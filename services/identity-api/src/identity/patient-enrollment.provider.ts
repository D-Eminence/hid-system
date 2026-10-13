import { Injectable } from '@nestjs/common';
import { DomainProblem, PublicDetailProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { PATIENT_REGISTRATION_NOT_OPEN, QoreIdVerificationAdapter } from './qoreid-verification.adapter';
import type { QoreIdNinEnrollmentBinding } from './qoreid-verification.types';

export const PUBLIC_PATIENT_IDENTITY_PROVIDER = Symbol('PUBLIC_PATIENT_IDENTITY_PROVIDER');

export interface VerifiedPublicPatientIdentity extends QoreIdNinEnrollmentBinding {
  providerReference: string;
}

/** What one NIN lookup is charged to (0085): the request and the keyed client network. */
export interface PublicPatientLookupCharge {
  correlationId: string;
  /** HMAC of the client network (an IPv4 address or an IPv6 /64), 64 hex characters. */
  networkDigest: string;
}

/** The refusals of a closed gate. Any other failure is a fault, not an answer. */
const CLOSED_GATE_CODES = new Set(['QOREID_DISABLED', 'QOREID_NIN_ONLY_DISABLED', 'INTEGRATION_PAUSED']);

export interface PublicPatientIdentityProvider {
  /**
   * The enrollment gate: refuses with 503 unless QoreID and NIN-only enrollment
   * are enabled and QoreID is not paused at runtime. It reads no NIN, so every
   * NIN gets the same answer while the gate is closed (ENR-4).
   */
  assertAvailable(): Promise<void>;
  /**
   * The same gate as an answer (FE-4): false where assertAvailable refuses
   * because the gate is closed, true where it passes. A fault reading the
   * runtime state is thrown, not answered.
   */
  isAvailable(): Promise<boolean>;
  /** Checks the gate again, charges the lookup (429 when refused), then asks QoreID. */
  verifyNin(nin: string, charge: PublicPatientLookupCharge): Promise<VerifiedPublicPatientIdentity>;
}

/** Production adapter. Unit tests inject a fixture provider through the token. */
@Injectable()
export class QoreIdPublicPatientIdentityProvider implements PublicPatientIdentityProvider {
  constructor(private readonly adapter: QoreIdVerificationAdapter,
    private readonly integrations: IntegrationRuntimeService) {}

  async assertAvailable(): Promise<void> {
    const environment = getEnvironment();
    // Switched off by configuration, which production keeps for NIN-only
    // enrollment until the N1 holder step ships: the patient is told that
    // registration is not open, not that it is temporarily unavailable.
    if (!environment.QOREID_ENABLED) {
      throw new PublicDetailProblem(503, 'QOREID_DISABLED', PATIENT_REGISTRATION_NOT_OPEN);
    }
    if (!environment.QOREID_NIN_ONLY_ENROLLMENT_ENABLED) {
      throw new PublicDetailProblem(503, 'QOREID_NIN_ONLY_DISABLED', PATIENT_REGISTRATION_NOT_OPEN);
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

  async verifyNin(nin: string, charge: PublicPatientLookupCharge): Promise<VerifiedPublicPatientIdentity> {
    await this.assertAvailable();
    // Charged only here, on the path that calls QoreID; a refusal is committed
    // with its audit event and answered 429 before any request leaves.
    await this.integrations.consumePublicPatientNinQuota(charge.correlationId, charge.networkDigest);
    const result = await this.adapter.verifyNinEnrollment(nin);
    if (result.state !== 'verified') {
      throw new DomainProblem(422, 'NIN_NOT_VERIFIED', 'The NIN could not be verified');
    }
    if (!result.providerReference || !result.ninEnrollmentBinding || result.ninEnrollmentBinding.nin !== nin) {
      throw new DomainProblem(502, 'QOREID_PROVIDER_RESPONSE_INVALID',
        'External verification returned an invalid response');
    }
    return { ...result.ninEnrollmentBinding, providerReference: result.providerReference };
  }
}
