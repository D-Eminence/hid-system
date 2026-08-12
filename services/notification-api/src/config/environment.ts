import { z } from 'zod';

const empty = (value: unknown) => typeof value === 'string' && !value.trim() ? undefined : value;
const optional = z.preprocess(empty, z.string().trim().min(1).optional());
const optionalUrl = z.preprocess(empty, z.string().url().optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NODE_TLS_REJECT_UNAUTHORIZED: optional,
  PORT: z.coerce.number().int().min(1).max(65_535).default(3007),
  NOTIFICATION_PROVIDER_MODE: z.enum(['disabled', 'test', 'live']).default('disabled'),
  NOTIFICATION_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(250).max(15_000).default(5_000),
  NOTIFICATION_WORKLOAD_IDENTITY_MODE: z.enum(['local-secret', 'jwt']).default('local-secret'),
  NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN: optional,
  WORKLOAD_ISSUER_URL: optionalUrl,
  WORKLOAD_JWKS_URL: optionalUrl,
  WORKLOAD_AUDIENCE: z.string().trim().min(3).default('hid-notification-api'),
  IDENTITY_CALLER_SUBJECT: optional,
  AWS_REGION: optional,
  AWS_ACCESS_KEY_ID: optional,
  AWS_SECRET_ACCESS_KEY: optional,
  SES_FROM_ADDRESS: z.preprocess(empty, z.string().email().optional()),
  TERMII_BASE_URL: optionalUrl,
  TERMII_API_KEY: optional,
  TERMII_SENDER_ID: optional,
  TERMII_CHANNEL: z.string().trim().min(1).max(32).default('generic'),
  META_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v25.0'),
  META_PHONE_NUMBER_ID: optional,
  META_ACCESS_TOKEN: optional,
  META_OTP_TEMPLATE_NAME: optional,
  META_OTP_TEMPLATE_LANGUAGE: z.string().trim().min(2).max(16).default('en_US'),
  INFOBIP_BASE_URL: optionalUrl,
  INFOBIP_API_KEY: optional,
  INFOBIP_EMAIL_FROM: z.preprocess(empty, z.string().email().optional()),
  INFOBIP_SMS_SENDER: optional,
  INFOBIP_WHATSAPP_SENDER: optional,
  INFOBIP_WHATSAPP_OTP_TEMPLATE_ID: optional,
}).superRefine((value, context) => {
  if (value.NOTIFICATION_PROVIDER_MODE === 'test' && value.NODE_ENV !== 'test') {
    context.addIssue({ code: 'custom', path: ['NOTIFICATION_PROVIDER_MODE'], message: 'Deterministic notification providers are test-only' });
  }
  if (value.NODE_ENV === 'production') {
    if (value.NODE_TLS_REJECT_UNAUTHORIZED === '0') context.addIssue({ code: 'custom', path: ['NODE_TLS_REJECT_UNAUTHORIZED'], message: 'Production TLS verification cannot be disabled' });
    if (value.NOTIFICATION_PROVIDER_MODE !== 'live') context.addIssue({ code: 'custom', path: ['NOTIFICATION_PROVIDER_MODE'], message: 'Live providers are required in production' });
    if (value.NOTIFICATION_WORKLOAD_IDENTITY_MODE !== 'jwt') context.addIssue({ code: 'custom', path: ['NOTIFICATION_WORKLOAD_IDENTITY_MODE'], message: 'JWT workload identity is required in production' });
    for (const key of ['WORKLOAD_ISSUER_URL','WORKLOAD_JWKS_URL','IDENTITY_CALLER_SUBJECT','AWS_REGION','SES_FROM_ADDRESS','TERMII_BASE_URL','TERMII_API_KEY','TERMII_SENDER_ID','META_PHONE_NUMBER_ID','META_ACCESS_TOKEN','META_OTP_TEMPLATE_NAME','INFOBIP_BASE_URL','INFOBIP_API_KEY'] as const) {
      if (!value[key]) context.addIssue({ code: 'custom', path: [key], message: `${key} is required in production` });
    }
    if (value.AWS_ACCESS_KEY_ID || value.AWS_SECRET_ACCESS_KEY) context.addIssue({ code: 'custom', path: ['AWS_ACCESS_KEY_ID'], message: 'Static AWS credentials are forbidden in production' });
    for (const key of ['WORKLOAD_ISSUER_URL','WORKLOAD_JWKS_URL','TERMII_BASE_URL','INFOBIP_BASE_URL'] as const) {
      if (value[key] && new URL(value[key]).protocol !== 'https:') context.addIssue({ code: 'custom', path: [key], message: `${key} must use HTTPS` });
    }
  }
});

export type Environment = z.infer<typeof schema>;
let cached: Environment | undefined;
export function getEnvironment(): Environment {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid Notification API configuration: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return cached = parsed.data;
}
export function resetEnvironmentForTests() { cached = undefined; }
