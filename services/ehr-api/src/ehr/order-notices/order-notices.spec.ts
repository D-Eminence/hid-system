import { HttpStatus, Logger, RequestMethod, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import type { PoolClient } from 'pg';
import { lastValueFrom, of, throwError } from 'rxjs';
import { AuditInterceptor } from '../../audit/audit.interceptor';
import type { AuditService } from '../../audit/audit.service';
import {
  ANY_PERMISSIONS, AUDIT_ACTION, AUDIT_FAILURES_ONLY, FACILITY_OPTIONAL, NO_AUDIT, PATIENT_ALLOWED, REQUIRED_PERMISSIONS,
} from '../../common/decorators';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { createValidationPipe } from '../../common/validation-pipe';
import { getEnvironment, resetEnvironmentForTests } from '../../config/environment';
import type { DatabaseService } from '../../database/database.service';
import { EhrModule } from '../ehr.module';
import { OrderNoticesController } from './order-notices.controller';
import { ListOrderNoticesQueryDto, MarkOrderNoticesReadDto } from './order-notices.dto';
import { OrderNoticesModule } from './order-notices.module';
import {
  ORDER_NOTICE_SEEN_SQL, ORDER_NOTICE_SUMMARY_SQL, ORDER_NOTICE_SWEEP_SQL, ORDER_NOTICES_LIST_SQL, ORDER_NOTICES_READ_SQL,
  OrderNoticeSweeper, OrderNoticesService, OrderNoticesSwitch, noticeMessage, translate,
} from './order-notices.service';

// ORD-11 (0159): the ordering doctor's notices. Who sees what, the order
// reads and the definers' audit rows are the database's
// (services/ehr-api/database/tests/order-notices.integration.sql); this is
// the route around them. Fictional identifiers and names only.
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const patientId = '123e4567-e89b-42d3-a456-426614174011';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const noticeA = '123e4567-e89b-42d3-a456-426614174101';
const noticeB = '123e4567-e89b-42d3-a456-426614174102';
const orderId = '123e4567-e89b-42d3-a456-426614174201';
const routeId = '123e4567-e89b-42d3-a456-426614174301';
const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  actor: { accountId: membershipId, subject: 'staff:test', permissions: ['ehr.lab-request.read'] } } as unknown as DataAccessContext;

const row = (overrides: Record<string, unknown> = {}) => ({ notice_id: noticeA, kind: 'lab_result_ready',
  order_kind: 'lab_request', order_id: orderId, order_route_id: null, encounter_id: encounterId,
  display: 'Synthetic blood count', event_count: 1, first_event_at: new Date('2026-11-26T09:00:00.123Z'),
  last_event_at: new Date('2026-11-26T09:30:00.456Z'), read_at: null, needs_seen: false, seen_at: null, version: '1',
  access_ended: false, patient_id: patientId, full_name: 'Ada Notice', sex: 'female', date_of_birth: '1984-04-04',
  health_id_last4: 'A2B3', has_more: false, ...overrides });

function databaseError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** A database whose one transaction answers `answer` (rows, or an error to throw). */
function harness(answer: Record<string, unknown>[] | Error = [row()], enabled = true) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (answer instanceof Error) throw answer;
    return { rows: answer };
  }) };
  const options: unknown[] = [];
  const database = {
    withTransaction: jest.fn(async (_context: unknown, operation: (client: PoolClient) => Promise<unknown>,
      transactionOptions: unknown = {}) => {
      options.push(transactionOptions);
      return operation(client as unknown as PoolClient);
    }),
    withSystemTransaction: jest.fn(async (_correlation: string, operation: (client: PoolClient) => Promise<unknown>) =>
      operation(client as unknown as PoolClient)),
  };
  const service = new OrderNoticesService(database as unknown as DatabaseService, new OrderNoticesSwitch(enabled));
  return { service, calls, database, options };
}

async function refusal(promise: Promise<unknown>): Promise<DomainProblem> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainProblem) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

