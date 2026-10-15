jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { type ArgumentsHost, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { createHmac } from 'node:crypto';
import type { MfaService } from '../auth/mfa/mfa.service';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import * as passwordHash from '../auth/password-hash';
import { requestDigest } from '../common/idempotency';
import { DomainProblem, ProblemDetailsFilter, PublicDetailProblem, RetryAfterProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import * as environment from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { ClinicianApplicationService } from './clinician-application.service';
import type { SubmitClinicianApplicationDto } from './dto/clinician-application.dto';

/**
 * ClinicianApplicationService (ADR-064) against a scripted database: the gate
 * and quota order, the keyed digests and the derived 0088 token, delivery
 * after the response, the submit transaction, the authenticator steps and the
 * database error table.
 */
const KEY = Buffer.alloc(32, 7);
const request = { correlationId: 'clinician-test-0001', ip: '203.0.113.71', userAgent: 'synthetic-agent' };
const email = 'synthetic.clinician@example.invalid';
const challengeId = '3f0c4a8e-2b1d-4c6e-9a7f-5d8b1e2c3a40';
const accountId = '7c6b5a49-3827-4615-8a4b-3c2d1e0f9a8b';
const mfaChallengeId = '1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7a8b';
const TOKEN = 'T'.repeat(43);
const submitInput = {
  email, fullName: 'Ada Synthetic', password: 'a-long-synthetic-password', profession: 'doctor', regulator: 'MDCN',
  licenceNumber: 'MDCN/12345', licenceValidUntil: '2027-06-30', facilityId: '0d9f8e7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f',
  declarations: { accurate: true, verificationConsent: true },
} as SubmitClinicianApplicationDto;

type Handler = (values: unknown[]) => unknown;
interface Harness {
  service: ClinicianApplicationService;
  calls: Array<{ sql: string; values: unknown[]; transaction: number }>;
  transactions: Array<{ committed: boolean }>;
  notification: { deliver: jest.Mock };
  mfa: Record<string, jest.Mock>;
  route: Map<string, Handler>;
}

function settings(values: Partial<environment.Environment> = {}): void {
  jest.spyOn(environment, 'getEnvironment').mockReturnValue({
    NODE_ENV: 'test', OTP_HMAC_KEY_B64: KEY.toString('base64'),
    CLINICIAN_APPLICATION_SIGNUP_NETWORK_HOURLY_LIMIT: 20, CLINICIAN_APPLICATION_SIGNUP_NETWORK_DAILY_LIMIT: 60,
    CLINICIAN_APPLICATION_SIGNUP_PLATFORM_DAILY_LIMIT: 1000, CLINICIAN_APPLICATION_STATUS_NETWORK_HOURLY_LIMIT: 21,
    CLINICIAN_APPLICATION_STATUS_NETWORK_DAILY_LIMIT: 61, CLINICIAN_APPLICATION_STATUS_PLATFORM_DAILY_LIMIT: 2000,
    CLINICIAN_APPLICATION_SEARCH_NETWORK_HOURLY_LIMIT: 120, CLINICIAN_APPLICATION_SEARCH_NETWORK_DAILY_LIMIT: 500,
    CLINICIAN_APPLICATION_SEARCH_PLATFORM_DAILY_LIMIT: 20000, CLINICIAN_APPLICATION_SUBMIT_NETWORK_HOURLY_LIMIT: 5,
    CLINICIAN_APPLICATION_SUBMIT_NETWORK_DAILY_LIMIT: 10, CLINICIAN_APPLICATION_SUBMIT_PLATFORM_DAILY_LIMIT: 200,
    CLINICIAN_APPLICATION_FACILITY_OPEN_LIMIT: 30, CLINICIAN_APPLICATION_SWEEP_SECONDS: 900,
    ...values,
  } as environment.Environment);
}

function harness(overrides: Record<string, Handler> = {}): Harness {
  const calls: Harness['calls'] = [];
  const transactions: Harness['transactions'] = [];
  const route = new Map<string, Handler>(Object.entries({
    'platform.control_enabled': () => ({ rows: [{ maintenance: false, signup: true, portal: true }] }),
    'consume_clinician_application_quota': () => ({ rows: [{ allowed: true }] }),
    'begin_clinician_application_challenge': () => ({ rows: [{ deliver: true }] }),
    'invalidate_clinician_application_challenge': () => ({ rows: [] }),
    'clinician_application_session(': () => ({ rows: [{ kind: 'account', stage: 'enrolment_required',
      account_id: accountId, mfa_challenge_id: mfaChallengeId, expires_at: new Date('2026-10-15T10:30:00Z') }] }),
    'bind_clinician_application_mfa_challenge': () => ({ rows: [] }),
    'clinician_application_submit_probe': () => ({ rows: [{ outcome: 'new' }] }),
    'count_clinician_application_submit_attempt': () => ({ rows: [] }),
    ...overrides,
  }));
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values, transaction: transactions.length - 1 });
    for (const [needle, handler] of route) if (sql.includes(needle)) return handler(values);
    throw new Error(`unexpected statement: ${sql}`);
  }) };
  const database = { withSystemTransaction: jest.fn(async (_correlationId: string,
    work: (value: typeof client) => Promise<unknown>) => {
    const transaction = { committed: false };
    transactions.push(transaction);
    const result = await work(client);
    transaction.committed = true;
    return result;
  }) };
  const notification = { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted' }) };
  const mfa = {
    openApplicantChallenge: jest.fn().mockResolvedValue({ kind: 'opened', purpose: 'enroll',
      expiresAt: new Date('2026-10-15T10:10:00Z') }),
    sendEnrollmentCode: jest.fn().mockResolvedValue({ accepted: true, channel: 'email',
      expiresAt: new Date('2026-10-15T10:10:00Z') }),
    startEnrollment: jest.fn(),
    activateEnrollment: jest.fn(),
    completeLogin: jest.fn(),
  };
  const service = new ClinicianApplicationService(database as unknown as DatabaseService,
    notification as unknown as NotificationOtpClient, mfa as unknown as MfaService);
  return { service, calls, transactions, notification, mfa, route };
}

const statements = (h: Harness) => h.calls.map(({ sql }) => sql.replace(/\s+/g, ' ').trim());
const indexOf = (h: Harness, needle: string) => statements(h).findIndex((sql) => sql.includes(needle));
async function refusal(promise: Promise<unknown>): Promise<DomainProblem> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}
const expected = (label: string, ...parts: string[]) => {
  const digest = createHmac('sha256', KEY).update(`clinician-application\0${label}`);
  for (const part of parts) digest.update(`\0${part}`);
  return digest.digest('hex');
};

beforeEach(() => settings());
afterEach(() => jest.restoreAllMocks());

