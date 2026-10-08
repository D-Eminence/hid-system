import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP (RFC 4226 HOTP) with the parameters every common authenticator
 * app supports: HMAC-SHA-1, 6 digits, 30-second period. Codes are accepted for
 * the current step and one step either side to absorb clock drift; the caller
 * must then refuse any step at or below the factor's last accepted step.
 */
export const TOTP_ALGORITHM = 'SHA1';
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_WINDOW_STEPS = 1;
/** 160-bit secret, the RFC 4226 recommended length. */
export const TOTP_SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Buffer {
  const normalized = text.replace(/[\s=]/g, '').toUpperCase();
  if (!/^[A-Z2-7]*$/.test(normalized)) throw new Error('Invalid base32 value');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of normalized) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('Invalid HOTP counter');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | (digest[offset + 1]! << 16)
    | (digest[offset + 2]! << 8)
    | digest[offset + 3]!;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export function totpStep(nowMs: number, periodSeconds = TOTP_PERIOD_SECONDS): number {
  return Math.floor(nowMs / 1000 / periodSeconds);
}

export function totp(secret: Uint8Array, nowMs: number): string {
  return hotp(secret, totpStep(nowMs));
}

/**
 * Returns the time step a code belongs to, or null. Every candidate step is
 * compared in constant time and the loop does not exit early.
 */
export function matchTotp(secret: Uint8Array, code: string, nowMs: number,
  windowSteps = TOTP_WINDOW_STEPS): number | null {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const supplied = Buffer.from(code, 'utf8');
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (let offset = -windowSteps; offset <= windowSteps; offset += 1) {
    const step = current + offset;
    if (step < 1) continue;
    const expected = Buffer.from(hotp(secret, step), 'utf8');
    if (timingSafeEqual(expected, supplied) && matched === null) matched = step;
  }
  return matched;
}

/** The provisioning URI understood by authenticator apps (Key URI format). */
export function otpauthUri(issuer: string, accountLabel: string, secretBase32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountLabel)}`;
  const parameters = new URLSearchParams({
    secret: secretBase32, issuer, algorithm: TOTP_ALGORITHM,
    digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}

/**
 * Recovery codes: ten characters from the Crockford base32 alphabet (50 bits),
 * shown as XXXXX-XXXXX. Normalization accepts lower case, separators and the
 * usual O/0 and I/L/1 confusions.
 */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCode(draw: (maximum: number) => number = (maximum) => randomInt(maximum)): string {
  let code = '';
  for (let index = 0; index < 10; index += 1) code += RECOVERY_ALPHABET[draw(RECOVERY_ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export function normalizeRecoveryCode(input: string): string | null {
  const normalized = input.toUpperCase().replace(/[\s-]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/.test(normalized) ? normalized : null;
}
