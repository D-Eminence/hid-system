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
 * Staff MFA (launch blocker MFA-1, 0088). A staff password yields only a
 * challenge; the staff session is issued after TOTP or a recovery code; and
 * a first enrolment needs a fresh proof bound to its challenge (an email code
 * to the account's address, or the provider activation that opened it),
 * never the password alone. The SQL guard of the same rule is pinned by
 * staff-mfa.integration.sql; the HTTP flow runs in
 * scripts/verify-staff-mfa-runtime.mjs.
 */
const ACCOUNT = '40000000-0000-4000-8000-0000000000d1';
const FACTOR = '41000000-0000-4000-8000-0000000000d1';
const CHALLENGE = '42000000-0000-4000-8000-0000000000d1';
const TOKEN = 'D'.repeat(43);
const SECRET = Buffer.from('12345678901234567890', 'ascii');
const NOW = 1_700_000_000_000;
const event = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPS', sourceIp: '192.0.2.20' };

type Statement = { sql: string; values: unknown[] };
interface Options {
  enrolled?: boolean;
  eligible?: boolean;
  proofMethod?: 'email_code' | 'provider_activation' | null;
  proofVerified?: boolean;
  proofCode?: string;
  email?: string | null;
  delivery?: 'accepted' | 'definitive_failure';
}

useTestEnvironment({ MFA_SECRET_KEY_B64: Buffer.alloc(32, 0x5a).toString('base64'), MFA_KEY_VERSION: 'staff-v1' });

function harness(options: Options = {}) {
  const statements: Statement[] = [];
  const protector = new MfaSecretProtector();
  const respond = (sql: string) => {
    if (sql.includes(' as eligible')) {
      return { rowCount: 1, rows: [{ eligible: options.eligible ?? true, enrolled: options.enrolled ?? false,
        token_version: '2', subject: 'synthetic:staff-mfa' }] };
    }
    if (sql.includes('from auth.mfa_login_challenges challenge')) {
      const proofMethod = options.proofMethod ?? null;
      return { rowCount: 1, rows: [{ id: CHALLENGE, account_id: ACCOUNT, subject: 'synthetic:staff-mfa',
        email: options.email === undefined ? 'staff-mfa@example.invalid' : options.email,
        failed_attempts: 0, max_attempts: 5, expires_at: new Date(Date.now() + 300_000),
        proof_method: proofMethod,
        proof_verifier_hmac: proofMethod === 'email_code'
          ? protector.enrollmentCodeDigest(CHALLENGE, options.proofCode ?? '246810') : null,
        proof_key_version: proofMethod === 'email_code' ? 'staff-v1' : null,
        proof_verified_at: options.proofVerified ? new Date() : null }] };
    }
    if (sql.includes('from auth.mfa_factors') && /for update/.test(sql)) {
      const pending = sql.includes("status = 'pending'");
      if (!pending && !options.enrolled) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ id: FACTOR,
        secret_ciphertext: protector.encryptSecret(FACTOR, ACCOUNT, Buffer.from(SECRET)),
        secret_key_version: 'staff-v1', last_used_step: null }] };
    }
    if (sql.includes('insert into auth.mfa_login_challenges')) return { rowCount: 1, rows: [{ expires_at: new Date(NOW) }] };
    if (sql.includes('insert into auth.mfa_factors')) return { rowCount: 1, rows: [{ enrollment_expires_at: new Date(NOW) }] };
    if (sql.includes('from auth.otp_rate_limits')) return { rowCount: 0, rows: [] };
    if (sql.includes('count(*)::text as remaining')) return { rowCount: 1, rows: [{ remaining: '9' }] };
    return { rowCount: 1, rows: [] };
  };
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql: String(sql), values });
    return respond(String(sql));
  }) } as unknown as PoolClient;
  const database = {
    withSystemTransaction: jest.fn(async (_correlationId: string, work: (client: PoolClient) => unknown) => work(client)),
  } as unknown as DatabaseService;
  const session = { actor: { accountId: ACCOUNT, sessionId: '44000000-0000-4000-8000-0000000000d1',
    facility: { id: 'facility-d1', membershipId: 'membership-d1', organizationId: 'organization-d1' } } };
  const tokens = {
    recordSessionEvent: jest.fn().mockResolvedValue(undefined),
    issueStaffSession: jest.fn().mockResolvedValue(session),
    issuePlatformSession: jest.fn().mockResolvedValue(session),
  };
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) };
  const localProvider = {
    authenticate: jest.fn().mockResolvedValue({ accountId: ACCOUNT, subject: 'synthetic:staff-mfa' }),
    principalHash: () => 'principal-hash',
  };
  const notification = { deliver: jest.fn().mockResolvedValue({ outcome: options.delivery ?? 'accepted' }) };
  const sink: MfaNoticeSink = { notify: jest.fn().mockResolvedValue(undefined) };
  const service = new MfaService(database, protector, tokens as unknown as TokenService,
    localProvider as unknown as LocalAuthProvider, audit as unknown as AuditService, () => NOW,
    notification as unknown as NotificationOtpClient, sink);
  return { service, statements, tokens, audit, notification, sink, localProvider, protector };
}

