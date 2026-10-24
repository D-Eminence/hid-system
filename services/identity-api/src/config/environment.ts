import { isIP } from 'node:net';
import { z } from 'zod';

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const optionalSecret = z.preprocess(emptyToUndefined, z.string().min(32).optional());
const booleanString = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');
const uniqueValues = (values: readonly string[]) => new Set(values).size === values.length;
const emergencyContactChannels = z.preprocess(emptyToUndefined, z.string().default('email'))
  .transform((value) => value.split(',').map((channel) => channel.trim()))
  .pipe(z.array(z.enum(['email', 'sms'])).min(1).refine(uniqueValues, 'Channels must be unique'));
const pilotAccountIds = z.preprocess(emptyToUndefined, z.string().optional())
  .transform((value) => value ? value.split(',').map((accountId) => accountId.trim().toLowerCase()) : [])
  .pipe(z.array(z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'Pilot account IDs must be UUIDs')).max(20).refine(uniqueValues, 'Pilot account IDs must be unique'));

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
  HID_DEPLOYMENT_ENV: z.enum(['staging', 'production']).optional(),
  TURNSTILE_MODE: z.enum(['disabled', 'required']).default('disabled'),
  TURNSTILE_SECRET_KEY: optionalString,
  TURNSTILE_SITEVERIFY_URL: z.string().url().default('https://challenges.cloudflare.com/turnstile/v0/siteverify'),
  TURNSTILE_TIMEOUT_MS: z.coerce.number().int().min(250).max(10_000).default(3_000),
  OTP_HMAC_KEY_B64: optionalString,
  CONTACT_LOOKUP_HMAC_KEY_B64: optionalString,
  OTP_HMAC_KEY_VERSION: z.string().trim().min(1).max(64).default('local-v1'),
  OTP_EXPIRY_SECONDS: z.coerce.number().int().min(60).max(600).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
  OTP_RATE_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  OTP_RATE_MAX_REQUESTS: z.coerce.number().int().min(1).max(100).default(5),
  // One budget of wrong recovery codes per account, across its challenges and
  // purposes: the OTP_VERIFY_FAILURE_MAX-th wrong code within the window
  // suspends recovery for that account for one window, even for a correct
  // code. The defaults follow the platform MFA budget (the fifth failure in
  // 15 minutes blocks for 15 minutes). Never keyed by client IP.
  OTP_VERIFY_FAILURE_MAX: z.coerce.number().int().min(2).max(100).default(5),
  OTP_VERIFY_FAILURE_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  NOTIFICATION_API_URL: z.string().url().default('http://127.0.0.1:3007'),
  NOTIFICATION_SERVICE_IDENTITY_MODE: z.enum(['local-secret', 'jwt']).default('local-secret'),
  NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN: optionalSecret,
  NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE: optionalString,
  // Emergency-contact verification codes and emergency-access alerts reach
  // people who are not Health ID users. On by default: D-Eminence approved
  // production delivery for every patient on 2026-10-24, and production's task
  // definitions do not set the key; notification-api switched on one release
  // earlier. Only an explicit EMERGENCY_CONTACT_DELIVERY_ENABLED=false switches
  // it off (while off, adding a contact and sending a code answer 409). dev's
  // Terraform does not write "false" yet, so until it does the off switch is a
  // release that flips this default back. Unlike main, production is not
  // refused (it would crash-loop sign-in).
  EMERGENCY_CONTACT_DELIVERY_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  // The channels a contact may be added and alerted on. Production's
  // email-brevo profile cannot send SMS.
  EMERGENCY_CONTACT_CHANNELS: emergencyContactChannels,
  // When set, only these accounts (at most 20) may add contacts or send codes,
  // and every other patient is told delivery is off. Empty means every patient.
  EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS: pilotAccountIds,
  // Interval for dispatching emergency-contact notifications while delivery is
  // enabled (owner decision O9: every 60 s). Zero disables it.
  PATIENT_LIFECYCLE_SWEEP_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
  // notification-api may spend two provider timeouts on one alert. The
  // dispatcher sends five alerts under a 120-second lease, so five of these
  // must stay below it (20 s at most).
  EMERGENCY_CONTACT_ALERT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(20_000).default(12_000),
  OIDC_ISSUER_URL: optionalUrl,
  OIDC_AUDIENCE: optionalString,
  OIDC_JWKS_URL: optionalUrl,
  GOOGLE_OIDC_CLIENT_IDS: z.preprocess(emptyToUndefined, z.string().trim().min(3).max(4000).optional()),
  NIN_PROVIDER_MODE: z.enum(['unavailable', 'deferred', 'test']).default('unavailable'),
  NIN_LOOKUP_HMAC_KEY_B64: optionalString,
  NIN_ENCRYPTION_KEY_B64: optionalString,
  NIN_KEY_VERSION: z.string().trim().min(1).max(64).default('local-v1'),
  // QoreID is a separate, server-only verification integration. It must not
  // change the governed NIN-registration provider mode above.
  QOREID_ENABLED: booleanString,
  // The public NIN documentation still requires name claims. This separate
  // gate must remain false until QoreID confirms the NIN-only contract.
  QOREID_NIN_ONLY_ENROLLMENT_ENABLED: booleanString,
  // The signed-in "Verify NIN" (POST /identity/me/verification/nin) binds a NIN
  // on a name and date-of-birth match, without proof that the patient holds
  // it. False answers 503 before any lookup, quota charge or evidence write;
  // only the owner turns it on.
  QOREID_PATIENT_SELF_NIN_BINDING_ENABLED: booleanString,
  QOREID_BASE_URL: z.string().url().default('https://api.qoreid.com'),
  QOREID_CLIENT_ID: optionalString,
  QOREID_CLIENT_SECRET: optionalString,
  QOREID_TIMEOUT_MS: z.coerce.number().int().min(250).max(10_000).default(5_000),
  // QoreID's POST endpoints do not publish an idempotency contract. Keep
  // retries explicitly disabled rather than risking duplicate verification.
  QOREID_MAX_RETRIES: z.coerce.number().int().min(0).max(0).default(0),
  // One budget of wrong public-enrollment contact codes per recipient, across
  // its challenges and enrollments: the PATIENT_ENROLLMENT_CONTACT_FAILURE_MAX-th
  // wrong code within the window refuses every code for that recipient, a
  // correct one too, for one window. The defaults follow the documented budget
  // for a six-digit code (the fifth failure in 15 minutes blocks for 15
  // minutes); the bounds allow at most ten failures per 15 minutes. Never
  // keyed by client IP.
  PATIENT_ENROLLMENT_CONTACT_FAILURE_MAX: z.coerce.number().int().min(2).max(10).default(5),
  PATIENT_ENROLLMENT_CONTACT_FAILURE_WINDOW_SECONDS: z.coerce.number().int().min(900).max(86_400).default(900),
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
  if (environment.GOOGLE_OIDC_CLIENT_IDS) {
    const clientIds = environment.GOOGLE_OIDC_CLIENT_IDS.split(',').map((value) => value.trim());
    if (environment.AUTH_MODE !== 'local') {
      context.addIssue({ code: 'custom', path: ['GOOGLE_OIDC_CLIENT_IDS'], message: 'Google cookie sessions require AUTH_MODE=local' });
    }
    if (clientIds.some((value) => value.length < 3 || value.length > 255)
        || new Set(clientIds).size !== clientIds.length) {
      context.addIssue({ code: 'custom', path: ['GOOGLE_OIDC_CLIENT_IDS'], message: 'Google client IDs must be unique, non-empty values' });
    }
  }
  if (environment.NIN_PROVIDER_MODE === 'test') {
    if (environment.NODE_ENV !== 'test') context.addIssue({ code: 'custom', path: ['NIN_PROVIDER_MODE'], message: 'The deterministic NIN provider is test-only' });
    if (environment.HID_DEPLOYMENT_ENV === 'staging') context.addIssue({ code: 'custom', path: ['NIN_PROVIDER_MODE'], message: 'Staging NIN verification is deferred; test verification cannot be enabled' });
  }
  if (environment.NIN_PROVIDER_MODE === 'deferred' && environment.HID_DEPLOYMENT_ENV !== 'staging') {
    context.addIssue({ code: 'custom', path: ['NIN_PROVIDER_MODE'], message: 'Deferred NIN mode requires the explicit staging deployment profile' });
  }
  if (environment.QOREID_ENABLED) {
    for (const key of ['QOREID_CLIENT_ID', 'QOREID_CLIENT_SECRET'] as const) {
      if (!environment[key]) context.addIssue({ code: 'custom', path: [key], message: `${key} is required when QoreID verification is enabled` });
    }
    const qoreIdUrl = new URL(environment.QOREID_BASE_URL);
    if (qoreIdUrl.origin !== 'https://api.qoreid.com'
      || qoreIdUrl.username || qoreIdUrl.password
      || qoreIdUrl.pathname !== '/' || qoreIdUrl.search || qoreIdUrl.hash) {
      context.addIssue({ code: 'custom', path: ['QOREID_BASE_URL'], message: 'Enabled QoreID verification must use the approved QoreID API origin' });
    }
  }
  if (environment.QOREID_NIN_ONLY_ENROLLMENT_ENABLED && !environment.QOREID_ENABLED) {
    context.addIssue({ code: 'custom', path: ['QOREID_NIN_ONLY_ENROLLMENT_ENABLED'],
      message: 'NIN-only enrollment requires enabled QoreID verification' });
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
  if (environment.CONTACT_LOOKUP_HMAC_KEY_B64 && !isBase64Key(environment.CONTACT_LOOKUP_HMAC_KEY_B64, 32)) {
    context.addIssue({ code: 'custom', path: ['CONTACT_LOOKUP_HMAC_KEY_B64'], message: 'The contact lookup key must be exactly 32 base64-encoded bytes' });
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
    if (!environment.HID_DEPLOYMENT_ENV) context.addIssue({ code: 'custom', path: ['HID_DEPLOYMENT_ENV'], message: 'A production or staging deployment profile is required' });
    if (environment.TURNSTILE_MODE !== 'required') context.addIssue({ code: 'custom', path: ['TURNSTILE_MODE'], message: 'Turnstile is required for public production authentication' });
    if (!environment.TURNSTILE_SECRET_KEY) context.addIssue({ code: 'custom', path: ['TURNSTILE_SECRET_KEY'], message: 'The server-only Turnstile secret is required in production' });
    if (new URL(environment.TURNSTILE_SITEVERIFY_URL).origin !== 'https://challenges.cloudflare.com') context.addIssue({ code: 'custom', path: ['TURNSTILE_SITEVERIFY_URL'], message: 'Production Turnstile validation must use Cloudflare Siteverify' });
    if (!environment.TRUST_PROXY_CIDRS) context.addIssue({ code: 'custom', path: ['TRUST_PROXY_CIDRS'], message: 'Approved reverse-proxy CIDRs are required in production' });
    else if (environment.TRUST_PROXY_CIDRS.split(',').map((value) => value.trim()).some((value) => !validProxyCidr(value))) context.addIssue({ code: 'custom', path: ['TRUST_PROXY_CIDRS'], message: 'TRUST_PROXY_CIDRS must contain only explicit IP addresses or CIDR ranges' });
    if (!environment.OTP_HMAC_KEY_B64) context.addIssue({ code: 'custom', path: ['OTP_HMAC_KEY_B64'], message: 'The server-only OTP HMAC key is required in production' });
    if (!environment.CONTACT_LOOKUP_HMAC_KEY_B64) context.addIssue({ code: 'custom', path: ['CONTACT_LOOKUP_HMAC_KEY_B64'], message: 'The server-only contact lookup key is required in production' });
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
