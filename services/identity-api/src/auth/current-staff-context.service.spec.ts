import { UnauthorizedException } from '@nestjs/common';
import type { DatabaseService } from '../database/database.service';
import { ACTIVE_STAFF_VERIFICATION_STATUSES } from './auth-policy';
import { CurrentStaffContextService } from './current-staff-context.service';

const STAFF_CONTEXT_ROW = {
  account_id: '20000000-0000-4000-8000-000000000001',
  subject: 'staff:test-clinician',
  email: 'clinician@test.invalid',
  display_name: 'Schema Test Clinician',
  facility_id: '10000000-0000-4000-8000-000000000002',
  membership_id: '40000000-0000-4000-8000-000000000001',
  organization_id: '10000000-0000-4000-8000-000000000001',
  facility_name: 'Schema Test Facility',
  facility_code: 'SCHEMA-A',
  roles: ['doctor'],
  permissions: ['ehr.encounter.read'],
  is_primary: true,
};

describe('CurrentStaffContextService PostgreSQL authorization boundary', () => {
  it('loads only a currently eligible account, staff record, organization, facility, and membership', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [STAFF_CONTEXT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{
        roles: ['platform_super_admin'],
        permissions: ['platform.admin.access', 'platform.facility.manage'],
      }], rowCount: 1 });
    const service = new CurrentStaffContextService({ query } as unknown as DatabaseService);

    const context = await service.resolve(STAFF_CONTEXT_ROW.subject, 'local');

    const call = query.mock.calls[0];
    expect(call).toBeDefined();
    const [sql, parameters] = call ?? ['', undefined];
    expect(String(sql)).toEqual(expect.stringContaining('join identity.staff staff'));
    expect(String(sql)).toEqual(expect.stringContaining('staff.active'));
    expect(String(sql)).toEqual(expect.stringContaining('join identity.organizations organization'));
    expect(String(sql)).toEqual(expect.stringContaining('organization.active'));
    expect(String(sql)).toEqual(expect.stringContaining('facility.active'));
    expect(String(sql)).toEqual(expect.stringContaining('membership.migration_hold_reason is null'));
    expect(String(sql)).toEqual(expect.stringContaining('account.disabled_until'));
    expect(parameters).toEqual([STAFF_CONTEXT_ROW.subject, [...ACTIVE_STAFF_VERIFICATION_STATUSES]]);
    expect(context.facility?.id).toBe(STAFF_CONTEXT_ROW.facility_id);
    expect(context.permissions).toEqual(['ehr.encounter.read']);
    expect(context.platformRoles).toEqual(['platform_super_admin']);
    expect(context.platformPermissions).toEqual(['platform.admin.access', 'platform.facility.manage']);
    const platformCall = query.mock.calls[1];
    expect(String(platformCall?.[0])).toContain("assignment.scope_type = 'platform'");
    expect(platformCall?.[1]).toEqual([STAFF_CONTEXT_ROW.account_id]);
  });

  it('fails closed when no complete active authorization tuple is returned', async () => {
    const service = new CurrentStaffContextService(
      { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as DatabaseService,
    );

    await expect(service.resolve(STAFF_CONTEXT_ROW.subject, 'oidc'))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not turn an ordinary patient principal into an administrator', async () => {
    const query = jest.fn(async (_text: string, _parameters?: readonly unknown[]) => ({ rows: [], rowCount: 0 }));
    const service = new CurrentStaffContextService({ query } as unknown as DatabaseService);
    await expect(service.resolve('patient:ordinary-person', 'local'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(String(query.mock.calls[0]?.[0])).toContain('join identity.staff staff');
  });
});
