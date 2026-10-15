import type { PoolClient } from 'pg';
import type { AuditEventInput } from '../../audit/audit.service';
import type { HidRequest } from '../../common/request-context';
import type { PatientEvidenceService } from './patient-evidence.service';
import type { PatientChatHistoryService } from './patient-chat-history.service';

/** Server-created access strategies; never deserialize one from a browser. */
export interface ChatAuthorization {
  patientId: string; accountId: string; subject: string;
  sessionId?: string; expiresAt?: string;
}
export interface EvidenceAccess {
  authorize(request: HidRequest): Promise<ChatAuthorization>;
  transaction<T>(authorization: ChatAuthorization, correlationId: string,
    operation: (client: PoolClient) => Promise<T>): Promise<T>;
}
export interface AttachmentAccess extends EvidenceAccess {
  query: string;
  table(kind: unknown): string;
}
export interface ChatAccess extends EvidenceAccess {
  admissionKey: string;
  chunksTable: 'ehr.patient_evidence_chunks' | 'ehr.staff_evidence_chunks';
  audit: Pick<AuditEventInput, 'actorType' | 'actorMembershipId' | 'facilityId' | 'organizationId' | 'purposeOfUse'>;
  evidence: Pick<PatientEvidenceService, 'snapshot' | 'assertCurrent' | 'prepareDocuments'>;
  history: Pick<PatientChatHistoryService, 'context' | 'save'> & {
    start(request: HidRequest, authorization: ChatAuthorization): Promise<string>;
  };
}
