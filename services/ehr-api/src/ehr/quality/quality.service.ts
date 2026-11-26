import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { requestDigest } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import { isCalendarTimestamp, type DataAccessContext, type HidRequest } from '../../common/request-context';
import { getEnvironment } from '../../config/environment';
import { DatabaseService } from '../../database/database.service';
import {
  QUALITY_CATEGORIES, QUALITY_HARM_LEVELS, QUALITY_TOLD_REQUIRED_FOR, type QualityActionAddDto,
  type QualityActionStatus, type QualityActionUpdateDto, type QualityAssignDto, type QualityCorrectionDto,
  type QualityCountsQueryDto, type QualityInvestigationDto, type QualityLeadEndDto, type QualityLeadNameDto,
  type QualityListQueryDto, type QualityReopenDto, type QualityReportDto, type QualityResolveDto, type QualityStatus,
  type QualityTold,
} from './quality.dto';

/**
 * QUAL-1 (0197, 0198): quality and safety reporting, incidents and near
 * misses, for one facility.
 *
 * Every route works through 0197's SECURITY DEFINER functions, which check the
 * caller again (an active membership here, not held by the cutover,
 * quality.incident.report, the purpose healthcare-operations; a manager by
 * quality.incident.manage or a named quality lead row), decide who sees what
 * (manager, the current reviewer, the reporter; anyone else not found), and
 * audit in the request's transaction, refusals that are answers included.
 *
 * Owner decisions Q248 A-Q253 A (25 November 2026): the reporter is named but
 * confidential, the patient link is optional and seen only by managers, the
 * lists are a DRAFT (QS-DRAFT-1) for the clinical lead, quality.incident.manage
 * and named leads manage, "patient or family told" is required for moderate
 * harm and above, nothing is deleted. Built at the recommended options
 * Q-QUAL-1 A to Q-QUAL-8 A, not yet answered by the owner.
 *
 * No Health ID or NIN in any path, query, body or answer: the linked patient
 * (managers only) carries the last 4 characters of the Health ID. Until the
 * owner's go-live, QUALITY_INCIDENTS_ENABLED is off in production and every
 * route answers 503 QUALITY_NOT_AVAILABLE; a database without 0197 answers the
 * same.
 */

/** The plain-words messages of every refusal. Staff screens show these and never the word "permission". */
export const QUALITY_MESSAGES = {
  notAvailable: 'Quality and safety reporting is not switched on yet.',
  patientLinkNotAvailable: 'Linking a patient is not switched on yet. Report without the patient, and do not write '
    + 'their name.',
  validation: 'Check the highlighted fields.',
  timeInvalid: 'The time it happened can be up to a year ago, and not in the future.',
  locationRequired: 'Say where it happened: choose a department, describe the place, or both.',
  departmentInvalid: 'Choose one of this facility\'s departments.',
  categoryInvalid: 'Choose a category from the list.',
  harmLevelInvalid: 'Choose how much harm was done from the list.',
  toldRequired: 'For moderate harm, severe harm or death, say whether the patient or family was told.',
  reviewerInvalid: 'Choose a reviewer who works at this facility.',
  actionOwnerInvalid: 'Choose a staff member of this facility to own this action.',
  dueDateInvalid: 'Choose a due date from today up to a year ahead.',
  leadInvalid: 'Choose a staff member who works at this facility.',
  reasonRequired: 'Say why in at least 8 characters.',
  cancelNoteRequired: 'Say why the action is cancelled, in at least 2 characters.',
  nothingToChange: 'Change at least one thing.',
  monthInvalid: 'Choose a month that has started.',
  cursorInvalid: 'This page of the list can no longer be opened. Start the list again.',
  purposeRequired: 'X-Purpose-Of-Use must be healthcare-operations for quality and safety reporting',
  notAllowed: 'Only staff of this facility can report incidents.',
  managerOnly: 'Only this facility\'s quality leads and administrators can do this.',
  leadsAdminOnly: 'Only this facility\'s administrators can name or remove quality leads.',
  reviewerOnly: 'Only the reviewer of this incident or a quality lead can do this.',
  patientLinkRefused: 'Only a patient of this facility can be linked. Report without the patient, and do not write '
    + 'their name. A quality lead can link the patient later.',
  incidentNotFound: 'This incident report is not available.',
  actionNotFound: 'This action is not available.',
  leadNotFound: 'This quality lead is not available.',
  resolved: 'This incident is resolved. Reopen it first.',
  statusInvalid: 'This step is not possible at the incident\'s current stage.',
  assignFirst: 'Assign a reviewer first.',
  investigateFirst: 'Record the investigation first.',
  notResolved: 'Only a resolved incident can be reopened.',
  actionsOpen: 'Mark every corrective action done or cancelled before resolving.',
  actionLimit: 'An incident can have up to 20 corrective actions.',
  leadExists: 'This staff member is already a quality lead.',
  leadLimit: 'A facility can have up to 10 quality leads.',
  leadEnded: 'This quality lead has already been removed.',
  keyReused: 'Idempotency-Key was already used with a different request',
  keyInvalid: 'Idempotency-Key must contain 16 to 128 URL-safe characters',
  versionConflict: 'Someone else changed this incident. Reload it and try again.',
} as const;

/** The first line of the counts CSV (Q253 A). */
export const QUALITY_CSV_NOTICE = 'Internal quality-improvement record. Counts only.';
export const QUALITY_CSV_COLUMNS = 'month,category_code,category,harm_level_code,harm_level,department_code,count';
export const QUALITY_LEAD_LIMIT = 10;
export const QUALITY_LIST_DEFAULT_LIMIT = 50;
export const QUALITY_LIST_MAX_LIMIT = 100;

export type QualityView = 'manager' | 'reviewer' | 'reporter';

export interface QualityPatient {
  patientId: string;
  fullName: string;
  recordKind: 'standard' | 'unknown';
  unknownLabel: string | null;
  sex: string | null;
  dateOfBirth: string | null;
  healthIdLast4: string;
}

