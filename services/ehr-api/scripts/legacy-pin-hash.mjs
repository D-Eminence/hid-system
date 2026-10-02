// The PIN command equalizes bcrypt work to cost 12. Higher-cost or malformed
// source envelopes must be remediated, never imported as working PINs.
const BCRYPT_ENVELOPE = /^\$2[aby]\$(?:0[4-9]|1[0-2])\$[./A-Za-z0-9]{53}$/;

export function validLegacyPinHash(value) {
  return typeof value === 'string' && BCRYPT_ENVELOPE.test(value);
}
