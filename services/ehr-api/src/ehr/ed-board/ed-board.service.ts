import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { requestDigest } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { getEnvironment } from '../../config/environment';
import { DatabaseService } from '../../database/database.service';
import type {
  EdArriveDto, EdArrivalMode, EdCancelDto, EdDispositionDto, EdLeaveDto, EdLinkVisitDto, EdMoveDto, EdOpenStage,
  EdOutcome, EdTriageDto,
} from './ed-board.dto';

/**
 * ED-1 (0168, 0169): the emergency department board.
 *
 * Every route works through 0168's SECURITY DEFINER functions, which check the
 * caller (an active membership here, ehr.ed.read and the route's own code,
 * 0135's pair ehr.encounter.read and ehr.encounter.write, the purpose, the
 * facility's seal), decide, and audit in the request's transaction, refusals
 * included. An ED patient is a row of the live waiting list (0135) plus an ED
 * record (Q-ED-1 A): the stage, triage level (0135's five-level scale; no
 * second scale) and assignee are the waiting-list row's own fields.
 *
 * Built at the recommended options, not yet answered by the owner: Q-ED-1 A
 * (one list), Q-ED-2 A (who uses the board, 0169), Q-ED-3 A (an emergency
 * search with the member's own break-glass grant may put the patient on the
 * board), Q-ED-4 A (a short complaint, never shown to the front desk), Q-ED-5 A
 * (two-step disposition), Q-ED-6 A (the admission request is kept until wards
 * ship), Q-ED-7 A (no new write basis).
 *
 * No Health ID or NIN is in any path, query, body or answer: the card carries
 * the last 4 characters of the Health ID only. Until the owner's go-live,
 * ED_BOARD_ENABLED is off in production and every route answers 503
 * ED_BOARD_NOT_AVAILABLE.
 */

/** The plain-words messages of the board's refusals. Staff screens show these and never the word "permission". */
export const ED_MESSAGES = {
  notAvailable: 'The emergency board is not available yet.',
  boardNotAllowed: 'Only the front desk, nurses, clinicians and doctors of this facility can use the emergency board.',
  triageNotAllowed: 'Only nurses, clinicians and doctors can triage, record a complaint or move patients on the board.',
  dispositionNotAllowed: 'Only clinicians and doctors can record where the patient goes next.',
  validation: 'Check the highlighted fields.',
  needsOnePatient: 'Choose one patient: from a search result or from this facility\'s patients.',
  timeInvalid: 'The arrival time can be up to 6 hours ago, and not in the future.',
  triageInvalid: 'Choose a triage level from 1 to 5.',
  nothingToChange: 'Choose a stage or who will see the patient.',
  assigneeInvalid: 'Choose a nurse, clinician or doctor who works at this facility.',
  visitInvalid: 'Choose a visit of this patient at this facility, started for this arrival.',
  admitDepartmentInvalid: 'Choose a department of this facility to admit the patient to.',
  reasonRequired: 'Say why in at least 8 characters.',
  needsSearch: 'Search for the patient first, then add them to the board. A search result can be used for 10 minutes.',
  notFound: 'This patient is not on this facility\'s emergency board.',
  closed: 'This patient has left the emergency department. Add them again if they are back.',
  decided: 'A decision is already recorded for this patient. Change the decision, or select Left the department.',
  notDecided: 'Record where the patient goes next first.',
  cancelNotAllowed: 'This arrival already has a visit or a decision, so it cannot be cancelled. Record where the patient goes next instead.',
  versionConflict: 'Someone else changed this patient\'s place on the board. Reload it and try again.',
  keyReused: 'Idempotency-Key was already used with a different request',
  directCareOnly: 'X-Purpose-Of-Use must be direct-care for the emergency board (emergency only to add a patient found by an emergency search)',
} as const;

/** At most this many cards in one board answer. */
export const ED_BOARD_LIMIT = 200;

export type EdColumn = 'waiting' | 'being_seen' | 'disposition' | 'closed';
export type EdStatus = 'open' | 'decided' | 'closed';

