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
  kind?: 'patient' | 'staff';
  patientId?: string;
  id: string;
  subject: string;
  accountId: string;
  sessionId?: string;
  email?: string;
  displayName?: string;
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
  authTransport?: 'bearer' | 'cookie';
  purposeOfUse?: PurposeOfUse;
}

export type PurposeOfUse = 'direct-care' | 'emergency' | 'healthcare-operations';
const PURPOSES = new Set<PurposeOfUse>(['direct-care', 'emergency', 'healthcare-operations']);

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

export function requireRequestContext(request: HidRequest, suppliedPurpose?: string): DataAccessContext {
  if (!request.actor || !request.facilityId || !request.correlationId) {
    throw new Error('Request context was not established by security guards');
  }
  // The guard requires a bearer token or a cookie, so their absence is a bug.
  if (!request.header('authorization') && !request.header('cookie')) {
    throw new Error('Validated authorization is required for Lab data access');
  }
  // A body purpose (the external import) is validated before this; the header,
  // which every other route uses, is not checked by the guard, so a missing or
  // unknown purpose is the client's error.
  const candidate = suppliedPurpose ?? request.header('x-purpose-of-use');
  if (!candidate || !PURPOSES.has(candidate as PurposeOfUse)) {
    throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED',
      'X-Purpose-Of-Use must be direct-care, emergency or healthcare-operations');
  }
  const purposeOfUse = candidate as PurposeOfUse;
  request.purposeOfUse = purposeOfUse;
  return {
    actor: request.actor,
    facilityId: request.facilityId,
    membershipId: request.actor.facility?.membershipId ?? '',
    correlationId: request.correlationId,
    purposeOfUse,
    authorization: request.header('authorization'),
    userCookie: request.header('cookie'),
    csrfToken: request.header('x-csrf-token'),
    origin: request.header('origin'),
    requestMethod: request.method,
  };
}
