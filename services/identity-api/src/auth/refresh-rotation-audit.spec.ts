jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
  SignJWT: class {
    setProtectedHeader() { return this; }
    setSubject() { return this; }
    setIssuer() { return this; }
    setAudience() { return this; }
    setJti() { return this; }
    setIssuedAt() { return this; }
    setExpirationTime() { return this; }
    async sign() { return 'signed-access-token'; }
  },
}));

import { UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ActorContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { useTestEnvironment } from '../testing/platform-assurance';
import type { CurrentPatientContextService } from './current-patient-context.service';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { TokenService } from './token.service';

/**
 * A6: a refresh's auth.refresh audit event commits with its rotation. The
 * controller writes it through refresh()'s `onRotated` hook
 * (RefreshRotationHook), which runs in the rotation's own transaction after
 * the new session, the rotated mark and the 'rotated' session event, and
 * before COMMIT. A failing hook rolls the rotation back, so the presented
 * refresh token is still the live one and renews the sign-in on a retry,
 * instead of being spent with no cookie to replace it (and then treated as
 * reuse). A reused token never reaches the hook.
 */
const ACCOUNT = '40000000-0000-4000-8000-0000000000a6';
const SESSION = '70000000-0000-4000-8000-0000000000a6';
const FAMILY = '70000000-0000-4000-8000-0000000000a7';
const event = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNA6' };
const refreshToken = `${SESSION}.opaque-refresh-secret.local`;
const ROTATE = "revocation_reason = 'rotated'";
const LOCK = 'select auth.lock_account_sessions($1)';

type Statement = { sql: string; values: unknown[] };

/**
 * A TokenService over a stub database that keeps the presented session's
 * state: each transaction records its statements and ends with COMMIT or, when
 * its work rejects, ROLLBACK, as DatabaseService does. Only a committed
 * rotation marks the stored session rotated.
 */
function harness(options: { storedRotated?: boolean; concurrentRotation?: boolean } = {}) {
  const stored = {
    revoked_at: options.storedRotated ? new Date(Date.now() - 60_000) : null as Date | null,
    revocation_reason: options.storedRotated ? 'rotated' : null as string | null,
  };
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('refresh_token_sha256 = $1') && sql.includes('account.token_version = session.account_token_version')) {
      return { rowCount: 1, rows: [{ id: SESSION, account_id: ACCOUNT, actor_subject: 'synthetic:a6', family_id: FAMILY,
        access_jti: '71000000-0000-4000-8000-0000000000a6', token_version: '1', authentication_method: 'password',
        session_kind: 'staff', patient_id: null, expires_at: new Date(Date.now() + 600_000),
        absolute_expires_at: new Date(Date.now() + 3_600_000), ...stored }] };
    }
    if (sql.includes('from auth.session_assurance')) return { rowCount: 1, rows: [{}] };
    if (sql.startsWith('select revocation_reason from auth.sessions where id = $1')) {
      return { rowCount: 1, rows: [{ revocation_reason: 'rotated' }] };
    }
    return { rowCount: 0, rows: [] };
  });
  const transactions: Statement[][] = [];
  const clients: PoolClient[] = [];
  const database = { query, withSystemTransaction: jest.fn(async (_id: string,
    work: (client: PoolClient) => Promise<unknown>) => {
    const statements: Statement[] = [];
    transactions.push(statements);
    const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql: String(sql), values });
      return sql.includes(ROTATE) && options.concurrentRotation ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 };
    }) } as unknown as PoolClient;
    clients.push(client);
    try {
      const result = await work(client);
      statements.push({ sql: 'COMMIT', values: [] });
      if (statements.some(({ sql }) => sql.includes(ROTATE))) {
        Object.assign(stored, { revoked_at: new Date(), revocation_reason: 'rotated' });
      }
      return result;
    } catch (error) {
      statements.push({ sql: 'ROLLBACK', values: [] });
      throw error;
    }
  }) };
  const actor = { id: 'synthetic:a6', subject: 'synthetic:a6', accountId: ACCOUNT, email: null, displayName: null,
    authenticationMethod: 'local', facilities: [], facilityIds: [] } as unknown as ActorContext;
  const staff = { resolve: jest.fn().mockResolvedValue(actor) };
  const service = new TokenService(database as unknown as DatabaseService, staff as unknown as CurrentStaffContextService,
    {} as CurrentPatientContextService);
  return { service, actor, query, transactions, clients };
}

