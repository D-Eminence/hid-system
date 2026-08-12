import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { decodeTimelineCursor, requestDigest, timelinePage } from '../shared/clinical-context';
import {
  CreateClinicalNoteDto,
  CreateClinicalNoteRevisionDto,
  NoteStatus,
  TimelineQueryDto,
  UpdateClinicalNoteDto,
} from '../shared/clinical.dto';
import { ClinicalRepository } from '../shared/clinical.repository';

export interface ClinicalNoteRow extends QueryResultRow {
  id: string;
  encounterId: string;
  patientId: string;
  facilityId: string;
  createdBy: string;
  createdByMembershipId: string;
  noteType: string;
  title: string;
  status: 'draft' | 'signed' | 'amended' | 'entered_in_error';
  currentRevisionNo: number;
  signedAt: Date | null;
  signedBy: string | null;
  rowVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClinicalNoteRevisionRow extends QueryResultRow {
  id: string;
  clinicalNoteId: string;
  patientId: string;
  facilityId: string;
  revisionNo: number;
  content: string;
  changeReason: string;
  supersedesRevisionNo: number | null;
  createdBy: string;
  createdByMembershipId: string;
  contentSha256: string;
  createdAt: Date;
}

export interface OcrClinicalNoteImport {
  encounterId: string;
  noteType: string;
  title: string;
  content: string;
  publicationId: string;
  documentId: string;
  ocrJobId: string;
  extractionId: string;
  validationId: string;
  validationVersion: number;
  reviewedBy: string;
}

const NOTE_COLUMNS = `
  id, encounter_id as "encounterId", patient_id as "patientId", facility_id as "facilityId",
  created_by as "createdBy", created_by_membership_id as "createdByMembershipId",
  note_type as "noteType", title, status, current_revision_no as "currentRevisionNo",
  signed_at as "signedAt", signed_by as "signedBy", row_version as "rowVersion",
  created_at as "createdAt", updated_at as "updatedAt"`;

const REVISION_COLUMNS = `
  id, clinical_note_id as "clinicalNoteId", patient_id as "patientId", facility_id as "facilityId",
  revision_no as "revisionNo", content, change_reason as "changeReason",
  supersedes_revision_no as "supersedesRevisionNo", created_by as "createdBy",
  created_by_membership_id as "createdByMembershipId", content_sha256 as "contentSha256",
  created_at as "createdAt"`;

@Injectable()
export class ClinicalNotesService {
  constructor(private readonly repository: ClinicalRepository) {}

