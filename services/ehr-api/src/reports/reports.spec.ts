import { RequestMethod } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { HEADERS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AUDIT_ACTION } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { createValidationPipe } from '../common/validation-pipe';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { ReportsController } from './reports.controller';
import { ReportExportDto, ReportRangeQueryDto } from './reports.dto';
import {
  EXPORT_SQL, READ_SQL, REPORT_MESSAGES, ReportsService, checkReportRange, lagosToday, requireReportAccess, toReport,
  toReportExport, translateReportError, twoYearsBefore,
} from './reports.service';

// Fictional identifiers only.
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const ADMIN = ['audit.read', 'workforce.manage', 'reports.read', 'reports.export'];

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'healthcare-operations',
  actor: { id: accountId, subject: 'staff:test', accountId, permissions: ADMIN } } as unknown as DataAccessContext;

/** A day relative to today's Lagos day, YYYY-MM-DD. */
function lagosDay(back: number): string {
  const [year, month, date] = lagosToday().split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date - back)).toISOString().slice(0, 10);
}

/** The database's answer as 0203's functions build it (jsonb: keys in its own order). */
function rawReport(extra: Record<string, unknown> = {}) {
  return {
    days: 7, from: lagosDay(9), to: lagosDay(3), report: 'operations', sections: [
      { key: 'waitingList', figures: [
        { key: 'checkedIn', kind: 'count', daily: [{ day: lagosDay(9), value: 7 }], current: 8, previous: 2 },
        { key: 'seen', kind: 'count', daily: [{ day: lagosDay(9), value: 3 }], current: 4, previous: 1,
          coverage: { previousTracked: 1, tracked: 7 } },
        { key: 'medianWaitMinutes', kind: 'median_minutes', daily: [{ day: lagosDay(9), value: 20, sampleSize: 2 }],
          current: 10, previous: 40, sampleSize: 3, previousSampleSize: 1, coverage: { tracked: 7, previousTracked: 1 } },
      ] },
      { key: 'pharmacy', figures: [
        { key: 'notCompleted', kind: 'count', daily: [{ day: lagosDay(9), value: 0 }], current: 3, previous: 1,
          byReason: [{ reason: 'out_of_stock', current: 2, previous: 1 }] },
      ] },
    ],
    timeZone: 'Africa/Lagos', facilityId, previousTo: lagosDay(10), definitions: { signedOff: false, version: 'rep1-draft-1' },
    generatedAt: '2026-12-01T08:00:00.000Z', previousFrom: lagosDay(16), includesToday: false, ...extra,
  };
}

function fakeDatabase(answer: unknown | Error) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const contexts: DataAccessContext[] = [];
  const options: unknown[] = [];
  const database = {
    withTransaction: jest.fn(async (given: DataAccessContext, operation: (client: unknown) => Promise<unknown>,
      givenOptions: unknown) => {
      contexts.push(given);
      options.push(givenOptions);
      return operation({
        query: async (sql: string, values: unknown[] = []) => {
          calls.push({ sql, values });
          if (sql.startsWith('set local')) return { rows: [] };
          if (answer instanceof Error) throw answer;
          return { rows: [{ report: answer }] };
        },
      });
    }),
  } as unknown as DatabaseService;
  return { database, calls, contexts, options };
}

function databaseError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function validate<T>(type: new () => T, value: unknown, kind: ArgumentMetadata['type'] = 'body'): Promise<T> {
  return createValidationPipe().transform(value, { type: kind, metatype: type }) as Promise<T>;
}

async function problemOf(attempt: Promise<unknown> | (() => unknown)): Promise<DomainProblem> {
  try {
    await (typeof attempt === 'function' ? attempt() : attempt);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainProblem);
    return error as DomainProblem;
  }
  throw new Error('expected a refusal');
}

