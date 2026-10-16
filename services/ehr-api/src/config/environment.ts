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

/**
 * The production profile: the production deployment, or NODE_ENV production
 * outside staging (Identity's rule, CFG-PROD). Every ECS task runs with
 * NODE_ENV production, staging included, so a setting that staging may use
 * and production may not is keyed on this, not on NODE_ENV alone.
 */
export function isProductionProfile(environment: { HID_DEPLOYMENT_ENV?: string; NODE_ENV?: string }): boolean {
  return environment.HID_DEPLOYMENT_ENV === 'production'
    || (environment.NODE_ENV === 'production' && environment.HID_DEPLOYMENT_ENV !== 'staging');
}

/** The processor's first-party API origin, the only one production may name. */
export const RECORD_CHAT_FIRST_PARTY_ORIGIN = 'https://api.anthropic.com';
/** A model id's shape only; the Models API readiness check proves it exists and fits. */
const MODEL_ID_SHAPE = /^[a-z0-9][a-z0-9._:@-]{0,99}$/;
/**
 * The operator's attestation of the external-processing approval: the ADR
 * that records the processing agreement and transfer mechanism, the inference
 * geography, the retention of the chat history and the quotas, and the date it
 * was accepted, for example ADR-123@2026-10-16. Only its form is checked here;
 * the release checklist's record chat row checks what it names. The record
 * chat design ADR is not that ADR.
 */
const PROCESSING_APPROVAL = /^ADR-(\d{3})@(\d{4})-(\d{2})-(\d{2})$/;
const NOTICE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

interface RecordChatSettings {
  NODE_ENV: string;
  RECORD_CHAT_PATIENT_ENABLED: boolean;
  RECORD_CHAT_MODEL_ID?: string;
  RECORD_CHAT_ANTHROPIC_API_KEY?: string;
  RECORD_CHAT_API_BASE_URL?: string;
  RECORD_CHAT_INFERENCE_GEO?: string;
  RECORD_CHAT_PROCESSING_APPROVAL?: string;
  RECORD_CHAT_AUDIT_DIGEST_KEY_B64?: string;
  RECORD_CHAT_NOTICE_VERSION?: string;
  RECORD_CHAT_DAILY_TOKEN_BUDGET?: number;
}

/** Whether a processing approval names an ADR and a real calendar date that is not in the future. */
function validProcessingApproval(value: string | undefined): boolean {
  const match = value ? PROCESSING_APPROVAL.exec(value) : null;
  if (!match) return false;
  const [, , year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day) && date.getTime() <= Date.now();
}

