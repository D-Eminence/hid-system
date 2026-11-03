import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { requestDigest, requireIdempotencyKey } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { ClinicalRepository } from '../shared/clinical.repository';
import { PATIENT_ENTRY_KINDS, PATIENT_ENTRY_MESSAGES, type CreatePatientEntryDto, type PatientEntryKind } from './patient-entries.dto';
import { patientEntryItem, readPatientEntries, type PatientEntryItem, type PatientEntryPage } from './patient-entries.query';

/** A record as it is saved: trimmed, a blank place or note none, the date as entered. */
export interface NormalizedPatientEntry {
  kind: PatientEntryKind;
  title: string;
  facilityName: string | null;
  occurredOn: string;
  notes: string | null;
}

export interface CreatedPatientEntry {
  entry: PatientEntryItem;
  replayed: boolean;
}

export interface WithdrawnPatientEntry {
  entry: { id: string; status: 'withdrawn'; withdrawnAt: string };
  replayed: boolean;
}

/** Every control character; a title and a place are one line. */
const ONE_LINE = /[\u0000-\u001f\u007f-\u009f]/u;
/** Control characters other than the newline (notes). */
const PLAIN_TEXT = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FIRST_DATE = '1900-01-01';
const LAGOS_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Today's calendar date in Lagos, YYYY-MM-DD (the database checks the same). */
export function lagosToday(now: Date = new Date()): string {
  return LAGOS_DATE.format(now);
}

const characters = (text: string) => Array.from(text).length;

function realDate(text: string): boolean {
  const parts = CALENDAR_DATE.exec(text);
  if (!parts) return false;
  const [, year, month, day] = parts;
  const value = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  value.setUTCFullYear(Number(year));
  return value.toISOString().slice(0, 10) === text;
}

/**
 * The fields of a record the patient adds, as they are saved, or 400
 * VALIDATION_FAILED listing every field that is not acceptable, in the words
 * the patient sees. Titles and places are trimmed and on one line; notes keep
 * their line breaks (CRLF and CR read as a newline). Lengths are counted in
 * characters, as the database counts them.
 */
export function normalizePatientEntry(input: CreatePatientEntryDto, now: Date = new Date()): NormalizedPatientEntry {
  const errors: { field: string; messages: string[] }[] = [];
  const refuse = (field: keyof typeof PATIENT_ENTRY_MESSAGES) => {
    errors.push({ field, messages: [PATIENT_ENTRY_MESSAGES[field]] });
  };
  const kind = (PATIENT_ENTRY_KINDS as readonly unknown[]).includes(input.kind) ? input.kind : undefined;
  if (!kind) refuse('kind');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (characters(title) < 2 || characters(title) > 160 || ONE_LINE.test(title)) refuse('title');
  let facilityName: string | null = null;
  if (input.facilityName !== undefined && input.facilityName !== null) {
    facilityName = typeof input.facilityName === 'string' ? input.facilityName.trim() : '\u0000';
    if (facilityName === '') facilityName = null;
    else if (characters(facilityName) > 160 || ONE_LINE.test(facilityName)) refuse('facilityName');
  }
  const occurredOn = typeof input.occurredOn === 'string' ? input.occurredOn : '';
  if (!realDate(occurredOn) || occurredOn < FIRST_DATE || occurredOn > lagosToday(now)) refuse('occurredOn');
  let notes: string | null = null;
  if (input.notes !== undefined && input.notes !== null) {
    notes = typeof input.notes === 'string' ? input.notes.replace(/\r\n?/g, '\n').trim() : '\u0000';
    if (notes === '') notes = null;
    else if (characters(notes) > 2000 || PLAIN_TEXT.test(notes)) refuse('notes');
  }
  if (errors.length > 0 || !kind) {
    throw new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.', errors);
  }
  return { kind, title, facilityName, occurredOn, notes };
}

interface CreateRow {
  outcome: string;
  entry_id: string | null;
  entry_kind: PatientEntryKind | null;
  entry_title: string | null;
  entry_facility_name: string | null;
  entry_occurred_on: string | null;
  entry_notes: string | null;
  entry_created_at: Date | string | null;
}

interface WithdrawRow {
  outcome: string;
  entry_id: string | null;
  entry_withdrawn_at: Date | string | null;
}

const CREATE_ENTRY = `select outcome, entry_id, entry_kind, entry_title, entry_facility_name,
    entry_occurred_on::text as entry_occurred_on, entry_notes, entry_created_at
  from ehr.create_my_patient_entry($1, $2, $3, $4::date, $5, $6, $7)`;
const WITHDRAW_ENTRY = 'select outcome, entry_id, entry_withdrawn_at from ehr.withdraw_my_patient_entry($1)';

/** The database's refusals of a record's values (its CHECKs and the command's own check). */
const INVALID_VALUE_CODES = new Set(['22023', '23514', '22001', '22007', '22008', '22P02']);

function accessChanged(): DomainProblem {
  return new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient authorization changed');
}

