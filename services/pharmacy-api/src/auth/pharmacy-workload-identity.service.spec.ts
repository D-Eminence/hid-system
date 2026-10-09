jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(() => jest.fn()), jwtVerify: jest.fn() }));
import { jwtVerify } from 'jose';
import { resetEnvironmentForTests } from '../config/environment';
import { PharmacyWorkloadIdentityService } from './pharmacy-workload-identity.service';

describe('PharmacyWorkloadIdentityService', () => {
  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
      DATABASE_SSL: 'false', CORS_ORIGINS: 'http://localhost:3000', PHARMACY_SERVICE_IDENTITY_MODE: 'jwt',
      PHARMACY_WORKLOAD_ISSUER_URL: 'https://issuer.test',
      PHARMACY_WORKLOAD_AUDIENCE: 'hid-pharmacy-api',
      PHARMACY_WORKLOAD_JWKS_URL: 'https://issuer.test/jwks',
      PHARMACY_EHR_CALLER_SUBJECT: 'workload:ehr', PHARMACY_OCR_CALLER_SUBJECT: 'workload:ocr' });
    delete process.env.PHARMACY_INTERNAL_SERVICE_TOKEN;
    resetEnvironmentForTests(); jest.mocked(jwtVerify).mockReset();
  });

  it('accepts the exact EHR subject, issuer, and audience', async () => {
    jest.mocked(jwtVerify).mockResolvedValue({ payload: { sub: 'workload:ehr' },
      protectedHeader: { alg: 'RS256' } } as never);
    await expect(new PharmacyWorkloadIdentityService().authenticate('ehr-api', 'Bearer signed-token'))
      .resolves.toBeUndefined();
    expect(jwtVerify).toHaveBeenCalledWith('signed-token', expect.any(Function), expect.objectContaining({
      issuer: 'https://issuer.test', audience: 'hid-pharmacy-api' }));
  });

  it('rejects a valid token belonging to the other workload', async () => {
    jest.mocked(jwtVerify).mockResolvedValue({ payload: { sub: 'workload:ocr' },
      protectedHeader: { alg: 'RS256' } } as never);
    await expect(new PharmacyWorkloadIdentityService().authenticate('ehr-api', 'Bearer signed-token'))
      .rejects.toMatchObject({ status: 403, code: 'WORKLOAD_CALLER_DENIED' });
  });

  it('requires workload authorization independently of user authorization', async () => {
    await expect(new PharmacyWorkloadIdentityService().authenticate('ocr-api', undefined))
      .rejects.toMatchObject({ status: 401, code: 'INTERNAL_SERVICE_AUTH_REQUIRED' });
  });

  it('rejects an oversized workload token before JOSE processing', async () => {
    await expect(new PharmacyWorkloadIdentityService().authenticate(
      'ehr-api', `Bearer ${'x'.repeat(16_385)}`,
    )).rejects.toMatchObject({ status: 401, code: 'INVALID_WORKLOAD_IDENTITY' });
    expect(jwtVerify).not.toHaveBeenCalled();
  });
});
