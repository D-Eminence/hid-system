import { Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { QoreIdVerificationAdapter } from './qoreid-verification.adapter';
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

export interface PublicPatientIdentityProvider {
  /**
   * The enrollment gate: refuses with 503 unless QoreID and NIN-only enrollment
   * are enabled and QoreID is not paused at runtime. It reads no NIN, so every
   * NIN gets the same answer while the gate is closed (ENR-4).
   */
  assertAvailable(): Promise<void>;
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
    if (!environment.QOREID_ENABLED) {
      throw new DomainProblem(503, 'QOREID_DISABLED', 'Patient identity enrollment is temporarily unavailable');
    }
    if (!environment.QOREID_NIN_ONLY_ENROLLMENT_ENABLED) {
      throw new DomainProblem(503, 'QOREID_NIN_ONLY_DISABLED',
        'Patient identity enrollment is temporarily unavailable');
    }
    await this.integrations.assertAvailable('qoreid', 'patient_nin');
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
