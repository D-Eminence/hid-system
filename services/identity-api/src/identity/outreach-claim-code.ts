import { createHmac, randomInt } from 'node:crypto';

/**
 * The one-time claim code of a Health ID created at an outreach with no
 * contact (0120). It is shown once, printed on the person's slip, and never
 * stored, logged or audited: the database keeps only its keyed HMAC
 * (identity.outreach_health_id_claims.code_hmac), keyed with the key 0119's
 * code verifier uses (OTP_HMAC_KEY_B64; no new secret). The later claim flow
 * recomputes the HMAC from what the person enters with outreachClaimCodeHmac.
 */
export const OUTREACH_CLAIM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const OUTREACH_CLAIM_CODE_LENGTH = 8;
/** The key version label stored beside the HMAC (code_key_version). */
export const OUTREACH_CLAIM_KEY_VERSION = 'claim-v1';

/** A new claim code: 8 characters from the unambiguous alphabet, uniformly with crypto.randomInt. */
export function generateOutreachClaimCode(): string {
  let code = '';
  for (let index = 0; index < OUTREACH_CLAIM_CODE_LENGTH; index += 1) {
    code += OUTREACH_CLAIM_CODE_ALPHABET[randomInt(0, OUTREACH_CLAIM_CODE_ALPHABET.length)];
  }
  return code;
}

/** HMAC-SHA256 (lower-case hex) of the uppercased code, keyed with the OTP verifier key. */
export function outreachClaimCodeHmac(key: Buffer, code: string): string {
  return createHmac('sha256', key).update(code.toUpperCase(), 'utf8').digest('hex');
}
