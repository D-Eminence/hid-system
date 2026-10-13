import { getEnvironment, resetEnvironmentForTests } from './environment';

// CFG-PROD: every production configuration refusal of the EHR API, one row
// each. The base is the production task the CDK defines, which must start.
describe('EHR production configuration refusals', () => {
  const original = { ...process.env };
  const production = {
    NODE_ENV: 'production', DATABASE_URL: 'postgresql://ehr:test@db.example/hid',
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
  const localToken = 'synthetic-local-service-token-0123456789';

  function configure(changes: Record<string, string | undefined>): void {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original, production);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvironmentForTests();
  }

  afterEach(() => configure({}));
  afterAll(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('starts with the production task configuration', () => {
    configure({});
    expect(getEnvironment()).toMatchObject({ NODE_ENV: 'production', STORAGE_MODE: 's3' });
  });

  it.each<[string, Record<string, string | undefined>, string]>([
    ['static S3 credentials', { S3_ACCESS_KEY_ID: 'synthetic-access-key-id', S3_SECRET_ACCESS_KEY: 'synthetic-secret-access-key' },
      'Static S3 credentials are forbidden in production'],
    ['a static S3 access key alone', { S3_ACCESS_KEY_ID: 'synthetic-access-key-id' }, 'Static S3 credentials are forbidden in production'],
    ['a static S3 secret alone', { S3_SECRET_ACCESS_KEY: 'synthetic-secret-access-key' }, 'Static S3 credentials are forbidden in production'],
    ['wildcard CORS', { CORS_ORIGINS: '*' }, 'exact HTTPS origins'],
    ['a wildcard among CORS origins', { CORS_ORIGINS: 'https://www.healthidentitydirectory.com,*' }, 'exact HTTPS origins'],
    ['plain-HTTP CORS', { CORS_ORIGINS: 'http://www.healthidentitydirectory.com' }, 'exact HTTPS origins'],
    ['a CORS origin with a path', { CORS_ORIGINS: 'https://www.healthidentitydirectory.com/ehr' }, 'exact HTTPS origins'],
    ['local-secret Identity calls', { IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret' }, 'Production Identity calls require JWT'],
    ['local-secret Lab calls', { LAB_SERVICE_IDENTITY_MODE: 'local-secret' }, 'Production Lab calls require JWT'],
    ['local-secret Pharmacy calls', { PHARMACY_SERVICE_IDENTITY_MODE: 'local-secret' }, 'Production Pharmacy calls require JWT'],
    ['local-secret OCR-to-EHR calls', { EHR_SERVICE_IDENTITY_MODE: 'local-secret', EHR_INTERNAL_SERVICE_TOKEN: localToken },
      'Production OCR-to-EHR calls require JWT'],
    ['local-secret Outreach calls', { OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: localToken },
      'Production Outreach-to-Identity calls require JWT'],
    ['a local Identity token', { IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: localToken }, 'Local Identity service tokens are forbidden'],
    ['a local Lab token', { LAB_INTERNAL_SERVICE_TOKEN: localToken }, 'Local Lab service tokens are forbidden'],
    ['a local Pharmacy token', { PHARMACY_INTERNAL_SERVICE_TOKEN: localToken }, 'Local Pharmacy service tokens are forbidden'],
    ['a local EHR token', { EHR_INTERNAL_SERVICE_TOKEN: localToken }, 'Local EHR service tokens are forbidden'],
    ['a local Outreach token', { OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: localToken }, 'Local Outreach service tokens are forbidden'],
    ['database TLS off', { DATABASE_SSL: 'false' }, 'TLS is required in production'],
    ['no database CA', { DATABASE_SSL_ROOT_CERT_BASE64: undefined }, 'trusted PostgreSQL CA certificate'],
    ['a TLS override in the database URL', { DATABASE_URL: 'postgresql://ehr:test@db.example/hid?sslmode=disable' }, 'must not override'],
    ['a global TLS bypass', { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, 'cannot be disabled globally'],
    ['no proxy CIDRs', { TRUST_PROXY_CIDRS: undefined }, 'reverse-proxy CIDRs are required'],
    ['disabled storage', { STORAGE_MODE: 'disabled' }, 'S3 storage is required in production'],
    ['no document KMS key', { S3_KMS_KEY_ID: undefined }, 'KMS key is required'],
    ['a plain-HTTP S3 endpoint', { S3_ENDPOINT: 'http://minio.internal.example' }, 'S3_ENDPOINT must use HTTPS'],
    ['a plain-HTTP workload issuer', { EHR_WORKLOAD_ISSUER_URL: 'http://issuer.example/production' }, 'must use HTTPS'],
    ['no scanner database credential', { WORKLOAD_DATABASE_URL: undefined }, 'WORKLOAD_DATABASE_URL is required'],
  ])('refuses %s', (_label, changes, error) => {
    configure(changes);
    expect(() => getEnvironment()).toThrow(error);
  });

  it('still lets a non-production run use static S3 credentials, for local object storage', () => {
    configure({ NODE_ENV: 'development', S3_ACCESS_KEY_ID: 'synthetic-access-key-id',
      S3_SECRET_ACCESS_KEY: 'synthetic-secret-access-key', S3_ENDPOINT: 'http://127.0.0.1:9000' });
    expect(getEnvironment().S3_ACCESS_KEY_ID).toBe('synthetic-access-key-id');
  });
});
