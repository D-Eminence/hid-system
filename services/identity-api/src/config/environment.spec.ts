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
      CONTACT_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 8).toString('base64'),
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

  it('keeps QoreID disabled by default and requires approved server-only configuration when enabled', () => {
    production(); resetEnvironmentForTests();
    expect(getEnvironment().QOREID_ENABLED).toBe(false);

    production(); process.env.QOREID_ENABLED = 'true'; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/QOREID_CLIENT_ID/);

    production(); Object.assign(process.env, {
      QOREID_ENABLED: 'true', QOREID_CLIENT_ID: 'synthetic-client', QOREID_CLIENT_SECRET: 'synthetic-secret',
      QOREID_BASE_URL: 'https://unapproved.example',
    }); resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/approved QoreID API origin/);

    production(); Object.assign(process.env, {
      QOREID_ENABLED: 'true', QOREID_CLIENT_ID: 'synthetic-client', QOREID_CLIENT_SECRET: 'synthetic-secret',
      QOREID_BASE_URL: 'https://api.qoreid.com',
    }); resetEnvironmentForTests();
    expect(getEnvironment().QOREID_ENABLED).toBe(true);
    expect(getEnvironment().QOREID_MAX_RETRIES).toBe(0);
  });

  it('turns emergency-contact delivery on by default in production, every 60 s, and lets it be switched off (main refuses it there)', () => {
    // Production's task definitions set none of these keys (owner approval, 2026-10-24).
    production(); resetEnvironmentForTests();
    expect(getEnvironment()).toMatchObject({ EMERGENCY_CONTACT_DELIVERY_ENABLED: true,
      EMERGENCY_CONTACT_CHANNELS: ['email'], EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS: [],
      PATIENT_LIFECYCLE_SWEEP_SECONDS: 60, EMERGENCY_CONTACT_ALERT_TIMEOUT_MS: 12_000 });
    expect(getEnvironment().HID_DEPLOYMENT_ENV).toBe('production');

    production(); process.env.EMERGENCY_CONTACT_DELIVERY_ENABLED = 'false'; resetEnvironmentForTests();
    expect(getEnvironment().EMERGENCY_CONTACT_DELIVERY_ENABLED).toBe(false);
  });

  it('reads emergency-contact channels as a non-empty subset of email and SMS', () => {
    for (const [value, channels] of [['', ['email']], ['sms', ['sms']], [' email , sms ', ['email', 'sms']]] as const) {
      production(); process.env.EMERGENCY_CONTACT_CHANNELS = value; resetEnvironmentForTests();
      expect(getEnvironment().EMERGENCY_CONTACT_CHANNELS).toEqual(channels);
    }
    for (const value of ['whatsapp', 'email,', 'email,email', ',']) {
      production(); process.env.EMERGENCY_CONTACT_CHANNELS = value; resetEnvironmentForTests();
      expect(() => getEnvironment()).toThrow(/EMERGENCY_CONTACT_CHANNELS/);
    }
  });

  it('reads the emergency-contact pilot as at most 20 distinct account UUIDs, empty meaning every patient', () => {
    const ids = Array.from({ length: 21 }, (_, index) => `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    production(); process.env.EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS = ' '; resetEnvironmentForTests();
    expect(getEnvironment().EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS).toEqual([]);
    production(); process.env.EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS = ` ${ids[0]!.toUpperCase()} ,${ids[1]}`;
    resetEnvironmentForTests();
    expect(getEnvironment().EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS).toEqual([ids[0], ids[1]]);
    production(); process.env.EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS = ids.slice(0, 20).join(','); resetEnvironmentForTests();
    expect(getEnvironment().EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS).toHaveLength(20);
    for (const value of [ids.join(','), `${ids[0]},${ids[0]}`, 'not-a-uuid', `${ids[0]},`,
      '70000000-0000-4000-8000-00000000001', '70000000-0000-4000-c000-000000000001']) {
      production(); process.env.EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS = value; resetEnvironmentForTests();
      expect(() => getEnvironment()).toThrow(/EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS/);
    }
  });

  it('bounds the dispatch interval and the alert timeout', () => {
    for (const [key, value] of [['PATIENT_LIFECYCLE_SWEEP_SECONDS', '0'], ['PATIENT_LIFECYCLE_SWEEP_SECONDS', '3600'],
      ['EMERGENCY_CONTACT_ALERT_TIMEOUT_MS', '1000'], ['EMERGENCY_CONTACT_ALERT_TIMEOUT_MS', '20000']] as const) {
      production(); process.env[key] = value; resetEnvironmentForTests();
      expect(getEnvironment()[key]).toBe(Number(value));
    }
    for (const [key, value] of [['PATIENT_LIFECYCLE_SWEEP_SECONDS', '-1'], ['PATIENT_LIFECYCLE_SWEEP_SECONDS', '3601'],
      ['EMERGENCY_CONTACT_ALERT_TIMEOUT_MS', '999'], ['EMERGENCY_CONTACT_ALERT_TIMEOUT_MS', '20001']] as const) {
      production(); process.env[key] = value; resetEnvironmentForTests();
      expect(() => getEnvironment()).toThrow(new RegExp(key));
    }
  });
});

describe('Public patient enrollment contact-code failure budget', () => {
  const original = { ...process.env };
  const keys = ['PATIENT_ENROLLMENT_CONTACT_FAILURE_MAX', 'PATIENT_ENROLLMENT_CONTACT_FAILURE_WINDOW_SECONDS'];
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  function local(values: Record<string, string> = {}): void {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
    }, values);
    resetEnvironmentForTests();
  }

  function budget(): { max: unknown; windowSeconds: unknown } {
    const environment: Record<string, unknown> = getEnvironment();
    return { max: environment.PATIENT_ENROLLMENT_CONTACT_FAILURE_MAX,
      windowSeconds: environment.PATIENT_ENROLLMENT_CONTACT_FAILURE_WINDOW_SECONDS };
  }

  it('defaults to the documented six-digit-code budget: the fifth wrong code in 15 minutes blocks for 15 minutes', () => {
    local();
    expect(budget()).toEqual({ max: 5, windowSeconds: 900 });
  });

  it('accepts a budget within its bounds and refuses one outside them', () => {
    for (const [max, windowSeconds] of [[2, 900], [10, 86_400]] as const) {
      local({ PATIENT_ENROLLMENT_CONTACT_FAILURE_MAX: String(max),
        PATIENT_ENROLLMENT_CONTACT_FAILURE_WINDOW_SECONDS: String(windowSeconds) });
      expect(budget()).toEqual({ max, windowSeconds });
    }
    const outside: Array<[string, string]> = [[keys[0]!, '1'], [keys[0]!, '11'], [keys[1]!, '899'], [keys[1]!, '86401']];
    for (const [key, value] of outside) {
      local({ [key]: value });
      expect(() => getEnvironment()).toThrow(new RegExp(`${key}: `));
    }
  });
});