describe('keyed digests', () => {
  it('keeps each digest in its own domain and derives the 0088 token from the capability and challenge', () => {
    const { service } = harness();
    const values = [service.hmac('email', 'x'), service.hmac('otp', 'x'), service.hmac('session', 'x'),
      service.hmac('ip', 'x')];
    expect(new Set(values).size).toBe(4);
    expect(service.hmac('otp', challengeId, '123456')).toBe(expected('otp', challengeId, '123456'));
    expect(service.hmac('session', TOKEN)).toBe(expected('session', TOKEN));
    const derived = service.derivedChallengeToken(TOKEN, mfaChallengeId);
    expect(derived).toBe(createHmac('sha256', KEY)
      .update(`clinician-application\0mfa-challenge\0${TOKEN}\0${mfaChallengeId}`).digest('base64url'));
    expect(derived).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(derived).not.toBe(TOKEN);
    expect(service.derivedChallengeToken(TOKEN, mfaChallengeId)).toBe(derived);
    expect(service.derivedChallengeToken(TOKEN, challengeId)).not.toBe(derived);
    expect(service.derivedChallengeToken('U'.repeat(43), mfaChallengeId)).not.toBe(derived);
    // The derived token is not a session digest of anything the browser holds.
    expect(Buffer.from(derived, 'base64url').toString('hex')).not.toBe(service.hmac('session', TOKEN));
  });

  it('refuses every command with 503 in production without OTP_HMAC_KEY_B64, and reports intake closed', async () => {
    settings({ NODE_ENV: 'production', OTP_HMAC_KEY_B64: undefined });
    const h = harness();
    for (const call of [() => h.service.startSignup(email, request), () => h.service.startStatus(email, request),
      () => h.service.verifySignupCode({ challengeId, email, code: '123456' }, request),
      () => h.service.current(TOKEN, request)]) {
      const problem = await refusal(call());
      expect([problem.getStatus(), problem.code]).toEqual([503, 'CLINICIAN_APPLICATION_UNAVAILABLE']);
    }
    await expect(h.service.availability('c')).resolves.toEqual({ open: false });
    await h.service.endSession(TOKEN, request);
    expect(h.calls).toEqual([]);
  });
});

describe('the email-code starts', () => {
  it('checks the gate, then charges the quota, then starts the challenge, and delivers after the answer', async () => {
    const h = harness();
    const answer = await h.service.startSignup(email, request);
    expect(answer).toEqual({ accepted: true, challengeId: expect.any(String), expiresInSeconds: 600,
      resendAfterSeconds: 60 });
    expect(indexOf(h, 'platform.control_enabled')).toBe(0);
    expect(indexOf(h, 'consume_clinician_application_quota')).toBe(1);
    expect(indexOf(h, 'begin_clinician_application_challenge')).toBe(2);
    const network = expected('ip', '203.0.113.71');
    expect(h.calls[1]!.values).toEqual([network, 'email_code', 20, 60, 1000]);
    const [purpose, id, emailHmac, address, codeHmac] = h.calls[2]!.values as string[];
    expect([purpose, id, emailHmac, address]).toEqual(['signup', answer.challengeId, expected('email', email), email]);
    await h.service.settleDeliveries();
    const delivered = h.notification.deliver.mock.calls[0]![0] as { code: string };
    expect(h.notification.deliver).toHaveBeenCalledWith({ challengeId: answer.challengeId, recipient: email,
      code: expect.stringMatching(/^[0-9]{6}$/), purpose: 'SIGNUP_VERIFY', channel: 'email',
      correlationId: request.correlationId });
    expect(codeHmac).toBe(expected('otp', answer.challengeId, delivered.code));
    // Nothing the database or a log sees carries the address in the network digest.
    expect(JSON.stringify(h.calls[1]!.values)).not.toContain('203.0.113.71');
  });

  it('answers the same whether or not a code is delivered, and invalidates a definitively failed one', async () => {
    const h = harness({ 'begin_clinician_application_challenge': () => ({ rows: [{ deliver: false }] }) });
    const silent = await h.service.startStatus(email, request);
    await h.service.settleDeliveries();
    expect(h.notification.deliver).not.toHaveBeenCalled();
    expect(h.calls[1]!.values).toEqual([expected('ip', '203.0.113.71'), 'status_code', 21, 61, 2000]);
    expect(h.calls[2]!.values[0]).toBe('status');
    h.route.set('begin_clinician_application_challenge', () => ({ rows: [{ deliver: true }] }));
    h.notification.deliver.mockResolvedValue({ outcome: 'definitive_failure' });
    const delivered = await h.service.startStatus(email, request);
    expect(Object.keys(delivered)).toEqual(Object.keys(silent));
    await h.service.settleDeliveries();
    const invalidation = h.calls.find(({ sql }) => sql.includes('invalidate_clinician_application_challenge'));
    expect(invalidation?.values).toEqual([delivered.challengeId]);
  });

  it('commits a quota refusal and answers 429 with the daily window, starting nothing', async () => {
    const h = harness({ 'consume_clinician_application_quota': () => ({ rows: [{ allowed: false }] }) });
    const problem = await refusal(h.service.startSignup(email, request));
    expect(problem).toBeInstanceOf(RetryAfterProblem);
    expect([problem.getStatus(), problem.code, (problem as RetryAfterProblem).retryAfterSeconds])
      .toEqual([429, 'CLINICIAN_APPLICATION_RATE_LIMITED', 86_400]);
    expect(h.transactions).toEqual([{ committed: true }]);
    expect(indexOf(h, 'begin_clinician_application_challenge')).toBe(-1);
  });

  it('answers a closed intake before the quota, but lets the status start run while sign-up is off', async () => {
    const closed = harness({ 'platform.control_enabled': () => ({ rows: [{ maintenance: false, signup: false, portal: true }] }) });
    const problem = await refusal(closed.service.startSignup(email, request));
    expect(problem).toBeInstanceOf(PublicDetailProblem);
    expect([problem.getStatus(), problem.code, problem.message]).toEqual([503, 'CLINICIAN_SIGNUP_CLOSED',
      'Clinician sign-up is not open yet. If you already have a Health ID provider account, sign in.']);
    expect(indexOf(closed, 'consume_clinician_application_quota')).toBe(-1);
    await closed.service.startStatus(email, request);
    expect(indexOf(closed, 'begin_clinician_application_challenge')).toBeGreaterThan(-1);
    const portalOff = harness({ 'platform.control_enabled': () => ({ rows: [{ maintenance: false, signup: true, portal: false }] }) });
    expect((await refusal(portalOff.service.startSignup(email, request))).code).toBe('CLINICIAN_SIGNUP_CLOSED');
    const maintenance = harness({ 'platform.control_enabled': () => ({ rows: [{ maintenance: true, signup: true, portal: true }] }) });
    for (const call of [() => maintenance.service.startSignup(email, request),
      () => maintenance.service.startStatus(email, request)]) {
      const refused = await refusal(call());
      expect([refused.getStatus(), refused.code]).toEqual([503, 'PLATFORM_MAINTENANCE']);
    }
    expect(indexOf(maintenance, 'consume_clinician_application_quota')).toBe(-1);
  });

  it('refuses a request without a usable client network before any database work', async () => {
    const h = harness();
    expect((await refusal(h.service.startSignup(email, { correlationId: 'c' }))).code)
      .toBe('CLINICIAN_APPLICATION_UNAVAILABLE');
    expect(h.calls).toEqual([]);
  });
});

