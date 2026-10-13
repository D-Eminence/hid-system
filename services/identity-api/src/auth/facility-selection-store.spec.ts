jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import type { PoolClient } from 'pg';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { TokenService } from './token.service';

// How TokenService reads and writes a sign-in's facility selection (0089). The
// database guard (auth.guard_session_facility_selection_change) and the real
// transaction are exercised by session-facility-selection.integration.sql and
// scripts/verify-facility-selection-runtime.mjs.

const sessionId = '90000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-000000000001';
const facilityId = '10000000-0000-4000-8000-00000000000b';
const membershipId = '40000000-0000-4000-8000-00000000000b';
const event = { correlationId: 'facility-selection-store-test' };
const normalized = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

function harness(upsertRows: { family_id: string }[] | Error = [{ family_id: sessionId }]) {
  const statements: string[] = [];
  const client = {
    query: jest.fn(async (sql: string, values?: unknown[]) => {
      statements.push(normalized(sql));
      if (/insert into auth\.session_facility_selection/.test(sql)) {
        if (upsertRows instanceof Error) throw upsertRows;
        return { rows: upsertRows, rowCount: upsertRows.length };
      }
      return { rows: [], rowCount: 1, values };
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

function guardRefusal(): Error {
  return Object.assign(new Error('SESSION_FACILITY_SELECTION_INVALID'), { code: '23514' });
}

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: 'http://localhost:5173', AUTH_MODE: 'local', STORAGE_MODE: 'disabled',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
  resetEnvironmentForTests();
});

describe('TokenService.recordFacilitySelection', () => {
  it('takes the account lock, upserts for the live staff session\'s family, then runs the caller\'s audit on the same transaction', async () => {
    const { service, client, database, statements } = harness();
    const within = jest.fn(async (transaction: unknown) => { expect(transaction).toBe(client); });

    const outcome = await service.recordFacilitySelection({ sessionId, accountId, facilityId, membershipId }, event, within);

    expect(outcome).toBe('selected');
    expect(database.withSystemTransaction).toHaveBeenCalledWith(event.correlationId, expect.any(Function));
    // Account row first (0073), as every sign-out and revocation, so a selection
    // cannot be written for a sign-in that a concurrent sign-out has just ended.
    expect(statements[0]).toBe('select auth.lock_account_sessions($1)');
    expect(client.query.mock.calls[0]![1]).toEqual([accountId]);
    const upsert = statements[1]!;
    expect(upsert).toMatch(/^insert into auth\.session_facility_selection \(family_id, account_id, facility_id, membership_id\) select session\.family_id, session\.account_id, \$3::uuid, \$4::uuid from auth\.sessions session/);
    for (const condition of ['session.id = $1', 'session.account_id = $2', "session.session_kind = 'staff'",
      'session.revoked_at is null', 'session.expires_at > clock_timestamp()',
      'session.absolute_expires_at > clock_timestamp()']) {
      expect(upsert).toContain(condition);
    }
    expect(upsert).toContain('on conflict (family_id) do update set facility_id = excluded.facility_id, membership_id = excluded.membership_id, selected_at = clock_timestamp(), row_version = auth.session_facility_selection.row_version + 1');
    expect(client.query.mock.calls[1]![1]).toEqual([sessionId, accountId, facilityId, membershipId]);
    expect(within).toHaveBeenCalledTimes(1);
    expect(client.query.mock.invocationCallOrder[1]!).toBeLessThan(within.mock.invocationCallOrder[0]!);
  });

  it('writes and audits nothing when the session is no longer a live staff session of the account', async () => {
    const { service } = harness([]);
    const within = jest.fn();

    await expect(service.recordFacilitySelection({ sessionId, accountId, facilityId, membershipId }, event, within))
      .resolves.toBe('session_ended');
    expect(within).not.toHaveBeenCalled();
  });

  it('reports the database guard\'s membership refusal as refused, with nothing audited', async () => {
    const { service } = harness(guardRefusal());
    const within = jest.fn();

    await expect(service.recordFacilitySelection({ sessionId, accountId, facilityId, membershipId }, event, within))
      .resolves.toBe('refused');
    expect(within).not.toHaveBeenCalled();
  });

  it('rethrows any other database failure, so the transaction rolls back and nothing is reported as selected', async () => {
    const failure = Object.assign(new Error('connection reset'), { code: '08006' });
    const { service } = harness(failure);
    await expect(service.recordFacilitySelection({ sessionId, accountId, facilityId, membershipId }, event, jest.fn()))
      .rejects.toBe(failure);
  });

  it('rethrows an audit failure from the caller, so the selection is rolled back with it', async () => {
    const { service } = harness();
    const auditFailure = new Error('audit unavailable');
    await expect(service.recordFacilitySelection({ sessionId, accountId, facilityId, membershipId }, event,
      jest.fn().mockRejectedValue(auditFailure))).rejects.toBe(auditFailure);
  });
});

describe('TokenService.selectedFacilityId', () => {
  it('reads the selection of the session\'s family only through a live staff session of the same account', async () => {
    const { service, database } = harness();
    database.query.mockResolvedValue({ rows: [{ facility_id: facilityId }], rowCount: 1 });

    await expect(service.selectedFacilityId(sessionId, accountId)).resolves.toBe(facilityId);

    const [sql, values] = database.query.mock.calls[0]!;
    const read = normalized(sql);
    expect(read).toContain('from auth.sessions session join auth.session_facility_selection selection on selection.family_id = session.family_id and selection.account_id = session.account_id');
    for (const condition of ['session.id = $1', 'session.account_id = $2', "session.session_kind = 'staff'",
      'session.revoked_at is null', 'session.expires_at > clock_timestamp()',
      'session.absolute_expires_at > clock_timestamp()']) {
      expect(read).toContain(condition);
    }
    expect(values).toEqual([sessionId, accountId]);
  });

  it('answers undefined when the sign-in has no selection or the session is no longer live', async () => {
    const { service, database } = harness();
    database.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(service.selectedFacilityId(sessionId, accountId)).resolves.toBeUndefined();
  });
});
