import { randomUUID } from 'node:crypto';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { requestDigest, requireIdempotencyKey } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { downloadFileName, sniffMediaType } from '../../documents/media-sniff';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { STORAGE_PROVIDER, type PresignedUpload, type StorageProvider } from '../../storage/storage.types';
import { ClinicalRepository } from '../shared/clinical.repository';
import { patientDocumentScanStatus, type PatientEntryDocumentItem } from './patient-entries.query';
import {
  PATIENT_DOCUMENT_MAX_BYTES, PATIENT_DOCUMENT_MAX_NAME, PATIENT_DOCUMENT_MEDIA_TYPES, PATIENT_DOCUMENT_MESSAGES,
  type CreatePatientEntryDocumentUploadDto, type PatientDocumentMediaType,
} from './patient-entry-documents.dto';

/** A file's request as it is digested and saved: the name trimmed, the SHA-256 in lower case. */
export interface NormalizedPatientDocument {
  fileName: string;
  mediaType: PatientDocumentMediaType;
  sizeBytes: number;
  sha256Hex: string;
}

/** The document as the upload routes answer it (the staff shape's three members the website reads). */
export interface PatientDocumentState {
  id: string;
  status: string;
  scanStatus: PatientEntryDocumentItem['scanStatus'];
}

export interface PatientDocumentUploadIntent {
  document: PatientDocumentState;
  upload: PresignedUpload;
}

/** How long an upload link is valid, as staff document uploads (DocumentService). */
export const PATIENT_DOCUMENT_UPLOAD_SECONDS = 300;
/** The first bytes of each type the confirm reads (JPEG FF D8 FF, PNG's eight, PDF %PDF-). */
const LEADING_BYTES = 8;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const SHA256 = /^[0-9a-fA-F]{64}$/;

/**
 * The file's fields as they are digested and saved, or 400 VALIDATION_FAILED
 * listing every field that is not acceptable. The website checks the same
 * before it sends anything; the database checks again.
 */
export function normalizePatientDocument(input: CreatePatientEntryDocumentUploadDto): NormalizedPatientDocument {
  const errors: { field: string; messages: string[] }[] = [];
  const refuse = (field: keyof typeof PATIENT_DOCUMENT_MESSAGES) => {
    errors.push({ field, messages: [PATIENT_DOCUMENT_MESSAGES[field]] });
  };
  const fileName = typeof input.fileName === 'string' ? input.fileName.trim() : '';
  const nameLength = Array.from(fileName).length;
  if (nameLength < 1 || nameLength > PATIENT_DOCUMENT_MAX_NAME || CONTROL.test(fileName)) refuse('fileName');
  const mediaType = (PATIENT_DOCUMENT_MEDIA_TYPES as readonly unknown[]).includes(input.mediaType)
    ? input.mediaType as PatientDocumentMediaType : undefined;
  if (!mediaType) refuse('mediaType');
  const sizeBytes = input.sizeBytes;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > PATIENT_DOCUMENT_MAX_BYTES) refuse('sizeBytes');
  const sha256Hex = typeof input.sha256Hex === 'string' && SHA256.test(input.sha256Hex) ? input.sha256Hex.toLowerCase() : '';
  if (!sha256Hex) refuse('sha256Hex');
  if (errors.length > 0 || !mediaType) {
    throw new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.', errors);
  }
  return { fileName, mediaType, sizeBytes, sha256Hex };
}

/** Whether the first bytes are the declared type's (only the three types a patient may upload). */
export function leadingBytesMatch(prefix: Uint8Array, mediaType: PatientDocumentMediaType): boolean {
  return sniffMediaType(prefix) === mediaType;
}

/**
 * S3 answers HEAD on a key nothing was stored under with 404 (NotFound, or
 * NoSuchKey on a GET) only to a caller holding s3:ListBucket; to any other
 * caller it answers 403 (Forbidden, or AccessDenied). ehr-api holds
 * s3:ListBucket on staging only, so in production a PUT that never arrived
 * reads as 403. Used only on the confirm path, for the row's own server-made
 * key, where ehr-api may otherwise read: there a 403 means nothing is stored.
 */
