import { isIP } from 'node:net';
import { z } from 'zod';

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const optionalSecret = z.preprocess(emptyToUndefined, z.string().min(32).optional());
const booleanString = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');

function validProxyCidr(value: string): boolean {
  const [address, prefix, extra] = value.split('/');
  if (!address || extra !== undefined) return false;
  const version = isIP(address);
  if (version === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 0 && bits <= (version === 4 ? 32 : 128);
}

function databaseUrlOverridesTls(connectionString: string): boolean {
  const url = new URL(connectionString);
  return ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation']
    .some((parameter) => url.searchParams.has(parameter));
}

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NODE_TLS_REJECT_UNAUTHORIZED: optionalString,
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  DATABASE_SSL: booleanString,
  DATABASE_SSL_ROOT_CERT_BASE64: optionalString,
  DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),
  CORS_ORIGINS: z.string().min(1),
  TRUST_PROXY_CIDRS: optionalString,
  AUTH_MODE: z.enum(['local', 'oidc']),
  AUTH_SIGNING_SECRET: optionalString,
  AUTH_ISSUER: z.string().min(3).default('hid-identity'),
  AUTH_AUDIENCE: z.string().min(3).default('hid-api'),
  AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().min(300).max(3600).default(900),
  AUTH_REFRESH_TTL_SECONDS: z.coerce.number().int().min(900).max(604800).default(28800),
  AUTH_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().min(3600).max(2592000).default(86400),
  AUTH_LOGIN_PEPPER: optionalString,
  AUTH_LOGIN_PEPPER_VERSION: z.coerce.number().int().min(1).max(32767).default(1),
  AUTH_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default('hid_access'),
  AUTH_COOKIE_SECURE: booleanString,
  AUTH_COOKIE_DOMAIN: optionalString,
  TURNSTILE_MODE: z.enum(['disabled', 'required']).default('disabled'),
  TURNSTILE_SECRET_KEY: optionalString,
  TURNSTILE_SITEVERIFY_URL: z.string().url().default('https://challenges.cloudflare.com/turnstile/v0/siteverify'),
  TURNSTILE_TIMEOUT_MS: z.coerce.number().int().min(250).max(10_000).default(3_000),
  OTP_HMAC_KEY_B64: optionalString,
  OTP_HMAC_KEY_VERSION: z.string().trim().min(1).max(64).default('local-v1'),
  OTP_EXPIRY_SECONDS: z.coerce.number().int().min(60).max(600).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
  OTP_RATE_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  OTP_RATE_MAX_REQUESTS: z.coerce.number().int().min(1).max(100).default(5),
  NOTIFICATION_API_URL: z.string().url().default('http://127.0.0.1:3007'),
  NOTIFICATION_SERVICE_IDENTITY_MODE: z.enum(['local-secret', 'jwt']).default('local-secret'),
  NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN: optionalSecret,
  NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE: optionalString,
  OIDC_ISSUER_URL: optionalUrl,
  OIDC_AUDIENCE: optionalString,
  OIDC_JWKS_URL: optionalUrl,
  NIN_PROVIDER_MODE: z.enum(['unavailable', 'test']).default('unavailable'),
  NIN_LOOKUP_HMAC_KEY_B64: optionalString,
  NIN_ENCRYPTION_KEY_B64: optionalString,
  NIN_KEY_VERSION: z.string().trim().min(1).max(64).default('local-v1'),
  IDENTITY_SERVICE_IDENTITY_MODE: z.enum(['local-secret', 'jwt']).default('local-secret'),
  IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: optionalSecret,
  IDENTITY_LAB_INTERNAL_SERVICE_TOKEN: optionalSecret,
  IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN: optionalSecret,
  IDENTITY_OCR_INTERNAL_SERVICE_TOKEN: optionalSecret,
  OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: optionalSecret,
  WORKLOAD_ISSUER_URL: optionalUrl,
  WORKLOAD_AUDIENCE: z.string().trim().min(3).default('hid-identity-api'),
  WORKLOAD_JWKS_URL: optionalUrl,
  IDENTITY_EHR_CALLER_SUBJECT: optionalString,
  IDENTITY_LAB_CALLER_SUBJECT: optionalString,
  IDENTITY_PHARMACY_CALLER_SUBJECT: optionalString,
  IDENTITY_OCR_CALLER_SUBJECT: optionalString,
  OUTREACH_CALLER_SUBJECT: optionalString,
  ADMIN_IDENTITY_STATUS_URL: optionalUrl,
  ADMIN_EHR_STATUS_URL: optionalUrl,
  ADMIN_LAB_STATUS_URL: optionalUrl,
  ADMIN_PHARMACY_STATUS_URL: optionalUrl,
  ADMIN_OCR_STATUS_URL: optionalUrl,
  ADMIN_OUTREACH_STATUS_URL: optionalUrl,
  ADMIN_EVENT_DISPATCHER_STATUS_URL: optionalUrl,
  ADMIN_OPERATIONS_TIMEOUT_MS: z.coerce.number().int().min(250).max(5000).default(1500),
}).superRefine((environment, context) => {
  if (environment.AUTH_MODE === 'local') {
    if (!environment.AUTH_SIGNING_SECRET || environment.AUTH_SIGNING_SECRET.length < 32) {
      context.addIssue({ code: 'custom', path: ['AUTH_SIGNING_SECRET'], message: 'A minimum 32-character signing secret is required for local auth' });
    }
    if (!environment.AUTH_LOGIN_PEPPER || environment.AUTH_LOGIN_PEPPER.length < 32) {
      context.addIssue({ code: 'custom', path: ['AUTH_LOGIN_PEPPER'], message: 'A minimum 32-character independent login-attempt pepper is required' });
    }
  }
  if (environment.AUTH_MODE === 'oidc') {
    for (const key of ['OIDC_ISSUER_URL', 'OIDC_AUDIENCE', 'OIDC_JWKS_URL'] as const) {
      if (!environment[key]) context.addIssue({ code: 'custom', path: [key], message: `${key} is required for OIDC auth` });
    }
  }
  if (environment.NIN_PROVIDER_MODE === 'test') {
    if (environment.NODE_ENV !== 'test') context.addIssue({ code: 'custom', path: ['NIN_PROVIDER_MODE'], message: 'The deterministic NIN provider is test-only' });
  }
  if (environment.NIN_LOOKUP_HMAC_KEY_B64 && !isBase64Key(environment.NIN_LOOKUP_HMAC_KEY_B64, 32)) {
    context.addIssue({ code: 'custom', path: ['NIN_LOOKUP_HMAC_KEY_B64'], message: 'The NIN lookup key must be exactly 32 base64-encoded bytes' });
  }
  if (environment.NIN_ENCRYPTION_KEY_B64 && !isBase64Key(environment.NIN_ENCRYPTION_KEY_B64, 32)) {
    context.addIssue({ code: 'custom', path: ['NIN_ENCRYPTION_KEY_B64'], message: 'The NIN encryption key must be exactly 32 base64-encoded bytes' });
  }
  if (environment.OTP_HMAC_KEY_B64 && !isBase64Key(environment.OTP_HMAC_KEY_B64, 32)) {
    context.addIssue({ code: 'custom', path: ['OTP_HMAC_KEY_B64'], message: 'The OTP HMAC key must be exactly 32 base64-encoded bytes' });
  }
  if (environment.NOTIFICATION_SERVICE_IDENTITY_MODE === 'local-secret'
      && !environment.NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN && environment.NODE_ENV !== 'test') {
    context.addIssue({ code: 'custom', path: ['NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN'], message: 'Local Identity-to-Notification calls require an ephemeral secret' });
  }
  if (environment.NOTIFICATION_SERVICE_IDENTITY_MODE === 'jwt'
      && !environment.NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE) {
    context.addIssue({ code: 'custom', path: ['NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE'], message: 'JWT Identity-to-Notification calls require a workload token file' });
  }
  if (environment.NODE_ENV === 'production') {
    if (environment.NODE_TLS_REJECT_UNAUTHORIZED === '0') context.addIssue({ code: 'custom',
      path: ['NODE_TLS_REJECT_UNAUTHORIZED'], message: 'Production TLS verification cannot be disabled globally' });
    if (databaseUrlOverridesTls(environment.DATABASE_URL)) context.addIssue({ code: 'custom',
      path: ['DATABASE_URL'], message: 'Production database URL must not override verified TLS configuration' });
    if (environment.IDENTITY_SERVICE_IDENTITY_MODE !== 'jwt') context.addIssue({ code: 'custom', path: ['IDENTITY_SERVICE_IDENTITY_MODE'], message: 'Production Identity callers require JWT workload identity' });
    for (const key of ['WORKLOAD_ISSUER_URL', 'WORKLOAD_JWKS_URL', 'IDENTITY_EHR_CALLER_SUBJECT', 'IDENTITY_LAB_CALLER_SUBJECT', 'IDENTITY_PHARMACY_CALLER_SUBJECT', 'IDENTITY_OCR_CALLER_SUBJECT', 'OUTREACH_CALLER_SUBJECT'] as const) {
      if (!environment[key]) context.addIssue({ code: 'custom', path: [key], message: `${key} is required in production` });
    }
    for (const key of ['IDENTITY_EHR_INTERNAL_SERVICE_TOKEN', 'IDENTITY_LAB_INTERNAL_SERVICE_TOKEN', 'IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN', 'IDENTITY_OCR_INTERNAL_SERVICE_TOKEN', 'OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN'] as const) {
      if (environment[key]) context.addIssue({ code: 'custom', path: [key], message: 'Local service tokens are forbidden in production' });
    }
    for (const url of ['WORKLOAD_ISSUER_URL', 'WORKLOAD_JWKS_URL', 'OIDC_ISSUER_URL', 'OIDC_JWKS_URL'] as const) {
      if (environment[url] && new URL(environment[url]).protocol !== 'https:') context.addIssue({ code: 'custom', path: [url], message: `${url} must use HTTPS in production` });
    }
    const origins = environment.CORS_ORIGINS.split(',').map((origin) => origin.trim());
    for (const origin of origins) {
      try {
        const parsed = new URL(origin);
        if (parsed.origin !== origin || parsed.protocol !== 'https:') throw new Error('invalid origin');
      } catch {
        context.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'Production CORS origins must be exact HTTPS origins without paths' });
        break;
      }
    }
    if (!environment.DATABASE_SSL) context.addIssue({ code: 'custom', path: ['DATABASE_SSL'], message: 'TLS is required in production' });
    if (!environment.DATABASE_SSL_ROOT_CERT_BASE64) context.addIssue({ code: 'custom', path: ['DATABASE_SSL_ROOT_CERT_BASE64'], message: 'The trusted PostgreSQL CA certificate is required in production' });
    if (!environment.AUTH_COOKIE_SECURE) context.addIssue({ code: 'custom', path: ['AUTH_COOKIE_SECURE'], message: 'Secure cookies are required in production' });
    if (environment.AUTH_COOKIE_DOMAIN) context.addIssue({ code: 'custom', path: ['AUTH_COOKIE_DOMAIN'], message: 'Production sessions must use host-only cookies; AUTH_COOKIE_DOMAIN must be absent' });
    if (environment.TURNSTILE_MODE !== 'required') context.addIssue({ code: 'custom', path: ['TURNSTILE_MODE'], message: 'Turnstile is required for public production authentication' });
    if (!environment.TURNSTILE_SECRET_KEY) context.addIssue({ code: 'custom', path: ['TURNSTILE_SECRET_KEY'], message: 'The server-only Turnstile secret is required in production' });
    if (new URL(environment.TURNSTILE_SITEVERIFY_URL).origin !== 'https://challenges.cloudflare.com') context.addIssue({ code: 'custom', path: ['TURNSTILE_SITEVERIFY_URL'], message: 'Production Turnstile validation must use Cloudflare Siteverify' });
    if (!environment.TRUST_PROXY_CIDRS) context.addIssue({ code: 'custom', path: ['TRUST_PROXY_CIDRS'], message: 'Approved reverse-proxy CIDRs are required in production' });
    else if (environment.TRUST_PROXY_CIDRS.split(',').map((value) => value.trim()).some((value) => !validProxyCidr(value))) context.addIssue({ code: 'custom', path: ['TRUST_PROXY_CIDRS'], message: 'TRUST_PROXY_CIDRS must contain only explicit IP addresses or CIDR ranges' });
    if (!environment.OTP_HMAC_KEY_B64) context.addIssue({ code: 'custom', path: ['OTP_HMAC_KEY_B64'], message: 'The server-only OTP HMAC key is required in production' });
    if (environment.NOTIFICATION_SERVICE_IDENTITY_MODE !== 'jwt') context.addIssue({ code: 'custom', path: ['NOTIFICATION_SERVICE_IDENTITY_MODE'], message: 'Production Identity-to-Notification calls require JWT workload identity' });
    if (environment.NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN) context.addIssue({ code: 'custom', path: ['NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN'], message: 'Local Notification service tokens are forbidden in production' });
    if (new URL(environment.NOTIFICATION_API_URL).protocol !== 'https:') context.addIssue({ code: 'custom', path: ['NOTIFICATION_API_URL'], message: 'Production Notification API URL must use HTTPS' });
  }
});

function isBase64Key(value: string, requiredBytes: number): boolean {
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === requiredBytes && decoded.toString('base64') === value;
  } catch {
    return false;
  }
}

export type Environment = z.infer<typeof environmentSchema>;
let cachedEnvironment: Environment | undefined;

export function getEnvironment(): Environment {
  if (cachedEnvironment) return cachedEnvironment;
  const result = environmentSchema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`).join('; ');
    throw new Error(`Invalid Identity service configuration: ${details}`);
  }
  cachedEnvironment = result.data;
  return result.data;
}

export function resetEnvironmentForTests(): void {
  cachedEnvironment = undefined;
}
