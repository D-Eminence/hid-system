import type { JWTPayload } from 'jose';
import type { ActorContext, FacilityAssignment } from '../common/request-context';

export interface HidJwtClaims extends JWTPayload {
  actor_kind?: 'staff' | 'patient' | 'platform';
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
}

export interface LoginResult {
  actor: ActorContext;
  accessToken: string;
  csrfToken: string;
  refreshToken: string;
  expiresAt: Date;
  refreshExpiresAt: Date;
  /** End of the sign-in (platform sessions): no refresh extends a session past it. */
  absoluteExpiresAt?: Date;
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
 * Where the facility a staff session response reports comes from (0080):
 * 'selected', the facility this sign-in chose with POST /auth/facility;
 * 'default', none chosen, so the primary facility (else the first by name);
 * 'reselect', the chosen facility is no longer one of the actor's active
 * facilities, so the default is reported and the user must choose again.
 * Staff sign-ins only; patient and platform sessions carry no such field.
 */
export type FacilitySelectionState = 'selected' | 'default' | 'reselect';