describe('the code verifications', () => {
  it('opens a draft on a correct sign-up code and answers wrong and in-use codes after they commit', async () => {
    const h = harness({ 'verify_clinician_application_signup_code': () => ({ rows: [{ outcome: 'verified' }] }),
      'clinician_application_session(': () => ({ rows: [{ kind: 'draft', stage: null, account_id: null,
        mfa_challenge_id: null, expires_at: new Date('2026-10-15T11:00:00Z') }] }) });
    const verified = await h.service.verifySignupCode({ challengeId, email, code: '123456' }, request);
    expect(verified.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verified.answer).toEqual({ verified: true, expiresAt: '2026-10-15T11:00:00.000Z' });
    const call = h.calls.find(({ sql }) => sql.includes('verify_clinician_application_signup_code'))!;
    expect(call.values).toEqual([challengeId, expected('email', email), email, expected('otp', challengeId, '123456'),
      expected('session', verified.token)]);
    h.route.set('verify_clinician_application_signup_code', () => ({ rows: [{ outcome: 'invalid' }] }));
    const wrong = await refusal(h.service.verifySignupCode({ challengeId, email, code: '000000' }, request));
    expect([wrong.getStatus(), wrong.code, wrong.message]).toEqual([401, 'CLINICIAN_APPLICATION_CODE_INVALID',
      'The code is wrong or has expired.']);
    expect(h.transactions.at(-1)).toEqual({ committed: true });
    h.route.set('verify_clinician_application_signup_code', () => ({ rows: [{ outcome: 'email_in_use' }] }));
    const inUse = await refusal(h.service.verifySignupCode({ challengeId, email, code: '123456' }, request));
    expect([inUse.getStatus(), inUse.code]).toEqual([409, 'CLINICIAN_EMAIL_IN_USE']);
    expect(inUse.message).toBe('This email address already has a Health ID account. Sign in, reset your password,'
      + ' or use a different email address for your clinician account.');
  });

  it('opens the authenticator challenge of a correct status code on a derived token, in the same transaction', async () => {
    const h = harness({ 'verify_clinician_application_status_code': () => ({ rows: [{ outcome: 'verified',
      account_id: accountId, stage: 'authenticator_required' }] }),
    'clinician_application_session(': () => ({ rows: [{ kind: 'account', stage: 'authenticator_required',
      account_id: accountId, mfa_challenge_id: null, expires_at: new Date('2026-10-15T10:30:00Z') }] }) });
    h.mfa.openApplicantChallenge!.mockResolvedValue({ kind: 'opened', purpose: 'verify', expiresAt: new Date() });
    const result = await h.service.verifyStatusCode({ challengeId, email, code: '123456' }, request);
    expect(result.answer).toEqual({ next: 'authenticator_verify', expiresAt: '2026-10-15T10:30:00.000Z' });
    const [, opened, challenge] = h.mfa.openApplicantChallenge!.mock.calls[0]! as [unknown, string,
      { id: string; token: string }];
    expect(opened).toBe(accountId);
    expect(challenge.token).toBe(h.service.derivedChallengeToken(result.token, challenge.id));
    const bind = h.calls.find(({ sql }) => sql.includes('bind_clinician_application_mfa_challenge'))!;
    expect(bind.values).toEqual([expected('session', result.token), challenge.id]);
    expect(new Set(h.calls.map(({ transaction }) => transaction))).toEqual(new Set([0]));
    expect(JSON.stringify(result.answer)).not.toContain(challenge.token);
  });

  it('answers a decoy or wrong status code 401, an unproven factor 403, and an account that re-enrols only at staff sign-in 403, opening nothing', async () => {
    for (const [outcome, status, code] of [['invalid', 401, 'CLINICIAN_APPLICATION_CODE_INVALID'],
      ['factor_unproven', 403, 'STAFF_MFA_FACTOR_UNPROVEN'],
      ['staff_sign_in_required', 403, 'CLINICIAN_APPLICATION_STAFF_SIGN_IN_REQUIRED']] as const) {
      const h = harness({ 'verify_clinician_application_status_code': () => ({ rows: [{ outcome, account_id: null,
        stage: null }] }) });
      const problem = await refusal(h.service.verifyStatusCode({ challengeId, email, code: '123456' }, request));
      expect([problem.getStatus(), problem.code]).toEqual([status, code]);
      expect(h.mfa.openApplicantChallenge).not.toHaveBeenCalled();
      expect(h.transactions).toEqual([{ committed: true }]);
    }
  });
});

