/**
 * True when a JOSE verification against a remote JWKS failed because the key
 * set could not be fetched or used, not because the token was refused: the
 * fetch timed out (ERR_JWKS_TIMEOUT), the endpoint was unreachable (fetch
 * rejects with a TypeError), answered other than 200 or with a body that is
 * not JSON (ERR_JOSE_GENERIC), or served an unusable key set
 * (ERR_JWKS_INVALID). That is the issuer's outage, answered 503; a bad
 * signature, a claim mismatch, an expired token or a key the issuer does not
 * publish (ERR_JWKS_NO_MATCHING_KEY) is a refusal of the token (A4, A5).
 */
export function jwksUnavailable(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JOSE_GENERIC' || code === 'ERR_JWKS_INVALID';
}
