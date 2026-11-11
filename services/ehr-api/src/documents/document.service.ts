import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import { offlineAuditDetails, type DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityApiService } from '../integrations/identity-api.service';
import type { StorageProvider } from '../storage/storage.types';
import { STORAGE_PROVIDER } from '../storage/storage.types';
import type { CreateDocumentUploadDto } from './dto/create-document-upload.dto';
import type { DocumentScanEventDto } from './dto/document-scan-event.dto';
import type { ListScanTargetsDto } from './dto/list-scan-targets.dto';
import type { ResolveScanTargetDto } from './dto/resolve-scan-target.dto';
import { downloadFileName, isSupportedDocumentMediaType, SNIFF_PREFIX_BYTES, sniffMediaType } from './media-sniff';
import { scanRefusalProblem } from './scan-errors';

interface WorkloadActor {
  subject: string;
  accountId: string;
}

interface DocumentRow {
  id: string;
  patient_id: string;
  facility_id: string;
  created_by: string;
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
  original_file_name?: string;
}

/** A row of ehr.resolve_document_scan_target (0105): no patient or facility ID. */
interface ScanTargetRow {
  document_id: string;
  object_version_id: string;
  sha256_hex: string;
  status: string;
  declared_media_type: string;
  latest_event_type: string | null;
}

/** A row of ehr.list_documents_awaiting_scan (0105): no patient or facility ID. */
interface AwaitingScanRow {
  document_id: string;
  storage_bucket: string;
  storage_key: string;
  object_version_id: string;
  sha256_hex: string;
  declared_media_type: string;
  updated_at: Date;
  latest_event_type: string | null;
  scan_started_count: number;
  last_scan_started_at: Date | null;
}

/**
 * The bytes check behind a resolve: 'supported' when the first bytes are one of
 * the four allowed types (sniffedMediaType names it), 'unsupported' when they
 * were read and are none of them, 'unavailable' when they could not be read
 * (the bridge retries; it never refuses a document on this one).
 */
export type SniffResult = 'supported' | 'unsupported' | 'unavailable';

interface IdempotencyRow {
  state: 'processing' | 'completed' | 'failed';
  request_sha256: string;
  result_resource_id: string | null;
}

/** ehr.documents.status while the OCR worker deletes the stored source, and once it did (migration 0112). */
export const SOURCE_DELETION_STATUSES: ReadonlySet<string> = new Set(['source_deleting', 'source_deleted']);

/** 410 for a document whose source the OCR worker deleted after 24 hours. */
export function sourceDeletedProblem(): DomainProblem {
  return new DomainProblem(410, 'DOCUMENT_SOURCE_DELETED', 'Source page deleted after 24 hours');
}

