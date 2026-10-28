import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';

const CIPHERTEXT_VERSION = 1;
/** The database CHECK on endpoint_key_version (0097). */
const KEY_VERSION = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Protects a web push endpoint (a bearer capability: whoever holds it can
 * push to that browser) with the emergency contacts' convention (D15):
 * AES-256-GCM under NIN_ENCRYPTION_KEY_B64 and NIN_KEY_VERSION, a version
 * byte, a 12-byte nonce and the 16-byte tag, and associated data naming the
 * subscription, so a ciphertext cannot be moved to another row. The
 * endpoint is never logged, audited, returned or put in a URL.
 */
@Injectable()
export class WebPushProtector {
  private readonly environment = getEnvironment();

  get keyVersion(): string {
    const version = this.environment.NIN_KEY_VERSION;
    if (!KEY_VERSION.test(version)) throw unavailable();
    return version;
  }

  /** True when an endpoint can be encrypted and decrypted here. */
  configured(): boolean {
    try {
      this.encryptionKey();
      void this.keyVersion;
      return true;
    } catch {
      return false;
    }
  }

  encrypt(subscriptionId: string, endpoint: string): Buffer {
    const key = this.encryptionKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(associatedData(subscriptionId));
    return Buffer.concat([Buffer.from([CIPHERTEXT_VERSION]), nonce, cipher.update(endpoint, 'utf8'), cipher.final(),
      cipher.getAuthTag()]);
  }

  decrypt(subscriptionId: string, keyVersion: string, value: Buffer): string {
    if (keyVersion !== this.environment.NIN_KEY_VERSION || value.length < 30 || value[0] !== CIPHERTEXT_VERSION) {
      throw unavailable();
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), value.subarray(1, 13));
      decipher.setAAD(associatedData(subscriptionId));
      decipher.setAuthTag(value.subarray(value.length - 16));
      return Buffer.concat([decipher.update(value.subarray(13, value.length - 16)), decipher.final()]).toString('utf8');
    } catch {
      throw unavailable();
    }
  }

  private encryptionKey(): Buffer {
    const encoded = this.environment.NIN_ENCRYPTION_KEY_B64;
    const key = encoded ? Buffer.from(encoded, 'base64') : undefined;
    if (!key || key.length !== 32) throw unavailable();
    return key;
  }
}

function associatedData(subscriptionId: string): Buffer {
  return Buffer.from(`identity:web-push-subscription:${subscriptionId}:endpoint`, 'utf8');
}

/** 503 WEB_PUSH_UNAVAILABLE: never a driver's or a key's message. */
export function webPushUnavailable(): DomainProblem {
  return new DomainProblem(503, 'WEB_PUSH_UNAVAILABLE', 'Notifications on this device are temporarily unavailable');
}

function unavailable(): DomainProblem {
  return webPushUnavailable();
}
