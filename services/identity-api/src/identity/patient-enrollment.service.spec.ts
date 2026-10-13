jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));
// Counted argon2: a password hashes to PASSWORD_HASH, random bytes (the replay
// placeholder) to PLACEHOLDER_HASH. Both have the form activation requires.
const PASSWORD_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${'c'.repeat(22)}$${'d'.repeat(43)}`;
const PLACEHOLDER_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${'e'.repeat(22)}$${'f'.repeat(43)}`;
jest.mock('argon2', () => ({ argon2id: 2, hash: jest.fn() }));

import * as argon2 from 'argon2';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import type { GoogleAuthenticationService } from '../auth/google-authentication.service';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { PatientEnrollmentService } from './patient-enrollment.service';
import { QoreIdPublicPatientIdentityProvider, type PublicPatientIdentityProvider } from './patient-enrollment.provider';
import type { QoreIdVerificationAdapter } from './qoreid-verification.adapter';
import type { NinIdentifierProtector } from './nin-identifier-protector';
import type { HidCodeGenerator } from './hid-code-generator.service';
import { createContactLookupHmac } from './contact-lookup';

const originalEnvironment = { ...process.env };
const nin = '12345678901';
const requestKey = '3f6339b5-f06f-474a-9976-105bd99c87db';
const correlationId = 'patient-enrollment-test';
const identity = {
  nin, firstName: 'Amina', lastName: 'Okafor', dateOfBirth: '1990-01-02',
  gender: 'female' as const, providerReference: 'qoreid-transaction-7',
  middleName: 'Fixture', phoneNumber: '08076543210', photo: 'ZmFrZQ==',
  address: '1 Fixture Street', residence: { address1: '1 Fixture Street',
    town: 'Fixture Town', lga: 'Fixture LGA', state: 'Fixture State' },
};

type RecordedQuery = { sql: string; values: readonly unknown[] };
/** `auth.otp_rate_limits` rows by `scope:bucket`; fixtures given one map share the table. */
type OtpRateRow = { request_count: number; window_started_at: Date; blocked_until: Date | null };

