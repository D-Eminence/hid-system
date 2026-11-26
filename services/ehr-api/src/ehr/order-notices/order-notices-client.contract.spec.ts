import { type INestApplication, Logger, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { EhrApiClient, EhrApiProblem, type EhrOrderNotice, type EhrOrderNoticePage, type EhrOrderNoticeSummary,
  type IdentityActorContext } from '@hid/api-client';
import type { AddressInfo } from 'node:net';
import type { PoolClient } from 'pg';
import { AuditInterceptor } from '../../audit/audit.interceptor';
import { AuditService } from '../../audit/audit.service';
import { RemoteSecurityGuard } from '../../auth/remote-security.guard';
import { CorrelationMiddleware } from '../../common/correlation.middleware';
import { ProblemDetailsFilter } from '../../common/problem';
import { createValidationPipe } from '../../common/validation-pipe';
import { DatabaseService } from '../../database/database.service';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { OrderNoticesController } from './order-notices.controller';
import { ORDER_NOTICE_SEEN_SQL, ORDER_NOTICE_SUMMARY_SQL, ORDER_NOTICES_LIST_SQL, ORDER_NOTICES_READ_SQL,
  OrderNoticesService, OrderNoticesSwitch } from './order-notices.service';

// ORD-11 over HTTP, as AppModule and main.ts serve it: the real guard,
// audit interceptor, audit service, validation pipe and problem filter, the
// routes and their service, over a database that answers the definers, and
// packages/api-client's calls reading what is sent. The types come from the
// package's entry point, so this also stops compiling if they are no longer
// exported there. Fictional identifiers and names only.

const FACILITY = { id: '30000000-0000-4000-8000-000000000001', membershipId: '40000000-0000-4000-8000-000000000001',
  organizationId: '50000000-0000-4000-8000-000000000001', name: 'Lagos General', roles: ['doctor'],
  permissions: ['ehr.lab-request.read', 'ehr.prescription.read'], isPrimary: true };
const doctor: IdentityActorContext = { kind: 'staff', id: 'staff:d', subject: 'staff:d',
  accountId: '20000000-0000-4000-8000-0000000000d1', roles: ['doctor'], permissions: FACILITY.permissions,
  platformRoles: [], platformPermissions: [], facilityIds: [FACILITY.id], facilities: [FACILITY], facility: FACILITY,
  role: 'doctor', authenticationMethod: 'local' };
const receptionist: IdentityActorContext = { ...doctor, facilities: [{ ...FACILITY, roles: ['receptionist'],
  permissions: ['identity.registration.write'] }] };
const patient: IdentityActorContext = { kind: 'patient', patientId: '60000000-0000-4000-8000-000000000001',
  id: 'patient:p', subject: 'patient:p', accountId: '20000000-0000-4000-8000-0000000000c1', roles: [], permissions: [],
  facilityIds: [], facilities: [], authenticationMethod: 'local' };
const noticeA = '70000000-0000-4000-8000-000000000001';
const noticeB = '70000000-0000-4000-8000-000000000002';
const orderId = '80000000-0000-4000-8000-000000000001';
const routeId = '90000000-0000-4000-8000-000000000001';
const context = { correlationId: 'client-contract-ord11-1234', facilityId: FACILITY.id, purposeOfUse: 'direct-care',
  authorization: 'Bearer propagated-user' };

const noticeRow = (overrides: Record<string, unknown> = {}) => ({ notice_id: noticeA, kind: 'lab_result_critical',
  order_kind: 'lab_request', order_id: orderId, order_route_id: routeId, encounter_id: 'a0000000-0000-4000-8000-000000000001',
  display: 'Synthetic potassium', event_count: 1, first_event_at: new Date('2026-11-26T09:00:00Z'),
  last_event_at: new Date('2026-11-26T09:00:00Z'), read_at: null, needs_seen: true, seen_at: null, version: '1',
  access_ended: false, patient_id: '60000000-0000-4000-8000-000000000001', full_name: 'Ada Notice', sex: 'female',
  date_of_birth: '1984-04-04', health_id_last4: 'A2B3', ...overrides });

interface Sent { sql: string; values: unknown[] }

let app: INestApplication | undefined;
let client: EhrApiClient;
let actor: IdentityActorContext;
let sent: Sent[];
let audited: { action: string; outcome: string }[];
let answers: Map<string, Record<string, unknown>[] | Error>;

async function start(enabled: boolean) {
  sent = [];
  audited = [];
  answers = new Map();
  actor = doctor;
  const transactionClient = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    sent.push({ sql, values });
    const answer = answers.get(sql);
    if (answer instanceof Error) throw answer;
    return { rows: answer ?? [] };
  }) };
  const database = {
    query: jest.fn(async (sql: string, values: unknown[]) => {
      if (sql.includes('platform.control_enabled')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }] };
      if (sql.includes('insert into audit.events')) {
        audited.push({ action: values[8] as string, outcome: values[11] as string });
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
    withTransaction: jest.fn(async (_context: unknown, operation: (client: PoolClient) => Promise<unknown>) =>
      operation(transactionClient as unknown as PoolClient)),
  };
  const identity = { authenticateRequest: jest.fn(async () => actor) };

  @Module({
    controllers: [OrderNoticesController],
    providers: [OrderNoticesService, AuditService, { provide: OrderNoticesSwitch, useValue: new OrderNoticesSwitch(enabled) },
      { provide: DatabaseService, useValue: database }, { provide: IdentityApiService, useValue: identity },
      { provide: APP_GUARD, useClass: RemoteSecurityGuard }, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
  })
  class ContractModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
    }
  }

  const moduleRef = await Test.createTestingModule({ imports: [ContractModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.listen(0, '127.0.0.1');
  client = new EhrApiClient({ baseUrl: `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}` });
}

async function problemOf(promise: Promise<unknown>): Promise<{ status: number; code: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EhrApiProblem) return { status: error.status, code: (error.payload as { code?: unknown })?.code };
    throw error;
  }
  throw new Error('expected a refusal');
}