describe('the submit', () => {
  const row = { application_id: 'a1', account_id: accountId, state: 'awaiting_authenticator',
    submitted_at: new Date('2026-10-15T10:00:00Z'), expires_at: new Date('2026-11-14T10:00:00Z'),
    facility_id: submitInput.facilityId, facility_name: 'Synthetic Clinic', application_version: '1',
    session_stage: 'enrolment_required', replayed: false };

  it('checks the draft, then charges the quota and counts a hash in its own transaction, hashes with argon2id, and opens the enrolment in the submit transaction', async () => {
    const h = harness({ 'submit_clinician_application': () => ({ rows: [row] }) });
    const hashing = jest.spyOn(passwordHash, 'hashAccountPassword');
    const result = await h.service.submit(TOKEN, 'clinician-submit-0000000001', submitInput, request);
    expect(h.transactions).toEqual([{ committed: true }, { committed: true }]);
    expect(h.calls.filter(({ transaction }) => transaction === 0).map(({ sql }) => sql))
      .toEqual([expect.stringContaining('platform.control_enabled'), expect.stringContaining('clinician_application_submit_probe'),
        expect.stringContaining('consume_clinician_application_quota'),
        expect.stringContaining('count_clinician_application_submit_attempt')]);
    const { password: _unused, ...unhashed } = submitInput;
    // The probe gets the details C8 would refuse without the password.
    expect(h.calls[1]!.values).toEqual([expected('session', TOKEN), expected('email', email), 'clinician-submit-0000000001',
      requestDigest('clinician-application.submit', unhashed), email, 'Ada Synthetic', 'doctor', 'MDCN', 'MDCN/12345',
      '2027-06-30', submitInput.facilityId, 30]);
    expect(h.calls[2]!.values).toEqual([expected('ip', '203.0.113.71'), 'submit', 5, 10, 200]);
    expect(h.calls[3]!.values).toEqual([expected('session', TOKEN)]);
    expect(hashing).toHaveBeenCalledWith(submitInput.password);
    const submit = h.calls.find(({ sql }) => sql.includes('submit_clinician_application'))!;
    expect(submit.transaction).toBe(1);
    const values = submit.values as unknown[];
    expect(values[0]).toBe(expected('session', TOKEN));
    expect(values[1]).toBe(expected('session', result.token));
    expect(values[2]).toBe('clinician-submit-0000000001');
    const { password: _password, ...withoutPassword } = submitInput;
    expect(values[3]).toBe(requestDigest('clinician-application.submit', withoutPassword));
    expect(values.slice(4, 7)).toEqual([email, expected('email', email), 'Ada Synthetic']);
    expect(values[7]).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    // The facility's open limit and the platform's daily limit, which C8 enforces where it creates the application.
    expect(values.slice(8)).toEqual(['doctor', 'MDCN', 'MDCN/12345', '2027-06-30', submitInput.facilityId, 30, 200]);
    expect(JSON.stringify(h.calls)).not.toContain(submitInput.password);
    const [client, opened, challenge] = h.mfa.openApplicantChallenge!.mock.calls[0]! as [unknown, string,
      { id: string; token: string }];
    expect(client).toBeDefined();
    expect(opened).toBe(accountId);
    expect(challenge.token).toBe(h.service.derivedChallengeToken(result.token, challenge.id));
    const bind = h.calls.find(({ sql }) => sql.includes('bind_clinician_application_mfa_challenge'))!;
    expect(bind).toMatchObject({ transaction: 1, values: [expected('session', result.token), challenge.id] });
    expect(result.answer).toEqual({ applicationId: 'a1', state: 'awaiting_authenticator',
      submittedAt: '2026-10-15T10:00:00.000Z', expiresAt: '2026-11-14T10:00:00.000Z',
      facility: { id: submitInput.facilityId, name: 'Synthetic Clinic' }, profession: 'doctor', version: 1,
      replayed: false, next: 'authenticator', authenticator: { purpose: 'enroll', expiresAt: '2026-10-15T10:10:00.000Z' } });
    const text = JSON.stringify(result.answer);
    for (const secret of [TOKEN, result.token, challenge.token]) expect(text).not.toContain(secret);
  });

  it('refuses a profession and regulator that do not pair, and a short password, before any work (with the body checks)', async () => {
    const h = harness();
    const mismatch = await refusal(h.service.submit(TOKEN, 'clinician-submit-0000000001',
      { ...submitInput, regulator: 'NMCN' } as SubmitClinicianApplicationDto, request));
    expect([mismatch.getStatus(), mismatch.code]).toEqual([400, 'CLINICIAN_APPLICATION_INVALID']);
    const short = await refusal(h.service.submit(TOKEN, 'clinician-submit-0000000001',
      { ...submitInput, password: 'short' } as SubmitClinicianApplicationDto, request));
    expect([short.getStatus(), short.code]).toEqual([400, 'PASSWORD_INVALID']);
    expect(h.calls).toEqual([]);
  });

  it('refuses a missing or malformed capability after the gate, charging nothing', async () => {
    for (const token of [undefined, 'not-a-token']) {
      const h = harness();
      const problem = await refusal(h.service.submit(token, 'clinician-submit-0000000001', submitInput, request));
      expect([problem.getStatus(), problem.code]).toEqual([401, 'CLINICIAN_APPLICATION_SESSION_INVALID']);
      expect(statements(h)).toEqual([expect.stringContaining('platform.control_enabled')]);
    }
  });

  it('refuses a forged or spent draft with 401 before the quota is charged or the password hashed', async () => {
    const hashing = jest.spyOn(passwordHash, 'hashAccountPassword');
    const h = harness({ 'clinician_application_submit_probe': () => {
      throw Object.assign(new Error('CLINICIAN_APPLICATION_SESSION_INVALID'), { code: '42501' });
    } });
    const problem = await refusal(h.service.submit('F'.repeat(43), 'clinician-submit-0000000001', submitInput, request));
    expect([problem.getStatus(), problem.code]).toEqual([401, 'CLINICIAN_APPLICATION_SESSION_INVALID']);
    expect(indexOf(h, 'consume_clinician_application_quota')).toBe(-1);
    expect(indexOf(h, 'submit_clinician_application(')).toBe(-1);
    expect(hashing).not.toHaveBeenCalled();
  });

  it('charges a replay of a spent draft (same key and request) and lets C8 answer it, without hashing the password', async () => {
    const hashing = jest.spyOn(passwordHash, 'hashAccountPassword');
    const h = harness({ 'clinician_application_submit_probe': () => ({ rows: [{ outcome: 'replay' }] }),
      'submit_clinician_application': () => ({ rows: [{ ...row, replayed: true }] }) });
    const result = await h.service.submit(TOKEN, 'clinician-submit-0000000001', submitInput, request);
    expect(result.answer.replayed).toBe(true);
    expect(indexOf(h, 'consume_clinician_application_quota')).toBeGreaterThan(indexOf(h, 'clinician_application_submit_probe'));
    // A replay counts no hash against the draft, and C8 gets a placeholder in its format, not the password's hash.
    expect(indexOf(h, 'count_clinician_application_submit_attempt')).toBe(-1);
    expect(hashing).not.toHaveBeenCalledWith(submitInput.password);
    const placeholder = h.calls.find(({ sql }) => sql.includes('submit_clinician_application('))!.values[7];
    expect(placeholder).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    await h.service.submit(TOKEN, 'clinician-submit-0000000001', submitInput, request);
    expect(h.calls.filter(({ sql }) => sql.includes('submit_clinician_application(')).at(-1)!.values[7]).toBe(placeholder);
    expect(hashing.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it.each([
    ['CLINICIAN_APPLICATION_INVALID', 400], ['CLINICIAN_APPLICATION_FACILITY_UNAVAILABLE', 409],
    ['CLINICIAN_APPLICATION_FACILITY_BUSY', 409], ['CLINICIAN_EMAIL_IN_USE', 409],
  ] as const)('charges the quota and answers %s as C8 would, without hashing the password or calling C8', async (marker, status) => {
    const hashing = jest.spyOn(passwordHash, 'hashAccountPassword');
    const h = harness({ 'clinician_application_submit_probe': () => ({ rows: [{ outcome: marker }] }) });
    const problem = await refusal(h.service.submit(TOKEN, 'clinician-submit-0000000001', submitInput, request));
    expect([problem.getStatus(), problem.code]).toEqual([status, marker]);
    expect(h.transactions).toEqual([{ committed: true }]);
    expect(indexOf(h, 'consume_clinician_application_quota')).toBeGreaterThan(-1);
    expect(indexOf(h, 'count_clinician_application_submit_attempt')).toBe(-1);
    expect(indexOf(h, 'submit_clinician_application(')).toBe(-1);
    expect(hashing).not.toHaveBeenCalled();
  });

  it('answers a draft whose five hashes are spent with 401, rolling the charge back, without hashing', async () => {
    const hashing = jest.spyOn(passwordHash, 'hashAccountPassword');
    const h = harness({ 'count_clinician_application_submit_attempt': () => {
      throw Object.assign(new Error('CLINICIAN_APPLICATION_SESSION_INVALID'), { code: '42501' });
    } });
    const problem = await refusal(h.service.submit(TOKEN, 'clinician-submit-0000000001', submitInput, request));
    expect([problem.getStatus(), problem.code]).toEqual([401, 'CLINICIAN_APPLICATION_SESSION_INVALID']);
    expect(h.transactions).toEqual([{ committed: false }]);
    expect(hashing).not.toHaveBeenCalled();
  });

  it('counts no hash when the quota refuses, and answers 429', async () => {
    const h = harness({ 'consume_clinician_application_quota': () => ({ rows: [{ allowed: false }] }) });
    const problem = await refusal(h.service.submit(TOKEN, 'clinician-submit-0000000001', submitInput, request));
    expect([problem.getStatus(), problem.code]).toEqual([429, 'CLINICIAN_APPLICATION_RATE_LIMITED']);
    expect(indexOf(h, 'count_clinician_application_submit_attempt')).toBe(-1);
  });

  it('answers a creation refused at the platform\'s daily cap (C8, under the counter\'s lock) with 429 and nothing committed', async () => {
    const h = harness({ 'submit_clinician_application': () => {
      throw Object.assign(new Error('CLINICIAN_APPLICATION_QUOTA_EXCEEDED'), { code: 'P4290' });
    } });
    const problem = await refusal(h.service.submit(TOKEN, 'clinician-submit-0000000001', submitInput, request));
    expect(problem).toBeInstanceOf(RetryAfterProblem);
    expect([problem.getStatus(), problem.code, (problem as RetryAfterProblem).retryAfterSeconds])
      .toEqual([429, 'CLINICIAN_APPLICATION_RATE_LIMITED', 86_400]);
    expect(h.transactions.at(-1)).toEqual({ committed: false });
    expect(h.mfa.openApplicantChallenge).not.toHaveBeenCalled();
  });

  it('still answers the application when the account challenge budget is spent (P9 opens it later)', async () => {
    const h = harness({ 'submit_clinician_application': () => ({ rows: [row] }) });
    h.mfa.openApplicantChallenge!.mockResolvedValue({ kind: 'rate_limited' });
    const result = await h.service.submit(TOKEN, 'clinician-submit-0000000001', submitInput, request);
    expect(result.answer.authenticator).toBeNull();
    expect(indexOf(h, 'bind_clinician_application_mfa_challenge')).toBe(-1);
  });
});

describe('the refusal order of the intake routes (P3, P4, P14)', () => {
  const details = { profession: 'doctor', regulator: 'MDCN', licenceNumber: 'MDCN/12345', licenceValidUntil: '2027-06-30',
    facilityId: submitInput.facilityId, declarations: { accurate: true, verificationConsent: true } } as const;
  const routes = (h: Harness, token: string | undefined, signedIn = false) => [
    () => h.service.searchFacilities(token, 'Synthetic', signedIn, request),
    () => h.service.submit(token, 'clinician-submit-0000000001', submitInput, request),
    () => h.service.apply(token, 'clinician-apply-00000000001', details as never, request),
  ];
  const forged = () => { throw Object.assign(new Error('CLINICIAN_APPLICATION_SESSION_INVALID'), { code: '42501' }); };

  it.each([
    ['intake closed', { maintenance: false, signup: false, portal: true }, 'CLINICIAN_SIGNUP_CLOSED'],
    ['the provider portal off', { maintenance: false, signup: true, portal: false }, 'CLINICIAN_SIGNUP_CLOSED'],
    ['intake closed in maintenance', { maintenance: true, signup: false, portal: true }, 'CLINICIAN_SIGNUP_CLOSED'],
    ['maintenance', { maintenance: true, signup: true, portal: true }, 'PLATFORM_MAINTENANCE'],
  ])('answers %s with 503 before a missing, malformed or forged capability', async (_label, controls, code) => {
    for (const token of [undefined, 'not-a-token', 'F'.repeat(43)]) {
      const h = harness({ 'platform.control_enabled': () => ({ rows: [controls] }),
        'clinician_application_session(': forged, 'clinician_application_submit_probe': forged });
      for (const route of routes(h, token)) {
        const problem = await refusal(route());
        expect([problem.getStatus(), problem.code]).toEqual([503, code]);
      }
      expect(statements(h).every((sql) => sql.includes('platform.control_enabled'))).toBe(true);
    }
  });

  it('answers a draft in a signed-in browser at P3 after the gate and the capability, and before the quota', async () => {
    const draft = () => ({ rows: [{ kind: 'draft', stage: null, account_id: null, mfa_challenge_id: null,
      expires_at: new Date() }] });
    const maintenance = harness({ 'platform.control_enabled': () => ({ rows: [{ maintenance: true, signup: true,
      portal: true }] }), 'clinician_application_session(': draft });
    expect((await refusal(maintenance.service.searchFacilities(TOKEN, 'Synthetic', true, request))).code)
      .toBe('PLATFORM_MAINTENANCE');
    const h = harness({ 'clinician_application_session(': draft });
    const problem = await refusal(h.service.searchFacilities(TOKEN, 'Synthetic', true, request));
    expect([problem.getStatus(), problem.code]).toEqual([409, 'CLINICIAN_APPLICATION_REQUIRES_SIGN_OUT']);
    expect(statements(h)).toEqual([expect.stringContaining('platform.control_enabled'),
      expect.stringContaining('clinician_application_session(')]);
  });

  it('searches in one transaction: the gate, the capability, the quota, then the search', async () => {
    const h = harness({ 'search_clinician_application_facilities': () => ({ rows: [{ facility_id: 'f1',
      facility_name: 'Synthetic Clinic', organization_name: 'Synthetic Health' }] }) });
    h.route.set('clinician_application_session(', () => ({ rows: [{ kind: 'account', stage: 'ready', account_id: accountId,
      mfa_challenge_id: null, expires_at: new Date() }] }));
    await expect(h.service.searchFacilities(TOKEN, 'Synthetic', true, request)).resolves.toEqual({ facilities: [
      { facilityId: 'f1', name: 'Synthetic Clinic', organizationName: 'Synthetic Health' }] });
    expect(statements(h).map((sql) => ['platform.control_enabled', 'clinician_application_session(',
      'consume_clinician_application_quota', 'search_clinician_application_facilities']
      .findIndex((needle) => sql.includes(needle)))).toEqual([0, 1, 2, 3]);
    expect(h.transactions).toEqual([{ committed: true }]);
  });
});

describe('applying again (P14)', () => {
  const details = { profession: 'doctor', regulator: 'MDCN', licenceNumber: 'MDCN/12345', licenceValidUntil: '2027-06-30',
    facilityId: submitInput.facilityId, declarations: { accurate: true, verificationConsent: true } } as const;

  it.each([
    ['an unknown capability', () => { throw Object.assign(new Error('CLINICIAN_APPLICATION_SESSION_INVALID'), { code: '42501' }); },
      401, 'CLINICIAN_APPLICATION_SESSION_INVALID'],
    ['a draft', () => ({ rows: [{ kind: 'draft', stage: null, account_id: null, mfa_challenge_id: null,
      expires_at: new Date() }] }), 401, 'CLINICIAN_APPLICATION_SESSION_INVALID'],
    ['a capability that needs the authenticator', () => ({ rows: [{ kind: 'account', stage: 'authenticator_required',
      account_id: accountId, mfa_challenge_id: null, expires_at: new Date() }] }), 403,
    'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED'],
  ] as const)('refuses %s before the submit quota is charged', async (_label, session, status, code) => {
    const h = harness({ 'clinician_application_session(': session });
    const problem = await refusal(h.service.apply(TOKEN, 'clinician-apply-00000000001', details as never, request));
    expect([problem.getStatus(), problem.code]).toEqual([status, code]);
    expect(indexOf(h, 'consume_clinician_application_quota')).toBe(-1);
    expect(indexOf(h, 'file_clinician_application')).toBe(-1);
  });

  it('charges the quota for a ready capability, then files the application', async () => {
    const h = harness({ 'clinician_application_session(': () => ({ rows: [{ kind: 'account', stage: 'ready',
      account_id: accountId, mfa_challenge_id: null, expires_at: new Date() }] }),
    'file_clinician_application': () => ({ rows: [{ application: { applicationId: 'a2', state: 'submitted' },
      replayed: false }] }) });
    await expect(h.service.apply(TOKEN, 'clinician-apply-00000000001', details as never, request))
      .resolves.toEqual({ applicationId: 'a2', state: 'submitted', replayed: false });
    // The facility's open limit and the platform's daily limit, which C13 enforces where it creates the application.
    expect(h.calls.find(({ sql }) => sql.includes('file_clinician_application'))!.values.slice(7))
      .toEqual([submitInput.facilityId, 30, 200]);
    expect(indexOf(h, 'clinician_application_session(')).toBeLessThan(indexOf(h, 'consume_clinician_application_quota'));
    expect(indexOf(h, 'consume_clinician_application_quota')).toBeLessThan(indexOf(h, 'file_clinician_application'));
  });
});

describe('the authenticator steps', () => {
  it('drives the bound 0088 challenge through its derived token and makes the capability ready in the same transaction', async () => {
    const h = harness();
    const view = { stage: 'ready', applications: [] };
    h.mfa.activateEnrollment!.mockImplementation(async (_token, _code, _event, kind, options) => {
      expect(kind).toBe('staff');
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ view }] }) };
      const result = await options.onActivated(client, 'factor-1');
      expect(client.query).toHaveBeenCalledWith('select identity.clinician_application_authenticator_ready($1,$2,$3) as view',
        [expected('session', TOKEN), 'factor-1', 'enrolment']);
      return { factorId: 'factor-1', recoveryCodes: ['code-1'], result };
    });
    await expect(h.service.activateAuthenticator(TOKEN, '123456', request))
      .resolves.toEqual({ recoveryCodes: ['code-1'], stage: 'ready', applications: [] });
    expect(h.mfa.activateEnrollment!.mock.calls[0]![0]).toBe(h.service.derivedChallengeToken(TOKEN, mfaChallengeId));
    expect(h.mfa.activateEnrollment!.mock.calls[0]![4]).toMatchObject({ issue: 'none' });

    h.route.set('clinician_application_session(', () => ({ rows: [{ kind: 'account', stage: 'authenticator_required',
      account_id: accountId, mfa_challenge_id: mfaChallengeId, expires_at: new Date() }] }));
    h.mfa.completeLogin!.mockImplementation(async (_token, _input, _event, _kind, options) => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [{ view }] }) };
      const result = await options.onVerified(client, { factorId: 'factor-1', method: 'recovery_code' });
      expect(client.query.mock.calls[0]![1]).toEqual([expected('session', TOKEN), 'factor-1', 'recovery_code']);
      return { factorId: 'factor-1', method: 'recovery_code', result };
    });
    await expect(h.service.verifyAuthenticator(TOKEN, { recoveryCode: 'abcd-efgh-jk' }, request)).resolves.toEqual(view);
    expect(h.mfa.completeLogin!.mock.calls[0]!.slice(0, 2)).toEqual([h.service.derivedChallengeToken(TOKEN, mfaChallengeId),
      { recoveryCode: 'abcd-efgh-jk' }]);
  });

  it('starts the enrolment in the applicant mode, so a wrong emailed proof counts in the applicants\' bucket', async () => {
    const h = harness();
    h.mfa.startEnrollment!.mockResolvedValue({ secret: 'S', otpauthUri: 'otpauth://x', algorithm: 'SHA1', digits: 6,
      periodSeconds: 30, expiresAt: new Date('2026-10-15T10:10:00Z') });
    await h.service.startAuthenticator(TOKEN, '246810', request);
    expect(h.mfa.startEnrollment).toHaveBeenCalledWith(h.service.derivedChallengeToken(TOKEN, mfaChallengeId),
      expect.objectContaining({ correlationId: request.correlationId }), 'staff', { emailCode: '246810' },
      { applicant: true });
  });

  it('answers a database fault in the emailed proof or the enrolment start 503, never 500, and keeps the 0088 codes', async () => {
    const fault = (code: string, message: string) => Object.assign(new Error(message), { code });
    const h = harness();
    h.mfa.sendEnrollmentCode!.mockRejectedValueOnce(fault('57014', 'canceling statement due to statement timeout'));
    const sent = await refusal(h.service.sendAuthenticatorCode(TOKEN, request));
    expect([sent.getStatus(), sent.code]).toEqual([503, 'CLINICIAN_APPLICATION_UNAVAILABLE']);
    h.mfa.startEnrollment!.mockRejectedValueOnce(fault('42501', 'permission denied for table mfa_login_challenges'));
    const started = await refusal(h.service.startAuthenticator(TOKEN, '246810', request));
    expect([started.getStatus(), started.code]).toEqual([503, 'CLINICIAN_APPLICATION_UNAVAILABLE']);
    const limited = new RetryAfterProblem(429, 'MFA_RATE_LIMITED', 'Too many verification attempts; try again later', 900);
    h.mfa.sendEnrollmentCode!.mockRejectedValueOnce(limited);
    expect(await refusal(h.service.sendAuthenticatorCode(TOKEN, request))).toBe(limited);
    const proof = new DomainProblem(403, 'MFA_ENROLLMENT_PROOF_REQUIRED', 'Enter the code sent to your email address');
    h.mfa.startEnrollment!.mockRejectedValueOnce(proof);
    expect(await refusal(h.service.startAuthenticator(TOKEN, '246810', request))).toBe(proof);
  });

  it('refuses a draft, a ready capability and an unbound one with their own codes', async () => {
    for (const [capability, status, code] of [
      [{ kind: 'draft', stage: null, account_id: null, mfa_challenge_id: null }, 401, 'CLINICIAN_APPLICATION_SESSION_INVALID'],
      [{ kind: 'account', stage: 'ready', account_id: accountId, mfa_challenge_id: mfaChallengeId }, 409,
        'CLINICIAN_APPLICATION_AUTHENTICATOR_READY'],
      [{ kind: 'account', stage: 'enrolment_required', account_id: accountId, mfa_challenge_id: null }, 401,
        'MFA_CHALLENGE_INVALID'],
    ] as const) {
      const h = harness({ 'clinician_application_session(': () => ({ rows: [{ ...capability, expires_at: new Date() }] }) });
      const problem = await refusal(h.service.sendAuthenticatorCode(TOKEN, request));
      expect([problem.getStatus(), problem.code]).toEqual([status, code]);
      expect(h.mfa.sendEnrollmentCode).not.toHaveBeenCalled();
    }
  });

  it('answers 409 AUTHENTICATOR_READY, not 401, when a concurrent step made the capability ready before the bind', async () => {
    const h = harness({ 'bind_clinician_application_mfa_challenge': () => {
      throw Object.assign(new Error('CLINICIAN_APPLICATION_AUTHENTICATOR_READY'), { code: '42501' });
    } });
    const problem = await refusal(h.service.reopenAuthenticator(TOKEN, request));
    expect([problem.getStatus(), problem.code]).toEqual([409, 'CLINICIAN_APPLICATION_AUTHENTICATOR_READY']);
  });

  it('re-opens the challenge of the capability stage, and commits a spent budget before its 429', async () => {
    const h = harness();
    await expect(h.service.reopenAuthenticator(TOKEN, request)).resolves.toEqual({ purpose: 'enroll',
      expiresAt: '2026-10-15T10:10:00.000Z' });
    const challenge = h.mfa.openApplicantChallenge!.mock.calls[0]![2] as { id: string; token: string };
    expect(challenge.token).toBe(h.service.derivedChallengeToken(TOKEN, challenge.id));
    h.mfa.openApplicantChallenge!.mockResolvedValue({ kind: 'rate_limited' });
    const problem = await refusal(h.service.reopenAuthenticator(TOKEN, request));
    expect([problem.getStatus(), problem.code]).toEqual([429, 'MFA_RATE_LIMITED']);
    expect((problem as RetryAfterProblem).retryAfterSeconds).toBeGreaterThan(0);
    expect(h.transactions.every(({ committed }) => committed)).toBe(true);
  });
});

