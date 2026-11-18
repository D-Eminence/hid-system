/**
 * The two ways a single sign-on step fails (ADR-070). Kept apart from the
 * provider client, so code and tests that only classify failures need nothing
 * else of single sign-on.
 */

/** The provider could not be asked (unreachable, failed, or answered something unusable): a fault. */
export class SsoProviderUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`The single sign-on provider is unavailable (${reason})`);
  }
}

/** The provider's answer, a token or a transaction was refused: never a fault, and never retried. */
export class SsoTokenRefused extends Error {
  constructor(readonly reason: string) {
    super(`A single sign-on token was refused (${reason})`);
  }
}
