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

// A5: the workload token agent rewrites the token file well before each token
// expires; when it stops (ADR-047 D2), the file keeps an expired token. EHR
// sent it and Identity refused it 401, which reached the browser as
// "signed out". An expired token is now refused here, before any request.
describe('ServiceWorkloadIdentityService: an expired Identity workload token is not sent (A5)', () => {
  const jwt = (claims: Record<string, unknown>) => [{ alg: 'ES256', typ: 'JWT' }, claims]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).concat('c2lnbmF0dXJl').join('.');

  beforeEach(() => {
    Object.assign(process.env, { IDENTITY_SERVICE_IDENTITY_MODE: 'jwt',
      IDENTITY_EHR_WORKLOAD_TOKEN_FILE: '/run/secrets/identity-ehr.jwt' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    delete process.env.IDENTITY_SERVICE_IDENTITY_MODE;
    delete process.env.IDENTITY_EHR_WORKLOAD_TOKEN_FILE;
    resetEnvironmentForTests();
  });

  it('answers 503 IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE for a token whose exp has passed, and counts it', async () => {
    jest.mocked(readFile).mockResolvedValue(`${jwt({ sub: 'workload:ehr-api', exp: Math.floor(Date.now() / 1000) - 5 })}\n`);
    const service = new ServiceWorkloadIdentityService();
    await expect(service.identityHeaders()).rejects.toMatchObject({ status: 503,
      code: 'IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE' });
    expect((service as unknown as { expiredTokenRefusals: number }).expiredTokenRefusals).toBe(1);
  });

  it('sends a token that has not expired', async () => {
    const token = jwt({ sub: 'workload:ehr-api', exp: Math.floor(Date.now() / 1000) + 240 });
    jest.mocked(readFile).mockResolvedValue(`${token}\n`);
    await expect(new ServiceWorkloadIdentityService().identityHeaders())
      .resolves.toEqual({ 'x-hid-service-authorization': `Bearer ${token}` });
  });

  it('leaves a token it cannot read as a JWT for Identity to judge', async () => {
    jest.mocked(readFile).mockResolvedValue('opaque.workload.token-value\n');
    await expect(new ServiceWorkloadIdentityService().identityHeaders())
      .resolves.toEqual({ 'x-hid-service-authorization': 'Bearer opaque.workload.token-value' });
  });
});
