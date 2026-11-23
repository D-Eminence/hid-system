import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { CollectedFieldProtector } from './collected-field-protector';
import { createContactLookupHmac, normalizePatientPhone, patientPhoneStoredForms } from './contact-lookup';
import type { CreateUnknownPatientDto, DecideUnknownPatientDto, IdentifyUnknownPatientDto,
  ListUnknownPatientsDto } from './dto/unknown-patient.dto';
import { HidCodeGenerator } from './hid-code-generator.service';

/**
 * 0145 (ID-7): unknown patient records, for a person who cannot say who they
 * are. The database decides (identity.create_unknown_patient,
 * list_unknown_patients, read_unknown_patient, identify_unknown_patient,
 * review_unknown_patient, decide_unknown_patient) and writes the audit rows of each success and each
 * not-found; this service reserves the Health ID, encrypts the arrival note
 * and the contact, computes the phone's lookup hashes, writes a refusal row
 * for every other refusal, and maps the answers. Nothing here logs or audits
 * a name, a date of birth, a phone, a Health ID or the arrival note.
 */

/** At this many unknown records in a Lagos day at one facility, a log line (ids and the count only). */
export const UNKNOWN_PATIENT_FACILITY_DAILY_ALERT = 20;
/** An open record older than this many days is overdue. */
export const UNKNOWN_PATIENT_OVERDUE_DAYS = 30;

export const UNKNOWN_PATIENT_MESSAGES = {
  identified: 'Patient identified. Their NIN is not verified yet.',
  sentForReview: 'This may be someone who is already registered. An approver will review it.',
  confirmed: 'Confirmed as a separate patient.',
  cancelled: 'Unknown patient record cancelled.',
} as const;

export const CREATE_UNKNOWN_PATIENT_SQL = `select patient_id::text, hid_code, record_kind, label, display_name, sex,
       date_of_birth::text as date_of_birth, dob_estimated, status, created_at, row_version, facility_daily_count, replayed
  from identity.create_unknown_patient($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)`;
export const LIST_UNKNOWN_PATIENTS_SQL = `select patient_id::text, record_kind, label, display_name, sex,
       date_of_birth::text as date_of_birth, dob_estimated, health_id_last4, unknown_reason, status, created_at,
       row_version, nin_verified, has_more
  from identity.list_unknown_patients($1, $2, $3, $4)`;
export const READ_UNKNOWN_PATIENT_SQL = `select outcome, patient_id::text, record_kind, label, display_name, sex,
       date_of_birth::text as date_of_birth, dob_estimated, health_id_last4, unknown_reason, status, created_at,
       row_version, nin_verified, arrival_note_ciphertext, arrival_note_key_version
  from identity.read_unknown_patient($1::uuid)`;
export const IDENTIFY_UNKNOWN_PATIENT_SQL = `select outcome, patient_id::text, record_kind, label, display_name, sex,
       date_of_birth::text as date_of_birth, dob_estimated, status, row_version, candidate_count, replayed
  from identity.identify_unknown_patient($1::uuid, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12)`;
export const REVIEW_UNKNOWN_PATIENT_SQL = `select outcome, patient_id::text, label, status, row_version,
       proposed_first_name, proposed_last_name, proposed_date_of_birth::text as proposed_date_of_birth, proposed_sex,
       identified_at, open_registration_count, candidates
  from identity.review_unknown_patient($1::uuid)`;
export const DECIDE_UNKNOWN_PATIENT_SQL = `select outcome, patient_id::text, record_kind, label, display_name, sex,
       date_of_birth::text as date_of_birth, dob_estimated, status, row_version, replayed
  from identity.decide_unknown_patient($1::uuid, $2, $3, $4, $5, $6)`;

type Timestamp = Date | string | null;
type Count = string | number | null;

interface CardRow extends QueryResultRow {
  patient_id: string | null;
  record_kind: 'standard' | 'unknown' | null;
  label: string | null;
  display_name: string | null;
  sex: string | null;
  date_of_birth: string | null;
  dob_estimated: boolean | null;
  status: string | null;
  row_version: Count;
  health_id_last4?: string | null;
  unknown_reason?: string | null;
  created_at?: Timestamp;
  nin_verified?: boolean | null;
}

