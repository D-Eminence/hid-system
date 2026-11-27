import type { Request } from 'express';
import type { StaffProduct } from '../auth/product-gate';
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
  /**
   * The recorded kinds of the facility's organisation (0126,
   * identity.organization_staff_kinds), present only when at least one is
   * recorded. The product gate reads them for an administrator (owner
   * decisions Q90 and Q91): no kind, or a hospital or clinic kind, is a
   * hospital.
   */
  organizationKinds?: readonly OrganizationKind[];
  /**
   * The products the facility's organisation holds (its active
   * identity.organization_products rows, 0126), present only with
   * organizationKinds and when at least one is held. The product gate admits
   * the administrator of an organisation that is not a hospital on each held
   * product's site as well as on its kinds' sites.
   */
  organizationProducts?: readonly OrganizationProduct[];
}

/** An organisation's effective kind as identity.organization_staff_kinds answers it ('other' already applied). */
export type OrganizationKind = 'clinic' | 'hospital' | 'laboratory' | 'pharmacy';

/** A product code an organisation holds (identity.organization_products.product_code). */
export type OrganizationProduct = 'ehr' | 'migrate' | 'laboratory' | 'pharmacy';

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
  /**
   * A verified staff login with no facility membership yet, signed in on
   * outreach. (Q88-2): no facility, no permission. The security guard lets it
   * reach only the routes marked @AccountOnlyAllowed ("Start an outreach
   * group" and the session routes it needs) and answers every other route
   * 403 NO_ACTIVE_FACILITY_MEMBERSHIP.
   */
  accountOnly?: true;
  /**
   * Staff sessions only: the staff product sites this login can open (Q97),
   * in the order ehr, lab, pharmacy, migrate, outreach. Read from every
   * active membership by the product gate's own rule, whatever site the
   * session was issued on; 'outreach' alone for an account-only session; empty
   * for a platform administrator with no membership. The website shows only
   * these sites.
   */
  products?: readonly StaffProduct[];
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

/**
 * A staff member acting on their own account (SX-7's preferences and
 * shortcuts; SX-6's own profile later): no purpose of use, and a facility
 * only when the request resolved one (X-Facility-ID on a facility-optional
 * route, or the facility a facility-required route needs). Unlike
 * DataAccessContext it may carry no facility, so a platform administrator
 * with no membership can act on their own account.
 */
export interface StaffAccountContext {
  correlationId: string;
  actor: ActorContext;
  facilityId?: string;
  membershipId?: string;
}

/**
 * The context of a staff member's own-account route. Staff sessions only (a
 * patient is refused by the guard before; refused here again); the facility
 * and membership are the ones the guard resolved, or none.
 */
export function requireStaffAccountContext(request: HidRequest): StaffAccountContext {
  if (!request.actor || !request.correlationId) {
    throw new Error('Request context was not established by security guards');
  }
  if (request.actor.kind === 'patient') {
    throw new DomainProblem(403, 'PATIENT_SCOPE_DENIED', 'This operation requires workforce authorization');
  }
  const membershipId = request.facilityId && request.actor.facility?.id === request.facilityId
    ? request.actor.facility.membershipId : undefined;
  return {
    correlationId: request.correlationId,
    actor: request.actor,
    ...(request.facilityId && membershipId ? { facilityId: request.facilityId, membershipId } : {}),
  };
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
