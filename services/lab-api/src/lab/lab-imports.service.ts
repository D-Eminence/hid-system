import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import { requestDigest } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import { LAB_IMPORT_PAGE_DEFAULT, LAB_IMPORT_PAGE_MAX } from './dto/create-lab-import.dto';
import type { CreateLabImportDto, ImportedLabObservationDto, ListLabImportsQueryDto, ListOtherFacilityLabImportsQueryDto }
  from './dto/create-lab-import.dto';
import type { OcrLabImportCommand } from './lab-import.types';

interface ImportRow extends QueryResultRow {
  id: string; patient_id: string; facility_id: string; source_type: 'IMPORTED_EXTERNAL';
  status: string; external_lab_name: string | null; external_reference: string | null;
  collected_at: Date | null; reported_at: Date | null; received_at: Date;
  source_document_id: string; ocr_job_id: string | null; extraction_id: string | null;
  validation_id: string | null; validation_version: number | null; publication_id: string | null;
  row_version: string; created_at: Date;
}

const OBSERVATION_COLUMNS = `id::text,"ordinal",test_code as "testCode",test_name as "testName",value,
  value_text as "valueText",unit,reference_range as "referenceRange",
  abnormal_flag as "abnormalFlag",reported_at as "reportedAt",status,created_at as "createdAt"`;

const IMPORT_SELECT = `select id::text,patient_id::text,facility_id::text,source_type,status,
  external_lab_name,external_reference,collected_at,reported_at,received_at,
  source_document_id::text,ocr_job_id::text,extraction_id::text,validation_id::text,
  validation_version,publication_id::text,row_version::text,created_at from lab.imported_evidence`;

interface OtherFacilityImportRow extends QueryResultRow {
  import_id: string; source_facility_id: string; source_facility_name: string; status: string;
  external_lab_name: string | null; external_reference: string | null; collected_at: Date | null;
  reported_at: Date | null; received_at: Date; created_at: Date; observations: unknown[] | null;
  cursor_at: string;
}

/**
 * 0124: one page of the patient's lab imports from other facilities.
 * $1 patient, $2 and $3 the cursor (received_at and id of the last record of
 * the previous page, or both null), $4 the page size. cursor_at keeps
 * received_at's microseconds for the next cursor. Exported for the tests.
 */
export const OTHER_FACILITY_IMPORTS_QUERY = `select import_id::text,source_facility_id::text,source_facility_name,status,
  external_lab_name,external_reference,collected_at,reported_at,received_at,created_at,observations,
  to_char(received_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
  from lab.patient_imports_other_facilities($1::uuid,$2::timestamptz,$3::uuid,$4::integer)`;

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The other-facilities cursor: base64url of '<time with microseconds, UTC>|<id>'. */
export function encodeOtherFacilityCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
}

