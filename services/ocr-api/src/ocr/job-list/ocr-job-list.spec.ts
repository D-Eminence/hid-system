import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { PoolClient } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { AUDIT_ACTION, FACILITY_OPTIONAL, PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../../common/decorators';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import type { OcrJobStatus } from '../ocr.types';
import { OcrJobListController } from './ocr-job-list.controller';
import { OCR_JOB_STATUSES, OcrJobListQueryDto } from './ocr-job-list.dto';
import { decodeCursor, encodeCursor, OCR_JOB_LIST_SQL, OcrJobListService } from './ocr-job-list.service';

const FACILITY = '10000000-0000-4000-8000-000000000001';
const OTHER_FACILITY = '10000000-0000-4000-8000-000000000002';
const MEMBERSHIP = '40000000-0000-4000-8000-000000000001';
const COLLEAGUE = '40000000-0000-4000-8000-000000000002';

const context = {
  correlationId: 'ocr-job-list-correlation', facilityId: FACILITY, membershipId: MEMBERSHIP,
  purposeOfUse: 'healthcare-operations',
  actor: { id: 'actor', subject: 'staff:fictional-records', accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['nurse'], permissions: ['ocr.job.read'], facilityIds: [FACILITY], facilities: [],
    facility: { id: FACILITY, membershipId: MEMBERSHIP, organizationId: '30000000-0000-4000-8000-000000000001',
      name: 'Fictional Clinic', roles: ['nurse'], permissions: ['ocr.job.read'], isPrimary: true },
    authenticationMethod: 'local' },
} satisfies DataAccessContext;

function jobRow(index: number, extra: Record<string, unknown> = {}) {
  const second = String(59 - index).padStart(2, '0');
  return {
    id: `70000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`,
    document_id: `60000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`,
    status: 'awaiting_validation', created_at: new Date(`2026-11-18T10:00:${second}.123Z`),
    cursor_at: `2026-11-18T10:00:${second}.123456Z`, created_by_membership_id: index % 2 ? COLLEAGUE : MEMBERSHIP,
    attempt_count: 1, max_attempts: 3, completed_at: null, failed_at: null, last_error_code: null, ...extra,
  };
}

function setup(rows: Record<string, unknown>[]) {
  const queries: { text: string; values: unknown[] }[] = [];
  const client = { query: jest.fn(async (text: string, values: unknown[] = []) => {
    queries.push({ text, values });
    return { rows, rowCount: rows.length };
  }) } as unknown as PoolClient;
  const transactions: { context: DataAccessContext; options: unknown }[] = [];
  const database = { withTransaction: jest.fn(async (call: DataAccessContext,
    operation: (client: PoolClient) => Promise<unknown>, options: unknown) => {
    transactions.push({ context: call, options });
    return operation(client);
  }) } as unknown as DatabaseService;
  const recordWithClient = jest.fn().mockResolvedValue(undefined);
  const audit = { recordWithClient } as unknown as AuditService;
  return { service: new OcrJobListService(database, audit), queries, transactions, recordWithClient, client };
}

function validate(query: Record<string, unknown>) {
  return validateSync(plainToInstance(OcrJobListQueryDto, query), { whitelist: true, forbidNonWhitelisted: true,
    forbidUnknownValues: true });
}

describe('GET ocr/job-list (SX-9)', () => {
  it('is its own path under ocr, needs ocr.job.read and a facility, and is audited as a request', () => {
    const handler = OcrJobListController.prototype.list;
    expect(Reflect.getMetadata(PATH_METADATA, OcrJobListController)).toBe('ocr');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('job-list');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['ocr.job.read']);
    expect(Reflect.getMetadata(AUDIT_ACTION, handler)).toBe('ocr.job.list.request');
    expect(Reflect.getMetadata(FACILITY_OPTIONAL, handler)).toBeUndefined();
    expect(Reflect.getMetadata(PUBLIC_ROUTE, handler)).toBeUndefined();
  });

  it('reads under healthcare-operations whatever purpose header the browser sends', async () => {
    const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null });
    const controller = new OcrJobListController({ list } as unknown as OcrJobListService);
    const request = { actor: context.actor, facilityId: FACILITY, correlationId: 'c-1',
      header: (name: string) => (name === 'x-purpose-of-use' ? 'emergency' : undefined) } as unknown as HidRequest;
    await controller.list({}, request);
    expect(list).toHaveBeenCalledWith({}, expect.objectContaining({ facilityId: FACILITY, membershipId: MEMBERSHIP,
      purposeOfUse: 'healthcare-operations' }));
  });

  it('accepts only its own keys: no Health ID, patient or facility in the URL', () => {
    expect(validate({})).toEqual([]);
    expect(validate({ status: 'failed', mine: 'true', limit: '50', cursor: encodeCursor({ at: '2026-11-18T10:00:00.000001Z',
      id: '70000000-0000-4000-8000-000000000001' }) })).toEqual([]);
    for (const query of [{ healthId: 'HID-ABC123' }, { patientId: '50000000-0000-4000-8000-000000000001' },
      { facilityId: OTHER_FACILITY }, { status: 'deleted' }, { status: 'Rejected' }, { mine: 'false' }, { limit: '0' }, { limit: '51' },
      { limit: '10.5' }, { cursor: 'short' }, { cursor: 'has spaces in it and more' }]) {
      expect(validate(query)).not.toEqual([]);
    }
  });

  it('lists this facility only, newest first, with no patient field, and audits the job ids shown', async () => {
    const rows = [jobRow(1), jobRow(2, { status: 'failed', failed_at: new Date('2026-11-18T10:01:00Z'),
      last_error_code: 'PROVIDER_TIMEOUT' })];
    const s = setup(rows);
    const answer = await s.service.list({}, context);
    // Not read-only: the audit row is inserted in this same transaction.
    expect(s.transactions).toEqual([{ context, options: undefined }]);
    expect(s.recordWithClient.mock.calls[0]![0]).toBe(s.client);
    expect(s.queries[0]).toEqual({ text: OCR_JOB_LIST_SQL, values: [FACILITY, null, null, null, null, 26] });
    expect(OCR_JOB_LIST_SQL).toMatch(/where facility_id = \$1::uuid/);
    expect(OCR_JOB_LIST_SQL).toMatch(/order by created_at desc, id desc/);
    expect(OCR_JOB_LIST_SQL).not.toMatch(/patient|identity\.|ehr\./);
    expect(answer.nextCursor).toBeNull();
    expect(answer.items).toEqual([
      { id: rows[0]!.id, documentId: rows[0]!.document_id, status: 'awaiting_validation', createdAt: rows[0]!.created_at,
        createdByMembershipId: COLLEAGUE, createdByMe: false, attemptCount: 1, maxAttempts: 3, completedAt: null,
        failedAt: null, failureCode: null },
      expect.objectContaining({ id: rows[1]!.id, status: 'failed', createdByMe: true, failureCode: 'PROVIDER_TIMEOUT' }),
    ]);
    for (const item of answer.items) expect(Object.keys(item).join(' ')).not.toMatch(/patient|healthId/i);
    expect(s.recordWithClient).toHaveBeenCalledTimes(1);
    const event = s.recordWithClient.mock.calls[0]![1];
    expect(event).toMatchObject({ action: 'ocr.job.list', resourceType: 'ocr-job-list', outcome: 'success',
      facilityId: FACILITY, actorMembershipId: MEMBERSHIP, purposeOfUse: 'healthcare-operations',
      details: { count: 2, jobIds: [rows[0]!.id, rows[1]!.id], status: null, mine: false, page: 'first' } });
    expect(event.patientId).toBeUndefined();
  });

  it('never reads another facility: the facility bound is the request\'s, not anything the caller names', async () => {
    const s = setup([]);
    await s.service.list({ status: 'queued' } as OcrJobListQueryDto, { ...context, facilityId: OTHER_FACILITY });
    expect(s.queries[0]!.values[0]).toBe(OTHER_FACILITY);
    expect(s.transactions[0]!.context.facilityId).toBe(OTHER_FACILITY);
  });

  it('filters by status and by the member\'s own jobs', async () => {
    const s = setup([]);
    await s.service.list({ status: 'failed', mine: 'true', limit: '5' }, context);
    expect(s.queries[0]!.values).toEqual([FACILITY, 'failed', MEMBERSHIP, null, null, 6]);
    expect(s.recordWithClient.mock.calls[0]![1].details).toMatchObject({ count: 0, status: 'failed', mine: true });
  });

  it('pages by a cursor kept to the microsecond, and the next page starts after the last row', async () => {
    const rows = [jobRow(1), jobRow(2), jobRow(3)];
    const s = setup(rows);
    const first = await s.service.list({ limit: '2' }, context);
    expect(first.items.map((item) => item.id)).toEqual([rows[0]!.id, rows[1]!.id]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(decodeCursor(first.nextCursor!)).toEqual({ at: rows[1]!.cursor_at, id: rows[1]!.id });
    const next = setup([rows[2]!]);
    const second = await next.service.list({ limit: '2', cursor: first.nextCursor! }, context);
    expect(next.queries[0]!.values).toEqual([FACILITY, null, null, rows[1]!.cursor_at, rows[1]!.id, 3]);
    expect(second.nextCursor).toBeNull();
    expect(next.recordWithClient.mock.calls[0]![1].details).toMatchObject({ page: 'next' });
  });

  it('refuses a cursor it did not make, in plain words, before any read', async () => {
    const s = setup([]);
    for (const cursor of [Buffer.from('2026-11-18|not-a-uuid').toString('base64url'),
      Buffer.from("2026-11-18T10:00:00.000001Z|70000000-0000-4000-8000-000000000001|x").toString('base64url'),
      Buffer.from("x' or 1=1 --|70000000-0000-4000-8000-000000000001").toString('base64url')]) {
      const failure = await s.service.list({ cursor }, context).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DomainProblem);
      expect((failure as DomainProblem).getStatus()).toBe(400);
      expect((failure as DomainProblem).code).toBe('OCR_JOB_LIST_CURSOR_INVALID');
      expect(JSON.stringify((failure as DomainProblem).getResponse())).not.toMatch(/unverified/i);
    }
    expect(s.queries).toEqual([]);
    expect(s.recordWithClient).not.toHaveBeenCalled();
  });

  it('answers nothing when the audit row cannot be written', async () => {
    const s = setup([jobRow(1)]);
    s.recordWithClient.mockRejectedValueOnce(new Error('audit down'));
    await expect(s.service.list({}, context)).rejects.toThrow('audit down');
  });

  it('filters by every status a job can have, rejected included', () => {
    for (const status of OCR_JOB_STATUSES) expect(validate({ status })).toEqual([]);
    expect(validate({ status: 'rejected' })).toEqual([]);
  });

  it('keeps its status list the same as OcrJobStatus and the database\'s jobs_status_check', () => {
    const every: Record<OcrJobStatus, true> = { queued: true, processing: true, extracted: true,
      awaiting_validation: true, validated: true, rejected: true, failed: true, cancelled: true };
    expect([...OCR_JOB_STATUSES].sort()).toEqual(Object.keys(every).sort());
    // The latest definition of ocr.jobs jobs_status_check among the migrations (0016 today).
    const directory = join(__dirname, '../../../../ehr-api/database/migrations');
    const definitions = readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()
      .flatMap((name) => [...readFileSync(join(directory, name), 'utf8')
        .matchAll(/add constraint jobs_status_check check \(status in \(([^)]*)\)\)/g)]
        .map((match) => ({ name, statuses: [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((value) => value[1]!) })));
    expect(definitions.length).toBeGreaterThan(0);
    const latest = definitions.at(-1)!;
    expect(latest.name).toMatch(/^0016_/);
    expect([...OCR_JOB_STATUSES].sort()).toEqual([...latest.statuses].sort());
  });
});

