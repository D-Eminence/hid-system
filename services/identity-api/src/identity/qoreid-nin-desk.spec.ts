import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type INestApplication, Logger, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Response } from 'express';
import supertest from 'supertest';
import { AuditService } from '../audit/audit.service';
import * as environment from '../config/environment';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { HidCodeGenerator } from './hid-code-generator.service';
import { NinIdentifierProtector } from './nin-identifier-protector';
import { NinRegistrationController } from './nin-registration.controller';
import { NinRegistrationService, SEALED_TENANT_SQL } from './nin-registration.service';
import {
  DeferredNinVerificationProvider,
  DeterministicTestNinVerificationProvider,
  isNinCheckNotStarted,
  isNinCheckOwnFault,
  isNinCheckRefusedUnsent,
  isNinNotConfigured,
  isStoredNinAnswer,
  markNinCheckStillRunning,
  markStoredNinAnswer,
  NIN_NOT_CONFIGURED_DETAIL,
  UnavailableNinVerificationProvider,
} from './nin-verification.provider';
import { NIN_BREAKER_RETRY_AFTER_MS, NIN_PROVIDER_UNAVAILABLE_EVENT, NinProviderBreaker } from './nin-provider-breaker';
import { ninCheckHeld, ninCheckInProgress, ninCheckStillRunning, ninCheckUnavailable } from './nin-check-once';
import { NIN_VERIFICATION_PROVIDER, type NinCheckSettlement, type NinVerificationProvider,
  type NinVerificationRequest } from './nin.types';
import { type NinRecordCheck, type PublicPatientIdentityProvider, QoreIdPublicPatientIdentityProvider,
  type VerifiedPublicPatientIdentity } from './patient-enrollment.provider';
import { markQoreIdDelivery, type QoreIdDelivery } from './qoreid-delivery';
import {
  QoreIdNinVerificationProvider,
  selectNinVerificationProvider,
} from './qoreid-nin-verification.provider';
import { passThroughNinCheck } from '../testing/nin-check-store.fake';

/**
 * Q108 (owner: "Q108 A"): the registration desk's NIN check through QoreID.
 * The QoreID gate and adapter are mocked: no call reaches QoreID. Fictional
 * people and identifiers only.
 */
const FORBIDDEN_WORD = /unverified/i;
/** SQL text with its whitespace runs made single spaces, as the harnesses record it. */
const words = (text: string) => text.replace(/\s+/g, ' ').trim();
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

/** The guard's answer for the desk: the record (names, date of birth, sex) and QoreID's reference. */
function found(overrides: Partial<VerifiedPublicPatientIdentity> = {},
  source: NinRecordCheck['source'] = 'qoreid'): NinRecordCheck {
  const { providerReference, ...names } = record(overrides);
  return { source, outcome: 'record', record: names, providerReference };
}

function noRecord(source: NinRecordCheck['source'] = 'qoreid'): NinRecordCheck {
  return { source, outcome: 'no_record' };
}

/** An error a QoreID request raised, marked as the adapter marks it with how far the request got. */
function fromQoreId(status: number, code: string, delivery: QoreIdDelivery = 'sent', httpStatus?: number) {
  return markQoreIdDelivery(new DomainProblem(status, code, 'External verification is unavailable'),
    { delivery, ...(httpStatus === undefined ? {} : { status: httpStatus }) });
}

/** An answer HID cannot use, given again from storage by 0137 (nothing sent for this request). */
function storedUnusable() {
  return markStoredNinAnswer(new DomainProblem(502, 'QOREID_PROVIDER_RESPONSE_INVALID',
    'External verification returned an invalid response'));
}

/** Q117: the one answer for a NIN QoreID has no record of, on the desk, sign-up and the profile. */
const NO_RECORD_ANSWER = { status: 422, code: 'NIN_NOT_VERIFIED',
  message: 'This NIN could not be verified. Check the number and try again.' };

function gate(overrides: Partial<Record<keyof PublicPatientIdentityProvider, jest.Mock>> = {}) {
  return {
    assertAvailable: jest.fn(async () => undefined),
    isAvailable: jest.fn(async () => true),
    // The desk never uses sign-up's check, which needs a complete record.
    verifyNin: jest.fn(async () => { throw new Error('the desk asks verifyNinRecord'); }),
    verifyNinRecord: jest.fn(async () => found()),
    ...overrides,
  };
}

/** What the desk hands the guard: the request's correlation id, path 'desk' and its own details to expect. */
const deskCheck = { correlationId: 'correlation-q108', path: 'desk', expects: expect.any(Function) };

function qoreIdProvider(qoreId = gate()) {
  return new QoreIdNinVerificationProvider(qoreId as never);
}

