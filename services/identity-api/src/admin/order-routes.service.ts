import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../common/problem';
import type { PlatformAdminContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { ReviewWrongPatientReportDto } from './dto/order-route-admin.dto';

const REFERENCE = /^[0-9A-F]{8}$/;
const HEALTH_ID = /^HID-[A-HJ-NP-Z2-9]{6,32}$/;

interface FoundRouteRow extends QueryResultRow {
  route_id: string;
  reference: string;
  kind: string;
  row_version: string | number;
  effective_state: string;
  ordering_facility_id: string;
  ordering_facility_name: string;
  receiving_facility_id: string;
  receiving_facility_name: string;
  created_at: Date | string;
  accepted_at: Date | string | null;
  ended_at: Date | string | null;
  ended_kind: string | null;
  /** Item 4 (0089): when the receiving facility's access ends; null before acceptance. Absent on an earlier schema. */
  access_ends_at?: Date | string | null;
  /** Item 4 (0089): whether support's Close would act now, at the database clock. Absent on an earlier schema. */
  closable?: boolean | null;
  /**
   * D17 (0090): whether the receiver may still withdraw what it sent back
   * (`not_accepted | open | correctable | reported | receiver_released |
   * too_late`), the deadline (also past, for too_late; null for not_accepted,
   * reported and receiver_released), and the receiver's report, if any.
   * Absent on an earlier schema.
   */
  correction?: string | null;
  correctable_until?: Date | string | null;
  wrong_patient_reported_at?: Date | string | null;
  wrong_patient_late?: boolean | null;
}

/** A row of C26 (`identity.admin_list_wrong_patient_reports`, item 3 §5.2). */
interface WrongPatientReportRow extends QueryResultRow {
  report_id: string;
  row_version: string | number;
  route_id: string;
  reference: string;
  kind: string;
  receiving_facility_id: string;
  receiving_facility_name: string | null;
  ordering_facility_id: string;
  ordering_facility_name: string | null;
  reported_at: Date | string;
  reported_by_account_id: string;
  reported_by_name: string | null;
  accepted_by_account_id: string;
  accepted_by_name: string | null;
  same_member: boolean;
  accepted_with: string;
  accepted_at: Date | string;
  reason_code: string;
  note: string;
  note_removed: boolean;
  state_before: string;
  results_voided: number | string;
  result_reports_marked: number | string;
  dispensing_reversed: boolean;
  specimens_collected: number | string;
  recorded_by: unknown;
  reporter_recorded_work: boolean;
  flags: string[] | null;
  facility_reports_last_30_days: number | string;
  member_reports_last_30_days: number | string;
  reviewed_at: Date | string | null;
  reviewed_by_account_id: string | null;
  reviewed_by_name: string | null;
  review_actions: string[] | null;
  review_note: string | null;
  /** D17 (0090): the seven trailing columns of a late report's facts. Absent on an earlier schema. */
  late?: boolean;
  ended_kind_before?: string | null;
  discovered_by?: string | null;
  discovered_on?: Date | string | null;
  reporter_late_reports_last_30_days?: number | string | null;
  ordering_sender_active?: boolean | null;
  required_actions?: string[] | null;
}

/** Who recorded the work (C6): `[{ accountId, name }]` from C26's jsonb, nothing else of each entry. */
function recordedBy(value: unknown): { accountId: string; name: string | null }[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { accountId, name } = entry as { accountId?: unknown; name?: unknown };
    return typeof accountId === 'string' ? [{ accountId, name: typeof name === 'string' ? name : null }] : [];
  });
}

/**
 * A `date` as yyyy-mm-dd. node-postgres parses a `date` column into a Date at
 * local midnight, so the local calendar fields are the stored date whatever
 * the process's time zone (toISOString would shift it east of UTC).
 */
function day(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return typeof value === 'string' ? value : null;
}

/** What C27 requires before a report is marked reviewed (D17-6), in C26's order. */
const REQUIRED_ACTIONS = ['referred_to_dpo', 'ordering_facility_told'] as const;