/** Exactly 32 bytes in canonical base64. */
function validDigestKey(value: string | undefined): boolean {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

/**
 * Record chat's configuration rules. With the flag off nothing is required
 * and nothing is sent. With it on, every setting the request needs must be
 * present; nothing has a default model. NODE_ENV=production (every deployed
 * environment, staging included) also needs the operator's attestation of the
 * external-processing approval (PROCESSING_APPROVAL above) and the first-party
 * API origin.
 */
export function recordChatIssues(environment: RecordChatSettings): Array<{ path: string[]; message: string }> {
  if (!environment.RECORD_CHAT_PATIENT_ENABLED) return [];
  const issues: Array<{ path: string[]; message: string }> = [];
  const refuse = (key: keyof RecordChatSettings, message: string) => issues.push({ path: [key], message });
  if (!environment.RECORD_CHAT_MODEL_ID || !MODEL_ID_SHAPE.test(environment.RECORD_CHAT_MODEL_ID)) {
    refuse('RECORD_CHAT_MODEL_ID', 'Record chat needs RECORD_CHAT_MODEL_ID, the configured model id (there is no default)');
  }
  const apiKey = environment.RECORD_CHAT_ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.length < 20 || /\s/.test(apiKey)) {
    refuse('RECORD_CHAT_ANTHROPIC_API_KEY', 'Record chat needs its API key from the secret store');
  }
  if (!environment.RECORD_CHAT_INFERENCE_GEO) {
    refuse('RECORD_CHAT_INFERENCE_GEO', 'Record chat needs RECORD_CHAT_INFERENCE_GEO (us or global)');
  }
  if (!validDigestKey(environment.RECORD_CHAT_AUDIT_DIGEST_KEY_B64)) {
    refuse('RECORD_CHAT_AUDIT_DIGEST_KEY_B64', 'Record chat needs a 32-byte base64 audit digest key');
  }
  if (!environment.RECORD_CHAT_NOTICE_VERSION || !NOTICE_VERSION.test(environment.RECORD_CHAT_NOTICE_VERSION)) {
    refuse('RECORD_CHAT_NOTICE_VERSION', 'Record chat needs the notice version patients acknowledge (1-40 characters)');
  }
  if (environment.RECORD_CHAT_DAILY_TOKEN_BUDGET === undefined) {
    refuse('RECORD_CHAT_DAILY_TOKEN_BUDGET', 'Record chat needs a daily token budget');
  }
  const baseUrl = environment.RECORD_CHAT_API_BASE_URL;
  if (environment.NODE_ENV === 'production') {
    if (!validProcessingApproval(environment.RECORD_CHAT_PROCESSING_APPROVAL)) {
      refuse('RECORD_CHAT_PROCESSING_APPROVAL', 'Record chat requires the recorded external-processing approval: '
        + 'the ADR that records the processing agreement, geography, retention and quotas, and its acceptance date '
        + '(ADR-NNN@YYYY-MM-DD, not in the future)');
    }
    if (baseUrl !== undefined && baseUrl !== RECORD_CHAT_FIRST_PARTY_ORIGIN) {
      refuse('RECORD_CHAT_API_BASE_URL', `Production record chat may only reach ${RECORD_CHAT_FIRST_PARTY_ORIGIN}`);
    }
  } else if (baseUrl !== undefined && environment.NODE_ENV !== 'test' && new URL(baseUrl).protocol !== 'https:') {
    refuse('RECORD_CHAT_API_BASE_URL', 'RECORD_CHAT_API_BASE_URL must use HTTPS outside tests');
  }
  return issues;
}

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // The deployment profile; unset counts as production (deny by default).
    HID_DEPLOYMENT_ENV: z.enum(['development', 'staging', 'production']).default('production'),
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
    // Read only to refuse them in production: without S3_* keys the S3 client
    // uses the SDK's default chain, which reads these before the task role.
    AWS_ACCESS_KEY_ID: optionalString,
    AWS_SECRET_ACCESS_KEY: optionalString,
    AWS_SESSION_TOKEN: optionalString,
    // Patient record release (owner decision 4 of 2026-10-16, D7, ADR-065):
    // what the patient's own summary releases beyond encounters and notes, one
    // flag per category, each off by default and refused in the production
    // profile (below). Lab requests (orders) are never released.
    EHR_PATIENT_RELEASE_VITALS: booleanString,
    EHR_PATIENT_RELEASE_DIAGNOSES: booleanString,
    EHR_PATIENT_RELEASE_PRESCRIPTIONS: booleanString,
    EHR_PATIENT_RELEASE_LAB_RESULTS: booleanString,
    EHR_PATIENT_RELEASE_DOCUMENTS: booleanString,
    // Imported legacy medical history (owner decision 3 of 2026-10-16,
    // ADR-066): the patient's own read (a category of the release set, its own
    // route, never part of either summary) and the staff read (direct care,
    // standard consent and the patient's own sharing choice). Both off by
    // default and refused in the production profile (below).
    EHR_PATIENT_RELEASE_IMPORTED_HISTORY: booleanString,
    EHR_STAFF_IMPORTED_HISTORY_ENABLED: booleanString,
    // Patient record chat (owner decision 1 of 2026-10-16): a patient's
    // question about their own released records, answered by the Claude API.
    // Off by default. Nothing below has a model default: the model id comes
    // only from RECORD_CHAT_MODEL_ID in the deployment's configuration.
    RECORD_CHAT_PATIENT_ENABLED: booleanString,
    RECORD_CHAT_MODEL_ID: optionalString,
    RECORD_CHAT_ANTHROPIC_API_KEY: optionalString,
    RECORD_CHAT_API_BASE_URL: optionalUrl,
    RECORD_CHAT_INFERENCE_GEO: z.preprocess(emptyToUndefined, z.enum(['us', 'global']).optional()),
    RECORD_CHAT_PROCESSING_APPROVAL: optionalString,
    RECORD_CHAT_AUDIT_DIGEST_KEY_B64: optionalString,
    RECORD_CHAT_NOTICE_VERSION: optionalString,
    RECORD_CHAT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1024).max(16_000).default(4096),
    RECORD_CHAT_EFFORT: z.preprocess(emptyToUndefined, z.enum(['low', 'medium', 'high']).optional()),
    RECORD_CHAT_DEADLINE_MS: z.coerce.number().int().min(5000).max(25_000).default(25_000),
    // Always 0, as QOREID_MAX_RETRIES: a retry would send the same PHI again
    // under the one disclosure audit row written before the request (the
    // record chat ADR).
    RECORD_CHAT_MAX_RETRIES: z.coerce.number().int().min(0).max(0).default(0),
    RECORD_CHAT_MAX_EVIDENCE_CHARS: z.coerce.number().int().min(4000).max(90_000).default(40_000),
    RECORD_CHAT_DAILY_TOKEN_BUDGET: z.preprocess(emptyToUndefined,
      z.coerce.number().int().min(1).max(20_000_000).optional()),
  })
  .superRefine((environment, context) => {
    // D17: Lab is not routed at launch and every Lab permission is withdrawn
    // (0091 section 2). The production profile releases no Lab result to a
    // patient until the reviewed migration that enables Lab removes this rule.
    if (environment.EHR_PATIENT_RELEASE_LAB_RESULTS && isProductionProfile(environment)) {
      context.addIssue({ code: 'custom', path: ['EHR_PATIENT_RELEASE_LAB_RESULTS'],
        message: 'Lab results are not released to patients while Lab is off at launch (D17)' });
    }
    // ADR-065: no clinician-review gate or sensitivity classification is
    // built, so the production profile releases none of the EHR categories
    // until the clinical owner signs off each category and its wording
    // (release checklist P36). Each refusal is removed only by a reviewed
    // change that records that sign-off; staging and a local development run
    // may opt in. The AWS development stack runs in the production profile.
    for (const [flag, category] of [['EHR_PATIENT_RELEASE_VITALS', 'Vitals'],
      ['EHR_PATIENT_RELEASE_DIAGNOSES', 'Diagnoses'], ['EHR_PATIENT_RELEASE_PRESCRIPTIONS', 'Prescriptions'],
      ['EHR_PATIENT_RELEASE_DOCUMENTS', 'Documents']] as const) {
      if (environment[flag] && isProductionProfile(environment)) {
        context.addIssue({ code: 'custom', path: [flag], message: `${category} released to patients are refused in the `
          + 'production profile until the clinical owner signs off the category and its wording (release checklist P36, '
          + 'ADR-065)' });
      }
    }
    // ADR-066: imported legacy history is shown to nobody in the production
    // profile until the DPO and the owner sign off the legacy data's
    // provenance, scope and retention and Health-id renders it (release
    // checklist P37). Removed only by a reviewed change that records that
    // sign-off; staging and a local development run may opt in.
    for (const flag of ['EHR_PATIENT_RELEASE_IMPORTED_HISTORY', 'EHR_STAFF_IMPORTED_HISTORY_ENABLED'] as const) {
      if (environment[flag] && isProductionProfile(environment)) {
        context.addIssue({ code: 'custom', path: [flag], message: 'Imported legacy medical history is refused in the '
          + 'production profile until the DPO and the owner sign off the legacy data (release checklist P37, ADR-066)' });
      }
    }
    for (const issue of recordChatIssues(environment)) context.addIssue({ code: 'custom', ...issue });
    if (environment.EHR_PATIENT_RELEASE_DOCUMENTS && environment.STORAGE_MODE !== 's3') {
      context.addIssue({ code: 'custom', path: ['EHR_PATIENT_RELEASE_DOCUMENTS'],
        message: 'Releasing documents to patients needs S3 storage for their download' });
    }
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
      // CFG-PROD: production reaches S3 only with the ECS task role.
      if (environment.S3_ACCESS_KEY_ID || environment.S3_SECRET_ACCESS_KEY) context.addIssue({ code: 'custom',
        path: ['S3_ACCESS_KEY_ID'], message: 'Static S3 credentials are forbidden in production; use the ECS task role' });
      if (environment.AWS_ACCESS_KEY_ID || environment.AWS_SECRET_ACCESS_KEY || environment.AWS_SESSION_TOKEN) {
        context.addIssue({ code: 'custom', path: ['AWS_ACCESS_KEY_ID'],
          message: 'Static AWS credentials are forbidden in production; use the ECS task role' });
      }
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
  const issues = result.success ? [] : result.error.issues
    .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`);
  // The Anthropic SDK reads ANTHROPIC_* variables (a key, a token, a profile,
  // workload identity federation, a base URL, extra headers, a log level).
  // Record chat passes every option explicitly, and refuses to start beside
  // any of them, so no ambient credential, endpoint or header is ever used.
  const chatEnabled = result.success ? result.data.RECORD_CHAT_PATIENT_ENABLED
    : process.env.RECORD_CHAT_PATIENT_ENABLED === 'true';
  if (chatEnabled) {
    for (const name of Object.keys(process.env).filter((key) => key.startsWith('ANTHROPIC_')).sort()) {
      issues.push(`${name}: Ambient ANTHROPIC_* variables are refused while record chat is enabled; `
        + 'record chat takes its credential and endpoint only from RECORD_CHAT_* settings');
    }
  }
  if (!result.success || issues.length > 0) {
    throw new Error(`Invalid server configuration: ${issues.join('; ')}`);
  }
  cachedEnvironment = result.data;
  return result.data;
}

export function resetEnvironmentForTests(): void {
  cachedEnvironment = undefined;
}