/** The incident card (route 4 and every write's answer), in the caller's view. */
export interface QualityCard {
  incidentId: string;
  incidentNumber: number;
  view: QualityView;
  title: string;
  description: string;
  occurredAt: string;
  occurredDay: string;
  departmentCode: string | null;
  locationText: string | null;
  category: string;
  harmLevel: string;
  immediateAction: string | null;
  patientOrFamilyTold: QualityTold | null;
  listVersion: string;
  status: QualityStatus;
  reportedAt: string;
  reportedByMe: boolean;
  reporterMembershipId: string | null;
  reporterHidden: boolean;
  patientLinked: boolean;
  patientHidden: boolean;
  patient: QualityPatient | null;
  reviewerMembershipId: string | null;
  assignedAt: string | null;
  investigation: { findings: string; recordedAt: string; recordedByMembershipId: string } | null;
  resolution: { resolution: string; resolvedAt: string; resolvedByMembershipId: string } | null;
  reopenedCount: number;
  openActions: number | null;
  overdueActions: number | null;
  can: { assign: boolean; investigate: boolean; addAction: boolean; resolve: boolean; reopen: boolean; correct: boolean };
  updatedAt: string;
  rowVersion: number;
}

export interface QualityAction {
  actionId: string;
  description: string;
  ownerMembershipId: string;
  dueDate: string;
  status: QualityActionStatus;
  overdue: boolean;
  completedAt: string | null;
  note: string | null;
  createdAt: string;
  createdByMembershipId: string;
}

export type QualityHistoryKind = 'reported' | 'patient_linked' | 'assigned' | 'reassigned' | 'investigation_recorded'
  | 'investigation_amended' | 'action_added' | 'action_updated' | 'resolved' | 'reopened' | 'corrected'
  | 'patient_link_changed';

export interface QualityHistoryEntry {
  kind: QualityHistoryKind;
  at: string;
  byMembershipId: string | null;
  fromStatus: QualityStatus | null;
  toStatus: QualityStatus | null;
  reason: string | null;
  text: string | null;
  actionId: string | null;
  changes: Record<string, unknown> | null;
}

export interface QualityIncident {
  incident: QualityCard;
  actions: QualityAction[];
  history: QualityHistoryEntry[];
}

export interface QualityWrite extends QualityIncident {
  replayed: boolean;
}

export interface QualityListItem {
  incidentId: string;
  incidentNumber: number;
  title: string;
  category: string;
  harmLevel: string;
  departmentCode: string | null;
  occurredAt: string;
  reportedAt: string;
  status: QualityStatus;
  reviewerMembershipId: string | null;
  patientLinked: boolean;
  reportedByMe: boolean;
  assignedToMe: boolean;
  openActions: number | null;
  overdueActions: number | null;
  rowVersion: number;
}

export interface QualityList {
  items: QualityListItem[];
  nextCursor: string | null;
  limit: number;
  counts: { reported: number; assigned: number; investigated: number; resolved: number } | null;
}

export interface QualityListEntry {
  code: string;
  label: string;
  hint: string;
}

export interface QualityMe {
  canReport: boolean;
  isManager: boolean;
  managerBasis: 'role' | 'quality_lead' | null;
  canNameLeads: boolean;
  patientLinkAvailable: boolean;
  lists: {
    listVersion: string;
    listStatus: 'draft' | 'signed';
    categories: QualityListEntry[];
    harmLevels: (QualityListEntry & { toldRequired: boolean })[];
    toldValues: QualityTold[];
  };
  departmentCodes: string[];
}

export interface QualityCountsRow {
  category: string;
  harmLevel: string;
  departmentCode: string | null;
  count: number;
}

export interface QualityCounts {
  month: string;
  basis: 'occurred';
  listVersion: string;
  listStatus: 'draft' | 'signed';
  generatedAt: string;
  total: number;
  rows: QualityCountsRow[];
}

export interface QualityLead {
  leadId: string;
  membershipId: string;
  namedAt: string;
  namedByMembershipId: string;
  endedAt?: string | null;
  endedByMembershipId?: string | null;
}

export interface QualityLeadWrite {
  lead: QualityLead;
  replayed: boolean;
}

/** The counts as a file: the CSV text and its file name. */
export interface QualityCountsFile {
  filename: string;
  csv: string;
}

export const ME_SQL = 'select ehr.quality_me() as body';
export const REPORT_SQL = `select outcome, replayed, body
  from ehr.quality_incident_report($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10::uuid, $11, $12)`;
export const LIST_SQL = `select ehr.quality_incident_list($1, $2, $3, $4, $5::date, $6::date, $7, $8::integer,
  $9::timestamptz, $10::uuid) as body`;
export const READ_SQL = 'select outcome, body from ehr.quality_incident_read($1::uuid)';
export const ASSIGN_SQL = `select outcome, replayed, body
  from ehr.quality_incident_assign($1::uuid, $2::bigint, $3::uuid, $4, $5)`;
export const INVESTIGATE_SQL = `select outcome, replayed, body
  from ehr.quality_incident_investigate($1::uuid, $2::bigint, $3, $4, $5)`;
export const ACTION_ADD_SQL = `select outcome, replayed, body
  from ehr.quality_incident_action_add($1::uuid, $2::bigint, $3, $4::uuid, $5::date, $6, $7)`;
export const ACTION_UPDATE_SQL = `select outcome, replayed, body
  from ehr.quality_incident_action_update($1::uuid, $2::uuid, $3::bigint, $4, $5, $6::uuid, $7::date, $8, $9)`;
export const RESOLVE_SQL = `select outcome, replayed, body
  from ehr.quality_incident_resolve($1::uuid, $2::bigint, $3, $4, $5)`;
