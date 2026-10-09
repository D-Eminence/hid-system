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

export interface PublicPatientIdentityProvider {
  verifyNin(nin: string): Promise<VerifiedPublicPatientIdentity>;
}

/** Production adapter. Unit tests inject a fixture provider through the token. */
@Injectable()
export class QoreIdPublicPatientIdentityProvider implements PublicPatientIdentityProvider {
  constructor(private readonly adapter: QoreIdVerificationAdapter,
    private readonly integrations: IntegrationRuntimeService) {}

  async verifyNin(nin: string): Promise<VerifiedPublicPatientIdentity> {
    const environment = getEnvironment();
    if (!environment.QOREID_ENABLED) {
      throw new DomainProblem(503, 'QOREID_DISABLED', 'Patient identity enrollment is temporarily unavailable');
    }
    if (!environment.QOREID_NIN_ONLY_ENROLLMENT_ENABLED) {
      throw new DomainProblem(503, 'QOREID_NIN_ONLY_DISABLED',
        'Patient identity enrollment is temporarily unavailable');
    }
    await this.integrations.assertAvailable('qoreid', 'patient_nin');
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
