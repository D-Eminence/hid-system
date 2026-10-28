import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign, verify } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, Optional } from '@nestjs/common';
import { type Environment, getEnvironment } from '../config/environment';

/**
 * Web push (B6, 0097): the empty, VAPID-signed push Identity asks for (N1).
 * A push carries no data, so there is no message encryption (RFC 8291); only
 * the VAPID token (RFC 8292, ES256 with node:crypto). This service is the
 * only holder of the private key. Nothing here logs or returns an endpoint,
 * a token or a key.
 */
export type WebPushServiceName = 'fcm' | 'mozilla' | 'apple' | 'windows';
export type WebPushOutcome = 'accepted' | 'gone' | 'retry' | 'rejected';
export interface WebPushSendResult {
  outcome: WebPushOutcome;
  pushStatus: number | null;
  retryAfterSeconds: number | null;
  safeCode: string | null;
}
export type WebPushTransport = (input: string, init: RequestInit) => Promise<Response>;
/** Tests inject a transport (NOTIFICATION_PROVIDER_MODE=test); live mode uses the global fetch. */
export const WEB_PUSH_TRANSPORT = Symbol('WEB_PUSH_TRANSPORT');
/** Tests inject a clock (milliseconds) for the token cache and Retry-After dates. */
export const WEB_PUSH_CLOCK = Symbol('WEB_PUSH_CLOCK');

export type WebPushOffReason = 'missing' | 'invalid_public_key' | 'invalid_subject' | 'invalid_private_key'
  | 'key_mismatch' | 'provider_disabled';
type WebPushOn = { on: true; applicationServerKey: string; keyId: string; subject: string; privateKey: KeyObject };
export type WebPushConfiguration = WebPushOn | { on: false; reason: WebPushOffReason };

/** D10: 4 hours covers a phone in Doze; a newer undelivered push replaces an older one (Topic). */
export const WEB_PUSH_HEADERS = Object.freeze({ TTL: '14400', Urgency: 'normal', Topic: 'hid-inbox' });
/**
 * One push's timeout: never above 5 s whatever NOTIFICATION_PROVIDER_TIMEOUT_MS
 * is (that setting is shared with SES, Brevo, Termii and Meta and may be up to
 * 15 s), so a push always ends before Identity's 8 s
 * WEB_PUSH_DELIVERY_TIMEOUT_MS gives up on this call and retries it: no push
 * is accepted after Identity has recorded it as a retry.
 */
export const WEB_PUSH_SEND_TIMEOUT_MS = 5_000;
/** The VAPID token lives 12 hours and is reused for the same audience until an hour before it ends. */
export const VAPID_TOKEN_SECONDS = 43_200;
const VAPID_TOKEN_REUSE_MARGIN_SECONDS = 3_600;
const RESPONSE_BODY_LIMIT = 4_096;
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

// ── Rule E (the same rule as Identity's web-push-endpoint.ts) ──
const APPLE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com$/;
const WINDOWS = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com$/;

/**
 * The push service of an endpoint that passes rule E, or null: a string of at
 * most 2048 characters whose WHATWG serialization is exactly itself; https,
 * no user info, port or fragment (no `#` at all: an empty fragment has
 * `hash === ''`) and no empty query (a bare `?`); a DNS host (no IP literal)
 * that is exactly one of the push services' names.
 */
export function webPushServiceOf(endpoint: unknown): WebPushServiceName | null {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.href !== endpoint || url.protocol !== 'https:' || url.username !== '' || url.password !== ''
      || url.port !== '' || url.hash !== '' || endpoint.includes('#') || (url.search === '' && endpoint.includes('?'))) {
    return null;
  }
  const host = url.hostname;
  if (host.includes('[') || host.includes(':') || /^[0-9.]+$/.test(host)) return null;
  if (host === 'fcm.googleapis.com') return 'fcm';
  if (host === 'updates.push.services.mozilla.com') return 'mozilla';
  if (host === 'web.push.apple.com' || APPLE.test(host)) return 'apple';
  if (WINDOWS.test(host)) return 'windows';
  return null;
}

/** The first 16 lowercase hex characters of SHA-256 over the public key's 65 raw bytes. */
export function webPushKeyId(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
}

function base64UrlExact(value: string, length: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === length && bytes.toString('base64url') === value ? bytes : null;
}