export interface EdDisposition {
  outcome: EdOutcome;
  decidedAt: string;
  decidedByMembershipId: string;
  admitToDepartmentCode: string | null;
  admittingMembershipId: string | null;
  referredToFacilityName: string | null;
}

/** The board card (every answer). */
export interface EdCard {
  attendanceId: string;
  entryId: string;
  patientId: string;
  /** For an unknown record (0145): "Unknown patient U-0007"; the placeholder is never shown as a name. */
  fullName: string;
  recordKind: 'standard' | 'unknown';
  unknownLabel: string | null;
  sex: string | null;
  dateOfBirth: string | null;
  dateOfBirthEstimated: boolean;
  healthIdLast4: string;
  chartBlocked: boolean;
  arrivalBasis: 'search' | 'own-facility' | 'emergency';
  arrivalMode: EdArrivalMode;
  arrivedAt: string;
  minutesInDepartment: number;
  column: EdColumn;
  /** The waiting-list row's own stage, triage level and assignee (0135). */
  stage: string;
  triageLevel: number | null;
  triagedAt: string | null;
  triagedByMembershipId: string | null;
  /** null with complaintHidden for a member without ehr.ed.triage (the front desk). */
  presentingComplaint: string | null;
  complaintHidden: boolean;
  assignedMembershipId: string | null;
  encounterId: string | null;
  status: EdStatus;
  disposition: EdDisposition | null;
  leftAt: string | null;
  rowVersion: number;
}

export interface EdHistoryEntry {
  kind: 'arrived' | 'moved_from_waiting_list' | 'triaged' | 'moved' | 'visit_linked' | 'disposition'
    | 'disposition_changed' | 'left' | 'cancelled' | 'closed_on_waiting_list';
  at: string;
  byMembershipId: string | null;
  fromStage: string | null;
  toStage: string | null;
  triageLevel: number | null;
  outcome: EdOutcome | null;
  reason: string | null;
  /** On a triage or arrival: whether a complaint was recorded or changed (never its text). */
  complaintChanged: boolean | null;
}

export type EdArrivalOutcome = 'arrived' | 'moved_from_waiting_list' | 'already_on_board';

export interface EdArrival {
  outcome: EdArrivalOutcome;
  attendance: EdCard;
  replayed: boolean;
}

export interface EdWrite {
  attendance: EdCard;
  replayed: boolean;
}

export interface EdBoard {
  items: EdCard[];
  counts: { waiting: number; beingSeen: number; disposition: number };
  hasMore: boolean;
  limit: typeof ED_BOARD_LIMIT;
}

export interface EdRecord {
  attendance: EdCard;
  history: EdHistoryEntry[];
}

interface CardRow extends QueryResultRow {
  attendance_id: string | null;
  entry_id: string;
  patient_id: string;
  full_name: string;
  record_kind: string;
  unknown_label: string | null;
  sex: string | null;
  date_of_birth: string | null;
  dob_estimated: boolean;
  health_id_last4: string;
  chart_blocked: boolean;
  arrival_basis: 'search' | 'own_facility' | 'emergency';
  arrival_mode: EdArrivalMode;
  arrived_at: Date;
  minutes_in_department: number;
  board_column: EdColumn;
  stage: string;
  triage_level: number | null;
  triaged_at: Date | null;
  triaged_by_membership_id: string | null;
  presenting_complaint: string | null;
  complaint_hidden: boolean;
  assigned_membership_id: string | null;
  encounter_id: string | null;
  status: EdStatus;
  disposition_outcome: EdOutcome | null;
  decided_at: Date | null;
  decided_by_membership_id: string | null;
  admit_to_department_code: string | null;
  admitting_membership_id: string | null;
  referred_to_facility_name: string | null;
  left_at: Date | null;
  row_version: string;
}

interface OutcomeRow extends CardRow {
  outcome: string;
  replayed: boolean | null;
}

