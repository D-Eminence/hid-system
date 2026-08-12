import type { JWTPayload } from 'jose';
import type { ActorContext, FacilityAssignment } from '../common/request-context';

export interface HidJwtClaims extends JWTPayload {
  sub: string;
  sid: string;
  email?: string;
  name?: string;
  roles: string[];
  permissions: string[];
  platform_roles: string[];
  platform_permissions: string[];
  facility_ids: string[];
  auth_method: 'local';
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
}

export interface CredentialIdentity {
  subject: string;
  accountId?: string;
  email: string;
  displayName: string;
  facilities: FacilityAssignment[];
  authenticationMethod: ActorContext['authenticationMethod'];
  passwordUpgrade?: {
    hash: string;
    expectedRowVersion: number;
  };
}
