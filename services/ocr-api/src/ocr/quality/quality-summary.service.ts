import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { REVIEW_OUTCOME_SCHEMA, type OutcomeBucket } from './review-outcome';

/** A group with fewer items (or, for review groups, fewer reviews) than this is returned suppressed, with no counts. */
export const MIN_GROUP_SIZE = 20;
/**
 * Inside a group that is shown, a reason or field-class count under this is left out (the number of cells left out
 * is returned as smallCellsHidden): a single wrong_patient rejection in a week must not point at one review.
 */
export const MIN_CELL_SIZE = 5;
export const MAX_RANGE_DAYS = 92;
/** The most reviews one summary reads; more and the answer says truncated. */
export const MAX_REVIEWS = 50_000;

/** Platform administration authority, and the operations-read permission, as Identity's admin routes require. */
export const QUALITY_PERMISSIONS = ['platform.admin.access', 'platform.operations.read'] as const;

/**
 * The strictest admin gate in the platform (Identity requireAdminContext plus a specific platform permission): a
 * staff actor whose platform permissions include platform.admin.access and platform.operations.read. Facility
 * permissions do not count. Anyone else gets 403 PERMISSION_DENIED.
 */
export function assertQualityReader(request: HidRequest): void {
  const actor = request.actor as (HidRequest['actor'] & { platformPermissions?: readonly string[] }) | undefined;
  if (!actor || actor.kind === 'patient'
    || !QUALITY_PERMISSIONS.every((permission) => actor.platformPermissions?.includes(permission))) {
    throw new DomainProblem(403, 'PERMISSION_DENIED', 'Platform administration authority is required');
  }
}

export interface OutcomeRow extends QueryResultRow {
  week: string;
  facility_id: string;
  outcome: unknown;
}

type Counts = Record<string, number>;
export interface ItemGroup {
  week: string; facilityId: string; kind: string; promptVersion: string | null; items: number;
  decisions: Counts; byConfidence: Record<string, Counts>; byReadBy: Record<string, Counts>;
  hardPage: Record<string, Counts>; fieldChanges: Counts; checkReasons: Record<string, Counts>;
  smallCellsHidden?: number;
}
export interface ReviewGroup {
  week: string; facilityId: string; promptVersion: string | null; reviews: number; validated: number;
  rejected: number; estimated: number; summaryFailed: number; reviewConfirmed: number; missedItems: number;
  rejectionReasons: Counts; removalReasons: Counts; changeReasons: Counts; correctionFields: Counts;
  smallCellsHidden?: number;
}
type Suppressed<Group, Keys extends keyof Group> = Pick<Group, Keys> & { suppressed: true };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const add = (counts: Counts, key: string, by = 1) => { counts[key] = (counts[key] ?? 0) + by; };
const addAll = (counts: Counts, from: unknown) => {
  if (!isRecord(from)) return;
  for (const [key, value] of Object.entries(from)) if (typeof value === 'number' && value > 0) add(counts, key, value);
};
const nested = (record: Record<string, Counts>, key: string): Counts => (record[key] ??= {});

/** Removes counts under MIN_CELL_SIZE from a reason / field-class map in place; returns how many were removed. */
function hideSmall(counts: Counts): number {
  let hidden = 0;
  for (const [key, value] of Object.entries(counts)) {
    if (value < MIN_CELL_SIZE) { delete counts[key]; hidden += 1; }
  }
  return hidden;
}

function hideSmallItemCells(group: ItemGroup): ItemGroup {
  let hidden = hideSmall(group.fieldChanges);
  for (const [code, counts] of Object.entries(group.checkReasons)) {
    hidden += hideSmall(counts);
    if (Object.keys(counts).length === 0) delete group.checkReasons[code];
  }
  return hidden ? { ...group, smallCellsHidden: hidden } : group;
}

function hideSmallReviewCells(group: ReviewGroup): ReviewGroup {
  const hidden = hideSmall(group.rejectionReasons) + hideSmall(group.removalReasons) + hideSmall(group.changeReasons)
    + hideSmall(group.correctionFields);
  return hidden ? { ...group, smallCellsHidden: hidden } : group;
}

