import { DomainProblem } from '../common/problem';

/**
 * Why the server no longer accepts a platform session (Stage 4A). It is
 * reported only once the presented credential is shown to be one the server
 * issued for that session: an access token with a valid signature, or a
 * refresh token matching the stored digest. An unknown, forged or malformed
 * credential, and every staff or patient session, still receives the generic
 * 401 AUTHENTICATION_REQUIRED, so nothing about other sessions or accounts can
 * be learned.
 */
export type PlatformSessionEnd = 'expired' | 'revoked';

export interface StoredPlatformSessionState {
  revoked: boolean;
  revocationReason: string | null;
  /** The idle or absolute expiry has passed. */
  lapsed: boolean;
}

export function platformSessionEnded(end: PlatformSessionEnd): DomainProblem {
  return end === 'expired'
    ? new DomainProblem(401, 'PLATFORM_SESSION_EXPIRED', 'Your platform session expired. Sign in again to continue')
    : new DomainProblem(401, 'PLATFORM_SESSION_REVOKED', 'Your platform session was ended. Sign in again to continue');
}

/** Classifies a stored platform session that failed validation; null keeps the generic answer. */
export function classifyPlatformSessionEnd(state: StoredPlatformSessionState | undefined): PlatformSessionEnd | null {
  if (!state) return null;
  if (state.revoked) {
    if (state.revocationReason === 'expired') return 'expired';
    // A refresh replaced this session; the client's own refresh decides.
    if (state.revocationReason === 'rotated') return null;
    return 'revoked';
  }
  if (state.lapsed) return 'expired';
  // Current and unexpired, yet refused: the account was suspended, its
  // credentials or roles changed (token version), or its authenticator was reset.
  return 'revoked';
}
