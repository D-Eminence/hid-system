import { UnauthorizedException } from '@nestjs/common';
import type { DatabaseService } from '../database/database.service';
import { ACTIVE_STAFF_VERIFICATION_STATUSES } from './auth-policy';
import { CurrentStaffContextService, STAFF_CONTEXT_SQL, STAFF_MEMBERSHIPS_SQL } from './current-staff-context.service';

// The staff context query at a2c21c7 (P4's frozen commit), copied verbatim.
const PREVIOUS_STAFF_CONTEXT_SQL = `select account.id::text as account_id,
              account.subject,
              account.email,
              account.display_name,
              membership.facility_id::text,
              membership.id::text as membership_id,
              membership.organization_id::text,
              facility.name as facility_name,
              facility.code as facility_code,
              array_remove(array[membership.membership_role, membership.app_role], null) as roles,
              coalesce(array_agg(distinct permission.code) filter (where permission.code is not null), array[]::text[]) as permissions,
              membership.is_primary
         from auth.accounts account
         join identity.staff_facility_memberships membership
           on membership.account_id = account.id
          and membership.active
          and membership.migration_hold_reason is null
         join identity.staff staff
           on staff.id = membership.staff_id
          and staff.account_id = account.id
          and staff.active
          and lower(btrim(staff.verification_status)) = any($2::text[])
         join identity.organizations organization
           on organization.id = membership.organization_id
          and organization.active
         join identity.facilities facility
           on facility.id = membership.facility_id
          and facility.organization_id = membership.organization_id
          and facility.active
         left join auth.account_roles account_role
           on account_role.account_id = account.id
          and account_role.scope_type = 'facility'
          and account_role.membership_id = membership.id
          and account_role.facility_id = membership.facility_id
          and account_role.revoked_at is null
         left join auth.roles role
           on role.code = account_role.role_code
          and role.active
         left join auth.role_permissions role_permission on role_permission.role_code = role.code
         left join auth.permissions permission
           on permission.code = role_permission.permission_code
          and permission.active
        where account.subject = $1
          and account.status = 'active'
          and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
        group by account.id, account.subject, account.email, account.display_name,
                 membership.id, membership.facility_id, membership.organization_id,
                 membership.membership_role, membership.app_role, membership.is_primary,
                 facility.name, facility.code
        order by membership.is_primary desc, facility.name, membership.facility_id`;

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

// P4b (SPEC 6.2, FEA R4): the previous query, byte-identical without its ORDER
// BY, wrapped with one call of identity.organization_self_service_state per
// membership row; only self-signed-up facilities gain facility.selfService.
describe('CurrentStaffContextService self sign-up state (P4b)', () => {
  it('wraps the previous query byte-identically, without its ORDER BY, and keeps its order', () => {
    const orderBy = '\n        order by membership.is_primary desc, facility.name, membership.facility_id';
    expect(PREVIOUS_STAFF_CONTEXT_SQL.endsWith(orderBy)).toBe(true);
    expect(STAFF_MEMBERSHIPS_SQL).toBe(PREVIOUS_STAFF_CONTEXT_SQL.slice(0, -orderBy.length));
    expect(STAFF_CONTEXT_SQL).toBe('select grouped.*, state.review_state, state.organization_type\n'
      + `         from (${STAFF_MEMBERSHIPS_SQL}) grouped\n`
      + '         left join lateral identity.organization_self_service_state(grouped.organization_id::uuid) state on true\n'
      + '        order by grouped.is_primary desc, grouped.facility_name, grouped.facility_id::uuid');
  });

  async function resolved(rows: Record<string, unknown>[]) {
    const query = jest.fn().mockResolvedValueOnce({ rows, rowCount: rows.length })
      .mockResolvedValueOnce({ rows: [{ roles: [], permissions: [] }], rowCount: 1 });
    const context = await new CurrentStaffContextService({ query } as unknown as DatabaseService)
      .resolve(STAFF_CONTEXT_ROW.subject, 'local');
    expect(query.mock.calls[0]?.[0]).toBe(STAFF_CONTEXT_SQL);
    expect(query.mock.calls[0]?.[1]).toEqual([STAFF_CONTEXT_ROW.subject, [...ACTIVE_STAFF_VERIFICATION_STATUSES]]);
    return context;
  }

  it('adds selfService for a pending or reviewed organization only', async () => {
    const pending = await resolved([{ ...STAFF_CONTEXT_ROW, roles: ['org_admin'], review_state: 'pending',
      organization_type: 'pharmacy' }]);
    expect(pending.facility?.selfService).toEqual({ review: 'pending', organizationType: 'pharmacy' });
    expect(pending.facilities[0]?.selfService).toEqual({ review: 'pending', organizationType: 'pharmacy' });
    const reviewed = await resolved([{ ...STAFF_CONTEXT_ROW, review_state: 'reviewed', organization_type: 'hospital' }]);
    expect(reviewed.facility?.selfService).toEqual({ review: 'reviewed', organizationType: 'hospital' });
    // Released organizations are inactive and never listed; a stray state is not shown.
    const released = await resolved([{ ...STAFF_CONTEXT_ROW, review_state: 'released', organization_type: 'hospital' }]);
    expect(released.facility).not.toHaveProperty('selfService');
  });

  it('answers a governed or legacy membership exactly as before: no selfService key at all', async () => {
    const before = await resolved([STAFF_CONTEXT_ROW]);
    const governed = await resolved([{ ...STAFF_CONTEXT_ROW, review_state: null, organization_type: null }]);
    expect(governed).toEqual(before);
    expect(JSON.stringify(governed)).toBe(JSON.stringify(before));
    expect(governed.facility).not.toHaveProperty('selfService');
  });

  it('keeps each membership\'s own state when a staff member works at both kinds', async () => {
    const context = await resolved([
      { ...STAFF_CONTEXT_ROW, is_primary: true, review_state: null, organization_type: null },
      { ...STAFF_CONTEXT_ROW, facility_id: '10000000-0000-4000-8000-000000000003',
        membership_id: '40000000-0000-4000-8000-000000000002', facility_name: 'Invited Hospital', is_primary: false,
        review_state: 'reviewed', organization_type: 'clinic' },
    ]);
    expect(context.facility?.selfService).toBeUndefined();
    expect(context.facilities.map((facility) => facility.selfService)).toEqual([undefined,
      { review: 'reviewed', organizationType: 'clinic' }]);
  });
});