const quiet = () => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

afterEach(async () => {
  await app?.close();
  app = undefined;
  jest.restoreAllMocks();
});

describe('ORD-11 client and routes over HTTP', () => {
  it('the summary: counts per kind; polled, so no audit row when it answers', async () => {
    await start(true);
    answers.set(ORDER_NOTICE_SUMMARY_SQL, [{ kind: 'lab_result_critical', unread_count: 1, critical_not_seen_count: 2 }]);
    const summary: EhrOrderNoticeSummary = await client.orderNoticeSummary(context);
    expect(summary).toMatchObject({ unread: 1, criticalNotSeen: 2,
      byKind: { lab_result_critical: { unread: 1, criticalNotSeen: 2 }, lab_result_ready: { unread: 0, criticalNotSeen: 0 } } });
    expect(audited).toEqual([]);
  });

  it('the list: the query sent, a routed critical notice and one whose access ended, the next cursor; audited', async () => {
    await start(true);
    const cut = { has_more: true, resume_tier: 0, resume_at: '2026-11-26T09:00:00.123456Z', resume_id: noticeB };
    answers.set(ORDER_NOTICES_LIST_SQL, [noticeRow(cut), noticeRow({ notice_id: noticeB,
      kind: 'prescription_dispensed', order_kind: 'prescription', order_route_id: null, needs_seen: false,
      access_ended: true, patient_id: null, full_name: null, sex: null, date_of_birth: null, health_id_last4: null,
      encounter_id: null, display: null, ...cut })]);
    const page: EhrOrderNoticePage = await client.listOrderNotices({ state: 'unread', limit: 2 }, context);
    expect(sent).toEqual([{ sql: ORDER_NOTICES_LIST_SQL, values: ['unread', null, null, null, 2] }]);
    expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]{16,512}$/);
    await client.listOrderNotices({ state: 'unread', cursor: page.nextCursor!, limit: 2 }, context);
    expect(sent[1]).toEqual({ sql: ORDER_NOTICES_LIST_SQL, values: ['unread', 0, '2026-11-26T09:00:00.123456Z', noticeB, 2] });
    quiet();
    expect(await problemOf(client.listOrderNotices({ state: 'all', cursor: page.nextCursor!, limit: 2 }, context)))
      .toEqual({ status: 400, code: 'INVALID_CURSOR' });
    expect(sent).toHaveLength(2);
    expect(page.items[0]).toEqual({ noticeId: noticeA, kind: 'lab_result_critical', version: 1,
      createdAt: '2026-11-26T09:00:00.000Z', lastEventAt: '2026-11-26T09:00:00.000Z', count: 1, readAt: null,
      needsSeen: true, seenAt: null, order: { type: 'lab_request', id: orderId, routeId,
        encounterId: 'a0000000-0000-4000-8000-000000000001', display: 'Synthetic potassium' },
      patient: { patientId: '60000000-0000-4000-8000-000000000001', fullName: 'Ada Notice', sex: 'female',
        dateOfBirth: '1984-04-04', healthIdLast4: 'A2B3' }, accessEnded: false,
      message: 'Critical result: Synthetic potassium. Open it and mark it Seen.' } satisfies EhrOrderNotice);
    expect(page.items[1]).toMatchObject({ accessEnded: true, patient: null, order: { display: null, encounterId: null } });
    expect(audited).toEqual([{ action: 'api.get./api/v1/ehr/me/order-notices', outcome: 'success' },
      { action: 'api.get./api/v1/ehr/me/order-notices', outcome: 'success' },
      { action: 'api.get./api/v1/ehr/me/order-notices', outcome: 'failure' }]);
  });

  it('mark read: the pairs sent as the route takes them; a stale version is updated 0', async () => {
    await start(true);
    answers.set(ORDER_NOTICES_READ_SQL, [{ updated: 0 }]);
    await expect(client.markOrderNoticesRead([{ noticeId: noticeA, version: 2 }, { noticeId: noticeB, version: 5 }],
      context)).resolves.toEqual({ updated: 0 });
    expect(sent).toEqual([{ sql: ORDER_NOTICES_READ_SQL, values: [[noticeA, noticeB], [2, 5]] }]);
    expect(audited).toEqual([{ action: 'api.post./api/v1/ehr/me/order-notices/read', outcome: 'success' }]);
  });

  it('Seen: the notice with seenAt; refused when access ended or the notice is not the caller\'s', async () => {
    await start(true);
    answers.set(ORDER_NOTICE_SEEN_SQL, [noticeRow({ read_at: new Date('2026-11-26T10:00:00Z'),
      seen_at: new Date('2026-11-26T10:00:00Z'), version: '3' })]);
    await expect(client.markOrderNoticeSeen(noticeA, context)).resolves.toMatchObject({ noticeId: noticeA,
      seenAt: '2026-11-26T10:00:00.000Z', version: 3, message: 'Critical result: Synthetic potassium. Marked Seen.' });
    quiet();
    answers.set(ORDER_NOTICE_SEEN_SQL, Object.assign(new Error('ORDER_NOTICE_CONSENT_REQUIRED'), { code: '42501' }));
    expect(await problemOf(client.markOrderNoticeSeen(noticeA, context))).toEqual({ status: 403, code: 'CONSENT_REQUIRED' });
    answers.set(ORDER_NOTICE_SEEN_SQL, Object.assign(new Error('ORDER_NOTICE_NOT_FOUND'), { code: 'P0002' }));
    expect(await problemOf(client.markOrderNoticeSeen(noticeB, context))).toEqual({ status: 404,
      code: 'ORDER_NOTICE_NOT_FOUND' });
    expect(audited).toEqual([
      { action: 'api.post./api/v1/ehr/me/order-notices/:noticeId/seen', outcome: 'success' },
      { action: 'api.post./api/v1/ehr/me/order-notices/:noticeId/seen', outcome: 'failure' },
      { action: 'api.post./api/v1/ehr/me/order-notices/:noticeId/seen', outcome: 'failure' },
    ]);
  });

  it('validation: 400 before any database call (a bad state, 101 pairs, a notice id that is not a UUID)', async () => {
    await start(true);
    quiet();
    expect(await problemOf(client.listOrderNotices({ state: 'read' as 'all' }, context))).toEqual({ status: 400,
      code: 'VALIDATION_FAILED' });
    expect(await problemOf(client.markOrderNoticesRead(Array.from({ length: 101 }, (_unused, index) => ({
      noticeId: `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`, version: 1 })), context)))
      .toEqual({ status: 400, code: 'VALIDATION_FAILED' });
    expect(await problemOf(client.markOrderNoticeSeen('not-a-uuid', context))).toEqual({ status: 400, code: 'BAD_REQUEST' });
    expect(sent).toEqual([]);
  });

  it('the summary audits its failures: a refused summary writes one failure row', async () => {
    await start(true);
    quiet();
    expect(await problemOf(client.orderNoticeSummary({ ...context, purposeOfUse: 'emergency' }))).toEqual({ status: 400,
      code: 'PURPOSE_OF_USE_REQUIRED' });
    expect(audited).toEqual([{ action: 'api.get./api/v1/ehr/me/order-notices/summary', outcome: 'failure' }]);
  });

  it('the guard: no facility, neither permission, or a patient session is refused before the service', async () => {
    await start(true);
    quiet();
    expect(await problemOf(client.orderNoticeSummary({ ...context, facilityId: '' }))).toEqual({ status: 400,
      code: 'FACILITY_REQUIRED' });
    actor = receptionist;
    expect(await problemOf(client.orderNoticeSummary(context))).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
    actor = patient;
    expect(await problemOf(client.listOrderNotices({ state: 'all' }, context))).toEqual({ status: 403,
      code: 'PATIENT_SCOPE_DENIED' });
    expect(sent).toEqual([]);
  });

  it('switch off: each call is 503 ORDER_NOTICES_UNAVAILABLE, nothing read', async () => {
    await start(false);
    quiet();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    for (const call of [client.orderNoticeSummary(context), client.listOrderNotices({ state: 'unread' }, context),
      client.markOrderNoticesRead([{ noticeId: noticeA, version: 1 }], context), client.markOrderNoticeSeen(noticeA, context)]) {
      expect(await problemOf(call)).toEqual({ status: 503, code: 'ORDER_NOTICES_UNAVAILABLE' });
    }
    expect(sent).toEqual([]);
  });
});

