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

/** Patient consent commands are tied to the authenticated patient session,
 * never to a facility header supplied by the browser. */
export function patientConsentRequest(request: HidRequest): HidRequest {
  if (request.header('x-purpose-of-use') !== 'direct-care') {
    throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED',
      'X-Purpose-Of-Use must be direct-care for this consent command');
  }
  if (request.actor?.kind !== 'patient' || !request.actor.patientId || !request.actor.sessionId) {
    throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
  }
  return request;
}
