import { UnauthorizedException } from '@nestjs/common';
import type { DatabaseService } from '../database/database.service';
import { ACTIVE_STAFF_VERIFICATION_STATUSES } from './auth-policy';
import { CurrentStaffContextService } from './current-staff-context.service';

const ACCOUNT_ROW = {
  account_id: '20000000-0000-4000-8000-000000000001',
  subject: 'staff:test-clinician',
  email: 'clinician@test.invalid',
  display_name: 'Schema Test Clinician',
};
const STAFF_CONTEXT_ROW = {
  facility_id: '10000000-0000-4000-8000-000000000002',
  membership_id: '40000000-0000-4000-8000-000000000001',
  organization_id: '10000000-0000-4000-8000-000000000001',
  facility_name: 'Schema Test Facility',
  facility_code: 'SCHEMA-A',
  roles: ['doctor'],
  permissions: ['ehr.encounter.read'],
  is_primary: true,
};

function result(rows: object[]) { return { rows, rowCount: rows.length }; }

describe('CurrentStaffContextService PostgreSQL authorization boundary', () => {
  it('loads only a currently eligible account, staff record, organization, facility, and membership', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce(result([ACCOUNT_ROW]))
      .mockResolvedValueOnce(result([STAFF_CONTEXT_ROW]))
      .mockResolvedValueOnce(result([{
        roles: ['platform_super_admin'],
        permissions: ['platform.admin.access', 'platform.facility.manage'],
      }]));
    const service = new CurrentStaffContextService({ query } as unknown as DatabaseService);

    const context = await service.resolve(ACCOUNT_ROW.subject, 'local');

    const [accountSql, accountParameters] = query.mock.calls[0] ?? ['', undefined];
    expect(String(accountSql)).toContain('from auth.accounts account');
    expect(accountParameters).toEqual([ACCOUNT_ROW.subject]);
    const [facilitySql, facilityParameters] = query.mock.calls[1] ?? ['', undefined];
    expect(String(facilitySql)).toContain('join identity.staff staff');
    expect(String(facilitySql)).toContain('staff.active');
    expect(String(facilitySql)).toContain('join identity.organizations organization');
    expect(String(facilitySql)).toContain('organization.active');
    expect(String(facilitySql)).toContain('facility.active');
    expect(String(facilitySql)).toContain('membership.migration_hold_reason is null');
    expect(String(facilitySql)).toContain('account.disabled_until');
    expect(facilityParameters).toEqual([ACCOUNT_ROW.account_id, [...ACTIVE_STAFF_VERIFICATION_STATUSES]]);
    expect(context.facility?.id).toBe(STAFF_CONTEXT_ROW.facility_id);
    expect(context.permissions).toEqual(['ehr.encounter.read']);
    expect(context.platformRoles).toEqual(['platform_super_admin']);
    expect(context.platformPermissions).toEqual(['platform.admin.access', 'platform.facility.manage']);
    const platformCall = query.mock.calls[2];
    expect(String(platformCall?.[0])).toContain("assignment.scope_type = 'platform'");
    expect(platformCall?.[1]).toEqual([ACCOUNT_ROW.account_id]);
  });

  it('authenticates an active platform administrator with no facility membership', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce(result([ACCOUNT_ROW]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{
        roles: ['platform_super_admin'], permissions: ['platform.admin.access'],
      }]));
    const service = new CurrentStaffContextService({ query } as unknown as DatabaseService);

    const context = await service.resolve(ACCOUNT_ROW.subject, 'local');
    expect(context).toMatchObject({
      accountId: ACCOUNT_ROW.account_id,
      facilities: [], facilityIds: [], roles: [], permissions: [],
      platformPermissions: ['platform.admin.access'],
    });
    expect(context.facility).toBeUndefined();
  });

  it('still denies a normal workforce account that has no active facility membership', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce(result([ACCOUNT_ROW]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ roles: [], permissions: [] }]));
    const service = new CurrentStaffContextService({ query } as unknown as DatabaseService);

    await expect(service.resolve(ACCOUNT_ROW.subject, 'oidc'))
      .rejects.toThrow('Staff account or facility membership is inactive');
  });

  it('does not turn an ordinary patient principal into an administrator', async () => {
    const query = jest.fn().mockResolvedValue(result([]));
    const service = new CurrentStaffContextService({ query } as unknown as DatabaseService);
    await expect(service.resolve('patient:ordinary-person', 'local'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(String(query.mock.calls[0]?.[0])).toContain('from auth.accounts account');
  });

  it('restores a selected facility and its exact permissions, then falls back when membership is revoked', async () => {
    const second = { ...STAFF_CONTEXT_ROW,
      facility_id: '10000000-0000-4000-8000-000000000003',
      membership_id: '40000000-0000-4000-8000-000000000002',
      facility_name: 'Second Test Facility', facility_code: 'SCHEMA-B',
      roles: ['lab_technician'], permissions: ['lab.results.read'], is_primary: false };
    const query = jest.fn()
      .mockResolvedValueOnce(result([ACCOUNT_ROW]))
      .mockResolvedValueOnce(result([STAFF_CONTEXT_ROW, second]))
      .mockResolvedValueOnce(result([{ roles: [], permissions: [] }]))
      .mockResolvedValueOnce(result([ACCOUNT_ROW]))
      .mockResolvedValueOnce(result([STAFF_CONTEXT_ROW]))
      .mockResolvedValueOnce(result([{ roles: [], permissions: [] }]));
    const service = new CurrentStaffContextService({ query } as unknown as DatabaseService);
    const selected = await service.resolve(ACCOUNT_ROW.subject, 'local', 'session-id', second.facility_id);
    expect(selected.facility?.id).toBe(second.facility_id);
    expect(selected.facilities.map((facility) => facility.id)).toEqual([
      STAFF_CONTEXT_ROW.facility_id, second.facility_id,
    ]);
    expect(selected.permissions).toEqual(['lab.results.read']);
    expect(selected.permissions).not.toContain('ehr.encounter.read');

    const restored = await service.resolve(ACCOUNT_ROW.subject, 'local', 'session-id', second.facility_id);
    expect(restored.facility?.id).toBe(STAFF_CONTEXT_ROW.facility_id);
    expect(restored.facilityIds).toEqual([STAFF_CONTEXT_ROW.facility_id]);
    expect(restored.permissions).toEqual(['ehr.encounter.read']);
  });
});
