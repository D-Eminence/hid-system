export const QOREID_PROVIDER = 'qoreid' as const;

// These are HID's stable, deliberately small result states. QoreID response
// payloads stay inside the adapter and are never returned or persisted.
export type VerificationState = 'verified' | 'not_verified' | 'incomplete';
export type EvidenceResult = VerificationState | 'provider_error' | 'disabled';
export type VerificationFailureCategory =
  | 'not_verified'
  | 'incomplete'
  | 'provider_authentication'
  | 'provider_unavailable'
  | 'timeout'
  | 'network'
  | 'malformed_response'
  | 'unexpected_response'
  | 'disabled';

export type OrganizationVerificationContext = 'hospital' | 'laboratory' | 'pharmacy';

export interface QoreIdNinClaims {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
}

export interface QoreIdNinBinding {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
}

/** Server-only registry identity for a new, still-pending patient enrollment. */
export interface QoreIdNinEnrollmentBinding extends QoreIdNinBinding {
  nin: string;
  gender: 'female' | 'male' | 'intersex' | 'other' | 'unknown';
  middleName?: string;
  phoneNumber?: string;
  photo?: string;
  address?: string;
  /** HID-normalized address components parsed from provider `nin.residence` only. */
  residence?: {
    address1: string;
    town?: string;
    lga?: string;
    state?: string;
  };
}

export interface QoreIdCacBinding {
  registrationNumber: string;
  companyName: string;
  entityType: string;
  registrationDate: string;
  address: string;
  registryStatus: string;
}

export interface QoreIdVerificationResult {
  provider: typeof QOREID_PROVIDER;
  state: VerificationState;
  // The documented provider transaction identifier is retained only when it
  // is a safe opaque scalar. It is not an identifier submitted by a user.
  providerReference?: string;
  respondedAt: string;
  // Registry fields are normalized and server-only. They must not be copied
  // into the public verification response or audit details.
  ninBinding?: QoreIdNinBinding;
  ninEnrollmentBinding?: QoreIdNinEnrollmentBinding;
  cacBinding?: QoreIdCacBinding;
}

export interface VerificationResponse {
  entityType: 'patient' | 'organization';
  verificationType: 'nin' | 'cac';
  provider: typeof QOREID_PROVIDER;
  state: EvidenceResult;
  providerReference?: string;
  recordedAt: string;
}
