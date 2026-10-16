import { getEnvironment, resetEnvironmentForTests } from './environment';

// Imported legacy medical history (owner decision 3 of 2026-10-16, ADR-067):
// one flag for the patient's own read (part of the patient record release
// set) and one for the staff read, both off by default. The production
// profile refuses both until the DPO and the owner sign off the provenance,
// scope and retention of the legacy data and Health-id renders the history
// (release checklist P38); staging and a local development run may opt in.
describe('EHR imported history flags', () => {
  const original = { ...process.env };
  const local = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost/hid', CORS_ORIGINS: 'http://127.0.0.1',
    STORAGE_MODE: 'disabled' } as const;
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
  const flags = ['EHR_PATIENT_RELEASE_IMPORTED_HISTORY', 'EHR_STAFF_IMPORTED_HISTORY_ENABLED'] as const;

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

  it('turns neither the patient nor the staff read on by default', () => {
    configure(local);
    const environment = getEnvironment();
    expect(environment.EHR_PATIENT_RELEASE_IMPORTED_HISTORY).toBe(false);
    expect(environment.EHR_STAFF_IMPORTED_HISTORY_ENABLED).toBe(false);
  });

  it('accepts only true or false', () => {
    configure(local, { EHR_STAFF_IMPORTED_HISTORY_ENABLED: 'yes' });
    expect(() => getEnvironment()).toThrow(/EHR_STAFF_IMPORTED_HISTORY_ENABLED/);
  });

  it.each(flags)('lets a development run and staging set %s', (flag) => {
    configure(local, { HID_DEPLOYMENT_ENV: 'development', [flag]: 'true' });
    expect(getEnvironment()[flag]).toBe(true);
    configure(production, { HID_DEPLOYMENT_ENV: 'staging', [flag]: 'true' });
    expect(getEnvironment()[flag]).toBe(true);
  });

  it.each(flags)('refuses %s in the production profile until the P38 sign-off', (flag) => {
    configure(production, { [flag]: 'true' });
    expect(() => getEnvironment()).toThrow(new RegExp(`${flag}: .*P38`));
    configure(local, { [flag]: 'true' });
    expect(() => getEnvironment()).toThrow(new RegExp(`${flag}: .*P38`));
  });

  it('starts the production profile with both flags off', () => {
    configure(production);
    const environment = getEnvironment();
    expect(environment.EHR_PATIENT_RELEASE_IMPORTED_HISTORY).toBe(false);
    expect(environment.EHR_STAFF_IMPORTED_HISTORY_ENABLED).toBe(false);
  });
});
