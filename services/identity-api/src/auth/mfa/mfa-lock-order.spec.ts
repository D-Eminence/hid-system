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
import type { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { PlatformAccessContext } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import {
  assuredClient, isAssuranceQuery, assuranceResult, platformActor, useTestEnvironment,
} from '../../testing/platform-assurance';
import { CurrentStaffContextService } from '../current-staff-context.service';
import type { LocalAuthProvider } from '../local-auth.provider';
import { requirePlatformAssurance } from '../platform-assurance';
import { TokenService } from '../token.service';
import type { MfaSecretProtector } from './mfa-secret-protector';
import { MfaService } from './mfa.service';
import { totp } from './totp';

/**
 * Stage 7A: every platform MFA transaction locks the account row
 * (auth.lock_account_for_mfa, 0076: FOR NO KEY UPDATE) before any other row
 * lock or write.
 *
 * An approved MFA reset (auth.admin_decide_approval, 0070) locks the target
 * account and then revokes its factors, recovery codes and sessions. A sign-in,
 * step-up, recovery-code or enrolment transaction that first locked the factor
 * (or wrote a challenge or recovery code) and only then reached the account,
 * through the FOR KEY SHARE that its session event, session or recovery code
 * insert takes on the account row, held the authenticator while waiting for
 * the account, and the reset held the account while waiting for the
 * authenticator. Taking the account first gives every one of these
 * transactions the order the reset and the 0073 revocations use. FOR NO KEY
 * UPDATE conflicts with their FOR UPDATE and with itself, so MFA transactions
 * of one account run one at a time, but not with the FOR KEY SHARE of a refresh
 * rotation or a staff sign-in of the account; the MFA transaction never takes
 * the revocation lock (auth.lock_account_sessions, FOR UPDATE). The lock mode
 * is pinned by mfa-account-lock.integration.sql, and the two-connection races
 * run in verify-platform-security-runtime.mjs.
 */
const ACCOUNT = '40000000-0000-4000-8000-0000000000c1';
const FACTOR = '41000000-0000-4000-8000-0000000000c1';
const OTHER_FACTOR = '41000000-0000-4000-8000-0000000000c2';
const CHALLENGE = '42000000-0000-4000-8000-0000000000c1';
const FAMILY = '43000000-0000-4000-8000-0000000000c1';
const TOKEN = 'C'.repeat(43);
const SECRET = Buffer.from('12345678901234567890', 'ascii');
const NOW = 1_700_000_000_000;
const LOCK = 'select auth.lock_account_for_mfa($1)';
const REVOCATION_LOCK = /auth\.lock_account_sessions/;
const event = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPT', sourceIp: '192.0.2.10' };

type Statement = { sql: string; values: unknown[] };
type Options = {
  activeFactor?: boolean; lockedChallenge?: boolean;
  /** The step-up's locked session read: no row (the session rotated or ended), or verified by another factor. */
  assurance?: 'none' | 'other-factor';
  /** Every MFA rate-limit bucket is blocked: the failure budgets and the request budget. */
  blocked?: boolean;
};

/** Any statement that takes a row, advisory or foreign-key lock, or writes. */
const LOCKING = /\bfor\s+update\b|^\s*(update|insert|delete)\b|pg_advisory_xact_lock|auth\.upgrade_legacy_password/i;

function harness(options: Options = {}) {
  const transactions: Statement[][] = [];
  const respond = (sql: string) => {
    if (isAssuranceQuery(sql)) return assuranceResult();
    if (sql.includes('auth.account_has_platform_permission')) {
      return { rowCount: 1, rows: [{ eligible: true, enrolled: true, token_version: '3', subject: 'synthetic:mfa-lock' }] };
    }
    if (sql.includes('from auth.mfa_login_challenges challenge')) {
      // The locked re-read of the challenge may be told to find nothing.
      if (options.lockedChallenge === false && /for update of challenge/.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ id: CHALLENGE, account_id: ACCOUNT, subject: 'synthetic:mfa-lock', email: null,
        failed_attempts: 0, max_attempts: 5, expires_at: new Date(Date.now() + 120_000) }] };
    }
    if (sql.includes('from auth.mfa_factors') && /for update/.test(sql)) {
      const pending = sql.includes("status = 'pending'");
      if (!pending && options.activeFactor === false) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ id: FACTOR, secret_ciphertext: Buffer.from('ciphertext'),
        secret_key_version: 'v1', last_used_step: null }] };
    }
    if (sql.includes('insert into auth.mfa_login_challenges')) return { rowCount: 1, rows: [{ expires_at: new Date() }] };
    if (sql.includes('insert into auth.mfa_factors')) return { rowCount: 1, rows: [{ enrollment_expires_at: new Date() }] };
    if (/for update of assurance/.test(sql)) {
      if (options.assurance === 'none') return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ family_id: FAMILY,
        mfa_factor_id: options.assurance === 'other-factor' ? OTHER_FACTOR : FACTOR }] };
    }
    if (sql.includes('update auth.session_assurance')) return { rowCount: 1, rows: [{ step_up_expires_at: new Date() }] };
    if (options.blocked && sql.includes('as blocked')) return { rowCount: 1, rows: [{ blocked: true }] };
    if (options.blocked && sql.includes('from auth.otp_rate_limits')) {
      return { rowCount: 1, rows: [{ request_count: 6, window_started_at: new Date(Date.now() - 60_000),
        blocked_until: new Date(Date.now() + 60_000) }] };
    }
    if (sql.includes('from auth.otp_rate_limits')) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [] };
  };
  // One statement list per transaction, so the lock is shown to share the authenticator's transaction.
  const begin = () => {
    const statements: Statement[] = [];
    transactions.push(statements);
    return { query: jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql: String(sql), values });
      return respond(String(sql));
    }) } as unknown as PoolClient;
  };
  const database = {
    withSystemTransaction: jest.fn(async (_correlationId: string, work: (client: PoolClient) => unknown) => work(begin())),
    withTransaction: jest.fn(async (_context: unknown, work: (client: PoolClient) => unknown) => work(begin())),
  } as unknown as DatabaseService;
  const protector = {
    assertConfigured: jest.fn(), keyVersion: 'v1',
    tokenDigest: (value: string) => `digest:${value.length}`,
    rateBucket: (...parts: string[]) => parts.join(':'),
    recoveryCodeDigest: (_accountId: string, code: string) => `code:${code}`,
    encryptSecret: () => Buffer.from('ciphertext'),
    decryptSecret: () => Buffer.from(SECRET),
  } as unknown as MfaSecretProtector;
  // The collaborators write in the caller's transaction, as the real ones do.
  const tokens = {
    recordSessionEvent: jest.fn(async (client: PoolClient, input: { accountId: string; eventType: string }) => {
      await client.query('insert into auth.session_events (account_id, event_type) values ($1, $2)',
        [input.accountId, input.eventType]);
    }),
    issuePlatformSession: jest.fn(async (client: PoolClient, assurance: { accountId: string }) => {
      await client.query('insert into auth.sessions (account_id) values ($1)', [assurance.accountId]);
      return { actor: { sessionId: '44000000-0000-4000-8000-0000000000c1' } };
    }),
  } as unknown as TokenService;
  const audit = {
    recordWithClient: jest.fn(async (client: PoolClient, input: { actorAccountId?: string }) => {
      await client.query('insert into audit.events (actor_account_id) values ($1)', [input.actorAccountId ?? null]);
    }),
  } as unknown as AuditService;
  const localProvider = {
    authenticate: jest.fn().mockResolvedValue({ accountId: ACCOUNT, subject: 'synthetic:mfa-lock' }),
    principalHash: () => 'principal-hash',
  } as unknown as LocalAuthProvider;
  const service = new MfaService(database, protector, tokens, localProvider, audit, () => NOW);
  return { service, transactions, database };
}

