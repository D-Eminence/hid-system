import type { AuditEventInput } from '../audit/audit.service';
import type { ActorContext, HidRequest } from '../common/request-context';
import type { SessionEventMetadata } from './token.service';

/**
 * The session metadata of a request: its correlation id, the client address
 * and the user agent (stored hashed). Shared by POST /auth/patient/login and
 * the patient enrollment activation, so both sign-ins record the same device
 * facts.
 */
export function sessionEventFromRequest(request: HidRequest): SessionEventMetadata {
  return {
    correlationId: request.correlationId,
    sourceIp: request.ip,
    userAgent: request.header('user-agent'),
  };
}

/**
 * The audit event of a successful sign-in, refresh or sign-out (`action`),
 * as POST /auth/login and /auth/patient/login record it. The patient
 * enrollment activation records the same 'auth.login' event when it signs the
 * new patient in, so the two cannot drift.
 */
export function sessionSuccessAuditEvent(action: string, actor: ActorContext, request: HidRequest): AuditEventInput {
  return {
    correlationId: request.correlationId,
    actorType: actor.kind === 'patient' ? 'patient' : 'staff',
    actorSubject: actor.subject,
    actorAccountId: actor.accountId,
    actorMembershipId: actor.facility?.membershipId,
    organizationId: actor.facility?.organizationId,
    facilityId: actor.facility?.id,
    action,
    resourceType: 'session',
    resourceId: actor.sessionId,
    outcome: 'success',
    sourceIp: request.ip,
    userAgent: request.header('user-agent'),
  };
}
