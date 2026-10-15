jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));

import type { PoolClient } from 'pg';
import type { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { DatabaseService } from '../../database/database.service';
import { useTestEnvironment } from '../../testing/platform-assurance';
import type { LocalAuthProvider } from '../local-auth.provider';
import type { NotificationOtpClient } from '../notification-otp.client';
import type { TokenService } from '../token.service';
import { MfaSecretProtector } from './mfa-secret-protector';
import { MfaService, type MfaNoticeSink } from './mfa.service';
import { totp } from './totp';

/**
 * The authenticator of a clinician applicant (ADR-064). Identity drives a
 * 0088 staff challenge for the applicant's application capability: it opens
 * the challenge with a token it derives itself and never gives the browser,
 * runs the unchanged 0088 enrolment and verification on it, and issues no
 * session (`issue: 'none'`); the application's own step runs in the same
 * transaction. At step 1 a Super Admin types a code the applicant reads
 * aloud, which is checked against the applicant's staff-proven factor, used
 * once, and counted against the applicant when wrong. The SQL side is pinned
 * by clinician-applications.integration.sql and the HTTP flow by
 * scripts/verify-clinician-application-runtime.mjs.
 */
const ACCOUNT = '40000000-0000-4000-8000-0000000000c1';
const ADMIN = '3f000000-0000-4000-8000-0000000000c1';
const LATER_ADMIN = '5f000000-0000-4000-8000-0000000000c1';
const FACTOR = '41000000-0000-4000-8000-0000000000c1';
const CHALLENGE = '42000000-0000-4000-8000-0000000000c1';
const NEW_CHALLENGE = '43000000-0000-4000-8000-0000000000c1';
const TOKEN = 'C'.repeat(43);
const SECRET = Buffer.from('12345678901234567890', 'ascii');
const NOW = 1_700_000_000_000;
const event = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNC1', sourceIp: '192.0.2.40' };

type Statement = { sql: string; values: unknown[] };
interface Options {
  enrolled?: boolean;
  unproven?: boolean;
  proofVerified?: boolean;
  lastUsedStep?: number | null;
  inactive?: boolean;
  bucketCounts?: Record<string, number>;
  blockedBuckets?: string[];
  /** Rows the factor's last-step UPDATE changes (0 when a concurrent use advanced it first). */
  stepAdvanced?: number;
}

useTestEnvironment({ MFA_SECRET_KEY_B64: Buffer.alloc(32, 0x5a).toString('base64'), MFA_KEY_VERSION: 'applicant-v1' });

function harness(options: Options = {}) {
  const statements: Statement[] = [];
  const protector = new MfaSecretProtector();
  const respond = (sql: string, values: unknown[]) => {
    if (sql.includes(' as enrolled') && !sql.includes(' as eligible')) {
      return options.inactive ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ enrolled: options.enrolled ?? false,
        unproven: (options.enrolled ?? false) && (options.unproven ?? false), token_version: '3' }] };
    }
    if (sql.includes('from auth.mfa_login_challenges challenge')) {
      return { rowCount: 1, rows: [{ id: CHALLENGE, account_id: ACCOUNT, subject: 'workforce:applicant',
        email: 'applicant@example.invalid', failed_attempts: 0, max_attempts: 5,
        expires_at: new Date(Date.now() + 300_000), proof_method: 'email_code',
        proof_verifier_hmac: protector.enrollmentCodeDigest(CHALLENGE, '246810'), proof_key_version: 'applicant-v1',
        proof_verified_at: options.proofVerified ? new Date() : null }] };
    }
    if (sql.includes('from auth.mfa_factors') && /for update/.test(sql)) {
      const pending = sql.includes("status = 'pending'");
      if (!pending && !options.enrolled) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ id: FACTOR,
        secret_ciphertext: protector.encryptSecret(FACTOR, ACCOUNT, Buffer.from(SECRET)),
        secret_key_version: 'applicant-v1',
        last_used_step: options.lastUsedStep === undefined || options.lastUsedStep === null ? null : String(options.lastUsedStep),
        enrollment_proof: !pending && options.unproven ? null : 'email_code' }] };
    }
    if (sql.includes('insert into auth.mfa_login_challenges')) return { rowCount: 1, rows: [{ expires_at: new Date(NOW) }] };
    if (sql.includes('as blocked') && sql.includes('from auth.otp_rate_limits')) {
      return { rowCount: 1, rows: [{ blocked: (options.blockedBuckets ?? []).includes(String(values[1])) }] };
    }
    if (sql.includes('from auth.otp_rate_limits')) {
      const counted = options.bucketCounts?.[String(values[1])];
      return counted === undefined ? { rowCount: 0, rows: [] }
        : { rowCount: 1, rows: [{ request_count: counted, window_started_at: new Date(), blocked_until: null }] };
    }
    if (sql.includes('count(*)::text as remaining')) return { rowCount: 1, rows: [{ remaining: '9' }] };
    if (sql.includes('set last_used_step = $2')) return { rowCount: options.stepAdvanced ?? 1, rows: [] };
    return { rowCount: 1, rows: [] };
  };
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql: String(sql), values });
    return respond(String(sql), values);
  }) } as unknown as PoolClient;
  const database = {
    withSystemTransaction: jest.fn(async (_correlationId: string, work: (client: PoolClient) => unknown) => work(client)),
  } as unknown as DatabaseService;
  const tokens = {
    recordSessionEvent: jest.fn(async (_client: PoolClient, input: unknown) => {
      statements.push({ sql: 'session event', values: [input] });
    }),
    issueStaffSession: jest.fn().mockRejectedValue(new Error('no session may be issued')),
    issuePlatformSession: jest.fn().mockRejectedValue(new Error('no session may be issued')),
  };
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) };
  const localProvider = { authenticate: jest.fn(), principalHash: () => 'principal-hash' };
  const notification = { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted' }) };
  const sink: MfaNoticeSink = { notify: jest.fn().mockResolvedValue(undefined) };
  const service = new MfaService(database, protector, tokens as unknown as TokenService,
    localProvider as unknown as LocalAuthProvider, audit as unknown as AuditService, () => NOW,
    notification as unknown as NotificationOtpClient, sink);
  return { service, statements, client, tokens, audit, sink, protector };
}

