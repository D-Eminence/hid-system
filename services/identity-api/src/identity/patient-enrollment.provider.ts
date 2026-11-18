import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { NinCheckOnce, type NinCheckAnswer, type NinCheckPath, qoreIdRejected, unusableAnswer } from './nin-check-once';
import { QoreIdVerificationAdapter } from './qoreid-verification.adapter';
import type { QoreIdNinEnrollmentBinding, QoreIdVerificationResult } from './qoreid-verification.types';

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
   * 'other'.
   */
  verifyNin(nin: string, context?: NinCheckContext): Promise<VerifiedPublicPatientIdentity>;
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
    const checked = await this.ninCheck.check({
      nin, correlationId: context.correlationId ?? `nin-check-${randomUUID()}`, path: context.path ?? 'other',
      needsCompleteRecord: true,
      ask: async ({ timeoutMs }) => ({
        answer: enrollmentAnswer(await this.adapter.verifyNinEnrollment(nin, { timeoutMs }), nin), value: undefined }),
    });
    return identityFromAnswer(checked.answer, nin);
  }
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

/** The same answer for a fresh and a stored check. */
function identityFromAnswer(answer: NinCheckAnswer, nin: string): VerifiedPublicPatientIdentity {
  if (answer.outcome === 'rejected') throw qoreIdRejected();
  if (answer.outcome === 'unusable') throw invalidResponse();
  if (answer.outcome === 'no_record') {
    throw new DomainProblem(422, 'NIN_NOT_VERIFIED', 'The NIN could not be verified');
  }
  if (!answer.record.complete || answer.record.binding.nin !== nin) throw invalidResponse();
  return { ...answer.record.binding, providerReference: answer.providerReference };
}

function invalidResponse(): DomainProblem {
  return new DomainProblem(502, 'QOREID_PROVIDER_RESPONSE_INVALID', 'External verification returned an invalid response');
}
