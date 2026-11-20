jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import type { PoolClient } from 'pg';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { OPEN_PATIENT_CLEAR_ELSEWHERE_SQL } from './open-patient';
import { TokenService } from './token.service';

// SX-8 (0140): a move to another facility (POST /auth/facility) clears the
// open patient kept at any other facility, in the transaction that stores
// 0129's choice, or (0129 off) in its own with the move's audit row.

const sessionId = 'f1406000-0000-4000-8000-0000000000c2';
const familyId = 'f1406000-0000-4000-8000-0000000000c1';
const accountId = 'f1402000-0000-4000-8000-00000000000c';
const facilityId = 'f1401000-0000-4000-8000-00000000000c';
const membershipId = 'f1404000-0000-4000-8000-00000000000c';
const event = { correlationId: 'open-patient-store-test' };
const normalized = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

function harness() {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql: normalized(sql), values });
      if (/for share/.test(sql)) return { rows: [{ family_id: familyId }], rowCount: 1 };
      if (/insert into auth\.session_facility_selection/.test(sql)) return { rows: [{ family_id: familyId }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  const database = {
    query: jest.fn(),
    withSystemTransaction: jest.fn(async (_correlation: string, operation: (client: PoolClient) => Promise<unknown>) =>
      operation(client as unknown as PoolClient)),
  };
  const service = new TokenService(database as unknown as DatabaseService, {} as CurrentStaffContextService);
  return { service, client, database, statements };
}

describe('TokenService and the open patient on a facility move (SX-8, 0140)', () => {
  const original = { ...process.env };

  function environment(enabled: string | undefined): void {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'http://localhost:5173', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
    if (enabled === undefined) delete process.env.STAFF_OPEN_PATIENT_ENABLED;
    else process.env.STAFF_OPEN_PATIENT_ENABLED = enabled;
    resetEnvironmentForTests();
  }

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('the clear deletes only through the presented session of the account, and only at other facilities', () => {
    expect(normalized(OPEN_PATIENT_CLEAR_ELSEWHERE_SQL)).toBe('delete from auth.session_open_patient open_patient '
      + 'using auth.sessions session where session.id = $1 and session.account_id = $2 '
      + 'and open_patient.family_id = session.family_id and open_patient.account_id = session.account_id '
      + 'and open_patient.facility_id <> $3');
  });

  it.each([['unset', undefined], ['false', 'false']] as const)(
    'setting %s: recordFacilitySelection is 0129\'s two statements, unchanged', async (_label, value) => {
      environment(value);
      const { service, statements } = harness();
      await expect(service.recordFacilitySelection({ sessionId, accountId, facilityId, membershipId }, event,
        async () => undefined)).resolves.toBe('selected');
      expect(statements).toHaveLength(2);
      expect(statements.some(({ sql }) => /session_open_patient/.test(sql))).toBe(false);
    });

  it('setting true: recordFacilitySelection clears elsewhere after storing the choice and before the audit row', async () => {
    environment('true');
    const { service, statements, client } = harness();
    const within = jest.fn(async (transaction: unknown) => {
      expect(transaction).toBe(client);
      expect(statements).toHaveLength(3);
    });
    await expect(service.recordFacilitySelection({ sessionId, accountId, facilityId, membershipId }, event, within))
      .resolves.toBe('selected');
    expect(within).toHaveBeenCalledTimes(1);
    expect(statements[2]).toEqual({ sql: normalized(OPEN_PATIENT_CLEAR_ELSEWHERE_SQL),
      values: [sessionId, accountId, facilityId] });
  });

  it('clearOpenPatientElsewhere (0129 off): the clear and the audit row on one system transaction', async () => {
    environment('true');
    const { service, statements, client, database } = harness();
    const within = jest.fn(async (transaction: unknown) => { expect(transaction).toBe(client); });
    await service.clearOpenPatientElsewhere({ sessionId, accountId, facilityId }, event, within);
    expect(database.withSystemTransaction).toHaveBeenCalledTimes(1);
    expect(database.withSystemTransaction).toHaveBeenCalledWith(event.correlationId, expect.any(Function));
    expect(statements).toEqual([{ sql: normalized(OPEN_PATIENT_CLEAR_ELSEWHERE_SQL), values: [sessionId, accountId, facilityId] }]);
    expect(within).toHaveBeenCalledTimes(1);
  });

  it('clearOpenPatientElsewhere rethrows a failure (the caller answers 503)', async () => {
    environment('true');
    const { service, client } = harness();
    client.query.mockRejectedValueOnce(new Error('down'));
    const within = jest.fn();
    await expect(service.clearOpenPatientElsewhere({ sessionId, accountId, facilityId }, event, within))
      .rejects.toThrow('down');
    expect(within).not.toHaveBeenCalled();
  });
});