/**
 * D17 (0090): a late report's facts, each only when the schema answers it:
 * whether it came after the order had ended, how the order had ended before,
 * how and when the receiver found out, the reporter's own late reports in 30
 * days, whether the sender is still at the ordering facility, and what the
 * review requires (`referred_to_dpo`, `ordering_facility_told`).
 */
function lateReportFacts(row: WrongPatientReportRow) {
  if (!('late' in row)) return {};
  return {
    late: row.late === true,
    endedKindBefore: row.ended_kind_before ?? null,
    discoveredBy: row.discovered_by ?? null,
    discoveredOn: day(row.discovered_on),
    reporterLateReportsLast30Days: Number(row.reporter_late_reports_last_30_days ?? 0),
    orderingSenderActive: row.ordering_sender_active === true,
    requiredActions: Array.isArray(row.required_actions)
      ? REQUIRED_ACTIONS.filter((action) => row.required_actions!.includes(action)) : [],
  };
}

/** A C26 row as support's list shows it (item 3 §5.2), built field by field: no patient, no order content. */
function wrongPatientReport(row: WrongPatientReportRow) {
  return {
    reportId: row.report_id,
    version: Number(row.row_version),
    routeId: row.route_id,
    reference: row.reference,
    kind: row.kind,
    receivingFacility: { id: row.receiving_facility_id, name: row.receiving_facility_name },
    orderingFacility: { id: row.ordering_facility_id, name: row.ordering_facility_name },
    reportedAt: iso(row.reported_at),
    reportedBy: { accountId: row.reported_by_account_id, name: row.reported_by_name },
    acceptedBy: { accountId: row.accepted_by_account_id, name: row.accepted_by_name },
    sameMember: row.same_member === true,
    acceptedWith: row.accepted_with,
    acceptedAt: iso(row.accepted_at),
    reason: row.reason_code,
    note: row.note,
    noteRemoved: row.note_removed === true,
    stateBefore: row.state_before,
    resultsVoided: Number(row.results_voided),
    resultReportsMarked: Number(row.result_reports_marked),
    dispensingReversed: row.dispensing_reversed === true,
    specimensCollected: Number(row.specimens_collected),
    recordedBy: recordedBy(row.recorded_by),
    reporterRecordedWork: row.reporter_recorded_work === true,
    flags: Array.isArray(row.flags) ? row.flags : [],
    facilityReportsLast30Days: Number(row.facility_reports_last_30_days),
    memberReportsLast30Days: Number(row.member_reports_last_30_days),
    ...lateReportFacts(row),
    review: row.reviewed_at === null || row.reviewed_at === undefined ? null : {
      reviewedAt: iso(row.reviewed_at),
      reviewedBy: { accountId: row.reviewed_by_account_id, name: row.reviewed_by_name },
      actions: Array.isArray(row.review_actions) ? row.review_actions : [],
      note: row.review_note,
    },
  };
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Support's counts of the orders a facility accepted and then ended because
 * it couldn't complete them (C32, D18-11), over the last 30 days at that
 * facility: all of them, within an hour of acceptance with nothing recorded,
 * 7 days or more after acceptance, later reported as accepted for the wrong
 * person (D18-12), and by reason. Counts only: no patient, order or member.
 */
export interface FacilityNotCompleted {
  last30Days: number;
  soonAfterAcceptance: number;
  afterSevenDays: number;
  laterReportedWrongPatient: number;
  byReason: Record<string, number>;
}

const COUNT_KEYS = ['last30Days', 'soonAfterAcceptance', 'afterSevenDays', 'laterReportedWrongPatient'] as const;
/** A reason code as 0091's endings table holds it. */
const REASON_CODE = /^[a-z][a-z_]{0,63}$/;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * C32's jsonb as support's facility panel shows it, built key by key: the
 * four counts and `byReason`, each a non-negative integer, or undefined when
 * any of it is missing or of another type (never a made-up zero).
 */
export function facilityNotCompleted(value: unknown): FacilityNotCompleted | undefined {
  let answer: Record<string, unknown> | undefined;
  try {
    answer = parse(value);
  } catch {
    return undefined;
  }
  if (!answer || !COUNT_KEYS.every((key) => isCount(answer![key]))) return undefined;
  const reasons = answer.byReason;
  if (typeof reasons !== 'object' || reasons === null || Array.isArray(reasons)) return undefined;
  const byReason = Object.entries(reasons as Record<string, unknown>);
  if (!byReason.every(([code, count]) => REASON_CODE.test(code) && isCount(count))) return undefined;
  return { last30Days: answer.last30Days as number, soonAfterAcceptance: answer.soonAfterAcceptance as number,
    afterSevenDays: answer.afterSevenDays as number, laterReportedWrongPatient: answer.laterReportedWrongPatient as number,
    byReason: Object.fromEntries(byReason) as Record<string, number> };
}

function sqlState(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
}

const lookupInvalid = () => new DomainProblem(400, 'ORDER_ROUTE_LOOKUP_INVALID',
  'Enter an order reference (8 characters) or a patient Health ID, not both');

const unavailable = () => new DomainProblem(503, 'ORDER_ROUTES_ADMIN_UNAVAILABLE',
  'Orders between facilities could not be read or changed');

/**
 * Support's tools for orders between facilities (P4c, SPEC-FINAL §8.7
 * C20-C23, §10.4): a facility's summary, listing it for orders or not,
 * finding a route and closing it. Platform transactions, so a standalone
 * platform administrator works; the commands check the permissions and write
 * their own platform and facility audit rows.
 */
@Injectable()
export class AdminOrderRoutesService {
  private readonly logger = new Logger(AdminOrderRoutesService.name);

  constructor(private readonly database: DatabaseService) {}

  /**
   * C20: listing, what the facility is as a destination (`destination
   * { receivingTypes, review }`, item 4, 0089: its active laboratory or
   * pharmacy products and its sign-up's review, no verification method),
   * lifetime counts and 30 days per counterpart; no patient, no order
   * content. The database's object is answered as it is, so an earlier
   * schema answers without `destination`.
   *
   * D18 (0091): then, in the same read-only transaction, support's counts of
   * the orders the facility couldn't complete (C32, `notCompleted`) and
   * `cannotComplete: true`, which says this backend serves "We can't complete
   * this order". C20 itself is unchanged (a3b1822's verifier asserts its
   * exact keys), so the counts come from their own function, read in a
   * savepoint: on any failure (a schema without 0091, an unreadable answer)
   * both are left out, the SQLSTATE alone is logged, and the summary still
   * answers.
   */
  async summary(context: PlatformAdminContext, facilityId: string) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const result = await client.query<{ summary: unknown }>(
          'select identity.admin_order_route_summary($1) as summary', [facilityId]);
        const summary = parse(result.rows[0]?.summary);
        if (!summary) throw new DomainProblem(404, 'ADMIN_FACILITY_NOT_FOUND', 'Facility was not found');
        const notCompleted = await this.notCompleted(client, facilityId, context.correlationId);
        return { facilityId, ...summary, ...(notCompleted ? { notCompleted, cannotComplete: true as const } : {}) };
      }, { readOnly: true });
    } catch (error) {
      throw adminOrderRouteProblem(error, 'facility');
    }
  }

  /** C32 in the summary's transaction, in a savepoint; undefined (and a logged SQLSTATE) on any failure. */
  private async notCompleted(client: PoolClient, facilityId: string, correlationId: string) {
    await client.query('savepoint admin_order_route_not_completed');
    let value: unknown;
    try {
      const result = await client.query<{ not_completed: unknown }>(
        'select identity.admin_order_route_not_completed($1) as not_completed', [facilityId]);
      await client.query('release savepoint admin_order_route_not_completed');
      value = result.rows[0]?.not_completed;
    } catch (error) {
      await client.query('rollback to savepoint admin_order_route_not_completed');
      this.logger.warn({ message: 'The counts of orders a facility could not complete could not be read',
        sqlState: sqlState(error), correlationId });
      return undefined;
    }
    const counts = facilityNotCompleted(value);
    if (!counts) {
      this.logger.warn({ message: 'The counts of orders a facility could not complete were unreadable', correlationId });
    }
    return counts;
  }

  /** C23: list or unlist the facility for orders from other facilities; accepted work is unaffected. */
  async setDestination(context: PlatformAdminContext, facilityId: string, listed: boolean, reason: string) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const result = await client.query<{ facility_id: string; listed: boolean; set_at: Date | string }>(
          `select facility_id::text as facility_id, listed, set_at
             from identity.admin_set_order_route_destination($1, $2, $3)`, [facilityId, listed, reason]);
        const row = result.rows[0];
        if (!row) throw unavailable();
        return { facilityId: row.facility_id, listed: row.listed, setAt: iso(row.set_at) };
      });
    } catch (error) {
      throw adminOrderRouteProblem(error, 'facility');
    }
  }

  /**
   * C21: by reference (at most 5 routes) or by Health ID (at most 20), exactly
   * one of them. `wrongPatientReports: true` says this backend lets the
   * receiving laboratory or pharmacy end an order it accepted for the wrong
   * person (item 3, 0088): only then does support's Close form ask support to
   * have such an order ended there first. An earlier Identity sends no such
   * field, and the form keeps its earlier wording (D15).
   *
   * Item 4 (0089): each route also answers `accessEndsAt` (when the
   * receiving facility's access ends, null before acceptance) and `closable`
   * (whether Close would act now: C22's own refusal, negated, at the database
   * clock). The query selects every column, so on a schema without 0089 (or
   * a later one that restores 0086's lookup) both are left out, never a
   * made-up `closable: false`, and the lookup still answers.
   *
   * D17 (0090): each route also answers `correction` (whether the receiver
   * may still withdraw what it sent back: not_accepted, open, correctable,
   * reported, receiver_released (its organization was released, so no
   * member can act) or too_late), `correctableUntil` (the deadline; already
   * past for too_late) and `wrongPatient` (`{ reportedAt, late }` or null), each only
   * when the schema answers it, and the answer adds `lateCorrection: true`,
   * so support's console learns this backend serves the late correction.
   *
   * D18 (0091): the answer adds `cannotComplete: true`, so support's console
   * learns this backend serves "We can't complete this order" (an order ended
   * that way is found as any other: `cancelled`, `receiving_unable`).
   */
  async find(context: PlatformAdminContext, reference: string | undefined, healthId: string | undefined) {
    const byReference = reference ? reference.toUpperCase() : null;
    const byHealthId = healthId ? healthId.toUpperCase() : null;
    if ((byReference === null) === (byHealthId === null)) throw lookupInvalid();
    if (byReference !== null && !REFERENCE.test(byReference)) throw lookupInvalid();
    if (byHealthId !== null && !HEALTH_ID.test(byHealthId)) throw lookupInvalid();
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        // node-postgres answers uuid and bigint as text, as the earlier casts did.
        const result = await client.query<FoundRouteRow>(
          'select * from identity.admin_find_order_routes($1, $2)', [byReference, byHealthId]);
        return { items: result.rows.map((row) => ({
          routeId: row.route_id, reference: row.reference, kind: row.kind, version: Number(row.row_version),
          effectiveState: row.effective_state, orderingFacilityId: row.ordering_facility_id,
          orderingFacilityName: row.ordering_facility_name, receivingFacilityId: row.receiving_facility_id,
          receivingFacilityName: row.receiving_facility_name, createdAt: iso(row.created_at),
          acceptedAt: iso(row.accepted_at), endedAt: iso(row.ended_at), endedKind: row.ended_kind,
          ...('access_ends_at' in row ? { accessEndsAt: iso(row.access_ends_at ?? null) } : {}),
          ...(typeof row.closable === 'boolean' ? { closable: row.closable } : {}),
          ...('correction' in row ? { correction: row.correction ?? null } : {}),
          ...('correctable_until' in row ? { correctableUntil: iso(row.correctable_until ?? null) } : {}),
          ...('wrong_patient_reported_at' in row ? { wrongPatient: wrongPatientOf(row) } : {}),
        })), wrongPatientReports: true, lateCorrection: true, cannotComplete: true };
      }, { readOnly: true });
    } catch (error) {
      throw adminOrderRouteProblem(error, 'lookup');
    }
  }

  /**
   * C26 (item 3 §5.2): support's wrong-patient reports, `unreviewed` (flagged
   * first, then oldest first) or `recent` (90 days, newest first), at most
   * 200, optionally of one receiving facility. Read-only; the interceptor
   * audits it (admin.wrong-patient-reports.list), never naming a note. D17
   * (0090): late reports carry their facts (`lateReportFacts`), and the
   * answer adds `lateCorrection: true`.
   *
   * D18-12 (0091, C26 unchanged): a report made after the receiver ended the
   * order because it couldn't complete it is a late report like any other:
   * it carries the `late_correction` flag, so it is listed among the flagged
   * reports, first; `endedKindBefore: 'receiving_unable'` names the earlier
   * ending. The rows are answered in C26's order, never re-sorted here.
   */
  async listWrongPatientReports(context: PlatformAdminContext, status: 'unreviewed' | 'recent', facilityId?: string) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const result = await client.query<WrongPatientReportRow>(
          'select * from identity.admin_list_wrong_patient_reports($1, $2)', [status, facilityId ?? null]);
        return { items: result.rows.map(wrongPatientReport), lateCorrection: true };
      }, { readOnly: true });
    } catch (error) {
      throw adminOrderRouteProblem(error, 'facility');
    }
  }

  /**
   * C27 (item 3 §5.2): mark a report reviewed, once, with what support did and
   * a note; optionally replace the reporter's note with fixed text. The
   * command writes the platform audit row (the review note is its reason).
   */
  async reviewWrongPatientReport(context: PlatformAdminContext, reportId: string, expectedVersion: number,
    input: ReviewWrongPatientReportDto) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const result = await client.query<{ report_id: string; row_version: string | number; reviewed_at: Date | string;
          review_actions: string[] | null; note_removed: boolean }>(
          `select report_id::text as report_id, row_version, reviewed_at, review_actions, note_removed
             from identity.admin_review_wrong_patient_report($1, $2, $3::text[], $4, $5)`,
          [reportId, expectedVersion, input.actions, input.note, input.removeNote === true]);
        const row = result.rows[0];
        if (!row) throw unavailable();
        return { reportId: row.report_id, version: Number(row.row_version), reviewedAt: iso(row.reviewed_at),
          actions: Array.isArray(row.review_actions) ? row.review_actions : [], noteRemoved: row.note_removed === true };
      });
    } catch (error) {
      throw adminOrderRouteProblem(error, 'report');
    }
  }

  /** C22: close a live route (access ends now, both facilities and the patient told). */
  async close(context: PlatformAdminContext, routeId: string, expectedVersion: number, reason: string) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const result = await client.query<{ route_id: string; row_version: string | number; state: string }>(
          `select route_id::text as route_id, row_version, state
             from identity.admin_close_order_route($1, $2, $3)`, [routeId, expectedVersion, reason]);
        const row = result.rows[0];
        if (!row) throw unavailable();
        return { routeId: row.route_id, version: Number(row.row_version), effectiveState: row.state };
      });
    } catch (error) {
      throw adminOrderRouteProblem(error, 'route');
    }
  }
}