interface CreateRow extends CardRow { hid_code: string; facility_daily_count: number | null; replayed: boolean }
interface ListRow extends CardRow { has_more: boolean }
interface ReadRow extends CardRow { outcome: string; arrival_note_ciphertext: Buffer | null; arrival_note_key_version: string | null }
interface IdentifyRow extends CardRow { outcome: string; candidate_count: number | null; replayed: boolean }
interface DecideRow extends CardRow { outcome: string; replayed: boolean }
interface ReviewCandidate { position: number; fullName: string; dateOfBirth: string | null; sex: string | null;
  healthIdLast4: string; matchReasons: string[]; active: boolean }
interface ReviewRow extends QueryResultRow {
  outcome: string; patient_id: string | null; label: string | null; status: string | null; row_version: Count;
  proposed_first_name: string | null; proposed_last_name: string | null; proposed_date_of_birth: string | null;
  proposed_sex: string | null; identified_at: Timestamp; open_registration_count: number | null;
  candidates: ReviewCandidate[] | null;
}

function iso(value: Timestamp | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function arrivalNoteLabel(patientId: string): string {
  return `identity:unknown-patient:${patientId}:arrival-note`;
}

export function unknownPatientContactLabel(patientId: string, part: 'phone' | 'address'): string {
  return `identity:unknown-patient:${patientId}:${part}`;
}

/** The page cursor: the last card's creation time and patient id, base64url JSON. */
export function encodeUnknownPatientCursor(createdAt: string, patientId: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt, p: patientId }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { createdAt: string; patientId: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: unknown; p?: unknown };
    if (typeof value.c === 'string' && !Number.isNaN(Date.parse(value.c)) && typeof value.p === 'string'
        && /^[0-9a-f-]{36}$/i.test(value.p)) {
      return { createdAt: value.c, patientId: value.p };
    }
  } catch { /* answered below */ }
  throw new DomainProblem(400, 'VALIDATION_FAILED', 'Check the highlighted fields.',
    [{ field: 'cursor', messages: ['cursor is not a page cursor of this list'] }]);
}

function card(row: CardRow, now = Date.now()) {
  const createdAt = iso(row.created_at);
  const openDays = createdAt ? Math.max(0, Math.floor((now - Date.parse(createdAt)) / 86_400_000)) : null;
  const stillUnknown = row.status === 'open' || row.status === 'sent_for_review';
  return {
    patientId: row.patient_id,
    recordKind: row.record_kind,
    label: row.label,
    displayName: row.display_name,
    sex: row.sex,
    dateOfBirth: row.date_of_birth,
    dateOfBirthEstimated: row.dob_estimated === true,
    ...(row.health_id_last4 !== undefined ? { healthIdLast4: row.health_id_last4 } : {}),
    ...(row.unknown_reason !== undefined ? { unknownReason: row.unknown_reason } : {}),
    ninStatus: row.nin_verified === true ? 'verified' : 'not_verified',
    status: row.status,
    ...(row.created_at !== undefined ? { createdAt, openDays,
      overdue: stillUnknown && openDays !== null && openDays > UNKNOWN_PATIENT_OVERDUE_DAYS } : {}),
    version: Number(row.row_version),
  };
}

