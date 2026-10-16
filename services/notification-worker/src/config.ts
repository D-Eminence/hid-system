import { z } from 'zod';

const empty = (value: unknown) => typeof value === 'string' && !value.trim() ? undefined : value;
const optional = z.preprocess(empty, z.string().trim().min(1).optional());
const optionalUrl = z.preprocess(empty, z.string().url().optional());
const bool = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');
// The two Novu regions the staging stack allows (StagingNovuApiUrl).
const APPROVED_NOVU_ORIGINS = ['https://api.novu.co', 'https://eu.api.novu.co'];

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // The deployment, as notification-api reads it. It defaults to production so
  // a task that does not say where it runs is refused what production refuses.
  HID_DEPLOYMENT_ENV: z.enum(['development', 'staging', 'production']).default('production'),
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
  // ADR-064 (0095): `email` gives Novu the patient's verified login email
  // before the trigger, through the claim-bound recipient lookup, and clears
  // it when the patient may not be emailed. `disabled` (the default) is main's
  // worker exactly. Refused for a production deployment until the release
  // checklist's approvals are recorded and this refusal is lifted by a
  // reviewed change.
  NOVU_SUBSCRIBER_SYNC: z.enum(['disabled', 'email']).default('disabled'),
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
  if (value.NOVU_SUBSCRIBER_SYNC === 'email') {
    if (value.HID_DEPLOYMENT_ENV === 'production'
        || (value.NODE_ENV === 'production' && value.HID_DEPLOYMENT_ENV !== 'staging')) {
      context.addIssue({ code: 'custom', path: ['NOVU_SUBSCRIBER_SYNC'],
        message: 'Novu subscriber email sync is not approved in production (ADR-064)' });
    }
    if (value.NOVU_MODE !== 'live' && !(value.NOVU_MODE === 'test' && value.NODE_ENV === 'test')) {
      context.addIssue({ code: 'custom', path: ['NOVU_SUBSCRIBER_SYNC'],
        message: 'Novu subscriber email sync needs the live Novu orchestrator' });
    }
    if (value.NODE_ENV === 'production' && !APPROVED_NOVU_ORIGINS.includes(new URL(value.NOVU_API_URL).origin)) {
      context.addIssue({ code: 'custom', path: ['NOVU_API_URL'],
        message: 'Novu subscriber email sync sends the email only to an approved Novu region origin' });
    }
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
