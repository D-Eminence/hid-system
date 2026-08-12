jest.mock('node:fs/promises', () => ({ readFile: jest.fn(), stat: jest.fn() }));
import { readFile, stat } from 'node:fs/promises';
import { resetEnvironmentForTests } from '../config/environment';
import { ServiceWorkloadIdentityService } from './service-workload-identity.service';

describe('ServiceWorkloadIdentityService', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
      DATABASE_SSL: 'false',
      CORS_ORIGINS: 'http://localhost:3000',
      STORAGE_MODE: 'disabled',
      LAB_SERVICE_IDENTITY_MODE: 'jwt',
      LAB_EHR_WORKLOAD_TOKEN_FILE: '/run/secrets/lab-ehr.jwt',
      PHARMACY_SERVICE_IDENTITY_MODE: 'jwt',
      PHARMACY_EHR_WORKLOAD_TOKEN_FILE: '/run/secrets/pharmacy-ehr.jwt',
    });
    resetEnvironmentForTests();
    jest.mocked(readFile).mockReset();
    jest.mocked(stat).mockReset().mockResolvedValue({ isFile: () => true, size: 256 } as never);
  });

  it('loads the current rotating service-specific token for each request', async () => {
    jest.mocked(readFile).mockResolvedValue('header.payload.signature\n');
    const service = new ServiceWorkloadIdentityService();
    await expect(service.authorization('lab')).resolves
      .toBe('Bearer header.payload.signature');
    await expect(service.authorization('pharmacy')).resolves
      .toBe('Bearer header.payload.signature');
    expect(readFile).toHaveBeenNthCalledWith(1, '/run/secrets/lab-ehr.jwt', { encoding: 'utf8' });
    expect(readFile).toHaveBeenNthCalledWith(2, '/run/secrets/pharmacy-ehr.jwt', { encoding: 'utf8' });
  });

  it('fails closed when a mounted service token is unavailable', async () => {
    jest.mocked(readFile).mockRejectedValue(new Error('missing'));
    await expect(new ServiceWorkloadIdentityService().authorization('pharmacy'))
      .rejects.toMatchObject({ status: 503, code: 'SERVICE_WORKLOAD_IDENTITY_UNAVAILABLE' });
  });
});
