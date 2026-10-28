import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';

const CIPHERTEXT_VERSION = 1;
/**
 * The key version prefix of a sign-up row written without the NIN encryption
 * key (PatientEnrollmentService: SIGNUP_DERIVED_KEY_PREFIX), and the HKDF
 * label it derives that key from the OTP key with. Kept identical here so a
 * sign-up patient's phone and declared hospital can be read back.
 */
const SIGNUP_DERIVED_KEY_PREFIX = 'otp-hkdf:';
const SIGNUP_DERIVED_KEY_INFO = 'hid:public-patient-signup:encryption:v1';

export type ProfileContactChannel = 'email' | 'phone';
export type EnrollmentCiphertextPurpose = 'phone' | 'contact' | 'profile';

/**
 * Encryption of the patient's profile data (0094), with the application's
 * AES-256-GCM convention (version byte, 12-byte nonce, ciphertext, 16-byte
 * tag) and NIN_ENCRYPTION_KEY_B64, as emergency contacts use it:
 * - a changed contact under `identity:patient-contact:<changeId>:<channel>`;
 * - the photo under `identity:patient-photo:<patientId>:<sha256>`, which
 *   binds the bytes to the hash the database keeps.
 * It also reads back what sign-up stored (the declared phone and profile,
 * under `identity:public-patient-enrollment:<enrollmentId>:<purpose>`, with
 * the NIN key or the OTP-derived key of the row's key version). Nothing here
 * logs; a value that does not decrypt is undefined.
 */
@Injectable()
export class PatientProfileCrypto {
  private readonly environment = getEnvironment();

  get keyVersion(): string {
    return this.environment.NIN_KEY_VERSION;
  }

  get verifierKeyVersion(): string {
    return this.environment.OTP_HMAC_KEY_VERSION;
  }

  /** 503 PROFILE_PROTECTION_UNAVAILABLE unless the NIN encryption key and the OTP key are configured. */
  assertConfigured(): void {
    this.encryptionKey();
    this.otpKey();
  }

  encryptContact(changeId: string, channel: ProfileContactChannel, value: string): Buffer {
    return this.encrypt(this.encryptionKey(), `identity:patient-contact:${changeId}:${channel}`, Buffer.from(value, 'utf8'));
  }

  decryptContact(changeId: string, channel: ProfileContactChannel, keyVersion: string | null,
    value: Buffer | null): string | undefined {
    if (keyVersion !== this.environment.NIN_KEY_VERSION) return undefined;
    const key = this.optionalEncryptionKey();
    if (!key) return undefined;
    return this.decrypt(key, `identity:patient-contact:${changeId}:${channel}`, value)?.toString('utf8');
  }

  encryptPhoto(patientId: string, sha256: string, bytes: Buffer): Buffer {
    return this.encrypt(this.encryptionKey(), `identity:patient-photo:${patientId}:${sha256}`, bytes);
  }

  decryptPhoto(patientId: string, sha256: string, keyVersion: string, value: Buffer): Buffer {
    const key = keyVersion === this.environment.NIN_KEY_VERSION ? this.optionalEncryptionKey() : undefined;
    const bytes = key ? this.decrypt(key, `identity:patient-photo:${patientId}:${sha256}`, value) : undefined;
    if (!bytes) throw this.unavailable();
    return bytes;
  }

  /** A sign-up or NIN-route enrollment's ciphertext, with the key its key version names. */
  decryptEnrollment(enrollmentId: string, purpose: EnrollmentCiphertextPurpose, keyVersion: string | null,
    value: Buffer | null): string | undefined {
    const key = this.enrollmentKey(keyVersion);
    if (!key) return undefined;
    return this.decrypt(key, `identity:public-patient-enrollment:${enrollmentId}:${purpose}`, value)?.toString('utf8');
  }

  /** The stored verifier of a contact change's code: an HMAC bound to the change, never the code. */
  codeVerifier(changeId: string, code: string): string {
    return createHmac('sha256', this.otpKey())
      .update(['hid-patient-contact-change:v1', changeId, code].join('\u001f'), 'utf8').digest('hex');
  }

  /** The account's wrong-password bucket for contact changes, in its own HMAC domain (auth.otp_rate_limits). */
  passwordFailureBucket(accountId: string): string {
    return createHmac('sha256', this.otpKey())
      .update(['hid-patient-contact-change-password:v1', accountId].join('\u001f'), 'utf8').digest('hex');
  }

  private encrypt(key: Buffer, associatedData: string, plaintext: Buffer): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    return Buffer.concat([Buffer.from([CIPHERTEXT_VERSION]), nonce, cipher.update(plaintext), cipher.final(),
      cipher.getAuthTag()]);
  }

  private decrypt(key: Buffer, associatedData: string, value: Buffer | null): Buffer | undefined {
    if (!value || value.length < 30 || value[0] !== CIPHERTEXT_VERSION) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(1, 13));
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      decipher.setAuthTag(value.subarray(value.length - 16));
      return Buffer.concat([decipher.update(value.subarray(13, value.length - 16)), decipher.final()]);
    } catch {
      return undefined;
    }
  }

  private enrollmentKey(keyVersion: string | null): Buffer | undefined {
    if (!keyVersion) return undefined;
    if (keyVersion.startsWith(SIGNUP_DERIVED_KEY_PREFIX)) {
      const otpKey = this.optionalOtpKey();
      if (!otpKey || keyVersion !== `${SIGNUP_DERIVED_KEY_PREFIX}${this.environment.OTP_HMAC_KEY_VERSION}`) return undefined;
      return Buffer.from(hkdfSync('sha256', otpKey, Buffer.alloc(0), Buffer.from(SIGNUP_DERIVED_KEY_INFO), 32));
    }
    return keyVersion === this.environment.NIN_KEY_VERSION ? this.optionalEncryptionKey() : undefined;
  }

  private optionalEncryptionKey(): Buffer | undefined {
    const encoded = this.environment.NIN_ENCRYPTION_KEY_B64;
    const key = encoded ? Buffer.from(encoded, 'base64') : undefined;
    return key && key.length === 32 ? key : undefined;
  }

  private optionalOtpKey(): Buffer | undefined {
    const encoded = this.environment.OTP_HMAC_KEY_B64;
    const key = encoded ? Buffer.from(encoded, 'base64') : undefined;
    return key && key.length === 32 ? key : undefined;
  }

  private encryptionKey(): Buffer {
    const key = this.optionalEncryptionKey();
    if (!key) throw this.unavailable();
    return key;
  }

  private otpKey(): Buffer {
    const key = this.optionalOtpKey();
    if (!key) throw this.unavailable();
    return key;
  }

  private unavailable(): DomainProblem {
    return new DomainProblem(503, 'PROFILE_PROTECTION_UNAVAILABLE', 'This part of your profile is temporarily unavailable');
  }
}
