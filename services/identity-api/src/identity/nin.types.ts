export interface NinClaimedDemographics {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender?: string;
}

export interface NinVerificationRequest {
  nin: string;
  claimedDemographics: NinClaimedDemographics;
  correlationId: string;
}

export interface NinVerificationResult {
  verified: boolean;
  provider: string;
  reference: string;
  verifiedAt: string;
  demographics: NinClaimedDemographics;
}

export interface NinVerificationProvider {
  readonly name: string;
  verify(request: NinVerificationRequest): Promise<NinVerificationResult>;
}

export const NIN_VERIFICATION_PROVIDER = Symbol('NIN_VERIFICATION_PROVIDER');
