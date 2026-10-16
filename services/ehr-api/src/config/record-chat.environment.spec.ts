import { getEnvironment, resetEnvironmentForTests } from './environment';
import { recordChatConfig } from '../ehr/record-chat/record-chat.config';

// Patient record chat (owner decision 1 of 2026-10-16). Off by default. With
// the flag on, every setting a request needs must be present and nothing has
// a default model. NODE_ENV=production (every deployed environment, staging
// included) also needs the recorded external-processing approval (an
// accepted ADR and its date) and the first-party API origin. Any ambient
// ANTHROPIC_* variable is refused while chat is on, so the SDK's own
// credential, endpoint, header and log chain is never used.
describe('EHR patient record chat configuration', () => {
  const original = { ...process.env };
  // A placeholder that is clearly not a real model id.
  const MODEL = 'synthetic-test-model';
  const DIGEST_KEY = Buffer.alloc(32, 7).toString('base64');
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
  const chat = {
    RECORD_CHAT_PATIENT_ENABLED: 'true', RECORD_CHAT_MODEL_ID: MODEL,
    RECORD_CHAT_ANTHROPIC_API_KEY: 'synthetic-api-key-0123456789abcdef', RECORD_CHAT_INFERENCE_GEO: 'us',
    RECORD_CHAT_AUDIT_DIGEST_KEY_B64: DIGEST_KEY, RECORD_CHAT_NOTICE_VERSION: 'notice-2026-10',
    RECORD_CHAT_DAILY_TOKEN_BUDGET: '2000000',
  } as const;
  const approval = { RECORD_CHAT_PROCESSING_APPROVAL: 'ADR-999@2026-10-01' } as const;

  function configure(base: Record<string, string>, changes: Record<string, string | undefined> = {}): void {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, base);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvironmentForTests();
  }

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('is off by default, and no model id exists anywhere unless configured', () => {
    configure(local);
    const environment = getEnvironment();
    expect(environment.RECORD_CHAT_PATIENT_ENABLED).toBe(false);
    expect(environment.RECORD_CHAT_MODEL_ID).toBeUndefined();
    const config = recordChatConfig(environment);
    expect(config.patientEnabled).toBe(false);
    expect(config.modelId).toBeUndefined();
    expect(config).toMatchObject({ baseUrl: 'https://api.anthropic.com', maxOutputTokens: 4096, deadlineMs: 25_000,
      maxRetries: 0, maxEvidenceChars: 40_000 });
    configure(production);
    expect(getEnvironment().RECORD_CHAT_PATIENT_ENABLED).toBe(false);
  });

  it('starts with every setting in place, and reads them as given', () => {
    configure(local, chat);
    const config = recordChatConfig(getEnvironment());
    expect(config).toMatchObject({ patientEnabled: true, modelId: MODEL, inferenceGeo: 'us', noticeVersion: 'notice-2026-10',
      dailyTokenBudget: 2_000_000 });
    expect(config.auditDigestKey?.length).toBe(32);
  });

  it.each([
    ['RECORD_CHAT_MODEL_ID', /RECORD_CHAT_MODEL_ID: Record chat needs RECORD_CHAT_MODEL_ID/],
    ['RECORD_CHAT_ANTHROPIC_API_KEY', /RECORD_CHAT_ANTHROPIC_API_KEY: /],
    ['RECORD_CHAT_INFERENCE_GEO', /RECORD_CHAT_INFERENCE_GEO: /],
    ['RECORD_CHAT_AUDIT_DIGEST_KEY_B64', /RECORD_CHAT_AUDIT_DIGEST_KEY_B64: /],
    ['RECORD_CHAT_NOTICE_VERSION', /RECORD_CHAT_NOTICE_VERSION: /],
    ['RECORD_CHAT_DAILY_TOKEN_BUDGET', /RECORD_CHAT_DAILY_TOKEN_BUDGET: /],
  ])('refuses to start enabled without %s', (key, message) => {
    configure(local, { ...chat, [key]: undefined });
    expect(() => getEnvironment()).toThrow(message);
  });

  it.each([
    ['a model id with spaces', { RECORD_CHAT_MODEL_ID: 'not a model' }, /RECORD_CHAT_MODEL_ID/],
    ['a short key', { RECORD_CHAT_ANTHROPIC_API_KEY: 'short' }, /RECORD_CHAT_ANTHROPIC_API_KEY/],
    ['a key with whitespace', { RECORD_CHAT_ANTHROPIC_API_KEY: 'synthetic api key 0123456789' }, /RECORD_CHAT_ANTHROPIC_API_KEY/],
    ['an unknown geography', { RECORD_CHAT_INFERENCE_GEO: 'eu' }, /RECORD_CHAT_INFERENCE_GEO/],
    ['a 16-byte digest key', { RECORD_CHAT_AUDIT_DIGEST_KEY_B64: Buffer.alloc(16, 1).toString('base64') },
      /RECORD_CHAT_AUDIT_DIGEST_KEY_B64/],
    ['a notice version over 40 characters', { RECORD_CHAT_NOTICE_VERSION: 'n'.repeat(41) }, /RECORD_CHAT_NOTICE_VERSION/],
    ['a budget above the hard ceiling', { RECORD_CHAT_DAILY_TOKEN_BUDGET: '20000001' }, /RECORD_CHAT_DAILY_TOKEN_BUDGET/],
    ['max output tokens below 1024', { RECORD_CHAT_MAX_OUTPUT_TOKENS: '1000' }, /RECORD_CHAT_MAX_OUTPUT_TOKENS/],
    ['max output tokens above 16000', { RECORD_CHAT_MAX_OUTPUT_TOKENS: '16001' }, /RECORD_CHAT_MAX_OUTPUT_TOKENS/],
    ['a deadline above 25 seconds', { RECORD_CHAT_DEADLINE_MS: '25001' }, /RECORD_CHAT_DEADLINE_MS/],
    ['a deadline below 5 seconds', { RECORD_CHAT_DEADLINE_MS: '4999' }, /RECORD_CHAT_DEADLINE_MS/],
    ['two retries', { RECORD_CHAT_MAX_RETRIES: '2' }, /RECORD_CHAT_MAX_RETRIES/],
    // A retry would send the same PHI again under one disclosure audit row (the record chat ADR):
    // never, in any environment.
    ['one retry', { RECORD_CHAT_MAX_RETRIES: '1' }, /RECORD_CHAT_MAX_RETRIES/],
    ['an evidence bound above 90000', { RECORD_CHAT_MAX_EVIDENCE_CHARS: '90001' }, /RECORD_CHAT_MAX_EVIDENCE_CHARS/],
    ['an unknown effort', { RECORD_CHAT_EFFORT: 'max' }, /RECORD_CHAT_EFFORT/],
    ['a flag that is not true or false', { RECORD_CHAT_PATIENT_ENABLED: 'yes' }, /RECORD_CHAT_PATIENT_ENABLED/],
  ])('refuses %s', (_label, changes, message) => {
    configure(local, { ...chat, ...changes });
    expect(() => getEnvironment()).toThrow(message);
  });

  it.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_LOG', 'ANTHROPIC_PROFILE',
    'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'ANTHROPIC_WORKSPACE_ID',
    'ANTHROPIC_SOMETHING_NEW'])('refuses the ambient %s while chat is enabled', (name) => {
    configure(local, { ...chat, [name]: 'ambient-value' });
    expect(() => getEnvironment()).toThrow(new RegExp(`${name}: Ambient ANTHROPIC_\\* variables are refused`));
    configure(production, { ...chat, ...approval, [name]: 'ambient-value' });
    expect(() => getEnvironment()).toThrow(new RegExp(`${name}: Ambient`));
  });

  it('ignores an ambient ANTHROPIC_* variable while chat is off, since nothing reads it', () => {
    configure(local, { ANTHROPIC_BASE_URL: 'https://ambient.example.invalid' });
    expect(getEnvironment().RECORD_CHAT_PATIENT_ENABLED).toBe(false);
  });

  it('starts in production only with the recorded processing approval and the first-party origin', () => {
    configure(production, { ...chat, ...approval });
    expect(recordChatConfig(getEnvironment()).baseUrl).toBe('https://api.anthropic.com');
    configure(production, { ...chat, ...approval, RECORD_CHAT_API_BASE_URL: 'https://api.anthropic.com' });
    expect(getEnvironment().RECORD_CHAT_PATIENT_ENABLED).toBe(true);
    configure(production, { ...chat, ...approval, HID_DEPLOYMENT_ENV: 'staging' });
    expect(getEnvironment().RECORD_CHAT_PATIENT_ENABLED).toBe(true);
  });

  it.each([
    ['no approval', {}],
    ['an approval without a date', { RECORD_CHAT_PROCESSING_APPROVAL: 'ADR-999' }],
    ['an approval that names no ADR', { RECORD_CHAT_PROCESSING_APPROVAL: 'approved@2026-10-01' }],
    ['an impossible date', { RECORD_CHAT_PROCESSING_APPROVAL: 'ADR-999@2026-02-30' }],
    ['a date in the future', { RECORD_CHAT_PROCESSING_APPROVAL: 'ADR-999@2999-01-01' }],
  ])('refuses chat in production with %s', (_label, changes) => {
    configure(production, { ...chat, ...changes });
    expect(() => getEnvironment()).toThrow(/RECORD_CHAT_PROCESSING_APPROVAL: Record chat requires the recorded external-processing approval/);
    configure(production, { ...chat, ...changes, HID_DEPLOYMENT_ENV: 'staging' });
    expect(() => getEnvironment()).toThrow(/RECORD_CHAT_PROCESSING_APPROVAL/);
  });

  it.each(['https://proxy.example.invalid', 'http://api.anthropic.com'])(
    'refuses the base URL %s in production', (url) => {
      configure(production, { ...chat, ...approval, RECORD_CHAT_API_BASE_URL: url });
      expect(() => getEnvironment()).toThrow(/RECORD_CHAT_API_BASE_URL: Production record chat may only reach https:\/\/api\.anthropic\.com/);
    });

  it('allows a plain HTTP base URL only under NODE_ENV=test (the runtime verifier\'s local fake)', () => {
    configure(local, { ...chat, RECORD_CHAT_API_BASE_URL: 'http://127.0.0.1:9999' });
    expect(recordChatConfig(getEnvironment()).baseUrl).toBe('http://127.0.0.1:9999');
    configure({ ...local, NODE_ENV: 'development' }, { ...chat, RECORD_CHAT_API_BASE_URL: 'http://127.0.0.1:9999' });
    expect(() => getEnvironment()).toThrow(/RECORD_CHAT_API_BASE_URL must use HTTPS outside tests/);
  });

  it('needs nothing else while the flag is off, in production too', () => {
    configure(production, { RECORD_CHAT_PATIENT_ENABLED: 'false' });
    expect(getEnvironment().RECORD_CHAT_PATIENT_ENABLED).toBe(false);
  });
});
