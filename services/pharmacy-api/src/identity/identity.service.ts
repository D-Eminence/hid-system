import { Injectable } from '@nestjs/common';
import { IdentityApiClient, IdentityApiProblem } from '@hid/api-client';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { PharmacyWorkloadIdentityService } from '../auth/pharmacy-workload-identity.service';

export interface AuthorizationDecision {
  allowed: boolean;
  patientId: string;
  facilityId: string;
  membershipId: string;
  scope: 'read_records' | 'write_records';
  purpose: string;
  consentGrantId?: string;
  breakGlass: boolean;
}

@Injectable()
export class IdentityService {
  private readonly client: IdentityApiClient;

  constructor(workloadIdentity: PharmacyWorkloadIdentityService) {
    this.client = new IdentityApiClient({ baseUrl: getEnvironment().IDENTITY_API_URL,
      caller: 'pharmacy-api', timeoutMs: 5_000,
      workloadHeaders: () => workloadIdentity.identityHeaders() });
  }

  async authorize(patientId: string, scope: 'read_records' | 'write_records',
    context: DataAccessContext): Promise<AuthorizationDecision> {
    const decision = await this.client.authorizePatient(patientId, scope, context.purposeOfUse,
      { authorization: context.authorization, cookie: context.userCookie,
        csrfToken: context.csrfToken, origin: context.origin, correlationId: context.correlationId,
        facilityId: context.facilityId, purposeOfUse: context.purposeOfUse })
      .catch((error) => { if (error instanceof IdentityApiProblem) throw new DomainProblem(error.status,
        error.code ?? 'IDENTITY_AUTHORIZATION_DENIED', error.message); throw new DomainProblem(503,
        'IDENTITY_SERVICE_UNAVAILABLE', 'Identity authorization service is unavailable'); });
    if (typeof decision.allowed !== 'boolean' || decision.patientId !== patientId
        || decision.facilityId !== context.facilityId || decision.scope !== scope
        || typeof decision.breakGlass !== 'boolean') {
      throw new DomainProblem(502, 'INVALID_IDENTITY_RESPONSE',
        'Identity returned an invalid Pharmacy authorization decision');
    }
    return decision as AuthorizationDecision;
  }
}