export const REOPEN_SQL = `select outcome, replayed, body
  from ehr.quality_incident_reopen($1::uuid, $2::bigint, $3, $4, $5)`;
export const CORRECT_SQL = `select outcome, replayed, body
  from ehr.quality_incident_correct($1::uuid, $2::bigint, $3, $4::text[], $5, $6, $7, $8, $9, $10::uuid, $11, $12)`;
export const COUNTS_SQL = 'select ehr.quality_incident_counts($1, $2) as body';
export const LEADS_SQL = 'select ehr.quality_lead_list() as body';
export const LEAD_NAME_SQL = 'select outcome, replayed, body from ehr.quality_lead_name($1::uuid, $2, $3)';
export const LEAD_END_SQL = 'select outcome, replayed, body from ehr.quality_lead_end($1::uuid, $2, $3, $4)';

/** The correction's fields, as the body names them and as 0197's function does. */
const CORRECTION_FIELDS = [
  ['category', 'category'], ['harmLevel', 'harm_level'], ['departmentCode', 'department_code'],
  ['locationText', 'location_text'], ['patientOrFamilyTold', 'told'], ['patientId', 'patient_id'],
] as const;

export function qualityEnabled(): boolean {
  return getEnvironment().QUALITY_INCIDENTS_ENABLED;
}

export function notAvailable(): DomainProblem {
  return new DomainProblem(503, 'QUALITY_NOT_AVAILABLE', QUALITY_MESSAGES.notAvailable);
}

/**
 * What a route needs of the session's codes at this facility, before the
 * database decides again: quality.incident.report always; naming and ending
 * leads quality.incident.manage itself. Manager steps are decided by the
 * database alone, because a named quality lead holds only the report code in
 * the session (Q-QUAL-1 A).
 */
export type QualityAccess = 'report' | 'leads';

export function requireQualityAccess(request: HidRequest, access: QualityAccess): void {
  const held = new Set(request.actor?.permissions ?? []);
  if (!held.has('quality.incident.report')) {
    throw new DomainProblem(403, 'QUALITY_NOT_ALLOWED', QUALITY_MESSAGES.notAllowed);
  }
  if (access === 'leads' && !held.has('quality.incident.manage')) {
    throw new DomainProblem(403, 'QUALITY_LEADS_ADMIN_ONLY', QUALITY_MESSAGES.leadsAdminOnly);
  }
}

function validation(field: string, message: string): DomainProblem {
  return new DomainProblem(400, 'VALIDATION_FAILED', QUALITY_MESSAGES.validation, [{ field, messages: [message] }]);
}

/** A real calendar day (2026-02-30 is not). */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

/** A reason of 8-500 characters after trimming (reopen, correction, ending a lead). */
function requireReason(reason: string | undefined): string {
  const value = reason?.trim() ?? '';
  if (value.length < 8 || value.length > 500 || !/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/.test(value)) {
    throw new DomainProblem(400, 'QUALITY_REASON_REQUIRED', QUALITY_MESSAGES.reasonRequired);
  }
  return value;
}

interface CursorPosition {
  reportedAt: string;
  incidentId: string;
}

/** The list's filters that a cursor is bound to (a cursor of another filter set is not this route's). */
function filtersOf(query: QualityListQueryDto, limit: number): string {
  return createHash('sha256').update(JSON.stringify([query.status ?? null, query.category ?? null,
    query.harmLevel ?? null, query.departmentCode ?? null, query.occurredFrom ?? null, query.occurredTo ?? null,
    query.mine ?? null, limit])).digest('hex').slice(0, 16);
}

/** An opaque keyset cursor: the last item's report time (microseconds, UTC) and id, and the filters it was made for. */
export function encodeCursor(position: CursorPosition, filters: string): string {
  return Buffer.from(JSON.stringify({ v: 1, at: position.reportedAt, id: position.incidentId, f: filters }), 'utf8')
    .toString('base64url');
}

export function decodeCursor(cursor: string, filters: string): CursorPosition {
  const refused = new DomainProblem(400, 'QUALITY_LIST_CURSOR_INVALID', QUALITY_MESSAGES.cursorInvalid);
  if (!/^[A-Za-z0-9_-]{16,400}$/.test(cursor)) throw refused;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw refused;
  }
  const value = decoded as Record<string, unknown> | null;
  if (typeof value !== 'object' || value === null || Object.keys(value).sort().join(',') !== 'at,f,id,v'
      || value.v !== 1 || value.f !== filters || typeof value.at !== 'string' || typeof value.id !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.at) || !isCalendarTimestamp(value.at)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id)
      || encodeCursor({ reportedAt: value.at, incidentId: value.id }, filters) !== cursor) {
    throw refused;
  }
  return { reportedAt: value.at, incidentId: value.id };
}

/** One CSV cell: quoted when it holds a comma, quote or line break; a leading formula sign is made text. */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

interface OutcomeRow extends QueryResultRow {
  outcome: string;
  replayed?: boolean | null;
  body: unknown;
}

interface BodyRow extends QueryResultRow {
  body: unknown;
}

@Injectable()
export class QualityService {
  constructor(private readonly database: DatabaseService) {}

  /** Route 1: what this member can do here, the lists and the facility's departments. */
  async me(context: DataAccessContext): Promise<QualityMe> {
    const row = await this.one<BodyRow>(context, ME_SQL, []);
    return toMe(row?.body);
  }