async function problem(promise: Promise<unknown>): Promise<DomainProblem> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

const writes = (statements: Statement[], pattern: RegExp) => statements.filter(({ sql }) => pattern.test(sql));

describe('staff sign-in (MFA-1)', () => {
  it('answers a staff password with a staff challenge only, for an account with an eligible staff membership', async () => {
    const { service, statements, tokens } = harness({ enrolled: true });
    const challenge = await service.beginLogin('staff@example.invalid', 'a-strong-password', event, 'staff');
    expect(challenge.purpose).toBe('verify');
    expect(challenge.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const eligibility = statements.find(({ sql }) => sql.includes(' as eligible'));
    // Eligibility is the staff resolver's own membership joins, not platform.admin.access.
    expect(eligibility?.sql).toContain('identity.staff_facility_memberships membership');
    expect(eligibility?.sql).not.toContain('platform.admin.access');
    expect(eligibility?.values[1]).toEqual(['verified', 'approved', 'active']);
    // Only the staff challenges of the account are superseded, and the new one is a staff one.
    const superseded = statements.find(({ sql }) => sql.includes("invalidation_reason = 'superseded'"));
    expect(superseded?.sql).toContain('and session_kind = $2');
    expect(superseded?.values).toEqual([ACCOUNT, 'staff']);
    const inserted = statements.find(({ sql }) => sql.includes('insert into auth.mfa_login_challenges'));
    expect(inserted?.values[9]).toBe('staff');
    expect(inserted?.values[10]).toBe(false);
    // No session of any kind.
    expect(tokens.issueStaffSession).not.toHaveBeenCalled();
    expect(writes(statements, /insert into auth\.sessions/)).toHaveLength(0);
  });

  it('answers an account without an eligible staff membership as a wrong password', async () => {
    const { service, statements } = harness({ eligible: false });
    await expect(service.beginLogin('staff@example.invalid', 'a-strong-password', event, 'staff'))
      .rejects.toMatchObject({ status: 401 });
    expect(writes(statements, /insert into auth\.mfa_login_challenges/)).toHaveLength(0);
  });

  it('marks the enrolment challenge proven only when provider activation opened it', async () => {
    const plain = harness();
    expect((await plain.service.beginLogin('staff@example.invalid', 'pw-123456', event, 'staff')).purpose).toBe('enroll');
    expect(plain.statements.find(({ sql }) => sql.includes('insert into auth.mfa_login_challenges'))?.values[10]).toBe(false);
    const activated = harness();
    await activated.service.beginLogin('staff@example.invalid', 'pw-123456', event, 'staff', { activationProof: true });
    const insert = activated.statements.find(({ sql }) => sql.includes('insert into auth.mfa_login_challenges'));
    expect(insert?.values[10]).toBe(true);
    expect(insert?.sql).toContain("case when $11 then 'provider_activation' end");
    // A platform sign-in never carries a staff proof, even if asked to.
    const platform = harness();
    await platform.service.beginLogin('admin@example.invalid', 'pw-123456', event, 'platform', { activationProof: true });
    const platformInsert = platform.statements.find(({ sql }) => sql.includes('insert into auth.mfa_login_challenges'));
    expect(platformInsert?.values.slice(9)).toEqual(['platform', false]);
  });

  it('issues a staff session, with its assurance, only after a valid TOTP code on a staff challenge', async () => {
    const { service, statements, tokens, audit } = harness({ enrolled: true });
    const session = await service.completeLogin(TOKEN, { code: totp(SECRET, NOW) }, event, 'staff');
    expect(session).toBe(await tokens.issueStaffSession.mock.results[0]?.value);
    expect(tokens.issueStaffSession).toHaveBeenCalledWith(expect.anything(),
      { accountId: ACCOUNT, subject: 'synthetic:staff-mfa', factorId: FACTOR, method: 'totp' }, event);
    expect(tokens.issuePlatformSession).not.toHaveBeenCalled();
    // The challenge is looked up as a staff challenge only.
    const lookups = statements.filter(({ sql }) => sql.includes('from auth.mfa_login_challenges challenge'));
    expect(lookups).toHaveLength(2);
    for (const lookup of lookups) expect(lookup.values).toContain('staff');
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'auth.login', facilityId: 'facility-d1', actorMembershipId: 'membership-d1',
      details: { mfaMethod: 'totp' } }));
  });

  it('audits a recovery-code sign-in with the codes left and sends the owner notice after commit', async () => {
    const { service, audit, sink } = harness({ enrolled: true });
    await service.completeLogin(TOKEN, { recoveryCode: 'ABCDE-12345' }, event, 'staff');
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'auth.staff.mfa.recovery-code.used', details: { recoveryCodesRemaining: 9 } }));
    await service.settleNotices();
    expect(sink.notify).toHaveBeenCalledWith({ accountId: ACCOUNT, kind: 'staff', event: 'recovery_code_used',
      correlationId: event.correlationId, recoveryCodesRemaining: 9 });
  });

  it('counts a wrong staff code as a failed attempt and issues nothing', async () => {
    const { service, statements, tokens, audit } = harness({ enrolled: true });
    const refused = await problem(service.completeLogin(TOKEN, { code: '000000' }, event, 'staff'));
    expect(refused.code).toBe('MFA_INVALID_CODE');
    expect(writes(statements, /failed_attempts = failed_attempts \+ 1/)).toHaveLength(1);
    expect(tokens.issueStaffSession).not.toHaveBeenCalled();
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'auth.staff.mfa.failed', outcome: 'denied' }));
  });
});

