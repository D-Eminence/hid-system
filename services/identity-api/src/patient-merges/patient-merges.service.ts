import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService, type AuditEventInput } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { NinStatus } from '../identity/nin-status';
import type { ListPatientMergesDto, PatientMergeStatus, RefusePatientMergeDto, RequestPatientMergeDto,
  UndoPatientMergeDto, VersionedPatientMergeDto } from './patient-merges.dto';
import { PATIENT_MERGE_ID8B_FUNCTIONS } from './patient-merges';

/**
 * ID-8a (0207): the database decides every rule (identity.request_patient_merge,
 * list_patient_merges, read_patient_merge, refuse_patient_merge,
 * cancel_patient_merge) and writes the audit row of each request, read,
 * refusal and cancel it carries out, replays included. This service maps the
 * answers, writes the list's rows (.list, and one .list.shown per patient
 * shown, both ids in details) and one denied row per refusal, and never
 * answers the target's patient id. Nothing here logs or audits a name, a date
 * of birth, a phone or a Health ID.
 */

export const REQUEST_PATIENT_MERGE_SQL = `select merge, replayed
  from identity.request_patient_merge($1::uuid, $2, $3, $4, $5)`;
export const LIST_PATIENT_MERGES_SQL = `select merge, has_more
  from identity.list_patient_merges($1, $2, $3, $4::timestamptz, $5::uuid)`;
export const READ_PATIENT_MERGE_SQL = `select merge from identity.read_patient_merge($1::uuid)`;
export const REFUSE_PATIENT_MERGE_SQL = `select merge, replayed
  from identity.refuse_patient_merge($1::uuid, $2, $3, $4, $5)`;
export const CANCEL_PATIENT_MERGE_SQL = `select merge, replayed
  from identity.cancel_patient_merge($1::uuid, $2, $3, $4)`;
/** Whether ID-8b's command of this name exists (0208 applied). */
export const PATIENT_MERGE_ID8B_PRESENT_SQL = `select exists (
  select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
   where namespace.nspname = 'identity' and proc.proname = $1) as present`;

export const PATIENT_MERGE_ACTIONS = Object.freeze({
  request: 'identity.patient-merge.request',
  list: 'identity.patient-merge.list',
  listShown: 'identity.patient-merge.list.shown',
  read: 'identity.patient-merge.read',
  refuse: 'identity.patient-merge.refuse',
  cancel: 'identity.patient-merge.cancel',
  approve: 'identity.patient-merge.approve',
  undo: 'identity.patient-merge.undo',
} as const);

type Timestamp = string | null;
export interface PatientMergeCard {
  fullName: string;
  sex: string | null;
  dateOfBirth: string | null;
  healthIdLast4: string | null;
  ninStatus: NinStatus;
  recordKind: 'standard' | 'unknown';
}
export interface PatientMergeMoves {
  visits: number; notes: number; vitals: number; diagnoses: number; prescriptions: number; labRequests: number;
  documents: number; allergies: number;
}
/** One request as 0207's functions answer it (jsonb). */
export interface PatientMergeItem {
  mergeId: string;
  status: PatientMergeStatus;
  version: number;
  requestedAt: Timestamp;
  reason: string;
  requestedByMe: boolean;
  decidedAt: Timestamp;
  decisionReason: string | null;
  cancelledAt: Timestamp;
  mergedAt: Timestamp;
  undoUntil: Timestamp;
  sourceStillAllowed: boolean | null;
  source: PatientMergeCard & { patientId: string; dateOfBirthEstimated: boolean };
  target: PatientMergeCard;
  targetPatientId: string;
  moves: PatientMergeMoves;
}
interface MergeRow extends QueryResultRow { merge: PatientMergeItem; replayed?: boolean; has_more?: boolean }

const MOVE_KEYS: readonly (keyof PatientMergeMoves)[] = ['visits', 'notes', 'vitals', 'diagnoses', 'prescriptions', 'labRequests',
  'documents', 'allergies'];

function iso(value: Timestamp | undefined): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