  /** Route 2: file a report. */
  async report(context: DataAccessContext, input: QualityReportDto, idempotencyKey: string): Promise<QualityWrite> {
    if (!isCalendarTimestamp(input.occurredAt)) throw validation('occurredAt', 'occurredAt must be a real time');
    if ((input.departmentCode ?? null) === null && (input.locationText ?? null) === null) {
      throw new DomainProblem(400, 'QUALITY_LOCATION_REQUIRED', QUALITY_MESSAGES.locationRequired);
    }
    if (!(QUALITY_CATEGORIES as readonly string[]).includes(input.category)) {
      throw new DomainProblem(400, 'QUALITY_CATEGORY_INVALID', QUALITY_MESSAGES.categoryInvalid);
    }
    if (!(QUALITY_HARM_LEVELS as readonly string[]).includes(input.harmLevel)) {
      throw new DomainProblem(400, 'QUALITY_HARM_LEVEL_INVALID', QUALITY_MESSAGES.harmLevelInvalid);
    }
    if ((QUALITY_TOLD_REQUIRED_FOR as readonly string[]).includes(input.harmLevel)
        && (input.patientOrFamilyTold ?? null) === null) {
      throw new DomainProblem(400, 'QUALITY_TOLD_REQUIRED', QUALITY_MESSAGES.toldRequired);
    }
    const body = {
      title: input.title, description: input.description, occurredAt: input.occurredAt,
      departmentCode: input.departmentCode ?? null, locationText: input.locationText ?? null,
      category: input.category, harmLevel: input.harmLevel, immediateAction: input.immediateAction ?? null,
      patientOrFamilyTold: input.patientOrFamilyTold ?? null, patientId: input.patientId ?? null,
    };
    const digest = requestDigest('quality.incident.report', body);
    return this.write(context, REPORT_SQL, [body.title, body.description, body.occurredAt, body.departmentCode,
      body.locationText, body.category, body.harmLevel, body.immediateAction, body.patientOrFamilyTold, body.patientId,
      idempotencyKey, digest]);
  }

