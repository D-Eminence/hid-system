jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { resetEnvironmentForTests } from '../config/environment';
import { WorkloadAuthService } from './workload-auth.service';
import { createRemoteJWKSet, jwtVerify } from 'jose';

describe('WorkloadAuthService Outreach caller', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
      DATABASE_SSL: 'false', CORS_ORIGINS: 'http://localhost:3000', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: 'x'.repeat(32), AUTH_LOGIN_PEPPER: 'y'.repeat(32),
      STORAGE_MODE: 'disabled',
      OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
      OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: 'outreach-independent-secret-value-1234',
      IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'ehr-independent-secret-value-12345678',
    });
    resetEnvironmentForTests();
  });

  afterEach(() => resetEnvironmentForTests());

  it('accepts exact local development workload evidence independently of the user session', async () => {
    const service = new WorkloadAuthService({} as never);
    await expect(service.authenticateOutreach('outreach-api', undefined,
      'outreach-independent-secret-value-1234')).resolves.toEqual({
        subject: 'local:outreach-api', accountId: 'local:outreach-api',
      });
  });

  it('denies the wrong service caller or token', async () => {
    const service = new WorkloadAuthService({} as never);
    await expect(service.authenticateOutreach('ehr-api', undefined,
      'outreach-independent-secret-value-1234')).rejects.toMatchObject({ status: 401 });
    await expect(service.authenticateOutreach('outreach-api', undefined,
      'wrong-secret')).rejects.toMatchObject({ status: 401 });
  });

  it('binds each local caller name to its own development-only secret', async () => {
    const service = new WorkloadAuthService({} as never);
    await expect(service.authenticateService('ehr-api', undefined,
      'ehr-independent-secret-value-12345678')).resolves.toEqual({
        subject: 'local:ehr-api', accountId: 'local:ehr-api',
      });
    await expect(service.authenticateService('lab-api', undefined,
      'ehr-independent-secret-value-12345678')).rejects.toMatchObject({ status: 401 });
  });

  describe('JWT production-equivalent validation', () => {
    beforeEach(() => {
      Object.assign(process.env, {
        IDENTITY_SERVICE_IDENTITY_MODE: 'jwt',
        WORKLOAD_ISSUER_URL: 'https://issuer.test',
        WORKLOAD_JWKS_URL: 'https://issuer.test/jwks',
        WORKLOAD_AUDIENCE: 'hid-identity-api',
        IDENTITY_EHR_CALLER_SUBJECT: 'workload:ehr-api',
      });
      resetEnvironmentForTests();
      jest.mocked(createRemoteJWKSet).mockReturnValue(jest.fn() as never);
      jest.mocked(jwtVerify).mockReset();
    });

    it('accepts the exact issuer, audience, algorithm, and caller subject', async () => {
      jest.mocked(jwtVerify).mockResolvedValue({ payload: { sub: 'workload:ehr-api' } } as never);
      await expect(new WorkloadAuthService({} as never).authenticateService(
        'ehr-api', 'Bearer signed-token', undefined,
      )).resolves.toEqual({ subject: 'workload:ehr-api', accountId: 'workload:ehr-api' });
      expect(jwtVerify).toHaveBeenCalledWith('signed-token', expect.any(Function), {
        issuer: 'https://issuer.test', audience: 'hid-identity-api', algorithms: ['RS256', 'ES256'],
      });
    });

    it('denies a valid token with the wrong workload subject', async () => {
      jest.mocked(jwtVerify).mockResolvedValue({ payload: { sub: 'workload:lab-api' } } as never);
      await expect(new WorkloadAuthService({} as never).authenticateService(
        'ehr-api', 'Bearer signed-token', undefined,
      )).rejects.toMatchObject({ status: 403 });
    });

    it('rejects an oversized workload token before JOSE processing', async () => {
      await expect(new WorkloadAuthService({} as never).authenticateService(
        'ehr-api', `Bearer ${'x'.repeat(16_385)}`, undefined,
      )).rejects.toMatchObject({ status: 401 });
      expect(jwtVerify).not.toHaveBeenCalled();
    });

    it.each(['invalid signature', 'expired token', 'wrong audience'])(
      'fails closed when JOSE rejects an %s',
      async () => {
        jest.mocked(jwtVerify).mockRejectedValue(new Error('JWT validation failed'));
        await expect(new WorkloadAuthService({} as never).authenticateService(
          'ehr-api', 'Bearer rejected-token', undefined,
        )).rejects.toMatchObject({ status: 401 });
      },
    );
  });
});