const writes = (statements: Statement[], pattern: RegExp) => statements.filter(({ sql }) => pattern.test(sql));
const sessionEvents = (statements: Statement[]) => statements.filter(({ sql }) => sql === 'session event')
  .map(({ values }) => values[0] as { eventType: string; details: Record<string, unknown> });

describe('a clinician applicant\'s 0088 challenge (ADR-064)', () => {
  it('opens a staff enrolment challenge with the given id and token, after the account lock, superseding the account\'s live staff challenges', async () => {
    const { service, statements, client, protector } = harness();
    const opened = await service.openApplicantChallenge(client, ACCOUNT, { id: NEW_CHALLENGE, token: TOKEN }, event);
    expect(opened).toEqual({ kind: 'opened', purpose: 'enroll', expiresAt: new Date(NOW) });
    expect(statements[0]).toEqual({ sql: 'select auth.lock_account_for_mfa($1)', values: [ACCOUNT] });
    const superseded = statements.find(({ sql }) => sql.includes("invalidation_reason = 'superseded'"));
    expect(superseded?.values).toEqual([ACCOUNT, 'staff']);
    const inserted = statements.find(({ sql }) => sql.includes('insert into auth.mfa_login_challenges'));
    expect(inserted?.values.slice(0, 5)).toEqual([NEW_CHALLENGE, ACCOUNT, 'enroll', protector.tokenDigest(TOKEN), '3']);
    expect(inserted?.values[9]).toBe('staff');
    expect(inserted?.values[10]).toBe(false);
    expect(statements.indexOf(superseded!)).toBeLessThan(statements.indexOf(inserted!));
    expect(sessionEvents(statements)).toEqual([expect.objectContaining({ eventType: 'mfa_challenge_issued',
      details: { purpose: 'enroll', session_kind: 'staff', origin: 'clinician_application' } })]);
  });

  it('opens a verification challenge for an account that holds a staff-proven factor', async () => {
    const { service, client } = harness({ enrolled: true });
    expect(await service.openApplicantChallenge(client, ACCOUNT, { id: NEW_CHALLENGE, token: TOKEN }, event))
      .toMatchObject({ kind: 'opened', purpose: 'verify' });
  });

  it('opens nothing for an account whose only factor platform sign-in enrolled, or an inactive account', async () => {
    const unproven = harness({ enrolled: true, unproven: true });
    expect(await unproven.service.openApplicantChallenge(unproven.client, ACCOUNT, { id: NEW_CHALLENGE, token: TOKEN },
      event)).toEqual({ kind: 'unproven' });
    expect(writes(unproven.statements, /insert into auth\.mfa_login_challenges/)).toHaveLength(0);
    const inactive = harness({ inactive: true });
    expect(await inactive.service.openApplicantChallenge(inactive.client, ACCOUNT, { id: NEW_CHALLENGE, token: TOKEN },
      event)).toEqual({ kind: 'invalid' });
    expect(writes(inactive.statements, /insert into auth\.mfa_login_challenges/)).toHaveLength(0);
  });

  it('counts each opening against the account\'s request budget and opens nothing over it', async () => {
    const probe = harness();
    const bucket = probe.protector.rateBucket('applicant-challenge', ACCOUNT);
    const { service, statements, client } = harness({ bucketCounts: { [bucket]: 5 } });
    expect(await service.openApplicantChallenge(client, ACCOUNT, { id: NEW_CHALLENGE, token: TOKEN }, event))
      .toEqual({ kind: 'rate_limited' });
    expect(writes(statements, /insert into auth\.mfa_login_challenges/)).toHaveLength(0);
    expect(sessionEvents(statements)).toEqual([expect.objectContaining({ eventType: 'mfa_rate_limited',
      details: { operation: 'applicant-challenge' } })]);
  });

  it('refuses a token that is not a 43-character base64url value', async () => {
    const { service, client } = harness();
    await expect(service.openApplicantChallenge(client, ACCOUNT, { id: NEW_CHALLENGE, token: 'short' }, event))
      .rejects.toThrow();
  });
});