function staffRequest(permissions: string[], purpose: string | undefined = 'healthcare-operations'): HidRequest {
  return {
    header: (name: string) => (name.toLowerCase() === 'x-purpose-of-use' ? purpose : undefined),
    correlationId: 'correlation-123456', facilityId, method: 'GET',
    actor: { kind: 'staff', id: accountId, subject: 'staff:test', accountId, permissions, roles: ['admin'],
      facilityIds: [facilityId], facilities: [], facility: { id: facilityId, membershipId } },
  } as unknown as HidRequest;
}

describe('REP-1 the facility\'s operations report (0203, 0204)', () => {
  const original = { ...process.env };
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost:5432/hid',
    CORS_ORIGINS: 'http://localhost:3000', STORAGE_MODE: 'disabled' };
  function settings(reports: boolean | undefined, exports: boolean | undefined): void {
    Object.assign(process.env, base);
    delete process.env.REPORTS_ENABLED;
    delete process.env.REPORTS_EXPORT_ENABLED;
    if (reports !== undefined) process.env.REPORTS_ENABLED = String(reports);
    if (exports !== undefined) process.env.REPORTS_EXPORT_ENABLED = String(exports);
    resetEnvironmentForTests();
  }
  beforeEach(() => settings(true, true));
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('both switches are off unless set to true (Q149 A)', () => {
    settings(undefined, undefined);
    expect([getEnvironment().REPORTS_ENABLED, getEnvironment().REPORTS_EXPORT_ENABLED]).toEqual([false, false]);
  });

  describe('routes', () => {
    it('serves the contract paths and methods, no-store, each with its request audit action', () => {
      expect(Reflect.getMetadata(PATH_METADATA, ReportsController)).toBe('ehr/reports');
      const prototype = ReportsController.prototype as unknown as Record<string, object>;
      const routes = (['read', 'export'] as const).map((name) => [name,
        Reflect.getMetadata(PATH_METADATA, prototype[name]!), Reflect.getMetadata(METHOD_METADATA, prototype[name]!),
        Reflect.getMetadata(HTTP_CODE_METADATA, prototype[name]!), Reflect.getMetadata(AUDIT_ACTION, prototype[name]!),
        Reflect.getMetadata(HEADERS_METADATA, prototype[name]!)]);
      expect(routes).toEqual([
        ['read', 'operations', RequestMethod.GET, undefined, 'ehr.reports.operations.request',
          [{ name: 'Cache-Control', value: 'no-store' }]],
        ['export', 'operations/exports', RequestMethod.POST, 200, 'ehr.reports.operations.export.request',
          [{ name: 'Cache-Control', value: 'no-store' }]],
      ]);
    });

    it('route 1 needs reports.read; route 2 also reports.export, in plain words', async () => {
      const { database } = fakeDatabase(rawReport());
      const controller = new ReportsController(new ReportsService(database));
      const query = { from: lagosDay(9), to: lagosDay(3) };
      const read = await problemOf(() => controller.read(staffRequest(['audit.read']), query));
      expect([read.getStatus(), read.code, read.message]).toEqual([403, 'REPORTS_NOT_ALLOWED', REPORT_MESSAGES.notAllowed]);
      const body = { ...query, format: 'csv' as const };
      const noRead = await problemOf(() => controller.export(staffRequest(['reports.export']), body));
      const noExport = await problemOf(() => controller.export(staffRequest(['reports.read']), body));
      expect([noRead.code, noExport.code, noExport.message]).toEqual(['REPORTS_EXPORT_NOT_ALLOWED',
        'REPORTS_EXPORT_NOT_ALLOWED', REPORT_MESSAGES.exportNotAllowed]);
      for (const problem of [read, noRead, noExport]) expect(problem.message).not.toMatch(/permission/i);
      expect((database.withTransaction as jest.Mock).mock.calls).toHaveLength(0);
    });

    it('the purpose is healthcare-operations only, as the audit trail', async () => {
      const { database } = fakeDatabase(rawReport());
      const controller = new ReportsController(new ReportsService(database));
      for (const purpose of ['direct-care', 'emergency', undefined]) {
        const problem = await problemOf(() => controller.read(staffRequest(ADMIN, purpose),
          { from: lagosDay(9), to: lagosDay(3) }));
        expect([problem.getStatus(), problem.code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
      }
      expect((database.withTransaction as jest.Mock).mock.calls).toHaveLength(0);
    });

    it('an administrator gets the report, read through the session\'s context', async () => {
      const { database, contexts } = fakeDatabase(rawReport());
      const controller = new ReportsController(new ReportsService(database));
      const answer = await controller.read(staffRequest(ADMIN), { from: lagosDay(9), to: lagosDay(3) });
      expect(answer.report).toBe('operations');
      expect([contexts[0]?.facilityId, contexts[0]?.membershipId, contexts[0]?.purposeOfUse])
        .toEqual([facilityId, membershipId, 'healthcare-operations']);
    });
  });

  describe('request validation', () => {
    it('takes exactly from and to, each a real calendar day', async () => {
      await expect(validate(ReportRangeQueryDto, { from: '2026-11-01', to: '2026-11-30' }, 'query')).resolves
        .toEqual({ from: '2026-11-01', to: '2026-11-30' });
      for (const query of [{ from: '2026-11-01' }, { from: '2026-02-30', to: '2026-03-01' },
        { from: '2026-11-1', to: '2026-11-30' }, { from: '2026-11-01T00:00:00Z', to: '2026-11-30' },
        { from: '2026-11-01', to: '2026-11-30', facilityId }]) {
        const problem = await problemOf(validate(ReportRangeQueryDto, query, 'query'));
        expect([problem.getStatus(), problem.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
    });

    it('a download takes the range and csv or pdf, nothing else', async () => {
      await expect(validate(ReportExportDto, { from: '2026-11-01', to: '2026-11-30', format: 'pdf' })).resolves
        .toEqual({ from: '2026-11-01', to: '2026-11-30', format: 'pdf' });
      for (const body of [{ from: '2026-11-01', to: '2026-11-30', format: 'xlsx' },
        { from: '2026-11-01', to: '2026-11-30' },
        { from: '2026-11-01', to: '2026-11-30', format: 'csv', patientId: facilityId }]) {
        const problem = await problemOf(validate(ReportExportDto, body));
        expect(problem.code).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('the range (Lagos days)', () => {
    it('today is the Lagos day, whatever the server\'s zone (23:30 UTC is the next Lagos day)', () => {
      expect(lagosToday(new Date('2026-11-30T23:30:00Z'))).toBe('2026-12-01');
      expect(lagosToday(new Date('2026-11-30T22:59:00Z'))).toBe('2026-11-30');
    });

    it('accepts 92 days ending today, and from exactly 2 years back', () => {
      expect(() => checkReportRange('2026-09-01', '2026-12-01', '2026-12-01')).not.toThrow();
      expect(() => checkReportRange('2024-12-01', '2024-12-07', '2026-12-01')).not.toThrow();
      expect(twoYearsBefore('2028-02-29')).toBe('2026-02-28');
    });

    it('refuses from after to, a future to, more than 2 years back and 93 days', async () => {
      const cases: [string, string, string][] = [['2026-11-10', '2026-11-09', 'REPORT_RANGE_INVALID'],
        ['2026-11-30', '2026-12-02', 'REPORT_RANGE_INVALID'], ['2024-11-30', '2024-12-01', 'REPORT_RANGE_INVALID'],
        ['2026-08-31', '2026-12-01', 'REPORT_RANGE_TOO_LONG']];
      for (const [from, to, code] of cases) {
        const problem = await problemOf(() => checkReportRange(from, to, '2026-12-01'));
        expect([problem.getStatus(), problem.code]).toEqual([400, code]);
      }
      const { database } = fakeDatabase(rawReport());
      const problem = await problemOf(new ReportsService(database).read(context, lagosDay(0), lagosDay(-1)));
      expect(problem.message).toBe(REPORT_MESSAGES.rangeInvalid);
      expect((database.withTransaction as jest.Mock).mock.calls).toHaveLength(0);
    });
  });

  describe('the database call', () => {
    it('route 1: one REPEATABLE READ transaction with a 15-second limit, passing REPORTS_ENABLED', async () => {
      settings(false, false);
      const { database, calls, options } = fakeDatabase(rawReport());
      await new ReportsService(database).read(context, lagosDay(9), lagosDay(3));
      expect(calls).toEqual([{ sql: "set local statement_timeout = '15s'", values: [] },
        { sql: READ_SQL, values: [lagosDay(9), lagosDay(3), false] }]);
      expect(options).toEqual([{ isolationLevel: 'REPEATABLE READ' }]);
    });

    it('route 2 passes on only when both switches are on', async () => {
      const seen: unknown[] = [];
      for (const [reports, exports] of [[true, true], [true, false], [false, true]] as const) {
        settings(reports, exports);
        const { database, calls } = fakeDatabase({ ...rawReport(), export: { format: 'csv', minimumCount: 5,
          suppressedValues: 3, recordedAt: '2026-12-01T08:00:00.000Z' } });
        await new ReportsService(database).export(context, lagosDay(9), lagosDay(3), 'csv');
        expect(calls[1]?.sql).toBe(EXPORT_SQL);
        seen.push(calls[1]?.values);
      }
      expect(seen).toEqual([[lagosDay(9), lagosDay(3), 'csv', true], [lagosDay(9), lagosDay(3), 'csv', false],
        [lagosDay(9), lagosDay(3), 'csv', false]]);
    });

    it('a timeout answers 503 REPORT_TOO_SLOW', async () => {
      const { database } = fakeDatabase(databaseError('57014', 'canceling statement due to statement timeout'));
      const problem = await problemOf(new ReportsService(database).read(context, lagosDay(9), lagosDay(3)));
      expect([problem.getStatus(), problem.code, problem.message]).toEqual([503, 'REPORT_TOO_SLOW', REPORT_MESSAGES.tooSlow]);
    });
  });

  describe('the database\'s refusals', () => {
    it('maps each to the contract\'s code', () => {
      const answer = (code: string, message: string, route: 'read' | 'export' = 'read') => {
        const problem = translateReportError(databaseError(code, message), route);
        return problem instanceof DomainProblem ? `${problem.getStatus()} ${problem.code}` : 'passed on';
      };
      expect([
        answer('42501', 'REPORTS_NOT_PERMITTED'), answer('42501', 'REPORTS_NOT_PERMITTED', 'export'),
        answer('42501', 'REPORTS_EXPORT_NOT_PERMITTED', 'export'),
        answer('42501', 'permission denied for function facility_report_operations'),
        answer('42883', 'function ehr.facility_report_operations(date, date, boolean) does not exist'),
        answer('22023', 'REPORTS_OPERATIONS_PURPOSE_ONLY'), answer('22023', 'REPORT_RANGE_INVALID'),
        answer('22023', 'REPORT_RANGE_TOO_LONG'), answer('22023', 'REPORT_FORMAT_INVALID', 'export'),
        answer('55000', 'REPORTS_SWITCHED_OFF'), answer('55000', 'REPORTS_EXPORT_SWITCHED_OFF', 'export'),
        answer('57014', 'canceling statement due to statement timeout'), answer('23505', 'duplicate key'),
      ]).toEqual([
        '403 REPORTS_NOT_ALLOWED', '403 REPORTS_EXPORT_NOT_ALLOWED', '403 REPORTS_EXPORT_NOT_ALLOWED',
        '503 REPORTS_NOT_AVAILABLE', '503 REPORTS_NOT_AVAILABLE',
        '400 PURPOSE_OF_USE_REQUIRED', '400 REPORT_RANGE_INVALID', '400 REPORT_RANGE_TOO_LONG', '400 VALIDATION_FAILED',
        '503 REPORTS_NOT_AVAILABLE', '503 REPORTS_EXPORT_NOT_AVAILABLE', '503 REPORT_TOO_SLOW', 'passed on',
      ]);
    });

    it('a download switched off answers REPORTS_NOT_AVAILABLE while the whole report is off', () => {
      settings(false, true);
      const problem = translateReportError(databaseError('55000', 'REPORTS_EXPORT_SWITCHED_OFF'), 'export');
      expect(problem instanceof DomainProblem ? problem.code : undefined).toBe('REPORTS_NOT_AVAILABLE');
    });

    it('no refusal says "permission"', () => {
      for (const message of Object.values(REPORT_MESSAGES)) expect(message).not.toMatch(/permission/i);
    });
  });

  describe('the answer', () => {
    it('is the report in the contract\'s field order, with nothing else the database might carry', () => {
      const report = toReport(rawReport({ internalCounter: 5 }));
      expect(Object.keys(report)).toEqual(['report', 'facilityId', 'from', 'to', 'days', 'previousFrom', 'previousTo',
        'includesToday', 'timeZone', 'generatedAt', 'definitions', 'sections']);
      expect(report.definitions).toEqual({ version: 'rep1-draft-1', signedOff: false });
      const median = report.sections[0]!.figures[2]!;
      expect(Object.keys(median)).toEqual(['key', 'kind', 'current', 'previous', 'sampleSize', 'previousSampleSize',
        'coverage', 'daily']);
      expect(median.coverage).toEqual({ tracked: 7, previousTracked: 1 });
      expect(Object.keys(report.sections[0]!.figures[0]!)).toEqual(['key', 'kind', 'current', 'previous', 'daily']);
      expect(report.sections[1]!.figures[0]!.byReason).toEqual([{ reason: 'out_of_stock', current: 2, previous: 1 }]);
    });

    it('a download keeps every hidden value null with its flag beside it, and the export record', () => {
      const raw = rawReport();
      raw.sections[0]!.figures[0] = { key: 'checkedIn', kind: 'count', current: 8, previous: null,
        previousSuppressed: true, daily: [{ day: lagosDay(9), value: null, suppressed: true }] } as never;
      raw.sections[0]!.figures[2] = { key: 'medianWaitMinutes', kind: 'median_minutes', current: null,
        currentSuppressed: true, sampleSize: null, sampleSizeSuppressed: true, previous: 40, previousSampleSize: 6,
        coverage: { tracked: 7, previousTracked: null, previousTrackedSuppressed: true },
        daily: [{ day: lagosDay(9), value: null, sampleSize: null, suppressed: true }] } as never;
      const download = toReportExport({ ...raw, export: { recordedAt: '2026-12-01T08:00:00.000Z', format: 'pdf',
        suppressedValues: 6, minimumCount: 5 } });
      expect(download.sections[0]!.figures[0]).toEqual({ key: 'checkedIn', kind: 'count', current: 8, previous: null,
        previousSuppressed: true, daily: [{ day: lagosDay(9), value: null, suppressed: true }] });
      expect(Object.keys(download.sections[0]!.figures[2]!)).toEqual(['key', 'kind', 'current', 'currentSuppressed',
        'previous', 'sampleSize', 'sampleSizeSuppressed', 'previousSampleSize', 'coverage', 'daily']);
      expect(download.sections[0]!.figures[2]!.coverage).toEqual({ tracked: 7, previousTracked: null,
        previousTrackedSuppressed: true });
      expect(download.export).toEqual({ format: 'pdf', minimumCount: 5, suppressedValues: 6,
        recordedAt: '2026-12-01T08:00:00.000Z' });
    });

    it('the access check is the session\'s codes only', () => {
      expect(() => requireReportAccess(staffRequest(ADMIN), 'export')).not.toThrow();
    });
  });
});
