import { getEnvironment, resetEnvironmentForTests } from './environment';

describe('Identity production database transport', () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  function production(): void {
    Object.assign(process.env, {
      NODE_ENV: 'production', DATABASE_URL: 'postgresql://identity:test@db.example/hid',
      DATABASE_SSL: 'true', DATABASE_SSL_ROOT_CERT_BASE64: 'trusted-ca',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', TRUST_PROXY_CIDRS: '10.0.0.0/8',
      AUTH_MODE: 'oidc', AUTH_COOKIE_SECURE: 'true', OIDC_ISSUER_URL: 'https://issuer.example',
      OIDC_AUDIENCE: 'hid-api', OIDC_JWKS_URL: 'https://issuer.example/jwks',
      IDENTITY_SERVICE_IDENTITY_MODE: 'jwt',
      WORKLOAD_ISSUER_URL: 'https://workloads.example', WORKLOAD_AUDIENCE: 'hid-identity-api', HID_DEPLOYMENT_ENV: 'production',
      WORKLOAD_JWKS_URL: 'https://workloads.example/jwks', IDENTITY_EHR_CALLER_SUBJECT: 'workload:ehr',
      IDENTITY_LAB_CALLER_SUBJECT: 'workload:lab', IDENTITY_PHARMACY_CALLER_SUBJECT: 'workload:pharmacy',
      IDENTITY_OCR_CALLER_SUBJECT: 'workload:ocr', OUTREACH_CALLER_SUBJECT: 'workload:outreach',
      TURNSTILE_MODE: 'required', TURNSTILE_SECRET_KEY: 'server-only-turnstile-secret',
      OTP_HMAC_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
      NOTIFICATION_API_URL: 'https://notification.internal.example',
      NOTIFICATION_SERVICE_IDENTITY_MODE: 'jwt',
      NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE: '/var/run/secrets/notification.jwt',
    });
  }

  it('rejects database URL TLS overrides and a global verification bypass', () => {
    production(); process.env.DATABASE_URL += '?sslmode=no-verify'; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/must not override/);
    production(); process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/cannot be disabled globally/);
  });

  it('rejects a production cookie domain and missing Turnstile secret', () => {
    production(); process.env.AUTH_COOKIE_DOMAIN = '.healthidentitydirectory.com'; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/host-only cookies/);
    production(); delete process.env.TURNSTILE_SECRET_KEY; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/Turnstile secret/);
  });

  it('requires an explicit staging or production deployment profile', () => {
    production(); delete process.env.HID_DEPLOYMENT_ENV; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/deployment profile/);
  });
});
