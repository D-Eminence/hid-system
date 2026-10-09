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

import type { PoolClient } from 'pg';
import { PlatformSecurityService } from '../admin/platform-security.service';
import type { AuditService } from '../audit/audit.service';
import type { PlatformAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { assuredClient, platformActor, useTestEnvironment } from '../testing/platform-assurance';
import type { CurrentPatientContextService } from './current-patient-context.service';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { TokenService } from './token.service';

/**
 * Stage 5B (0073): a family revocation made by the Identity API itself takes
 * the account row lock before its UPDATE, in the same transaction, so it waits
 * for a refresh rotation in flight and then revokes the session that rotation
 * created. Sign-out and expiry take it first too, so every revocation locks the
 * account before its sessions. The two-connection races run in
 * verify-platform-security-runtime.mjs.
 */
const ACCOUNT = '40000000-0000-4000-8000-0000000000b1';
const SESSION = '70000000-0000-4000-8000-0000000000b1';
const FAMILY = '70000000-0000-4000-8000-0000000000b2';
const event = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPS' };
const refreshToken = `${SESSION}.opaque-refresh-secret.local`;
const LOCK = 'select auth.lock_account_sessions($1)';

type Statement = { sql: string; values: unknown[] };

/** Index of the lock and of the family UPDATE among one transaction's statements. */
function lockOrder(statements: Statement[], accountId: string) {
  const lock = statements.findIndex(({ sql, values }) => sql === LOCK && values[0] === accountId);
  const revoke = statements.findIndex(({ sql }) => sql.includes('update auth.sessions') && sql.includes('family_id = $1'));
  return { lock, revoke };
}

function refreshHarness(kind: 'staff' | 'platform',
  options: { storedRotated?: boolean; concurrentRotation?: boolean; expired?: boolean }) {
  const row = { id: SESSION, account_id: ACCOUNT, actor_subject: 'synthetic:lock', family_id: FAMILY,
    access_jti: '71000000-0000-4000-8000-0000000000b1', token_version: '1', authentication_method: 'password',
    session_kind: kind, patient_id: null,
    expires_at: new Date(Date.now() + (options.expired ? -60_000 : 600_000)),
    absolute_expires_at: new Date(Date.now() + 3_600_000),
    revoked_at: options.storedRotated ? new Date(Date.now() - 60_000) : null,
    revocation_reason: options.storedRotated ? 'rotated' : null };
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('refresh_token_sha256 = $1') && sql.includes('account.token_version = session.account_token_version')) {
      return { rowCount: 1, rows: [row] };
    }
    if (sql.includes('from auth.session_assurance')) return { rowCount: 1, rows: [{}] };
    if (sql.startsWith('select revocation_reason from auth.sessions where id = $1')) {
      return { rowCount: 1, rows: [{ revocation_reason: 'rotated' }] };
    }
    return { rowCount: 0, rows: [] };
  });
  // One statement list per transaction, so the lock is shown to share the UPDATE's transaction.
  const transactions: Statement[][] = [];
  const database = { query, withSystemTransaction: jest.fn(async (_id, work) => {
    const statements: Statement[] = [];
    transactions.push(statements);
    return work({ query: jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql: String(sql), values });
      return sql.includes("revocation_reason = 'rotated'") && options.concurrentRotation
        ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 };
    }) } as unknown as PoolClient);
  }) };
  const actor = { id: 'synthetic:lock', subject: 'synthetic:lock', accountId: ACCOUNT, email: null, displayName: null,
    authenticationMethod: 'local', kind, facilities: [], facilityIds: [] };
  const staff = { resolve: jest.fn().mockResolvedValue(actor), resolvePlatform: jest.fn().mockResolvedValue(actor) };
  const service = new TokenService(database as unknown as DatabaseService, staff as unknown as CurrentStaffContextService,
    {} as CurrentPatientContextService);
  return { service, transactions };
}