@Injectable()
export class UnknownPatientsService {
  private readonly logger = new Logger(UnknownPatientsService.name);
  private readonly fieldProtector: CollectedFieldProtector;

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly hidGenerator: HidCodeGenerator,
    @Optional() fieldProtector?: CollectedFieldProtector,
  ) {
    this.fieldProtector = fieldProtector ?? new CollectedFieldProtector();
  }

  /** 201 for a new record (with its Health ID, once, for the wristband); 200 with replayed: true for a replay. */
  async create(input: CreateUnknownPatientDto, idempotencyKey: string, context: DataAccessContext) {
    const patientId = randomUUID();
    if (input.arrivalNote) this.fieldProtector.assertConfigured();
    const note = input.arrivalNote ? {
      ciphertext: this.fieldProtector.encrypt(arrivalNoteLabel(patientId), input.arrivalNote),
      keyVersion: this.fieldProtector.keyVersion,
    } : null;
    const requestSha256 = requestDigest('identity.unknown-patient.create', {
      gender: input.gender, estimatedAgeYears: input.estimatedAgeYears ?? null, unknownReason: input.unknownReason,
      arrivalNote: input.arrivalNote ?? null, purpose: input.purpose,
    });
    let row: CreateRow;
    try {
      row = await this.hidGenerator.reserve<CreateRow>(async (candidateHid) => {
        try {
          const result = await this.database.withTransaction(context, async (client) => (await client.query<CreateRow>(
            CREATE_UNKNOWN_PATIENT_SQL, [patientId, candidateHid, input.gender, input.estimatedAgeYears ?? null,
              input.unknownReason, note?.ciphertext ?? null, note?.keyVersion ?? null, idempotencyKey,
              requestSha256])).rows[0]);
          if (!result) throw unavailable();
          return { reserved: true as const, result };
        } catch (error) {
          if (isHidCollision(error)) return { reserved: false as const };
          throw error;
        }
      });
    } catch (error) {
      throw await this.refusal(context, 'identity.unknown-patient.create', null, error);
    }
    if (!row.replayed && row.facility_daily_count !== null && row.facility_daily_count >= UNKNOWN_PATIENT_FACILITY_DAILY_ALERT) {
      this.logger.warn(`identity.unknown_patient.facility_daily_high facility=${context.facilityId} `
        + `count=${row.facility_daily_count} correlation=${context.correlationId}`);
    }
    return { status: row.replayed ? 200 as const : 201 as const,
      body: { ...card(row), hid: row.hid_code, replayed: row.replayed === true } };
  }

  async list(query: ListUnknownPatientsDto, context: DataAccessContext) {
    const after = decodeCursor(query.cursor);
    const limit = query.limit ?? 25;
    let rows: ListRow[];
    try {
      rows = await this.database.withTransaction(context, async (client) => (await client.query<ListRow>(
        LIST_UNKNOWN_PATIENTS_SQL, [query.status ?? 'open', limit, after?.createdAt ?? null,
          after?.patientId ?? null])).rows);
    } catch (error) {
      throw await this.refusal(context, 'identity.unknown-patient.list', null, error);
    }
    const items = rows.map((row) => card(row));
    const last = rows.at(-1);
    const hasMore = rows[0]?.has_more === true;
    return { items, nextCursor: hasMore && last?.patient_id && last.created_at
      ? encodeUnknownPatientCursor(iso(last.created_at) as string, last.patient_id) : null };
  }

  async read(patientId: string, context: DataAccessContext) {
    let row: ReadRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<ReadRow>(
        READ_UNKNOWN_PATIENT_SQL, [patientId])).rows[0]);
    } catch (error) {
      throw await this.refusal(context, 'identity.unknown-patient.read', patientId, error);
    }
    if (!row) throw unavailable();
    if (row.outcome === 'not_found') throw patientNotFound();
    let arrivalNote: string | null = null;
    if (row.arrival_note_ciphertext && row.arrival_note_key_version) {
      try {
        arrivalNote = this.fieldProtector.decrypt(arrivalNoteLabel(patientId), row.arrival_note_key_version,
          row.arrival_note_ciphertext);
      } catch {
        // A key that is no longer configured: the card still answers, never the ciphertext.
        this.logger.error(`identity.unknown_patient.note_unreadable correlation=${context.correlationId}`);
        throw unavailable();
      }
    }
    return { ...card(row), arrivalNote };
  }

  async identify(patientId: string, input: IdentifyUnknownPatientDto, idempotencyKey: string,
    context: DataAccessContext) {
    const contact = input.phone ? {
      phone: normalizePatientPhone(input.phone) ?? input.phone,
      address: JSON.stringify({ addressLine: input.addressLine, city: input.city, stateCode: input.stateCode, lga: input.lga }),
    } : null;
    if (contact) this.fieldProtector.assertConfigured();
    const phoneLookups = contact
      ? patientPhoneStoredForms(contact.phone).map((form) => createContactLookupHmac('phone', form)).join(',') : null;
    // The digest names the phone by its lookup hash, never the number.
    const requestSha256 = requestDigest('identity.unknown-patient.identify', {
      patientId, firstName: input.firstName, lastName: input.lastName, dateOfBirth: input.dateOfBirth,
      gender: input.gender ?? null, phoneLookup: phoneLookups, address: contact ? contact.address : null,
      expectedVersion: input.expectedVersion, purpose: input.purpose,
    });
    const protectedContact = contact ? {
      phone: this.fieldProtector.encrypt(unknownPatientContactLabel(patientId, 'phone'), contact.phone),
      address: this.fieldProtector.encrypt(unknownPatientContactLabel(patientId, 'address'), contact.address),
      keyVersion: this.fieldProtector.keyVersion,
    } : null;
    let row: IdentifyRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<IdentifyRow>(
        IDENTIFY_UNKNOWN_PATIENT_SQL, [patientId, input.expectedVersion, input.firstName, input.lastName,
          input.dateOfBirth, input.gender ?? null, phoneLookups, protectedContact?.phone ?? null,
          protectedContact?.address ?? null, protectedContact?.keyVersion ?? null, idempotencyKey,
          requestSha256])).rows[0]);
    } catch (error) {
      throw await this.refusal(context, 'identity.unknown-patient.identify', patientId, error);
    }
    if (!row) throw unavailable();
    if (row.outcome === 'not_found') throw patientNotFound();
    const identified = row.outcome === 'identified';
    return { ...card(row), outcome: identified ? 'identified' : 'sent_for_review',
      message: identified ? UNKNOWN_PATIENT_MESSAGES.identified : UNKNOWN_PATIENT_MESSAGES.sentForReview,
      replayed: row.replayed === true };
  }

  /**
   * The approver's review of a record in review: the details held at
   * identify and each possible duplicate's card, so confirm-separate is not a
   * blind decision. The database audits the read and each candidate shown,
   * and the refusals it answers (not in review; the member who identified).
   */
  async review(patientId: string, context: DataAccessContext) {
    let row: ReviewRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<ReviewRow>(
        REVIEW_UNKNOWN_PATIENT_SQL, [patientId])).rows[0]);
    } catch (error) {
      throw await this.refusal(context, 'identity.unknown-patient.review', patientId, error);
    }
    if (!row) throw unavailable();
    if (row.outcome === 'not_found') throw patientNotFound();
    if (row.outcome === 'not_in_review') {
      throw new DomainProblem(409, 'UNKNOWN_PATIENT_NOT_IN_REVIEW', 'This record is not waiting for review.');
    }
    if (row.outcome === 'second_person_required') {
      throw new DomainProblem(403, 'UNKNOWN_PATIENT_SECOND_PERSON_REQUIRED',
        'Another approver must review this. You identified this patient.');
    }
    return {
      patientId: row.patient_id, label: row.label, status: row.status, version: Number(row.row_version),
      identifiedAt: iso(row.identified_at),
      heldDetails: { firstName: row.proposed_first_name, lastName: row.proposed_last_name,
        dateOfBirth: row.proposed_date_of_birth, sex: row.proposed_sex },
      openRegistrationCount: row.open_registration_count ?? 0,
      candidates: (row.candidates ?? []).map((candidate) => ({ position: candidate.position, fullName: candidate.fullName,
        dateOfBirth: candidate.dateOfBirth, sex: candidate.sex, healthIdLast4: candidate.healthIdLast4,
        matchReasons: candidate.matchReasons, active: candidate.active })),
    };
  }

  async decide(patientId: string, decision: 'confirm_separate' | 'cancel', input: DecideUnknownPatientDto,
    idempotencyKey: string, context: DataAccessContext) {
    const action = decision === 'cancel' ? 'identity.unknown-patient.cancel' : 'identity.unknown-patient.confirm-separate';
    const requestSha256 = requestDigest(action, { patientId, decision, expectedVersion: input.expectedVersion,
      reason: input.reason, purpose: input.purpose });
    let row: DecideRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<DecideRow>(
        DECIDE_UNKNOWN_PATIENT_SQL, [patientId, decision, input.expectedVersion, input.reason, idempotencyKey,
          requestSha256])).rows[0]);
    } catch (error) {
      throw await this.refusal(context, action, patientId, error);
    }
    if (!row) throw unavailable();
    if (row.outcome === 'not_found') throw patientNotFound();
    return { ...card(row), outcome: row.outcome,
      message: decision === 'cancel' ? UNKNOWN_PATIENT_MESSAGES.cancelled : UNKNOWN_PATIENT_MESSAGES.confirmed,
      replayed: row.replayed === true };
  }

  /**
   * A refused call: the mapped answer, and one denied row with the refusal's
   * code (the database's own rows rolled back with it). A 5xx writes none.
   */
  private async refusal(context: DataAccessContext, action: string, patientId: string | null,
    error: unknown): Promise<DomainProblem | unknown> {
    const problem = unknownPatientProblem(error);
    if (problem instanceof DomainProblem && problem.getStatus() < 500) {
      await this.audit.record({
        correlationId: context.correlationId, actorType: 'staff', actorSubject: context.actor.subject,
        actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId,
        organizationId: context.actor.facility?.organizationId, facilityId: context.facilityId, action,
        resourceType: 'unknown-patient', ...(patientId ? { resourceId: patientId } : {}), outcome: 'denied',
        purposeOfUse: context.purposeOfUse, details: { refusal: problem.code },
      });
    }
    return problem;
  }
}

