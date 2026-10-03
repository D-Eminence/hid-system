import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { STORAGE_PROVIDER, type StorageProvider } from '../../storage/storage.types';
import { ClinicalRepository } from '../shared/clinical.repository';

interface Binding {
  file_id: string; patient_id: string; storage_bucket: string; storage_key: string;
  object_version_id: string; sha256_hex: string; size_bytes: string;
  file_name: string | null; result: string | null; detected_media_type: string | null;
}

@Injectable()
export class ImportedAttachmentService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityApiService,
    private readonly audit: AuditService, private readonly clinical: ClinicalRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  async self(fileId: string, request: HidRequest) {
    const actor = request.actor;
    if (actor?.kind !== 'patient' || !actor.patientId || !actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
    }
    const auth = await this.identity.authorizeSelf(request);
    if (auth.patientId !== actor.patientId || auth.accountId !== actor.accountId
      || auth.subject !== actor.subject || auth.sessionId !== actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient authorization changed');
    }
    const binding = await this.database.withPatientTransaction(auth, request.correlationId, async client => {
      const value = await this.read(client, auth.patientId, fileId);
      await this.audit.recordWithClient(client, { correlationId: request.correlationId, actorType: 'patient',
        actorSubject: actor.subject, actorAccountId: actor.accountId, patientId: actor.patientId,
        action: 'ehr.imported.attachment.download', resourceType: 'imported-attachment', resourceId: fileId,
        outcome: 'success', purposeOfUse: 'patient-self' });
      return value;
    });
    return this.sign(binding);
  }

  async staff(patientId: string, fileId: string, context: DataAccessContext) {
    const binding = await this.clinical.run(context, patientId, 'read_records', {
      action: 'ehr.imported.attachment.download', resourceType: 'imported-attachment', resourceId: fileId,
    }, async client => ({ value: await this.read(client, patientId, fileId) }));
    // The authorization/audit transaction must commit before issuing a bearer URL.
    return this.sign(binding);
  }

  private async read(client: PoolClient, patientId: string, fileId: string): Promise<Binding> {
    const result = await client.query<Binding>(`select b.*,f.source_payload->>'original_file_name' as file_name,
      s.result,s.detected_media_type from ehr.imported_medical_record_files f
      join ehr.imported_attachment_bindings b on b.file_id=f.id and b.patient_id=f.patient_id
      left join lateral(select result,detected_media_type from ehr.imported_attachment_scan_events
        where file_id=b.file_id and patient_id=b.patient_id and sha256_hex=b.sha256_hex
          and object_version_id=b.object_version_id order by sequence_id desc limit 1) s on true
      where f.id=$1 and f.patient_id=$2`, [fileId, patientId]);
    const binding = result.rows[0];
    if (!binding) throw new DomainProblem(404, 'ATTACHMENT_NOT_FOUND', 'Attachment is unavailable');
    if (binding.result !== 'clean' || !binding.detected_media_type) {
      throw new DomainProblem(409, 'ATTACHMENT_NOT_CLEARED', 'Attachment has not passed safety verification');
    }
    return binding;
  }

  private async sign(binding: Binding) {
    if (binding.storage_bucket !== this.storage.bucket()) throw new DomainProblem(409, 'ATTACHMENT_STORAGE_MISMATCH', 'Attachment storage is unavailable');
    const actual = await this.storage.inspectVersion(binding.storage_key, binding.object_version_id);
    if (actual.versionId !== binding.object_version_id || actual.sha256Hex !== binding.sha256_hex.trim()
      || actual.sizeBytes !== Number(binding.size_bytes)) {
      throw new DomainProblem(409, 'ATTACHMENT_INTEGRITY_MISMATCH', 'Attachment failed integrity verification');
    }
    const safeTypes = ['application/pdf','image/png','image/jpeg','text/plain'];
    const mediaType = safeTypes.includes(binding.detected_media_type ?? '') ? binding.detected_media_type! : 'application/octet-stream';
    return this.storage.createDownload(binding.storage_key, binding.object_version_id,
      { fileName: binding.file_name ?? 'attachment', mediaType });
  }
}