/** The receiver's report on a found route (D17): `{ reportedAt, late }`, or null when it has none. */
function wrongPatientOf(row: FoundRouteRow): { reportedAt: string; late: boolean } | null {
  const reportedAt = iso(row.wrong_patient_reported_at ?? null);
  return reportedAt ? { reportedAt, late: row.wrong_patient_late === true } : null;
}

/**
 * C27's refusal when a late report's required actions are missing (D17-6):
 * 400 with the missing ones as the problem member `required` (the DETAIL,
 * comma-separated, `referred_to_dpo` first), kept to the known actions.
 */
function referralRequired(error: unknown): DomainProblem {
  const detail = (error as { detail?: unknown }).detail;
  const named = typeof detail === 'string' ? detail.split(',').map((action) => action.trim()) : [];
  const required = REQUIRED_ACTIONS.filter((action) => named.includes(action)).join(',');
  return new DomainProblem(400, 'WRONG_PATIENT_REVIEW_REFERRAL_REQUIRED',
    'This report came after the order had ended: record "Referred to the DPO" and, where the order had come back, '
      + '"Ordering facility told" before marking it reviewed', undefined,
    required ? { extensions: { required } } : undefined);
}

function parse(value: unknown): Record<string, unknown> | undefined {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

/**
 * The commands' refusals (SPEC-FINAL §8.7 C20-C23, §10.4, §11), as the
 * neighbouring admin commands answer them: 42501 403 PERMISSION_DENIED, a
 * version conflict 409 VERSION_CONFLICT (P4b's admin convention, 40001).
 * Item 3: support's wrong-patient list (C26) uses the `facility` scope (an
 * unknown facility is 404 ADMIN_FACILITY_NOT_FOUND, B8); the review (C27) the
 * `report` scope, where D17's 22023 WRONG_PATIENT_REVIEW_REFERRAL_REQUIRED is
 * 400 with the problem member `required`.
 */
export function adminOrderRouteProblem(error: unknown, scope: 'facility' | 'lookup' | 'route' | 'report'): unknown {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message : '';
  switch (code) {
    case '42501':
      return new DomainProblem(403, 'PERMISSION_DENIED', 'Administrative permission is missing');
    case 'P0002':
      if (scope === 'report') {
        return new DomainProblem(404, 'WRONG_PATIENT_REPORT_NOT_FOUND', 'The wrong-patient report was not found');
      }
      return scope === 'route' ? new DomainProblem(404, 'ORDER_ROUTE_NOT_FOUND', 'The order route was not found')
        : new DomainProblem(404, 'ADMIN_FACILITY_NOT_FOUND', 'Facility was not found');
    case '22023':
      if (scope === 'lookup') return lookupInvalid();
      if (scope === 'report') {
        // D17-6: recognised before the generic refusal (an older Identity answers it WRONG_PATIENT_REVIEW_INVALID).
        if (message === 'WRONG_PATIENT_REVIEW_REFERRAL_REQUIRED') return referralRequired(error);
        return new DomainProblem(400, 'WRONG_PATIENT_REVIEW_INVALID',
          'Choose one or more actions, or "No further action" alone, and write a note of 8 to 500 characters');
      }
      if (message === 'WRONG_PATIENT_REPORTS_QUERY_INVALID') {
        return new DomainProblem(400, message, 'status must be unreviewed or recent');
      }
      return new DomainProblem(400, message === 'ORDER_ROUTE_DESTINATION_INVALID' || message === 'ORDER_ROUTE_CLOSE_INVALID'
        ? message : 'ORDER_ROUTE_ADMIN_INVALID', 'The reason must be 8 to 500 characters');
    case '40001':
      if (scope === 'report') {
        return new DomainProblem(409, 'VERSION_CONFLICT', 'The report changed; reload before retrying');
      }
      return new DomainProblem(409, 'VERSION_CONFLICT', 'The order route changed; reload before retrying');
    case '23505':
      if (scope === 'report') {
        return message === 'WRONG_PATIENT_REPORT_ALREADY_REVIEWED'
          ? new DomainProblem(409, message, 'This report has already been reviewed') : unavailable();
      }
      if (message === 'ORDER_ROUTE_ALREADY_CLOSED') {
        return new DomainProblem(409, 'ORDER_ROUTE_ALREADY_CLOSED', 'This order route is already closed');
      }
      if (message === 'ORDER_ROUTE_DESTINATION_UNCHANGED') {
        return new DomainProblem(409, 'ORDER_ROUTE_DESTINATION_UNCHANGED', 'The facility is already listed that way');
      }
      return unavailable();
    default:
      return unavailable();
  }
}