/** The card columns, with the date of birth as text so no time zone is applied to it. */
const CARD_COLUMNS = `attendance_id, entry_id, patient_id, full_name, record_kind, unknown_label, sex,
  date_of_birth::text as date_of_birth, dob_estimated, health_id_last4, chart_blocked, arrival_basis, arrival_mode,
  arrived_at, minutes_in_department, board_column, stage, triage_level, triaged_at, triaged_by_membership_id,
  presenting_complaint, complaint_hidden, assigned_membership_id, encounter_id, status, disposition_outcome, decided_at,
  decided_by_membership_id, admit_to_department_code, admitting_membership_id, referred_to_facility_name, left_at,
  row_version::text as row_version`;

export const ARRIVE_SQL = `select outcome, replayed, ${CARD_COLUMNS}
  from ehr.ed_arrive($1, $2, $3, $4::timestamptz, $5::smallint, $6, $7, $8)`;
export const BOARD_SQL = `select ${CARD_COLUMNS}, has_more, waiting_count, being_seen_count, disposition_count
  from ehr.ed_board($1) order by ord`;
export const READ_SQL = `select outcome, ${CARD_COLUMNS}, history from ehr.ed_read($1)`;
export const TRIAGE_SQL = `select outcome, replayed, ${CARD_COLUMNS}
  from ehr.ed_triage($1, $2, $3::smallint, $4, $5, $6, $7)`;
