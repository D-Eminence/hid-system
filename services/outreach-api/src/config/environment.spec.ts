import { getEnvironment, resetEnvironmentForTests } from './environment';

describe('Outreach production configuration', () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  function production(): void {
    Object.assign(process.env, {
      NODE_ENV: 'production', OUTREACH_DATABASE_URL: 'postgresql://outreach:test@db.example/hid',
      DATABASE_SSL: 'true', DATABASE_SSL_ROOT_CERT_BASE64: 'Y2E=', DATABASE_POOL_MAX: '10',
      CORS_ORIGINS: 'https://app.example', TRUST_PROXY_CIDRS: '10.0.0.0/8',
      IDENTITY_API_URL: 'https://identity.example', OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE: 'jwt',
      OUTREACH_IDENTITY_WORKLOAD_TOKEN_FILE: '/var/run/secrets/outreach-identity-token',
    });
  }

  it('accepts a mounted rotating JWT in production', () => {
    production(); delete process.env.OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN; resetEnvironmentForTests();
    expect(getEnvironment().OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE).toBe('jwt');
  });

  it('rejects local shared-secret identity in production', () => {
    production(); process.env.OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE = 'local-secret';
    process.env.OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN = 'x'.repeat(32); resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/Production Outreach API requires JWT workload identity/);
  });

  it('rejects database URL TLS overrides and a global verification bypass', () => {
    production(); process.env.OUTREACH_DATABASE_URL += '?sslmode=no-verify'; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/must not override/);
    production(); process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/cannot be disabled globally/);
  });
});