/** A hook that writes an audit row on the transaction it is given, as AuthController's does. */
function auditing() {
  return jest.fn(async (client: PoolClient, rotated: ActorContext) => {
    await client.query('insert into audit.events (action, resource_id) values ($1, $2)', ['auth.refresh', rotated.sessionId]);
  });
}

const kinds = (statements: Statement[]) => statements.map(({ sql }) => sql.includes('insert into auth.sessions') ? 'session'
  : sql.includes(ROTATE) ? 'rotated' : sql.includes('insert into auth.session_events') ? 'event'
    : sql.includes('insert into audit.events') ? 'audit' : sql);

describe('refresh rotation commits with its audit (A6)', () => {
  useTestEnvironment();

  it('runs onRotated in the rotation\'s transaction, after the rotation and before COMMIT', async () => {
    const { service, actor, transactions, clients } = harness();
    const onRotated = auditing();
    const result = await service.refresh(refreshToken, event, 'standard', onRotated);
    expect(transactions).toHaveLength(1);
    expect(kinds(transactions[0] ?? [])).toEqual(['session', 'rotated', 'event', 'audit', 'COMMIT']);
    expect(onRotated).toHaveBeenCalledTimes(1);
    expect(onRotated).toHaveBeenCalledWith(clients[0], { ...actor, sessionId: result.actor.sessionId });
    expect(result.actor).toEqual({ ...actor, sessionId: result.actor.sessionId });
    expect(result.actor.sessionId).not.toBe(SESSION);
  });

  it('rolls the rotation back when onRotated fails, so the presented token still refreshes once', async () => {
    const { service, query, transactions } = harness();
    const fault = Object.assign(new Error('audit insert failed'), { code: '23503' });
    await expect(service.refresh(refreshToken, event, 'standard', jest.fn().mockRejectedValue(fault))).rejects.toBe(fault);
    // One transaction, rolled back; the failure is not mistaken for reuse.
    expect(transactions).toHaveLength(1);
    expect(kinds(transactions[0] ?? [])).toEqual(['session', 'rotated', 'event', 'ROLLBACK']);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('select revocation_reason'))).toBe(false);
    expect(transactions.flat().some(({ sql }) => sql === LOCK || sql.includes('family_id = $1'))).toBe(false);

    // The retry renews the sign-in, and commits with its audit.
    const retry = auditing();
    await expect(service.refresh(refreshToken, event, 'standard', retry)).resolves.toMatchObject({
      refreshToken: expect.any(String) });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(kinds(transactions[1] ?? [])).toEqual(['session', 'rotated', 'event', 'audit', 'COMMIT']);

    // Once: presented again after that rotation committed, the token is reuse.
    const reused = auditing();
    await expect(service.refresh(refreshToken, event, 'standard', reused)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(reused).not.toHaveBeenCalled();
  });

  it.each([
    ['presented after its rotation', { storedRotated: true }],
    ['presented while its rotation is in flight', { concurrentRotation: true }],
  ])('a reused token %s never runs onRotated, and its family is still revoked', async (_case, options) => {
    const { service, transactions } = harness(options);
    const onRotated = auditing();
    await expect(service.refresh(refreshToken, event, 'standard', onRotated)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(onRotated).not.toHaveBeenCalled();
    expect(transactions.flat().some(({ sql }) => sql.includes('insert into audit.events'))).toBe(false);
    const revoking = transactions.filter((statements) => statements.some(({ sql }) => sql.includes('family_id = $1')));
    expect(revoking).toHaveLength(1);
    const statements = revoking[0] ?? [];
    const lock = statements.findIndex(({ sql, values }) => sql === LOCK && values[0] === ACCOUNT);
    const revoke = statements.findIndex(({ sql }) => sql.includes('update auth.sessions') && sql.includes('family_id = $1'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(revoke);
    expect(statements.at(-1)?.sql).toBe('COMMIT');
  });
});
