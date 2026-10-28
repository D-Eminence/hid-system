import { generateKeyPairSync } from 'node:crypto';

/** A synthetic VAPID public key (87 base64url characters) for unit tests; never real key material. */
export function syntheticVapidPublicKey(): string {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])
    .toString('base64url');
}

/** A browser's p256dh (65 bytes, 0x04 first) and auth (16 bytes), as a PushSubscription's toJSON() gives them. */
export function syntheticBrowserKeys(): { p256dh: string; auth: string } {
  return { p256dh: syntheticVapidPublicKey(), auth: Buffer.alloc(16, 0x2a).toString('base64url') };
}
