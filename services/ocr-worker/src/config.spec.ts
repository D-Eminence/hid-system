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

  it('keeps AI reading off by default with the agreed models and efforts', () => {
    const config = readOcrWorkerConfig(base);
    expect(config).toMatchObject({ OCR_AI_MODE: 'off', OCR_AI_FIRST_PASS_MODEL: 'claude-opus-5-5',
      OCR_AI_FIRST_PASS_EFFORT: 'high', OCR_AI_REREAD_MODEL: 'claude-opus-5-5', OCR_AI_REREAD_EFFORT: 'high',
      OCR_AI_MAX_TOKENS: 64_000, OCR_AI_MAX_REREAD_PAGES: 20, OCR_TEXTRACT_MAX_RETRIES: 3, OCR_TEXTRACT_MAX_PAGES: 20 });
    expect(config.OCR_AI_FACILITY_IDS).toBeUndefined();
  });

  it('requires a key and approved US processing for Claude reading', () => {
    expect(() => readOcrWorkerConfig({ ...base, OCR_AI_MODE: 'claude' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => readOcrWorkerConfig({ ...base, OCR_AI_MODE: 'claude', ANTHROPIC_API_KEY: 'sk-ant-fake-key-000000000' }))
      .toThrow(/OCR_AI_US_PROCESSING_APPROVED/);
    expect(() => readOcrWorkerConfig({ ...base, OCR_AI_MODE: 'claude', ANTHROPIC_API_KEY: 'short',
      OCR_AI_US_PROCESSING_APPROVED: 'true' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(readOcrWorkerConfig({ ...base, OCR_AI_MODE: 'claude', ANTHROPIC_API_KEY: 'sk-ant-fake-key-000000000',
      OCR_AI_US_PROCESSING_APPROVED: 'true' }).OCR_AI_MODE).toBe('claude');
  });

  it('says US processing when approval is missing', () => {
    expect(() => readOcrWorkerConfig({ ...base, OCR_AI_MODE: 'claude', ANTHROPIC_API_KEY: 'sk-ant-fake-key-000000000' }))
      .toThrow(/approved US processing/);
    expect(() => readOcrWorkerConfig({ ...base, OCR_AI_MODE: 'claude', ANTHROPIC_API_KEY: 'sk-ant-fake-key-000000000',
      OCR_AI_US_PROCESSING_APPROVED: 'false' })).toThrow(/OCR_AI_US_PROCESSING_APPROVED/);
  });

  it('does not accept the retired global-processing switch as approval', () => {
    const retired = { ...base, OCR_AI_MODE: 'claude', ANTHROPIC_API_KEY: 'sk-ant-fake-key-000000000',
      OCR_AI_GLOBAL_PROCESSING_APPROVED: 'true' };
    expect(() => readOcrWorkerConfig(retired)).toThrow(/OCR_AI_US_PROCESSING_APPROVED/);
    expect(readOcrWorkerConfig({ ...retired, OCR_AI_US_PROCESSING_APPROVED: 'true' }))
      .not.toHaveProperty('OCR_AI_GLOBAL_PROCESSING_APPROVED');
  });

  it('re-reads hard pages with the picture by default only when AI reading is on, and fails closed on other values', () => {
    const claude = { ...base, OCR_AI_MODE: 'claude', ANTHROPIC_API_KEY: 'sk-ant-fake-key-000000000',
      OCR_AI_US_PROCESSING_APPROVED: 'true' };
    expect(readOcrWorkerConfig(base).OCR_AI_IMAGE_REREAD).toBe('off');
    expect(readOcrWorkerConfig(claude).OCR_AI_IMAGE_REREAD).toBe('on');
    expect(readOcrWorkerConfig({ ...claude, OCR_AI_IMAGE_REREAD: '  ' }).OCR_AI_IMAGE_REREAD).toBe('on');
    expect(readOcrWorkerConfig({ ...claude, OCR_AI_IMAGE_REREAD: 'off' }).OCR_AI_IMAGE_REREAD).toBe('off');
    expect(readOcrWorkerConfig({ ...base, OCR_AI_IMAGE_REREAD: 'on' }).OCR_AI_IMAGE_REREAD).toBe('on');
    for (const value of ['yes', 'true', 'ON', '1', 'auto']) {
      expect(() => readOcrWorkerConfig({ ...claude, OCR_AI_IMAGE_REREAD: value })).toThrow(/OCR_AI_IMAGE_REREAD/);
    }
  });

  it('reads hard pages twice at max effort by default when AI reading is on, and fails closed on other values', () => {
    const claude = { ...base, OCR_AI_MODE: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000000000',
      OCR_AI_US_PROCESSING_APPROVED: 'true' };
    expect(readOcrWorkerConfig(base)).toMatchObject({ OCR_AI_HARD_PAGE_READS: 'off', OCR_AI_HARD_PAGE_EFFORT: 'max',
      OCR_AI_HARD_PAGE_TIMEOUT_MS: 900_000 });
    expect(readOcrWorkerConfig(claude).OCR_AI_HARD_PAGE_READS).toBe('on');
    expect(readOcrWorkerConfig({ ...claude, OCR_AI_HARD_PAGE_READS: ' ' }).OCR_AI_HARD_PAGE_READS).toBe('on');
    expect(readOcrWorkerConfig({ ...claude, OCR_AI_HARD_PAGE_READS: 'off' }).OCR_AI_HARD_PAGE_READS).toBe('off');
    expect(readOcrWorkerConfig({ ...claude, OCR_AI_HARD_PAGE_EFFORT: 'xhigh' }).OCR_AI_HARD_PAGE_EFFORT).toBe('xhigh');
    for (const value of ['yes', 'ON', 'true']) {
      expect(() => readOcrWorkerConfig({ ...claude, OCR_AI_HARD_PAGE_READS: value })).toThrow(/OCR_AI_HARD_PAGE_READS/);
    }
    for (const value of ['maximum', 'MAX', 'highest']) {
      expect(() => readOcrWorkerConfig({ ...claude, OCR_AI_HARD_PAGE_EFFORT: value })).toThrow(/OCR_AI_HARD_PAGE_EFFORT/);
    }
    for (const value of ['9999', '1800001']) {
      expect(() => readOcrWorkerConfig({ ...claude, OCR_AI_HARD_PAGE_TIMEOUT_MS: value })).toThrow(/OCR_AI_HARD_PAGE_TIMEOUT_MS/);
    }
  });

  it('sends pages with a masked number as pictures by default (owner decision), keeps them text-only when set to text_only, and fails closed', () => {
    expect(readOcrWorkerConfig(base).OCR_AI_IMAGE_MASKED_PAGES).toBe('send');
    expect(readOcrWorkerConfig({ ...base, OCR_AI_IMAGE_MASKED_PAGES: ' ' }).OCR_AI_IMAGE_MASKED_PAGES).toBe('send');
    expect(readOcrWorkerConfig({ ...base, OCR_AI_IMAGE_MASKED_PAGES: 'text_only' }).OCR_AI_IMAGE_MASKED_PAGES)
      .toBe('text_only');
    expect(readOcrWorkerConfig({ ...base, OCR_AI_IMAGE_MASKED_PAGES: 'send' }).OCR_AI_IMAGE_MASKED_PAGES).toBe('send');
    for (const value of ['yes', 'true', 'SEND', 'on', 'text-only']) {
      expect(() => readOcrWorkerConfig({ ...base, OCR_AI_IMAGE_MASKED_PAGES: value })).toThrow(/OCR_AI_IMAGE_MASKED_PAGES/);
    }
  });

  it('never echoes the key in a configuration error', () => {
    const key = 'sk-ant-fake key with spaces 0000';
    expect(() => readOcrWorkerConfig({ ...base, ANTHROPIC_API_KEY: key })).toThrow(/ANTHROPIC_API_KEY/);
    try { readOcrWorkerConfig({ ...base, ANTHROPIC_API_KEY: key }); } catch (error) {
      expect(String(error)).not.toContain(key);
    }
  });

  it('accepts only first-party Claude model ids and the five effort levels', () => {
    expect(() => readOcrWorkerConfig({ ...base, OCR_AI_FIRST_PASS_MODEL: 'anthropic.claude-sonnet-5-5' }))
      .toThrow(/OCR_AI_FIRST_PASS_MODEL/);
    expect(() => readOcrWorkerConfig({ ...base, OCR_AI_REREAD_MODEL: 'gpt-x' })).toThrow(/OCR_AI_REREAD_MODEL/);
    expect(() => readOcrWorkerConfig({ ...base, OCR_AI_REREAD_EFFORT: 'extreme' })).toThrow(/OCR_AI_REREAD_EFFORT/);
    expect(readOcrWorkerConfig({ ...base, OCR_AI_REREAD_EFFORT: 'xhigh' }).OCR_AI_REREAD_EFFORT).toBe('xhigh');
  });

  it('reads text only from Textract by default, with layout analysis as the one alternative', () => {
    expect(readOcrWorkerConfig(base).OCR_TEXTRACT_FEATURES).toBe('text');
    expect(readOcrWorkerConfig({ ...base, OCR_TEXTRACT_FEATURES: '' }).OCR_TEXTRACT_FEATURES).toBe('text');
    expect(readOcrWorkerConfig({ ...base, OCR_TEXTRACT_FEATURES: 'layout' }).OCR_TEXTRACT_FEATURES).toBe('layout');
    for (const value of ['tables', 'forms', 'LAYOUT', 'layout,tables']) {
      expect(() => readOcrWorkerConfig({ ...base, OCR_TEXTRACT_FEATURES: value })).toThrow(/OCR_TEXTRACT_FEATURES/);
    }
  });

  it('treats an unset, empty or blank facility list as every facility', () => {
    for (const value of [undefined, '', '   ']) {
      expect(readOcrWorkerConfig({ ...base, OCR_AI_FACILITY_IDS: value }).OCR_AI_FACILITY_IDS).toBeUndefined();
    }
  });

  it('rejects a facility list with no UUID or with anything that is not one', () => {
    for (const value of [',', ' , ', 'demo-hospital', '11111111-2222-4333-8444-555555555555,demo-hospital',
      '11111111-2222-4333-8444-55555555555']) {
      expect(() => readOcrWorkerConfig({ ...base, OCR_AI_FACILITY_IDS: value })).toThrow(/OCR_AI_FACILITY_IDS/);
    }
  });

  it('parses the facility allowlist as UUIDs', () => {
    expect(readOcrWorkerConfig({ ...base,
      OCR_AI_FACILITY_IDS: ' 11111111-2222-4333-8444-555555555555, 11111111-2222-4333-8444-555555555555 ,AAAAAAAA-2222-4333-8444-555555555555' })
      .OCR_AI_FACILITY_IDS).toEqual(['11111111-2222-4333-8444-555555555555', 'aaaaaaaa-2222-4333-8444-555555555555']);
    expect(readOcrWorkerConfig({ ...base, OCR_AI_FACILITY_IDS: '\t11111111-2222-4333-8444-555555555555 ,' })
      .OCR_AI_FACILITY_IDS).toEqual(['11111111-2222-4333-8444-555555555555']);
  });

  it('bounds retries, tokens and re-reads', () => {
    expect(() => readOcrWorkerConfig({ ...base, OCR_AI_MAX_RETRIES: '50' })).toThrow(/OCR_AI_MAX_RETRIES/);
    expect(() => readOcrWorkerConfig({ ...base, OCR_TEXTRACT_MAX_RETRIES: '-1' })).toThrow(/OCR_TEXTRACT_MAX_RETRIES/);
    expect(() => readOcrWorkerConfig({ ...base, OCR_AI_MAX_TOKENS: '500' })).toThrow(/OCR_AI_MAX_TOKENS/);
    expect(() => readOcrWorkerConfig({ ...base, OCR_AI_MAX_REREAD_PAGES: '21' })).toThrow(/OCR_AI_MAX_REREAD_PAGES/);
  });

  it('caps claims per facility and calls in flight with the agreed defaults and bounds', () => {
    expect(readOcrWorkerConfig(base)).toMatchObject({ OCR_WORKER_MAX_INFLIGHT_PER_FACILITY: 2,
      OCR_AI_MAX_CONCURRENT_REQUESTS: 4, OCR_AI_PAGE_CONCURRENCY: 2, OCR_TEXTRACT_MAX_CONCURRENT: 2 });
    expect(readOcrWorkerConfig({ ...base, OCR_WORKER_MAX_INFLIGHT_PER_FACILITY: '16', OCR_AI_MAX_CONCURRENT_REQUESTS: '32',
      OCR_TEXTRACT_MAX_CONCURRENT: '16', OCR_AI_PAGE_CONCURRENCY: '8' })).toMatchObject({
      OCR_WORKER_MAX_INFLIGHT_PER_FACILITY: 16, OCR_AI_MAX_CONCURRENT_REQUESTS: 32, OCR_TEXTRACT_MAX_CONCURRENT: 16,
      OCR_AI_PAGE_CONCURRENCY: 8 });
    for (const [name, value] of [['OCR_WORKER_MAX_INFLIGHT_PER_FACILITY', '0'], ['OCR_WORKER_MAX_INFLIGHT_PER_FACILITY', '17'],
      ['OCR_AI_MAX_CONCURRENT_REQUESTS', '0'], ['OCR_AI_MAX_CONCURRENT_REQUESTS', '33'],
      ['OCR_TEXTRACT_MAX_CONCURRENT', '0'], ['OCR_TEXTRACT_MAX_CONCURRENT', '17'],
      ['OCR_AI_PAGE_CONCURRENCY', '0'], ['OCR_AI_PAGE_CONCURRENCY', '9'], ['OCR_AI_MAX_CONCURRENT_REQUESTS', '2.5']]) {
      expect(() => readOcrWorkerConfig({ ...base, [name!]: value })).toThrow(new RegExp(name!));
    }
  });
});