beforeEach(() => {
  jest.spyOn(environment, 'getEnvironment').mockReturnValue({ NIN_PROVIDER_MODE: 'unavailable' } as never);
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

  it('sends only the NIN, through 0137\'s once-per-NIN guard as the desk, and answers a match with QoreID\'s reference', async () => {
    const qoreId = gate();
    const answer = await qoreIdProvider(qoreId).verify(request);
    // The request's correlation id and path 'desk' go to the guard (its audit row); nothing else but the NIN.
    expect(qoreId.verifyNinRecord).toHaveBeenCalledTimes(1);
    expect(qoreId.verifyNinRecord).toHaveBeenCalledWith(NIN, deskCheck);
    expect(Object.keys(qoreId.verifyNinRecord.mock.calls[0][1]).sort()).toEqual(['correlationId', 'expects', 'path']);
    expect(qoreId.verifyNin).not.toHaveBeenCalled();
    expect(answer).toEqual({
      verified: true, outcome: 'match', provider: 'qoreid', reference: '700123',
      verifiedAt: expect.any(String),
      demographics: { firstName: 'Ada', lastName: 'Fictional', dateOfBirth: '1991-04-05', gender: 'female' },
    });
  });

  it('matches names whatever the letter case and spacing', async () => {
    const qoreId = gate({ verifyNinRecord: jest.fn(async () => found({ firstName: ' ada ', lastName: 'fictional' })) });
    const answer = await qoreIdProvider(qoreId).verify({ ...request,
      claimedDemographics: { ...claimed, firstName: 'Ada' } });
    expect(answer).toMatchObject({ verified: true, outcome: 'match' });
  });

  it('keeps the sex the desk gave, and leaves out an unknown one from the record', async () => {
    const given = await qoreIdProvider().verify({ ...request, claimedDemographics: { ...claimed, gender: 'male' } });
    expect(given.demographics.gender).toBe('male');
    const unknown = await qoreIdProvider(gate({ verifyNinRecord: jest.fn(async () => found({ gender: 'unknown' })) }))
      .verify(request);
    expect(unknown.demographics).not.toHaveProperty('gender');
  });

  it('uses a record without a recognised sex (one a sign-up could not use) for its name and date of birth', async () => {
    // 0137 keeps such a record as incomplete or unusable; the desk needs only the name and date of birth.
    const { gender: _gender, providerReference, ...names } = record();
    const qoreId = gate({ verifyNinRecord: jest.fn(async (): Promise<NinRecordCheck> => ({ source: 'qoreid',
      outcome: 'record', record: names, providerReference })) });
    const answer = await qoreIdProvider(qoreId).verify(request);
    expect(answer).toMatchObject({ verified: true, outcome: 'match', reference: '700123' });
    expect(answer.demographics).not.toHaveProperty('gender');
    const given = await qoreIdProvider(qoreId).verify({ ...request, claimedDemographics: { ...claimed, gender: 'female' } });
    expect(given.demographics.gender).toBe('female');
  });

  it('hands the guard the desk\'s own details, so a record that is someone else\'s is kept only 24 hours', async () => {
    const qoreId = gate();
    await qoreIdProvider(qoreId).verify(request);
    const { expects } = qoreId.verifyNinRecord.mock.calls[0][1] as { expects: (record: unknown) => boolean };
    expect(expects({ nin: NIN, firstName: ' ada ', lastName: 'FICTIONAL', dateOfBirth: '1991-04-05' })).toBe(true);
    expect(expects({ nin: NIN, firstName: 'ADA', lastName: 'OTHER', dateOfBirth: '1991-04-05' })).toBe(false);
    expect(expects({ nin: NIN, firstName: 'ADA', lastName: 'FICTIONAL', dateOfBirth: '1991-04-06' })).toBe(false);
  });

  it('says when an answer is one 0137 kept, so nothing was sent for this request', async () => {
    const stored = (answer: NinRecordCheck) => qoreIdProvider(gate({ verifyNinRecord: jest.fn(async () => answer) }))
      .verify(request);
    await expect(stored(found({}, 'stored'))).resolves.toMatchObject({ verified: true, stored: true });
    await expect(stored(found({ lastName: 'OTHER' }, 'stored'))).resolves.toMatchObject({ verified: false,
      outcome: 'name_mismatch', stored: true });
    await expect(stored(noRecord('stored'))).resolves.toMatchObject({ verified: false, outcome: 'no_match',
      stored: true });
    await expect(stored(found())).resolves.not.toHaveProperty('stored');
    const bad = await stored(found({ firstName: ' ' }, 'stored')).catch((error: unknown) => error);
    expect(bad).toMatchObject({ status: 502, code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
    expect(isStoredNinAnswer(bad)).toBe(true);
    expect(isStoredNinAnswer(await stored(found({ firstName: ' ' })).catch((error: unknown) => error))).toBe(false);
  });

  it('makes no keep call of its own for a stored record (Q115: 0137\'s begin counted the use as it answered)', async () => {
    const verifyNinRecord = jest.fn(async () => found({}, 'stored'));
    const result = await qoreIdProvider(gate({ verifyNinRecord })).verify(request);
    // The guard's one call is the whole use: the desk has no other way to 0137 (no NinCheckOnce of its own).
    expect(verifyNinRecord).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ verified: true, outcome: 'match', stored: true });
    expect(Object.keys(result).sort()).toEqual(['demographics', 'outcome', 'provider', 'reference', 'stored',
      'verified', 'verifiedAt']);
  });

  it.each([
    ['a different first name', { firstName: 'BOLA' }],
    ['a different last name', { lastName: 'OTHER' }],
    ['the names the other way round', { firstName: 'FICTIONAL', lastName: 'ADA' }],
    ['a different date of birth', { dateOfBirth: '1991-04-06' }],
  ])('answers a name mismatch for %s', async (_label, overrides) => {
    const answer = await qoreIdProvider(gate({ verifyNinRecord: jest.fn(async () => found(overrides)) })).verify(request);
    expect(answer).toMatchObject({ verified: false, outcome: 'name_mismatch', provider: 'qoreid', reference: '700123',
      demographics: claimed });
  });

  it('answers a record born before 1900 (the adapter reads dates from 1800) as not the desk\'s: a mismatch, not 502', async () => {
    // The desk's own date of birth is from 1900, so such a record never matches; QoreID answered all the same.
    const answer = await qoreIdProvider(gate({ verifyNinRecord: jest.fn(async () => found({ dateOfBirth: '1899-12-31' })) }))
      .verify(request);
    expect(answer).toMatchObject({ verified: false, outcome: 'name_mismatch', reference: '700123' });
    const old = await qoreIdProvider(gate({ verifyNinRecord: jest.fn(async () => found({ dateOfBirth: '1800-01-01' })) }))
      .verify(request);
    expect(old).toMatchObject({ verified: false, outcome: 'name_mismatch' });
    // Before 1800, or not a real date, the adapter would not have read it: still an answer HID cannot use.
    await expect(qoreIdProvider(gate({ verifyNinRecord: jest.fn(async () => found({ dateOfBirth: '1799-12-31' })) }))
      .verify(request)).rejects.toMatchObject({ status: 502, code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
  });

  it('answers no match when QoreID does not confirm the NIN', async () => {
    const qoreId = gate({ verifyNinRecord: jest.fn(async () => noRecord()) });
    const answer = await qoreIdProvider(qoreId).verify(request);
    expect(answer).toMatchObject({ verified: false, outcome: 'no_match', provider: 'qoreid', demographics: claimed });
    expect(answer.reference).not.toContain(NIN);
  });

  it.each(['QOREID_DISABLED', 'QOREID_NIN_ONLY_DISABLED', 'INTEGRATION_PAUSED', 'QOREID_CONFIGURATION_INVALID'])(
    'answers "not configured" when the gate refuses with %s', async (code) => {
      const qoreId = gate({ verifyNinRecord: jest.fn(async () => { throw new DomainProblem(503, code, 'off'); }) });
      const refusal = qoreIdProvider(qoreId).verify(request);
      await expect(refusal).rejects.toMatchObject({ status: 503, code: 'NIN_PROVIDER_UNAVAILABLE',
        message: NIN_NOT_CONFIGURED_DETAIL });
      await refusal.catch((error) => expect(isNinNotConfigured(error)).toBe(true));
    });

  it('answers "cannot be started" when the gate\'s control cannot be read just before sending', async () => {
    const qoreId = gate({ verifyNinRecord: jest.fn(async () => {
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
    const qoreId = gate({ verifyNinRecord: jest.fn(async () => { throw fromQoreId(status, code); }) });
    const refusal = qoreIdProvider(qoreId).verify(request);
    await expect(refusal).rejects.toMatchObject({ status, code });
    await refusal.catch((error) => {
      expect(isNinNotConfigured(error)).toBe(false);
      // QoreID failing: not HID's own fault, so the breaker counts it.
      expect(isNinCheckOwnFault(error)).toBe(false);
    });
  });

  it('marks an error no QoreID request raised as HID\'s own', async () => {
    const thrown = async (error: unknown) => qoreIdProvider(gate({ verifyNinRecord: jest.fn(async () => {
      throw error;
    }) })).verify(request).catch((caught: unknown) => caught);
    // The guard's audit write failing, and a database fault: HID's own.
    for (const own of [new ServiceUnavailableException('Audit persistence is unavailable; request was denied'),
      Object.assign(new Error('connection reset'), { code: '08006' })]) {
      const caught = await thrown(own);
      expect(caught).toBe(own);
      expect(isNinCheckOwnFault(caught)).toBe(true);
    }
    // The guard's own answers keep their meaning.
    const stored = await thrown(storedUnusable());
    expect([isStoredNinAnswer(stored), isNinCheckOwnFault(stored)]).toEqual([true, false]);
    const running = await thrown(markNinCheckStillRunning(ninCheckStillRunning()));
    expect(isNinCheckOwnFault(running)).toBe(false);
    const held = await thrown(ninCheckHeld(new Date(Date.now() + 60_000)));
    expect(isNinCheckOwnFault(held)).toBe(false);
  });

  describe('the answers of 0137\'s once-per-NIN guard', () => {
    const held = new Date(Date.now() + 5 * 60 * 1000);
    it.each([
      ['this NIN is being checked', () => ninCheckInProgress(), 409, 'NIN_CHECK_IN_PROGRESS', 60],
      ['this NIN is held after a check QoreID may have charged', () => ninCheckHeld(held), 409, 'NIN_CHECK_HELD', 300],
      ['the check is still running after the wait', () => ninCheckStillRunning(), 504, 'QOREID_TIMEOUT', 60],
    ] as const)('passes "%s" on with retryAfterSeconds', async (_label, refusal, status, code, retryAfterSeconds) => {
      const qoreId = gate({ verifyNinRecord: jest.fn(async () => { throw refusal(); }) });
      const answer = await qoreIdProvider(qoreId).verify(request).catch((error: unknown) => error) as DomainProblem;
      expect(answer).toMatchObject({ status, code });
      expect(answer.extensions?.retryAfterSeconds).toBeGreaterThanOrEqual(retryAfterSeconds - 1);
      expect(answer.extensions?.retryAfterSeconds).toBeLessThanOrEqual(retryAfterSeconds);
      expect(isNinCheckRefusedUnsent(answer)).toBe(code !== 'QOREID_TIMEOUT');
    });

    it('answers "cannot be started" when the guard\'s store cannot be read', async () => {
      const qoreId = gate({ verifyNinRecord: jest.fn(async () => { throw ninCheckUnavailable(); }) });
      const refusal = qoreIdProvider(qoreId).verify(request);
      await expect(refusal).rejects.toMatchObject({ status: 503, code: 'NIN_PROVIDER_UNAVAILABLE',
        message: 'NIN checks cannot be started right now. Please try again in a minute.' });
      await refusal.catch((error) => expect(isNinCheckNotStarted(error)).toBe(true));
    });
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
    const qoreId = gate({ verifyNinRecord: jest.fn(async () => found(overrides)) });
    await expect(qoreIdProvider(qoreId).verify(request)).rejects.toMatchObject({
      status: 502, code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
  });

  it('has no claim, stored answer or limit of its own: only the NIN check (Q109, 0137)', () => {
    const provider = qoreIdProvider();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(provider)).sort())
      .toEqual(['constructor', 'isEnabled', 'notVerified', 'verify']);
  });
});

describe('Q108 desk NIN resolve through QoreID', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  /**
   * `holders`: what each read of the NIN's verified holder (identity.patient_identifiers) finds, in turn;
   * none by default. `sealed`: what the read of the sealed demo and QA tenants answers (SEALED_TENANT_SQL),
   * or the error it raises; not sealed by default.
   */
  function desk(provider: NinVerificationProvider, breaker = new NinProviderBreaker(),
    holders: Array<Record<string, unknown> | Error | undefined> = [], sealed: boolean | Error = false) {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const query = jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql: sql.replace(/\s+/g, ' '), values });
      if (sql.includes('from identity.patient_identifiers identifier')) {
        const holder = holders.shift();
        if (holder instanceof Error) throw holder;
        return { rows: holder ? [holder] : [] };
      }
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
      // The sealed tenant read, outside any transaction (as the code sends it).
      query: jest.fn(async (sql: string, values: unknown[] = []) => {
        statements.push({ sql: sql.replace(/\s+/g, ' '), values });
        if (sealed instanceof Error) throw sealed;
        return { rows: sql === SEALED_TENANT_SQL ? [{ sealed }] : [] };
      }),
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

  it.each([
    ['QoreID\'s "no record"', 'qoreid', {}],
    ['a "no record" 0137 kept (QoreID\'s 404 included)', 'stored', { storedAnswer: true }],
  ] as const)('answers %s as 422 NIN_NOT_VERIFIED (Q117) and audits it', async (_label, source, extra) => {
    const qoreId = gate({ verifyNinRecord: jest.fn(async () => noRecord(source)) });
    const { service, audit, breaker } = desk(qoreIdProvider(qoreId));
    await expect(service.resolve(input, 'resolve-key-q108-000003', context)).rejects.toMatchObject(NO_RECORD_ANSWER);
    expect(breaker.state()).toBe('closed');
    expect(auditRows(audit)).toEqual([expect.objectContaining({ action: 'identity.nin.verify', outcome: 'denied',
      details: { provider: 'qoreid', ninCheck: 'no_match', ...extra } })]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers QoreID\'s 404 "not found", fresh or kept by 0137, 422 NIN_NOT_VERIFIED through the real verifyNinRecord (Q117)', async () => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ NIN_PROVIDER_MODE: 'unavailable', QOREID_ENABLED: true,
      QOREID_NIN_ONLY_ENROLLMENT_ENABLED: true } as never);
    // QoreID's 404, as the adapter raises it: answered, status 404.
    const adapter = { verifyNinEnrollment: jest.fn(async () => {
      throw markQoreIdDelivery(new DomainProblem(502, 'QOREID_PROVIDER_REJECTED',
        'External verification could not be completed'), { delivery: 'answered', status: 404 });
    }) };
    const integrations = { assertAvailable: jest.fn(async () => undefined) };
    const realGate = (ninCheck: unknown) => new QoreIdPublicPatientIdentityProvider(adapter as never,
      integrations as never, ninCheck as never);
    // Fresh: the guard asks QoreID for this request and passes its 404 on.
    const fresh = desk(qoreIdProvider(realGate(passThroughNinCheck()) as never));
    await expect(fresh.service.resolve(input, 'resolve-key-q117-000001', context)).rejects.toMatchObject(NO_RECORD_ANSWER);
    expect(adapter.verifyNinEnrollment).toHaveBeenCalledTimes(1);
    expect(fresh.breaker.state()).toBe('closed');
    // Kept: 0137 hands back the 404 it kept ('rejected'); nothing is sent.
    const kept = { check: jest.fn(async () => ({ source: 'stored', answer: { outcome: 'rejected' }, value: undefined })) };
    const stored = desk(qoreIdProvider(realGate(kept) as never));
    await expect(stored.service.resolve(input, 'resolve-key-q117-000002', context)).rejects.toMatchObject(NO_RECORD_ANSWER);
    expect(adapter.verifyNinEnrollment).toHaveBeenCalledTimes(1);
    expect(auditRows(fresh.audit).concat(auditRows(stored.audit))).toEqual([
      expect.objectContaining({ action: 'identity.nin.verify', outcome: 'denied',
        details: { provider: 'qoreid', ninCheck: 'no_match' } }),
      expect.objectContaining({ action: 'identity.nin.verify', outcome: 'denied',
        details: { provider: 'qoreid', ninCheck: 'no_match', storedAnswer: true } })]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('tells the desk the name or date of birth does not match, and audits a name mismatch', async () => {
    const qoreId = gate({ verifyNinRecord: jest.fn(async () => found({ lastName: 'OTHER' })) });
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
    const { service, audit, breaker } = desk(qoreIdProvider(qoreId));
    for (const key of ['resolve-key-q108-000005', 'resolve-key-q108-000006', 'resolve-key-q108-000007',
      'resolve-key-q108-000008']) {
      await expect(service.resolve(input, key, context)).rejects.toMatchObject({
        status: 503, code: 'NIN_PROVIDER_UNAVAILABLE', message: NIN_NOT_CONFIGURED_DETAIL });
    }
    expect(qoreId.verifyNinRecord).not.toHaveBeenCalled();
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
    expect(qoreId.verifyNinRecord).not.toHaveBeenCalled();
    expect(breaker.state()).toBe('closed');
    expect(auditRows(audit)).toEqual([expect.objectContaining({ action: 'identity.nin.verify', outcome: 'failure',
      details: expect.objectContaining({ provider: 'qoreid', code: 'INTEGRATION_UNAVAILABLE', providerCalled: false }) })]);
  });

  it('sends every check one desk account makes, with no hourly, daily or facility limit (Q109)', async () => {
    const qoreId = gate();
    const { service, audit } = desk(qoreIdProvider(qoreId));
    for (let index = 0; index < 25; index += 1) {
      await expect(service.resolve(input, `resolve-key-q109-${String(index).padStart(6, '0')}`, context))
        .resolves.toMatchObject({ caseId });
    }
    expect(qoreId.verifyNinRecord).toHaveBeenCalledTimes(25);
    expect(JSON.stringify(auditRows(audit))).not.toMatch(/LIMIT/);
  });

  it('lets one facility check as many NINs as its desks need in a day: no facility limit (Q109)', async () => {
    const qoreId = gate();
    const { service, audit } = desk(qoreIdProvider(qoreId));
    // 40 desk accounts at one facility, 10 checks each: 400 checks, more than the review build's 300 a day.
    for (let account = 0; account < 40; account += 1) {
      const suffix = String(account).padStart(12, '0');
      const member = { ...context, membershipId: `c3d4e5f6-a7b8-4c9d-8e0f-${suffix}`,
        actor: { ...context.actor, accountId: `f0e1d2c3-b4a5-4968-8776-${suffix}` } } as DataAccessContext;
      for (let check = 0; check < 10; check += 1) {
        await expect(service.resolve(input, `resolve-key-fac-${String(account * 10 + check).padStart(6, '0')}`, member))
          .resolves.toMatchObject({ caseId });
      }
    }
    expect(qoreId.verifyNinRecord).toHaveBeenCalledTimes(400);
    expect(JSON.stringify(auditRows(audit))).not.toMatch(/LIMIT|NIN_CHECK_HELD/);
  });

  it('trips the breaker when QoreID is down, logs no NIN, and stops sending checks', async () => {
    const qoreId = gate({ verifyNinRecord: jest.fn(async () => {
      throw fromQoreId(503, 'QOREID_PROVIDER_UNAVAILABLE', 'sent', 503);
    }) });
    const { service, audit, breaker } = desk(qoreIdProvider(qoreId));
    await expect(service.resolve(input, 'resolve-key-q108-000011', context)).rejects.toMatchObject({ status: 503 });
    expect(breaker.state()).toBe('open');
    await expect(service.resolve(input, 'resolve-key-q108-000012', context)).rejects.toMatchObject({
      code: 'NIN_PROVIDER_UNAVAILABLE', message: 'The NIN service is not answering right now. Please try again in a minute.' });
    expect(qoreId.verifyNinRecord).toHaveBeenCalledTimes(1);
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
      fromQoreId(504, 'QOREID_TIMEOUT'),
      fromQoreId(502, 'QOREID_PROVIDER_RESPONSE_INVALID', 'answered'),
      fromQoreId(504, 'QOREID_TIMEOUT'),
    ];
    const qoreId = gate({ verifyNinRecord: jest.fn(async () => { throw failures.shift(); }) });
    const { service, breaker } = desk(qoreIdProvider(qoreId));
    for (const key of ['resolve-key-q108-000013', 'resolve-key-q108-000014']) {
      await expect(service.resolve(input, key, context)).rejects.toBeInstanceOf(DomainProblem);
      expect(breaker.state()).toBe('closed');
    }
    await expect(service.resolve(input, 'resolve-key-q108-000015', context)).rejects.toMatchObject({ code: 'QOREID_TIMEOUT' });
    expect(breaker.state()).toBe('open');
  });

  it.each([
    ['its token request timed out (nothing sent)', 'not_sent'],
    ['the check timed out at its deadline', 'sent'],
  ] as const)('answers QoreID\'s own 504 QOREID_TIMEOUT when %s with retryAfterSeconds, as the guard\'s', async (_label,
    delivery) => {
    const timeout = fromQoreId(504, 'QOREID_TIMEOUT', delivery);
    const qoreId = gate({ verifyNinRecord: jest.fn(async () => { throw timeout; }) });
    const { service, audit, breaker } = desk(qoreIdProvider(qoreId));
    const answer = await service.resolve(input, 'resolve-key-q108-000070', context).catch((error: unknown) => error);
    expect(answer).toMatchObject({ status: 504, code: 'QOREID_TIMEOUT', extensions: { retryAfterSeconds: 60 } });
    // Still QoreID failing: one failure for the breaker, audited as a provider error.
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: NIN_PROVIDER_UNAVAILABLE_EVENT,
      code: 'QOREID_TIMEOUT', status: 504 }));
    expect(breaker.state()).toBe('closed');
    expect(auditRows(audit)).toEqual([expect.objectContaining({ action: 'identity.nin.verify', outcome: 'failure',
      details: expect.objectContaining({ code: 'QOREID_TIMEOUT', providerCalled: true, ninCheck: 'provider_error' }) })]);
  });

  it('does not count QoreID\'s own rate limit (429) as an outage', async () => {
    const qoreId = gate({ verifyNinRecord: jest.fn(async () => {
      throw fromQoreId(429, 'QOREID_RATE_LIMITED', 'not_sent', 429);
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
    const qoreId = gate({ verifyNinRecord: jest.fn(async () => {
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
    const qoreId = gate({ verifyNinRecord: jest.fn(async () => {
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

  it('hands every resend to 0137\'s guard, which decides whether QoreID is asked: no claim or stored answer of its own', async () => {
    const verifyNinRecord = jest.fn(async () => noRecord());
    const { service, audit, breaker } = desk(qoreIdProvider(gate({ verifyNinRecord })));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(service.resolve(input, 'resolve-key-q109-000041', context)).rejects.toMatchObject(NO_RECORD_ANSWER);
    }
    // The guard answers the second from the answer it stored (qoreid-nin-desk-once.spec.ts).
    expect(verifyNinRecord).toHaveBeenCalledTimes(2);
    expect(verifyNinRecord).toHaveBeenNthCalledWith(2, NIN, { ...deskCheck, onQoreIdSettled: expect.any(Function) });
    expect(breaker.state()).toBe('closed');
    expect(auditRows(audit)).toEqual([0, 1].map(() => expect.objectContaining({ action: 'identity.nin.verify',
      outcome: 'denied', details: { provider: 'qoreid', ninCheck: 'no_match' } })));
  });

  it('lets the desk resend a request whose check failed', async () => {
    const qoreId = gate({ verifyNinRecord: jest.fn()
      .mockRejectedValueOnce(fromQoreId(504, 'QOREID_TIMEOUT'))
      .mockResolvedValueOnce(found()) });
    const { service } = desk(qoreIdProvider(qoreId));
    await expect(service.resolve(input, 'resolve-key-q108-000042', context)).rejects.toMatchObject({ status: 504 });
    await expect(service.resolve(input, 'resolve-key-q108-000042', context)).resolves.toMatchObject({ caseId });
    expect(qoreId.verifyNinRecord).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a date of birth in the future', { dateOfBirth: '2062-03-01' }],
    ['a date of birth before 1900', { dateOfBirth: '1899-12-31' }],
    ['a name with a tab', { firstName: 'Ada\tBola' }],
    ['a blank name', { lastName: '   ' }],
  ])('refuses %s before anything is sent or charged', async (_label, overrides) => {
    const qoreId = gate();
    const { service, audit, breaker } = desk(qoreIdProvider(qoreId));
    for (const key of ['resolve-key-q108-000043', 'resolve-key-q108-000044', 'resolve-key-q108-000045']) {
      await expect(service.resolve({ ...input, ...overrides }, key, context)).rejects.toMatchObject({
        status: 400, code: 'NIN_DETAILS_INVALID',
        message: 'Check the name and the date of birth. The date of birth cannot be in the future or before 1900.' });
    }
    expect(qoreId.verifyNinRecord).not.toHaveBeenCalled();
    expect(breaker.state()).toBe('closed');
    expect(warn).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'identity.nin.verify',
      outcome: 'failure', details: expect.objectContaining({ code: 'NIN_DETAILS_INVALID', providerCalled: false }) }));
  });

  it('does not trip the breaker or record a call when the switch cannot be read again just before sending', async () => {
    const qoreId = gate({ verifyNinRecord: jest.fn()
      .mockRejectedValueOnce(new DomainProblem(503, 'INTEGRATION_UNAVAILABLE', 'Delivery provider is temporarily unavailable'))
      .mockResolvedValueOnce(found()) });
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

  it('runs, in the database suite, the holder read the desk sends, word for word', async () => {
    // The fakes here answer the read themselves. The Postgres suite
    // (desk-nin-holder.integration.sql) runs this exact read under row-level
    // security as Identity's runtime role in the desk's context: a revoked NIN,
    // an inactive patient and a member without registration permission. It
    // must keep testing what the code sends.
    const { service, statements } = desk(qoreIdProvider(gate()));
    await service.resolve(input, 'resolve-key-sql-000001', context);
    const suite = readFileSync(join(__dirname, '../../../ehr-api/test/database/desk-nin-holder.integration.sql'), 'utf8');
    const body = (name: string) => new RegExp(`create function pg_temp\\.${name}\\([\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$`)
      .exec(suite)?.[1] ?? `pg_temp.${name} is missing`;
    const holder = statements.find(({ sql }) => sql.includes('from identity.patient_identifiers identifier'));
    expect(words(body('desk_nin_holder'))).toBe(words(holder?.sql ?? 'no holder read was sent'));
    // No hold or count of any kind is read or written (Q109).
    expect(statements.some(({ sql }) => sql.includes('otp_rate_limits'))).toBe(false);
  });

  describe('a desk of the sealed demo or QA tenant (0098 G6, 0123 G6q and D9)', () => {
    const holder = { patient_id: 'b1000000-0000-4000-8000-000000000001', hid_code: 'HID-FIXTURE-0002',
      first_name: 'ADA', last_name: 'FICTIONAL', dob: '1991-04-05', gender: 'female',
      verification_provider: 'qoreid', verification_reference: '700001', verified_at: '2026-10-01T08:00:00.000Z' };

    it('answers "not configured" before anything is read or sent: no QoreID call, no holder read, no guard', async () => {
      const qoreId = gate();
      const { service, audit, statements, breaker } = desk(qoreIdProvider(qoreId), undefined, [holder], true);
      for (const key of ['resolve-key-seal-000001', 'resolve-key-seal-000002']) {
        await expect(service.resolve(input, key, context)).rejects.toMatchObject({
          status: 503, code: 'NIN_PROVIDER_UNAVAILABLE', message: NIN_NOT_CONFIGURED_DETAIL });
      }
      expect(qoreId.verifyNinRecord).not.toHaveBeenCalled();
      expect(qoreId.verifyNin).not.toHaveBeenCalled();
      // The seal is asked with the desk's facility and staff account, and nothing else is read.
      expect(statements.filter(({ sql }) => sql === words(SEALED_TENANT_SQL)).map(({ values }) => values))
        .toEqual([[context.facilityId, context.actor.accountId], [context.facilityId, context.actor.accountId]]);
      expect(statements.some(({ sql }) => sql.includes('from identity.patient_identifiers identifier'))).toBe(false);
      expect(statements.some(({ sql }) => /insert into identity\.registration_cases \(/.test(sql))).toBe(false);
      expect(breaker.state()).toBe('closed');
      expect(warn).not.toHaveBeenCalled();
      expect(auditRows(audit)).toEqual([0, 1].map(() => expect.objectContaining({ action: 'identity.nin.verify',
        outcome: 'failure', details: { provider: 'qoreid', errorType: 'DomainProblem', code: 'NIN_PROVIDER_UNAVAILABLE',
          providerCalled: false, sealedTenant: true } })));
    });

    it('fails closed when the seal cannot be read: "cannot be started", nothing sent, the breaker untouched', async () => {
      const qoreId = gate();
      const lost = Object.assign(new Error('connection reset'), { code: '08006' });
      const { service, audit, breaker } = desk(qoreIdProvider(qoreId), undefined, [holder], lost);
      await expect(service.resolve(input, 'resolve-key-seal-000003', context)).rejects.toMatchObject({
        status: 503, code: 'NIN_PROVIDER_UNAVAILABLE',
        message: 'NIN checks cannot be started right now. Please try again in a minute.' });
      expect(qoreId.verifyNinRecord).not.toHaveBeenCalled();
      expect(breaker.state()).toBe('closed');
      expect(JSON.stringify(auditRows(audit))).not.toContain('connection reset');
      expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'identity.nin.verify',
        outcome: 'failure', details: expect.objectContaining({ providerCalled: false }) }));
    });

    it('is asked for every check at any other desk, after the switch, and the check goes on', async () => {
      const qoreId = gate();
      const { service, statements } = desk(qoreIdProvider(qoreId));
      await expect(service.resolve(input, 'resolve-key-seal-000004', context)).resolves.toMatchObject({ caseId });
      expect(qoreId.verifyNinRecord).toHaveBeenCalledTimes(1);
      expect(statements.filter(({ sql }) => sql === words(SEALED_TENANT_SQL))).toHaveLength(1);
      // Not asked while NIN checks are switched off: that answer is the same.
      const off = desk(qoreIdProvider(gate({ isAvailable: jest.fn(async () => false) })));
      await expect(off.service.resolve(input, 'resolve-key-seal-000005', context)).rejects.toMatchObject({
        status: 503, message: NIN_NOT_CONFIGURED_DETAIL });
      expect(off.statements.some(({ sql }) => sql === words(SEALED_TENANT_SQL))).toBe(false);
    });

    it('is not asked for a NIN check that sends nothing to QoreID (the test provider)', async () => {
      const { service, statements } = desk(new DeterministicTestNinVerificationProvider(), undefined, [], true);
      await expect(service.resolve(input, 'resolve-key-seal-000006', context)).resolves.toMatchObject({ caseId });
      expect(statements.some(({ sql }) => sql === words(SEALED_TENANT_SQL))).toBe(false);
    });

    it('runs, in the database suite, the seal read the desk sends, word for word', () => {
      // desk-nin-holder.integration.sql runs this read as Identity's runtime role: a demo or QA facility or
      // account is sealed; a real facility and account, and null ids, are not.
      const suite = readFileSync(join(__dirname, '../../../ehr-api/test/database/desk-nin-holder.integration.sql'), 'utf8');
      const body = /create function pg_temp\.desk_sealed_tenant\([\s\S]*?as \$\$([\s\S]*?)\$\$/.exec(suite)?.[1]
        ?? 'pg_temp.desk_sealed_tenant is missing';
      expect(words(body)).toBe(words(SEALED_TENANT_SQL));
    });
  });

  describe('a NIN already on a Health ID (Q110)', () => {
    const holder = { patient_id: 'b1000000-0000-4000-8000-000000000001', hid_code: 'HID-FIXTURE-0002',
      first_name: 'ADA', last_name: ' fictional ', dob: '1991-04-05', gender: 'female',
      verification_provider: 'qoreid', verification_reference: '700001', verified_at: '2026-10-01T08:00:00.000Z' };

    it('matches the patient from the record without asking the NIN service, even with the breaker tripped', async () => {
      const qoreId = gate();
      const breaker = new NinProviderBreaker();
      breaker.recordFailure(new DomainProblem(503, 'QOREID_PROVIDER_UNAVAILABLE', 'down'));
      warn.mockClear();
      const { service, audit, statements } = desk(qoreIdProvider(qoreId), breaker, [holder, holder]);
      await expect(service.resolve(input, 'resolve-key-q110-000001', context)).resolves.toMatchObject({ caseId });
      expect(qoreId.verifyNinRecord).not.toHaveBeenCalled();
      const insert = statements.find(({ sql }) => sql.includes('insert into identity.registration_cases ('));
      expect(insert?.values[4]).toBe('resolved_existing_identity');
      expect(insert?.values.slice(14, 17)).toEqual(['qoreid', '700001', '2026-10-01T08:00:00.000Z']);
      expect(insert?.values[19]).toBe(holder.patient_id);
      expect(auditRows(audit)[0]).toMatchObject({ action: 'identity.nin.verify', outcome: 'success',
        details: { provider: 'qoreid', ninCheck: 'match', providerCalled: false, healthIdRecord: true } });
      expect(breaker.state()).toBe('open');
    });

    it.each([
      ['another first name', { first_name: 'BOLA' }],
      ['the names the other way round', { first_name: 'FICTIONAL', last_name: 'ADA' }],
      ['another date of birth', { dob: '1991-04-06' }],
      ['no date of birth', { dob: null }],
    ])('answers "does not match" from a record with %s, never asking the NIN service', async (_label, overrides) => {
      const qoreId = gate();
      const breaker = new NinProviderBreaker();
      breaker.recordFailure(new DomainProblem(503, 'QOREID_PROVIDER_UNAVAILABLE', 'down'));
      warn.mockClear();
      const { service, audit, statements } = desk(qoreIdProvider(qoreId), breaker, [{ ...holder, ...overrides }]);
      const refusal = await service.resolve(input, 'resolve-key-q110-000002', context).catch((error: unknown) => error);
      // The same answer, code and text as a record from the NIN service that does not match.
      expect(refusal).toMatchObject({ status: 422, code: 'NIN_VERIFICATION_FAILED',
        message: 'The name or date of birth does not match the NIN record. Check the spelling and the date of birth.' });
      expect(qoreId.verifyNinRecord).not.toHaveBeenCalled();
      expect(statements.some(({ sql }) => /insert into identity\.registration_cases \(/.test(sql))).toBe(false);
      expect(auditRows(audit)).toEqual([expect.objectContaining({ action: 'identity.nin.verify', outcome: 'denied',
        details: { provider: 'qoreid', ninCheck: 'name_mismatch', providerCalled: false, healthIdRecord: true } })]);
      // Neither the record's name nor its date of birth reaches the desk or the audit row.
      expect(JSON.stringify([(refusal as Error).message, audit.record.mock.calls])).not.toMatch(/BOLA|1991-04-06/);
      expect(breaker.state()).toBe('open');
      expect(warn).not.toHaveBeenCalled();
    });

    it('answers "cannot be started", sending nothing, for a holder whose check cannot be read', async () => {
      const qoreId = gate();
      const { service, breaker } = desk(qoreIdProvider(qoreId), undefined, [{ ...holder, verification_reference: null }]);
      await expect(service.resolve(input, 'resolve-key-q110-000006', context)).rejects.toMatchObject({
        status: 503, code: 'NIN_PROVIDER_UNAVAILABLE',
        message: 'NIN checks cannot be started right now. Please try again in a minute.' });
      expect(qoreId.verifyNinRecord).not.toHaveBeenCalled();
      expect(breaker.state()).toBe('closed');
    });

    it('writes nothing when the patient changed between the read and the write', async () => {
      const qoreId = gate();
      const { service, statements } = desk(qoreIdProvider(qoreId), undefined, [holder, undefined]);
      // The website's NIN_CHECK_IN_PROGRESS handling (wait, then the same Idempotency-Key) is what this needs; the
      // text says what happened, not that a check is running.
      await expect(service.resolve(input, 'resolve-key-q110-000003', context)).rejects.toMatchObject({
        status: 409, code: 'NIN_CHECK_IN_PROGRESS', extensions: { retryAfterSeconds: 60 },
        message: 'The record for this NIN changed while it was being checked. Please wait a minute, then try again.' });
      expect(statements.some(({ sql }) => sql.includes('insert into identity.registration_cases ('))).toBe(false);
      expect(qoreId.verifyNinRecord).not.toHaveBeenCalled();
    });

    it('answers "cannot be started", sending nothing, when the record cannot be read', async () => {
      const qoreId = gate();
      const lost = Object.assign(new Error('connection reset'), { code: '08006' });
      const { service, audit, breaker } = desk(qoreIdProvider(qoreId), undefined, [lost]);
      await expect(service.resolve(input, 'resolve-key-q110-000005', context)).rejects.toMatchObject({
        status: 503, code: 'NIN_PROVIDER_UNAVAILABLE',
        message: 'NIN checks cannot be started right now. Please try again in a minute.' });
      expect(qoreId.verifyNinRecord).not.toHaveBeenCalled();
      expect(breaker.state()).toBe('closed');
      expect(JSON.stringify(auditRows(audit))).not.toContain('connection reset');
      expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'identity.nin.verify',
        outcome: 'failure', details: expect.objectContaining({ providerCalled: false }) }));
    });

    it('is not read while NIN checks are switched off', async () => {
      const { service, statements } = desk(qoreIdProvider(gate({ isAvailable: jest.fn(async () => false) })),
        undefined, [holder, holder]);
      await expect(service.resolve(input, 'resolve-key-q110-000004', context)).rejects.toMatchObject({
        status: 503, message: NIN_NOT_CONFIGURED_DETAIL });
      expect(statements.some(({ sql }) => sql.includes('from identity.patient_identifiers identifier'))).toBe(false);
    });
  });

  describe('0137\'s once-per-NIN guard', () => {
    /** A breaker tripped a minute ago, now letting one check through. */
    function retryingBreaker() {
      const breaker = new NinProviderBreaker();
      breaker.recordFailure(new DomainProblem(503, 'QOREID_PROVIDER_UNAVAILABLE', 'down'), {},
        Date.now() - NIN_BREAKER_RETRY_AFTER_MS);
      warn.mockClear();
      expect(breaker.state()).toBe('retrying');
      return breaker;
    }

    it.each([
      ['NIN_CHECK_IN_PROGRESS', () => ninCheckInProgress(), 409],
      ['NIN_CHECK_HELD', () => ninCheckHeld(new Date(Date.now() + 6 * 60 * 60 * 1000)), 409],
      ['NIN_PROTECTION_UNAVAILABLE', () => new DomainProblem(503, 'NIN_PROTECTION_UNAVAILABLE',
        'NIN protection keys are unavailable'), 503],
    ] as const)('answers the guard\'s %s as sent nothing: no breaker count, the retry place freed', async (code, refusal,
      status) => {
      const verifyNinRecord = jest.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce(found());
      const breaker = retryingBreaker();
      const { service, audit } = desk(qoreIdProvider(gate({ verifyNinRecord })), breaker);
      const answer = await service.resolve(input, 'resolve-key-q109-000050', context).catch((error: unknown) => error);
      expect(answer).toMatchObject({ status, code });
      if (status === 409) expect((answer as DomainProblem).extensions?.retryAfterSeconds).toBeGreaterThan(0);
      expect(warn).not.toHaveBeenCalled();
      expect(breaker.available()).toBe(true);
      expect(auditRows(audit)).toEqual([expect.objectContaining({ action: 'identity.nin.verify', outcome: 'failure',
        details: { provider: 'qoreid', errorType: 'DomainProblem', code, providerCalled: false } })]);
      // Nothing was sent, so the same request may be sent again.
      await expect(service.resolve(input, 'resolve-key-q109-000050', context)).resolves.toMatchObject({ caseId });
    });

    it('answers the guard\'s store being unreadable as "cannot be started", without touching the breaker', async () => {
      const qoreId = gate({ verifyNinRecord: jest.fn(async () => { throw ninCheckUnavailable(); }) });
      const { service, audit, breaker } = desk(qoreIdProvider(qoreId));
      await expect(service.resolve(input, 'resolve-key-q109-000051', context)).rejects.toMatchObject({
        status: 503, code: 'NIN_PROVIDER_UNAVAILABLE',
        message: 'NIN checks cannot be started right now. Please try again in a minute.' });
      // A 503 from QoreID itself would have tripped it at once.
      expect(breaker.state()).toBe('closed');
      expect(warn).not.toHaveBeenCalled();
      expect(auditRows(audit)).toEqual([expect.objectContaining({ action: 'identity.nin.verify', outcome: 'failure',
        details: expect.objectContaining({ provider: 'qoreid', providerCalled: false }) })]);
    });

    it('passes on 504 QOREID_TIMEOUT with retryAfterSeconds, counting each wait once, and a late answer as a success', async () => {
      const settles: Array<(settlement: NinCheckSettlement) => void> = [];
      const verifyNinRecord = jest.fn(async (_nin: string, check: { onQoreIdSettled: (settlement: NinCheckSettlement) => void }) => {
        settles.push(check.onQoreIdSettled);
        throw markNinCheckStillRunning(ninCheckStillRunning());
      });
      const { service, audit, breaker } = desk(qoreIdProvider(gate({ verifyNinRecord })));
      for (const [index, key] of ['resolve-key-q109-000052', 'resolve-key-q109-000053', 'resolve-key-q109-000054'].entries()) {
        expect(breaker.state()).toBe('closed');
        const answer = await service.resolve(input, key, context).catch((error: unknown) => error);
        expect(answer).toMatchObject({ status: 504, code: 'QOREID_TIMEOUT', extensions: { retryAfterSeconds: 60 } });
        expect(warn).toHaveBeenCalledTimes(index + 1);
      }
      // D4: three waits that ran out within five minutes open it, as three timeouts would: a hang of QoreID
      // stops new (charged) checks after the usual number of waits, not after the 90-second ceiling.
      expect(breaker.state()).toBe('open');
      expect(auditRows(audit)).toEqual([0, 1, 2].map(() => expect.objectContaining({ action: 'identity.nin.verify',
        outcome: 'failure', details: { provider: 'qoreid', errorType: 'DomainProblem', code: 'QOREID_TIMEOUT',
          providerCalled: true, ninCheck: 'provider_error' } })));
      // The third never answers: its failure is not counted a second time.
      settles[2]!({ answered: false, error: fromQoreId(504, 'QOREID_TIMEOUT') });
      expect(warn).toHaveBeenCalledTimes(3);
      // QoreID answers the first late: that answer is recorded as a success and closes it.
      settles[0]!({ answered: true });
      expect(breaker.state()).toBe('closed');
      settles[1]!({ answered: true });
      expect(breaker.state()).toBe('closed');
    });

    it('counts the wait even when the check answers just before the desk is told (and then its answer)', async () => {
      const breaker = retryingBreaker();
      const verifyNinRecord = jest.fn(async (_nin: string, check: { onQoreIdSettled: (settlement: NinCheckSettlement) => void }) => {
        check.onQoreIdSettled({ answered: true });
        throw markNinCheckStillRunning(ninCheckStillRunning());
      });
      const { service } = desk(qoreIdProvider(gate({ verifyNinRecord })), breaker);
      await expect(service.resolve(input, 'resolve-key-q109-000061', context)).rejects.toMatchObject({ status: 504 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(breaker.state()).toBe('closed');
    });

    it('never counts QoreID\'s "not found" (404, given by the guard as "no record") as a failure: QoreID answered', async () => {
      const verifyNinRecord = jest.fn(async (_nin: string, check: { onQoreIdSettled: (settlement: NinCheckSettlement) => void }) => {
        check.onQoreIdSettled({ answered: true });
        return noRecord();
      });
      const { service, audit, breaker } = desk(qoreIdProvider(gate({ verifyNinRecord })));
      for (const key of ['resolve-key-q109-000062', 'resolve-key-q109-000063', 'resolve-key-q109-000064']) {
        await expect(service.resolve(input, key, context)).rejects.toMatchObject(NO_RECORD_ANSWER);
      }
      expect(breaker.state()).toBe('closed');
      expect(warn).not.toHaveBeenCalled();
      expect(auditRows(audit)).toEqual([0, 1, 2].map(() => expect.objectContaining({ action: 'identity.nin.verify',
        outcome: 'denied', details: { provider: 'qoreid', ninCheck: 'no_match' } })));
      // QoreID answering closes a breaker that was letting one check through.
      const retrying = retryingBreaker();
      const { service: next } = desk(qoreIdProvider(gate({ verifyNinRecord })), retrying);
      await expect(next.resolve(input, 'resolve-key-q109-000065', context)).rejects.toMatchObject({ status: 422 });
      expect(retrying.state()).toBe('closed');
    });

    it('never counts an error of HID\'s own (the guard\'s audit write): only what QoreID did, if asked', async () => {
      const auditDown = () => new ServiceUnavailableException('Audit persistence is unavailable; request was denied');
      // Nothing sent (the guard's row for a stored answer could not be audited), three times.
      const unsent = jest.fn(async () => { throw auditDown(); });
      const { service, breaker } = desk(qoreIdProvider(gate({ verifyNinRecord: unsent })));
      for (const key of ['resolve-key-q109-000066', 'resolve-key-q109-000067', 'resolve-key-q109-000068']) {
        await expect(service.resolve(input, key, context)).rejects.toMatchObject({ status: 503 });
      }
      expect(breaker.state()).toBe('closed');
      expect(warn).not.toHaveBeenCalled();
      // QoreID answered, then the guard's audit write failed: QoreID's answer is what counts.
      const retrying = retryingBreaker();
      const answered = jest.fn(async (_nin: string, check: { onQoreIdSettled: (settlement: NinCheckSettlement) => void }) => {
        check.onQoreIdSettled({ answered: true });
        throw auditDown();
      });
      const { service: next, audit } = desk(qoreIdProvider(gate({ verifyNinRecord: answered })), retrying);
      await expect(next.resolve(input, 'resolve-key-q109-000069', context)).rejects.toMatchObject({ status: 503 });
      expect(retrying.state()).toBe('closed');
      expect(auditRows(audit)).toEqual([expect.objectContaining({ action: 'identity.nin.verify', outcome: 'failure',
        details: { provider: 'qoreid', errorType: 'ServiceUnavailableException', providerCalled: true } })]);
      // QoreID failed (503), then the guard's audit write failed: QoreID's failure counts.
      const failed = jest.fn(async (_nin: string, check: { onQoreIdSettled: (settlement: NinCheckSettlement) => void }) => {
        check.onQoreIdSettled({ answered: false, error: fromQoreId(503, 'QOREID_PROVIDER_UNAVAILABLE', 'sent', 503) });
        throw auditDown();
      });
      const { service: third, breaker: tripped } = desk(qoreIdProvider(gate({ verifyNinRecord: failed })));
      await expect(third.resolve(input, 'resolve-key-q109-000070', context)).rejects.toMatchObject({ status: 503 });
      expect(tripped.state()).toBe('open');
      // The request stopped before QoreID answered: its answer is counted when it comes.
      const settles: Array<(settlement: NinCheckSettlement) => void> = [];
      const pending = jest.fn(async (_nin: string, check: { onQoreIdSettled: (settlement: NinCheckSettlement) => void }) => {
        settles.push(check.onQoreIdSettled);
        throw auditDown();
      });
      const { service: fourth, breaker: later } = desk(qoreIdProvider(gate({ verifyNinRecord: pending })));
      await expect(fourth.resolve(input, 'resolve-key-q109-000071', context)).rejects.toMatchObject({ status: 503 });
      expect(later.state()).toBe('closed');
      settles[0]!({ answered: false, error: fromQoreId(503, 'QOREID_PROVIDER_UNAVAILABLE', 'sent', 503) });
      expect(later.state()).toBe('open');
    });

    it('answers a stored answer HID cannot use again without counting it, freeing the retry place', async () => {
      const breaker = retryingBreaker();
      const verifyNinRecord = jest.fn(async () => { throw storedUnusable(); });
      const { service, audit } = desk(qoreIdProvider(gate({ verifyNinRecord })), breaker);
      for (const key of ['resolve-key-q109-000056', 'resolve-key-q109-000057', 'resolve-key-q109-000058']) {
        await expect(service.resolve(input, key, context)).rejects.toMatchObject({ status: 502,
          code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
      }
      expect(breaker.state()).toBe('retrying');
      expect(breaker.available()).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      expect(auditRows(audit)).toEqual([0, 1, 2].map(() => expect.objectContaining({ action: 'identity.nin.verify',
        outcome: 'failure', details: expect.objectContaining({ code: 'QOREID_PROVIDER_RESPONSE_INVALID',
          providerCalled: true, ninCheck: 'provider_error', storedAnswer: true }) })));
    });

    it('answers a stored "no record" (QoreID\'s 404 included) 422 NIN_NOT_VERIFIED without counting it (Q117)', async () => {
      const breaker = retryingBreaker();
      const { service, audit } = desk(qoreIdProvider(gate({ verifyNinRecord: jest.fn(async () => noRecord('stored')) })),
        breaker);
      for (const key of ['resolve-key-q109-000076', 'resolve-key-q109-000077']) {
        await expect(service.resolve(input, key, context)).rejects.toMatchObject(NO_RECORD_ANSWER);
      }
      expect(breaker.state()).toBe('retrying');
      expect(breaker.available()).toBe(true);
      expect(auditRows(audit)).toEqual([0, 1].map(() => expect.objectContaining({ action: 'identity.nin.verify',
        outcome: 'denied', details: { provider: 'qoreid', ninCheck: 'no_match', storedAnswer: true } })));
    });

    it('frees the retry place for a stored answer but does not close the breaker with it', async () => {
      const breaker = retryingBreaker();
      const verifyNinRecord = jest.fn(async () => found({}, 'stored'));
      const { service, audit } = desk(qoreIdProvider(gate({ verifyNinRecord })), breaker);
      await expect(service.resolve(input, 'resolve-key-q109-000059', context)).resolves.toMatchObject({ caseId });
      expect(breaker.state()).toBe('retrying');
      expect(breaker.available()).toBe(true);
      // Q115: 0137's begin kept the stored record as it answered; the desk's row says only that it was stored.
      expect(auditRows(audit)[0]).toEqual(expect.objectContaining({ action: 'identity.nin.verify', outcome: 'success',
        details: { provider: 'qoreid', ninCheck: 'match', storedAnswer: true } }));
      // A check QoreID answers now does close it.
      verifyNinRecord.mockResolvedValueOnce(found());
      await expect(service.resolve(input, 'resolve-key-q109-000060', context)).resolves.toMatchObject({ caseId });
      expect(breaker.state()).toBe('closed');
    });
  });
});

describe('Q108 registration-capabilities with QoreID', () => {
  afterEach(() => jest.restoreAllMocks());

  /** The desk's capabilities; `sealed`: what the seal read answers for this desk (or the error it raises). */
  function capabilities(qoreId: ReturnType<typeof gate>, breaker = new NinProviderBreaker(),
    sealed: boolean | Error = false) {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ NIN_PROVIDER_MODE: 'unavailable' } as never);
    registrations.sealedTenant.mockImplementation(async () => {
      if (sealed instanceof Error) throw sealed;
      return sealed;
    });
    return new NinRegistrationController(registrations as never, breaker, undefined, qoreIdProvider(qoreId))
      .capabilities({ facilityId: context.facilityId, actor: context.actor } as HidRequest);
  }
  const registrations = { sealedTenant: jest.fn() };
  beforeEach(() => registrations.sealedTenant.mockReset());

  it('reports NIN checks on and available while QoreID\'s switch is on', async () => {
    const answer = await capabilities(gate());
    expect(answer).toEqual({
      nin: { enabled: true, state: 'live', available: true },
      // ID-2 (0130): registration without a NIN is on beside the NIN checks.
      withoutNin: { enabled: true, phoneRequiredUnlessChild: true,
        reasons: ['nin_service_unavailable', 'no_nin', 'not_carried', 'child', 'foreign_national'] },
      newPatientRegistrationRequiresNin: false,
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

  it('reports them off at a desk of the sealed demo or QA tenant (0098 G6, 0123 G6q), as resolve answers there', async () => {
    expect((await capabilities(gate(), undefined, true)).nin).toEqual({ enabled: false, state: 'unavailable',
      available: false });
    expect(registrations.sealedTenant).toHaveBeenCalledWith(context.facilityId, context.actor.accountId);
  });

  it('reports them on but not available when the seal cannot be read', async () => {
    expect((await capabilities(gate(), undefined, new Error('connection reset'))).nin).toEqual({ enabled: true,
      state: 'live', available: false });
  });
});

describe('Q108 desk NIN details refused before any check, over HTTP', () => {
  let app: INestApplication | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  /** POST identity/nin/resolve with the global pipe and problem filter main.ts uses. */
  async function post(body: Record<string, unknown>) {
    const provider = { name: 'qoreid', isEnabled: jest.fn(async () => true), verify: jest.fn() };
    const audit = { record: jest.fn(async () => undefined), recordWithClient: jest.fn(async () => undefined) };
    const database = { withTransaction: jest.fn(async (_c: unknown, work: (c: unknown) => unknown) =>
      work({ query: jest.fn(async () => ({ rows: [] })) })),
    // Not a sealed demo or QA desk.
    query: jest.fn(async () => ({ rows: [{ sealed: false }] })) };
    const module = await Test.createTestingModule({ controllers: [NinRegistrationController], providers: [
      NinRegistrationService, NinProviderBreaker,
      { provide: DatabaseService, useValue: database },
      { provide: AuditService, useValue: audit },
      { provide: NinIdentifierProtector, useValue: { lookup: jest.fn(() => 'a'.repeat(64)), protect: jest.fn() } },
      { provide: HidCodeGenerator, useValue: {} },
      { provide: NIN_VERIFICATION_PROVIDER, useValue: provider },
    ] }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    app.use((incoming: HidRequest, _response: Response, next: NextFunction) => {
      incoming.correlationId = 'correlation-q108-http';
      incoming.actor = context.actor;
      incoming.facilityId = context.facilityId;
      next();
    });
    await app.init();
    const response = await supertest(app.getHttpServer()).post('/api/v1/identity/nin/resolve')
      .set('idempotency-key', 'resolve-key-q108-http-01').send(body);
    return { response, provider, audit };
  }

  it.each([
    ['a date of birth in the future', { dateOfBirth: '2062-03-01' }],
    ['a date of birth before 1900', { dateOfBirth: '1899-12-31' }],
    ['a first name with a tab', { firstName: 'Ada\tBola' }],
    ['a last name with a line break', { lastName: 'Fic\ntional' }],
  ])('answers %s with 400 NIN_DETAILS_INVALID and the plain message, sending nothing', async (_label, overrides) => {
    const { response, provider, audit } = await post({ ...input, ...overrides });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'NIN_DETAILS_INVALID',
      detail: 'Check the name and the date of birth. The date of birth cannot be in the future or before 1900.' });
    expect(provider.verify).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.nin.verify',
      outcome: 'failure', details: expect.objectContaining({ code: 'NIN_DETAILS_INVALID', providerCalled: false }) }));
    expect(JSON.stringify(response.body)).not.toContain(NIN);
  });

  it.each([
    ['a date that is not a real date', { dateOfBirth: '1991-02-30' }, 'dateOfBirth'],
    ['a date in another format', { dateOfBirth: '05/04/1991' }, 'dateOfBirth'],
    ['a blank name', { firstName: '   ' }, 'firstName'],
    ['a name over 100 characters', { lastName: 'x'.repeat(101) }, 'lastName'],
  ])('still refuses %s as a malformed body (400 VALIDATION_FAILED)', async (_label, overrides, field) => {
    const { response, provider } = await post({ ...input, ...overrides });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED', errors: [expect.objectContaining({ field })] });
    expect(provider.verify).not.toHaveBeenCalled();
  });

  it('passes a real date of birth and plain names on to the check', async () => {
    const { provider } = await post({ ...input, dateOfBirth: '1900-01-01', firstName: '  Ada  Bola ' });
    expect(provider.verify).toHaveBeenCalledTimes(1);
  });
});
