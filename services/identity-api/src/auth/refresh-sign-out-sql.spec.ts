jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));

import type { PoolClient } from 'pg';
import type { DatabaseService } from '../database/database.service';
import { useTestEnvironment } from '../testing/platform-assurance';
import type { CurrentPatientContextService } from './current-patient-context.service';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { TokenService } from './token.service';

// The statements behind sign-out by refresh cookie and the client-kind refresh
// check. The HTTP runs are in scripts/verify-session-sign-out-runtime.mjs.
const ACCOUNT = '40000000-0000-4000-8000-0000000000c1';
const SESSION = '70000000-0000-4000-8000-0000000000c1';
const event = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPT' };
const refreshToken = `${SESSION}.opaque-refresh-secret.local`;

type Statement = { sql: string; values: unknown[] };

/** The statement on one line, so assertions do not depend on its layout. */
const flat = (sql = '') => sql.replace(/\s+/g, ' ');

/** refresh()'s account checks: a lookup that skips them answers for a sign-in refresh() would refuse. */
const ACCOUNT_LIVE = "account.status = 'active' and (account.disabled_until is null or account.disabled_until <= clock_timestamp()) and account.token_version = session.account_token_version";
/** The sign-in a rotated token was exchanged into is still live. */
const FAMILY_LIVE = 'exists (select 1 from auth.sessions live where live.family_id = session.family_id and live.revoked_at is null and live.expires_at > clock_timestamp())';
/** A sign-in refresh() could renew now: live, or rotated moments ago (the other app's tab) into one that is. */
const RENEWABLE = `${ACCOUNT_LIVE} and session.absolute_expires_at > clock_timestamp() and ((session.revoked_at is null and session.expires_at > clock_timestamp()) or (session.revocation_reason = 'rotated' and session.revoked_at > clock_timestamp() - make_interval(secs => $2) and ${FAMILY_LIVE}))`;

type Stored = { session_kind: 'staff' | 'patient'; renewable?: boolean };

/** `left`: whether the family still has an unrevoked session when the sign-out ends it, under the account lock. */
function harness(stored?: Stored, left = true) {
  const lookups: Statement[] = [];
  const row = stored && { id: SESSION, account_id: ACCOUNT, actor_subject: 'synthetic:sign-out', renewable: true, ...stored };
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    lookups.push({ sql, values });
    return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
  });
  const transactions: Statement[][] = [];
  const database = { query, withSystemTransaction: jest.fn(async (_id, work) => {
    const statements: Statement[] = [];
    transactions.push(statements);
    return work({ query: jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql: String(sql), values });
      if (sql.includes('update auth.sessions')) return left ? { rowCount: 1, rows: [{ account_id: ACCOUNT }] } : { rowCount: 0, rows: [] };
      if (sql.includes('as renewable')) return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    }) } as unknown as PoolClient);
  }) };
  const service = new TokenService(database as unknown as DatabaseService, {} as CurrentStaffContextService,
    {} as CurrentPatientContextService);
  return { service, lookups, transactions };
}

const position = (statements: Statement[], test: (statement: Statement) => boolean) => statements.findIndex(test);
const isLock = ({ sql, values }: Statement) => sql.includes('auth.lock_account_sessions(session_row.account_id)')
  && flat(sql).includes("session_row.refresh_token_sha256 = $1 and session_row.session_kind in ('staff', 'patient')")
  && /^[0-9a-f]{64}$/.test(String(values[0]));
const isLookup = ({ sql }: Statement) => sql.includes('as renewable');
const isEnd = ({ sql, values }: Statement) => sql.includes('update auth.sessions') && sql.includes("'logout'")
  && flat(sql).includes('where presented.id = $1) and revoked_at is null returning') && values[0] === SESSION;
const isEvent = ({ sql }: Statement) => sql.includes('insert into auth.session_events');

