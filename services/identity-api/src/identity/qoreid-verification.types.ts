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

export interface QoreIdVerificationResult {
  provider: typeof QOREID_PROVIDER;
  state: VerificationState;
  // The documented provider transaction identifier is retained only when it
  // is a safe opaque scalar. It is not an identifier submitted by a user.
  providerReference?: string;
  respondedAt: string;
}

export interface VerificationResponse {
  entityType: 'patient' | 'organization';
  verificationType: 'nin' | 'cac';
  provider: typeof QOREID_PROVIDER;
  state: EvidenceResult;
  providerReference?: string;
  recordedAt: string;
}
