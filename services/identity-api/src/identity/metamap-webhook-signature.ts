import { createHmac, timingSafeEqual } from 'node:crypto';

// General MetaMap webhook primitive only. Standalone GovChecks signing-secret
// selection is not documented sufficiently to expose an HID callback route yet.
// This authenticates bytes only; callers still need durable request correlation,
// expiry/replay checks and an independently reviewed NIN result contract.
export function validMetaMapWebhookSignature(
  rawBody: Buffer, signature: unknown, webhookSecret: string,
): boolean {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > 262_144
    || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)
    || webhookSecret.length < 16 || webhookSecret.length > 4096
    || !/[A-Z]/.test(webhookSecret) || !/[a-z]/.test(webhookSecret) || !/[0-9]/.test(webhookSecret)) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
