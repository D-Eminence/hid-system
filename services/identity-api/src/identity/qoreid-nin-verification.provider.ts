import { Inject, Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { isNinCheckRefusedUnsent, isNinCheckStillRunning, isStoredNinAnswer, markNinCheckOwnFault,
  markStoredNinAnswer, ninCheckNotStarted, ninNotConfigured } from './nin-verification.provider';
import type {
  NinClaimedDemographics,
  NinVerificationProvider,
  NinVerificationRequest,
  NinVerificationResult,
} from './nin.types';
import {
  type NinRecordCheck,
  type NinRecordNames,
  PUBLIC_PATIENT_IDENTITY_PROVIDER,
  type PublicPatientIdentityProvider,
} from './patient-enrollment.provider';
import { markQoreIdDelivery, qoreIdDelivery } from './qoreid-delivery';
import { QOREID_PROVIDER, type QoreIdNinBinding } from './qoreid-verification.types';

/** The gate's refusals while it is closed. Anything else is a fault, not a setting. */
const CLOSED_GATE_CODES = new Set(['QOREID_DISABLED', 'QOREID_NIN_ONLY_DISABLED', 'INTEGRATION_PAUSED',
  'QOREID_CONFIGURATION_INVALID']);

const PROVIDER_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const GENDERS = new Set(['female', 'male', 'intersex', 'other', 'unknown']);

/**
 * Q108: the registration desk's NIN check through QoreID, the same check and
 * the same gate as app. patient enrollment (QoreIdPublicPatientIdentityProvider):
 * QOREID_ENABLED, QOREID_NIN_ONLY_ENROLLMENT_ENABLED and the admin integration
 * control for QoreID NIN checks, read for every check (never cached).
 *
 * Only the NIN is sent. The record QoreID returns is compared here with the
 * name and date of birth the desk entered; the desk returns and logs nothing
 * from it. 0137's guard keeps QoreID's answer (encrypted, as for every path):
 * a record that matched for as long as 0137 keeps a record from its first
 * check (90 days, Q110), one that did not match (probably someone else's NIN)
 * for 24 hours. Each later desk request the guard answers from a stored
 * record, its details matching or not, is a use of it, and 0137's begin keeps
 * the record at least 30 days from that use as it answers (Q115,
 * identity.qoreid_nin_record_used), so the desk makes no keep call of its own
 * (NinCheckOnce.keepRecord would only repeat it).
 *
 * Its only way to QoreID is PUBLIC_PATIENT_IDENTITY_PROVIDER.verifyNinRecord,
 * 0137's once-per-NIN guard as path 'desk'. Any record the guard holds for the
 * NIN will do, complete or not (the desk needs no photo, address or
 * recognised gender), so a desk request, a resend of it, another desk's
 * request and a sign-up or profile check of the same NIN together make one
 * QoreID call while the answer is kept or the check is running, but for
 * 0137's own exceptions (docs/INTERFACE_CONTRACT.md, Q108, "One QoreID check
 * per NIN"), each a second charge: a sign-up after a profile check's
 * incomplete record; a desk check or a sign-up after a profile check's "no
 * record" or unusable answer, which 0137 keeps for the profile's question
 * only (the desk asks with none); and a NIN_KEY_VERSION change. No
 * per-request claim and no limit (Q109) is kept beside it.
 *
 * Q117: QoreID having no record of the NIN (its "no record", or its 404
 * "not found", fresh or kept) is answered `no_match`, which the desk gives as
 * 422 NIN_NOT_VERIFIED, the answer sign-up and the profile give too. QoreID's
 * "incomplete" (its check not finished) gets the same answer here and on
 * sign-up (the profile answers it 200 state "incomplete").
 */
@Injectable()
export class QoreIdNinVerificationProvider implements NinVerificationProvider {
  readonly name = QOREID_PROVIDER;

  constructor(@Inject(PUBLIC_PATIENT_IDENTITY_PROVIDER) private readonly qoreId: PublicPatientIdentityProvider) {}

  isEnabled(): Promise<boolean> {
    return this.qoreId.isAvailable();
  }

  /**
   * 0137 (Q109): the check goes through the once-per-NIN guard (NinCheckOnce)
   * as the desk's, and the guard's audit row (`identity.qoreid.nin-check`,
   * path 'desk') carries this request's correlation id. The guard's answers
   * become the desk's:
   * - a stored answer: compared as a fresh one, and said to be stored
   *   (`stored`, or isStoredNinAnswer on a refusal): nothing was sent. A
   *   stored record is a use of it: the guard's begin kept it by 0137's Q115
   *   rule before the desk compares it, matched or not;
   * - 409 NIN_CHECK_IN_PROGRESS (this NIN is being checked) and 409
   *   NIN_CHECK_HELD (held after a check QoreID may have charged), with
   *   `retryAfterSeconds`: passed on; nothing was sent for this request.
   * - 504 QOREID_TIMEOUT with `retryAfterSeconds` (isNinCheckStillRunning):
   *   passed on; the check was sent and goes on, its answer is kept for the
   *   retry and `request.onSettled` hears how it ended. QoreID's own 504
   *   QOREID_TIMEOUT is given the same `retryAfterSeconds` (withRetryAfter).
   * - 503 NIN_CHECK_UNAVAILABLE (the guard's store could not be read):
   *   "NIN checks cannot be started right now", as the desk answers any check
   *   that could not be started; nothing was sent.
   * For the breaker (D4), an error no QoreID request raised (the guard's
   * audit write, a database fault) is marked as HID's own
   * (isNinCheckOwnFault). QoreID's 404 is not an error here: it is its "no
   * record" (Q117), an answer like any other.
   */
  async verify(request: NinVerificationRequest): Promise<NinVerificationResult> {
    const claimed = request.claimedDemographics;
    let checked: NinRecordCheck;
    try {
      checked = await this.qoreId.verifyNinRecord(request.nin, {
        correlationId: request.correlationId, path: 'desk',
        expects: (record) => sameDetails(record, claimed),
        ...(request.onSettled ? { onQoreIdSettled: request.onSettled } : {}),
      });
    } catch (error) {
      if (error instanceof DomainProblem && CLOSED_GATE_CODES.has(error.code)) {
        // Switched off between the gate and the check: nothing was sent.
        throw ninNotConfigured();
      }
      if (error instanceof DomainProblem && error.code === 'INTEGRATION_UNAVAILABLE') {
        // The gate's admin control could not be read (only the gate, which
        // runs before anything is sent, raises this code): nothing was sent.
        throw ninCheckNotStarted();
      }
      if (error instanceof DomainProblem && error.code === 'NIN_CHECK_UNAVAILABLE') {
        // 0137's store of checks could not be read or written before the
        // check: nothing was sent.
        throw ninCheckNotStarted();
      }
      throw withRetryAfter(forTheBreaker(error));
    }
    const stored = checked.source === 'stored';
    if (checked.outcome === 'no_record') return this.notVerified(request, 'no_match', stored);
    const identity = checked.record;
    if (!validIdentity(identity, checked.providerReference, request.nin)) {
      const invalid = new DomainProblem(502, 'QOREID_PROVIDER_RESPONSE_INVALID',
        'External verification returned an invalid response');
      throw stored ? markStoredNinAnswer(invalid) : invalid;
    }
    if (!sameDetails(identity, claimed)) {
      return this.notVerified(request, 'name_mismatch', stored, checked.providerReference);
    }
    // The desk's spelling is kept: it equals the record's but for letter case
    // and spacing. The record's sex is used only when the desk gave none.
    const demographics: NinClaimedDemographics = {
      firstName: claimed.firstName,
      lastName: claimed.lastName,
      dateOfBirth: identity.dateOfBirth,
      ...(claimed.gender ? { gender: claimed.gender }
        : identity.gender && identity.gender !== 'unknown' ? { gender: identity.gender } : {}),
    };
    return {
      verified: true,
      outcome: 'match',
      provider: this.name,
      reference: checked.providerReference,
      verifiedAt: new Date().toISOString(),
      demographics,
      ...(stored ? { stored: true } : {}),
    };
  }

  private notVerified(request: NinVerificationRequest, outcome: 'no_match' | 'name_mismatch', stored: boolean,
    reference = 'qoreid-not-verified'): NinVerificationResult {
    return {
      verified: false,
      outcome,
      provider: this.name,
      reference,
      verifiedAt: new Date().toISOString(),
      demographics: request.claimedDemographics,
      ...(stored ? { stored: true } : {}),
    };
  }
}

/**
 * Q108: which NIN check the desk uses. `deferred` and `test` are unchanged.
 * With NIN_PROVIDER_MODE=unavailable (production today) and QOREID_ENABLED,
 * the desk uses QoreID; each check still asks the QoreID gate (NIN-only
 * checks on, the admin control on) and is answered "not configured", as
 * before, while the gate is closed. Otherwise NIN checks stay off.
 */
export function selectNinVerificationProvider(
  environment: { NIN_PROVIDER_MODE: 'unavailable' | 'deferred' | 'test'; QOREID_ENABLED: boolean },
  providers: {
    deterministicTest: NinVerificationProvider;
    unavailable: NinVerificationProvider;
    deferred: NinVerificationProvider;
    qoreId: NinVerificationProvider;
  },
): NinVerificationProvider {
  if (environment.NIN_PROVIDER_MODE === 'deferred') return providers.deferred;
  if (environment.NIN_PROVIDER_MODE === 'test') return providers.deterministicTest;
  return environment.QOREID_ENABLED ? providers.qoreId : providers.unavailable;
}

/**
 * D4: says what an error from the guard means for the breaker, which counts
 * only what QoreID did. The guard's own answers (stored, still running,
 * refused unsent) are already marked. An error a QoreID request raised is
 * marked with how far it got (qoreid-delivery.ts): QoreID failing (5xx,
 * timeout, network, 401, an answer HID cannot use) is left as it is (its
 * 404 never reaches here: verifyNinRecord answers it as "no record", Q117).
 * Any other error was raised by HID's own code or database.
 */
function forTheBreaker(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || isStoredNinAnswer(error) || isNinCheckStillRunning(error)
    || isNinCheckRefusedUnsent(error)) return error;
  return qoreIdDelivery(error) ? error : markNinCheckOwnFault(error);
}

