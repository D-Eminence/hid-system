import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';

const CIPHERTEXT_VERSION = 1;
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u;
/** Providers so common that naming one says nothing about the person. */
const COMMON_PROVIDERS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'outlook.com',
  'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com']);

export interface CardRecipient {
  email: string;
  /** The patient's private label ("Who is this?"), never emailed. */
  label: string | null;
}

/** A link token: 32 random bytes, base64url without padding. */
export function isLinkToken(value: unknown): value is string {
  return typeof value === 'string' && LINK_TOKEN.test(value);
}

/** The address as stored and compared: trimmed and lower case, or null when it is not one. */
export function normalizeCardEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length >= 6 && email.length <= 254 && EMAIL.test(email) ? email : null;
}

/**
 * What the patient's list, the receiver's page and Activity show of an
 * address: the first character and a mask, then a common provider's domain,
 * or another domain's first character and last label (a workplace domain is
 * not exposed to whoever holds the link).
 */
export function cardRecipientHint(email: string): string {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const shownDomain = COMMON_PROVIDERS.has(domain) ? domain : `${domain.slice(0, 1)}•••.${domain.split('.').at(-1)}`;
  return `${Array.from(local)[0] ?? ''}•••@${shownDomain}`;
}

/** The network a request came from: its /24 (IPv4) or /48 (IPv6), or null. */
export function networkPrefix(ip: string | undefined): string | null {
  if (!ip) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const address = mapped ? mapped[1]! : ip;
  if (isIP(address) === 4) return `${address.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIP(address) !== 6) return null;
  const [head = '', tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 3).map((group) => parseInt(group, 16).toString(16)).join(':')}::/48`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Card links' secrets (0118). The address and private label are encrypted
 * with the emergency contacts' convention (AES-256-GCM under
 * NIN_ENCRYPTION_KEY_B64 and NIN_KEY_VERSION, a version byte, a 12-byte nonce
 * and the tag) with associated data naming the link, so a ciphertext cannot
 * move to another row. The address, the link token, the code, the network
 * and the stop link are keyed with the OTP key under distinct labels; the
 * database holds only those keyed values, never a token or a code.
 */
@Injectable()
export class CardLinksProtector {
  private readonly environment = getEnvironment();

  get keyVersion(): string {
    return this.environment.NIN_KEY_VERSION;
  }

  recipientHmac(email: string): string {
    return this.hmac('card-share', 'address', email);
  }

  tokenHmac(token: string): string {
    return this.hmac('card-share', 'link', token);
  }

  codeVerifier(tokenHmac: string, code: string): string {
    return this.hmac('card-share', 'code', tokenHmac, code);
  }

  networkHmac(ip: string | undefined): string | null {
    const prefix = networkPrefix(ip);
    return prefix ? this.hmac('card-share', 'network', prefix) : null;
  }

  /** "Stop these emails": the link id and its keyed tag (it cannot open the card). */
  stopToken(shareId: string): string {
    return `${shareId}.${this.stopTag(shareId).toString('base64url')}`;
  }

  /** The link id of a genuine stop token, or null. */
  stopShareId(stopToken: string): string | null {
    const [shareId = '', tag = ''] = stopToken.split('.');
    if (!UUID.test(shareId) || !LINK_TOKEN.test(tag)) return null;
    const expected = this.stopTag(shareId);
    const given = Buffer.from(tag, 'base64url');
    return given.length === expected.length && timingSafeEqual(given, expected) ? shareId : null;
  }

  newLinkToken(): string {
    return randomBytes(32).toString('base64url');
  }

  newSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  newCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  encrypt(shareId: string, recipient: CardRecipient): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), nonce);
    cipher.setAAD(associatedData(shareId));
    return Buffer.concat([Buffer.from([CIPHERTEXT_VERSION]), nonce,
      cipher.update(JSON.stringify({ email: recipient.email, label: recipient.label }), 'utf8'), cipher.final(),
      cipher.getAuthTag()]);
  }

  decrypt(shareId: string, keyVersion: string, value: Buffer): CardRecipient {
    if (keyVersion !== this.environment.NIN_KEY_VERSION || value.length < 30 || value[0] !== CIPHERTEXT_VERSION) {
      throw unavailable();
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), value.subarray(1, 13));
      decipher.setAAD(associatedData(shareId));
      decipher.setAuthTag(value.subarray(value.length - 16));
      const parsed = JSON.parse(Buffer.concat([decipher.update(value.subarray(13, value.length - 16)), decipher.final()])
        .toString('utf8')) as Partial<CardRecipient>;
      if (typeof parsed.email !== 'string' || (parsed.label !== null && typeof parsed.label !== 'string')) {
        throw new Error('shape');
      }
      return { email: parsed.email, label: parsed.label ?? null };
    } catch {
      throw unavailable();
    }
  }

  private stopTag(shareId: string): Buffer {
    return createHmac('sha256', this.otpKey()).update(['card-share', 'stop', shareId].join('\0')).digest();
  }

  private hmac(...parts: string[]): string {
    return createHmac('sha256', this.otpKey()).update(parts.join('\0')).digest('hex');
  }

  private encryptionKey(): Buffer {
    const encoded = this.environment.NIN_ENCRYPTION_KEY_B64;
    const key = encoded ? Buffer.from(encoded, 'base64') : undefined;
    if (!key || key.length !== 32) throw unavailable();
    return key;
  }

  private otpKey(): Buffer {
    const encoded = this.environment.OTP_HMAC_KEY_B64;
    const key = encoded ? Buffer.from(encoded, 'base64') : undefined;
    if (!key || key.length !== 32) throw unavailable();
    return key;
  }
}

function associatedData(shareId: string): Buffer {
  return Buffer.from(`identity:card-share:${shareId}:recipient`, 'utf8');
}

/** 503 CARD_SHARE_UNAVAILABLE: never a key's or a driver's message. */
export function cardLinksUnavailable(): DomainProblem {
  return new DomainProblem(503, 'CARD_SHARE_UNAVAILABLE', 'Card links are not available right now. Try again later.');
}

function unavailable(): DomainProblem {
  return cardLinksUnavailable();
}
