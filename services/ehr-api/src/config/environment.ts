import { isIP } from 'node:net';
import { z } from 'zod';

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const optionalSecret = z.preprocess(emptyToUndefined, z.string().min(32).optional());
const optionalPostgresUrl = z.preprocess(
  emptyToUndefined,
  z.string().url().startsWith('postgresql://').optional(),
);
const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

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

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    NODE_TLS_REJECT_UNAUTHORIZED: optionalString,
    PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
    DATABASE_URL: z.string().url().startsWith('postgresql://'),
    LAB_API_URL: z.string().url().default('http://127.0.0.1:3003'),
    LAB_INTERNAL_SERVICE_TOKEN: optionalSecret,
    LAB_SERVICE_IDENTITY_MODE: z.enum(['local-secret','jwt']).default('local-secret'),
    LAB_EHR_WORKLOAD_TOKEN_FILE: optionalString,
    PHARMACY_API_URL: z.string().url().default('http://127.0.0.1:3004'),
    PHARMACY_INTERNAL_SERVICE_TOKEN: optionalSecret,
    PHARMACY_SERVICE_IDENTITY_MODE: z.enum(['local-secret','jwt']).default('local-secret'),
    PHARMACY_EHR_WORKLOAD_TOKEN_FILE: optionalString,
    IDENTITY_API_URL: z.string().url().default('http://127.0.0.1:3001'),
    IDENTITY_SERVICE_IDENTITY_MODE: z.enum(['local-secret', 'jwt']).default('local-secret'),
    IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: optionalSecret,
    IDENTITY_EHR_WORKLOAD_TOKEN_FILE: optionalString,
    EHR_INTERNAL_SERVICE_TOKEN: optionalSecret,
    EHR_SERVICE_IDENTITY_MODE: z.enum(['local-secret', 'jwt']).default('local-secret'),
    EHR_WORKLOAD_ISSUER_URL: optionalUrl,
    EHR_WORKLOAD_AUDIENCE: optionalString,
    EHR_WORKLOAD_JWKS_URL: optionalUrl,
    EHR_OCR_CALLER_SUBJECT: optionalString,
    OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE: z.enum(['unavailable', 'local-secret', 'jwt']).default('unavailable'),
    OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: optionalSecret,
    OUTREACH_CALLER_SUBJECT: optionalString,
    DATABASE_SSL: booleanString,
    DATABASE_SSL_ROOT_CERT_BASE64: optionalString,
    DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),
    WORKLOAD_DATABASE_URL: optionalPostgresUrl,
    WORKLOAD_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(3),
    CORS_ORIGINS: z.string().min(1),
    TRUST_PROXY_CIDRS: optionalString,
    STORAGE_MODE: z.enum(['s3', 'disabled']),
    S3_ENDPOINT: optionalUrl,
    S3_REGION: z.string().min(1).default('eu-west-1'),
    S3_BUCKET: optionalString,
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    S3_FORCE_PATH_STYLE: booleanString,
    S3_KMS_KEY_ID: optionalString,
  })
  .superRefine((environment, context) => {
    if (environment.EHR_SERVICE_IDENTITY_MODE === 'local-secret'
        && !environment.EHR_INTERNAL_SERVICE_TOKEN && environment.NODE_ENV !== 'test') {
      context.addIssue({ code: 'custom', path: ['EHR_INTERNAL_SERVICE_TOKEN'],
        message: 'Local OCR-to-EHR service identity requires an ephemeral secret' });
    }
    if (environment.EHR_SERVICE_IDENTITY_MODE === 'jwt') {
      for (const key of ['EHR_WORKLOAD_ISSUER_URL', 'EHR_WORKLOAD_AUDIENCE',
        'EHR_WORKLOAD_JWKS_URL', 'EHR_OCR_CALLER_SUBJECT'] as const) {
        if (!environment[key]) context.addIssue({ code: 'custom', path: [key],
          message: `${key} is required for JWT OCR workload identity` });
      }
    }
    if(environment.NODE_ENV==='production'&&environment.LAB_SERVICE_IDENTITY_MODE!=='jwt')context.addIssue({code:'custom',path:['LAB_SERVICE_IDENTITY_MODE'],message:'Production Lab calls require JWT workload identity'});
    if(environment.NODE_ENV==='production'&&environment.PHARMACY_SERVICE_IDENTITY_MODE!=='jwt')context.addIssue({code:'custom',path:['PHARMACY_SERVICE_IDENTITY_MODE'],message:'Production Pharmacy calls require JWT workload identity'});
    if(environment.NODE_ENV==='production'&&environment.IDENTITY_SERVICE_IDENTITY_MODE!=='jwt')context.addIssue({code:'custom',path:['IDENTITY_SERVICE_IDENTITY_MODE'],message:'Production Identity calls require JWT workload identity'});
    if(environment.NODE_ENV==='production'&&environment.EHR_SERVICE_IDENTITY_MODE!=='jwt')context.addIssue({code:'custom',path:['EHR_SERVICE_IDENTITY_MODE'],message:'Production OCR-to-EHR calls require JWT workload identity'});
    if(environment.NODE_ENV==='production'&&environment.LAB_INTERNAL_SERVICE_TOKEN)context.addIssue({code:'custom',path:['LAB_INTERNAL_SERVICE_TOKEN'],message:'Local Lab service tokens are forbidden in production'});
    if(environment.NODE_ENV==='production'&&environment.PHARMACY_INTERNAL_SERVICE_TOKEN)context.addIssue({code:'custom',path:['PHARMACY_INTERNAL_SERVICE_TOKEN'],message:'Local Pharmacy service tokens are forbidden in production'});
    if(environment.NODE_ENV==='production'&&environment.IDENTITY_EHR_INTERNAL_SERVICE_TOKEN)context.addIssue({code:'custom',path:['IDENTITY_EHR_INTERNAL_SERVICE_TOKEN'],message:'Local Identity service tokens are forbidden in production'});
    if(environment.NODE_ENV==='production'&&environment.EHR_INTERNAL_SERVICE_TOKEN)context.addIssue({code:'custom',path:['EHR_INTERNAL_SERVICE_TOKEN'],message:'Local EHR service tokens are forbidden in production'});
    if(environment.LAB_SERVICE_IDENTITY_MODE==='jwt'&&!environment.LAB_EHR_WORKLOAD_TOKEN_FILE)context.addIssue({code:'custom',path:['LAB_EHR_WORKLOAD_TOKEN_FILE'],message:'LAB_EHR_WORKLOAD_TOKEN_FILE is required for JWT workload identity'});
    if(environment.PHARMACY_SERVICE_IDENTITY_MODE==='jwt'&&!environment.PHARMACY_EHR_WORKLOAD_TOKEN_FILE)context.addIssue({code:'custom',path:['PHARMACY_EHR_WORKLOAD_TOKEN_FILE'],message:'PHARMACY_EHR_WORKLOAD_TOKEN_FILE is required for JWT workload identity'});
    if(environment.IDENTITY_SERVICE_IDENTITY_MODE==='jwt'&&!environment.IDENTITY_EHR_WORKLOAD_TOKEN_FILE)context.addIssue({code:'custom',path:['IDENTITY_EHR_WORKLOAD_TOKEN_FILE'],message:'IDENTITY_EHR_WORKLOAD_TOKEN_FILE is required for JWT workload identity'});
    if(environment.OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE==='local-secret'&&!environment.OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN)context.addIssue({code:'custom',path:['OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN'],message:'Local Outreach-to-Identity calls require an ephemeral secret'});
    if(environment.OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE==='jwt'&&!environment.OUTREACH_CALLER_SUBJECT)context.addIssue({code:'custom',path:['OUTREACH_CALLER_SUBJECT'],message:'OUTREACH_CALLER_SUBJECT is required for JWT workload identity'});
    if(environment.NODE_ENV==='production'&&environment.OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE!=='jwt')context.addIssue({code:'custom',path:['OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE'],message:'Production Outreach-to-Identity calls require JWT workload identity'});
    if(environment.NODE_ENV==='production'&&environment.OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN)context.addIssue({code:'custom',path:['OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN'],message:'Local Outreach service tokens are forbidden in production'});
    const workloadKeys = [
      'WORKLOAD_DATABASE_URL',
    ] as const;
    const workloadConfigured = workloadKeys.some((key) => Boolean(environment[key]));
    if (workloadConfigured || environment.NODE_ENV === 'production') {
      for (const key of workloadKeys) {
        if (!environment[key]) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required for the isolated document-scanner workload`,
          });
        }
      }
    }
    if (environment.STORAGE_MODE === 's3') {
      for (const key of ['S3_BUCKET'] as const) {
        if (!environment[key]) {
          context.addIssue({ code: 'custom', path: [key], message: `${key} is required for S3 storage` });
        }
      }
      if (Boolean(environment.S3_ACCESS_KEY_ID) !== Boolean(environment.S3_SECRET_ACCESS_KEY)) {
        context.addIssue({ code: 'custom', path: ['S3_ACCESS_KEY_ID'], message: 'S3 access key and secret must be provided together' });
      }
    }
    if (environment.NODE_ENV === 'production') {
      if (environment.NODE_TLS_REJECT_UNAUTHORIZED === '0') context.addIssue({ code: 'custom',
        path: ['NODE_TLS_REJECT_UNAUTHORIZED'], message: 'Production TLS verification cannot be disabled globally' });
      for (const [key, value] of [['DATABASE_URL', environment.DATABASE_URL],
        ['WORKLOAD_DATABASE_URL', environment.WORKLOAD_DATABASE_URL]] as const) {
        if (value && databaseUrlOverridesTls(value)) context.addIssue({ code: 'custom', path: [key],
          message: 'Production database URL must not override verified TLS configuration' });
      }
      const origins = environment.CORS_ORIGINS.split(',').map((origin) => origin.trim());
      for (const origin of origins) {
        try {
          const parsed = new URL(origin);
          if (parsed.origin !== origin || parsed.protocol !== 'https:') throw new Error('invalid origin');
        } catch {
          context.addIssue({
            code: 'custom', path: ['CORS_ORIGINS'],
            message: 'Production CORS origins must be exact HTTPS origins without paths',
          });
          break;
        }
      }
      if (!environment.DATABASE_SSL) {
        context.addIssue({ code: 'custom', path: ['DATABASE_SSL'], message: 'TLS is required in production' });
      }
      if (!environment.DATABASE_SSL_ROOT_CERT_BASE64) {
        context.addIssue({
          code: 'custom', path: ['DATABASE_SSL_ROOT_CERT_BASE64'],
          message: 'The trusted PostgreSQL CA certificate is required in production',
        });
      }
      if (!environment.TRUST_PROXY_CIDRS) {
        context.addIssue({
          code: 'custom', path: ['TRUST_PROXY_CIDRS'],
          message: 'Approved reverse-proxy CIDRs are required in production',
        });
      } else if (environment.TRUST_PROXY_CIDRS.split(',')
        .map((cidr) => cidr.trim())
        .some((cidr) => !validProxyCidr(cidr))) {
        context.addIssue({
          code: 'custom', path: ['TRUST_PROXY_CIDRS'],
          message: 'TRUST_PROXY_CIDRS must contain only explicit IP addresses or CIDR ranges',
        });
      }
      if (environment.STORAGE_MODE !== 's3') {
        context.addIssue({ code: 'custom', path: ['STORAGE_MODE'], message: 'S3 storage is required in production' });
      }
      if (!environment.S3_KMS_KEY_ID) {
        context.addIssue({
          code: 'custom', path: ['S3_KMS_KEY_ID'],
          message: 'A KMS key is required for production PHI storage',
        });
      }
      for (const key of [
        'LAB_API_URL',
        'PHARMACY_API_URL',
        'IDENTITY_API_URL',
        'EHR_WORKLOAD_ISSUER_URL',
        'EHR_WORKLOAD_JWKS_URL',
        'S3_ENDPOINT',
      ] as const) {
        if (environment[key] && new URL(environment[key]).protocol !== 'https:') {
          context.addIssue({ code: 'custom', path: [key], message: `${key} must use HTTPS in production` });
        }
      }
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

let cachedEnvironment: Environment | undefined;

export function getEnvironment(): Environment {
  if (cachedEnvironment) return cachedEnvironment;
  const result = environmentSchema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid server configuration: ${details}`);
  }
  cachedEnvironment = result.data;
  return result.data;
}

export function resetEnvironmentForTests(): void {
  cachedEnvironment = undefined;
}
