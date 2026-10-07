import { Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { DatabaseService } from '../database/database.service';
import { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { QoreIdVerificationAdapter } from './qoreid-verification.adapter';
import { verifiedCacBinding } from './organization-applications.service';
import { OrganizationProfileCompletionService } from './organization-profile-completion.service';
import type { StartProviderEnrollmentDto } from './dto/provider-enrollment.dto';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';

interface ApplicationRow {
  application_id: string;
  application_status: string;
  verification_result: string | null;
  provider_verified_registration_number: string | null;
  row_version: string;
}

@Injectable()
export class ProviderEnrollmentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly integrations: IntegrationRuntimeService,
    private readonly qoreid: QoreIdVerificationAdapter,
    private readonly completion: OrganizationProfileCompletionService,
  ) {}

  async start(input: StartProviderEnrollmentDto, request: HidRequest) {
    if (!getEnvironment().QOREID_ENABLED) {
      throw new DomainProblem(503, 'QOREID_DISABLED', 'External verification is not enabled');
    }

    const applicationId = await this.database.withSystemTransaction(request.correlationId, async (client) => {
      const result = await client.query<{ application_id: string }>(
        'select identity.submit_self_service_organization_application($1,$2,$3,$4,$5) as application_id',
        [input.productCode, input.organizationType, input.cacRegistrationNumber,
          input.administratorName, input.administratorEmail.trim().toLowerCase()],
      );
      return result.rows[0]?.application_id;
    });
    if (!applicationId) {
      throw new DomainProblem(503, 'PROVIDER_ENROLLMENT_UNAVAILABLE',
        'Provider enrollment is temporarily unavailable');
    }

    const current = await this.database.withSystemTransaction(request.correlationId, async (client) => {
      const result = await client.query<ApplicationRow>(
        'select * from identity.public_get_organization_application($1,$2,$3)',
        [input.cacRegistrationNumber, input.administratorEmail.trim().toLowerCase(), input.productCode],
      );
      return result.rows[0];
    });

    if (!current || current.application_id !== applicationId) {
      throw new DomainProblem(409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW',
        'This provider application requires manual resolution');
    }

    if (current.application_status === 'approved') {
      throw new DomainProblem(409, 'PROVIDER_ALREADY_REGISTERED',
        'This provider organization is already registered with HID');
    }

    if (current.application_status === 'ready_for_review'
      && current.verification_result === 'verified'
      && current.provider_verified_registration_number === input.cacRegistrationNumber) {
      return this.startEmailVerification(input, request);
    }

    let result;
    try {
      await this.integrations.assertAvailable('qoreid', 'provider_cac');
      result = await this.database.withSystemTransaction(request.correlationId, async (client) => {
        await this.integrations.consumeQuotaWithClient(client, 'application_cac', applicationId);
        const providerResult = await this.qoreid.verifyCac(input.cacRegistrationNumber);
        if (providerResult.state !== 'verified') return providerResult;
        const binding = verifiedCacBinding(input.cacRegistrationNumber, providerResult);
        if (!binding || !providerResult.providerReference) {
          throw new DomainProblem(502, 'QOREID_PROVIDER_RESPONSE_INVALID',
            'External verification returned an invalid response');
        }
        await client.query(
          'select * from identity.public_record_organization_cac_result($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [applicationId, Number(current.row_version), 'verified', providerResult.providerReference,
            binding.registrationNumber, binding.companyName, binding.entityType,
            binding.registrationDate, binding.address, binding.registryStatus],
        );
        return providerResult;
      });
    } catch (error) {
      if (error instanceof DomainProblem) throw error;
      throw new DomainProblem(503, 'PROVIDER_CAC_VERIFICATION_UNAVAILABLE',
        'CAC verification is temporarily unavailable');
    }

    if (result.state !== 'verified') {
      throw new DomainProblem(422, 'CAC_NOT_VERIFIED',
        'The CAC could not be verified. Check the registration number and try again.');
    }

    return this.startEmailVerification(input, request);
  }

  private startEmailVerification(input: StartProviderEnrollmentDto, request: HidRequest) {
    return this.completion.start({
      productCode: input.productCode,
      cacRegistrationNumber: input.cacRegistrationNumber,
      administratorEmail: input.administratorEmail,
      turnstileAction: 'organization-completion',
      turnstileToken: input.turnstileToken,
    }, request.ip, request.correlationId);
  }
}