/** 87 base64url characters: 65 bytes, first 0x04, a point on P-256. */
export function vapidPublicKeyBytes(value: string): Buffer | null {
  if (value.length !== 87) return null;
  const bytes = base64UrlExact(value, 65);
  if (!bytes || bytes[0] !== 0x04) return null;
  try {
    createPublicKey({ key: publicJwk(bytes), format: 'jwk' });
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

function publicJwk(bytes: Buffer) {
  return { kty: 'EC', crv: 'P-256', x: bytes.subarray(1, 33).toString('base64url'), y: bytes.subarray(33, 65).toString('base64url') };
}

/**
 * D13: on only when the public key, the subject and the private key are all
 * valid and the private key signs what the public key verifies. Anything else
 * is off with its reason: never a boot failure, never a value anywhere.
 */
export function webPushConfiguration(environment: Pick<Environment, 'WEB_PUSH_VAPID_PUBLIC_KEY'
  | 'WEB_PUSH_VAPID_PRIVATE_KEY' | 'WEB_PUSH_SUBJECT'>): WebPushConfiguration {
  const publicKey = environment.WEB_PUSH_VAPID_PUBLIC_KEY;
  const privateKeyValue = environment.WEB_PUSH_VAPID_PRIVATE_KEY;
  const subject = environment.WEB_PUSH_SUBJECT;
  if (!publicKey || !privateKeyValue || !subject) return { on: false, reason: 'missing' };
  const publicBytes = vapidPublicKeyBytes(publicKey);
  if (!publicBytes) return { on: false, reason: 'invalid_public_key' };
  if (!validVapidSubject(subject)) return { on: false, reason: 'invalid_subject' };
  const d = privateKeyValue.length === 43 ? base64UrlExact(privateKeyValue, 32) : null;
  // A P-256 private scalar is 1 to n - 1.
  const scalar = d ? BigInt(`0x${d.toString('hex')}`) : 0n;
  if (!d || scalar < 1n || scalar >= P256_ORDER) return { on: false, reason: 'invalid_private_key' };
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: { ...publicJwk(publicBytes), d: d.toString('base64url') }, format: 'jwk' });
  } catch {
    return { on: false, reason: 'invalid_private_key' };
  }
  // The JWK import does not check that d belongs to x and y: sign and verify.
  try {
    const probe = Buffer.from('hid-vapid-key-pair-check');
    const signature = sign('sha256', probe, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const publicKeyObject = createPublicKey({ key: publicJwk(publicBytes), format: 'jwk' });
    if (!verify('sha256', probe, { key: publicKeyObject, dsaEncoding: 'ieee-p1363' }, signature)) {
      return { on: false, reason: 'key_mismatch' };
    }
  } catch {
    return { on: false, reason: 'key_mismatch' };
  }
  return { on: true, applicationServerKey: publicKey, keyId: webPushKeyId(publicBytes), subject, privateKey };
}

/** The VAPID JWT: ES256 over base64url(header).base64url(claims), the signature as 64 raw bytes. */
export function vapidToken(privateKey: KeyObject, audience: string, subject: string, expiresAt: number): string {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ aud: audience, exp: expiresAt, sub: subject })).toString('base64url');
  const input = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}

/** A Retry-After of seconds or an HTTP date, clamped to 1-3600 seconds; null when absent or unreadable. */
export function retryAfterSeconds(value: string | null, now: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  let seconds: number;
  if (/^\d{1,10}$/.test(text)) seconds = Number(text);
  else {
    const at = Date.parse(text);
    if (Number.isNaN(at)) return null;
    seconds = Math.ceil((at - now) / 1000);
  }
  return Math.min(3600, Math.max(1, seconds));
}

/** The push service's answer, as N1's outcome and safe code. */
export function classifyPushResponse(status: number, retryAfter: string | null, now: number): WebPushSendResult {
  const result = (outcome: WebPushOutcome, safeCode: string | null, wait: number | null = null): WebPushSendResult =>
    ({ outcome, pushStatus: status, retryAfterSeconds: wait, safeCode });
  if (status >= 200 && status <= 299) return result('accepted', null);
  if (status === 404 || status === 410) return result('gone', `push_${status}`);
  if (status === 429) return result('retry', 'push_429', retryAfterSeconds(retryAfter, now));
  if (status >= 500 && status <= 599) return result('retry', 'push_5xx', retryAfterSeconds(retryAfter, now));
  if (status >= 300 && status <= 399) return result('rejected', 'redirect_refused');
  if ([400, 401, 403, 413].includes(status)) return result('rejected', `push_${status}`);
  if (status >= 400 && status <= 499) return result('rejected', 'push_4xx');
  return result('retry', 'push_status');
}

