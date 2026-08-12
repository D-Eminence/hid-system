import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import { requestDigest, requireIdempotencyKey } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityApiService } from '../integrations/identity-api.service';
import { EhrApiService } from '../integrations/ehr-api.service';
import type { ConfirmOcrPatientDto } from './dto/confirm-ocr-patient.dto';
import type { CreateOcrPublicationDto } from './dto/create-ocr-publication.dto';
import type { CreateOcrJobDto } from './dto/create-ocr-job.dto';
import type { RetryOcrJobDto } from './dto/retry-ocr-job.dto';
import type { ValidateOcrJobDto } from './dto/validate-ocr-job.dto';
import { assertCandidateClassification, clinicalNoteCandidate,
  expectedPublicationOperation, importedLabCandidate,
  importedMedicationCandidate } from './ocr-publication-policy';
import { LabApiService } from '../integrations/lab-api.service';
import { PharmacyApiService } from '../integrations/pharmacy-api.service';

interface OcrJobRow extends QueryResultRow {
  id: string;
  facility_id: string;
  document_id: string;
  patient_id: string | null;
  status: string;
  provider: string;
  attempt_count: number;
  max_attempts: number;
  row_version: string;
  created_at: Date;
  confirmation_id?: string | null;
  confirmed_patient_id?: string | null;
  confirmation_version?: number | null;
  confirmation_method?: string | null;
  confirmed_at?: Date | null;
}

interface ValidationRow extends QueryResultRow {
  id: string; job_id: string; facility_id: string; extraction_id: string;
  validation_version: number; disposition: 'validated' | 'rejected';
  target_domain: 'EHR' | 'LAB' | 'PHARMACY' | 'DOCUMENT_ONLY' | 'UNCLASSIFIED';
  candidate_type: string; accepted_fields: Record<string, unknown>;
  rejected_fields: readonly Record<string, unknown>[]; corrections: readonly Record<string, unknown>[];
  reason: string; validated_by: string; created_at: Date;
  document_id: string; patient_id: string | null;
  job_status: string;
}

interface ConfirmationRow extends QueryResultRow {
  id: string; job_id: string; patient_id: string; confirmation_version: number;
  method: string; created_at: Date; request_sha256: string;
}

interface PublicationRow extends QueryResultRow {
  id: string; job_id: string; validation_id: string; validation_version: number;
  patient_confirmation_id: string; facility_id: string; patient_id: string;
  target_domain: string; target_operation: string; status: 'pending' | 'processing' | 'published' | 'failed';
  request_sha256: string; attempt_count: number; max_attempts: number;
  target_resource_type: string | null; target_resource_id: string | null;
  failure_code: string | null; failure_summary: string | null; row_version: string;
  requested_at: Date; completed_at: Date | null;
}

const JOB_SELECT = `
  select id::text, facility_id::text, document_id::text, patient_id::text,
         status, provider, attempt_count, max_attempts, row_version::text, created_at
         ,(select confirmation.id::text from ocr.patient_confirmations confirmation
             where confirmation.job_id=ocr.jobs.id order by confirmation.confirmation_version desc limit 1) as confirmation_id
         ,(select confirmation.patient_id::text from ocr.patient_confirmations confirmation
             where confirmation.job_id=ocr.jobs.id order by confirmation.confirmation_version desc limit 1) as confirmed_patient_id
         ,(select confirmation.confirmation_version from ocr.patient_confirmations confirmation
             where confirmation.job_id=ocr.jobs.id order by confirmation.confirmation_version desc limit 1) as confirmation_version
         ,(select confirmation.method from ocr.patient_confirmations confirmation
             where confirmation.job_id=ocr.jobs.id order by confirmation.confirmation_version desc limit 1) as confirmation_method
         ,(select confirmation.created_at from ocr.patient_confirmations confirmation
             where confirmation.job_id=ocr.jobs.id order by confirmation.confirmation_version desc limit 1) as confirmed_at
    from ocr.jobs`;

@Injectable()
export class OcrService {
  constructor(
    private readonly database: DatabaseService,
    private readonly identity: IdentityApiService,
    private readonly audit: AuditService,
    private readonly ehrApi: EhrApiService,
    private readonly labApi: LabApiService,
    private readonly pharmacyApi: PharmacyApiService,
  ) {}

