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
  /**
   * Present only at a facility that signed itself up (P4b): 'pending' until
   * Health ID support reviews it, then 'reviewed'. Governed and legacy
   * facilities never carry it, so their session answers are unchanged.
   */
  selfService?: FacilitySelfService;
}

export interface FacilitySelfService {
  review: 'pending' | 'reviewed';
  organizationType: 'clinic' | 'hospital' | 'laboratory' | 'pharmacy' | 'other';
}

export interface ActorContext {
  kind?: 'staff' | 'patient';
  patientId?: string;
  id: string;
  subject: string;
  accountId: string;
  sessionId?: string;
  email?: string;
  displayName?: string;
  roles: readonly string[];
  permissions: readonly string[];
  platformRoles?: readonly string[];
  platformPermissions?: readonly string[];
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
  /**
   * The browser read (GET, HEAD or OPTIONS) an authenticated workload reported
   * on a @DelegatedBrowserRequest route. Set only when the guard skipped the
   * cookie-write Origin and CSRF check for that reason.
   */
  delegatedBrowserMethod?: string;
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
}

/** Administration authority has no implied facility or clinical membership. */
export interface PlatformAdminContext extends Omit<DataAccessContext, 'facilityId' | 'membershipId'> {
  facilityId?: string;
  membershipId?: string;
}

export function requireRequestContext(request: HidRequest, suppliedPurpose?: string): DataAccessContext {
  if (!request.actor || !request.facilityId || !request.correlationId) {
    throw new Error('Request context was not established by security guards');
  }
  // Consent and audit routes check their purpose first and most routes supply a
  // validated body purpose; the registration-case read takes it from the
  // header, which the guard does not check, so a missing or unknown one is the
  // client's.
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
  };
}
