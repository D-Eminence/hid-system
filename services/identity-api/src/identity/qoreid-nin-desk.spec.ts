import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as environment from '../config/environment';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { ResolveNinDto } from './dto/resolve-nin.dto';
import { NinRegistrationController } from './nin-registration.controller';
import { NinRegistrationService } from './nin-registration.service';
import {
  DeferredNinVerificationProvider,
  DeterministicTestNinVerificationProvider,
  isNinCheckNotStarted,
  isNinNotConfigured,
  NIN_NOT_CONFIGURED_DETAIL,
  UnavailableNinVerificationProvider,
} from './nin-verification.provider';
import { NIN_BREAKER_RETRY_AFTER_MS, NIN_PROVIDER_UNAVAILABLE_EVENT, NinProviderBreaker } from './nin-provider-breaker';
import type { NinVerificationProvider, NinVerificationRequest } from './nin.types';
import type { PublicPatientIdentityProvider, VerifiedPublicPatientIdentity } from './patient-enrollment.provider';
import {
  DESK_NIN_CHECK_ANSWER_SECONDS,
  DESK_NIN_CHECK_CLAIM_SECONDS,
  QoreIdNinVerificationProvider,
  selectNinVerificationProvider,
} from './qoreid-nin-verification.provider';

/**
 * Q108 (owner: "Q108 A"): the registration desk's NIN check through QoreID.
 * The QoreID gate and adapter are mocked: no call reaches QoreID. Fictional
 * people and identifiers only.
 */
const FORBIDDEN_WORD = /unverified/i;
const NIN = '12345678901';
const caseId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const context = {
  actor: { kind: 'staff', subject: 'synthetic:desk', accountId: 'f0e1d2c3-b4a5-4968-8776-655443322110',
    permissions: ['identity.registration.write'], facility: { organizationId: 'org' } },
  facilityId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', membershipId: 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f',
  correlationId: 'correlation-q108', purposeOfUse: 'healthcare-operations',
} as unknown as DataAccessContext;
const input = { nin: NIN, firstName: 'Ada', lastName: 'Fictional', dateOfBirth: '1991-04-05',
  purpose: 'healthcare-operations' as const };
const claimed = { firstName: 'Ada', lastName: 'Fictional', dateOfBirth: '1991-04-05' };

function record(overrides: Partial<VerifiedPublicPatientIdentity> = {}): VerifiedPublicPatientIdentity {
  return { nin: NIN, firstName: 'ADA', lastName: 'FICTIONAL', dateOfBirth: '1991-04-05', gender: 'female',
    providerReference: '700123', ...overrides };
}

function gate(overrides: Partial<Record<keyof PublicPatientIdentityProvider, jest.Mock>> = {}) {
  return {
    assertAvailable: jest.fn(async () => undefined),
    isAvailable: jest.fn(async () => true),
    verifyNin: jest.fn(async () => record()),
    ...overrides,
  };
}

interface WindowRow { request_count: number; window_started_at: Date; blocked_until: Date | null }

/**
 * A stand-in for `auth.otp_rate_limits` that answers the statements the
 * request limits, the claim and the stored answers use, as Postgres would.
 * Transactions run one at a time, as the bucket locks make them in Postgres.
 */
function rateLimitTable() {
  const rows = new Map<string, WindowRow>();
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const at = (scope: unknown, bucket: unknown) => `${String(scope)}:${String(bucket)}`;
  const recent = (row: WindowRow | undefined, seconds: unknown) => row !== undefined
    && row.request_count > 0 && row.window_started_at.getTime() > Date.now() - Number(seconds) * 1000;
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    statements.push({ sql: flat, values });
    if (/pg_advisory_xact_lock/.test(flat)) return { rows: [] };
    if (/as blocked from auth\.otp_rate_limits/.test(flat)) {
      const row = rows.get(at(values[0], values[1]));
      return { rows: row ? [{ blocked: Boolean(row.blocked_until && row.blocked_until.getTime() > Date.now()) }] : [] };
    }
    if (/for update$/.test(flat)) {
      const row = rows.get(at(values[0], values[1]));
      return { rows: row ? [{ ...row }] : [] };
    }
    if (/bucket_hmac = any\(\$1::text\[\]\)/.test(flat)) {
      return { rows: (values[0] as string[]).filter((bucket) => recent(rows.get(at('account', bucket)), values[1]))
        .map((bucket) => ({ bucket_hmac: bucket })) };
    }
    if (/as held from auth\.otp_rate_limits/.test(flat)) {
      const row = rows.get(at('account', values[0]));
      return { rows: row ? [{ held: recent(row, values[1]) }] : [] };
    }
    if (/greatest\(request_count - 1, 0\)/.test(flat)) {
      const row = rows.get(at(values[0], values[1]));
      if (row && row.request_count > 0 && (!row.blocked_until || row.blocked_until.getTime() <= Date.now())) {
        row.request_count -= 1;
      }
      return { rows: [] };
    }
    if (/set request_count = 0,/.test(flat)) {
      const row = rows.get(at('account', values[0]));
      if (row) row.request_count = 0;
      return { rows: [] };
    }
    if (/^insert into auth\.otp_rate_limits .* values \('account', \$1,/.test(flat)) {
      rows.set(at('account', values[0]), { request_count: 1, window_started_at: new Date(Date.now()), blocked_until: null });
      return { rows: [] };
    }
    if (/^insert into auth\.otp_rate_limits/.test(flat)) {
      const [scope, bucket, expired, count, blocked, seconds] = values as [string, string, boolean, number, boolean, number];
      const current = rows.get(at(scope, bucket));
      rows.set(at(scope, bucket), {
        request_count: current ? count : 1,
        window_started_at: !current || expired ? new Date(Date.now()) : current.window_started_at,
        blocked_until: current && blocked ? new Date(Date.now() + seconds * 1000) : null,
      });
      return { rows: [] };
    }
    throw new Error(`unexpected statement: ${flat}`);
  });
  let queue: Promise<unknown> = Promise.resolve();
  const database = {
    withSystemTransaction: jest.fn((_c: string, work: (client: unknown) => Promise<unknown>) => {
      const run = queue.then(() => work({ query }));
      queue = run.catch(() => undefined);
      return run;
    }),
  };
  /** The request count a bucket holds now (0 for none). */
  const counts = () => [...rows.values()].map((row) => row.request_count);
  return { database, rows, statements, counts };
}