describe('the database error table', () => {
  const error = (code: string, message: string) => Object.assign(new Error(message), { code });
  const cases: Array<[string, string, number, string]> = [
    ['P4290', 'CLINICIAN_APPLICATION_QUOTA_EXCEEDED', 429, 'CLINICIAN_APPLICATION_RATE_LIMITED'],
    ['P4290', 'CLINICIAN_APPLICATION_SEARCH_BUDGET', 429, 'CLINICIAN_APPLICATION_SEARCH_LIMITED'],
    ['55000', 'PLATFORM_CONTROL_DISABLED:clinician_signup_enabled', 503, 'CLINICIAN_SIGNUP_CLOSED'],
    ['55000', 'PLATFORM_CONTROL_DISABLED:provider_portal_enabled', 503, 'CLINICIAN_SIGNUP_CLOSED'],
    ['55000', 'PLATFORM_MAINTENANCE', 503, 'PLATFORM_MAINTENANCE'],
    ['55000', 'PLATFORM_CONTROL_UNAVAILABLE', 503, 'PLATFORM_CONTROL_UNAVAILABLE'],
    ['55000', 'CLINICIAN_APPLICATION_IMMUTABLE', 503, 'CLINICIAN_APPLICATION_UNAVAILABLE'],
    ['42501', 'CLINICIAN_APPLICATION_SESSION_INVALID', 401, 'CLINICIAN_APPLICATION_SESSION_INVALID'],
    ['42501', 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED', 403, 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED'],
    ['42501', 'CLINICIAN_APPLICATION_AUTHENTICATOR_READY', 409, 'CLINICIAN_APPLICATION_AUTHENTICATOR_READY'],
    ['42501', 'CLINICIAN_APPLICATION_STAFF_SIGN_IN_REQUIRED', 403, 'CLINICIAN_APPLICATION_STAFF_SIGN_IN_REQUIRED'],
    ['42501', 'CLINICIAN_APPLICATION_PERMISSION_DENIED', 503, 'CLINICIAN_APPLICATION_UNAVAILABLE'],
    ['42501', 'permission denied for function submit_clinician_application', 503, 'CLINICIAN_APPLICATION_UNAVAILABLE'],
    ['42501', '', 503, 'CLINICIAN_APPLICATION_UNAVAILABLE'],
    ['40001', 'CLINICIAN_APPLICATION_VERSION_CONFLICT', 409, 'VERSION_CONFLICT'],
    ['22023', 'CLINICIAN_APPLICATION_INVALID', 400, 'CLINICIAN_APPLICATION_INVALID'],
    ['22023', 'CLINICIAN_APPLICATION_QUOTA_INVALID', 503, 'CLINICIAN_APPLICATION_UNAVAILABLE'],
    ['P0002', 'CLINICIAN_APPLICATION_NOT_FOUND', 404, 'CLINICIAN_APPLICATION_NOT_FOUND'],
    ['23505', 'CLINICIAN_EMAIL_IN_USE', 409, 'CLINICIAN_EMAIL_IN_USE'],
    ['23505', 'CLINICIAN_APPLICATION_ALREADY_OPEN', 409, 'CLINICIAN_APPLICATION_ALREADY_OPEN'],
    ['23505', 'CLINICIAN_APPLICATION_MEMBERSHIP_EXISTS', 409, 'CLINICIAN_APPLICATION_MEMBERSHIP_EXISTS'],
    ['23505', 'CLINICIAN_APPLICATION_IDEMPOTENCY_CONFLICT', 409, 'IDEMPOTENCY_CONFLICT'],
    ['23505', 'duplicate key value violates unique constraint "accounts_email_key"', 503, 'CLINICIAN_APPLICATION_UNAVAILABLE'],
    ['23514', 'CLINICIAN_APPLICATION_FACILITY_UNAVAILABLE', 409, 'CLINICIAN_APPLICATION_FACILITY_UNAVAILABLE'],
    ['23514', 'CLINICIAN_APPLICATION_FACILITY_BUSY', 409, 'CLINICIAN_APPLICATION_FACILITY_BUSY'],
    ['23514', 'CLINICIAN_APPLICATION_ROLE_CONFLICT', 409, 'CLINICIAN_APPLICATION_ROLE_CONFLICT'],
    ['23514', 'CLINICIAN_APPLICATION_LIMIT_REACHED', 409, 'CLINICIAN_APPLICATION_LIMIT_REACHED'],
    ['23514', 'CLINICIAN_APPLICATION_STATE_INVALID', 409, 'CLINICIAN_APPLICATION_STATE_INVALID'],
    ['23514', 'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE', 403, 'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE'],
    ['23514', 'CLINICIAN_APPLICATION_ALREADY_OPEN', 503, 'CLINICIAN_APPLICATION_UNAVAILABLE'],
    ['23514', 'new row violates check constraint', 503, 'CLINICIAN_APPLICATION_UNAVAILABLE'],
    ['42883', 'function identity.submit_clinician_application does not exist', 503, 'CLINICIAN_APPLICATION_UNAVAILABLE'],
    ['57014', 'canceling statement due to statement timeout', 503, 'CLINICIAN_APPLICATION_UNAVAILABLE'],
  ];

  it.each(cases)('%s %s is %i %s', (code, message, status, answer) => {
    const problem = harness().service.databaseProblem(error(code, message));
    expect([problem.getStatus(), problem.code]).toEqual([status, answer]);
  });

  it('gives the rate limits a Retry-After and keeps only the closed-intake 503 sentence public', () => {
    const { service } = harness();
    const quota = service.databaseProblem(error('P4290', 'CLINICIAN_APPLICATION_QUOTA_EXCEEDED')) as RetryAfterProblem;
    expect(quota.retryAfterSeconds).toBe(86_400);
    // A capability's 30 searches never come back: not a "try again later" answer (A21).
    const budget = service.databaseProblem(error('P4290', 'CLINICIAN_APPLICATION_SEARCH_BUDGET'));
    expect(budget).not.toBeInstanceOf(RetryAfterProblem);
    for (const [code, message] of cases.filter(([, , status]) => status === 503).map(([c, m]) => [c, m] as const)) {
      const problem = service.databaseProblem(error(code, message));
      expect(problem instanceof PublicDetailProblem).toBe(problem.code === 'CLINICIAN_SIGNUP_CLOSED');
    }
    const passthrough = new DomainProblem(401, 'MFA_INVALID_CODE', 'The code is not valid');
    expect(service.databaseProblem(passthrough)).toBe(passthrough);
  });
});