/** The app's own validation pipe, as main.ts installs it. */
async function validate<T>(type: new () => T, value: unknown, kind: 'query' | 'body'): Promise<T> {
  return createValidationPipe().transform(value, { type: kind, metatype: type }) as Promise<T>;
}

async function validationErrors<T>(type: new () => T, value: unknown, kind: 'query' | 'body') {
  const problem = await refusal(validate(type, value, kind));
  expect([problem.getStatus(), problem.code]).toEqual([400, 'VALIDATION_FAILED']);
  return problem.errors?.map((error) => error.field);
}

const listQuery = (values: Record<string, unknown>) => plainToInstance(ListOrderNoticesQueryDto, values);
const readBody = (notices: unknown[]) => plainToInstance(MarkOrderNoticesReadDto, { notices });

describe('ORD-11 routes (ehr/me/order-notices)', () => {
  const handlers = OrderNoticesController.prototype as unknown as Record<string, object>;

  it('is registered in the EHR module, for staff at a facility, with either read permission', () => {
    expect(Reflect.getMetadata('imports', EhrModule)).toContain(OrderNoticesModule);
    expect(Reflect.getMetadata('controllers', OrderNoticesModule)).toEqual([OrderNoticesController]);
    expect(Reflect.getMetadata(PATH_METADATA, OrderNoticesController)).toBe('ehr/me/order-notices');
    expect(Reflect.getMetadata(ANY_PERMISSIONS, OrderNoticesController)).toEqual(['ehr.lab-request.read',
      'ehr.prescription.read']);
    for (const target of [OrderNoticesController, ...Object.values(handlers)]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, target)).toBeUndefined();
      expect(Reflect.getMetadata(PATIENT_ALLOWED, target)).toBeUndefined();
      expect(Reflect.getMetadata(FACILITY_OPTIONAL, target)).toBeUndefined();
    }
  });

  it.each([
    ['summary', 'summary', RequestMethod.GET, undefined],
    ['list', '/', RequestMethod.GET, undefined],
    ['markRead', 'read', RequestMethod.POST, HttpStatus.OK],
    ['seen', ':noticeId/seen', RequestMethod.POST, HttpStatus.OK],
  ])('%s: its path and method, answered 200 and never cached', (name, path, method, code) => {
    const handler = handlers[name]!;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(code);
    expect(Reflect.getMetadata('__headers__', handler)).toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
  });

  it('the audit decorators: summary records failures only; list, mark read and Seen keep the interceptor row', () => {
    expect(Reflect.getMetadata(AUDIT_FAILURES_ONLY, handlers.summary!)).toBe(true);
    expect(Reflect.getMetadata(AUDIT_FAILURES_ONLY, OrderNoticesController)).toBeUndefined();
    for (const name of ['list', 'markRead', 'seen']) {
      expect(Reflect.getMetadata(AUDIT_FAILURES_ONLY, handlers[name]!)).toBeUndefined();
    }
    for (const target of [OrderNoticesController, ...Object.values(handlers)]) {
      expect(Reflect.getMetadata(NO_AUDIT, target)).toBeUndefined();
      expect(Reflect.getMetadata(AUDIT_ACTION, target)).toBeUndefined();
    }
  });

  describe('the audit interceptor on these routes', () => {
    const record = jest.fn(async () => undefined);
    const interceptor = new AuditInterceptor(new Reflector(), { record } as unknown as AuditService);
    const request = { method: 'GET', correlationId: 'correlation-123456', facilityId, params: {}, query: {}, ip: '127.0.0.1',
      route: { path: '/api/v1/ehr/me/order-notices' }, header: () => 'direct-care',
      actor: { kind: 'staff', subject: 'staff:test', accountId: membershipId, facility: { membershipId,
        organizationId: facilityId } } } as unknown as HidRequest;
    const call = (name: string): ExecutionContext => ({
      getHandler: () => handlers[name], getClass: () => OrderNoticesController,
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
    }) as unknown as ExecutionContext;
    beforeEach(() => record.mockClear());

    it('a summary that answers writes no row; one that fails writes one failure row', async () => {
      await expect(lastValueFrom(interceptor.intercept(call('summary'), { handle: () => of({ unread: 1 }) } as CallHandler)))
        .resolves.toEqual({ unread: 1 });
      expect(record).not.toHaveBeenCalled();
      await expect(lastValueFrom(interceptor.intercept(call('summary'),
        { handle: () => throwError(() => new DomainProblem(503, 'ORDER_NOTICES_UNAVAILABLE', 'x')) } as CallHandler)))
        .rejects.toMatchObject({ code: 'ORDER_NOTICES_UNAVAILABLE' });
      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure',
        action: 'api.get./api/v1/ehr/me/order-notices' }));
    });

    it.each(['list', 'markRead', 'seen'])('%s writes one success row', async (name) => {
      await lastValueFrom(interceptor.intercept(call(name), { handle: () => of({}) } as CallHandler));
      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', resourceType: 'http-request',
        actorMembershipId: membershipId, facilityId }));
    });
  });
});

