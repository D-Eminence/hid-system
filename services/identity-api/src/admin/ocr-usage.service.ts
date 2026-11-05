import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DomainProblem } from '../common/problem';
import type { PlatformAdminContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { OcrPageLimitCommandDto } from './dto/ocr-usage.dto';
import { estimateOcrCostUsd } from './ocr-usage.pricing';

interface AllowanceRow extends QueryResultRow {
  pages_used: number | string;
  pages_limit: number | string;
  resets_on: string;
  paused: boolean;
}

interface UsageRow extends QueryResultRow {
  model: string;
  requests: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  cache_read_tokens: string | number;
  cache_write_tokens: string | number;
  pages: string | number;
}

export interface OcrModelUsage {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface FacilityOcrUsage {
  /** The Africa/Lagos month reported, YYYY-MM. */
  month: string;
  pagesUsed: number;
  pagesLimit: number;
  resetsOn: string;
  paused: boolean;
  byModel: OcrModelUsage[];
  textractPages: number;
  estimatedCostUsd: number | null;
}

/** The model name ocr.facility_ocr_usage gives the Textract row (pages only, tokens 0). */
const TEXTRACT_ROW = 'textract';
const LAGOS_MONTH = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit' });

/** The Africa/Lagos calendar month of an instant, YYYY-MM. */
export function lagosMonth(instant: Date): string {
  const parts = LAGOS_MONTH.formatToParts(instant);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}`;
}

/**
 * A facility's OCR page allowance and its month's use (migration 0107), for platform administrators. Every
 * read and the one command run in a platform transaction with no facility or membership, and the database
 * decides: ocr.facility_page_allowance and ocr.facility_ocr_usage take platform.admin.access, and
 * ocr.set_facility_page_limit only a platform super admin (a cost decision). The command writes its own
 * platform audit row (admin.ocr.page-limit.set); refusals are audited by the route (AuditFailuresOnly).
 */
@Injectable()
export class AdminOcrUsageService {
  constructor(private readonly database: DatabaseService) {}

  async usage(context: PlatformAdminContext, facilityId: string, month?: string,
    now: Date = new Date()): Promise<FacilityOcrUsage> {
    const current = lagosMonth(now);
    const reported = month ?? current;
    try {
      const platform = platformScoped(context);
      const { allowance, rows } = await this.database.withPlatformTransaction(platform, async (client) => {
        const allowanceResult = await client.query<AllowanceRow>(
          `select pages_used, pages_limit, resets_on::text as resets_on, paused
             from ocr.facility_page_allowance($1)`, [facilityId]);
        const usageResult = await client.query<UsageRow>(
          `select model, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, pages
             from ocr.facility_ocr_usage($1, $2::date)`, [facilityId, `${reported}-01`]);
        return { allowance: allowanceResult.rows[0], rows: usageResult.rows };
      }, { readOnly: true });
      if (!allowance) throw new DomainProblem(404, 'FACILITY_NOT_FOUND', 'Facility was not found');
      const byModel = rows.filter((row) => row.model !== TEXTRACT_ROW).map((row) => ({
        model: row.model, requests: count(row.requests), inputTokens: count(row.input_tokens),
        outputTokens: count(row.output_tokens), cacheReadTokens: count(row.cache_read_tokens),
        cacheWriteTokens: count(row.cache_write_tokens) }));
      const textractPages = rows.filter((row) => row.model === TEXTRACT_ROW)
        .reduce((sum, row) => sum + count(row.pages), 0);
      return {
        month: reported,
        // The allowance is this month's; for another month the pages counted then are the use.
        pagesUsed: reported === current ? count(allowance.pages_used) : textractPages,
        pagesLimit: count(allowance.pages_limit),
        resetsOn: String(allowance.resets_on),
        paused: allowance.paused === true,
        byModel,
        textractPages,
        estimatedCostUsd: estimateOcrCostUsd(textractPages, byModel),
      };
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  async setPageLimit(context: PlatformAdminContext, facilityId: string, input: OcrPageLimitCommandDto): Promise<void> {
    // The database refuses anyone else too; this answers plainly before a transaction is opened.
    if (!context.actor.platformRoles?.includes('platform_super_admin')) throw superAdminRequired();
    try {
      await this.database.withPlatformTransaction(platformScoped(context), (client) =>
        client.query('select ocr.set_facility_page_limit($1, $2, $3)', [facilityId, input.pagesLimit, input.reason]));
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }
}

/** The 0107 commands want a platform-scoped session: no facility and no membership. */
function platformScoped(context: PlatformAdminContext): PlatformAdminContext {
  const { facilityId: _facility, membershipId: _membership, ...platform } = context;
  return platform;
}

function count(value: string | number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new DomainProblem(503, 'OCR_USAGE_UNAVAILABLE', 'OCR usage is unavailable');
  }
  return number;
}

function superAdminRequired(): DomainProblem {
  return new DomainProblem(403, 'PLATFORM_SUPER_ADMIN_REQUIRED',
    "Only a platform super admin can change a facility's monthly page limit");
}

function mapDatabaseError(error: unknown): DomainProblem {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === '42501') return new DomainProblem(403, 'PERMISSION_DENIED', 'You are not allowed to do this');
  if (code === 'P0002') return new DomainProblem(404, 'FACILITY_NOT_FOUND', 'Facility was not found');
  if (code === '22023' || code === '22007' || code === '22008') {
    return new DomainProblem(400, 'OCR_USAGE_REQUEST_INVALID', 'The page limit or month is not valid');
  }
  return new DomainProblem(503, 'OCR_USAGE_UNAVAILABLE', 'OCR usage is unavailable');
}
