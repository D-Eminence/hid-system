import { DomainProblem } from '../common/problem';
import type { HidRequest, PlatformAccessContext } from '../common/request-context';

/**
 * Platform administration context. It is available only on @PlatformScope
 * routes, which the security guard has already authorized with platform
 * permissions and bound to no facility. No facility or membership is borrowed
 * from the administrator's own provider account.
 */
export function requireAdminContext(request: HidRequest): PlatformAccessContext {
  const actor = request.actor;
  if (!actor || actor.kind === 'patient' || request.accessScope !== 'platform' || !request.correlationId) {
    throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid administrator authentication is required');
  }
  if (!(actor.platformPermissions ?? []).includes('platform.admin.access')) {
    throw new DomainProblem(403, 'PERMISSION_DENIED', 'Required permission is missing');
  }
  return {
    scope: 'platform',
    actor,
    facilityId: null,
    membershipId: null,
    correlationId: request.correlationId,
    purposeOfUse: 'healthcare-operations',
    authorization: request.header('authorization'),
  };
}

/** Actor fields for a platform-scoped semantic audit event: no facility or membership. */
export function platformAuditActor(context: PlatformAccessContext) {
  return {
    correlationId: context.correlationId,
    actorType: 'staff' as const,
    actorSubject: context.actor.subject,
    actorAccountId: context.actor.accountId,
    accessScope: 'platform' as const,
  };
}
