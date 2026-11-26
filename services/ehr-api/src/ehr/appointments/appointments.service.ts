import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { requestDigest } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { getEnvironment } from '../../config/environment';
import { DatabaseService } from '../../database/database.service';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { toVisitQueueCard, type VisitQueueCard } from '../worklist/visit-queue.service';
import type {
  AppointmentStatus, AppointmentVisitType, BookAppointmentDto, CancelAppointmentDto, CheckInAppointmentDto,
  CreateAppointmentClinicDto, ListAppointmentsQueryDto, MarkNoShowDto, MyAppointmentsQueryDto,
  RescheduleAppointmentDto, SaveAppointmentSettingsDto, UpdateAppointmentClinicDto,
} from './appointments.dto';

/**
 * APPT-1 (0160, 0161): appointments, with check-in to the waiting list.
 *
 * Every staff route works through 0160's SECURITY DEFINER functions, which
 * check the caller (active membership, the code, direct care, the facility's
 * seal), decide, and audit in the request's transaction, refusals included.
 * No Health ID or NIN is in any path, query, body or answer: the staff card
 * carries the last 4 characters of the Health ID only.
 *
 * Built at the recommended options, not yet answered by the owner: Q-APPT-1 A
 * (check-in opens the waiting-list row in the same transaction), Q-APPT-2 A
 * (timed bookings, the server checks clashes), Q-APPT-4 A (the portal is read
 * only), Q-APPT-5 A (who books) and Q-APPT-6 A (the appointment is a
 * check-in-only basis on its own day; a fresh search is always accepted).
 *
 * Until the owner's go-live, APPOINTMENTS_ENABLED is off in production and
 * every route answers 503 APPOINTMENTS_NOT_AVAILABLE.
 */

/** The staff card (every staff answer). */
export interface AppointmentCard {
  appointmentId: string;
  patientId: string;
  fullName: string;
  sex: string | null;
  dateOfBirth: string | null;
  healthIdLast4: string;
  chartBlocked: boolean;
  departmentCode: string;
  clinicId: string | null;
  clinicName: string | null;
  clinicianMembershipId: string | null;
  startsAt: string;
  endsAt: string;
  lengthMinutes: number;
  /** The Lagos calendar day of startsAt. */
  appointmentDay: string;
  visitType: AppointmentVisitType;
  reason: string | null;
  status: AppointmentStatus;
  /** How the patient was found at booking: from a search, or already this facility's patient. */
  bookingBasis: 'search' | 'own-facility';
  visitQueueEntryId: string | null;
  bookedAt: string;
  bookedByMembershipId: string;
  statusChangedAt: string;
  reminderSentAt: string | null;
  rowVersion: number;
}

export interface AppointmentHistoryEntry {
  kind: 'booked' | 'rescheduled' | 'cancelled' | 'no_show' | 'no_show_undone' | 'checked_in';
  at: string;
  byMembershipId: string | null;
  fromStartsAt: string | null;
  toStartsAt: string | null;
  fromClinicianMembershipId: string | null;
  toClinicianMembershipId: string | null;
  reason: string | null;
}

export interface AppointmentClinic {
  clinicId: string;
  name: string;
  departmentCode: string;
  defaultLengthMinutes: number | null;
  active: boolean;
  rowVersion: number;
}

/** Route 12: the patient's own appointment, at any facility. No staff id, no booking basis. */
export interface MyAppointment {
  appointmentId: string;
  facilityName: string;
  clinicName: string | null;
  departmentCode: string;
  clinicianName: string | null;
  startsAt: string;
  endsAt: string;
  lengthMinutes: number;
  visitType: AppointmentVisitType;
  reason: string | null;
  status: AppointmentStatus;
}

interface CardRow extends QueryResultRow {
  appointment_id: string;
  patient_id: string;
  full_name: string;
  sex: string | null;
  date_of_birth: string | null;
  health_id_last4: string;
  chart_blocked: boolean;
  department_code: string;
  clinic_id: string | null;
  clinic_name: string | null;
  clinician_membership_id: string | null;
  starts_at: Date;
  ends_at: Date;
  length_minutes: number;
  appointment_day: string;
  visit_type: AppointmentVisitType;
  reason: string | null;
  status: AppointmentStatus;
  booking_basis: 'search' | 'own_facility';
  visit_queue_entry_id: string | null;
  booked_at: Date;
  booked_by_membership_id: string;
  status_changed_at: Date;
  reminder_sent_at: Date | null;
  row_version: string;
}

interface OutcomeRow extends Partial<CardRow> {
  outcome: string;
  replayed?: boolean | null;
}