export const MOVE_SQL = `select outcome, replayed, ${CARD_COLUMNS} from ehr.ed_move($1, $2, $3, $4, $5, $6, $7)`;
export const LINK_VISIT_SQL = `select outcome, replayed, ${CARD_COLUMNS} from ehr.ed_link_visit($1, $2, $3, $4, $5)`;
export const DISPOSITION_SQL = `select outcome, replayed, ${CARD_COLUMNS}
  from ehr.ed_record_disposition($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
export const LEAVE_SQL = `select outcome, replayed, ${CARD_COLUMNS} from ehr.ed_leave($1, $2, $3, $4)`;
export const CANCEL_SQL = `select outcome, replayed, ${CARD_COLUMNS} from ehr.ed_cancel($1, $2, $3, $4, $5)`;

export function edBoardEnabled(): boolean {
  return getEnvironment().ED_BOARD_ENABLED;
}

export function notAvailable(): DomainProblem {
  return new DomainProblem(503, 'ED_BOARD_NOT_AVAILABLE', ED_MESSAGES.notAvailable);
}

/**
 * The access a route needs, checked on the session's codes at this facility
 * before the database decides again: the board (ehr.ed.read) and 0135's pair
 * always, then the route's own code.
 */
export type EdAccess = 'read' | 'arrive' | 'triage' | 'disposition';

export function requireEdAccess(request: HidRequest, access: EdAccess): void {
  const held = new Set(request.actor?.permissions ?? []);
  if (!held.has('ehr.ed.read') || !held.has('ehr.encounter.read') || !held.has('ehr.encounter.write')
      || (access === 'arrive' && !held.has('ehr.ed.arrive'))) {
    throw new DomainProblem(403, 'ED_BOARD_NOT_ALLOWED', ED_MESSAGES.boardNotAllowed);
  }
  if (access === 'triage' && !held.has('ehr.ed.triage')) {
    throw new DomainProblem(403, 'ED_TRIAGE_NOT_ALLOWED', ED_MESSAGES.triageNotAllowed);
  }
  if (access === 'disposition' && !held.has('ehr.ed.disposition')) {
    throw new DomainProblem(403, 'ED_DISPOSITION_NOT_ALLOWED', ED_MESSAGES.dispositionNotAllowed);
  }
}

/** Whether the session may triage (the triage fields of an arrival need it). */
export function canTriage(request: HidRequest): boolean {
  return (request.actor?.permissions ?? []).includes('ehr.ed.triage');
}

function validation(field: string, message: string): DomainProblem {
  return new DomainProblem(400, 'VALIDATION_FAILED', ED_MESSAGES.validation, [{ field, messages: [message] }]);
}

function triageLevelValid(level: number | undefined | null): boolean {
  return level === undefined || level === null || (Number.isInteger(level) && level >= 1 && level <= 5);
}

function reasonValid(reason: string | undefined): boolean {
  return reason !== undefined && reason.length >= 8 && reason.length <= 500 && !/[\u0000-\u001f\u007f]/.test(reason);
}

@Injectable()
export class EdBoardService {
  constructor(private readonly database: DatabaseService) {}

  /** Route 1: put a patient on the board. The database resolves the patient, decides and audits. */
  async arrive(context: DataAccessContext, input: EdArriveDto, idempotencyKey: string): Promise<EdArrival> {
    const matchRef = input.matchRef === undefined || input.matchRef === '' ? null : input.matchRef;
    const patientId = input.patientId ?? null;
    if ((matchRef === null) === (patientId === null)) {
      throw new DomainProblem(400, 'ED_ARRIVAL_NEEDS_ONE_PATIENT', ED_MESSAGES.needsOnePatient);
    }
    if (context.purposeOfUse === 'emergency' && matchRef === null) {
      throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', ED_MESSAGES.directCareOnly);
    }
    if (!triageLevelValid(input.triageLevel)) {
      throw new DomainProblem(400, 'ED_TRIAGE_INVALID', ED_MESSAGES.triageInvalid);
    }
    const digest = requestDigest('ed.arrive', {
      matchRef, patientId, arrivalMode: input.arrivalMode, arrivedAt: input.arrivedAt ?? null,
      triageLevel: input.triageLevel ?? null, presentingComplaint: input.presentingComplaint ?? null,
      purpose: context.purposeOfUse,
    });
    const row = await this.one<OutcomeRow>(context, ARRIVE_SQL, [matchRef, patientId, input.arrivalMode,
      input.arrivedAt ?? null, input.triageLevel ?? null, input.presentingComplaint ?? null, idempotencyKey, digest]);
    if (row && (row.outcome === 'arrived' || row.outcome === 'moved_from_waiting_list'
                || row.outcome === 'already_on_board') && row.attendance_id) {
      return { outcome: row.outcome, attendance: toCard(row), replayed: row.replayed === true };
    }
    throw refusal(row?.outcome);
  }

  /** Route 2: this facility's board, by column, most urgent first, at most 200 cards. Audited per patient shown. */
  async board(context: DataAccessContext, includeClosedToday: boolean): Promise<EdBoard> {
    const rows = await this.query<CardRow & { has_more: boolean; waiting_count: number; being_seen_count: number;
      disposition_count: number }>(context, BOARD_SQL, [includeClosedToday]);
    const first = rows[0];
    return {
      items: rows.map(toCard),
      counts: { waiting: Number(first?.waiting_count ?? 0), beingSeen: Number(first?.being_seen_count ?? 0),
        disposition: Number(first?.disposition_count ?? 0) },
      hasMore: rows.some((row) => row.has_more),
      limit: ED_BOARD_LIMIT,
    };
  }

  /** Route 3: one record and its history (never the complaint's text). */
  async read(context: DataAccessContext, attendanceId: string): Promise<EdRecord> {
    const row = await this.one<CardRow & { outcome: string; history: unknown }>(context, READ_SQL, [attendanceId]);
    if (row?.outcome !== 'found' || !row.attendance_id) throw refusal('not_found');
    return { attendance: toCard(row), history: toHistory(row.history) };
  }

  /** Route 4: triage (level 1-5 on the waiting-list row; the complaint, or null to clear it). */
  async triage(context: DataAccessContext, attendanceId: string, input: EdTriageDto,
    idempotencyKey: string): Promise<EdWrite> {
    if (!triageLevelValid(input.triageLevel)) {
      throw new DomainProblem(400, 'ED_TRIAGE_INVALID', ED_MESSAGES.triageInvalid);
    }
    const setComplaint = input.presentingComplaint !== undefined;
    const digest = requestDigest('ed.triage', { attendanceId, expectedRowVersion: input.expectedRowVersion,
      triageLevel: input.triageLevel, presentingComplaint: setComplaint ? input.presentingComplaint : '(unchanged)' });
    return this.write(context, TRIAGE_SQL, [attendanceId, input.expectedRowVersion, input.triageLevel,
      setComplaint ? input.presentingComplaint : null, setComplaint, idempotencyKey, digest]);
  }

  /** Route 5: the stage and who is seeing the patient ("Start care": with_clinician and the member's own id). */
  async move(context: DataAccessContext, attendanceId: string, input: EdMoveDto, idempotencyKey: string): Promise<EdWrite> {
    if (input.stage === undefined && input.assignedMembershipId === undefined) {
      throw new DomainProblem(400, 'ED_NOTHING_TO_CHANGE', ED_MESSAGES.nothingToChange);
    }
    const clearAssignee = input.assignedMembershipId === null;
    const digest = requestDigest('ed.move', { attendanceId, expectedRowVersion: input.expectedRowVersion,
      stage: input.stage ?? null, assignedMembershipId: input.assignedMembershipId === undefined
        ? '(unchanged)' : input.assignedMembershipId });
    return this.write(context, MOVE_SQL, [attendanceId, input.expectedRowVersion, input.stage ?? null,
      clearAssignee ? null : input.assignedMembershipId ?? null, clearAssignee, idempotencyKey, digest]);
  }

  /** Route 6: link the patient's visit (EHR-C1's emergency visit, opened under the usual chart access). */
  async linkVisit(context: DataAccessContext, attendanceId: string, input: EdLinkVisitDto,
    idempotencyKey: string): Promise<EdWrite> {
    const digest = requestDigest('ed.visit', { attendanceId, expectedRowVersion: input.expectedRowVersion,
      encounterId: input.encounterId });
    return this.write(context, LINK_VISIT_SQL, [attendanceId, input.expectedRowVersion, input.encounterId,
      idempotencyKey, digest]);
  }

  /** Route 7: where the patient goes next. Never completes or changes the visit. */
  async disposition(context: DataAccessContext, attendanceId: string, input: EdDispositionDto,
    idempotencyKey: string): Promise<EdWrite> {
    if (input.outcome !== 'admit_requested'
        && (input.admitToDepartmentCode !== undefined || input.admittingMembershipId !== undefined)) {
      throw validation(input.admitToDepartmentCode !== undefined ? 'admitToDepartmentCode' : 'admittingMembershipId',
        'only for an admission request (outcome admit_requested)');
    }
    if (input.outcome !== 'referred_out' && input.referredToFacilityName !== undefined) {
      throw validation('referredToFacilityName', 'only for a referral (outcome referred_out)');
    }
    if (input.reason !== undefined && !reasonValid(input.reason)) {
      throw new DomainProblem(400, 'ED_REASON_REQUIRED', ED_MESSAGES.reasonRequired);
    }
    const digest = requestDigest('ed.disposition', { attendanceId, expectedRowVersion: input.expectedRowVersion,
      outcome: input.outcome, admitToDepartmentCode: input.admitToDepartmentCode ?? null,
      admittingMembershipId: input.admittingMembershipId ?? null,
      referredToFacilityName: input.referredToFacilityName ?? null, reason: input.reason ?? null });
    return this.write(context, DISPOSITION_SQL, [attendanceId, input.expectedRowVersion, input.outcome,
      input.admitToDepartmentCode ?? null, input.admittingMembershipId ?? null, input.referredToFacilityName ?? null,
      input.reason ?? null, idempotencyKey, digest]);
  }

  /** Route 8: "Left the department" (for an admission request, "Handed over to the ward"). */
  async leave(context: DataAccessContext, attendanceId: string, input: EdLeaveDto,
    idempotencyKey: string): Promise<EdWrite> {
    const digest = requestDigest('ed.leave', { attendanceId, expectedRowVersion: input.expectedRowVersion });
    return this.write(context, LEAVE_SQL, [attendanceId, input.expectedRowVersion, idempotencyKey, digest]);
  }

  /** Route 9: cancel an arrival made in error (open, no visit, no decision), with a reason. */
  async cancel(context: DataAccessContext, attendanceId: string, input: EdCancelDto,
    idempotencyKey: string): Promise<EdWrite> {
    if (!reasonValid(input.reason)) {
      throw new DomainProblem(400, 'ED_REASON_REQUIRED', ED_MESSAGES.reasonRequired);
    }
    const digest = requestDigest('ed.cancel', { attendanceId, expectedRowVersion: input.expectedRowVersion,
      reason: input.reason });
    return this.write(context, CANCEL_SQL, [attendanceId, input.expectedRowVersion, input.reason, idempotencyKey,
      digest]);
  }

  private async write(context: DataAccessContext, sql: string, values: readonly unknown[]): Promise<EdWrite> {
    const row = await this.one<OutcomeRow>(context, sql, values);
    if (row?.outcome === 'updated' && row.attendance_id) {
      return { attendance: toCard(row), replayed: row.replayed === true };
    }
    throw refusal(row?.outcome);
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
      throw translate(error);
    }
  }
}

const iso = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString();

export function toCard(row: CardRow): EdCard {
  return {
    attendanceId: String(row.attendance_id),
    entryId: row.entry_id,
    patientId: row.patient_id,
    fullName: row.full_name,
    recordKind: row.record_kind === 'unknown' ? 'unknown' : 'standard',
    unknownLabel: row.record_kind === 'unknown' ? row.unknown_label : null,
    sex: row.sex,
    dateOfBirth: row.date_of_birth,
    dateOfBirthEstimated: row.dob_estimated === true,
    healthIdLast4: row.health_id_last4,
    chartBlocked: row.chart_blocked === true,
    arrivalBasis: row.arrival_basis === 'own_facility' ? 'own-facility' : row.arrival_basis,
    arrivalMode: row.arrival_mode,
    arrivedAt: iso(row.arrived_at) ?? '',
    minutesInDepartment: Number(row.minutes_in_department),
    column: row.board_column,
    stage: row.stage,
    triageLevel: row.triage_level === null ? null : Number(row.triage_level),
    triagedAt: iso(row.triaged_at),
    triagedByMembershipId: row.triaged_by_membership_id,
    presentingComplaint: row.complaint_hidden ? null : row.presenting_complaint,
    complaintHidden: row.complaint_hidden === true,
    assignedMembershipId: row.assigned_membership_id,
    encounterId: row.encounter_id,
    status: row.status,
    disposition: row.disposition_outcome === null ? null : {
      outcome: row.disposition_outcome,
      decidedAt: iso(row.decided_at) ?? '',
      decidedByMembershipId: String(row.decided_by_membership_id),
      admitToDepartmentCode: row.admit_to_department_code,
      admittingMembershipId: row.admitting_membership_id,
      referredToFacilityName: row.referred_to_facility_name,
    },
    leftAt: iso(row.left_at),
    rowVersion: Number(row.row_version),
  };
}

export function toHistory(value: unknown): EdHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const text = (item: unknown): string | null => typeof item === 'string' ? item : null;
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      kind: entry.kind as EdHistoryEntry['kind'],
      at: iso(text(entry.at)) ?? '',
      byMembershipId: text(entry.byMembershipId),
      fromStage: text(entry.fromStage),
      toStage: text(entry.toStage),
      triageLevel: typeof entry.triageLevel === 'number' ? entry.triageLevel : null,
      outcome: text(entry.outcome) as EdOutcome | null,
      reason: text(entry.reason),
      complaintChanged: typeof entry.complaintChanged === 'boolean' ? entry.complaintChanged : null,
    }));
}

/** An answer that refuses, in plain words. The same 403 for every reason a patient cannot be added. */
export function refusal(outcome: string | undefined): DomainProblem {
  switch (outcome) {
    case 'needs_search':
      return new DomainProblem(403, 'ED_ARRIVAL_NEEDS_SEARCH', ED_MESSAGES.needsSearch);
    case 'time_invalid':
      return new DomainProblem(400, 'ED_ARRIVAL_TIME_INVALID', ED_MESSAGES.timeInvalid);
    case 'key_reused':
      return new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', ED_MESSAGES.keyReused);
    case 'closed':
      return new DomainProblem(409, 'ED_ATTENDANCE_CLOSED', ED_MESSAGES.closed);
    case 'decided':
      return new DomainProblem(409, 'ED_ATTENDANCE_DECIDED', ED_MESSAGES.decided);
    case 'not_decided':
      return new DomainProblem(409, 'ED_ATTENDANCE_NOT_DECIDED', ED_MESSAGES.notDecided);
    case 'cancel_not_allowed':
      return new DomainProblem(409, 'ED_CANCEL_NOT_ALLOWED', ED_MESSAGES.cancelNotAllowed);
    case 'changed':
      return new DomainProblem(412, 'ED_VERSION_CONFLICT', ED_MESSAGES.versionConflict);
    case 'assignee_invalid':
      return new DomainProblem(400, 'ED_ASSIGNEE_INVALID', ED_MESSAGES.assigneeInvalid);
    case 'visit_invalid':
      return new DomainProblem(400, 'ED_VISIT_INVALID', ED_MESSAGES.visitInvalid);
    case 'admit_department_invalid':
      return new DomainProblem(400, 'ED_ADMIT_DEPARTMENT_INVALID', ED_MESSAGES.admitDepartmentInvalid);
    case 'admitting_invalid':
      return validation('admittingMembershipId', 'choose an active clinician or doctor of this facility');
    case 'reason_required':
      return new DomainProblem(400, 'ED_REASON_REQUIRED', ED_MESSAGES.reasonRequired);
    default:
      return new DomainProblem(404, 'ED_ATTENDANCE_NOT_FOUND', ED_MESSAGES.notFound);
  }
}

/** The functions' own refusals, in plain words; anything else is passed on. */
export function translate(error: unknown): unknown {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  if (code === '42501' && message === 'ED_TRIAGE_NOT_ALLOWED') {
    return new DomainProblem(403, 'ED_TRIAGE_NOT_ALLOWED', ED_MESSAGES.triageNotAllowed);
  }
  if (code === '42501' && message === 'ED_DISPOSITION_NOT_ALLOWED') {
    return new DomainProblem(403, 'ED_DISPOSITION_NOT_ALLOWED', ED_MESSAGES.dispositionNotAllowed);
  }
  if (code === '42501') {
    return new DomainProblem(403, 'ED_BOARD_NOT_ALLOWED', ED_MESSAGES.boardNotAllowed);
  }
  if (code === '22023') {
    switch (message) {
      case 'ED_DIRECT_CARE_ONLY':
        return new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', ED_MESSAGES.directCareOnly);
      case 'ED_ARRIVAL_NEEDS_ONE_PATIENT':
        return new DomainProblem(400, 'ED_ARRIVAL_NEEDS_ONE_PATIENT', ED_MESSAGES.needsOnePatient);
      case 'ED_TRIAGE_INVALID':
        return new DomainProblem(400, 'ED_TRIAGE_INVALID', ED_MESSAGES.triageInvalid);
      case 'ED_NOTHING_TO_CHANGE':
        return new DomainProblem(400, 'ED_NOTHING_TO_CHANGE', ED_MESSAGES.nothingToChange);
      case 'ED_REASON_REQUIRED':
        return new DomainProblem(400, 'ED_REASON_REQUIRED', ED_MESSAGES.reasonRequired);
      case 'ED_IDEMPOTENCY_KEY_INVALID':
        return new DomainProblem(400, 'IDEMPOTENCY_KEY_REQUIRED',
          'Idempotency-Key must contain 16 to 128 URL-safe characters');
      default:
        return new DomainProblem(400, 'VALIDATION_FAILED', ED_MESSAGES.validation);
    }
  }
  if (code === '40P01') {
    // A close on the waiting list at the same moment as a board write for the same patient (0168's header).
    return new DomainProblem(412, 'ED_VERSION_CONFLICT', ED_MESSAGES.versionConflict);
  }
  if (code === '42883' || code === '42P01') {
    // A new image on a schema without 0168: the routes stay closed until the migration is applied.
    return notAvailable();
  }
  return error;
}