/** The cursor's time and id, or a 400 INVALID_CURSOR problem. */
export function decodeOtherFacilityCursor(cursor: string): { at: string; id: string } {
  const [at, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (rest.length > 0 || !at || !id || !CURSOR_AT.test(at) || !Number.isFinite(Date.parse(at)) || !CURSOR_ID.test(id)) {
    throw new DomainProblem(400, 'INVALID_CURSOR', 'Invalid record cursor');
  }
  return { at, id };
}

/** A refusal of lab.patient_imports_other_facilities as its problem; anything else unchanged (500). */
function otherFacilitiesProblem(error: unknown): unknown {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  if (code === '42501' && message === 'OTHER_FACILITIES_NOT_SHARED') {
    return new DomainProblem(403, 'OTHER_FACILITIES_NOT_SHARED',
      'The patient has not shared imported records from other facilities with you', undefined, { cause: error });
  }
  if (code === '22023') {
    return new DomainProblem(400, 'OTHER_FACILITIES_REQUEST_INVALID',
      'The request for records from other facilities is invalid', undefined, { cause: error });
  }
  return error;
}

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
        `select ${OBSERVATION_COLUMNS} from lab.imported_observations where import_id=$1 order by "ordinal"`, [row.id]);
      await this.audit.recordWithClient(client, this.auditEvent(context, row, 'lab.import.read'));
      return { ...this.project(row), observations: observations.rows };
    });
  }

  /**
   * One patient's imported Lab evidence with its observations, newest received
   * first (received_at desc, id desc: the 0017 patient timeline index). The
   * same canonical read_records decision as get(), but before any query, so a
   * refusal reads no row and writes no audit. Rows are this facility's only:
   * the query names the facility and the 0017 read policies check facility and
   * the consent grant again. The cursor is the last import id of the previous
   * page; one not visible here (another patient or facility) ends the list.
   * One audit row per page, with ids and counts only.
   */
  async listForPatient(context: DataAccessContext, query: ListLabImportsQueryDto) {
    const { patientId } = query;
    const limit = Math.min(Math.max(query.limit ?? LAB_IMPORT_PAGE_DEFAULT, 1), LAB_IMPORT_PAGE_MAX);
    const cursor = query.cursor ?? null;
    await this.authorize(patientId, context, 'read_records');
    return this.database.withTransaction(context, async (client) => {
      const page = await client.query<ImportRow>(
        `${IMPORT_SELECT} e where e.patient_id=$1 and e.facility_id=$2
          and ($3::uuid is null or (e.received_at,e.id) < (select c.received_at,c.id from lab.imported_evidence c
            where c.id=$3::uuid and c.patient_id=$1 and c.facility_id=$2))
         order by e.received_at desc, e.id desc limit $4`,
        [patientId, context.facilityId, cursor, limit + 1]);
      const rows = page.rows.slice(0, limit);
      const ids = rows.map((row) => row.id);
      const observations = ids.length === 0 ? [] : (await client.query<{ importId: string } & QueryResultRow>(
        `select import_id::text as "importId",${OBSERVATION_COLUMNS} from lab.imported_observations
         where import_id=any($1::uuid[]) and patient_id=$2 and facility_id=$3 order by import_id,"ordinal"`,
        [ids, patientId, context.facilityId])).rows;
      const byImport = new Map<string, QueryResultRow[]>(ids.map((id) => [id, []]));
      for (const { importId, ...observation } of observations) byImport.get(importId)?.push(observation);
      await this.audit.recordWithClient(client, {
        correlationId: context.correlationId, actorType: 'staff', actorSubject: context.actor.subject,
        actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId,
        organizationId: context.actor.facility?.organizationId, facilityId: context.facilityId, patientId,
        action: 'lab.import.list', resourceType: 'lab-imported-evidence-collection', outcome: 'success',
        purposeOfUse: context.purposeOfUse, sourceSystem: 'lab-api',
        details: { recordCount: rows.length, observationCount: observations.length, importIds: ids },
      });
      return {
        records: rows.map((row) => ({ ...this.project(row), observations: byImport.get(row.id) ?? [] })),
        nextCursor: page.rows.length > limit ? rows.at(-1)!.id : null,
      };
    });
  }

  /**
   * 0124 (Q64 option A): one page of the patient's imported Lab evidence from
   * OTHER facilities, newest received first, for staff at the facility of an
   * active patient share to their membership that includes other facilities.
   * lab.patient_imports_other_facilities checks the share (never break-glass,
   * a PIN grant or an approved request; purpose direct-care), withholds
   * entered-in-error and, unless the patient included them, sensitive records,
   * and writes the read's one audit row; so no Identity decision is asked and
   * no second audit row is written here. nextCursor is set when a full page
   * came back.
   */
  async listOtherFacilities(context: DataAccessContext, query: ListOtherFacilityLabImportsQueryDto) {
    const limit = Math.min(Math.max(query.limit ?? LAB_IMPORT_PAGE_DEFAULT, 1), LAB_IMPORT_PAGE_MAX);
    const cursor = query.cursor ? decodeOtherFacilityCursor(query.cursor) : null;
    let rows: OtherFacilityImportRow[];
    try {
      rows = await this.database.withTransaction(context, async (client) => (await client.query<OtherFacilityImportRow>(
        OTHER_FACILITY_IMPORTS_QUERY, [query.patientId, cursor?.at ?? null, cursor?.id ?? null, limit])).rows);
    } catch (error) {
      throw otherFacilitiesProblem(error);
    }
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      records: page.map((row) => ({ id: row.import_id, sourceFacilityId: row.source_facility_id,
        sourceFacilityName: row.source_facility_name, status: row.status, externalLabName: row.external_lab_name,
        externalReference: row.external_reference, collectedAt: row.collected_at, reportedAt: row.reported_at,
        receivedAt: row.received_at, createdAt: row.created_at,
        observations: Array.isArray(row.observations) ? row.observations : [],
        provenance: 'imported-from-paper-other-facility' as const })),
      nextCursor: page.length === limit && last ? encodeOtherFacilityCursor(last.cursor_at, last.import_id) : null,
    };
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
      // Imported evidence is insert-only (0017 trigger; no UPDATE for the runtime
      // role, so no row lock). Unique keys allow one import per idempotency key and
      // publication; DatabaseService reruns the SERIALIZABLE loser of a race (Stage 9).
      const existingResult = await client.query<ImportRow & { request_sha256: string }>(
        `select id::text,patient_id::text,facility_id::text,source_type,status,
          external_lab_name,external_reference,collected_at,reported_at,received_at,
          source_document_id::text,ocr_job_id::text,extraction_id::text,validation_id::text,
          validation_version,publication_id::text,row_version::text,created_at,request_sha256
         from lab.imported_evidence where (facility_id=$1 and created_by=$2 and idempotency_key=$3)
          or ($4::uuid is not null and publication_id=$4)`,
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