  /** Route 3: the list, newest report first, with a keyset cursor bound to the filters. */
  async list(context: DataAccessContext, query: QualityListQueryDto): Promise<QualityList> {
    const limit = query.limit ?? QUALITY_LIST_DEFAULT_LIMIT;
    if (limit > QUALITY_LIST_MAX_LIMIT) throw validation('limit', `limit must not be greater than ${QUALITY_LIST_MAX_LIMIT}`);
    for (const field of ['occurredFrom', 'occurredTo'] as const) {
      const value = query[field];
      if (value !== undefined && !isCalendarDay(value)) throw validation(field, `${field} must be a real day`);
    }
    if (query.occurredFrom !== undefined && query.occurredTo !== undefined) {
      const span = (Date.parse(query.occurredTo) - Date.parse(query.occurredFrom)) / 86_400_000;
      if (span < 0 || span > 366) {
        throw validation('occurredTo', 'occurredTo must be on or after occurredFrom, at most 366 days apart');
      }
    }
    const filters = filtersOf(query, limit);
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor, filters);
    const row = await this.one<BodyRow>(context, LIST_SQL, [query.status ?? null, query.category ?? null,
      query.harmLevel ?? null, query.departmentCode ?? null, query.occurredFrom ?? null, query.occurredTo ?? null,
      query.mine ?? null, limit, position?.reportedAt ?? null, position?.incidentId ?? null]);
    const body = asRecord(row?.body);
    const next = asRecord(body.next);
    return {
      items: asArray(body.items).map(toListItem),
      nextCursor: body.hasMore === true && typeof next.reportedAt === 'string' && typeof next.incidentId === 'string'
        ? encodeCursor({ reportedAt: next.reportedAt, incidentId: next.incidentId }, filters) : null,
      limit,
      counts: body.counts === null || body.counts === undefined ? null : {
        reported: numberOf(asRecord(body.counts).reported), assigned: numberOf(asRecord(body.counts).assigned),
        investigated: numberOf(asRecord(body.counts).investigated), resolved: numberOf(asRecord(body.counts).resolved),
      },
    };
  }

  /** Route 4: one incident in this member's view. */
  async read(context: DataAccessContext, incidentId: string): Promise<QualityIncident> {
    const row = await this.one<OutcomeRow>(context, READ_SQL, [incidentId]);
    if (row?.outcome !== 'ok') throw refusal(row?.outcome);
    return toIncident(row.body);
  }

  /** Route 5 (manager): choose or change the reviewer. */
  async assign(context: DataAccessContext, incidentId: string, input: QualityAssignDto,
    idempotencyKey: string): Promise<QualityWrite> {
    const digest = requestDigest('quality.incident.assign', { incidentId,
      expectedRowVersion: input.expectedRowVersion, reviewerMembershipId: input.reviewerMembershipId });
    return this.write(context, ASSIGN_SQL, [incidentId, input.expectedRowVersion, input.reviewerMembershipId,
      idempotencyKey, digest]);
  }

  /** Route 6 (the reviewer or a manager): the findings; assigned to investigated, or an amendment. */
  async investigate(context: DataAccessContext, incidentId: string, input: QualityInvestigationDto,
    idempotencyKey: string): Promise<QualityWrite> {
    const digest = requestDigest('quality.incident.investigation', { incidentId,
      expectedRowVersion: input.expectedRowVersion, findings: input.findings });
    return this.write(context, INVESTIGATE_SQL, [incidentId, input.expectedRowVersion, input.findings, idempotencyKey,
      digest]);
  }

  /** Route 7 (the reviewer or a manager): a corrective action. */
  async addAction(context: DataAccessContext, incidentId: string, input: QualityActionAddDto,
    idempotencyKey: string): Promise<QualityWrite> {
    if (!isCalendarDay(input.dueDate)) throw validation('dueDate', 'dueDate must be a real day');
    const digest = requestDigest('quality.incident.action-add', { incidentId,
      expectedRowVersion: input.expectedRowVersion, description: input.description,
      ownerMembershipId: input.ownerMembershipId, dueDate: input.dueDate });
    return this.write(context, ACTION_ADD_SQL, [incidentId, input.expectedRowVersion, input.description,
      input.ownerMembershipId, input.dueDate, idempotencyKey, digest]);
  }

  /** Route 8 (the reviewer or a manager): an action's status, note, owner or due date. */
  async updateAction(context: DataAccessContext, incidentId: string, actionId: string, input: QualityActionUpdateDto,
    idempotencyKey: string): Promise<QualityWrite> {
    if (input.status === undefined && input.note === undefined && input.ownerMembershipId === undefined
        && input.dueDate === undefined) {
      throw new DomainProblem(400, 'QUALITY_NOTHING_TO_CHANGE', QUALITY_MESSAGES.nothingToChange);
    }
    if (input.status === 'cancelled' && input.note === undefined) {
      throw new DomainProblem(400, 'QUALITY_REASON_REQUIRED', QUALITY_MESSAGES.cancelNoteRequired);
    }
    if (input.dueDate !== undefined && !isCalendarDay(input.dueDate)) throw validation('dueDate', 'dueDate must be a real day');
    const digest = requestDigest('quality.incident.action-update', { incidentId, actionId,
      expectedRowVersion: input.expectedRowVersion, status: input.status ?? null, note: input.note ?? null,
      ownerMembershipId: input.ownerMembershipId ?? null, dueDate: input.dueDate ?? null });
    return this.write(context, ACTION_UPDATE_SQL, [incidentId, actionId, input.expectedRowVersion, input.status ?? null,
      input.note ?? null, input.ownerMembershipId ?? null, input.dueDate ?? null, idempotencyKey, digest]);
  }

  /** Route 9 (manager): resolve an investigated incident with no open action. */
  async resolve(context: DataAccessContext, incidentId: string, input: QualityResolveDto,
    idempotencyKey: string): Promise<QualityWrite> {
    const digest = requestDigest('quality.incident.resolve', { incidentId,
      expectedRowVersion: input.expectedRowVersion, resolution: input.resolution });
    return this.write(context, RESOLVE_SQL, [incidentId, input.expectedRowVersion, input.resolution, idempotencyKey,
      digest]);
  }

  /** Route 10 (manager): reopen a resolved incident, with a reason. */
  async reopen(context: DataAccessContext, incidentId: string, input: QualityReopenDto,
    idempotencyKey: string): Promise<QualityWrite> {
    const reason = requireReason(input.reason);
    const digest = requestDigest('quality.incident.reopen', { incidentId,
      expectedRowVersion: input.expectedRowVersion, reason });
    return this.write(context, REOPEN_SQL, [incidentId, input.expectedRowVersion, reason, idempotencyKey, digest]);
  }

  /** Route 11 (manager): correct the classification or the patient link, with a reason. */
  async correct(context: DataAccessContext, incidentId: string, input: QualityCorrectionDto,
    idempotencyKey: string): Promise<QualityWrite> {
    const reason = requireReason(input.reason);
    const given = CORRECTION_FIELDS.filter(([field]) => input[field] !== undefined);
    if (given.length === 0) {
      throw new DomainProblem(400, 'QUALITY_NOTHING_TO_CHANGE', QUALITY_MESSAGES.nothingToChange);
    }
    if (input.category !== undefined && !(QUALITY_CATEGORIES as readonly string[]).includes(input.category)) {
      throw new DomainProblem(400, 'QUALITY_CATEGORY_INVALID', QUALITY_MESSAGES.categoryInvalid);
    }
    if (input.harmLevel !== undefined && !(QUALITY_HARM_LEVELS as readonly string[]).includes(input.harmLevel)) {
      throw new DomainProblem(400, 'QUALITY_HARM_LEVEL_INVALID', QUALITY_MESSAGES.harmLevelInvalid);
    }
    const changes = Object.fromEntries(given.map(([field]) => [field, input[field] ?? null]));
    const digest = requestDigest('quality.incident.correct', { incidentId,
      expectedRowVersion: input.expectedRowVersion, reason, changes });
    return this.write(context, CORRECT_SQL, [incidentId, input.expectedRowVersion, reason,
      given.map(([, column]) => column), input.category ?? null, input.harmLevel ?? null, input.departmentCode ?? null,
      input.locationText ?? null, input.patientOrFamilyTold ?? null, input.patientId ?? null, idempotencyKey, digest]);
  }

  /** Route 12 (manager): the monthly de-identified count, as JSON. */
  async counts(context: DataAccessContext, query: QualityCountsQueryDto): Promise<QualityCounts> {
    return toCounts((await this.countRows(context, query.month, 'json')).body);
  }

  /** Route 12 with format=csv: the same count as a CSV file with the active list's words. */
  async countsFile(context: DataAccessContext, query: QualityCountsQueryDto): Promise<QualityCountsFile> {
    const { body, month } = await this.countRows(context, query.month, 'csv');
    const record = asRecord(body);
    const lines = [QUALITY_CSV_NOTICE, QUALITY_CSV_COLUMNS, ...asArray(record.rows).map((value) => {
      const row = asRecord(value);
      return [month, textOf(row.category), textOf(row.categoryLabel), textOf(row.harmLevel), textOf(row.harmLevelLabel),
        nullableText(row.departmentCode), numberOf(row.count)].map(csvCell).join(',');
    })];
    return { filename: `quality-incident-counts-${month}.csv`, csv: `${lines.join('\r\n')}\r\n` };
  }

  /** Route 13 (manager): the active quality leads. */
  async leads(context: DataAccessContext): Promise<{ leads: QualityLead[]; limit: number }> {
    const row = await this.one<BodyRow>(context, LEADS_SQL, []);
    return { leads: asArray(asRecord(row?.body).leads).map((lead) => toLead(lead, false)), limit: QUALITY_LEAD_LIMIT };
  }

  /** Route 14 (quality.incident.manage): name a quality lead. */
  async nameLead(context: DataAccessContext, input: QualityLeadNameDto, idempotencyKey: string): Promise<QualityLeadWrite> {
    const digest = requestDigest('quality.lead.name', { membershipId: input.membershipId });
    return this.leadWrite(context, LEAD_NAME_SQL, [input.membershipId, idempotencyKey, digest]);
  }

  /** Route 15 (quality.incident.manage): end a quality lead, with a reason; the row is kept. */
  async endLead(context: DataAccessContext, leadId: string, input: QualityLeadEndDto,
    idempotencyKey: string): Promise<QualityLeadWrite> {
    const reason = requireReason(input.reason);
    const digest = requestDigest('quality.lead.end', { leadId, reason });
    return this.leadWrite(context, LEAD_END_SQL, [leadId, reason, idempotencyKey, digest]);
  }

  private async countRows(context: DataAccessContext, month: string,
    format: 'json' | 'csv'): Promise<{ body: unknown; month: string }> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new DomainProblem(400, 'QUALITY_MONTH_INVALID', QUALITY_MESSAGES.monthInvalid);
    }
    const row = await this.one<BodyRow>(context, COUNTS_SQL, [month, format]);
    return { body: row?.body, month };
  }

  private async write(context: DataAccessContext, sql: string, values: readonly unknown[]): Promise<QualityWrite> {
    const row = await this.one<OutcomeRow>(context, sql, values);
    if (row?.outcome !== 'ok') throw refusal(row?.outcome);
    return { ...toIncident(row.body), replayed: row.replayed === true };
  }

  private async leadWrite(context: DataAccessContext, sql: string, values: readonly unknown[]): Promise<QualityLeadWrite> {
    const row = await this.one<OutcomeRow>(context, sql, values);
    if (row?.outcome !== 'ok') throw refusal(row?.outcome);
    return { lead: toLead(asRecord(row.body).lead, true), replayed: row.replayed === true };
  }

  private async one<Row extends QueryResultRow>(context: DataAccessContext, sql: string,
    values: readonly unknown[]): Promise<Row | undefined> {
    try {
      return await this.database.withTransaction(context, async (client: PoolClient) =>
        (await client.query<Row>(sql, [...values])).rows[0]);
    } catch (error) {
      throw translate(error);
    }
  }
}

