import type { JWTPayload } from 'jose';
import type { ActorContext, FacilityAssignment } from '../common/request-context';
import type { StaffProduct } from './product-gate';

export interface HidJwtClaims extends JWTPayload {
  actor_kind?: 'staff' | 'patient';
  patient_id?: string;
  sub: string;
  sid: string;
  email?: string;
  name?: string;
  roles: string[];
  permissions: string[];
  platform_roles: string[];
  platform_permissions: string[];
  facility_ids: string[];
  auth_method: 'local' | 'oidc';
  csrf_hash?: string;
  token_version: number;
  /** The staff product site the session was issued or refreshed on (Q88-1); absent elsewhere. */
  product?: StaffProduct;
}

export interface LoginResult {
  actor: ActorContext;
  accessToken: string;
  csrfToken: string;
  refreshToken: string;
  expiresAt: Date;
  refreshExpiresAt: Date;
}

export interface CredentialIdentity {
  actorKind?: 'staff' | 'patient';
  subject: string;
  accountId?: string;
  email?: string;
  displayName: string;
  facilities: FacilityAssignment[];
  authenticationMethod: ActorContext['authenticationMethod'];
  passwordUpgrade?: {
    hash: string;
    expectedRowVersion: number;
  };
}

/**
 * Where the facility a staff session answer reports comes from (0129, with
 * STAFF_FACILITY_SELECTION_MODE keep or ask; never sent while it is off):
 * - 'selected': the facility this sign-in chose with POST /auth/facility, still
 *   one of the actor's facilities on the session's own site;
 * - 'default': no choice yet, so the primary facility (else the first by
 *   name); answered only in 'ask', where 'keep' leaves the field out;
 * - 'reselect': the chosen facility is no longer one of the actor's (the
 *   membership ended or is held, the facility closed, or it no longer fits the
 *   site), so the default is reported and the user must choose again;
 * - 'unavailable': the choice could not be read, so the default is reported
 *   and it is not a choice: the website asks where the user is working.
 * Staff sign-ins with a facility only; patients, account-only sessions, OIDC
 * bearer callers and service-session carry no such field.
 */
export type FacilitySelectionState = 'selected' | 'default' | 'reselect' | 'unavailable';
