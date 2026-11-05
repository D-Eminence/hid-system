import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');
const optionalString = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).optional(),
);

const emptyToUndefined = (value: unknown) => typeof value === 'string' && value.trim() === '' ? undefined : value;
const claudeModel = z.string().trim().regex(/^claude-[a-z0-9-]+$/, 'must be a first-party Claude model ID');
const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * OCR_AI_FACILITY_IDS, the AI reading emergency off-switch (the OCR HTTP service reads the same variable, so both services
 * must get the same value): comma-separated facility UUIDs, whitespace trimmed, case-insensitive (kept lower
 * case); blank entries from stray commas are ignored. Unset or empty (or only whitespace) means every facility.
 * Anything else that is not a list of at least one UUID (",", "demo-hospital") fails startup.
 */
const facilityIds = z.preprocess(emptyToUndefined, z.string().optional()).transform((value, context) => {
  if (value === undefined) return undefined;
  const ids = value.split(',').map((id) => id.trim().toLowerCase()).filter((id) => id.length > 0);
  if (ids.length === 0 || ids.some((id) => !UUID.test(id))) {
    context.addIssue({ code: 'custom', message: 'must be a comma-separated list of facility UUIDs' });
    return z.NEVER;
  }
  return [...new Set(ids)];
});

function databaseUrlOverridesTls(connectionString: string): boolean {
  const url = new URL(connectionString);
  return ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation']
    .some((parameter) => url.searchParams.has(parameter));
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NODE_TLS_REJECT_UNAUTHORIZED: optionalString,
  OCR_PROVIDER: z.enum(['textract', 'test', 'disabled']).default('disabled'),
  OCR_WORKER_DATABASE_URL: z.string().url().startsWith('postgresql://'),
  OCR_WORKER_SUBJECT: z.string().trim().min(3).max(255),
  OCR_WORKER_DATABASE_SSL: booleanString,
  OCR_WORKER_DATABASE_SSL_ROOT_CERT_BASE64: optionalString,
  OCR_WORKER_POOL_MAX: z.coerce.number().int().min(1).max(20).default(4),
  OCR_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  // Fair claiming (migration 0107, ocr.claim_worker_job_fair): a facility with this many jobs processing under
  // a live lease gets no more until one finishes, and the facility with the fewest processing goes first.
  OCR_WORKER_MAX_INFLIGHT_PER_FACILITY: z.coerce.number().int().min(1).max(16).default(2),
  OCR_WORKER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  OCR_WORKER_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  OCR_WORKER_MAX_OBJECT_BYTES: z.coerce.number().int().min(1).max(52_428_800).default(52_428_800),
  OCR_WORKER_API_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  OCR_TEXTRACT_POLL_MS: z.coerce.number().int().min(250).max(30_000).default(1_500),
  OCR_TEXTRACT_MAX_POLL_SECONDS: z.coerce.number().int().min(5).max(3_600).default(300),
  AWS_REGION: z.string().trim().min(1).default('eu-west-1'),
  AWS_ENDPOINT_URL: z.string().url().optional(),
  AWS_ACCESS_KEY_ID: optionalString,
  AWS_SECRET_ACCESS_KEY: optionalString,
  S3_FORCE_PATH_STYLE: booleanString,
  OCR_TEXTRACT_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(3),
  OCR_TEXTRACT_MAX_PAGES: z.coerce.number().int().min(1).max(20).default(20),
  // Textract calls in flight at once for the whole process (every claim loop shares the one limit).
  OCR_TEXTRACT_MAX_CONCURRENT: z.coerce.number().int().min(1).max(16).default(2),
  // 'text' (default): text detection only. 'layout': document analysis with LAYOUT only (reading order, higher cost).
  OCR_TEXTRACT_FEATURES: z.preprocess(emptyToUndefined, z.enum(['text', 'layout']).default('text')),
  // AI reading (Anthropic Claude API, US-only processing: inference_geo "us"; owner decision "Lift hold, US only", 2026-11-04).
  OCR_AI_MODE: z.enum(['off', 'claude']).default('off'),
  // Same validation as the EHR service's ANTHROPIC_API_KEY. Never logged.
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().min(20).regex(/^\S+$/).optional()),
  OCR_AI_US_PROCESSING_APPROVED: booleanString,
  OCR_AI_FIRST_PASS_MODEL: claudeModel.default('claude-sonnet-5-5'),
  OCR_AI_FIRST_PASS_EFFORT: effort.default('medium'),
  OCR_AI_REREAD_MODEL: claudeModel.default('claude-opus-5-5'),
  OCR_AI_REREAD_EFFORT: effort.default('high'),
  OCR_AI_MAX_TOKENS: z.coerce.number().int().min(1_024).max(128_000).default(16_000),
  OCR_AI_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(180_000),
  OCR_AI_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(4),
  OCR_AI_MAX_REREAD_PAGES: z.coerce.number().int().min(0).max(20).default(20),
  // Claude API requests in flight at once for the whole process (every claim loop shares the one limit).
  OCR_AI_MAX_CONCURRENT_REQUESTS: z.coerce.number().int().min(1).max(32).default(4),
  // Pages of one document read at once (inside OCR_AI_MAX_CONCURRENT_REQUESTS), so one long document cannot
  // take every request slot.
  OCR_AI_PAGE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  OCR_AI_FACILITY_IDS: facilityIds,
}).superRefine((env, context) => {
  if (env.OCR_PROVIDER === 'test' && env.NODE_ENV !== 'test') {
    context.addIssue({ code: 'custom', path: ['OCR_PROVIDER'], message: 'The test OCR provider is restricted to NODE_ENV=test' });
  }
  if (env.NODE_ENV === 'production' && env.OCR_PROVIDER !== 'textract') {
    context.addIssue({ code: 'custom', path: ['OCR_PROVIDER'], message: 'Production requires the Textract OCR provider' });
  }
  if (env.NODE_ENV === 'production' && !env.OCR_WORKER_DATABASE_SSL) {
    context.addIssue({ code: 'custom', path: ['OCR_WORKER_DATABASE_SSL'], message: 'Production worker database TLS is required' });
  }
  if (env.NODE_ENV === 'production' && !env.OCR_WORKER_DATABASE_SSL_ROOT_CERT_BASE64) {
    context.addIssue({ code: 'custom', path: ['OCR_WORKER_DATABASE_SSL_ROOT_CERT_BASE64'], message: 'Production worker database CA is required' });
  }
  if (env.NODE_ENV === 'production' && env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    context.addIssue({ code: 'custom', path: ['NODE_TLS_REJECT_UNAUTHORIZED'], message: 'Production TLS verification cannot be disabled globally' });
  }
  if (env.NODE_ENV === 'production' && databaseUrlOverridesTls(env.OCR_WORKER_DATABASE_URL)) {
    context.addIssue({ code: 'custom', path: ['OCR_WORKER_DATABASE_URL'], message: 'Production database URL must not override verified TLS configuration' });
  }
  if (Boolean(env.AWS_ACCESS_KEY_ID) !== Boolean(env.AWS_SECRET_ACCESS_KEY)) {
    context.addIssue({ code: 'custom', path: ['AWS_ACCESS_KEY_ID'], message: 'AWS access key and secret must be provided together' });
  }
  if (env.NODE_ENV === 'production' && env.AWS_ENDPOINT_URL && new URL(env.AWS_ENDPOINT_URL).protocol !== 'https:') {
    context.addIssue({ code: 'custom', path: ['AWS_ENDPOINT_URL'], message: 'Production AWS endpoint must use HTTPS' });
  }
  if (env.OCR_AI_MODE === 'claude') {
    if (!env.ANTHROPIC_API_KEY) {
      context.addIssue({ code: 'custom', path: ['ANTHROPIC_API_KEY'], message: 'AI reading requires a server-side Anthropic API key' });
    }
    if (!env.OCR_AI_US_PROCESSING_APPROVED) {
      context.addIssue({ code: 'custom', path: ['OCR_AI_US_PROCESSING_APPROVED'],
        message: 'AI reading requires approved US processing on the Claude API (inference_geo "us")' });
    }
  }
});

export type OcrWorkerConfig = z.infer<typeof schema>;

export function readOcrWorkerConfig(environment: NodeJS.ProcessEnv = process.env): OcrWorkerConfig {
  const result = schema.safeParse(environment);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid OCR worker configuration: ${details}`);
  }
  return result.data;
}