/**
 * Sums stored review outcomes by ISO week, facility, item kind and prompt version (items), and by ISO week,
 * facility and prompt version (reviews). No per-reviewer figure exists in the input or the output.
 */
export function aggregateReviewOutcomes(rows: readonly OutcomeRow[]) {
  const items = new Map<string, ItemGroup>();
  const reviews = new Map<string, ReviewGroup>();
  for (const row of rows) {
    const outcome = row.outcome;
    if (!isRecord(outcome) || outcome.schema !== REVIEW_OUTCOME_SCHEMA) continue;
    const promptVersion = typeof outcome.promptVersion === 'string' ? outcome.promptVersion : null;
    const reviewKey = [row.week, row.facility_id, promptVersion].join('|');
    let review = reviews.get(reviewKey);
    if (!review) {
      review = { week: row.week, facilityId: row.facility_id, promptVersion, reviews: 0, validated: 0, rejected: 0,
        estimated: 0, summaryFailed: 0, reviewConfirmed: 0, missedItems: 0, rejectionReasons: {}, removalReasons: {},
        changeReasons: {}, correctionFields: {} };
      reviews.set(reviewKey, review);
    }
    review.reviews += 1;
    if (outcome.error !== undefined) { review.summaryFailed += 1; continue; }
    if (outcome.disposition === 'validated') review.validated += 1;
    if (outcome.disposition === 'rejected') review.rejected += 1;
    if (outcome.estimated === true) review.estimated += 1;
    const reviewer = isRecord(outcome.reviewer) ? outcome.reviewer : {};
    if (reviewer.reviewConfirmed === true) review.reviewConfirmed += 1;
    if (typeof reviewer.missedItems === 'number') review.missedItems += reviewer.missedItems;
    if (typeof reviewer.rejectionReasonCode === 'string') add(review.rejectionReasons, reviewer.rejectionReasonCode);
    addAll(review.removalReasons, reviewer.removalReasons);
    addAll(review.changeReasons, reviewer.changeReasons);
    addAll(review.correctionFields, reviewer.correctionFields);
    for (const bucket of Array.isArray(outcome.buckets) ? outcome.buckets as Partial<OutcomeBucket>[] : []) {
      if (!isRecord(bucket) || typeof bucket.items !== 'number' || typeof bucket.kind !== 'string'
        || typeof bucket.decision !== 'string') continue;
      const key = [row.week, row.facility_id, bucket.kind, promptVersion].join('|');
      let group = items.get(key);
      if (!group) {
        group = { week: row.week, facilityId: row.facility_id, kind: bucket.kind, promptVersion, items: 0,
          decisions: {}, byConfidence: {}, byReadBy: {}, hardPage: {}, fieldChanges: {}, checkReasons: {} };
        items.set(key, group);
      }
      group.items += bucket.items;
      add(group.decisions, bucket.decision, bucket.items);
      add(nested(group.byConfidence, String(bucket.confidence)), bucket.decision, bucket.items);
      add(nested(group.byReadBy, String(bucket.readBy)), bucket.decision, bucket.items);
      add(nested(group.hardPage, String(bucket.hardPage === true)), bucket.decision, bucket.items);
      addAll(group.fieldChanges, bucket.fieldChanges);
      if (isRecord(bucket.checkReasons)) {
        for (const [code, count] of Object.entries(bucket.checkReasons)) {
          if (typeof count === 'number') add(nested(group.checkReasons, code), bucket.decision, count);
        }
      }
    }
  }
  const order = (a: { week: string; facilityId: string }, b: { week: string; facilityId: string }) =>
    a.week.localeCompare(b.week) || a.facilityId.localeCompare(b.facilityId);
  const itemGroups = [...items.values()].sort(order).map((group): ItemGroup
    | Suppressed<ItemGroup, 'week' | 'facilityId' | 'kind' | 'promptVersion'> => (group.items < MIN_GROUP_SIZE
    ? { week: group.week, facilityId: group.facilityId, kind: group.kind, promptVersion: group.promptVersion,
      suppressed: true } : hideSmallItemCells(group)));
  const reviewGroups = [...reviews.values()].sort(order).map((group): ReviewGroup
    | Suppressed<ReviewGroup, 'week' | 'facilityId' | 'promptVersion'> => (group.reviews < MIN_GROUP_SIZE
    ? { week: group.week, facilityId: group.facilityId, promptVersion: group.promptVersion, suppressed: true }
    : hideSmallReviewCells(group)));
  return { itemGroups, reviewGroups };
}