describe('verifying an applicant\'s authenticator issues no session (issue: none)', () => {
  it('accepts a TOTP code, consumes the challenge and runs the application step in the same transaction', async () => {
    const { service, statements, client, tokens, audit } = harness({ enrolled: true });
    let consumedFirst = false;
    const onVerified = jest.fn(async (transaction: PoolClient, verified: { factorId: string; method: string }) => {
      expect(transaction).toBe(client);
      expect(verified).toEqual({ factorId: FACTOR, method: 'totp' });
      consumedFirst = writes(statements, /set consumed_at = clock_timestamp\(\)/).length === 1;
      return { stage: 'ready' };
    });
    const verified = await service.completeLogin(TOKEN, { code: totp(SECRET, NOW) }, event, 'staff',
      { issue: 'none', onVerified });
    expect(verified).toEqual({ factorId: FACTOR, method: 'totp', result: { stage: 'ready' } });
    expect(onVerified).toHaveBeenCalledTimes(1);
    expect(consumedFirst).toBe(true);
    expect(tokens.issueStaffSession).not.toHaveBeenCalled();
    expect(writes(statements, /insert into auth\.sessions/)).toHaveLength(0);
    expect(audit.recordWithClient).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'auth.login' }));
    expect(sessionEvents(statements)).toContainEqual(expect.objectContaining({ eventType: 'mfa_verified',
      details: { method: 'totp', session_kind: 'staff', origin: 'clinician_application' } }));
  });

  it('fails whole when the application step fails', async () => {
    const { service } = harness({ enrolled: true });
    const failure = new Error('application step failed');
    await expect(service.completeLogin(TOKEN, { code: totp(SECRET, NOW) }, event, 'staff',
      { issue: 'none', onVerified: jest.fn().mockRejectedValue(failure) })).rejects.toBe(failure);
  });

  it('accepts a recovery code without a session, audits its use and notifies the owner', async () => {
    const { service, audit, sink, tokens } = harness({ enrolled: true });
    const verified = await service.completeLogin(TOKEN, { recoveryCode: 'ABCDE-12345' }, event, 'staff',
      { issue: 'none', onVerified: jest.fn().mockResolvedValue('view') });
    expect(verified).toEqual({ factorId: FACTOR, method: 'recovery_code', result: 'view' });
    expect(tokens.issueStaffSession).not.toHaveBeenCalled();
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'auth.staff.mfa.recovery-code.used',
      details: { recoveryCodesRemaining: 9, origin: 'clinician_application' } }));
    await service.settleNotices();
    expect(sink.notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'recovery_code_used', kind: 'staff' }));
  });

  it('counts a wrong code as a failed attempt and runs no application step', async () => {
    const { service, statements } = harness({ enrolled: true });
    const onVerified = jest.fn();
    const refused = await service.completeLogin(TOKEN, { code: '000000' }, event, 'staff', { issue: 'none', onVerified })
      .then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(DomainProblem);
    expect((refused as DomainProblem).code).toBe('MFA_INVALID_CODE');
    expect(onVerified).not.toHaveBeenCalled();
    expect(writes(statements, /failed_attempts = failed_attempts \+ 1/)).toHaveLength(1);
  });

  it('refuses the no-session mode on a platform challenge', async () => {
    const { service } = harness({ enrolled: true });
    await expect(service.completeLogin(TOKEN, { code: totp(SECRET, NOW) }, event,
      'platform' as 'staff', { issue: 'none', onVerified: jest.fn() })).rejects.toThrow();
  });
});

