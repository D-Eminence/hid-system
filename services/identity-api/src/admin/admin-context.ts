import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';

export function requireAdminContext(request: HidRequest): DataAccessContext {
  const actor = request.actor;
  if (!actor || !request.correlationId) {
    throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid administrator authentication is required');
  }
  const isPlatformAdmin = actor.platformPermissions?.includes('platform.admin.access') ?? false;
  if (!isPlatformAdmin && !actor.facility) {
    throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid administrator authentication is required');
  }
  const facility = actor.facility;
  return {
    actor,
    facilityId: facility?.id ?? '',
    membershipId: facility?.membershipId ?? '',
    correlationId: request.correlationId,
    purposeOfUse: 'healthcare-operations',
    authorization: request.header('authorization'),
  };
}