describe('ORD-11 ORDER_NOTICES_ENABLED', () => {
  const original = { ...process.env };
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost:5432/hid',
    CORS_ORIGINS: 'http://localhost:3000', STORAGE_MODE: 'disabled' };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });
  const provider = () => (Reflect.getMetadata('providers', OrderNoticesModule) as unknown[]).find((entry) =>
    typeof entry === 'object' && entry !== null && (entry as { provide?: unknown }).provide === OrderNoticesSwitch) as
    { useFactory: () => OrderNoticesSwitch };

  it('is off unless set to true, and the module follows it; any other value is refused', () => {
    Object.assign(process.env, base);
    delete process.env.ORDER_NOTICES_ENABLED;
    resetEnvironmentForTests();
    expect(getEnvironment().ORDER_NOTICES_ENABLED).toBe(false);
    expect(provider().useFactory().enabled).toBe(false);
    process.env.ORDER_NOTICES_ENABLED = 'true';
    resetEnvironmentForTests();
    expect(provider().useFactory().enabled).toBe(true);
    process.env.ORDER_NOTICES_ENABLED = 'yes';
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/ORDER_NOTICES_ENABLED/);
  });

  it('off: every route is 503 ORDER_NOTICES_UNAVAILABLE and no transaction is opened', async () => {
    const { service, database } = harness([row()], false);
    const answers = await Promise.all([
      refusal(service.summary(context)),
      refusal(service.list(context, listQuery({ state: 'unread' }))),
      refusal(service.markRead(context, readBody([{ noticeId: noticeA, version: 1 }]))),
      refusal(service.seen(context, noticeA)),
    ]);
    for (const problem of answers) {
      expect([problem.getStatus(), problem.code, problem.message]).toEqual([503, 'ORDER_NOTICES_UNAVAILABLE',
        'Notices about your orders are not available yet.']);
    }
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it('off: the sweep timer never starts and a sweep reads nothing', async () => {
    const { database } = harness([{ swept: 3 }]);
    const sweeper = new OrderNoticeSweeper(database as unknown as DatabaseService, new OrderNoticesSwitch(false));
    const interval = jest.spyOn(global, 'setInterval');
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      sweeper.onModuleInit();
    } finally {
      process.env.NODE_ENV = nodeEnv;
    }
    expect(interval).not.toHaveBeenCalled();
    interval.mockRestore();
    await expect(sweeper.sweep()).resolves.toBe(0);
    expect(database.withSystemTransaction).not.toHaveBeenCalled();
  });
});

