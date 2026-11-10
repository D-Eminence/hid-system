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
  // Owner decision 2026-11-05: every reading call uses the most capable model at high effort, US only.
  OCR_AI_FIRST_PASS_MODEL: claudeModel.default('claude-opus-5-5'),
  OCR_AI_FIRST_PASS_EFFORT: effort.default('high'),
  OCR_AI_REREAD_MODEL: claudeModel.default('claude-opus-5-5'),
  OCR_AI_REREAD_EFFORT: effort.default('high'),
  // Room for a dense page (dozens of items) plus adaptive thinking; only tokens generated are billed. 64,000 (was
  // 32,000) so a hard page read at max effort (long thinking, then every item with a basis per field) is not cut
  // off: a cut-off answer is a failed reading. Claude Opus 5.5 allows up to 128,000 output tokens when streamed.
  OCR_AI_MAX_TOKENS: z.coerce.number().int().min(1_024).max(128_000).default(64_000),
  // Per request, for the whole streamed answer: a full OCR_AI_MAX_TOKENS answer at high effort needs minutes.
  OCR_AI_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(300_000),
  // Hard pages (flagged handwriting or low_confidence, re-read with the picture): best-guess readings, two reads per
  // page (owner decision 2026-11-05 about 18:40 UTC). 'on' or 'off'; unset or empty means 'on' when
  // OCR_AI_MODE=claude and 'off' otherwise ('off' sends such pages the ordinary image re-read). Any other value
  // fails startup.
  OCR_AI_HARD_PAGE_READS: z.preprocess(emptyToUndefined, z.enum(['on', 'off']).optional()),
  // Effort for the first turn of both hard-page reads, 'high' by default (owner decision of 2026-11-10, about 16:40 UTC,
  // relayed by the coordinator: "High (Recommended)" thinking for hard handwritten pages, about 2.5 minutes and about
  // $0.80 a page, both reads kept; it was 'max'). Set 'max' to compare (README). Fail-closed like the others.
  OCR_AI_HARD_PAGE_EFFORT: effort.default('high'),
  // Effort for a hard-page read's later turns, the ones after a zoom tool_result (coordinator 2026-11-10, relaying
  // production job 5419047a: 13 minutes and about $3.60 for one hard page, nearly all of it output tokens at 'max').
  // 'high' by default. Sent as the top-level effort of those requests: legal with adaptive thinking (earlier thinking
  // blocks stay valid), but a change from the first turn's effort starts the messages cache over once (README). The
  // same value as OCR_AI_HARD_PAGE_EFFORT keeps one effort for the whole read. Fail-closed like the others.
  OCR_AI_HARD_PAGE_FOLLOWUP_EFFORT: effort.default('high'),
  // Output tokens (thinking and answer) for ONE hard-page read, all its turns together: each request's max_tokens is
  // what is left of it (README "Hard-page time and cost bounds"). It counts the output the API reported, so it bounds
  // each attempt: a retry of a turn gets the same max_tokens, and an attempt cut mid-answer reports about 1 output
  // token; the read's billed output is bounded by OCR_AI_HARD_PAGE_DEADLINE_MS, not by this. 32,000 by default: about 4x the answer and thinking
  // the earlier estimate gave a read at 'max', and half of what one read used in production (about 73,000). 4,096 to
  // 128,000; anything else fails startup.
  OCR_AI_HARD_PAGE_MAX_TOKENS: z.preprocess(emptyToUndefined,
    z.coerce.number().int().min(4_096).max(128_000).default(32_000)),
  // The whole hard page, both reads, from their start (permit waits, every turn, zoom crops, retries and backoff
  // included): at the deadline every read still running is aborted; a read that finished is used alone
  // (single_reading_only; logged endedBy "deadline" for the other), and with none finished the page keeps its first
  // reading (reread_failed). 150,000 ms by default (the target is a hard page within 3 minutes); 30,000 to 1,800,000.
  OCR_AI_HARD_PAGE_DEADLINE_MS: z.preprocess(emptyToUndefined,
    z.coerce.number().int().min(30_000).max(1_800_000).default(150_000)),
  // The last-resort image re-read's own window (coordinator decision of 2026-11-10, about 18:58 UTC; README "Last
  // resort"): it runs for at most this many seconds from when it is decided, never in what is left of the hard
  // page's deadline, so a page whose two hard reads were both cut by the deadline still gets an answer. 60 by default:
  // a hard page's worst case is then about OCR_AI_HARD_PAGE_DEADLINE_MS + 60 s (210 s) plus the first pass: past the
  // 3-minute hard-page target above and the website's 3-minute poll (README "Worst case"; raised with the owner and
  // coordinator). 30 to 300; anything else fails startup. 30 s is the least worth sending (about 3,000 output tokens
  // at the ~100 tokens per second measured in production, a sparse page's answer with little thinking; less would
  // almost surely be cut, its thinking billed for nothing). 300 s caps a hard page at about 150 s + 300 s (450 s),
  // further past that poll, and is more than the last resort's 16,000-token cap needs (about 160 s at that rate).
  OCR_AI_LAST_RESORT_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(30).max(300).default(60)),
  // Per hard-page request attempt, for the whole streamed answer. 15 minutes by default; the job's lease is renewed
  // meanwhile. OCR_AI_HARD_PAGE_DEADLINE_MS (150 s by default) now ends the whole page well before it.
  OCR_AI_HARD_PAGE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(1_800_000).default(900_000),
  // Zoom in the hard-page reads (owner decision 2026-11-05 about 18:45 UTC, "Zoom in our reader"): the model may ask
  // the worker for enlarged crops of the page picture (reading/zoom.ts). 'on' or 'off'; unset or empty means 'on'
  // when the hard-page reads are on and 'off' otherwise. Any other value fails startup. With hard-page reads off it
  // does nothing. The hard-page timeout then holds for each read's whole tool loop.
  OCR_AI_HARD_PAGE_ZOOM: z.preprocess(emptyToUndefined, z.enum(['on', 'off']).optional()),
  // Zoom calls per hard-page read (each of the two reads has its own): 0 to 4, 4 by default (was 8 until the
  // coordinator's decision of 2026-11-10); 0 declares no tool. Anything else fails startup.
  OCR_AI_ZOOM_MAX_CALLS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(4).default(4)),
  OCR_AI_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(4),
  OCR_AI_MAX_REREAD_PAGES: z.coerce.number().int().min(0).max(20).default(20),
  // Claude API requests in flight at once for the whole process (every claim loop shares the one limit).
  OCR_AI_MAX_CONCURRENT_REQUESTS: z.coerce.number().int().min(1).max(32).default(4),
  // Pages of one document read at once (inside OCR_AI_MAX_CONCURRENT_REQUESTS), so one long document cannot
  // take every request slot.
  OCR_AI_PAGE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  OCR_AI_FACILITY_IDS: facilityIds,
  // Re-read flagged pages (any first-pass page flag: low_confidence, handwriting, many_dropped, ai_unsure,
  // possible_missed_item) WITH the page picture instead of from their text: one-page PNG and JPEG images only, on the
  // re-read only (owner decisions of 2026-11-05). 'on' or 'off'; unset or empty means 'on' when OCR_AI_MODE=claude
  // and 'off' otherwise. Any other value fails startup.
  OCR_AI_IMAGE_REREAD: z.preprocess(emptyToUndefined, z.enum(['on', 'off']).optional()),
  // A page whose text had a number hidden by the masker (an 11-digit NIN-like or a Nigerian phone number): the
  // text sent hides it, but the picture shows it. 'send' (default; unset or empty; owner decision 2026-11-05 about
  // 14:06 UTC, "send images with numbers"): the picture is sent anyway, and with it those numbers reach the Claude
  // API (US only). 'text_only': such a page is re-read from its text only ('image_has_masked_number'). Any other
  // value fails startup. The text sent stays masked either way.
  OCR_AI_IMAGE_MASKED_PAGES: z.preprocess(emptyToUndefined, z.enum(['text_only', 'send']).default('send')),
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
  const hardPageReadsOn = (env.OCR_AI_HARD_PAGE_READS ?? (env.OCR_AI_MODE === 'claude' ? 'on' : 'off')) === 'on';
  if (env.OCR_AI_MODE === 'claude' && hardPageReadsOn && env.OCR_AI_MAX_CONCURRENT_REQUESTS < 2) {
    // A hard page's two reads run at once, each holding a request permit per turn: with one permit they would take
    // turns, and one read could use the whole deadline.
    context.addIssue({ code: 'custom', path: ['OCR_AI_MAX_CONCURRENT_REQUESTS'],
      message: 'Hard-page reads need at least 2 concurrent Claude API requests (their two reads run at once)' });
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
}).transform((env) => {
  const hardPageReads = env.OCR_AI_HARD_PAGE_READS ?? (env.OCR_AI_MODE === 'claude' ? 'on' as const : 'off' as const);
  return { ...env,
    OCR_AI_IMAGE_REREAD: env.OCR_AI_IMAGE_REREAD ?? (env.OCR_AI_MODE === 'claude' ? 'on' as const : 'off' as const),
    OCR_AI_HARD_PAGE_READS: hardPageReads,
    OCR_AI_HARD_PAGE_ZOOM: env.OCR_AI_HARD_PAGE_ZOOM ?? hardPageReads };
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
