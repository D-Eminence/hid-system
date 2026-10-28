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
import { emailFirstName } from '../auth/email-first-name';

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
  const challenges: Record<string, unknown>[] = [];
  let bound = false;
  let contactBound = false;
  let ready = true;
  let contactReady = true;
  let signupOutcome = 'started';
  let rateCount = 0;
  const queries: RecordedQuery[] = [];
  const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes('public_patient_nin_already_bound')) return { rows: [{ bound }] };
    if (sql.includes('public_patient_enrollment_ready')) return { rows: [{ ready }] };
    if (sql.includes('patient_contact_lookup_ready')) return { rows: [{ ready: contactReady }] };
    if (sql.includes('identity.start_public_patient_signup')) {
      if (signupOutcome !== 'started') return { rows: [{ outcome: signupOutcome }] };
      if (enrollment) throw Object.assign(new Error('duplicate enrollment'), { code: '23505' });
      enrollment = {
        id: values[0], nin_lookup_hmac: null, nin_last4: null, nin_ciphertext: null,
        request_hmac: values[1], token_hmac: values[2], signup_email_lookup_hmac: values[4],
        signup_phone_lookup_hmac: values[5], signup_phone_ciphertext: values[6],
        profile_ciphertext: values[7], profile_sha256: values[8], key_version: values[9],
        provider_reference: null, state: 'verify_contact', expires_at: new Date(Date.now() + 86_400_000),
        created_at: new Date(), contact_channel: null, contact_hmac: null, contact_lookup_hmac: null,
        contact_ciphertext: null, contact_verified_at: null,
      };
      return { rows: [{ outcome: 'started' }] };
    }
    if (sql.includes('identity.activate_public_patient_signup')) {
      if (enrollment?.state === 'active') return { rows: [{ patient_id: 'patient-8',
        account_id: 'account-8', hid_code: 'HID-TEST-00000001', replayed: true }] };
      Object.assign(enrollment!, { activated_at: new Date(), state: 'active', patient_id: 'patient-8' });
      return { rows: [{ patient_id: 'patient-8', account_id: 'account-8', hid_code: values[4], replayed: false }] };
    }
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
    // The HID an active enrollment shows (progress at 'active').
    if (sql.includes('select hid_code from identity.patients')) {
      return { rows: enrollment?.state === 'active' ? [{ hid_code: 'HID-TEST-00000001' }] : [] };
    }
    if (sql.includes('insert into identity.public_patient_enrollments')) {
      if (enrollment) throw Object.assign(new Error('duplicate enrollment'), { code: '23505' });
      enrollment = {
        id: values[0], nin_lookup_hmac: values[1], nin_last4: values[2],
        nin_ciphertext: values[3], profile_ciphertext: values[4], profile_sha256: values[5],
        provider_reference: values[7], request_hmac: values[8], token_hmac: values[9],
        state: 'verify_contact', expires_at: new Date(Date.now() + 86_400_000), created_at: new Date(),
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
    if (sql.includes('identity.activate_public_patient_enrollment')) {
      // An active enrollment replays: the stored HID, the password ignored (0058).
      if (enrollment?.state === 'active') return { rows: [{ patient_id: 'patient-7',
        account_id: 'account-7', hid_code: 'HID-TEST-00000001', replayed: true }] };
      // A first activation records when it happened, as the command does.
      Object.assign(enrollment!, { activated_at: new Date() });
      return { rows: [{ patient_id: 'patient-7', account_id: 'account-7',
        hid_code: values[4], replayed: false }] };
    }
    return { rows: [], rowCount: 0 };
  }) } as unknown as PoolClient;
  const database = { withSystemTransaction: jest.fn(async (_correlation: string,
    work: (client: PoolClient) => Promise<unknown>) => work(client)) } as unknown as DatabaseService;
  const provider = { assertAvailable: jest.fn().mockResolvedValue(undefined),
    isAvailable: jest.fn().mockResolvedValue(true), verifyNin: jest.fn().mockResolvedValue(identity) };
  const notification = { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'test_sms' }),
    deliverPatientWelcome: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'ses' }) };
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
    set contactReady(value: boolean) { contactReady = value; },
    set signupOutcome(value: string) { signupOutcome = value; },
    set rateCount(value: number) { rateCount = value; } };
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
      QOREID_CLIENT_ID: 'fixture-client', QOREID_CLIENT_SECRET: 'fixture-secret',
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

  it.each([true, false])('reports only reconciliation readiness (%s), without consuming a NIN or contacting a provider', async ready => {
    const f = fixture(); f.ready = ready;
    // open is the sign-up's: the NIN start's readiness is ninStart only.
    await expect(f.service.availability(correlationId)).resolves.toEqual({ open: true, signup: true, ninStart: ready });
    expect(f.provider.isAvailable).toHaveBeenCalledTimes(1);
    expect(f.queries).toEqual([
      { sql: 'select identity.patient_contact_lookup_ready() as ready', values: [] },
      { sql: 'select identity.public_patient_enrollment_ready() as ready', values: [] }]);
    expect(f.provider.verifyNin).not.toHaveBeenCalled();
    expect(f.notification.deliver).not.toHaveBeenCalled();
  });

  it('reports the NIN start closed while the QoreID gate is closed, without reading its readiness; sign-up stays open', async () => {
    const f = fixture();
    f.provider.isAvailable.mockResolvedValue(false);
    await expect(f.service.availability(correlationId)).resolves.toEqual({ open: true, signup: true, ninStart: false });
    expect(f.queries).toEqual([{ sql: 'select identity.patient_contact_lookup_ready() as ready', values: [] }]);
    expect(f.provider.verifyNin).not.toHaveBeenCalled();
  });

  it('reports the NIN start closed when enrollment configuration is missing, as start refuses; sign-up does not need the NIN keys', async () => {
    delete process.env.NIN_ENCRYPTION_KEY_B64;
    delete process.env.NIN_LOOKUP_HMAC_KEY_B64;
    resetEnvironmentForTests();
    const f = fixture();
    await expect(f.service.availability(correlationId)).resolves.toEqual({ open: true, signup: true, ninStart: false });
    expect(f.provider.isAvailable).not.toHaveBeenCalled();
    expect(f.queries).toEqual([{ sql: 'select identity.patient_contact_lookup_ready() as ready', values: [] }]);
    f.queries.length = 0;
    await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
      .rejects.toMatchObject({ status: 503, code: 'ENROLLMENT_CONFIGURATION_UNAVAILABLE' });
    expect(f.provider.assertAvailable).not.toHaveBeenCalled();
  });

  it('propagates a readiness outage instead of announcing registration open', async () => {
    const f = fixture();
    jest.spyOn(f.client, 'query').mockImplementationOnce(() => { throw new Error('readiness unavailable'); });
    await expect(f.service.availability(correlationId)).rejects.toThrow('readiness unavailable');
    expect(f.provider.verifyNin).not.toHaveBeenCalled();
  });

  it('starts with NIN alone and stores opaque encrypted evidence', async () => {
    const f = fixture();
    const result = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);

    expect(f.provider.verifyNin).toHaveBeenCalledWith(nin);
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
    // The gate is checked first and was open; QoreID is never asked.
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
      .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001', replayed: false });
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
      .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001', replayed: false });
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

  describe('activation cost and budget', () => {
    const activation = (queries: RecordedQuery[]) => queries
      .filter(({ sql }) => sql.includes('identity.activate_public_patient_enrollment'));

    it('hashes the password once for a first activation', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      const before = passwordHash().mock.calls.length;
      await expect(f.service.activate(cookie, 'a-strong-test-password', correlationId))
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001', replayed: false });
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
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001', replayed: true });

      // A replay sets no credential (0058 returns the HID first), so the
      // presented password is never hashed. The command still receives a
      // well-formed hash: one of random bytes, computed at the first replay,
      // kept for the process and never stored.
      expect(passwordHash().mock.calls.slice(before)).toEqual([[expect.any(Buffer),
        { type: 2, memoryCost: 65_536, timeCost: 3, parallelism: 1 }]]);
      expect(passwordHash().mock.calls.some(([value]) => value === 'a-different-test-password')).toBe(false);
      const replay = activation(f.queries).at(-1);
      expect(replay?.values[5]).toBe(PLACEHOLDER_HASH);
      expect(replay?.values).not.toContain('a-different-test-password');

      // Further replays reuse it: no argon2id run at all.
      await f.service.activate(cookie, 'a-third-test-password', correlationId);
      expect(passwordHash().mock.calls.slice(before)).toHaveLength(1);
      expect(activation(f.queries).at(-1)?.values[5]).toBe(PLACEHOLDER_HASH);
    });

    it('computes the placeholder again after a failed attempt, and never at construction', async () => {
      const f = fixture();
      expect(passwordHash()).not.toHaveBeenCalled();
      const cookie = await verifiedEnrollment(f);
      await f.service.activate(cookie, 'a-strong-test-password', correlationId);
      Object.assign(f.enrollment!, { state: 'active', patient_id: 'patient-7' });
      passwordHash().mockRejectedValueOnce(new Error('argon2 unavailable'));
      await expect(f.service.activate(cookie, 'a-strong-test-password', correlationId))
        .rejects.toThrow('argon2 unavailable');
      await expect(f.service.activate(cookie, 'a-strong-test-password', correlationId))
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001', replayed: true });
      expect(activation(f.queries).at(-1)?.values[5]).toBe(PLACEHOLDER_HASH);
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
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001', replayed: false });
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

    it('keeps one budget per enrollment: each enrollment its own bucket, the same one on every attempt', async () => {
      const bucketsOf = async () => {
        const f = fixture();
        const cookie = await verifiedEnrollment(f);
        const attempts: unknown[] = [];
        for (const attempt of [1, 2]) {
          f.queries.length = 0;
          await f.service.activate(cookie, 'a-strong-test-password', correlationId);
          attempts.push(...rateLookups(f.queries).map(({ bucket }) => bucket));
          if (attempt === 1) Object.assign(f.enrollment!, { state: 'active', patient_id: 'patient-7' });
        }
        return { id: f.enrollment?.id, attempts };
      };
      const first = await bucketsOf();
      const second = await bucketsOf();
      expect(first.id).not.toBe(second.id);
      expect(first.attempts).toHaveLength(2);
      expect(first.attempts[1]).toBe(first.attempts[0]);
      expect(second.attempts[1]).toBe(second.attempts[0]);
      expect(second.attempts[0]).not.toBe(first.attempts[0]);
    });

    it('stores the argon2id form the activation command requires (real argon2)', async () => {
      const real = jest.requireActual<typeof import('argon2')>('argon2');
      passwordHash().mockImplementation((value: string | Buffer, options: Parameters<typeof real.hash>[1]) =>
        real.hash(value, options));
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      await f.service.activate(cookie, 'a-strong-test-password', correlationId);
      const stored = String(activation(f.queries).at(-1)?.values[5]);
      // identity.activate_public_patient_enrollment (0058) refuses any other form.
      expect(stored).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
      expect(stored.length).toBeGreaterThanOrEqual(64);
      expect(stored.length).toBeLessThanOrEqual(512);
      await expect(real.verify(stored, 'a-strong-test-password')).resolves.toBe(true);
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

  describe('the enrollment gate comes before any registration lookup', () => {
    const open = { QOREID_ENABLED: 'true', QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'true' };
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
        const { f, adapter, pause: pauseQoreId } = gated();
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

    // GET /identity/patient-enrollments/availability answers from the checks
    // start makes before it reads a NIN, so a client can say that registration
    // is not open before it asks for one.
    it.each(closures)('answers availability closed while %s, as start refuses, reading and charging nothing',
      async (_label, closed, pause, status, code) => {
        Object.assign(process.env, open); resetEnvironmentForTests();
        const { f, adapter, pause: pauseQoreId } = gated();
        await expect(f.service.availability(correlationId)).resolves.toEqual({ open: true, signup: true, ninStart: true });
        f.queries.length = 0;
        Object.assign(process.env, closed); resetEnvironmentForTests();
        if (pause) pauseQoreId();
        await expect(f.service.availability(correlationId)).resolves.toEqual({ open: true, signup: true, ninStart: false });
        expect(f.queries).toEqual([{ sql: 'select identity.patient_contact_lookup_ready() as ready', values: [] }]);
        f.queries.length = 0;
        await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
          .rejects.toMatchObject({ status, code });
        expect(f.queries).toEqual([]);
        expect(adapter.verifyNinEnrollment).not.toHaveBeenCalled();
      });

    it('answers availability closed while the enrollment keys are not configured, as start refuses', async () => {
      Object.assign(process.env, open);
      delete process.env.NIN_ENCRYPTION_KEY_B64; resetEnvironmentForTests();
      const { f, integrations } = gated();
      await expect(f.service.availability(correlationId)).resolves.toEqual({ open: true, signup: true, ninStart: false });
      f.queries.length = 0;
      await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
        .rejects.toMatchObject({ status: 503, code: 'ENROLLMENT_CONFIGURATION_UNAVAILABLE' });
      expect(integrations.assertAvailable).not.toHaveBeenCalled();
      expect(f.queries).toEqual([]);
    });

    it('reports a fault reading the runtime pause as a fault, not as closed or open', async () => {
      Object.assign(process.env, open); resetEnvironmentForTests();
      const { f, integrations } = gated();
      integrations.assertAvailable.mockRejectedValueOnce(new DomainProblem(503, 'INTEGRATION_UNAVAILABLE',
        'Delivery provider is temporarily unavailable'));
      await expect(f.service.availability(correlationId)).rejects.toMatchObject({ status: 503, code: 'INTEGRATION_UNAVAILABLE' });
    });
  });

  describe('the HID is shown again for 15 minutes after activation only', () => {
    const activationCalls = (f: ReturnType<typeof fixture>) => f.queries
      .filter(({ sql }) => sql.includes('identity.activate_public_patient_enrollment'));

    it('replays the activation through the cookie within 15 minutes of it', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      await f.service.activate(cookie, 'a-strong-test-password', correlationId);
      Object.assign(f.enrollment!, { state: 'active', patient_id: 'patient-7',
        activated_at: new Date(Date.now() - 14 * 60_000) });
      f.queries.length = 0;
      await expect(f.service.activate(cookie, 'a-strong-test-password', correlationId))
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001', replayed: true });
      expect(activationCalls(f)).toHaveLength(1);
    });

    it.each<[string, Date | null]>([
      ['more than 15 minutes ago', new Date(Date.now() - 15 * 60_000 - 1_000)],
      ['at no recorded time', null],
    ])('answers an enrollment activated %s as an unknown one, charging and hashing nothing', async (_label, activatedAt) => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      await f.service.activate(cookie, 'a-strong-test-password', correlationId);
      Object.assign(f.enrollment!, { state: 'active', patient_id: 'patient-7', activated_at: activatedAt });
      f.queries.length = 0;
      const hashesBefore = passwordHash().mock.calls.length;

      await expect(f.service.current(cookie, correlationId))
        .rejects.toMatchObject({ status: 404, code: 'ENROLLMENT_NOT_FOUND' });
      await expect(f.service.activate(cookie, 'a-strong-test-password', correlationId))
        .rejects.toMatchObject({ status: 404, code: 'ENROLLMENT_NOT_FOUND' });
      await expect(f.service.startContact(cookie, 'email', 'patient@example.test', '203.0.113.10', correlationId))
        .rejects.toMatchObject({ status: 404, code: 'ENROLLMENT_NOT_FOUND' });
      // The locked reads refuse it the same way.
      await expect(f.service.verifyContact(cookie, f.challenge?.id as string, '123456', correlationId))
        .rejects.toMatchObject({ status: 404, code: 'ENROLLMENT_NOT_FOUND' });
      await expect(f.service.bindGoogle(cookie, 'pending-id.pending-token', correlationId))
        .rejects.toMatchObject({ status: 404, code: 'ENROLLMENT_NOT_FOUND' });

      expect(activationCalls(f)).toHaveLength(0);
      expect(rateLookups(f.queries)).toEqual([]);
      expect(passwordHash().mock.calls.length).toBe(hashesBefore);
    });

    it('answers a start with the key of an activated enrollment as a reused key, so the page says it was completed', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      await f.service.activate(cookie, 'a-strong-test-password', correlationId);
      Object.assign(f.enrollment!, { state: 'active', patient_id: 'patient-7' });
      f.bound = true;
      // The activated enrollment answers its own key's start as reused, before the registration checks.
      await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
        .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
      // Any other key for the registered NIN is a duplicate, as before.
      await expect(f.service.start(nin, '49ebcc73-3aa3-47aa-b1e4-f8944ab6eab0', '203.0.113.10', correlationId))
        .rejects.toMatchObject({ status: 409, code: 'NIN_ALREADY_REGISTERED' });
      expect(f.provider.verifyNin).toHaveBeenCalledTimes(1);
    });

    it('leaves an enrollment that is not yet active to its own expiry', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      // A pending row has no activation time; the window does not apply to it.
      expect(f.enrollment?.activated_at).toBeUndefined();
      await expect(f.service.current(started.cookie, correlationId))
        .resolves.toMatchObject({ stage: 'verify_contact' });
    });
  });

  it('enrolls a NIN record whose residence gives only some parts, keeping exactly those parts', async () => {
    const f = fixture();
    const { address: _address, residence: _residence, phoneNumber: _phone, photo: _photo, ...bare } = identity;
    f.provider.verifyNin.mockResolvedValue({ ...bare, residence: { town: 'Fixture Town', state: 'Fixture State' } });
    const cookie = await verifiedEnrollment(f);
    await expect(f.service.activate(cookie, 'a-strong-test-password', correlationId))
      .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001', replayed: false });
    const activation = f.queries.find(({ sql }) => sql.includes('identity.activate_public_patient_enrollment'))!;
    const profile = JSON.parse(activation.values[2] as string);
    expect(profile.residence).toEqual({ town: 'Fixture Town', state: 'Fixture State' });
    expect(profile).not.toHaveProperty('address');
    expect(profile).not.toHaveProperty('phoneNumber');
    expect(profile).not.toHaveProperty('photo');

    // An address that names a different street than the residence still is a provider fault.
    const g = fixture();
    g.provider.verifyNin.mockResolvedValue({ ...bare, address: '2 Other Street',
      residence: { address1: '1 Fixture Street', town: 'Fixture Town' } });
    await expect(g.service.start(nin, requestKey, '203.0.113.10', correlationId))
      .rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
  });

  describe('the name on the NIN record, for the person to check it is theirs', () => {
    it('answers a start with the full name as the record gives it, and stores it only encrypted', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      expect(started.progress).toMatchObject({ stage: 'verify_contact', recordName: 'Amina Fixture Okafor' });
      const insert = f.queries.find(({ sql }) => sql.includes('insert into identity.public_patient_enrollments'))!;
      expect(JSON.stringify(insert.values.map((value) => Buffer.isBuffer(value) ? value.toString('hex') : value)))
        .not.toContain('Amina');
    });

    it('shows it again while the enrollment is pending: on resume, at the contact step and at the password step', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
        .resolves.toMatchObject({ progress: { recordName: 'Amina Fixture Okafor' } });
      await expect(f.service.current(started.cookie, correlationId))
        .resolves.toMatchObject({ stage: 'verify_contact', recordName: 'Amina Fixture Okafor' });
      const contact = await f.service.startContact(started.cookie, 'email', 'patient@example.test',
        '203.0.113.10', correlationId);
      await expect(f.service.current(started.cookie, correlationId))
        .resolves.toMatchObject({ stage: 'verify_contact', challengeId: contact.challengeId,
          recordName: 'Amina Fixture Okafor' });
      const deliveredCode = f.notification.deliver.mock.calls[0]?.[0].code as string;
      await f.service.verifyContact(started.cookie, contact.challengeId, deliveredCode, correlationId);
      await expect(f.service.current(started.cookie, correlationId))
        .resolves.toMatchObject({ stage: 'set_password', recordName: 'Amina Fixture Okafor' });
    });

    it('gives a name without a middle name, and single spaces', async () => {
      const f = fixture();
      const { middleName: _middle, ...noMiddle } = identity;
      f.provider.verifyNin.mockResolvedValue({ ...noMiddle, firstName: '  Amina ', lastName: 'Okafor   Bello' });
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      expect(started.progress).toMatchObject({ recordName: 'Amina Okafor Bello' });
    });

    it('leaves the name out, and still answers, when the stored record cannot be read', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      Object.assign(f.enrollment!, { profile_ciphertext: Buffer.alloc(40, 9) });
      const progress = await f.service.current(started.cookie, correlationId);
      expect(progress).toMatchObject({ stage: 'verify_contact' });
      expect(progress).not.toHaveProperty('recordName');
    });

    it('is not part of the answer once the enrollment is active, not even within 15 minutes of the start', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      await expect(f.service.activate(cookie, 'a-strong-test-password', correlationId))
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001', replayed: false });
      Object.assign(f.enrollment!, { state: 'active', patient_id: 'patient-7', activated_at: new Date(Date.now() - 60_000) });
      const progress = await f.service.current(cookie, correlationId);
      expect(progress).toMatchObject({ stage: 'active', hidCode: 'HID-TEST-00000001' });
      expect(progress).not.toHaveProperty('recordName');
    });

    it('is shown on a reload for 15 minutes after the start only, so the next person on a shared device does not see it', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      Object.assign(f.enrollment!, { created_at: new Date(Date.now() - 14 * 60_000) });
      await expect(f.service.current(started.cookie, correlationId))
        .resolves.toMatchObject({ recordName: 'Amina Fixture Okafor' });
      Object.assign(f.enrollment!, { created_at: new Date(Date.now() - 15 * 60_000 - 1_000) });
      const later = await f.service.current(started.cookie, correlationId);
      expect(later).toMatchObject({ stage: 'verify_contact' });
      expect(later).not.toHaveProperty('recordName');
      // A start, which needs the NIN and the page's own key, still shows it, and does not reopen the reload window.
      await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
        .resolves.toMatchObject({ progress: { recordName: 'Amina Fixture Okafor' } });
      expect(await f.service.current(started.cookie, correlationId)).not.toHaveProperty('recordName');
    });
  });

  describe('sign-up without a NIN (0092)', () => {
    const declared = { firstName: ' Ada ', lastName: 'Obi', email: 'Ada@Example.test',
      phone: '0803 123 4567', gender: 'female' as const, hospitalCurrentlyUsing: 'LUTH' };
    const challengeOf = (progress: unknown) => String((progress as { challengeId?: string }).challengeId);
    const signupCalls = (f: ReturnType<typeof fixture>) => f.queries
      .filter(({ sql }) => sql.includes('identity.start_public_patient_signup'));

    it('stores the declared profile without a NIN, sets the cookie and sends a code to the email at once', async () => {
      const f = fixture();
      const cookies: string[] = [];
      const result = await f.service.signup(declared, requestKey, '203.0.113.10', correlationId,
        (cookie) => cookies.push(cookie));
      expect(cookies).toEqual([result.cookie]);
      expect(result.progress).toMatchObject({ stage: 'verify_contact', contactChannel: 'email',
        maskedContact: 'a•••@example.test', challengeId: f.challenge?.id,
        expiresInSeconds: expect.any(Number), resendAfterSeconds: expect.any(Number),
        expiresAt: expect.any(String), googleOnboardingRequired: false });
      expect(result.progress).not.toHaveProperty('recordName');
      const [call] = signupCalls(f);
      expect(call?.values[3]).toBe('ada@example.test');
      expect(call?.values[4]).toBe(createContactLookupHmac('email', 'ada@example.test'));
      expect(call?.values[5]).toBe(createContactLookupHmac('phone', '+2348031234567'));
      expect(f.enrollment).toMatchObject({ nin_lookup_hmac: null, state: 'verify_contact', contact_channel: 'email' });
      expect(f.notification.deliver).toHaveBeenCalledWith(expect.objectContaining({
        recipient: 'ada@example.test', purpose: 'SIGNUP_VERIFY', channel: 'email' }));
      // Neither QoreID nor the NIN registry is involved.
      expect(f.provider.assertAvailable).not.toHaveBeenCalled();
      expect(f.provider.verifyNin).not.toHaveBeenCalled();
      expect(f.protector.lookup).not.toHaveBeenCalled();
      expect(f.queries.some(({ sql }) => sql.includes('public_patient_enrollment_ready'))).toBe(false);
    });

    it('verifies the declared email, then activates from the declared profile with its own command', async () => {
      const f = fixture();
      const started = await f.service.signup(declared, requestKey, '203.0.113.10', correlationId, () => undefined);
      const code = f.notification.deliver.mock.calls[0]?.[0].code as string;
      await expect(f.service.verifyContact(started.cookie, challengeOf(started.progress), code, correlationId))
        .resolves.toEqual({ stage: 'set_password' });
      await expect(f.service.activate(started.cookie, 'correct horse battery', correlationId))
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001', replayed: false });
      const activation = f.queries.find(({ sql }) => sql.includes('identity.activate_public_patient_signup'));
      expect(JSON.parse(String(activation?.values[2]))).toEqual({ kind: 'signup', firstName: 'Ada', lastName: 'Obi',
        email: 'ada@example.test', phone: '+2348031234567', gender: 'female', hospitalCurrentlyUsing: 'LUTH',
        termsAccepted: true });
      expect(activation?.values[3]).toBe('ada@example.test');
      expect(f.queries.some(({ sql }) => sql.includes('identity.activate_public_patient_enrollment'))).toBe(false);
      expect(f.google.consumePendingInTransaction).not.toHaveBeenCalled();
    });

    it('works without the NIN keys, encrypting with the OTP-derived key', async () => {
      delete process.env.NIN_ENCRYPTION_KEY_B64; delete process.env.NIN_LOOKUP_HMAC_KEY_B64;
      resetEnvironmentForTests();
      const f = fixture();
      const started = await f.service.signup(declared, requestKey, '203.0.113.10', correlationId, () => undefined);
      expect(f.enrollment?.key_version).toBe('otp-hkdf:local-v1');
      const code = f.notification.deliver.mock.calls[0]?.[0].code as string;
      await f.service.verifyContact(started.cookie, challengeOf(started.progress), code, correlationId);
      await expect(f.service.activate(started.cookie, 'correct horse battery', correlationId))
        .resolves.toMatchObject({ stage: 'active' });
    });

    it('refuses another email or a phone for the code', async () => {
      const f = fixture();
      const started = await f.service.signup(declared, requestKey, '203.0.113.10', correlationId, () => undefined);
      await expect(f.service.startContact(started.cookie, 'email', 'eve@example.test', '203.0.113.10', correlationId))
        .rejects.toMatchObject({ status: 400, code: 'ENROLLMENT_CONTACT_MISMATCH' });
      await expect(f.service.startContact(started.cookie, 'phone', '08031234567', '203.0.113.10', correlationId))
        .rejects.toMatchObject({ status: 400, code: 'ENROLLMENT_CONTACT_MISMATCH' });
    });

    it.each([['email_registered', 'PATIENT_EMAIL_ALREADY_REGISTERED', 'This email address already has a Health ID account. Sign in instead.'],
      ['phone_registered', 'PATIENT_PHONE_ALREADY_REGISTERED', 'This phone number already has a Health ID account. Sign in instead.']])(
      'answers %s with 409 and sets no cookie', async (outcome, code, detail) => {
        const f = fixture(); f.signupOutcome = outcome;
        const cookies: string[] = [];
        await expect(f.service.signup(declared, requestKey, '203.0.113.10', correlationId, (cookie) => cookies.push(cookie)))
          .rejects.toMatchObject({ status: 409, code, message: detail });
        expect(cookies).toEqual([]);
        expect(f.notification.deliver).not.toHaveBeenCalled();
      });

    it('resumes a retry with the same key and declaration, and refuses the key for another declaration', async () => {
      const f = fixture();
      const first = await f.service.signup(declared, requestKey, '203.0.113.10', correlationId, () => undefined);
      const again = await f.service.signup(declared, requestKey, '203.0.113.10', correlationId, () => undefined);
      expect(again.cookie).toBe(first.cookie);
      expect(again.progress).toMatchObject({ stage: 'verify_contact', challengeId: challengeOf(first.progress) });
      expect(signupCalls(f)).toHaveLength(1);
      expect(f.notification.deliver).toHaveBeenCalledTimes(1);
      await expect(f.service.signup({ ...declared, lastName: 'Other' }, requestKey, '203.0.113.10', correlationId,
        () => undefined)).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    });

    it.each([['phone', { phone: '0803123456' }], ['phone', { phone: '447700900123' }], ['phone', { phone: '+123456' }],
      ['phone', { phone: '+1234567890123456' }],
      ['firstName', { firstName: '   ' }], ['email', { email: 'not-an-email' }]] as const)(
      'refuses an invalid %s before anything is written', async (field, change) => {
        const f = fixture();
        await expect(f.service.signup({ ...declared, ...change }, requestKey, '203.0.113.10', correlationId,
          () => undefined)).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED',
          errors: [expect.objectContaining({ field })] });
        expect(f.queries).toEqual([]);
      });

    it('says how to type a phone of any country when the phone is refused', async () => {
      const f = fixture();
      await expect(f.service.signup({ ...declared, phone: '447700900123' }, requestKey, '203.0.113.10', correlationId,
        () => undefined)).rejects.toMatchObject({ errors: [{ field: 'phone', messages: [
        'Enter your phone number with its country code, like +44 7700 900123, or a Nigerian number like 08012345678.'] }] });
    });

    it.each([['+44 7700 900123', '+447700900123'], ['+1 (415) 555-0100', '+14155550100'], ['+683 4002', '+6834002'],
      ['0803-123-4567', '+2348031234567'], ['+234 0803 123 4567', '+2348031234567']])(
      'stores the phone %s as E.164 (any country; owner decision of 2026-10-28)', async (typed, stored) => {
        const f = fixture();
        await f.service.signup({ ...declared, phone: typed }, requestKey, '203.0.113.10', correlationId, () => undefined);
        const [call] = signupCalls(f);
        expect(call?.values[5]).toBe(createContactLookupHmac('phone', stored));
      });

    it('the NIN start refuses a sign-up\'s key as reused', async () => {
      const f = fixture();
      await f.service.signup(declared, requestKey, '203.0.113.10', correlationId, () => undefined);
      await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
        .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    });
  });

  describe('the welcome email at activation (owner decision of 2026-10-28)', () => {
    const declared = { firstName: ' Ada ', lastName: 'Obi', email: 'Ada@Example.test',
      phone: '0803 123 4567', gender: 'female' as const, hospitalCurrentlyUsing: 'LUTH' };
    const challengeOf = (progress: unknown) => String((progress as { challengeId?: string }).challengeId);

    async function signedUp(f: ReturnType<typeof fixture>) {
      const started = await f.service.signup(declared, requestKey, '203.0.113.10', correlationId, () => undefined);
      const code = f.notification.deliver.mock.calls[0]?.[0].code as string;
      await f.service.verifyContact(started.cookie, challengeOf(started.progress), code, correlationId);
      return started.cookie;
    }

    function capturedWarnings(f: ReturnType<typeof fixture>) {
      return jest.spyOn((f.service as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
    }

    it('sends "Your Health ID is ready" once to the verified email of a sign-up, never on a replay', async () => {
      const f = fixture();
      const cookie = await signedUp(f);
      await f.service.activate(cookie, 'correct horse battery', correlationId);
      await f.service.settleWelcomeEmails();
      expect(f.notification.deliverPatientWelcome).toHaveBeenCalledTimes(1);
      expect(f.notification.deliverPatientWelcome).toHaveBeenCalledWith({ patientId: 'patient-8',
        recipient: 'ada@example.test', firstName: 'Ada', healthId: 'HID-TEST-00000001', correlationId });

      await expect(f.service.activate(cookie, 'correct horse battery', correlationId))
        .resolves.toMatchObject({ replayed: true });
      await f.service.settleWelcomeEmails();
      expect(f.notification.deliverPatientWelcome).toHaveBeenCalledTimes(1);
    });

    it('sends it on the NIN route to a verified email, with the record\'s first name and never the NIN', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      await f.service.activate(cookie, 'a-strong-test-password', correlationId);
      await f.service.settleWelcomeEmails();
      expect(f.notification.deliverPatientWelcome).toHaveBeenCalledWith({ patientId: 'patient-7',
        recipient: 'patient@example.test', firstName: 'Amina', healthId: 'HID-TEST-00000001', correlationId });
      expect(JSON.stringify(f.notification.deliverPatientWelcome.mock.calls)).not.toContain(nin);
      expect(JSON.stringify(f.notification.deliverPatientWelcome.mock.calls)).not.toContain('a-strong-test-password');
    });

    it('sends nothing when the verified contact is a phone number (production delivers email only)', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const contact = await f.service.startContact(started.cookie, 'phone', '08012345678', '203.0.113.10', correlationId);
      const code = f.notification.deliver.mock.calls[0]?.[0].code as string;
      await f.service.verifyContact(started.cookie, contact.challengeId, code, correlationId);
      await expect(f.service.activate(started.cookie, 'a-strong-test-password', correlationId))
        .resolves.toMatchObject({ stage: 'active', replayed: false });
      await f.service.settleWelcomeEmails();
      expect(f.notification.deliverPatientWelcome).not.toHaveBeenCalled();
    });

    it('never holds the activation up: it answers before the email is sent', async () => {
      const f = fixture();
      let finish: (value: { outcome: 'accepted' }) => void = () => undefined;
      f.notification.deliverPatientWelcome.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      const cookie = await signedUp(f);
      await expect(f.service.activate(cookie, 'correct horse battery', correlationId))
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001', replayed: false });
      expect(f.notification.deliverPatientWelcome).toHaveBeenCalledTimes(1);
      finish({ outcome: 'accepted' });
      await f.service.settleWelcomeEmails();
    });

    it.each<[string, () => Promise<unknown>]>([
      ['fails', () => Promise.reject(new Error('connect ECONNREFUSED ada@example.test HID-TEST-00000001'))],
      ['is refused', () => Promise.resolve({ outcome: 'definitive_failure', safeCode: 'http_404' })],
    ])('a send that %s never fails the sign-up, and is logged without personal data', async (_label, outcome) => {
      const f = fixture();
      f.notification.deliverPatientWelcome.mockImplementation(outcome);
      const warn = capturedWarnings(f);
      const cookie = await signedUp(f);
      await expect(f.service.activate(cookie, 'correct horse battery', correlationId))
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001', replayed: false });
      await f.service.settleWelcomeEmails();
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]?.[0]);
      expect(logged).toContain(correlationId);
      for (const secret of ['ada@example.test', 'Ada', 'HID-TEST-00000001', 'patient-8', 'correct horse battery']) {
        expect(logged).not.toContain(secret);
      }
    });
  });
});

describe('emailFirstName', () => {
  it.each<[unknown, string | undefined]>([
    ['Ada', 'Ada'], [' Ada ', 'Ada'], ['Ọlá', 'Ọlá'], ['Mary-Jane', 'Mary-Jane'], ['O’Neil', "O'Neil"],
    ['ADA2', 'ADA'], ['1Ada', 'Ada'], ['<b>Ada</b>', 'b Ada b'], ['', undefined], ['123', undefined],
    [null, undefined], [7, undefined], ['A'.repeat(130), 'A'.repeat(120)],
  ])('%p becomes %p', (value, expected) => {
    expect(emailFirstName(value)).toBe(expected);
  });
});
