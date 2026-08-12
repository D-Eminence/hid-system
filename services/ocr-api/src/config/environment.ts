import { isIP } from 'node:net';
import { z } from 'zod';

const emptyToUndefined = (value: unknown) => typeof value === 'string' && value.trim() === '' ? undefined : value;
const optionalString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
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
  PORT: z.coerce.number().int().min(1).max(65_535).default(3005),
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  DATABASE_SSL: booleanString,
  DATABASE_SSL_ROOT_CERT_BASE64: optionalString,
  DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),
  CORS_ORIGINS: z.string().min(1),
  TRUST_PROXY_CIDRS: optionalString,
  IDENTITY_API_URL: z.string().url().default('http://127.0.0.1:3001'),
  IDENTITY_SERVICE_IDENTITY_MODE: z.enum(['local-secret', 'jwt']).default('local-secret'),
  IDENTITY_OCR_INTERNAL_SERVICE_TOKEN: optionalSecret,
  IDENTITY_OCR_WORKLOAD_TOKEN_FILE: optionalString,
  EHR_API_URL: z.string().url().default('http://127.0.0.1:3002'),
  EHR_SERVICE_IDENTITY_MODE: z.enum(['local-secret', 'jwt']).default('local-secret'),
  EHR_INTERNAL_SERVICE_TOKEN: optionalSecret,
  EHR_OCR_WORKLOAD_TOKEN_FILE: optionalString,
  LAB_API_URL: z.string().url().default('http://127.0.0.1:3003'),
  LAB_SERVICE_IDENTITY_MODE: z.enum(['local-secret', 'jwt']).default('local-secret'),
  LAB_INTERNAL_SERVICE_TOKEN: optionalSecret,
  LAB_OCR_WORKLOAD_TOKEN_FILE: optionalString,
  PHARMACY_API_URL: z.string().url().default('http://127.0.0.1:3004'),
  PHARMACY_SERVICE_IDENTITY_MODE: z.enum(['local-secret', 'jwt']).default('local-secret'),
  PHARMACY_INTERNAL_SERVICE_TOKEN: optionalSecret,
  PHARMACY_OCR_WORKLOAD_TOKEN_FILE: optionalString,
}).superRefine((environment, context) => {
  const modes = [
    ['IDENTITY_SERVICE_IDENTITY_MODE', 'IDENTITY_OCR_INTERNAL_SERVICE_TOKEN', 'IDENTITY_OCR_WORKLOAD_TOKEN_FILE'],
    ['EHR_SERVICE_IDENTITY_MODE', 'EHR_INTERNAL_SERVICE_TOKEN', 'EHR_OCR_WORKLOAD_TOKEN_FILE'],
    ['LAB_SERVICE_IDENTITY_MODE', 'LAB_INTERNAL_SERVICE_TOKEN', 'LAB_OCR_WORKLOAD_TOKEN_FILE'],
    ['PHARMACY_SERVICE_IDENTITY_MODE', 'PHARMACY_INTERNAL_SERVICE_TOKEN', 'PHARMACY_OCR_WORKLOAD_TOKEN_FILE'],
  ] as const;
  for (const [modeKey, secretKey, tokenFileKey] of modes) {
    if (environment[modeKey] === 'local-secret' && !environment[secretKey]) {
      context.addIssue({ code: 'custom', path: [secretKey], message: `${secretKey} is required for local service identity` });
    }
    if (environment[modeKey] === 'jwt' && !environment[tokenFileKey]) {
      context.addIssue({ code: 'custom', path: [tokenFileKey], message: `${tokenFileKey} is required for JWT service identity` });
    }
    if (environment.NODE_ENV === 'production' && environment[modeKey] !== 'jwt') {
      context.addIssue({ code: 'custom', path: [modeKey], message: `${modeKey} must use JWT in production` });
    }
    if (environment.NODE_ENV === 'production' && environment[secretKey]) {
      context.addIssue({ code: 'custom', path: [secretKey], message: 'Local shared-token authentication is forbidden in production' });
    }
  }
  if (environment.NODE_ENV === 'production') {
    if (environment.NODE_TLS_REJECT_UNAUTHORIZED === '0') context.addIssue({ code: 'custom',
      path: ['NODE_TLS_REJECT_UNAUTHORIZED'], message: 'Production TLS verification cannot be disabled globally' });
    if (databaseUrlOverridesTls(environment.DATABASE_URL)) context.addIssue({ code: 'custom',
      path: ['DATABASE_URL'], message: 'Production database URL must not override verified TLS configuration' });
    if (!environment.DATABASE_SSL) context.addIssue({ code: 'custom', path: ['DATABASE_SSL'], message: 'TLS is required in production' });
    if (!environment.DATABASE_SSL_ROOT_CERT_BASE64) context.addIssue({ code: 'custom', path: ['DATABASE_SSL_ROOT_CERT_BASE64'], message: 'The PostgreSQL CA certificate is required in production' });
    if (!environment.TRUST_PROXY_CIDRS) context.addIssue({ code: 'custom', path: ['TRUST_PROXY_CIDRS'], message: 'Approved reverse-proxy CIDRs are required in production' });
    else if (environment.TRUST_PROXY_CIDRS.split(',').map((value) => value.trim()).some((value) => !validProxy(value))) {
      context.addIssue({ code: 'custom', path: ['TRUST_PROXY_CIDRS'], message: 'Only explicit IP addresses or CIDRs are allowed' });
    }
    for (const [key, value] of [['IDENTITY_API_URL', environment.IDENTITY_API_URL],
      ['EHR_API_URL', environment.EHR_API_URL], ['LAB_API_URL', environment.LAB_API_URL],
      ['PHARMACY_API_URL', environment.PHARMACY_API_URL]] as const) {
      if (new URL(value).protocol !== 'https:') context.addIssue({ code: 'custom', path: [key], message: `${key} must use HTTPS in production` });
    }
    for (const origin of environment.CORS_ORIGINS.split(',').map((value) => value.trim())) {
      try { const url = new URL(origin); if (url.protocol !== 'https:' || url.origin !== origin) throw new Error(); }
      catch { context.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'Production origins must be exact HTTPS origins' }); break; }
    }
  }
});

export type Environment = z.infer<typeof environmentSchema>;
let cachedEnvironment: Environment | undefined;
export function getEnvironment(): Environment {
  if (cachedEnvironment) return cachedEnvironment;
  const result = environmentSchema.safeParse({ ...process.env,
    DATABASE_URL: process.env.OCR_DATABASE_URL ?? process.env.DATABASE_URL });
  if (!result.success) throw new Error(`Invalid OCR configuration: ${result.error.issues
    .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`).join('; ')}`);
  cachedEnvironment = result.data;
  return result.data;
}
export function resetEnvironmentForTests(): void { cachedEnvironment = undefined; }