function qoreIdProvider(qoreId = gate(), database: unknown = rateLimitTable().database) {
  return new QoreIdNinVerificationProvider(qoreId as never, database as never);
}

// A fictional local key for the keyed request-limit buckets (never a deployed value).
beforeEach(() => {
  jest.spyOn(environment, 'getEnvironment').mockReturnValue({ NIN_PROVIDER_MODE: 'unavailable',
    OTP_HMAC_KEY_B64: Buffer.alloc(32, 7).toString('base64') } as never);
});
afterEach(() => jest.restoreAllMocks());

const request: NinVerificationRequest = { nin: NIN, claimedDemographics: claimed, correlationId: 'correlation-q108' };

describe('Q108 choosing the desk NIN check', () => {
  const providers = {
    deterministicTest: new DeterministicTestNinVerificationProvider(),
    unavailable: new UnavailableNinVerificationProvider(),
    deferred: new DeferredNinVerificationProvider(),
    qoreId: qoreIdProvider(),
  };

  it.each([
    ['deferred', true, 'deferred'],
    ['deferred', false, 'deferred'],
    ['test', true, 'deterministic-test'],
    ['test', false, 'deterministic-test'],
    ['unavailable', false, 'unavailable'],
    ['unavailable', true, 'qoreid'],
  ] as const)('NIN_PROVIDER_MODE=%s with QOREID_ENABLED=%s uses %s', (mode, qoreIdEnabled, expected) => {
    expect(selectNinVerificationProvider({ NIN_PROVIDER_MODE: mode, QOREID_ENABLED: qoreIdEnabled }, providers).name)
      .toBe(expected);
  });
});