/** The account lock must be the first locking statement of the (only) transaction that touches the authenticator. */
function expectAccountFirst(transactions: Statement[][]) {
  expect(transactions).toHaveLength(1);
  const statements = transactions[0] ?? [];
  const lock = statements.findIndex(({ sql }) => sql === LOCK);
  const firstOther = statements.findIndex(({ sql }) => sql !== LOCK && LOCKING.test(sql));
  expect(lock).toBeGreaterThanOrEqual(0);
  expect(statements[lock]?.values).toEqual([ACCOUNT]);
  expect(firstOther).toBeGreaterThan(lock);
  expect(statements.filter(({ sql }) => sql === LOCK)).toHaveLength(1);
  // Never the FOR UPDATE revocation lock, which would also wait for refresh rotations and staff sign-ins.
  expect(statements.filter(({ sql }) => REVOCATION_LOCK.test(sql))).toEqual([]);
  return statements;
}

function platformContext(): PlatformAccessContext {
  return { scope: 'platform', correlationId: 'mfa-lock-correlation', facilityId: null, membershipId: null,
    purposeOfUse: 'healthcare-operations', actor: platformActor({ accountId: ACCOUNT, subject: 'synthetic:mfa-lock' }) };
}

describe('platform MFA lock order (Stage 7A)', () => {
  useTestEnvironment();

  it('the password step locks the account before it supersedes and issues challenges', async () => {
    const { service, transactions } = harness();
    await expect(service.beginLogin('admin@example.invalid', 'Synthetic-Password-2026', event))
      .resolves.toMatchObject({ purpose: 'verify' });
    const statements = expectAccountFirst(transactions);
    // The eligibility read sees the account only after the lock.
    const eligibility = statements.findIndex(({ sql }) => sql.includes('auth.account_has_platform_permission'));
    expect(eligibility).toBeGreaterThan(statements.findIndex(({ sql }) => sql === LOCK));
  });

  it('a TOTP sign-in locks the account before the challenge, the factor and its session', async () => {
    const { service, transactions } = harness();
    await expect(service.completeLogin(TOKEN, { code: totp(SECRET, NOW) }, event)).resolves.toBeDefined();
    const statements = expectAccountFirst(transactions);
    expect(statements.some(({ sql }) => /from auth\.mfa_factors[\s\S]*for update/.test(sql))).toBe(true);
  });

  it('a recovery-code sign-in locks the account before the factor and the code it spends', async () => {
    const { service, transactions } = harness();
    await expect(service.completeLogin(TOKEN, { recoveryCode: 'ABCDE-FGHJK' }, event)).resolves.toBeDefined();
    const statements = expectAccountFirst(transactions);
    expect(statements.some(({ sql }) => sql.includes('update auth.mfa_recovery_codes code set used_at'))).toBe(true);
  });

  it('a failed second factor locks the account before it records the failure', async () => {
    const { service, transactions } = harness();
    const wrong = totp(SECRET, NOW) === '000000' ? '111111' : '000000';
    await expect(service.completeLogin(TOKEN, { code: wrong }, event)).rejects.toMatchObject({ code: 'MFA_INVALID_CODE' });
    expectAccountFirst(transactions);
  });

  it('starting enrolment locks the account before it replaces a pending factor', async () => {
    const { service, transactions } = harness({ activeFactor: false });
    await expect(service.startEnrollment(TOKEN, event)).resolves.toMatchObject({ digits: 6 });
    expectAccountFirst(transactions);
  });

  it('activating enrolment locks the account before the pending factor and the new recovery codes', async () => {
    const { service, transactions } = harness();
    await expect(service.activateEnrollment(TOKEN, totp(SECRET, NOW), event)).resolves.toBeDefined();
    const statements = expectAccountFirst(transactions);
    expect(statements.some(({ sql }) => sql.includes('insert into auth.mfa_recovery_codes'))).toBe(true);
  });

  it('a step-up locks the account before the session assurance and the factor', async () => {
    const { service, transactions } = harness();
    await expect(service.stepUp(platformContext(), totp(SECRET, NOW), event)).resolves.toBeDefined();
    const statements = expectAccountFirst(transactions);
    // The assurance check reads the session only after the lock.
    const lock = statements.findIndex(({ sql }) => sql === LOCK);
    expect(statements.findIndex(({ sql }) => isAssuranceQuery(sql))).toBeGreaterThan(lock);
  });

  it('regenerating recovery codes locks the account before the factor and the codes', async () => {
    const { service, transactions } = harness();
    await expect(service.regenerateRecoveryCodes(platformContext(), event)).resolves.toMatchObject({
      recoveryCodes: expect.any(Array) });
    const statements = expectAccountFirst(transactions);
    const lock = statements.findIndex(({ sql }) => sql === LOCK);
    expect(statements.findIndex(({ sql }) => isAssuranceQuery(sql))).toBeGreaterThan(lock);
  });

  // The challenge is found without a lock only to learn its account; it is then
  // read again, locked, for that account only, after the account lock.
  it('locks the challenge only after the account, and only for the account it locked', async () => {
    const { service, transactions } = harness();
    await service.completeLogin(TOKEN, { code: totp(SECRET, NOW) }, event);
    const statements = transactions[0] ?? [];
    const lock = statements.findIndex(({ sql }) => sql === LOCK);
    const locked = statements.findIndex(({ sql }) => /for update of challenge/.test(sql));
    expect(locked).toBeGreaterThan(lock);
    expect(statements[locked]?.sql).toMatch(/challenge\.account_id = \$3/);
    expect(statements[locked]?.values[2]).toBe(ACCOUNT);
    for (const { sql } of statements.slice(0, lock)) expect(sql).not.toMatch(LOCKING);
  });

  it('refuses a challenge that is no longer valid once the account lock is held', async () => {
    const { service, transactions } = harness({ lockedChallenge: false });
    await expect(service.completeLogin(TOKEN, { code: totp(SECRET, NOW) }, event))
      .rejects.toMatchObject({ code: 'MFA_CHALLENGE_INVALID' });
    const statements = transactions[0] ?? [];
    // The refusal comes from the re-read made while the account lock is held.
    const lock = statements.findIndex(({ sql }) => sql === LOCK);
    const refused = statements.findIndex(({ sql }) => /for update of challenge/.test(sql));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(statements[lock]?.values).toEqual([ACCOUNT]);
    expect(refused).toBeGreaterThan(lock);
    expect(statements.some(({ sql }) => sql.includes('auth.mfa_factors'))).toBe(false);
    expect(statements.some(({ sql }) => sql.includes('auth.session_events') || sql.includes('auth.sessions'))).toBe(false);
  });

  // The account row stays locked until the MFA transaction commits, and other
  // requests of that account (other MFA requests, sign-outs, revocations) wait
  // on it, each holding a pool connection. Issuing the session must therefore
  // not need a second pool connection: it resolves the administrator on the
  // transaction's own client.
  it('issues the platform session without a second pool connection', async () => {
    const poolQuery = jest.fn(async () => { throw new Error('the pool must not be used inside the locked transaction'); });
    const database = { query: poolQuery } as unknown as DatabaseService;
    const tokens = new TokenService(database, new CurrentStaffContextService(database));
    const statements: string[] = [];
    const client = { query: jest.fn(async (sql: string) => {
      statements.push(String(sql));
      if (sql.includes('from auth.accounts') && sql.includes('select id::text, subject')) {
        return { rowCount: 1, rows: [{ id: ACCOUNT, subject: 'synthetic:mfa-lock', email: null, display_name: null }] };
      }
      if (sql.includes('from auth.account_roles assignment')) {
        return { rowCount: 1, rows: [{ roles: ['platform_super_admin'], permissions: ['platform.admin.access'] }] };
      }
      if (sql.includes('select token_version::text from auth.accounts')) return { rowCount: 1, rows: [{ token_version: '3' }] };
      return { rowCount: 1, rows: [] };
    }) } as unknown as PoolClient;

    const session = await tokens.issuePlatformSession(client,
      { accountId: ACCOUNT, subject: 'synthetic:mfa-lock', factorId: FACTOR, method: 'totp' }, event);

    expect(session.actor).toMatchObject({ kind: 'platform', accountId: ACCOUNT, platformPermissions: ['platform.admin.access'] });
    expect(poolQuery).not.toHaveBeenCalled();
    expect(statements.some((sql) => sql.includes('from auth.account_roles assignment'))).toBe(true);
  });
});

