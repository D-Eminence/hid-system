import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { NinProviderBreaker } from './nin-provider-breaker';
import { NinRegistrationService } from './nin-registration.service';
import type { NinVerificationProvider, NinVerificationResult } from './nin.types';

/**
 * ID-6 (0138): NinRegistrationService.checkNinForLink, the desk's check of a
 * NIN for a patient already registered here. Every gate resolve's check has
 * (deferred, switched off, the seals, Q110's record), then the NIN service
 * behind the breaker; a match, a mismatch or a refusal, never the NIN.
 */
const NIN = '12345678901';
const HMAC = 'a'.repeat(64);
const HOLDER = '77777777-7777-4777-8777-777777777777';
const claimed = { firstName: 'Ngozi', lastName: 'Linkone', dateOfBirth: '1990-03-04' };
const context = {
  correlationId: 'nin-link-check-0001',
  facilityId: '33333333-3333-4333-8333-333333333333',
  membershipId: '44444444-4444-4444-8444-444444444444',
  purposeOfUse: 'healthcare-operations',
  actor: { subject: 'synthetic:desk', accountId: '55555555-5555-4555-8555-555555555555',
    facility: { organizationId: '66666666-6666-4666-8666-666666666666' } },
} as unknown as DataAccessContext;

function result(overrides: Partial<NinVerificationResult> = {}): NinVerificationResult {
  return { verified: true, outcome: 'match', provider: 'qoreid', reference: 'QOREID-TXN-0001',
    verifiedAt: new Date().toISOString(), demographics: claimed, ...overrides };
}

function harness(provider: Partial<NinVerificationProvider> & { name: string },
  options: { holder?: Record<string, unknown>; sealed?: boolean } = {}) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('from identity.patient_identifiers identifier')) return { rows: options.holder ? [options.holder] : [] };
    return { rows: [] };
  });
  const database = {
    withTransaction: jest.fn(async (_c: unknown, work: (c: unknown) => unknown) => work({ query })),
    withSystemTransaction: jest.fn(async (_c: unknown, work: (c: unknown) => unknown) => work({ query })),
    query: jest.fn(async () => ({ rows: [{ sealed: options.sealed ?? false }] })),
  };
  const audit = { record: jest.fn(async () => undefined), recordWithClient: jest.fn(async () => undefined) };
  const breaker = new NinProviderBreaker();
  const service = new NinRegistrationService(database as never, audit as never, {} as never, {} as never,
    provider as NinVerificationProvider, breaker);
  return { service, audit, breaker };
}

describe('checkNinForLink (ID-6)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('answers a match from the NIN service, with its reference', async () => {
    const verify = jest.fn(async () => result());
    const { service } = harness({ name: 'qoreid', isEnabled: async () => true, verify });
    await expect(service.checkNinForLink(NIN, HMAC, claimed, context)).resolves.toEqual({
      verified: true, outcome: 'match', providerCalled: true, stored: false, healthIdRecord: false,
      reference: 'QOREID-TXN-0001' });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ nin: NIN, claimedDemographics: claimed }));
  });

  it('says a stored answer called no one', async () => {
    const { service } = harness({ name: 'qoreid', isEnabled: async () => true, verify: async () => result({ stored: true }) });
    await expect(service.checkNinForLink(NIN, HMAC, claimed, context)).resolves.toMatchObject({
      verified: true, providerCalled: false, stored: true });
  });

  it.each(['name_mismatch', 'no_match'] as const)('answers %s as not verified, and does not throw', async (outcome) => {
    const { service } = harness({ name: 'qoreid', isEnabled: async () => true,
      verify: async () => result({ verified: false, outcome }) });
    await expect(service.checkNinForLink(NIN, HMAC, claimed, context)).resolves.toMatchObject({
      verified: false, outcome, providerCalled: true });
  });

  it('answers a NIN a Health ID holds from that record, never sending it (Q110)', async () => {
    const verify = jest.fn();
    const holder = { patient_id: HOLDER, verification_provider: 'qoreid', verification_reference: 'QOREID-TXN-0009',
      verified_at: new Date().toISOString(), first_name: 'Ngozi', last_name: 'Linkone', dob: '1990-03-04', gender: null };
    const matched = harness({ name: 'qoreid', isEnabled: async () => true, verify }, { holder });
    await expect(matched.service.checkNinForLink(NIN, HMAC, claimed, context)).resolves.toEqual({
      verified: true, outcome: 'match', providerCalled: false, stored: false, healthIdRecord: true,
      holderPatientId: HOLDER });
    const other = harness({ name: 'qoreid', isEnabled: async () => true, verify }, { holder: { ...holder, first_name: 'Someone' } });
    await expect(other.service.checkNinForLink(NIN, HMAC, claimed, context)).resolves.toMatchObject({
      verified: false, outcome: 'name_mismatch', providerCalled: false, healthIdRecord: true });
    expect(verify).not.toHaveBeenCalled();
  });

  it('sends nothing for details no one can have', async () => {
    const verify = jest.fn();
    const { service } = harness({ name: 'qoreid', isEnabled: async () => true, verify });
    await expect(service.checkNinForLink(NIN, HMAC, { ...claimed, dateOfBirth: '2999-01-01' }, context))
      .resolves.toMatchObject({ verified: false, providerCalled: false });
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([
    ['deferred', { name: 'deferred' }, 'NIN_PROVIDER_DEFERRED'],
    ['switched off by mode', { name: 'unavailable' }, 'NIN_PROVIDER_UNAVAILABLE'],
    ['QoreID\'s switch off', { name: 'qoreid', isEnabled: async () => false }, 'NIN_PROVIDER_UNAVAILABLE'],
  ])('refuses when NIN checks are %s, sending nothing', async (_label, provider, code) => {
    const verify = jest.fn();
    const { service, breaker } = harness({ ...provider, verify } as never);
    await expect(service.checkNinForLink(NIN, HMAC, claimed, context)).rejects.toMatchObject({ status: 503, code });
    expect(verify).not.toHaveBeenCalled();
    expect(breaker.state()).toBe('closed');
  });

  it('sends nothing from a desk of a sealed tenant', async () => {
    const verify = jest.fn();
    const { service } = harness({ name: 'qoreid', isEnabled: async () => true, verify }, { sealed: true });
    await expect(service.checkNinForLink(NIN, HMAC, claimed, context)).rejects.toMatchObject({
      status: 503, code: 'NIN_PROVIDER_UNAVAILABLE' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('counts the NIN service failing against the breaker, as resolve does', async () => {
    const failure = new DomainProblem(503, 'QOREID_PROVIDER_UNAVAILABLE', 'down');
    const verify = jest.fn(async () => { throw failure; });
    const { service, breaker, audit } = harness({ name: 'qoreid', isEnabled: async () => true, verify });
    let failures = 0;
    while (breaker.state() === 'closed' && failures < 10) {
      await expect(service.checkNinForLink(NIN, HMAC, claimed, context)).rejects.toBe(failure);
      failures += 1;
    }
    expect(breaker.state()).not.toBe('closed');
    // Once open, nothing is sent: ID-0's refusal.
    await expect(service.checkNinForLink(NIN, HMAC, claimed, context)).rejects.toMatchObject({
      status: 503, code: 'NIN_PROVIDER_UNAVAILABLE' });
    expect(verify).toHaveBeenCalledTimes(failures);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(NIN);
  });
});
