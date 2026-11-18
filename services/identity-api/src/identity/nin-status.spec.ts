import { Logger } from '@nestjs/common';
import * as environment from '../config/environment';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { IdentityService } from './identity.service';
import type { AuthorizationDecision, IdentityPatient, IdentityProvider } from './identity.types';
import { NinRegistrationController } from './nin-registration.controller';
import { NinRegistrationService } from './nin-registration.service';
import {
  NIN_BREAKER_RETRY_AFTER_MS,
  NIN_BREAKER_WINDOW_MS,
  NIN_PROVIDER_UNAVAILABLE_EVENT,
  NinProviderBreaker,
} from './nin-provider-breaker';
import { ninStatusOf, patientHasVerifiedNinSql } from './nin-status';
import { PostgresIdentityProvider } from './postgres-identity.provider';

/**
 * ID-0 (Akos wave 1): "NIN Verified" / "NIN Not Verified" on staff answers,
 * and the NIN service breaker behind registration-capabilities.
 * Fictional people and identifiers only.
 */
const FORBIDDEN_WORD = /unverified/i;
const patientId = '6b1f0d2e-3c4a-4b5d-8e6f-7a8b9c0d1e2f';
const caseId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const context = {
  actor: { kind: 'staff', subject: 'synthetic:desk', accountId: 'f0e1d2c3-b4a5-4968-8776-655443322110',
    permissions: ['identity.patient.read', 'identity.registration.write'], facility: { organizationId: 'org' } },
  facilityId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', membershipId: 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f',
  correlationId: 'correlation-id0', purposeOfUse: 'direct-care',
} as unknown as DataAccessContext;

