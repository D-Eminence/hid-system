import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { PoolClient } from 'pg';
import { REQUIRED_PERMISSIONS } from '../../common/decorators';
import type { DataAccessContext } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import type { WorkItemProgressService } from '../../integrations/work-item-progress.service';
import type { OrderRouteReader } from '../order-routes/order-route-reader';
import { MyOrdersController } from './my-orders.controller';
import { MyOrdersQueryDto } from './my-orders.dto';
import { addYears, lagosDay, MY_ORDERS_SQL, MyOrdersService, OWN_PROGRESS_CONCURRENCY } from './my-orders.service';

// MY-1 (0143): "Ordered by me". What the member may see, and the audit rows,
// are the database's (services/ehr-api/test/database/my-orders.integration.sql);
// this is the route around it. Fictional identifiers only.
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const patientA = '123e4567-e89b-42d3-a456-426614174011';
const patientB = '123e4567-e89b-42d3-a456-426614174012';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const now = new Date('2026-11-20T10:00:00Z');
const context = (permissions: string[]) => ({ correlationId: 'correlation-123456', facilityId, membershipId,
  purposeOfUse: 'direct-care', actor: { accountId: membershipId, subject: 'staff:test', permissions } }) as unknown as DataAccessContext;
const BOTH = ['ehr.lab-request.read', 'ehr.prescription.read'];

const row = (overrides: Record<string, unknown>) => ({ kind: 'prescription', order_id: '123e4567-e89b-42d3-a456-426614174101',
  encounter_id: encounterId, patient_id: patientA, full_name: 'Ada Orders', sex: 'female', date_of_birth: '1984-04-04',
  health_id_last4: 'A2B3', display: 'Synthetic amoxicillin', status: 'active', priority: null,
  created_at: new Date('2026-11-20T09:00:00Z'), updated_at: new Date('2026-11-20T09:05:00Z'), hidden_count: '2',
  hidden_count_complete: true, has_more: false, resume_at: null, resume_kind: null, resume_id: null, ...overrides });
const more = { has_more: true, resume_at: '2026-11-20T09:00:00.123456Z', resume_kind: 'prescription',
  resume_id: '123e4567-e89b-42d3-a456-426614174101' };

function harness(rows: Record<string, unknown>[] | Error = [row({})]) {
  const calls: unknown[][] = [];
  const client = { query: jest.fn(async (_sql: string, values: unknown[]) => {
    calls.push(values);
    if (rows instanceof Error) throw rows;
    return { rows };
  }) };
  const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: PoolClient) => Promise<unknown>) =>
    operation(client as unknown as PoolClient)) };
  const routes = { summaries: jest.fn(async (_client: unknown, _context: unknown, _kind: string, _patient: string,
    ids: string[]) => new Map(ids.map((id) => [id, { orderRouteId: `route-${id.slice(-3)}` }]))) };
  const progress = {
    pharmacy: jest.fn(async (_context: unknown, _patient: string, items: { id: string }[]) =>
      new Map(items.map((item) => [item.id, { status: 'received', receivedAt: null, dispensedAt: null, reversedAt: null }]))),
    lab: jest.fn(async (_context: unknown, _patient: string, items: { id: string }[]) =>
      new Map(items.map((item) => [item.id, { status: 'results_ready', receivedAt: null, collectedAt: null, lastResultAt: null }]))),
  };
  const service = new MyOrdersService(database as unknown as DatabaseService, routes as unknown as OrderRouteReader,
    progress as unknown as WorkItemProgressService);
  return { service, calls, routes, progress, client };
}

const query = (values: Record<string, unknown> = {}) => plainToInstance(MyOrdersQueryDto, values);

