import { DomainProblem } from '../common/problem';
import type { PlatformAdminContext, HidRequest } from '../common/request-context';

export function requireAdminContext(request: HidRequest): PlatformAdminContext {
  const actor = request.actor;
  const facility = actor?.facility;
  if (!actor || !request.correlationId) {
    throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid administrator authentication is required');
  }
  if (actor.kind === 'patient' || !actor.platformPermissions?.includes('platform.admin.access')) {
    throw new DomainProblem(403, 'PERMISSION_DENIED', 'Platform administration authority is required');
  }
  return {
    actor,
    ...(facility ? { facilityId: facility.id, membershipId: facility.membershipId } : {}),
    correlationId: request.correlationId,
    purposeOfUse: 'healthcare-operations',
    authorization: request.header('authorization'),
  };
}
