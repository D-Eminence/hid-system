import { z } from 'zod';

const empty = (value: unknown) => typeof value === 'string' && !value.trim() ? undefined : value;
const optional = z.preprocess(empty, z.string().trim().min(1).optional());
const optionalUrl = z.preprocess(empty, z.string().url().optional());
const bool = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NODE_TLS_REJECT_UNAUTHORIZED: optional,
  NOTIFICATION_WORKER_ENABLED: bool,
  NOTIFICATION_WORKER_ID: z.string().trim().min(3).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/).default('notification-worker-local'),
  NOTIFICATION_WORKER_STATUS_HOST: z.string().trim().min(1).default('127.0.0.1'),
  NOTIFICATION_WORKER_STATUS_PORT: z.coerce.number().int().min(1).max(65_535).default(3008),
  NOTIFICATION_WORKER_DATABASE_URL: optional,
  NOTIFICATION_WORKER_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(4),
  NOTIFICATION_WORKER_DATABASE_SSL: bool,
  NOTIFICATION_WORKER_DATABASE_SSL_ROOT_CERT_BASE64: optional,
  NOTIFICATION_WORKER_QUEUE_URL: optionalUrl,
  NOTIFICATION_WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  NOTIFICATION_WORKER_LEASE_SECONDS: z.coerce.number().int().min(5).max(900).default(60),
  AWS_REGION: z.string().trim().min(1).default('eu-west-1'),
  AWS_ENDPOINT_URL: optionalUrl,
  AWS_ACCESS_KEY_ID: optional,
  AWS_SECRET_ACCESS_KEY: optional,
  NOVU_MODE: z.enum(['disabled', 'test', 'live']).default('disabled'),
  NOVU_API_URL: z.string().url().default('https://api.novu.co'),
  NOVU_API_KEY: optional,
  FCM_PROJECT_ID: optional,
  FCM_API_URL: z.string().url().default('https://fcm.googleapis.com'),
}).superRefine((value, context) => {
  if (value.NOTIFICATION_WORKER_ENABLED) {
    for (const key of ['NOTIFICATION_WORKER_DATABASE_URL', 'NOTIFICATION_WORKER_QUEUE_URL'] as const) {
      if (!value[key]) context.addIssue({ code: 'custom', path: [key], message: `${key} is required when the worker is enabled` });
    }
  }
  if (value.NOVU_MODE === 'test' && value.NODE_ENV !== 'test') {
    context.addIssue({ code: 'custom', path: ['NOVU_MODE'], message: 'Deterministic Novu mode is test-only' });
  }
  if (Boolean(value.AWS_ACCESS_KEY_ID) !== Boolean(value.AWS_SECRET_ACCESS_KEY)) {
    context.addIssue({ code: 'custom', path: ['AWS_ACCESS_KEY_ID'], message: 'AWS static credentials must be supplied together' });
  }
  if (value.NODE_ENV === 'production') {
    if (!value.NOTIFICATION_WORKER_ENABLED || value.NOVU_MODE !== 'live' || !value.NOVU_API_KEY) {
      context.addIssue({ code: 'custom', path: ['NOTIFICATION_WORKER_ENABLED'], message: 'Production requires the enabled live Novu worker' });
    }
    if (!value.NOTIFICATION_WORKER_DATABASE_SSL || !value.NOTIFICATION_WORKER_DATABASE_SSL_ROOT_CERT_BASE64) {
      context.addIssue({ code: 'custom', path: ['NOTIFICATION_WORKER_DATABASE_SSL'], message: 'Production database TLS with a trusted CA is required' });
    }
    if (value.AWS_ACCESS_KEY_ID || value.AWS_SECRET_ACCESS_KEY) {
      context.addIssue({ code: 'custom', path: ['AWS_ACCESS_KEY_ID'], message: 'Production uses workload IAM, not static AWS credentials' });
    }
    if (value.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
      context.addIssue({ code: 'custom', path: ['NODE_TLS_REJECT_UNAUTHORIZED'], message: 'Production TLS verification cannot be disabled' });
    }
    for (const key of ['NOTIFICATION_WORKER_QUEUE_URL', 'AWS_ENDPOINT_URL', 'NOVU_API_URL', 'FCM_API_URL'] as const) {
      if (value[key] && new URL(value[key]!).protocol !== 'https:') {
        context.addIssue({ code: 'custom', path: [key], message: `${key} must use HTTPS in production` });
      }
    }
    if (value.NOTIFICATION_WORKER_DATABASE_URL && databaseUrlOverridesTls(value.NOTIFICATION_WORKER_DATABASE_URL)) {
      context.addIssue({ code: 'custom', path: ['NOTIFICATION_WORKER_DATABASE_URL'], message: 'Production database URL must not override the dedicated verified TLS configuration' });
    }
  }
});

function databaseUrlOverridesTls(value: string): boolean {
  const url = new URL(value);
  return ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation']
    .some((name) => url.searchParams.has(name));
}

export type NotificationWorkerConfig = z.infer<typeof schema>;
export function readConfig(environment: NodeJS.ProcessEnv = process.env): NotificationWorkerConfig {
  const result = schema.safeParse(environment);
  if (!result.success) throw new Error(`Invalid Notification Worker configuration: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return result.data;
}