describe('ORD-11 GET summary', () => {
  it('counts per kind and in all, every kind present, in a read-only transaction', async () => {
    const { service, calls, options } = harness([
      { kind: 'lab_result_critical', unread_count: 1, critical_not_seen_count: 2 },
      { kind: 'lab_result_ready', unread_count: 3, critical_not_seen_count: 0 },
    ]);
    await expect(service.summary(context)).resolves.toEqual({ unread: 4, criticalNotSeen: 2, byKind: {
      lab_result_critical: { unread: 1, criticalNotSeen: 2 }, lab_result_corrected: { unread: 0, criticalNotSeen: 0 },
      lab_result_ready: { unread: 3, criticalNotSeen: 0 }, lab_result_withdrawn: { unread: 0, criticalNotSeen: 0 },
      prescription_dispensed: { unread: 0, criticalNotSeen: 0 }, dispensing_reversed: { unread: 0, criticalNotSeen: 0 } } });
    expect(calls).toEqual([{ sql: ORDER_NOTICE_SUMMARY_SQL, values: [] }]);
    expect(options).toEqual([{ readOnly: true }]);
  });

  it('no notices: all zero', async () => {
    const answer = await harness([]).service.summary(context);
    expect([answer.unread, answer.criticalNotSeen, Object.keys(answer.byKind).length]).toEqual([0, 0, 6]);
  });
});

describe('ORD-11 GET list', () => {
  it('passes the state, cursor and limit to the definer (20 by default) and answers the contract\'s shape', async () => {
    const { service, calls, options } = harness([row({ event_count: 3, version: '4' })]);
    const page = await service.list(context, await validate(ListOrderNoticesQueryDto, { state: 'unread' }, 'query'));
    expect(calls).toEqual([{ sql: ORDER_NOTICES_LIST_SQL, values: ['unread', null, 20] }]);
    expect(options).toEqual([{}]);
    expect(page).toEqual({ nextCursor: null, items: [{ noticeId: noticeA, kind: 'lab_result_ready', version: 4,
      createdAt: '2026-11-26T09:00:00.123Z', lastEventAt: '2026-11-26T09:30:00.456Z', count: 3, readAt: null,
      needsSeen: false, seenAt: null,
      order: { type: 'lab_request', id: orderId, routeId: null, encounterId, display: 'Synthetic blood count' },
      patient: { patientId, fullName: 'Ada Notice', sex: 'female', dateOfBirth: '1984-04-04', healthIdLast4: 'A2B3' },
      accessEnded: false, message: '3 results ready: Synthetic blood count.' }] });
    await service.list(context, await validate(ListOrderNoticesQueryDto, { state: 'all', cursor: noticeB, limit: '50' },
      'query'));
    expect(calls[1]!.values).toEqual(['all', noticeB, 50]);
  });

  it('keeps the database\'s order (critical not Seen first) and pages by the last notice id', async () => {
    const { service } = harness([
      row({ notice_id: noticeB, kind: 'lab_result_critical', needs_seen: true, order_route_id: routeId, has_more: true }),
      row({ has_more: true }),
    ]);
    const page = await service.list(context, listQuery({ state: 'unread', limit: 2 }));
    expect(page.items.map((item) => [item.noticeId, item.kind, item.order.routeId])).toEqual([
      [noticeB, 'lab_result_critical', routeId], [noticeA, 'lab_result_ready', null]]);
    expect(page.items[0]!.message).toBe('Critical result: Synthetic blood count. Open it and mark it Seen.');
    expect(page.nextCursor).toBe(noticeA);
  });

  it('accessEnded: no patient, visit or display, whatever the row holds, and the ended words', async () => {
    const { service } = harness([
      row({ kind: 'lab_result_critical', needs_seen: true, access_ended: true }),
      row({ notice_id: noticeB, kind: 'prescription_dispensed', order_kind: 'prescription', access_ended: true,
        patient_id: null, full_name: null, sex: null, date_of_birth: null, health_id_last4: null, encounter_id: null,
        display: null }),
    ]);
    const [critical, dispensed] = (await service.list(context, listQuery({ state: 'all' }))).items;
    expect(critical).toMatchObject({ accessEnded: true, patient: null, needsSeen: true,
      order: { type: 'lab_request', id: orderId, routeId: null, encounterId: null, display: null },
      message: 'A result is ready for a patient whose access has ended. Ask the patient for access to see it, '
        + 'or call the laboratory.' });
    expect(dispensed).toMatchObject({ accessEnded: true, patient: null, order: { display: null, encounterId: null },
      message: 'A prescription was dispensed for a patient whose access has ended. Ask the patient for access to see it.' });
    expect(JSON.stringify([critical, dispensed])).not.toMatch(/Ada Notice|Synthetic blood count|A2B3/);
  });

  it('a page with nothing: no items, no cursor', async () => {
    await expect(harness([]).service.list(context, listQuery({ state: 'unread' }))).resolves.toEqual({ items: [],
      nextCursor: null });
  });

  it.each([
    ['no state', {}, ['state']], ['another state', { state: 'read' }, ['state']],
    ['limit 0', { state: 'all', limit: '0' }, ['limit']], ['limit 51', { state: 'all', limit: '51' }, ['limit']],
    ['a limit that is not a whole number', { state: 'all', limit: '2.5' }, ['limit']],
    ['a cursor that is not a UUID', { state: 'all', cursor: 'abc' }, ['cursor']],
    ['an unknown parameter', { state: 'all', kind: 'lab' }, ['kind']],
  ])('the query refuses %s (400 VALIDATION_FAILED, naming it)', async (_label, values, fields) => {
    expect(await validationErrors(ListOrderNoticesQueryDto, values, 'query')).toEqual(fields);
  });
});

