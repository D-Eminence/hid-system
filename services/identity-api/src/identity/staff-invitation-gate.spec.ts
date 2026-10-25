jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { MODULE_METADATA } from '@nestjs/common/constants';
import { AuthSessionAuditService } from '../auth/auth-session-audit.service';
import { AuthModule } from '../auth/auth.module';
import { LocalAuthProvider } from '../auth/local-auth.provider';
import { DomainProblem } from '../common/problem';
import { AdminFacilityStaffController } from './admin-facility-staff.controller';
import { FacilityStaffController } from './facility-staff.controller';
import { FacilityStaffService } from './facility-staff.service';
import { IdentityModule } from './identity.module';
import { assertStaffInvitationsOpen, staffInvitationGateRefusal } from './staff-invitation-gate';
import { StaffInvitationsPublicController } from './staff-invitations-public.controller';
import { StaffInvitationsSignedInController } from './staff-invitations-signed-in.controller';
import { StaffInvitationsService } from './staff-invitations.service';
import { StaffReauthenticationService } from './staff-reauthentication.service';

const unavailable = () => new DomainProblem(503, 'STAFF_MANAGEMENT_UNAVAILABLE', 'x');
const controls = (row: Record<string, boolean | null>) => ({ query: jest.fn().mockResolvedValue({ rows: [row] }) });

describe('staff invitations gate (SPEC 6.1)', () => {
  it('is open only with the control on, the provider portal on and maintenance off', async () => {
    const database = controls({ invitations: true, provider_portal: true, maintenance: false });
    await expect(assertStaffInvitationsOpen(database, unavailable)).resolves.toBeUndefined();
    expect(String(database.query.mock.calls[0]?.[0])).toContain("platform.control_enabled('staff_invitations_enabled')");
    for (const row of [{ invitations: false, provider_portal: true, maintenance: false },
      { invitations: true, provider_portal: false, maintenance: false },
      { invitations: true, provider_portal: true, maintenance: true },
      { invitations: null, provider_portal: true, maintenance: false },
      { invitations: true, provider_portal: true, maintenance: null }]) {
      await expect(assertStaffInvitationsOpen(controls(row), unavailable))
        .rejects.toMatchObject({ status: 423, code: 'STAFF_INVITATIONS_UNAVAILABLE' });
    }
    await expect(assertStaffInvitationsOpen({ query: jest.fn().mockResolvedValue({ rows: [] }) }, unavailable))
      .rejects.toMatchObject({ status: 423 });
  });

  it.each([
    ['55000', 'PLATFORM_CONTROL_DISABLED:staff_invitations_enabled', 423],
    ['55000', 'PLATFORM_CONTROL_UNAVAILABLE', 423],
    ['22023', 'PLATFORM_CONTROL_INVALID', 423],
    ['55000', 'PLATFORM_CONTROL_DISABLED:provider_self_service_enabled', 503],
    ['22023', 'STAFF_INVITATION_INVALID', 503],
    ['08006', 'connection failure', 503],
  ])('answers the control read\'s %s %s %i', async (code, message, status) => {
    const database = { query: jest.fn().mockRejectedValue(Object.assign(new Error(message), { code })) };
    await expect(assertStaffInvitationsOpen(database, unavailable)).rejects.toMatchObject({ status });
  });

  it('maps only the control refusals', () => {
    expect(staffInvitationGateRefusal(null)).toBeUndefined();
    expect(staffInvitationGateRefusal({ code: '55000', message: 'STAFF_INVITATION_IMMUTABLE' })).toBeUndefined();
    expect(staffInvitationGateRefusal({ code: '55000', message: 'PLATFORM_CONTROL_DISABLED:staff_invitations_enabled' }))
      .toMatchObject({ status: 423, code: 'STAFF_INVITATIONS_UNAVAILABLE' });
  });
});

describe('P4b wiring', () => {
  it('registers the four controllers and three services, and Auth exports the password re-entry\'s providers', () => {
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, IdentityModule) as readonly unknown[];
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, IdentityModule) as readonly unknown[];
    for (const controller of [FacilityStaffController, StaffInvitationsSignedInController, StaffInvitationsPublicController,
      AdminFacilityStaffController]) expect(controllers).toContain(controller);
    for (const provider of [StaffInvitationsService, FacilityStaffService, StaffReauthenticationService]) {
      expect(providers).toContain(provider);
    }
    const exported = Reflect.getMetadata(MODULE_METADATA.EXPORTS, AuthModule) as readonly unknown[];
    expect(exported).toEqual(expect.arrayContaining([LocalAuthProvider, AuthSessionAuditService]));
  });
});
