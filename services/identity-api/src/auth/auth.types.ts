import type { JWTPayload } from 'jose';
import type { ActorContext, FacilityAssignment } from '../common/request-context';
import type { DeviceTrust, SignInVia } from './outreach-volunteer';

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
}

export interface LoginResult {
  actor: ActorContext;
  accessToken: string;
  csrfToken: string;
  refreshToken: string;
  expiresAt: Date;
  refreshExpiresAt: Date;
  /** True when this session has the long outreach volunteer lifetimes ("own phone"). */
  longVolunteerSession?: boolean;
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
  /**
   * A password-free outreach volunteer sign-in only: 'own_device' asks for
   * the long volunteer session (granted only while
   * OUTREACH_VOLUNTEER_LONG_SESSION_ENABLED is on and the login is
   * volunteer-only); 'standard' keeps today's lifetimes.
   */
  deviceTrust?: DeviceTrust;
  /** A password-free sign-in only: how it was made, for the session event and the audit. */
  signInVia?: SignInVia;
}
