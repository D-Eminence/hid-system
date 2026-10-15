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

  // Each production refusal, one case per unsafe setting (CFG-PROD).
  const qoreId = { QOREID_ENABLED: 'true', QOREID_CLIENT_ID: 'synthetic-client', QOREID_CLIENT_SECRET: 'synthetic-secret' };
  it.each<[string, Record<string, string>, RegExp]>([
    ['NIN-only enrollment without a route to prove the NIN holder (N1, ADR-062)',
      { ...qoreId, QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'true' },
      /QOREID_NIN_ONLY_ENROLLMENT_ENABLED: NIN-only enrollment requires NIN_HOLDER_SMS_ENABLED or ASSISTED_REGISTRATION_ENABLED/],
    // ADR-063: the facility route is the remedy when someone who knows a NIN
    // closes its online route, and the only route without a usable registry phone.
    ['the online NIN holder route without the facility route that remedies its lockout',
      { ...qoreId, QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'true', NIN_HOLDER_SMS_ENABLED: 'true' },
      /NIN_HOLDER_SMS_ENABLED: The online NIN holder route needs ASSISTED_REGISTRATION_ENABLED in production/],
    ['the signed-in NIN binding, which proves no holder', { ...qoreId, QOREID_PATIENT_SELF_NIN_BINDING_ENABLED: 'true' },
      /QOREID_PATIENT_SELF_NIN_BINDING_ENABLED: The signed-in NIN binding is refused in production/],
    ['Turnstile disabled', { TURNSTILE_MODE: 'disabled' }, /TURNSTILE_MODE: Turnstile is required/],
    ['insecure cookies', { AUTH_COOKIE_SECURE: 'false' }, /AUTH_COOKIE_SECURE: Secure cookies are required/],
    ['a wildcard CORS origin', { CORS_ORIGINS: '*' }, /CORS_ORIGINS: Production CORS origins must be exact HTTPS origins/],
    ['an HTTP CORS origin', { CORS_ORIGINS: 'http://www.healthidentitydirectory.com' }, /CORS_ORIGINS: Production CORS origins/],
    ['local-secret Identity callers', { IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret' },
      /IDENTITY_SERVICE_IDENTITY_MODE: Production Identity callers require JWT workload identity/],
    ['a local service token', { IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'x'.repeat(40) },
      /IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: Local service tokens are forbidden in production/],
    ['local-secret Notification calls', { NOTIFICATION_SERVICE_IDENTITY_MODE: 'local-secret',
      NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN: 'y'.repeat(40) },
    /NOTIFICATION_SERVICE_IDENTITY_MODE: Production Identity-to-Notification calls require JWT workload identity/],
    ['an HTTP Notification API', { NOTIFICATION_API_URL: 'http://notification.internal.example' },
      /NOTIFICATION_API_URL: Production Notification API URL must use HTTPS/],
    ['no OTP HMAC key', { OTP_HMAC_KEY_B64: '' }, /OTP_HMAC_KEY_B64: The server-only OTP HMAC key is required/],
    ['no trusted proxy list', { TRUST_PROXY_CIDRS: '' }, /TRUST_PROXY_CIDRS: Approved reverse-proxy CIDRs are required/],
  ])('refuses %s in production', (_label, values, message) => {
    production(); Object.assign(process.env, values); resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(message);
  });

  it('keeps every NIN holder route flag off by default, with the default holder and in-person budgets', () => {
    production(); resetEnvironmentForTests();
    expect(getEnvironment()).toMatchObject({ QOREID_NIN_ONLY_ENROLLMENT_ENABLED: false, NIN_HOLDER_SMS_ENABLED: false,
      ASSISTED_REGISTRATION_ENABLED: false, QOREID_PATIENT_SELF_NIN_BINDING_ENABLED: false,
      NIN_HOLDER_SMS_DAILY_MAX: 5, NIN_HOLDER_FAILURES_DAILY_MAX: 10, NIN_HOLDER_FAILURES_MONTHLY_MAX: 30,
      NIN_HOLDER_DISTINCT_NINS_MAX: 5, ASSISTED_VERIFICATION_STAFF_DAILY_MAX: 20,
      ASSISTED_VERIFICATION_FACILITY_DAILY_MAX: 100 });
  });

  // ADR-063: in-person checks per staff member and per facility over a
  // sliding 24 hours, every outcome counted.
  it('bounds the in-person check budgets and keeps the facility budget at or above the staff one', () => {
    production(); Object.assign(process.env, { ASSISTED_VERIFICATION_STAFF_DAILY_MAX: '50',
      ASSISTED_VERIFICATION_FACILITY_DAILY_MAX: '40' });
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(
      /ASSISTED_VERIFICATION_FACILITY_DAILY_MAX: The facility budget of in-person checks cannot be below the staff budget/);
    for (const [name, value] of [['ASSISTED_VERIFICATION_STAFF_DAILY_MAX', '0'],
      ['ASSISTED_VERIFICATION_STAFF_DAILY_MAX', '201'], ['ASSISTED_VERIFICATION_FACILITY_DAILY_MAX', '1001']] as const) {
      production(); delete process.env.ASSISTED_VERIFICATION_STAFF_DAILY_MAX;
      delete process.env.ASSISTED_VERIFICATION_FACILITY_DAILY_MAX;
      Object.assign(process.env, { [name]: value }); resetEnvironmentForTests();
      expect(() => getEnvironment()).toThrow(new RegExp(name));
    }
  });

  it('accepts the online NIN holder route in production only with the facility route', () => {
    production(); Object.assign(process.env, qoreId, { QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'true',
      NIN_HOLDER_SMS_ENABLED: 'true', ASSISTED_REGISTRATION_ENABLED: 'true' });
    resetEnvironmentForTests();
    expect(getEnvironment()).toMatchObject({ NIN_HOLDER_SMS_ENABLED: true, ASSISTED_REGISTRATION_ENABLED: true });
  });

  it.each<[string, string, string | undefined]>([
    ['the staging deployment profile', 'production', 'staging'],
    ['local development', 'development', undefined],
    ['tests', 'test', undefined],
  ])('accepts NIN-only enrollment with the online holder route in %s', (_label, nodeEnvironment, deployment) => {
    production(); Object.assign(process.env, qoreId, { QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'true',
      NIN_HOLDER_SMS_ENABLED: 'true', NODE_ENV: nodeEnvironment });
    // A staging task serves the staging hosts (Turnstile allowlist, TS-9).
    if (deployment) Object.assign(process.env, { HID_DEPLOYMENT_ENV: deployment, CORS_ORIGINS: 'https://staging.healthidentitydirectory.com' });
    else delete process.env.HID_DEPLOYMENT_ENV;
    resetEnvironmentForTests();
    expect(getEnvironment()).toMatchObject({ QOREID_NIN_ONLY_ENROLLMENT_ENABLED: true, NIN_HOLDER_SMS_ENABLED: true });
  });

  it('accepts NIN-only enrollment in production with the facility route alone', () => {
    // ADR-063: the facility route opens only while an active designation
    // exists; until then every start answers PATIENT_REGISTRATION_NOT_OPEN.
    production(); Object.assign(process.env, qoreId, { QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'true',
      ASSISTED_REGISTRATION_ENABLED: 'true' });
    resetEnvironmentForTests();
    expect(getEnvironment()).toMatchObject({ QOREID_NIN_ONLY_ENROLLMENT_ENABLED: true, NIN_HOLDER_SMS_ENABLED: false });
  });

  it('refuses NIN-only enrollment without a holder route anywhere, and without QoreID', () => {
    production(); Object.assign(process.env, qoreId, { QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'true', NODE_ENV: 'test' });
    delete process.env.HID_DEPLOYMENT_ENV; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/NIN-only enrollment requires NIN_HOLDER_SMS_ENABLED or ASSISTED_REGISTRATION_ENABLED/);
    production(); Object.assign(process.env, { QOREID_ENABLED: 'false', QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'true',
      NIN_HOLDER_SMS_ENABLED: 'true', HID_DEPLOYMENT_ENV: 'staging', CORS_ORIGINS: 'https://staging.healthidentitydirectory.com' });
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/NIN-only enrollment requires enabled QoreID verification/);
  });

  it('applies the production holder rules under the production deployment profile whatever NODE_ENV says', () => {
    production(); Object.assign(process.env, qoreId, { QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'true',
      NIN_HOLDER_SMS_ENABLED: 'true', NODE_ENV: 'test' });
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/online NIN holder route needs ASSISTED_REGISTRATION_ENABLED in production/);
    production(); Object.assign(process.env, { QOREID_PATIENT_SELF_NIN_BINDING_ENABLED: 'true', NODE_ENV: 'test' });
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/signed-in NIN binding is refused in production/);
  });

  it('allows the signed-in NIN binding outside production only when set, and checks the holder budgets', () => {
    production(); Object.assign(process.env, { QOREID_PATIENT_SELF_NIN_BINDING_ENABLED: 'true',
      HID_DEPLOYMENT_ENV: 'staging', CORS_ORIGINS: 'https://staging.healthidentitydirectory.com' });
    resetEnvironmentForTests();
    expect(getEnvironment().QOREID_PATIENT_SELF_NIN_BINDING_ENABLED).toBe(true);
    production(); Object.assign(process.env, { NIN_HOLDER_FAILURES_DAILY_MAX: '20', NIN_HOLDER_FAILURES_MONTHLY_MAX: '19' });
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/monthly holder failure budget cannot be below the daily one/);
    // A code's attempts count against the daily failure budget before it is
    // sent (ADR-062): a budget below one code's attempts would send nothing.
    delete process.env.QOREID_PATIENT_SELF_NIN_BINDING_ENABLED; delete process.env.NIN_HOLDER_FAILURES_MONTHLY_MAX;
    production(); Object.assign(process.env, { NIN_HOLDER_FAILURES_DAILY_MAX: '4', OTP_MAX_ATTEMPTS: '5' });
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/NIN_HOLDER_FAILURES_DAILY_MAX: The daily holder failure budget cannot be below OTP_MAX_ATTEMPTS/);
    production(); Object.assign(process.env, { NIN_HOLDER_FAILURES_DAILY_MAX: '5', OTP_MAX_ATTEMPTS: '5' });
    resetEnvironmentForTests();
    expect(getEnvironment().NIN_HOLDER_FAILURES_DAILY_MAX).toBe(5);
    for (const [key, value] of [['NIN_HOLDER_SMS_DAILY_MAX', '0'], ['NIN_HOLDER_SMS_DAILY_MAX', '51'],
      ['NIN_HOLDER_FAILURES_DAILY_MAX', '101'], ['NIN_HOLDER_DISTINCT_NINS_MAX', '0']] as const) {
      production(); process.env[key] = value; resetEnvironmentForTests();
      expect(() => getEnvironment()).toThrow(new RegExp(key));
    }
  });

  it('keeps emergency-contact delivery disabled by default and refuses it in production', () => {
    production(); resetEnvironmentForTests();
    expect(getEnvironment().EMERGENCY_CONTACT_DELIVERY_ENABLED).toBe(false);

    production(); process.env.EMERGENCY_CONTACT_DELIVERY_ENABLED = 'true'; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/emergency-contact delivery is not approved/);

    production(); Object.assign(process.env, {
      EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true', HID_DEPLOYMENT_ENV: 'staging',
      CORS_ORIGINS: 'https://staging.healthidentitydirectory.com',
    }); resetEnvironmentForTests();
    expect(getEnvironment().EMERGENCY_CONTACT_DELIVERY_ENABLED).toBe(true);
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

describe('Public patient enrollment QoreID lookup quota', () => {
  const original = { ...process.env };
  const keys = ['PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX', 'PATIENT_ENROLLMENT_QOREID_NETWORK_DAILY_MAX',
    'PATIENT_ENROLLMENT_QOREID_DAILY_CAP'];
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

  function limits(): unknown[] {
    const environment: Record<string, unknown> = getEnvironment();
    return keys.map((key) => environment[key]);
  }

  it('defaults to 5 lookups an hour and 15 a day per client network, and 200 a day in all', () => {
    local();
    expect(limits()).toEqual([5, 15, 200]);
  });

  it('accepts limits within their bounds and refuses others', () => {
    local({ [keys[0]!]: '1', [keys[1]!]: '1', [keys[2]!]: '1' });
    expect(limits()).toEqual([1, 1, 1]);
    local({ [keys[0]!]: '100', [keys[1]!]: '1000', [keys[2]!]: '100000' });
    expect(limits()).toEqual([100, 1000, 100000]);
    const outside: Array<[string, string]> = [[keys[0]!, '0'], [keys[0]!, '101'], [keys[1]!, '0'],
      [keys[1]!, '1001'], [keys[2]!, '0'], [keys[2]!, '100001']];
    for (const [key, value] of outside) {
      local({ [key]: value });
      expect(() => getEnvironment()).toThrow(new RegExp(`${key}: `));
    }
  });

  it('refuses an hourly network limit above the daily one', () => {
    local({ [keys[0]!]: '20', [keys[1]!]: '15' });
    expect(() => getEnvironment()).toThrow(/PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX: /);
  });
});

describe('Clinician self sign-up limits (ADR-064)', () => {
  const original = { ...process.env };
  const operations = ['SIGNUP', 'STATUS', 'SEARCH', 'SUBMIT'] as const;
  const keys = [
    ...operations.flatMap((operation) => ['NETWORK_HOURLY', 'NETWORK_DAILY', 'PLATFORM_DAILY']
      .map((limit) => `CLINICIAN_APPLICATION_${operation}_${limit}_LIMIT`)),
    'CLINICIAN_APPLICATION_FACILITY_OPEN_LIMIT', 'CLINICIAN_APPLICATION_SWEEP_SECONDS',
  ];
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

  function values(): unknown[] {
    const environment: Record<string, unknown> = getEnvironment();
    return keys.map((key) => environment[key]);
  }

  it('defaults to the design values', () => {
    local();
    expect(values()).toEqual([20, 60, 1000, 20, 60, 2000, 120, 500, 20000, 5, 10, 200, 30, 900]);
  });

  it('accepts each limit at its bounds and refuses one outside them', () => {
    const bounds: Record<string, [number, number]> = {
      SIGNUP_NETWORK_HOURLY: [1, 200], SIGNUP_NETWORK_DAILY: [1, 2000], SIGNUP_PLATFORM_DAILY: [1, 100000],
      STATUS_NETWORK_HOURLY: [1, 200], STATUS_NETWORK_DAILY: [1, 2000], STATUS_PLATFORM_DAILY: [1, 100000],
      SEARCH_NETWORK_HOURLY: [1, 1000], SEARCH_NETWORK_DAILY: [1, 5000], SEARCH_PLATFORM_DAILY: [1, 100000],
      SUBMIT_NETWORK_HOURLY: [1, 200], SUBMIT_NETWORK_DAILY: [1, 2000], SUBMIT_PLATFORM_DAILY: [1, 100000],
    };
    for (const [name, [minimum, maximum]] of Object.entries(bounds)) {
      const key = `CLINICIAN_APPLICATION_${name}_LIMIT`;
      const hourly = key.replace('_NETWORK_DAILY_', '_NETWORK_HOURLY_');
      // A daily limit's minimum is its hourly one: set that to 1 to test the bound itself.
      const pair = key.includes('_NETWORK_DAILY_') ? { [hourly]: '1' } : {};
      local({ ...pair, [key]: String(minimum) });
      expect((getEnvironment() as Record<string, unknown>)[key]).toBe(minimum);
      local({ ...(key.includes('_NETWORK_HOURLY_') ? { [key.replace('_HOURLY_', '_DAILY_')]: String(bounds[name.replace('HOURLY', 'DAILY')]![1]) } : {}),
        [key]: String(maximum) });
      expect((getEnvironment() as Record<string, unknown>)[key]).toBe(maximum);
      for (const outside of [minimum - 1, maximum + 1]) {
        local({ ...pair, [key]: String(outside) });
        expect(() => getEnvironment()).toThrow(new RegExp(`${key}: `));
      }
    }
    for (const [key, minimum, maximum] of [['CLINICIAN_APPLICATION_FACILITY_OPEN_LIMIT', 1, 500],
      ['CLINICIAN_APPLICATION_SWEEP_SECONDS', 60, 3600]] as const) {
      local({ [key]: String(minimum) });
      expect((getEnvironment() as Record<string, unknown>)[key]).toBe(minimum);
      local({ [key]: String(maximum) });
      expect((getEnvironment() as Record<string, unknown>)[key]).toBe(maximum);
      for (const outside of [minimum - 1, maximum + 1]) {
        local({ [key]: String(outside) });
        expect(() => getEnvironment()).toThrow(new RegExp(`${key}: `));
      }
    }
  });

  it('refuses a network hourly limit above its daily one', () => {
    for (const operation of operations) {
      local({ [`CLINICIAN_APPLICATION_${operation}_NETWORK_HOURLY_LIMIT`]: '11',
        [`CLINICIAN_APPLICATION_${operation}_NETWORK_DAILY_LIMIT`]: '10' });
      expect(() => getEnvironment()).toThrow(new RegExp(`CLINICIAN_APPLICATION_${operation}_NETWORK_HOURLY_LIMIT: `));
    }
  });
});
