import { DomainProblem } from '../common/problem';
import { requireRequestContext, type DataAccessContext, type HidRequest, type PurposeOfUse } from '../common/request-context';

export function consentContext(
  request: HidRequest,
  allowedPurposes: readonly PurposeOfUse[],
): DataAccessContext {
  const purpose = request.header('x-purpose-of-use');
  if (!purpose || !allowedPurposes.includes(purpose as PurposeOfUse)) {
    throw new DomainProblem(
      400,
      'PURPOSE_OF_USE_REQUIRED',
      `X-Purpose-Of-Use must be ${allowedPurposes.join(' or ')} for this consent command`,
    );
  }
  return requireRequestContext(request, purpose);
}

/**
 * The context of a patient's own decision on an access request (list, approve,
 * deny). The decision is bound to the authenticated patient session, never to
 * a staff facility a patient does not have; the database takes the purpose of
 * the grant from the request the clinician made. The patient app sends no
 * purpose header for these (a header, if sent, must be direct-care). Before
 * this, these three routes answered 400 PURPOSE_OF_USE_REQUIRED to the app
 * and, with the header, 500 (no facility in the request context), so no
 * patient could see, approve or deny a request in the app. main binds them to
 * the patient session the same way.
 */
export function patientConsentContext(request: HidRequest): DataAccessContext {
  const actor = request.actor;
  if (actor?.kind !== 'patient' || !actor.patientId || !actor.sessionId || !request.correlationId) {
    throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
  }
  const purpose = request.header('x-purpose-of-use');
  if (purpose !== undefined && purpose !== 'direct-care') {
    throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED',
      'A patient decision on an access request takes no purpose of use other than direct-care');
  }
  request.purposeOfUse = 'direct-care';
  return {
    actor,
    facilityId: '',
    membershipId: '',
    correlationId: request.correlationId,
    purposeOfUse: 'direct-care',
    authorization: request.header('authorization'),
  };
}