describe('ORD-11 POST read', () => {
  it('sends the ids and versions in order and answers how many changed', async () => {
    const { service, calls } = harness([{ updated: 2 }]);
    const body = await validate(MarkOrderNoticesReadDto, { notices: [{ noticeId: noticeA, version: 3 },
      { noticeId: noticeB, version: 1 }] }, 'body');
    await expect(service.markRead(context, body)).resolves.toEqual({ updated: 2 });
    expect(calls).toEqual([{ sql: ORDER_NOTICES_READ_SQL, values: [[noticeA, noticeB], [3, 1]] }]);
  });

  it('a stale version (the notice changed since it was shown): updated 0, and no error', async () => {
    const { service } = harness([{ updated: 0 }]);
    await expect(service.markRead(context, readBody([{ noticeId: noticeA, version: 1 }]))).resolves.toEqual({ updated: 0 });
  });

  it('a notice whose access has ended is marked read like any other: no access is asked', async () => {
    // The database reads no order for mark read; the route asks nothing more than the pairs.
    const { service, calls } = harness([{ updated: 1 }]);
    await expect(service.markRead(context, readBody([{ noticeId: noticeB, version: 2 }]))).resolves.toEqual({ updated: 1 });
    expect(calls).toHaveLength(1);
  });

  it('accepts 1 and 100 pairs', async () => {
    const pairs = (count: number) => Array.from({ length: count }, (_unused, index) => ({
      noticeId: `123e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}`, version: index + 1 }));
    await expect(validate(MarkOrderNoticesReadDto, { notices: pairs(1) }, 'body')).resolves.toBeDefined();
    await expect(validate(MarkOrderNoticesReadDto, { notices: pairs(100) }, 'body')).resolves.toBeDefined();
    expect(await validationErrors(MarkOrderNoticesReadDto, { notices: pairs(101) }, 'body')).toEqual(['notices']);
  });

  it.each([
    ['no pairs', { notices: [] }], ['no notices', {}], ['notices null', { notices: null }],
    ['the old form, ids only', { noticeIds: [noticeA] }],
    ['a bare id', { notices: [noticeA] }],
    ['a pair without its version', { notices: [{ noticeId: noticeA }] }],
    ['version 0', { notices: [{ noticeId: noticeA, version: 0 }] }],
    ['a version sent as text', { notices: [{ noticeId: noticeA, version: '3' }] }],
    ['a version that is not whole', { notices: [{ noticeId: noticeA, version: 1.5 }] }],
    ['a notice id that is not a UUID', { notices: [{ noticeId: 'abc', version: 1 }] }],
    ['an unknown field in a pair', { notices: [{ noticeId: noticeA, version: 1, readAt: 'now' }] }],
    ['an unknown field beside the pairs', { notices: [{ noticeId: noticeA, version: 1 }], all: true }],
    ['the same notice twice', { notices: [{ noticeId: noticeA, version: 1 }, { noticeId: noticeA.toUpperCase(), version: 2 }] }],
  ])('the body refuses %s (400 VALIDATION_FAILED)', async (_label, value) => {
    expect((await validationErrors(MarkOrderNoticesReadDto, value, 'body'))?.length).toBeGreaterThan(0);
  });
});

