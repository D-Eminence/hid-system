jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { GoogleAuthenticationService } from '../auth/google-authentication.service';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import type { HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { fakeNinCheckStore } from '../testing/nin-check-store.fake';
import type { HidCodeGenerator } from './hid-code-generator.service';
import { NIN_CHECK_HOLD_SECONDS, NIN_CHECK_NO_ANSWER_HOLD_SECONDS, NIN_NO_RECORD_ANSWER_SECONDS,
  NIN_RECORD_ANSWER_SECONDS, NinCheckOnce } from './nin-check-once';
import { NinIdentifierProtector } from './nin-identifier-protector';
import { PatientEnrollmentService } from './patient-enrollment.service';
import { QoreIdPublicPatientIdentityProvider } from './patient-enrollment.provider';
import { QoreIdVerificationAdapter } from './qoreid-verification.adapter';
import { QoreIdVerificationService } from './qoreid-verification.service';

/**
 * Every way the same NIN could be sent to QoreID twice (owner, 18 November
 * 2026: "every call charges whether success or fail"; a user on 28 October has
 * two verified checks in the QoreID logs, both charged). Each test drives the
 * real services and the real QoreID adapter against a fake QoreID that counts
 * every NIN request it receives, answered or not, as QoreID bills them.
 * They were written first as test.failing against the code before the fix
 * (QoreID asked twice in each); with NinCheckOnce (0137) each asks it once.
 * Fictional values only; nothing leaves the process.
 */

const NIN = '70000000001';
const KEY_A = '3f6339b5-f06f-474a-9976-105bd99c87db';
const KEY_B = '49ebcc73-3aa3-47aa-b1e4-f8944ab6eab0';
const KEY_C = '5a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const IP = '203.0.113.20';
const RECORD = { nin: NIN, firstname: 'Adaeze', lastname: 'Fictional', middlename: 'Test',
  gender: 'F', birthdate: '02-03-1990', phone: '08000000000', photo: 'Zml4dHVyZQ==',
  residence: { address1: '1 Fixture Road', town: 'Fixture Town', lga: 'Fixture LGA', state: 'Fixture State' } };
const originalEnvironment = { ...process.env };
/** Every NinCheckOnce a test made, so checks still reading an answer finish before the next test. */
const created: NinCheckOnce[] = [];

/**
 * 'slow': never answers (HID gives up at QOREID_NIN_ANSWER_CEILING_MS);
 * 'late': answers after the caller's wait but within the ceiling;
 * 'refused': the connection is refused before anything is sent (not billed);
 * 'reset': the connection drops after the request was sent;
 * 'forbidden': 403, an account-level refusal (wallet, product, allowlist);
 * 'no_gender': a verified record without a usable gender (HID cannot enroll with it);
 * 'no_id': a verified answer whose transaction id is not a safe integer.
 */
type QoreIdMode = 'verified' | 'no_record' | 'not_found' | 'slow' | 'late' | 'unavailable' | 'refused' | 'reset'
  | 'forbidden' | 'no_gender' | 'no_id';

/** A QoreID that bills every NIN request it receives, as the owner's logs show. */
function fakeQoreId() {
  const state = { charged: 0, modes: [] as QoreIdMode[], fallback: 'verified' as QoreIdMode, delayMs: 0 };
  let transaction = 7000;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch = jest.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/token')) return json({ accessToken: 'fixture-access-token', expiresIn: 7200, tokenType: 'Bearer' });
    if (!url.includes('/v1/ng/identities/nin/')) throw new Error('unexpected QoreID path');
    const mode = state.modes.shift() ?? state.fallback;
    if (mode === 'refused') {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    }
    state.charged += 1;
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (mode === 'late') await new Promise((resolve) => setTimeout(resolve, 500));
    if (mode === 'slow') {
      // QoreID keeps working (and bills) after HID stops waiting.
      await new Promise((_resolve, reject) => init.signal?.addEventListener('abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    if (mode === 'reset') {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    }
    if (mode === 'unavailable') return json({ message: 'unavailable' }, 503);
    if (mode === 'not_found') return json({ message: 'not found' }, 404);
    if (mode === 'forbidden') return json({ message: 'insufficient balance' }, 403);
    transaction += 1;
    const claims = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, string> : undefined;
    if (mode === 'no_record') {
      return json({ id: transaction, status: { state: 'complete', status: 'not_verified' },
        summary: { nin_check: claims ? { status: 'NO_MATCH', fieldMatches: { firstname: false, lastname: false } }
          : 'not_verified' } });
    }
    const upper = (value: string | undefined) => (value ?? '').trim().toLocaleUpperCase('en-NG');
    const firstname = upper(claims?.firstname) === upper(RECORD.firstname);
    const lastname = upper(claims?.lastname) === upper(RECORD.lastname);
    const dob = claims?.dob === '1990-03-02';
    return json({ id: mode === 'no_id' ? 'not-a-number' : transaction, status: { state: 'complete', status: 'verified' },
      summary: { nin_check: claims ? { status: firstname && lastname && dob ? 'EXACT_MATCH' : 'NO_MATCH',
        fieldMatches: { firstname, lastname, dob } } : 'verified' },
      nin: mode === 'no_gender' ? { ...RECORD, gender: '' } : RECORD });
  });
  return { state, fetch };
}

/** The identity tables the two paths touch, kept in memory as the database keeps them. */
function fakeDatabase() {
  const enrollments: Record<string, unknown>[] = [];
  const bound = new Set<string>();
  /** NIN lookups whose patient's login was deleted (0096). */
  const deletedLogins = new Set<string>();
  const store = fakeNinCheckStore({ erased: (lookup) => deletedLogins.has(lookup) });
  const audits: unknown[][] = [];
  const evidence: Record<string, unknown>[] = [];
  const profile = { patientId: 'a7000000-0000-4000-8000-000000000001', firstName: 'Adaeze', lastName: 'Fictional',
    dateOfBirth: null as string | null };
  const control = { failNextEnrollmentWrite: false };
  const query = jest.fn(async (sql: string, values: readonly unknown[] = []) => {
    const stored = store.query(sql, values);
    if (stored) return stored;
    if (sql.includes('prune_expired_public_patient_enrollments')) {
      for (let index = enrollments.length - 1; index >= 0; index -= 1) {
        const row = enrollments[index]!;
        if (row.state !== 'active' && (row.expires_at as Date).getTime() <= Date.now()) enrollments.splice(index, 1);
      }
      return { rows: [{ prune_expired_public_patient_enrollments: 0 }] };
    }
    if (sql.includes('public_patient_nin_already_bound')) return { rows: [{ bound: bound.has(String(values[0])) }] };
    if (sql.includes('public_patient_enrollment_ready')) return { rows: [{ ready: true }] };
    if (sql.includes('from identity.public_patient_enrollment_rates')) return { rows: [] };
    if (sql.includes('from identity.public_patient_enrollments where nin_lookup_hmac')) {
      return { rows: enrollments.filter((row) => row.nin_lookup_hmac === values[0]) };
    }
    if (sql.includes('from identity.public_patient_enrollments where request_hmac')) {
      return { rows: enrollments.filter((row) => row.request_hmac === values[0]) };
    }
    if (sql.includes('insert into identity.public_patient_enrollments')) {
      if (control.failNextEnrollmentWrite) {
        control.failNextEnrollmentWrite = false;
        throw Object.assign(new Error('connection reset'), { code: '08006' });
      }
      if (enrollments.some((row) => row.nin_lookup_hmac === values[1] || row.request_hmac === values[8])) {
        throw Object.assign(new Error('duplicate'), { code: '23505' });
      }
      enrollments.push({ id: values[0], nin_lookup_hmac: values[1], profile_ciphertext: values[4],
        provider_reference: values[7], request_hmac: values[8], token_hmac: values[9], key_version: 'v1',
        state: 'verify_contact', expires_at: new Date(Date.now() + 86_400_000), created_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('google_onboarding_enrollment_requirement')) return { rows: [{ required: false }] };
    if (sql.includes('patient_self_profile')) return { rows: [{ profile }] };
    if (sql.includes('patient_self_nin_eligibility')) {
      return { rows: [{ state: bound.has(String(values[2])) ? 'bound_exact' : 'legacy_unbound' }] };
    }
    if (sql.includes('bind_my_verified_nin')) {
      bound.add(String(values[3]));
      evidence.push({ result: 'verified', reference: values[7] });
      return { rows: [{ evidenceId: values[2], recordedAt: new Date() }] };
    }
    if (sql.includes('record_my_verified_nin_date_of_birth')) return { rows: [], rowCount: 1 };
    if (sql.includes('record_my_nin_verification_evidence')) {
      evidence.push({ result: values[2], reference: values[3], failure: values[4] });
      return { rows: [{ evidenceId: 'a7000000-0000-4000-8000-0000000000e1', recordedAt: new Date() }] };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query } as unknown as PoolClient;
  const database = {
    withSystemTransaction: jest.fn(async (_correlation: string, work: (value: PoolClient) => Promise<unknown>) =>
      work(client)),
    query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('insert into audit.events')) audits.push([...values]);
      return { rows: [], rowCount: 1 };
    }),
  } as unknown as DatabaseService;
  return { database, query, enrollments, bound, deletedLogins, store, audits, evidence, profile, control };
}

function system() {
  const qoreId = fakeQoreId();
  const db = fakeDatabase();
  const adapter = new QoreIdVerificationAdapter({ baseUrl: 'https://qoreid.fixture.invalid', clientId: 'fixture-client',
    clientSecret: 'fixture-secret', timeoutMs: 100, ninOnlyEnrollmentEnabled: true },
  qoreId.fetch as unknown as typeof globalThis.fetch);
  const integrations = { assertAvailable: jest.fn().mockResolvedValue(undefined),
    consumePatientQuota: jest.fn().mockResolvedValue(undefined) } as unknown as IntegrationRuntimeService;
  const protector = new NinIdentifierProtector();
  const ninCheck = new NinCheckOnce(db.database, protector, new AuditService(db.database));
  created.push(ninCheck);
  const provider = new QoreIdPublicPatientIdentityProvider(adapter, integrations, ninCheck);
  const notification = { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'test_sms' }) };
  const enrollment = new PatientEnrollmentService(db.database, protector, provider,
    notification as unknown as NotificationOtpClient, { generate: jest.fn() } as unknown as HidCodeGenerator,
    { bindPendingInTransaction: jest.fn() } as unknown as GoogleAuthenticationService);
  const profile = new QoreIdVerificationService(db.database, adapter, integrations, protector, ninCheck);
  const patientRequest = { correlationId: 'nin-double-charge-profile', actor: { kind: 'patient',
    patientId: db.profile.patientId, accountId: 'a7000000-0000-4000-8000-000000000002', subject: 'patient:fixture',
    sessionId: 'a7000000-0000-4000-8000-000000000003', roles: [], permissions: [], facilityIds: [], facilities: [] },
  header: () => undefined } as unknown as HidRequest;
  const start = (key = KEY_A, correlationId = `start-${key}`) => enrollment.start(NIN, key, IP, correlationId);
  const verifyProfile = (dateOfBirth?: string) => profile.verifyPatientNin(patientRequest, NIN, dateOfBirth);
  /** The audit rows of the NIN checks: [path, source, result] each. */
  const checkAudits = () => db.audits.filter((values) => values[8] === 'identity.qoreid.nin-check')
    .map((values) => { const details = JSON.parse(String(values[16])) as Record<string, unknown>;
      return [details.path, details.source, details.result]; });
  return { qoreId, db, start, verifyProfile, ninCheck, provider, checkAudits, lookup: protector.lookup(NIN) };
}

describe('the same NIN is sent to QoreID once', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://app.fixture.invalid', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      NIN_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 1).toString('base64'),
      NIN_ENCRYPTION_KEY_B64: Buffer.alloc(32, 2).toString('base64'),
      CONTACT_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 4).toString('base64'),
      OTP_HMAC_KEY_B64: Buffer.alloc(32, 3).toString('base64'),
      QOREID_ENABLED: 'true', QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'true',
      QOREID_CLIENT_ID: 'fixture-client', QOREID_CLIENT_SECRET: 'fixture-secret', QOREID_TIMEOUT_MS: '250',
      QOREID_NIN_ANSWER_CEILING_MS: '1000',
    });
    resetEnvironmentForTests();
  });

  afterEach(async () => {
    await Promise.all(created.splice(0).map((check) => check.settle()));
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
    jest.restoreAllMocks();
  });

  describe('Health ID sign-up with a NIN (public enrollment start)', () => {
    test('E1: two starts at once (a double tap, or two tabs) ask QoreID once', async () => {
      const s = system();
      s.qoreId.state.delayMs = 30;
      const results = await Promise.allSettled([s.start(KEY_A), s.start(KEY_B)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(s.qoreId.state.charged).toBe(1);
    });

    test('E2: a start sent again straight after a QoreID timeout does not ask again', async () => {
      const s = system();
      s.qoreId.state.modes = ['slow'];
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'QOREID_TIMEOUT' });
      await expect(s.start(KEY_A)).rejects.toMatchObject({ status: 409, code: 'NIN_CHECK_HELD' });
      expect(s.qoreId.state.charged).toBe(1);
    });

    test('E3: a new start after the 24-hour pending enrollment ended reuses the answer', async () => {
      const s = system();
      await s.start(KEY_A);
      s.db.enrollments[0]!.expires_at = new Date(Date.now() - 1000);
      await expect(s.start(KEY_B)).resolves.toMatchObject({ progress: { stage: 'verify_contact' } });
      expect(s.qoreId.state.charged).toBe(1);
    });

    test('E4: a retry after the verified answer could not be saved reuses the answer', async () => {
      const s = system();
      s.db.control.failNextEnrollmentWrite = true;
      await expect(s.start(KEY_A)).rejects.toMatchObject({ status: 503 });
      await expect(s.start(KEY_A)).resolves.toMatchObject({ progress: { stage: 'verify_contact' } });
      expect(s.qoreId.state.charged).toBe(1);
    });

    test('E5: a NIN QoreID found no record for is not asked again on a retry', async () => {
      const s = system();
      s.qoreId.state.fallback = 'no_record';
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'NIN_NOT_VERIFIED' });
      await expect(s.start(KEY_B)).rejects.toMatchObject({ code: 'NIN_NOT_VERIFIED' });
      expect(s.qoreId.state.charged).toBe(1);
    });

    test('E6: a NIN QoreID refused (not found) is not asked again on a retry', async () => {
      const s = system();
      s.qoreId.state.fallback = 'not_found';
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'QOREID_PROVIDER_REJECTED' });
      await expect(s.start(KEY_B)).rejects.toMatchObject({ code: 'QOREID_PROVIDER_REJECTED' });
      expect(s.qoreId.state.charged).toBe(1);
    });

    it('a same-key resume and a second key while the enrollment is pending never ask QoreID (not a charge path)', async () => {
      const s = system();
      await s.start(KEY_A);
      await s.start(KEY_A);
      await expect(s.start(KEY_B)).rejects.toMatchObject({ code: 'NIN_ALREADY_REGISTERED' });
      expect(s.qoreId.state.charged).toBe(1);
    });

    it('a NIN already bound to a Health ID never reaches QoreID (not a charge path)', async () => {
      const s = system();
      s.db.bound.add(s.lookup);
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'NIN_ALREADY_REGISTERED' });
      expect(s.qoreId.state.charged).toBe(0);
    });
  });

  describe('NIN added from the patient profile (POST identity/me/verification/nin)', () => {
    test('P1: two profile checks at once ask QoreID once', async () => {
      const s = system();
      s.qoreId.state.delayMs = 30;
      await Promise.allSettled([s.verifyProfile('1990-03-02'), s.verifyProfile('1990-03-02')]);
      expect(s.qoreId.state.charged).toBe(1);
    });

    test('P2: a profile check sent again after a details mismatch reuses the answer', async () => {
      const s = system();
      await expect(s.verifyProfile('1990-02-03')).rejects.toMatchObject({ code: 'PATIENT_NIN_DETAILS_MISMATCH' });
      await expect(s.verifyProfile('1990-03-02')).resolves.toMatchObject({ state: 'verified' });
      expect(s.qoreId.state.charged).toBe(1);
    });

    test('P3: a profile check sent again straight after a QoreID timeout does not ask again', async () => {
      const s = system();
      s.qoreId.state.modes = ['slow'];
      await expect(s.verifyProfile('1990-03-02')).rejects.toMatchObject({ code: 'QOREID_TIMEOUT' });
      await expect(s.verifyProfile('1990-03-02')).rejects.toMatchObject({ code: 'NIN_CHECK_HELD' });
      expect(s.qoreId.state.charged).toBe(1);
    });

    test('P4: a profile check after a NIN sign-up for the same NIN reuses the sign-up answer', async () => {
      const s = system();
      await s.start(KEY_A);
      await expect(s.verifyProfile('1990-03-02')).resolves.toMatchObject({ state: 'verified' });
      expect(s.qoreId.state.charged).toBe(1);
    });

    test('P5: a NIN sign-up after a profile check that did not bind reuses the answer', async () => {
      const s = system();
      await expect(s.verifyProfile('1990-02-03')).rejects.toMatchObject({ code: 'PATIENT_NIN_DETAILS_MISMATCH' });
      await expect(s.start(KEY_C)).resolves.toMatchObject({ progress: { stage: 'verify_contact' } });
      expect(s.qoreId.state.charged).toBe(1);
    });

    test('P6: a profile check retried with the same details after "no record" is not asked again', async () => {
      const s = system();
      s.qoreId.state.fallback = 'no_record';
      await expect(s.verifyProfile('1990-03-02')).rejects.toMatchObject({ code: 'PATIENT_NIN_DETAILS_MISMATCH' });
      await expect(s.verifyProfile('1990-03-02')).rejects.toMatchObject({ code: 'PATIENT_NIN_DETAILS_MISMATCH' });
      expect(s.qoreId.state.charged).toBe(1);
    });
  });
  describe('the stored answer (NinCheckOnce, 0137)', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('the second of two simultaneous starts waits for the first and is told the NIN is taken, with one QoreID call', async () => {
      const s = system();
      s.qoreId.state.delayMs = 40;
      const [first, second] = await Promise.allSettled([s.start(KEY_A), s.start(KEY_B)]);
      expect(first).toMatchObject({ status: 'fulfilled' });
      expect(second).toMatchObject({ status: 'rejected', reason: { code: 'NIN_ALREADY_REGISTERED' } });
      expect(s.qoreId.state.charged).toBe(1);
      expect(s.checkAudits()).toEqual([['enrollment', 'qoreid', 'record'], ['enrollment', 'stored', 'record']]);
    });

    it('three checks at once from sign-up, the profile and the desk path ask QoreID once', async () => {
      const s = system();
      s.qoreId.state.delayMs = 40;
      await Promise.allSettled([s.start(KEY_A), s.verifyProfile('1990-03-02'),
        s.provider.verifyNin(NIN, { correlationId: 'desk-check', path: 'desk' })]);
      expect(s.qoreId.state.charged).toBe(1);
      expect(s.checkAudits().filter(([, source]) => source === 'qoreid')).toHaveLength(1);
    });

    it('a record is reused for 90 days (Q110), then QoreID is asked again', async () => {
      const s = system();
      await s.start(KEY_A);
      s.db.enrollments.length = 0;
      s.db.store.clock.offsetMs = NIN_RECORD_ANSWER_SECONDS * 1000 - 60_000;
      await s.start(KEY_B);
      expect(s.qoreId.state.charged).toBe(1);
      s.db.enrollments.length = 0;
      s.db.store.clock.offsetMs = NIN_RECORD_ANSWER_SECONDS * 1000 + 1000;
      await s.start(KEY_C);
      expect(s.qoreId.state.charged).toBe(2);
    });

    it('"no record" is reused for 24 hours, then QoreID is asked again', async () => {
      const s = system();
      s.qoreId.state.fallback = 'no_record';
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'NIN_NOT_VERIFIED' });
      s.db.store.clock.offsetMs = NIN_NO_RECORD_ANSWER_SECONDS * 1000 - 60_000;
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'NIN_NOT_VERIFIED' });
      expect(s.qoreId.state.charged).toBe(1);
      s.db.store.clock.offsetMs = DAY + 1000;
      s.qoreId.state.fallback = 'verified';
      await expect(s.start(KEY_A)).resolves.toMatchObject({ progress: { stage: 'verify_contact' } });
      expect(s.qoreId.state.charged).toBe(2);
    });

    it('an answer that arrives after the caller stopped waiting is kept, and the retry reuses it (28 October)', async () => {
      const s = system();
      // Production's 5 s timeout and a 6 s answer with a photo, scaled down.
      s.qoreId.state.modes = ['late'];
      const first = await s.start(KEY_A).catch((error: unknown) => error);
      expect(first).toMatchObject({ status: 504, code: 'QOREID_TIMEOUT',
        message: 'The NIN check is taking longer than usual. Please wait a minute, then try again.' });
      await s.ninCheck.settle();
      await expect(s.start(KEY_A)).resolves.toMatchObject({ progress: { stage: 'verify_contact' } });
      expect(s.qoreId.state.charged).toBe(1);
      expect(s.checkAudits()).toEqual([['enrollment', 'qoreid', 'timeout'], ['enrollment', 'late', 'record'],
        ['enrollment', 'stored', 'record']]);
    });

    it('a retry while the late answer is still on its way waits for it instead of asking again', async () => {
      const s = system();
      s.qoreId.state.modes = ['late'];
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'QOREID_TIMEOUT' });
      // Sent at once: it finds the check still running and waits for its answer.
      await expect(s.start(KEY_A)).resolves.toMatchObject({ progress: { stage: 'verify_contact' } });
      expect(s.qoreId.state.charged).toBe(1);
    });

    it('with no answer by the ceiling the NIN is held for hours, not 5 minutes, and the message says so', async () => {
      const s = system();
      s.qoreId.state.modes = ['slow'];
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'QOREID_TIMEOUT' });
      await s.ninCheck.settle();
      // The old 5-minute hold has passed: still held, still no second charge.
      s.db.store.clock.offsetMs = NIN_CHECK_HOLD_SECONDS * 1000 + 1000;
      const held = await s.start(KEY_A).catch((error: unknown) => error) as { message: string;
        extensions: { retryAfterSeconds: number } };
      expect(held).toMatchObject({ status: 409, code: 'NIN_CHECK_HELD',
        message: 'We could not finish checking this NIN. Please try again in 6 hours.' });
      expect(held.extensions.retryAfterSeconds).toBeGreaterThan(5 * 60 * 60);
      expect(s.qoreId.state.charged).toBe(1);
      s.db.store.clock.offsetMs = NIN_CHECK_NO_ANSWER_HOLD_SECONDS * 1000 + 1000;
      await expect(s.start(KEY_A)).resolves.toMatchObject({ progress: { stage: 'verify_contact' } });
      expect(s.qoreId.state.charged).toBe(2);
      expect(s.checkAudits()).toEqual([['enrollment', 'qoreid', 'timeout'], ['enrollment', 'late', 'no_answer'],
        ['enrollment', 'none', 'held'], ['enrollment', 'qoreid', 'record']]);
    });

    it('a QoreID 5xx is held for 5 minutes, then the next check asks again', async () => {
      const s = system();
      s.qoreId.state.modes = ['unavailable'];
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'QOREID_PROVIDER_UNAVAILABLE' });
      await expect(s.start(KEY_A)).rejects.toMatchObject({ status: 409, code: 'NIN_CHECK_HELD',
        message: 'We could not finish checking this NIN. Please try again in 5 minutes.' });
      expect(s.qoreId.state.charged).toBe(1);
      s.db.store.clock.offsetMs = NIN_CHECK_HOLD_SECONDS * 1000 + 1000;
      await expect(s.start(KEY_A)).resolves.toMatchObject({ progress: { stage: 'verify_contact' } });
      expect(s.qoreId.state.charged).toBe(2);
      expect(s.checkAudits()).toEqual([['enrollment', 'qoreid', 'not_answered'], ['enrollment', 'none', 'held'],
        ['enrollment', 'qoreid', 'record']]);
    });

    it('a connection lost after the request was sent is held, not asked again at once', async () => {
      const s = system();
      s.qoreId.state.modes = ['reset'];
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'QOREID_NETWORK_UNAVAILABLE' });
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'NIN_CHECK_HELD' });
      expect(s.qoreId.state.charged).toBe(1);
    });

    it('a connection refused before anything was sent is let go: the next check asks at once', async () => {
      const s = system();
      s.qoreId.state.modes = ['refused'];
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'QOREID_NETWORK_UNAVAILABLE' });
      await expect(s.start(KEY_A)).resolves.toMatchObject({ progress: { stage: 'verify_contact' } });
      expect(s.qoreId.state.charged).toBe(1);
      expect(s.checkAudits()).toEqual([['enrollment', 'qoreid', 'not_sent'], ['enrollment', 'qoreid', 'record']]);
      const notSent = s.db.audits.filter((values) => values[8] === 'identity.qoreid.nin-check')
        .map((values) => JSON.parse(String(values[16])) as Record<string, unknown>)[0];
      expect(notSent).toMatchObject({ qoreidCalled: false, result: 'not_sent' });
    });

    it('an account-level refusal (403) is not kept as a refusal of the NIN for a day', async () => {
      const s = system();
      s.qoreId.state.modes = ['forbidden'];
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'QOREID_PROVIDER_REJECTED' });
      // Held briefly (it may have been charged), then the NIN is checked again once the account is fixed.
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'NIN_CHECK_HELD' });
      s.db.store.clock.offsetMs = NIN_CHECK_HOLD_SECONDS * 1000 + 1000;
      await expect(s.start(KEY_A)).resolves.toMatchObject({ progress: { stage: 'verify_contact' } });
      expect(s.qoreId.state.charged).toBe(2);
      expect([...s.db.store.rows.values()][0]).toMatchObject({ state: 'answered', outcome: 'record' });
    });

    it('a complete answer HID cannot use is kept for a day: never re-sent, every path refuses it without a call', async () => {
      const s = system();
      s.qoreId.state.modes = ['no_gender'];
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
      s.db.store.clock.offsetMs = NIN_CHECK_HOLD_SECONDS * 1000 + 1000;
      await expect(s.start(KEY_B)).rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
      await expect(s.provider.verifyNin(NIN, { correlationId: 'desk-check', path: 'desk' }))
        .rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
      // The name and date of birth on it still serve a profile check.
      await expect(s.verifyProfile('1990-03-02')).resolves.toMatchObject({ state: 'verified' });
      expect(s.qoreId.state.charged).toBe(1);
      expect([...s.db.store.rows.values()][0]).toMatchObject({ state: 'answered', outcome: 'unusable' });
      expect(s.checkAudits()).toEqual([['enrollment', 'qoreid', 'unusable'], ['enrollment', 'stored', 'unusable'],
        ['desk', 'stored', 'unusable'], ['profile', 'stored', 'unusable']]);
      s.db.store.clock.offsetMs = NIN_NO_RECORD_ANSWER_SECONDS * 1000 + 1000;
      s.db.enrollments.length = 0;
      s.db.bound.clear();
      await expect(s.start(KEY_C)).resolves.toMatchObject({ progress: { stage: 'verify_contact' } });
      expect(s.qoreId.state.charged).toBe(2);
    });

    it('a verified profile answer without a usable QoreID id is kept as unusable, never as a details mismatch', async () => {
      const s = system();
      s.qoreId.state.modes = ['no_id'];
      await expect(s.verifyProfile('1990-03-02')).rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
      await expect(s.verifyProfile('1990-03-02')).rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
      expect(s.qoreId.state.charged).toBe(1);
      expect(s.db.evidence.map((row) => row.result)).not.toContain('not_verified');
      expect([...s.db.store.rows.values()][0]).toMatchObject({ state: 'answered', outcome: 'unusable' });
    });

    it('a profile check that did not match keeps the record for 24 hours, not 90 days', async () => {
      const s = system();
      const before = Date.now();
      await expect(s.verifyProfile('1990-02-03')).rejects.toMatchObject({ code: 'PATIENT_NIN_DETAILS_MISMATCH' });
      const row = [...s.db.store.rows.values()][0]!;
      expect(row).toMatchObject({ state: 'answered', outcome: 'record' });
      expect(row.until - before).toBeLessThanOrEqual(NIN_NO_RECORD_ANSWER_SECONDS * 1000 + 5_000);
      // Within the day a sign-up with that NIN still reuses it (P5); after it, the record is gone.
      s.db.store.clock.offsetMs = NIN_NO_RECORD_ANSWER_SECONDS * 1000 + 1000;
      await expect(s.ninCheck.prune('sweep', 500)).resolves.toBe(1);
      expect(s.db.store.rows.size).toBe(0);
    });

    it('a profile check that matched keeps the record for 90 days (Q110)', async () => {
      const s = system();
      const before = Date.now();
      await expect(s.verifyProfile('1990-03-02')).resolves.toMatchObject({ state: 'verified' });
      const row = [...s.db.store.rows.values()][0]!;
      expect(row.until - before).toBeGreaterThan((NIN_RECORD_ANSWER_SECONDS - 60) * 1000);
    });

    it('an answer charged but never recorded (the lease ended) holds the NIN instead of being asked again', async () => {
      const s = system();
      s.db.store.fail('finish_qoreid_nin_check');
      // The answer still reaches this caller; four tries to record it all fail.
      await expect(s.start(KEY_A)).resolves.toMatchObject({ progress: { stage: 'verify_contact' } });
      s.db.store.fail(undefined);
      expect(s.db.store.calls.filter(({ sql }) => sql.includes('finish_qoreid_nin_check'))).toHaveLength(4);
      s.db.enrollments.length = 0;
      // After the lease ends, a new check is held, not paid again.
      s.db.store.clock.offsetMs = 300_000;
      // (The fake store's clock runs 5 minutes ahead of the process's, so the hours are rounded up to 7 here.)
      await expect(s.start(KEY_B)).rejects.toMatchObject({ status: 409, code: 'NIN_CHECK_HELD',
        message: expect.stringMatching(/^We could not finish checking this NIN\. Please try again in [67] hours\.$/) });
      expect(s.qoreId.state.charged).toBe(1);
      s.db.store.clock.offsetMs = 300_000 + NIN_CHECK_NO_ANSWER_HOLD_SECONDS * 1000;
      await expect(s.start(KEY_B)).resolves.toMatchObject({ progress: { stage: 'verify_contact' } });
      expect(s.qoreId.state.charged).toBe(2);
    }, 20_000);

    it('recording an outcome is tried again when the database is briefly busy', async () => {
      const s = system();
      let failures = 2;
      const query = s.db.store.query;
      s.db.store.query = (sql: string, values?: readonly unknown[]) => {
        if (sql.includes('finish_qoreid_nin_check') && failures > 0) {
          failures -= 1;
          throw Object.assign(new Error('pool exhausted'), { code: '53300' });
        }
        return query(sql, values);
      };
      await s.start(KEY_A);
      s.db.store.query = query;
      expect([...s.db.store.rows.values()][0]).toMatchObject({ state: 'answered', outcome: 'record' });
      s.db.enrollments.length = 0;
      await s.start(KEY_B);
      expect(s.qoreId.state.charged).toBe(1);
    });

    it('an answer for a NIN whose patient\'s login was deleted is never kept', async () => {
      const s = system();
      s.db.deletedLogins.add(s.lookup);
      await s.provider.verifyNin(NIN, { correlationId: 'desk-check', path: 'desk' });
      expect(s.db.store.rows.size).toBe(0);
    });

    it('a check whose first attempt is still running past the wait gets the plain message, not a second call', async () => {
      const s = system();
      // A lease another task holds (as after a crash or a very slow answer).
      s.db.store.rows.set(s.lookup, { nin_lookup_hmac: s.lookup, state: 'checking',
        attempt_id: 'a7000000-0000-4000-8000-0000000000ff', question_hmac: null, outcome: null, record_complete: null,
        answer_ciphertext: null, key_version: null, until: Date.now() + 60_000 });
      await expect(s.start(KEY_A)).rejects.toMatchObject({ status: 409, code: 'NIN_CHECK_IN_PROGRESS' });
      expect(s.qoreId.state.charged).toBe(0);
      expect(s.checkAudits()).toEqual([['enrollment', 'none', 'in_progress']]);
    });

    it('when the store cannot be reached nothing is sent to QoreID', async () => {
      const s = system();
      s.db.store.fail('begin_qoreid_nin_check');
      await expect(s.start(KEY_A)).rejects.toMatchObject({ status: 503, code: 'NIN_CHECK_UNAVAILABLE' });
      await expect(s.verifyProfile('1990-03-02')).rejects.toMatchObject({ status: 503, code: 'NIN_CHECK_UNAVAILABLE' });
      expect(s.qoreId.state.charged).toBe(0);
      // No evidence row: nothing reached QoreID.
      expect(s.db.evidence).toEqual([]);
    });

    it('an answer stored under another NIN key version is not reused', async () => {
      const s = system();
      await s.start(KEY_A);
      s.db.enrollments.length = 0;
      process.env.NIN_KEY_VERSION = 'rotated-v2';
      resetEnvironmentForTests();
      await s.start(KEY_B);
      expect(s.qoreId.state.charged).toBe(2);
    });

    it('is erased, and never reused, once the patient holding the NIN has deleted their login', async () => {
      const s = system();
      await s.start(KEY_A);
      s.db.enrollments.length = 0;
      s.db.deletedLogins.add(s.lookup);
      await expect(s.ninCheck.prune('sweep', 500)).resolves.toBe(1);
      expect(s.db.store.rows.size).toBe(0);
      await s.start(KEY_B);
      expect(s.qoreId.state.charged).toBe(2);
    });

    it('expired rows are erased by the sweeper\'s prune; live answers stay', async () => {
      const s = system();
      await s.start(KEY_A);
      await expect(s.ninCheck.prune('sweep', 500)).resolves.toBe(0);
      s.db.store.clock.offsetMs = NIN_RECORD_ANSWER_SECONDS * 1000 + 1000;
      await expect(s.ninCheck.prune('sweep', 500)).resolves.toBe(1);
      expect(s.db.store.rows.size).toBe(0);
    });

    it('keeps the answer encrypted and never puts the NIN in a statement, an audit row or a log line', async () => {
      const s = system();
      const logged: string[] = [];
      for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
          logged.push(JSON.stringify(args));
        });
      }
      s.qoreId.state.modes = ['slow', 'unavailable'];
      await s.start(KEY_A).catch(() => undefined);
      await s.ninCheck.settle();
      s.db.store.clock.offsetMs = NIN_CHECK_NO_ANSWER_HOLD_SECONDS * 1000 + 1000;
      await s.start(KEY_A).catch(() => undefined);
      s.db.store.clock.offsetMs += NIN_CHECK_HOLD_SECONDS * 1000 + 1000;
      await s.start(KEY_A);
      s.db.store.fail('finish_qoreid_nin_check');
      s.db.store.clock.offsetMs = 2 * NIN_RECORD_ANSWER_SECONDS * 1000;
      s.db.enrollments.length = 0;
      await s.start(KEY_B);
      s.db.store.fail(undefined);
      // The answer could not be recorded, so its lease stands until it ends:
      // a check right after waits for it and is told so, without a call.
      await expect(s.verifyProfile('1990-03-02')).rejects.toMatchObject({ code: 'NIN_CHECK_IN_PROGRESS' });
      expect(s.qoreId.state.charged).toBe(4);
      const row = [...s.db.store.rows.values()][0]!;
      expect(row.nin_lookup_hmac).toBe(s.lookup);
      const text = (value: unknown) => Buffer.isBuffer(value) ? value.toString('latin1') : JSON.stringify(value);
      for (const value of [...s.db.store.calls.flatMap(({ values }) => values), ...s.db.audits.flat(), ...logged]) {
        expect(text(value)).not.toContain(NIN);
        expect(text(value)).not.toContain(s.lookup.slice(0, 16).toUpperCase());
        expect(text(value)).not.toContain('Adaeze');
      }
      for (const audit of s.db.audits.filter((values) => values[8] === 'identity.qoreid.nin-check')) {
        expect(text(audit)).not.toContain(s.lookup);
      }
      expect(logged.some((line) => line.includes('nin-check.finish.failed'))).toBe(true);
    }, 20_000);

    it('a stored record is compared with the profile exactly as QoreID\'s answer was: a wrong date is still refused', async () => {
      const s = system();
      await s.start(KEY_A);
      await expect(s.verifyProfile('1990-02-03')).rejects.toMatchObject({ code: 'PATIENT_NIN_DETAILS_MISMATCH' });
      s.db.profile.firstName = 'Fictional';
      s.db.profile.lastName = 'Adaeze';
      await expect(s.verifyProfile('1990-03-02')).resolves.toMatchObject({ state: 'verified' });
      expect(s.qoreId.state.charged).toBe(1);
      expect(s.db.evidence.map((row) => row.result)).toEqual(['not_verified', 'verified']);
    });
  });
});