/**
 * The outbound request for one empty push: TTL, Urgency, Topic and the VAPID
 * Authorization only; no Content-Encoding, no Crypto-Key, an empty body (a
 * zero-length byte array, so no Content-Type is added), never a redirect
 * followed.
 */
export function pushRequest(token: string, applicationServerKey: string, timeoutMs: number): RequestInit {
  return {
    method: 'POST',
    headers: { ...WEB_PUSH_HEADERS, Authorization: `vapid t=${token}, k=${applicationServerKey}` },
    body: new Uint8Array(0),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  };
}

/** Reads at most 4 KB of a response body and discards it. */
async function discardBody(response: Response): Promise<void> {
  try {
    const reader = response.body?.getReader();
    let read = 0;
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      read += chunk.value.byteLength;
      if (read >= RESPONSE_BODY_LIMIT) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    // The body is never used.
  }
}

/**
 * notification-api's web push provider: the configuration decided once, the
 * VAPID token cache per audience, the send and its classification, one log
 * line per send (service, status and outcome only).
 */
@Injectable()
export class WebPushProvider implements OnApplicationBootstrap {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(WebPushProvider.name);
  private readonly configuration: WebPushConfiguration;
  private readonly transport: WebPushTransport | null;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(@Optional() @Inject(WEB_PUSH_TRANSPORT) transport?: WebPushTransport,
    @Optional() @Inject(WEB_PUSH_CLOCK) private readonly clock: () => number = Date.now) {
    const mode = this.environment.NOTIFICATION_PROVIDER_MODE;
    this.transport = mode === 'live' ? (input, init) => fetch(input, init) : mode === 'test' ? transport ?? null : null;
    this.configuration = this.transport ? webPushConfiguration(this.environment) : { on: false, reason: 'provider_disabled' };
  }

  onApplicationBootstrap(): void {
    if (this.environment.NODE_ENV === 'test') return;
    if (this.configuration.on) this.logger.log(`Web push is on (keyId=${this.configuration.keyId})`);
    else this.logger.log(`Web push is off (reason=${this.configuration.reason})`);
  }

  get on(): boolean {
    return this.configuration.on;
  }

  get keyId(): string | null {
    return this.configuration.on ? this.configuration.keyId : null;
  }

  get offReason(): WebPushOffReason | null {
    return this.configuration.on ? null : this.configuration.reason;
  }

  /** Sends one empty push to an endpoint that passed rule E. */
  async send(endpoint: string, pushService: WebPushServiceName): Promise<WebPushSendResult> {
    const configuration = this.configuration;
    if (!configuration.on || !this.transport) {
      return { outcome: 'retry', pushStatus: null, retryAfterSeconds: null, safeCode: 'not_configured' };
    }
    const token = this.token(configuration, new URL(endpoint).origin);
    let result: WebPushSendResult;
    try {
      const response = await this.transport(endpoint,
        pushRequest(token, configuration.applicationServerKey,
          Math.min(this.environment.NOTIFICATION_PROVIDER_TIMEOUT_MS, WEB_PUSH_SEND_TIMEOUT_MS)));
      result = classifyPushResponse(response.status, response.headers.get('retry-after'), this.clock());
      await discardBody(response);
    } catch (error) {
      const timeout = (error as { name?: unknown } | null)?.name === 'TimeoutError';
      result = { outcome: 'retry', pushStatus: null, retryAfterSeconds: null, safeCode: timeout ? 'timeout' : 'transport_error' };
    }
    this.logger.log(`Web push outcome (event=web_push_outcome service=${pushService} `
      + `status=${result.pushStatus ?? 'none'} outcome=${result.outcome})`);
    return result;
  }

  private token(configuration: WebPushOn, audience: string): string {
    const now = Math.floor(this.clock() / 1000);
    const cached = this.tokens.get(audience);
    if (cached && cached.expiresAt - VAPID_TOKEN_REUSE_MARGIN_SECONDS > now) return cached.token;
    if (this.tokens.size >= 64) this.tokens.clear();
    const expiresAt = now + VAPID_TOKEN_SECONDS;
    const token = vapidToken(configuration.privateKey, audience, configuration.subject, expiresAt);
    this.tokens.set(audience, { token, expiresAt });
    return token;
  }
}