/**
 * The list through the real DatabaseService transaction and the real
 * AuditService, over a client that keeps PostgreSQL's rule for READ ONLY
 * transactions: any INSERT is refused with SQLSTATE 25006 ("cannot execute
 * INSERT in a read-only transaction") and the transaction rolls back.
 */
describe('GET ocr/job-list (SX-9) through the transaction and the audit insert', () => {
  function readOnlyEnforcingDatabase(rows: Record<string, unknown>[]) {
    const statements: string[] = [];
    const clients = new Set<object>();
    let readOnly = false;
    const client = {
      query: async (text: string) => {
        const sql = text.trim().replace(/\s+/g, ' ');
        statements.push(sql);
        if (sql === 'BEGIN') readOnly = false;
        if (sql === 'SET TRANSACTION READ ONLY') readOnly = true;
        if (/^insert /i.test(sql) && readOnly) {
          throw Object.assign(new Error('cannot execute INSERT in a read-only transaction'), { code: '25006' });
        }
        if (sql.startsWith('select id::text, document_id::text')) return { rows, rowCount: rows.length };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => { clients.add(client); return client; } };
    const database = Object.create(DatabaseService.prototype) as DatabaseService;
    Object.assign(database, { pool });
    return { database, statements, clients };
  }

  it('commits the read and its audit row in one writable transaction', async () => {
    const rows = [jobRow(1), jobRow(2, { status: 'rejected', completed_at: new Date('2026-11-18T10:02:00Z') })];
    const db = readOnlyEnforcingDatabase(rows);
    const service = new OcrJobListService(db.database, new AuditService(db.database));
    const answer = await service.list({}, context);
    expect(answer.items.map((item) => item.status)).toEqual(['awaiting_validation', 'rejected']);
    expect(db.clients.size).toBe(1);
    expect(db.statements).not.toContain('SET TRANSACTION READ ONLY');
    const kinds = db.statements.map((sql) => sql.split(' ')[0]!.toLowerCase());
    expect(kinds[0]).toBe('begin');
    expect(kinds.at(-1)).toBe('commit');
    expect(kinds).not.toContain('rollback');
    const read = db.statements.findIndex((sql) => sql.startsWith('select id::text, document_id::text'));
    const insert = db.statements.findIndex((sql) => sql.startsWith('insert into audit.events'));
    expect(read).toBeGreaterThan(0);
    expect(insert).toBeGreaterThan(read);
  });

  it('would fail on every call in a read-only transaction (the model refuses the audit insert as PostgreSQL does)', async () => {
    const db = readOnlyEnforcingDatabase([jobRow(1)]);
    const audit = new AuditService(db.database);
    const failure = await db.database.withTransaction(context, async (client) => {
      await audit.recordWithClient(client, { correlationId: 'c', actorSubject: 's', facilityId: FACILITY,
        action: 'ocr.job.list', outcome: 'success' });
    }, { readOnly: true }).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe('25006');
    expect(db.statements.at(-1)).toBe('ROLLBACK');
  });
});
