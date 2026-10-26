import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
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
  constructor(private readonly database: DatabaseService) {}

  /**
   * C20: listing, what the facility is as a destination (`destination
   * { receivingTypes, review }`, item 4, 0089: its active laboratory or
   * pharmacy products and its sign-up's review, no verification method),
   * lifetime counts and 30 days per counterpart; no patient, no order
   * content. The database's object is answered as it is, so an earlier
   * schema answers without `destination`.
   */
  async summary(context: PlatformAdminContext, facilityId: string) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const result = await client.query<{ summary: unknown }>(
          'select identity.admin_order_route_summary($1) as summary', [facilityId]);
        const summary = parse(result.rows[0]?.summary);
        if (!summary) throw new DomainProblem(404, 'ADMIN_FACILITY_NOT_FOUND', 'Facility was not found');
        return { facilityId, ...summary };
      }, { readOnly: true });
    } catch (error) {
      throw adminOrderRouteProblem(error, 'facility');
    }
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
        })), wrongPatientReports: true };
      }, { readOnly: true });
    } catch (error) {
      throw adminOrderRouteProblem(error, 'lookup');
    }
  }

  /**
   * C26 (item 3 §5.2): support's wrong-patient reports, `unreviewed` (flagged
   * first, then oldest first) or `recent` (90 days, newest first), at most
   * 200, optionally of one receiving facility. Read-only; the interceptor
   * audits it (admin.wrong-patient-reports.list), never naming a note.
   */
  async listWrongPatientReports(context: PlatformAdminContext, status: 'unreviewed' | 'recent', facilityId?: string) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const result = await client.query<WrongPatientReportRow>(
          'select * from identity.admin_list_wrong_patient_reports($1, $2)', [status, facilityId ?? null]);
        return { items: result.rows.map(wrongPatientReport) };
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
 * `report` scope.
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
