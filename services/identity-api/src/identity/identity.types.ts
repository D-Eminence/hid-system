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
  /** The active patient with this exact HID that the caller may read (row-level security), or null. */
  lookupExactHid(hid: string, context: DataAccessContext): Promise<IdentityPatient | null>;
  /**
   * For the audit of a refused lookup only: the active patient this exact HID
   * names, whether or not the caller may read it (0086). Never returned by the API.
   */
  lookupAuditSubject(hid: string, context: DataAccessContext): Promise<string | null>;
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
  consentStatus(patientId: string, purpose: PurposeOfUse, context: DataAccessContext): Promise<ConsentStatus>;
}

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');
