import { Injectable } from '@nestjs/common';
import { EhrApiClient, EhrApiProblem, type EhrOcrClinicalNoteImport } from '@hid/api-client';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { ServiceWorkloadIdentityService } from './service-workload-identity.service';

@Injectable()
export class EhrApiService {
  private readonly client: EhrApiClient;

  constructor(workloadIdentity: ServiceWorkloadIdentityService) {
    const environment = getEnvironment();
    this.client = new EhrApiClient({
      baseUrl: environment.EHR_API_URL,
      timeoutMs: 10_000,
      internalServiceToken: environment.EHR_INTERNAL_SERVICE_TOKEN,
      ...(environment.EHR_SERVICE_IDENTITY_MODE === 'jwt'
        ? { serviceAuthorizationProvider: (caller) => workloadIdentity.authorization('ehr', caller) }
        : {}),
    });
  }

  getOcrDocumentSource(documentId: string, context: DataAccessContext) {
    return this.translate(this.client.getOcrDocumentSource(documentId, this.context(context)));
  }

  createOcrClinicalNote(patientId: string, input: EhrOcrClinicalNoteImport,
    context: DataAccessContext, idempotencyKey: string) {
    return this.translate(this.client.createOcrClinicalNote(
      patientId, input, this.context(context), idempotencyKey,
    ));
  }

  private context(context: DataAccessContext) {
    if (!context.authorization && !context.userCookie) {
      throw new DomainProblem(503, 'EHR_SERVICE_AUTH_UNAVAILABLE',
        'Authenticated EHR service delegation is unavailable');
    }
    return { authorization: context.authorization, cookie: context.userCookie,
      csrfToken: context.csrfToken, origin: context.origin,
      correlationId: context.correlationId, facilityId: context.facilityId,
      purposeOfUse: context.purposeOfUse };
  }

  private async translate<T>(operation: Promise<T>): Promise<T> {
    try { return await operation; }
    catch (error) {
      if (error instanceof EhrApiProblem) {
        const payload = error.payload as { code?: unknown; detail?: unknown };
        throw new DomainProblem(error.status,
          typeof payload?.code === 'string' ? payload.code : 'EHR_SERVICE_ERROR',
          typeof payload?.detail === 'string' ? payload.detail : 'EHR service request failed');
      }
      if (error instanceof DomainProblem) throw error;
      throw new DomainProblem(503, 'EHR_SERVICE_UNAVAILABLE', 'EHR service is unavailable');
    }
  }
}