// The answers are rebuilt field by field from what the database gives (a whitelist): only the contract's fields
// leave this service, in the contract's order.
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOf(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : 0;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : numberOf(value);
}

const iso = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? new Date(value).toISOString() : null;

function toPatient(value: unknown): QualityPatient | null {
  if (value === null || value === undefined) return null;
  const patient = asRecord(value);
  return {
    patientId: textOf(patient.patientId),
    fullName: textOf(patient.fullName),
    recordKind: patient.recordKind === 'unknown' ? 'unknown' : 'standard',
    unknownLabel: patient.recordKind === 'unknown' ? nullableText(patient.unknownLabel) : null,
    sex: nullableText(patient.sex),
    dateOfBirth: nullableText(patient.dateOfBirth),
    healthIdLast4: textOf(patient.healthIdLast4),
  };
}

export function toCard(value: unknown): QualityCard {
  const card = asRecord(value);
  const investigation = asRecord(card.investigation);
  const resolution = asRecord(card.resolution);
  const can = asRecord(card.can);
  const view: QualityView = card.view === 'manager' || card.view === 'reviewer' ? card.view : 'reporter';
  return {
    incidentId: textOf(card.incidentId),
    incidentNumber: numberOf(card.incidentNumber),
    view,
    title: textOf(card.title),
    description: textOf(card.description),
    occurredAt: iso(card.occurredAt) ?? '',
    occurredDay: textOf(card.occurredDay),
    departmentCode: nullableText(card.departmentCode),
    locationText: nullableText(card.locationText),
    category: textOf(card.category),
    harmLevel: textOf(card.harmLevel),
    immediateAction: nullableText(card.immediateAction),
    patientOrFamilyTold: nullableText(card.patientOrFamilyTold) as QualityTold | null,
    listVersion: textOf(card.listVersion),
    status: textOf(card.status) as QualityStatus,
    reportedAt: iso(card.reportedAt) ?? '',
    reportedByMe: card.reportedByMe === true,
    // The reporter and the patient leave this service only in the manager's view, whatever the row holds.
    reporterMembershipId: view === 'manager' ? nullableText(card.reporterMembershipId) : null,
    reporterHidden: card.reporterHidden === true,
    patientLinked: card.patientLinked === true,
    patientHidden: card.patientHidden === true,
    patient: view === 'manager' ? toPatient(card.patient) : null,
    reviewerMembershipId: view === 'reporter' ? null : nullableText(card.reviewerMembershipId),
    assignedAt: iso(card.assignedAt),
    investigation: view === 'reporter' || card.investigation === null || card.investigation === undefined ? null : {
      findings: textOf(investigation.findings), recordedAt: iso(investigation.recordedAt) ?? '',
      recordedByMembershipId: textOf(investigation.recordedByMembershipId),
    },
    resolution: view === 'reporter' || card.resolution === null || card.resolution === undefined ? null : {
      resolution: textOf(resolution.resolution), resolvedAt: iso(resolution.resolvedAt) ?? '',
      resolvedByMembershipId: textOf(resolution.resolvedByMembershipId),
    },
    reopenedCount: numberOf(card.reopenedCount),
    openActions: view === 'reporter' ? null : nullableNumber(card.openActions),
    overdueActions: view === 'reporter' ? null : nullableNumber(card.overdueActions),
    can: {
      assign: can.assign === true, investigate: can.investigate === true, addAction: can.addAction === true,
      resolve: can.resolve === true, reopen: can.reopen === true, correct: can.correct === true,
    },
    updatedAt: iso(card.updatedAt) ?? '',
    rowVersion: numberOf(card.rowVersion),
  };
}

export function toAction(value: unknown): QualityAction {
  const action = asRecord(value);
  return {
    actionId: textOf(action.actionId),
    description: textOf(action.description),
    ownerMembershipId: textOf(action.ownerMembershipId),
    dueDate: textOf(action.dueDate),
    status: textOf(action.status) as QualityActionStatus,
    overdue: action.overdue === true,
    completedAt: iso(action.completedAt),
    note: nullableText(action.note),
    createdAt: iso(action.createdAt) ?? '',
    createdByMembershipId: textOf(action.createdByMembershipId),
  };
}

