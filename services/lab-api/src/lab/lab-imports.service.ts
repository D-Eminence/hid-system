import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import { requestDigest } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import type { CreateLabImportDto, ImportedLabObservationDto } from './dto/create-lab-import.dto';
import type { OcrLabImportCommand } from './lab-import.types';

interface ImportRow extends QueryResultRow {
  id: string; patient_id: string; facility_id: string; source_type: 'IMPORTED_EXTERNAL';
  status: string; external_lab_name: string | null; external_reference: string | null;
  collected_at: Date | null; reported_at: Date | null; received_at: Date;
  source_document_id: string; ocr_job_id: string | null; extraction_id: string | null;
  validation_id: string | null; validation_version: number | null; publication_id: string | null;
  row_version: string; created_at: Date;
}

const IMPORT_SELECT = `select id::text,patient_id::text,facility_id::text,source_type,status,
  external_lab_name,external_reference,collected_at,reported_at,received_at,
  source_document_id::text,ocr_job_id::text,extraction_id::text,validation_id::text,
  validation_version,publication_id::text,row_version::text,created_at from lab.imported_evidence`;

@Injectable()
export class LabImportsService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityService,
    private readonly audit: AuditService) {}

  async createExternal(context: DataAccessContext, input: CreateLabImportDto, key: string) {
    return this.create(context, { ...input }, key, null);
  }

  async createFromOcr(context: DataAccessContext, input: OcrLabImportCommand): Promise<{ id: string; status: string; version: number }> {
    return this.create(context, input, `ocr-publication:${input.publicationId}`, input);
  }

  async get(context: DataAccessContext, importId: string) {
    return this.database.withTransaction(context, async (client) => {
      const row = await this.find(client, importId);
      await this.authorize(row.patient_id, context, 'read_records');
      const observations = await client.query(
        `select id::text,"ordinal",test_code as "testCode",test_name as "testName",value,
          value_text as "valueText",unit,reference_range as "referenceRange",
          abnormal_flag as "abnormalFlag",reported_at as "reportedAt",status,created_at as "createdAt"
         from lab.imported_observations where import_id=$1 order by "ordinal"`, [row.id]);
      await this.audit.recordWithClient(client, this.auditEvent(context, row, 'lab.import.read'));
      return { ...this.project(row), observations: observations.rows };
    });
  }

  private async create(context: DataAccessContext,
    input: CreateLabImportDto | OcrLabImportCommand, key: string, ocr: OcrLabImportCommand | null) {
    await this.authorize(input.patientId, context, 'write_records');
    const digest = requestDigest('lab.imported-evidence.create', {
      facilityId: context.facilityId, patientId: input.patientId, sourceDocumentId: input.sourceDocumentId,
      externalLabName: input.externalLabName ?? null, externalReference: input.externalReference ?? null,
      collectedAt: input.collectedAt ?? null, reportedAt: input.reportedAt ?? null,
      observations: input.observations, publicationId: ocr?.publicationId ?? null,
      validationId: ocr?.validationId ?? null, validationVersion: ocr?.validationVersion ?? null,
    });
    return this.database.withTransaction(context, async (client) => {
      const existingResult = await client.query<ImportRow & { request_sha256: string }>(
        `select id::text,patient_id::text,facility_id::text,source_type,status,
          external_lab_name,external_reference,collected_at,reported_at,received_at,
          source_document_id::text,ocr_job_id::text,extraction_id::text,validation_id::text,
          validation_version,publication_id::text,row_version::text,created_at,request_sha256
         from lab.imported_evidence where (facility_id=$1 and created_by=$2 and idempotency_key=$3)
          or ($4::uuid is not null and publication_id=$4) for update`,
        [context.facilityId, context.actor.accountId, key, ocr?.publicationId ?? null]);
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.request_sha256 !== digest) throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was used for different Lab evidence');
        return this.project(existing);
      }
      const importId = randomUUID();
      const inserted = await client.query<ImportRow>(
        `insert into lab.imported_evidence (id,patient_id,facility_id,external_lab_name,external_reference,
          collected_at,reported_at,source_document_id,ocr_job_id,extraction_id,validation_id,
          validation_version,publication_id,reviewed_by,created_by,created_by_membership_id,
          idempotency_key,request_sha256,correlation_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         returning *`,
        [importId,input.patientId,context.facilityId,input.externalLabName ?? null,input.externalReference ?? null,
          input.collectedAt ?? null,input.reportedAt ?? null,input.sourceDocumentId,ocr?.ocrJobId ?? null,
          ocr?.extractionId ?? null,ocr?.validationId ?? null,ocr?.validationVersion ?? null,
          ocr?.publicationId ?? null,ocr?.reviewedBy ?? context.actor.accountId,context.actor.accountId,
          context.membershipId,key,digest,context.correlationId]);
      const row = inserted.rows[0];
      if (!row) throw new DomainProblem(503, 'LAB_IMPORT_NOT_CREATED', 'Imported Lab evidence could not be created');
      await this.insertObservations(client, row, input.observations);
      await client.query(
        `insert into lab.outbox_events(event_type,aggregate_id,aggregate_version,facility_id,patient_id,correlation_id,payload)
         values ('LabImportedEvidenceCreated',$1,1,$2,$3,$4,$5::jsonb)`,
        [row.id,row.facility_id,row.patient_id,context.correlationId,JSON.stringify({ importId: row.id, sourceType: 'IMPORTED_EXTERNAL' })]);
      await this.audit.recordWithClient(client, this.auditEvent(context, row, 'lab.import.create', {
        sourceType: 'IMPORTED_EXTERNAL', publicationId: ocr?.publicationId, observationCount: input.observations.length,
      }));
      return this.project(row);
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  private async authorize(patientId: string, context: DataAccessContext, action: 'read_records' | 'write_records') {
    const decision = await this.identity.authorize(patientId, action, context.purposeOfUse, context);
    if (!decision.allowed || (action === 'write_records' && decision.breakGlass)) {
      throw new DomainProblem(403, 'LAB_IMPORT_ACCESS_DENIED', 'Imported Lab evidence access is not authorized');
    }
  }

  private async insertObservations(client: PoolClient, row: ImportRow, observations: ImportedLabObservationDto[]) {
    for (const [index, item] of observations.entries()) {
      if (!item.value?.trim() && !item.valueText?.trim()) {
        throw new DomainProblem(400, 'LAB_OBSERVATION_VALUE_REQUIRED', 'Each imported observation requires a value or text result');
      }
      await client.query(
        `insert into lab.imported_observations(import_id,facility_id,patient_id,"ordinal",test_code,test_name,
          value,value_text,unit,reference_range,abnormal_flag,reported_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [row.id,row.facility_id,row.patient_id,index + 1,item.testCode ?? null,item.testName.trim(),
          item.value?.trim() || null,item.valueText?.trim() || null,item.unit?.trim() || null,
          item.referenceRange?.trim() || null,item.abnormalFlag ?? 'unknown',item.reportedAt ?? null]);
    }
  }

  private async find(client: PoolClient, id: string): Promise<ImportRow> {
    const result = await client.query<ImportRow>(`${IMPORT_SELECT} where id=$1`, [id]);
    const row = result.rows[0];
    if (!row) throw new DomainProblem(404, 'LAB_IMPORT_NOT_FOUND', 'Imported Lab evidence was not found');
    return row;
  }

  private project(row: ImportRow) {
    return { id: row.id, patientId: row.patient_id, facilityId: row.facility_id, sourceType: row.source_type,
      status: row.status, externalLabName: row.external_lab_name, externalReference: row.external_reference,
      collectedAt: row.collected_at, reportedAt: row.reported_at, receivedAt: row.received_at,
      sourceDocumentId: row.source_document_id, ocrJobId: row.ocr_job_id, extractionId: row.extraction_id,
      validationId: row.validation_id, validationVersion: row.validation_version, publicationId: row.publication_id,
      version: Number(row.row_version), createdAt: row.created_at };
  }

  private auditEvent(context: DataAccessContext, row: ImportRow, action: string, details?: Record<string, unknown>) {
    return { correlationId: context.correlationId, actorType: 'staff' as const, actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId, facilityId: context.facilityId,
      patientId: row.patient_id, action, resourceType: 'lab-imported-evidence', resourceId: row.id,
      outcome: 'success' as const, purposeOfUse: context.purposeOfUse, details, sourceSystem: 'lab-api' };
  }
}
