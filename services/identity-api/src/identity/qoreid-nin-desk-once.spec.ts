jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { fakeNinCheckStore } from '../testing/nin-check-store.fake';
import { NIN_CHECK_HOLD_SECONDS, NIN_NO_RECORD_ANSWER_SECONDS, NIN_RECORD_ANSWER_SECONDS,
  NinCheckOnce } from './nin-check-once';
import { NinIdentifierProtector } from './nin-identifier-protector';
import { NIN_BREAKER_RETRY_AFTER_MS, NinProviderBreaker } from './nin-provider-breaker';
import { NinRegistrationService, SEALED_TENANT_SQL } from './nin-registration.service';
import { QoreIdPublicPatientIdentityProvider } from './patient-enrollment.provider';
import { QoreIdNinVerificationProvider } from './qoreid-nin-verification.provider';
import { QoreIdVerificationAdapter } from './qoreid-verification.adapter';
import { QoreIdVerificationService } from './qoreid-verification.service';

/**
 * Q108 with 0137 (Q109: "the same NIN must never be paid for twice; every
 * QoreID call costs money, success or failure"): the registration desk's NIN
 * check goes through NinCheckOnce as path 'desk'. These drive the real desk
 * service, the real desk provider, the real NIN-only provider, the real guard
 * and the real QoreID adapter against a fake QoreID that bills every NIN
 * request it receives, and 0137's commands in memory. Nothing leaves the
 * process; fictional people and identifiers only.
 */

const NIN = '70000000002';
const caseId = '2b3c4d5e-6f70-4a81-9b2c-3d4e5f607182';
const RECORD = { nin: NIN, firstname: 'Bisola', lastname: 'Fixture', middlename: 'Test', gender: 'F',
  birthdate: '14-07-1988', phone: '08000000001', photo: 'Zml4dHVyZQ==',
  residence: { address1: '2 Fixture Road', town: 'Fixture Town', lga: 'Fixture LGA', state: 'Fixture State' } };
const input = { nin: NIN, firstName: 'Bisola', lastName: 'Fixture', dateOfBirth: '1988-07-14',
  purpose: 'healthcare-operations' as const };
const originalEnvironment = { ...process.env };
const created: NinCheckOnce[] = [];
/** Q117: the one answer for a NIN QoreID has no record of, on the desk, sign-up and the profile. */
const NO_RECORD_ANSWER = { status: 422, code: 'NIN_NOT_VERIFIED',
  message: 'This NIN could not be verified. Check the number and try again.' };

function deskContext(index = 1): DataAccessContext {
  const suffix = String(index).padStart(12, '0');
  return {
    actor: { kind: 'staff', subject: `synthetic:desk-${index}`, accountId: `f1e2d3c4-b5a6-4978-8877-${suffix}`,
      permissions: ['identity.registration.write'], facility: { organizationId: 'org' } },
    facilityId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', membershipId: `d4e5f6a7-b8c9-4d0e-8f1a-${suffix}`,
    correlationId: `desk-once-${index}`, purposeOfUse: 'healthcare-operations',
  } as unknown as DataAccessContext;
}

/**
 * 'late': answers after the desk's wait but within the ceiling; 'slow': never
 * answers (HID gives up at QOREID_NIN_ANSWER_CEILING_MS); 'no_gender': a record
 * without a recognised sex, and 'address_break': one whose home address holds
 * a line break (a sign-up cannot enrol from either; the name and date of birth
 * are fine); 'not_found': QoreID's 404; 'unavailable': its 503; 'born_1899': a record whose date of birth is
 * before 1900 (the adapter reads dates from 1800; the desk's own are from 1900).
 */
type QoreIdMode = 'verified' | 'no_record' | 'late' | 'slow' | 'reset' | 'forbidden' | 'no_gender' | 'address_break'
  | 'not_found' | 'unavailable' | 'born_1899';

/** A QoreID that bills every NIN request it receives, answered or not, and answers with the asked NIN's record. */
function fakeQoreId(leaseHeld: (nin: string) => boolean) {
  const state = { charged: 0, outsideGuard: 0, modes: [] as QoreIdMode[], fallback: 'verified' as QoreIdMode,
    delayMs: 0, tokenHangs: false };
  let transaction = 8000;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/token') && state.tokenHangs) {
      // QoreID's token endpoint never answers: the adapter gives up at its own timeout (nothing is billed).
      await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    if (url.endsWith('/token')) return json({ accessToken: 'fixture-access-token', expiresIn: 7200, tokenType: 'Bearer' });
    if (!url.includes('/v1/ng/identities/nin/')) throw new Error('unexpected QoreID path');
    const nin = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    // Every NIN request must be sent while 0137's guard holds the NIN's lease.
    if (!leaseHeld(nin)) state.outsideGuard += 1;
    const mode = state.modes.shift() ?? state.fallback;
    state.charged += 1;
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (mode === 'late') await new Promise((resolve) => setTimeout(resolve, 500));
    if (mode === 'slow') {
      // QoreID keeps working (and bills) after HID stops waiting.
      await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    if (mode === 'reset') {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    }
    if (mode === 'forbidden') return json({ message: 'insufficient balance' }, 403);
    if (mode === 'not_found') return json({ message: 'not found' }, 404);
    if (mode === 'unavailable') return json({ message: 'unavailable' }, 503);
    transaction += 1;
    if (mode === 'no_record') {
      return json({ id: transaction, status: { state: 'complete', status: 'not_verified' },
        summary: { nin_check: 'not_verified' } });
    }
    const bio = { ...RECORD, nin,
      ...(mode === 'no_gender' ? { gender: '' } : {}),
      ...(mode === 'born_1899' ? { birthdate: '14-07-1899' } : {}),
      ...(mode === 'address_break' ? { residence: { ...RECORD.residence, address1: '2 Fixture Road\nBack Gate' } } : {}) };
    // The profile's check sends the patient's name and date of birth and gets the record with field matches.
    const claims = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, string> : undefined;
    const upper = (value: string | undefined) => (value ?? '').trim().toLocaleUpperCase('en-NG');
    const matches = { firstname: upper(claims?.firstname) === upper(RECORD.firstname),
      lastname: upper(claims?.lastname) === upper(RECORD.lastname), dob: claims?.dob === '1988-07-14' };
    return json({ id: transaction, status: { state: 'complete', status: 'verified' },
      summary: { nin_check: claims ? { status: matches.firstname && matches.lastname && matches.dob ? 'EXACT_MATCH'
        : 'NO_MATCH', fieldMatches: matches } : 'verified' }, nin: bio });
  });
  return { state, fetch };
}

/** The patient whose profile adds the NIN (QoreIdVerificationService.verifyPatientNin), fictional. */
const PROFILE = { patientId: 'a8000000-0000-4000-8000-000000000001', firstName: 'Bisola', lastName: 'Fixture',
  dateOfBirth: '1988-07-14' };

/** The profile path's own tables (its claims, eligibility and evidence), in memory. */
function profileTables(sql: string, values: readonly unknown[]) {
  if (sql.includes('patient_self_profile')) return { rows: [{ profile: PROFILE }] };
  if (sql.includes('patient_self_nin_eligibility')) return { rows: [{ state: 'legacy_unbound' }] };
  if (sql.includes('bind_my_verified_nin') || sql.includes('record_my_nin_verification_evidence')) {
    return { rows: [{ evidenceId: String(values[2] ?? 'a8000000-0000-4000-8000-0000000000e1'), recordedAt: new Date() }] };
  }
  return undefined;
}

