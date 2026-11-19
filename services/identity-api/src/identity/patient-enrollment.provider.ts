import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { NIN_NO_RECORD_ANSWER_SECONDS, NinCheckOnce, type NinCheckAnswer, type NinCheckPath, type NinCheckResult,
  recordNames, unusableAnswer } from './nin-check-once';
import { markNinCheckStillRunning, markStoredNinAnswer, ninCouldNotBeVerified } from './nin-verification.provider';
import type { NinCheckSettlement } from './nin.types';
import { qoreIdDelivery } from './qoreid-delivery';
import { QoreIdVerificationAdapter } from './qoreid-verification.adapter';
import type { QoreIdNinBinding, QoreIdNinEnrollmentBinding, QoreIdVerificationResult } from './qoreid-verification.types';

export const PUBLIC_PATIENT_IDENTITY_PROVIDER = Symbol('PUBLIC_PATIENT_IDENTITY_PROVIDER');

export interface VerifiedPublicPatientIdentity extends QoreIdNinEnrollmentBinding {
  providerReference: string;
}

/** The refusals of a closed gate. Any other failure is a fault, not an answer. */
const CLOSED_GATE_CODES = new Set(['QOREID_DISABLED', 'QOREID_NIN_ONLY_DISABLED', 'INTEGRATION_PAUSED']);

export interface PublicPatientIdentityProvider {
  /**
   * The enrollment gate: refuses with 503 unless QoreID and NIN-only enrollment
   * are enabled and QoreID is not paused at runtime. It reads no NIN, so every
   * NIN gets the same answer while the gate is closed.
   */
  assertAvailable(): Promise<void>;
  /**
   * The same gate as an answer: false where assertAvailable refuses because
   * the gate is closed, true where it passes. A fault reading the runtime state
   * is thrown, not answered.
   */
  isAvailable(): Promise<boolean>;
  /**
   * Checks the gate again, then asks QoreID through NinCheckOnce (0137): once
   * per NIN, reusing a stored answer and waiting for a check in flight.
   * `context` names the request (its correlation id) and the path for the
   * audit; without it the check is audited under a fresh correlation id as
   * 'other'. A NIN QoreID has no record of (its 404 "not found" or the
   * NIN-only check's "no record", fresh or stored) is refused 422
   * NIN_NOT_VERIFIED (Q117).
   */
  verifyNin(nin: string, context?: NinCheckContext): Promise<VerifiedPublicPatientIdentity>;
  /**
   * Q108, the registration desk: the same gate and the same once-per-NIN
   * check (NinCheckOnce, 0137) as verifyNin, but any record QoreID returned
   * for the NIN will do, complete or not, because the desk compares only its
   * name and date of birth. A record kept as incomplete (no recognised
   * gender, a photo or an address HID cannot read) by any path, or an answer
   * a sign-up or a desk check kept as unusable that still gives a readable
   * name and date of birth, is used, not paid for again (0137 keeps a profile
   * check's answer that is not a record for that check's question only, so
   * it is not reused here); such a record QoreID returns here is kept as an
   * incomplete record, as a profile check keeps it.
   *
   * Says whether the answer came from QoreID for this request or from
   * storage. QoreID's 404 "not found", fresh or stored, is its "no record"
   * for the NIN (Q117), answered as outcome 'no_record' like the NIN-only
   * check's own "no record". An answer without a readable name is thrown as
   * by verifyNin, marked isStoredNinAnswer when it comes from storage; the
   * guard's 504 (this request's wait ended, the check goes on) is marked
   * isNinCheckStillRunning.
   */
  verifyNinRecord(nin: string, context?: NinRecordContext): Promise<NinRecordCheck>;
}

/**
 * Q108: what the desk compares from a NIN's record: the name and date of
 * birth, and the sex when the record is complete. Nothing else from the
 * record leaves the provider.
 */
export interface NinRecordNames extends QoreIdNinBinding {
  gender?: QoreIdNinEnrollmentBinding['gender'];
}

export type NinRecordCheck = {
  /** 'stored': 0137's stored answer; QoreID was not asked for this request. */
  source: 'qoreid' | 'stored';
} & ({ outcome: 'record'; record: NinRecordNames; providerReference: string } | { outcome: 'no_record' });

