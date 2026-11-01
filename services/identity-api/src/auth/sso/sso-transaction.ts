import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { SSO_SITE_KINDS } from './sso-config';
import { openid } from './sso-libraries';
import { safeReturnPath } from './sso-return-path';

/**
 * The sign-in a product starts at `auth.` and finishes at its own callback
 * (ADR-070): `state`, `nonce` and the PKCE verifier (RFC 7636), each from
 * openid-client (randomState, randomNonce, randomPKCECodeVerifier), the page to
 * come back to and the client, kept on the server's side of the browser in a
 * transaction cookie on the product host, never in browser storage and never
 * in an address the provider sees (only `state`, `nonce` and the S256
 * challenge travel).
 *
 * The cookie is `__Host-hid_sso_tx_<id>`: HttpOnly, Secure, Path=/, no Domain,
 * SameSite=Lax (the callback is a navigation back from `auth.`), Max-Age 600.
 * The `__Host-` prefix means only the product host itself can set it. Its id
 * is derived from `state`, so two tabs signing in at once keep their own. Its
 * value is HMAC-SHA256-signed with a key derived (HKDF) from
 * AUTH_SIGNING_SECRET under its own label, so it is interchangeable with no
 * other token Identity signs, and its expiry is inside the signed payload and
 * checked by the server, whatever the browser kept.
 */
export const SSO_TRANSACTION_SECONDS = 600;
export const SSO_TRANSACTION_COOKIE_PREFIX = '__Host-hid_sso_tx_';
/** More open sign-ins than this on one browser are cleared, so the Cookie header stays bounded. */
export const SSO_TRANSACTION_COOKIE_LIMIT = 4;

/** 32 random bytes in base64url (openid-client's state, nonce and verifier). */
export const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;
const MAX_SEALED_LENGTH = 2_048;

export interface SsoTransaction {
  readonly clientId: string;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly returnTo: string;
  /** Whether the provider was asked not to show a page (prompt=none). */
  readonly silent: boolean;
  /** Unix seconds. */
  readonly expiresAt: number;
}

export function newTransaction(clientId: string, returnTo: string, silent: boolean, now = Date.now()): SsoTransaction {
  const library = openid();
  return {
    clientId,
    state: library.randomState(),
    nonce: library.randomNonce(),
    verifier: library.randomPKCECodeVerifier(),
    returnTo,
    silent,
    expiresAt: Math.floor(now / 1_000) + SSO_TRANSACTION_SECONDS,
  };
}

/** RFC 7636 S256, by openid-client: BASE64URL(SHA256(ASCII(verifier))). */
export function pkceChallenge(verifier: string): Promise<string> {
  return openid().calculatePKCECodeChallenge(verifier);
}

/** The cookie that holds the transaction of this state. */
export function transactionCookieName(state: string): string {
  return `${SSO_TRANSACTION_COOKIE_PREFIX}${createHash('sha256').update(`hid-sso-transaction-name:${state}`, 'utf8')
    .digest('hex').slice(0, 16)}`;
}

/** The digest under which a spent transaction is recorded (single use). */
export function transactionDigest(state: string): string {
  return createHash('sha256').update(`hid-sso-transaction:${state}`, 'utf8').digest('hex');
}

function key(signingSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', signingSecret, 'hid-sso', 'hid-sso-transaction-cookie:v1', 32));
}

function mac(signingSecret: string, payload: string): string {
  return createHmac('sha256', key(signingSecret)).update(payload, 'utf8').digest('base64url');
}

export function sealTransaction(signingSecret: string, transaction: SsoTransaction): string {
  const payload = Buffer.from(JSON.stringify({
    v: 1, c: transaction.clientId, s: transaction.state, n: transaction.nonce, pv: transaction.verifier,
    r: transaction.returnTo, p: transaction.silent ? 1 : 0, e: transaction.expiresAt,
  }), 'utf8').toString('base64url');
  return `${payload}.${mac(signingSecret, payload)}`;
}

/**
 * The transaction in a cookie value when its signature, shape and expiry all
 * hold; otherwise undefined. The caller still compares the state and the
 * client.
 */
export function openTransaction(signingSecret: string, sealed: unknown, now = Date.now()): SsoTransaction | undefined {
  if (typeof sealed !== 'string' || sealed.length > MAX_SEALED_LENGTH) return undefined;
  const [payload, signature, extra] = sealed.split('.');
  if (extra !== undefined || !payload || !signature || !/^[A-Za-z0-9_-]+$/.test(payload)) return undefined;
  const expected = Buffer.from(mac(signingSecret, payload), 'utf8');
  const supplied = Buffer.from(signature, 'utf8');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { v, c, s, n, pv, r, p, e } = value as Record<string, unknown>;
  if (v !== 1 || typeof c !== 'string' || !Object.hasOwn(SSO_SITE_KINDS, c)) return undefined;
  if (![s, n, pv].every((part) => typeof part === 'string' && RANDOM_VALUE.test(part))) return undefined;
  if (safeReturnPath(r) !== r || (p !== 0 && p !== 1)) return undefined;
  if (typeof e !== 'number' || !Number.isSafeInteger(e) || e <= Math.floor(now / 1_000)) return undefined;
  return { clientId: c, state: s as string, nonce: n as string, verifier: pv as string, returnTo: r as string,
    silent: p === 1, expiresAt: e };
}

/** Constant-time comparison of two strings. */
export function sameValue(first: string, second: string): boolean {
  const left = Buffer.from(first, 'utf8');
  const right = Buffer.from(second, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