function unavailable(): DomainProblem {
  return new DomainProblem(503, 'UNKNOWN_PATIENT_UNAVAILABLE', 'Unknown patient records are not available right now.');
}

function patientNotFound(): DomainProblem {
  return new DomainProblem(404, 'PATIENT_NOT_FOUND', 'No such patient.');
}

const REFUSALS: Readonly<Record<string, readonly [number, string, string]>> = Object.freeze({
  UNKNOWN_PATIENT_DENIED: [403, 'PERMISSION_DENIED', 'You do not have permission to do this.'],
  UNKNOWN_PATIENT_SEALED_FACILITY: [403, 'UNKNOWN_PATIENT_NOT_AVAILABLE',
    'Unknown patient records cannot be made at this facility.'],
  UNKNOWN_PATIENT_SECOND_PERSON_REQUIRED: [403, 'UNKNOWN_PATIENT_SECOND_PERSON_REQUIRED',
    'Another approver must confirm this. You identified this patient.'],
  UNKNOWN_PATIENT_INVALID: [400, 'VALIDATION_FAILED', 'Check the highlighted fields.'],
  UNKNOWN_PATIENT_PHONE_REQUIRED: [400, 'PHONE_REQUIRED',
    'Enter the patient\'s phone number and address. Only a child can be identified without them.'],
  IDEMPOTENCY_KEY_REUSED: [409, 'IDEMPOTENCY_KEY_REUSED',
    'This request was already sent with different details. Please reload and try again.'],
  UNKNOWN_PATIENT_ALREADY_IDENTIFIED: [409, 'UNKNOWN_PATIENT_ALREADY_IDENTIFIED', 'This patient has already been identified.'],
  UNKNOWN_PATIENT_NOT_IN_REVIEW: [409, 'UNKNOWN_PATIENT_NOT_IN_REVIEW', 'This record is not waiting for review.'],
  UNKNOWN_PATIENT_HAS_RECORDS: [409, 'UNKNOWN_PATIENT_HAS_RECORDS',
    'This record already has clinical records, so it cannot be cancelled. Merge it into the right record instead.'],
  UNKNOWN_PATIENT_CANCELLED: [409, 'UNKNOWN_PATIENT_CANCELLED', 'This record was cancelled.'],
  VERSION_CONFLICT: [412, 'VERSION_CONFLICT', 'Someone else changed this record. Reload it and try again.'],
});

/** The answer to a database refusal of these routes; anything unknown is 503. */
export function unknownPatientProblem(error: unknown): DomainProblem | unknown {
  if (error instanceof DomainProblem) return error;
  if (typeof error !== 'object' || error === null) return error;
  const code = (error as { code?: unknown }).code;
  const message = String((error as { message?: unknown }).message ?? '');
  if (code === '42883' || code === '42P01') return unavailable();
  if (['P0001', '22023', '42501', '40001'].includes(String(code)) && Object.prototype.hasOwnProperty.call(REFUSALS, message)) {
    const [status, problemCode, detail] = REFUSALS[message] as readonly [number, string, string];
    return new DomainProblem(status, problemCode, detail);
  }
  if (typeof code === 'string') return unavailable();
  return error;
}

function isHidCollision(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === '23505'
    && (error as { constraint?: unknown }).constraint === 'patients_hid_code_ci_uq';
}