  list(
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    query: TimelineQueryDto,
  ) {
    const cursor = decodeTimelineCursor(query.cursor);
    return this.repository.run(
      context,
      patientId,
      'read_records',
      { action: 'ehr.note.list', resourceType: 'clinical-note', resourceId: encounterId },
      async (client) => {
        const result = await client.query<ClinicalNoteRow>(
          `select ${NOTE_COLUMNS} from ehr.clinical_notes
           where encounter_id = $1 and patient_id = $2 and facility_id = $3
             and ($4::timestamptz is null or (created_at, id) < ($4::timestamptz, $5::uuid))
           order by created_at desc, id desc limit $6`,
          [encounterId, patientId, context.facilityId, cursor?.sortAt ?? null, cursor?.id ?? null, query.limit + 1],
        );
        const page = timelinePage(result.rows, query.limit, (row) => row.createdAt);
        return { value: page, details: { resultCount: page.items.length } };
      },
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
  }

  get(context: DataAccessContext, patientId: string, encounterId: string, noteId: string): Promise<ClinicalNoteRow> {
    return this.repository.run(
      context,
      patientId,
      'read_records',
      { action: 'ehr.note.read', resourceType: 'clinical-note', resourceId: noteId },
      async (client) => ({ value: this.singleNote(await this.findNote(client, context, patientId, encounterId, noteId)) }),
      (client) => this.repository.exists(client, 'clinical_notes', noteId, patientId, context.facilityId, encounterId),
    );
  }

  listRevisions(
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    noteId: string,
  ): Promise<readonly ClinicalNoteRevisionRow[]> {
    return this.repository.run(
      context,
      patientId,
      'read_records',
      { action: 'ehr.note-revision.list', resourceType: 'clinical-note', resourceId: noteId },
      async (client) => {
        const result = await client.query<ClinicalNoteRevisionRow>(
          `select ${REVISION_COLUMNS} from ehr.clinical_note_revisions
           where clinical_note_id = $1 and patient_id = $2 and facility_id = $3
           order by revision_no desc`,
          [noteId, patientId, context.facilityId],
        );
        return { value: result.rows, resourceId: noteId, details: { resultCount: result.rows.length } };
      },
      (client) => this.repository.exists(client, 'clinical_notes', noteId, patientId, context.facilityId, encounterId),
    );
  }

  create(
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    input: CreateClinicalNoteDto,
    idempotencyKey: string,
  ): Promise<ClinicalNoteRow> {
    const operation = 'clinical-note.create';
    const digest = requestDigest(operation, { patientId, encounterId, input });
    return this.repository.run(
      context,
      patientId,
      'write_records',
      { action: 'ehr.note.create', resourceType: 'clinical-note' },
      (client) => this.repository.executeCreate(
        client,
        context,
        patientId,
        idempotencyKey,
        operation,
        digest,
        'clinical-note',
        async () => {
          const signed = input.status === NoteStatus.Signed;
          const result = await client.query<ClinicalNoteRow>(
            `insert into ehr.clinical_notes (
               encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
               note_type, title, status, signed_at, signed_by
             ) values ($1, $2, $3, $4, $5, $6, $7, $8,
               case when $9 then clock_timestamp() else null end,
               case when $9 then $4 else null end)
             returning ${NOTE_COLUMNS}`,
            [
              encounterId,
              patientId,
              context.facilityId,
              context.actor.accountId,
              context.membershipId,
              input.noteType,
              input.title,
              input.status,
              signed,
            ],
          );
          const note = this.singleNote(result.rows[0]);
          await client.query(
            `insert into ehr.clinical_note_revisions (
               clinical_note_id, patient_id, facility_id, revision_no, content, change_reason,
               supersedes_revision_no, created_by, created_by_membership_id
             ) values ($1, $2, $3, 1, $4, 'initial clinical note', null, $5, $6)`,
            [note.id, patientId, context.facilityId, input.content, context.actor.accountId, context.membershipId],
          );
          return { value: note, id: note.id };
        },
        (id) => this.findNoteById(client, context, patientId, id),
      ),
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
  }

  createImportedFromOcr(
    context: DataAccessContext,
    patientId: string,
    input: OcrClinicalNoteImport,
  ): Promise<ClinicalNoteRow> {
    const operation = 'clinical-note.import-ocr';
    const idempotencyKey = `ocr-publication:${input.publicationId}`;
    const digest = requestDigest(operation, { patientId, ...input });
    return this.repository.run(
      context,
      patientId,
      'write_records',
      { action: 'ehr.note.import-ocr', resourceType: 'clinical-note',
        details: { publicationId: input.publicationId, documentId: input.documentId } },
      (client) => this.repository.executeCreate(
        client, context, patientId, idempotencyKey, operation, digest, 'clinical-note',
        async () => {
          const result = await client.query<ClinicalNoteRow>(
            `insert into ehr.clinical_notes (
               encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
               note_type, title, status
             ) values ($1,$2,$3,$4,$5,$6,$7,'draft') returning ${NOTE_COLUMNS}`,
            [input.encounterId, patientId, context.facilityId, context.actor.accountId,
              context.membershipId, input.noteType, input.title],
          );
          const note = this.singleNote(result.rows[0]);
          await client.query(
            `insert into ehr.clinical_note_revisions (
               clinical_note_id, patient_id, facility_id, revision_no, content,
               change_reason, supersedes_revision_no, created_by, created_by_membership_id
             ) values ($1,$2,$3,1,$4,'OCR import from human-validated source evidence',null,$5,$6)`,
            [note.id, patientId, context.facilityId, input.content,
              context.actor.accountId, context.membershipId],
          );
          await client.query(
            `insert into ehr.ocr_import_provenance (
               clinical_resource_type, clinical_resource_id, facility_id, patient_id,
               document_id, ocr_job_id, extraction_id, validation_id, validation_version,
               publication_id, reviewed_by, published_by
             ) values ('clinical_note',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [note.id, context.facilityId, patientId, input.documentId, input.ocrJobId,
              input.extractionId, input.validationId, input.validationVersion,
              input.publicationId, input.reviewedBy, context.actor.accountId],
          );
          return { value: note, id: note.id };
        },
        (id) => this.findNoteById(client, context, patientId, id),
      ),
      (client) => this.repository.encounterExists(client, input.encounterId, patientId, context.facilityId),
    );
  }

  update(
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    noteId: string,
    input: UpdateClinicalNoteDto,
  ): Promise<ClinicalNoteRow> {
    if (input.title === undefined && input.status === undefined) {
      throw new DomainProblem(400, 'EMPTY_UPDATE', 'At least one clinical field must be supplied');
    }
    return this.repository.run(
      context,
      patientId,
      'write_records',
      { action: 'ehr.note.update', resourceType: 'clinical-note', resourceId: noteId },
      async (client) => {
        const current = await this.lockNote(client, context, patientId, encounterId, noteId);
        this.validateTransition(current, input);
        await this.repository.setChangeReason(client, input.changeReason);
        const signing = input.status === NoteStatus.Signed && current.status === 'draft';
        const result = await client.query<ClinicalNoteRow>(
          `update ehr.clinical_notes set
             title = coalesce($1, title), status = coalesce($2, status),
             signed_at = case when $3 then clock_timestamp() else signed_at end,
             signed_by = case when $3 then $4 else signed_by end
           where id = $5 and encounter_id = $6 and patient_id = $7 and facility_id = $8 and row_version = $9
           returning ${NOTE_COLUMNS}`,
          [
            input.title ?? null,
            input.status ?? null,
            signing,
            context.actor.accountId,
            noteId,
            encounterId,
            patientId,
            context.facilityId,
            input.expectedRowVersion,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new DomainProblem(412, 'VERSION_CONFLICT', 'Clinical note changed since it was loaded');
        return { value: row, resourceId: noteId, details: { rowVersion: row.rowVersion } };
      },
      (client) => this.repository.exists(client, 'clinical_notes', noteId, patientId, context.facilityId, encounterId),
    );
  }

  addRevision(
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    noteId: string,
    input: CreateClinicalNoteRevisionDto,
    idempotencyKey: string,
  ): Promise<ClinicalNoteRevisionRow> {
    const operation = 'clinical-note-revision.create';
    const digest = requestDigest(operation, { patientId, encounterId, noteId, input });
    return this.repository.run(
      context,
      patientId,
      'write_records',
      { action: 'ehr.note-revision.create', resourceType: 'clinical-note-revision' },
      (client) => this.repository.executeCreate(
        client,
        context,
        patientId,
        idempotencyKey,
        operation,
        digest,
        'clinical-note-revision',
        async () => {
          const note = await this.lockNote(client, context, patientId, encounterId, noteId);
          if (note.status === 'entered_in_error') {
            throw new DomainProblem(409, 'NOTE_NOT_AMENDABLE', 'A note entered in error cannot be amended');
          }
          if (Number(note.rowVersion) !== input.expectedRowVersion) {
            throw new DomainProblem(412, 'VERSION_CONFLICT', 'Clinical note changed since it was loaded');
          }
          const nextRevision = note.currentRevisionNo + 1;
          const revisionResult = await client.query<ClinicalNoteRevisionRow>(
            `insert into ehr.clinical_note_revisions (
               clinical_note_id, patient_id, facility_id, revision_no, content, change_reason,
               supersedes_revision_no, created_by, created_by_membership_id
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             returning ${REVISION_COLUMNS}`,
            [
              noteId,
              patientId,
              context.facilityId,
              nextRevision,
              input.content,
              input.changeReason,
              note.currentRevisionNo,
              context.actor.accountId,
              context.membershipId,
            ],
          );
          await this.repository.setChangeReason(client, input.changeReason);
          const update = await client.query(
            `update ehr.clinical_notes
             set current_revision_no = $1, status = case when status in ('signed', 'amended') then 'amended' else status end
             where id = $2 and patient_id = $3 and facility_id = $4 and row_version = $5`,
            [nextRevision, noteId, patientId, context.facilityId, input.expectedRowVersion],
          );
          if (update.rowCount !== 1) throw new DomainProblem(412, 'VERSION_CONFLICT', 'Clinical note changed since it was loaded');
          const revision = this.singleRevision(revisionResult.rows[0]);
          return { value: revision, id: revision.id };
        },
        (id) => this.findRevision(client, context, patientId, noteId, id),
      ),
      (client) => this.repository.exists(client, 'clinical_notes', noteId, patientId, context.facilityId, encounterId),
    );
  }

  private async findNote(
    client: PoolClient,
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    noteId: string,
  ): Promise<ClinicalNoteRow | undefined> {
    const result = await client.query<ClinicalNoteRow>(
      `select ${NOTE_COLUMNS} from ehr.clinical_notes
       where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4`,
      [noteId, encounterId, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  private async findNoteById(client: PoolClient, context: DataAccessContext, patientId: string, noteId: string) {
    const result = await client.query<ClinicalNoteRow>(
      `select ${NOTE_COLUMNS} from ehr.clinical_notes where id = $1 and patient_id = $2 and facility_id = $3`,
      [noteId, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  private async lockNote(
    client: PoolClient,
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    noteId: string,
  ): Promise<ClinicalNoteRow> {
    const result = await client.query<ClinicalNoteRow>(
      `select ${NOTE_COLUMNS} from ehr.clinical_notes
       where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4 for update`,
      [noteId, encounterId, patientId, context.facilityId],
    );
    return this.singleNote(result.rows[0]);
  }

  private async findRevision(
    client: PoolClient,
    context: DataAccessContext,
    patientId: string,
    noteId: string,
    revisionId: string,
  ): Promise<ClinicalNoteRevisionRow | undefined> {
    const result = await client.query<ClinicalNoteRevisionRow>(
      `select ${REVISION_COLUMNS} from ehr.clinical_note_revisions
       where id = $1 and clinical_note_id = $2 and patient_id = $3 and facility_id = $4`,
      [revisionId, noteId, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  private validateTransition(current: ClinicalNoteRow, input: UpdateClinicalNoteDto): void {
    if (input.title !== undefined && current.status !== 'draft') {
      throw new DomainProblem(409, 'SIGNED_NOTE_IMMUTABLE', 'Signed note metadata cannot be overwritten');
    }
    if (!input.status || input.status === current.status) return;
    const allowed = current.status === 'draft'
      ? [NoteStatus.Signed, NoteStatus.EnteredInError]
      : current.status === 'signed' || current.status === 'amended'
        ? [NoteStatus.EnteredInError]
        : [];
    if (!allowed.includes(input.status)) {
      throw new DomainProblem(409, 'INVALID_NOTE_TRANSITION', 'Clinical note status transition is not allowed');
    }
  }

  private singleNote(row: ClinicalNoteRow | undefined): ClinicalNoteRow {
    if (!row) throw new DomainProblem(404, 'CLINICAL_NOTE_NOT_FOUND', 'Clinical note was not found');
    return row;
  }

  private singleRevision(row: ClinicalNoteRevisionRow | undefined): ClinicalNoteRevisionRow {
    if (!row) throw new DomainProblem(500, 'REVISION_CREATE_FAILED', 'Clinical note revision could not be created');
    return row;
  }
}
