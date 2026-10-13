import { DomainProblem } from '../common/problem';
import { resetEnvironmentForTests } from '../config/environment';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { QoreIdPublicPatientIdentityProvider } from './patient-enrollment.provider';
import type { QoreIdVerificationAdapter } from './qoreid-verification.adapter';

const originalEnvironment = { ...process.env };
const nin = '12345678901';
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
      QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'false',
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
});