export interface NinRecordContext extends NinCheckContext {
  /**
   * The record the caller expects (the desk: the name and date of birth it
   * typed). A fresh record that is not it, probably someone else's NIN, is
   * kept 24 hours (NIN_NO_RECORD_ANSWER_SECONDS), as a profile check keeps a
   * record it did not match, not as long as a matched one.
   */
  expects?: (record: QoreIdNinBinding) => boolean;
  /**
   * Called once when this request's own QoreID request ends, even after the
   * caller stopped waiting. Not called for a stored answer.
   */
  onQoreIdSettled?: (settlement: NinCheckSettlement) => void;
}

/** The request a NIN check belongs to and where it comes from (never the NIN). */
export interface NinCheckContext {
  correlationId?: string;
  path?: NinCheckPath;
}

/** Production adapter. Unit tests inject a fixture provider through the token. */
@Injectable()
export class QoreIdPublicPatientIdentityProvider implements PublicPatientIdentityProvider {
  constructor(private readonly adapter: QoreIdVerificationAdapter,
    private readonly integrations: IntegrationRuntimeService,
    private readonly ninCheck: NinCheckOnce) {}

  async assertAvailable(): Promise<void> {
    const environment = getEnvironment();
    if (!environment.QOREID_ENABLED) {
      throw new DomainProblem(503, 'QOREID_DISABLED', 'Patient identity enrollment is temporarily unavailable');
    }
    if (!environment.QOREID_NIN_ONLY_ENROLLMENT_ENABLED) {
      throw new DomainProblem(503, 'QOREID_NIN_ONLY_DISABLED',
        'Patient identity enrollment is temporarily unavailable');
    }
    await this.integrations.assertAvailable('qoreid', 'patient_nin');
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.assertAvailable();
      return true;
    } catch (error) {
      if (error instanceof DomainProblem && CLOSED_GATE_CODES.has(error.code)) return false;
      throw error;
    }
  }

  async verifyNin(nin: string, context: NinCheckContext = {}): Promise<VerifiedPublicPatientIdentity> {
    await this.assertAvailable();
    if (!/^\d{11}$/.test(nin)) throw new DomainProblem(400, 'NIN_INVALID', 'An 11-digit NIN is required');
    let checked: NinCheckResult<undefined>;
    try {
      checked = await this.ninCheck.check({
        nin, correlationId: context.correlationId ?? `nin-check-${randomUUID()}`, path: context.path ?? 'other',
        needsCompleteRecord: true,
        ask: async ({ timeoutMs }) => ({
          answer: enrollmentAnswer(await this.adapter.verifyNinEnrollment(nin, { timeoutMs }), nin), value: undefined }),
      });
    } catch (error) {
      // Q117: QoreID's 404 "not found" (kept by the guard as 'rejected') is
      // its answer that it has no record of the NIN.
      if (qoreIdNotFound(error)) throw ninCouldNotBeVerified();
      throw error;
    }
    return identityFromAnswer(checked.answer, nin);
  }

  async verifyNinRecord(nin: string, context: NinRecordContext = {}): Promise<NinRecordCheck> {
    await this.assertAvailable();
    if (!/^\d{11}$/.test(nin)) throw new DomainProblem(400, 'NIN_INVALID', 'An 11-digit NIN is required');
    let checked: NinCheckResult<undefined>;
    try {
      checked = await this.ninCheck.check({
        nin, correlationId: context.correlationId ?? `nin-check-${randomUUID()}`, path: context.path ?? 'other',
        needsCompleteRecord: false,
        ask: async ({ timeoutMs }) => {
          let answer: NinCheckAnswer;
          try {
            answer = enrollmentAnswer(await this.adapter.verifyNinEnrollment(nin, { timeoutMs }), nin);
          } catch (error) {
            // A record a sign-up cannot enrol from (no recognised sex, a
            // photo or an address HID cannot read) still has the name and
            // date of birth the desk compares: kept as an incomplete record,
            // as a profile check keeps one (as long as a record, Q110), not as
            // 'unusable' for 24 hours, so the desk, the profile and a later
            // desk use it without paying again. A sign-up needs a complete
            // record and asks QoreID itself, as after a profile check.
            const named = namedIncompleteRecord(error);
            if (!named) {
              // QoreID's 404 "not found" is its answer (D4); anything else is
              // QoreID failing, or answering with nothing HID can use.
              context.onQoreIdSettled?.(qoreIdNotFound(error) ? { answered: true } : { answered: false, error });
              throw error;
            }
            answer = named;
          }
          context.onQoreIdSettled?.({ answered: true });
          const names = answerNames(answer);
          return { answer, value: undefined,
            ...(names && context.expects && !context.expects(names.record)
              ? { keepSeconds: NIN_NO_RECORD_ANSWER_SECONDS } : {}) };
        },
      });
    } catch (error) {
      // The guard's own 504 (QoreID's own timeout is marked as sent): this
      // request's wait ended and the check goes on.
      if (error instanceof DomainProblem && error.code === 'QOREID_TIMEOUT' && !qoreIdDelivery(error)) {
        throw markNinCheckStillRunning(error);
      }
      // Q117: QoreID's 404 "not found" for this request's own check is its
      // "no record" for the NIN (the guard keeps it as 'rejected').
      if (qoreIdNotFound(error)) return { source: 'qoreid', outcome: 'no_record' };
      throw error;
    }
    const stored = checked.source === 'stored';
    const refuse = (problem: DomainProblem) => stored ? markStoredNinAnswer(problem) : problem;
    const answer = checked.answer;
    // Q117: a kept 404 is "no record" too.
    if (answer.outcome === 'rejected' || answer.outcome === 'no_record') {
      return { source: checked.source, outcome: 'no_record' };
    }
    const names = answerNames(answer);
    if (!names || names.record.nin !== nin) throw refuse(invalidResponse());
    return { source: checked.source, outcome: 'record', record: names.record,
      providerReference: names.providerReference };
  }
}

