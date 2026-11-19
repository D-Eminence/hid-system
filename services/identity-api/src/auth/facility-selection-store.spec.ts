jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { ACTIVE_STAFF_VERIFICATION_STATUSES } from './auth-policy';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { TokenService } from './token.service';

// How TokenService writes and reads a staff sign-in's chosen facility (0129).
// The database guard (auth.guard_session_facility_selection_change) and the
// real transaction are exercised by
// services/ehr-api/test/database/session-facility-selection.integration.sql,
// which models these two statements exactly.

const MIGRATION = readFileSync(
  join(__dirname, '../../../ehr-api/database/migrations/0129_session_facility_selection.sql'), 'utf8');

const sessionId = 'f1296000-0000-4000-8000-0000000000b2';
const familyId = 'f1296000-0000-4000-8000-0000000000b1';
const accountId = 'f1292000-0000-4000-8000-00000000000b';
const facilityId = 'f1291000-0000-4000-8000-00000000000b';
const membershipId = 'f1294000-0000-4000-8000-00000000000b';
const input = { sessionId, accountId, facilityId, membershipId };
const event = { correlationId: 'facility-selection-store-test' };
const normalized = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
const LIVE_STAFF_SESSION = ['session.id = $1', 'session.account_id = $2', "session.session_kind = 'staff'",
  'session.revoked_at is null', 'session.expires_at > clock_timestamp()', 'session.absolute_expires_at > clock_timestamp()'];

