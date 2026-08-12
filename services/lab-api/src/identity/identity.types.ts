import type { DataAccessContext, PurposeOfUse } from '../common/request-context';

export type RecordAccessScope = 'read_records' | 'write_records';

export interface IdentityPatient {
  id: string;
  hidCode: string;
  firstName: string;
  lastName: string;
  fullName: string;
  dateOfBirth: string | null;
  gender: string | null;
  rowVersion: number;
}

export interface AuthorizationRequest {
  patientId: string;
  scope: RecordAccessScope;
  purpose: PurposeOfUse;
  context: DataAccessContext;
}

export interface AuthorizationDecision {
  allowed: boolean;
  patientId: string;
  facilityId: string;
  membershipId: string;
  scope: RecordAccessScope;
  purpose: PurposeOfUse;
  consentGrantId?: string;
  expiresAt?: string;
  breakGlass: boolean;
}

export interface ConsentStatus {
  patientId: string;
  facilityId: string;
  purpose: PurposeOfUse;
  readAllowed: boolean;
  writeAllowed: boolean;
  expiresAt?: string;
}

export interface IdentityProvider {
  lookupExactHid(hid: string, context: DataAccessContext): Promise<IdentityPatient | null>;
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
  consentStatus(patientId: string, purpose: PurposeOfUse, context: DataAccessContext): Promise<ConsentStatus>;
}

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');