describe('activating an applicant\'s enrolment issues no session (issue: none)', () => {
  it('activates the factor with its recovery codes and the enrolment audit, and runs the application step in the transaction', async () => {
    const { service, statements, client, tokens, audit, sink } = harness({ proofVerified: true });
    const onActivated = jest.fn(async (transaction: PoolClient, factorId: string) => {
      expect(transaction).toBe(client);
      expect(factorId).toBe(FACTOR);
      expect(writes(statements, /set status = 'active'/)).toHaveLength(1);
      return { stage: 'ready' };
    });
    const activated = await service.activateEnrollment(TOKEN, totp(SECRET, NOW), event, 'staff',
      { issue: 'none', onActivated });
    expect(activated.factorId).toBe(FACTOR);
    expect(activated.result).toEqual({ stage: 'ready' });
    expect(activated.recoveryCodes).toHaveLength(10);
    expect(writes(statements, /insert into auth\.mfa_recovery_codes/)).toHaveLength(10);
    expect(writes(statements, /set consumed_at = clock_timestamp\(\)/)).toHaveLength(1);
    expect(tokens.issueStaffSession).not.toHaveBeenCalled();
    expect(writes(statements, /insert into auth\.sessions/)).toHaveLength(0);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'auth.staff.mfa.enrolled',
      details: { recoveryCodes: 10, proofMethod: 'email_code', origin: 'clinician_application' } }));
    expect(audit.recordWithClient).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'auth.login' }));
    expect(sessionEvents(statements)).toContainEqual(expect.objectContaining({ eventType: 'mfa_enrolled',
      details: { recoveryCodes: 10, session_kind: 'staff', proof: 'email_code', origin: 'clinician_application' } }));
    await service.settleNotices();
    expect(sink.notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'factor_enrolled', kind: 'staff' }));
  });

  it('fails whole when the application step fails', async () => {
    const { service } = harness({ proofVerified: true });
    const failure = new Error('application step failed');
    await expect(service.activateEnrollment(TOKEN, totp(SECRET, NOW), event, 'staff',
      { issue: 'none', onActivated: jest.fn().mockRejectedValue(failure) })).rejects.toBe(failure);
  });

  it('still needs the enrolment proof', async () => {
    const { service } = harness({ proofVerified: false });
    const onActivated = jest.fn();
    const refused = await service.activateEnrollment(TOKEN, totp(SECRET, NOW), event, 'staff', { issue: 'none', onActivated })
      .then(() => undefined, (error: unknown) => error);
    expect((refused as DomainProblem).code).toBe('MFA_ENROLLMENT_PROOF_REQUIRED');
    expect(onActivated).not.toHaveBeenCalled();
  });
});