function harness(options: { locked?: { family_id: string }[]; stored?: { family_id: string }[] | Error } = {}) {
  const locked = options.locked ?? [{ family_id: familyId }];
  const stored = options.stored ?? [{ family_id: familyId }];
  const statements: string[] = [];
  const client = {
    query: jest.fn(async (sql: string, _values?: unknown[]) => {
      statements.push(normalized(sql));
      if (/insert into auth\.session_facility_selection/.test(sql)) {
        if (stored instanceof Error) throw stored;
        return { rows: stored, rowCount: stored.length };
      }
      if (/for share/.test(sql)) return { rows: locked, rowCount: locked.length };
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

const databaseError = (code: string, message: string) => Object.assign(new Error(message), { code });

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: 'http://localhost:5173', AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
  resetEnvironmentForTests();
});

describe('TokenService.recordFacilitySelection', () => {
  it('locks the presented live staff session FOR SHARE, upserts for its family, then runs the audit on the same transaction',
    async () => {
      const { service, client, database, statements } = harness();
      const within = jest.fn(async (transaction: unknown) => { expect(transaction).toBe(client); });

      await expect(service.recordFacilitySelection(input, event, within)).resolves.toBe('selected');

      expect(database.withSystemTransaction).toHaveBeenCalledTimes(1);
      expect(database.withSystemTransaction).toHaveBeenCalledWith(event.correlationId, expect.any(Function));
      expect(database.query).not.toHaveBeenCalled();
      expect(statements).toHaveLength(2);
      // 1. The presented session, while it is a live staff session of the
      // account, locked FOR SHARE: sign-out, rotation and reuse revocation
      // update that row, so they wait for this transaction or have ended the
      // session first (then nothing is written). The runtime only reads
      // auth.accounts, so the account row is not locked (no main 0073).
      const lock = statements[0]!;
      expect(lock).toMatch(/^select session\.family_id::text from auth\.sessions session where .* for share$/);
      for (const condition of LIVE_STAFF_SESSION) expect(lock).toContain(condition);
      expect(lock).not.toMatch(/auth\.accounts|lock_account_sessions|for update|for no key update/);
      expect(client.query.mock.calls[0]![1]).toEqual([sessionId, accountId]);
      // 2. The choice, keyed by the locked session's family (the sign-in).
      expect(statements[1]).toBe('insert into auth.session_facility_selection (family_id, account_id, facility_id, membership_id)'
        + ' values ($1::uuid, $2::uuid, $3::uuid, $4::uuid) on conflict (family_id) do update'
        + ' set facility_id = excluded.facility_id, membership_id = excluded.membership_id,'
        + ' selected_at = clock_timestamp(), row_version = auth.session_facility_selection.row_version + 1'
        + ' returning family_id::text');
      expect(client.query.mock.calls[1]![1]).toEqual([familyId, accountId, facilityId, membershipId]);
      // 3. The caller's audit row, after the write, on the same transaction.
      expect(within).toHaveBeenCalledTimes(1);
      expect(client.query.mock.invocationCallOrder[1]!).toBeLessThan(within.mock.invocationCallOrder[0]!);
    });

  it('writes and audits nothing when the presented session is no longer a live staff session of the account', async () => {
    const { service, statements } = harness({ locked: [] });
    const within = jest.fn();

    await expect(service.recordFacilitySelection(input, event, within)).resolves.toBe('session_ended');

    expect(statements).toHaveLength(1);
    expect(within).not.toHaveBeenCalled();
  });

  it('answers refused for the guard\'s 23514 SESSION_FACILITY_SELECTION_INVALID, with nothing audited', async () => {
    const { service } = harness({ stored: databaseError('23514', 'SESSION_FACILITY_SELECTION_INVALID') });
    const within = jest.fn();

    await expect(service.recordFacilitySelection(input, event, within)).resolves.toBe('refused');
    expect(within).not.toHaveBeenCalled();
  });

  it.each([
    ['another CHECK violation', databaseError('23514', 'new row violates check constraint "session_facility_selection_row_version_check"')],
    ['the guard\'s immutability refusal', databaseError('55000', 'SESSION_FACILITY_SELECTION_IMMUTABLE')],
    ['a missing grant', databaseError('42501', 'permission denied for table session_facility_selection')],
    ['a missing table', databaseError('42P01', 'relation "auth.session_facility_selection" does not exist')],
    ['a lost connection', databaseError('08006', 'connection reset')],
  ])('rethrows %s, so the transaction rolls back and nothing is reported as selected', async (_label, failure) => {
    const { service } = harness({ stored: failure });
    const within = jest.fn();

    await expect(service.recordFacilitySelection(input, event, within)).rejects.toBe(failure);
    expect(within).not.toHaveBeenCalled();
  });

  it('rethrows the caller\'s audit failure, so the choice is rolled back with it', async () => {
    const { service } = harness();
    const auditFailure = new Error('audit unavailable');

    await expect(service.recordFacilitySelection(input, event, jest.fn().mockRejectedValue(auditFailure)))
      .rejects.toBe(auditFailure);
  });

  it('never answers selected when the upsert reports no row', async () => {
    const { service } = harness({ stored: [] });
    const within = jest.fn();

    await expect(service.recordFacilitySelection(input, event, within)).rejects.toThrow();
    expect(within).not.toHaveBeenCalled();
  });
});

describe('TokenService.selectedFacilityId', () => {
  it('reads the facility only, through the presented session while it is a live staff session of the account', async () => {
    const { service, database } = harness();
    database.query.mockResolvedValue({ rows: [{ facility_id: facilityId }], rowCount: 1 });

    await expect(service.selectedFacilityId(sessionId, accountId)).resolves.toBe(facilityId);

    expect(database.query).toHaveBeenCalledTimes(1);
    expect(database.withSystemTransaction).not.toHaveBeenCalled();
    const [sql, values] = database.query.mock.calls[0]!;
    const read = normalized(sql);
    expect(read).toMatch(/^select selection\.facility_id::text from auth\.sessions session join auth\.session_facility_selection selection on selection\.family_id = session\.family_id and selection\.account_id = session\.account_id where /);
    for (const condition of LIVE_STAFF_SESSION) expect(read).toContain(condition);
    // The membership is not read: matching is by facility id only.
    expect(read).not.toContain('membership_id');
    // A plain read: it takes no row lock, so it never waits on another transaction.
    expect(read).not.toMatch(/\bfor (update|no key update|share|key share)\b/);
    expect(values).toEqual([sessionId, accountId]);
  });

  it('answers undefined when the sign-in has no choice or the session is no longer live', async () => {
    const { service, database } = harness();
    database.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(service.selectedFacilityId(sessionId, accountId)).resolves.toBeUndefined();
  });

  it('rethrows a failed read for the caller to report', async () => {
    const { service, database } = harness();
    const failure = databaseError('57014', 'canceling statement due to statement timeout');
    database.query.mockRejectedValue(failure);

    await expect(service.selectedFacilityId(sessionId, accountId)).rejects.toBe(failure);
  });
});

describe('the SQL matches migration 0129', () => {
  it('the guard admits the verification statuses the Identity runtime treats as active (ACTIVE_STAFF_VERIFICATION_STATUSES)', () => {
    const match = /lower\(btrim\(staff_row\.verification_status\)\) in \(([^)]*)\)/.exec(MIGRATION);
    expect(match).not.toBeNull();
    const statuses = [...match![1]!.matchAll(/'([^']*)'/g)].map(([, status]) => status);
    expect(statuses).toEqual([...ACTIVE_STAFF_VERIFICATION_STATUSES]);
  });

  it('the guard answers the codes TokenService maps', () => {
    expect(MIGRATION).toContain("raise exception using errcode = '23514', message = 'SESSION_FACILITY_SELECTION_INVALID'");
    expect(MIGRATION).toContain("raise exception using errcode = '55000', message = 'SESSION_FACILITY_SELECTION_IMMUTABLE'");
  });

  it('every column the write and read name is one of the table\'s', async () => {
    const table = /create table auth\.session_facility_selection \(([\s\S]*?)\n\);/.exec(MIGRATION);
    expect(table).not.toBeNull();
    const columns = new Set([...table![1]!.matchAll(/^\s{2}([a-z_]+) (?:uuid|timestamptz|bigint)\b/gm)].map(([, name]) => name));
    expect([...columns].sort()).toEqual(['account_id', 'facility_id', 'family_id', 'membership_id', 'row_version', 'selected_at']);

    const { service, database, statements } = harness();
    database.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await service.recordFacilitySelection(input, event, jest.fn());
    await service.selectedFacilityId(sessionId, accountId);
    const write = statements[1]!;
    const read = normalized(database.query.mock.calls[0]![0]);
    const inserted = /^insert into auth\.session_facility_selection \(([^)]*)\)/.exec(write)![1]!
      .split(',').map((name) => name.trim());
    const updated = [.../ do update set (.*) returning /.exec(write)![1]!.matchAll(/(?:^|, )([a-z_]+) = /g)]
      .map(([, name]) => name);
    const returned = / returning ([a-z_]+)::text$/.exec(write)![1]!;
    const readColumns = [...read.matchAll(/\bselection\.([a-z_]+)/g)].map(([, name]) => name);
    expect(inserted).toEqual(['family_id', 'account_id', 'facility_id', 'membership_id']);
    expect(updated).toEqual(['facility_id', 'membership_id', 'selected_at', 'row_version']);
    expect(readColumns.length).toBeGreaterThan(0);
    for (const name of [...inserted, ...updated, returned, ...readColumns]) expect(columns).toContain(name);
  });
});
