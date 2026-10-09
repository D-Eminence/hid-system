import { getEnvironment, resetEnvironmentForTests } from './environment';

const required = {
  NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
  DATABASE_SSL: 'false', CORS_ORIGINS: 'http://localhost:3000',
  IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_OCR_INTERNAL_SERVICE_TOKEN: 'i'.repeat(32),
  EHR_SERVICE_IDENTITY_MODE: 'local-secret', EHR_INTERNAL_SERVICE_TOKEN: 'e'.repeat(32),
  LAB_SERVICE_IDENTITY_MODE: 'local-secret', LAB_INTERNAL_SERVICE_TOKEN: 'l'.repeat(32),
  PHARMACY_SERVICE_IDENTITY_MODE: 'local-secret', PHARMACY_INTERNAL_SERVICE_TOKEN: 'p'.repeat(32),
};

describe('OCR environment', () => {
  beforeEach(() => { Object.assign(process.env, required); delete process.env.PORT; resetEnvironmentForTests(); });
  afterEach(() => { resetEnvironmentForTests(); });

  it('uses the reserved standalone port', () => {
    expect(getEnvironment().PORT).toBe(3005);
  });

  it('fails closed when a local downstream workload secret is absent', () => {
    delete process.env.EHR_INTERNAL_SERVICE_TOKEN;
    expect(() => getEnvironment()).toThrow(/EHR_INTERNAL_SERVICE_TOKEN/);
  });

  it('rejects production database URL TLS overrides and a global bypass', () => {
    Object.assign(process.env, {
      ...required, NODE_ENV: 'production', OCR_DATABASE_URL: 'postgresql://ocr:test@db.example/hid',
      DATABASE_SSL: 'true', DATABASE_SSL_ROOT_CERT_BASE64: 'trusted-ca',
      CORS_ORIGINS: 'https://app.example', TRUST_PROXY_CIDRS: '10.0.0.0/8',
      IDENTITY_API_URL: 'https://identity.example', IDENTITY_SERVICE_IDENTITY_MODE: 'jwt',
      IDENTITY_OCR_WORKLOAD_TOKEN_FILE: '/var/run/secrets/identity.jwt',
      EHR_API_URL: 'https://ehr.example', EHR_SERVICE_IDENTITY_MODE: 'jwt',
      EHR_OCR_WORKLOAD_TOKEN_FILE: '/var/run/secrets/ehr.jwt',
      LAB_API_URL: 'https://lab.example', LAB_SERVICE_IDENTITY_MODE: 'jwt',
      LAB_OCR_WORKLOAD_TOKEN_FILE: '/var/run/secrets/lab.jwt',
      PHARMACY_API_URL: 'https://pharmacy.example', PHARMACY_SERVICE_IDENTITY_MODE: 'jwt',
      PHARMACY_OCR_WORKLOAD_TOKEN_FILE: '/var/run/secrets/pharmacy.jwt',
    });
    process.env.OCR_DATABASE_URL += '?sslmode=no-verify'; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/must not override/);
    process.env.OCR_DATABASE_URL = 'postgresql://ocr:test@db.example/hid';
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/cannot be disabled globally/);
  });
});
