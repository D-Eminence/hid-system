import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DomainProblem } from '../common/problem';
import type { PlatformAdminContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { OcrLearningSwitchCommandDto } from './dto/ocr-learning.dto';

export const MAX_SUMMARY_DAYS = 92;
const DAY_MS = 86_400_000;

interface SummaryRow extends QueryResultRow {
  group_type: string; week: string; facility_id: string; kind: string | null; prompt_version: string | null;
  measure: string; value: string | number;
}
interface OverviewRow extends QueryResultRow {
  scope: string; facility_id: string | null; enabled: boolean; active_rules: number; retired_rules: number;
  showings_180d: number; rejected_180d: number;
}

type Counts = Record<string, number>;
export interface PlatformItemGroup { week: string; facilityId: string; kind: string; promptVersion: string | null;
  suppressed?: true; decisions?: Counts }
export interface PlatformReviewGroup { week: string; facilityId: string; promptVersion: string | null;
  suppressed?: true; counts?: Counts }

/**
 * The requested range widened to whole ISO weeks (Monday to Sunday), as ocr-api's bound-facility summary does, so
 * two ranges a day apart cannot be subtracted to show a suppressed day.
 */
export function summaryRange(from: string | undefined, to: string | undefined, now: Date): { from: string; to: string } {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const end = to ?? day(now.getTime());
  const start = from ?? day(Date.parse(`${end}T00:00:00Z`) - 27 * DAY_MS);
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || day(startMs) !== start || day(endMs) !== end
    || endMs < startMs || (endMs - startMs) / DAY_MS + 1 > MAX_SUMMARY_DAYS) {
    throw new DomainProblem(400, 'OCR_QUALITY_RANGE_INVALID',
      `from and to must be real days, from not after to, at most ${MAX_SUMMARY_DAYS} days`);
  }
  const monday = startMs - ((new Date(startMs).getUTCDay() + 6) % 7) * DAY_MS;
  const sunday = endMs + ((7 - new Date(endMs).getUTCDay()) % 7) * DAY_MS;
  return { from: day(monday), to: day(sunday) };
}

const toCount = (value: string | number): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new DomainProblem(503, 'OCR_LEARNING_UNAVAILABLE', 'OCR learning is unavailable');
  }
  return number;
};

/** Rows of ocr.review_outcome_summary (0119) as groups: decisions per item group, counts per review group. */
export function summaryGroups(rows: readonly SummaryRow[]) {
  const items = new Map<string, PlatformItemGroup>();
  const reviews = new Map<string, PlatformReviewGroup>();
  for (const row of rows) {
    if (row.group_type === 'item') {
      const key = [row.week, row.facility_id, row.kind, row.prompt_version].join('|');
      const group = items.get(key) ?? { week: row.week, facilityId: row.facility_id, kind: row.kind ?? 'other',
        promptVersion: row.prompt_version };
      if (row.measure === 'suppressed') group.suppressed = true;
      else (group.decisions ??= {})[row.measure] = toCount(row.value);
      items.set(key, group);
    } else if (row.group_type === 'review') {
      const key = [row.week, row.facility_id, row.prompt_version].join('|');
      const group = reviews.get(key) ?? { week: row.week, facilityId: row.facility_id, promptVersion: row.prompt_version };
      if (row.measure === 'suppressed') group.suppressed = true;
      else (group.counts ??= {})[row.measure] = toCount(row.value);
      reviews.set(key, group);
    }
  }
  return { itemGroups: [...items.values()], reviewGroups: [...reviews.values()] };
}

/**
 * OCR learning in the admin console (migration 0119): the platform-wide review-outcome summary (every facility,
 * aggregate only, suppressed in the database), the rule counts per rule set, and the owner kill switches. Every call
 * runs in a platform transaction with no facility or membership, and the database decides who may: platform.admin.access
 * for the overview, plus platform.operations.read for the summary, and only a platform super admin for a switch. The
 * summary and the switch write their own platform audit rows; refusals are audited by the route.
 */
@Injectable()
export class AdminOcrLearningService {
  constructor(private readonly database: DatabaseService) {}

  async qualitySummary(context: PlatformAdminContext, query: { from?: string; to?: string }, now = new Date()) {
    const range = summaryRange(query.from, query.to, now);
    try {
      const rows = await this.database.withPlatformTransaction(platformScoped(context), async (client) =>
        (await client.query<SummaryRow>(
          `select group_type, week, facility_id::text as facility_id, kind, prompt_version, measure, value
             from ocr.review_outcome_summary($1::date, $2::date)`, [range.from, range.to])).rows);
      return { schema: 'hid.ocr.quality-summary/v1', scope: 'platform', from: range.from, to: range.to,
        minGroupSize: 20, ...summaryGroups(rows) };
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  async overview(context: PlatformAdminContext) {
    try {
      const rows = await this.database.withPlatformTransaction(platformScoped(context), async (client) =>
        (await client.query<OverviewRow>(
          `select scope, facility_id::text as facility_id, enabled, active_rules, retired_rules, showings_180d,
                  rejected_180d from ocr.learning_overview()`)).rows, { readOnly: true });
      return { ruleSets: rows.map((row) => ({ scope: row.scope, facilityId: row.facility_id, enabled: row.enabled === true,
        activeRules: toCount(row.active_rules), retiredRules: toCount(row.retired_rules),
        showingsLast180Days: toCount(row.showings_180d), notTakenLast180Days: toCount(row.rejected_180d) })) };
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  async setSwitch(context: PlatformAdminContext, input: OcrLearningSwitchCommandDto): Promise<void> {
    if (!context.actor.platformRoles?.includes('platform_super_admin')) {
      throw new DomainProblem(403, 'PLATFORM_SUPER_ADMIN_REQUIRED',
        'Only a platform super admin can switch OCR suggestions off or on');
    }
    if ((input.scope === 'facility') !== (input.facilityId !== undefined)) {
      throw new DomainProblem(400, 'OCR_LEARNING_SWITCH_INVALID', 'facilityId is required with scope facility only');
    }
    try {
      await this.database.withPlatformTransaction(platformScoped(context), (client) =>
        client.query('select ocr.set_learning_switch($1, $2, $3, $4)',
          [input.scope, input.facilityId ?? null, input.enabled, input.reason]));
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }
}

/** The 0119 commands want a platform-scoped session: no facility and no membership. */
function platformScoped(context: PlatformAdminContext): PlatformAdminContext {
  const { facilityId: _facility, membershipId: _membership, ...platform } = context;
  return platform;
}

function mapDatabaseError(error: unknown): DomainProblem {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === '42501') return new DomainProblem(403, 'PERMISSION_DENIED', 'You are not allowed to do this');
  if (code === 'P0002') return new DomainProblem(404, 'FACILITY_NOT_FOUND', 'Facility was not found');
  if (code === '22023' || code === '22007' || code === '22008') {
    return new DomainProblem(400, 'OCR_LEARNING_REQUEST_INVALID', 'The request is not valid');
  }
  return new DomainProblem(503, 'OCR_LEARNING_UNAVAILABLE', 'OCR learning is unavailable');
}
