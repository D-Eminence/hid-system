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
  scope: 'read_records' | 'write_records';
  purpose: string;
  breakGlass: boolean;
}

/** What Outreach keeps of an Identity patient lookup: never the full Health ID. */
export interface HealthIdPatient {
  patientId: string;
  fullName: string;
  dateOfBirth: string | null;
  healthIdLast4: string;
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
    if (!IdentityService.writeAllowed(decision, patientId, context)) throw new DomainProblem(403,
      'IDENTITY_AUTHORIZATION_DENIED', 'Identity did not authorize the existing patient link');
  }

  /**
   * Resolves a Health ID with the caller's own authorization, through
   * Identity's patient lookup (read_records; Identity audits it and the
   * patient sees it as a view). Identity's 404 NOT_FOUND becomes
   * OUTREACH_HEALTH_ID_NOT_FOUND and only its 403 ACCESS_DENIED (no access to
   * this patient) becomes OUTREACH_PATIENT_ACCESS_REQUIRED; every other
   * refusal (a role that may not look patients up, facility, origin, CSRF, a
   * disabled portal) keeps Identity's status and code. Break-glass access is
   * refused here as the link refuses it.
   */
  async lookupByHealthId(healthId: string, context: DataAccessContext): Promise<HealthIdPatient> {
    const found = await this.client.lookupPatient(healthId, 'direct-care', this.delegated(context))
      .catch((error) => {
        if (error instanceof IdentityApiProblem) {
          if (error.status === 404 && error.code === 'NOT_FOUND') throw new DomainProblem(404,
            'OUTREACH_HEALTH_ID_NOT_FOUND', 'No one has this Health ID. Check it and try again.');
          if (error.status === 403 && error.code === 'ACCESS_DENIED') throw IdentityService.accessRequired();
          throw new DomainProblem(error.status, error.code ?? 'IDENTITY_AUTHORIZATION_DENIED', error.message);
        }
        throw new DomainProblem(503, 'IDENTITY_SERVICE_UNAVAILABLE', 'Identity patient lookup is unavailable');
      });
    // Identity must have answered for this Health ID and this member at this
    // facility; anything else is a bad answer, never shown as this person.
    if (found.patient.hid !== healthId || found.authorization.membershipId !== context.membershipId
        || found.authorization.facilityId !== context.facilityId) throw new DomainProblem(502,
      'IDENTITY_BAD_RESPONSE', 'Identity answered the patient lookup for a different request');
    if (found.authorization.breakGlass !== false) throw IdentityService.accessRequired();
    return { patientId: found.patient.patientId, fullName: found.patient.fullName,
      dateOfBirth: found.patient.dateOfBirth ?? null, healthIdLast4: found.patient.hid.slice(-4) };
  }

  /**
   * Whether linking would be authorized: the same write_records check the
   * link makes, answered as a yes or no. A refusal of the check itself (403)
   * is a no; Identity unavailable is an error.
   */
  async canLinkPatient(patientId: string, context: DataAccessContext): Promise<boolean> {
    try {
      const decision = await this.client.authorizePatient(patientId, 'write_records', 'direct-care',
        this.delegated(context));
      return IdentityService.writeAllowed(decision, patientId, context);
    } catch (error) {
      if (error instanceof IdentityApiProblem) {
        if (error.status === 403) return false;
        throw new DomainProblem(error.status, error.code ?? 'IDENTITY_AUTHORIZATION_DENIED', error.message);
      }
      throw new DomainProblem(503, 'IDENTITY_SERVICE_UNAVAILABLE', 'Identity authorization service is unavailable');
    }
  }

  private delegated(context: DataAccessContext) {
    return { correlationId: context.correlationId, facilityId: context.facilityId,
      purposeOfUse: 'direct-care' as const, authorization: context.userAuthorization,
      cookie: context.userCookie, csrfToken: context.csrfToken, origin: context.origin };
  }

  private static writeAllowed(decision: AuthorizationDecision, patientId: string,
    context: DataAccessContext): boolean {
    return decision.allowed === true && decision.patientId === patientId
      && decision.facilityId === context.facilityId && decision.scope === 'write_records'
      && decision.breakGlass === false;
  }

  private static accessRequired(): DomainProblem {
    return new DomainProblem(403, 'OUTREACH_PATIENT_ACCESS_REQUIRED',
      'Ask the person to share their record with you, or use their PIN.');
  }
}
