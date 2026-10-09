import { Injectable } from '@nestjs/common';
import { PharmacyApiClient, PharmacyApiProblem } from '@hid/api-client';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { ServiceWorkloadIdentityService } from './service-workload-identity.service';

@Injectable()
export class PharmacyApiService {
  private readonly client: PharmacyApiClient;

  constructor(workloadIdentity: ServiceWorkloadIdentityService) {
    const environment = getEnvironment();
    this.client = new PharmacyApiClient({
      baseUrl: environment.PHARMACY_API_URL,
      timeoutMs: 10_000,
      internalServiceToken: environment.PHARMACY_INTERNAL_SERVICE_TOKEN,
      ...(environment.PHARMACY_SERVICE_IDENTITY_MODE === 'jwt'
        ? { serviceAuthorizationProvider: (caller) => workloadIdentity.authorization('pharmacy', caller) }
        : {}),
    });
  }

  createOcrImport(context: DataAccessContext, input: unknown, key: string) {
    return this.translate(this.client.createOcrImport(input, this.context(context), key));
  }

  private context(context: DataAccessContext) {
    if (!context.authorization && !context.userCookie) {
      throw new DomainProblem(
        503,
        'PHARMACY_SERVICE_AUTH_UNAVAILABLE',
        'Authenticated Pharmacy service delegation is unavailable',
      );
    }
    return {
      authorization: context.authorization,
      cookie: context.userCookie,
      csrfToken: context.csrfToken,
      origin: context.origin,
      correlationId: context.correlationId,
      facilityId: context.facilityId,
      purposeOfUse: context.purposeOfUse,
    };
  }

  private async translate<T>(operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      if (error instanceof PharmacyApiProblem) {
        const payload = error.payload as { code?: unknown; detail?: unknown };
        throw new DomainProblem(
          error.status,
          typeof payload?.code === 'string' ? payload.code : 'PHARMACY_SERVICE_ERROR',
          typeof payload?.detail === 'string' ? payload.detail : 'Pharmacy service request failed',
        );
      }
      throw new DomainProblem(503, 'PHARMACY_SERVICE_UNAVAILABLE', 'Pharmacy service is unavailable');
    }
  }
}
