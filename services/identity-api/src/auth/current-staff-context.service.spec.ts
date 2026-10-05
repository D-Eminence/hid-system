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
      .mockResolvedValueOnce({ rows: [{
        id: STAFF_CONTEXT_ROW.account_id,
        subject: STAFF_CONTEXT_ROW.subject,
        email: STAFF_CONTEXT_ROW.email,
        display_name: STAFF_CONTEXT_ROW.display_name,
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{
        roles: ['platform_operations_admin'],
        permissions: ['platform.operations.read'],
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [STAFF_CONTEXT_ROW], rowCount: 1 });
    const service = new CurrentStaffContextService({ query } as unknown as DatabaseService);

    const context = await service.resolve(STAFF_CONTEXT_ROW.subject, 'local');

    const call = query.mock.calls[2];
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
    expect(context.platformRoles).toEqual(['platform_operations_admin']);
    expect(context.platformPermissions).toEqual(['platform.operations.read']);
    const platformCall = query.mock.calls[1];
    expect(String(platformCall?.[0])).toContain("assignment.scope_type = 'platform'");
    expect(platformCall?.[1]).toEqual([STAFF_CONTEXT_ROW.account_id]);
  });

  it('allows an active platform admin to authenticate without a facility membership', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{
        id: '20000000-0000-4000-8000-000000000009',
        subject: 'staff:platform-admin',
        email: 'admin@test.invalid',
        display_name: 'Platform Admin',
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{
        roles: ['platform_super_admin'],
        permissions: ['platform.admin.access', 'platform.facility.manage'],
      }], rowCount: 1 });

    const service = new CurrentStaffContextService({ query } as unknown as DatabaseService);
    const context = await service.resolve('staff:platform-admin', 'local');

    expect(context.facility).toBeUndefined();
    expect(context.facilities).toEqual([]);
    expect(context.facilityIds).toEqual([]);
    expect(context.permissions).toEqual([]);
    expect(context.platformRoles).toEqual(['platform_super_admin']);
    expect(context.platformPermissions).toContain('platform.admin.access');
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0]?.[0])).toContain('from auth.accounts');
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
    expect(String(query.mock.calls[0]?.[0])).toContain('from auth.accounts');
  });

  it('restores a selected facility and its exact permissions, then falls back when membership is revoked', async () => {
    const second = { ...STAFF_CONTEXT_ROW,
      facility_id: '10000000-0000-4000-8000-000000000003',
      membership_id: '40000000-0000-4000-8000-000000000002',
      facility_name: 'Second Test Facility', facility_code: 'SCHEMA-B',
      roles: ['lab_technician'], permissions: ['lab.results.read'], is_primary: false };
    let eligibleRows = [STAFF_CONTEXT_ROW, second];
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{
        id: STAFF_CONTEXT_ROW.account_id,
        subject: STAFF_CONTEXT_ROW.subject,
        email: STAFF_CONTEXT_ROW.email,
        display_name: STAFF_CONTEXT_ROW.display_name,
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ roles: [], permissions: [] }], rowCount: 1 })
      .mockImplementation(async () => ({ rows: eligibleRows, rowCount: eligibleRows.length }));
    const service = new CurrentStaffContextService({ query } as unknown as DatabaseService);
    const selected = await service.resolve(STAFF_CONTEXT_ROW.subject, 'local', 'session-id', second.facility_id);
    expect(selected.facility?.id).toBe(second.facility_id);
    expect(selected.facilities.map((facility) => facility.id)).toEqual([
      STAFF_CONTEXT_ROW.facility_id, second.facility_id,
    ]);
    expect(selected.permissions).toEqual(['lab.results.read']);
    expect(selected.permissions).not.toContain('ehr.encounter.read');

    eligibleRows = [STAFF_CONTEXT_ROW];
    const restored = await service.resolve(STAFF_CONTEXT_ROW.subject, 'local', 'session-id', second.facility_id);
    expect(restored.facility?.id).toBe(STAFF_CONTEXT_ROW.facility_id);
    expect(restored.facilityIds).toEqual([STAFF_CONTEXT_ROW.facility_id]);
    expect(restored.permissions).toEqual(['ehr.encounter.read']);
  });
});