/**
 * The answer for one request: the contract's shape. The target card is the
 * search card's fields only; the target's patient id is never answered.
 * undoUntil is answered once the request is merged (ID-8b).
 */
export function patientMergeAnswer(item: PatientMergeItem) {
  const merged = item.status === 'merged' || item.status === 'undone';
  return {
    mergeId: item.mergeId,
    status: item.status,
    version: Number(item.version),
    requestedAt: iso(item.requestedAt),
    reason: item.reason,
    requestedByMe: item.requestedByMe === true,
    sourceStillAllowed: item.status === 'requested' ? item.sourceStillAllowed === true : null,
    decidedAt: iso(item.decidedAt),
    decisionReason: item.decisionReason ?? null,
    cancelledAt: iso(item.cancelledAt),
    ...(merged ? { mergedAt: iso(item.mergedAt), undoUntil: iso(item.undoUntil) } : {}),
    source: {
      patientId: item.source.patientId, fullName: item.source.fullName, sex: item.source.sex,
      dateOfBirth: item.source.dateOfBirth, dateOfBirthEstimated: item.source.dateOfBirthEstimated === true,
      healthIdLast4: item.source.healthIdLast4, ninStatus: item.source.ninStatus === 'verified' ? 'verified' : 'not_verified',
      recordKind: item.source.recordKind,
    },
    target: {
      fullName: item.target.fullName, sex: item.target.sex, dateOfBirth: item.target.dateOfBirth,
      healthIdLast4: item.target.healthIdLast4, ninStatus: item.target.ninStatus === 'verified' ? 'verified' : 'not_verified',
      recordKind: item.target.recordKind,
    },
    moves: Object.fromEntries(MOVE_KEYS.map((key) => [key, Number(item.moves?.[key] ?? 0)])) as unknown as PatientMergeMoves,
  };
}

/** The page cursor: the last item's request time and merge id, base64url JSON. */
export function encodePatientMergeCursor(requestedAt: string, mergeId: string): string {
  return Buffer.from(JSON.stringify({ c: requestedAt, m: mergeId }), 'utf8').toString('base64url');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A request time as 0207 answers it (PostgreSQL's jsonb timestamptz: ISO-8601 with an offset, to the microsecond). */
const CURSOR_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-](\d{2})(:\d{2})?)$/;

/** A request time PostgreSQL takes: the shape, a real calendar day (JavaScript rolls 30 February over) and an offset PostgreSQL allows. */
function cursorTime(value: string): boolean {
  const parts = CURSOR_TIME.exec(value);
  if (!parts || Number.isNaN(Date.parse(value))) return false;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && Number(parts[6] ?? 0) <= 15;
}

/**
 * The page cursor back. Only a value PostgreSQL takes as ($4::timestamptz,
 * $5::uuid) passes, so a forged cursor is 400 VALIDATION_FAILED, never a
 * database error (503).
 */
export function decodePatientMergeCursor(cursor: string | undefined): { requestedAt: string; mergeId: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: unknown; m?: unknown };
    if (typeof value.c === 'string' && cursorTime(value.c) && typeof value.m === 'string' && UUID.test(value.m)) {
      return { requestedAt: value.c, mergeId: value.m };
    }
  } catch { /* answered below */ }
  throw new DomainProblem(400, 'VALIDATION_FAILED', 'Check the highlighted fields.',
    [{ field: 'cursor', messages: ['cursor is not a page cursor of this list'] }]);
}

/** The ids a refusal's DETAIL carries (0207 sets them only when the caller may see the request). */
export function refusalIds(error: unknown): { mergeId?: string; sourcePatientId?: string; targetPatientId?: string } {
  const detail = typeof error === 'object' && error !== null ? (error as { detail?: unknown }).detail : undefined;
  if (typeof detail !== 'string') return {};
  try {
    const value = JSON.parse(detail) as Record<string, unknown>;
    const ids: { mergeId?: string; sourcePatientId?: string; targetPatientId?: string } = {};
    for (const key of ['mergeId', 'sourcePatientId', 'targetPatientId'] as const) {
      const id = value[key];
      if (typeof id === 'string' && UUID.test(id)) ids[key] = id;
    }
    return ids;
  } catch {
    return {};
  }
}

