import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';

export function requireAdminContext(request: HidRequest): DataAccessContext {
  const actor = request.actor;
  const facility = actor?.facility;
  if (!actor || !facility || !request.correlationId) {
    throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid administrator authentication is required');
  }
  return {
    actor,
    facilityId: facility.id,
    membershipId: facility.membershipId,
    correlationId: request.correlationId,
    purposeOfUse: 'healthcare-operations',
    authorization: request.header('authorization'),
  };
}