describe('ORD-11 the client refuses a broken answer (502)', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  const respond = (payload: unknown) => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200,
      headers: { 'content-type': 'application/json' } }));
  };
  const offline = new EhrApiClient({ baseUrl: 'https://ehr.test' });
  const notice = { noticeId: noticeA, kind: 'lab_result_ready', version: 1, createdAt: '2026-11-26T09:00:00.000Z',
    lastEventAt: '2026-11-26T09:00:00.000Z', count: 1, readAt: null, needsSeen: false, seenAt: null,
    order: { type: 'lab_request', id: orderId, routeId: null, encounterId: null, display: null }, patient: null,
    accessEnded: true, message: 'A result is ready for a patient whose access has ended.' };

  it('a staff call: the user\'s credentials, no internal caller or service token', async () => {
    respond({ items: [], nextCursor: null });
    await offline.listOrderNotices({ state: 'all', limit: 5 }, context);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://ehr.test/api/v1/ehr/me/order-notices?state=all&limit=5');
    expect(init.credentials).toBe('include');
    expect(init.headers).toMatchObject({ authorization: 'Bearer propagated-user', 'x-facility-id': FACILITY.id,
      'x-purpose-of-use': 'direct-care' });
    expect(Object.keys(init.headers)).not.toEqual(expect.arrayContaining(['x-hid-internal-caller']));
    expect(Object.keys(init.headers).filter((name) => name.startsWith('x-hid-service'))).toEqual([]);
  });

  it('Seen: the answered id is the one sent, in any letter case', async () => {
    // ehr-api's UUID check takes upper case, and the database answers the id in lower case.
    const lettered = '70000000-0000-4000-8000-00000000abcd';
    const seen = { ...notice, noticeId: lettered, seenAt: '2026-11-26T10:00:00.000Z', readAt: null, version: 2 };
    respond(seen);
    await expect(offline.markOrderNoticeSeen(lettered.toUpperCase(), context)).resolves.toMatchObject({
      noticeId: lettered, seenAt: '2026-11-26T10:00:00.000Z' });
    respond({ ...seen, noticeId: noticeB });
    expect(await problemOf(offline.markOrderNoticeSeen(lettered.toUpperCase(), context))).toMatchObject({ status: 502 });
  });

  it('keeps a kind it does not know; refuses a patient shown on a notice whose access ended', async () => {
    respond({ items: [{ ...notice, kind: 'a_later_kind' }], nextCursor: null });
    expect((await offline.listOrderNotices({ state: 'all' }, context)).items[0]!.kind).toBe('a_later_kind');
    respond({ items: [{ ...notice, patient: { patientId: 'p', fullName: 'Ada Notice', sex: null, dateOfBirth: null,
      healthIdLast4: null } }], nextCursor: null });
    expect(await problemOf(offline.listOrderNotices({ state: 'all' }, context))).toMatchObject({ status: 502 });
    respond({ items: [{ ...notice, order: { ...notice.order, display: 'Synthetic potassium' } }], nextCursor: null });
    expect(await problemOf(offline.listOrderNotices({ state: 'all' }, context))).toMatchObject({ status: 502 });
  });

  it.each([
    ['no version', { ...notice, version: undefined }], ['version 0', { ...notice, version: 0 }],
    ['count as text', { ...notice, count: '1' }], ['no message', { ...notice, message: undefined }],
    ['a notice id that is not a UUID', { ...notice, noticeId: 'n1' }],
  ])('a notice with %s', async (_label, broken) => {
    respond({ items: [broken], nextCursor: null });
    expect(await problemOf(offline.listOrderNotices({ state: 'all' }, context))).toMatchObject({ status: 502 });
  });

  it('a page over 50, a cursor that is not one, counts that are not whole, more updated than sent, a Seen without seenAt',
    async () => {
      respond({ items: Array.from({ length: 51 }, () => notice), nextCursor: null });
      expect(await problemOf(offline.listOrderNotices({ state: 'all' }, context))).toMatchObject({ status: 502 });
      respond({ items: [], nextCursor: 'next' });
      expect(await problemOf(offline.listOrderNotices({ state: 'all' }, context))).toMatchObject({ status: 502 });
      respond({ items: [], nextCursor: 'eyJ2IjoxLCJmIjoi+/=' });
      expect(await problemOf(offline.listOrderNotices({ state: 'all' }, context))).toMatchObject({ status: 502 });
      respond({ unread: 1.5, criticalNotSeen: 0, byKind: {} });
      expect(await problemOf(offline.orderNoticeSummary(context))).toMatchObject({ status: 502 });
      respond({ unread: 1, criticalNotSeen: 0, byKind: { lab_result_ready: { unread: -1, criticalNotSeen: 0 } } });
      expect(await problemOf(offline.orderNoticeSummary(context))).toMatchObject({ status: 502 });
      respond({ updated: 2 });
      expect(await problemOf(offline.markOrderNoticesRead([{ noticeId: noticeA, version: 1 }], context)))
        .toMatchObject({ status: 502 });
      respond(notice);
      expect(await problemOf(offline.markOrderNoticeSeen(noticeA, context))).toMatchObject({ status: 502 });
    });
});
