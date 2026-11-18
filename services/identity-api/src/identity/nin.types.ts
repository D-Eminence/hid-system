export interface NinClaimedDemographics {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender?: string;
}

export interface NinVerificationRequest {
  nin: string;
  claimedDemographics: NinClaimedDemographics;
  correlationId: string;
}

/**
 * Q108: what the NIN check found, for the audit row. A provider that does not
 * say is read as 'match' when `verified` and 'no_match' otherwise.
 * - 'match': the NIN is on the register with this name and date of birth.
 * - 'no_match': the NIN was not found (or the provider could not confirm it).
 * - 'name_mismatch': the NIN was found, but the name or the date of birth on
 *   its record is not the one the desk entered.
 */
export type NinCheckOutcome = 'match' | 'no_match' | 'name_mismatch';

export interface NinVerificationResult {
  verified: boolean;
  provider: string;
  reference: string;
  verifiedAt: string;
  demographics: NinClaimedDemographics;
  outcome?: NinCheckOutcome;
}

/** Q108: who a live NIN check is charged to (never a NIN). */
export interface NinCheckReservation {
  correlationId: string;
  accountId: string;
  facilityId: string;
}

export interface NinVerificationProvider {
  readonly name: string;
  /**
   * Q108, live providers only: false while the provider is switched off (a
   * setting, not an outage). Reads no NIN. Throws when the setting cannot be
   * read.
   */
  isEnabled?(): Promise<boolean>;
  /**
   * Q108, live providers only: counts the check against the request limits
   * before any NIN is sent; refuses with 429 when a limit is reached.
   */
  reserve?(reservation: NinCheckReservation): Promise<void>;
  verify(request: NinVerificationRequest): Promise<NinVerificationResult>;
}

export const NIN_VERIFICATION_PROVIDER = Symbol('NIN_VERIFICATION_PROVIDER');