/** A well-formed TOTP code that matches no step of the window accepted around NOW. */
const WRONG = ['000000', '111111', '222222', '333333'].find((code) =>
  ![-30_000, 0, 30_000].some((offset) => totp(SECRET, NOW + offset) === code))!;

/** The status, code and message a refused call threw. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainProblem) return { status: error.getStatus(), code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected a refusal');
}

const inserts = (statements: Statement[], table: string) =>
  statements.filter(({ sql }) => sql.startsWith(`insert into ${table}`));

/**
 * A20: step-up and recovery-code regeneration run on an authenticated platform
 * route, so a refusal there is never 401, which the console reads as an ended
 * session (it refreshes and repeats the request). A wrong or replayed code is
 * 403 MFA_INVALID_CODE and is still counted; a session that lost its MFA
 * assurance while the request waited for the account lock is 403
 * PLATFORM_SESSION_REQUIRED, as requirePlatformAssurance answers it. The
 * unauthenticated sign-in challenge steps keep 401.
 */
describe('platform MFA refusals on authenticated routes (A20)', () => {
  useTestEnvironment();

  it('answers a wrong step-up code 403 MFA_INVALID_CODE after counting the factor failure', async () => {
    const { service, transactions, database } = harness();
    await expect(refusal(service.stepUp(platformContext(), WRONG, event)))
      .resolves.toEqual({ status: 403, code: 'MFA_INVALID_CODE', message: 'The code is not valid' });
    // The transaction returned its outcome instead of throwing, so the failure it counted commits.
    await expect((database.withTransaction as jest.Mock).mock.results[0]?.value).resolves.toEqual({ kind: 'failed' });
    const statements = transactions[0] ?? [];
    expect(inserts(statements, 'auth.otp_rate_limits').map(({ values }) => values[0]))
      .toEqual(['mfa_failure_account', 'mfa_failure_ip']);
    expect(inserts(statements, 'auth.session_events').map(({ values }) => values[1])).toEqual(['step_up_failed']);
  });

  it.each([
    ['its session was rotated or ended while it waited', { assurance: 'none' as const }],
    ['its session was verified by another factor', { assurance: 'other-factor' as const }],
    ['the account has no active factor', { activeFactor: false }],
  ])('answers a step-up 403 PLATFORM_SESSION_REQUIRED, as the assurance check does, when %s', async (_case, options) => {
    const expected = await refusal(requirePlatformAssurance(
      assuredClient(jest.fn(), { active: false }) as unknown as PoolClient, platformContext(), 'platform.mfa.step-up'));
    const { service, transactions } = harness(options);
    await expect(refusal(service.stepUp(platformContext(), totp(SECRET, NOW), event))).resolves.toEqual(expected);
    expect(expected).toMatchObject({ status: 403, code: 'PLATFORM_SESSION_REQUIRED' });
    // Not a wrong code: nothing is counted against the failure budgets.
    const statements = transactions[0] ?? [];
    expect(inserts(statements, 'auth.otp_rate_limits')).toEqual([]);
    expect(inserts(statements, 'auth.session_events')).toEqual([]);
  });

  it('answers a regeneration that finds no active factor 403 PLATFORM_SESSION_REQUIRED and issues no code', async () => {
    const { service, transactions } = harness({ activeFactor: false });
    await expect(refusal(service.regenerateRecoveryCodes(platformContext(), event))).resolves.toEqual({
      status: 403, code: 'PLATFORM_SESSION_REQUIRED',
      message: 'An MFA-verified platform administration session is required' });
    expect(inserts(transactions[0] ?? [], 'auth.mfa_recovery_codes')).toEqual([]);
  });

  it('still answers a step-up while the failure budget is blocked 429 MFA_RATE_LIMITED, without testing the code', async () => {
    const { service, transactions } = harness({ blocked: true });
    await expect(refusal(service.stepUp(platformContext(), totp(SECRET, NOW), event)))
      .resolves.toMatchObject({ status: 429, code: 'MFA_RATE_LIMITED' });
    expect((transactions[0] ?? []).some(({ sql }) => sql.includes('update auth.mfa_factors'))).toBe(false);
  });

  describe('the unauthenticated sign-in challenge steps keep 401', () => {
    it('a wrong sign-in code is 401 MFA_INVALID_CODE', async () => {
      const { service } = harness();
      await expect(refusal(service.completeLogin(TOKEN, { code: WRONG }, event)))
        .resolves.toMatchObject({ status: 401, code: 'MFA_INVALID_CODE' });
    });

    it('a wrong enrolment activation code is 401 MFA_INVALID_CODE', async () => {
      const { service } = harness();
      await expect(refusal(service.activateEnrollment(TOKEN, WRONG, event)))
        .resolves.toMatchObject({ status: 401, code: 'MFA_INVALID_CODE' });
    });

    it('a challenge no longer valid is 401 MFA_CHALLENGE_INVALID', async () => {
      const { service } = harness({ lockedChallenge: false });
      await expect(refusal(service.completeLogin(TOKEN, { code: totp(SECRET, NOW) }, event)))
        .resolves.toMatchObject({ status: 401, code: 'MFA_CHALLENGE_INVALID' });
    });

    it('starting enrolment over an active factor is 401 MFA_CHALLENGE_INVALID', async () => {
      const { service } = harness();
      await expect(refusal(service.startEnrollment(TOKEN, event)))
        .resolves.toMatchObject({ status: 401, code: 'MFA_CHALLENGE_INVALID' });
    });
  });
});