const DAY_MS = 86_400_000;

function range(from: string | undefined, to: string | undefined, now: Date): { from: string; to: string } {
  const today = now.toISOString().slice(0, 10);
  const end = to ?? today;
  const start = from ?? new Date(Date.parse(`${end}T00:00:00Z`) - 27 * DAY_MS).toISOString().slice(0, 10);
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)
    || new Date(startMs).toISOString().slice(0, 10) !== start || new Date(endMs).toISOString().slice(0, 10) !== end) {
    throw new DomainProblem(400, 'OCR_QUALITY_RANGE_INVALID', 'from and to must be real dates (YYYY-MM-DD)');
  }
  if (endMs < startMs || (endMs - startMs) / DAY_MS + 1 > MAX_RANGE_DAYS) {
    throw new DomainProblem(400, 'OCR_QUALITY_RANGE_INVALID',
      `from must not be after to, and the range must be at most ${MAX_RANGE_DAYS} days`);
  }
  // Groups are ISO weeks: the range is widened to whole weeks (Monday to Sunday), so two ranges differing by a
  // day cannot be subtracted to show a suppressed day.
  const monday = startMs - ((new Date(startMs).getUTCDay() + 6) % 7) * DAY_MS;
  const sunday = endMs + ((7 - new Date(endMs).getUTCDay()) % 7) * DAY_MS;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: day(monday), to: day(sunday) };
}

@Injectable()
export class OcrQualityService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  /**
   * Review outcomes of the bound facility (X-Facility-ID). ocr.validations has row-level security by
   * platform.current_facility_id() (0013) and no cross-facility policy, so the runtime role reads one facility per
   * request; the facility grouping is kept so a later cross-facility read (README "Review outcomes") answers in the
   * same shape.
   */
  async summary(query: { from?: string; to?: string }, context: DataAccessContext, now = new Date()) {
    const window = range(query.from, query.to, now);
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<OutcomeRow>(
        `select to_char(validation.created_at at time zone 'UTC', 'IYYY-"W"IW') as week,
                validation.facility_id::text as facility_id,
                validation.provenance -> 'reviewOutcome' as outcome
           from ocr.validations validation
          where validation.created_at >= $1::date and validation.created_at < ($2::date + 1)
            and validation.provenance -> 'reviewOutcome' ->> 'schema' = $3
          order by validation.created_at limit $4`,
        [window.from, window.to, REVIEW_OUTCOME_SCHEMA, MAX_REVIEWS + 1]);
      const truncated = result.rows.length > MAX_REVIEWS;
      const { itemGroups, reviewGroups } = aggregateReviewOutcomes(result.rows.slice(0, MAX_REVIEWS));
      const suppressed = [...itemGroups, ...reviewGroups].filter((group) => 'suppressed' in group).length;
      await this.audit.recordWithClient(client, {
        correlationId: context.correlationId, actorType: 'staff', actorSubject: context.actor.subject,
        actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId,
        organizationId: context.actor.facility?.organizationId, facilityId: context.facilityId,
        action: 'ocr.quality.summary.read', resourceType: 'ocr-quality-summary', outcome: 'success',
        purposeOfUse: context.purposeOfUse, sourceSystem: 'ocr-api',
        details: { from: window.from, to: window.to, reviews: Math.min(result.rows.length, MAX_REVIEWS), truncated,
          itemGroups: itemGroups.length, reviewGroups: reviewGroups.length, suppressedGroups: suppressed },
      });
      return { schema: 'hid.ocr.quality-summary/v1', from: window.from, to: window.to,
        scope: 'bound_facility', minGroupSize: MIN_GROUP_SIZE, truncated, itemGroups, reviewGroups };
    });
  }
}
