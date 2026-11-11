import { isIP } from 'node:net';
import { z } from 'zod';

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const optionalString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const optionalSecret = z.preprocess(emptyToUndefined, z.string().min(32).optional());
const booleanString = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');

function validProxy(value: string): boolean {
  const [address, prefix, extra] = value.split('/');
  if (!address || extra !== undefined) return false;
  const version = isIP(address);
  if (!version) return false;
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
  PORT: z.coerce.number().int().min(1).max(65_535).default(3006),
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  DATABASE_SSL: booleanString,
  DATABASE_SSL_ROOT_CERT_BASE64: optionalString,
  DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),
  CORS_ORIGINS: z.string().min(1),
  TRUST_PROXY_CIDRS: optionalString,
  IDENTITY_API_URL: z.string().url().default('http://127.0.0.1:3001'),
  OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE: z.enum(['local-secret', 'jwt']).default('local-secret'),
  OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: optionalSecret,
  OUTREACH_IDENTITY_WORKLOAD_TOKEN_FILE: optionalString,
}).superRefine((environment, context) => {
  if (environment.OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE === 'local-secret'
      && !environment.OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN) {
    context.addIssue({ code: 'custom', path: ['OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN'],
      message: 'Local Outreach-to-Identity calls require an ephemeral secret' });
  }
  if (environment.OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE === 'jwt'
      && !environment.OUTREACH_IDENTITY_WORKLOAD_TOKEN_FILE) {
    context.addIssue({ code: 'custom', path: ['OUTREACH_IDENTITY_WORKLOAD_TOKEN_FILE'],
      message: 'JWT workload identity requires a rotating mounted token file' });
  }
  if (environment.NODE_ENV === 'production') {
    if (environment.NODE_TLS_REJECT_UNAUTHORIZED === '0') context.addIssue({ code: 'custom',
      path: ['NODE_TLS_REJECT_UNAUTHORIZED'], message: 'Production TLS verification cannot be disabled globally' });
    if (databaseUrlOverridesTls(environment.DATABASE_URL)) context.addIssue({ code: 'custom',
      path: ['DATABASE_URL'], message: 'Production database URL must not override verified TLS configuration' });
    if (environment.OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE !== 'jwt') {
      context.addIssue({ code: 'custom', path: ['OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE'],
        message: 'Production Outreach API requires JWT workload identity' });
    }
    if (environment.OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN) {
      context.addIssue({ code: 'custom', path: ['OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN'],
        message: 'Local shared-token authentication is forbidden in production' });
    }
    if (!environment.DATABASE_SSL) context.addIssue({ code: 'custom', path: ['DATABASE_SSL'],
      message: 'TLS is required in production' });
    if (!environment.DATABASE_SSL_ROOT_CERT_BASE64) context.addIssue({ code: 'custom',
      path: ['DATABASE_SSL_ROOT_CERT_BASE64'], message: 'The PostgreSQL CA certificate is required in production' });
    if (!environment.TRUST_PROXY_CIDRS) context.addIssue({ code: 'custom', path: ['TRUST_PROXY_CIDRS'],
      message: 'Approved reverse-proxy CIDRs are required in production' });
    else if (environment.TRUST_PROXY_CIDRS.split(',').map((item) => item.trim()).some((item) => !validProxy(item))) {
      context.addIssue({ code: 'custom', path: ['TRUST_PROXY_CIDRS'],
        message: 'Only explicit IP addresses or CIDRs are allowed' });
    }
    if (new URL(environment.IDENTITY_API_URL).protocol !== 'https:') {
      context.addIssue({ code: 'custom', path: ['IDENTITY_API_URL'],
        message: 'IDENTITY_API_URL must use HTTPS in production' });
    }
    for (const origin of environment.CORS_ORIGINS.split(',').map((item) => item.trim())) {
      try {
        const url = new URL(origin);
        if (url.protocol !== 'https:' || url.origin !== origin) throw new Error();
      } catch {
        context.addIssue({ code: 'custom', path: ['CORS_ORIGINS'],
          message: 'Production origins must be exact HTTPS origins' });
        break;
      }
    }
  }
});

export type Environment = z.infer<typeof environmentSchema>;
let cachedEnvironment: Environment | undefined;

export function getEnvironment(): Environment {
  if (cachedEnvironment) return cachedEnvironment;
  const result = environmentSchema.safeParse({ ...process.env,
    DATABASE_URL: process.env.OUTREACH_DATABASE_URL ?? process.env.DATABASE_URL });
  if (!result.success) throw new Error(`Invalid Outreach configuration: ${result.error.issues
    .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`).join('; ')}`);
  cachedEnvironment = result.data;
  return result.data;
}

export function resetEnvironmentForTests(): void { cachedEnvironment = undefined; }