describe('Q108 QoreID NIN check for the desk', () => {
  it('is switched on exactly when the QoreID gate is open (asked every time)', async () => {
    const qoreId = gate({ isAvailable: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) });
    const provider = qoreIdProvider(qoreId);
    await expect(provider.isEnabled()).resolves.toBe(true);
    await expect(provider.isEnabled()).resolves.toBe(false);
    expect(qoreId.isAvailable).toHaveBeenCalledTimes(2);
  });

  it('sends only the NIN and answers a match with QoreID\'s reference', async () => {
    const qoreId = gate();
    const answer = await qoreIdProvider(qoreId).verify(request);
    expect(qoreId.verifyNin).toHaveBeenCalledWith(NIN);
    expect(answer).toEqual({
      verified: true, outcome: 'match', provider: 'qoreid', reference: '700123',
      verifiedAt: expect.any(String),
      demographics: { firstName: 'Ada', lastName: 'Fictional', dateOfBirth: '1991-04-05', gender: 'female' },
    });
  });

  it('matches names whatever the letter case and spacing', async () => {
    const qoreId = gate({ verifyNin: jest.fn(async () => record({ firstName: ' ada ', lastName: 'fictional' })) });
    const answer = await qoreIdProvider(qoreId).verify({ ...request,
      claimedDemographics: { ...claimed, firstName: 'Ada' } });
    expect(answer).toMatchObject({ verified: true, outcome: 'match' });
  });

  it('keeps the sex the desk gave, and leaves out an unknown one from the record', async () => {
    const given = await qoreIdProvider().verify({ ...request, claimedDemographics: { ...claimed, gender: 'male' } });
    expect(given.demographics.gender).toBe('male');
    const unknown = await qoreIdProvider(gate({ verifyNin: jest.fn(async () => record({ gender: 'unknown' })) }))
      .verify(request);
    expect(unknown.demographics).not.toHaveProperty('gender');
  });

  it.each([
    ['a different first name', { firstName: 'BOLA' }],
    ['a different last name', { lastName: 'OTHER' }],
    ['the names the other way round', { firstName: 'FICTIONAL', lastName: 'ADA' }],
    ['a different date of birth', { dateOfBirth: '1991-04-06' }],
  ])('answers a name mismatch for %s', async (_label, overrides) => {
    const answer = await qoreIdProvider(gate({ verifyNin: jest.fn(async () => record(overrides)) })).verify(request);
    expect(answer).toMatchObject({ verified: false, outcome: 'name_mismatch', provider: 'qoreid', reference: '700123',
      demographics: claimed });
  });

  it('answers no match when QoreID does not confirm the NIN', async () => {
    const qoreId = gate({ verifyNin: jest.fn(async () => {
      throw new DomainProblem(422, 'NIN_NOT_VERIFIED', 'The NIN could not be verified');
    }) });
    const answer = await qoreIdProvider(qoreId).verify(request);
    expect(answer).toMatchObject({ verified: false, outcome: 'no_match', provider: 'qoreid', demographics: claimed });
    expect(answer.reference).not.toContain(NIN);
  });

  it.each(['QOREID_DISABLED', 'QOREID_NIN_ONLY_DISABLED', 'INTEGRATION_PAUSED', 'QOREID_CONFIGURATION_INVALID'])(
    'answers "not configured" when the gate refuses with %s', async (code) => {
      const qoreId = gate({ verifyNin: jest.fn(async () => { throw new DomainProblem(503, code, 'off'); }) });
      const refusal = qoreIdProvider(qoreId).verify(request);
      await expect(refusal).rejects.toMatchObject({ status: 503, code: 'NIN_PROVIDER_UNAVAILABLE',
        message: NIN_NOT_CONFIGURED_DETAIL });
      await refusal.catch((error) => expect(isNinNotConfigured(error)).toBe(true));
    });

  it('answers "cannot be started" when the gate\'s control cannot be read just before sending', async () => {
    const qoreId = gate({ verifyNin: jest.fn(async () => {
      throw new DomainProblem(503, 'INTEGRATION_UNAVAILABLE', 'Delivery provider is temporarily unavailable');
    }) });
    const refusal = qoreIdProvider(qoreId).verify(request);
    await expect(refusal).rejects.toMatchObject({ status: 503, code: 'NIN_PROVIDER_UNAVAILABLE',
      message: 'NIN checks cannot be started right now. Please try again in a minute.' });
    await refusal.catch((error) => expect(isNinCheckNotStarted(error)).toBe(true));
  });

  it.each([
    ['QOREID_PROVIDER_UNAVAILABLE', 503],
    ['QOREID_TIMEOUT', 504],
    ['QOREID_NETWORK_UNAVAILABLE', 503],
    ['QOREID_AUTHENTICATION_FAILED', 503],
    ['QOREID_PROVIDER_RESPONSE_INVALID', 502],
    ['QOREID_RATE_LIMITED', 429],
  ])('passes QoreID\'s %s on as a provider error', async (code, status) => {
    const qoreId = gate({ verifyNin: jest.fn(async () => { throw new DomainProblem(status, code, 'External verification is unavailable'); }) });
    const refusal = qoreIdProvider(qoreId).verify(request);
    await expect(refusal).rejects.toMatchObject({ status, code });
    await refusal.catch((error) => expect(isNinNotConfigured(error)).toBe(false));
  });

  it.each([
    ['another NIN', { nin: '10987654321' }],
    ['no reference', { providerReference: '' }],
    ['a reference holding the NIN', { providerReference: `ref-${NIN}` }],
    ['an empty name', { firstName: ' ' }],
    ['an impossible date of birth', { dateOfBirth: '1991-02-30' }],
    ['a future date of birth', { dateOfBirth: '2999-01-01' }],
    ['an unknown sex value', { gender: 'x' as never }],
  ])('refuses a record with %s as a bad answer', async (_label, overrides) => {
    const qoreId = gate({ verifyNin: jest.fn(async () => record(overrides)) });
    await expect(qoreIdProvider(qoreId).verify(request)).rejects.toMatchObject({
      status: 502, code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
  });

  describe('no request limits (Q109)', () => {
    const reservation = { correlationId: 'correlation-q108', accountId: context.actor.accountId,
      facilityId: context.facilityId, idempotencyKey: 'resolve-key-q109-limits', requestSha256: 'b'.repeat(64) };
    /** A different desk request (its own Idempotency-Key) by `accountId` at the facility. */
    const check = (index: number, accountId = context.actor.accountId) =>
      ({ ...reservation, accountId, idempotencyKey: `resolve-key-q109-check-${index}` });
    const account = (index: number) => `f0e1d2c3-b4a5-4968-8776-${String(index).padStart(12, '0')}`;

    it('claims the request in one keyed bucket and counts nothing per account or facility', async () => {
      const { database, statements } = rateLimitTable();
      await expect(qoreIdProvider(gate(), database).reserve(reservation)).resolves.toEqual({});
      expect(database.withSystemTransaction).toHaveBeenCalledWith('correlation-q108', expect.any(Function));
      const writes = statements.filter(({ sql }) => /insert into auth\.otp_rate_limits/.test(sql));
      expect(writes).toHaveLength(1);
      // The bucket is keyed: no identifier, key or digest is stored.
      for (const value of [context.actor.accountId, context.facilityId, reservation.idempotencyKey, 'b'.repeat(64)]) {
        expect(JSON.stringify(statements)).not.toContain(value);
      }
    });

    it('lets one staff account check as many NINs as the desk needs, in an hour and in a day', async () => {
      const provider = qoreIdProvider(gate(), rateLimitTable().database);
      // More than the 20 an hour and 100 a day the review build allowed.
      for (let index = 0; index < 150; index += 1) await expect(provider.reserve(check(index))).resolves.toEqual({});
    });

    it('lets one facility check as many NINs as its desks need in a day', async () => {
      const provider = qoreIdProvider(gate(), rateLimitTable().database);
      // More than the 300 a day the review build allowed, across 40 accounts.
      for (let index = 0; index < 400; index += 1) {
        await expect(provider.reserve(check(index, account(index % 40)))).resolves.toEqual({});
      }
    });

    it('answers "cannot be started" when the claim cannot be read, with no SQL detail', async () => {
      const database = { withSystemTransaction: jest.fn(async () => {
        throw Object.assign(new Error('relation "auth.otp_rate_limits" does not exist'), { code: '42P01' });
      }) };
      const refusal = qoreIdProvider(gate(), database).reserve(reservation);
      await expect(refusal).rejects.toMatchObject({ status: 503, code: 'NIN_PROVIDER_UNAVAILABLE',
        message: 'NIN checks cannot be started right now. Please try again in a minute.' });
      await refusal.catch((error) => expect(isNinCheckNotStarted(error)).toBe(true));
    });
  });

  describe('one check per desk request', () => {
    const reservation = { correlationId: 'correlation-q108', accountId: context.actor.accountId,
      facilityId: context.facilityId, idempotencyKey: 'resolve-key-q108-once', requestSha256: 'c'.repeat(64) };

    it('refuses a resend while the first check is still waiting for its answer, counting nothing', async () => {
      const table = rateLimitTable();
      const provider = qoreIdProvider(gate(), table.database);
      await expect(provider.reserve(reservation)).resolves.toEqual({});
      const counted = table.counts();
      await expect(provider.reserve(reservation)).rejects.toMatchObject({ status: 409, code: 'NIN_CHECK_IN_PROGRESS',
        message: 'This NIN check is already in progress. Please wait for its answer.' });
      expect(table.counts()).toEqual(counted);
    });

    it('lets only one of two requests sent at the same moment through', async () => {
      const provider = qoreIdProvider(gate(), rateLimitTable().database);
      const results = await Promise.allSettled([provider.reserve(reservation), provider.reserve(reservation)]);
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: expect.objectContaining({ code: 'NIN_CHECK_IN_PROGRESS' }) });
    });

    it.each(['no_match', 'name_mismatch'] as const)('gives a resend the stored %s answer, counting nothing', async (outcome) => {
      const table = rateLimitTable();
      const provider = qoreIdProvider(gate(), table.database);
      await provider.reserve(reservation);
      await provider.settle(reservation, outcome);
      const counted = table.counts();
      await expect(provider.reserve(reservation)).resolves.toEqual({ stored: outcome });
      expect(table.counts()).toEqual(counted);
    });

    it('lets the desk try again when nothing usable came back', async () => {
      const provider = qoreIdProvider(gate(), rateLimitTable().database);
      await provider.reserve(reservation);
      await provider.settle(reservation, 'not_answered');
      await expect(provider.reserve(reservation)).resolves.toEqual({});
    });

    it('treats the same key with a different body as a different request', async () => {
      const provider = qoreIdProvider(gate(), rateLimitTable().database);
      await provider.reserve(reservation);
      await provider.settle(reservation, 'no_match');
      await expect(provider.reserve({ ...reservation, requestSha256: 'd'.repeat(64) })).resolves.toEqual({});
    });

    it('lets a claim go after two minutes, and a stored answer after a day', async () => {
      const provider = qoreIdProvider(gate(), rateLimitTable().database);
      const start = Date.parse('2026-11-18T09:00:00Z');
      const now = jest.spyOn(Date, 'now').mockReturnValue(start);
      await provider.reserve(reservation);
      now.mockReturnValue(start + DESK_NIN_CHECK_CLAIM_SECONDS * 1000 + 1000);
      await expect(provider.reserve(reservation)).resolves.toEqual({});
      await provider.settle(reservation, 'no_match');
      now.mockReturnValue(start + (DESK_NIN_CHECK_CLAIM_SECONDS + DESK_NIN_CHECK_ANSWER_SECONDS) * 1000 + 2000);
      await expect(provider.reserve(reservation)).resolves.toEqual({});
    });

    it('never throws while recording how a check ended', async () => {
      const database = { withSystemTransaction: jest.fn(async () => { throw new Error('connection reset'); }) };
      await expect(qoreIdProvider(gate(), database).settle(reservation, 'no_match')).resolves.toBeUndefined();
    });
  });
});

