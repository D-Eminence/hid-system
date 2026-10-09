import { getEnvironment, resetEnvironmentForTests } from './environment';

describe('Pharmacy production workload configuration', () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });
  const production = () => Object.assign(process.env, {
    NODE_ENV: 'production', PHARMACY_DATABASE_URL: 'postgresql://pharmacy:test@db.example/hid',
    DATABASE_SSL: 'true', DATABASE_SSL_ROOT_CERT_BASE64: 'Y2E=', DATABASE_POOL_MAX: '10',
    CORS_ORIGINS: 'https://app.example', TRUST_PROXY_CIDRS: '10.0.0.0/8',
    IDENTITY_API_URL: 'https://identity.example', PHARMACY_SERVICE_IDENTITY_MODE: 'jwt',
    IDENTITY_SERVICE_IDENTITY_MODE: 'jwt',
    IDENTITY_PHARMACY_WORKLOAD_TOKEN_FILE: '/var/run/secrets/identity-token',
    PHARMACY_WORKLOAD_ISSUER_URL: 'https://issuer.example',
    PHARMACY_WORKLOAD_AUDIENCE: 'hid-pharmacy-api',
    PHARMACY_WORKLOAD_JWKS_URL: 'https://issuer.example/jwks',
    PHARMACY_EHR_CALLER_SUBJECT: 'workload:ehr', PHARMACY_OCR_CALLER_SUBJECT: 'workload:ocr',
  });

  it('accepts asymmetric audience-bound production configuration', () => {
    production(); delete process.env.PHARMACY_INTERNAL_SERVICE_TOKEN; resetEnvironmentForTests();
    expect(getEnvironment().PHARMACY_SERVICE_IDENTITY_MODE).toBe('jwt');
  });

  it('rejects local shared-secret identity in production', () => {
    production(); process.env.PHARMACY_SERVICE_IDENTITY_MODE = 'local-secret';
    process.env.PHARMACY_INTERNAL_SERVICE_TOKEN = 'x'.repeat(32); resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/Production Pharmacy API requires JWT workload identity/);
  });

  it('rejects database URL TLS overrides and a global verification bypass', () => {
    production(); process.env.PHARMACY_DATABASE_URL += '?sslmode=no-verify'; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/must not override/);
    production(); process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/cannot be disabled globally/);
  });
});