function system() {
  const protector = new NinIdentifierProtector();
  const lookup = protector.lookup(NIN);
  const store = fakeNinCheckStore();
  const qoreId = fakeQoreId((nin) => store.rows.get(protector.lookup(nin))?.state === 'checking');
  const audits: unknown[][] = [];
  /** While set, the guard's audit write fails (AuditService then refuses with 503). */
  const auditDown = { on: false };
  /** The profile's evidence rows: [result, provider reference, failure category] each. */
  const evidence: unknown[][] = [];
  const checkDatabase = {
    // As a transaction: a failed one leaves the check rows as they were.
    withSystemTransaction: jest.fn(async (_correlation: string, work: (client: PoolClient) => Promise<unknown>) => {
      const before = new Map([...store.rows].map(([key, row]) => [key, { ...row }]));
      try {
        return await work({ query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
          if (sql.includes('record_my_nin_verification_evidence')) evidence.push(values.slice(2, 5));
          return store.query(sql, values) ?? profileTables(sql, values) ?? { rows: [], rowCount: 0 };
        }) } as unknown as PoolClient);
      } catch (error) {
        store.rows.clear();
        for (const [key, row] of before) store.rows.set(key, row);
        throw error;
      }
    }),
    query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('insert into audit.events') && auditDown.on) throw new Error('audit unavailable');
      if (sql.includes('insert into audit.events')) audits.push([...values]);
      return { rows: [], rowCount: 1 };
    }),
  } as unknown as DatabaseService;
  const ninCheck = new NinCheckOnce(checkDatabase, protector, new AuditService(checkDatabase));
  created.push(ninCheck);
  const adapter = new QoreIdVerificationAdapter({ baseUrl: 'https://qoreid.fixture.invalid', clientId: 'fixture-client',
    clientSecret: 'fixture-secret', timeoutMs: 100, ninOnlyEnrollmentEnabled: true },
  qoreId.fetch as unknown as typeof globalThis.fetch);
  const integrations = { assertAvailable: jest.fn().mockResolvedValue(undefined),
    consumePatientQuota: jest.fn().mockResolvedValue(undefined) } as unknown as IntegrationRuntimeService;
  const ninOnly = new QoreIdPublicPatientIdentityProvider(adapter, integrations, ninCheck);
  const provider = new QoreIdNinVerificationProvider(ninOnly, ninCheck);
  // The patient's own "Add NIN" on the profile, as it really asks (its name and date of birth, any record).
  const profile = new QoreIdVerificationService(checkDatabase, adapter, integrations, protector, ninCheck);
  const verifyProfile = () => profile.verifyPatientNin({ correlationId: 'profile-check', actor: { kind: 'patient',
    patientId: PROFILE.patientId, accountId: 'a8000000-0000-4000-8000-000000000002', subject: 'patient:fixture',
    sessionId: 'a8000000-0000-4000-8000-000000000003', roles: [], permissions: [], facilityIds: [], facilities: [] },
  header: () => undefined } as unknown as HidRequest, NIN);
  const cases: unknown[][] = [];
  /** Active patients holding a NIN verified, by NIN lookup HMAC (identity.patient_identifiers). */
  const healthIds = new Map<string, Record<string, unknown>>();
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('from identity.patient_identifiers identifier')) {
      const patient = healthIds.get(String(values[0]));
      return { rows: patient ? [patient] : [] };
    }
    if (/insert into identity\.registration_cases \(/.test(sql)) {
      cases.push(values);
      return { rows: [{ id: caseId }] };
    }
    if (/where registration\.id = \$1/.test(sql)) {
      return { rows: [{ id: caseId, status: 'pending_new_identity_approval', row_version: '1', resolved_patient_id: null,
        resolved_hid_code: null, candidate_count: '0', contact_recorded: false, nin_verified: true }] };
    }
    return { rows: [] };
  });
  /** While on, the desk's facility is one of the sealed demo or QA tenant's (0098, 0123). */
  const sealed = { on: false };
  const deskDatabase = { withTransaction: jest.fn(async (_c: unknown, work: (client: unknown) => unknown) => work({ query })),
    query: jest.fn(async (sql: string) => ({ rows: sql === SEALED_TENANT_SQL ? [{ sealed: sealed.on }] : [] })) };
  const deskAudit = { record: jest.fn(async (_row: { action: string; details: unknown }) => undefined),
    recordWithClient: jest.fn(async (_client: unknown, _row: { action: string; details: unknown }) => undefined) };
  const breaker = new NinProviderBreaker();
  const service = new NinRegistrationService(deskDatabase as never, deskAudit as never, protector, {} as never,
    provider, breaker);
  const resolve = (key: string, context = deskContext(), body = input) => service.resolve(body, key, context);
  /** The guard's audit rows: [path, source, result, correlation id] each. */
  const checkAudits = () => audits.filter((values) => values[8] === 'identity.qoreid.nin-check')
    .map((values) => { const details = JSON.parse(String(values[16])) as Record<string, unknown>;
      return [details.path, details.source, details.result, values[0]]; });
  /** The desk's own identity.nin.verify rows (details). */
  const deskChecks = () => deskAudit.record.mock.calls.map(([row]) => row)
    .filter((row) => row.action === 'identity.nin.verify').map((row) => row.details);
  return { qoreId, store, ninCheck, ninOnly, resolve, breaker, cases, checkAudits, deskChecks, deskAudit, lookup,
    verifyProfile, protector, healthIds, auditDown, sealed, evidence };
}