export function toHistoryEntry(value: unknown): QualityHistoryEntry {
  const entry = asRecord(value);
  const changes = entry.changes;
  return {
    kind: textOf(entry.kind) as QualityHistoryKind,
    at: iso(entry.at) ?? '',
    byMembershipId: nullableText(entry.byMembershipId),
    fromStatus: nullableText(entry.fromStatus) as QualityStatus | null,
    toStatus: nullableText(entry.toStatus) as QualityStatus | null,
    reason: nullableText(entry.reason),
    text: nullableText(entry.text),
    actionId: nullableText(entry.actionId),
    changes: typeof changes === 'object' && changes !== null && !Array.isArray(changes)
      ? changes as Record<string, unknown> : null,
  };
}

export function toIncident(value: unknown): QualityIncident {
  const body = asRecord(value);
  const incident = toCard(body.incident);
  return {
    incident,
    // The reporter's view holds no action (Q-QUAL-5 A), whatever the row holds.
    actions: incident.view === 'reporter' ? [] : asArray(body.actions).map(toAction),
    history: asArray(body.history).map(toHistoryEntry),
  };
}

export function toListItem(value: unknown): QualityListItem {
  const item = asRecord(value);
  return {
    incidentId: textOf(item.incidentId),
    incidentNumber: numberOf(item.incidentNumber),
    title: textOf(item.title),
    category: textOf(item.category),
    harmLevel: textOf(item.harmLevel),
    departmentCode: nullableText(item.departmentCode),
    occurredAt: iso(item.occurredAt) ?? '',
    reportedAt: iso(item.reportedAt) ?? '',
    status: textOf(item.status) as QualityStatus,
    reviewerMembershipId: nullableText(item.reviewerMembershipId),
    patientLinked: item.patientLinked === true,
    reportedByMe: item.reportedByMe === true,
    assignedToMe: item.assignedToMe === true,
    openActions: nullableNumber(item.openActions),
    overdueActions: nullableNumber(item.overdueActions),
    rowVersion: numberOf(item.rowVersion),
  };
}

export function toMe(value: unknown): QualityMe {
  const me = asRecord(value);
  const lists = asRecord(me.lists);
  return {
    canReport: me.canReport === true,
    isManager: me.isManager === true,
    managerBasis: me.managerBasis === 'role' || me.managerBasis === 'quality_lead' ? me.managerBasis : null,
    canNameLeads: me.canNameLeads === true,
    patientLinkAvailable: me.patientLinkAvailable === true,
    lists: {
      listVersion: textOf(lists.listVersion),
      listStatus: lists.listStatus === 'signed' ? 'signed' : 'draft',
      categories: asArray(lists.categories).map((entry) => {
        const item = asRecord(entry);
        return { code: textOf(item.code), label: textOf(item.label), hint: textOf(item.hint) };
      }),
      harmLevels: asArray(lists.harmLevels).map((entry) => {
        const item = asRecord(entry);
        return { code: textOf(item.code), label: textOf(item.label), hint: textOf(item.hint),
          toldRequired: item.toldRequired === true };
      }),
      toldValues: ['yes', 'no', 'not_applicable'],
    },
    departmentCodes: asArray(me.departmentCodes).filter((code): code is string => typeof code === 'string'),
  };
}

export function toCounts(value: unknown): QualityCounts {
  const counts = asRecord(value);
  return {
    month: textOf(counts.month),
    basis: 'occurred',
    listVersion: textOf(counts.listVersion),
    listStatus: counts.listStatus === 'signed' ? 'signed' : 'draft',
    generatedAt: iso(counts.generatedAt) ?? '',
    total: numberOf(counts.total),
    rows: asArray(counts.rows).map((entry) => {
      const row = asRecord(entry);
      return { category: textOf(row.category), harmLevel: textOf(row.harmLevel),
        departmentCode: nullableText(row.departmentCode), count: numberOf(row.count) };
    }),
  };
}

export function toLead(value: unknown, withEnd: boolean): QualityLead {
  const lead = asRecord(value);
  return {
    leadId: textOf(lead.leadId),
    membershipId: textOf(lead.membershipId),
    namedAt: iso(lead.namedAt) ?? '',
    namedByMembershipId: textOf(lead.namedByMembershipId),
    ...(withEnd ? { endedAt: iso(lead.endedAt), endedByMembershipId: nullableText(lead.endedByMembershipId) } : {}),
  };
}

