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

function harness(stored?: { session_kind: 'staff' | 'patient' }) {
  const lookups: Statement[] = [];
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    lookups.push({ sql, values });
    const row = stored && { id: SESSION, account_id: ACCOUNT, actor_subject: 'synthetic:sign-out', ...stored };
    return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
  });
  const transactions: Statement[][] = [];
  const database = { query, withSystemTransaction: jest.fn(async (_id, work) => {
    const statements: Statement[] = [];
    transactions.push(statements);
    return work({ query: jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql: String(sql), values });
      return sql.includes('update auth.sessions') ? { rowCount: 1, rows: [{ account_id: ACCOUNT }] } : { rowCount: 0, rows: [] };
    }) } as unknown as PoolClient);
  }) };
  const service = new TokenService(database as unknown as DatabaseService, {} as CurrentStaffContextService,
    {} as CurrentPatientContextService);
  return { service, lookups, transactions };
}

describe('sign-out by refresh token', () => {
  useTestEnvironment();

  it('finds only a sign-in that is still live, by the token\'s hash', async () => {
    const { service, lookups } = harness();
    await expect(service.revokeByRefreshToken(refreshToken, event)).resolves.toBeUndefined();
    expect(lookups).toHaveLength(1);
    const [lookup] = lookups;
    const sql = flat(lookup?.sql);
    expect(sql).toContain('session.refresh_token_sha256 = $1');
    expect(sql).toContain("session.session_kind in ('staff', 'patient')");
    expect(sql).toContain(ACCOUNT_LIVE);
    expect(sql).toContain('session.absolute_expires_at > clock_timestamp()');
    // Its own session is live, or it was rotated into a session that still is:
    // a cookie of a sign-in already ended, replayed, finds nothing to end again.
    expect(sql).toContain(`((session.revoked_at is null and session.expires_at > clock_timestamp()) or (session.revocation_reason = 'rotated' and ${FAMILY_LIVE}))`);
    expect(lookup?.values).toHaveLength(1);
    expect(lookup?.values[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(lookup?.values[0]).not.toBe(refreshToken);
  });

  it('changes nothing when no such session exists: a platform, ended or unknown token', async () => {
    const { service, transactions } = harness();
    await expect(service.revokeByRefreshToken(refreshToken, event)).resolves.toBeUndefined();
    expect(transactions).toHaveLength(0);
  });

  it('ends the whole sign-in as a sign-out does: account lock first, then the family, then the event', async () => {
    const { service, transactions } = harness({ session_kind: 'patient' });
    await expect(service.revokeByRefreshToken(refreshToken, event)).resolves.toEqual({ sessionId: SESSION,
      accountId: ACCOUNT, actorSubject: 'synthetic:sign-out', kind: 'patient' });
    expect(transactions).toHaveLength(1);
    const statements = transactions[0] ?? [];
    const lock = statements.findIndex(({ sql, values }) => sql.includes('auth.lock_account_sessions(session_row.account_id)')
      && values[0] === SESSION);
    const end = statements.findIndex(({ sql, values }) => sql.includes('update auth.sessions') && sql.includes("'logout'")
      && /and \(id = \$1 or revoked_at is null\)/.test(sql) && values[0] === SESSION);
    const recorded = statements.findIndex(({ sql }) => sql.includes('insert into auth.session_events'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(end);
    expect(end).toBeLessThan(recorded);
    const sessionEvent = statements[recorded];
    expect(sessionEvent?.values.slice(0, 4)).toEqual([SESSION, ACCOUNT, 'logout', 'success']);
    expect(JSON.parse(String(sessionEvent?.values[7]))).toEqual({ actor_subject: 'synthetic:sign-out', presented: 'refresh_token' });
  });

  it('refuses a sign-in of another kind than the calling app names, before ending anything', async () => {
    const { service, transactions } = harness({ session_kind: 'staff' });
    await expect(service.revokeByRefreshToken(refreshToken, event, 'patient')).resolves.toEqual({ refusedKind: 'staff' });
    expect(transactions).toHaveLength(0);
  });

  it('ends a sign-in of the kind the calling app names', async () => {
    const { service, transactions } = harness({ session_kind: 'staff' });
    await expect(service.revokeByRefreshToken(refreshToken, event, 'staff')).resolves.toEqual(expect.objectContaining({
      sessionId: SESSION, kind: 'staff' }));
    expect(transactions).toHaveLength(1);
  });

  it('records an access-token sign-out without the refresh marker', async () => {
    const { service, transactions } = harness();
    await service.revoke(SESSION, 'synthetic:sign-out', event);
    const sessionEvent = (transactions[0] ?? []).find(({ sql }) => sql.includes('insert into auth.session_events'));
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
    expect(sql).toContain(ACCOUNT_LIVE);
    expect(sql).toContain('session.absolute_expires_at > clock_timestamp()');
    // Only a token rotated moments ago, by the other app's tab, into a sign-in
    // that is still live: an older rotated token is reuse, which refresh()
    // detects and answers by ending the whole sign-in.
    expect(sql).toContain(`((session.revoked_at is null and session.expires_at > clock_timestamp()) or (session.revocation_reason = 'rotated' and session.revoked_at > clock_timestamp() - make_interval(secs => $2) and ${FAMILY_LIVE}))`);
    expect(lookups[0]?.values[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(lookups[0]?.values[1]).toBe(60);
  });

  it('has no kind for any other token, which refresh() then refuses', async () => {
    const { service } = harness();
    await expect(service.refreshSessionKind(refreshToken)).resolves.toBeUndefined();
  });
});
