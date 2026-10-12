jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => 'jwks'),
  jwtVerify: jest.fn(),
}));

import type { ExecutionContext } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { resetEnvironmentForTests } from '../config/environment';
import { OcrInternalCallerGuard } from './ocr-internal-caller.guard';

const localToken = 'ocr-to-ehr-independent-secret-value';

function configure(overrides: Record<string, string> = {}): void {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
    DATABASE_SSL: 'false',
    CORS_ORIGINS: 'http://localhost:3000',
    STORAGE_MODE: 'disabled',
    EHR_SERVICE_IDENTITY_MODE: 'local-secret',
    EHR_INTERNAL_SERVICE_TOKEN: localToken,
    ...overrides,
  });
  resetEnvironmentForTests();
}

function context(headers: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ header: (name: string) => headers[name.toLowerCase()] }),
    }),
  } as unknown as ExecutionContext;
}

describe('OcrInternalCallerGuard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configure();
  });

  afterEach(() => {
    jest.mocked(createRemoteJWKSet).mockImplementation(() => 'jwks' as never);
    process.env.EHR_SERVICE_IDENTITY_MODE = 'local-secret';
    process.env.EHR_INTERNAL_SERVICE_TOKEN = localToken;
    resetEnvironmentForTests();
  });

  it('accepts only the exact OCR caller and independent local workload token', async () => {
    const guard = new OcrInternalCallerGuard();
    await expect(guard.canActivate(context({
      'x-hid-internal-caller': 'ocr-api',
      'x-hid-service-token': localToken,
    }))).resolves.toBe(true);

    await expect(guard.canActivate(context({
      'x-hid-internal-caller': 'lab-api',
      'x-hid-service-token': localToken,
    }))).rejects.toMatchObject({ status: 401, code: 'INTERNAL_SERVICE_AUTH_REQUIRED' });
    await expect(guard.canActivate(context({
      'x-hid-internal-caller': 'ocr-api',
      'x-hid-service-token': 'wrong-secret',
    }))).rejects.toMatchObject({ status: 401, code: 'INTERNAL_SERVICE_AUTH_REQUIRED' });
  });

  it('verifies JWT audience and exact OCR subject while rejecting oversized input before JOSE', async () => {
    configure({
      EHR_SERVICE_IDENTITY_MODE: 'jwt',
      EHR_INTERNAL_SERVICE_TOKEN: '',
      EHR_WORKLOAD_ISSUER_URL: 'https://issuer.example.test',
      EHR_WORKLOAD_AUDIENCE: 'hid-ehr-api',
      EHR_WORKLOAD_JWKS_URL: 'https://issuer.example.test/.well-known/jwks.json',
      EHR_OCR_CALLER_SUBJECT: 'workload:ocr-api',
    });
    jest.mocked(jwtVerify).mockResolvedValue({
      payload: { sub: 'workload:ocr-api' },
      protectedHeader: { alg: 'RS256' },
    } as never);
    const guard = new OcrInternalCallerGuard();
    await expect(guard.canActivate(context({
      'x-hid-internal-caller': 'ocr-api',
      'x-hid-service-authorization': 'Bearer signed-workload-token',
    }))).resolves.toBe(true);
    expect(jwtVerify).toHaveBeenCalledWith('signed-workload-token', 'jwks', expect.objectContaining({
      issuer: 'https://issuer.example.test',
      audience: 'hid-ehr-api',
    }));

    jest.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { sub: 'workload:lab-api' },
      protectedHeader: { alg: 'RS256' },
    } as never);
    await expect(guard.canActivate(context({
      'x-hid-internal-caller': 'ocr-api',
      'x-hid-service-authorization': 'Bearer another-signed-token',
    }))).rejects.toMatchObject({ status: 403, code: 'WORKLOAD_CALLER_DENIED' });

    jest.mocked(jwtVerify).mockClear();
    await expect(guard.canActivate(context({
      'x-hid-internal-caller': 'ocr-api',
      'x-hid-service-authorization': `Bearer ${'x'.repeat(16_385)}`,
    }))).rejects.toMatchObject({ status: 401, code: 'INVALID_WORKLOAD_IDENTITY' });
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it('reuses one remote JWKS set for every verification instead of fetching it per request', async () => {
    configure({
      EHR_SERVICE_IDENTITY_MODE: 'jwt',
      EHR_INTERNAL_SERVICE_TOKEN: '',
      EHR_WORKLOAD_ISSUER_URL: 'https://issuer.example.test',
      EHR_WORKLOAD_AUDIENCE: 'hid-ehr-api',
      EHR_WORKLOAD_JWKS_URL: 'https://issuer.example.test/.well-known/jwks.json',
      EHR_OCR_CALLER_SUBJECT: 'workload:ocr-api',
    });
    let created = 0;
    jest.mocked(createRemoteJWKSet).mockImplementation(() => `jwks-${++created}` as never);
    jest.mocked(jwtVerify).mockResolvedValue({
      payload: { sub: 'workload:ocr-api' },
      protectedHeader: { alg: 'ES256' },
    } as never);
    const guard = new OcrInternalCallerGuard();
    for (const token of ['first-signed-workload-token', 'second-signed-workload-token']) {
      await expect(guard.canActivate(context({
        'x-hid-internal-caller': 'ocr-api',
        'x-hid-service-authorization': `Bearer ${token}`,
      }))).resolves.toBe(true);
    }
    expect(createRemoteJWKSet).toHaveBeenCalledTimes(1);
    expect(String(jest.mocked(createRemoteJWKSet).mock.calls[0]?.[0]))
      .toBe('https://issuer.example.test/.well-known/jwks.json');
    expect(jwtVerify).toHaveBeenNthCalledWith(1, 'first-signed-workload-token', 'jwks-1', expect.anything());
    expect(jwtVerify).toHaveBeenNthCalledWith(2, 'second-signed-workload-token', 'jwks-1', expect.anything());
  });
});
