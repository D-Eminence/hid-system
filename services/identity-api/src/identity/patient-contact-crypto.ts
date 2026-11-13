import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Environment } from '../config/environment';

/**
 * The patient contact encryption public sign-up uses (0092) and that the
 * outreach assisted Health ID (0119) shares, so both write identity.patients'
 * contact ciphertext with one key and one key_version: the NIN encryption key
 * (NIN_KEY_VERSION) when configured, else a key derived from the OTP key with
 * HKDF-SHA256 (`otp-hkdf:` and OTP_HMAC_KEY_VERSION). AES-256-GCM, a version
 * byte 1, a 12-byte nonce and the tag; the additional data binds the value to
 * the row id and its purpose.
 */
export const SIGNUP_DERIVED_KEY_PREFIX = 'otp-hkdf:';

/** The process's OTP key when OTP_HMAC_KEY_B64 is not configured (outside production only). */
export const LOCAL_OTP_KEY = randomBytes(32);

export type ContactCipherPurpose = 'nin' | 'profile' | 'contact' | 'phone';

type KeyEnvironment = Pick<Environment, 'OTP_HMAC_KEY_B64' | 'OTP_HMAC_KEY_VERSION' | 'NIN_ENCRYPTION_KEY_B64'
  | 'NIN_KEY_VERSION'>;

export function otpHmacKey(environment: Pick<Environment, 'OTP_HMAC_KEY_B64'>): Buffer {
  return environment.OTP_HMAC_KEY_B64 ? Buffer.from(environment.OTP_HMAC_KEY_B64, 'base64') : LOCAL_OTP_KEY;
}

export function derivedContactKeyVersion(environment: Pick<Environment, 'OTP_HMAC_KEY_VERSION'>): string {
  return `${SIGNUP_DERIVED_KEY_PREFIX}${environment.OTP_HMAC_KEY_VERSION}`;
}

export function derivedContactKey(otpKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', otpKey, Buffer.alloc(0),
    Buffer.from('hid:public-patient-signup:encryption:v1'), 32));
}

/** The key and key_version a new patient contact is encrypted with. */
export function currentContactEncryption(environment: KeyEnvironment): { key: Buffer; version: string } {
  if (environment.NIN_ENCRYPTION_KEY_B64) {
    return { key: Buffer.from(environment.NIN_ENCRYPTION_KEY_B64, 'base64'), version: environment.NIN_KEY_VERSION };
  }
  return { key: derivedContactKey(otpHmacKey(environment)), version: derivedContactKeyVersion(environment) };
}

/** The key of a stored key_version, or undefined when this process does not hold it. */
export function contactKeyForVersion(environment: KeyEnvironment, version: string): Buffer | undefined {
  if (version.startsWith(SIGNUP_DERIVED_KEY_PREFIX)) {
    return version === derivedContactKeyVersion(environment) ? derivedContactKey(otpHmacKey(environment)) : undefined;
  }
  return environment.NIN_ENCRYPTION_KEY_B64 && version === environment.NIN_KEY_VERSION
    ? Buffer.from(environment.NIN_ENCRYPTION_KEY_B64, 'base64') : undefined;
}

function additionalData(id: string, purpose: ContactCipherPurpose): Buffer {
  return Buffer.from(`identity:public-patient-enrollment:${id}:${purpose}`);
}

export function encryptContactValue(key: Buffer, id: string, purpose: ContactCipherPurpose, value: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(additionalData(id, purpose));
  return Buffer.concat([Buffer.from([1]), nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
}

/** The plaintext, or undefined when the value is malformed or does not authenticate. */
export function decryptContactValue(key: Buffer, id: string, purpose: ContactCipherPurpose,
  value: Buffer): string | undefined {
  if (value.length < 30 || value[0] !== 1) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(1, 13));
    decipher.setAAD(additionalData(id, purpose));
    decipher.setAuthTag(value.subarray(value.length - 16));
    return Buffer.concat([decipher.update(value.subarray(13, value.length - 16)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
