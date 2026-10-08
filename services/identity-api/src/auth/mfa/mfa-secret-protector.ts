import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainProblem } from '../../common/problem';
import { getEnvironment } from '../../config/environment';

const CIPHERTEXT_VERSION = 1;

/**
 * Protects TOTP secrets and recovery codes with keys derived (HKDF-SHA-256)
 * from MFA_SECRET_KEY_B64, so the encryption key and the recovery-code MAC key
 * are never the same bytes. Secrets use the application AES-256-GCM convention
 * (version byte, 12-byte nonce, tag) with associated data that binds the
 * ciphertext to its factor and account.
 */
@Injectable()
export class MfaSecretProtector {
  private readonly environment = getEnvironment();
  private derived?: { secretKey: Buffer; recoveryKey: Buffer };

  get keyVersion(): string {
    return this.environment.MFA_KEY_VERSION;
  }

  assertConfigured(): void {
    this.keys();
  }

  encryptSecret(factorId: string, accountId: string, secret: Buffer): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys().secretKey, nonce);
    cipher.setAAD(this.associatedData(factorId, accountId));
    return Buffer.concat([Buffer.from([CIPHERTEXT_VERSION]), nonce, cipher.update(secret), cipher.final(),
      cipher.getAuthTag()]);
  }

  decryptSecret(factorId: string, accountId: string, keyVersion: string, value: Buffer): Buffer {
    if (keyVersion !== this.keyVersion || value.length < 30 || value[0] !== CIPHERTEXT_VERSION) {
      throw this.unavailable();
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.keys().secretKey, value.subarray(1, 13));
      decipher.setAAD(this.associatedData(factorId, accountId));
      decipher.setAuthTag(value.subarray(value.length - 16));
      return Buffer.concat([decipher.update(value.subarray(13, value.length - 16)), decipher.final()]);
    } catch {
      throw this.unavailable();
    }
  }

  /** Keyed digest of a normalized recovery code, bound to its account. */
  recoveryCodeDigest(accountId: string, normalizedCode: string): string {
    return createHmac('sha256', this.keys().recoveryKey)
      .update(`hid-platform-mfa-recovery:v1\u001f${accountId}\u001f${normalizedCode}`, 'utf8').digest('hex');
  }

  /** Challenge and similar bearer tokens carry 256 random bits; a plain digest suffices. */
  tokenDigest(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /** HMAC bucket for the shared rate-limit table; never a raw identifier. */
  rateBucket(...parts: string[]): string {
    return createHmac('sha256', this.keys().recoveryKey)
      .update(`hid-platform-mfa-rate:v1\u001f${parts.join('\u001f')}`, 'utf8').digest('hex');
  }

  private associatedData(factorId: string, accountId: string): Buffer {
    return Buffer.from(`auth:mfa-factor:${factorId}:${accountId}:totp-secret`, 'utf8');
  }

  private keys(): { secretKey: Buffer; recoveryKey: Buffer } {
    if (this.derived) return this.derived;
    const encoded = this.environment.MFA_SECRET_KEY_B64;
    const master = encoded ? Buffer.from(encoded, 'base64') : undefined;
    if (!master || master.length !== 32) throw this.unavailable();
    const derive = (info: string) => Buffer.from(hkdfSync('sha256', master, 'hid-platform-mfa', info, 32));
    this.derived = { secretKey: derive('totp-secret:v1'), recoveryKey: derive('recovery-code:v1') };
    return this.derived;
  }

  private unavailable(): DomainProblem {
    return new DomainProblem(503, 'MFA_UNAVAILABLE', 'Administrator MFA is temporarily unavailable');
  }
}