/** An answer that refuses, in plain words. Every reason a patient cannot be linked answers the same. */
export function refusal(outcome: string | undefined): DomainProblem {
  switch (outcome) {
    case 'key_reused':
      return new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', QUALITY_MESSAGES.keyReused);
    case 'changed':
      return new DomainProblem(412, 'QUALITY_VERSION_CONFLICT', QUALITY_MESSAGES.versionConflict);
    case 'resolved':
      return new DomainProblem(409, 'QUALITY_INCIDENT_RESOLVED', QUALITY_MESSAGES.resolved);
    case 'assign_first':
      return new DomainProblem(409, 'QUALITY_STATUS_INVALID', QUALITY_MESSAGES.assignFirst);
    case 'investigate_first':
      return new DomainProblem(409, 'QUALITY_STATUS_INVALID', QUALITY_MESSAGES.investigateFirst);
    case 'not_resolved':
      return new DomainProblem(409, 'QUALITY_STATUS_INVALID', QUALITY_MESSAGES.notResolved);
    case 'actions_open':
      return new DomainProblem(409, 'QUALITY_ACTIONS_OPEN', QUALITY_MESSAGES.actionsOpen);
    case 'action_limit':
      return new DomainProblem(409, 'QUALITY_ACTION_LIMIT', QUALITY_MESSAGES.actionLimit);
    case 'reviewer_only':
      return new DomainProblem(403, 'QUALITY_REVIEWER_ONLY', QUALITY_MESSAGES.reviewerOnly);
    case 'reviewer_invalid':
      return new DomainProblem(400, 'QUALITY_REVIEWER_INVALID', QUALITY_MESSAGES.reviewerInvalid);
    case 'action_owner_invalid':
      return new DomainProblem(400, 'QUALITY_ACTION_OWNER_INVALID', QUALITY_MESSAGES.actionOwnerInvalid);
    case 'nothing_to_change':
      return new DomainProblem(400, 'QUALITY_NOTHING_TO_CHANGE', QUALITY_MESSAGES.nothingToChange);
    case 'patient_link_not_available':
      return new DomainProblem(503, 'QUALITY_PATIENT_LINK_NOT_AVAILABLE', QUALITY_MESSAGES.patientLinkNotAvailable);
    case 'patient_link_refused':
      return new DomainProblem(403, 'QUALITY_PATIENT_LINK_REFUSED', QUALITY_MESSAGES.patientLinkRefused);
    case 'action_not_found':
      return new DomainProblem(404, 'QUALITY_ACTION_NOT_FOUND', QUALITY_MESSAGES.actionNotFound);
    case 'lead_invalid':
      return new DomainProblem(400, 'QUALITY_LEAD_INVALID', QUALITY_MESSAGES.leadInvalid);
    case 'lead_exists':
      return new DomainProblem(409, 'QUALITY_LEAD_EXISTS', QUALITY_MESSAGES.leadExists);
    case 'lead_limit':
      return new DomainProblem(409, 'QUALITY_LEAD_LIMIT', QUALITY_MESSAGES.leadLimit);
    case 'lead_ended':
      return new DomainProblem(409, 'QUALITY_LEAD_ENDED', QUALITY_MESSAGES.leadEnded);
    case 'lead_not_found':
      return new DomainProblem(404, 'QUALITY_LEAD_NOT_FOUND', QUALITY_MESSAGES.leadNotFound);
    default:
      return new DomainProblem(404, 'QUALITY_INCIDENT_NOT_FOUND', QUALITY_MESSAGES.incidentNotFound);
  }
}

const RAISED_400: Readonly<Record<string, [string, string]>> = {
  QUALITY_TIME_INVALID: ['QUALITY_TIME_INVALID', QUALITY_MESSAGES.timeInvalid],
  QUALITY_LOCATION_REQUIRED: ['QUALITY_LOCATION_REQUIRED', QUALITY_MESSAGES.locationRequired],
  QUALITY_DEPARTMENT_INVALID: ['QUALITY_DEPARTMENT_INVALID', QUALITY_MESSAGES.departmentInvalid],
  QUALITY_CATEGORY_INVALID: ['QUALITY_CATEGORY_INVALID', QUALITY_MESSAGES.categoryInvalid],
  QUALITY_HARM_LEVEL_INVALID: ['QUALITY_HARM_LEVEL_INVALID', QUALITY_MESSAGES.harmLevelInvalid],
  QUALITY_TOLD_REQUIRED: ['QUALITY_TOLD_REQUIRED', QUALITY_MESSAGES.toldRequired],
  QUALITY_REASON_REQUIRED: ['QUALITY_REASON_REQUIRED', QUALITY_MESSAGES.reasonRequired],
  QUALITY_NOTHING_TO_CHANGE: ['QUALITY_NOTHING_TO_CHANGE', QUALITY_MESSAGES.nothingToChange],
  QUALITY_DUE_DATE_INVALID: ['QUALITY_DUE_DATE_INVALID', QUALITY_MESSAGES.dueDateInvalid],
  QUALITY_MONTH_INVALID: ['QUALITY_MONTH_INVALID', QUALITY_MESSAGES.monthInvalid],
  QUALITY_LIST_CURSOR_INVALID: ['QUALITY_LIST_CURSOR_INVALID', QUALITY_MESSAGES.cursorInvalid],
  QUALITY_PURPOSE_REQUIRED: ['PURPOSE_OF_USE_REQUIRED', QUALITY_MESSAGES.purposeRequired],
  QUALITY_IDEMPOTENCY_KEY_INVALID: ['IDEMPOTENCY_KEY_REQUIRED', QUALITY_MESSAGES.keyInvalid],
};

/** The functions' own refusals, in plain words; anything else is passed on. */
export function translate(error: unknown): unknown {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  if (code === '42501') {
    if (message === 'QUALITY_MANAGER_ONLY') {
      return new DomainProblem(403, 'QUALITY_MANAGER_ONLY', QUALITY_MESSAGES.managerOnly);
    }
    if (message === 'QUALITY_LEADS_ADMIN_ONLY') {
      return new DomainProblem(403, 'QUALITY_LEADS_ADMIN_ONLY', QUALITY_MESSAGES.leadsAdminOnly);
    }
    return new DomainProblem(403, 'QUALITY_NOT_ALLOWED', QUALITY_MESSAGES.notAllowed);
  }
  if (code === '22023') {
    const known = typeof message === 'string' ? RAISED_400[message] : undefined;
    return known ? new DomainProblem(400, known[0], known[1])
      : new DomainProblem(400, 'VALIDATION_FAILED', QUALITY_MESSAGES.validation);
  }
  if (code === '22007' || code === '22008') {
    // A time or day PostgreSQL cannot read (the DTOs let only real ones through).
    return new DomainProblem(400, 'VALIDATION_FAILED', QUALITY_MESSAGES.validation);
  }
  if (code === '40001' || code === '40P01') {
    return new DomainProblem(412, 'QUALITY_VERSION_CONFLICT', QUALITY_MESSAGES.versionConflict);
  }
  if (code === '42883' || code === '42P01') {
    // A new image on a schema without 0197: the routes stay closed until the migration is applied.
    return notAvailable();
  }
  return error;
}