@Injectable()
export class PatientMergesService {
  private readonly logger = new Logger(PatientMergesService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** 201 for a new request; 200 with replayed: true for a replay. */
  async request(input: RequestPatientMergeDto, idempotencyKey: string, context: DataAccessContext) {
    const requestSha256 = requestDigest(PATIENT_MERGE_ACTIONS.request, {
      sourcePatientId: input.sourcePatientId, targetMatchRef: input.targetMatchRef, reason: input.reason,
      purpose: input.purpose,
    });
    let row: MergeRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<MergeRow>(
        REQUEST_PATIENT_MERGE_SQL, [input.sourcePatientId, input.targetMatchRef, input.reason, idempotencyKey,
          requestSha256])).rows[0]);
    } catch (error) {
      throw await this.refusal(context, PATIENT_MERGE_ACTIONS.request, error, { sourcePatientId: input.sourcePatientId },
        input.reason);
    }
    if (!row) throw unavailable();
    return { status: row.replayed ? 200 as const : 201 as const,
      body: { ...patientMergeAnswer(row.merge), replayed: row.replayed === true } };
  }

  /**
   * The list. The database writes no row for it; this writes .list and one
   * .list.shown per patient shown (the source and the target of each item,
   * the other's id in details), in the list's own transaction.
   */
  async list(query: ListPatientMergesDto, context: DataAccessContext) {
    const after = decodePatientMergeCursor(query.cursor);
    const limit = query.limit ?? 25;
    let rows: MergeRow[];
    try {
      rows = await this.database.withTransaction(context, async (client) => {
        const found = (await client.query<MergeRow>(LIST_PATIENT_MERGES_SQL, [query.view, query.status ?? null, limit,
          after?.requestedAt ?? null, after?.mergeId ?? null])).rows;
        await this.recordList(client, context, query, found);
        return found;
      });
    } catch (error) {
      throw await this.refusal(context, PATIENT_MERGE_ACTIONS.list, error, {});
    }
    const last = rows.at(-1);
    const hasMore = rows[0]?.has_more === true;
    return { items: rows.map((row) => patientMergeAnswer(row.merge)),
      nextCursor: hasMore && last ? encodePatientMergeCursor(String(last.merge.requestedAt), last.merge.mergeId) : null };
  }

  async read(mergeId: string, context: DataAccessContext) {
    let row: MergeRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<MergeRow>(
        READ_PATIENT_MERGE_SQL, [mergeId])).rows[0]);
    } catch (error) {
      throw await this.refusal(context, PATIENT_MERGE_ACTIONS.read, error, { mergeId });
    }
    if (!row) throw unavailable();
    return patientMergeAnswer(row.merge);
  }

  async refuse(mergeId: string, input: RefusePatientMergeDto, idempotencyKey: string, context: DataAccessContext) {
    const requestSha256 = requestDigest(PATIENT_MERGE_ACTIONS.refuse, { mergeId, expectedVersion: input.expectedVersion,
      reason: input.reason, purpose: input.purpose });
    let row: MergeRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<MergeRow>(
        REFUSE_PATIENT_MERGE_SQL, [mergeId, input.expectedVersion, input.reason, idempotencyKey, requestSha256])).rows[0]);
    } catch (error) {
      throw await this.refusal(context, PATIENT_MERGE_ACTIONS.refuse, error, { mergeId }, input.reason);
    }
    if (!row) throw unavailable();
    return { ...patientMergeAnswer(row.merge), replayed: row.replayed === true };
  }

  async cancel(mergeId: string, input: VersionedPatientMergeDto, idempotencyKey: string, context: DataAccessContext) {
    const requestSha256 = requestDigest(PATIENT_MERGE_ACTIONS.cancel, { mergeId, expectedVersion: input.expectedVersion,
      purpose: input.purpose });
    let row: MergeRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<MergeRow>(
        CANCEL_PATIENT_MERGE_SQL, [mergeId, input.expectedVersion, idempotencyKey, requestSha256])).rows[0]);
    } catch (error) {
      throw await this.refusal(context, PATIENT_MERGE_ACTIONS.cancel, error, { mergeId });
    }
    if (!row) throw unavailable();
    return { ...patientMergeAnswer(row.merge), replayed: row.replayed === true };
  }

  /**
   * Approve and undo are ID-8b's (0208), which is not built: 503
   * MERGE_UNAVAILABLE and one denied row, whether 0208's command exists or
   * not (this image carries no call to it; a later image does).
   */
  async unavailable(command: 'approve' | 'undo', mergeId: string, _input: VersionedPatientMergeDto | UndoPatientMergeDto,
    context: DataAccessContext): Promise<never> {
    let present: boolean | null = null;
    try {
      present = (await this.database.query<{ present: boolean }>(PATIENT_MERGE_ID8B_PRESENT_SQL,
        [PATIENT_MERGE_ID8B_FUNCTIONS[command]])).rows[0]?.present === true;
    } catch {
      present = null;
    }
    if (present) {
      // 0208 is applied but this image does not call it: a deploy order to fix, never a patient detail.
      this.logger.warn({ event: 'identity.patient_merge.id8b_present_image_without_merge', command,
        correlationId: context.correlationId });
    }
    const problem = unavailable();
    await this.audit.record(this.event(context, PATIENT_MERGE_ACTIONS[command], 'denied', { mergeId },
      { refusal: problem.code, id8b: present === null ? 'unknown' : present ? 'present' : 'absent' }));
    throw problem;
  }

  private async recordList(client: PoolClient, context: DataAccessContext, query: ListPatientMergesDto,
    rows: MergeRow[]): Promise<void> {
    await this.audit.recordWithClient(client, this.event(context, PATIENT_MERGE_ACTIONS.list, 'success', {}, {
      view: query.view, status: query.status ?? null, resultCount: rows.length, hasMore: rows[0]?.has_more === true,
      mergeIds: rows.map((row) => row.merge.mergeId) }));
    for (const { merge } of rows) {
      await this.audit.recordWithClient(client, this.event(context, PATIENT_MERGE_ACTIONS.listShown, 'success',
        { mergeId: merge.mergeId, patientId: merge.source.patientId },
        { mergeId: merge.mergeId, shownAs: 'source', targetPatientId: merge.targetPatientId, status: merge.status }));
      await this.audit.recordWithClient(client, this.event(context, PATIENT_MERGE_ACTIONS.listShown, 'success',
        { mergeId: merge.mergeId, patientId: merge.targetPatientId },
        { mergeId: merge.mergeId, shownAs: 'target', sourcePatientId: merge.source.patientId, status: merge.status }));
    }
  }

  private event(context: DataAccessContext, action: string, outcome: 'success' | 'denied',
    ids: { mergeId?: string; patientId?: string }, details: Record<string, unknown>, reason?: string): AuditEventInput {
    return {
      correlationId: context.correlationId, actorType: 'staff', actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId, facilityId: context.facilityId,
      ...(ids.patientId ? { patientId: ids.patientId } : {}), action, resourceType: 'patient-merge',
      ...(ids.mergeId ? { resourceId: ids.mergeId } : {}), outcome, purposeOfUse: context.purposeOfUse,
      ...(reason ? { reason } : {}), details,
    };
  }

  /**
   * A refused call: the mapped answer, and one denied row with the refusal's
   * code and the ids the database gave for it (its own rows rolled back with
   * the refusal). The source's id is the row's patient only when the database
   * named it (it is this facility's record); a 5xx writes none.
   */
  private async refusal(context: DataAccessContext, action: string, error: unknown,
    known: { mergeId?: string; sourcePatientId?: string }, reason?: string): Promise<DomainProblem | unknown> {
    const problem = patientMergeProblem(error);
    if (problem instanceof DomainProblem && problem.getStatus() < 500) {
      const ids = refusalIds(error);
      const mergeId = ids.mergeId ?? known.mergeId;
      await this.audit.record(this.event(context, action, 'denied',
        { ...(mergeId ? { mergeId } : {}), ...(ids.sourcePatientId ? { patientId: ids.sourcePatientId } : {}) },
        { refusal: problem.code,
          ...(mergeId ? { mergeId } : {}),
          ...(ids.targetPatientId ? { targetPatientId: ids.targetPatientId } : {}),
          ...(!ids.sourcePatientId && known.sourcePatientId ? { requestedSourcePatientId: known.sourcePatientId } : {}) },
        reason));
    }
    return problem;
  }
}

