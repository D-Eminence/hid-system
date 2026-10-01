import { resetEnvironmentForTests } from '../config/environment';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { QoreIdPublicPatientIdentityProvider } from './patient-enrollment.provider';
import type { QoreIdVerificationAdapter } from './qoreid-verification.adapter';

const originalEnvironment = { ...process.env };
const nin = '12345678901';
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
    const integrations = { assertAvailable: jest.fn().mockResolvedValue(undefined) };
    return { adapter, integrations, service: new QoreIdPublicPatientIdentityProvider(
      adapter as unknown as QoreIdVerificationAdapter,
      integrations as unknown as IntegrationRuntimeService) };
  }

  it('does not contact the integration when QoreID is disabled', async () => {
    const f = provider({ state: 'verified', providerReference: 'transaction-1', ninEnrollmentBinding: binding });
    await expect(f.service.verifyNin(nin)).rejects.toMatchObject({ code: 'QOREID_DISABLED' });
    expect(f.integrations.assertAvailable).not.toHaveBeenCalled();
    expect(f.adapter.verifyNinEnrollment).not.toHaveBeenCalled();
  });

  it('requires enabled runtime authority and an exact verified NIN binding', async () => {
    process.env.QOREID_ENABLED = 'true';
    process.env.QOREID_CLIENT_ID = 'test-client';
    process.env.QOREID_CLIENT_SECRET = 'test-secret';
    resetEnvironmentForTests();
    const f = provider({ state: 'verified', providerReference: 'transaction-1', ninEnrollmentBinding: binding });
    await expect(f.service.verifyNin(nin)).resolves.toEqual({ ...binding, providerReference: 'transaction-1' });
    expect(f.integrations.assertAvailable).toHaveBeenCalledWith('qoreid', 'patient_nin');
    expect(f.adapter.verifyNinEnrollment).toHaveBeenCalledWith(nin);
    f.adapter.verifyNinEnrollment.mockResolvedValue({ state: 'verified', providerReference: 'transaction-2',
      ninEnrollmentBinding: { ...binding, nin: '99999999999' } });
    await expect(f.service.verifyNin(nin)).rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
  });

  it('rejects an incomplete or denied provider result', async () => {
    process.env.QOREID_ENABLED = 'true';
    process.env.QOREID_CLIENT_ID = 'test-client';
    process.env.QOREID_CLIENT_SECRET = 'test-secret';
    resetEnvironmentForTests();
    const f = provider({ state: 'not_verified' });
    await expect(f.service.verifyNin(nin)).rejects.toMatchObject({ code: 'NIN_NOT_VERIFIED' });
    f.adapter.verifyNinEnrollment.mockResolvedValue({ state: 'verified', ninEnrollmentBinding: binding });
    await expect(f.service.verifyNin(nin)).rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
  });
});