/**
 * The name and date of birth (and the sex of a complete record) on a kept or
 * fresh answer, with QoreID's reference: a record, or an unusable answer that
 * kept them.
 */
function answerNames(answer: NinCheckAnswer): { record: NinRecordNames; providerReference: string } | undefined {
  if (answer.outcome === 'record') {
    const names: NinRecordNames = recordNames(answer.record);
    return { record: answer.record.complete ? { ...names, gender: answer.record.binding.gender } : names,
      providerReference: answer.providerReference };
  }
  if (answer.outcome === 'unusable' && answer.record && answer.providerReference) {
    return { record: recordNames(answer.record), providerReference: answer.providerReference };
  }
  return undefined;
}

/**
 * QoreID's 404 "not found": its answer that it has no record of the NIN,
 * which 0137 keeps (as 'rejected') and every path answers as "no record"
 * (Q117); never a failure of QoreID (D4).
 */
export function qoreIdNotFound(error: unknown): boolean {
  const facts = qoreIdDelivery(error);
  return facts?.delivery === 'answered' && facts.status === 404;
}

/** QoreID's full answer that a sign-up cannot enrol from but whose name and date of birth could be read. */
function namedIncompleteRecord(error: unknown): NinCheckAnswer | undefined {
  const facts = qoreIdDelivery(error);
  if (!(error instanceof DomainProblem) || error.code !== 'QOREID_PROVIDER_RESPONSE_INVALID'
    || facts?.delivery !== 'answered' || !facts.record || !facts.providerReference) return undefined;
  return { outcome: 'record', record: facts.record, providerReference: facts.providerReference };
}

/** What a NIN-only check keeps: the record, "no record", or (thrown) an answer HID cannot use. */
function enrollmentAnswer(result: QoreIdVerificationResult, nin: string): NinCheckAnswer {
  if (result.state !== 'verified') {
    return { outcome: 'no_record', state: result.state,
      ...(result.providerReference ? { providerReference: result.providerReference } : {}) };
  }
  if (!result.providerReference || !result.ninEnrollmentBinding || result.ninEnrollmentBinding.nin !== nin) {
    // QoreID answered and charged; the same NIN gets the same answer again.
    throw unusableAnswer();
  }
  return { outcome: 'record', providerReference: result.providerReference,
    record: { complete: true, binding: result.ninEnrollmentBinding } };
}

/**
 * The same answer for a fresh and a stored check. QoreID's "no record" and
 * its kept 404 are the one Q117 answer, 422 NIN_NOT_VERIFIED.
 */
function identityFromAnswer(answer: NinCheckAnswer, nin: string): VerifiedPublicPatientIdentity {
  if (answer.outcome === 'rejected' || answer.outcome === 'no_record') throw ninCouldNotBeVerified();
  if (answer.outcome === 'unusable') throw invalidResponse();
  if (!answer.record.complete || answer.record.binding.nin !== nin) throw invalidResponse();
  return { ...answer.record.binding, providerReference: answer.providerReference };
}

function invalidResponse(): DomainProblem {
  return new DomainProblem(502, 'QOREID_PROVIDER_RESPONSE_INVALID', 'External verification returned an invalid response');
}