export function missingObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, $metadata } = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return name === 'NotFound' || name === 'NoSuchKey' || name === 'Forbidden' || name === 'AccessDenied'
    || $metadata?.httpStatusCode === 404 || $metadata?.httpStatusCode === 403;
}

interface IntentRow {
  outcome: string;
  document_id: string | null;
  document_status: string | null;
  document_scan_status: string | null;
  document_storage_bucket: string | null;
  document_storage_key: string | null;
  document_media_type: PatientDocumentMediaType | null;
  document_size_bytes: string | null;
  document_sha256_hex: string | null;
  retry_after_seconds: number | null;
}

interface CompleteRow {
  outcome: string;
  document_id: string | null;
  document_status: string | null;
  document_scan_status: string | null;
}

interface StoredDocumentRow {
  id: string;
  status: string;
  scan_status: string;
  storage_bucket: string;
  storage_key: string;
  object_version_id: string | null;
  declared_media_type: PatientDocumentMediaType;
  detected_media_type: string | null;
  size_bytes: string;
  sha256_hex: string;
  original_file_name: string;
}

const CREATE_INTENT = `select outcome, document_id, document_status, document_scan_status, document_storage_bucket,
    document_storage_key, document_media_type, document_size_bytes::text as document_size_bytes, document_sha256_hex,
    retry_after_seconds
  from ehr.create_my_patient_entry_document_intent($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
const COMPLETE = `select outcome, document_id, document_status, document_scan_status
  from ehr.complete_my_patient_entry_document($1, $2, $3, $4, $5)`;
/** The uploader's own file on the record, as the patient's row-level security shows it (a removed record's: none). */
const OWN_DOCUMENT = `select id, status, scan_status, storage_bucket, storage_key, object_version_id, declared_media_type,
    detected_media_type, size_bytes::text as size_bytes, sha256_hex, original_file_name
  from ehr.patient_entry_documents_effective
  where id = $1 and entry_id = $2 and patient_id = $3 and created_by_account_id = $4`;
/** A file on the record as a clinician's row-level security shows it: confirmed, the record active, access granted. */
const STAFF_DOCUMENT = `select id, status, scan_status, storage_bucket, storage_key, object_version_id, declared_media_type,
    detected_media_type, size_bytes::text as size_bytes, sha256_hex, original_file_name
  from ehr.patient_entry_documents_effective
  where id = $1 and entry_id = $2 and patient_id = $3`;

const INVALID_VALUE_CODES = new Set(['22023', '23514', '22001', '22P02']);

function accessChanged(): DomainProblem {
  return new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient authorization changed');
}
function entryNotFound(): DomainProblem {
  return new DomainProblem(404, 'PATIENT_ENTRY_NOT_FOUND', 'This record could not be found.');
}
function documentNotFound(): DomainProblem {
  return new DomainProblem(404, 'PATIENT_DOCUMENT_NOT_FOUND', 'This file could not be found.');
}
function uploadIncomplete(): DomainProblem {
  return new DomainProblem(409, 'PATIENT_DOCUMENT_UPLOAD_INCOMPLETE', 'This file didn\'t upload completely. Try again.');
}
function storageMismatch(): ServiceUnavailableException {
  return new ServiceUnavailableException('Document storage is unavailable');
}

/** A database refusal as the patient's answer; any other fault is passed on (503 or 500 upstream). */
function databaseProblem(error: unknown): unknown {
  const code = typeof error === 'object' && error !== null ? String((error as { code?: unknown }).code ?? '') : '';
  if (code === '42501') return accessChanged();
  if (INVALID_VALUE_CODES.has(code)) {
    return new DomainProblem(400, 'PATIENT_DOCUMENT_INVALID', 'Check the file\'s details and try again.');
  }
  if (code === '23505') {
    return new DomainProblem(409, 'REQUEST_IN_PROGRESS', 'This file is already being added. Try again in a moment.');
  }
  return error;
}

function state(id: string, status: string | null, scanStatus: string | null): PatientDocumentState {
  return { id, status: status ?? 'initiated', scanStatus: patientDocumentScanStatus(scanStatus) };
}

/**
 * Photos and files on the records patients add themselves (0117; health main
 * BACKEND-NEEDS.md section 1). The patient asks for a link per file, PUTs the
 * exact bytes to the documents bucket as staff uploads do (the same S3
 * provider and key format, clinical/objects/<uuid>), and confirms; the
 * commands check the patient, the record, the key, the day's and the
 * record's limits and audit each write. A clinician reads a file only as they
 * read the record (ClinicalRepository.run, read_records, the patient's
 * consent), audited as ehr.document.download, which the patient's activity
 * shows as "Your records were opened".
 */
@Injectable()
export class PatientEntryDocumentsService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityApiService,
    private readonly clinical: ClinicalRepository, @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  async createUploadIntent(request: HidRequest, entryId: string, input: CreatePatientEntryDocumentUploadDto,
    idempotencyKeyHeader: string | undefined): Promise<PatientDocumentUploadIntent> {
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyHeader);
    const file = normalizePatientDocument(input);
    // The record is part of the request: the same key on another record is another request (key_reused).
    const digest = requestDigest('ehr.patient-entry.document.upload-intent', { entryId: entryId.toLowerCase(), ...file });
    const bucket = this.storage.bucket();
    const authorization = await this.authorizeSelf(request);
    let row: IntentRow | undefined;
    try {
      row = await this.database.withPatientTransaction(authorization, request.correlationId, async (client) =>
        (await client.query<IntentRow>(CREATE_INTENT, [entryId, file.fileName, file.mediaType, file.sizeBytes,
          file.sha256Hex, idempotencyKey, digest, bucket, `clinical/objects/${randomUUID()}`])).rows[0]);
    } catch (error) {
      throw databaseProblem(error);
    }
    // Mapped after the transaction, so that a refusal's audit row (a limit) is kept.
    if (!row) throw accessChanged();
    switch (row.outcome) {
      case 'created':
      case 'replayed': {
        // A replay (Try again, before the file is confirmed) answers 201 for the same document with a new link.
        if (row.document_storage_bucket !== bucket || !row.document_storage_key || !row.document_media_type
          || !row.document_sha256_hex || !row.document_id) throw storageMismatch();
        const upload = await this.storage.createUpload({ key: row.document_storage_key, mediaType: row.document_media_type,
          sizeBytes: Number(row.document_size_bytes), sha256Hex: row.document_sha256_hex,
          expiresInSeconds: PATIENT_DOCUMENT_UPLOAD_SECONDS });
        return { document: state(row.document_id, row.document_status, row.document_scan_status), upload };
      }
      case 'already_uploaded':
        throw new DomainProblem(409, 'PATIENT_DOCUMENT_ALREADY_UPLOADED', 'This file is already uploaded.', undefined,
          { members: { document: state(row.document_id!, row.document_status, row.document_scan_status) } });
      case 'key_reused':
        throw new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED',
          'This request was already used for a different file. Please try again.');
      case 'entry_not_found':
        throw entryNotFound();
      case 'daily_limit':
        throw new DomainProblem(429, 'PATIENT_DOCUMENT_DAILY_LIMIT',
          'You can add up to 10 photos or files a day. Your record is saved; add the rest tomorrow.', undefined,
          { headers: { 'Retry-After': String(Math.max(1, Number(row.retry_after_seconds ?? 1))) } });
      case 'entry_full':
        throw new DomainProblem(409, 'PATIENT_DOCUMENT_ENTRY_LIMIT', 'A record can have up to 5 photos or files.');
      default:
        throw new Error('The patient document intent answered an unknown outcome');
    }
  }

  /**
   * Confirms one file: the stored object's size and SHA-256 must be the
   * declared ones and its first bytes the declared type's, read from the
   * object itself (HEAD, then a ranged GET of that version), never from the
   * request. Only the account that asked for the link may confirm.
   */
  async complete(request: HidRequest, entryId: string, documentId: string): Promise<{ document: PatientDocumentState }> {
    const authorization = await this.authorizeSelf(request);
    let stored: StoredDocumentRow | undefined;
    try {
      stored = await this.database.withPatientTransaction(authorization, request.correlationId, async (client) =>
        (await client.query<StoredDocumentRow>(OWN_DOCUMENT, [documentId, entryId, authorization.patientId,
          authorization.accountId])).rows[0]);
    } catch (error) {
      throw databaseProblem(error);
    }
    if (!stored) throw documentNotFound();
    // A confirm that went through though its answer was lost: the document as it is now.
    if (stored.status !== 'initiated') return { document: state(stored.id, stored.status, stored.scan_status) };
    if (stored.storage_bucket !== this.storage.bucket()) throw storageMismatch();
    let metadata;
    try {
      metadata = await this.storage.inspect(stored.storage_key);
    } catch (error) {
      if (missingObject(error)) throw uploadIncomplete();
      throw error;
    }
    if (metadata.sizeBytes !== Number(stored.size_bytes) || metadata.sha256Hex !== stored.sha256_hex.trim()) {
      throw uploadIncomplete();
    }
    const prefix = await this.storage.readPrefix(stored.storage_key, metadata.versionId, LEADING_BYTES);
    if (!leadingBytesMatch(prefix, stored.declared_media_type)) {
      throw new DomainProblem(409, 'PATIENT_DOCUMENT_TYPE_MISMATCH', 'This file isn\'t a JPEG, PNG or PDF.');
    }
    let row: CompleteRow | undefined;
    try {
      row = await this.database.withPatientTransaction(authorization, request.correlationId, async (client) =>
        (await client.query<CompleteRow>(COMPLETE, [entryId, documentId, metadata.versionId, metadata.sizeBytes,
          metadata.sha256Hex])).rows[0]);
    } catch (error) {
      throw databaseProblem(error);
    }
    if (!row) throw accessChanged();
    switch (row.outcome) {
      case 'uploaded':
      case 'already_uploaded':
        return { document: state(row.document_id!, row.document_status, row.document_scan_status) };
      case 'not_found':
        throw documentNotFound();
      case 'mismatch':
        throw uploadIncomplete();
      default:
        throw new Error('The patient document confirm answered an unknown outcome');
    }
  }

  /**
   * A clinician opens one file: with the patient's access currently granted
   * (403 CONSENT_REQUIRED otherwise), a file the clinician's row-level security
   * shows (confirmed, its record active; 404 CLINICAL_RESOURCE_NOT_FOUND
   * otherwise), scanned clean (409 PATIENT_DOCUMENT_NOT_AVAILABLE otherwise).
   * A 60-second link to that exact version, served as the scanned type.
   * Audited as ehr.document.download on patient-entry-document, a view in the
   * patient's activity.
   */
  async staffDownload(patientId: string, entryId: string, documentId: string, context: DataAccessContext) {
    return this.clinical.run(context, patientId, 'read_records', {
      action: 'ehr.document.download', resourceType: 'patient-entry-document', resourceId: documentId,
      details: { entryId },
    }, async (client: PoolClient) => {
      const document = (await client.query<StoredDocumentRow>(STAFF_DOCUMENT, [documentId, entryId, patientId])).rows[0];
      if (!document || document.status !== 'available' || document.scan_status !== 'clean' || !document.object_version_id
        || !(PATIENT_DOCUMENT_MEDIA_TYPES as readonly string[]).includes(document.detected_media_type ?? '')) {
        throw new DomainProblem(409, 'PATIENT_DOCUMENT_NOT_AVAILABLE', 'This file is not available yet.');
      }
      if (document.storage_bucket !== this.storage.bucket()) throw storageMismatch();
      const mediaType = document.detected_media_type as PatientDocumentMediaType;
      const download = await this.storage.createDownload(document.storage_key, document.object_version_id, {
        fileName: downloadFileName(document.original_file_name, mediaType), mediaType, disposition: 'inline',
      });
      return { value: download, details: { entryId } };
    }, async (client: PoolClient) =>
      (await client.query(STAFF_DOCUMENT, [documentId, entryId, patientId])).rows.length === 1);
  }

  /** The session's patient, re-confirmed by Identity (as PatientEntriesService.authorizeSelf). */
  private async authorizeSelf(request: HidRequest) {
    const actor = request.actor;
    if (actor?.kind !== 'patient' || !actor.patientId || !actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
    }
    const authorization = await this.identity.authorizeSelf(request);
    if (authorization.patientId !== actor.patientId || authorization.accountId !== actor.accountId
      || authorization.subject !== actor.subject || authorization.sessionId !== actor.sessionId) {
      throw accessChanged();
    }
    return authorization;
  }
}
