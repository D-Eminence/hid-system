import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type { ReportExportFormat } from './reports.dto';

/**
 * REP-1 (0203, 0204): the facility's operations report, worked out on demand from live data (owner decisions Q237 A
 * to Q241 A and Q149 A of 25 November 2026).
 *
 * Both routes work through 0203's SECURITY DEFINER functions, which check the caller again (an active membership at
 * the session facility holding reports.read, and reports.export for a download), the purpose
 * (healthcare-operations), the switch (the value this service passes, or a sealed demo or QA facility) and the range,
 * count as their owner, hide small counts in a download, and write the audit row in this request's transaction. The
 * facility is always the session's: no route takes a facility id, and no answer names a patient.
 *
 * Each call runs in one REPEATABLE READ transaction (one snapshot for every figure) with SET LOCAL
 * statement_timeout = '15s'; a timeout answers 503 REPORT_TOO_SLOW.
 */

/** The plain-words messages of the report's refusals. Staff screens show these and never the word "permission". */
export const REPORT_MESSAGES = {
  rangeInvalid: 'Choose a start date on or before the end date, ending today or earlier, within the last 2 years.',
  rangeTooLong: 'Choose a range of up to 92 days.',
  purpose: 'X-Purpose-Of-Use must be healthcare-operations for reports',
  notAllowed: 'Only this facility\'s administrators can see its reports.',
  exportNotAllowed: 'Only this facility\'s administrators can download its reports.',
  notAvailable: 'Reports are not available yet.',
  exportNotAvailable: 'Downloading reports is not available yet.',
  tooSlow: 'This report took too long. Try a shorter range, or try again later.',
  validation: 'Check the highlighted fields.',
} as const;

/** At most this many Lagos days in one range, both ends included. */
export const REPORT_MAX_DAYS = 92;
/** The database's limit on one report call. */
export const REPORT_STATEMENT_TIMEOUT = '15s';

export const READ_SQL = 'select ehr.facility_report_operations($1::date, $2::date, $3) as report';
export const EXPORT_SQL = 'select ehr.facility_report_operations_export($1::date, $2::date, $3, $4) as report';

export type ReportFigureKind = 'count' | 'median_minutes';

/** One day of a figure's line: a count, or a median with its sample size. Hidden in a download: null, suppressed. */
export interface ReportDailyEntry {
  day: string;
  value: number | null;
  sampleSize?: number | null;
  suppressed?: true;
}

/** How many check-ins in each period record when a clinician first saw the patient (the tracked figures). */
export interface ReportCoverage {
  tracked: number | null;
  trackedSuppressed?: true;
  previousTracked: number | null;
  previousTrackedSuppressed?: true;
}

export interface ReportReason {
  reason: string;
  current: number | null;
  currentSuppressed?: true;
  previous: number | null;
  previousSuppressed?: true;
}

export interface ReportFigure {
  key: string;
  kind: ReportFigureKind;
  current: number | null;
  currentSuppressed?: true;
  previous: number | null;
  previousSuppressed?: true;
  sampleSize?: number | null;
  sampleSizeSuppressed?: true;
  previousSampleSize?: number | null;
  previousSampleSizeSuppressed?: true;
  coverage?: ReportCoverage;
  byReason?: ReportReason[];
  daily: ReportDailyEntry[];
}

export interface ReportSection {
  key: string;
  figures: ReportFigure[];
}

/** Route 1's answer (and route 2's, with small counts hidden). */
export interface OperationsReport {
  report: 'operations';
  facilityId: string;
  from: string;
  to: string;
  days: number;
  previousFrom: string;
  previousTo: string;
  includesToday: boolean;
  timeZone: 'Africa/Lagos';
  generatedAt: string;
  definitions: { version: string; signedOff: boolean };
  sections: ReportSection[];
}

/** Route 2's answer: the report with small counts hidden, and the record of the download. */
export interface OperationsReportExport extends OperationsReport {
  export: { format: ReportExportFormat; minimumCount: number; suppressedValues: number; recordedAt: string };
}

export function reportsEnabled(): boolean {
  return getEnvironment().REPORTS_ENABLED;
}

/** The download's switch: both settings on. */
export function reportExportsEnabled(): boolean {
  const environment = getEnvironment();
  return environment.REPORTS_ENABLED && environment.REPORTS_EXPORT_ENABLED;
}

export type ReportAccess = 'read' | 'export';

/**
 * The session's codes at this facility, checked before the database decides again: reports.read, and reports.export
 * for a download. No backend role but admin and org_admin holds either (0204, Q240 A).
 */
