import type { QoreIdNinRecord } from './qoreid-verification.types';

/**
 * How far a failed QoreID request got (Q109: QoreID charges every check it
 * receives, answered or not), so NinCheckOnce knows whether a retry would pay
 * again:
 * - 'not_sent': the NIN never reached QoreID's check, or QoreID refused the
 *   request before checking it (the token request failed, the connection was
 *   refused or its name did not resolve, 401, 429): nothing to keep.
 * - 'sent': the request was sent and no usable answer came back (a 5xx, a 4xx
 *   other than "not found", the connection lost after the request was
 *   written, a timeout): QoreID may have charged.
 * - 'answered': QoreID answered in full (its 404 "not found", or a 2xx body
 *   HID could not use): charged, and the same NIN gets the same answer again.
 */
export type QoreIdDelivery = 'not_sent' | 'sent' | 'answered';

export interface QoreIdDeliveryFacts {
  delivery: QoreIdDelivery;
  /** QoreID's HTTP status, when it answered with one. */
  status?: number;
  /** A 2xx answer HID could not use: the name and date of birth it gave, when they could be read. */
  record?: Extract<QoreIdNinRecord, { complete: false }>;
  /** QoreID's transaction id on that answer, when it was a safe integer. */
  providerReference?: string;
}

const facts = new WeakMap<object, QoreIdDeliveryFacts>();

/**
 * Marks an error with how far its request got. The first mark wins: an error
 * already marked where it was raised keeps that mark. Returns the error.
 */
export function markQoreIdDelivery<T>(error: T, value: QoreIdDeliveryFacts): T {
  if (typeof error === 'object' && error !== null && !facts.has(error)) facts.set(error, value);
  return error;
}

/** How far the request behind this error got; undefined for an error no QoreID request marked. */
export function qoreIdDelivery(error: unknown): QoreIdDeliveryFacts | undefined {
  return typeof error === 'object' && error !== null ? facts.get(error) : undefined;
}

/**
 * Network errors raised before the request could be written: the name did
 * not resolve, the connection was refused or could not be opened, or TLS
 * refused the server. Anything else may have reached QoreID.
 */
const NOT_SENT_NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH',
  'ENETDOWN', 'EHOSTDOWN', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_NOT_YET_VALID',
]);

/** True when a fetch failure provably happened before the request was written. */
export function failedBeforeSending(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    const code = typeof current === 'object' && 'code' in current ? (current as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && NOT_SENT_NETWORK_CODES.has(code)) return true;
    current = typeof current === 'object' && 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}
