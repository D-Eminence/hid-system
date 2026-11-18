jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { DataAccessContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { fakeNinCheckStore } from '../testing/nin-check-store.fake';
import { NIN_CHECK_HOLD_SECONDS, NinCheckOnce } from './nin-check-once';
import { NinIdentifierProtector } from './nin-identifier-protector';
import { NinProviderBreaker } from './nin-provider-breaker';
import { NinRegistrationService } from './nin-registration.service';
import { QoreIdPublicPatientIdentityProvider } from './patient-enrollment.provider';
import { QoreIdNinVerificationProvider } from './qoreid-nin-verification.provider';
import { QoreIdVerificationAdapter } from './qoreid-verification.adapter';

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

function deskContext(index = 1): DataAccessContext {
  const suffix = String(index).padStart(12, '0');
  return {
    actor: { kind: 'staff', subject: `synthetic:desk-${index}`, accountId: `f1e2d3c4-b5a6-4978-8877-${suffix}`,
      permissions: ['identity.registration.write'], facility: { organizationId: 'org' } },
    facilityId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', membershipId: `d4e5f6a7-b8c9-4d0e-8f1a-${suffix}`,
    correlationId: `desk-once-${index}`, purposeOfUse: 'healthcare-operations',
  } as unknown as DataAccessContext;
}

type QoreIdMode = 'verified' | 'no_record' | 'late' | 'reset' | 'forbidden';

/** A QoreID that bills every NIN request it receives, answered or not. */
function fakeQoreId(leaseHeld: () => boolean) {
  const state = { charged: 0, outsideGuard: 0, modes: [] as QoreIdMode[], fallback: 'verified' as QoreIdMode,
    delayMs: 0 };
  let transaction = 8000;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch = jest.fn(async (url: string) => {
    if (url.endsWith('/token')) return json({ accessToken: 'fixture-access-token', expiresIn: 7200, tokenType: 'Bearer' });
    if (!url.includes('/v1/ng/identities/nin/')) throw new Error('unexpected QoreID path');
    // Every NIN request must be sent while 0137's guard holds the NIN's lease.
    if (!leaseHeld()) state.outsideGuard += 1;
    const mode = state.modes.shift() ?? state.fallback;
    state.charged += 1;
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (mode === 'late') await new Promise((resolve) => setTimeout(resolve, 500));
    if (mode === 'reset') {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    }
    if (mode === 'forbidden') return json({ message: 'insufficient balance' }, 403);
    transaction += 1;
    if (mode === 'no_record') {
      return json({ id: transaction, status: { state: 'complete', status: 'not_verified' },
        summary: { nin_check: 'not_verified' } });
    }
    return json({ id: transaction, status: { state: 'complete', status: 'verified' },
      summary: { nin_check: 'verified' }, nin: RECORD });
  });
  return { state, fetch };
}

function system() {
  const protector = new NinIdentifierProtector();
  const lookup = protector.lookup(NIN);
  const store = fakeNinCheckStore();
  const qoreId = fakeQoreId(() => store.rows.get(lookup)?.state === 'checking');
  const audits: unknown[][] = [];
  const checkDatabase = {
    withSystemTransaction: jest.fn(async (_correlation: string, work: (client: PoolClient) => Promise<unknown>) =>
      work({ query: jest.fn(async (sql: string, values: readonly unknown[] = []) =>
        store.query(sql, values) ?? { rows: [], rowCount: 0 }) } as unknown as PoolClient)),
    query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('insert into audit.events')) audits.push([...values]);
      return { rows: [], rowCount: 1 };
    }),
  } as unknown as DatabaseService;
  const ninCheck = new NinCheckOnce(checkDatabase, protector, new AuditService(checkDatabase));
  created.push(ninCheck);
  const adapter = new QoreIdVerificationAdapter({ baseUrl: 'https://qoreid.fixture.invalid', clientId: 'fixture-client',
    clientSecret: 'fixture-secret', timeoutMs: 100, ninOnlyEnrollmentEnabled: true },
  qoreId.fetch as unknown as typeof globalThis.fetch);
  const integrations = { assertAvailable: jest.fn().mockResolvedValue(undefined) } as unknown as IntegrationRuntimeService;
  const ninOnly = new QoreIdPublicPatientIdentityProvider(adapter, integrations, ninCheck);
  const provider = new QoreIdNinVerificationProvider(ninOnly);
  const cases: unknown[][] = [];
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
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
  const deskDatabase = { withTransaction: jest.fn(async (_c: unknown, work: (client: unknown) => unknown) => work({ query })) };
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
  return { qoreId, store, ninCheck, ninOnly, resolve, breaker, cases, checkAudits, deskChecks, deskAudit, lookup };
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
      QOREID_NIN_ANSWER_CEILING_MS: '1000',
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
      await expect(s.resolve(key)).rejects.toMatchObject({ status: 422, code: 'NIN_VERIFICATION_FAILED',
        message: 'The NIN could not be verified' });
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
    expect(s.deskChecks()).toEqual([{ provider: 'qoreid', ninCheck: 'name_mismatch' },
      { provider: 'qoreid', ninCheck: 'name_mismatch' }, { provider: 'qoreid', ninCheck: 'match' }]);
  });

  it('reuses the answer of a sign-up or profile check of the same NIN, and the other paths reuse the desk\'s', async () => {
    const s = system();
    await s.ninOnly.verifyNin(NIN, { correlationId: 'signup-check', path: 'enrollment' });
    await expect(s.resolve('desk-once-key-000009')).resolves.toMatchObject({ caseId });
    await s.ninOnly.verifyNin(NIN, { correlationId: 'profile-check', path: 'profile' });
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
      { provider: 'qoreid', ninCheck: 'match' }]);
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
      answer_ciphertext: null, key_version: null, until: Date.now() + 60_000 });
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
});
