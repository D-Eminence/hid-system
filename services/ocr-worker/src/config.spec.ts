import { readOcrWorkerConfig } from './config';

const base = {
  NODE_ENV: 'test', OCR_PROVIDER: 'test',
  OCR_WORKER_DATABASE_URL: 'postgresql://worker:secret@localhost:5432/hid',
  OCR_WORKER_SUBJECT: 'workload:ocr:test',
};

describe('OCR worker configuration', () => {
  it('allows the deterministic provider only in tests', () => {
    expect(readOcrWorkerConfig(base).OCR_PROVIDER).toBe('test');
    expect(() => readOcrWorkerConfig({ ...base, NODE_ENV: 'development' })).toThrow(/restricted/);
  });

  it('fails closed unless production uses Textract with database TLS and a CA', () => {
    expect(() => readOcrWorkerConfig({ ...base, NODE_ENV: 'production', OCR_PROVIDER: 'disabled' }))
      .toThrow(/Production requires/);
    expect(() => readOcrWorkerConfig({ ...base, NODE_ENV: 'production', OCR_PROVIDER: 'textract' }))
      .toThrow(/TLS/);
  });

  it('rejects partial explicit AWS credentials', () => {
    expect(() => readOcrWorkerConfig({ ...base, AWS_ACCESS_KEY_ID: 'access-only' }))
      .toThrow(/provided together/);
  });

  it('rejects production database URL overrides and a global TLS bypass', () => {
    const production = { ...base, NODE_ENV: 'production', OCR_PROVIDER: 'textract',
      OCR_WORKER_DATABASE_SSL: 'true', OCR_WORKER_DATABASE_SSL_ROOT_CERT_BASE64: 'trusted-ca' };
    expect(() => readOcrWorkerConfig({ ...production,
      OCR_WORKER_DATABASE_URL: `${base.OCR_WORKER_DATABASE_URL}?sslmode=no-verify` }))
      .toThrow(/must not override/);
    expect(() => readOcrWorkerConfig({ ...production, NODE_TLS_REJECT_UNAUTHORIZED: '0' }))
      .toThrow(/cannot be disabled globally/);
  });
});
