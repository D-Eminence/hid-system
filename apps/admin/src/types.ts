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