function fixture(otpRates = new Map<string, OtpRateRow>(),
  identityProvider?: PublicPatientIdentityProvider) {
  let enrollment: Record<string, unknown> | undefined;
  let activationFailure: unknown;
  const challenges: Record<string, unknown>[] = [];
  let bound = false;
  let contactBound = false;
  let ready = true;
  let rateCount = 0;
  const queries: RecordedQuery[] = [];
  const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes('public_patient_nin_already_bound')) return { rows: [{ bound }] };
    if (sql.includes('public_patient_enrollment_ready')) return { rows: [{ ready }] };
    if (sql.includes('public_patient_contact_already_bound')) return { rows: [{ bound: contactBound }] };
    if (sql.includes('from identity.public_patient_enrollment_rates')) return { rows: rateCount
      ? [{ request_count: rateCount, window_started_at: new Date() }] : [] };
    // The shared keyed windows of rate-limit.ts, as its statements read and write them.
    if (sql.includes('coalesce(blocked_until > clock_timestamp(), false)')) {
      const row = otpRates.get(`${values[0]}:${values[1]}`);
      return { rows: row ? [{ blocked: row.blocked_until !== null && row.blocked_until > new Date() }] : [] };
    }
    if (sql.includes('from auth.otp_rate_limits') && sql.includes('for update')) {
      const row = otpRates.get(`${values[0]}:${values[1]}`);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (sql.includes('insert into auth.otp_rate_limits')) {
      const key = `${values[0]}:${values[1]}`;
      const row = otpRates.get(key);
      otpRates.set(key, row ? { request_count: Number(values[3]),
        window_started_at: values[2] ? new Date() : row.window_started_at,
        blocked_until: values[4] ? new Date(Date.now() + Number(values[5]) * 1000) : null }
        : { request_count: 1, window_started_at: new Date(), blocked_until: null });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('from identity.public_patient_enrollments where nin_lookup_hmac')) {
      return { rows: enrollment && values[0] === enrollment.nin_lookup_hmac ? [enrollment] : [] };
    }
    if (sql.includes('from identity.public_patient_enrollments where request_hmac')) {
      return { rows: enrollment && values[0] === enrollment.request_hmac ? [enrollment] : [] };
    }
    if (sql.includes('from identity.public_patient_enrollments where id=$1')) {
      return { rows: enrollment && values[0] === enrollment.id ? [enrollment] : [] };
    }
    if (sql.includes('insert into identity.public_patient_enrollments')) {
      if (enrollment) throw Object.assign(new Error('duplicate enrollment'), { code: '23505' });
      enrollment = {
        id: values[0], nin_lookup_hmac: values[1], nin_last4: values[2],
        nin_ciphertext: values[3], profile_ciphertext: values[4], profile_sha256: values[5],
        provider_reference: values[7], request_hmac: values[8], token_hmac: values[9],
        state: 'verify_contact', expires_at: new Date(Date.now() + 86_400_000),
        contact_channel: null, contact_hmac: null, contact_lookup_hmac: null, contact_ciphertext: null,
        contact_verified_at: null,
      };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('from identity.public_patient_enrollment_otps where id=$1')) {
      const challenge = challenges.find((candidate) => candidate.id === values[0]
        && !candidate.consumed_at && !candidate.invalidated_at);
      return { rows: challenge ? [challenge] : [] };
    }
    if (sql.includes('from identity.public_patient_enrollment_otps where enrollment_id=$1')) {
      const challenge = [...challenges].reverse().find((candidate) => !candidate.consumed_at
        && !candidate.invalidated_at);
      return { rows: challenge ? [challenge] : [] };
    }
    if (sql.includes('update identity.public_patient_enrollments set contact_channel=')) {
      Object.assign(enrollment!, { contact_channel: values[1], contact_hmac: values[2],
        contact_lookup_hmac: values[3], contact_ciphertext: values[4] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('insert into identity.public_patient_enrollment_otps')) {
      challenges.push({ id: values[0], recipient_hmac: values[2], channel: values[3],
        verifier_hmac: values[4], expires_at: new Date(Date.now() + 300_000),
        created_at: new Date(Date.now() - 61_000), failed_attempts: 0,
        max_attempts: 5, delivery_outcome: 'unknown' });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('set delivery_outcome=$2')) {
      const challenge = challenges.find((candidate) => candidate.id === values[0]);
      Object.assign(challenge!, { delivery_outcome: values[1],
        ...(values[1] === 'definitive_failure' ? { invalidated_at: new Date() } : {}) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('set invalidated_at=clock_timestamp()')) {
      const challenge = challenges.find((candidate) => candidate.id === values[0]);
      Object.assign(challenge!, { invalidated_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('set failed_attempts=failed_attempts+1')) {
      const challenge = challenges.find((candidate) => candidate.id === values[0])!;
      challenge!.failed_attempts = Number(challenge!.failed_attempts) + 1;
      if (Number(challenge!.failed_attempts) >= Number(challenge!.max_attempts)) {
        challenge!.invalidated_at = new Date();
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('set verified_at=clock_timestamp()')) {
      const challenge = challenges.find((candidate) => candidate.id === values[0])!;
      challenge!.consumed_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("set state='set_password'")) {
      Object.assign(enrollment!, { state: 'set_password', contact_verified_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('select hid_code from identity.patients')) {
      return { rows: enrollment?.state === 'active' ? [{ hid_code: 'HID-TEST-00000001' }] : [] };
    }
    // A contact proof too old for activation sends the enrollment back to the contact step.
    if (sql.includes("set state='verify_contact'") && sql.includes("state='set_password' and contact_verified_at")) {
      if (enrollment?.state !== 'set_password') return { rows: [], rowCount: 0 };
      Object.assign(enrollment, { state: 'verify_contact', contact_channel: null, contact_hmac: null,
        contact_lookup_hmac: null, contact_ciphertext: null, contact_verified_at: null,
        verified_challenge_id: null });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('identity.activate_public_patient_enrollment')) {
      if (activationFailure) throw activationFailure;
      // An active enrollment replays: the stored HID, the password ignored (0058).
      if (enrollment?.state === 'active') return { rows: [{ patient_id: 'patient-7',
        account_id: 'account-7', hid_code: 'HID-TEST-00000001', replayed: true }] };
      return { rows: [{ patient_id: 'patient-7', account_id: 'account-7',
        hid_code: values[4], replayed: false }] };
    }
    return { rows: [], rowCount: 0 };
  }) } as unknown as PoolClient;
  const database = { withSystemTransaction: jest.fn(async (_correlation: string,
    work: (client: PoolClient) => Promise<unknown>) => work(client)) } as unknown as DatabaseService;
  const provider = { assertAvailable: jest.fn().mockResolvedValue(undefined),
    verifyNin: jest.fn().mockResolvedValue(identity) };
  const notification = { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'test_sms' }) };
  const protector = { lookup: jest.fn().mockReturnValue('a'.repeat(64)) };
  const hidCodes = { generate: jest.fn().mockReturnValue('HID-TEST-00000001') };
  const google = { bindPendingInTransaction: jest.fn().mockResolvedValue(undefined),
    consumePendingInTransaction: jest.fn().mockResolvedValue(undefined) };
  const service = new PatientEnrollmentService(database, protector as unknown as NinIdentifierProtector,
    identityProvider ?? provider as PublicPatientIdentityProvider, notification as unknown as NotificationOtpClient,
    hidCodes as unknown as HidCodeGenerator, google as unknown as GoogleAuthenticationService);
  return { service, client, queries, provider, notification, protector, google, otpRates,
    get enrollment() { return enrollment; }, get challenge() { return challenges.at(-1); },
    challenges,
    set bound(value: boolean) { bound = value; },
    set contactBound(value: boolean) { contactBound = value; },
    set ready(value: boolean) { ready = value; },
    set rateCount(value: number) { rateCount = value; },
    set activationFailure(value: unknown) { activationFailure = value; } };
}

function passwordHash(): jest.Mock { return argon2.hash as unknown as jest.Mock; }

/** An enrollment whose contact is verified, ready for its password. */
async function verifiedEnrollment(f: ReturnType<typeof fixture>) {
  const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
  const contact = await f.service.startContact(started.cookie, 'email', 'patient@example.test',
    '203.0.113.10', correlationId);
  const deliveredCode = f.notification.deliver.mock.calls[0]?.[0].code as string;
  await f.service.verifyContact(started.cookie, contact.challengeId, deliveredCode, correlationId);
  return started.cookie;
}

const rateLookups = (queries: RecordedQuery[]) => queries
  .filter(({ sql }) => sql.includes('from identity.public_patient_enrollment_rates'))
  .map(({ values }) => ({ scope: values[0], bucket: values[1] }));

describe('PatientEnrollmentService', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      NIN_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 1).toString('base64'),
      NIN_ENCRYPTION_KEY_B64: Buffer.alloc(32, 2).toString('base64'),
      CONTACT_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 4).toString('base64'),
      OTP_HMAC_KEY_B64: Buffer.alloc(32, 3).toString('base64'),
    });
    resetEnvironmentForTests();
    passwordHash().mockReset();
    passwordHash().mockImplementation(async (value: unknown) =>
      Buffer.isBuffer(value) ? PLACEHOLDER_HASH : PASSWORD_HASH);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
    jest.restoreAllMocks();
  });

  it('starts with NIN alone and stores opaque encrypted evidence', async () => {
    const f = fixture();
    const result = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);

    expect(f.provider.verifyNin).toHaveBeenCalledWith(nin,
      { correlationId, networkDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(result.progress.stage).toBe('verify_contact');
    expect(result.cookie).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const insert = f.queries.find(({ sql }) => sql.includes('insert into identity.public_patient_enrollments'))!;
    expect(insert.values[2]).toBe('8901');
    expect(insert.values[3]).toBeInstanceOf(Buffer);
    expect(insert.values[4]).toBeInstanceOf(Buffer);
    expect(JSON.stringify(f.queries.map(({ values }) => values.map((value) => Buffer.isBuffer(value)
      ? value.toString('hex') : value)))).not.toContain(nin);
    expect((insert.values[4] as Buffer).toString('utf8')).not.toContain('Amina');
  });

  it('replays the same idempotency key without another provider call and rejects a second key', async () => {
    const f = fixture();
    const first = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
    const replay = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
    expect(replay.cookie).toBe(first.cookie);
    expect(f.provider.verifyNin).toHaveBeenCalledTimes(1);
    await expect(f.service.start(nin, '49ebcc73-3aa3-47aa-b1e4-f8944ab6eab0',
      '203.0.113.10', correlationId)).rejects.toMatchObject({ code: 'NIN_ALREADY_REGISTERED' });
    expect(f.provider.verifyNin).toHaveBeenCalledTimes(1);
  });

  it('settles simultaneous starts for the same NIN through the database uniqueness boundary', async () => {
    const f = fixture();
    let releaseVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
    f.provider.verifyNin.mockImplementation(async () => {
      if (f.provider.verifyNin.mock.calls.length === 2) releaseVerification();
      await verificationGate;
      return identity;
    });
    const secondKey = '49ebcc73-3aa3-47aa-b1e4-f8944ab6eab0';
    const attempts = await Promise.allSettled([
      f.service.start(nin, requestKey, '203.0.113.10', correlationId),
      f.service.start(nin, secondKey, '203.0.113.11', correlationId),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({
        code: 'NIN_ALREADY_REGISTERED',
      }) }),
    ]);
    expect(f.provider.verifyNin).toHaveBeenCalledTimes(2);
    expect(f.queries.filter(({ sql }) => sql.includes('insert into identity.public_patient_enrollments')))
      .toHaveLength(2);
  });

  it('rejects a retry key reused with a different NIN before provider verification', async () => {
    const f = fixture();
    f.protector.lookup.mockImplementation((value: string) => value === nin ? 'a'.repeat(64) : 'b'.repeat(64));
    await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
    await expect(f.service.start('98765432109', requestKey, '203.0.113.10', correlationId))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(f.provider.verifyNin).toHaveBeenCalledTimes(1);
  });

  it('with the enrollment gate open, rejects an already bound NIN before contacting the provider', async () => {
    const f = fixture();
    f.bound = true;
    await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
      .rejects.toMatchObject({ code: 'NIN_ALREADY_REGISTERED' });
    // The gate is checked first and was open; the registry lookup is never made.
    expect(f.provider.assertAvailable).toHaveBeenCalledTimes(1);
    expect(f.provider.assertAvailable.mock.invocationCallOrder[0])
      .toBeLessThan((f.client.query as unknown as jest.Mock).mock.invocationCallOrder[0] ?? 0);
    expect(f.provider.verifyNin).not.toHaveBeenCalled();
  });

  it('blocks a new identity before QoreID when cross-cohort reconciliation is unsealed', async () => {
    const f = fixture();
    f.ready = false;
    await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
      .rejects.toMatchObject({ code: 'ENROLLMENT_RECONCILIATION_REQUIRED', status: 503 });
    expect(f.provider.verifyNin).not.toHaveBeenCalled();
  });

  it('rejects an existing patient contact before delivering an OTP', async () => {
    const f = fixture();
    const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
    f.contactBound = true;
    await expect(f.service.startContact(started.cookie, 'phone', '08012345678',
      '203.0.113.10', correlationId)).rejects.toMatchObject({ code: 'CONTACT_ALREADY_REGISTERED' });
    expect(f.notification.deliver).not.toHaveBeenCalled();
  });

  it('rate limits before provider verification and rejects invalid cookies before charging contact quota', async () => {
    const f = fixture();
    f.rateCount = 5;
    await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
      .rejects.toMatchObject({ code: 'ENROLLMENT_RATE_LIMITED' });
    expect(f.provider.verifyNin).not.toHaveBeenCalled();
    const rateStatements = f.queries.filter(({ sql }) => sql.includes('public_patient_enrollment_rates'));
    expect(rateStatements.length).toBeGreaterThan(0);

    f.queries.length = 0;
    await expect(f.service.startContact('invalid-cookie', 'email', 'patient@example.test',
      '203.0.113.10', correlationId)).rejects.toMatchObject({ code: 'ENROLLMENT_NOT_FOUND' });
    expect(f.queries.some(({ sql }) => sql.includes('public_patient_enrollment_rates'))).toBe(false);
    expect(f.notification.deliver).not.toHaveBeenCalled();
  });

  it('rejects mismatched or incomplete authoritative identity', async () => {
    const f = fixture();
    f.provider.verifyNin.mockResolvedValue({ ...identity, nin: '99999999999' });
    await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
      .rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
    expect(f.queries.some(({ sql }) => sql.includes('insert into identity.public_patient_enrollments'))).toBe(false);
    f.provider.verifyNin.mockResolvedValue({ ...identity, firstName: undefined });
    await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
      .rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
    f.provider.verifyNin.mockResolvedValue({ ...identity, photo: 'malformed photo' });
    await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
      .rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
    f.provider.verifyNin.mockResolvedValue({ ...identity, residence: { ...identity.residence,
      town: 'bad\nlocation' } });
    await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
      .rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
    f.provider.verifyNin.mockResolvedValue({ ...identity, address: 'different address' });
    await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
      .rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
  });

  it.each([
    [504, 'QOREID_TIMEOUT'],
    [429, 'QOREID_RATE_LIMITED'],
    [503, 'QOREID_PROVIDER_UNAVAILABLE'],
    [503, 'QOREID_AUTHENTICATION_FAILED'],
    [429, 'VERIFICATION_QUOTA_EXCEEDED'],
  ])('never creates pending identity when QoreID fails with %s %s', async (status, code) => {
    const f = fixture();
    f.provider.verifyNin.mockRejectedValue(new DomainProblem(status, code, 'External verification unavailable'));
    await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
      .rejects.toMatchObject({ status, code });
    expect(f.queries.some(({ sql }) => sql.includes('insert into identity.public_patient_enrollments'))).toBe(false);
  });

  it('binds an SMS challenge to contact, counts a wrong code, then activates through the database command', async () => {
    const f = fixture();
    const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
    const contact = await f.service.startContact(started.cookie, 'phone', '08012345678',
      '203.0.113.10', correlationId);
    expect(f.notification.deliver).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'sms', recipient: '+2348012345678', purpose: 'SIGNUP_VERIFY',
      challengeId: contact.challengeId,
    }));
    const deliveredCode = f.notification.deliver.mock.calls[0]?.[0].code as string;
    const wrongCode = deliveredCode === '000000' ? '000001' : '000000';
    await expect(f.service.verifyContact(started.cookie, contact.challengeId, wrongCode, correlationId))
      .rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect(f.challenge?.failed_attempts).toBe(1);
    await expect(f.service.verifyContact(started.cookie, contact.challengeId, deliveredCode, correlationId))
      .resolves.toEqual({ stage: 'set_password' });
    await expect(f.service.activate(started.cookie, 'a-strong-test-password', correlationId))
      .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001' });
    const activation = f.queries.find(({ sql }) => sql.includes('identity.activate_public_patient_enrollment'))!;
    expect(activation.values[0]).toBe(f.enrollment?.id);
    expect(activation.values[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(activation.values[3]).toBe('+2348012345678');
    expect(JSON.parse(activation.values[2] as string)).toMatchObject({
      phoneNumber: '08076543210', middleName: 'Fixture',
      residence: { address1: '1 Fixture Street', town: 'Fixture Town',
        lga: 'Fixture LGA', state: 'Fixture State' },
    });
    expect(activation.values[5]).toMatch(/^\$argon2id\$/);
    expect(activation.values[6]).toBe(createContactLookupHmac('phone', '+2348012345678'));
    expect(f.enrollment?.contact_lookup_hmac).toBe(activation.values[6]);
    expect(activation.values).not.toContain('a-strong-test-password');
  });

  it('binds Google pending proof on start and retry, then consumes it inside the account activation transaction', async () => {
    const f = fixture();
    const googleCookie = '30000000-0000-4000-8000-000000000001.' + 'A'.repeat(43);
    const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId,
      googleCookie);
    expect(f.google.bindPendingInTransaction).toHaveBeenCalledWith(f.client, googleCookie,
      f.enrollment?.id, f.enrollment?.token_hmac);
    await f.service.start(nin, requestKey, '203.0.113.10', correlationId, googleCookie);
    expect(f.google.bindPendingInTransaction).toHaveBeenCalledTimes(2);
    expect(f.provider.verifyNin).toHaveBeenCalledTimes(1);

    const contact = await f.service.startContact(started.cookie, 'email',
      'google-patient@example.test', '203.0.113.10', correlationId);
    const deliveredCode = f.notification.deliver.mock.calls[0]?.[0].code as string;
    await f.service.verifyContact(started.cookie, contact.challengeId, deliveredCode, correlationId);
    await f.service.activate(started.cookie, 'a-strong-test-password', correlationId, googleCookie);
    expect(f.google.consumePendingInTransaction).toHaveBeenCalledWith(f.client,
      googleCookie, f.enrollment?.id, 'account-7');
    expect(f.client.query).toHaveBeenCalledWith(
      'select * from identity.activate_public_patient_enrollment($1,$2,$3,$4,$5,$6,$7)',
      expect.any(Array));
  });

  it('rebinds fresh Google proof to an existing preactivation enrollment', async () => {
    const f = fixture();
    const firstCookie = '30000000-0000-4000-8000-000000000001.' + 'A'.repeat(43);
    const freshCookie = '30000000-0000-4000-8000-000000000002.' + 'B'.repeat(43);
    const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId,
      firstCookie);

    await expect(f.service.bindGoogle(started.cookie, freshCookie, correlationId))
      .resolves.toEqual({ bound: true });
    expect(f.google.bindPendingInTransaction).toHaveBeenLastCalledWith(f.client, freshCookie,
      f.enrollment?.id, f.enrollment?.token_hmac);
    await expect(f.service.bindGoogle(started.cookie, undefined, correlationId))
      .rejects.toMatchObject({ code: 'GOOGLE_ONBOARDING_NOT_FOUND' });
  });

  it('does not complete activation when a bound pending Google capability cannot be consumed', async () => {
    const f = fixture();
    const googleCookie = '30000000-0000-4000-8000-000000000001.' + 'A'.repeat(43);
    const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId,
      googleCookie);
    const contact = await f.service.startContact(started.cookie, 'email',
      'google-patient@example.test', '203.0.113.10', correlationId);
    const deliveredCode = f.notification.deliver.mock.calls[0]?.[0].code as string;
    await f.service.verifyContact(started.cookie, contact.challengeId, deliveredCode, correlationId);
    f.google.consumePendingInTransaction.mockRejectedValueOnce(new DomainProblem(404,
      'GOOGLE_ONBOARDING_NOT_FOUND', 'No pending Google onboarding was found'));

    await expect(f.service.activate(started.cookie, 'a-strong-test-password', correlationId,
      googleCookie)).rejects.toMatchObject({ code: 'GOOGLE_ONBOARDING_NOT_FOUND' });
    expect(f.google.consumePendingInTransaction).toHaveBeenCalledWith(f.client,
      googleCookie, f.enrollment?.id, 'account-7');
  });

  it('rejects an expired code without advancing the enrollment', async () => {
    const f = fixture();
    const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
    const contact = await f.service.startContact(started.cookie, 'phone', '08012345678',
      '203.0.113.10', correlationId);
    const deliveredCode = f.notification.deliver.mock.calls[0]?.[0].code as string;
    f.challenge!.expires_at = new Date(Date.now() - 1000);

    await expect(f.service.verifyContact(started.cookie, contact.challengeId, deliveredCode, correlationId))
      .rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect(f.enrollment?.state).toBe('verify_contact');
    expect(f.challenge?.consumed_at).toBeUndefined();
    expect(f.queries.some(({ sql }) => sql.includes("set state='set_password'"))).toBe(false);
  });

  it('invalidates a challenge after excessive failures, even if the correct code is supplied later', async () => {
    const f = fixture();
    const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
    const contact = await f.service.startContact(started.cookie, 'email', 'Patient@Example.test',
      '203.0.113.10', correlationId);
    const deliveredCode = f.notification.deliver.mock.calls[0]?.[0].code as string;
    const wrongCode = deliveredCode === '000000' ? '000001' : '000000';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(f.service.verifyContact(started.cookie, contact.challengeId, wrongCode, correlationId))
        .rejects.toMatchObject({ code: 'OTP_INVALID' });
    }
    expect(f.challenge?.failed_attempts).toBe(5);
    expect(f.challenge?.invalidated_at).toBeInstanceOf(Date);
    await expect(f.service.verifyContact(started.cookie, contact.challengeId, deliveredCode, correlationId))
      .rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect(f.enrollment?.state).toBe('verify_contact');
    expect(f.challenge?.consumed_at).toBeUndefined();
  });

  describe('contact code failure budget per recipient (ENR-6)', () => {
    type Fixture = ReturnType<typeof fixture>;
    const wrong = (code: string) => (code === '000000' ? '000001' : '000000');
    const lastCode = (f: Fixture) => f.notification.deliver.mock.calls.at(-1)?.[0].code as string;
    const refusesCode = (f: Fixture, cookie: string, challengeId: string, code: string) =>
      expect(f.service.verifyContact(cookie, challengeId, code, correlationId))
        .rejects.toMatchObject({ status: 422, code: 'OTP_INVALID' });
    const budgetStatements = (queries: RecordedQuery[]) => queries.filter(({ sql, values }) =>
      sql.includes('auth.otp_rate_limits') || String(values[0]).startsWith('otp-rate:'));

    it('refuses even the correct code once five wrong codes across its challenges spend the recipient budget', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const first = await f.service.startContact(started.cookie, 'email', 'patient@example.test',
        '203.0.113.10', correlationId);
      const firstCode = lastCode(f);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await refusesCode(f, started.cookie, first.challengeId, wrong(firstCode));
      }
      // A resend opens a challenge with five attempts of its own; the recipient's budget carries over.
      const second = await f.service.startContact(started.cookie, 'email', 'patient@example.test',
        '198.51.100.7', correlationId);
      const secondCode = lastCode(f);
      expect(f.challenges[0]?.invalidated_at).toBeInstanceOf(Date);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await refusesCode(f, started.cookie, second.challengeId, wrong(secondCode));
      }
      expect(f.challenge?.failed_attempts).toBe(2);

      await refusesCode(f, started.cookie, second.challengeId, secondCode);
      expect(f.enrollment?.state).toBe('verify_contact');
      // Refused before the comparison: the challenge stays open and the attempt is not counted.
      expect(f.challenge?.failed_attempts).toBe(2);
      expect(f.challenge?.consumed_at).toBeUndefined();
      expect(f.challenge?.invalidated_at).toBeUndefined();
      expect(f.queries.some(({ sql }) => sql.includes("set state='set_password'"))).toBe(false);

      // The block lasts one window; once it has passed, the same challenge's code verifies.
      for (const row of f.otpRates.values()) row.blocked_until = new Date(Date.now() - 1000);
      await expect(f.service.verifyContact(started.cookie, second.challengeId, secondCode, correlationId))
        .resolves.toEqual({ stage: 'set_password' });
    });

    it('keys one budget on the recipient alone, across enrollments and networks, never on the client IP', async () => {
      const otpRates = new Map<string, OtpRateRow>();
      const [a, b, other] = [fixture(otpRates), fixture(otpRates), fixture(otpRates)];
      const startedA = await a.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const contactA = await a.service.startContact(startedA.cookie, 'email', 'patient@example.test',
        '203.0.113.10', correlationId);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await refusesCode(a, startedA.cookie, contactA.challengeId, wrong(lastCode(a)));
      }
      // Another enrollment, from another network, with the same contact written differently.
      const startedB = await b.service.start(nin, requestKey, '198.51.100.7', correlationId);
      const contactB = await b.service.startContact(startedB.cookie, 'email', '  Patient@Example.TEST ',
        '198.51.100.7', correlationId);
      expect(b.challenge?.recipient_hmac).toBe(a.challenge?.recipient_hmac);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await refusesCode(b, startedB.cookie, contactB.challengeId, wrong(lastCode(b)));
      }
      await refusesCode(b, startedB.cookie, contactB.challengeId, lastCode(b));
      expect(b.enrollment?.state).toBe('verify_contact');

      // Another recipient keeps its own budget.
      const startedOther = await other.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const contactOther = await other.service.startContact(startedOther.cookie, 'email',
        'someone-else@example.test', '203.0.113.10', correlationId);
      await expect(other.service.verifyContact(startedOther.cookie, contactOther.challengeId,
        lastCode(other), correlationId)).resolves.toEqual({ stage: 'set_password' });

      const rows = [...a.queries, ...b.queries].filter(({ sql }) => sql.includes('auth.otp_rate_limits'));
      expect(new Set(rows.map(({ values }) => `${values[0]}:${values[1]}`)).size).toBe(1);
      expect(rows[0]?.values[0]).toBe('recipient');
      const bucket = rows[0]?.values[1] as string;
      expect(bucket).toMatch(/^[0-9a-f]{64}$/);
      // Its own HMAC domain: not the stored recipient HMAC, which also keys the contact start bucket.
      expect(bucket).not.toBe(a.challenge?.recipient_hmac);
      expect([...otpRates.keys()]).toEqual([`recipient:${bucket}`]);
    });

    it('sends no new code to a recipient whose budget is spent, and leaves other recipients alone', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const contact = await f.service.startContact(started.cookie, 'email', 'patient@example.test',
        '203.0.113.10', correlationId);
      const code = lastCode(f);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await refusesCode(f, started.cookie, contact.challengeId, wrong(code));
      }
      expect(f.notification.deliver).toHaveBeenCalledTimes(1);

      await expect(f.service.startContact(started.cookie, 'email', 'Patient@Example.test',
        '198.51.100.7', correlationId)).rejects.toMatchObject({ status: 429, code: 'ENROLLMENT_RATE_LIMITED' });
      expect(f.notification.deliver).toHaveBeenCalledTimes(1);
      expect(f.challenges).toHaveLength(1);
      await expect(f.service.startContact(started.cookie, 'phone', '08012345678',
        '203.0.113.10', correlationId)).resolves.toMatchObject({ challengeId: expect.any(String) });
      expect(f.notification.deliver).toHaveBeenCalledTimes(2);
    });

    it('touches no budget for an unknown or expired challenge', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const contact = await f.service.startContact(started.cookie, 'email', 'patient@example.test',
        '203.0.113.10', correlationId);
      const code = lastCode(f);
      f.queries.length = 0;
      await refusesCode(f, started.cookie, '7d5e8a52-4c0e-4b5f-9a43-2f8f6f1f3c11', wrong(code));
      f.challenge!.expires_at = new Date(Date.now() - 1000);
      await refusesCode(f, started.cookie, contact.challengeId, wrong(code));
      expect(budgetStatements(f.queries)).toEqual([]);
      expect(f.otpRates.size).toBe(0);
    });

    it('reads, compares and counts under the bucket lock taken after the challenge lock, writing no other challenge', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const contact = await f.service.startContact(started.cookie, 'email', 'patient@example.test',
        '203.0.113.10', correlationId);
      const code = lastCode(f);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await refusesCode(f, started.cookie, contact.challengeId, wrong(code));
      }
      f.queries.length = 0;
      // The fifth wrong code spends the budget.
      await refusesCode(f, started.cookie, contact.challengeId, wrong(code));

      const position = (predicate: (query: RecordedQuery) => boolean) => f.queries.findIndex(predicate);
      const challengeLock = position(({ sql }) => sql.includes('from identity.public_patient_enrollment_otps where id=$1')
        && sql.includes('for update'));
      const bucketLocks = f.queries.filter(({ sql, values }) => sql.includes('pg_advisory_xact_lock')
        && String(values[0]).startsWith('otp-rate:'));
      const firstBucketLock = bucketLocks[0] ? f.queries.indexOf(bucketLocks[0]) : -1;
      const blockedRead = position(({ sql }) => sql.includes('coalesce(blocked_until > clock_timestamp(), false)'));
      const counted = position(({ sql }) => sql.includes('insert into auth.otp_rate_limits'));
      expect(challengeLock).toBeGreaterThanOrEqual(0);
      expect(firstBucketLock).toBeGreaterThan(challengeLock);
      expect(blockedRead).toBeGreaterThan(firstBucketLock);
      expect(counted).toBeGreaterThan(blockedRead);
      // One lock key throughout: the one consumeRateLimit takes for this bucket.
      const bucket = f.queries[counted]?.values[1];
      expect(new Set(bucketLocks.map(({ values }) => values[0]))).toEqual(new Set([`otp-rate:recipient:${bucket}`]));
      // Only this challenge is written; no other challenge is invalidated under these locks.
      expect(f.queries.filter(({ sql }) => sql.includes('update identity.public_patient_enrollment_otps'))
        .map(({ values }) => values[0])).toEqual([contact.challengeId]);
      expect(f.otpRates.get(`recipient:${bucket}`)?.blocked_until).toBeInstanceOf(Date);
    });

    it('applies a configured budget and window', async () => {
      Object.assign(process.env, { PATIENT_ENROLLMENT_CONTACT_FAILURE_MAX: '3',
        PATIENT_ENROLLMENT_CONTACT_FAILURE_WINDOW_SECONDS: '1800' });
      resetEnvironmentForTests();
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const contact = await f.service.startContact(started.cookie, 'email', 'patient@example.test',
        '203.0.113.10', correlationId);
      const code = lastCode(f);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await refusesCode(f, started.cookie, contact.challengeId, wrong(code));
      }
      await refusesCode(f, started.cookie, contact.challengeId, code);
      const [row] = [...f.otpRates.values()];
      expect(row?.request_count).toBe(3);
      const remaining = (row?.blocked_until?.getTime() ?? 0) - Date.now();
      expect(remaining).toBeGreaterThan(1_790_000);
      expect(remaining).toBeLessThanOrEqual(1_800_000);
    });
  });

  it('invalidates the old challenge when the applicant changes the selected account contact', async () => {
    const f = fixture();
    const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
    const phone = await f.service.startContact(started.cookie, 'phone', '08012345678',
      '203.0.113.10', correlationId);
    const phoneCode = f.notification.deliver.mock.calls[0]?.[0].code as string;
    const email = await f.service.startContact(started.cookie, 'email', 'Patient@Example.test',
      '203.0.113.10', correlationId);
    const emailCode = f.notification.deliver.mock.calls[1]?.[0].code as string;

    expect(f.challenges[0]?.invalidated_at).toBeInstanceOf(Date);
    expect(f.notification.deliver).toHaveBeenLastCalledWith(expect.objectContaining({
      channel: 'email', recipient: 'patient@example.test', challengeId: email.challengeId,
    }));
    await expect(f.service.verifyContact(started.cookie, phone.challengeId, phoneCode, correlationId))
      .rejects.toMatchObject({ code: 'OTP_INVALID' });
    await expect(f.service.verifyContact(started.cookie, email.challengeId, emailCode, correlationId))
      .resolves.toEqual({ stage: 'set_password' });
    expect(f.enrollment?.contact_channel).toBe('email');
    await expect(f.service.activate(started.cookie, 'a-strong-test-password', correlationId))
      .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001' });
    const activation = f.queries.find(({ sql }) => sql.includes('identity.activate_public_patient_enrollment'))!;
    expect(activation.values[3]).toBe('patient@example.test');
  });

  it('does not accept replay of a consumed contact challenge', async () => {
    const f = fixture();
    const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
    const contact = await f.service.startContact(started.cookie, 'email', 'patient@example.test',
      '203.0.113.10', correlationId);
    const deliveredCode = f.notification.deliver.mock.calls[0]?.[0].code as string;

    await expect(f.service.verifyContact(started.cookie, contact.challengeId, deliveredCode, correlationId))
      .resolves.toEqual({ stage: 'set_password' });
    await expect(f.service.verifyContact(started.cookie, contact.challengeId, deliveredCode, correlationId))
      .rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect(f.challenge?.consumed_at).toBeInstanceOf(Date);
    expect(f.queries.filter(({ sql }) => sql.includes("set state='set_password'"))).toHaveLength(1);
  });

  describe('activation cost and budget (ENR-5)', () => {
    const activation = (queries: RecordedQuery[]) => queries
      .filter(({ sql }) => sql.includes('identity.activate_public_patient_enrollment'));

    it('hashes the password once for a first activation', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      const before = passwordHash().mock.calls.length;
      await expect(f.service.activate(cookie, 'a-strong-test-password', correlationId))
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001' });
      expect(passwordHash().mock.calls.slice(before)).toEqual([['a-strong-test-password',
        { type: 2, memoryCost: 65_536, timeCost: 3, parallelism: 1 }]]);
      expect(activation(f.queries).at(-1)?.values[5]).toBe(PASSWORD_HASH);
    });

    it('replays an active enrollment without hashing the presented password', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      await f.service.activate(cookie, 'a-strong-test-password', correlationId);
      Object.assign(f.enrollment!, { state: 'active', patient_id: 'patient-7' });
      const before = passwordHash().mock.calls.length;

      await expect(f.service.activate(cookie, 'a-different-test-password', correlationId))
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001' });

      // A replay sets no credential (0058 returns the HID first), so it costs
      // no argon2id run. The command still receives a well-formed hash: one
      // computed once per process from random bytes, never stored.
      expect(passwordHash().mock.calls.slice(before)).toEqual([]);
      expect(passwordHash().mock.calls.some(([value]) => value === 'a-different-test-password')).toBe(false);
      expect(passwordHash()).toHaveBeenCalledWith(expect.any(Buffer),
        { type: 2, memoryCost: 65_536, timeCost: 3, parallelism: 1 });
      const replay = activation(f.queries).at(-1);
      expect(replay?.values[5]).toBe(PLACEHOLDER_HASH);
      expect(replay?.values).not.toContain('a-different-test-password');
    });

    it('charges each activation to the enrollment, after the cookie and stage checks', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      const contactBuckets = rateLookups(f.queries).filter(({ scope }) => scope === 'enrollment');
      expect(contactBuckets).toHaveLength(1);
      f.queries.length = 0;

      await f.service.activate(cookie, 'a-strong-test-password', correlationId);

      const charged = rateLookups(f.queries);
      expect(charged).toEqual([{ scope: 'enrollment', bucket: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
      // Its own budget: not the contact step's enrollment bucket, and not the enrollment id in clear.
      expect(charged[0]?.bucket).not.toBe(contactBuckets[0]?.bucket);
      expect(charged[0]?.bucket).not.toContain(String(f.enrollment?.id));
      const rate = f.queries.findIndex(({ sql }) => sql.includes('from identity.public_patient_enrollment_rates'));
      const command = f.queries.findIndex(({ sql }) => sql.includes('identity.activate_public_patient_enrollment'));
      expect(rate).toBeGreaterThan(-1);
      expect(rate).toBeLessThan(command);
    });

    it('refuses an activation over the budget with 429, before argon2id or the activation command', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      // OTP_RATE_MAX_REQUESTS * 3 (15) attempts per enrollment per window, as
      // the contact step's enrollment bucket allows: the fifteenth still runs.
      const budget = getEnvironment().OTP_RATE_MAX_REQUESTS * 3;
      expect(budget).toBe(15);
      f.rateCount = budget - 1;
      await expect(f.service.activate(cookie, 'a-strong-test-password', correlationId))
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001' });
      f.queries.length = 0;
      const before = passwordHash().mock.calls.length;
      // The sixteenth is refused.
      f.rateCount = budget;

      const refused = await f.service.activate(cookie, 'a-strong-test-password', correlationId)
        .then(() => undefined, (error: unknown) => error);

      expect(refused).toBeInstanceOf(DomainProblem);
      expect([(refused as DomainProblem).getStatus(), (refused as DomainProblem).code])
        .toEqual([429, 'ENROLLMENT_RATE_LIMITED']);
      expect(passwordHash().mock.calls.length).toBe(before);
      expect(activation(f.queries)).toHaveLength(0);
      expect(rateLookups(f.queries)).toEqual([{ scope: 'enrollment', bucket: expect.any(String) }]);
    });

    it('charges an attempt that fails after the stage check, a transient 503 included', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      f.queries.length = 0;
      const before = passwordHash().mock.calls.length;
      f.google.consumePendingInTransaction.mockRejectedValueOnce(
        new DomainProblem(503, 'GOOGLE_SIGN_IN_UNAVAILABLE', 'Google sign-in is unavailable'));

      await expect(f.service.activate(cookie, 'a-strong-test-password', correlationId))
        .rejects.toMatchObject({ code: 'GOOGLE_SIGN_IN_UNAVAILABLE' });

      // Every attempt past the cookie and stage checks counts, whatever its
      // outcome: this one ran argon2id and the activation command.
      expect(rateLookups(f.queries)).toEqual([{ scope: 'enrollment', bucket: expect.any(String) }]);
      expect(passwordHash().mock.calls.length).toBe(before + 1);
      expect(activation(f.queries)).toHaveLength(1);
    });

    it('refuses a forged cookie or an unverified contact before charging the budget', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      f.queries.length = 0;
      const forged = started.cookie.replace(/.$/, (last) => (last === 'A' ? 'B' : 'A'));
      await expect(f.service.activate(forged, 'a-strong-test-password', correlationId))
        .rejects.toMatchObject({ code: 'ENROLLMENT_NOT_FOUND' });
      await expect(f.service.activate(started.cookie, 'a-strong-test-password', correlationId))
        .rejects.toMatchObject({ code: 'ENROLLMENT_STAGE_INVALID' });
      expect(rateLookups(f.queries)).toEqual([]);
      expect(passwordHash().mock.calls.some(([value]) => value === 'a-strong-test-password')).toBe(false);
    });
  });
  describe('the enrollment gate comes before any registration lookup (ENR-4)', () => {
    const credentials = { QOREID_CLIENT_ID: 'test-client', QOREID_CLIENT_SECRET: 'test-secret' };
    const open = { QOREID_ENABLED: 'true', QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'true', ...credentials };
    const ninByLookup: Record<string, string> = { [nin]: 'a'.repeat(64), '98765432109': 'b'.repeat(64),
      '11122233344': 'c'.repeat(64) };

    /** The service with the real QoreID provider; QoreID itself and the runtime pause are stubbed. */
    function gated() {
      let paused = false;
      const adapter = { verifyNinEnrollment: jest.fn(async (value: string) => ({ state: 'verified',
        providerReference: 'qoreid-transaction-7', ninEnrollmentBinding: { ...identity, nin: value,
          providerReference: undefined } })) };
      const integrations = {
        assertAvailable: jest.fn(async () => {
          if (paused) throw new DomainProblem(503, 'INTEGRATION_PAUSED', 'External verification is temporarily unavailable');
        }),
        consumePublicPatientNinQuota: jest.fn().mockResolvedValue(undefined),
      };
      const provider = new QoreIdPublicPatientIdentityProvider(adapter as unknown as QoreIdVerificationAdapter,
        integrations as unknown as IntegrationRuntimeService);
      const f = fixture(new Map(), provider);
      f.protector.lookup.mockImplementation((value: string) => ninByLookup[value] ?? 'd'.repeat(64));
      return { f, adapter, integrations, pause: () => { paused = true; } };
    }

    const closures: Array<[string, Record<string, string>, boolean, number, string]> = [
      ['QoreID is disabled', { QOREID_ENABLED: 'false', QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'false' }, false,
        503, 'QOREID_DISABLED'],
      ['NIN-only enrollment is disabled', { ...open, QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'false' }, false,
        503, 'QOREID_NIN_ONLY_DISABLED'],
      ['QoreID is paused at runtime', open, true, 503, 'INTEGRATION_PAUSED'],
    ];

    it.each(closures)('answers a bound, a pending and an unbound NIN identically while %s',
      async (_label, closed, pause, status, code) => {
        Object.assign(process.env, open); resetEnvironmentForTests();
        const { f, adapter, integrations, pause: pauseQoreId } = gated();
        // A pending enrollment for `nin`, started while the gate was open.
        const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
        expect(adapter.verifyNinEnrollment).toHaveBeenCalledTimes(1);
        Object.assign(process.env, closed); resetEnvironmentForTests();
        if (pause) pauseQoreId();
        const statementsBefore = f.queries.length;

        const refusal = async (value: string, key: string, bound: boolean) => {
          f.bound = bound;
          const error = await f.service.start(value, key, '203.0.113.10', correlationId)
            .then(() => undefined, (failure: unknown) => failure);
          expect(error).toBeInstanceOf(DomainProblem);
          return { status: (error as DomainProblem).getStatus(), code: (error as DomainProblem).code,
            body: (error as DomainProblem).getResponse() };
        };
        const pending = await refusal(nin, '49ebcc73-3aa3-47aa-b1e4-f8944ab6eab0', false);
        const bound = await refusal('98765432109', '5f0bd2a4-63c4-4f43-9f6f-0b8f7f1e2a10', true);
        const unbound = await refusal('11122233344', '6a1ce3b5-74d5-4a54-8a7a-1c9a8a2f3b21', false);

        expect(pending).toMatchObject({ status, code });
        expect(bound).toEqual(pending);
        expect(unbound).toEqual(pending);
        // Nothing was read or charged for them: no rate bucket, no binding or pending lookup.
        expect(f.queries.length).toBe(statementsBefore);
        expect(adapter.verifyNinEnrollment).toHaveBeenCalledTimes(1);
        expect(integrations.consumePublicPatientNinQuota).toHaveBeenCalledTimes(1);
        // The pending enrollment itself is untouched and still resumable through its cookie.
        await expect(f.service.current(started.cookie, correlationId))
          .resolves.toMatchObject({ stage: 'verify_contact' });
      });

    it('refuses a same-key resume while the gate is closed, and resumes once it opens again', async () => {
      Object.assign(process.env, open); resetEnvironmentForTests();
      const { f, adapter } = gated();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      Object.assign(process.env, { QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'false' }); resetEnvironmentForTests();
      await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
        .rejects.toMatchObject({ status: 503, code: 'QOREID_NIN_ONLY_DISABLED' });
      Object.assign(process.env, open); resetEnvironmentForTests();
      await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
        .resolves.toMatchObject({ cookie: started.cookie });
      expect(adapter.verifyNinEnrollment).toHaveBeenCalledTimes(1);
    });
  });

  describe('QoreID lookup quota per client network (IP-1)', () => {
    const digestFor = async (address: string) => {
      const f = fixture();
      await f.service.start(nin, requestKey, address, correlationId);
      const charge = f.provider.verifyNin.mock.calls[0]?.[1] as { networkDigest: string } | undefined;
      expect(charge?.networkDigest).toMatch(/^[0-9a-f]{64}$/);
      return { digest: charge!.networkDigest, ipBucket: rateLookups(f.queries).find(({ scope }) => scope === 'ip')?.bucket };
    };

    it('charges the lookup only on the path that calls QoreID: never on a resume, a duplicate or a refusal', async () => {
      const f = fixture();
      f.protector.lookup.mockImplementation((value: string) => value === nin ? 'a'.repeat(64) : 'b'.repeat(64));
      await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      expect(f.provider.verifyNin).toHaveBeenCalledTimes(1);
      expect(f.provider.verifyNin).toHaveBeenLastCalledWith(nin,
        { correlationId, networkDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
      // Same-key resume, another key for the pending NIN, the key reused for another NIN.
      await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      await expect(f.service.start(nin, '49ebcc73-3aa3-47aa-b1e4-f8944ab6eab0', '203.0.113.10', correlationId))
        .rejects.toMatchObject({ code: 'NIN_ALREADY_REGISTERED' });
      await expect(f.service.start('98765432109', requestKey, '203.0.113.10', correlationId))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      // A bound NIN and a rate-limited client.
      f.bound = true;
      await expect(f.service.start('98765432109', '5f0bd2a4-63c4-4f43-9f6f-0b8f7f1e2a10', '203.0.113.10',
        correlationId)).rejects.toMatchObject({ code: 'NIN_ALREADY_REGISTERED' });
      f.bound = false; f.rateCount = 5;
      await expect(f.service.start('98765432109', '5f0bd2a4-63c4-4f43-9f6f-0b8f7f1e2a10', '203.0.113.10',
        correlationId)).rejects.toMatchObject({ code: 'ENROLLMENT_RATE_LIMITED' });
      expect(f.provider.verifyNin).toHaveBeenCalledTimes(1);
    });

    it('keys an IPv6 client by its /64 and an IPv4 client by its address, in a keyed digest of its own', async () => {
      const sameSlash64 = [await digestFor('2001:db8:1:2::1'), await digestFor('2001:db8:1:2:ffff:ffff:ffff:fffe')];
      const otherSlash64 = await digestFor('2001:db8:1:3::1');
      const ipv4 = [await digestFor('203.0.113.10'), await digestFor('::ffff:203.0.113.10')];
      const otherIpv4 = await digestFor('203.0.113.11');
      expect(sameSlash64[1]!.digest).toBe(sameSlash64[0]!.digest);
      expect(otherSlash64.digest).not.toBe(sameSlash64[0]!.digest);
      expect(ipv4[1]!.digest).toBe(ipv4[0]!.digest);
      expect(otherIpv4.digest).not.toBe(ipv4[0]!.digest);
      // Not the start rate bucket's HMAC of the same address, and no address in clear.
      expect(ipv4[0]!.digest).not.toBe(ipv4[0]!.ipBucket);
      expect(ipv4[0]!.digest).not.toContain('203.0.113.10');
    });
  });

  describe('HID re-display after activation is limited to 15 minutes (ENR-3 Part B)', () => {
    async function activatedMinutesAgo(f: ReturnType<typeof fixture>, minutes: number | null) {
      const cookie = await verifiedEnrollment(f);
      await f.service.activate(cookie, 'a-strong-test-password', correlationId);
      Object.assign(f.enrollment!, { state: 'active', patient_id: 'patient-7', account_id: 'account-7',
        activated_at: minutes === null ? null : new Date(Date.now() - minutes * 60_000) });
      f.queries.length = 0;
      return cookie;
    }

    it('shows the HID through GET /current and an activation replay within 15 minutes', async () => {
      const f = fixture();
      const cookie = await activatedMinutesAgo(f, 14);
      await expect(f.service.current(cookie, correlationId))
        .resolves.toMatchObject({ stage: 'active', hidCode: 'HID-TEST-00000001' });
      await expect(f.service.activate(cookie, 'a-strong-test-password', correlationId))
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001' });
    });

    it.each([16, null])('answers 404 ENROLLMENT_NOT_FOUND, without the HID, once activation is older (activated %s minutes ago)',
      async (minutes) => {
        const f = fixture();
        const cookie = await activatedMinutesAgo(f, minutes);
        const before = passwordHash().mock.calls.length;
        for (const attempt of [
          () => f.service.current(cookie, correlationId),
          () => f.service.activate(cookie, 'a-strong-test-password', correlationId),
          () => f.service.bindGoogle(cookie, '30000000-0000-4000-8000-000000000001.' + 'A'.repeat(43), correlationId),
          () => f.service.verifyContact(cookie, '7d5e8a52-4c0e-4b5f-9a43-2f8f6f1f3c11', '123456', correlationId),
        ]) {
          const error = await attempt().then(() => undefined, (failure: unknown) => failure);
          expect(error).toMatchObject({ status: 404, code: 'ENROLLMENT_NOT_FOUND' });
          expect(JSON.stringify((error as DomainProblem).getResponse())).not.toContain('HID-TEST');
        }
        // Refused before the activation budget, argon2id, the activation command or the HID read.
        expect(rateLookups(f.queries)).toEqual([]);
        expect(passwordHash().mock.calls.length).toBe(before);
        expect(f.queries.some(({ sql }) => sql.includes('identity.activate_public_patient_enrollment'))).toBe(false);
        expect(f.queries.some(({ sql }) => sql.includes('select hid_code from identity.patients'))).toBe(false);
      });
  });

  describe('contact proof older than 30 minutes is verified again before activation (ENR-3b)', () => {
    const activation = (queries: RecordedQuery[]) => queries
      .filter(({ sql }) => sql.includes('identity.activate_public_patient_enrollment'));

    it('resets the enrollment to the contact step and answers 409 ENROLLMENT_CONTACT_REVERIFY_REQUIRED', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      f.enrollment!.contact_verified_at = new Date(Date.now() - 31 * 60_000);
      f.queries.length = 0;
      const before = passwordHash().mock.calls.length;

      const refused = await f.service.activate(cookie, 'a-strong-test-password', correlationId)
        .then(() => undefined, (failure: unknown) => failure);

      expect(refused).toBeInstanceOf(DomainProblem);
      expect([(refused as DomainProblem).getStatus(), (refused as DomainProblem).code])
        .toEqual([409, 'ENROLLMENT_CONTACT_REVERIFY_REQUIRED']);
      expect(passwordHash().mock.calls.length).toBe(before);
      expect(activation(f.queries)).toHaveLength(0);
      const reset = f.queries.filter(({ sql }) => sql.includes("set state='verify_contact'"));
      expect(reset).toHaveLength(1);
      expect(reset[0]?.sql).toContain("interval '30 minutes'");
      expect(f.enrollment).toMatchObject({ state: 'verify_contact', contact_verified_at: null,
        contact_channel: null, contact_ciphertext: null, verified_challenge_id: null });
      await expect(f.service.current(cookie, correlationId)).resolves.toMatchObject({ stage: 'verify_contact' });

      // Proving the contact again lets the same enrollment activate.
      const contact = await f.service.startContact(cookie, 'email', 'patient@example.test', '203.0.113.10',
        correlationId);
      await f.service.verifyContact(cookie, contact.challengeId,
        f.notification.deliver.mock.calls.at(-1)?.[0].code as string, correlationId);
      await expect(f.service.activate(cookie, 'a-strong-test-password', correlationId))
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001' });
    });

    it('activates a contact verified 29 minutes earlier', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      f.enrollment!.contact_verified_at = new Date(Date.now() - 29 * 60_000);
      await expect(f.service.activate(cookie, 'a-strong-test-password', correlationId))
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001' });
      expect(f.queries.some(({ sql }) => sql.includes("set state='verify_contact'"))).toBe(false);
    });

    it('resets and answers 409 when the activation command finds the proof too old', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      f.activationFailure = Object.assign(new Error('PATIENT_CONTACT_REVERIFY_REQUIRED'), { code: '23514' });
      await expect(f.service.activate(cookie, 'a-strong-test-password', correlationId))
        .rejects.toMatchObject({ status: 409, code: 'ENROLLMENT_CONTACT_REVERIFY_REQUIRED' });
      expect(f.queries.filter(({ sql }) => sql.includes("set state='verify_contact'"))).toHaveLength(1);
    });

    it('does not apply the contact age to a replay of an active enrollment within its window', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      await f.service.activate(cookie, 'a-strong-test-password', correlationId);
      Object.assign(f.enrollment!, { state: 'active', patient_id: 'patient-7',
        contact_verified_at: new Date(Date.now() - 2 * 60 * 60_000), activated_at: new Date(Date.now() - 60_000) });
      await expect(f.service.activate(cookie, 'a-strong-test-password', correlationId))
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001' });
      expect(f.enrollment?.state).toBe('active');
    });
  });
});
