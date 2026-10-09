import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');
const optionalString = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).optional(),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  EVENT_DISPATCHER_ENABLED: booleanString,
  EVENT_DISPATCHER_TRANSPORT: z.enum(['eventbridge', 'deterministic', 'disabled']).default('disabled'),
  EVENT_DISPATCHER_DATABASE_URL: optionalString,
  EVENT_DISPATCHER_ID: z.string().trim().min(3).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/).optional(),
  EVENT_DISPATCHER_DATABASE_SSL: booleanString,
  EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64: optionalString,
  EVENT_DISPATCHER_POOL_MAX: z.coerce.number().int().min(1).max(20).default(4),
  EVENT_DISPATCHER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  EVENT_DISPATCHER_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(10),
  EVENT_DISPATCHER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  EVENT_DISPATCHER_LEASE_SECONDS: z.coerce.number().int().min(5).max(900).default(60),
  EVENT_DISPATCHER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  EVENT_DISPATCHER_RETRY_BASE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(1_000),
  EVENT_DISPATCHER_RETRY_MAX_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(300_000),
  EVENT_DISPATCHER_TRANSPORT_TIMEOUT_MS: z.coerce.number().int().min(250).max(120_000).default(10_000),
  EVENT_DISPATCHER_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  EVENT_DISPATCHER_STATUS_HOST: z.string().trim().min(1).default('127.0.0.1'),
  EVENT_DISPATCHER_STATUS_PORT: z.coerce.number().int().min(1).max(65_535).default(3010),
  EVENTBRIDGE_EVENT_BUS_NAME: optionalString,
  AWS_REGION: z.string().trim().min(1).default('eu-west-1'),
  AWS_ENDPOINT_URL: z.string().url().optional(),
  AWS_ACCESS_KEY_ID: optionalString,
  AWS_SECRET_ACCESS_KEY: optionalString,
}).superRefine((env, context) => {
  if (env.EVENT_DISPATCHER_ENABLED && !env.EVENT_DISPATCHER_DATABASE_URL) {
    context.addIssue({ code: 'custom', path: ['EVENT_DISPATCHER_DATABASE_URL'], message: 'Enabled dispatcher requires its database URL' });
  }
  if (env.EVENT_DISPATCHER_ENABLED && env.EVENT_DISPATCHER_TRANSPORT === 'disabled') {
    context.addIssue({ code: 'custom', path: ['EVENT_DISPATCHER_TRANSPORT'], message: 'Enabled dispatcher requires an active transport' });
  }
  if (!env.EVENT_DISPATCHER_ENABLED && env.EVENT_DISPATCHER_TRANSPORT !== 'disabled') {
    context.addIssue({ code: 'custom', path: ['EVENT_DISPATCHER_TRANSPORT'], message: 'Disabled dispatcher must use the disabled transport' });
  }
  if (env.EVENT_DISPATCHER_TRANSPORT === 'deterministic' && env.NODE_ENV === 'production') {
    context.addIssue({ code: 'custom', path: ['EVENT_DISPATCHER_TRANSPORT'], message: 'Deterministic transport is forbidden in production' });
  }
  if (env.EVENT_DISPATCHER_TRANSPORT === 'eventbridge' && !env.EVENTBRIDGE_EVENT_BUS_NAME) {
    context.addIssue({ code: 'custom', path: ['EVENTBRIDGE_EVENT_BUS_NAME'], message: 'EventBridge transport requires a bus name' });
  }
  if (env.EVENT_DISPATCHER_RETRY_BASE_MS > env.EVENT_DISPATCHER_RETRY_MAX_MS) {
    context.addIssue({ code: 'custom', path: ['EVENT_DISPATCHER_RETRY_BASE_MS'], message: 'Retry base must not exceed retry maximum' });
  }
  if (env.EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64
      && !isBase64PemCertificate(env.EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64)) {
    context.addIssue({ code: 'custom', path: ['EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64'],
      message: 'Database TLS root certificate must be a valid base64-encoded PEM certificate' });
  }
  if (Boolean(env.AWS_ACCESS_KEY_ID) !== Boolean(env.AWS_SECRET_ACCESS_KEY)) {
    context.addIssue({ code: 'custom', path: ['AWS_ACCESS_KEY_ID'], message: 'AWS access key and secret must be provided together' });
  }
  if (env.NODE_ENV === 'production') {
    if (!env.EVENT_DISPATCHER_ENABLED || env.EVENT_DISPATCHER_TRANSPORT !== 'eventbridge') {
      context.addIssue({ code: 'custom', path: ['EVENT_DISPATCHER_ENABLED'], message: 'Production requires an enabled EventBridge dispatcher' });
    }
    if (!env.EVENT_DISPATCHER_DATABASE_SSL || !env.EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64) {
      context.addIssue({ code: 'custom', path: ['EVENT_DISPATCHER_DATABASE_SSL'], message: 'Production database TLS with a trusted CA is required' });
    }
    if (env.EVENT_DISPATCHER_DATABASE_URL
        && databaseUrlOverridesTls(env.EVENT_DISPATCHER_DATABASE_URL)) {
      context.addIssue({ code: 'custom', path: ['EVENT_DISPATCHER_DATABASE_URL'],
        message: 'Production database URL must not override the dedicated verified TLS configuration' });
    }
    if (env.AWS_ACCESS_KEY_ID || env.AWS_SECRET_ACCESS_KEY) {
      context.addIssue({ code: 'custom', path: ['AWS_ACCESS_KEY_ID'], message: 'Production must use workload IAM credentials, not static AWS keys' });
    }
    if (env.AWS_ENDPOINT_URL && new URL(env.AWS_ENDPOINT_URL).protocol !== 'https:') {
      context.addIssue({ code: 'custom', path: ['AWS_ENDPOINT_URL'], message: 'Production AWS endpoint must use HTTPS' });
    }
  }
});

const DATABASE_URL_TLS_PARAMETERS = [
  'ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation',
] as const;

function databaseUrlOverridesTls(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    return DATABASE_URL_TLS_PARAMETERS.some((parameter) => url.searchParams.has(parameter));
  } catch {
    return false;
  }
}

function isBase64PemCertificate(encodedCertificate: string): boolean {
  const normalized = encodedCertificate.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) return false;
  const certificate = Buffer.from(normalized, 'base64').toString('utf8');
  return certificate.includes('-----BEGIN CERTIFICATE-----')
    && certificate.includes('-----END CERTIFICATE-----');
}

export type EventDispatcherConfig = z.infer<typeof schema>;

export function readEventDispatcherConfig(environment: NodeJS.ProcessEnv = process.env): EventDispatcherConfig {
  const result = schema.safeParse(environment);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid event dispatcher configuration: ${details}`);
  }
  if (result.data.NODE_ENV === 'production'
      && (typeof environment.AWS_REGION !== 'string' || !environment.AWS_REGION.trim())) {
    throw new Error('Invalid event dispatcher configuration: AWS_REGION: Production EventBridge region must be explicit');
  }
  if (result.data.NODE_ENV === 'production' && environment.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('Invalid event dispatcher configuration: NODE_TLS_REJECT_UNAUTHORIZED: Production TLS verification cannot be disabled globally');
  }
  return result.data;
}