describe('step 1 confirms the applicant\'s authenticator (confirmApplicantFactor)', () => {
  it('locks both accounts in id order before the factor and accepts a live code once', async () => {
    for (const [first, second] of [[ACCOUNT, ADMIN], [ACCOUNT, LATER_ADMIN]]) {
      const { service, statements, client } = harness({ enrolled: true });
      const confirmed = await service.confirmApplicantFactor(client, { applicantAccountId: first!, actorAccountId: second! },
        totp(SECRET, NOW), event);
      expect(confirmed).toEqual({ kind: 'confirmed', factorId: FACTOR });
      const locks = statements.filter(({ sql }) => sql === 'select auth.lock_account_sessions($1)').map(({ values }) => values[0]);
      expect(locks).toEqual([first, second].sort());
      const factorLock = statements.findIndex(({ sql }) => sql.includes('from auth.mfa_factors') && sql.includes('for update'));
      const lastLock = statements.map(({ sql }) => sql).lastIndexOf('select auth.lock_account_sessions($1)');
      expect(factorLock).toBeGreaterThan(lastLock);
      const advanced = writes(statements, /set last_used_step = \$2, last_used_at = clock_timestamp\(\)/);
      expect(advanced).toHaveLength(1);
      expect(writes(statements, /failed_attempts/)).toHaveLength(0);
    }
  });

  it('does not accept a code of a time step already used, the code\'s own step included', async () => {
    // The boundary: the same code read twice at step 1 (its step is the last used one).
    for (const lastUsedStep of [Math.floor(NOW / 30_000), Math.floor(NOW / 30_000) + 1]) {
      const { service, statements, client } = harness({ enrolled: true, lastUsedStep });
      expect(await service.confirmApplicantFactor(client, { applicantAccountId: ACCOUNT, actorAccountId: ADMIN },
        totp(SECRET, NOW), event)).toEqual({ kind: 'invalid' });
      expect(writes(statements, /set last_used_step/)).toHaveLength(0);
    }
    // One step earlier was used: the code's step is accepted, once.
    const { service, client } = harness({ enrolled: true, lastUsedStep: Math.floor(NOW / 30_000) - 1 });
    expect(await service.confirmApplicantFactor(client, { applicantAccountId: ACCOUNT, actorAccountId: ADMIN },
      totp(SECRET, NOW), event)).toEqual({ kind: 'confirmed', factorId: FACTOR });
  });

  it('does not accept a code whose step a concurrent use advanced first (the guarded UPDATE changed no row)', async () => {
    const { service, statements, client } = harness({ enrolled: true, stepAdvanced: 0 });
    expect(await service.confirmApplicantFactor(client, { applicantAccountId: ACCOUNT, actorAccountId: ADMIN },
      totp(SECRET, NOW), event)).toEqual({ kind: 'invalid' });
    const advance = writes(statements, /set last_used_step = \$2/)[0];
    expect(advance?.sql).toContain('(last_used_step is null or last_used_step < $2)');
    expect(sessionEvents(statements)).toContainEqual(expect.objectContaining({ eventType: 'mfa_failed' }));
  });

  it('counts a wrong code, or a recovery code, against the applicant', async () => {
    for (const code of ['000000', 'ABCDE-12345']) {
      const { service, statements, client, protector } = harness({ enrolled: true });
      expect(await service.confirmApplicantFactor(client, { applicantAccountId: ACCOUNT, actorAccountId: ADMIN },
        code, event)).toEqual({ kind: 'invalid' });
      const counted = statements.filter(({ sql }) => sql.includes('insert into auth.otp_rate_limits'))
        .map(({ values }) => values.slice(0, 2));
      expect(counted).toContainEqual(['mfa_failure_account', protector.rateBucket('account', ACCOUNT)]);
      expect(sessionEvents(statements)).toContainEqual(expect.objectContaining({ eventType: 'mfa_failed',
        accountId: ACCOUNT }));
    }
  });

  it('answers rate_limited once the applicant\'s failure budget is spent, without checking the code', async () => {
    const probe = harness();
    const { service, statements, client } = harness({ enrolled: true,
      blockedBuckets: [probe.protector.rateBucket('account', ACCOUNT)] });
    expect(await service.confirmApplicantFactor(client, { applicantAccountId: ACCOUNT, actorAccountId: ADMIN },
      totp(SECRET, NOW), event)).toEqual({ kind: 'rate_limited' });
    expect(writes(statements, /set last_used_step/)).toHaveLength(0);
  });

  it('answers no_factor without an active staff-proven factor', async () => {
    for (const options of [{ enrolled: false }, { enrolled: true, unproven: true }]) {
      const { service, statements, client } = harness(options);
      expect(await service.confirmApplicantFactor(client, { applicantAccountId: ACCOUNT, actorAccountId: ADMIN },
        totp(SECRET, NOW), event)).toEqual({ kind: 'no_factor' });
      expect(writes(statements, /set last_used_step/)).toHaveLength(0);
    }
  });
});

