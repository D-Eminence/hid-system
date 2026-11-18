import { type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
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
import { NinRegistrationService } from './nin-registration.service';
import {
  DeferredNinVerificationProvider,
  DeterministicTestNinVerificationProvider,
  isNinCheckNotStarted,
  isNinCheckRefusedUnsent,
  isNinNotConfigured,
  NIN_NOT_CONFIGURED_DETAIL,
  UnavailableNinVerificationProvider,
} from './nin-verification.provider';
import { NIN_BREAKER_RETRY_AFTER_MS, NIN_PROVIDER_UNAVAILABLE_EVENT, NinProviderBreaker } from './nin-provider-breaker';
import { ninCheckHeld, ninCheckInProgress, ninCheckStillRunning, ninCheckUnavailable } from './nin-check-once';
import { NIN_VERIFICATION_PROVIDER, type NinVerificationProvider, type NinVerificationRequest } from './nin.types';
import type { PublicPatientIdentityProvider, VerifiedPublicPatientIdentity } from './patient-enrollment.provider';
import {
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
    expect(qoreId.verifyNin).toHaveBeenCalledTimes(1);
    expect(qoreId.verifyNin).toHaveBeenCalledWith(NIN, { correlationId: 'correlation-q108', path: 'desk' });
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

  describe('the answers of 0137\'s once-per-NIN guard', () => {
    const held = new Date(Date.now() + 5 * 60 * 1000);
    it.each([
      ['this NIN is being checked', () => ninCheckInProgress(), 409, 'NIN_CHECK_IN_PROGRESS', 60],
      ['this NIN is held after a check QoreID may have charged', () => ninCheckHeld(held), 409, 'NIN_CHECK_HELD', 300],
      ['the check is still running after the wait', () => ninCheckStillRunning(), 504, 'QOREID_TIMEOUT', 60],
    ] as const)('passes "%s" on with retryAfterSeconds', async (_label, refusal, status, code, retryAfterSeconds) => {
      const qoreId = gate({ verifyNin: jest.fn(async () => { throw refusal(); }) });
      const answer = await qoreIdProvider(qoreId).verify(request).catch((error: unknown) => error) as DomainProblem;
      expect(answer).toMatchObject({ status, code });
      expect(answer.extensions?.retryAfterSeconds).toBeGreaterThanOrEqual(retryAfterSeconds - 1);
      expect(answer.extensions?.retryAfterSeconds).toBeLessThanOrEqual(retryAfterSeconds);
      expect(isNinCheckRefusedUnsent(answer)).toBe(code !== 'QOREID_TIMEOUT');
    });

    it('answers "cannot be started" when the guard\'s store cannot be read', async () => {
      const qoreId = gate({ verifyNin: jest.fn(async () => { throw ninCheckUnavailable(); }) });
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
    const qoreId = gate({ verifyNin: jest.fn(async () => record(overrides)) });
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
    const { service, audit, breaker } = desk(qoreIdProvider(qoreId));
    for (const key of ['resolve-key-q108-000005', 'resolve-key-q108-000006', 'resolve-key-q108-000007',
      'resolve-key-q108-000008']) {
      await expect(service.resolve(input, key, context)).rejects.toMatchObject({
        status: 503, code: 'NIN_PROVIDER_UNAVAILABLE', message: NIN_NOT_CONFIGURED_DETAIL });
    }
    expect(qoreId.verifyNin).not.toHaveBeenCalled();
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
    const { service, audit } = desk(qoreIdProvider(qoreId));
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

  it('hands every resend to 0137\'s guard, which decides whether QoreID is asked: no claim or stored answer of its own', async () => {
    const verifyNin = jest.fn(async () => { throw new DomainProblem(422, 'NIN_NOT_VERIFIED', 'x'); });
    const { service, audit, breaker } = desk(qoreIdProvider(gate({ verifyNin })));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(service.resolve(input, 'resolve-key-q109-000041', context)).rejects.toMatchObject({
        status: 422, code: 'NIN_VERIFICATION_FAILED', message: 'The NIN could not be verified' });
    }
    // The guard answers the second from the answer it stored (qoreid-nin-desk-once.spec.ts).
    expect(verifyNin).toHaveBeenCalledTimes(2);
    expect(verifyNin).toHaveBeenNthCalledWith(2, NIN, { correlationId: 'correlation-q108', path: 'desk' });
    expect(breaker.state()).toBe('closed');
    expect(auditRows(audit)).toEqual([0, 1].map(() => expect.objectContaining({ action: 'identity.nin.verify',
      outcome: 'denied', details: { provider: 'qoreid', ninCheck: 'no_match' } })));
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
  ])('refuses %s before anything is sent or charged', async (_label, overrides) => {
    const qoreId = gate();
    const { service, audit, breaker } = desk(qoreIdProvider(qoreId));
    for (const key of ['resolve-key-q108-000043', 'resolve-key-q108-000044', 'resolve-key-q108-000045']) {
      await expect(service.resolve({ ...input, ...overrides }, key, context)).rejects.toMatchObject({
        status: 400, code: 'NIN_DETAILS_INVALID',
        message: 'Check the name and the date of birth. The date of birth cannot be in the future or before 1900.' });
    }
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
      const verifyNin = jest.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce(record());
      const breaker = retryingBreaker();
      const { service, audit } = desk(qoreIdProvider(gate({ verifyNin })), breaker);
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
      const qoreId = gate({ verifyNin: jest.fn(async () => { throw ninCheckUnavailable(); }) });
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

    it('passes on 504 QOREID_TIMEOUT with retryAfterSeconds as a sent check that counts toward the breaker', async () => {
      const qoreId = gate({ verifyNin: jest.fn(async () => { throw ninCheckStillRunning(); }) });
      const { service, audit, breaker } = desk(qoreIdProvider(qoreId));
      const answer = await service.resolve(input, 'resolve-key-q109-000052', context).catch((error: unknown) => error);
      expect(answer).toMatchObject({ status: 504, code: 'QOREID_TIMEOUT', extensions: { retryAfterSeconds: 60 } });
      // One slow answer does not trip it; three within five minutes do (as before).
      expect(breaker.state()).toBe('closed');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(auditRows(audit)).toEqual([expect.objectContaining({ action: 'identity.nin.verify', outcome: 'failure',
        details: { provider: 'qoreid', errorType: 'DomainProblem', code: 'QOREID_TIMEOUT', providerCalled: true,
          ninCheck: 'provider_error' } })]);
    });
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

describe('Q108 desk NIN details refused before any check, over HTTP', () => {
  let app: INestApplication | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  /** POST identity/nin/resolve with the global pipe and problem filter main.ts uses. */
  async function post(body: Record<string, unknown>) {
    const provider = { name: 'qoreid', isEnabled: jest.fn(async () => true), verify: jest.fn() };
    const audit = { record: jest.fn(async () => undefined), recordWithClient: jest.fn(async () => undefined) };
    const database = { withTransaction: jest.fn(async (_c: unknown, work: (c: unknown) => unknown) =>
      work({ query: jest.fn(async () => ({ rows: [] })) })) };
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
