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

/** Q108: who a live NIN check is charged to, and which desk request it is (never a NIN). */
export interface NinCheckReservation {
  correlationId: string;
  accountId: string;
  facilityId: string;
  /** The desk's Idempotency-Key for this request. */
  idempotencyKey: string;
  /** The request's digest (keyed: it holds the NIN's lookup HMAC, never the NIN). */
  requestSha256: string;
}

/**
 * Q108: what `reserve` found. `stored` is the answer an earlier check of this
 * same request (same Idempotency-Key, same body) already got and that is
 * given again without a new check; absent when a new check may be sent.
 */
export interface NinCheckReservationResult {
  stored?: Exclude<NinCheckOutcome, 'match'>;
}

/** Q108: how a reserved check ended, for `settle`. 'not_answered': nothing usable came back. */
export type NinCheckSettlement = NinCheckOutcome | 'not_answered';

export interface NinVerificationProvider {
  readonly name: string;
  /**
   * Q108, live providers only: false while the provider is switched off (a
   * setting, not an outage). Reads no NIN. Throws when the setting cannot be
   * read.
   */
  isEnabled?(): Promise<boolean>;
  /**
   * Q108, live providers only, before any NIN is sent: claims the desk
   * request (409 while the same request is still being checked; the stored
   * answer when it was already answered), then counts the check against the
   * request limits (429 when a limit is reached, counting nothing).
   */
  reserve?(reservation: NinCheckReservation): Promise<NinCheckReservationResult>;
  /**
   * Q108, live providers only: records how a reserved check ended, so that a
   * resend of the same request is answered without a new (charged) check,
   * or, when nothing usable came back, may be sent again. Never throws.
   */
  settle?(reservation: NinCheckReservation, settlement: NinCheckSettlement): Promise<void>;
  verify(request: NinVerificationRequest): Promise<NinVerificationResult>;
}

export const NIN_VERIFICATION_PROVIDER = Symbol('NIN_VERIFICATION_PROVIDER');
