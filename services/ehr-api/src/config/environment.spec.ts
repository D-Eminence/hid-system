import { getEnvironment, resetEnvironmentForTests } from './environment';

describe('EHR production database transport', () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  function production(): void {
    Object.assign(process.env, {
      NODE_ENV: 'production', DATABASE_URL: 'postgresql://ehr:test@db.example/hid',
      WORKLOAD_DATABASE_URL: 'postgresql://scanner:test@db.example/hid', DATABASE_SSL: 'true',
      DATABASE_SSL_ROOT_CERT_BASE64: 'trusted-ca', CORS_ORIGINS: 'https://app.example',
      TRUST_PROXY_CIDRS: '10.0.0.0/8',
      IDENTITY_API_URL: 'https://identity.example', IDENTITY_SERVICE_IDENTITY_MODE: 'jwt',
      IDENTITY_EHR_WORKLOAD_TOKEN_FILE: '/var/run/secrets/identity.jwt',
      LAB_API_URL: 'https://lab.example', LAB_SERVICE_IDENTITY_MODE: 'jwt',
      LAB_EHR_WORKLOAD_TOKEN_FILE: '/var/run/secrets/lab.jwt',
      PHARMACY_API_URL: 'https://pharmacy.example', PHARMACY_SERVICE_IDENTITY_MODE: 'jwt',
      PHARMACY_EHR_WORKLOAD_TOKEN_FILE: '/var/run/secrets/pharmacy.jwt',
      EHR_SERVICE_IDENTITY_MODE: 'jwt', EHR_WORKLOAD_ISSUER_URL: 'https://workloads.example',
      EHR_WORKLOAD_AUDIENCE: 'hid-ehr-api', EHR_WORKLOAD_JWKS_URL: 'https://workloads.example/jwks',
      EHR_OCR_CALLER_SUBJECT: 'workload:ocr', OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE: 'jwt',
      OUTREACH_CALLER_SUBJECT: 'workload:outreach',
      STORAGE_MODE: 's3', S3_BUCKET: 'hid-documents', S3_REGION: 'eu-west-1', S3_KMS_KEY_ID: 'kms-key',
    });
  }

  it('rejects primary and workload URL TLS overrides plus a global bypass', () => {
    production(); process.env.DATABASE_URL += '?sslmode=no-verify'; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/must not override/);
    production(); process.env.WORKLOAD_DATABASE_URL += '?sslmode=disable'; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/must not override/);
    production(); process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/cannot be disabled globally/);
  });
});
