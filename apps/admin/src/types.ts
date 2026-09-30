export interface AdminActor {
  accountId: string;
  subject: string;
  displayName: string | null;
  email: string | null;
  platformRoles: string[];
  platformPermissions: string[];
}

export interface AdminSession { actor: AdminActor }
export interface Page<T> { items: T[]; page: number; pageSize: number; total: number }

export interface Facility {
  id: string; organizationId: string; organizationName: string; name: string; code: string;
  status: 'pending' | 'verified' | 'rejected' | 'suspended'; version: number;
  statusReason: string | null; statusChangedAt: string | null; createdAt: string; membershipCount: number;
}

export interface Principal {
  id: string; subject: string; email: string | null; displayName: string | null;
  status: string; version: number; createdAt: string; activeSessionCount: number;
  memberships: Array<{ id: string; facilityId: string; facilityName: string; role: string; appRole: string; active: boolean; version: number }>;
  platformRoles: string[];
}

export interface IdentityReview {
  id: string; facilityId: string; facilityName: string; status: string; maskedNin: string;
  provider: string; candidateCount: number; version: number; createdAt: string; updatedAt: string;
}

export interface OrganizationApplication {
  applicationId: string;
  productCode: 'ehr' | 'migrate' | 'laboratory' | 'pharmacy';
  organizationName: string;
  organizationType: string;
  cacHint: string;
  administratorName: string;
  administratorEmail: string;
  status: 'pending_verification' | 'ready_for_review' | 'approved' | 'rejected';
  verificationResult: 'verified' | 'not_verified' | 'incomplete' | 'provider_error' | 'disabled' | null;
  verifiedOrganizationName: string | null;
  version: number;
  createdAt: string;
  verifiedAt: string | null;
  reviewedAt: string | null;
}

export interface AuditEvent {
  sequenceId: string; eventId: string; occurredAt: string; correlationId: string;
  actorType: string; actorSubject: string | null; facilityId: string | null;
  action: string; outcome: string; resourceType: string | null; resourceId: string | null;
  purposeOfUse: string | null; reason: string | null; sourceSystem: string | null;
}

export interface ServiceState {
  service: string; live: boolean | null; ready: boolean | null;
  state: string; checkedAt: string; code: string | null;
}

export interface EventFailure {
  eventId: string; eventType: string; producer: string; attemptCount: number;
  errorCode: string; errorSummary: string; failedAt: string; nextAttemptAt: string; correlationId: string;
}

export type IntegrationHealth = 'healthy' | 'degraded' | 'failed' | 'unknown';
export type IntegrationSetting = string | number | boolean | null;

export interface ProviderIntegration {
  provider: string;
  name: string;
  capabilities: string[];
  enabled: boolean;
  health: IntegrationHealth;
  activeCapabilities: string[];
  version: number;
  configuration: Record<string, IntegrationSetting>;
  credential: {
    state: 'configured' | 'missing' | 'external' | 'unsupported';
    masked: string | null;
    rotationSupported: boolean;
  };
  lastTestedAt: string | null;
  lastSuccessfulTestAt: string | null;
  lastFailedTestAt: string | null;
  availableActions: string[];
}

export interface CapabilityRouting {
  capability: string;
  activeProvider: string | null;
  fallbackProvider: string | null;
  eligibleProviders: string[];
  version: number;
}

export interface IntegrationCatalog {
  items: ProviderIntegration[];
  capabilities: CapabilityRouting[];
}

export interface IntegrationAuditEvent {
  eventId: string;
  action: string;
  occurredAt: string;
  actorSubject: string | null;
  actorAccountId: string;
  correlationId: string;
  capability: string | null;
  reason: string | null;
  outcome: string;
}