describe('MY-1: GET /ehr/my-orders', () => {
  it('is a GET with no single permission, never cached', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MyOrdersController)).toBe('ehr/my-orders');
    const handler = MyOrdersController.prototype.list;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toBeUndefined();
    expect(Reflect.getMetadata('__headers__', handler)).toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
  });

  it.each([
    ['kind', { kind: 'visit' }], ['state', { state: 'closed' }], ['since', { since: '20-11-2026' }],
    ['limit 0', { limit: 0 }], ['limit 51', { limit: 51 }], ['cursor', { cursor: 'short' }],
  ])('the query refuses a bad %s (400 VALIDATION_FAILED)', (_label, values) => {
    expect(validateSync(query(values)).length).toBeGreaterThan(0);
  });

  it('the defaults: all kinds, all states, 90 days back (Lagos day), 25 rows', async () => {
    const { service, calls } = harness();
    const page = await service.list(context(BOTH), query(), now);
    expect(calls[0]).toEqual([['lab_request', 'prescription'], false, '2026-08-22', null, null, null, 25]);
    expect(page.since).toBe('2026-08-22');
  });

  it('the Lagos day is the day in Lagos', () => {
    expect(lagosDay(new Date('2026-11-19T23:30:00Z'))).toBe('2026-11-20');
  });

  it.each([
    ['all, with lab read only', 'all', ['ehr.lab-request.read'], ['lab_request']],
    ['all, with prescription read only', 'all', ['ehr.prescription.read'], ['prescription']],
    ['lab', 'lab', BOTH, ['lab_request']],
    ['prescription', 'prescription', BOTH, ['prescription']],
  ])('kind %s lists only what the member may read', async (_label, kind, permissions, kinds) => {
    const { service, calls } = harness();
    await service.list(context(permissions), query({ kind }), now);
    expect(calls[0]![0]).toEqual(kinds);
  });

  it.each([
    ['neither permission', 'all', []], ['lab without lab-request read', 'lab', ['ehr.prescription.read']],
    ['prescription without prescription read', 'prescription', ['ehr.lab-request.read']],
  ])('%s is 403 PERMISSION_DENIED, with nothing read', async (_label, kind, permissions) => {
    const { service, calls } = harness();
    await expect(service.list(context(permissions), query({ kind }), now)).rejects.toMatchObject({ status: 403,
      code: 'PERMISSION_DENIED' });
    expect(calls).toHaveLength(0);
  });

  it('more than 2 years back is 400 MY_ORDERS_SINCE_TOO_OLD; a future day or a non-day is 400 VALIDATION_FAILED', async () => {
    const { service } = harness();
    await expect(service.list(context(BOTH), query({ since: '2024-11-19' }), now)).rejects.toMatchObject({ status: 400,
      code: 'MY_ORDERS_SINCE_TOO_OLD', message: 'You can look back up to 2 years. Choose a later date.' });
    await expect(service.list(context(BOTH), query({ since: '2024-11-20' }), now)).resolves.toBeDefined();
    await expect(service.list(context(BOTH), query({ since: '2026-11-21' }), now)).rejects.toMatchObject({ status: 400,
      code: 'VALIDATION_FAILED' });
    await expect(service.list(context(BOTH), query({ since: '2026-02-30' }), now)).rejects.toMatchObject({ status: 400,
      code: 'VALIDATION_FAILED' });
  });

  it('answers the contract\'s shape: the card, the order, its own progress and route', async () => {
    const { service, progress, routes } = harness([
      row({}),
      row({ kind: 'lab_request', order_id: '123e4567-e89b-42d3-a456-426614174201', display: 'Synthetic blood count',
        status: 'completed', priority: 'urgent' }),
    ]);
    const page = await service.list(context(BOTH), query({ state: 'open' }), now);
    expect(page).toEqual({ hiddenCount: 2, hiddenCountComplete: true, since: '2026-08-22', nextCursor: null, items: [
      { kind: 'prescription', orderId: '123e4567-e89b-42d3-a456-426614174101', encounterId,
        patient: { patientId: patientA, fullName: 'Ada Orders', sex: 'female', dateOfBirth: '1984-04-04', healthIdLast4: 'A2B3' },
        display: 'Synthetic amoxicillin', status: 'active', priority: null, createdAt: '2026-11-20T09:00:00.000Z',
        updatedAt: '2026-11-20T09:05:00.000Z', ownProgress: expect.objectContaining({ status: 'received' }),
        orderRoute: { orderRouteId: 'route-101' } },
      expect.objectContaining({ kind: 'lab_request', priority: 'urgent', ownProgress: expect.objectContaining({ status: 'results_ready' }) }),
    ] });
    expect(JSON.stringify(page)).not.toMatch(/HID-|hidCode|healthId"/);
    expect(progress.pharmacy).toHaveBeenCalledTimes(1);
    expect(progress.lab).toHaveBeenCalledTimes(1);
    expect(routes.summaries).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'prescription', patientA,
      ['123e4567-e89b-42d3-a456-426614174101']);
  });

  it('asks progress once per patient and kind on the page', async () => {
    const { service, progress } = harness([
      row({ order_id: '123e4567-e89b-42d3-a456-426614174101' }),
      row({ order_id: '123e4567-e89b-42d3-a456-426614174102' }),
      row({ order_id: '123e4567-e89b-42d3-a456-426614174103', patient_id: patientB }),
    ]);
    await service.list(context(BOTH), query(), now);
    expect(progress.pharmacy).toHaveBeenCalledTimes(2);
    expect(progress.pharmacy.mock.calls[0]![2]).toEqual([{ id: '123e4567-e89b-42d3-a456-426614174101', status: 'active' },
      { id: '123e4567-e89b-42d3-a456-426614174102', status: 'active' }]);
  });

  it('an empty page still answers hiddenCount (the database\'s row with no order)', async () => {
    const { service, progress } = harness([row({ kind: null, order_id: null, encounter_id: null, patient_id: null,
      hidden_count: '3', created_at: null, updated_at: null })]);
    await expect(service.list(context(BOTH), query(), now)).resolves.toEqual({ items: [], hiddenCount: 3,
      hiddenCountComplete: true, since: '2026-08-22', nextCursor: null });
    expect(progress.pharmacy).not.toHaveBeenCalled();
  });

  it('a page the database stopped early (none listed) still has more, resuming where the database says', async () => {
    const first = harness([row({ kind: null, order_id: null, encounter_id: null, patient_id: null, hidden_count: '2000',
      hidden_count_complete: false, created_at: null, updated_at: null, ...more,
      resume_id: '123e4567-e89b-42d3-a456-426614174999' })]);
    const page = await first.service.list(context(BOTH), query(), now);
    expect(page).toMatchObject({ items: [], hiddenCount: 2000, hiddenCountComplete: false, nextCursor: expect.any(String) });
    const next = harness([row({ hidden_count: null, hidden_count_complete: null })]);
    const second = await next.service.list(context(BOTH), query({ cursor: page.nextCursor }), now);
    expect(next.calls[0]!.slice(3)).toEqual(['2026-11-20T09:00:00.123456Z', 'prescription',
      '123e4567-e89b-42d3-a456-426614174999', 25]);
    // Later pages carry the first page's count; the database does not recount it.
    expect(second).toMatchObject({ hiddenCount: 2000, hiddenCountComplete: false });
  });

  it('a later page keeps the first page\'s day across Lagos midnight; an explicit other day is refused', async () => {
    const lateEvening = new Date('2026-11-20T22:59:00Z');
    const afterMidnight = new Date('2026-11-20T23:01:00Z');
    const first = harness([row(more)]);
    const page = await first.service.list(context(BOTH), query({ limit: 1 }), lateEvening);
    expect(first.calls[0]![2]).toBe('2026-08-22');
    const next = harness();
    await expect(next.service.list(context(BOTH), query({ limit: 1, cursor: page.nextCursor }), afterMidnight))
      .resolves.toMatchObject({ since: '2026-08-22' });
    expect(next.calls[0]![2]).toBe('2026-08-22');
    await expect(next.service.list(context(BOTH), query({ limit: 1, since: '2026-08-22', cursor: page.nextCursor }),
      afterMidnight)).resolves.toBeDefined();
    await expect(next.service.list(context(BOTH), query({ limit: 1, since: '2026-08-23', cursor: page.nextCursor }),
      afterMidnight)).rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
  });

  it('pages with an exact cursor bound to the member and the filters', async () => {
    const first = harness([row(more)]);
    const page = await first.service.list(context(BOTH), query({ limit: 1 }), now);
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = harness();
    await next.service.list(context(BOTH), query({ limit: 1, cursor: page.nextCursor }), now);
    expect(next.calls[0]!.slice(3)).toEqual(['2026-11-20T09:00:00.123456Z', 'prescription',
      '123e4567-e89b-42d3-a456-426614174101', 1]);
    // Another filter, or another member, cannot use it.
    await expect(next.service.list(context(BOTH), query({ limit: 1, state: 'open', cursor: page.nextCursor }), now))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
    await expect(next.service.list(context(['ehr.prescription.read']), query({ limit: 1, cursor: page.nextCursor }), now))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
  });

  it.each([
    ['a schema without 0143', Object.assign(new Error('function ehr.list_my_orders does not exist'), { code: '42883' }),
      503, 'MY_ORDERS_UNAVAILABLE'],
    ['any other failure', new Error('Connection terminated unexpectedly'), 503, 'MY_ORDERS_UNAVAILABLE'],
    ['the database\'s refusal', Object.assign(new Error('MY_ORDERS_NOT_PERMITTED'), { code: '42501' }), 403, 'PERMISSION_DENIED'],
    ['another purpose', Object.assign(new Error('MY_ORDERS_DIRECT_CARE_ONLY'), { code: '22023' }), 400, 'PURPOSE_OF_USE_REQUIRED'],
    ['a day after the database\'s today', Object.assign(new Error('MY_ORDERS_SINCE_INVALID'), { code: '22023' }), 400,
      'VALIDATION_FAILED'],
  ] as const)('%s answers %s %s', async (_label, error, status, code) => {
    const { service } = harness(error);
    await expect(service.list(context(BOTH), query(), now)).rejects.toMatchObject({ status, code });
  });

  it('reads through the definer with the exact time of where the next page resumes', () => {
    expect(MY_ORDERS_SQL).toContain('from ehr.list_my_orders($1::text[], $2, $3::date, $4::timestamptz, $5, $6::uuid, $7)');
    expect(MY_ORDERS_SQL).toContain(`to_char(resume_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as resume_at`);
  });

  it('the 2-year bound is PostgreSQL\'s: 29 February goes to the 28th', async () => {
    expect(addYears('2028-02-29', -2)).toBe('2026-02-28');
    expect(addYears('2026-11-20', -2)).toBe('2024-11-20');
    const { service } = harness();
    await expect(service.list(context(BOTH), query({ since: '2026-02-28' }), new Date('2028-02-29T10:00:00Z')))
      .resolves.toBeDefined();
    await expect(service.list(context(BOTH), query({ since: '2026-02-27' }), new Date('2028-02-29T10:00:00Z')))
      .rejects.toMatchObject({ status: 400, code: 'MY_ORDERS_SINCE_TOO_OLD' });
  });

  it('a route that could not be read is left out; one read with no route is null', async () => {
    const { service, routes } = harness([
      row({}),
      row({ order_id: '123e4567-e89b-42d3-a456-426614174103', patient_id: patientB }),
      row({ kind: 'lab_request', order_id: '123e4567-e89b-42d3-a456-426614174201' }),
    ]);
    routes.summaries.mockImplementation(async (_client: unknown, _context: unknown, kind: string, patient: string) =>
      (kind === 'prescription' && patient === patientA ? undefined : new Map()) as never);
    const page = await service.list(context(BOTH), query(), now);
    expect(page.items[0]).not.toHaveProperty('orderRoute');
    expect(page.items[1]).toHaveProperty('orderRoute', null);
    expect(page.items[2]).toHaveProperty('orderRoute', null);
  });

  it('asks progress in parallel, at most 6 at once, and answers unknown for what misses the page\'s deadline', async () => {
    const rows = Array.from({ length: 10 }, (_unused, index) => row({
      order_id: `123e4567-e89b-42d3-a456-4266141742${String(index).padStart(2, '0')}`,
      patient_id: `123e4567-e89b-42d3-a456-4266141743${String(index).padStart(2, '0')}` }));
    const { service, progress } = harness(rows);
    service.progressDeadlineMs = 50;
    let running = 0;
    let most = 0;
    progress.pharmacy.mockImplementation(async (_context: unknown, patient: string, items: { id: string }[]) => {
      running += 1;
      most = Math.max(most, running);
      // The patient ending 03 hangs (the service neither refuses nor answers).
      if (patient.endsWith('4303')) await new Promise(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return new Map(items.map((item) => [item.id, { status: 'received', receivedAt: null, dispensedAt: null, reversedAt: null }]));
    });
    const started = Date.now();
    const page = await service.list(context(BOTH), query(), now);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(most).toBe(OWN_PROGRESS_CONCURRENCY);
    expect(progress.pharmacy).toHaveBeenCalledTimes(10);
    expect(page.items.map((item) => item.ownProgress.status)).toEqual(
      ['received', 'received', 'received', 'unknown', 'received', 'received', 'received', 'received', 'received', 'received']);
  });

  it('a progress call that throws makes only its own orders unknown', async () => {
    const { service, progress } = harness([row({}), row({ order_id: '123e4567-e89b-42d3-a456-426614174103', patient_id: patientB })]);
    progress.pharmacy.mockImplementationOnce(async () => { throw new Error('unexpected'); });
    const page = await service.list(context(BOTH), query(), now);
    expect(page.items.map((item) => item.ownProgress.status)).toEqual(['unknown', 'received']);
  });
});
