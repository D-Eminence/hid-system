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
  /**
   * 0137: called once when a check this request sent to the NIN service ends,
   * even after the request stopped waiting for it (504 QOREID_TIMEOUT, the
   * check goes on). Not called when nothing was sent for this request (a
   * stored answer, a refusal before sending).
   */
  onSettled?: (settlement: NinCheckSettlement) => void;
}

/** How a check sent to the NIN service ended: an answer, or the failure. */
export type NinCheckSettlement = { answered: true } | { answered: false; error: unknown };

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
  /**
   * 0137: true when this is an answer the NIN service gave before and HID
   * kept: nothing was sent for this request.
   */
  stored?: boolean;
}

export interface NinVerificationProvider {
  readonly name: string;
  /**
   * Q108, live providers only: false while the provider is switched off (a
   * setting, not an outage). Reads no NIN. Throws when the setting cannot be
   * read.
   */
  isEnabled?(): Promise<boolean>;
  verify(request: NinVerificationRequest): Promise<NinVerificationResult>;
}

export const NIN_VERIFICATION_PROVIDER = Symbol('NIN_VERIFICATION_PROVIDER');