  async createJob(input: CreateOcrJobDto, idempotencyHeader: string | undefined, context: DataAccessContext) {
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    const digest = requestDigest('ocr.job.create', {
      facilityId: context.facilityId,
      documentId: input.documentId,
      patientId: input.patientId ?? null,
      provider: input.provider,
      maxAttempts: input.maxAttempts ?? 3,
    });
    return this.database.withTransaction(context, async (client) => {
      const existing = await client.query<OcrJobRow>(
        `${JOB_SELECT} where facility_id = $1 and created_by = $2
          and operation = 'ocr.extract' and idempotency_key = $3 for update`,
        [context.facilityId, context.actor.accountId, idempotencyKey],
      );
      const replay = existing.rows[0];
      if (replay) {
        const hash = await client.query<{ request_sha256: string }>(
          `select request_sha256 from ocr.jobs where id = $1`, [replay.id],
        );
        if (hash.rows[0]?.request_sha256 !== digest) {
          throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was used for a different OCR request');
        }
        await this.authorizeJob(replay, context, 'read_records');
        return this.project(replay);
      }

      const source = await this.ehrApi.getOcrDocumentSource(input.documentId, context);
      if (source.status !== 'available' || source.scanStatus !== 'clean'
          || !source.objectVersionId || !source.sha256Hex) {
        throw new DomainProblem(409, 'OCR_SOURCE_NOT_ELIGIBLE', 'OCR source must have exact clean immutable object evidence');
      }
      if (input.patientId && input.patientId !== source.patientId) {
        throw new DomainProblem(409, 'OCR_PATIENT_MISMATCH', 'OCR patient association does not match the source document');
      }
      const authorization = await this.identity.authorize(
        source.patientId, 'read_records', context.purposeOfUse, context,
      );
      if (!authorization.allowed) throw new DomainProblem(403, 'OCR_ACCESS_DENIED', 'OCR source access is not authorized');

      const inserted = await client.query<OcrJobRow>(
        `insert into ocr.jobs (
           id, facility_id, document_id, patient_id, source_object_version_id,
           source_sha256_hex, idempotency_key, request_sha256, provider,
           max_attempts, created_by, created_by_membership_id, correlation_id
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         returning id::text, facility_id::text, document_id::text, patient_id::text,
                   status, provider, attempt_count, max_attempts, row_version::text, created_at`,
        [
          randomUUID(), context.facilityId, source.id, input.patientId ?? null,
          source.objectVersionId, source.sha256Hex, idempotencyKey, digest,
          input.provider, input.maxAttempts ?? 3, context.actor.accountId,
          context.membershipId, context.correlationId,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new DomainProblem(503, 'OCR_JOB_NOT_CREATED', 'OCR job could not be created');
      await this.audit.recordWithClient(client, this.auditEvent(context, 'ocr.job.create', row));
      return this.project(row);
    });
  }

  async getJob(jobId: string, context: DataAccessContext) {
    return this.database.withTransaction(context, async (client) => {
      const row = await this.findJob(client, jobId);
      await this.authorizeJob(row, context, 'read_records');
      await this.audit.recordWithClient(client, this.auditEvent(context, 'ocr.job.read', row));
      return this.project(row);
    });
  }

  async findForDocument(documentId: string, context: DataAccessContext) {
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<OcrJobRow>(
        `${JOB_SELECT} where document_id=$1 order by created_at desc,id desc limit 1`, [documentId]);
      const row = result.rows[0];
      if (!row) return { job: null };
      await this.authorizeJob(row, context, 'read_records');
      return { job: this.project(row) };
    });
  }

  async listExtractions(jobId: string, context: DataAccessContext) {
    return this.database.withTransaction(context, async (client) => {
      const job = await this.findJob(client, jobId);
      await this.authorizeJob(job, context, 'read_records');
      const result = await client.query(
        `select id::text as "id", extraction_version as "version", attempt_no as "attempt",
                provider, provider_model as "providerModel", raw_text as "rawText",
                structured_payload as "structuredPayload", confidence, provenance, created_at as "createdAt"
           from ocr.extractions where job_id = $1 order by extraction_version`,
        [jobId],
      );
      await this.audit.recordWithClient(client, this.auditEvent(context, 'ocr.extraction.list', job));
      return { items: result.rows };
    });
  }

