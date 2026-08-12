import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';

export interface NinProtectionConfig {
  lookupKey: Buffer;
  encryptionKey: Buffer;
  keyVersion: string;
}

export interface ProtectedNin {
  ciphertext: Buffer;
  lookupHmac: string;
  last4: string;
  keyVersion: string;
}

export function createNinLookupHmac(nin: string, lookupKey: Buffer): string {
  if (lookupKey.length !== 32) {
    throw new DomainProblem(503, 'NIN_PROTECTION_UNAVAILABLE', 'NIN protection keys are unavailable');
  }
  return createHmac('sha256', lookupKey).update(nin, 'utf8').digest('hex');
}

export function protectNin(
  nin: string,
  caseId: string,
  config: NinProtectionConfig,
): ProtectedNin {
  if (config.lookupKey.length !== 32 || config.encryptionKey.length !== 32) {
    throw new DomainProblem(503, 'NIN_PROTECTION_UNAVAILABLE', 'NIN protection keys are unavailable');
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.encryptionKey, nonce);
  cipher.setAAD(Buffer.from(`identity:registration-case:${caseId}:nin`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(nin, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([Buffer.from([1]), nonce, tag, ciphertext]),
    lookupHmac: createNinLookupHmac(nin, config.lookupKey),
    last4: nin.slice(-4),
    keyVersion: config.keyVersion,
  };
}

@Injectable()
export class NinIdentifierProtector {
  lookup(nin: string): string {
    const environment = getEnvironment();
    if (!environment.NIN_LOOKUP_HMAC_KEY_B64) {
      throw new DomainProblem(503, 'NIN_PROTECTION_UNAVAILABLE', 'NIN protection keys are unavailable');
    }
    return createNinLookupHmac(nin, Buffer.from(environment.NIN_LOOKUP_HMAC_KEY_B64, 'base64'));
  }

  protect(nin: string, caseId: string): ProtectedNin {
    const environment = getEnvironment();
    if (!environment.NIN_LOOKUP_HMAC_KEY_B64 || !environment.NIN_ENCRYPTION_KEY_B64) {
      throw new DomainProblem(503, 'NIN_PROTECTION_UNAVAILABLE', 'NIN protection keys are unavailable');
    }
    return protectNin(nin, caseId, {
      lookupKey: Buffer.from(environment.NIN_LOOKUP_HMAC_KEY_B64, 'base64'),
      encryptionKey: Buffer.from(environment.NIN_ENCRYPTION_KEY_B64, 'base64'),
      keyVersion: environment.NIN_KEY_VERSION,
    });
  }
}
