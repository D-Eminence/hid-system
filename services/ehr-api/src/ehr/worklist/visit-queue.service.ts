import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import type { CheckInToVisitQueueDto, UpdateVisitQueueEntryDto, VisitQueueStage } from './visit-queue.dto';

/** EHR-C7 (0135): at most this many cards in one list answer. */
export const VISIT_QUEUE_LIST_LIMIT = 200;

/**
 * One waiting-list card: identity details only, never clinical content and
 * never a Health ID (its last 4 characters only). `patientId` is a UUID for
 * opening the chart, which still needs the patient's consent (or the
 * own-facility rule).
 */
export interface VisitQueueCard {
  entryId: string;
  patientId: string;
  fullName: string;
  sex: string | null;
  dateOfBirth: string | null;
  healthIdLast4: string;
  stage: VisitQueueStage;
  triageLevel: number | null;
  assignedMembershipId: string | null;
  /** How the patient was checked in: from a search, or already this facility's patient. */
  checkInBasis: 'search' | 'own-facility';
  checkedInAt: string;
  /** The Lagos calendar day of the check-in (YYYY-MM-DD). */
  checkInDay: string;
  stageChangedAt: string;
  closedAt: string | null;
  rowVersion: number;
  /** A deny directive covers this facility: the patient stays listed, the chart cannot be opened. */
  chartBlocked: boolean;
  /** 0145 (ID-7): an unknown patient record shows its fullName ("Unknown patient U-0007") and label. */
  recordKind: 'standard' | 'unknown';
  /** 0145 (ID-7): the date of birth is estimated (an unknown record's age). */
  dateOfBirthEstimated: boolean;
}

export interface VisitQueueCheckIn {
  outcome: 'checked_in' | 'already_on_list';
  entry: VisitQueueCard;
}

export interface VisitQueueList {
  items: VisitQueueCard[];
  /** More rows than the limit: the rest are not shown (the least urgent, latest). */
  hasMore: boolean;
  limit: typeof VISIT_QUEUE_LIST_LIMIT;
}

interface CardRow extends QueryResultRow {
  entry_id: string;
  patient_id: string;
  full_name: string;
  sex: string | null;
  date_of_birth: string | null;
  health_id_last4: string;
  stage: VisitQueueStage;
  triage_level: number | null;
  assigned_membership_id: string | null;
  check_in_basis: 'search' | 'own_facility';
  checked_in_at: Date;
  queue_day: string;
  stage_changed_at: Date;
  closed_at: Date | null;
  row_version: string;
  chart_blocked: boolean;
  record_kind?: string | null;
  dob_estimated?: boolean | null;
}

interface OutcomeRow extends CardRow {
  outcome: string;
}

/** The card columns, with dates as text so no time zone is applied to them. */
const CARD_COLUMNS = `entry_id, patient_id, full_name, sex, date_of_birth::text as date_of_birth, health_id_last4,
  stage, triage_level, assigned_membership_id, check_in_basis, checked_in_at, queue_day::text as queue_day,
  stage_changed_at, closed_at, row_version::text as row_version, chart_blocked`;

export const CHECK_IN_SQL = `select outcome, ${CARD_COLUMNS} from ehr.visit_queue_check_in($1, $2)`;
/** 0145 (ID-7): the record kinds of the cards' entries, read only where 0145 is applied. */
export const RECORD_KINDS_PRESENT_SQL =
  `select to_regprocedure('ehr.visit_queue_record_kinds(uuid[])') is not null as present`;
export const RECORD_KINDS_SQL =
  'select entry_id::text as entry_id, record_kind, dob_estimated from ehr.visit_queue_record_kinds($1::uuid[])';
export const LIST_SQL = `select ${CARD_COLUMNS}, has_more from ehr.visit_queue_list($1) order by ord`;
export const UPDATE_SQL = `select outcome, ${CARD_COLUMNS}
  from ehr.visit_queue_update($1, $2, $3, $4::smallint, $5, $6, $7)`;

/** The one answer for every refused check-in, so it never tells whether a patient exists. */
export function checkInRefused(): DomainProblem {
  return new DomainProblem(403, 'CHECK_IN_NEEDS_SEARCH',
    'Search for the patient first, then check them in. A search result can be used for 10 minutes.');
}

