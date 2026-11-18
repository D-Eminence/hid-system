jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import type { PoolClient } from 'pg';
import type { GoogleAuthenticationService } from '../auth/google-authentication.service';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import type { HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import type { HidCodeGenerator } from './hid-code-generator.service';
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

type QoreIdMode = 'verified' | 'no_record' | 'not_found' | 'slow' | 'unavailable';

/** A QoreID that bills every NIN request it receives, as the owner's logs show. */
function fakeQoreId() {
  const state = { charged: 0, modes: [] as QoreIdMode[], fallback: 'verified' as QoreIdMode, delayMs: 0 };
  let transaction = 7000;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch = jest.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/token')) return json({ accessToken: 'fixture-access-token', expiresIn: 7200, tokenType: 'Bearer' });
    if (!url.includes('/v1/ng/identities/nin/')) throw new Error('unexpected QoreID path');
    state.charged += 1;
    const mode = state.modes.shift() ?? state.fallback;
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (mode === 'slow') {
      // QoreID keeps working (and bills) after HID stops waiting.
      await new Promise((_resolve, reject) => init.signal?.addEventListener('abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    if (mode === 'unavailable') return json({ message: 'unavailable' }, 503);
    if (mode === 'not_found') return json({ message: 'not found' }, 404);
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
    return json({ id: transaction, status: { state: 'complete', status: 'verified' },
      summary: { nin_check: claims ? { status: firstname && lastname && dob ? 'EXACT_MATCH' : 'NO_MATCH',
        fieldMatches: { firstname, lastname, dob } } : 'verified' },
      nin: RECORD });
  });
  return { state, fetch };
}

/** The identity tables the two paths touch, kept in memory as the database keeps them. */
function fakeDatabase() {
  const enrollments: Record<string, unknown>[] = [];
  const bound = new Set<string>();
  const evidence: Record<string, unknown>[] = [];
  const profile = { patientId: 'a7000000-0000-4000-8000-000000000001', firstName: 'Adaeze', lastName: 'Fictional',
    dateOfBirth: null as string | null };
  const control = { failNextEnrollmentWrite: false };
  const query = jest.fn(async (sql: string, values: readonly unknown[] = []) => {
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
    query: jest.fn(async () => ({ rows: [], rowCount: 1 })),
  } as unknown as DatabaseService;
  return { database, query, enrollments, bound, evidence, profile, control };
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
  const provider = new QoreIdPublicPatientIdentityProvider(adapter, integrations);
  const notification = { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'test_sms' }) };
  const enrollment = new PatientEnrollmentService(db.database, protector, provider,
    notification as unknown as NotificationOtpClient, { generate: jest.fn() } as unknown as HidCodeGenerator,
    { bindPendingInTransaction: jest.fn() } as unknown as GoogleAuthenticationService);
  const profile = new QoreIdVerificationService(db.database, adapter, integrations, protector);
  const patientRequest = { correlationId: 'nin-double-charge-profile', actor: { kind: 'patient',
    patientId: db.profile.patientId, accountId: 'a7000000-0000-4000-8000-000000000002', subject: 'patient:fixture',
    sessionId: 'a7000000-0000-4000-8000-000000000003', roles: [], permissions: [], facilityIds: [], facilities: [] },
  header: () => undefined } as unknown as HidRequest;
  const start = (key = KEY_A, correlationId = `start-${key}`) => enrollment.start(NIN, key, IP, correlationId);
  const verifyProfile = (dateOfBirth?: string) => profile.verifyPatientNin(patientRequest, NIN, dateOfBirth);
  return { qoreId, db, start, verifyProfile, lookup: protector.lookup(NIN) };
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
    });
    resetEnvironmentForTests();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
    jest.restoreAllMocks();
  });

  describe('Health ID sign-up with a NIN (public enrollment start)', () => {
    test.failing('E1: two starts at once (a double tap, or two tabs) ask QoreID once', async () => {
      const s = system();
      s.qoreId.state.delayMs = 30;
      const results = await Promise.allSettled([s.start(KEY_A), s.start(KEY_B)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(s.qoreId.state.charged).toBe(1);
    });

    test.failing('E2: a start sent again straight after a QoreID timeout does not ask again', async () => {
      const s = system();
      s.qoreId.state.modes = ['slow'];
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'QOREID_TIMEOUT' });
      await expect(s.start(KEY_A)).rejects.toMatchObject({ status: 409, code: 'NIN_CHECK_IN_PROGRESS' });
      expect(s.qoreId.state.charged).toBe(1);
    });

    test.failing('E3: a new start after the 24-hour pending enrollment ended reuses the answer', async () => {
      const s = system();
      await s.start(KEY_A);
      s.db.enrollments[0]!.expires_at = new Date(Date.now() - 1000);
      await expect(s.start(KEY_B)).resolves.toMatchObject({ progress: { stage: 'verify_contact' } });
      expect(s.qoreId.state.charged).toBe(1);
    });

    test.failing('E4: a retry after the verified answer could not be saved reuses the answer', async () => {
      const s = system();
      s.db.control.failNextEnrollmentWrite = true;
      await expect(s.start(KEY_A)).rejects.toMatchObject({ status: 503 });
      await expect(s.start(KEY_A)).resolves.toMatchObject({ progress: { stage: 'verify_contact' } });
      expect(s.qoreId.state.charged).toBe(1);
    });

    test.failing('E5: a NIN QoreID found no record for is not asked again on a retry', async () => {
      const s = system();
      s.qoreId.state.fallback = 'no_record';
      await expect(s.start(KEY_A)).rejects.toMatchObject({ code: 'NIN_NOT_VERIFIED' });
      await expect(s.start(KEY_B)).rejects.toMatchObject({ code: 'NIN_NOT_VERIFIED' });
      expect(s.qoreId.state.charged).toBe(1);
    });

    test.failing('E6: a NIN QoreID refused (not found) is not asked again on a retry', async () => {
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
    test.failing('P1: two profile checks at once ask QoreID once', async () => {
      const s = system();
      s.qoreId.state.delayMs = 30;
      await Promise.allSettled([s.verifyProfile('1990-03-02'), s.verifyProfile('1990-03-02')]);
      expect(s.qoreId.state.charged).toBe(1);
    });

    test.failing('P2: a profile check sent again after a details mismatch reuses the answer', async () => {
      const s = system();
      await expect(s.verifyProfile('1990-02-03')).rejects.toMatchObject({ code: 'PATIENT_NIN_DETAILS_MISMATCH' });
      await expect(s.verifyProfile('1990-03-02')).resolves.toMatchObject({ state: 'verified' });
      expect(s.qoreId.state.charged).toBe(1);
    });

    test.failing('P3: a profile check sent again straight after a QoreID timeout does not ask again', async () => {
      const s = system();
      s.qoreId.state.modes = ['slow'];
      await expect(s.verifyProfile('1990-03-02')).rejects.toMatchObject({ code: 'QOREID_TIMEOUT' });
      await expect(s.verifyProfile('1990-03-02')).rejects.toMatchObject({ code: 'NIN_CHECK_IN_PROGRESS' });
      expect(s.qoreId.state.charged).toBe(1);
    });

    test.failing('P4: a profile check after a NIN sign-up for the same NIN reuses the sign-up answer', async () => {
      const s = system();
      await s.start(KEY_A);
      await expect(s.verifyProfile('1990-03-02')).resolves.toMatchObject({ state: 'verified' });
      expect(s.qoreId.state.charged).toBe(1);
    });

    test.failing('P5: a NIN sign-up after a profile check that did not bind reuses the answer', async () => {
      const s = system();
      await expect(s.verifyProfile('1990-02-03')).rejects.toMatchObject({ code: 'PATIENT_NIN_DETAILS_MISMATCH' });
      await expect(s.start(KEY_C)).resolves.toMatchObject({ progress: { stage: 'verify_contact' } });
      expect(s.qoreId.state.charged).toBe(1);
    });

    test.failing('P6: a profile check retried with the same details after "no record" is not asked again', async () => {
      const s = system();
      s.qoreId.state.fallback = 'no_record';
      await expect(s.verifyProfile('1990-03-02')).rejects.toMatchObject({ code: 'PATIENT_NIN_DETAILS_MISMATCH' });
      await expect(s.verifyProfile('1990-03-02')).rejects.toMatchObject({ code: 'PATIENT_NIN_DETAILS_MISMATCH' });
      expect(s.qoreId.state.charged).toBe(1);
    });
  });
});