describe('applicant failures have their own per-address bucket (not staff sign-in\'s)', () => {
  const failureBuckets = (statements: Statement[]) => statements
    .filter(({ sql }) => sql.includes('insert into auth.otp_rate_limits')).map(({ values }) => values.slice(0, 2));
  const ipBucket = (h: ReturnType<typeof harness>, name: string) => h.protector.rateBucket(name, event.sourceIp);

  it('counts a wrong applicant code, emailed proof or activation code in the applicants\' bucket only', async () => {
    const verify = harness({ enrolled: true });
    await verify.service.completeLogin(TOKEN, { code: '000000' }, event, 'staff', { issue: 'none', onVerified: jest.fn() })
      .catch(() => undefined);
    const start = harness();
    await start.service.startEnrollment(TOKEN, event, 'staff', { emailCode: '000000' }, { applicant: true })
      .catch(() => undefined);
    const activate = harness({ proofVerified: true });
    await activate.service.activateEnrollment(TOKEN, '000000', event, 'staff', { issue: 'none', onActivated: jest.fn() })
      .catch(() => undefined);
    const review = harness({ enrolled: true });
    await review.service.confirmApplicantFactor(review.client, { applicantAccountId: ACCOUNT, actorAccountId: ADMIN },
      '000000', event);
    for (const h of [verify, start, activate, review]) {
      const counted = failureBuckets(h.statements);
      expect(counted).toContainEqual(['mfa_failure_ip', ipBucket(h, 'applicant-ip')]);
      expect(counted).not.toContainEqual(['mfa_failure_ip', ipBucket(h, 'staff-ip')]);
      expect(counted).toContainEqual(['mfa_failure_account', h.protector.rateBucket('account', ACCOUNT)]);
    }
  });

  it('leaves staff sign-in from an address unblocked when the applicants\' bucket of that address is spent', async () => {
    const probe = harness();
    const staff = harness({ enrolled: true, blockedBuckets: [ipBucket(probe, 'applicant-ip')] });
    const refused = await staff.service.completeLogin(TOKEN, { code: '000000' }, event, 'staff')
      .then(() => undefined, (error: unknown) => error);
    // A wrong code is checked and counted in the staff bucket, not refused as rate limited.
    expect((refused as DomainProblem).code).toBe('MFA_INVALID_CODE');
    expect(failureBuckets(staff.statements)).toContainEqual(['mfa_failure_ip', ipBucket(staff, 'staff-ip')]);
    const applicant = harness({ enrolled: true, blockedBuckets: [ipBucket(probe, 'applicant-ip')] });
    const limited = await applicant.service.completeLogin(TOKEN, { code: totp(SECRET, NOW) }, event, 'staff',
      { issue: 'none', onVerified: jest.fn() }).then(() => undefined, (error: unknown) => error);
    expect((limited as DomainProblem).code).toBe('MFA_RATE_LIMITED');
  });

  it('lets an applicant verify while staff sign-in\'s bucket of the address is spent', async () => {
    const probe = harness();
    const { service } = harness({ enrolled: true, blockedBuckets: [ipBucket(probe, 'staff-ip')] });
    await expect(service.completeLogin(TOKEN, { code: totp(SECRET, NOW) }, event, 'staff',
      { issue: 'none', onVerified: jest.fn().mockResolvedValue('ready') })).resolves.toMatchObject({ result: 'ready' });
  });
});