/**
 * Every 504 QOREID_TIMEOUT the desk answers carries `retryAfterSeconds: 60`,
 * as the guard's own does (the website waits that long, then retries with
 * the same Idempotency-Key). QoreID's own timeout reaches the desk without
 * it: its token request timing out at QOREID_TIMEOUT_MS (which starts before
 * the guard's wait, so it ends first), or the check at its deadline. The same
 * problem is given with the extension, keeping how far its request got; the
 * breaker counts it as before.
 */
function withRetryAfter(error: unknown): unknown {
  const facts = qoreIdDelivery(error);
  if (!(error instanceof DomainProblem) || error.code !== 'QOREID_TIMEOUT' || !facts
    || typeof error.extensions?.retryAfterSeconds === 'number') return error;
  return markQoreIdDelivery(new DomainProblem(error.getStatus(), error.code, error.message, error.errors,
    { extensions: { ...error.extensions, retryAfterSeconds: 60 } }), facts);
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleUpperCase('en-NG');
}

/** The record's first and last name (in that order) and date of birth are the ones the desk entered. */
function sameDetails(record: QoreIdNinBinding, claimed: NinClaimedDemographics): boolean {
  return normalizedName(record.firstName) === normalizedName(claimed.firstName)
    && normalizedName(record.lastName) === normalizedName(claimed.lastName)
    && record.dateOfBirth === claimed.dateOfBirth;
}