describe('Q108 desk NIN resolve through QoreID', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  function desk(provider: NinVerificationProvider, breaker = new NinProviderBreaker()) {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const query = jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql: sql.replace(/\s+/g, ' '), values });
      if (/insert into identity\.registration_cases \(/.test(sql)) return { rows: [{ id: caseId }] };
      if (/where registration\.id = \$1/.test(sql)) {
        return { rows: [{ id: caseId, status: 'pending_new_identity_approval', row_version: '1',
          resolved_patient_id: null, resolved_hid_code: null, candidate_count: '0', contact_recorded: false,
          nin_verified: true }] };
      }
      return { rows: [] };
    });
    const database = {
      withTransaction: jest.fn(async (_c: unknown, work: (c: unknown) => unknown) => work({ query })),
      withSystemTransaction: jest.fn(async (_c: unknown, work: (c: unknown) => unknown) => work({ query })),
    };
    const audit = { recordWithClient: jest.fn(async () => undefined), record: jest.fn(async () => undefined) };
    const protector = {
      lookup: jest.fn(() => 'a'.repeat(64)),
      protect: jest.fn(() => ({ lookupHmac: 'a'.repeat(64), ciphertext: Buffer.from('sealed'), last4: '8901',
        keyVersion: 'local-v1' })),
    };
    const service = new NinRegistrationService(database as never, audit as never, protector as never, {} as never,
      provider, breaker);
    return { service, audit, statements, breaker };
  }

  /** Every audit row written, with no NIN, record name or date of birth in any of them. */
  function auditRows(audit: { record: jest.Mock; recordWithClient: jest.Mock }) {
    const rows = [...audit.record.mock.calls.map(([row]) => row),
      ...audit.recordWithClient.mock.calls.map(([, row]) => row)];
    expect(JSON.stringify(rows)).not.toContain(NIN);
    expect(JSON.stringify(rows)).not.toMatch(FORBIDDEN_WORD);
    return rows;
  }

  it('records the case with QoreID\'s evidence when the NIN matches', async () => {
    const qoreId = gate();
    const { service, audit, statements, breaker } = desk(qoreIdProvider(qoreId));
    const answer = await service.resolve(input, 'resolve-key-q108-000001', context);
    expect(answer).toMatchObject({ caseId, status: 'pending_new_identity_approval', ninStatus: 'verified' });
    expect(JSON.stringify(answer)).not.toMatch(FORBIDDEN_WORD);
    const insert = statements.find(({ sql }) => sql.includes('insert into identity.registration_cases ('));
    // verification_provider, verification_reference and verified_at.
    expect(insert?.values.slice(14, 17)).toEqual(['qoreid', '700123', expect.any(String)]);
    expect(insert?.values.slice(5, 10)).toEqual(['Ada', 'Fictional', 'Ada Fictional', '1991-04-05', 'female']);
    expect(breaker.state()).toBe('closed');
    const [checked, resolved] = auditRows(audit);
    expect(checked).toMatchObject({ action: 'identity.nin.verify', outcome: 'success',
      details: { provider: 'qoreid', ninCheck: 'match' } });
    expect(resolved).toMatchObject({ action: 'identity.nin.resolve', outcome: 'success', resourceId: expect.any(String),
      details: expect.objectContaining({ provider: 'qoreid', ninCheck: 'match' }) });
    expect(qoreId.isAvailable).toHaveBeenCalledTimes(1);
  });

  it('charges the check to the desk account and facility before sending the NIN', async () => {
    const provider = qoreIdProvider();
    const order: string[] = [];
    jest.spyOn(provider, 'reserve').mockImplementation(async (reservation) => {
      order.push('reserve');
      expect(reservation).toEqual({ correlationId: 'correlation-q108', accountId: context.actor.accountId,
        facilityId: context.facilityId, idempotencyKey: 'resolve-key-q108-000002',
        requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      return {};
    });
    const verify = jest.spyOn(provider, 'verify');
    verify.mockImplementation(async (checked) => { order.push('verify'); return { verified: true, outcome: 'match',
      provider: 'qoreid', reference: '700123', verifiedAt: new Date().toISOString(), demographics: checked.claimedDemographics }; });
    await desk(provider).service.resolve(input, 'resolve-key-q108-000002', context);
    expect(order).toEqual(['reserve', 'verify']);
  });

  it.each([
    ['no match', 'NIN_NOT_VERIFIED', 'no_match', 'The NIN could not be verified'],
  ])('answers %s as "could not be verified" and audits it', async (_label, code, ninCheck, message) => {
    const qoreId = gate({ verifyNin: jest.fn(async () => { throw new DomainProblem(422, code, 'x'); }) });
    const { service, audit, breaker } = desk(qoreIdProvider(qoreId));
    await expect(service.resolve(input, 'resolve-key-q108-000003', context)).rejects.toMatchObject({
      status: 422, code: 'NIN_VERIFICATION_FAILED', message });
    expect(breaker.state()).toBe('closed');
    expect(auditRows(audit)).toEqual([expect.objectContaining({ action: 'identity.nin.verify', outcome: 'denied',
      details: { provider: 'qoreid', ninCheck } })]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('tells the desk the name or date of birth does not match, and audits a name mismatch', async () => {
    const qoreId = gate({ verifyNin: jest.fn(async () => record({ lastName: 'OTHER' })) });
    const { service, audit, breaker } = desk(qoreIdProvider(qoreId));
    const refusal = service.resolve(input, 'resolve-key-q108-000004', context);
    await expect(refusal).rejects.toMatchObject({ status: 422, code: 'NIN_VERIFICATION_FAILED',
      message: 'The name or date of birth does not match the NIN record. Check the spelling and the date of birth.' });
    expect(breaker.state()).toBe('closed');
    expect(auditRows(audit)).toEqual([expect.objectContaining({ action: 'identity.nin.verify', outcome: 'denied',
      details: { provider: 'qoreid', ninCheck: 'name_mismatch' } })]);
    // The record's other name never reaches the desk or the audit row.
    await refusal.catch((error: Error) => expect(error.message).not.toContain('OTHER'));
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('OTHER');
  });

  it('keeps today\'s "not configured" answer while QoreID\'s switch is off, sending nothing', async () => {
    const qoreId = gate({ isAvailable: jest.fn(async () => false) });
    const provider = qoreIdProvider(qoreId);
    const reserve = jest.spyOn(provider, 'reserve');
    const { service, audit, breaker } = desk(provider);
    for (const key of ['resolve-key-q108-000005', 'resolve-key-q108-000006', 'resolve-key-q108-000007',
      'resolve-key-q108-000008']) {
      await expect(service.resolve(input, key, context)).rejects.toMatchObject({
        status: 503, code: 'NIN_PROVIDER_UNAVAILABLE', message: NIN_NOT_CONFIGURED_DETAIL });
    }
    expect(qoreId.verifyNin).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(breaker.state()).toBe('closed');
    expect(warn).not.toHaveBeenCalled();
    expect(auditRows(audit)).toHaveLength(4);
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'identity.nin.verify',
      outcome: 'failure', details: { provider: 'qoreid', errorType: 'DomainProblem', code: 'NIN_PROVIDER_UNAVAILABLE',
        providerCalled: false } }));
  });

  it('asks the desk to try again when the switch cannot be read, without touching the breaker', async () => {
    const qoreId = gate({ isAvailable: jest.fn(async () => {
      throw new DomainProblem(503, 'INTEGRATION_UNAVAILABLE', 'Delivery provider is temporarily unavailable');
    }) });
    const { service, audit, breaker } = desk(qoreIdProvider(qoreId));
    await expect(service.resolve(input, 'resolve-key-q108-000009', context)).rejects.toMatchObject({
      status: 503, code: 'NIN_PROVIDER_UNAVAILABLE',
      message: 'NIN checks cannot be started right now. Please try again in a minute.' });
    expect(qoreId.verifyNin).not.toHaveBeenCalled();
    expect(breaker.state()).toBe('closed');
    expect(auditRows(audit)).toEqual([expect.objectContaining({ action: 'identity.nin.verify', outcome: 'failure',
      details: expect.objectContaining({ provider: 'qoreid', code: 'INTEGRATION_UNAVAILABLE', providerCalled: false }) })]);
  });

  it('sends every check one desk account makes, with no hourly, daily or facility limit (Q109)', async () => {
    const qoreId = gate();
    const { service, audit } = desk(qoreIdProvider(qoreId, rateLimitTable().database));
    for (let index = 0; index < 25; index += 1) {
      await expect(service.resolve(input, `resolve-key-q109-${String(index).padStart(6, '0')}`, context))
        .resolves.toMatchObject({ caseId });
    }
    expect(qoreId.verifyNin).toHaveBeenCalledTimes(25);
    expect(JSON.stringify(auditRows(audit))).not.toMatch(/LIMIT/);
  });

  it('trips the breaker when QoreID is down, logs no NIN, and stops sending checks', async () => {
    const qoreId = gate({ verifyNin: jest.fn(async () => {
      throw new DomainProblem(503, 'QOREID_PROVIDER_UNAVAILABLE', 'External verification is unavailable');
    }) });
    const { service, audit, breaker } = desk(qoreIdProvider(qoreId));
    await expect(service.resolve(input, 'resolve-key-q108-000011', context)).rejects.toMatchObject({ status: 503 });
    expect(breaker.state()).toBe('open');
    await expect(service.resolve(input, 'resolve-key-q108-000012', context)).rejects.toMatchObject({
      code: 'NIN_PROVIDER_UNAVAILABLE', message: 'The NIN service is not answering right now. Please try again in a minute.' });
    expect(qoreId.verifyNin).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: NIN_PROVIDER_UNAVAILABLE_EVENT,
      provider: 'qoreid', code: 'QOREID_PROVIDER_UNAVAILABLE', status: 503, correlationId: 'correlation-q108' }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(NIN);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Ada|Fictional|1991-04-05/);
    expect(auditRows(audit)).toEqual([
      expect.objectContaining({ action: 'identity.nin.verify', outcome: 'failure',
        details: { provider: 'qoreid', errorType: 'DomainProblem', code: 'QOREID_PROVIDER_UNAVAILABLE',
          providerCalled: true, ninCheck: 'provider_error' } }),
      expect.objectContaining({ action: 'identity.nin.verify', outcome: 'failure',
        details: expect.objectContaining({ provider: 'qoreid', providerCalled: false, breaker: 'open' }) }),
    ]);
  });

  it('trips the breaker after three timeouts or bad answers within five minutes', async () => {
    const failures = [
      new DomainProblem(504, 'QOREID_TIMEOUT', 'External verification timed out'),
      new DomainProblem(502, 'QOREID_PROVIDER_RESPONSE_INVALID', 'External verification returned an invalid response'),
      new DomainProblem(504, 'QOREID_TIMEOUT', 'External verification timed out'),
    ];
    const qoreId = gate({ verifyNin: jest.fn(async () => { throw failures.shift(); }) });
    const { service, breaker } = desk(qoreIdProvider(qoreId));
    for (const key of ['resolve-key-q108-000013', 'resolve-key-q108-000014']) {
      await expect(service.resolve(input, key, context)).rejects.toBeInstanceOf(DomainProblem);
      expect(breaker.state()).toBe('closed');
    }
    await expect(service.resolve(input, 'resolve-key-q108-000015', context)).rejects.toMatchObject({ code: 'QOREID_TIMEOUT' });
    expect(breaker.state()).toBe('open');
  });

  it('does not count QoreID\'s own rate limit (429) as an outage', async () => {
    const qoreId = gate({ verifyNin: jest.fn(async () => {
      throw new DomainProblem(429, 'QOREID_RATE_LIMITED', 'External verification is temporarily rate limited');
    }) });
    const { service, breaker } = desk(qoreIdProvider(qoreId));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(service.resolve(input, `resolve-key-q108-00002${attempt}`, context))
        .rejects.toMatchObject({ status: 429 });
    }
    expect(breaker.state()).toBe('closed');
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats QoreID switched off during the check as a setting, not an outage', async () => {
    const qoreId = gate({ verifyNin: jest.fn(async () => {
      throw new DomainProblem(503, 'INTEGRATION_PAUSED', 'External verification is temporarily unavailable');
    }) });
    const breaker = new NinProviderBreaker();
    const { service, audit } = desk(qoreIdProvider(qoreId), breaker);
    for (const key of ['resolve-key-q108-000031', 'resolve-key-q108-000032', 'resolve-key-q108-000033']) {
      await expect(service.resolve(input, key, context)).rejects.toMatchObject({
        status: 503, code: 'NIN_PROVIDER_UNAVAILABLE', message: NIN_NOT_CONFIGURED_DETAIL });
    }
    expect(breaker.state()).toBe('closed');
    expect(warn).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'identity.nin.verify',
      outcome: 'failure', details: expect.objectContaining({ provider: 'qoreid', providerCalled: false }) }));
  });

  it('frees the retry place when QoreID is switched off during the retried check', async () => {
    const qoreId = gate({ verifyNin: jest.fn(async () => {
      throw new DomainProblem(503, 'QOREID_DISABLED', 'off');
    }) });
    const breaker = new NinProviderBreaker();
    const start = Date.parse('2026-11-18T11:00:00Z');
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    breaker.recordFailure(new DomainProblem(503, 'QOREID_PROVIDER_UNAVAILABLE', 'down'));
    warn.mockClear();
    now.mockReturnValue(start + NIN_BREAKER_RETRY_AFTER_MS);
    const { service } = desk(qoreIdProvider(qoreId), breaker);
    await expect(service.resolve(input, 'resolve-key-q108-000034', context)).rejects.toMatchObject({
      message: NIN_NOT_CONFIGURED_DETAIL });
    expect(breaker.available()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('sends one check, not two, when the same request arrives twice at once', async () => {
    let answer: (identity: VerifiedPublicPatientIdentity) => void = () => undefined;
    const qoreId = gate({ verifyNin: jest.fn(() => new Promise<VerifiedPublicPatientIdentity>((resolve) => {
      answer = resolve;
    })) });
    const { service, audit } = desk(qoreIdProvider(qoreId));
    const first = service.resolve(input, 'resolve-key-q108-000040', context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(service.resolve(input, 'resolve-key-q108-000040', context)).rejects.toMatchObject({
      status: 409, code: 'NIN_CHECK_IN_PROGRESS' });
    answer(record());
    await expect(first).resolves.toMatchObject({ caseId, ninStatus: 'verified' });
    expect(qoreId.verifyNin).toHaveBeenCalledTimes(1);
    expect(auditRows(audit)).toContainEqual(expect.objectContaining({ action: 'identity.nin.verify', outcome: 'failure',
      details: expect.objectContaining({ code: 'NIN_CHECK_IN_PROGRESS', providerCalled: false }) }));
  });

  it.each([
    ['could not be verified', jest.fn(async () => {
      throw new DomainProblem(422, 'NIN_NOT_VERIFIED', 'The NIN could not be verified');
    }), 'no_match', 'The NIN could not be verified'],
    ['does not match', jest.fn(async () => record({ lastName: 'OTHER' })), 'name_mismatch',
      'The name or date of birth does not match the NIN record. Check the spelling and the date of birth.'],
  ])('gives a resend of a request answered "%s" the same answer without a new check', async (_label, verifyNin,
    ninCheck, message) => {
    verifyNin.mockClear();
    const qoreId = gate({ verifyNin });
    const { service, audit, breaker } = desk(qoreIdProvider(qoreId));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(service.resolve(input, 'resolve-key-q108-000041', context)).rejects.toMatchObject({
        status: 422, code: 'NIN_VERIFICATION_FAILED', message });
    }
    expect(verifyNin).toHaveBeenCalledTimes(1);
    expect(breaker.state()).toBe('closed');
    expect(auditRows(audit)).toEqual([
      expect.objectContaining({ action: 'identity.nin.verify', outcome: 'denied', details: { provider: 'qoreid', ninCheck } }),
      expect.objectContaining({ action: 'identity.nin.verify', outcome: 'denied',
        details: { provider: 'qoreid', ninCheck, providerCalled: false, replay: true } }),
    ]);
    // A corrected request (another body) is a new check.
    await expect(service.resolve({ ...input, lastName: 'Corrected' }, 'resolve-key-q108-000041', context))
      .rejects.toMatchObject({ status: 422 });
    expect(verifyNin).toHaveBeenCalledTimes(2);
  });

  it('lets the desk resend a request whose check failed', async () => {
    const qoreId = gate({ verifyNin: jest.fn()
      .mockRejectedValueOnce(new DomainProblem(504, 'QOREID_TIMEOUT', 'External verification timed out'))
      .mockResolvedValueOnce(record()) });
    const { service } = desk(qoreIdProvider(qoreId));
    await expect(service.resolve(input, 'resolve-key-q108-000042', context)).rejects.toMatchObject({ status: 504 });
    await expect(service.resolve(input, 'resolve-key-q108-000042', context)).resolves.toMatchObject({ caseId });
    expect(qoreId.verifyNin).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a date of birth in the future', { dateOfBirth: '2062-03-01' }],
    ['a date of birth before 1900', { dateOfBirth: '1899-12-31' }],
    ['a name with a tab', { firstName: 'Ada\tBola' }],
    ['a blank name', { lastName: '   ' }],
  ])('refuses %s before anything is sent, counted or charged', async (_label, overrides) => {
    const qoreId = gate();
    const provider = qoreIdProvider(qoreId);
    const reserve = jest.spyOn(provider, 'reserve');
    const { service, audit, breaker } = desk(provider);
    for (const key of ['resolve-key-q108-000043', 'resolve-key-q108-000044', 'resolve-key-q108-000045']) {
      await expect(service.resolve({ ...input, ...overrides }, key, context)).rejects.toMatchObject({
        status: 400, code: 'NIN_DETAILS_INVALID',
        message: 'Check the name and the date of birth. The date of birth cannot be in the future or before 1900.' });
    }
    expect(reserve).not.toHaveBeenCalled();
    expect(qoreId.verifyNin).not.toHaveBeenCalled();
    expect(breaker.state()).toBe('closed');
    expect(warn).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'identity.nin.verify',
      outcome: 'failure', details: expect.objectContaining({ code: 'NIN_DETAILS_INVALID', providerCalled: false }) }));
  });

  it('does not trip the breaker or record a call when the switch cannot be read again just before sending', async () => {
    const qoreId = gate({ verifyNin: jest.fn()
      .mockRejectedValueOnce(new DomainProblem(503, 'INTEGRATION_UNAVAILABLE', 'Delivery provider is temporarily unavailable'))
      .mockResolvedValueOnce(record()) });
    const { service, audit, breaker } = desk(qoreIdProvider(qoreId));
    await expect(service.resolve(input, 'resolve-key-q108-000046', context)).rejects.toMatchObject({
      status: 503, code: 'NIN_PROVIDER_UNAVAILABLE',
      message: 'NIN checks cannot be started right now. Please try again in a minute.' });
    // One 503 from QoreID itself would have tripped it at once.
    expect(breaker.state()).toBe('closed');
    expect(warn).not.toHaveBeenCalled();
    expect(auditRows(audit)).toEqual([expect.objectContaining({ action: 'identity.nin.verify', outcome: 'failure',
      details: expect.objectContaining({ provider: 'qoreid', providerCalled: false }) })]);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('provider_error');
    // Nothing was sent, so the same request may be sent again.
    await expect(service.resolve(input, 'resolve-key-q108-000046', context)).resolves.toMatchObject({ caseId });
  });
});

