import type { Request } from 'express';
import { DomainProblem } from './problem';

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

export type PurposeOfUse = 'direct-care' | 'emergency' | 'healthcare-operations';

export interface HidRequest extends Request {
  correlationId: string;
  actor?: ActorContext;
  facilityId?: string;
  authTransport?: 'bearer' | 'cookie';
  purposeOfUse?: PurposeOfUse;
}

export interface DataAccessContext {
  correlationId: string;
  actor: ActorContext;
  facilityId: string;
  membershipId: string;
  purposeOfUse: PurposeOfUse;
  authorization?: string;
  userCookie?: string;
  /** The browser request's method; Identity applies its browser-write check to a forwarded cookie only for a write. */
  requestMethod?: string;
  csrfToken?: string;
  origin?: string;
}

const PURPOSES = new Set<PurposeOfUse>(['direct-care', 'emergency', 'healthcare-operations']);

export function requireRequestContext(request: HidRequest): DataAccessContext {
  if (!request.actor || !request.facilityId || !request.correlationId) {
    throw new Error('Request context was not established by the security guard');
  }
  const candidate = request.header('x-purpose-of-use');
  const authorization = request.header('authorization');
  const userCookie = request.header('cookie');
  // The guard requires a bearer token or a cookie, so their absence is a bug.
  if (!authorization && !userCookie) {
    throw new Error('Validated authorization is required for Pharmacy data access');
  }
  // The purpose comes from the header, which the guard does not check, so a
  // missing or unknown one is the client's error.
  if (!candidate || !PURPOSES.has(candidate as PurposeOfUse)) {
    throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED',
      'X-Purpose-Of-Use must be direct-care, emergency or healthcare-operations');
  }
  request.purposeOfUse = candidate as PurposeOfUse;
  return {
    actor: request.actor,
    facilityId: request.facilityId,
    membershipId: request.actor.facility?.membershipId ?? '',
    correlationId: request.correlationId,
    purposeOfUse: candidate as PurposeOfUse,
    authorization,
    userCookie,
    csrfToken: request.header('x-csrf-token'),
    origin: request.header('origin'),
    requestMethod: request.method,
  };
}