/**
 * The record QoreID returned is for this NIN and well formed (as patient
 * enrollment checks it). Its date of birth is any the adapter reads (a real
 * date from 1800, not in the future): a record born before 1900 is QoreID's
 * answer, and can only not match the desk's details (which are from 1900).
 */
function validIdentity(identity: NinRecordNames, providerReference: string, nin: string): boolean {
  const validName = (value: unknown): value is string => typeof value === 'string'
    && value.trim().length >= 1 && value.trim().length <= 100 && !/[\x00-\x1f\x7f]/.test(value);
  const date = typeof identity?.dateOfBirth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(identity.dateOfBirth)
    ? new Date(`${identity.dateOfBirth}T00:00:00Z`) : new Date(NaN);
  return identity !== null && typeof identity === 'object'
    && identity.nin === nin && validName(identity.firstName) && validName(identity.lastName)
    && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === identity.dateOfBirth
    && date.getUTCFullYear() >= 1800 && date.getTime() <= Date.now()
    // A record without a recognised sex is used for its name and date of birth.
    && (identity.gender === undefined || GENDERS.has(identity.gender))
    && typeof providerReference === 'string' && PROVIDER_REFERENCE.test(providerReference)
    // The reference is QoreID's own transaction number, never the NIN.
    && !providerReference.includes(nin);
}