export function requireReportAccess(request: HidRequest, access: ReportAccess): void {
  const held = new Set(request.actor?.permissions ?? []);
  if (!held.has('reports.read')) {
    throw new DomainProblem(403, access === 'export' ? 'REPORTS_EXPORT_NOT_ALLOWED' : 'REPORTS_NOT_ALLOWED',
      access === 'export' ? REPORT_MESSAGES.exportNotAllowed : REPORT_MESSAGES.notAllowed);
  }
  if (access === 'export' && !held.has('reports.export')) {
    throw new DomainProblem(403, 'REPORTS_EXPORT_NOT_ALLOWED', REPORT_MESSAGES.exportNotAllowed);
  }
}

/** Today's Lagos calendar day, YYYY-MM-DD, whatever the server's zone. */
export function lagosToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit',
    day: '2-digit' }).format(now);
}

function dayNumber(day: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, date) / 86_400_000;
}

/** The same calendar day 2 years earlier (29 February to 28 February, as PostgreSQL's date - interval '2 years'). */
export function twoYearsBefore(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(year - 2, month, 0)).getUTCDate();
  return `${String(year - 2).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(date, lastDay)).padStart(2, '0')}`;
}

/**
 * The range rules, before the database checks them again: from on or before to, to today (Lagos) or earlier, from
 * no more than 2 years before today, and at most 92 days, both included.
 */
export function checkReportRange(from: string, to: string, today: string = lagosToday()): void {
  if (from > to || to > today || from < twoYearsBefore(today)) {
    throw new DomainProblem(400, 'REPORT_RANGE_INVALID', REPORT_MESSAGES.rangeInvalid);
  }
  if (dayNumber(to) - dayNumber(from) + 1 > REPORT_MAX_DAYS) {
    throw new DomainProblem(400, 'REPORT_RANGE_TOO_LONG', REPORT_MESSAGES.rangeTooLong);
  }
}

@Injectable()
export class ReportsService {
  constructor(private readonly database: DatabaseService) {}

  /** Route 1: the report, values as they are. */
  async read(context: DataAccessContext, from: string, to: string): Promise<OperationsReport> {
    checkReportRange(from, to);
    const raw = await this.call(context, READ_SQL, [from, to, reportsEnabled()], 'read');
    return toReport(raw);
  }

  /** Route 2: the report with small counts hidden by the database, and the record of the download. */
  async export(context: DataAccessContext, from: string, to: string,
    format: ReportExportFormat): Promise<OperationsReportExport> {
    checkReportRange(from, to);
    const raw = await this.call(context, EXPORT_SQL, [from, to, format, reportExportsEnabled()], 'export');
    return toReportExport(raw);
  }

  private async call(context: DataAccessContext, sql: string, values: readonly unknown[],
    route: ReportAccess): Promise<unknown> {
    try {
      return await this.database.withTransaction(context, async (client: PoolClient) => {
        await client.query(`set local statement_timeout = '${REPORT_STATEMENT_TIMEOUT}'`);
        const result = await client.query<{ report: unknown }>(sql, [...values]);
        return result.rows[0]?.report;
      }, { isolationLevel: 'REPEATABLE READ' });
    } catch (error) {
      throw translateReportError(error, route);
    }
  }
}

/** The database's refusals, in plain words; anything else is passed on. */
export function translateReportError(error: unknown, route: ReportAccess): unknown {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  const notAvailable = () => new DomainProblem(503, 'REPORTS_NOT_AVAILABLE', REPORT_MESSAGES.notAvailable);
  switch (code) {
    case '42501':
      if (message === 'REPORTS_NOT_PERMITTED') {
        return route === 'export'
          ? new DomainProblem(403, 'REPORTS_EXPORT_NOT_ALLOWED', REPORT_MESSAGES.exportNotAllowed)
          : new DomainProblem(403, 'REPORTS_NOT_ALLOWED', REPORT_MESSAGES.notAllowed);
      }
      if (message === 'REPORTS_EXPORT_NOT_PERMITTED') {
        return new DomainProblem(403, 'REPORTS_EXPORT_NOT_ALLOWED', REPORT_MESSAGES.exportNotAllowed);
      }
      // A database whose runtime role may not run the functions yet (runtime-grants.sql not applied).
      return notAvailable();
    case '42883':
    case '3F000':
    case '42P01':
      // A database without 0203.
      return notAvailable();
    case '22023':
      switch (message) {
        case 'REPORTS_OPERATIONS_PURPOSE_ONLY':
          return new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', REPORT_MESSAGES.purpose);
        case 'REPORT_RANGE_INVALID':
          return new DomainProblem(400, 'REPORT_RANGE_INVALID', REPORT_MESSAGES.rangeInvalid);
        case 'REPORT_RANGE_TOO_LONG':
          return new DomainProblem(400, 'REPORT_RANGE_TOO_LONG', REPORT_MESSAGES.rangeTooLong);
        case 'REPORT_FORMAT_INVALID':
          return new DomainProblem(400, 'VALIDATION_FAILED', REPORT_MESSAGES.validation,
            [{ field: 'format', messages: ['format must be one of the following values: csv, pdf'] }]);
        default:
          return error;
      }
    case '55000':
      if (message === 'REPORTS_SWITCHED_OFF') return notAvailable();
      if (message === 'REPORTS_EXPORT_SWITCHED_OFF') {
        return reportsEnabled()
          ? new DomainProblem(503, 'REPORTS_EXPORT_NOT_AVAILABLE', REPORT_MESSAGES.exportNotAvailable)
          : notAvailable();
      }
      return error;
    case '57014':
      return new DomainProblem(503, 'REPORT_TOO_SLOW', REPORT_MESSAGES.tooSlow);
    default:
      return error;
  }
}

