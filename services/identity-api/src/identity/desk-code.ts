/**
 * Desk codes for facility-assisted registration (ADR-063). The patient's own
 * device shows the code at a participating facility; staff type it. A code
 * is 10 Crockford base32 characters, 50 bits, taken from a keyed digest of
 * the enrollment cookie and a random salt, so only the cookie holder can be
 * shown it again and the database keeps only its keyed digest.
 */
export const DESK_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DESK_CODE_LENGTH = 10;

/** The first 50 bits of a digest as 10 Crockford base32 characters. */
export function deskCodeFromDigest(digest: Buffer): string {
  if (digest.length < 7) throw new Error('A desk code needs at least 56 bits of digest');
  // 56 bits, the low 6 dropped: the first 50 bits of the digest.
  let value = BigInt(`0x${digest.subarray(0, 7).toString('hex')}`) >> 6n;
  let code = '';
  for (let index = 0; index < DESK_CODE_LENGTH; index += 1) {
    code = DESK_CODE_ALPHABET[Number(value & 31n)] + code;
    value >>= 5n;
  }
  return code;
}

/**
 * What staff type, as the canonical code: case-insensitive, spaces and
 * hyphens ignored, and the Crockford look-alikes O (zero) and I, L (one)
 * read as digits. Anything else, U included, is not a desk code: null.
 */
export function normalizeDeskCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.replace(/[\s-]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
  return new RegExp(`^[${DESK_CODE_ALPHABET}]{${DESK_CODE_LENGTH}}$`).test(code) ? code : null;
}