/**
 * A21: an MFA lockout is an explicit answer, so it states when to retry. Every
 * MFA window is 900 seconds (FAILURE_PER_ACCOUNT, FAILURE_PER_IP,
 * REQUESTS_PER_ACCOUNT), so the value is the same whichever budget refused and
 * never the time left in one.
 */
describe('platform MFA lockout carries Retry-After (A21)', () => {
  useTestEnvironment();

  it.each([
    ['a sign-in', {}, (service: MfaService) => service.completeLogin(TOKEN, { code: totp(SECRET, NOW) }, event)],
    ['an enrolment activation', {}, (service: MfaService) => service.activateEnrollment(TOKEN, totp(SECRET, NOW), event)],
    ['a step-up', {}, (service: MfaService) => service.stepUp(platformContext(), totp(SECRET, NOW), event)],
    ['an enrolment start', { activeFactor: false }, (service: MfaService) => service.startEnrollment(TOKEN, event)],
    ['a recovery-code regeneration', {}, (service: MfaService) => service.regenerateRecoveryCodes(platformContext(), event)],
  ])('answers %s over its budget 429 MFA_RATE_LIMITED with Retry-After 900', async (_case, options, call) => {
    const { service } = harness({ ...options, blocked: true });
    const refused = await call(service).then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(DomainProblem);
    expect(refused).toMatchObject({ code: 'MFA_RATE_LIMITED', retryAfterSeconds: 900 });
    expect((refused as DomainProblem).getStatus()).toBe(429);
  });
});
