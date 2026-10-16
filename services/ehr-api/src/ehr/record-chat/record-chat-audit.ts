import { createHmac } from 'node:crypto';
import { canonicalJson, type SourceBinding } from './evidence-extract';

/**
 * Patient record chat's audit details (owner decision 1 of 2026-10-16). Each
 * row names the external processor and holds codes, counts, digests and ids
 * only: never a question, an answer, record text, a name or an identifier
 * other than the record chat message id and the processor's message id.
 */
export const DISCLOSURE_DETAIL_KEYS = ['processor', 'model', 'inferenceGeo', 'audience', 'sourceCount', 'sourceCounts',
  'priorExchangeCount', 'withheldCategories', 'truncated', 'noticeVersion', 'reservedTokens', 'maxOutputTokens',
  'disclosureDigest'] as const;
export const ANSWER_DETAIL_KEYS = ['processor', 'model', 'status', 'reason', 'stopReason', 'refusalCategory',
  'citationsValid', 'citedSourceCount', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'servedGeo', 'processorMessageId', 'durationMs'] as const;
export const HISTORY_DETAIL_KEYS = ['exchangeCount', 'hiddenCount', 'deletedCount'] as const;

type DetailKey = (typeof DISCLOSURE_DETAIL_KEYS)[number] | (typeof ANSWER_DETAIL_KEYS)[number]
  | (typeof HISTORY_DETAIL_KEYS)[number];

/** Only the allowlisted keys, and only scalar, count-map or code-array values. */
export function auditDetails(allowed: readonly DetailKey[], values: Partial<Record<DetailKey, unknown>>):
  Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = values[key];
    if (value === undefined) continue;
    details[key] = value;
  }
  return details;
}

/**
 * A keyed digest of exactly what was disclosed: the message, the model and
 * geography, the bound records (kind, id and content hash), the question's
 * SHA-256 and the earlier exchanges sent. The key (RECORD_CHAT_AUDIT_DIGEST_KEY_B64)
 * is held only by EHR, so the digest proves a disclosure later without
 * storing what it contained.
 */
export function disclosureDigest(key: Buffer, input: {
  messageId: string; model: string; inferenceGeo: string; bindings: readonly SourceBinding[]; questionSha256: string;
  priorMessageIds: readonly string[];
}): string {
  return createHmac('sha256', key).update(canonicalJson(input), 'utf8').digest('hex');
}