  async retry(jobId: string, input: RetryOcrJobDto, context: DataAccessContext) {
    return this.database.withTransaction(context, async (client) => {
      const current = await this.findJob(client, jobId, true);
      await this.authorizeJob(current, context, 'write_records');
      const result = await client.query<OcrJobRow>(
        `update ocr.jobs set status = 'queued', queued_at = clock_timestamp(),
                next_attempt_at = clock_timestamp(), started_at = null,
                failed_at = null, last_error_code = null, last_error_summary = null,
                correlation_id = $4, row_version = row_version + 1
          where id = $1 and facility_id = $2 and status = 'failed'
            and row_version = $3 and attempt_count < max_attempts
          returning id::text, facility_id::text, document_id::text, patient_id::text,
                    status, provider, attempt_count, max_attempts, row_version::text, created_at`,
        [jobId, context.facilityId, input.expectedVersion, context.correlationId],
      );
      const row = result.rows[0];
      if (!row) throw new DomainProblem(412, 'OCR_VERSION_CONFLICT', 'OCR job is not retryable at the expected version');
      await this.audit.recordWithClient(client, this.auditEvent(context, 'ocr.job.retry', row, { reason: input.reason }));
      return this.project(row);
    });
  }

  async validate(jobId: string, input: ValidateOcrJobDto, idempotencyHeader: string | undefined, context: DataAccessContext) {
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    assertCandidateClassification(input);
    const digest = requestDigest('ocr.validation.create', { jobId, ...input });
    return this.database.withTransaction(context, async (client) => {
      const job = await this.findJob(client, jobId, true);
      await this.authorizeJob(job, context, 'write_records');
      const replayResult = await client.query<ValidationRow>(
        `select validation.*, job.document_id::text, job.patient_id::text,
                job.status as job_status
           from ocr.validations validation join ocr.jobs job on job.id = validation.job_id
          where validation.facility_id = $1 and validation.validated_by = $2
            and validation.idempotency_key = $3 for update`,
        [context.facilityId, context.actor.accountId, idempotencyKey],
      );
      const replay = replayResult.rows[0];
      if (replay) {
        if (replay.request_sha256 !== digest) throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was used for a different validation');
        return this.projectValidation(replay);
      }
      if (job.status !== 'awaiting_validation' || Number(job.row_version) !== input.expectedVersion) {
        throw new DomainProblem(412, 'OCR_VERSION_CONFLICT', 'OCR job is not awaiting validation at the expected version');
      }
      const versionResult = await client.query<{ version: number }>(
        `select coalesce(max(validation_version), 0) + 1 as version from ocr.validations where job_id = $1`,
        [jobId],
      );
      const validationVersion = Number(versionResult.rows[0]?.version ?? 1);
      const validationResult = await client.query<{ id: string }>(
        `insert into ocr.validations (
           job_id, facility_id, extraction_id, validation_version, validated_payload,
           corrections, reason, validated_by, validated_by_membership_id,
           disposition, target_domain, candidate_type, accepted_fields,
           rejected_fields, provenance, idempotency_key, request_sha256
         ) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,
           $13::jsonb,$14::jsonb,$15::jsonb,$16,$17) returning id::text`,
        [jobId, context.facilityId, input.extractionId, validationVersion,
          JSON.stringify(input.validatedPayload), JSON.stringify(input.corrections),
          input.reason, context.actor.accountId, context.membershipId, input.disposition,
          input.targetDomain, input.candidateType, JSON.stringify(input.acceptedFields),
          JSON.stringify(input.rejectedFields), JSON.stringify({ source: 'human_review', extractionId: input.extractionId }),
          idempotencyKey, digest],
      );
      const validationId = validationResult.rows[0]?.id;
      if (!validationId) throw new DomainProblem(503, 'OCR_VALIDATION_NOT_CREATED', 'OCR validation could not be created');
      const updated = await client.query<OcrJobRow>(
        `update ocr.jobs set status = $5, completed_at = clock_timestamp(),
                correlation_id = $4, row_version = row_version + 1
          where id = $1 and facility_id = $2 and row_version = $3
          returning id::text, facility_id::text, document_id::text, patient_id::text,
                    status, provider, attempt_count, max_attempts, row_version::text, created_at`,
        [jobId, context.facilityId, input.expectedVersion, context.correlationId,
          input.disposition === 'validated' ? 'validated' : 'rejected'],
      );
      const row = updated.rows[0];
      if (!row) throw new DomainProblem(412, 'OCR_VERSION_CONFLICT', 'OCR job changed during validation');
      await this.audit.recordWithClient(client, this.auditEvent(context,
        input.disposition === 'validated' ? 'ocr.validation.accept' : 'ocr.validation.reject', row,
        { validationId, validationVersion, targetDomain: input.targetDomain }));
      return { ...this.project(row), validationId, validationVersion,
        disposition: input.disposition, targetDomain: input.targetDomain, candidateType: input.candidateType };
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async listValidations(jobId: string, context: DataAccessContext) {
    return this.database.withTransaction(context, async (client) => {
      const job = await this.findJob(client, jobId);
      await this.authorizeJob(job, context, 'read_records');
      const result = await client.query<ValidationRow>(
        `select validation.*, job.document_id::text, job.patient_id::text,
                job.status as job_status
           from ocr.validations validation join ocr.jobs job on job.id = validation.job_id
          where validation.job_id = $1 order by validation.validation_version`, [jobId]);
      return { items: result.rows.map((row) => this.projectValidation(row)) };
    });
  }

  async confirmPatient(jobId: string, input: ConfirmOcrPatientDto,
    idempotencyHeader: string | undefined, context: DataAccessContext) {
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    const digest = requestDigest('ocr.patient.confirm', { jobId, ...input });
    return this.database.withTransaction(context, async (client) => {
      const job = await this.findJob(client, jobId, true);
      const source = await this.authorizeJob(job, context, 'write_records');
      if (Number(job.row_version) !== input.expectedJobVersion) {
        throw new DomainProblem(412, 'OCR_VERSION_CONFLICT', 'OCR job changed before patient confirmation');
      }
      if (source.patientId !== input.patientId || (job.patient_id && job.patient_id !== input.patientId)) {
        throw new DomainProblem(409, 'OCR_PATIENT_MISMATCH', 'Confirmed patient does not match the canonical source document patient');
      }
      const decision = await this.identity.authorize(input.patientId, 'write_records', input.purpose, context);
      if (!decision.allowed || decision.breakGlass) {
        throw new DomainProblem(403, 'OCR_PATIENT_CONFIRMATION_DENIED', 'Patient confirmation is not authorized');
      }
      const replayResult = await client.query<ConfirmationRow>(
        `select id::text, job_id::text, patient_id::text, confirmation_version,
                method, created_at, request_sha256
           from ocr.patient_confirmations where facility_id = $1 and confirmed_by = $2
            and idempotency_key = $3 for update`,
        [context.facilityId, context.actor.accountId, idempotencyKey]);
      const replay = replayResult.rows[0];
      if (replay) {
        if (replay.request_sha256 !== digest) throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was used for a different patient confirmation');
        return this.projectConfirmation(replay);
      }
      const version = await client.query<{ version: number }>(
        `select coalesce(max(confirmation_version),0)+1 as version from ocr.patient_confirmations where job_id=$1`, [jobId]);
      const inserted = await client.query<ConfirmationRow>(
        `insert into ocr.patient_confirmations (job_id,facility_id,patient_id,confirmation_version,
          method,reason,confirmed_by,confirmed_by_membership_id,idempotency_key,request_sha256)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         returning id::text,job_id::text,patient_id::text,confirmation_version,method,created_at,request_sha256`,
        [jobId, context.facilityId, input.patientId, Number(version.rows[0]?.version ?? 1),
          input.method, input.reason, context.actor.accountId, context.membershipId, idempotencyKey, digest]);
      const confirmation = inserted.rows[0];
      if (!confirmation) throw new DomainProblem(503, 'OCR_CONFIRMATION_NOT_CREATED', 'Patient confirmation could not be created');
      await this.audit.recordWithClient(client, this.auditEvent(context, 'ocr.patient.confirm', job,
        { confirmationId: confirmation.id, method: input.method }));
      await this.appendOutbox(client, job, 'OcrPatientConfirmed', Number(job.row_version),
        { confirmationId: confirmation.id });
      return this.projectConfirmation(confirmation);
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async createPublication(validationId: string, input: CreateOcrPublicationDto,
    idempotencyHeader: string | undefined, context: DataAccessContext) {
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    const digest = requestDigest('ocr.publication.create', { validationId, ...input });
    const publication = await this.database.withTransaction(context, async (client) => {
      const validation = await this.findValidation(client, validationId, true);
      const job = await this.findJob(client, validation.job_id, true);
      await this.authorizeJob(job, context, 'write_records');
      this.assertPublicationRequest(validation, input);
      const confirmation = await this.findConfirmation(client, input.patientConfirmationId, validation.job_id);
      const replayResult = await client.query<PublicationRow>(
        `select * from ocr.publications where facility_id=$1 and requested_by=$2 and idempotency_key=$3 for update`,
        [context.facilityId, context.actor.accountId, idempotencyKey]);
      const replay = replayResult.rows[0];
      if (replay) {
        if (replay.request_sha256 !== digest) throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was used for a different publication');
        return replay;
      }
      const priorForValidation = await client.query<{ id: string }>(
        `select id::text from ocr.publications where validation_id=$1`, [validation.id]);
      if (priorForValidation.rows[0]) {
        throw new DomainProblem(409, 'OCR_ALREADY_PUBLISHED', 'This validation already has a publication command');
      }
      const inserted = await client.query<PublicationRow>(
        `insert into ocr.publications (job_id,validation_id,validation_version,
          patient_confirmation_id,facility_id,patient_id,target_domain,target_operation,
          idempotency_key,request_sha256,requested_by,requested_by_membership_id,correlation_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
        [validation.job_id, validation.id, validation.validation_version, confirmation.id,
          context.facilityId, confirmation.patient_id, validation.target_domain,
          input.targetOperation, idempotencyKey, digest, context.actor.accountId,
          context.membershipId, context.correlationId]);
      const created = inserted.rows[0];
      if (!created) throw new DomainProblem(503, 'OCR_PUBLICATION_NOT_CREATED', 'Publication command could not be created');
      await this.audit.recordWithClient(client, this.auditEvent(context, 'ocr.publication.request', job,
        { publicationId: created.id, validationId, targetDomain: validation.target_domain }));
      await this.appendOutbox(client, job, 'OcrPublicationRequested', Number(created.row_version),
        { publicationId: created.id, validationId });
      return created;
    }, { isolationLevel: 'SERIALIZABLE' });
    if (publication.status === 'published') return this.projectPublication(publication);
    if (publication.status === 'failed' && publication.failure_code
      && !['OWNING_SERVICE_UNAVAILABLE', 'REQUEST_IN_PROGRESS'].includes(publication.failure_code)) {
      throw new DomainProblem(409, 'OCR_PUBLICATION_TERMINAL', 'Publication failed terminally and requires corrected validation evidence');
    }
    return this.executePublication(publication.id, context);
  }

  async listPublications(validationId: string, context: DataAccessContext) {
    return this.database.withTransaction(context, async (client) => {
      const validation = await this.findValidation(client, validationId);
      const job = await this.findJob(client, validation.job_id);
      await this.authorizeJob(job, context, 'read_records');
      const result = await client.query<PublicationRow>(
        `select * from ocr.publications where validation_id=$1 order by requested_at`, [validationId]);
      return { items: result.rows.map((row) => this.projectPublication(row)) };
    });
  }

  private async executePublication(publicationId: string, context: DataAccessContext) {
    const token = randomUUID();
    const claimed = await this.database.withTransaction(context, async (client) => {
      const result = await client.query<PublicationRow>(
        `update ocr.publications set status='processing', processing_token=$2,
          processing_expires_at=clock_timestamp()+interval '60 seconds',
          attempt_count=attempt_count+1, failure_code=null, failure_summary=null,
          row_version=row_version+1, correlation_id=$3
         where id=$1 and attempt_count < max_attempts and next_attempt_at <= clock_timestamp()
           and (status in ('pending','failed') or (status='processing' and processing_expires_at <= clock_timestamp()))
         returning *`, [publicationId, token, context.correlationId]);
      return result.rows[0];
    });
    if (!claimed) {
      const current = await this.database.withTransaction(context, async (client) => {
        const result = await client.query<PublicationRow>('select * from ocr.publications where id=$1', [publicationId]);
        return result.rows[0];
      });
      if (current?.status === 'published') return this.projectPublication(current);
      throw new DomainProblem(409, 'OCR_PUBLICATION_IN_PROGRESS', 'Publication is already processing or is not retryable');
    }

    try {
      const evidence = await this.database.withTransaction(context, async (client) => {
        const validation = await this.findValidation(client, claimed.validation_id);
        const job = await this.findJob(client, claimed.job_id);
        await this.authorizeJob(job, context, 'write_records');
        return { validation, job };
      });
      let resourceType: string;
      let resourceId: string;
      if (claimed.target_domain === 'EHR' && claimed.target_operation === 'create_imported_clinical_note') {
        const note = clinicalNoteCandidate(evidence.validation.accepted_fields);
        const created = await this.ehrApi.createOcrClinicalNote(claimed.patient_id, {
          ...note, publicationId: claimed.id, documentId: evidence.validation.document_id,
          ocrJobId: evidence.validation.job_id, extractionId: evidence.validation.extraction_id,
          validationId: evidence.validation.id, validationVersion: evidence.validation.validation_version,
          reviewedBy: evidence.validation.validated_by,
        }, context, `ocr-publication:${claimed.id}`);
        resourceType = 'clinical-note'; resourceId = created.id;
      } else if (claimed.target_domain === 'LAB'
        && claimed.target_operation === 'create_imported_lab_evidence') {
        const candidate = importedLabCandidate(evidence.validation.accepted_fields);
        const created = await this.labApi.createOcrImport(context, {
          ...candidate, patientId: claimed.patient_id, sourceDocumentId: evidence.validation.document_id,
          ocrJobId: evidence.validation.job_id, extractionId: evidence.validation.extraction_id,
          validationId: evidence.validation.id, validationVersion: evidence.validation.validation_version,
          publicationId: claimed.id, reviewedBy: evidence.validation.validated_by,
        }, `ocr-publication:${claimed.id}`);
        resourceType = 'lab-imported-evidence'; resourceId = created.id;
      } else if (claimed.target_domain === 'PHARMACY'
        && claimed.target_operation === 'create_imported_medication_evidence') {
        const candidate = importedMedicationCandidate(evidence.validation.accepted_fields);
        const created = await this.pharmacyApi.createOcrImport(context, {
          ...candidate, patientId: claimed.patient_id,
          sourceDocumentId: evidence.validation.document_id,
          ocrJobId: evidence.validation.job_id,
          extractionId: evidence.validation.extraction_id,
          validationId: evidence.validation.id,
          validationVersion: evidence.validation.validation_version,
          publicationId: claimed.id,
          reviewedBy: evidence.validation.validated_by,
        }, `ocr-publication:${claimed.id}`);
        resourceType = 'pharmacy-imported-medication-evidence';
        resourceId = created.id;
      } else if (claimed.target_domain === 'DOCUMENT_ONLY'
        && claimed.target_operation === 'retain_validated_document') {
        resourceType = 'document'; resourceId = evidence.validation.document_id;
      } else {
        throw new DomainProblem(409, 'OCR_TARGET_UNAVAILABLE', 'The owning domain does not support this publication operation');
      }
      return await this.database.withTransaction(context, async (client) => {
        const result = await client.query<PublicationRow>(
          `update ocr.publications set status='published', completed_at=clock_timestamp(),
            failed_at=null, processing_token=null, processing_expires_at=null,
            target_resource_type=$3,target_resource_id=$4,row_version=row_version+1
           where id=$1 and status='processing' and processing_token=$2 returning *`,
          [claimed.id, token, resourceType, resourceId]);
        const published = result.rows[0];
        if (!published) throw new DomainProblem(409, 'OCR_PUBLICATION_CLAIM_LOST', 'Publication ownership expired before completion');
        await this.audit.recordWithClient(client, this.auditEvent(context, 'ocr.publication.succeed', evidence.job,
          { publicationId: published.id, targetResourceType: resourceType, targetResourceId: resourceId }));
        await this.appendOutbox(client, evidence.job, 'OcrPublicationSucceeded', Number(published.row_version),
          { publicationId: published.id, targetResourceType: resourceType, targetResourceId: resourceId });
        return this.projectPublication(published);
      });
    } catch (error) {
      const terminal = error instanceof DomainProblem && error.getStatus() >= 400 && error.getStatus() < 500
        && error.code !== 'REQUEST_IN_PROGRESS';
      const code = error instanceof DomainProblem ? error.code : 'OWNING_SERVICE_UNAVAILABLE';
      const summary = terminal ? 'Publication was rejected by the owning domain' : 'Owning clinical service is temporarily unavailable';
      await this.database.withTransaction(context, async (client) => {
        const result = await client.query<PublicationRow>(
          `update ocr.publications set status='failed', failed_at=clock_timestamp(),
            processing_token=null,processing_expires_at=null,failure_code=$3,failure_summary=$4,
            next_attempt_at=case when $5 and attempt_count < max_attempts
              then clock_timestamp()+interval '15 seconds' else clock_timestamp() end,
            row_version=row_version+1 where id=$1 and processing_token=$2 returning *`,
          [claimed.id, token, code.replace(/[^A-Z0-9_]/g, '_').slice(0, 80), summary, !terminal]);
        const failed = result.rows[0];
        if (failed) {
          const job = await this.findJob(client, failed.job_id);
          await this.audit.recordWithClient(client, this.auditEvent(context, 'ocr.publication.fail', job,
            { publicationId: failed.id, failureCode: failed.failure_code, retryable: !terminal }));
          await this.appendOutbox(client, job, 'OcrPublicationFailed', Number(failed.row_version),
            { publicationId: failed.id, failureCode: failed.failure_code, retryable: !terminal });
        }
      });
      throw error;
    }
  }

  private async findValidation(client: PoolClient, validationId: string, lock = false): Promise<ValidationRow> {
    const result = await client.query<ValidationRow>(
      `select validation.*, job.document_id::text, job.patient_id::text,
              job.status as job_status
         from ocr.validations validation join ocr.jobs job on job.id=validation.job_id
        where validation.id=$1${lock ? ' for update of validation' : ''}`, [validationId]);
    const row = result.rows[0];
    if (!row) throw new DomainProblem(404, 'OCR_VALIDATION_NOT_FOUND', 'OCR validation was not found');
    return row;
  }

  private async findConfirmation(client: PoolClient, confirmationId: string, jobId: string): Promise<ConfirmationRow> {
    const result = await client.query<ConfirmationRow>(
      `select id::text,job_id::text,patient_id::text,confirmation_version,method,created_at,request_sha256
         from ocr.patient_confirmations where id=$1 and job_id=$2
          and confirmation_version=(select max(latest.confirmation_version)
            from ocr.patient_confirmations latest where latest.job_id=$2)`, [confirmationId, jobId]);
    const row = result.rows[0];
    if (!row) throw new DomainProblem(409, 'OCR_PATIENT_UNCONFIRMED', 'A current patient confirmation is required');
    return row;
  }

  private assertPublicationRequest(validation: ValidationRow, input: CreateOcrPublicationDto): void {
    if (validation.disposition !== 'validated' || validation.job_status !== 'validated') {
      throw new DomainProblem(409, 'OCR_VALIDATION_NOT_PUBLISHABLE', 'Rejected or stale OCR validation cannot be published');
    }
    if (validation.validation_version !== input.validationVersion) {
      throw new DomainProblem(412, 'OCR_VALIDATION_VERSION_CONFLICT', 'Publication must bind to the explicit validation version');
    }
    const expected = expectedPublicationOperation(validation.target_domain);
    if (!expected || expected !== input.targetOperation) {
      throw new DomainProblem(409, 'OCR_TARGET_UNAVAILABLE', 'The owning domain does not support this publication operation');
    }
  }

  private projectValidation(row: ValidationRow) {
    return { id: row.id, jobId: row.job_id, extractionId: row.extraction_id,
      version: row.validation_version, disposition: row.disposition,
      targetDomain: row.target_domain, candidateType: row.candidate_type,
      acceptedFields: row.accepted_fields, rejectedFields: row.rejected_fields,
      corrections: row.corrections, reason: row.reason, reviewedAt: row.created_at };
  }

  private projectConfirmation(row: ConfirmationRow) {
    return { id: row.id, jobId: row.job_id, patientId: row.patient_id,
      version: row.confirmation_version, method: row.method, confirmedAt: row.created_at };
  }

  private projectPublication(row: PublicationRow) {
    return { id: row.id, validationId: row.validation_id, validationVersion: row.validation_version,
      patientConfirmationId: row.patient_confirmation_id, patientId: row.patient_id,
      targetDomain: row.target_domain, targetOperation: row.target_operation, status: row.status,
      attemptCount: row.attempt_count, maxAttempts: row.max_attempts,
      targetResourceType: row.target_resource_type, targetResourceId: row.target_resource_id,
      failureCode: row.failure_code, failureSummary: row.failure_summary,
      version: Number(row.row_version), requestedAt: row.requested_at, completedAt: row.completed_at };
  }

  private async appendOutbox(client: PoolClient, job: OcrJobRow, eventType: string,
    aggregateVersion: number, payload: Readonly<Record<string, unknown>>): Promise<void> {
    await client.query(
      `insert into ocr.outbox_events (event_type,aggregate_id,aggregate_version,
        facility_id,correlation_id,payload) values ($1,$2,$3,$4,platform.current_correlation_id(),$5::jsonb)`,
      [eventType, job.id, aggregateVersion, job.facility_id,
        JSON.stringify({ jobId: job.id, ...payload })],
    );
  }

  private async findJob(client: PoolClient, jobId: string, lock = false): Promise<OcrJobRow> {
    const result = await client.query<OcrJobRow>(
      `${JOB_SELECT} where id = $1${lock ? ' for update' : ''}`,
      [jobId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainProblem(404, 'OCR_JOB_NOT_FOUND', 'OCR job was not found');
    return row;
  }

  private project(row: OcrJobRow) {
    return {
      id: row.id,
      facilityId: row.facility_id,
      documentId: row.document_id,
      patientId: row.patient_id,
      status: row.status,
      provider: row.provider,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      version: Number(row.row_version),
      createdAt: row.created_at,
      patientConfirmation: row.confirmation_id ? {
        id: row.confirmation_id, patientId: row.confirmed_patient_id,
        version: row.confirmation_version, method: row.confirmation_method,
        confirmedAt: row.confirmed_at,
      } : null,
    };
  }

  private async authorizeJob(
    row: OcrJobRow,
    context: DataAccessContext,
    action: 'read_records' | 'write_records',
  ) {
    const source = await this.ehrApi.getOcrDocumentSource(row.document_id, context)
      .catch((error: unknown) => {
        if (error instanceof DomainProblem && error.getStatus() === 404) {
          throw new DomainProblem(404, 'OCR_JOB_NOT_FOUND', 'OCR job was not found');
        }
        throw error;
      });
    const authorization = await this.identity.authorize(
      source.patientId, action, context.purposeOfUse, context,
    );
    if (!authorization.allowed || (action === 'write_records' && authorization.breakGlass)) {
      throw new DomainProblem(404, 'OCR_JOB_NOT_FOUND', 'OCR job was not found');
    }
    return source;
  }

  private auditEvent(
    context: DataAccessContext,
    action: string,
    row: OcrJobRow,
    details?: Readonly<Record<string, unknown>>,
  ) {
    return {
      correlationId: context.correlationId,
      actorType: 'staff' as const,
      actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId,
      actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId,
      facilityId: context.facilityId,
      patientId: row.patient_id ?? undefined,
      action,
      resourceType: 'ocr-job',
      resourceId: row.id,
      outcome: 'success' as const,
      purposeOfUse: context.purposeOfUse,
      details,
      sourceSystem: 'ocr-api',
    };
  }
}
