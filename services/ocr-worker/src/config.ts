import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');
const optionalString = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).optional(),
);

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
