import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import { PatientEnrollmentService } from './patient-enrollment.service';
import type { PublicPatientIdentityProvider } from './patient-enrollment.provider';
import type { NinIdentifierProtector } from './nin-identifier-protector';
import type { HidCodeGenerator } from './hid-code-generator.service';

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

function fixture() {
  let enrollment: Record<string, unknown> | undefined;
  const challenges: Record<string, unknown>[] = [];
  let bound = false;
  let rateCount = 0;
  const queries: RecordedQuery[] = [];
  const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes('public_patient_nin_already_bound')) return { rows: [{ bound }] };
    if (sql.includes('from identity.public_patient_enrollment_rates')) return { rows: rateCount
      ? [{ request_count: rateCount, window_started_at: new Date() }] : [] };
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
        contact_channel: null, contact_hmac: null, contact_ciphertext: null,
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
        contact_ciphertext: values[3] });
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
      return { rows: [{ patient_id: 'patient-7', account_id: 'account-7',
        hid_code: values[4], replayed: false }] };
    }
    return { rows: [], rowCount: 0 };
  }) } as unknown as PoolClient;
  const database = { withSystemTransaction: jest.fn(async (_correlation: string,
    work: (client: PoolClient) => Promise<unknown>) => work(client)) } as unknown as DatabaseService;
  const provider = { verifyNin: jest.fn().mockResolvedValue(identity) };
  const notification = { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'test_sms' }) };
  const protector = { lookup: jest.fn().mockReturnValue('a'.repeat(64)) };
  const hidCodes = { generate: jest.fn().mockReturnValue('HID-TEST-00000001') };
  const service = new PatientEnrollmentService(database, protector as unknown as NinIdentifierProtector,
    provider as PublicPatientIdentityProvider, notification as unknown as NotificationOtpClient,
    hidCodes as unknown as HidCodeGenerator);
  return { service, queries, provider, notification, protector,
    get enrollment() { return enrollment; }, get challenge() { return challenges.at(-1); },
    challenges,
    set bound(value: boolean) { bound = value; },
    set rateCount(value: number) { rateCount = value; } };
}

describe('PatientEnrollmentService', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      NIN_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 1).toString('base64'),
      NIN_ENCRYPTION_KEY_B64: Buffer.alloc(32, 2).toString('base64'),
      OTP_HMAC_KEY_B64: Buffer.alloc(32, 3).toString('base64'),
    });
    resetEnvironmentForTests();
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

  it('rejects an already bound NIN before contacting the provider', async () => {
    const f = fixture();
    f.bound = true;
    await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
      .rejects.toMatchObject({ code: 'NIN_ALREADY_REGISTERED' });
    expect(f.provider.verifyNin).not.toHaveBeenCalled();
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
    expect(activation.values).not.toContain('a-strong-test-password');
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
});