describe('session revocation serialization (Stage 5B)', () => {
  useTestEnvironment();

  describe.each<'staff' | 'platform'>(['staff', 'platform'])('a reused %s refresh token', (kind) => {
    const scope = kind === 'platform' ? 'platform' : 'standard';

    it.each([
      ['presented after its rotation', { storedRotated: true }],
      ['presented while its rotation is in flight', { concurrentRotation: true }],
    ])('%s locks the account before revoking its family', async (_case, options) => {
      const { service, transactions } = refreshHarness(kind, options);
      await expect(service.refresh(refreshToken, event, scope)).rejects.toBeDefined();
      const revoking = transactions.filter((statements) => lockOrder(statements, ACCOUNT).revoke >= 0);
      expect(revoking).toHaveLength(1);
      const { lock, revoke } = lockOrder(revoking[0] ?? [], ACCOUNT);
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(lock).toBeLessThan(revoke);
    });
  });

  // Sign-out and expiry end one session, but take the account row first too, so
  // they cannot deadlock with an administrator's revocation of the account.
  it('a sign-out locks the account before ending its session', async () => {
    const { service, transactions } = refreshHarness('staff', {});
    await service.revoke(SESSION, 'synthetic:lock', event);
    expect(transactions).toHaveLength(1);
    const statements = transactions[0] ?? [];
    const lock = statements.findIndex(({ sql, values }) => sql.includes('auth.lock_account_sessions(session_row.account_id)')
      && sql.includes('where session_row.id = $1') && values[0] === SESSION);
    const end = statements.findIndex(({ sql }) => sql.includes('update auth.sessions') && sql.includes("'logout'"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(end);
  });

  it('a sign-out ends the whole sign-in: the presented session and any session its family rotated into', async () => {
    const { service, transactions } = refreshHarness('staff', {});
    await service.revoke(SESSION, 'synthetic:lock', event);
    const signOut = (transactions[0] ?? []).find(({ sql }) => sql.includes('update auth.sessions') && sql.includes("'logout'"));
    expect(signOut?.sql).toMatch(/where family_id = \(select presented\.family_id from auth\.sessions presented where presented\.id = \$1\)\s+and \(id = \$1 or revoked_at is null\)/);
    expect(signOut?.values).toEqual([SESSION]);
  });

  it.each<'staff' | 'platform'>(['staff', 'platform'])('an expired %s session locks the account before it is marked expired',
    async (kind) => {
      const { service, transactions } = refreshHarness(kind, { expired: true });
      await expect(service.refresh(refreshToken, event, kind === 'platform' ? 'platform' : 'standard')).rejects.toBeDefined();
      expect(transactions).toHaveLength(1);
      const statements = transactions[0] ?? [];
      const lock = statements.findIndex(({ sql, values }) => sql === LOCK && values[0] === ACCOUNT);
      const end = statements.findIndex(({ sql }) => sql.includes('update auth.sessions') && sql.includes("'expired'"));
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(lock).toBeLessThan(end);
    });

  it('an administrator revoking their own session locks their account before revoking the family', async () => {
    const actor = platformActor();
    const context: PlatformAccessContext = { scope: 'platform', correlationId: 'lock-correlation', facilityId: null,
      membershipId: null, purposeOfUse: 'healthcare-operations', actor };
    const statements: Statement[] = [];
    const command = jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql: String(sql), values });
      if (sql.startsWith('select family_id::text from auth.sessions')) return { rowCount: 1, rows: [{ family_id: FAMILY }] };
      return { rowCount: 2, rows: [] };
    });
    const client = assuredClient(command);
    const database = { withTransaction: jest.fn(async (_context, work) => work(client)) } as unknown as DatabaseService;
    const tokens = { recordSessionEvent: jest.fn().mockResolvedValue(undefined) } as unknown as TokenService;
    const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const service = new PlatformSecurityService(database, audit, tokens);

    await expect(service.revokeOwnSession(context, SESSION, event)).resolves.toEqual({ sessionId: SESSION, revokedCount: 2 });
    const { lock, revoke } = lockOrder(statements, actor.accountId!);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(revoke);
  });
});
