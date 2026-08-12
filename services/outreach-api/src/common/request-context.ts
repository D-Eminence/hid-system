import type { Request } from 'express';

export interface FacilityAssignment {
  id: string;
  membershipId: string;
  organizationId: string;
  name: string;
  code?: string;
  roles: readonly string[];
  permissions: readonly string[];
  isPrimary: boolean;
}

export interface ActorContext {
  id: string;
  subject: string;
  accountId: string;
  sessionId?: string;
  roles: readonly string[];
  permissions: readonly string[];
  facilityIds: readonly string[];
  facilities: readonly FacilityAssignment[];
  facility?: FacilityAssignment;
  role?: string;
  authenticationMethod: 'local' | 'oidc';
}

export interface HidRequest extends Request {
  correlationId: string;
  actor?: ActorContext;
  facilityId?: string;
}

export interface DataAccessContext {
  correlationId: string;
  actor: ActorContext;
  facilityId: string;
  membershipId: string;
  purposeOfUse: 'direct-care';
  userAuthorization?: string;
  userCookie?: string;
  csrfToken?: string;
  origin?: string;
}

export function requireRequestContext(request: HidRequest): DataAccessContext {
  if (!request.actor?.facility || !request.facilityId || !request.correlationId) {
    throw new Error('Request context was not established by the Outreach security guard');
  }
  return {
    actor: request.actor,
    facilityId: request.facilityId,
    membershipId: request.actor.facility.membershipId,
    correlationId: request.correlationId,
    purposeOfUse: 'direct-care',
    userAuthorization: request.header('authorization'),
    userCookie: request.header('cookie'),
    csrfToken: request.header('x-csrf-token'),
    origin: request.header('origin'),
  };
}
