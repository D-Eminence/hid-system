import { Injectable } from '@nestjs/common';
import { IdentityApiClient, IdentityApiProblem } from '@hid/api-client';
import { WorkloadCredentialsService } from '../auth/workload-credentials.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';

interface AuthorizationDecision {
  allowed: boolean;
  patientId: string;
  facilityId: string;
  membershipId: string;
  scope: 'write_records';
  purpose: string;
  breakGlass: boolean;
}

@Injectable()
export class IdentityService {
  private readonly client: IdentityApiClient;

  constructor(private readonly workload: WorkloadCredentialsService) {
    this.client = new IdentityApiClient({ baseUrl: getEnvironment().IDENTITY_API_URL,
      caller: 'outreach-api', timeoutMs: 5_000,
      workloadHeaders: () => this.workload.headers() });
  }

  async authorizeExistingPatient(patientId: string, context: DataAccessContext): Promise<void> {
    const decision = await this.client.authorizePatient(patientId, 'write_records', 'direct-care', {
      correlationId: context.correlationId, facilityId: context.facilityId,
      purposeOfUse: 'direct-care', authorization: context.userAuthorization,
      cookie: context.userCookie, csrfToken: context.csrfToken, origin: context.origin,
    }).catch((error) => { if (error instanceof IdentityApiProblem) throw new DomainProblem(error.status,
      error.code ?? 'IDENTITY_AUTHORIZATION_DENIED', error.message); throw new DomainProblem(503,
      'IDENTITY_SERVICE_UNAVAILABLE', 'Identity authorization service is unavailable'); });
    if (decision.allowed !== true || decision.patientId !== patientId
        || decision.facilityId !== context.facilityId || decision.scope !== 'write_records'
        || decision.breakGlass !== false) throw new DomainProblem(403, 'IDENTITY_AUTHORIZATION_DENIED',
      'Identity did not authorize the existing patient link');
  }
}