describe('first staff enrolment needs a fresh proof (MFA-1)', () => {
  it('refuses to start enrolment on the password alone, before any factor is created', async () => {
    for (const options of [{}, { proofMethod: 'email_code' as const }]) {
      const { service, statements } = harness(options);
      const refused = await problem(service.startEnrollment(TOKEN, event, 'staff'));
      expect(refused.getStatus()).toBe(403);
      expect(refused.code).toBe('MFA_ENROLLMENT_PROOF_REQUIRED');
      expect(writes(statements, /insert into auth\.mfa_factors/)).toHaveLength(0);
      expect(writes(statements, /proof_verified_at = clock_timestamp\(\)/)).toHaveLength(0);
    }
  });

  it('refuses an email code before one was sent for this challenge', async () => {
    const { service, statements } = harness({ proofMethod: null });
    const refused = await problem(service.startEnrollment(TOKEN, event, 'staff', { emailCode: '246810' }));
    expect(refused.code).toBe('MFA_ENROLLMENT_PROOF_REQUIRED');
    expect(writes(statements, /insert into auth\.mfa_factors/)).toHaveLength(0);
  });

  it('counts a wrong email code as a failed attempt of the challenge', async () => {
    const { service, statements } = harness({ proofMethod: 'email_code', proofCode: '246810' });
    const refused = await problem(service.startEnrollment(TOKEN, event, 'staff', { emailCode: '135790' }));
    expect(refused.code).toBe('MFA_INVALID_CODE');
    expect(writes(statements, /failed_attempts = failed_attempts \+ 1/)).toHaveLength(1);
    expect(writes(statements, /insert into auth\.mfa_factors/)).toHaveLength(0);
  });

  it('verifies the email code, records the proof, then creates the pending factor', async () => {
    const { service, statements } = harness({ proofMethod: 'email_code', proofCode: '246810' });
    const started = await service.startEnrollment(TOKEN, event, 'staff', { emailCode: '246810' });
    expect(started.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(started.otpauthUri).toMatch(/^otpauth:\/\/totp\/Health%20ID:/);
    const proven = statements.findIndex(({ sql }) => /set proof_verified_at = clock_timestamp\(\)/.test(sql));
    const factor = statements.findIndex(({ sql }) => sql.includes('insert into auth.mfa_factors'));
    expect(proven).toBeGreaterThan(-1);
    expect(factor).toBeGreaterThan(proven);
  });

  it('accepts the provider activation as the proof, with no email code', async () => {
    const { service, statements } = harness({ proofMethod: 'provider_activation', proofVerified: true });
    await service.startEnrollment(TOKEN, event, 'staff');
    expect(writes(statements, /insert into auth\.mfa_factors/)).toHaveLength(1);
  });

  it('refuses to activate a staff authenticator whose enrolment proof is not verified', async () => {
    const { service, statements, tokens } = harness({ proofMethod: 'email_code' });
    const refused = await problem(service.activateEnrollment(TOKEN, totp(SECRET, NOW), event, 'staff'));
    expect(refused.code).toBe('MFA_ENROLLMENT_PROOF_REQUIRED');
    expect(writes(statements, /set status = 'active'/)).toHaveLength(0);
    expect(tokens.issueStaffSession).not.toHaveBeenCalled();
  });

  it('activates a proven staff enrolment: factor, recovery codes, staff session, audit and notice', async () => {
    const { service, statements, tokens, audit, sink } = harness({ proofMethod: 'email_code', proofVerified: true });
    const { recoveryCodes } = await service.activateEnrollment(TOKEN, totp(SECRET, NOW), event, 'staff');
    expect(recoveryCodes).toHaveLength(10);
    expect(writes(statements, /insert into auth\.mfa_recovery_codes/)).toHaveLength(10);
    expect(tokens.issueStaffSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      factorId: FACTOR, method: 'totp' }), event);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'auth.staff.mfa.enrolled', details: { recoveryCodes: 10, proofMethod: 'email_code' } }));
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'auth.login', details: { mfaMethod: 'totp', enrolled: true } }));
    await service.settleNotices();
    expect(sink.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'staff', event: 'factor_enrolled' }));
  });

  it('sends the enrolment code to the account address only as a keyed digest bound to the challenge', async () => {
    const { service, statements, notification, protector } = harness();
    const sent = await service.sendEnrollmentCode(TOKEN, event);
    expect(sent).toMatchObject({ accepted: true, channel: 'email' });
    const delivered = notification.deliver.mock.calls[0]?.[0] as { code: string; recipient: string; purpose: string };
    expect(delivered).toMatchObject({ recipient: 'staff-mfa@example.invalid', purpose: 'LOGIN_STEP_UP', channel: 'email' });
    expect(delivered.code).toMatch(/^[0-9]{6}$/);
    const stored = statements.find(({ sql }) => sql.includes("set proof_method = 'email_code'"));
    expect(stored?.values).toEqual([CHALLENGE, protector.enrollmentCodeDigest(CHALLENGE, delivered.code), 'staff-v1']);
    expect(JSON.stringify(stored?.values)).not.toContain(delivered.code);
    // Each send counts against the account's enrolment-proof budget.
    expect(statements.some(({ sql, values }) => sql.includes('insert into auth.otp_rate_limits')
      && values[0] === 'mfa_request_account' && values[1] === protector.rateBucket('enroll-proof', ACCOUNT))).toBe(true);
  });

  it('refuses another code once the proof is verified, and an account without an address', async () => {
    const verified = harness({ proofMethod: 'email_code', proofVerified: true });
    expect((await problem(verified.service.sendEnrollmentCode(TOKEN, event))).code).toBe('MFA_ENROLLMENT_PROOF_COMPLETE');
    expect(verified.notification.deliver).not.toHaveBeenCalled();
    const noAddress = harness({ email: null });
    expect((await problem(noAddress.service.sendEnrollmentCode(TOKEN, event))).code).toBe('MFA_ENROLLMENT_PROOF_UNAVAILABLE');
    expect(noAddress.notification.deliver).not.toHaveBeenCalled();
  });

  it('answers 503 when the code could not be delivered', async () => {
    const { service } = harness({ delivery: 'definitive_failure' });
    const refused = await problem(service.sendEnrollmentCode(TOKEN, event));
    expect(refused.getStatus()).toBe(503);
    expect(refused.code).toBe('MFA_ENROLLMENT_CODE_UNDELIVERABLE');
  });

  it('keeps platform enrolment as it was: no proof is asked of a platform challenge', async () => {
    const { service, statements } = harness();
    await service.startEnrollment(TOKEN, event, 'platform');
    expect(writes(statements, /insert into auth\.mfa_factors/)).toHaveLength(1);
    const lookups = statements.filter(({ sql }) => sql.includes('from auth.mfa_login_challenges challenge'));
    for (const lookup of lookups) expect(lookup.values).toContain('platform');
  });
});
