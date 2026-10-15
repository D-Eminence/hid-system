import { Logger, type ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { QoreIdPublicPatientIdentityProvider } from './patient-enrollment.provider';
import type { QoreIdVerificationAdapter } from './qoreid-verification.adapter';

const originalEnvironment = { ...process.env };
const nin = '12345678901';
/** What a patient reads while registration is closed (FE-4); Health-id shows the detail as sent. */
const NOT_OPEN = 'New Health ID registration is not open yet. If you already have a Health ID, sign in.';

/** The problem body Identity sends for an error, through its own filter. */
function answered(error: unknown): { status: number; code: string; detail: string } {
  const response = { status: jest.fn().mockReturnThis(), type: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis() };
  const host = { switchToHttp: () => ({
    getRequest: () => ({ correlationId: 'provider-test-correlation', method: 'POST',
      route: { path: '/identity/patient-enrollments' } } as unknown as HidRequest),
    getResponse: () => response as unknown as Response,
  }) } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(error, host);
  return response.json.mock.calls[0]?.[0];
}
const charge = { correlationId: 'provider-test-correlation', networkDigest: 'e'.repeat(64) };
const binding = { nin, firstName: 'Amina', lastName: 'Okafor', dateOfBirth: '1990-01-02',
  gender: 'female' as const, phoneNumber: '08012345678', address: 'Lagos', photo: 'ZmFrZQ==' };

describe('QoreID public patient identity provider', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456', QOREID_ENABLED: 'false',
      QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'false', NIN_HOLDER_SMS_ENABLED: 'true',
    });
    resetEnvironmentForTests();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  function provider(result: object) {
    const adapter = { verifyNinEnrollment: jest.fn().mockResolvedValue(result) };
    const integrations = { assertAvailable: jest.fn().mockResolvedValue(undefined),
      consumePublicPatientNinQuota: jest.fn().mockResolvedValue(undefined) };
    const service = new QoreIdPublicPatientIdentityProvider(
      adapter as unknown as QoreIdVerificationAdapter,
      integrations as unknown as IntegrationRuntimeService);
    return { adapter, integrations, service };
  }

  function enable(ninOnly = true) {
    Object.assign(process.env, { QOREID_ENABLED: 'true', QOREID_NIN_ONLY_ENROLLMENT_ENABLED: String(ninOnly),
      QOREID_CLIENT_ID: 'test-client', QOREID_CLIENT_SECRET: 'test-secret' });
    resetEnvironmentForTests();
  }

  it('does not contact the integration when QoreID is disabled', async () => {
    const f = provider({ state: 'verified', providerReference: 'transaction-1', ninEnrollmentBinding: binding });
    await expect(f.service.verifyNin(nin, charge)).rejects.toMatchObject({ code: 'QOREID_DISABLED' });
    expect(f.integrations.assertAvailable).not.toHaveBeenCalled();
    expect(f.adapter.verifyNinEnrollment).not.toHaveBeenCalled();
  });

  it('blocks NIN-only enrollment before runtime lookup when its separate gate is disabled', async () => {
    process.env.QOREID_ENABLED = 'true';
    process.env.QOREID_CLIENT_ID = 'test-client';
    process.env.QOREID_CLIENT_SECRET = 'test-secret';
    resetEnvironmentForTests();
    const f = provider({ state: 'verified', providerReference: '1', ninEnrollmentBinding: binding });
    await expect(f.service.verifyNin(nin, charge)).rejects.toMatchObject({ code: 'QOREID_NIN_ONLY_DISABLED' });
    expect(f.integrations.assertAvailable).not.toHaveBeenCalled();
    expect(f.adapter.verifyNinEnrollment).not.toHaveBeenCalled();
  });

  it('requires enabled runtime authority and an exact verified NIN binding', async () => {
    process.env.QOREID_ENABLED = 'true';
    process.env.QOREID_NIN_ONLY_ENROLLMENT_ENABLED = 'true';
    process.env.QOREID_CLIENT_ID = 'test-client';
    process.env.QOREID_CLIENT_SECRET = 'test-secret';
    resetEnvironmentForTests();
    const f = provider({ state: 'verified', providerReference: 'transaction-1', ninEnrollmentBinding: binding });
    await expect(f.service.verifyNin(nin, charge)).resolves.toEqual({ ...binding, providerReference: 'transaction-1' });
    expect(f.integrations.assertAvailable).toHaveBeenCalledWith('qoreid', 'patient_nin');
    expect(f.adapter.verifyNinEnrollment).toHaveBeenCalledWith(nin);
    f.adapter.verifyNinEnrollment.mockResolvedValue({ state: 'verified', providerReference: 'transaction-2',
      ninEnrollmentBinding: { ...binding, nin: '99999999999' } });
    await expect(f.service.verifyNin(nin, charge)).rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
  });

  it('rejects an incomplete or denied provider result', async () => {
    process.env.QOREID_ENABLED = 'true';
    process.env.QOREID_NIN_ONLY_ENROLLMENT_ENABLED = 'true';
    process.env.QOREID_CLIENT_ID = 'test-client';
    process.env.QOREID_CLIENT_SECRET = 'test-secret';
    resetEnvironmentForTests();
    const f = provider({ state: 'not_verified' });
    await expect(f.service.verifyNin(nin, charge)).rejects.toMatchObject({ code: 'NIN_NOT_VERIFIED' });
    f.adapter.verifyNinEnrollment.mockResolvedValue({ state: 'verified', ninEnrollmentBinding: binding });
    await expect(f.service.verifyNin(nin, charge)).rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
  });

  it('blocks new verification while QoreID is paused before invoking the adapter', async () => {
    process.env.QOREID_ENABLED = 'true';
    process.env.QOREID_NIN_ONLY_ENROLLMENT_ENABLED = 'true';
    process.env.QOREID_CLIENT_ID = 'test-client';
    process.env.QOREID_CLIENT_SECRET = 'test-secret';
    resetEnvironmentForTests();
    const f = provider({ state: 'verified', providerReference: '1', ninEnrollmentBinding: binding });
    f.integrations.assertAvailable.mockRejectedValue(new DomainProblem(503, 'INTEGRATION_PAUSED',
      'External verification is temporarily unavailable'));
    await expect(f.service.verifyNin(nin, charge)).rejects.toMatchObject({ code: 'INTEGRATION_PAUSED' });
    expect(f.adapter.verifyNinEnrollment).not.toHaveBeenCalled();
  });
  describe('the enrollment gate (ENR-4)', () => {
    it('is closed while QoreID is disabled, without a runtime lookup', async () => {
      const f = provider({});
      await expect(f.service.assertAvailable()).rejects.toMatchObject({ status: 503, code: 'QOREID_DISABLED' });
      expect(f.integrations.assertAvailable).not.toHaveBeenCalled();
    });

    it('is closed while NIN-only enrollment is disabled, without a runtime lookup', async () => {
      enable(false);
      const f = provider({});
      await expect(f.service.assertAvailable()).rejects.toMatchObject({ status: 503, code: 'QOREID_NIN_ONLY_DISABLED' });
      expect(f.integrations.assertAvailable).not.toHaveBeenCalled();
    });

    it('is closed while QoreID is paused at runtime, and open only with both flags and the runtime enabled', async () => {
      enable();
      const f = provider({});
      f.integrations.assertAvailable.mockRejectedValueOnce(new DomainProblem(503, 'INTEGRATION_PAUSED',
        'External verification is temporarily unavailable'));
      await expect(f.service.assertAvailable()).rejects.toMatchObject({ status: 503, code: 'INTEGRATION_PAUSED' });
      await expect(f.service.assertAvailable()).resolves.toBeUndefined();
      expect(f.integrations.assertAvailable).toHaveBeenCalledWith('qoreid', 'patient_nin');
      // The gate alone asks QoreID nothing and charges nothing.
      expect(f.adapter.verifyNinEnrollment).not.toHaveBeenCalled();
      expect(f.integrations.consumePublicPatientNinQuota).not.toHaveBeenCalled();
    });
  });

  describe('the lookup quota (IP-1)', () => {
    it('charges the lookup to the client network after the gate and before QoreID is called', async () => {
      enable();
      const f = provider({ state: 'verified', providerReference: 'transaction-1', ninEnrollmentBinding: binding });
      await expect(f.service.verifyNin(nin, charge)).resolves.toEqual({ ...binding, providerReference: 'transaction-1' });
      expect(f.integrations.consumePublicPatientNinQuota).toHaveBeenCalledTimes(1);
      expect(f.integrations.consumePublicPatientNinQuota).toHaveBeenCalledWith(charge.correlationId, charge.networkDigest);
      const [gate] = f.integrations.assertAvailable.mock.invocationCallOrder;
      const [quota] = f.integrations.consumePublicPatientNinQuota.mock.invocationCallOrder;
      const [lookup] = f.adapter.verifyNinEnrollment.mock.invocationCallOrder;
      expect(gate).toBeLessThan(quota!);
      expect(quota).toBeLessThan(lookup!);
    });

    it('does not call QoreID when the quota refuses the lookup', async () => {
      enable();
      const f = provider({ state: 'verified', providerReference: 'transaction-1', ninEnrollmentBinding: binding });
      f.integrations.consumePublicPatientNinQuota.mockRejectedValue(new DomainProblem(429,
        'VERIFICATION_QUOTA_EXCEEDED', 'Verification request limit reached; try again later'));
      await expect(f.service.verifyNin(nin, charge)).rejects.toMatchObject({ status: 429,
        code: 'VERIFICATION_QUOTA_EXCEEDED' });
      expect(f.adapter.verifyNinEnrollment).not.toHaveBeenCalled();
    });

    it('charges nothing while the gate is closed', async () => {
      enable(false);
      const f = provider({ state: 'verified', providerReference: 'transaction-1', ninEnrollmentBinding: binding });
      await expect(f.service.verifyNin(nin, charge)).rejects.toMatchObject({ code: 'QOREID_NIN_ONLY_DISABLED' });
      expect(f.integrations.consumePublicPatientNinQuota).not.toHaveBeenCalled();
    });
  });
  describe('registration that is not open says so (FE-4)', () => {
    beforeEach(() => { jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined); });
    afterEach(() => { jest.restoreAllMocks(); });

    it('answers 503 QOREID_DISABLED with the registration-not-open copy while QoreID is disabled', async () => {
      const f = provider({});
      for (const refusal of [() => f.service.assertAvailable(), () => f.service.verifyNin(nin, charge)]) {
        const error = await refusal().then(() => undefined, (failure: unknown) => failure);
        expect(answered(error)).toMatchObject({ status: 503, code: 'QOREID_DISABLED', detail: NOT_OPEN });
      }
    });

    it('answers 503 QOREID_NIN_ONLY_DISABLED with the same copy while NIN-only enrollment is off (production)', async () => {
      enable(false);
      const f = provider({});
      for (const refusal of [() => f.service.assertAvailable(), () => f.service.verifyNin(nin, charge)]) {
        const error = await refusal().then(() => undefined, (failure: unknown) => failure);
        expect(answered(error)).toMatchObject({ status: 503, code: 'QOREID_NIN_ONLY_DISABLED', detail: NOT_OPEN });
      }
    });

    it('keeps the generic 5xx detail for a runtime pause and for any other service fault', async () => {
      enable();
      const f = provider({});
      f.integrations.assertAvailable.mockRejectedValueOnce(new DomainProblem(503, 'INTEGRATION_PAUSED',
        'External verification is temporarily unavailable'));
      const paused = await f.service.assertAvailable().then(() => undefined, (failure: unknown) => failure);
      expect(answered(paused)).toMatchObject({ status: 503, code: 'INTEGRATION_PAUSED',
        detail: 'The service could not complete the request.' });
      expect(answered(new DomainProblem(503, 'SOME_DEPENDENCY', 'internal dependency detail')))
        .toMatchObject({ status: 503, detail: 'The service could not complete the request.' });
    });

    it('reports availability from the same gate, asking QoreID nothing and charging nothing', async () => {
      const closed = provider({});
      await expect(closed.service.isAvailable()).resolves.toBe(false);
      expect(closed.integrations.assertAvailable).not.toHaveBeenCalled();
      enable(false);
      const ninOnlyOff = provider({});
      await expect(ninOnlyOff.service.isAvailable()).resolves.toBe(false);
      expect(ninOnlyOff.integrations.assertAvailable).not.toHaveBeenCalled();
      enable();
      const f = provider({});
      f.integrations.assertAvailable.mockRejectedValueOnce(new DomainProblem(503, 'INTEGRATION_PAUSED',
        'External verification is temporarily unavailable'));
      await expect(f.service.isAvailable()).resolves.toBe(false);
      await expect(f.service.isAvailable()).resolves.toBe(true);
      expect(f.integrations.assertAvailable).toHaveBeenCalledWith('qoreid', 'patient_nin');
      expect(f.adapter.verifyNinEnrollment).not.toHaveBeenCalled();
      expect(f.integrations.consumePublicPatientNinQuota).not.toHaveBeenCalled();
    });

    it('reports a fault reading the runtime state as a fault, not as an answer', async () => {
      enable();
      const f = provider({});
      f.integrations.assertAvailable.mockRejectedValueOnce(new DomainProblem(503, 'INTEGRATION_UNAVAILABLE',
        'Delivery provider is temporarily unavailable'));
      await expect(f.service.isAvailable())
        .rejects.toMatchObject({ status: 503, code: 'INTEGRATION_UNAVAILABLE' });
    });
  });
});
