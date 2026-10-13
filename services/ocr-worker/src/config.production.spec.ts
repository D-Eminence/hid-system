import { readOcrWorkerConfig } from './config';

// CFG-PROD: every production configuration refusal of the OCR worker, one row
// each. The base is the production task the CDK defines, which must start.
describe('OCR worker production configuration refusals', () => {
  const production = {
    NODE_ENV: 'production', OCR_PROVIDER: 'textract',
    OCR_WORKER_DATABASE_URL: 'postgresql://worker:test@db.example/hid',
    OCR_WORKER_SUBJECT: 'hid:production:ocr-api',
    OCR_WORKER_DATABASE_SSL: 'true', OCR_WORKER_DATABASE_SSL_ROOT_CERT_BASE64: 'trusted-ca',
    AWS_REGION: 'eu-west-1', S3_FORCE_PATH_STYLE: 'false',
  } as const;

  function read(changes: Record<string, string | undefined>) {
    const environment: NodeJS.ProcessEnv = { ...production };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete environment[key];
      else environment[key] = value;
    }
    return readOcrWorkerConfig(environment);
  }

  it('starts with the production task configuration and the task role', () => {
    const config = read({});
    expect(config.OCR_PROVIDER).toBe('textract');
    expect(config.AWS_ACCESS_KEY_ID).toBeUndefined();
  });

  it.each<[string, Record<string, string | undefined>, string]>([
    ['static AWS credentials', { AWS_ACCESS_KEY_ID: 'synthetic-access-key-id', AWS_SECRET_ACCESS_KEY: 'synthetic-secret-access-key' },
      'Static AWS credentials are forbidden in production'],
    ['a static AWS access key alone', { AWS_ACCESS_KEY_ID: 'synthetic-access-key-id' }, 'Static AWS credentials are forbidden in production'],
    ['a static AWS secret alone', { AWS_SECRET_ACCESS_KEY: 'synthetic-secret-access-key' }, 'Static AWS credentials are forbidden in production'],
    ['the disabled provider', { OCR_PROVIDER: 'disabled' }, 'Production requires the Textract OCR provider'],
    ['the test provider', { OCR_PROVIDER: 'test' }, 'restricted to NODE_ENV=test'],
    ['database TLS off', { OCR_WORKER_DATABASE_SSL: 'false' }, 'Production worker database TLS is required'],
    ['no database CA', { OCR_WORKER_DATABASE_SSL_ROOT_CERT_BASE64: undefined }, 'Production worker database CA is required'],
    ['a TLS override in the database URL', { OCR_WORKER_DATABASE_URL: 'postgresql://worker:test@db.example/hid?sslmode=disable' },
      'must not override'],
    ['a global TLS bypass', { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, 'cannot be disabled globally'],
    ['a plain-HTTP AWS endpoint', { AWS_ENDPOINT_URL: 'http://localstack.internal.example' }, 'Production AWS endpoint must use HTTPS'],
  ])('refuses %s', (_label, changes, error) => {
    expect(() => read(changes)).toThrow(error);
  });

  it('still lets a test run use explicit credentials for a local emulator', () => {
    expect(readOcrWorkerConfig({ ...production, NODE_ENV: 'test', OCR_PROVIDER: 'test',
      AWS_ACCESS_KEY_ID: 'synthetic-access-key-id', AWS_SECRET_ACCESS_KEY: 'synthetic-secret-access-key',
      AWS_ENDPOINT_URL: 'http://127.0.0.1:4566' }).AWS_ACCESS_KEY_ID).toBe('synthetic-access-key-id');
  });
});
