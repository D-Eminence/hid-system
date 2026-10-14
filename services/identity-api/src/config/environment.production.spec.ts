import { getEnvironment, resetEnvironmentForTests } from './environment';

// CFG-PROD: every production configuration refusal of the Identity API, one
// row each. The base is the production task the CDK defines (AUTH_MODE=local,
// JWT workload identity, Turnstile required, the launch-profile secret with an
// empty Google allowlist), which must start. Identity makes no AWS SDK call,
// so it has no static AWS credential setting to refuse.
describe('Identity production configuration refusals', () => {
  const original = { ...process.env };
  const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');
  const production = {
    NODE_ENV: 'production', HID_DEPLOYMENT_ENV: 'production', PORT: '3001',
    DATABASE_URL: 'postgresql://identity:test@db.example/hid', DATABASE_SSL: 'true',
    DATABASE_SSL_ROOT_CERT_BASE64: 'trusted-ca', DATABASE_POOL_MAX: '6',
    CORS_ORIGINS: 'https://www.healthidentitydirectory.com,https://ehr.healthidentitydirectory.com',
    TRUST_PROXY_CIDRS: '10.40.0.0/16',
    AUTH_MODE: 'local', AUTH_COOKIE_SECURE: 'true', AUTH_ISSUER: 'hid-identity', AUTH_AUDIENCE: 'hid-api',
    AUTH_SIGNING_SECRET: 'synthetic-signing-secret-0123456789abcdef',
    AUTH_LOGIN_PEPPER: 'synthetic-login-pepper-0123456789abcdefgh',
    TURNSTILE_MODE: 'required', TURNSTILE_SECRET_KEY: 'synthetic-turnstile-secret',
    OTP_HMAC_KEY_VERSION: 'aws-v1', OTP_HMAC_KEY_B64: key(1), CONTACT_LOOKUP_HMAC_KEY_B64: key(2),
    MFA_KEY_VERSION: 'aws-v1', MFA_SECRET_KEY_B64: key(3),
    NIN_PROVIDER_MODE: 'unavailable', NIN_KEY_VERSION: 'aws-v1', NIN_LOOKUP_HMAC_KEY_B64: key(4), NIN_ENCRYPTION_KEY_B64: key(5),
    GOOGLE_OIDC_CLIENT_IDS: '',
    QOREID_ENABLED: 'false',
    NOTIFICATION_API_URL: 'https://notification.internal.production.example',
    NOTIFICATION_SERVICE_IDENTITY_MODE: 'jwt',
    NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE: '/var/run/hid/workload-tokens/notification.jwt',
    IDENTITY_SERVICE_IDENTITY_MODE: 'jwt', WORKLOAD_AUDIENCE: 'hid-identity-api',
    WORKLOAD_ISSUER_URL: 'https://issuer.example/production',
    WORKLOAD_JWKS_URL: 'https://issuer.example/production/.well-known/jwks.json',
    IDENTITY_EHR_CALLER_SUBJECT: 'hid:production:ehr-api', IDENTITY_LAB_CALLER_SUBJECT: 'hid:production:lab-api',
    IDENTITY_PHARMACY_CALLER_SUBJECT: 'hid:production:pharmacy-api', IDENTITY_OCR_CALLER_SUBJECT: 'hid:production:ocr-api',
    OUTREACH_CALLER_SUBJECT: 'hid:production:outreach-api',
  } as const;
  const localToken = 'synthetic-local-service-token-0123456789';

  function configure(changes: Record<string, string | undefined>): void {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original, production);
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetEnvironmentForTests();
  }

  afterAll(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('starts with the production task configuration, with Google sign-in off', () => {
    configure({});
    const environment = getEnvironment();
    expect(environment).toMatchObject({ NODE_ENV: 'production', TURNSTILE_MODE: 'required', AUTH_COOKIE_SECURE: true });
    expect(environment.GOOGLE_OIDC_CLIENT_IDS).toBeUndefined();
  });

  it.each<[string, Record<string, string | undefined>, string]>([
    ['Turnstile disabled', { TURNSTILE_MODE: 'disabled' }, 'Turnstile is required for public production authentication'],
    ['no Turnstile secret', { TURNSTILE_SECRET_KEY: undefined }, 'server-only Turnstile secret is required'],
    ['another Turnstile verifier', { TURNSTILE_SITEVERIFY_URL: 'https://turnstile.example/siteverify' }, 'must use Cloudflare Siteverify'],
    ['insecure cookies', { AUTH_COOKIE_SECURE: 'false' }, 'Secure cookies are required in production'],
    ['a shared cookie domain', { AUTH_COOKIE_DOMAIN: '.healthidentitydirectory.com' }, 'host-only cookies'],
    ['wildcard CORS', { CORS_ORIGINS: '*' }, 'exact HTTPS origins'],
    ['a wildcard among CORS origins', { CORS_ORIGINS: 'https://www.healthidentitydirectory.com,*' }, 'exact HTTPS origins'],
    ['plain-HTTP CORS', { CORS_ORIGINS: 'http://www.healthidentitydirectory.com' }, 'exact HTTPS origins'],
    ['a CORS origin with a path', { CORS_ORIGINS: 'https://www.healthidentitydirectory.com/portal' }, 'exact HTTPS origins'],
    ['local-secret service callers', { IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret' }, 'Production Identity callers require JWT'],
    ['local-secret Notification calls', { NOTIFICATION_SERVICE_IDENTITY_MODE: 'local-secret', NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN: localToken },
      'Production Identity-to-Notification calls require JWT'],
    ['a local EHR caller token', { IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: localToken }, 'Local service tokens are forbidden'],
    ['a local Lab caller token', { IDENTITY_LAB_INTERNAL_SERVICE_TOKEN: localToken }, 'Local service tokens are forbidden'],
    ['a local Pharmacy caller token', { IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN: localToken }, 'Local service tokens are forbidden'],
    ['a local OCR caller token', { IDENTITY_OCR_INTERNAL_SERVICE_TOKEN: localToken }, 'Local service tokens are forbidden'],
    ['a local Outreach caller token', { OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: localToken }, 'Local service tokens are forbidden'],
    ['a local Notification token', { NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN: localToken }, 'Local Notification service tokens are forbidden'],
    ['no deployment profile', { HID_DEPLOYMENT_ENV: undefined }, 'A production or staging deployment profile is required'],
    ['a missing caller subject', { IDENTITY_EHR_CALLER_SUBJECT: undefined }, 'IDENTITY_EHR_CALLER_SUBJECT is required in production'],
    ['a plain-HTTP workload issuer', { WORKLOAD_ISSUER_URL: 'http://issuer.example/production' }, 'WORKLOAD_ISSUER_URL must use HTTPS'],
    ['a plain-HTTP Notification API', { NOTIFICATION_API_URL: 'http://notification.internal.production.example' },
      'Production Notification API URL must use HTTPS'],
    ['database TLS off', { DATABASE_SSL: 'false' }, 'TLS is required in production'],
    ['no database CA', { DATABASE_SSL_ROOT_CERT_BASE64: undefined }, 'trusted PostgreSQL CA certificate'],
    ['a TLS override in the database URL', { DATABASE_URL: 'postgresql://identity:test@db.example/hid?sslmode=disable' }, 'must not override'],
    ['a global TLS bypass', { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, 'cannot be disabled globally'],
    ['no proxy CIDRs', { TRUST_PROXY_CIDRS: undefined }, 'reverse-proxy CIDRs are required'],
    ['no OTP key', { OTP_HMAC_KEY_B64: undefined }, 'server-only OTP HMAC key is required'],
    ['no contact lookup key', { CONTACT_LOOKUP_HMAC_KEY_B64: undefined }, 'server-only contact lookup key is required'],
    ['a non-canonical MFA key', { MFA_SECRET_KEY_B64: Buffer.alloc(32, 3).toString('hex') }, 'MFA secret key must be exactly 32'],
    ['a short NIN encryption key', { NIN_ENCRYPTION_KEY_B64: Buffer.alloc(31, 5).toString('base64') }, 'NIN encryption key must be exactly 32'],
    ['emergency-contact delivery', { EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true' }, 'emergency-contact delivery is not approved'],
    ['the deterministic NIN provider', { NIN_PROVIDER_MODE: 'test' }, 'deterministic NIN provider is test-only'],
    ['deferred NIN outside staging', { NIN_PROVIDER_MODE: 'deferred' }, 'Deferred NIN mode requires the explicit staging deployment profile'],
    // TS-9: a browser origin the Turnstile allowlist does not name could never
    // pass a check, so every sign-in from it would be refused at runtime.
    ['a CORS origin without Turnstile actions', { CORS_ORIGINS: 'https://www.healthidentitydirectory.com,https://portal.healthidentitydirectory.com' },
      'CORS origin https://portal.healthidentitydirectory.com has no Turnstile actions in the production deployment profile'],
    ['staging hosts under the production profile', { CORS_ORIGINS: 'https://staging.healthidentitydirectory.com' },
      'CORS origin https://staging.healthidentitydirectory.com has no Turnstile actions in the production deployment profile'],
    ['production hosts under the staging profile', { HID_DEPLOYMENT_ENV: 'staging' },
      'CORS origin https://www.healthidentitydirectory.com has no Turnstile actions in the staging deployment profile'],
  ])('refuses %s', (_label, changes, error) => {
    configure(changes);
    expect(() => getEnvironment()).toThrow(error);
  });

  it('starts with every launch host of each deployment profile', () => {
    // The browser hosts infra/aws/src/config.ts sets as CORS_ORIGINS.
    const products = ['ehr', 'lab', 'pharmacy', 'migrate', 'outreach', 'admin'];
    configure({ CORS_ORIGINS: ['www', ...products].map((host) => `https://${host}.healthidentitydirectory.com`).join(',') });
    expect(() => getEnvironment()).not.toThrow();
    configure({ HID_DEPLOYMENT_ENV: 'staging', CORS_ORIGINS: ['staging', ...products.map((product) => `${product}.staging`)]
      .map((host) => `https://${host}.healthidentitydirectory.com`).join(',') });
    expect(() => getEnvironment()).not.toThrow();
  });

  // TS-10: the production deployment profile keeps its Turnstile refusals
  // whatever NODE_ENV says; a local or test run of the staging profile does not.
  it.each<[string, Record<string, string | undefined>, string]>([
    ['Turnstile disabled', { TURNSTILE_MODE: 'disabled' }, 'Turnstile is required for public production authentication'],
    ['no Turnstile secret', { TURNSTILE_SECRET_KEY: undefined }, 'server-only Turnstile secret is required'],
    ['another Turnstile verifier', { TURNSTILE_SITEVERIFY_URL: 'https://turnstile.example/siteverify' }, 'must use Cloudflare Siteverify'],
    ['a CORS origin without Turnstile actions', { CORS_ORIGINS: 'https://portal.healthidentitydirectory.com' }, 'has no Turnstile actions'],
  ])('refuses %s for the production profile outside NODE_ENV=production', (_label, changes, error) => {
    configure({ NODE_ENV: 'development', ...changes });
    expect(() => getEnvironment()).toThrow(error);
  });

  it('starts a local run of the staging profile with Turnstile disabled', () => {
    configure({ NODE_ENV: 'development', HID_DEPLOYMENT_ENV: 'staging', TURNSTILE_MODE: 'disabled',
      TURNSTILE_SECRET_KEY: undefined, CORS_ORIGINS: 'http://localhost:5173' });
    expect(() => getEnvironment()).not.toThrow();
  });
});