/** The card columns, with dates as text so no time zone is applied to them. */
const CARD_COLUMNS = `appointment_id, patient_id, full_name, sex, date_of_birth::text as date_of_birth, health_id_last4,
  chart_blocked, department_code, clinic_id, clinic_name, clinician_membership_id, starts_at, ends_at, length_minutes,
  appointment_day::text as appointment_day, visit_type, reason, status, booking_basis, visit_queue_entry_id, booked_at,
  booked_by_membership_id, status_changed_at, reminder_sent_at, row_version::text as row_version`;

export const BOOK_SQL = `select outcome, replayed, ${CARD_COLUMNS}
  from ehr.appointment_book($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11)`;
export const LIST_SQL = `select ${CARD_COLUMNS}, has_more,
    to_char(booked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as resume_booked_at,
    to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as resume_starts_at
  from ehr.appointment_list($1::date, $2, $3, $4::text[], $5, $6::timestamptz, $7::timestamptz, $8) order by ord`;
export const READ_SQL = `select outcome, ${CARD_COLUMNS}, history from ehr.appointment_read($1)`;
export const PATIENT_LIST_SQL = `select ${CARD_COLUMNS} from ehr.appointment_patient_list($1) order by ord`;
export const RESCHEDULE_SQL = `select outcome, replayed, ${CARD_COLUMNS}
  from ehr.appointment_reschedule($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9)`;
export const CANCEL_SQL = `select outcome, replayed, ${CARD_COLUMNS} from ehr.appointment_cancel($1, $2, $3, $4, $5)`;
export const NO_SHOW_SQL = `select outcome, replayed, ${CARD_COLUMNS} from ehr.appointment_mark_no_show($1, $2, $3, $4)`;
export const CHECK_IN_SQL = `select outcome, replayed, ${CARD_COLUMNS}, entry
  from ehr.appointment_check_in($1, $2, $3, $4, $5, $6)`;
export const BOOKABLE_STAFF_SQL = 'select membership_id from ehr.appointment_bookable_staff()';
export const CLINIC_LIST_SQL = `select clinic_id, name, department_code, default_length_minutes, active,
  row_version::text as row_version from ehr.appointment_clinic_list($1)`;