/** A database refusal as the patient's answer; any other fault is passed on (503 or 500 upstream). */
function databaseProblem(error: unknown): unknown {
  const code = typeof error === 'object' && error !== null ? String((error as { code?: unknown }).code ?? '') : '';
  if (code === '42501') return accessChanged();
  if (INVALID_VALUE_CODES.has(code)) {
    return new DomainProblem(400, 'PATIENT_ENTRY_INVALID', 'Check the record\'s details and try again.');
  }
  if (code === '23505') {
    return new DomainProblem(409, 'REQUEST_IN_PROGRESS', 'This record is already being saved. Try again in a moment.');
  }
  return error;
}

/**
 * Records patients add themselves, text only (0116; Akos handover step 6).
 * The patient adds and withdraws their own records in a fresh patient-self
 * transaction (authorized by Identity, as GET ehr/me/records), through the
 * session-bound commands, which audit each write. A clinician reads them as
 * the chart's other reads are authorized and audited (ClinicalRepository.run,
 * read_records), as "ehr.record.read" on resource type patient-entries, which
 * the patient's access log (0093) shows as a view. A withdrawn record is read
 * by nobody and kept (D7).
 */
@Injectable()
export class PatientEntriesService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityApiService,
    private readonly clinical: ClinicalRepository) {}

  async create(request: HidRequest, input: CreatePatientEntryDto, idempotencyKeyHeader: string | undefined):
    Promise<CreatedPatientEntry> {
    if ((Array.isArray(input.attachments) && input.attachments.length > 0)
      || (Array.isArray(input.fileIds) && input.fileIds.length > 0)) {
      throw new DomainProblem(422, 'PATIENT_ENTRY_FILES_NOT_READY', PATIENT_ENTRY_MESSAGES.files);
    }
    const entry = normalizePatientEntry(input);
    const idempotencyKey = idempotencyKeyHeader === undefined ? null : requireIdempotencyKey(idempotencyKeyHeader);
    const digest = requestDigest('ehr.patient-entry.create', entry);
    const authorization = await this.authorizeSelf(request);
    let row: CreateRow | undefined;
    try {
      row = await this.database.withPatientTransaction(authorization, request.correlationId, async (client) =>
        (await client.query<CreateRow>(CREATE_ENTRY, [entry.kind, entry.title, entry.facilityName, entry.occurredOn,
          entry.notes, idempotencyKey, digest])).rows[0]);
    } catch (error) {
      throw databaseProblem(error);
    }
    // Mapped after the transaction, so that a refusal's audit row (the daily limit) is kept.
    if (!row) throw accessChanged();
    switch (row.outcome) {
      case 'created':
      case 'replayed':
        return { entry: patientEntryItem({ id: row.entry_id!, kind: row.entry_kind!, title: row.entry_title!,
          facility_name: row.entry_facility_name, occurred_on: row.entry_occurred_on!, notes: row.entry_notes,
          created_at: row.entry_created_at! }), replayed: row.outcome === 'replayed' };
      case 'key_reused':
        throw new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED',
          'This request was already used for a different record. Please try again.');
      case 'limited':
        throw new DomainProblem(429, 'PATIENT_ENTRY_LIMITED', 'You\'ve added a lot of records today. Try again tomorrow.');
      default:
        throw new Error('The patient entry command answered an unknown outcome');
    }
  }

  async withdraw(request: HidRequest, entryId: string): Promise<WithdrawnPatientEntry> {
    const authorization = await this.authorizeSelf(request);
    let row: WithdrawRow | undefined;
    try {
      row = await this.database.withPatientTransaction(authorization, request.correlationId, async (client) =>
        (await client.query<WithdrawRow>(WITHDRAW_ENTRY, [entryId])).rows[0]);
    } catch (error) {
      throw databaseProblem(error);
    }
    if (!row) throw accessChanged();
    if (row.outcome === 'not_found') {
      throw new DomainProblem(404, 'PATIENT_ENTRY_NOT_FOUND', 'This record could not be found.');
    }
    if ((row.outcome !== 'withdrawn' && row.outcome !== 'already_withdrawn') || !row.entry_id || !row.entry_withdrawn_at) {
      throw new Error('The patient entry withdrawal answered an unknown outcome');
    }
    return { entry: { id: row.entry_id, status: 'withdrawn', withdrawnAt: new Date(row.entry_withdrawn_at).toISOString() },
      replayed: row.outcome === 'already_withdrawn' };
  }

  /** A clinician's read, with the patient's access currently granted (403 CONSENT_REQUIRED otherwise). */
  staffList(patientId: string, context: DataAccessContext): Promise<PatientEntryPage> {
    return this.clinical.run(context, patientId, 'read_records', {
      action: 'ehr.record.read', resourceType: 'patient-entries', resourceId: patientId,
    }, async (client: PoolClient) => {
      const page = await readPatientEntries(client, patientId);
      return { value: page, details: { entryCount: page.items.length, more: page.more } };
    });
  }

  /** The session's patient, re-confirmed by Identity (as PatientRecordsService.authorizeSelf). */
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
