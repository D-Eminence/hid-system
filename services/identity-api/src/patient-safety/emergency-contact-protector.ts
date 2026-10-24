import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { normalizeContactForLookup } from '../identity/contact-lookup';

export type EmergencyContactChannel = 'email' | 'sms';

export interface EmergencyContactSecret {
  name: string;
  destination: string;
}

const CIPHERTEXT_VERSION = 1;

/**
 * Protects emergency-contact names and destinations with the existing
 * application AES-256-GCM convention (version byte, 12-byte nonce, tag) and a
 * distinct associated-data label. The keyed destination HMAC is used only for
 * duplicate detection; it is not the contact-lookup HMAC and never resolves a
 * patient.
 */
@Injectable()
export class EmergencyContactProtector {
  private readonly environment = getEnvironment();

  normalizeDestination(channel: EmergencyContactChannel, raw: string): string {
    try {
      // People type phone numbers with spaces; strip separators before the
      // shared normalizer, which accepts national `0XXXXXXXXXX` or E.164.
      return channel === 'email'
        ? normalizeContactForLookup('email', raw)
        : normalizeContactForLookup('phone', raw.replace(/[\s().-]/g, ''));
    } catch {
      throw new DomainProblem(400, 'EMERGENCY_CONTACT_DESTINATION_INVALID',
        channel === 'email' ? 'Enter a valid email address' : 'Enter a valid phone number');
    }
  }

  destinationHmac(channel: EmergencyContactChannel, normalizedDestination: string): string {
    return this.hmac('hid-emergency-contact-destination:v1', channel, normalizedDestination);
  }

  verifier(challengeId: string, contactId: string, code: string): string {
    return this.hmac('hid-emergency-contact-verification:v1', challengeId, contactId, code);
  }

  get keyVersion(): string {
    return this.environment.NIN_KEY_VERSION;
  }

  get verifierKeyVersion(): string {
    return this.environment.OTP_HMAC_KEY_VERSION;
  }

  encrypt(contactId: string, secret: EmergencyContactSecret): Buffer {
    const key = this.encryptionKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(this.associatedData(contactId));
    return Buffer.concat([
      Buffer.from([CIPHERTEXT_VERSION]), nonce,
      cipher.update(JSON.stringify({ name: secret.name, destination: secret.destination }), 'utf8'),
      cipher.final(), cipher.getAuthTag(),
    ]);
  }

  decrypt(contactId: string, keyVersion: string, value: Buffer): EmergencyContactSecret {
    if (keyVersion !== this.environment.NIN_KEY_VERSION || value.length < 30 || value[0] !== CIPHERTEXT_VERSION) {
      throw this.unavailable();
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), value.subarray(1, 13));
      decipher.setAAD(this.associatedData(contactId));
      decipher.setAuthTag(value.subarray(value.length - 16));
      const plain = Buffer.concat([decipher.update(value.subarray(13, value.length - 16)), decipher.final()])
        .toString('utf8');
      const parsed = JSON.parse(plain) as Partial<EmergencyContactSecret>;
      if (typeof parsed.name !== 'string' || typeof parsed.destination !== 'string') throw new Error('shape');
      return { name: parsed.name, destination: parsed.destination };
    } catch {
      throw this.unavailable();
    }
  }

  assertConfigured(): void {
    this.encryptionKey();
    this.otpKey();
  }

  private associatedData(contactId: string): Buffer {
    return Buffer.from(`identity:patient-emergency-contact:${contactId}:contact`, 'utf8');
  }

  private hmac(...parts: string[]): string {
    return createHmac('sha256', this.otpKey()).update(parts.join('\u001f'), 'utf8').digest('hex');
  }

  private encryptionKey(): Buffer {
    const encoded = this.environment.NIN_ENCRYPTION_KEY_B64;
    const key = encoded ? Buffer.from(encoded, 'base64') : undefined;
    if (!key || key.length !== 32) throw this.unavailable();
    return key;
  }

  private otpKey(): Buffer {
    const encoded = this.environment.OTP_HMAC_KEY_B64;
    const key = encoded ? Buffer.from(encoded, 'base64') : undefined;
    if (!key || key.length !== 32) throw this.unavailable();
    return key;
  }

  private unavailable(): DomainProblem {
    return new DomainProblem(503, 'EMERGENCY_CONTACTS_UNAVAILABLE', 'Emergency contacts are temporarily unavailable');
  }
}

/** Display hint that never returns the full destination to the browser. */
export function maskDestination(channel: EmergencyContactChannel, destination: string): string {
  if (channel === 'email') {
    const [local = '', domain = ''] = destination.split('@');
    return `${local.slice(0, 1)}•••@${domain}`;
  }
  return `${destination.slice(0, 4)}•••••${destination.slice(-3)}`;
}
