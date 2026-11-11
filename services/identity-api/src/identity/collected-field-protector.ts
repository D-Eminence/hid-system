import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';

const CIPHERTEXT_VERSION = 1;

/**
 * Encrypts the personal data 0122 collects (the facility applicant's phone at
 * sign-up; the patient's phone and address at the registration desk) with the
 * application AES-256-GCM convention of the emergency contacts (0084): a
 * version byte, a 12-byte nonce, the ciphertext and the tag, under the NIN
 * encryption key and its version. The associated data binds each value to
 * the row it belongs to, so a ciphertext copied to another row does not
 * decrypt:
 *   identity:facility-signup-phone:<emailed code id>
 *   identity:registration-case:<case id>:phone
 *   identity:registration-case:<case id>:address
 */
export class CollectedFieldProtector {
  constructor(private readonly unavailable: () => DomainProblem = () =>
    new DomainProblem(503, 'COLLECTED_FIELDS_UNAVAILABLE', 'This form cannot be saved right now; try again later')) {}

  get keyVersion(): string {
    return getEnvironment().NIN_KEY_VERSION;
  }

  /** Throws the unavailable problem when the key is missing or not 32 bytes. */
  assertConfigured(): void {
    this.key();
  }

  encrypt(label: string, plain: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), nonce);
    cipher.setAAD(Buffer.from(label, 'utf8'));
    return Buffer.concat([Buffer.from([CIPHERTEXT_VERSION]), nonce,
      cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  }

  decrypt(label: string, keyVersion: string, value: Buffer): string {
    if (keyVersion !== this.keyVersion || value.length < 30 || value[0] !== CIPHERTEXT_VERSION) {
      throw this.unavailable();
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key(), value.subarray(1, 13));
      decipher.setAAD(Buffer.from(label, 'utf8'));
      decipher.setAuthTag(value.subarray(value.length - 16));
      return Buffer.concat([decipher.update(value.subarray(13, value.length - 16)), decipher.final()])
        .toString('utf8');
    } catch {
      throw this.unavailable();
    }
  }

  private key(): Buffer {
    const encoded = getEnvironment().NIN_ENCRYPTION_KEY_B64;
    const key = encoded ? Buffer.from(encoded, 'base64') : undefined;
    if (!key || key.length !== 32) throw this.unavailable();
    return key;
  }
}

export function facilitySignupPhoneLabel(challengeId: string): string {
  return `identity:facility-signup-phone:${challengeId}`;
}

export function registrationCaseContactLabel(caseId: string, part: 'phone' | 'address'): string {
  return `identity:registration-case:${caseId}:${part}`;
}
