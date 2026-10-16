import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import type { IdentityApiService } from '../../integrations/identity-api.service';

/**
 * The patient-self authorization of this request's own session: Identity
 * confirms it (cookie or bearer, ehr-api workload) and it must still name the
 * same patient, account, subject and session. Every patient-self read
 * (the record summary, a document download, the imported history, record
 * chat before and after its model call) runs in the transaction
 * DatabaseService.withPatientTransaction opens with it.
 */
export async function authorizeOwnSession(identity: Pick<IdentityApiService, 'authorizeSelf'>, request: HidRequest) {
  const actor = requirePatientSession(request);
  const authorization = await identity.authorizeSelf(request);
  if (authorization.patientId !== actor.patientId || authorization.accountId !== actor.accountId
    || authorization.subject !== actor.subject || authorization.sessionId !== actor.sessionId) {
    throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient authorization changed');
  }
  return { actor, authorization };
}

/** The request's patient session, or 403 PATIENT_SESSION_REQUIRED. */
export function requirePatientSession(request: HidRequest) {
  const actor = request.actor;
  if (actor?.kind !== 'patient' || !actor.patientId || !actor.sessionId) {
    throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
  }
  return actor as typeof actor & { patientId: string; sessionId: string };
}
