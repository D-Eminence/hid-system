import { createHash } from 'node:crypto';

/**
 * Web push (B6, 0097) shared rules, without Nest: which push services a
 * browser subscription may name (rule E of the B6 contract), the endpoint's
 * digest and the VAPID key id. notification-api applies the same rule E
 * before it sends (its own copy, providers/web-push.ts).
 */
export type WebPushService = 'fcm' | 'mozilla' | 'apple' | 'windows';

export const WEB_PUSH_SERVICES: readonly WebPushService[] = ['fcm', 'mozilla', 'apple', 'windows'];
/** The longest endpoint accepted (the database ciphertext CHECK allows its encryption). */
export const WEB_PUSH_ENDPOINT_MAX_LENGTH = 2048;
/**
 * One send's timeout in Identity: notification-api's push timeout (at most
 * 5 s, its WEB_PUSH_SEND_TIMEOUT_MS, whatever NOTIFICATION_PROVIDER_TIMEOUT_MS
 * is) plus the internal hop, so notification-api always answers first. Ten
 * sends of a claim stay inside its 120-second lease.
 */
export const WEB_PUSH_DELIVERY_TIMEOUT_MS = 8_000;

const APPLE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com$/;
const WINDOWS = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com$/;
const DOTTED_DECIMAL = /^[0-9.]+$/;

export type WebPushEndpointCheck =
  | { ok: true; pushService: WebPushService }
  | { ok: false; reason: 'malformed' | 'unsupported' };

/**
 * Rule E. Malformed: not a string of at most 2048 characters, not a URL whose
 * WHATWG serialization is exactly the string (so the string hashed is the
 * string sent), not https, with user info, a port or a fragment: any `#`,
 * since an empty fragment (`hash === ''`) serializes as itself, and an empty
 * query (a bare `?`), both of which would store the same push resource under
 * a second digest and escape the digest's dedupe.
 * Unsupported: a well-formed https URL whose host is an IP literal or not
 * exactly one of the push services' names.
 */
export function checkWebPushEndpoint(endpoint: unknown): WebPushEndpointCheck {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > WEB_PUSH_ENDPOINT_MAX_LENGTH) {
    return { ok: false, reason: 'malformed' };
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (url.href !== endpoint || url.protocol !== 'https:' || url.username !== '' || url.password !== ''
      || url.port !== '' || url.hash !== '' || endpoint.includes('#') || (url.search === '' && endpoint.includes('?'))) {
    return { ok: false, reason: 'malformed' };
  }
  const host = url.hostname;
  if (host.includes('[') || host.includes(':') || DOTTED_DECIMAL.test(host)) return { ok: false, reason: 'unsupported' };
  const pushService = pushServiceForHost(host);
  return pushService ? { ok: true, pushService } : { ok: false, reason: 'unsupported' };
}

function pushServiceForHost(host: string): WebPushService | null {
  if (host === 'fcm.googleapis.com') return 'fcm';
  if (host === 'updates.push.services.mozilla.com') return 'mozilla';
  if (host === 'web.push.apple.com' || APPLE.test(host)) return 'apple';
  if (WINDOWS.test(host)) return 'windows';
  return null;
}

/** Lowercase hex SHA-256 of the endpoint's UTF-8 bytes, exactly as sent. */
export function webPushEndpointDigest(endpoint: string): string {
  return createHash('sha256').update(endpoint, 'utf8').digest('hex');
}

/** The first 16 lowercase hex characters of SHA-256 over the public key's 65 raw bytes. */
export function webPushKeyId(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
}

/**
 * The bytes of a base64url value, with or without `=` padding, or null when
 * it is not base64url.
 */
export function base64UrlBytes(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(value)) return null;
  const bare = value.replace(/=+$/, '');
  if (bare.length % 4 === 1) return null;
  const bytes = Buffer.from(bare, 'base64url');
  return bytes.toString('base64url') === bare ? bytes : null;
}
