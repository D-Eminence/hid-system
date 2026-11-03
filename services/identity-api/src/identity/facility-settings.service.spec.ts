import type { ActorContext, DataAccessContext, FacilityAssignment } from '../common/request-context';
import { DomainProblem } from '../common/problem';
import type { DatabaseService } from '../database/database.service';
import { FacilitySettingsService, facilitySettingProblem } from './facility-settings.service';

const facilityId = '10000000-0000-4000-8000-000000000002';

function adminContext(): DataAccessContext {
  const assignment: FacilityAssignment = { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
    organizationId: '10000000-0000-4000-8000-000000000001', name: 'Synthetic Lab Ltd', roles: ['org_admin'],
    permissions: ['organization.manage'], isPrimary: true };
  const actor: ActorContext = { kind: 'staff', id: 'staff:administrator', subject: 'staff:administrator',
    accountId: '20000000-0000-4000-8000-000000000001', email: 'admin@example.test', roles: assignment.roles,
    permissions: assignment.permissions, facilityIds: [facilityId], facilities: [assignment], facility: assignment,
    authenticationMethod: 'local' };
  return { actor, facilityId, membershipId: assignment.membershipId, correlationId: 'facility-settings-test',
    purposeOfUse: 'healthcare-operations' };
}

function harness(answer: (sql: string, values: unknown[]) => unknown) {
  const calls: { sql: string; values: unknown[]; context: unknown; options: unknown }[] = [];
  const database = {
    withTransaction: jest.fn(async (context: unknown, work: (client: unknown) => Promise<unknown>, options?: unknown) =>
      work({ query: jest.fn(async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values, context, options });
        return answer(sql, values);
      }) })),
  };
  return { service: new FacilitySettingsService(database as unknown as DatabaseService), database, calls };
}

const dbError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('FacilitySettingsService (owner decision 33.3)', () => {
  it('reads the switch of the session facility in a read-only staff transaction', async () => {
    const { service, calls } = harness(async () => ({ rows: [{ enabled: true, changed_at: new Date('2026-11-03T10:00:00.000Z'),
      changed_by_name: 'Ada Obi', reason: 'Only one scientist works here' }] }));
    const context = adminContext();
    await expect(service.read(context)).resolves.toEqual({ onePersonLab: { enabled: true,
      changedAt: '2026-11-03T10:00:00.000Z', changedByName: 'Ada Obi', reason: 'Only one scientist works here' } });
    expect(calls).toEqual([{ sql: 'select * from identity.facility_one_person_lab_state()', values: [], context,
      options: { readOnly: true } }]);
    expect((calls[0]?.context as DataAccessContext).purposeOfUse).toBe('healthcare-operations');
  });

  it('reads a facility never switched as off', async () => {
    const { service } = harness(async () => ({ rows: [{ enabled: false, changed_at: null, changed_by_name: null, reason: null }] }));
    await expect(service.read(adminContext())).resolves.toEqual({ onePersonLab: { enabled: false, changedAt: null,
      changedByName: null, reason: null } });
  });

  it('switches with the value and the reason as sent and answers the new state', async () => {
    const { service, calls } = harness(async () => ({ rows: [{ enabled: true, changed_at: '2026-11-03T10:00:00Z',
      setting_id: '50000000-0000-4000-8000-000000000001' }] }));
    await expect(service.setOnePersonLab(adminContext(), true, 'Only one scientist works here')).resolves.toEqual({
      enabled: true, changedAt: '2026-11-03T10:00:00.000Z', settingId: '50000000-0000-4000-8000-000000000001' });
    expect(calls.map((call) => [call.sql, call.values, call.options])).toEqual([[
      'select * from identity.set_facility_one_person_lab($1,$2)', [true, 'Only one scientist works here'], undefined]]);
  });

  it.each([
    [dbError('42501', 'FACILITY_SETTING_PERMISSION_DENIED'), 403, 'FACILITY_SETTING_PERMISSION_DENIED'],
    [dbError('22023', 'FACILITY_SETTING_REASON_INVALID'), 400, 'FACILITY_SETTING_REASON_INVALID'],
    [dbError('22023', 'FACILITY_SETTING_INVALID'), 400, 'FACILITY_SETTING_INVALID'],
    [dbError('P0001', 'FACILITY_SETTING_UNCHANGED'), 409, 'FACILITY_SETTING_UNCHANGED'],
    [dbError('P0001', 'SOMETHING_ELSE'), 503, 'FACILITY_SETTINGS_UNAVAILABLE'],
    [dbError('22023', 'invalid input syntax'), 503, 'FACILITY_SETTINGS_UNAVAILABLE'],
    [dbError('42883', 'function identity.set_facility_one_person_lab(boolean, text) does not exist'), 503,
      'FACILITY_SETTINGS_UNAVAILABLE'],
    [new Error('connection reset'), 503, 'FACILITY_SETTINGS_UNAVAILABLE'],
  ])('answers a refusal (%s) with %d %s, in both commands', async (error, status, code) => {
    const { service } = harness(async () => { throw error; });
    await expect(service.setOnePersonLab(adminContext(), true, 'Only one scientist works here')).rejects.toMatchObject({ status, code });
    await expect(service.read(adminContext())).rejects.toMatchObject({ status: code === 'FACILITY_SETTING_PERMISSION_DENIED' ? 403 : status,
      code });
  });

  it('never echoes the database message or the reason', () => {
    const problem = facilitySettingProblem(dbError('XX000', 'Only one scientist works here leaked'));
    expect(problem).toBeInstanceOf(DomainProblem);
    expect(JSON.stringify(problem.getResponse())).not.toContain('leaked');
    const kept = new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.');
    expect(facilitySettingProblem(kept)).toBe(kept);
  });
});
