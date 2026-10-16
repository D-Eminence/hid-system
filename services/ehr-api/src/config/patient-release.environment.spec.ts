import { getEnvironment, isProductionProfile, resetEnvironmentForTests } from './environment';

// Patient record release (owner decision 4 of 2026-10-16, D7): one flag per
// category, all off by default. Lab results stay refused in the production
// profile while the Lab module is withdrawn at launch (D17, 0091 section 2);
// staging (HID_DEPLOYMENT_ENV=staging, which every ECS task also runs with
// NODE_ENV=production) and development may opt in.
describe('EHR patient record release flags', () => {
  const original = { ...process.env };
  const local = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost/hid', CORS_ORIGINS: 'http://127.0.0.1',
    STORAGE_MODE: 's3', S3_BUCKET: 'synthetic-bucket' } as const;
  const production = {
    NODE_ENV: 'production', HID_DEPLOYMENT_ENV: 'production', DATABASE_URL: 'postgresql://ehr:test@db.example/hid',
    WORKLOAD_DATABASE_URL: 'postgresql://scanner:test@db.example/hid', DATABASE_SSL: 'true',
    DATABASE_SSL_ROOT_CERT_BASE64: 'trusted-ca', CORS_ORIGINS: 'https://www.healthidentitydirectory.com',
    TRUST_PROXY_CIDRS: '10.40.0.0/16',
    IDENTITY_API_URL: 'https://identity.internal.example', IDENTITY_SERVICE_IDENTITY_MODE: 'jwt',
    IDENTITY_EHR_WORKLOAD_TOKEN_FILE: '/var/run/hid/workload-tokens/identity.jwt',
    LAB_API_URL: 'https://lab.internal.example', LAB_SERVICE_IDENTITY_MODE: 'jwt',
    LAB_EHR_WORKLOAD_TOKEN_FILE: '/var/run/hid/workload-tokens/lab.jwt',
    PHARMACY_API_URL: 'https://pharmacy.internal.example', PHARMACY_SERVICE_IDENTITY_MODE: 'jwt',
    PHARMACY_EHR_WORKLOAD_TOKEN_FILE: '/var/run/hid/workload-tokens/pharmacy.jwt',
    EHR_SERVICE_IDENTITY_MODE: 'jwt', EHR_WORKLOAD_ISSUER_URL: 'https://issuer.example/production',
    EHR_WORKLOAD_AUDIENCE: 'hid-ehr-api', EHR_WORKLOAD_JWKS_URL: 'https://issuer.example/production/.well-known/jwks.json',
    EHR_OCR_CALLER_SUBJECT: 'hid:production:ocr-api', OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE: 'jwt',
    OUTREACH_CALLER_SUBJECT: 'hid:production:outreach-api',
    STORAGE_MODE: 's3', S3_BUCKET: 'hid-documents', S3_REGION: 'eu-west-1',
    S3_FORCE_PATH_STYLE: 'false', S3_KMS_KEY_ID: 'arn:aws:kms:eu-west-1:000000000000:key/00000000-0000-4000-8000-000000000001',
  } as const;
  const flags = ['EHR_PATIENT_RELEASE_VITALS', 'EHR_PATIENT_RELEASE_DIAGNOSES', 'EHR_PATIENT_RELEASE_PRESCRIPTIONS',
    'EHR_PATIENT_RELEASE_LAB_RESULTS', 'EHR_PATIENT_RELEASE_DOCUMENTS'] as const;

  function configure(base: Record<string, string>, changes: Record<string, string | undefined> = {}): void {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original, base);
    for (const key of [...flags, 'HID_DEPLOYMENT_ENV', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
      if (!(key in base)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvironmentForTests();
  }

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('releases no further category by default, and the deployment profile defaults to production', () => {
    configure(local);
    const environment = getEnvironment();
    for (const flag of flags) expect(environment[flag]).toBe(false);
    expect(environment.HID_DEPLOYMENT_ENV).toBe('production');
    configure(production);
    for (const flag of flags) expect(getEnvironment()[flag]).toBe(false);
  });

  it.each(flags)('accepts only true or false for %s', (flag) => {
    configure(local, { HID_DEPLOYMENT_ENV: 'development', [flag]: 'yes' });
    expect(() => getEnvironment()).toThrow(new RegExp(flag));
  });

  it.each([
    ['production', { ...production }],
    ['NODE_ENV production with no deployment profile', { ...production, HID_DEPLOYMENT_ENV: undefined }],
    ['a local run with no deployment profile', { ...local }],
  ])('refuses Lab results in %s (D17)', (_label, base) => {
    const { HID_DEPLOYMENT_ENV: profile, ...rest } = base as Record<string, string | undefined>;
    configure(rest as Record<string, string>, { HID_DEPLOYMENT_ENV: profile, EHR_PATIENT_RELEASE_LAB_RESULTS: 'true' });
    expect(() => getEnvironment()).toThrow(/EHR_PATIENT_RELEASE_LAB_RESULTS: Lab results are not released to patients/);
  });

  it('accepts Lab results on staging and in development, where a Lab module may run', () => {
    configure(production, { HID_DEPLOYMENT_ENV: 'staging', EHR_PATIENT_RELEASE_LAB_RESULTS: 'true' });
    expect(getEnvironment().EHR_PATIENT_RELEASE_LAB_RESULTS).toBe(true);
    configure(local, { HID_DEPLOYMENT_ENV: 'development', EHR_PATIENT_RELEASE_LAB_RESULTS: 'true' });
    expect(getEnvironment().EHR_PATIENT_RELEASE_LAB_RESULTS).toBe(true);
  });

  it('accepts the four approved EHR categories in production', () => {
    configure(production, { EHR_PATIENT_RELEASE_VITALS: 'true', EHR_PATIENT_RELEASE_DIAGNOSES: 'true',
      EHR_PATIENT_RELEASE_PRESCRIPTIONS: 'true', EHR_PATIENT_RELEASE_DOCUMENTS: 'true' });
    const environment = getEnvironment();
    expect([environment.EHR_PATIENT_RELEASE_VITALS, environment.EHR_PATIENT_RELEASE_DIAGNOSES,
      environment.EHR_PATIENT_RELEASE_PRESCRIPTIONS, environment.EHR_PATIENT_RELEASE_DOCUMENTS])
      .toEqual([true, true, true, true]);
  });

  it('refuses releasing documents without S3 storage, where no patient could download them', () => {
    configure({ ...local, STORAGE_MODE: 'disabled' }, { HID_DEPLOYMENT_ENV: 'development', S3_BUCKET: undefined,
      EHR_PATIENT_RELEASE_DOCUMENTS: 'true' });
    expect(() => getEnvironment()).toThrow(/EHR_PATIENT_RELEASE_DOCUMENTS: .*S3 storage/);
  });

  it('treats only staging and development as outside the production profile', () => {
    expect(isProductionProfile({ HID_DEPLOYMENT_ENV: 'production', NODE_ENV: 'test' })).toBe(true);
    expect(isProductionProfile({ HID_DEPLOYMENT_ENV: 'staging', NODE_ENV: 'production' })).toBe(false);
    expect(isProductionProfile({ HID_DEPLOYMENT_ENV: 'development', NODE_ENV: 'production' })).toBe(true);
    expect(isProductionProfile({ HID_DEPLOYMENT_ENV: 'development', NODE_ENV: 'test' })).toBe(false);
  });
});
