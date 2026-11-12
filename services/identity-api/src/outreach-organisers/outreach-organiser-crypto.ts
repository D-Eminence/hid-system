import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { normalizePatientPhone } from '../identity/contact-lookup';

/** The organiser terms the owner approved (owner decision 4 of 11 Nov 2026). */
export const OUTREACH_ORGANISER_TERMS_VERSION = '2026-11-01';

/** The phone refusal, in plain English. */
export const OUTREACH_PHONE_MESSAGE = 'Enter a phone number we can call, like 08012345678, '
  + 'or with its country code, like +234 801 234 5678.';

/**
 * A phone as E.164 (+ and 7-15 digits): a Nigerian local number (0 and 10
 * digits) is read as +234, spaces, dots, dashes and brackets are ignored, and
 * a trunk 0 typed after +234 is dropped. Undefined for anything else.
 */
export function normalizeOutreachPhone(raw: string): string | undefined {
  return normalizePatientPhone(raw);
}

/**
 * Group names that suggest a hospital, a health agency or a government body
 * (plan PR-1), the same rule as identity.outreach_group_name_allowed (0115).
 * The name is first reduced to plain Latin letters: Unicode NFKD, then
 * accents dropped (Yoruba, Igbo and Hausa letters keep their base letter);
 * anything left that is not a Latin letter, a digit, a space or . , ' ’ &
 * ( ) - / refuses the name, so look-alike letters from other scripts and
 * invisible characters cannot hide a word. Words are then compared in any
 * case, with single letters joined ("N.C.D.C" and "N C D C" read as "ncdc").
 * "who" is refused only as the acronym (in capitals, or dotted), so "Those who
 * care" is fine. The database refuses them too; Identity answers first so the
 * person is told before they choose a password.
 */
const ALLOWED_LETTERS = /^[A-Za-z0-9 .,'\u2019&()/-]+$/;
const RESERVED_WORD = new RegExp(' (hospitals?|hosp|ministry|ministries|government|govt|federal|commission|agency|agencies'
  + '|unicef|unfpa|usaid|nafdac|ncdc|nphcda|nhis|nhia|luth|fmc|msf) ');
const RESERVED_PHRASE = new RegExp(' (health organi[sz]ations?|world health|disease control|primary health ?care|health ?care boards?'
  + '|medical cent(re|er)s?|health services?|state health|red cross|red crescent|doctors without borders'
  + '|medecins sans frontieres) ');

export function reservedOrganiserName(name: string): boolean {
  const plain = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  if (!ALLOWED_LETTERS.test(plain)) return true;
  const cased = ` ${plain.replace(/[^A-Za-z0-9]+/g, ' ').trim()} `.replace(/(?<= [A-Za-z]) (?=[A-Za-z] )/g, '');
  const words = cased.toLowerCase();
  return RESERVED_WORD.test(words) || RESERVED_PHRASE.test(words) || cased.includes(' WHO ');
}

export function reservedNameProblem(): DomainProblem {
  return new DomainProblem(422, 'OUTREACH_ORGANISER_NAME_NOT_ALLOWED',
    'Choose another group name. It cannot use words kept for hospitals, health agencies or government bodies, such as '
    + '"hospital", "ministry" or "disease control", and it can only use ordinary letters, numbers, spaces and . , \' & ( ) - /. '
    + 'If you really are one of these bodies, contact Health ID support.');
}

const localKey = randomBytes(32);
const PHONE_CIPHER_VERSION = 1;
const PHONE_AAD = Buffer.from('hid-outreach-organiser-phone:v1', 'utf8');

/** The OTP key (or a per-process key outside production), or null in production without one. */
export function outreachKey(): Buffer | null {
  const environment = getEnvironment();
  if (environment.OTP_HMAC_KEY_B64) return Buffer.from(environment.OTP_HMAC_KEY_B64, 'base64');
  return environment.NODE_ENV === 'production' ? null : localKey;
}

/** HMAC-SHA-256 over '<domain>\0<label>' and each part after '\0'. */
export function domainHmac(key: Buffer, domain: string, label: string, ...parts: string[]): string {
  const digest = createHmac('sha256', key).update(`${domain}\0`).update(label);
  for (const part of parts) digest.update('\0').update(part);
  return digest.digest('hex');
}

function phoneKey(key: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'hid-outreach-organiser-phone', 32));
}

/** AES-256-GCM of an E.164 phone: version byte, 12-byte IV, 16-byte tag, ciphertext. */
export function encryptOutreachPhone(key: Buffer, phone: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', phoneKey(key), iv);
  cipher.setAAD(PHONE_AAD);
  const body = Buffer.concat([cipher.update(phone, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([PHONE_CIPHER_VERSION]), iv, cipher.getAuthTag(), body]);
}

/** The phone, or null when the ciphertext is missing or cannot be read with this key. */
export function decryptOutreachPhone(key: Buffer, value: Buffer | null | undefined): string | null {
  if (!value || value.length < 30 || value[0] !== PHONE_CIPHER_VERSION) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', phoneKey(key), value.subarray(1, 13));
    decipher.setAAD(PHONE_AAD);
    decipher.setAuthTag(value.subarray(13, 29));
    return Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** The text of a database error, for matching the refusal codes the commands raise. */
export function databaseMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message?: unknown }).message ?? '') : '';
}

export function databaseCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code) : undefined;
}

/** Whether a database error carries the refusal code `code` (alone, or as `CODE:detail`). */
export function hasRefusal(error: unknown, code: string): boolean {
  const message = databaseMessage(error);
  return message === code || message.startsWith(`${code}:`) || message.includes(code);
}