type Json = Record<string, unknown>;

function object(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`The report answer has no ${what}`);
  }
  return value as Json;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`The report answer has no ${what}`);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`The report answer has no ${what}`);
  return value;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Copies a number field and, when the database hid it, its <field>Suppressed flag right after it. */
function numberField<Target extends object>(target: Target, source: Json, name: string): void {
  Object.assign(target, { [name]: count(source[name]) });
  if (source[`${name}Suppressed`] === true) Object.assign(target, { [`${name}Suppressed`]: true });
}

function toDaily(value: unknown, kind: ReportFigureKind): ReportDailyEntry {
  const source = object(value, 'daily entry');
  const entry: ReportDailyEntry = { day: text(source.day, 'day'), value: count(source.value) };
  if (kind === 'median_minutes') entry.sampleSize = count(source.sampleSize);
  if (source.suppressed === true) entry.suppressed = true;
  return entry;
}

function toFigure(value: unknown): ReportFigure {
  const source = object(value, 'figure');
  const kind = source.kind === 'median_minutes' ? 'median_minutes' : 'count';
  const figure = { key: text(source.key, 'figure key'), kind } as ReportFigure;
  numberField(figure, source, 'current');
  numberField(figure, source, 'previous');
  if (kind === 'median_minutes') {
    numberField(figure, source, 'sampleSize');
    numberField(figure, source, 'previousSampleSize');
  }
  if (source.coverage !== undefined) {
    const coverageSource = object(source.coverage, 'coverage');
    const coverage = {} as ReportCoverage;
    numberField(coverage, coverageSource, 'tracked');
    numberField(coverage, coverageSource, 'previousTracked');
    figure.coverage = coverage;
  }
  if (source.byReason !== undefined) {
    figure.byReason = list(source.byReason, 'reasons').map((reasonValue) => {
      const reasonSource = object(reasonValue, 'reason');
      const reason = { reason: text(reasonSource.reason, 'reason') } as ReportReason;
      numberField(reason, reasonSource, 'current');
      numberField(reason, reasonSource, 'previous');
      return reason;
    });
  }
  figure.daily = list(source.daily, 'daily line').map((entry) => toDaily(entry, kind));
  return figure;
}

/** The database's report, in the contract's field order; nothing else it might carry is passed on. */
export function toReport(value: unknown): OperationsReport {
  const source = object(value, 'report');
  if (source.report !== 'operations') throw new Error('The report answer is not the operations report');
  const definitions = object(source.definitions, 'definitions');
  return {
    report: 'operations',
    facilityId: text(source.facilityId, 'facility'),
    from: text(source.from, 'from'),
    to: text(source.to, 'to'),
    days: count(source.days) ?? 0,
    previousFrom: text(source.previousFrom, 'previousFrom'),
    previousTo: text(source.previousTo, 'previousTo'),
    includesToday: source.includesToday === true,
    timeZone: 'Africa/Lagos',
    generatedAt: text(source.generatedAt, 'generatedAt'),
    definitions: { version: text(definitions.version, 'definitions version'), signedOff: definitions.signedOff === true },
    sections: list(source.sections, 'sections').map((sectionValue) => {
      const section = object(sectionValue, 'section');
      return { key: text(section.key, 'section key'), figures: list(section.figures, 'figures').map(toFigure) };
    }),
  };
}

export function toReportExport(value: unknown): OperationsReportExport {
  const source = object(value, 'report');
  const record = object(source.export, 'export record');
  return {
    ...toReport(source),
    export: {
      format: record.format === 'pdf' ? 'pdf' : 'csv',
      minimumCount: count(record.minimumCount) ?? 5,
      suppressedValues: count(record.suppressedValues) ?? 0,
      recordedAt: text(record.recordedAt, 'recordedAt'),
    },
  };
}