@Injectable()
export class VisitQueueService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Checks a patient in. The database function decides and audits (a refusal
   * too, so the transaction commits before the refusal is answered).
   */
  async checkIn(context: DataAccessContext, input: CheckInToVisitQueueDto): Promise<VisitQueueCheckIn> {
    const matchRef = input.matchRef === undefined || input.matchRef === '' ? null : input.matchRef;
    const patientId = input.patientId ?? null;
    if ((matchRef === null) === (patientId === null)) {
      throw new DomainProblem(400, 'CHECK_IN_NEEDS_ONE_PATIENT',
        'Give the search result (matchRef) or, for this facility\'s own patient, the patient id. Not both.');
    }
    const row = await this.call<OutcomeRow>(context, CHECK_IN_SQL, [matchRef, patientId]);
    if (!row || (row.outcome !== 'checked_in' && row.outcome !== 'already_open')) throw checkInRefused();
    return { outcome: row.outcome === 'already_open' ? 'already_on_list' : 'checked_in', entry: toCard(row) };
  }

  /** This facility's waiting list, most urgent first, at most 200 cards. Audited per patient shown. */
  async list(context: DataAccessContext, includeClosedToday: boolean): Promise<VisitQueueList> {
    const rows = await this.query<CardRow & { has_more: boolean }>(context, LIST_SQL, [includeClosedToday]);
    return { items: rows.map(toCard), hasMore: rows.some((row) => row.has_more), limit: VISIT_QUEUE_LIST_LIMIT };
  }

  /** Moves a row between stages, closes it, or sets or clears its triage level or assignee. */
  async update(context: DataAccessContext, entryId: string, input: UpdateVisitQueueEntryDto): Promise<VisitQueueCard> {
    const clearTriage = input.triageLevel === null;
    const clearAssignee = input.assignedMembershipId === null;
    if (input.stage === undefined && input.triageLevel === undefined && input.assignedMembershipId === undefined) {
      throw new DomainProblem(400, 'VISIT_QUEUE_NOTHING_TO_CHANGE',
        'Choose a stage, a triage level or a person to see the patient.');
    }
    const row = await this.call<OutcomeRow>(context, UPDATE_SQL, [
      entryId, input.expectedRowVersion, input.stage ?? null, clearTriage ? null : input.triageLevel ?? null,
      clearTriage, clearAssignee ? null : input.assignedMembershipId ?? null, clearAssignee,
    ]);
    switch (row?.outcome) {
      case 'updated':
        return toCard(row);
      case 'changed':
        throw new DomainProblem(409, 'VISIT_QUEUE_ENTRY_CHANGED',
          'Someone else changed this patient\'s place on the waiting list. Reload the list and try again.');
      case 'closed':
        throw new DomainProblem(409, 'VISIT_QUEUE_ENTRY_CLOSED',
          'This patient is no longer on the waiting list. Check them in again if they are back.');
      case 'assignee_invalid':
        throw new DomainProblem(400, 'VISIT_QUEUE_ASSIGNEE_INVALID',
          'Choose a nurse, clinician or doctor who works at this facility.');
      default:
        throw new DomainProblem(404, 'VISIT_QUEUE_ENTRY_NOT_FOUND', 'This waiting list entry was not found.');
    }
  }

  private async call<Row extends QueryResultRow>(context: DataAccessContext, sql: string,
    values: readonly unknown[]): Promise<Row | undefined> {
    return (await this.query<Row>(context, sql, values))[0];
  }

  private async query<Row extends QueryResultRow>(context: DataAccessContext, sql: string,
    values: readonly unknown[]): Promise<Row[]> {
    try {
      return await this.database.withTransaction(context, async (client: PoolClient) => {
        const rows = (await client.query<Row>(sql, [...values])).rows;
        const entryIds = rows.map((row) => (row as { entry_id?: unknown }).entry_id).filter(
          (id): id is string => typeof id === 'string');
        if (entryIds.length === 0
            || (await client.query<{ present: boolean }>(RECORD_KINDS_PRESENT_SQL)).rows[0]?.present !== true) {
          return rows;
        }
        const kinds = new Map((await client.query<{ entry_id: string; record_kind: string; dob_estimated: boolean }>(
          RECORD_KINDS_SQL, [entryIds])).rows.map((kind) => [kind.entry_id, kind]));
        return rows.map((row) => {
          const kind = kinds.get(String((row as { entry_id?: unknown }).entry_id));
          return kind ? { ...row, record_kind: kind.record_kind, dob_estimated: kind.dob_estimated } : row;
        });
      });
    } catch (error) {
      throw translate(error);
    }
  }
}

function toCard(row: CardRow): VisitQueueCard {
  return {
    entryId: row.entry_id,
    patientId: row.patient_id,
    fullName: row.full_name,
    sex: row.sex,
    dateOfBirth: row.date_of_birth,
    healthIdLast4: row.health_id_last4,
    stage: row.stage,
    triageLevel: row.triage_level === null ? null : Number(row.triage_level),
    assignedMembershipId: row.assigned_membership_id,
    checkInBasis: row.check_in_basis === 'own_facility' ? 'own-facility' : 'search',
    checkedInAt: new Date(row.checked_in_at).toISOString(),
    checkInDay: row.queue_day,
    stageChangedAt: new Date(row.stage_changed_at).toISOString(),
    closedAt: row.closed_at === null ? null : new Date(row.closed_at).toISOString(),
    rowVersion: Number(row.row_version),
    chartBlocked: row.chart_blocked === true,
    recordKind: row.record_kind === 'unknown' ? 'unknown' : 'standard',
    dateOfBirthEstimated: row.dob_estimated === true,
  };
}

/** The functions' own refusals, in plain words; anything else is passed on. */
export function translate(error: unknown): unknown {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  if (code === '42501') {
    return new DomainProblem(403, 'VISIT_QUEUE_NOT_PERMITTED',
      'Only the front desk, nurses, clinicians and doctors of this facility can use the waiting list.');
  }
  if (code === '22023' && message === 'VISIT_QUEUE_DIRECT_CARE_ONLY') {
    return new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', 'X-Purpose-Of-Use must be direct-care for the waiting list');
  }
  if (code === '22023' && message === 'VISIT_QUEUE_CHECK_IN_INVALID') {
    return new DomainProblem(400, 'CHECK_IN_NEEDS_ONE_PATIENT',
      'Give the search result (matchRef) or, for this facility\'s own patient, the patient id. Not both.');
  }
  if (code === '22023' && message === 'VISIT_QUEUE_UPDATE_INVALID') {
    return new DomainProblem(400, 'VISIT_QUEUE_UPDATE_INVALID',
      'Choose a stage, a triage level from 1 to 5, or a person to see the patient.');
  }
  if (code === '42883' || code === '42P01') {
    // A new image on a schema without 0135: the routes stay closed until the migration is applied.
    return new DomainProblem(503, 'VISIT_QUEUE_UNAVAILABLE', 'The waiting list is not available yet. Try again later.');
  }
  return error;
}
