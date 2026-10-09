import { Injectable } from '@nestjs/common';
import { IdentityApiClient, IdentityApiProblem } from '@hid/api-client';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { ServiceWorkloadIdentityService } from './service-workload-identity.service';

@Injectable()
export class IdentityApiService {
  private readonly client: IdentityApiClient;

  constructor(workloadIdentity: ServiceWorkloadIdentityService) {
    const environment = getEnvironment();
    this.client = new IdentityApiClient({
      baseUrl: environment.IDENTITY_API_URL,
      caller: 'ocr-api',
      timeoutMs: 10_000,
      workloadHeaders: () => workloadIdentity.identityHeaders(),
    });
  }

  authenticateRequest(request: HidRequest) {
    const authorization = request.header('authorization');
    const cookie = request.header('cookie');
    return this.translate(this.client.authenticateActor({
      correlationId: request.correlationId,
      facilityId: request.header('x-facility-id'),
      authorization,
      cookie,
      csrfToken: request.header('x-csrf-token'),
      origin: request.header('origin'),
      validateMutation: Boolean(cookie && !authorization && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)),
    }));
  }

  authorize(
    patientId: string,
    scope: 'read_records' | 'write_records',
    purpose: 'direct-care' | 'emergency' | 'healthcare-operations',
    context: DataAccessContext,
  ) {
    return this.translate(this.client.authorizePatient(patientId, scope, purpose, {
      correlationId: context.correlationId,
      facilityId: context.facilityId,
      purposeOfUse: purpose,
      authorization: context.authorization,
      cookie: context.userCookie,
      csrfToken: context.csrfToken,
      origin: context.origin,
    }));
  }

  private async translate<Value>(operation: Promise<Value>): Promise<Value> {
    try {
      return await operation;
    } catch (error) {
      if (error instanceof IdentityApiProblem) {
        throw new DomainProblem(
          error.status,
          error.code ?? 'IDENTITY_SERVICE_ERROR',
          error.message,
        );
      }
      if (error instanceof DomainProblem) throw error;
      throw new DomainProblem(503, 'IDENTITY_SERVICE_UNAVAILABLE', 'Identity service is unavailable');
    }
  }
}
