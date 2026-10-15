jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));
// Counted argon2: a password hashes to PASSWORD_HASH, random bytes (the replay
// placeholder) to PLACEHOLDER_HASH. Both have the form activation requires.
const PASSWORD_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${'c'.repeat(22)}$${'d'.repeat(43)}`;
const PLACEHOLDER_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${'e'.repeat(22)}$${'f'.repeat(43)}`;
jest.mock('argon2', () => ({ argon2id: 2, hash: jest.fn() }));

import { createHmac } from 'node:crypto';
import * as argon2 from 'argon2';
import type { ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import { DomainProblem, ProblemDetailsFilter, PublicDetailProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import * as environment from '../config/environment';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import type { GoogleAuthenticationService } from '../auth/google-authentication.service';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { PatientEnrollmentService, normalizeRegistryPhone, underEighteen } from './patient-enrollment.service';
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
/** The problem body Identity sends for an error, through its own filter. */
function answered(error: unknown): { status: number; code: string; detail: string } {
  const response = { status: jest.fn().mockReturnThis(), type: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis() };
  const host = { switchToHttp: () => ({
    getRequest: () => ({ correlationId, method: 'POST',
      route: { path: '/identity/patient-enrollments/holder' } } as unknown as HidRequest),
    getResponse: () => response as unknown as Response,
  }) } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(error, host);
  return response.json.mock.calls[0]?.[0];
}
/** `auth.otp_rate_limits` rows by `scope:bucket`; fixtures given one map share the table. */
type OtpRateRow = { request_count: number; window_started_at: Date; blocked_until: Date | null };

function fixture(otpRates = new Map<string, OtpRateRow>(),
  identityProvider?: PublicPatientIdentityProvider) {
  // Each start inserts its own enrollment (0093); `enrollment` is the latest.
  const enrollments = new Map<string, Record<string, unknown>>();
  let enrollment: Record<string, unknown> | undefined;
  let activationFailure: unknown;
  // What identity.record_public_patient_holder_send and _proof answer (0093).
  let holderSendAllowed = true;
  let holderProofOutcome = 'verified';
  // The facilities identity.list_participating_facilities lists (0094), the
  // in-person proof's answer or failure, and the desk code lookups.
  let participating: Record<string, unknown>[] = [];
  let facilityProof: unknown = 'verified';
  const holderCalls: { command: string; values: readonly unknown[] }[] = [];
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
    if (sql.includes('identity.list_participating_facilities()')) {
      if (sql.includes('exists')) return { rows: [{ open: participating.length > 0 }] };
      return { rows: participating };
    }
    if (sql.includes('from identity.public_patient_enrollments where desk_code_hmac=$1')) {
      return { rows: [...enrollments.values()].filter((row) => row.desk_code_hmac === values[0]
        && row.state === 'verify_holder' && (row.desk_code_expires_at as Date) > new Date()) };
    }
    if (sql.includes('set desk_code_hmac=$2')) {
      const row = enrollments.get(String(values[0]));
      if (!row || row.state !== 'verify_holder' || Number(row.desk_code_issues) >= Number(values[3])) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(row, { desk_code_hmac: values[1], desk_code_salt: values[2], desk_code_expires_at: row.expires_at,
        desk_code_issues: Number(row.desk_code_issues) + 1 });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('from identity.public_patient_enrollments where nin_lookup_hmac')) {
      return { rows: [...enrollments.values()].filter((row) => values[0] === row.nin_lookup_hmac) };
    }
    if (sql.includes('from identity.public_patient_enrollments where request_hmac')) {
      return { rows: [...enrollments.values()].filter((row) => values[0] === row.request_hmac) };
    }
    if (sql.includes('select nin_lookup_hmac from identity.public_patient_enrollments where id=$1')) {
      const row = enrollments.get(String(values[0]));
      return { rows: row ? [{ nin_lookup_hmac: row.nin_lookup_hmac }] : [] };
    }
    if (sql.includes('from identity.public_patient_enrollments where id=$1')) {
      const row = enrollments.get(String(values[0]));
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('insert into identity.public_patient_enrollments')) {
      if ([...enrollments.values()].some((row) => row.request_hmac === values[8])) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'),
          { code: '23505', constraint: 'public_patient_enrollment_request_uq' });
      }
      enrollment = {
        id: values[0], nin_lookup_hmac: values[1], nin_last4: values[2],
        nin_ciphertext: values[3], profile_ciphertext: values[4], profile_sha256: values[5],
        provider_reference: values[7], request_hmac: values[8], token_hmac: values[9],
        state: 'verify_holder', expires_at: new Date(Date.now() + 86_400_000),
        contact_channel: null, contact_hmac: null, contact_lookup_hmac: null, contact_ciphertext: null,
        contact_verified_at: null, holder_recipient_hmac: null,
        desk_code_hmac: null, desk_code_salt: null, desk_code_expires_at: null, desk_code_issues: 0,
      };
      enrollments.set(String(values[0]), enrollment);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('from identity.public_patient_enrollment_otps where id=$1')) {
      const challenge = challenges.find((candidate) => candidate.id === values[0]
        && candidate.enrollment_id === values[1] && !candidate.consumed_at && !candidate.invalidated_at
        && (!sql.includes('purpose=') || sql.includes(`purpose='${String(candidate.purpose)}'`)));
      return { rows: challenge ? [challenge] : [] };
    }
    if (sql.includes('from identity.public_patient_enrollment_otps where enrollment_id=$1')) {
      const challenge = [...challenges].reverse().find((candidate) => candidate.enrollment_id === values[0]
        && !candidate.consumed_at && !candidate.invalidated_at
        && (!sql.includes('purpose=') || sql.includes(`purpose='${String(candidate.purpose)}'`)));
      return { rows: challenge ? [challenge] : [] };
    }
    if (sql.includes('as sent from identity.public_patient_enrollment_otps')) {
      return { rows: [{ sent: challenges.filter((candidate) => candidate.enrollment_id === values[0]
        && candidate.purpose === 'nin_holder').length }] };
    }
    if (sql.includes('update identity.public_patient_enrollments set contact_channel=')) {
      Object.assign(enrollments.get(String(values[0]))!, { contact_channel: values[1], contact_hmac: values[2],
        contact_lookup_hmac: values[3], contact_ciphertext: values[4] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('update identity.public_patient_enrollments set holder_recipient_hmac=')) {
      Object.assign(enrollments.get(String(values[0]))!, { holder_recipient_hmac: values[1] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('identity.record_public_patient_holder_send')) {
      holderCalls.push({ command: 'send', values });
      return { rows: [{ allowed: holderSendAllowed }] };
    }
    if (sql.includes('identity.record_public_patient_holder_failure')) {
      holderCalls.push({ command: 'failure', values });
      return { rows: [{}] };
    }
    if (sql.includes('identity.record_public_patient_holder_proof') && sql.includes("'facility_in_person'")) {
      holderCalls.push({ command: 'facility-proof', values });
      if (facilityProof instanceof Error) throw facilityProof;
      const row = enrollments.get(String(values[0]));
      if (facilityProof === 'verified' && row) {
        Object.assign(row, { state: 'verify_contact', holder_method: 'facility_in_person',
          holder_verification_id: values[2], holder_verified_at: new Date(), desk_code_hmac: null,
          desk_code_salt: null, desk_code_expires_at: null });
      } else if (facilityProof === 'existing_identity' && row) {
        enrollments.delete(String(row.id));
      }
      return { rows: [{ outcome: facilityProof }] };
    }
    if (sql.includes('identity.record_public_patient_holder_proof')) {
      holderCalls.push({ command: 'proof', values });
      const row = enrollments.get(String(values[0]))!;
      const challenge = challenges.find((candidate) => candidate.id === values[2])!;
      if (holderProofOutcome === 'verified') {
        Object.assign(challenge, { verified_at: new Date(), consumed_at: new Date() });
        Object.assign(row, { state: 'verify_contact', holder_method: 'registry_phone_otp',
          holder_challenge_id: challenge.id, holder_verified_at: new Date() });
      } else if (holderProofOutcome === 'existing_identity') {
        enrollments.delete(String(row.id));
        for (const candidate of challenges) if (candidate.enrollment_id === row.id) candidate.deleted = true;
      }
      return { rows: [{ outcome: holderProofOutcome }] };
    }
    if (sql.includes('insert into identity.public_patient_enrollment_otps')) {
      // A holder code names its channel and purpose in the statement (0093).
      challenges.push(sql.includes("'nin_holder'")
        ? { id: values[0], enrollment_id: values[1], recipient_hmac: values[2], channel: 'phone',
          purpose: 'nin_holder', verifier_hmac: values[3], expires_at: new Date(Date.now() + 300_000),
          created_at: new Date(Date.now() - 61_000), failed_attempts: 0, max_attempts: 5,
          delivery_outcome: 'unknown' }
        : { id: values[0], enrollment_id: values[1], recipient_hmac: values[2], channel: values[3],
          purpose: 'contact', verifier_hmac: values[4], expires_at: new Date(Date.now() + 300_000),
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
      Object.assign(enrollments.get(String(values[0]))!, { state: 'set_password', contact_verified_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('select hid_code from identity.patients')) {
      return { rows: enrollment?.state === 'active' ? [{ hid_code: 'HID-TEST-00000001' }] : [] };
    }
    // A contact proof too old for activation sends the enrollment back to the contact step.
    if (sql.includes("set state='verify_contact'") && sql.includes("state='set_password' and contact_verified_at")) {
      const row = enrollments.get(String(values[0]));
      if (row?.state !== 'set_password') return { rows: [], rowCount: 0 };
      Object.assign(row, { state: 'verify_contact', contact_channel: null, contact_hmac: null,
        contact_lookup_hmac: null, contact_ciphertext: null, contact_verified_at: null,
        verified_challenge_id: null });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('identity.activate_public_patient_enrollment')) {
      if (activationFailure) throw activationFailure;
      const row = enrollments.get(String(values[0]));
      // An active enrollment replays: the stored HID, the password ignored (0058).
      if (row?.state === 'active') return { rows: [{ patient_id: 'patient-7',
        account_id: 'account-7', hid_code: 'HID-TEST-00000001', replayed: true }] };
      // A first activation records when it happened, as the command does.
      Object.assign(row!, { activated_at: new Date() });
      return { rows: [{ patient_id: 'patient-7', account_id: 'account-7',
        hid_code: values[4], replayed: false }] };
    }
    return { rows: [], rowCount: 0 };
  }) } as unknown as PoolClient;
  // A failed transaction rolls back the codes it stored, as PostgreSQL does.
  const database = { withSystemTransaction: jest.fn(async (_correlation: string,
    work: (client: PoolClient) => Promise<unknown>) => {
    const stored = challenges.length;
    try { return await work(client); } catch (error) { challenges.splice(stored); throw error; }
  }) } as unknown as DatabaseService;
  const provider = { assertAvailable: jest.fn().mockResolvedValue(undefined),
    isAvailable: jest.fn().mockResolvedValue(true), verifyNin: jest.fn().mockResolvedValue(identity) };
  const notification = { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'test_sms' }) };
  const protector = { lookup: jest.fn().mockReturnValue('a'.repeat(64)) };
  const hidCodes = { generate: jest.fn().mockReturnValue('HID-TEST-00000001') };
  const google = { bindPendingInTransaction: jest.fn().mockResolvedValue(undefined),
    consumePendingInTransaction: jest.fn().mockResolvedValue(undefined) };
  const service = new PatientEnrollmentService(database, protector as unknown as NinIdentifierProtector,
    identityProvider ?? provider as PublicPatientIdentityProvider, notification as unknown as NotificationOtpClient,
    hidCodes as unknown as HidCodeGenerator, google as unknown as GoogleAuthenticationService);
  return { service, client, queries, provider, notification, protector, google, otpRates, holderCalls,
    enrollments,
    get enrollment() { return enrollment; }, get challenge() { return challenges.at(-1); },
    challenges,
    set holderSendAllowed(value: boolean) { holderSendAllowed = value; },
    set holderProofOutcome(value: string) { holderProofOutcome = value; },
    set participating(value: Record<string, unknown>[]) { participating = value; },
    set facilityProof(value: unknown) { facilityProof = value; },
    set bound(value: boolean) { bound = value; },
    set contactBound(value: boolean) { contactBound = value; },
    set ready(value: boolean) { ready = value; },
    set rateCount(value: number) { rateCount = value; },
    set activationFailure(value: unknown) { activationFailure = value; } };
}

function passwordHash(): jest.Mock { return argon2.hash as unknown as jest.Mock; }

/**
 * Proves that the caller holds the NIN with the code sent to the registry
 * phone (0093), then forgets that delivery, so a test's first delivery is
 * its own.
 */
async function proveHolder(f: ReturnType<typeof fixture>, cookie: string, ip = '203.0.113.10') {
  const sent = await f.service.sendHolderCode(cookie, ip, correlationId);
  const delivered = f.notification.deliver.mock.calls.at(-1)?.[0] as { code: string };
  await f.service.verifyHolderCode(cookie, sent.challengeId, delivered.code, correlationId);
  f.notification.deliver.mockClear();
}

/** A started enrollment whose holder is proved, at the contact step. */
async function provenStart(f: ReturnType<typeof fixture>, key = requestKey, ip = '203.0.113.10',
  googleCookie?: string) {
  const started = await f.service.start(nin, key, ip, correlationId, googleCookie);
  await proveHolder(f, started.cookie, ip);
  return started;
}

/** An enrollment whose contact is verified, ready for its password. */
async function verifiedEnrollment(f: ReturnType<typeof fixture>) {
  const started = await provenStart(f);
  const contact = await f.service.startContact(started.cookie, 'email', 'patient@example.test',
    '203.0.113.10', correlationId);
  const deliveredCode = f.notification.deliver.mock.calls[0]?.[0].code as string;
  await f.service.verifyContact(started.cookie, contact.challengeId, deliveredCode, correlationId);
  return started.cookie;
}

/** The fields activation may carry for a NIN record that lacks them (ADR-061). */
type SelfReportedProfile = { dateOfBirth?: string;
  gender?: 'female' | 'male' | 'intersex' | 'other' | 'unknown' };
/** Activation with self-reported fields, through the service's own method. */
function activateWith(f: ReturnType<typeof fixture>, cookie: string, profile: SelfReportedProfile,
  password = 'a-strong-test-password') {
  const activate = f.service.activate as (cookie: string | undefined, password: string,
    correlationId: string, googleCookie: string | undefined,
    profile: SelfReportedProfile) => Promise<{ stage: 'active'; hidCode: string }>;
  return activate.call(f.service, cookie, password, correlationId, undefined, profile);
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
      // The online holder route (ADR-062) is on unless a test turns it off.
      NIN_HOLDER_SMS_ENABLED: 'true',
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

  it('starts with NIN alone at the holder step and stores opaque encrypted evidence', async () => {
    const f = fixture();
    const result = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);

    expect(f.provider.verifyNin).toHaveBeenCalledWith(nin,
      { correlationId, networkDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // ADR-062: the holder step first; no registry value, masked digit or
    // required profile field before the proof.
    expect(result.progress).toEqual({ stage: 'verify_holder', expiresAt: expect.any(String),
      googleOnboardingRequired: false, online: { available: true }, facility: { available: false } });
    expect(result.cookie).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const insert = f.queries.find(({ sql }) => sql.includes('insert into identity.public_patient_enrollments'))!;
    // The runtime inserts the start columns only: the state is the verify_holder default.
    expect(insert.sql).not.toMatch(/\bstate\b/);
    expect(insert.values[2]).toBe('8901');
    expect(insert.values[3]).toBeInstanceOf(Buffer);
    expect(insert.values[4]).toBeInstanceOf(Buffer);
    expect(JSON.stringify(f.queries.map(({ values }) => values.map((value) => Buffer.isBuffer(value)
      ? value.toString('hex') : value)))).not.toContain(nin);
    expect((insert.values[4] as Buffer).toString('utf8')).not.toContain('Amina');
    expect(JSON.stringify(result)).not.toMatch(/08076543210|7654|3210|Amina|Okafor/);
  });

  it('replays the same idempotency key without another provider call; another key starts another enrollment', async () => {
    const f = fixture();
    const first = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
    const replay = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
    expect(replay.cookie).toBe(first.cookie);
    expect(replay.progress).toMatchObject({ stage: 'verify_holder', online: { available: true } });
    expect(f.provider.verifyNin).toHaveBeenCalledTimes(1);
    // A start never answers NIN_ALREADY_REGISTERED (ADR-062): another key for
    // the same NIN is another enrollment, after another lookup.
    const second = await f.service.start(nin, '49ebcc73-3aa3-47aa-b1e4-f8944ab6eab0',
      '203.0.113.10', correlationId);
    expect(second.cookie).not.toBe(first.cookie);
    expect(f.provider.verifyNin).toHaveBeenCalledTimes(2);
    expect(f.enrollments.size).toBe(2);
  });

  it('settles two simultaneous starts with one key by resuming the one the database kept', async () => {
    const f = fixture();
    let releaseVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
    f.provider.verifyNin.mockImplementation(async () => {
      if (f.provider.verifyNin.mock.calls.length === 2) releaseVerification();
      await verificationGate;
      return identity;
    });
    const attempts = await Promise.all([
      f.service.start(nin, requestKey, '203.0.113.10', correlationId),
      f.service.start(nin, requestKey, '203.0.113.11', correlationId),
    ]);
    expect(attempts[0]?.cookie).toBe(attempts[1]?.cookie);
    expect(f.enrollments.size).toBe(1);
    expect(f.provider.verifyNin).toHaveBeenCalledTimes(2);
  });

  it('answers 503 ENROLLMENT_UNAVAILABLE, never NIN_ALREADY_REGISTERED, for any other unique violation at start', async () => {
    const f = fixture();
    const original = (f.client.query as unknown as jest.Mock).getMockImplementation()!;
    (f.client.query as unknown as jest.Mock).mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('insert into identity.public_patient_enrollments')) {
        throw Object.assign(new Error('duplicate'), { code: '23505', constraint: 'public_patient_enrollments_proven_nin_uq' });
      }
      return original(sql, values);
    });
    await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
      .rejects.toMatchObject({ status: 503, code: 'ENROLLMENT_UNAVAILABLE' });
  });

  it('rejects a retry key reused with a different NIN before provider verification', async () => {
    const f = fixture();
    f.protector.lookup.mockImplementation((value: string) => value === nin ? 'a'.repeat(64) : 'b'.repeat(64));
    await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
    await expect(f.service.start('98765432109', requestKey, '203.0.113.10', correlationId))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(f.provider.verifyNin).toHaveBeenCalledTimes(1);
  });

  it('never reads whether the NIN is bound or pending at start', async () => {
    const f = fixture();
    f.bound = true;
    await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
      .resolves.toMatchObject({ progress: { stage: 'verify_holder' } });
    expect(f.queries.some(({ sql }) => sql.includes('public_patient_nin_already_bound'))).toBe(false);
    expect(f.queries.some(({ sql }) => sql.includes('where nin_lookup_hmac'))).toBe(false);
    // The gate is checked first.
    expect(f.provider.assertAvailable.mock.invocationCallOrder[0])
      .toBeLessThan((f.client.query as unknown as jest.Mock).mock.invocationCallOrder[0] ?? 0);
  });

  it.each([
    ['QOREID_PROVIDER_RESPONSE_INVALID', 502], ['QOREID_PROVIDER_UNAVAILABLE', 503], ['QOREID_TIMEOUT', 504],
  ])('shows one fixed patient text when the lookup fails with %s', async (code, status) => {
    const f = fixture();
    f.provider.verifyNin.mockRejectedValue(new DomainProblem(status, code, 'internal detail'));
    const refusal = await f.service.start(nin, requestKey, '203.0.113.10', correlationId).catch((error) => error);
    expect(refusal).toBeInstanceOf(PublicDetailProblem);
    expect(refusal).toMatchObject({ code, status, message: 'We could not check your NIN now. Try again later.' });
  });

  it('refuses a start with 503 PATIENT_REGISTRATION_NOT_OPEN before QoreID when no ownership route is open', async () => {
    Object.assign(process.env, { NIN_HOLDER_SMS_ENABLED: 'false', ASSISTED_REGISTRATION_ENABLED: 'true' });
    resetEnvironmentForTests();
    const f = fixture();
    const refusal = await f.service.start(nin, requestKey, '203.0.113.10', correlationId).catch((error) => error);
    expect(refusal).toBeInstanceOf(PublicDetailProblem);
    expect(refusal).toMatchObject({ status: 503, code: 'PATIENT_REGISTRATION_NOT_OPEN',
      message: 'New Health ID registration is not open yet. If you already have a Health ID, sign in.' });
    expect(f.provider.assertAvailable).not.toHaveBeenCalled();
    expect(f.provider.verifyNin).not.toHaveBeenCalled();
    // The facility flag is on, but no facility takes part (ADR-063): the one
    // read asks only that, of no NIN.
    expect(f.queries.map(({ sql }) => sql)).toEqual([
      'select exists(select 1 from identity.list_participating_facilities()) as open']);
    await expect(f.service.availability()).resolves.toEqual({ open: false, online: false, facility: false });
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
    const started = await provenStart(f);
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
    const started = await provenStart(f);
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
      .resolves.toEqual({ stage: 'set_password', requiredProfileFields: [] });
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
    const started = await provenStart(f, requestKey, '203.0.113.10', googleCookie);
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
      'select * from identity.activate_public_patient_enrollment($1,$2,$3,$4,$5,$6,$7,$8,$9)',
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
    const started = await provenStart(f, requestKey, '203.0.113.10', googleCookie);
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
    const started = await provenStart(f);
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
    const started = await provenStart(f);
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
      const started = await provenStart(f);
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
      // challenges[0] is the holder code (0093); [1] the first contact code.
      expect(f.challenges[1]?.invalidated_at).toBeInstanceOf(Date);
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
        .resolves.toEqual({ stage: 'set_password', requiredProfileFields: [] });
    });

    it('keys one budget on the recipient alone, across enrollments and networks, never on the client IP', async () => {
      const otpRates = new Map<string, OtpRateRow>();
      const [a, b, other] = [fixture(otpRates), fixture(otpRates), fixture(otpRates)];
      const startedA = await provenStart(a);
      const contactA = await a.service.startContact(startedA.cookie, 'email', 'patient@example.test',
        '203.0.113.10', correlationId);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await refusesCode(a, startedA.cookie, contactA.challengeId, wrong(lastCode(a)));
      }
      // Another enrollment, from another network, with the same contact written differently.
      const startedB = await provenStart(b, requestKey, '198.51.100.7');
      const contactB = await b.service.startContact(startedB.cookie, 'email', '  Patient@Example.TEST ',
        '198.51.100.7', correlationId);
      expect(b.challenge?.recipient_hmac).toBe(a.challenge?.recipient_hmac);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await refusesCode(b, startedB.cookie, contactB.challengeId, wrong(lastCode(b)));
      }
      await refusesCode(b, startedB.cookie, contactB.challengeId, lastCode(b));
      expect(b.enrollment?.state).toBe('verify_contact');

      // Another recipient keeps its own budget.
      const startedOther = await provenStart(other);
      const contactOther = await other.service.startContact(startedOther.cookie, 'email',
        'someone-else@example.test', '203.0.113.10', correlationId);
      await expect(other.service.verifyContact(startedOther.cookie, contactOther.challengeId,
        lastCode(other), correlationId)).resolves.toEqual({ stage: 'set_password', requiredProfileFields: [] });

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
      const started = await provenStart(f);
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
      // The holder code and the one contact code (0093).
      expect(f.challenges).toHaveLength(2);
      await expect(f.service.startContact(started.cookie, 'phone', '08012345678',
        '203.0.113.10', correlationId)).resolves.toMatchObject({ challengeId: expect.any(String) });
      expect(f.notification.deliver).toHaveBeenCalledTimes(2);
    });

    it('touches no budget for an unknown or expired challenge', async () => {
      const f = fixture();
      const started = await provenStart(f);
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
      const started = await provenStart(f);
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
      const started = await provenStart(f);
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
    const started = await provenStart(f);
    const phone = await f.service.startContact(started.cookie, 'phone', '08012345678',
      '203.0.113.10', correlationId);
    const phoneCode = f.notification.deliver.mock.calls[0]?.[0].code as string;
    const email = await f.service.startContact(started.cookie, 'email', 'Patient@Example.test',
      '203.0.113.10', correlationId);
    const emailCode = f.notification.deliver.mock.calls[1]?.[0].code as string;

    // challenges[0] is the holder code (0093); [1] the phone contact code.
    expect(f.challenges[1]?.invalidated_at).toBeInstanceOf(Date);
    expect(f.notification.deliver).toHaveBeenLastCalledWith(expect.objectContaining({
      channel: 'email', recipient: 'patient@example.test', challengeId: email.challengeId,
    }));
    await expect(f.service.verifyContact(started.cookie, phone.challengeId, phoneCode, correlationId))
      .rejects.toMatchObject({ code: 'OTP_INVALID' });
    await expect(f.service.verifyContact(started.cookie, email.challengeId, emailCode, correlationId))
      .resolves.toEqual({ stage: 'set_password', requiredProfileFields: [] });
    expect(f.enrollment?.contact_channel).toBe('email');
    await expect(f.service.activate(started.cookie, 'a-strong-test-password', correlationId))
      .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001' });
    const activation = f.queries.find(({ sql }) => sql.includes('identity.activate_public_patient_enrollment'))!;
    expect(activation.values[3]).toBe('patient@example.test');
  });

  it('does not accept replay of a consumed contact challenge', async () => {
    const f = fixture();
    const started = await provenStart(f);
    const contact = await f.service.startContact(started.cookie, 'email', 'patient@example.test',
      '203.0.113.10', correlationId);
    const deliveredCode = f.notification.deliver.mock.calls[0]?.[0].code as string;

    await expect(f.service.verifyContact(started.cookie, contact.challengeId, deliveredCode, correlationId))
      .resolves.toEqual({ stage: 'set_password', requiredProfileFields: [] });
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
      const started = await provenStart(f);
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

  // IP-1: the enrollment IP limits are keyed on the client network. In AWS
  // request.ip is the client only when the edge supplied it (the Worker's
  // X-Real-IP, applied by the gateway's realip module); otherwise it is
  // the load balancer, inside TRUST_PROXY_CIDRS, and shared by every client.
  describe('client network', () => {
    const vpc = '10.40.0.0/16';
    function inProduction() {
      const base = getEnvironment();
      jest.spyOn(environment, 'getEnvironment').mockReturnValue({ ...base, NODE_ENV: 'production', TRUST_PROXY_CIDRS: vpc });
    }
    const ipBuckets = (queries: RecordedQuery[]) => rateLookups(queries)
      .filter(({ scope }) => scope === 'ip').map(({ bucket }) => String(bucket));

    it('in production, refuses a start whose client address is missing or one of our proxies, before any database work', async () => {
      inProduction();
      const f = fixture();
      for (const remoteIp of [undefined, 'not-an-address', '10.40.1.10', '::ffff:10.40.200.3']) {
        await expect(f.service.start(nin, requestKey, remoteIp, correlationId))
          .rejects.toMatchObject({ status: 503, code: 'ENROLLMENT_RATE_LIMIT_UNAVAILABLE' });
      }
      expect(f.queries).toEqual([]);
      expect(f.provider.verifyNin).not.toHaveBeenCalled();
    });

    it('in production, refuses a contact step from one of our proxies before charging or sending', async () => {
      inProduction();
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '198.51.100.40', correlationId);
      f.queries.length = 0;
      await expect(f.service.startContact(started.cookie, 'email', 'patient@example.test', '10.40.1.10', correlationId))
        .rejects.toMatchObject({ status: 503, code: 'ENROLLMENT_RATE_LIMIT_UNAVAILABLE' });
      expect(f.queries).toEqual([]);
      expect(f.notification.deliver).not.toHaveBeenCalled();
    });

    it('gives two clients two buckets and one IPv6 /64 one bucket', async () => {
      inProduction();
      const buckets: string[] = [];
      for (const remoteIp of ['198.51.100.1', '198.51.100.2', '2001:db8:1:2::10', '2001:db8:1:2:abcd::99',
        '2001:db8:1:3::10']) {
        const f = fixture();
        await f.service.start(nin, requestKey, remoteIp, correlationId);
        buckets.push(...ipBuckets(f.queries));
      }
      expect(buckets).toHaveLength(5);
      expect(buckets[0]).not.toBe(buckets[1]);
      expect(buckets[2]).toBe(buckets[3]);
      expect(buckets[4]).not.toBe(buckets[2]);
      expect(new Set(buckets).size).toBe(4);
    });

    it('limits starts per network with PATIENT_ENROLLMENT_START_RATE_MAX_REQUESTS, apart from the OTP limit', async () => {
      process.env.PATIENT_ENROLLMENT_START_RATE_MAX_REQUESTS = '2';
      process.env.OTP_RATE_MAX_REQUESTS = '5';
      resetEnvironmentForTests();
      const limited = fixture();
      limited.rateCount = 2;
      await expect(limited.service.start(nin, requestKey, '198.51.100.7', correlationId))
        .rejects.toMatchObject({ status: 429, code: 'ENROLLMENT_RATE_LIMITED' });
      expect(limited.provider.verifyNin).not.toHaveBeenCalled();
      const allowed = fixture();
      allowed.rateCount = 1;
      await expect(allowed.service.start(nin, requestKey, '198.51.100.7', correlationId)).resolves.toBeDefined();
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
          .resolves.toMatchObject({ stage: 'verify_holder' });
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

    // FE-4: GET /identity/patient-enrollments/availability answers from the
    // checks start makes before it reads a NIN, so a client can say that
    // registration is not open before it asks for one.

    it.each(closures)('answers availability closed while %s, as start refuses, reading and charging nothing',
      async (_label, closed, pause, status, code) => {
        Object.assign(process.env, open); resetEnvironmentForTests();
        const { f, adapter, integrations, pause: pauseQoreId } = gated();
        await expect(f.service.availability()).resolves.toEqual({ open: true, online: true, facility: false });
        Object.assign(process.env, closed); resetEnvironmentForTests();
        if (pause) pauseQoreId();
        await expect(f.service.availability()).resolves.toEqual({ open: false, online: true, facility: false });
        expect(f.queries).toEqual([]);
        await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
          .rejects.toMatchObject({ status, code });
        expect(f.queries).toEqual([]);
        expect(adapter.verifyNinEnrollment).not.toHaveBeenCalled();
        expect(integrations.consumePublicPatientNinQuota).not.toHaveBeenCalled();
      });

    it('answers availability closed while the enrollment keys are not configured, as start refuses', async () => {
      Object.assign(process.env, open); resetEnvironmentForTests();
      delete process.env.NIN_ENCRYPTION_KEY_B64; resetEnvironmentForTests();
      const { f, integrations } = gated();
      await expect(f.service.availability()).resolves.toEqual({ open: false, online: true, facility: false });
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
      await expect(f.service.availability()).rejects.toMatchObject({ status: 503, code: 'INTEGRATION_UNAVAILABLE' });
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

    it('charges the lookup only on the path that calls QoreID: never on a resume or a refusal', async () => {
      const f = fixture();
      f.protector.lookup.mockImplementation((value: string) => value === nin ? 'a'.repeat(64) : 'b'.repeat(64));
      await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      expect(f.provider.verifyNin).toHaveBeenCalledTimes(1);
      expect(f.provider.verifyNin).toHaveBeenLastCalledWith(nin,
        { correlationId, networkDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
      // A same-key resume and the key reused for another NIN ask QoreID nothing.
      await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      await expect(f.service.start('98765432109', requestKey, '203.0.113.10', correlationId))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      expect(f.provider.verifyNin).toHaveBeenCalledTimes(1);
      // Another key for the same NIN is another enrollment and another charged lookup (ADR-062).
      await f.service.start(nin, '49ebcc73-3aa3-47aa-b1e4-f8944ab6eab0', '203.0.113.10', correlationId);
      expect(f.provider.verifyNin).toHaveBeenCalledTimes(2);
      // A rate-limited client asks nothing.
      f.rateCount = 5;
      await expect(f.service.start('98765432109', '5f0bd2a4-63c4-4f43-9f6f-0b8f7f1e2a10', '203.0.113.10',
        correlationId)).rejects.toMatchObject({ code: 'ENROLLMENT_RATE_LIMITED' });
      expect(f.provider.verifyNin).toHaveBeenCalledTimes(2);
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

  // ADR-061: QoreID may return only the name, the NIN and its reference. The
  // patient enters a missing date of birth or gender at activation; a field the
  // NIN record provided can never be replaced.
  describe('a NIN record without a date of birth or gender', () => {
    const { dateOfBirth: _dateOfBirth, gender: _gender, ...withoutBoth } = identity;
    const { dateOfBirth: _onlyDate, ...withoutDate } = identity;
    const { gender: _onlyGender, ...withoutGender } = identity;
    const activation = (queries: RecordedQuery[]) => queries
      .filter(({ sql }) => sql.includes('identity.activate_public_patient_enrollment'));

    async function sparseEnrollment(record: Record<string, unknown> = withoutBoth) {
      const f = fixture();
      f.provider.verifyNin.mockResolvedValue(record);
      const cookie = await verifiedEnrollment(f);
      f.queries.length = 0;
      return { f, cookie };
    }

    async function refusal(promise: Promise<unknown>) {
      const error = await promise.then(() => undefined, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(DomainProblem);
      const problem = error as DomainProblem;
      return { status: problem.getStatus(), code: problem.code, detail: problem.message };
    }

    it.each([
      ['a complete record', identity, []],
      ['a record without either', withoutBoth, ['dateOfBirth', 'gender']],
      ['a record without a date of birth', withoutDate, ['dateOfBirth']],
      ['a record without a gender', withoutGender, ['gender']],
    ] as const)('starts %s and answers the fields it lacks, never a profile value', async (_label, record, required) => {
      const f = fixture();
      f.provider.verifyNin.mockResolvedValue(record);
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      // No required profile field before the holder proof (ADR-062).
      expect(started.progress).toMatchObject({ stage: 'verify_holder' });
      expect(started.progress).not.toHaveProperty('requiredProfileFields');
      const sent = await f.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId);
      const holderCode = f.notification.deliver.mock.calls.at(-1)?.[0].code as string;
      const proved = await f.service.verifyHolderCode(started.cookie, sent.challengeId, holderCode, correlationId);
      expect(proved).toEqual({ stage: 'verify_contact', requiredProfileFields: required });
      f.notification.deliver.mockClear();
      for (const value of ['Amina', 'Okafor', '1990-01-02', 'female', nin]) {
        expect(JSON.stringify([started.progress, proved])).not.toContain(value);
      }
      // The resumed start, GET /current at each stage before activation and the
      // contact proof all answer the same list, read from the stored profile.
      const resumed = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      expect(resumed.progress).toMatchObject({ stage: 'verify_contact', requiredProfileFields: required });
      expect(f.provider.verifyNin).toHaveBeenCalledTimes(1);
      await expect(f.service.current(started.cookie, correlationId))
        .resolves.toMatchObject({ stage: 'verify_contact', requiredProfileFields: required });
      const contact = await f.service.startContact(started.cookie, 'email', 'patient@example.test',
        '203.0.113.10', correlationId);
      const code = f.notification.deliver.mock.calls[0]?.[0].code as string;
      await expect(f.service.current(started.cookie, correlationId))
        .resolves.toMatchObject({ stage: 'verify_contact', challengeId: contact.challengeId,
          requiredProfileFields: required });
      await expect(f.service.verifyContact(started.cookie, contact.challengeId, code, correlationId))
        .resolves.toEqual({ stage: 'set_password', requiredProfileFields: required });
      await expect(f.service.current(started.cookie, correlationId))
        .resolves.toMatchObject({ stage: 'set_password', requiredProfileFields: required });
    });

    it('stores the record as QoreID returned it, without the missing keys and without null', async () => {
      const { f, cookie } = await sparseEnrollment();
      await activateWith(f, cookie, { dateOfBirth: '1990-01-02', gender: 'female' });
      const profile = JSON.parse(activation(f.queries).at(-1)?.values[2] as string) as Record<string, unknown>;
      expect(profile).not.toHaveProperty('dateOfBirth');
      expect(profile).not.toHaveProperty('gender');
      expect(profile).toMatchObject({ nin, firstName: 'Amina', lastName: 'Okafor' });
    });

    it('never answers requiredProfileFields once the enrollment is active', async () => {
      const { f, cookie } = await sparseEnrollment();
      await activateWith(f, cookie, { dateOfBirth: '1990-01-02', gender: 'female' });
      Object.assign(f.enrollment!, { state: 'active', patient_id: 'patient-7', account_id: 'account-7' });
      const progress = await f.service.current(cookie, correlationId);
      expect(progress).toMatchObject({ stage: 'active', hidCode: 'HID-TEST-00000001' });
      expect(progress).not.toHaveProperty('requiredProfileFields');
    });

    it.each([
      ['a malformed date', { dateOfBirth: '01-02-1990' }],
      ['an impossible date', { dateOfBirth: '1990-02-30' }],
      ['a date before 1900', { dateOfBirth: '1899-12-31' }],
      ['a null date', { dateOfBirth: null }],
      ['a gender outside the list', { gender: 'F' }],
      ['a null gender', { gender: null }],
    ])('still refuses a record whose date of birth or gender is present but invalid: %s', async (_label, field) => {
      const f = fixture();
      f.provider.verifyNin.mockResolvedValue({ ...identity, ...field });
      await expect(f.service.start(nin, requestKey, '203.0.113.10', correlationId))
        .rejects.toMatchObject({ status: 502, code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
      expect(f.queries.some(({ sql }) => sql.includes('insert into identity.public_patient_enrollments'))).toBe(false);
    });

    it.each([
      [withoutBoth, {}, 'Enter your date of birth and gender'],
      [withoutBoth, { dateOfBirth: '1990-01-02' }, 'Enter your gender'],
      [withoutBoth, { gender: 'female' }, 'Enter your date of birth'],
      [withoutDate, {}, 'Enter your date of birth'],
      [withoutGender, {}, 'Enter your gender'],
    ] as const)('refuses a missing field with 400 ENROLLMENT_PROFILE_REQUIRED, before argon2id or the command (%#)',
      async (record, profile, detail) => {
        const { f, cookie } = await sparseEnrollment(record);
        const before = passwordHash().mock.calls.length;
        expect(await refusal(activateWith(f, cookie, profile)))
          .toEqual({ status: 400, code: 'ENROLLMENT_PROFILE_REQUIRED', detail });
        expect(passwordHash().mock.calls.length).toBe(before);
        expect(activation(f.queries)).toHaveLength(0);
        // Charged to the activation budget, as every attempt past the stage check is.
        expect(rateLookups(f.queries)).toEqual([{ scope: 'enrollment', bucket: expect.any(String) }]);
        expect(f.enrollment?.state).toBe('set_password');
      });

    it.each([
      [identity, { dateOfBirth: '1990-01-02' }, 'Your date of birth comes from your NIN record and cannot be changed here'],
      [identity, { gender: 'male' }, 'Your gender comes from your NIN record and cannot be changed here'],
      [identity, { dateOfBirth: '1990-01-02', gender: 'female' },
        'Your date of birth and gender come from your NIN record and cannot be changed here'],
      [withoutDate, { dateOfBirth: '1990-01-02', gender: 'female' },
        'Your gender comes from your NIN record and cannot be changed here'],
      [withoutGender, { dateOfBirth: '1985-06-07', gender: 'male' },
        'Your date of birth comes from your NIN record and cannot be changed here'],
    ] as const)('refuses a field the NIN record provided with 400 ENROLLMENT_PROFILE_FIELD_VERIFIED (%#)',
      async (record, profile, detail) => {
        const { f, cookie } = await sparseEnrollment(record);
        const before = passwordHash().mock.calls.length;
        expect(await refusal(activateWith(f, cookie, profile)))
          .toEqual({ status: 400, code: 'ENROLLMENT_PROFILE_FIELD_VERIFIED', detail });
        expect(passwordHash().mock.calls.length).toBe(before);
        expect(activation(f.queries)).toHaveLength(0);
      });

    it.each(['1899-12-31', '1990-02-30', '1990-13-01', '0000-00-00', 'not-a-date'])
    ('refuses a date of birth that is not a real date from 1900-01-01 to today: %s', async (dateOfBirth) => {
      const { f, cookie } = await sparseEnrollment();
      const before = passwordHash().mock.calls.length;
      expect(await refusal(activateWith(f, cookie, { dateOfBirth, gender: 'female' }))).toEqual({
        status: 400, code: 'DATE_OF_BIRTH_INVALID',
        detail: 'Enter a real date of birth. It cannot be before 1 January 1900 or in the future.' });
      expect(passwordHash().mock.calls.length).toBe(before);
      expect(activation(f.queries)).toHaveLength(0);
    });

    it('refuses tomorrow and accepts today and 1900-01-01', async () => {
      const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
      const { f, cookie } = await sparseEnrollment();
      expect((await refusal(activateWith(f, cookie, { dateOfBirth: day(1), gender: 'other' }))).code)
        .toBe('DATE_OF_BIRTH_INVALID');
      for (const dateOfBirth of [day(0), '1900-01-01']) {
        const accepted = await sparseEnrollment();
        await expect(activateWith(accepted.f, accepted.cookie, { dateOfBirth, gender: 'other' }))
          .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001' });
        expect(activation(accepted.f.queries).at(-1)?.values.slice(7)).toEqual([dateOfBirth, 'other']);
      }
    });

    it('passes the entered fields to the activation command as $8 and $9', async () => {
      const { f, cookie } = await sparseEnrollment();
      await expect(activateWith(f, cookie, { dateOfBirth: '1990-01-02', gender: 'female' }))
        .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001' });
      const command = activation(f.queries);
      expect(command).toHaveLength(1);
      expect(command[0]?.sql).toBe('select * from identity.activate_public_patient_enrollment($1,$2,$3,$4,$5,$6,$7,$8,$9)');
      expect(command[0]?.values.slice(7)).toEqual(['1990-01-02', 'female']);
      expect(command[0]?.values[5]).toBe(PASSWORD_HASH);
    });

    it.each([
      [withoutDate, { dateOfBirth: '1990-01-02' }, ['1990-01-02', null]],
      [withoutGender, { gender: 'intersex' }, [null, 'intersex']],
      [identity, {}, [null, null]],
    ] as const)('passes null for a field the NIN record provided (%#)', async (record, profile, passed) => {
      const { f, cookie } = await sparseEnrollment(record);
      await activateWith(f, cookie, profile);
      expect(activation(f.queries).at(-1)?.values.slice(7)).toEqual(passed);
    });

    it('passes null for both when the password is sent alone for a complete record', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      await f.service.activate(cookie, 'a-strong-test-password', correlationId);
      expect(activation(f.queries).at(-1)?.values.slice(7)).toEqual([null, null]);
    });

    it('lets a replay of an active enrollment ignore the fields, whatever they are', async () => {
      const { f, cookie } = await sparseEnrollment();
      await activateWith(f, cookie, { dateOfBirth: '1990-01-02', gender: 'female' });
      Object.assign(f.enrollment!, { state: 'active', patient_id: 'patient-7', account_id: 'account-7' });
      for (const profile of [{}, { dateOfBirth: '2999-01-01' }, { dateOfBirth: '1991-03-04', gender: 'male' as const }]) {
        f.queries.length = 0;
        await expect(activateWith(f, cookie, profile))
          .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST-00000001' });
        expect(activation(f.queries).at(-1)?.values.slice(7)).toEqual([null, null]);
      }
    });

    it('checks the password, stage, contact proof and budget first', async () => {
      const { f, cookie } = await sparseEnrollment();
      await expect(activateWith(f, cookie, {}, 'short')).rejects.toMatchObject({ code: 'PASSWORD_INVALID' });
      f.rateCount = getEnvironment().OTP_RATE_MAX_REQUESTS * 3;
      await expect(activateWith(f, cookie, {})).rejects.toMatchObject({ status: 429, code: 'ENROLLMENT_RATE_LIMITED' });
      f.rateCount = 0;
      f.enrollment!.contact_verified_at = new Date(Date.now() - 31 * 60_000);
      await expect(activateWith(f, cookie, {}))
        .rejects.toMatchObject({ status: 409, code: 'ENROLLMENT_CONTACT_REVERIFY_REQUIRED' });
      // Back at the contact step, the stage refusal comes first.
      await expect(activateWith(f, cookie, {}))
        .rejects.toMatchObject({ status: 409, code: 'ENROLLMENT_STAGE_INVALID' });
      expect(activation(f.queries)).toHaveLength(0);
    });
  });

  describe('holder proof by the registry phone (ADR-062)', () => {
    type Fixture = ReturnType<typeof fixture>;
    const lastDelivery = (f: Fixture) => f.notification.deliver.mock.calls.at(-1)?.[0] as
      { code: string; recipient: string; purpose: string; channel: string; challengeId: string };
    const holderSql = (f: Fixture) => f.queries.map(({ sql }) => sql);
    const routeUnavailable = 'We cannot send a code to the phone on your NIN record. Use a participating facility to register.';

    it.each([
      ['08031234567', '+2348031234567'], ['2348031234567', '+2348031234567'], ['+2348031234567', '+2348031234567'],
      ['0803 123 4567', '+2348031234567'], ['+234 (803) 123-4567', '+2348031234567'], ['234-803-123-4567', '+2348031234567'],
    ])('normalizes the registry phone %s to %s', (raw, normalized) => {
      expect(normalizeRegistryPhone(raw)).toBe(normalized);
    });

    it.each([[undefined], [null], [''], [8031234567], [{ phone: '08031234567' }], ['0803123456'], ['080312345678'],
      ['+2358031234567'], ['+44 7700 900123'], ['0803-123-456a'], ['80312345678']])(
      'treats the registry phone %p as unusable', (raw) => {
        expect(normalizeRegistryPhone(raw)).toBeNull();
      });

    it('treats a registry date of birth under 18 years as a minor, and an absent one as not shown', () => {
      const now = new Date('2026-10-15T12:00:00Z');
      expect(underEighteen('2008-10-15', now)).toBe(false);
      expect(underEighteen('2008-10-16', now)).toBe(true);
      expect(underEighteen('2015-01-01', now)).toBe(true);
      expect(underEighteen('1990-01-02', now)).toBe(false);
      expect(underEighteen(undefined, now)).toBe(false);
      expect(underEighteen('not-a-date', now)).toBe(false);
    });

    it('shows only route availability before a code, then the open code’s timing, never a registry value', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      await expect(f.service.current(started.cookie, correlationId)).resolves.toEqual({
        stage: 'verify_holder', expiresAt: expect.any(String), googleOnboardingRequired: false,
        online: { available: true }, facility: { available: false } });
      const sent = await f.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId);
      const progress = await f.service.current(started.cookie, correlationId);
      expect(progress).toEqual({ stage: 'verify_holder', expiresAt: expect.any(String),
        googleOnboardingRequired: false, facility: { available: false },
        online: { available: true, challengeId: sent.challengeId, expiresInSeconds: expect.any(Number),
          resendAfterSeconds: expect.any(Number) } });
      expect(JSON.stringify(progress)).not.toMatch(/0807|3210|\+234|Amina|Okafor|1990|requiredProfileFields|masked/);
    });

    it('sends a six-digit code by SMS to the normalized registry phone, storing only digests', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      f.queries.length = 0;
      const sent = await f.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId);
      expect(sent).toEqual({ challengeId: expect.any(String), expiresInSeconds: 300, resendAfterSeconds: 60 });
      const delivery = lastDelivery(f);
      expect(delivery).toMatchObject({ recipient: '+2348076543210', channel: 'sms', purpose: 'NIN_HOLDER_VERIFY',
        challengeId: sent.challengeId });
      expect(delivery.code).toMatch(/^\d{6}$/);
      const challenge = f.challenge!;
      expect(challenge).toMatchObject({ purpose: 'nin_holder', channel: 'phone', id: sent.challengeId });
      expect(challenge.recipient_hmac).toMatch(/^[0-9a-f]{64}$/);
      expect(f.enrollment?.holder_recipient_hmac).toBe(challenge.recipient_hmac);
      expect(challenge.verifier_hmac).toMatch(/^[0-9a-f]{64}$/);
      // The send budgets are checked by the database command, with the configured limits.
      const send = f.holderCalls.find(({ command }) => command === 'send')!;
      expect(send.values).toEqual([f.enrollment?.id, f.enrollment?.token_hmac, expect.stringMatching(/^[0-9a-f]{64}$/),
        5, 10, 30]);
      expect(send.values[2]).not.toBe(f.enrollment?.nin_lookup_hmac);
      // Neither the raw nor the normalized phone, nor the code, reaches the database.
      const written = JSON.stringify(f.queries.map(({ values }) => values));
      for (const value of ['08076543210', '+2348076543210', delivery.code]) expect(written).not.toContain(value);
      // The NIN lock before the enrollment row lock (ADR-062).
      const sqls = holderSql(f);
      const located = sqls.findIndex((sql) => sql.includes('select nin_lookup_hmac from identity.public_patient_enrollments'));
      const ninLock = sqls.findIndex((sql) => sql.includes("hashtextextended('patient-nin:' || $1, 0)"));
      const rowLock = sqls.findIndex((sql) => sql.includes('from identity.public_patient_enrollments where id=$1 for update'));
      expect(located).toBeGreaterThanOrEqual(0);
      expect(ninLock).toBeGreaterThan(located);
      expect(rowLock).toBeGreaterThan(ninLock);
    });

    it.each([
      ['the record has no phone', { phoneNumber: undefined }, 409],
      ['the registry phone is unusable', { phoneNumber: '12345' }, 409],
      ['the registry date of birth shows a minor', { dateOfBirth: `${new Date().getUTCFullYear() - 17}-01-01` }, 409],
    ])('refuses the send with one text and online.available false when %s', async (_label, change, status) => {
      const f = fixture();
      f.provider.verifyNin.mockResolvedValue({ ...identity, ...change });
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      expect(started.progress).toMatchObject({ online: { available: false } });
      await expect(f.service.current(started.cookie, correlationId))
        .resolves.toMatchObject({ stage: 'verify_holder', online: { available: false } });
      await expect(f.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId))
        .rejects.toMatchObject({ status, code: 'NIN_HOLDER_ROUTE_UNAVAILABLE', message: routeUnavailable });
      expect(f.notification.deliver).not.toHaveBeenCalled();
      expect(f.holderCalls).toEqual([]);
    });

    it('refuses the send with the same text while the online route is off, and outside the holder step', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      Object.assign(process.env, { NIN_HOLDER_SMS_ENABLED: 'false', ASSISTED_REGISTRATION_ENABLED: 'true' });
      resetEnvironmentForTests();
      const off = fixture();
      off.enrollments.set(String(f.enrollment!.id), f.enrollment!);
      await expect(off.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId))
        .rejects.toMatchObject({ status: 503, code: 'NIN_HOLDER_ROUTE_UNAVAILABLE', message: routeUnavailable });
      await expect(off.service.current(started.cookie, correlationId))
        .resolves.toMatchObject({ online: { available: false } });
      Object.assign(process.env, { NIN_HOLDER_SMS_ENABLED: 'true' }); resetEnvironmentForTests();
      const on = fixture();
      on.enrollments.set(String(f.enrollment!.id), f.enrollment!);
      await proveHolder(on, started.cookie);
      await expect(on.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId))
        .rejects.toMatchObject({ status: 409, code: 'NIN_HOLDER_ROUTE_UNAVAILABLE', message: routeUnavailable });
    });

    it('keeps one open code with a resend cooldown, and sends at most three codes per enrollment', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const first = await f.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId);
      f.challenge!.created_at = new Date();
      await expect(f.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId))
        .rejects.toMatchObject({ status: 429, code: 'OTP_RESEND_COOLDOWN' });
      f.challenge!.created_at = new Date(Date.now() - 61_000);
      const second = await f.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId);
      expect(f.challenges.find(({ id }) => id === first.challengeId)?.invalidated_at).toBeInstanceOf(Date);
      expect(second.challengeId).not.toBe(first.challengeId);
      await f.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId);
      await expect(f.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId))
        .rejects.toMatchObject({ status: 429, code: 'NIN_HOLDER_ROUTE_LIMITED',
          message: 'Use a participating facility to register.' });
      expect(f.notification.deliver).toHaveBeenCalledTimes(3);
    });

    it('answers a 503 holder refusal with its fixed patient text through the problem filter', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      Object.assign(process.env, { NIN_HOLDER_SMS_ENABLED: 'false', ASSISTED_REGISTRATION_ENABLED: 'true' });
      resetEnvironmentForTests();
      const off = fixture();
      off.enrollments.set(String(f.enrollment!.id), f.enrollment!);
      const send = await off.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId)
        .catch((error) => error);
      const verify = await off.service.verifyHolderCode(started.cookie, '00000000-0000-4000-8000-000000000000',
        '000000', correlationId).catch((error) => error);
      for (const refusal of [send, verify]) {
        expect(refusal).toBeInstanceOf(PublicDetailProblem);
        expect(answered(refusal)).toMatchObject({ status: 503, code: 'NIN_HOLDER_ROUTE_UNAVAILABLE',
          detail: routeUnavailable });
      }
    });

    it('stores the new code before the send command, so the database counts its attempts', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      await f.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId);
      const sql = holderSql(f);
      const stored = sql.findIndex((statement) => statement.includes('insert into identity.public_patient_enrollment_otps'));
      const counted = sql.findIndex((statement) => statement.includes('identity.record_public_patient_holder_send'));
      expect(stored).toBeGreaterThanOrEqual(0);
      expect(counted).toBeGreaterThan(stored);
    });

    it('sends nothing when a send or failure budget is spent', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      f.holderSendAllowed = false;
      await expect(f.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId))
        .rejects.toMatchObject({ status: 429, code: 'NIN_HOLDER_ROUTE_LIMITED',
          message: 'Use a participating facility to register.' });
      expect(f.notification.deliver).not.toHaveBeenCalled();
      expect(f.challenges).toEqual([]);
    });

    it('counts a wrong code on the challenge and as a failure of the NIN, and closes the challenge after five', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const sent = await f.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId);
      const code = lastDelivery(f).code;
      const wrong = code === '000000' ? '000001' : '000000';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(f.service.verifyHolderCode(started.cookie, sent.challengeId, wrong, correlationId))
          .rejects.toMatchObject({ status: 422, code: 'OTP_INVALID' });
      }
      expect(f.challenge?.failed_attempts).toBe(5);
      expect(f.challenge?.invalidated_at).toBeInstanceOf(Date);
      const failures = f.holderCalls.filter(({ command }) => command === 'failure');
      expect(failures).toHaveLength(5);
      expect(failures[0]?.values).toEqual([f.enrollment?.id, f.enrollment?.token_hmac, sent.challengeId,
        expect.stringMatching(/^[0-9a-f]{64}$/), 10, 30]);
      await expect(f.service.verifyHolderCode(started.cookie, sent.challengeId, code, correlationId))
        .rejects.toMatchObject({ status: 422, code: 'OTP_INVALID' });
      expect(f.holderCalls.some(({ command }) => command === 'proof')).toBe(false);
      expect(f.enrollment?.state).toBe('verify_holder');
    });

    it('records a correct code through the proof command under the NIN lock and answers the contact step', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const sent = await f.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId);
      const code = lastDelivery(f).code;
      f.queries.length = 0;
      await expect(f.service.verifyHolderCode(started.cookie, sent.challengeId, code, correlationId))
        .resolves.toEqual({ stage: 'verify_contact', requiredProfileFields: [] });
      const proof = f.holderCalls.find(({ command }) => command === 'proof')!;
      expect(proof.values).toEqual([f.enrollment?.id, f.enrollment?.token_hmac, sent.challengeId,
        expect.stringMatching(/^[0-9a-f]{64}$/), 5]);
      const sqls = holderSql(f);
      const ninLock = sqls.findIndex((sql) => sql.includes("hashtextextended('patient-nin:' || $1, 0)"));
      const rowLock = sqls.findIndex((sql) => sql.includes('from identity.public_patient_enrollments where id=$1 for update'));
      const proofAt = sqls.findIndex((sql) => sql.includes('record_public_patient_holder_proof'));
      expect(ninLock).toBeGreaterThanOrEqual(0);
      expect(rowLock).toBeGreaterThan(ninLock);
      expect(proofAt).toBeGreaterThan(rowLock);
      // The same code cannot prove twice.
      await expect(f.service.verifyHolderCode(started.cookie, sent.challengeId, code, correlationId))
        .rejects.toMatchObject({ status: 422, code: 'OTP_INVALID' });
      expect(f.holderCalls.filter(({ command }) => command === 'proof')).toHaveLength(1);
    });

    it('refuses an expired code without a proof or a failure', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const sent = await f.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId);
      f.challenge!.expires_at = new Date(Date.now() - 1000);
      await expect(f.service.verifyHolderCode(started.cookie, sent.challengeId, lastDelivery(f).code, correlationId))
        .rejects.toMatchObject({ status: 422, code: 'OTP_INVALID' });
      expect(f.holderCalls.filter(({ command }) => command !== 'send')).toEqual([]);
    });

    it('checks readiness first and the online route, counting nothing', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const sent = await f.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId);
      f.ready = false;
      await expect(f.service.verifyHolderCode(started.cookie, sent.challengeId, '000000', correlationId))
        .rejects.toMatchObject({ status: 503, code: 'ENROLLMENT_RECONCILIATION_REQUIRED' });
      f.ready = true;
      Object.assign(process.env, { NIN_HOLDER_SMS_ENABLED: 'false', ASSISTED_REGISTRATION_ENABLED: 'true' });
      resetEnvironmentForTests();
      const off = fixture();
      off.enrollments.set(String(f.enrollment!.id), f.enrollment!);
      off.challenges.push(f.challenge!);
      await expect(off.service.verifyHolderCode(started.cookie, sent.challengeId, '000000', correlationId))
        .rejects.toMatchObject({ status: 503, code: 'NIN_HOLDER_ROUTE_UNAVAILABLE' });
      expect(f.challenge?.failed_attempts).toBe(0);
      expect([...f.holderCalls, ...off.holderCalls].filter(({ command }) => command !== 'send')).toEqual([]);
    });

    it.each([
      ['existing_identity', 409, 'NIN_ALREADY_REGISTERED', 'This NIN already has a Health ID. Use account recovery to sign in.'],
      ['facility_conflict', 409, 'NIN_HOLDER_PROOF_CONFLICT', 'Registration for this NIN is in progress at a facility.'],
      ['route_limited', 429, 'NIN_HOLDER_ROUTE_LIMITED', 'Use a participating facility to register.'],
    ])('answers a %s proof with %s %s', async (outcome, status, code, message) => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const sent = await f.service.sendHolderCode(started.cookie, '203.0.113.10', correlationId);
      f.holderProofOutcome = outcome;
      const refusal = await f.service.verifyHolderCode(started.cookie, sent.challengeId, lastDelivery(f).code,
        correlationId).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ status, code, message });
      expect(JSON.stringify(refusal)).not.toMatch(/HID-|patient-|account-|pending/);
    });

    it('refuses the contact step and activation before the holder proof', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      await expect(f.service.startContact(started.cookie, 'email', 'patient@example.test', '203.0.113.10',
        correlationId)).rejects.toMatchObject({ status: 409, code: 'ENROLLMENT_STAGE_INVALID' });
      await expect(f.service.activate(started.cookie, 'a-strong-test-password', correlationId))
        .rejects.toMatchObject({ status: 409, code: 'ENROLLMENT_STAGE_INVALID' });
      expect(f.notification.deliver).not.toHaveBeenCalled();
    });

    it('answers an activation the database refuses for its holder proof with 409 ENROLLMENT_HOLDER_PROOF_REQUIRED', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      f.activationFailure = Object.assign(new Error('PATIENT_HOLDER_PROOF_INVALID'), { code: '23514' });
      await expect(f.service.activate(cookie, 'a-strong-test-password', correlationId))
        .rejects.toMatchObject({ status: 409, code: 'ENROLLMENT_HOLDER_PROOF_REQUIRED' });
    });

    it('answers a NIN bound at activation with the recovery text, never "pending"', async () => {
      const f = fixture();
      const cookie = await verifiedEnrollment(f);
      f.activationFailure = Object.assign(new Error('PATIENT_NIN_ALREADY_BOUND'), { code: '23505' });
      const refusal = await f.service.activate(cookie, 'a-strong-test-password', correlationId)
        .catch((error: unknown) => error);
      expect(refusal).toMatchObject({ status: 409, code: 'NIN_ALREADY_REGISTERED',
        message: 'This NIN already has a Health ID. Use account recovery to sign in.' });
    });
  });

  // ADR-063: the facility route. The patient starts on their own device; at
  // the desk the phone shows a desk code; staff record an in-person check.
  describe('facility-assisted registration (ADR-063)', () => {
    const otpKey = Buffer.alloc(32, 3);
    const keyed = (...parts: string[]) => createHmac('sha256', otpKey).update(parts.join('\u001f'), 'utf8').digest('hex');
    const clinic = { name: 'Synthetic Clinic', address_line: '1 Synthetic Road', town: 'Ikeja', lga: 'Ikeja',
      state: 'Lagos', hours: 'Mon-Fri 08:00-16:00' };
    const whatToBring = ['Your own phone with this registration open',
      'One original photo ID: national ID card, international passport, driver\'s licence or voter\'s card',
      'A phone number or email that can receive codes now'];
    const facilityOnly = () => {
      Object.assign(process.env, { NIN_HOLDER_SMS_ENABLED: 'false', ASSISTED_REGISTRATION_ENABLED: 'true' });
      resetEnvironmentForTests();
    };

    it('opens the facility route only with the flag and a participating facility', async () => {
      facilityOnly();
      const f = fixture();
      f.participating = [clinic];
      await expect(f.service.availability()).resolves.toEqual({ open: true, online: false, facility: true });
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      expect(started.progress).toMatchObject({ stage: 'verify_holder', online: { available: false },
        facility: { available: true } });
      expect(started.progress).not.toHaveProperty('facility.deskCode');
      f.participating = [];
      await expect(f.service.availability()).resolves.toEqual({ open: false, online: false, facility: false });
      Object.assign(process.env, { ASSISTED_REGISTRATION_ENABLED: 'false', NIN_HOLDER_SMS_ENABLED: 'true' });
      resetEnvironmentForTests();
      const off = fixture();
      off.participating = [clinic];
      await expect(off.service.availability()).resolves.toEqual({ open: true, online: true, facility: false });
      expect(off.queries.filter(({ sql }) => sql.includes('list_participating_facilities'))).toEqual([]);
    });

    it('lists participating facilities by name and location only, with what to bring', async () => {
      facilityOnly();
      const f = fixture();
      f.participating = [clinic, { name: 'Synthetic Annex', address_line: null, town: 'Yaba', lga: 'Lagos Mainland',
        state: 'Lagos', hours: null }];
      await expect(f.service.participatingFacilities(correlationId)).resolves.toEqual({
        facilities: [{ name: 'Synthetic Clinic', addressLine: '1 Synthetic Road', town: 'Ikeja', lga: 'Ikeja',
          state: 'Lagos', hours: 'Mon-Fri 08:00-16:00' },
        { name: 'Synthetic Annex', town: 'Yaba', lga: 'Lagos Mainland', state: 'Lagos' }],
        whatToBring });
      Object.assign(process.env, { ASSISTED_REGISTRATION_ENABLED: 'false' }); resetEnvironmentForTests();
      const off = fixture();
      off.participating = [clinic];
      await expect(off.service.participatingFacilities(correlationId)).resolves.toEqual({ facilities: [], whatToBring });
      expect(off.queries).toEqual([]);
    });

    it('issues a desk code the cookie holder sees, stored only as its keyed digest', async () => {
      facilityOnly();
      const f = fixture();
      f.participating = [clinic];
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const issued = await f.service.issueDeskCode(started.cookie, correlationId);
      expect(issued).toMatchObject({ stage: 'verify_holder', facility: { available: true,
        deskCode: expect.stringMatching(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/),
        deskCodeExpiresAt: f.enrollment!.expires_at.toISOString() } });
      const code = issued.facility.deskCode as string;
      expect(f.enrollment!.desk_code_hmac).toBe(keyed('patient-enrollment-desk-code', code));
      expect(f.enrollment!.desk_code_salt).toMatch(/^[0-9a-f]{32}$/);
      expect(JSON.stringify(f.queries)).not.toContain(code);
      // The same code again for the cookie holder, from the salt and the cookie; never for another cookie.
      await expect(f.service.current(started.cookie, correlationId)).resolves.toMatchObject({
        facility: { available: true, deskCode: code } });
      const [id] = started.cookie.split('.');
      await expect(f.service.current(`${id}.${'A'.repeat(43)}`, correlationId))
        .rejects.toMatchObject({ status: 404, code: 'ENROLLMENT_NOT_FOUND' });
      // A new code replaces the old one; five per enrollment.
      const again = await f.service.issueDeskCode(started.cookie, correlationId);
      expect(again.facility.deskCode).not.toBe(code);
      expect(f.enrollment!.desk_code_hmac).toBe(keyed('patient-enrollment-desk-code', again.facility.deskCode as string));
      for (let n = 3; n <= 5; n += 1) await f.service.issueDeskCode(started.cookie, correlationId);
      await expect(f.service.issueDeskCode(started.cookie, correlationId)).rejects.toMatchObject({ status: 429,
        code: 'ASSISTED_DESK_CODE_LIMITED' });
      expect(f.enrollment!.desk_code_issues).toBe(5);
    });

    it('refuses a desk code while the facility route is closed, and outside the holder step', async () => {
      const f = fixture();
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      // The flag is on but no facility takes part.
      Object.assign(process.env, { ASSISTED_REGISTRATION_ENABLED: 'true' }); resetEnvironmentForTests();
      const closed = fixture();
      closed.enrollments.set(String(f.enrollment!.id), f.enrollment!);
      await expect(closed.service.issueDeskCode(started.cookie, correlationId)).rejects.toMatchObject({ status: 409,
        code: 'ASSISTED_REGISTRATION_UNAVAILABLE', message: 'Registration at a facility is not available now.' });
      const open = fixture();
      open.participating = [clinic];
      open.enrollments.set(String(f.enrollment!.id), f.enrollment!);
      await proveHolder(open, started.cookie);
      await expect(open.service.issueDeskCode(started.cookie, correlationId)).rejects.toMatchObject({ status: 409,
        code: 'ENROLLMENT_STAGE_INVALID' });
      // After a proof the progress shows no desk code and no route.
      const progress = await open.service.current(started.cookie, correlationId);
      expect(progress).not.toHaveProperty('facility');
    });

    it('finds the enrollment a desk code names and compares the document with the record blindly', async () => {
      facilityOnly();
      const f = fixture();
      f.participating = [clinic];
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const { facility } = await f.service.issueDeskCode(started.cookie, correlationId);
      const found = await f.service.deskLookup(facility.deskCode as string,
        { firstName: 'OKAFOR', lastName: 'amina', dateOfBirth: '1990-01-02' }, correlationId);
      expect(found).toEqual({ deskCodeHmac: keyed('patient-enrollment-desk-code', facility.deskCode as string),
        enrollment: { id: f.enrollment!.id, ninDigest: keyed('patient-enrollment-holder-nin', 'a'.repeat(64)),
          result: { matched: true, firstName: 'match', lastName: 'match', dateOfBirth: 'match' } } });
      const mismatch = await f.service.deskLookup(facility.deskCode as string,
        { firstName: 'Amina', lastName: 'Okafor', dateOfBirth: '1990-01-03' }, correlationId);
      expect(mismatch.enrollment?.result).toEqual({ matched: false, firstName: 'match', lastName: 'match',
        dateOfBirth: 'no_match' });
      // Nothing of the record is returned, only the comparison.
      expect(JSON.stringify(mismatch)).not.toMatch(/Amina|Okafor|1990|12345678901/);
      await expect(f.service.deskLookup('0000000000', { firstName: 'Amina', lastName: 'Okafor' }, correlationId))
        .resolves.toEqual({ deskCodeHmac: keyed('patient-enrollment-desk-code', '0000000000'), enrollment: null });
    });

    it('proves the holder at the facility with the enrollment\'s own token and maps the refusals', async () => {
      facilityOnly();
      const f = fixture();
      f.participating = [clinic];
      const started = await f.service.start(nin, requestKey, '203.0.113.10', correlationId);
      const verificationId = '7b0d64e4-1d39-4e3a-9a52-6f0c2a7e2001';
      await expect(f.service.proveAtFacility(String(f.enrollment!.id), verificationId, correlationId))
        .resolves.toBe('verified');
      const proof = f.holderCalls.find(({ command }) => command === 'facility-proof')!;
      expect(proof.values).toEqual([f.enrollment!.id, f.enrollment!.token_hmac, verificationId,
        keyed('patient-enrollment-holder-nin', 'a'.repeat(64)), 5]);
      await expect(f.service.current(started.cookie, correlationId)).resolves.toMatchObject({ stage: 'verify_contact' });
      const other = await f.service.start(nin, '3f6339b5-f06f-474a-9976-105bd99c87dc', '203.0.113.10', correlationId);
      expect(other.cookie).not.toBe(started.cookie);
      f.facilityProof = 'existing_identity';
      await expect(f.service.proveAtFacility(String(f.enrollment!.id), verificationId, correlationId))
        .resolves.toBe('existing_identity');
      for (const [error, status, code] of [
        [Object.assign(new Error('ASSISTED_REGISTRATION_NOT_AUTHORIZED'), { code: '42501' }), 403,
          'ASSISTED_REGISTRATION_NOT_AUTHORIZED'],
        [Object.assign(new Error('PATIENT_HOLDER_PROOF_INVALID'), { code: '23514' }), 409, 'ASSISTED_VERIFICATION_STALE'],
        [Object.assign(new Error('PATIENT_ENROLLMENT_DENIED'), { code: '42501' }), 409, 'ASSISTED_VERIFICATION_STALE'],
        [Object.assign(new Error('PATIENT_ENROLLMENT_RECONCILIATION_REQUIRED'), { code: '55000' }), 503,
          'ENROLLMENT_RECONCILIATION_REQUIRED'],
      ] as const) {
        const g = fixture();
        g.participating = [clinic];
        await g.service.start(nin, requestKey, '203.0.113.10', correlationId);
        g.facilityProof = error;
        await expect(g.service.proveAtFacility(String(g.enrollment!.id), verificationId, correlationId))
          .rejects.toMatchObject({ status, code });
      }
      // An enrollment that is gone cannot be proved.
      await expect(fixture().service.proveAtFacility('7b0d64e4-1d39-4e3a-9a52-6f0c2a7e9999', verificationId,
        correlationId)).rejects.toMatchObject({ status: 409, code: 'ASSISTED_VERIFICATION_STALE' });
    });

    it('keys a staff request and its idempotency key with the server key in their own domains', () => {
      const f = fixture();
      const digests = f.service.assistedRequestDigests('assisted-check-key-0001', '{"canonical":true}');
      expect(digests).toEqual({ keyHmac: keyed('assisted-verification-key', 'assisted-check-key-0001'),
        requestHmac: keyed('assisted-verification-request', '{"canonical":true}') });
    });
  });
});