/**
 * What a client receives for a refusal: the status, the Retry-After header
 * ProblemDetailsFilter sets (undefined when none), and the body.
 */
function onTheWire(problem: unknown): { status: number; retryAfter: string | undefined; body: Record<string, unknown> } {
  const headers = new Map<string, string>();
  const response = { status: jest.fn().mockReturnThis(), type: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn((name: string, value: string) => { headers.set(name.toLowerCase(), value); }) };
  const host = { switchToHttp: () => ({
    getRequest: () => ({ correlationId: request.correlationId, method: 'POST',
      route: { path: '/identity/clinician-applications' } } as unknown as HidRequest),
    getResponse: () => response as unknown as Response,
  }) } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(problem, host);
  return { status: response.status.mock.calls[0]![0] as number, retryAfter: headers.get('retry-after'),
    body: response.json.mock.calls[0]![0] as Record<string, unknown> };
}

// A21 (D-Eminence/hid-system#80): every rate-limit 429 of these routes tells
// the client, in Retry-After, the longest window that can have refused it,
// and nothing else does. The body names no wait.
describe('Retry-After on the wire (A21)', () => {
  const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
  // ProblemDetailsFilter logs every 5xx; these cases need only the answer.
  beforeEach(() => { jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined); });

  it('states the longest quota window on a quota 429, the platform cap reached in a creation included', () => {
    const { service } = harness();
    for (const marker of ['CLINICIAN_APPLICATION_QUOTA_EXCEEDED', '']) {
      const answer = onTheWire(service.databaseProblem(failure('P4290', marker)));
      expect([answer.status, answer.body.code, answer.retryAfter])
        .toEqual([429, 'CLINICIAN_APPLICATION_RATE_LIMITED', '86400']);
      expect(Object.keys(answer.body).sort())
        .toEqual(['code', 'correlationId', 'detail', 'instance', 'status', 'title', 'type']);
    }
  });

  // A capability's 30 searches never come back, so waiting does not help: as
  // #80 holds ASSISTED_DESK_CODE_LIMITED, the answer has its own code, says to
  // verify the address again, and carries no Retry-After.
  it('answers a spent search budget with its own code and no Retry-After', () => {
    const answer = onTheWire(harness().service.databaseProblem(failure('P4290', 'CLINICIAN_APPLICATION_SEARCH_BUDGET')));
    expect([answer.status, answer.body.code, answer.retryAfter]).toEqual([429, 'CLINICIAN_APPLICATION_SEARCH_LIMITED',
      undefined]);
    expect(answer.body.detail).toBe('Too many searches in this session. Verify your email address again to continue.');
  });

  it('answers a spent quota at submit 429 with the header, before any hash', async () => {
    const h = harness({ 'consume_clinician_application_quota': () => ({ rows: [{ allowed: false }] }) });
    const hashing = jest.spyOn(passwordHash, 'hashAccountPassword');
    const problem = await refusal(h.service.submit(TOKEN, 'clinician-submit-0000000002', submitInput, request));
    const answer = onTheWire(problem);
    expect([answer.status, answer.body.code, answer.retryAfter]).toEqual([429, 'CLINICIAN_APPLICATION_RATE_LIMITED', '86400']);
    expect(hashing).not.toHaveBeenCalled();
  });

  it('states the 15-minute MFA window when P9 finds the account challenge budget spent', async () => {
    const h = harness();
    h.mfa.openApplicantChallenge!.mockResolvedValue({ kind: 'rate_limited' });
    const answer = onTheWire(await refusal(h.service.reopenAuthenticator(TOKEN, request)));
    expect([answer.status, answer.body.code, answer.retryAfter]).toEqual([429, 'MFA_RATE_LIMITED', '900']);
  });

  it('passes MfaService\'s own 429 through with its header on the authenticator steps', async () => {
    const h = harness();
    h.mfa.sendEnrollmentCode!.mockRejectedValueOnce(
      new RetryAfterProblem(429, 'MFA_RATE_LIMITED', 'Too many verification attempts; try again later', 900));
    const answer = onTheWire(await refusal(h.service.sendAuthenticatorCode(TOKEN, request)));
    expect([answer.status, answer.retryAfter]).toEqual([429, '900']);
  });

  it.each([
    ['55000', 'PLATFORM_CONTROL_DISABLED:clinician_signup_enabled', 503],
    ['55000', 'PLATFORM_MAINTENANCE', 503],
    ['42501', 'CLINICIAN_APPLICATION_SESSION_INVALID', 401],
    ['23514', 'CLINICIAN_APPLICATION_LIMIT_REACHED', 409],
    ['23514', 'CLINICIAN_APPLICATION_FACILITY_BUSY', 409],
    ['57014', 'canceling statement due to statement timeout', 503],
  ])('sends no Retry-After with %s %s (%i): not a rate limit', (code, message, status) => {
    const answer = onTheWire(harness().service.databaseProblem(failure(code, message)));
    expect([answer.status, answer.retryAfter]).toEqual([status, undefined]);
  });
});

describe('logging', () => {
  it('never logs an address, code, token or driver message', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    }
    const h = harness({ 'end_clinician_application_session': () => {
      throw Object.assign(new Error(`failed for ${email}`), { code: '57P01' });
    }, 'invalidate_clinician_application_challenge': () => {
      throw Object.assign(new Error(`failed for ${email}`), { code: '57P01' });
    } });
    h.notification.deliver.mockResolvedValue({ outcome: 'definitive_failure' });
    await h.service.startSignup(email, request);
    await h.service.settleDeliveries();
    await h.service.endSession(TOKEN, request);
    expect(lines.length).toBeGreaterThan(0);
    const text = lines.join('\n');
    for (const secret of [email, TOKEN, '203.0.113.71', 'failed for']) expect(text).not.toContain(secret);
    const code = (h.notification.deliver.mock.calls[0]![0] as { code: string }).code;
    expect(text).not.toContain(code);
  });
});