export const CLINIC_SAVE_SQL = `select outcome, replayed, clinic_id, name, department_code, default_length_minutes, active,
  row_version::text as row_version from ehr.appointment_clinic_save($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
export const SETTINGS_READ_SQL = `select default_length_minutes, row_version::text as row_version
  from ehr.appointment_settings_read()`;
export const SETTINGS_SAVE_SQL = `select outcome, replayed, default_length_minutes, row_version::text as row_version
  from ehr.appointment_settings_save($1, $2, $3, $4)`;
export const MY_LIST_SQL = `select appointment_id, facility_name, clinic_name, department_code, clinician_name, starts_at,
    ends_at, length_minutes, visit_type, reason, status, has_more,
    to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as resume_starts_at
  from ehr.appointment_my_list($1, $2, $3, $4::timestamptz, $5)`;
export const REMINDER_SQL = 'select ehr.appointment_send_reminders($1) as sent';

/** At most this many cards in one day-list page, unless the request asks for fewer. */
export const APPOINTMENT_LIST_LIMIT = 200;
/** The reminder sweep: every 10 minutes, at most this many reminders a run. */
export const APPOINTMENT_REMINDER_BATCH = 100;
export const APPOINTMENT_REMINDER_INTERVAL_MS = 10 * 60_000;

/** The plain-English messages (staff screens show these; never the word "permission"). */
export const APPOINTMENT_MESSAGES = {
  notAvailable: 'Appointments are not available yet.',
  readNotAllowed: 'Only the front desk, nurses, clinicians and doctors of this facility can see appointments.',
  writeNotAllowed: 'Only the front desk, clinicians and doctors of this facility can book or change appointments.',
  checkInNotAllowed: 'Only the front desk, clinicians and doctors of this facility can check a patient in from an appointment.',
  settingsNotAllowed: 'Only the hospital administrator can change the clinics and the default appointment length.',
  validation: 'Check the highlighted fields.',
  needsOnePatient: 'Choose one patient: from a search result or from this facility\'s patients.',
  timeInvalid: 'Choose a time from now up to one year ahead, on a 5-minute step.',
  clinicianInvalid: 'Choose a nurse, clinician or doctor who works at this facility.',
  clinicInvalid: 'Choose an open clinic of this facility in the same department.',
  identityNotConfirmed: 'Confirm the patient\'s name and date of birth with them before checking them in.',
  needsSearch: 'Search for the patient first, then book. A search result can be used for 10 minutes.',
  checkInNeedsSearch: 'Search for the patient to check them in.',
  notFound: 'No such appointment.',
  clinicianClash: 'This clinician already has an appointment at this time. Choose another time or clinician.',
  patientClash: 'This patient already has an appointment here at this time.',
  notBooked: 'This appointment is no longer booked. Reload it to see what changed.',
  noShowTooEarly: 'You can mark a no-show only after the appointment time.',
  wrongDay: 'This appointment is for another day. Check the patient in on that day, or reschedule it.',
  versionConflict: 'Someone else changed this appointment. Reload it and try again.',
  keyReused: 'This Idempotency-Key was already used for a different request.',
  clinicNotFound: 'No such clinic at this facility.',
  clinicNameTaken: 'This facility already has a clinic with this name.',
  clinicVersionConflict: 'Someone else changed this clinic. Reload it and try again.',
  settingsVersionConflict: 'Someone else changed the default length. Reload it and try again.',
  invalidCursor: 'This page link is no longer valid. Load the list from the start.',
} as const;

/** Whether the service flag is on (read on every call, so a test can switch it). */
export function appointmentsEnabled(): boolean {
  return getEnvironment().APPOINTMENTS_ENABLED;
}

export function notAvailable(): DomainProblem {
  return new DomainProblem(503, 'APPOINTMENTS_NOT_AVAILABLE', APPOINTMENT_MESSAGES.notAvailable);
}

/** The access a route needs, checked on the session's codes at this facility before the database decides again. */
export type AppointmentAccess = 'read' | 'write' | 'check-in' | 'settings-read' | 'settings-write';

export function requireAppointmentAccess(request: HidRequest, access: AppointmentAccess): void {
  const held = new Set(request.actor?.permissions ?? []);
  const allowed = access === 'read' ? held.has('ehr.appointment.read')
    : access === 'write' ? held.has('ehr.appointment.write')
      : access === 'check-in' ? held.has('ehr.appointment.write') && held.has('ehr.encounter.read')
        && held.has('ehr.encounter.write')
        : access === 'settings-read' ? held.has('ehr.appointment.read') || held.has('organization.manage')
          : held.has('organization.manage');
  if (allowed) return;
  const message = access === 'read' ? APPOINTMENT_MESSAGES.readNotAllowed
    : access === 'write' ? APPOINTMENT_MESSAGES.writeNotAllowed
      : access === 'check-in' ? APPOINTMENT_MESSAGES.checkInNotAllowed
        : access === 'settings-read' ? APPOINTMENT_MESSAGES.readNotAllowed
          : APPOINTMENT_MESSAGES.settingsNotAllowed;
  throw new DomainProblem(403, 'APPOINTMENT_NOT_ALLOWED', message);
}

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DayCursor { v: 1; d: string; s: string; b: string; i: string }
interface MyCursor { v: 1; w: 'upcoming' | 'past'; s: string; i: string }

export function encodeCursor(value: DayCursor | MyCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function invalidCursor(): DomainProblem {
  return new DomainProblem(400, 'INVALID_CURSOR', APPOINTMENT_MESSAGES.invalidCursor);
}

/** A day-list cursor, only for the same day it was issued for. */
export function decodeDayCursor(cursor: string, day: string): DayCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<DayCursor>;
    if (value.v === 1 && value.d === day && typeof value.s === 'string' && CURSOR_TIME.test(value.s)
      && typeof value.b === 'string' && CURSOR_TIME.test(value.b) && typeof value.i === 'string' && UUID.test(value.i)
      && encodeCursor({ v: 1, d: value.d, s: value.s, b: value.b, i: value.i }) === cursor) {
      return value as DayCursor;
    }
  } catch { /* refused below */ }
  throw invalidCursor();
}

/** A "My appointments" cursor, only for the same list (upcoming or past). */
export function decodeMyCursor(cursor: string, when: 'upcoming' | 'past'): MyCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<MyCursor>;
    if (value.v === 1 && value.w === when && typeof value.s === 'string' && CURSOR_TIME.test(value.s)
      && typeof value.i === 'string' && UUID.test(value.i)
      && encodeCursor({ v: 1, w: value.w, s: value.s, i: value.i }) === cursor) {
      return value as MyCursor;
    }
  } catch { /* refused below */ }
  throw invalidCursor();
}

/** The idempotency key as the database checks it (the controller has required it already). */
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

@Injectable()
export class AppointmentsService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityApiService) {}

  /** Route 1: book. */
  async book(context: DataAccessContext, input: BookAppointmentDto, key: string): Promise<{ appointment: AppointmentCard; replayed: boolean }> {
    const matchRef = input.matchRef === undefined || input.matchRef === '' ? null : input.matchRef;
    const patientId = input.patientId ?? null;
    if ((matchRef === null) === (patientId === null)) {
      throw new DomainProblem(400, 'APPOINTMENT_NEEDS_ONE_PATIENT', APPOINTMENT_MESSAGES.needsOnePatient);
    }
    if (input.lengthMinutes !== undefined && input.lengthMinutes % 5 !== 0) throw validation('lengthMinutes');
    const startsAt = parseInstant(input.startsAt);
    const reason = input.reason === undefined || input.reason === null || input.reason === '' ? null : input.reason;
    const digest = requestDigest('appointment.book', {
      matchRef, patientId, departmentCode: input.departmentCode, clinicId: input.clinicId ?? null,
      clinicianMembershipId: input.clinicianMembershipId ?? null, startsAt, lengthMinutes: input.lengthMinutes ?? null,
      visitType: input.visitType, reason,
    });
    const row = await this.one<OutcomeRow>(context, BOOK_SQL, [matchRef, patientId, input.departmentCode,
      input.clinicId ?? null, input.clinicianMembershipId ?? null, startsAt, input.lengthMinutes ?? null,
      input.visitType, reason, requiredKey(key), digest]);
    if (row?.outcome === 'booked' && row.appointment_id) {
      return { appointment: toCard(row as CardRow), replayed: row.replayed === true };
    }
    throw refusal(row?.outcome, 'book');
  }

  /** Route 2: the day list. */
  async list(context: DataAccessContext, query: ListAppointmentsQueryDto): Promise<{ items: AppointmentCard[]; nextCursor: string | null }> {
    const limit = query.limit ?? APPOINTMENT_LIST_LIMIT;
    const after = query.cursor === undefined ? null : decodeDayCursor(query.cursor, query.day);
    const rows = await this.query<CardRow & { has_more: boolean; resume_starts_at: string; resume_booked_at: string }>(
      context, LIST_SQL, [query.day, query.clinicId ?? null, query.clinicianMembershipId ?? null,
        query.status && query.status.length > 0 ? [...new Set(query.status)] : null, limit,
        after?.s ?? null, after?.b ?? null, after?.i ?? null]);
    const last = rows[rows.length - 1];
    return {
      items: rows.map(toCard),
      nextCursor: last && rows.some((row) => row.has_more)
        ? encodeCursor({ v: 1, d: query.day, s: last.resume_starts_at, b: last.resume_booked_at, i: last.appointment_id })
        : null,
    };
  }

  /** Route 3: one card and its history. */
  async read(context: DataAccessContext, appointmentId: string): Promise<{ appointment: AppointmentCard; history: AppointmentHistoryEntry[] }> {
    const row = await this.one<OutcomeRow & { history: unknown }>(context, READ_SQL, [appointmentId]);
    if (row?.outcome !== 'found' || !row.appointment_id) throw refusal('not_found', 'read');
    return { appointment: toCard(row as CardRow), history: toHistory(row.history) };
  }

  /** Route 4: this facility's appointments for one patient (upcoming, and the last 90 days). */
  async patientList(context: DataAccessContext, patientId: string): Promise<{ items: AppointmentCard[] }> {
    const rows = await this.query<CardRow>(context, PATIENT_LIST_SQL, [patientId]);
    return { items: rows.map(toCard) };
  }

  /** Route 5: reschedule (only while booked; clashes checked again). */
  async reschedule(context: DataAccessContext, appointmentId: string, input: RescheduleAppointmentDto, key: string) {
    if (input.lengthMinutes !== undefined && input.lengthMinutes % 5 !== 0) throw validation('lengthMinutes');
    const startsAt = parseInstant(input.startsAt);
    const clearClinician = input.clinicianMembershipId === null;
    const digest = requestDigest('appointment.reschedule', { appointmentId, expectedRowVersion: input.expectedRowVersion,
      startsAt, lengthMinutes: input.lengthMinutes ?? null,
      clinicianMembershipId: input.clinicianMembershipId === undefined ? 'unchanged' : input.clinicianMembershipId,
      reason: input.reason });
    return this.change(context, RESCHEDULE_SQL, [appointmentId, input.expectedRowVersion, startsAt,
      input.lengthMinutes ?? null, clearClinician ? null : input.clinicianMembershipId ?? null, clearClinician,
      input.reason, requiredKey(key), digest], 'reschedule');
  }

  /** Route 6: cancel (only while booked; cancelled is final). */
  async cancel(context: DataAccessContext, appointmentId: string, input: CancelAppointmentDto, key: string) {
    const digest = requestDigest('appointment.cancel', { appointmentId, expectedRowVersion: input.expectedRowVersion,
      reason: input.reason });
    return this.change(context, CANCEL_SQL, [appointmentId, input.expectedRowVersion, input.reason, requiredKey(key),
      digest], 'cancel');
  }

  /** Route 7: no-show (only while booked and once the start time has passed). */
  async markNoShow(context: DataAccessContext, appointmentId: string, input: MarkNoShowDto, key: string) {
    const digest = requestDigest('appointment.no-show', { appointmentId, expectedRowVersion: input.expectedRowVersion });
    return this.change(context, NO_SHOW_SQL, [appointmentId, input.expectedRowVersion, requiredKey(key), digest],
      'no-show');
  }

  /**
   * Route 8: check in (Q-APPT-6 A). Without a matchRef the appointment itself
   * is the basis for this one check-in, on its own Lagos day, at the facility
   * that booked it; with one, the fresh search must name the appointment's
   * patient and the check-in goes through 0135's own function.
   */
  async checkIn(context: DataAccessContext, appointmentId: string, input: CheckInAppointmentDto, key: string): Promise<{
    outcome: 'checked_in' | 'already_on_list'; appointment: AppointmentCard; entry: VisitQueueCard; replayed: boolean;
  }> {
    if (input.identityConfirmed !== true) {
      throw new DomainProblem(400, 'APPOINTMENT_IDENTITY_NOT_CONFIRMED', APPOINTMENT_MESSAGES.identityNotConfirmed);
    }
    const matchRef = input.matchRef === undefined || input.matchRef === '' ? null : input.matchRef;
    const digest = requestDigest('appointment.check-in', { appointmentId, expectedRowVersion: input.expectedRowVersion,
      identityConfirmed: true, matchRef });
    const row = await this.one<OutcomeRow & { entry: Record<string, unknown> | null }>(context, CHECK_IN_SQL,
      [appointmentId, input.expectedRowVersion, true, matchRef, requiredKey(key), digest]);
    if ((row?.outcome === 'checked_in' || row?.outcome === 'already_on_list') && row.appointment_id && row.entry) {
      return { outcome: row.outcome, appointment: toCard(row as CardRow), entry: entryCard(row.entry),
        replayed: row.replayed === true };
    }
    throw refusal(row?.outcome, 'check-in');
  }

  /** Route 10: the membership ids this facility can book against (names come from SX-9). */
  async bookableStaff(context: DataAccessContext): Promise<{ items: { membershipId: string }[] }> {
    const rows = await this.query<{ membership_id: string }>(context, BOOKABLE_STAFF_SQL, []);
    return { items: rows.map((row) => ({ membershipId: row.membership_id })) };
  }

  /** Route 9: the clinic list. */
  async clinics(context: DataAccessContext, includeInactive: boolean): Promise<{ items: AppointmentClinic[] }> {
    const rows = await this.query<ClinicRow>(context, CLINIC_LIST_SQL, [includeInactive]);
    return { items: rows.map(toClinic) };
  }

  async createClinic(context: DataAccessContext, input: CreateAppointmentClinicDto, key: string) {
    if (input.defaultLengthMinutes !== undefined && input.defaultLengthMinutes % 5 !== 0) {
      throw validation('defaultLengthMinutes');
    }
    const digest = requestDigest('appointment.clinic.create', { name: input.name, departmentCode: input.departmentCode,
      defaultLengthMinutes: input.defaultLengthMinutes ?? null });
    return this.saveClinic(context, [null, null, input.name, input.departmentCode, input.defaultLengthMinutes ?? null,
      false, null, requiredKey(key), digest]);
  }

  async updateClinic(context: DataAccessContext, clinicId: string, input: UpdateAppointmentClinicDto, key: string) {
    if (typeof input.defaultLengthMinutes === 'number' && input.defaultLengthMinutes % 5 !== 0) {
      throw validation('defaultLengthMinutes');
    }
    const clearDefault = input.defaultLengthMinutes === null;
    const digest = requestDigest('appointment.clinic.update', { clinicId, expectedRowVersion: input.expectedRowVersion,
      name: input.name ?? null, defaultLengthMinutes: input.defaultLengthMinutes === undefined ? 'unchanged'
        : input.defaultLengthMinutes, active: input.active ?? null });
    return this.saveClinic(context, [clinicId, input.expectedRowVersion, input.name ?? null, null,
      clearDefault ? null : input.defaultLengthMinutes ?? null, clearDefault, input.active ?? null, requiredKey(key),
      digest]);
  }

  async settings(context: DataAccessContext): Promise<{ defaultLengthMinutes: number; rowVersion: number }> {
    const row = await this.one<{ default_length_minutes: number; row_version: string }>(context, SETTINGS_READ_SQL, []);
    return { defaultLengthMinutes: Number(row?.default_length_minutes ?? 30), rowVersion: Number(row?.row_version ?? 0) };
  }

  async saveSettings(context: DataAccessContext, input: SaveAppointmentSettingsDto, key: string) {
    if (input.defaultLengthMinutes % 5 !== 0) throw validation('defaultLengthMinutes');
    const digest = requestDigest('appointment.settings.save', { expectedRowVersion: input.expectedRowVersion,
      defaultLengthMinutes: input.defaultLengthMinutes });
    const row = await this.one<{ outcome: string; replayed: boolean; default_length_minutes: number | null;
      row_version: string | null }>(context, SETTINGS_SAVE_SQL, [input.expectedRowVersion, input.defaultLengthMinutes,
      requiredKey(key), digest]);
    if (row?.outcome === 'saved') {
      return { defaultLengthMinutes: Number(row.default_length_minutes), rowVersion: Number(row.row_version),
        replayed: row.replayed === true };
    }
    if (row?.outcome === 'changed') {
      throw new DomainProblem(412, 'APPOINTMENT_SETTINGS_VERSION_CONFLICT', APPOINTMENT_MESSAGES.settingsVersionConflict);
    }
    throw refusal(row?.outcome, 'settings');
  }

  /**
   * Route 12: the signed-in patient's own appointments, read only. Identity
   * re-confirms the session first (as GET ehr/me/records); the database
   * answers only in that patient's own live session and audits the read.
   */
  async mine(request: HidRequest, query: MyAppointmentsQueryDto): Promise<{ items: MyAppointment[]; nextCursor: string | null }> {
    const actor = request.actor;
    if (actor?.kind !== 'patient' || !actor.patientId || !actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
    }
    const authorization = await this.identity.authorizeSelf(request);
    if (authorization.patientId !== actor.patientId || authorization.accountId !== actor.accountId
      || authorization.subject !== actor.subject || authorization.sessionId !== actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient authorization changed');
    }
    const limit = query.limit ?? 20;
    const after = query.cursor === undefined ? null : decodeMyCursor(query.cursor, query.when);
    let rows: MyRow[];
    try {
      rows = await this.database.withPatientTransaction(authorization, request.correlationId, async (client) =>
        (await client.query<MyRow>(MY_LIST_SQL, [authorization.patientId, query.when, limit, after?.s ?? null,
          after?.i ?? null])).rows);
    } catch (error) {
      throw translate(error, 'read');
    }
    const last = rows[rows.length - 1];
    return {
      items: rows.map(toMine),
      nextCursor: last && rows.some((row) => row.has_more)
        ? encodeCursor({ v: 1, w: query.when, s: last.resume_starts_at, i: last.appointment_id }) : null,
    };
  }

  private async change(context: DataAccessContext, sql: string, values: readonly unknown[],
    action: 'reschedule' | 'cancel' | 'no-show'): Promise<{ appointment: AppointmentCard; replayed: boolean }> {
    const row = await this.one<OutcomeRow>(context, sql, values);
    if (row?.outcome === 'updated' && row.appointment_id) {
      return { appointment: toCard(row as CardRow), replayed: row.replayed === true };
    }
    throw refusal(row?.outcome, action);
  }

  private async saveClinic(context: DataAccessContext, values: readonly unknown[]) {
    const row = await this.one<ClinicRow & { outcome: string; replayed: boolean }>(context, CLINIC_SAVE_SQL, values);
    if (row?.outcome === 'saved' && row.clinic_id) return { clinic: toClinic(row), replayed: row.replayed === true };
    switch (row?.outcome) {
      case 'not_found':
        throw new DomainProblem(404, 'APPOINTMENT_CLINIC_NOT_FOUND', APPOINTMENT_MESSAGES.clinicNotFound);
      case 'changed':
        throw new DomainProblem(412, 'APPOINTMENT_CLINIC_VERSION_CONFLICT', APPOINTMENT_MESSAGES.clinicVersionConflict);
      case 'name_taken':
        throw new DomainProblem(409, 'APPOINTMENT_CLINIC_NAME_TAKEN', APPOINTMENT_MESSAGES.clinicNameTaken);
      default:
        throw refusal(row?.outcome, 'settings');
    }
  }

  private async one<Row extends QueryResultRow>(context: DataAccessContext, sql: string,
    values: readonly unknown[]): Promise<Row | undefined> {
    return (await this.query<Row>(context, sql, values))[0];
  }

  private async query<Row extends QueryResultRow>(context: DataAccessContext, sql: string,
    values: readonly unknown[]): Promise<Row[]> {
    try {
      return await this.database.withTransaction(context, async (client: PoolClient) =>
        (await client.query<Row>(sql, [...values])).rows);
    } catch (error) {
      throw translate(error, sql === LIST_SQL || sql === READ_SQL || sql === PATIENT_LIST_SQL
        || sql === BOOKABLE_STAFF_SQL ? 'read' : 'write');
    }
  }
}

/**
 * The reminder sweep (0161, Q-APPT-3 A): every 10 minutes while
 * APPOINTMENTS_ENABLED is on, as the system actor. The database sends only
 * between 07:00 and 21:00 Lagos, only for booked appointments that start
 * within 24 hours and were booked at least 12 hours before, once each (inbox,
 * then web push and email; SMS only while its control is on, which is seeded
 * off). Not started in tests. A failure is logged once with no identifier and
 * tried again next time.
 */
@Injectable()
export class AppointmentReminderSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppointmentReminderSweeper.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly database: DatabaseService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !appointmentsEnabled()) return;
    this.timer = setInterval(() => { void this.sweep(); }, APPOINTMENT_REMINDER_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<number> {
    if (!appointmentsEnabled()) return 0;
    try {
      return await this.database.withSystemTransaction(`appointment-reminders-${randomUUID()}`, async (client) =>
        Number((await client.query<{ sent: number }>(REMINDER_SQL, [APPOINTMENT_REMINDER_BATCH])).rows[0]?.sent ?? 0));
    } catch {
      this.logger.warn({ event: 'ehr.appointment.reminder_sweep_unavailable' });
      return 0;
    }
  }
}

interface ClinicRow extends QueryResultRow {
  clinic_id: string;
  name: string;
  department_code: string;
  default_length_minutes: number | null;
  active: boolean;
  row_version: string;
}

interface MyRow extends QueryResultRow {
  appointment_id: string;
  facility_name: string;
  clinic_name: string | null;
  department_code: string;
  clinician_name: string | null;
  starts_at: Date;
  ends_at: Date;
  length_minutes: number;
  visit_type: AppointmentVisitType;
  reason: string | null;
  status: AppointmentStatus;
  has_more: boolean;
  resume_starts_at: string;
}

function requiredKey(key: string): string {
  if (!KEY.test(key)) {
    throw new DomainProblem(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key must contain 16 to 128 URL-safe characters');
  }
  return key;
}

function validation(field: string): DomainProblem {
  return new DomainProblem(400, 'VALIDATION_FAILED', APPOINTMENT_MESSAGES.validation,
    [{ field, messages: [`${field} must be a multiple of 5 minutes`] }]);
}

/** An ISO time on a whole second, as the database compares it (the 5-minute step is checked there). */
function parseInstant(value: string): string {
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) {
    throw new DomainProblem(400, 'APPOINTMENT_TIME_INVALID', APPOINTMENT_MESSAGES.timeInvalid);
  }
  return at.toISOString();
}

export function toCard(row: CardRow): AppointmentCard {
  return {
    appointmentId: row.appointment_id,
    patientId: row.patient_id,
    fullName: row.full_name,
    sex: row.sex,
    dateOfBirth: row.date_of_birth,
    healthIdLast4: row.health_id_last4,
    chartBlocked: row.chart_blocked === true,
    departmentCode: row.department_code,
    clinicId: row.clinic_id,
    clinicName: row.clinic_name,
    clinicianMembershipId: row.clinician_membership_id,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    lengthMinutes: Number(row.length_minutes),
    appointmentDay: row.appointment_day,
    visitType: row.visit_type,
    reason: row.reason,
    status: row.status,
    bookingBasis: row.booking_basis === 'own_facility' ? 'own-facility' : 'search',
    visitQueueEntryId: row.visit_queue_entry_id,
    bookedAt: new Date(row.booked_at).toISOString(),
    bookedByMembershipId: row.booked_by_membership_id,
    statusChangedAt: new Date(row.status_changed_at).toISOString(),
    reminderSentAt: row.reminder_sent_at === null ? null : new Date(row.reminder_sent_at).toISOString(),
    rowVersion: Number(row.row_version),
  };
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function toHistory(value: unknown): AppointmentHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      kind: entry.kind as AppointmentHistoryEntry['kind'],
      at: iso(entry.at) ?? '',
      byMembershipId: text(entry.byMembershipId),
      fromStartsAt: iso(entry.fromStartsAt),
      toStartsAt: iso(entry.toStartsAt),
      fromClinicianMembershipId: text(entry.fromClinicianMembershipId),
      toClinicianMembershipId: text(entry.toClinicianMembershipId),
      reason: text(entry.reason),
    }));
}

/** The waiting-list card in the check-in answer (EHR-C7's card, from 0135's card function as JSON). */
function entryCard(entry: Record<string, unknown>): VisitQueueCard {
  return toVisitQueueCard({
    entry_id: String(entry.entry_id), patient_id: String(entry.patient_id), full_name: String(entry.full_name),
    sex: text(entry.sex), date_of_birth: text(entry.date_of_birth), health_id_last4: String(entry.health_id_last4),
    stage: entry.stage as VisitQueueCard['stage'], triage_level: typeof entry.triage_level === 'number' ? entry.triage_level : null,
    assigned_membership_id: text(entry.assigned_membership_id),
    check_in_basis: entry.check_in_basis as 'search' | 'own_facility' | 'appointment',
    checked_in_at: new Date(String(entry.checked_in_at)), queue_day: String(entry.queue_day),
    stage_changed_at: new Date(String(entry.stage_changed_at)),
    closed_at: typeof entry.closed_at === 'string' ? new Date(entry.closed_at) : null,
    row_version: String(entry.row_version), chart_blocked: entry.chart_blocked === true,
  });
}

function toClinic(row: ClinicRow): AppointmentClinic {
  return {
    clinicId: row.clinic_id,
    name: row.name,
    departmentCode: row.department_code,
    defaultLengthMinutes: row.default_length_minutes === null ? null : Number(row.default_length_minutes),
    active: row.active === true,
    rowVersion: Number(row.row_version),
  };
}

function toMine(row: MyRow): MyAppointment {
  return {
    appointmentId: row.appointment_id,
    facilityName: row.facility_name,
    clinicName: row.clinic_name,
    departmentCode: row.department_code,
    clinicianName: row.clinician_name,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    lengthMinutes: Number(row.length_minutes),
    visitType: row.visit_type,
    reason: row.reason,
    status: row.status,
  };
}

/** A database outcome other than success, as the contract's answer. */
export function refusal(outcome: string | undefined,
  action: 'book' | 'read' | 'reschedule' | 'cancel' | 'no-show' | 'check-in' | 'settings'): DomainProblem {
  switch (outcome) {
    case 'needs_search':
      return action === 'check-in'
        ? new DomainProblem(403, 'APPOINTMENT_CHECK_IN_NEEDS_SEARCH', APPOINTMENT_MESSAGES.checkInNeedsSearch)
        : new DomainProblem(403, 'APPOINTMENT_NEEDS_SEARCH', APPOINTMENT_MESSAGES.needsSearch);
    case 'time_invalid':
      return new DomainProblem(400, 'APPOINTMENT_TIME_INVALID', APPOINTMENT_MESSAGES.timeInvalid);
    case 'department_invalid':
      return new DomainProblem(400, 'VALIDATION_FAILED', APPOINTMENT_MESSAGES.validation,
        [{ field: 'departmentCode', messages: ['departmentCode must be one of this facility\'s departments'] }]);
    case 'clinic_invalid':
      return new DomainProblem(400, 'APPOINTMENT_CLINIC_INVALID', APPOINTMENT_MESSAGES.clinicInvalid);
    case 'clinician_invalid':
      return new DomainProblem(400, 'APPOINTMENT_CLINICIAN_INVALID', APPOINTMENT_MESSAGES.clinicianInvalid);
    case 'clinician_clash':
      return new DomainProblem(409, 'APPOINTMENT_CLINICIAN_CLASH', APPOINTMENT_MESSAGES.clinicianClash);
    case 'patient_clash':
      return new DomainProblem(409, 'APPOINTMENT_PATIENT_CLASH', APPOINTMENT_MESSAGES.patientClash);
    case 'key_reused':
      return new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', APPOINTMENT_MESSAGES.keyReused);
    case 'not_booked':
      return new DomainProblem(409, 'APPOINTMENT_NOT_BOOKED', APPOINTMENT_MESSAGES.notBooked);
    case 'too_early':
      return new DomainProblem(409, 'APPOINTMENT_NO_SHOW_TOO_EARLY', APPOINTMENT_MESSAGES.noShowTooEarly);
    case 'wrong_day':
      return new DomainProblem(409, 'APPOINTMENT_CHECK_IN_WRONG_DAY', APPOINTMENT_MESSAGES.wrongDay);
    case 'changed':
      return new DomainProblem(412, 'APPOINTMENT_VERSION_CONFLICT', APPOINTMENT_MESSAGES.versionConflict);
    default:
      return new DomainProblem(404, 'APPOINTMENT_NOT_FOUND', APPOINTMENT_MESSAGES.notFound);
  }
}

/** The functions' own refusals, in plain words; anything else is passed on. */
export function translate(error: unknown, kind: 'read' | 'write'): unknown {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  if (code === '42501' && message === 'PATIENT_SESSION_REQUIRED') {
    return new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
  }
  if (code === '42501') {
    return new DomainProblem(403, 'APPOINTMENT_NOT_ALLOWED',
      kind === 'read' ? APPOINTMENT_MESSAGES.readNotAllowed : APPOINTMENT_MESSAGES.writeNotAllowed);
  }
  if (code === '22023' && message === 'APPOINTMENT_DIRECT_CARE_ONLY') {
    return new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', 'X-Purpose-Of-Use must be direct-care for appointments');
  }
  if (code === '22023' && message === 'APPOINTMENT_NEEDS_ONE_PATIENT') {
    return new DomainProblem(400, 'APPOINTMENT_NEEDS_ONE_PATIENT', APPOINTMENT_MESSAGES.needsOnePatient);
  }
  if (code === '22023' && message === 'APPOINTMENT_IDENTITY_NOT_CONFIRMED') {
    return new DomainProblem(400, 'APPOINTMENT_IDENTITY_NOT_CONFIRMED', APPOINTMENT_MESSAGES.identityNotConfirmed);
  }
  if (code === '22023' && message === 'APPOINTMENT_IDEMPOTENCY_KEY_INVALID') {
    return new DomainProblem(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key must contain 16 to 128 URL-safe characters');
  }
  if (code === '22023' && message === 'APPOINTMENT_INVALID') {
    return new DomainProblem(400, 'VALIDATION_FAILED', APPOINTMENT_MESSAGES.validation);
  }
  if (code === '42883' || code === '42P01') {
    // A new image on a schema without 0160 or 0161: the routes stay closed until the migrations are applied.
    return notAvailable();
  }
  return error;
}