/** Statuses of ehr.documents_effective reached only through a completed upload. */
const COMPLETED_STATUSES = new Set(['uploaded', 'available', 'rejected']);

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
    await this.requirePlatformControl('uploads_enabled');
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
      // Clinical objects live under a non-expiring lifecycle prefix. The
      // version ID captured after upload remains the immutable OCR boundary.
      const storageKey = `clinical/objects/${randomUUID()}`;
      const result = await client.query<DocumentRow>(
        `insert into ehr.documents (
           id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
           original_file_name, storage_bucket, storage_key, declared_media_type,
           size_bytes, sha256_hex, classification, status, retention_class
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'initiated', $14)
         returning id::text, patient_id::text, facility_id::text, created_by::text, storage_bucket, storage_key,
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
      // ehr.documents_effective counts only scans bound to the document's
      // version and SHA-256, as download and OCR do; the media type is the one
      // the scan detected (owner decision D3) once there is one.
      const result = await client.query(
        `select document.id::text as "id", document.patient_id::text as "patientId",
                document.encounter_id::text as "encounterId", document.original_file_name as "fileName",
                coalesce(document.detected_media_type, document.declared_media_type) as "mediaType",
                document.size_bytes::text as "sizeBytes", document.status,
                document.scan_status as "scanStatus", document.row_version::text as "version",
                document.created_at as "createdAt"
           from ehr.documents_effective document
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
      // The type the scan detected (D3), never the declared one; null until a
      // scan has detected one.
      mediaType: document.detected_media_type,
    };
  }

  async complete(documentId: string, context: DataAccessContext) {
    const initial = await this.database.withTransaction(
      context,
      (client) => this.findById(client, documentId, context.facilityId),
      { readOnly: true },
    );
    this.assertUploader(initial, context);
    const authorization = await this.identity.authorize(initial.patient_id, 'write_records', context.purposeOfUse, context);
    if (!authorization.allowed) throw new ForbiddenException('Patient write access is not authorized');
    // A replayed complete (offline contract A8.6) is answered from the row
    // after the same uploader, facility and write checks; the object is
    // already bound, so storage is not inspected again.
    const replay = initial.status !== 'initiated';
    const metadata = replay ? undefined : await this.storage.inspect(initial.storage_key);
    if (metadata && (metadata.sizeBytes !== Number(initial.size_bytes)
      || metadata.sha256Hex !== initial.sha256_hex
      || metadata.mediaType !== initial.declared_media_type)) {
      throw new ConflictException('Uploaded object does not match the declared content metadata');
    }

    return this.database.withTransaction(context, async (client) => {
      if (metadata) {
        await client.query(`select set_config('app.change_reason', 'verified S3 upload completion', true)`);
        const result = await client.query<DocumentRow>(
          `update ehr.documents
              set object_version_id = $3,
                  size_bytes = $4, sha256_hex = $5, status = 'uploaded'
            where id = $1 and facility_id = $2 and status = 'initiated' and created_by = $6
            returning id::text, patient_id::text, facility_id::text, created_by::text, storage_bucket, storage_key,
                      object_version_id, declared_media_type, null::text as detected_media_type,
                      size_bytes::text, sha256_hex, null::text as scan_status, status, row_version::text`,
          [documentId, context.facilityId, metadata.versionId, metadata.sizeBytes, metadata.sha256Hex,
            context.actor.accountId],
        );
        const row = result.rows[0];
        if (row) {
          await this.audit.recordWithClient(client, this.auditEvent(
            context, 'ehr.document.upload.complete', 'success', row.patient_id, row.id,
          ));
          return this.view(row);
        }
      }
      // Already completed, by an earlier call or a concurrent one: no write and
      // no second audit event. The answer is the document as it is now.
      const current = await this.findById(client, documentId, context.facilityId);
      this.assertUploader(current, context);
      if (COMPLETED_STATUSES.has(current.status) && current.object_version_id
        && (!metadata || current.object_version_id === metadata.versionId)) return this.view(current);
      throw new DomainProblem(409, 'INVALID_DOCUMENT_TRANSITION', 'Document is not in an upload-completable state');
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
    // The OCR worker deletes (source_deleting) or deleted (source_deleted) every stored version 24 hours after the
    // document's OCR jobs finished (migration 0112, owner decision of 2026-11-11); nothing is served. Answered only
    // after the read check, as the 409 below.
    if (SOURCE_DELETION_STATUSES.has(document.status)) throw sourceDeletedProblem();
    if (document.status !== 'available' || document.scan_status !== 'clean' || !document.object_version_id
      || !isSupportedDocumentMediaType(document.detected_media_type)) {
      throw new ConflictException('Document is not available for download');
    }
    // Served as the type the scan detected (D3), not the declared one, shown in
    // the browser tab under a name whose extension matches it.
    const download = await this.storage.createDownload(document.storage_key, document.object_version_id, {
      fileName: downloadFileName(document.original_file_name ?? 'document', document.detected_media_type),
      mediaType: document.detected_media_type,
      disposition: 'inline',
    });
    await this.audit.record(this.auditEvent(
      context, 'ehr.document.download', 'success', document.patient_id, document.id,
    ));
    return download;
  }

  async recordScan(input: DocumentScanEventDto, actor: WorkloadActor, correlationId: string) {
    return this.scannerTransaction(actor, correlationId, async (client) => {
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

  /**
   * From the S3 object a GuardDuty result names to its document (0105), then,
   * outside the database transaction, the first 1 KB of that exact version to
   * learn its real type. Refusals answer 404 or 409 (scan-errors.ts); the
   * bucket must be this service's own.
   */
  async resolveScanTarget(input: ResolveScanTargetDto, actor: WorkloadActor, correlationId: string) {
    if (input.storageBucket !== this.storage.bucket()) {
      throw new DomainProblem(404, 'DOCUMENT_NOT_FOUND', 'No document holds this object');
    }
    const target = await this.scannerTransaction(actor, correlationId, async (client) => {
      const result = await client.query<ScanTargetRow>(
        `select document_id::text as document_id, object_version_id, sha256_hex, status, declared_media_type,
                latest_event_type
           from ehr.resolve_document_scan_target($1, $2, $3, $4)`,
        [input.storageBucket, input.storageKey, input.objectVersionId, correlationId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Document scan target resolution did not return a row');
      return row;
    });
    let sniffedMediaType: string | null = null;
    let sniffResult: SniffResult;
    try {
      sniffedMediaType = sniffMediaType(
        await this.storage.readPrefix(input.storageKey, target.object_version_id, SNIFF_PREFIX_BYTES),
      );
      sniffResult = sniffedMediaType ? 'supported' : 'unsupported';
    } catch {
      sniffResult = 'unavailable';
    }
    return {
      documentId: target.document_id,
      objectVersionId: target.object_version_id,
      sha256Hex: target.sha256_hex,
      status: target.status,
      declaredMediaType: target.declared_media_type,
      latestEventType: target.latest_event_type,
      sniffResult,
      sniffedMediaType,
    };
  }

  /** The reconcile and backfill work list (0105), oldest first. */
  async listScanTargets(query: ListScanTargetsDto, actor: WorkloadActor, correlationId: string) {
    return this.scannerTransaction(actor, correlationId, async (client) => {
      const result = await client.query<AwaitingScanRow>(
        `select document_id::text as document_id, storage_bucket, storage_key, object_version_id, sha256_hex,
                declared_media_type, updated_at, latest_event_type, scan_started_count, last_scan_started_at
           from ehr.list_documents_awaiting_scan($1, $2, $3)`,
        [query.olderThanSeconds, query.limit, correlationId],
      );
      return {
        items: result.rows.map(row => ({
          documentId: row.document_id,
          storageBucket: row.storage_bucket,
          storageKey: row.storage_key,
          objectVersionId: row.object_version_id,
          sha256Hex: row.sha256_hex,
          declaredMediaType: row.declared_media_type,
          updatedAt: new Date(row.updated_at).toISOString(),
          latestEventType: row.latest_event_type,
          scanStartedCount: Number(row.scan_started_count),
          lastScanStartedAt: row.last_scan_started_at ? new Date(row.last_scan_started_at).toISOString() : null,
        })),
      };
    });
  }

  /** The isolated scanner pool, with the scanner commands' refusals mapped to 4xx. */
  private async scannerTransaction<Result>(
    actor: WorkloadActor,
    correlationId: string,
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    try {
      return await this.database.withWorkloadTransaction(actor.subject, correlationId, operation);
    } catch (error) {
      throw scanRefusalProblem(error);
    }
  }

  private async requirePlatformControl(controlKey: string): Promise<void> {
    try {
      await this.database.query('select platform.require_control_enabled($1)', [controlKey]);
    } catch (error) {
      if (isDatabaseError(error) && error.code === '55000'
        && String((error as { message?: unknown }).message ?? '').startsWith('PLATFORM_CONTROL_DISABLED:')) {
        throw new ConflictException('Document uploads are temporarily disabled');
      }
      throw error;
    }
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
      `select id::text, patient_id::text, facility_id::text, created_by::text, storage_bucket, storage_key,
              object_version_id, declared_media_type, detected_media_type, original_file_name,
              size_bytes::text, sha256_hex, scan_status, status, row_version::text
         from ehr.documents_effective where id = $1 and facility_id = $2`,
      [documentId, facilityId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Document not found');
    return row;
  }

  /**
   * Only the account that created the upload intent completes it (current
   * default; INTERFACE_CONTRACT.md §16). Anyone else gets the same 404 as an
   * unknown document, a document at another facility or one they cannot read.
   */
  private assertUploader(row: DocumentRow, context: DataAccessContext): void {
    if (row.created_by !== context.actor.accountId) throw new NotFoundException('Document not found');
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
      details: offlineAuditDetails(context),
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

function isDatabaseError(value: unknown): value is { code: string; message?: string } {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && typeof (value as { code?: unknown }).code === 'string';
}