describe('ORD-11 POST :noticeId/seen', () => {
  it('answers the notice with seenAt set', async () => {
    const { service, calls } = harness([row({ kind: 'lab_result_critical', needs_seen: true, read_at: new Date('2026-11-26T10:00:00Z'),
      seen_at: new Date('2026-11-26T10:00:00Z'), version: '3' })]);
    const answer = await service.seen(context, noticeA);
    expect(calls).toEqual([{ sql: ORDER_NOTICE_SEEN_SQL, values: [noticeA] }]);
    expect(answer).toMatchObject({ noticeId: noticeA, version: 3, needsSeen: true, seenAt: '2026-11-26T10:00:00.000Z',
      readAt: '2026-11-26T10:00:00.000Z', accessEnded: false, patient: { patientId },
      message: 'Critical result: Synthetic blood count. Marked Seen.' });
  });

  it.each([
    ['access ended (403 CONSENT_REQUIRED)', databaseError('42501', 'ORDER_NOTICE_CONSENT_REQUIRED'), 403, 'CONSENT_REQUIRED',
      'Ask the patient for access to see this result first.'],
    ['someone else\'s notice, or none (404 ORDER_NOTICE_NOT_FOUND)', databaseError('P0002', 'ORDER_NOTICE_NOT_FOUND'), 404,
      'ORDER_NOTICE_NOT_FOUND', 'This notice is not available.'],
  ])('refused: %s', async (_label, error, status, code, message) => {
    const problem = await refusal(harness(error).service.seen(context, noticeA));
    expect([problem.getStatus(), problem.code, problem.message]).toEqual([status, code, message]);
  });

  it('a definer that answers no row is a fault: 503, and the transaction is not kept', async () => {
    const problem = await refusal(harness([]).service.seen(context, noticeA));
    expect([problem.getStatus(), problem.code]).toEqual([503, 'ORDER_NOTICES_UNAVAILABLE']);
  });
});

describe('ORD-11 the definers\' refusals', () => {
  it.each([
    ['42501', 'ORDER_NOTICES_NOT_PERMITTED', 403, 'PERMISSION_DENIED'],
    ['22023', 'ORDER_NOTICES_DIRECT_CARE_ONLY', 400, 'PURPOSE_OF_USE_REQUIRED'],
    ['22023', 'ORDER_NOTICES_CURSOR_INVALID', 400, 'INVALID_CURSOR'],
    ['22023', 'ORDER_NOTICES_LIST_INVALID', 400, 'VALIDATION_FAILED'],
    ['22023', 'ORDER_NOTICES_READ_INVALID', 400, 'VALIDATION_FAILED'],
    ['42883', 'function ehr.order_notice_summary() does not exist', 503, 'ORDER_NOTICES_UNAVAILABLE'],
    ['42P01', 'relation "ehr.order_notices" does not exist', 503, 'ORDER_NOTICES_UNAVAILABLE'],
    ['57014', 'canceling statement due to statement timeout', 503, 'ORDER_NOTICES_UNAVAILABLE'],
    ['42501', 'permission denied for function list_order_notices', 503, 'ORDER_NOTICES_UNAVAILABLE'],
  ])('%s %s is %i %s', async (code, message, status, answerCode) => {
    const problem = translate(databaseError(code, message));
    expect([problem.getStatus(), problem.code]).toEqual([status, answerCode]);
    const summary = await refusal(harness(databaseError(code, message)).service.summary(context));
    expect([summary.getStatus(), summary.code]).toEqual([status, answerCode]);
  });

  it('a refusal of its own passes through', () => {
    const own = new DomainProblem(400, 'VALIDATION_FAILED', 'x');
    expect(translate(own)).toBe(own);
  });
});