describe('sign-out by refresh token', () => {
  useTestEnvironment();

  it('reads the sign-in under its account lock, by the token\'s hash, and finds any sign-in with something left to end', async () => {
    const { service, lookups, transactions } = harness();
    await expect(service.revokeByRefreshToken(refreshToken, event)).resolves.toBeUndefined();
    // Read in the transaction, after the account lock: a sign-out or
    // revocation that committed first is seen, and not recorded again.
    expect(lookups).toHaveLength(0);
    const statements = transactions[0] ?? [];
    expect(position(statements, isLock)).toBe(0);
    expect(position(statements, isLookup)).toBe(1);
    const lookup = statements[1];
    const sql = flat(lookup?.sql);
    expect(sql).toContain('session.refresh_token_sha256 = $1');
    expect(sql).toContain("session.session_kind in ('staff', 'patient')");
    // Its own session is unrevoked, or it was rotated into one that is.
    // Neither expiry nor the account's state keeps a sign-in from ending: a
    // timed suspension lapses, and refresh() would renew the sign-in again.
    expect(sql).toContain("and (session.revoked_at is null or (session.revocation_reason = 'rotated' and exists (select 1 from auth.sessions unended where unended.family_id = session.family_id and unended.revoked_at is null)))");
    const where = sql.split(' on account.id = session.account_id where ')[1] ?? '';
    expect(where).toMatch(/^session\.refresh_token_sha256 = \$1 /);
    for (const condition of ['account.', 'expires_at', 'absolute_expires_at', 'make_interval']) expect(where).not.toContain(condition);
    // Whether the app may be named is read from the same row.
    expect(sql).toContain(`coalesce(${RENEWABLE}, false) as renewable`);
    expect(lookup?.values).toHaveLength(2);
    expect(lookup?.values[0]).toBe(statements[0]?.values[0]);
    expect(lookup?.values[0]).not.toBe(refreshToken);
    expect(lookup?.values[1]).toBe(60);
  });

  it('changes nothing when nothing of the sign-in is left: a platform, ended or unknown token', async () => {
    const { service, transactions } = harness();
    await expect(service.revokeByRefreshToken(refreshToken, event, 'patient')).resolves.toBeUndefined();
    const statements = transactions[0] ?? [];
    expect(position(statements, ({ sql }) => sql.includes('update auth.sessions'))).toBe(-1);
    expect(position(statements, isEvent)).toBe(-1);
  });

  it('ends the whole sign-in as a sign-out does: account lock first, then the read, the family and the event', async () => {
    const { service, transactions } = harness({ session_kind: 'patient' });
    await expect(service.revokeByRefreshToken(refreshToken, event)).resolves.toEqual({ sessionId: SESSION,
      accountId: ACCOUNT, actorSubject: 'synthetic:sign-out', kind: 'patient' });
    expect(transactions).toHaveLength(1);
    const statements = transactions[0] ?? [];
    const lock = position(statements, isLock), lookup = position(statements, isLookup);
    const end = position(statements, isEnd), recorded = position(statements, isEvent);
    expect([lock, lookup]).toEqual([0, 1]);
    expect(lookup).toBeLessThan(end);
    expect(end).toBeLessThan(recorded);
    const sessionEvent = statements[recorded];
    expect(sessionEvent?.values.slice(0, 4)).toEqual([SESSION, ACCOUNT, 'logout', 'success']);
    expect(JSON.parse(String(sessionEvent?.values[7]))).toEqual({ actor_subject: 'synthetic:sign-out', presented: 'refresh_token' });
  });

  it('refuses a sign-in of another kind than the calling app names, that refresh() could renew, before ending anything', async () => {
    const { service, transactions } = harness({ session_kind: 'staff', renewable: true });
    await expect(service.revokeByRefreshToken(refreshToken, event, 'patient')).resolves.toEqual({ refusedKind: 'staff' });
    const statements = transactions[0] ?? [];
    expect(position(statements, ({ sql }) => sql.includes('update auth.sessions'))).toBe(-1);
    expect(position(statements, isEvent)).toBe(-1);
  });

  it('ends, without naming its kind, a sign-in of the other kind that refresh() could not renew now', async () => {
    // An older rotated token (reuse), an idle-expired sign-in, or one whose
    // account is suspended for now: the answer is the same as for the app's
    // own sign-in, so it tells nobody whether, or as which app, it is live.
    const { service, transactions } = harness({ session_kind: 'staff', renewable: false });
    await expect(service.revokeByRefreshToken(refreshToken, event, 'patient')).resolves.toEqual({ sessionId: SESSION,
      accountId: ACCOUNT, actorSubject: 'synthetic:sign-out', kind: 'staff' });
    const statements = transactions[0] ?? [];
    expect(position(statements, isEnd)).toBeGreaterThan(position(statements, isLookup));
    expect(position(statements, isEvent)).toBeGreaterThan(position(statements, isEnd));
  });

  it('ends a sign-in of the kind the calling app names', async () => {
    const { service, transactions } = harness({ session_kind: 'staff' });
    await expect(service.revokeByRefreshToken(refreshToken, event, 'staff')).resolves.toEqual(expect.objectContaining({
      sessionId: SESSION, kind: 'staff' }));
    expect(position(transactions[0] ?? [], isEnd)).toBeGreaterThan(-1);
  });

  it('records nothing and ends nothing more when a concurrent sign-out ended the sign-in first', async () => {
    const byRefresh = harness({ session_kind: 'patient' }, false);
    await expect(byRefresh.service.revokeByRefreshToken(refreshToken, event)).resolves.toBeUndefined();
    expect(position(byRefresh.transactions[0] ?? [], isEvent)).toBe(-1);
    const byAccess = harness(undefined, false);
    await expect(byAccess.service.revoke(SESSION, 'synthetic:sign-out', event)).resolves.toBe(false);
    expect(position(byAccess.transactions[0] ?? [], isEvent)).toBe(-1);
  });

  it('records an access-token sign-out without the refresh marker', async () => {
    const { service, transactions } = harness();
    await expect(service.revoke(SESSION, 'synthetic:sign-out', event)).resolves.toBe(true);
    const statements = transactions[0] ?? [];
    expect(statements[0]?.sql).toContain('auth.lock_account_sessions(session_row.account_id) from auth.sessions session_row where session_row.id = $1');
    const sessionEvent = statements.find(isEvent);
    expect(JSON.parse(String(sessionEvent?.values[7]))).toEqual({ actor_subject: 'synthetic:sign-out' });
  });
});

describe('refresh session kind', () => {
  useTestEnvironment();

  it('reads the kind of a live or just-rotated staff or patient session, without a transaction', async () => {
    const { service, lookups, transactions } = harness({ session_kind: 'staff' });
    await expect(service.refreshSessionKind(refreshToken)).resolves.toBe('staff');
    expect(transactions).toHaveLength(0);
    const sql = flat(lookups[0]?.sql);
    expect(sql).toContain("session.session_kind in ('staff', 'patient')");
    // Only a token rotated moments ago, by the other app's tab, into a sign-in
    // that is still live: an older rotated token is reuse, which refresh()
    // detects and answers by ending the whole sign-in.
    expect(sql).toContain(`and ${RENEWABLE}`);
    expect(lookups[0]?.values[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(lookups[0]?.values[1]).toBe(60);
  });

  it('has no kind for any other token, which refresh() then refuses', async () => {
    const { service } = harness();
    await expect(service.refreshSessionKind(refreshToken)).resolves.toBeUndefined();
  });
});