function unavailable(): DomainProblem {
  return new DomainProblem(503, 'MERGE_UNAVAILABLE', 'Merging records is not available right now.');
}

const REFUSALS: Readonly<Record<string, readonly [number, string, string]>> = Object.freeze({
  MERGE_DENIED: [403, 'PERMISSION_DENIED', 'You do not have permission to do this.'],
  MERGE_INVALID: [400, 'VALIDATION_FAILED', 'Check the highlighted fields.'],
  MERGE_SECOND_PERSON_REQUIRED: [403, 'MERGE_SECOND_PERSON_REQUIRED',
    'Another approver must approve this. You asked for this merge.'],
  MERGE_SEARCH_FIRST: [403, 'MERGE_SEARCH_FIRST',
    'Search for the right record first, then ask to merge. A search result can be used for 10 minutes.'],
  MERGE_NOT_FOUND: [404, 'MERGE_NOT_FOUND', 'No merge request of this facility matches.'],
  PATIENT_NOT_FOUND: [404, 'PATIENT_NOT_FOUND', 'No such patient.'],
  MERGE_SOURCE_NOT_ALLOWED: [409, 'MERGE_SOURCE_NOT_ALLOWED',
    'Only an unknown or NIN Not Verified record that nobody signs in to can be merged into another.'],
  MERGE_SAME_RECORD: [409, 'MERGE_SAME_RECORD', 'These are the same record.'],
  MERGE_TARGET_NOT_ALLOWED: [409, 'MERGE_TARGET_NOT_ALLOWED', 'This record cannot receive a merge.'],
  MERGE_ALREADY_OPEN: [409, 'MERGE_ALREADY_OPEN', 'There is already a merge request for this record.'],
  MERGE_ALREADY_DECIDED: [409, 'MERGE_ALREADY_DECIDED', 'This merge request has already been decided.'],
  IDEMPOTENCY_KEY_REUSED: [409, 'IDEMPOTENCY_KEY_REUSED',
    'This request was already sent with different details. Please reload and try again.'],
  VERSION_CONFLICT: [412, 'VERSION_CONFLICT', 'Someone else changed this merge request. Reload it and try again.'],
});
const STATES = new Set(['P0001', '22023', '42501', '40001', '23505']);

/**
 * The answer to a database refusal of these routes. A missing function or
 * table (0207 not applied) and any other database failure is 503
 * MERGE_UNAVAILABLE; the one-open-request index (two requests in a race) is
 * MERGE_ALREADY_OPEN.
 */
export function patientMergeProblem(error: unknown): DomainProblem | unknown {
  if (error instanceof DomainProblem) return error;
  if (typeof error !== 'object' || error === null) return error;
  const code = (error as { code?: unknown }).code;
  const message = String((error as { message?: unknown }).message ?? '');
  const constraint = (error as { constraint?: unknown }).constraint;
  if (code === '23505' && constraint === 'patient_merges_one_open_per_source_ux') {
    const [status, problemCode, detail] = REFUSALS.MERGE_ALREADY_OPEN as readonly [number, string, string];
    return new DomainProblem(status, problemCode, detail);
  }
  if (STATES.has(String(code)) && Object.prototype.hasOwnProperty.call(REFUSALS, message)) {
    const [status, problemCode, detail] = REFUSALS[message] as readonly [number, string, string];
    return new DomainProblem(status, problemCode, detail);
  }
  if (typeof code === 'string') return unavailable();
  return error;
}
