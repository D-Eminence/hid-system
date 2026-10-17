import { RECORD_CHAT_FIRST_PARTY_ORIGIN, type Environment } from '../../config/environment';

/**
 * Patient record chat's settings (owner decision 1 of 2026-10-16), built once
 * from the validated environment. With the flag off the rest is unused and
 * may be absent. With it on, environment.ts has already required every
 * setting the request needs; there is no default model anywhere.
 */
export interface RecordChatConfig {
  readonly patientEnabled: boolean;
  /** Staff record chat (ADR-069); shares every other setting with the patient's. */
  readonly staffEnabled: boolean;
  readonly modelId?: string;
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly inferenceGeo?: 'us' | 'global';
  readonly maxOutputTokens: number;
  readonly effort?: 'low' | 'medium' | 'high';
  readonly deadlineMs: number;
  readonly maxRetries: number;
  readonly maxEvidenceChars: number;
  readonly dailyTokenBudget?: number;
  readonly noticeVersion?: string;
  readonly auditDigestKey?: Buffer;
}

/** The settings a model request needs, present when the flag is on. */
export interface EnabledRecordChatConfig extends RecordChatConfig {
  readonly modelId: string;
  readonly apiKey: string;
  readonly inferenceGeo: 'us' | 'global';
  readonly dailyTokenBudget: number;
  readonly noticeVersion: string;
  readonly auditDigestKey: Buffer;
}

export const RECORD_CHAT_CONFIG = Symbol('RECORD_CHAT_CONFIG');

export function recordChatConfig(environment: Pick<Environment, 'RECORD_CHAT_PATIENT_ENABLED' | 'RECORD_CHAT_STAFF_ENABLED'
  | 'RECORD_CHAT_MODEL_ID'
  | 'RECORD_CHAT_ANTHROPIC_API_KEY' | 'RECORD_CHAT_API_BASE_URL' | 'RECORD_CHAT_INFERENCE_GEO'
  | 'RECORD_CHAT_MAX_OUTPUT_TOKENS' | 'RECORD_CHAT_EFFORT' | 'RECORD_CHAT_DEADLINE_MS' | 'RECORD_CHAT_MAX_RETRIES'
  | 'RECORD_CHAT_MAX_EVIDENCE_CHARS' | 'RECORD_CHAT_DAILY_TOKEN_BUDGET' | 'RECORD_CHAT_NOTICE_VERSION'
  | 'RECORD_CHAT_AUDIT_DIGEST_KEY_B64'>): RecordChatConfig {
  return {
    patientEnabled: environment.RECORD_CHAT_PATIENT_ENABLED,
    staffEnabled: environment.RECORD_CHAT_STAFF_ENABLED,
    ...(environment.RECORD_CHAT_MODEL_ID ? { modelId: environment.RECORD_CHAT_MODEL_ID } : {}),
    ...(environment.RECORD_CHAT_ANTHROPIC_API_KEY ? { apiKey: environment.RECORD_CHAT_ANTHROPIC_API_KEY } : {}),
    // Always explicit, so the SDK never falls back to ANTHROPIC_BASE_URL.
    baseUrl: environment.RECORD_CHAT_API_BASE_URL ?? RECORD_CHAT_FIRST_PARTY_ORIGIN,
    ...(environment.RECORD_CHAT_INFERENCE_GEO ? { inferenceGeo: environment.RECORD_CHAT_INFERENCE_GEO } : {}),
    maxOutputTokens: environment.RECORD_CHAT_MAX_OUTPUT_TOKENS,
    ...(environment.RECORD_CHAT_EFFORT ? { effort: environment.RECORD_CHAT_EFFORT } : {}),
    deadlineMs: environment.RECORD_CHAT_DEADLINE_MS,
    maxRetries: environment.RECORD_CHAT_MAX_RETRIES,
    maxEvidenceChars: environment.RECORD_CHAT_MAX_EVIDENCE_CHARS,
    ...(environment.RECORD_CHAT_DAILY_TOKEN_BUDGET !== undefined
      ? { dailyTokenBudget: environment.RECORD_CHAT_DAILY_TOKEN_BUDGET } : {}),
    ...(environment.RECORD_CHAT_NOTICE_VERSION ? { noticeVersion: environment.RECORD_CHAT_NOTICE_VERSION } : {}),
    ...(environment.RECORD_CHAT_AUDIT_DIGEST_KEY_B64
      ? { auditDigestKey: Buffer.from(environment.RECORD_CHAT_AUDIT_DIGEST_KEY_B64, 'base64') } : {}),
  };
}

/** The enabled settings (for either audience); throws if a setting environment.ts requires is missing. */
export function enabledRecordChatConfig(config: RecordChatConfig): EnabledRecordChatConfig {
  if (!(config.patientEnabled || config.staffEnabled) || !config.modelId || !config.apiKey || !config.inferenceGeo
    || config.dailyTokenBudget === undefined || !config.noticeVersion || config.auditDigestKey?.length !== 32) {
    throw new Error('Record chat is not configured');
  }
  return config as EnabledRecordChatConfig;
}