describe('ORD-11 the words', () => {
  it.each([
    ['lab_result_ready', 1, 'Result ready: Potassium.'],
    ['lab_result_ready', 3, '3 results ready: Potassium.'],
    ['lab_result_corrected', 1, 'Corrected result: Potassium.'],
    ['lab_result_corrected', 2, '2 corrected results: Potassium.'],
    ['lab_result_critical', 1, 'Critical result: Potassium. Open it and mark it Seen.'],
    ['lab_result_withdrawn', 1, 'Result withdrawn: Potassium. It was entered in error.'],
    ['lab_result_withdrawn', 2, '2 results withdrawn: Potassium. They were entered in error.'],
    ['prescription_dispensed', 1, 'Dispensed: Potassium.'],
    ['dispensing_reversed', 1, 'Dispensing reversed: Potassium.'],
    ['dispensing_reversed', 2, '2 dispensings reversed: Potassium.'],
    ['a_later_kind', 1, 'News about your order: Potassium.'],
  ])('%s, %i event(s)', (kind, count, words) => {
    expect(noticeMessage(kind, 'Potassium', count, false)).toBe(words);
  });

  it.each([
    ['lab_result_ready', 'A result is ready'], ['lab_result_corrected', 'A corrected result is ready'],
    ['lab_result_withdrawn', 'A result was withdrawn'], ['prescription_dispensed', 'A prescription was dispensed'],
    ['dispensing_reversed', 'A dispensing was reversed'], ['a_later_kind', 'There is news about an order'],
  ])('access ended, %s: no name, ask for access', (kind, start) => {
    expect(noticeMessage(kind, 'Potassium', 2, true)).toBe(
      `${start} for a patient whose access has ended. Ask the patient for access to see it.`);
  });

  it('access ended, critical: or call the laboratory, until it is Seen', () => {
    expect(noticeMessage('lab_result_critical', null, 1, true)).toMatch(/to see it, or call the laboratory\.$/);
    expect(noticeMessage('lab_result_critical', null, 1, true, true)).toMatch(/to see it\.$/);
  });
});

describe('ORD-11 the sweep', () => {
  it('on: every 10 minutes outside tests, through the system transaction, 500 at a time', async () => {
    const { database, calls } = harness([{ swept: 7 }]);
    const sweeper = new OrderNoticeSweeper(database as unknown as DatabaseService, new OrderNoticesSwitch(true));
    await expect(sweeper.sweep()).resolves.toBe(7);
    expect(calls).toEqual([{ sql: ORDER_NOTICE_SWEEP_SQL, values: [500] }]);
    expect(database.withSystemTransaction).toHaveBeenCalledWith(expect.stringMatching(/^order-notice-sweep-/),
      expect.any(Function));
    const interval = jest.spyOn(global, 'setInterval');
    sweeper.onModuleInit();
    expect(interval).not.toHaveBeenCalled();
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      sweeper.onModuleInit();
    } finally {
      process.env.NODE_ENV = nodeEnv;
    }
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 600_000);
    sweeper.onModuleDestroy();
    interval.mockRestore();
  });

  it('a failure is logged once with no identifier, and answers 0', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { database } = harness(databaseError('42883', 'function ehr.sweep_order_notices(integer) does not exist'));
    const sweeper = new OrderNoticeSweeper(database as unknown as DatabaseService, new OrderNoticesSwitch(true));
    await expect(sweeper.sweep()).resolves.toBe(0);
    expect(warn).toHaveBeenCalledWith({ event: 'ehr.order_notice.sweep_unavailable' });
    warn.mockRestore();
  });
});
