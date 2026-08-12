import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityApiService } from '../integrations/identity-api.service';
import type { StorageProvider } from '../storage/storage.types';
import { STORAGE_PROVIDER } from '../storage/storage.types';
import type { CreateDocumentUploadDto } from './dto/create-document-upload.dto';
import type { DocumentScanEventDto } from './dto/document-scan-event.dto';

interface WorkloadActor {
  subject: string;
  accountId: string;
}

interface DocumentRow {
  id: string;
  patient_id: string;
  facility_id: string;
  storage_bucket: string;
  storage_key: string;
  object_version_id: string | null;
  declared_media_type: string;
  size_bytes: string | null;
  sha256_hex: string | null;
  status: string;
  row_version: string;
  scan_status: string | null;
  detected_media_type: string | null;
}

interface IdempotencyRow {
  state: 'processing' | 'completed' | 'failed';
  request_sha256: string;
  result_resource_id: string | null;
}

@Injectable()
export class DocumentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly identity: IdentityApiService,
    private readonly audit: AuditService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  async createUploadIntent(input: CreateDocumentUploadDto, idempotencyKey: string, context: DataAccessContext) {
    this.validateIdempotencyKey(idempotencyKey);
    const authorization = await this.identity.authorize(input.patientId, 'write_records', context.purposeOfUse, context);
    if (!authorization.allowed) throw new ForbiddenException('Patient write access is not authorized');

    const requestHash = this.hash(JSON.stringify({
      patientId: input.patientId,
      encounterId: input.encounterId ?? null,
      fileName: input.fileName,
      mediaType: input.mediaType,
      sizeBytes: input.sizeBytes,
      sha256Hex: input.sha256Hex,
      classification: input.classification,
      retentionClass: input.retentionClass,
    }));
    const document = await this.database.withTransaction(context, async (client) => {
      const existing = await this.claimIdempotency(client, input.patientId, idempotencyKey, requestHash, context);
      if (existing?.state === 'completed' && existing.result_resource_id) {
        return this.findById(client, existing.result_resource_id, context.facilityId);
      }
      if (existing) throw new ConflictException('An identical request is already being processed');

      const documentId = randomUUID();
      const storageKey = `objects/${randomUUID()}`;
      const result = await client.query<DocumentRow>(
        `insert into ehr.documents (
           id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
           original_file_name, storage_bucket, storage_key, declared_media_type,
           size_bytes, sha256_hex, classification, status, retention_class
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'initiated', $14)
         returning id::text, patient_id::text, facility_id::text, storage_bucket, storage_key,
                   object_version_id, declared_media_type, null::text as detected_media_type,
                   size_bytes::text, sha256_hex, null::text as scan_status, status, row_version::text`,
        [
          documentId,
          input.encounterId ?? null,
          input.patientId,
          context.facilityId,
          context.actor.accountId,
          context.membershipId,
          input.fileName,
          this.storage.bucket(),
          storageKey,
          input.mediaType,
          input.sizeBytes,
          input.sha256Hex,
          input.classification,
          input.retentionClass,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Document insert did not return a row');
      await client.query(`select set_config('app.change_reason', 'idempotency completed', true)`);
      await client.query(
        `update ehr.idempotency_keys
            set state = 'completed', result_resource_type = 'document',
                result_resource_id = $5, response_status = 201
          where facility_id = $1 and created_by = $2 and operation = 'document.upload-intent'
            and idempotency_key = $3 and request_sha256 = $4`,
        [context.facilityId, context.actor.accountId, idempotencyKey, requestHash, row.id],
      );
      await this.audit.recordWithClient(client, this.auditEvent(
        context, 'ehr.document.upload-intent.create', 'success', input.patientId, row.id,
      ));
      return row;
    });

    const upload = await this.storage.createUpload({
      key: document.storage_key,
      mediaType: document.declared_media_type,
      sizeBytes: Number(document.size_bytes),
      sha256Hex: document.sha256_hex ?? input.sha256Hex,
      expiresInSeconds: 300,
    });
    return { document: this.view(document), upload };
  }

  async list(patientId: string, encounterId: string, context: DataAccessContext) {
    const authorization = await this.identity.authorize(patientId, 'read_records', context.purposeOfUse, context);
    if (!authorization.allowed) throw new ForbiddenException('Patient read access is not authorized');
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query(
        `select document.id::text as "id", document.patient_id::text as "patientId",
                document.encounter_id::text as "encounterId", document.original_file_name as "fileName",
                coalesce(scan.detected_media_type, document.declared_media_type) as "mediaType",
                document.size_bytes::text as "sizeBytes",
                case when document.status='uploaded' and scan.event_type='clean' then 'available'
                     when scan.event_type='rejected' then 'rejected' else document.status end as status,
                coalesce(scan.event_type, 'pending') as "scanStatus", document.row_version::text as "version",
                document.created_at as "createdAt"
           from ehr.documents document
           left join lateral (select event_type, detected_media_type
             from ehr.document_scan_events where document_id=document.id
             order by created_at desc,id desc limit 1) scan on true
          where document.patient_id=$1 and document.encounter_id=$2 and document.facility_id=$3
          order by document.created_at desc,document.id desc`,
        [patientId, encounterId, context.facilityId],
      );
      await this.audit.recordWithClient(client, this.auditEvent(
        context, 'ehr.document.list', 'success', patientId, encounterId,
      ));
      return { items: result.rows };
    });
  }

  async getOcrSource(documentId: string, context: DataAccessContext) {
    const document = await this.database.withTransaction(
      context,
      (client) => this.findById(client, documentId, context.facilityId),
      { readOnly: true },
    );
    const authorization = await this.identity.authorize(
      document.patient_id, 'read_records', context.purposeOfUse, context,
    );
    if (!authorization.allowed) throw new ForbiddenException('Patient read access is not authorized');
    await this.audit.record(this.auditEvent(
      context, 'ehr.document.ocr-source.read', 'success', document.patient_id, document.id,
    ));
    return {
      id: document.id,
      patientId: document.patient_id,
      facilityId: document.facility_id,
      objectVersionId: document.object_version_id,
      sha256Hex: document.sha256_hex,
      status: document.status,
      scanStatus: document.scan_status ?? 'pending',
    };
  }

  async complete(documentId: string, context: DataAccessContext) {
    const initial = await this.database.withTransaction(
      context,
      (client) => this.findById(client, documentId, context.facilityId),
      { readOnly: true },
    );
    const authorization = await this.identity.authorize(initial.patient_id, 'write_records', context.purposeOfUse, context);
    if (!authorization.allowed) throw new ForbiddenException('Patient write access is not authorized');
    const metadata = await this.storage.inspect(initial.storage_key);
    if (metadata.sizeBytes !== Number(initial.size_bytes)
      || metadata.sha256Hex !== initial.sha256_hex
      || metadata.mediaType !== initial.declared_media_type) {
      throw new ConflictException('Uploaded object does not match the declared content metadata');
    }

    return this.database.withTransaction(context, async (client) => {
      await client.query(`select set_config('app.change_reason', 'verified S3 upload completion', true)`);
      const result = await client.query<DocumentRow>(
        `update ehr.documents
            set object_version_id = $3,
                size_bytes = $4, sha256_hex = $5, status = 'uploaded'
          where id = $1 and facility_id = $2 and status = 'initiated'
          returning id::text, patient_id::text, facility_id::text, storage_bucket, storage_key,
                    object_version_id, declared_media_type, null::text as detected_media_type,
                    size_bytes::text, sha256_hex, null::text as scan_status, status, row_version::text`,
        [documentId, context.facilityId, metadata.versionId, metadata.sizeBytes, metadata.sha256Hex],
      );
      const row = result.rows[0];
      if (!row) {
        const current = await this.findById(client, documentId, context.facilityId);
        if (current.status === 'uploaded' && current.object_version_id === metadata.versionId) return this.view(current);
        throw new ConflictException('Document is not in an upload-completable state');
      }
      await this.audit.recordWithClient(client, this.auditEvent(
        context, 'ehr.document.upload.complete', 'success', row.patient_id, row.id,
      ));
      return this.view(row);
    });
  }

  async createDownload(documentId: string, context: DataAccessContext) {
    const document = await this.database.withTransaction(
      context,
      (client) => this.findById(client, documentId, context.facilityId),
      { readOnly: true },
    );
    const authorization = await this.identity.authorize(document.patient_id, 'read_records', context.purposeOfUse, context);
    if (!authorization.allowed) throw new ForbiddenException('Patient read access is not authorized');
    if (document.status !== 'available' || document.scan_status !== 'clean' || !document.object_version_id) {
      throw new ConflictException('Document is not available for download');
    }
    const download = await this.storage.createDownload(document.storage_key, document.object_version_id);
    await this.audit.record(this.auditEvent(
      context, 'ehr.document.download', 'success', document.patient_id, document.id,
    ));
    return download;
  }

  async recordScan(input: DocumentScanEventDto, actor: WorkloadActor, correlationId: string) {
    return this.database.withWorkloadTransaction(actor.subject, correlationId, async (client) => {
      const result = await client.query<{ event_id: string }>(
        `select ehr.append_document_scan_event(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
         )::text as event_id`,
        [
          input.documentId,
          input.objectVersionId,
          input.objectSha256Hex,
          input.eventType,
          input.detectedMediaType ?? null,
          input.scannerEngine,
          input.scannerVersion,
          input.reasonCode ?? null,
          input.idempotencyKey,
          correlationId,
        ],
      );
      const event = result.rows[0];
      if (!event) throw new Error('Document scan event insert did not return a row');
      return { eventId: event.event_id };
    });
  }

  private async claimIdempotency(
    client: PoolClient,
    patientId: string,
    key: string,
    requestHash: string,
    context: DataAccessContext,
  ): Promise<IdempotencyRow | null> {
    const inserted = await client.query(
      `insert into ehr.idempotency_keys (
         facility_id, patient_id, created_by, created_by_membership_id,
         idempotency_key, operation, request_sha256, locked_until, expires_at
       ) values ($1, $2, $3, $4, $5, 'document.upload-intent', $6,
                 clock_timestamp() + interval '30 seconds', clock_timestamp() + interval '24 hours')
       on conflict (facility_id, created_by, operation, idempotency_key) do nothing
       returning id`,
      [context.facilityId, patientId, context.actor.accountId, context.membershipId, key, requestHash],
    );
    if (inserted.rowCount === 1) return null;
    const existing = await client.query<IdempotencyRow>(
      `select state, request_sha256, result_resource_id
         from ehr.idempotency_keys
        where facility_id = $1 and created_by = $2
          and operation = 'document.upload-intent' and idempotency_key = $3
        for update`,
      [context.facilityId, context.actor.accountId, key],
    );
    const row = existing.rows[0];
    if (!row || row.request_sha256 !== requestHash) {
      throw new ConflictException('Idempotency key was already used for a different request');
    }
    return row;
  }

  private async findById(client: PoolClient, documentId: string, facilityId: string): Promise<DocumentRow> {
    const result = await client.query<DocumentRow>(
      `select id::text, patient_id::text, facility_id::text, storage_bucket, storage_key,
              object_version_id, declared_media_type, detected_media_type,
              size_bytes::text, sha256_hex, scan_status, status, row_version::text
         from ehr.documents_effective where id = $1 and facility_id = $2`,
      [documentId, facilityId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Document not found');
    return row;
  }

  private view(row: DocumentRow) {
    return {
      id: row.id,
      patientId: row.patient_id,
      facilityId: row.facility_id,
      mediaType: row.detected_media_type ?? row.declared_media_type,
      sizeBytes: row.size_bytes ? Number(row.size_bytes) : null,
      scanStatus: row.scan_status ?? 'pending',
      status: row.status,
      version: Number(row.row_version),
    };
  }

  private auditEvent(
    context: DataAccessContext,
    action: string,
    outcome: 'success' | 'denied' | 'failure',
    patientId: string,
    resourceId: string,
  ) {
    return {
      correlationId: context.correlationId,
      actorType: 'staff' as const,
      actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId,
      actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId,
      facilityId: context.facilityId,
      patientId,
      action,
      resourceType: 'document',
      resourceId,
      outcome,
      purposeOfUse: context.purposeOfUse,
    };
  }

  private validateIdempotencyKey(key: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key)) {
      throw new ConflictException('A valid Idempotency-Key header is required');
    }
  }

  private hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }
}