describe('ID-0 NIN status', () => {
  describe('the shared rule', () => {
    it('counts only a checked NIN that has not been revoked', () => {
      const sql = patientHasVerifiedNinSql('patient_row.id').replace(/\s+/g, ' ');
      expect(sql).toContain("nin_identifier.identifier_type = 'nin'");
      expect(sql).toContain('and nin_identifier.verified');
      expect(sql).toContain('nin_identifier.revoked_at is null');
      expect(sql).toContain('nin_identifier.patient_id = patient_row.id');
    });

    it('refuses anything but a column reference', () => {
      expect(() => patientHasVerifiedNinSql('id); drop table x; --')).toThrow();
      expect(() => patientHasVerifiedNinSql("'x'")).toThrow();
    });

    it.each([
      [true, 'verified'],
      [false, 'not_verified'],
      [undefined, 'not_verified'],
      [null, 'not_verified'],
      ['true', 'not_verified'],
      [1, 'not_verified'],
    ])('maps %p to %p', (value, expected) => {
      expect(ninStatusOf(value)).toBe(expected);
    });
  });

  describe('staff patient lookup (POST identity/patient-lookup)', () => {
    const allow: AuthorizationDecision = {
      allowed: true, patientId, facilityId: 'facility', membershipId: 'membership',
      scope: 'read_records', purpose: 'direct-care', consentGrantId: 'grant', breakGlass: false,
    };
    function lookupWith(patient: IdentityPatient) {
      const provider: IdentityProvider = {
        lookupExactHid: jest.fn(async () => patient),
        authorize: jest.fn(async () => allow),
        consentStatus: jest.fn(),
      };
      const audit = { record: jest.fn(async () => undefined) };
      return { service: new IdentityService(provider, audit as never), audit };
    }
    const base: IdentityPatient = {
      id: patientId, hidCode: 'HID-QX7K2M', firstName: 'Ada', lastName: 'Fictional', fullName: 'Ada Fictional',
      dateOfBirth: '1991-04-05', gender: 'female', rowVersion: 3,
    };

    it.each([
      ['a checked NIN', true, 'verified'],
      ['no checked NIN', false, 'not_verified'],
      ['a revoked NIN (the database answers false)', false, 'not_verified'],
      ['a provider that does not say', undefined, 'not_verified'],
    ] as const)('answers ninStatus for %s', async (_label, ninVerified, expected) => {
      const { service, audit } = lookupWith({ ...base, ...(ninVerified === undefined ? {} : { ninVerified }) });
      const answer = await service.lookupPatient('HID-QX7K2M', 'direct-care', context);
      expect(answer.patient.ninStatus).toBe(expected);
      expect(JSON.stringify(answer)).not.toMatch(FORBIDDEN_WORD);
      // Every patient lookup is still audited.
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
        action: 'identity.patient.lookup', outcome: 'success', patientId }));
    });

    it('reads the NIN status in the same lookup query', async () => {
      const query = jest.fn(async () => ({ rows: [{ id: patientId, hid_code: 'HID-QX7K2M', first_name: 'Ada',
        last_name: 'Fictional', full_name: 'Ada Fictional', dob: '1991-04-05', gender: 'female', row_version: '3',
        nin_verified: false }] }));
      const database = { withTransaction: jest.fn(async (_c: unknown, work: (c: unknown) => unknown) => work({ query })) };
      const provider = new PostgresIdentityProvider(database as never);
      await expect(provider.lookupExactHid('HID-QX7K2M', context)).resolves.toMatchObject({ id: patientId, ninVerified: false });
      const [sql] = query.mock.calls[0] as unknown as [string];
      expect(sql.replace(/\s+/g, ' ')).toContain('nin_identifier.revoked_at is null');
      expect(sql).toMatch(/as nin_verified/);
      expect(sql).toMatch(/patient_row\.status = 'active'/);
    });
  });

  describe('registration case answer', () => {
    function caseService(row: Record<string, unknown>) {
      const statements: string[] = [];
      const query = jest.fn(async (sql: string) => {
        statements.push(sql.replace(/\s+/g, ' '));
        if (/from identity\.registration_case_candidates candidate join/.test(sql)) return { rows: [] };
        return { rows: [row] };
      });
      const database = { withTransaction: jest.fn(async (_c: unknown, work: (c: unknown) => unknown) => work({ query })) };
      const audit = { recordWithClient: jest.fn(async () => undefined), record: jest.fn(async () => undefined) };
      return { service: new NinRegistrationService(database as never, audit as never, {} as never, {} as never, {} as never),
        statements };
    }
    const row = { id: caseId, status: 'approved_new_identity', row_version: '2', resolved_patient_id: patientId,
      resolved_hid_code: 'HID-QX7K2M', candidate_count: '0', contact_recorded: false };

    it.each([
      ['a checked NIN', true, 'verified'],
      ['a revoked NIN on the patient', false, 'not_verified'],
    ] as const)('answers ninStatus for %s', async (_label, ninVerified, expected) => {
      const { service, statements } = caseService({ ...row, nin_verified: ninVerified });
      const answer = await service.getCase(caseId, context);
      expect(answer.ninStatus).toBe(expected);
      expect(JSON.stringify(answer)).not.toMatch(FORBIDDEN_WORD);
      const read = statements.find((sql) => sql.includes('as nin_verified'));
      expect(read).toContain('when registration.verified_at is null then false');
      expect(read).toContain('when registration.resolved_patient_id is null then true');
      expect(read).toContain('nin_identifier.revoked_at is null');
    });
  });
});