describe('Q108 registration-capabilities with QoreID', () => {
  afterEach(() => jest.restoreAllMocks());

  function capabilities(qoreId: ReturnType<typeof gate>, breaker = new NinProviderBreaker()) {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ NIN_PROVIDER_MODE: 'unavailable' } as never);
    return new NinRegistrationController({} as never, breaker, qoreIdProvider(qoreId)).capabilities();
  }

  it('reports NIN checks on and available while QoreID\'s switch is on', async () => {
    const answer = await capabilities(gate());
    expect(answer).toEqual({
      nin: { enabled: true, state: 'live', available: true },
      withoutNin: { enabled: false },
      newPatientRegistrationRequiresNin: true,
    });
    expect(JSON.stringify(answer)).not.toMatch(FORBIDDEN_WORD);
  });

  it('reports them not available while the breaker is tripped', async () => {
    const breaker = new NinProviderBreaker();
    breaker.recordFailure(new DomainProblem(503, 'QOREID_PROVIDER_UNAVAILABLE', 'down'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect((await capabilities(gate(), breaker)).nin).toEqual({ enabled: true, state: 'live', available: false });
  });

  it('reports them off while QoreID\'s switch is off, as today', async () => {
    expect((await capabilities(gate({ isAvailable: jest.fn(async () => false) }))).nin)
      .toEqual({ enabled: false, state: 'unavailable', available: false });
  });

  it('reports them on but not available when the switch cannot be read', async () => {
    const qoreId = gate({ isAvailable: jest.fn(async () => { throw new DomainProblem(503, 'INTEGRATION_UNAVAILABLE', 'x'); }) });
    expect((await capabilities(qoreId)).nin).toEqual({ enabled: true, state: 'live', available: false });
  });
});

describe('Q108 desk NIN details the request refuses before any check', () => {
  async function refusedFields(body: Record<string, unknown>) {
    const errors = await validate(plainToInstance(ResolveNinDto, body), { whitelist: true, forbidNonWhitelisted: true });
    return errors.map((error) => error.property);
  }

  it('accepts a real date of birth and plain names', async () => {
    expect(await refusedFields(input)).toEqual([]);
    expect(await refusedFields({ ...input, dateOfBirth: '1900-01-01' })).toEqual([]);
    expect(await refusedFields({ ...input, firstName: '  Ada  Bola ' })).toEqual([]);
  });

  it.each([
    ['a date of birth in the future', { dateOfBirth: '2062-03-01' }, 'dateOfBirth'],
    ['a date of birth before 1900', { dateOfBirth: '1899-12-31' }, 'dateOfBirth'],
    ['a first name with a tab', { firstName: 'Ada\tBola' }, 'firstName'],
    ['a last name with a line break', { lastName: 'Fic\ntional' }, 'lastName'],
    ['a blank name', { firstName: '   ' }, 'firstName'],
  ])('refuses %s', async (_label, overrides, field) => {
    expect(await refusedFields({ ...input, ...overrides })).toEqual([field]);
  });
});