describe('Q108 desk NIN check through 0137\'s once-per-NIN guard (path \'desk\')', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://app.fixture.invalid', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      NIN_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 5).toString('base64'),
      NIN_ENCRYPTION_KEY_B64: Buffer.alloc(32, 6).toString('base64'),
      CONTACT_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 8).toString('base64'),
      OTP_HMAC_KEY_B64: Buffer.alloc(32, 9).toString('base64'),
      QOREID_ENABLED: 'true', QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'true',
      QOREID_CLIENT_ID: 'fixture-client', QOREID_CLIENT_SECRET: 'fixture-secret', QOREID_TIMEOUT_MS: '250',
      QOREID_NIN_ANSWER_CEILING_MS: '1000', QOREID_PATIENT_SELF_NIN_BINDING_ENABLED: 'true',
    });
    resetEnvironmentForTests();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await Promise.all(created.splice(0).map((check) => check.settle()));
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
    jest.restoreAllMocks();
  });

  it('checks the NIN once, audited by the guard as the desk under the request\'s correlation id', async () => {
    const s = system();
    await expect(s.resolve('desk-once-key-000001')).resolves.toMatchObject({ caseId, ninStatus: 'verified' });
    expect(s.qoreId.state.charged).toBe(1);
    expect(s.checkAudits()).toEqual([['desk', 'qoreid', 'record', 'desk-once-1']]);
    // verification_provider and verification_reference: QoreID's transaction id, never the NIN.
    expect(s.cases[0]?.slice(14, 16)).toEqual(['qoreid', '8001']);
    expect(s.deskChecks()).toEqual([{ provider: 'qoreid', ninCheck: 'match' }]);
    expect(s.qoreId.state.outsideGuard).toBe(0);
  });

  it('asks QoreID once when two desks check the same NIN at the same moment', async () => {
    const s = system();
    s.qoreId.state.delayMs = 40;
    const results = await Promise.allSettled([s.resolve('desk-once-key-000002', deskContext(1)),
      s.resolve('desk-once-key-000003', deskContext(2))]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(s.qoreId.state.charged).toBe(1);
    expect(s.checkAudits().map(([path, source]) => [path, source])).toEqual([['desk', 'qoreid'], ['desk', 'stored']]);
  });

  it('asks QoreID once when the same request arrives twice at once (a double click)', async () => {
    const s = system();
    s.qoreId.state.delayMs = 40;
    const results = await Promise.allSettled([s.resolve('desk-once-key-000017'), s.resolve('desk-once-key-000017')]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(s.qoreId.state.charged).toBe(1);
    expect(s.checkAudits().map(([path, source]) => [path, source])).toEqual([['desk', 'qoreid'], ['desk', 'stored']]);
  });

  it('answers a resend after "could not be verified" from the stored answer, with the same key or a new one', async () => {
    const s = system();
    s.qoreId.state.fallback = 'no_record';
    for (const key of ['desk-once-key-000004', 'desk-once-key-000004', 'desk-once-key-000005']) {
      await expect(s.resolve(key)).rejects.toMatchObject(NO_RECORD_ANSWER);
    }
    expect(s.qoreId.state.charged).toBe(1);
    expect(s.breaker.state()).toBe('closed');
    expect(s.checkAudits().map(([path, source, result]) => [path, source, result])).toEqual([
      ['desk', 'qoreid', 'no_record'], ['desk', 'stored', 'no_record'], ['desk', 'stored', 'no_record']]);
  });

  it('does not charge again when the desk corrects a name or date of birth that did not match', async () => {
    const s = system();
    await expect(s.resolve('desk-once-key-000006', deskContext(), { ...input, lastName: 'Fixtura' }))
      .rejects.toMatchObject({ status: 422, code: 'NIN_VERIFICATION_FAILED',
        message: 'The name or date of birth does not match the NIN record. Check the spelling and the date of birth.' });
    await expect(s.resolve('desk-once-key-000007', deskContext(), { ...input, dateOfBirth: '1988-07-15' }))
      .rejects.toMatchObject({ status: 422 });
    await expect(s.resolve('desk-once-key-000008')).resolves.toMatchObject({ caseId, ninStatus: 'verified' });
    expect(s.qoreId.state.charged).toBe(1);
    // The second and third are compared with the stored record: nothing was sent for them.
    expect(s.deskChecks()).toEqual([{ provider: 'qoreid', ninCheck: 'name_mismatch' },
      { provider: 'qoreid', ninCheck: 'name_mismatch', storedAnswer: true },
      // Q115: the record the corrected details matched is kept by 0137's shared rule.
      { provider: 'qoreid', ninCheck: 'match', storedAnswer: true, recordKept: true }]);
  });

  it('reuses the answer of a sign-up or profile check of the same NIN, and the other paths reuse the desk\'s', async () => {
    const s = system();
    await s.ninOnly.verifyNin(NIN, { correlationId: 'signup-check', path: 'enrollment' });
    await expect(s.resolve('desk-once-key-000009')).resolves.toMatchObject({ caseId });
    // The profile's own check (its name and date of birth, any record), as the patient's "Add NIN" makes it.
    await expect(s.verifyProfile()).resolves.toMatchObject({ state: 'verified' });
    expect(s.qoreId.state.charged).toBe(1);
    expect(s.checkAudits()).toEqual([['enrollment', 'qoreid', 'record', 'signup-check'],
      ['desk', 'stored', 'record', 'desk-once-1'], ['profile', 'stored', 'record', 'profile-check']]);
  });

  it('asks QoreID once when a sign-up and the desk check the same NIN at the same moment', async () => {
    const s = system();
    s.qoreId.state.delayMs = 40;
    await Promise.allSettled([s.ninOnly.verifyNin(NIN, { correlationId: 'signup-check', path: 'enrollment' }),
      s.resolve('desk-once-key-000010')]);
    expect(s.qoreId.state.charged).toBe(1);
    expect(s.checkAudits().filter(([, source]) => source === 'qoreid')).toHaveLength(1);
  });

  it('answers 504 QOREID_TIMEOUT with retryAfterSeconds when the wait ends, and the retry reuses the late answer', async () => {
    const s = system();
    s.qoreId.state.modes = ['late'];
    const first = await s.resolve('desk-once-key-000011').catch((error: unknown) => error);
    expect(first).toMatchObject({ status: 504, code: 'QOREID_TIMEOUT', extensions: { retryAfterSeconds: 60 } });
    await s.ninCheck.settle();
    // The website sends the same Idempotency-Key again.
    await expect(s.resolve('desk-once-key-000011')).resolves.toMatchObject({ caseId, ninStatus: 'verified' });
    expect(s.qoreId.state.charged).toBe(1);
    expect(s.checkAudits().map(([path, source, result]) => [path, source, result])).toEqual([
      ['desk', 'qoreid', 'timeout'], ['desk', 'late', 'record'], ['desk', 'stored', 'record']]);
    expect(s.deskChecks()).toEqual([
      expect.objectContaining({ code: 'QOREID_TIMEOUT', providerCalled: true, ninCheck: 'provider_error' }),
      { provider: 'qoreid', ninCheck: 'match', storedAnswer: true, recordKept: true }]);
  });

  it('answers QoreID\'s own 504 QOREID_TIMEOUT (its token request hung) with retryAfterSeconds, sending nothing', async () => {
    const s = system();
    s.qoreId.state.tokenHangs = true;
    const answer = await s.resolve('desk-once-key-000018').catch((error: unknown) => error);
    expect(answer).toMatchObject({ status: 504, code: 'QOREID_TIMEOUT', extensions: { retryAfterSeconds: 60 } });
    // The NIN never reached QoreID: nothing charged or kept, the NIN free for the retry; QoreID failing counts once.
    expect(s.qoreId.state.charged).toBe(0);
    expect(s.store.rows.size).toBe(0);
    expect(warn.mock.calls.filter(([entry]) => (entry as { event?: string }).event
      === 'identity.nin_provider.unavailable')).toHaveLength(1);
    s.qoreId.state.tokenHangs = false;
    await expect(s.resolve('desk-once-key-000018')).resolves.toMatchObject({ caseId });
    expect(s.qoreId.state.charged).toBe(1);
  });

  it('answers 409 NIN_CHECK_HELD with retryAfterSeconds for a NIN held after a check QoreID may have charged', async () => {
    const s = system();
    s.qoreId.state.modes = ['reset'];
    // The connection was lost after a sign-up's request was written.
    await expect(s.ninOnly.verifyNin(NIN, { correlationId: 'signup-check', path: 'enrollment' }))
      .rejects.toMatchObject({ code: 'QOREID_NETWORK_UNAVAILABLE' });
    const held = await s.resolve('desk-once-key-000012').catch((error: unknown) => error) as {
      extensions: { retryAfterSeconds: number } };
    expect(held).toMatchObject({ status: 409, code: 'NIN_CHECK_HELD',
      message: 'We could not finish checking this NIN. Please try again in 5 minutes.' });
    expect(held.extensions.retryAfterSeconds).toBeGreaterThan(NIN_CHECK_HOLD_SECONDS - 10);
    expect(held.extensions.retryAfterSeconds).toBeLessThanOrEqual(NIN_CHECK_HOLD_SECONDS);
    expect(s.qoreId.state.charged).toBe(1);
    // Nothing was sent for the desk: not an outage.
    expect(s.breaker.state()).toBe('closed');
    expect(warn).not.toHaveBeenCalled();
    expect(s.deskChecks()).toEqual([expect.objectContaining({ code: 'NIN_CHECK_HELD', providerCalled: false })]);
    // After the hold the desk checks it.
    s.store.clock.offsetMs = NIN_CHECK_HOLD_SECONDS * 1000 + 1000;
    await expect(s.resolve('desk-once-key-000012')).resolves.toMatchObject({ caseId });
    expect(s.qoreId.state.charged).toBe(2);
  });

  it('holds the NIN after a desk check that failed once sent, instead of paying again on the resend', async () => {
    const s = system();
    s.qoreId.state.modes = ['forbidden'];
    await expect(s.resolve('desk-once-key-000013')).rejects.toMatchObject({ code: 'QOREID_PROVIDER_REJECTED' });
    await expect(s.resolve('desk-once-key-000013')).rejects.toMatchObject({ status: 409, code: 'NIN_CHECK_HELD' });
    expect(s.qoreId.state.charged).toBe(1);
  });

  it('answers 409 NIN_CHECK_IN_PROGRESS when another check of the NIN is still running past the wait', async () => {
    const s = system();
    // A lease another task holds (a very slow answer, or a stopped process).
    s.store.rows.set(s.lookup, { nin_lookup_hmac: s.lookup, state: 'checking',
      attempt_id: 'b8000000-0000-4000-8000-0000000000ff', question_hmac: null, outcome: null, record_complete: null,
      record_source: null, answer_ciphertext: null, key_version: null, until: Date.now() + 60_000 });
    const answer = await s.resolve('desk-once-key-000014').catch((error: unknown) => error);
    expect(answer).toMatchObject({ status: 409, code: 'NIN_CHECK_IN_PROGRESS',
      message: 'We are still checking this NIN. Please wait a minute, then try again.',
      extensions: { retryAfterSeconds: 60 } });
    expect(s.qoreId.state.charged).toBe(0);
    expect(s.breaker.state()).toBe('closed');
    expect(s.deskChecks()).toEqual([expect.objectContaining({ code: 'NIN_CHECK_IN_PROGRESS', providerCalled: false })]);
    expect(s.checkAudits()).toEqual([['desk', 'none', 'in_progress', 'desk-once-1']]);
  }, 15_000);

  it('answers "cannot be started" and sends nothing when the guard\'s store cannot be reached', async () => {
    const s = system();
    s.store.fail('begin_qoreid_nin_check');
    await expect(s.resolve('desk-once-key-000015')).rejects.toMatchObject({ status: 503, code: 'NIN_PROVIDER_UNAVAILABLE',
      message: 'NIN checks cannot be started right now. Please try again in a minute.' });
    expect(s.qoreId.state.charged).toBe(0);
    expect(s.breaker.state()).toBe('closed');
    expect(s.deskChecks()).toEqual([expect.objectContaining({ providerCalled: false })]);
  });

  it('never puts the NIN in a desk audit row, a guard audit row or a log line', async () => {
    const s = system();
    s.qoreId.state.modes = ['late', 'no_record'];
    await s.resolve('desk-once-key-000016').catch(() => undefined);
    await s.ninCheck.settle();
    await s.resolve('desk-once-key-000016');
    const logged = JSON.stringify(warn.mock.calls);
    for (const text of [JSON.stringify(s.deskAudit.record.mock.calls), JSON.stringify(s.deskAudit.recordWithClient.mock.calls),
      JSON.stringify(s.checkAudits()), logged]) {
      expect(text).not.toContain(NIN);
      expect(text).not.toContain(s.lookup);
    }
    expect(s.qoreId.state.outsideGuard).toBe(0);
  });

  describe('any record will do: the desk compares only the name and date of birth', () => {
    it('uses a record a profile check kept without a recognised sex, without paying again', async () => {
      const s = system();
      s.qoreId.state.modes = ['no_gender'];
      await expect(s.verifyProfile()).resolves.toMatchObject({ state: 'verified' });
      expect([...s.store.rows.values()][0]).toMatchObject({ outcome: 'record', record_complete: false });
      await expect(s.resolve('desk-once-key-000101')).resolves.toMatchObject({ caseId, ninStatus: 'verified' });
      expect(s.qoreId.state.charged).toBe(1);
      expect(s.checkAudits().map(([path, source, result]) => [path, source, result])).toEqual([
        ['profile', 'qoreid', 'record'], ['desk', 'stored', 'record']]);
    });

    it('asks QoreID once when the profile and the desk check such a NIN at the same moment', async () => {
      const s = system();
      s.qoreId.state.modes = ['no_gender'];
      s.qoreId.state.delayMs = 40;
      const results = await Promise.allSettled([s.verifyProfile(), s.resolve('desk-once-key-000102')]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(s.qoreId.state.charged).toBe(1);
    });

    it.each([
      ['no recognised sex', 'no_gender'],
      ['a home address with a line break', 'address_break'],
    ] as const)('checks a NIN whose record has %s once, and answers it, not 502', async (_label, mode) => {
      const s = system();
      s.qoreId.state.modes = [mode];
      const before = Date.now();
      await expect(s.resolve('desk-once-key-000103')).resolves.toMatchObject({ caseId, ninStatus: 'verified' });
      // Kept as a profile check keeps such a record: incomplete, for as long as a record (Q110), not 24 hours.
      const kept = [...s.store.rows.values()][0];
      expect(kept).toMatchObject({ state: 'answered', outcome: 'record', record_complete: false });
      expect(kept!.until).toBeGreaterThanOrEqual(before + NIN_RECORD_ANSWER_SECONDS * 1000);
      await expect(s.resolve('desk-once-key-000104')).resolves.toMatchObject({ caseId });
      // Two days later, another desk (or the profile) still reuses it.
      s.store.clock.offsetMs = 2 * NIN_NO_RECORD_ANSWER_SECONDS * 1000;
      await expect(s.resolve('desk-once-key-000108', deskContext(2))).resolves.toMatchObject({ caseId });
      await expect(s.verifyProfile()).resolves.toMatchObject({ state: 'verified' });
      expect(s.qoreId.state.charged).toBe(1);
      expect(s.breaker.state()).toBe('closed');
      // The sex came from neither: the desk gave none and the record's is not usable.
      expect(s.cases[0]?.[9]).toBeNull();
    });

    it('lets the profile reuse the record the desk paid for', async () => {
      const s = system();
      await expect(s.resolve('desk-once-key-000105')).resolves.toMatchObject({ caseId });
      await expect(s.verifyProfile()).resolves.toMatchObject({ state: 'verified' });
      expect(s.qoreId.state.charged).toBe(1);
    });

    it('keeps a record the desk did not match (perhaps someone else\'s NIN) 24 hours, a matched one 90 days', async () => {
      const mismatch = system();
      const before = Date.now();
      await expect(mismatch.resolve('desk-once-key-000106', deskContext(), { ...input, lastName: 'Fixtura' }))
        .rejects.toMatchObject({ status: 422, code: 'NIN_VERIFICATION_FAILED' });
      const kept = [...mismatch.store.rows.values()][0];
      expect(kept).toMatchObject({ state: 'answered', outcome: 'record' });
      expect(kept!.until).toBeGreaterThanOrEqual(before + NIN_NO_RECORD_ANSWER_SECONDS * 1000);
      expect(kept!.until).toBeLessThan(Date.now() + NIN_NO_RECORD_ANSWER_SECONDS * 1000 + 5_000);
      const matched = system();
      await expect(matched.resolve('desk-once-key-000107')).resolves.toMatchObject({ caseId });
      expect([...matched.store.rows.values()][0]!.until)
        .toBeGreaterThanOrEqual(before + NIN_RECORD_ANSWER_SECONDS * 1000);
    });
  });

  describe('a stored record the desk matches is kept by 0137\'s shared rule (Q115)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    /** Q115: each later use keeps the record at least this long from that use. */
    const USE_KEEP_MS = 30 * DAY_MS;
    /** The desk's calls of 0137's keep: [key version, seconds] each (the lookup HMAC is never asserted on). */
    const keeps = (s: ReturnType<typeof system>) => s.store.calls
      .filter(({ sql }) => sql.includes('identity.keep_qoreid_nin_record'))
      .map(({ values }) => [values[1], values[2]]);

    it('keeps a record first kept 24 hours after a typo at least 30 days from the corrected match: no second charge', async () => {
      const s = system();
      // A typo: QoreID's record does not match, so it is kept 24 hours (perhaps someone else's NIN).
      await expect(s.resolve('desk-once-key-000500', deskContext(), { ...input, lastName: 'Fixtura' }))
        .rejects.toMatchObject({ status: 422, code: 'NIN_VERIFICATION_FAILED' });
      const first = { ...[...s.store.rows.values()][0]! };
      expect(first.until).toBeLessThan(Date.now() + NIN_NO_RECORD_ANSWER_SECONDS * 1000 + 5_000);
      expect(keeps(s)).toEqual([]);
      // The corrected request, two hours later, matches the stored record: a use of it.
      s.store.clock.offsetMs = 2 * 60 * 60 * 1000;
      const used = Date.now() + s.store.clock.offsetMs;
      await expect(s.resolve('desk-once-key-000501')).resolves.toMatchObject({ caseId, ninStatus: 'verified' });
      const kept = [...s.store.rows.values()][0]!;
      // The same answer, unread and unchanged: its completeness, source, key and ciphertext.
      expect(kept).toMatchObject({ state: 'answered', outcome: 'record', record_complete: true,
        record_source: first.record_source, key_version: first.key_version, answer_ciphertext: first.answer_ciphertext });
      expect(kept.until).toBeGreaterThanOrEqual(used + USE_KEEP_MS);
      expect(keeps(s)).toEqual([[first.key_version, expect.any(Number)]]);
      expect(s.deskChecks()[1]).toEqual({ provider: 'qoreid', ninCheck: 'match', storedAnswer: true, recordKept: true });
      // Twenty-nine days after that use another desk, and the patient's profile, are answered from storage.
      s.store.clock.offsetMs += 29 * DAY_MS;
      await expect(s.resolve('desk-once-key-000502', deskContext(2))).resolves.toMatchObject({ caseId });
      await expect(s.verifyProfile()).resolves.toMatchObject({ state: 'verified' });
      expect(s.qoreId.state.charged).toBe(1);
      expect(s.checkAudits().map(([path, source]) => [path, source])).toEqual([['desk', 'qoreid'], ['desk', 'stored'],
        ['desk', 'stored'], ['profile', 'stored']]);
      expect(s.qoreId.state.outsideGuard).toBe(0);
    });

    it('keeps a record 90 days from its first check, and each later desk match keeps it 30 days from that match', async () => {
      const s = system();
      const checked = Date.now();
      await expect(s.resolve('desk-once-key-000503')).resolves.toMatchObject({ caseId });
      // The first check: the guard keeps the record 90 days; the desk asks for no keep.
      expect([...s.store.rows.values()][0]!.until).toBeGreaterThanOrEqual(checked + NIN_RECORD_ANSWER_SECONDS * 1000);
      expect(keeps(s)).toEqual([]);
      // A desk match on day 10 does not end it before day 90.
      s.store.clock.offsetMs = 10 * DAY_MS;
      await expect(s.resolve('desk-once-key-000504', deskContext(2))).resolves.toMatchObject({ caseId });
      expect([...s.store.rows.values()][0]!.until).toBeGreaterThanOrEqual(checked + NIN_RECORD_ANSWER_SECONDS * 1000);
      // A desk match on day 80 keeps it to at least day 110, so day 109 is still answered from storage.
      s.store.clock.offsetMs = 80 * DAY_MS;
      await expect(s.resolve('desk-once-key-000505', deskContext(3))).resolves.toMatchObject({ caseId });
      expect([...s.store.rows.values()][0]!.until).toBeGreaterThanOrEqual(checked + 80 * DAY_MS + USE_KEEP_MS);
      s.store.clock.offsetMs = 109 * DAY_MS;
      await expect(s.resolve('desk-once-key-000506', deskContext(4))).resolves.toMatchObject({ caseId });
      expect(s.qoreId.state.charged).toBe(1);
      // One keep for each later use: days 10, 80 and 109.
      expect(keeps(s)).toHaveLength(3);
    });

    it('keeps a record another check kept 24 hours (its details did not match) once the desk\'s details match it', async () => {
      const s = system();
      // Another check of the NIN whose details were not the record's: QoreID's record, kept 24 hours.
      await s.ninOnly.verifyNinRecord(NIN, { correlationId: 'other-check', path: 'other', expects: () => false });
      expect([...s.store.rows.values()][0]!.until).toBeLessThan(Date.now() + NIN_NO_RECORD_ANSWER_SECONDS * 1000 + 5_000);
      s.store.clock.offsetMs = 60 * 60 * 1000;
      await expect(s.resolve('desk-once-key-000507')).resolves.toMatchObject({ caseId });
      s.store.clock.offsetMs += 29 * DAY_MS;
      await expect(s.resolve('desk-once-key-000508', deskContext(2))).resolves.toMatchObject({ caseId });
      expect(s.qoreId.state.charged).toBe(1);
    });

    it('asks for no keep after "does not match" or a stored "no record", and changes neither', async () => {
      const s = system();
      await expect(s.resolve('desk-once-key-000509', deskContext(), { ...input, lastName: 'Fixtura' }))
        .rejects.toMatchObject({ status: 422 });
      const mismatched = { ...[...s.store.rows.values()][0]! };
      await expect(s.resolve('desk-once-key-000510', deskContext(), { ...input, lastName: 'Fixtura' }))
        .rejects.toMatchObject({ status: 422 });
      expect([...s.store.rows.values()][0]).toEqual(mismatched);
      const other = system();
      other.qoreId.state.modes = ['no_record'];
      for (const key of ['desk-once-key-000511', 'desk-once-key-000512']) {
        await expect(other.resolve(key)).rejects.toMatchObject({ status: 422 });
      }
      expect([keeps(s), keeps(other)]).toEqual([[], []]);
      expect(s.deskChecks().concat(other.deskChecks())).toEqual(
        [expect.not.objectContaining({ recordKept: true }), expect.not.objectContaining({ recordKept: true }),
          expect.not.objectContaining({ recordKept: true }), expect.not.objectContaining({ recordKept: true })]);
    });

    it('never fails the desk\'s answer when the keep cannot be written, and logs no identifier', async () => {
      const s = system();
      await expect(s.resolve('desk-once-key-000513', deskContext(), { ...input, lastName: 'Fixtura' }))
        .rejects.toMatchObject({ status: 422 });
      const before = { ...[...s.store.rows.values()][0]! };
      s.store.fail('keep_qoreid_nin_record');
      await expect(s.resolve('desk-once-key-000514')).resolves.toMatchObject({ caseId });
      s.store.fail(undefined);
      // Nothing written: still the 24-hour keep, the same answer.
      expect([...s.store.rows.values()][0]).toEqual(before);
      expect(s.deskChecks()[1]).toEqual({ provider: 'qoreid', ninCheck: 'match', storedAnswer: true });
      expect(warn).toHaveBeenCalledWith({ event: 'identity.nin.record_keep_failed', correlationId: 'desk-once-1',
        code: '57P01' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(NIN);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(s.lookup);
      expect(s.qoreId.state.charged).toBe(1);
    });
  });

  describe('a NIN QoreID has no record of: one 422 on the desk, sign-up and the profile (Q117)', () => {
    const signUp = (s: ReturnType<typeof system>) => s.ninOnly.verifyNin(NIN, { correlationId: 'signup-check',
      path: 'enrollment' });

    it('answers QoreID\'s 404 at the desk 422 NIN_NOT_VERIFIED, and a sign-up and the profile the same from storage', async () => {
      const s = system();
      s.qoreId.state.fallback = 'not_found';
      await expect(s.resolve('desk-once-key-000701')).rejects.toMatchObject(NO_RECORD_ANSWER);
      await expect(signUp(s)).rejects.toMatchObject(NO_RECORD_ANSWER);
      await expect(s.verifyProfile()).rejects.toMatchObject(NO_RECORD_ANSWER);
      expect(s.qoreId.state.charged).toBe(1);
      // The profile's evidence for a 404 is as before: a provider error, nothing verified.
      expect(s.evidence).toEqual([['provider_error', null, 'unexpected_response']]);
      expect(s.checkAudits().map(([path, source, result]) => [path, source, result])).toEqual([
        ['desk', 'qoreid', 'rejected'], ['enrollment', 'stored', 'rejected'], ['profile', 'stored', 'rejected']]);
      expect(s.deskChecks()).toEqual([{ provider: 'qoreid', ninCheck: 'no_match' }]);
      expect(s.breaker.state()).toBe('closed');
    });

    it('answers QoreID\'s 404 at sign-up 422 NIN_NOT_VERIFIED, and the desk the same from storage', async () => {
      const s = system();
      s.qoreId.state.fallback = 'not_found';
      await expect(signUp(s)).rejects.toMatchObject(NO_RECORD_ANSWER);
      await expect(s.resolve('desk-once-key-000702')).rejects.toMatchObject(NO_RECORD_ANSWER);
      expect(s.qoreId.state.charged).toBe(1);
      expect(s.deskChecks()).toEqual([{ provider: 'qoreid', ninCheck: 'no_match', storedAnswer: true }]);
    });

    it('answers QoreID\'s 404 on the profile 422 NIN_NOT_VERIFIED, and the desk and a sign-up the same from storage', async () => {
      const s = system();
      s.qoreId.state.fallback = 'not_found';
      await expect(s.verifyProfile()).rejects.toMatchObject(NO_RECORD_ANSWER);
      expect(s.evidence).toEqual([['provider_error', null, 'unexpected_response']]);
      await expect(s.resolve('desk-once-key-000703')).rejects.toMatchObject(NO_RECORD_ANSWER);
      await expect(signUp(s)).rejects.toMatchObject(NO_RECORD_ANSWER);
      expect(s.qoreId.state.charged).toBe(1);
      expect(s.checkAudits().map(([path, source]) => [path, source])).toEqual([
        ['profile', 'qoreid'], ['desk', 'stored'], ['enrollment', 'stored']]);
    });

    it('answers QoreID\'s "no record" at the desk or at sign-up 422 NIN_NOT_VERIFIED, fresh and from storage', async () => {
      const desk = system();
      desk.qoreId.state.fallback = 'no_record';
      await expect(desk.resolve('desk-once-key-000704')).rejects.toMatchObject(NO_RECORD_ANSWER);
      await expect(signUp(desk)).rejects.toMatchObject(NO_RECORD_ANSWER);
      const enrollment = system();
      enrollment.qoreId.state.fallback = 'no_record';
      await expect(signUp(enrollment)).rejects.toMatchObject(NO_RECORD_ANSWER);
      await expect(enrollment.resolve('desk-once-key-000705')).rejects.toMatchObject(NO_RECORD_ANSWER);
      expect([desk.qoreId.state.charged, enrollment.qoreId.state.charged]).toEqual([1, 1]);
    });

    it('keeps "does not match" (a record whose name or date of birth is not the desk\'s) a different answer', async () => {
      const s = system();
      await expect(s.resolve('desk-once-key-000706', deskContext(), { ...input, lastName: 'Fixtura' }))
        .rejects.toMatchObject({ status: 422, code: 'NIN_VERIFICATION_FAILED',
          message: 'The name or date of birth does not match the NIN record. Check the spelling and the date of birth.' });
    });
  });

  describe('the breaker counts only what QoreID did (D4)', () => {
    const NINS = ['70000000003', '70000000004', '70000000005'];

    it('counts each desk wait that runs out, and closes again when QoreID\'s slow answers come; retries reuse them', async () => {
      const s = system();
      s.qoreId.state.fallback = 'late';
      const first = await Promise.all(NINS.map((nin, index) => s.resolve(`desk-once-key-00020${index}`,
        deskContext(index + 1), { ...input, nin }).catch((error: unknown) => error)));
      expect(first).toEqual(NINS.map(() => expect.objectContaining({ status: 504, code: 'QOREID_TIMEOUT' })));
      // Three waits ran out: as three timeouts, they open it.
      expect(s.breaker.state()).toBe('open');
      await s.ninCheck.settle();
      // QoreID answered all three late: those answers are recorded as successes.
      expect(s.breaker.state()).toBe('closed');
      // The website resends with the same Idempotency-Key after retryAfterSeconds.
      const retries = await Promise.all(NINS.map((nin, index) => s.resolve(`desk-once-key-00020${index}`,
        deskContext(index + 1), { ...input, nin }).catch((error: unknown) => error)));
      expect(retries).toEqual(NINS.map(() => expect.objectContaining({ caseId })));
      expect(s.qoreId.state.charged).toBe(3);
      expect(s.qoreId.state.outsideGuard).toBe(0);
    });

    it('is tripped by a QoreID that hangs after the usual three waits, not at its 90-second ceiling', async () => {
      const s = system();
      s.qoreId.state.fallback = 'slow';
      for (const [index, nin] of NINS.entries()) {
        await expect(s.resolve(`desk-once-key-00021${index}`, deskContext(index + 1), { ...input, nin }))
          .rejects.toMatchObject({ status: 504, code: 'QOREID_TIMEOUT' });
      }
      // Open as soon as the third wait ran out, while the three checks are still waiting on QoreID.
      expect(s.breaker.state()).toBe('open');
      await expect(s.resolve('desk-once-key-000219', deskContext(4), { ...input, nin: '70000000006' }))
        .rejects.toMatchObject({ status: 503, code: 'NIN_PROVIDER_UNAVAILABLE' });
      expect(s.qoreId.state.charged).toBe(3);
      // QoreID never answers them: each was counted once, at its wait.
      await s.ninCheck.settle();
      expect(s.breaker.state()).toBe('open');
      expect(warn.mock.calls.filter(([entry]) => (entry as { event?: string }).event
        === 'identity.nin_provider.unavailable')).toHaveLength(3);
    });

    it('never counts QoreID\'s "not found": it is QoreID\'s answer, fresh or given again from storage', async () => {
      const s = system();
      s.qoreId.state.modes = ['not_found', 'not_found', 'not_found'];
      for (const [index, nin] of NINS.entries()) {
        await expect(s.resolve(`desk-once-key-00022${index}`, deskContext(index + 1), { ...input, nin }))
          .rejects.toMatchObject(NO_RECORD_ANSWER);
      }
      for (const key of ['desk-once-key-000220', 'desk-once-key-000223']) {
        await expect(s.resolve(key, deskContext(1), { ...input, nin: NINS[0]! }))
          .rejects.toMatchObject(NO_RECORD_ANSWER);
      }
      expect(s.qoreId.state.charged).toBe(3);
      expect(s.breaker.state()).toBe('closed');
      expect(s.deskChecks()).toEqual([
        ...NINS.map(() => ({ provider: 'qoreid', ninCheck: 'no_match' })),
        { provider: 'qoreid', ninCheck: 'no_match', storedAnswer: true },
        { provider: 'qoreid', ninCheck: 'no_match', storedAnswer: true }]);
      // Another desk's new NIN is still checked.
      await expect(s.resolve('desk-once-key-000224', deskContext(2))).resolves.toMatchObject({ caseId });
    });

    it('records QoreID\'s late 404 behind a desk wait as its answer: three such waits open it, the answers close it', async () => {
      // D4(a) inside verifyNinRecord: a 404 QoreID gives after the desk stopped waiting settles as answered.
      const s = system();
      s.qoreId.state.delayMs = 500;
      s.qoreId.state.modes = ['not_found', 'not_found', 'not_found'];
      const first = await Promise.all(NINS.map((nin, index) => s.resolve(`desk-once-key-00026${index}`,
        deskContext(index + 1), { ...input, nin }).catch((error: unknown) => error)));
      expect(first).toEqual(NINS.map(() => expect.objectContaining({ status: 504, code: 'QOREID_TIMEOUT' })));
      expect(s.breaker.state()).toBe('open');
      await s.ninCheck.settle();
      expect(s.breaker.state()).toBe('closed');
      expect(s.qoreId.state.charged).toBe(3);
      // The retries are answered from the stored 404: QoreID has no record of the NIN (Q117).
      await expect(s.resolve('desk-once-key-000260', deskContext(1), { ...input, nin: NINS[0]! }))
        .rejects.toMatchObject(NO_RECORD_ANSWER);
      expect(s.qoreId.state.charged).toBe(3);
    });

    it('never counts a fresh 404 when the guard\'s audit write fails after it: QoreID answered', async () => {
      // D4(a) and (c): the error the desk gets is HID's own (503); what QoreID did, a 404, is an answer.
      const s = system();
      s.auditDown.on = true;
      s.qoreId.state.modes = ['not_found', 'not_found', 'not_found'];
      for (const [index, nin] of NINS.entries()) {
        await expect(s.resolve(`desk-once-key-00027${index}`, deskContext(index + 1), { ...input, nin }))
          .rejects.toMatchObject({ status: 503 });
      }
      expect(s.qoreId.state.charged).toBe(3);
      expect(s.breaker.state()).toBe('closed');
      expect(warn.mock.calls.filter(([entry]) => (entry as { event?: string }).event
        === 'identity.nin_provider.unavailable')).toHaveLength(0);
    });

    it('counts a record born before 1900 as QoreID\'s answer: "does not match", the breaker closed', async () => {
      const s = system();
      s.qoreId.state.fallback = 'born_1899';
      for (const [index, nin] of NINS.entries()) {
        await expect(s.resolve(`desk-once-key-00028${index}`, deskContext(index + 1), { ...input, nin }))
          .rejects.toMatchObject({ status: 422, code: 'NIN_VERIFICATION_FAILED',
            message: 'The name or date of birth does not match the NIN record. Check the spelling and the date of birth.' });
      }
      expect(s.qoreId.state.charged).toBe(3);
      expect(s.breaker.state()).toBe('closed');
      expect(warn.mock.calls.filter(([entry]) => (entry as { event?: string }).event
        === 'identity.nin_provider.unavailable')).toHaveLength(0);
      // Kept as records that did not match: 24 hours.
      expect([...s.store.rows.values()].map((row) => [row.outcome, row.until < Date.now()
        + NIN_NO_RECORD_ANSWER_SECONDS * 1000 + 5_000])).toEqual(NINS.map(() => ['record', true]));
    });

    it('never counts the guard\'s own audit write failing, only what QoreID did', async () => {
      const s = system();
      s.auditDown.on = true;
      // QoreID answers each NIN, and the guard keeps the answer, but cannot audit it: 503 to the desk.
      for (const [index, nin] of NINS.entries()) {
        await expect(s.resolve(`desk-once-key-00025${index}`, deskContext(index + 1), { ...input, nin }))
          .rejects.toMatchObject({ status: 503 });
      }
      // The resends are answered from storage, whose audit row cannot be written either.
      for (const [index, nin] of NINS.entries()) {
        await expect(s.resolve(`desk-once-key-00025${index}`, deskContext(index + 1), { ...input, nin }))
          .rejects.toMatchObject({ status: 503 });
      }
      expect(s.qoreId.state.charged).toBe(3);
      expect(s.breaker.state()).toBe('closed');
      expect(s.deskChecks()).toEqual(NINS.concat(NINS).map(() =>
        expect.objectContaining({ errorType: 'ServiceUnavailableException', providerCalled: true })));
      s.auditDown.on = false;
      await expect(s.resolve('desk-once-key-000250', deskContext(1), { ...input, nin: NINS[0]! }))
        .resolves.toMatchObject({ caseId });
      expect(s.qoreId.state.charged).toBe(3);
    });

    it('does not let a stored answer close a breaker letting one check through', async () => {
      const s = system();
      await expect(s.resolve('desk-once-key-000230')).resolves.toMatchObject({ caseId });
      // QoreID went down a minute ago: one check may go through now.
      s.breaker.recordFailure(new DomainProblem(503, 'QOREID_PROVIDER_UNAVAILABLE', 'down'), {},
        Date.now() - NIN_BREAKER_RETRY_AFTER_MS);
      expect(s.breaker.state()).toBe('retrying');
      await expect(s.resolve('desk-once-key-000231', deskContext(2))).resolves.toMatchObject({ caseId });
      expect(s.breaker.state()).toBe('retrying');
      // Three desks with three new NINs while QoreID is still down: one is let through, not three.
      s.qoreId.state.fallback = 'unavailable';
      const burst = await Promise.all(NINS.map((nin, index) => s.resolve(`desk-once-key-00023${index + 2}`,
        deskContext(index + 3), { ...input, nin }).catch((error: unknown) => error)));
      expect(s.qoreId.state.charged).toBe(2);
      expect(burst.filter((answer) => (answer as DomainProblem).code === 'NIN_PROVIDER_UNAVAILABLE')).toHaveLength(2);
      expect(s.breaker.state()).toBe('open');
    });
  });

  describe('a NIN already on a Health ID (Q110: its checked answer stays with the record)', () => {
    /** The patient a sign-up with NIN created: their record's name and date of birth are the NIN record's. */
    function onHealthId(s: ReturnType<typeof system>) {
      s.healthIds.set(s.lookup, { patient_id: 'a8000000-0000-4000-8000-0000000000aa', hid_code: 'HID-FIXTURE-0001',
        first_name: 'BISOLA', last_name: 'FIXTURE', dob: '1988-07-14', gender: 'female',
        verification_provider: 'qoreid', verification_reference: '8001', verified_at: new Date('2026-12-01T09:00:00Z') });
    }

    it('matches a returning patient from the record, without paying QoreID again after the stored answer ends', async () => {
      const s = system();
      await s.ninOnly.verifyNin(NIN, { correlationId: 'signup-check', path: 'enrollment' });
      onHealthId(s);
      // Weeks later, at a second hospital: 0137's stored answer has ended.
      s.store.clock.offsetMs = NIN_RECORD_ANSWER_SECONDS * 1000 + 1000;
      await expect(s.resolve('desk-once-key-000301', deskContext(2))).resolves.toMatchObject({ caseId });
      expect(s.qoreId.state.charged).toBe(1);
      expect(s.checkAudits().map(([path, source]) => [path, source])).toEqual([['enrollment', 'qoreid']]);
      // status, provider, reference and time: HID's own checked answer; the case points at the patient.
      expect([s.cases[0]?.[4], ...(s.cases[0] ?? []).slice(14, 17), s.cases[0]?.[19]]).toEqual([
        'resolved_existing_identity', 'qoreid', '8001', '2026-12-01T09:00:00.000Z',
        'a8000000-0000-4000-8000-0000000000aa']);
      expect(s.cases[0]?.slice(5, 10)).toEqual(['Bisola', 'Fixture', 'Bisola Fixture', '1988-07-14', 'female']);
      expect(s.deskChecks()).toEqual([{ provider: 'qoreid', ninCheck: 'match', providerCalled: false,
        healthIdRecord: true }]);
    });

    it('answers other details "does not match" from the record: no QoreID call, nothing kept or written', async () => {
      const s = system();
      onHealthId(s);
      for (const [key, body] of [['desk-once-key-000302', { ...input, dateOfBirth: '1988-07-15' }],
        ['desk-once-key-000303', { ...input, firstName: 'Bisi' }]] as const) {
        await expect(s.resolve(key, deskContext(), body)).rejects.toMatchObject({ status: 422,
          code: 'NIN_VERIFICATION_FAILED',
          message: 'The name or date of birth does not match the NIN record. Check the spelling and the date of birth.' });
      }
      expect(s.qoreId.state.charged).toBe(0);
      expect(s.store.rows.size).toBe(0);
      expect(s.checkAudits()).toEqual([]);
      expect(s.cases).toHaveLength(0);
      expect(s.deskChecks()).toEqual([0, 1].map(() => ({ provider: 'qoreid', ninCheck: 'name_mismatch',
        providerCalled: false, healthIdRecord: true })));
      // The right details are matched from the same record, still without QoreID.
      await expect(s.resolve('desk-once-key-000304')).resolves.toMatchObject({ caseId });
      expect(s.qoreId.state.charged).toBe(0);
    });

    it('treats a revoked NIN or an inactive patient as no holder: QoreID checks it, as before', async () => {
      // identity.patient_identifiers finds no holder for either (desk-nin-holder.integration.sql 1b, 1c).
      const s = system();
      await expect(s.resolve('desk-once-key-000305', deskContext(), { ...input, dateOfBirth: '1988-07-15' }))
        .rejects.toMatchObject({ status: 422, code: 'NIN_VERIFICATION_FAILED' });
      expect(s.qoreId.state.charged).toBe(1);
      expect(s.deskChecks()).toEqual([{ provider: 'qoreid', ninCheck: 'name_mismatch' }]);
    });
  });

  it('makes no QoreID call from a desk of the sealed demo or QA tenant, and never reaches 0137\'s stored answers', async () => {
    // 0098 G6, 0123 G6q and D9: such a desk causes no QoreID call. A real sign-up of the NIN has paid once.
    const s = system();
    await s.ninOnly.verifyNin(NIN, { correlationId: 'signup-check', path: 'enrollment' });
    s.sealed.on = true;
    // The record's own details (a free comparison against a real person's stored record) and a new NIN.
    for (const [key, body] of [['desk-once-key-000601', input], ['desk-once-key-000602', { ...input, lastName: 'Fixtura' }],
      ['desk-once-key-000603', { ...input, nin: '70000000007' }]] as const) {
      await expect(s.resolve(key, deskContext(), body)).rejects.toMatchObject({ status: 503,
        code: 'NIN_PROVIDER_UNAVAILABLE', message: 'NIN verification is not configured' });
    }
    expect(s.qoreId.state.charged).toBe(1);
    expect(s.checkAudits()).toEqual([['enrollment', 'qoreid', 'record', 'signup-check']]);
    expect(s.cases).toHaveLength(0);
    expect(s.breaker.state()).toBe('closed');
    expect(s.deskChecks()).toEqual([0, 1, 2].map(() => expect.objectContaining({ code: 'NIN_PROVIDER_UNAVAILABLE',
      providerCalled: false, sealedTenant: true })));
    // Any other desk checks as before.
    s.sealed.on = false;
    await expect(s.resolve('desk-once-key-000604', deskContext(2))).resolves.toMatchObject({ caseId });
    expect(s.qoreId.state.charged).toBe(1);
  });

  it('answers every "does not match" for one NIN by one account, holding nothing (Q109: no limit of any kind)', async () => {
    const s = system();
    const answers: unknown[] = [];
    for (let day = 1; day <= 40; day += 1) {
      const dateOfBirth = `1950-${String(Math.ceil(day / 28)).padStart(2, '0')}-${String(((day - 1) % 28) + 1).padStart(2, '0')}`;
      answers.push(await s.resolve(`desk-once-key-${String(400 + day).padStart(6, '0')}`, deskContext(),
        { ...input, dateOfBirth }).catch((error: { code?: string }) => error.code));
    }
    expect(answers).toEqual(answers.map(() => 'NIN_VERIFICATION_FAILED'));
    expect(s.qoreId.state.charged).toBe(1);
    // The same account with the right details is answered at once.
    await expect(s.resolve('desk-once-key-000499', deskContext())).resolves.toMatchObject({ caseId });
  });
});
