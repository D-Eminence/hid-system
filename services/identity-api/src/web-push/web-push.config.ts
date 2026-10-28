import { createPublicKey } from 'node:crypto';
import { type Environment, getEnvironment } from '../config/environment';
import { base64UrlBytes, webPushKeyId } from './web-push-endpoint';

/**
 * Whether Identity serves web push (B6, D13): on only when
 * WEB_PUSH_VAPID_PUBLIC_KEY and WEB_PUSH_SUBJECT are both valid. Identity
 * never holds the private key (notification-api does). Anything missing or
 * invalid is off, never a boot failure and never a value in a log: the
 * environment schema declares both as plain optional strings.
 */
export type WebPushConfiguration =
  | { on: true; applicationServerKey: string; keyId: string; subject: string }
  | { on: false; reason: 'missing' | 'invalid_public_key' | 'invalid_subject' };

const cache = new WeakMap<Environment, WebPushConfiguration>();

export function webPushConfiguration(environment: Environment = getEnvironment()): WebPushConfiguration {
  const cached = cache.get(environment);
  if (cached) return cached;
  const configuration = evaluate(environment.WEB_PUSH_VAPID_PUBLIC_KEY, environment.WEB_PUSH_SUBJECT);
  cache.set(environment, configuration);
  return configuration;
}

function evaluate(publicKey: string | undefined, subject: string | undefined): WebPushConfiguration {
  if (!publicKey || !subject) return { on: false, reason: 'missing' };
  const key = vapidPublicKeyBytes(publicKey);
  if (!key) return { on: false, reason: 'invalid_public_key' };
  if (!validVapidSubject(subject)) return { on: false, reason: 'invalid_subject' };
  return { on: true, applicationServerKey: publicKey, keyId: webPushKeyId(key), subject };
}

/**
 * The 65 bytes of an uncompressed P-256 public key given as 87 base64url
 * characters (first byte 0x04, a point on the curve), or null.
 */
export function vapidPublicKeyBytes(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{87}$/.test(value)) return null;
  const bytes = base64UrlBytes(value);
  if (!bytes || bytes.length !== 65 || bytes[0] !== 0x04) return null;
  try {
    createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: bytes.subarray(1, 33).toString('base64url'),
      y: bytes.subarray(33, 65).toString('base64url') }, format: 'jwk' });
  } catch {
    return null;
  }
  return bytes;
}

/** At most 256 characters: `mailto:` and an address, or an https URL with a host. */
export function validVapidSubject(value: string): boolean {
  if (value.length > 256 || /\s/.test(value)) return false;
  if (value.startsWith('mailto:')) return /^mailto:[^@/?#]+@[^@/?#]+\.[^@/?#]+$/.test(value);
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}