describe('ID-0 NIN service breaker', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  const outage = () => new DomainProblem(503, 'NIN_PROVIDER_UNAVAILABLE', 'The NIN service is down');
  const badAnswer = () => new DomainProblem(502, 'NIN_PROVIDER_RESPONSE_INVALID', 'The NIN service gave a bad answer');

  it('starts closed and available', () => {
    const breaker = new NinProviderBreaker();
    expect(breaker.state(0)).toBe('closed');
    expect(breaker.available(0)).toBe(true);
  });

  it('trips at once on a 503 and refuses checks with a plain message', () => {
    const breaker = new NinProviderBreaker();
    breaker.recordFailure(outage(), {}, 1_000);
    expect(breaker.available(1_000)).toBe(false);
    expect(() => breaker.assertAvailable(1_500)).toThrow(expect.objectContaining({
      code: 'NIN_PROVIDER_UNAVAILABLE', message: 'The NIN service is not answering right now. Please try again in a minute.' }));
  });

  it('trips on the third other failure within 5 minutes', () => {
    const breaker = new NinProviderBreaker();
    breaker.recordFailure(badAnswer(), {}, 0);
    breaker.recordFailure(new Error('socket hang up'), {}, 60_000);
    expect(breaker.available(60_000)).toBe(true);
    breaker.recordFailure(badAnswer(), {}, 120_000);
    expect(breaker.available(120_000)).toBe(false);
  });

  it('forgets failures older than 5 minutes', () => {
    const breaker = new NinProviderBreaker();
    breaker.recordFailure(badAnswer(), {}, 0);
    breaker.recordFailure(badAnswer(), {}, 1_000);
    breaker.recordFailure(badAnswer(), {}, NIN_BREAKER_WINDOW_MS + 2_000);
    expect(breaker.available(NIN_BREAKER_WINDOW_MS + 2_000)).toBe(true);
  });

  it('lets a check through after 60 seconds and closes when it succeeds (recovered)', () => {
    const breaker = new NinProviderBreaker();
    breaker.recordFailure(outage(), {}, 0);
    expect(breaker.available(NIN_BREAKER_RETRY_AFTER_MS - 1)).toBe(false);
    expect(breaker.state(NIN_BREAKER_RETRY_AFTER_MS)).toBe('retrying');
    expect(breaker.available(NIN_BREAKER_RETRY_AFTER_MS)).toBe(true);
    breaker.recordSuccess();
    expect(breaker.state(NIN_BREAKER_RETRY_AFTER_MS + 1)).toBe('closed');
    // The count was cleared: two failures do not trip it again.
    breaker.recordFailure(badAnswer(), {}, NIN_BREAKER_RETRY_AFTER_MS + 2);
    breaker.recordFailure(badAnswer(), {}, NIN_BREAKER_RETRY_AFTER_MS + 3);
    expect(breaker.available(NIN_BREAKER_RETRY_AFTER_MS + 3)).toBe(true);
  });

  it('trips again when the retry fails', () => {
    const breaker = new NinProviderBreaker();
    breaker.recordFailure(outage(), {}, 0);
    breaker.recordFailure(badAnswer(), {}, NIN_BREAKER_RETRY_AFTER_MS + 5);
    expect(breaker.state(NIN_BREAKER_RETRY_AFTER_MS + 6)).toBe('open');
  });

  it('does not count or log a refusal that is not an outage', () => {
    const breaker = new NinProviderBreaker();
    for (let at = 0; at < 5; at += 1) {
      expect(breaker.recordFailure(new DomainProblem(400, 'BAD_REQUEST', 'Bad request'), {}, at)).toBe(false);
    }
    expect(breaker.available(5)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs identity.nin_provider.unavailable for each failure, with no personal details', () => {
    const breaker = new NinProviderBreaker();
    breaker.recordFailure(badAnswer(), { correlationId: 'correlation-id0', provider: 'deterministic-test' }, 0);
    breaker.recordFailure(outage(), { correlationId: 'correlation-id1', provider: 'deterministic-test' }, 1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(expect.objectContaining({
      event: NIN_PROVIDER_UNAVAILABLE_EVENT, code: 'NIN_PROVIDER_UNAVAILABLE', status: 503,
      failuresInLastFiveMinutes: 2, breaker: 'open', provider: 'deterministic-test' }));
    expect(NIN_PROVIDER_UNAVAILABLE_EVENT).toBe('identity.nin_provider.unavailable');
  });

  describe('in NIN resolve', () => {
    const input = { nin: '12345678901', firstName: 'Ada', lastName: 'Fictional', dateOfBirth: '1991-04-05',
      purpose: 'healthcare-operations' as const };
    function resolver(verify: jest.Mock) {
      const query = jest.fn(async () => ({ rows: [] }));
      const database = { withTransaction: jest.fn(async (_c: unknown, work: (c: unknown) => unknown) => work({ query })) };
      const audit = { recordWithClient: jest.fn(async () => undefined), record: jest.fn(async () => undefined) };
      const protector = { lookup: jest.fn(() => 'a'.repeat(64)) };
      const breaker = new NinProviderBreaker();
      const service = new NinRegistrationService(database as never, audit as never, protector as never, {} as never,
        { name: 'deterministic-test', verify } as never, breaker);
      return { service, audit, breaker };
    }

    it('stops sending checks once the service answers 503, and audits each refusal', async () => {
      const verify = jest.fn(async () => { throw new DomainProblem(503, 'NIN_PROVIDER_UNAVAILABLE', 'NIN verification is not configured'); });
      const { service, audit, breaker } = resolver(verify);
      await expect(service.resolve(input, 'resolve-key-00000000001', context)).rejects.toMatchObject({ status: 503 });
      expect(breaker.available()).toBe(false);
      const refused = service.resolve(input, 'resolve-key-00000000002', context);
      await expect(refused).rejects.toMatchObject({ code: 'NIN_PROVIDER_UNAVAILABLE' });
      await refused.catch((error: Error) => expect(error.message).not.toMatch(FORBIDDEN_WORD));
      expect(verify).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledTimes(2);
      expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({
        action: 'identity.nin.verify', outcome: 'failure' }));
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain('12345678901');
    });

    it('does not count a NIN that does not match as a failure', async () => {
      const verify = jest.fn(async () => ({ verified: false, provider: 'deterministic-test', reference: 'test-ref',
        verifiedAt: new Date().toISOString(), demographics: { firstName: 'Ada', lastName: 'Fictional', dateOfBirth: '1991-04-05' } }));
      const { service, breaker } = resolver(verify);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(service.resolve(input, `resolve-key-0000000000${attempt}`, context))
          .rejects.toMatchObject({ code: 'NIN_VERIFICATION_FAILED' });
      }
      expect(breaker.state()).toBe('closed');
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('registration-capabilities', () => {
    function capabilities(mode: 'test' | 'deferred' | 'unavailable', breaker: NinProviderBreaker) {
      jest.spyOn(environment, 'getEnvironment').mockReturnValue({ NIN_PROVIDER_MODE: mode } as never);
      return new NinRegistrationController({} as never, breaker).capabilities();
    }

    it('reports the NIN service available, and registration without a NIN off', () => {
      expect(capabilities('test', new NinProviderBreaker())).toEqual({
        nin: { enabled: true, state: 'test-only', available: true },
        withoutNin: { enabled: false },
        newPatientRegistrationRequiresNin: true,
      });
    });

    it('reports it unavailable while the breaker is tripped, and again once it can retry', () => {
      const breaker = new NinProviderBreaker();
      const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
      breaker.recordFailure(new DomainProblem(503, 'NIN_PROVIDER_UNAVAILABLE', 'down'));
      expect(capabilities('test', breaker).nin.available).toBe(false);
      now.mockReturnValue(10_000 + NIN_BREAKER_RETRY_AFTER_MS);
      expect(capabilities('test', breaker).nin.available).toBe(true);
    });

    it.each(['deferred', 'unavailable'] as const)('reports %s NIN checks as not available', (mode) => {
      const answer = capabilities(mode, new NinProviderBreaker());
      expect(answer.nin).toEqual({ enabled: false, state: mode, available: false });
      expect(JSON.stringify(answer)).not.toMatch(FORBIDDEN_WORD);
    });
  });
});
