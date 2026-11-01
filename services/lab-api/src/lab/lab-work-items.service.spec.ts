import { Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { LabWorkItemsService, WORK_LIST_QUERY } from './lab-work-items.service';
import { LabOrderRouteAccess } from './order-route-access';
import { LabOrderRouteCards } from './order-route-cards';
import type { AcceptEhrLabOrderCommand } from './lab-work-items.types';

const facilityId = '10000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-000000000001';
const orderId = '30000000-0000-4000-8000-000000000001';
const patientId = '50000000-0000-4000-8000-000000000001';
const workItemId = '60000000-0000-4000-8000-000000000001';
const context = { correlationId: 'lab-work-item-correlation', facilityId,
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care', actor: { id: 'actor',
    subject: 'staff:lab', accountId, roles: ['doctor'], permissions: ['lab.work-item.accept'], facilityIds: [facilityId],
    facilities: [], authenticationMethod: 'local' } } satisfies DataAccessContext;
const command = (version: number, priority: AcceptEhrLabOrderCommand['priority'] = 'routine'): AcceptEhrLabOrderCommand => ({
  sourceEhrOrderId: orderId, sourceEhrOrderVersion: version, sourceEncounterId: '70000000-0000-4000-8000-000000000001',
  patientId, orderingFacilityId: facilityId, testCodeSystem: 'http://loinc.org', testCode: '718-7', testName: 'Haemoglobin',
  priority, clinicalIndication: 'Fatigue', requestedBy: accountId, requestedAt: '2026-10-01T09:00:00.123456Z' });

// The work item Lab accepted from version 1 of the EHR order. lab.work_items has
// unique(source_ehr_order_id) (0018): one work item per EHR order, ever.
const stored = { id: workItemId, patient_id: patientId, facility_id: facilityId, ordering_facility_id: facilityId,
  source_ehr_order_id: orderId, source_ehr_order_version: '1', source_encounter_id: '70000000-0000-4000-8000-000000000001',
  status: 'accepted', priority: 'routine', accepted_by: accountId, accepted_at: new Date('2026-10-01T09:00:01Z'),
  row_version: '1', created_at: new Date('2026-10-01T09:00:01Z'),
  request_sha256: requestDigest('lab.work-item.accept-ehr-order', command(1)) };

/** A database error as node-postgres reports it; the message can name rows, values and constraints. */
const databaseError = (code: string, message: string, fields: Record<string, string> = {}) =>
  Object.assign(new Error(message), { code, ...fields });
const uniqueViolation = (table: string, constraint: string) => databaseError('23505',
  `duplicate key value violates unique constraint "${constraint}"`, { schema: 'lab', table, constraint });

/**
 * A fake database holding `rows`. The replay lookup returns the stored work
 * item when its predicate would select it: the same idempotency key, or the
 * same EHR order (and, if the statement also binds the version, that version).
 * An insert behaves as the database does: `insertError` if given (a refusal of
 * the work-item insert), else the unique violation on source_ehr_order_id when
 * a work item of the order exists. `later` fails a later statement of the
 * transaction instead.
 */
const harness = (rows: (typeof stored)[], insertError?: Error, later?: { statement: RegExp; error: Error }) => {
  const queries: string[] = [];
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    queries.push(sql);
    if (/^\s*select\b/i.test(sql) && /from lab\.work_items/.test(sql)) {
      const byVersion = /source_ehr_order_version\s*=\s*\$5/.test(sql);
      return { rows: rows.filter((row) => row.source_ehr_order_id === values[3]
        && (!byVersion || row.source_ehr_order_version === String(values[4]))) };
    }
    if (/insert into lab\.work_items\b/.test(sql)) {
      if (insertError) throw insertError;
      if (rows.some((row) => row.source_ehr_order_id === values[4])) {
        throw uniqueViolation('work_items', 'work_items_source_ehr_order_id_key');
      }
      return { rows: [{ ...stored, source_ehr_order_version: String(values[5]), priority: values[7] }] };
    }
    if (later?.statement.test(sql)) throw later.error;
    return { rows: [], rowCount: 1 };
  }) } as unknown as PoolClient;
  const database = { withTransaction: async <T>(_context: DataAccessContext, operation: (c: PoolClient) => Promise<T>) =>
    operation(client) } as unknown as DatabaseService;
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: false }) } as unknown as IdentityService;
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return { service: new LabWorkItemsService(database, identity, audit, new LabOrderRouteAccess(identity),
    new LabOrderRouteCards(database)), queries };
};
const inserts = (queries: string[]) => queries.filter((sql) => /insert into lab\./.test(sql));

describe('LabWorkItemsService.acceptEhrOrder', () => {
  it('refuses a later version of an EHR order it accepted with 409 LAB_ORDER_ALREADY_ACCEPTED, writing nothing', async () => {
    const { service, queries } = harness([stored]);
    await expect(service.acceptEhrOrder(context, command(2, 'stat'))).rejects.toMatchObject({
      code: 'LAB_ORDER_ALREADY_ACCEPTED', status: 409 });
    expect(inserts(queries)).toEqual([]);
  });

  // Two EHR updates commit v2 and then v3 and each sends its version after its
  // commit; the v3 call reaches Lab first. The late v2 is not the current EHR
  // order (EHR is at v3 or later), and Lab holds a version that already carries
  // its change, so ALREADY_ACCEPTED ("Lab holds an earlier version, the change
  // is not in Lab") would be false.
  it('refuses an earlier version of an EHR order than the one it holds with 409 LAB_ORDER_NOT_CURRENT, writing nothing', async () => {
    const later = { ...stored, source_ehr_order_version: '3', request_sha256: requestDigest('lab.work-item.accept-ehr-order', command(3)) };
    const { service, queries } = harness([later]);
    await expect(service.acceptEhrOrder(context, command(2))).rejects.toMatchObject({
      code: 'LAB_ORDER_NOT_CURRENT', status: 409 });
    expect(inserts(queries)).toEqual([]);
  });

  it('replays the same version of the same order without writing', async () => {
    const { service, queries } = harness([stored]);
    await expect(service.acceptEhrOrder(context, command(1))).resolves.toMatchObject({ id: workItemId,
      sourceEhrOrderId: orderId, sourceEhrOrderVersion: 1, status: 'accepted' });
    expect(inserts(queries)).toEqual([]);
  });

  it('refuses the same version with a different body with 409 IDEMPOTENCY_CONFLICT', async () => {
    const { service, queries } = harness([stored]);
    await expect(service.acceptEhrOrder(context, command(1, 'urgent'))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    expect(inserts(queries)).toEqual([]);
  });

  it('accepts a new order, reading it without a lock', async () => {
    const { service, queries } = harness([]);
    await expect(service.acceptEhrOrder(context, command(1))).resolves.toMatchObject({ sourceEhrOrderVersion: 1 });
    expect(inserts(queries).filter((sql) => /insert into lab\.work_items\b/.test(sql))).toHaveLength(1);
    expect(queries.filter((sql) => /\bfor\s+(update|share|no key update|key share)\b/i.test(sql))).toEqual([]);
  });

  it('answers the acceptance guard refusal (23514) with 409 LAB_ORDER_NOT_CURRENT, keeping the SQLSTATE as its cause', async () => {
    const guard = Object.assign(new Error('Lab work item does not match the exact active EHR order version and actor context'),
      { code: '23514' });
    const { service } = harness([], guard);
    const refusal = await service.acceptEhrOrder(context, command(1)).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: 'LAB_ORDER_NOT_CURRENT', status: 409 });
    expect((refusal as { getResponse?: () => unknown }).getResponse?.()).not.toMatch(/does not match/);
    expect((refusal as { cause?: unknown }).cause).toBe(guard);
  });

  // P4c (SPEC-FINAL §7.5): the guard refuses an order with a live route to
  // another facility's laboratory with the message LAB_REQUEST_ROUTED.
  it('answers the guard\'s LAB_REQUEST_ROUTED refusal with 409 LAB_REQUEST_ROUTED, as the EHR answers it', async () => {
    const guard = Object.assign(new Error('LAB_REQUEST_ROUTED'), { code: '23514' });
    const { service } = harness([], guard);
    const refusal = await service.acceptEhrOrder(context, command(1)).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: 'LAB_REQUEST_ROUTED', status: 409 });
    expect((refusal as { cause?: unknown }).cause).toBe(guard);
  });
});

/**
 * Lab maps no SQLSTATE in its problem filter (fix/ehr-lab-handoff-resend):
 * acceptance maps its own three database refusals, those of the work-item
 * insert and its unique keys, with fixed details. Any other database error
 * reaches the filter unchanged and answers 500, as for every other Lab command.
 */
describe('LabWorkItemsService.acceptEhrOrder database refusals', () => {
  const secret = 'Key (source_ehr_order_id)=(30000000-0000-4000-8000-000000000001) for patient 50000000';
  const answer = (exception: unknown) => {
    const request = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ', method: 'POST',
      route: { path: '/lab/work-items/accept-ehr-order' } } as unknown as HidRequest;
    const response = { status: jest.fn().mockReturnThis(), type: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis() } as unknown as Response;
    const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) } as unknown as ArgumentsHost;
    new ProblemDetailsFilter().catch(exception, host);
    return (response.json as jest.Mock).mock.calls[0]?.[0] as { status: number; code: string; detail: string };
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    // lab.validate_work_item (0077) refuses the work item.
    ['the guard refusal (23514)', 409, 'LAB_ORDER_NOT_CURRENT',
      databaseError('23514', `Lab work item does not match the exact active EHR order version (${secret})`)],
    // Left after DatabaseService's one retry: Lab holds a work item for the order that the replay read cannot return.
    ['the unique conflict on the EHR order (23505)', 409, 'LAB_ORDER_ALREADY_ACCEPTED',
      uniqueViolation('work_items', 'work_items_source_ehr_order_id_key')],
    ['the unique conflict on the order\'s key (23505)', 409, 'LAB_ORDER_ALREADY_ACCEPTED',
      uniqueViolation('work_items', 'work_items_facility_id_accepted_by_idempotency_key_key')],
    // Row-level security refuses the insert: the actor has no database consent.
    ['the row-level security refusal (42501)', 403, 'LAB_ACCESS_DENIED',
      databaseError('42501', `new row violates row-level security policy (${secret})`)],
  ])('answers %s of the work-item insert with a fixed %i %s, keeping the error as its cause', async (_label, status, code, refusal) => {
    const { service, queries } = harness([], refusal);
    const problem = await service.acceptEhrOrder(context, command(1)).catch((error: unknown) => error);
    expect(problem).toBeInstanceOf(DomainProblem);
    expect(problem).toMatchObject({ status, code });
    expect((problem as DomainProblem).cause).toBe(refusal);
    expect(queries.filter((sql) => /insert into lab\.(work_item_requested_tests|work_item_events|outbox_events)\b/.test(sql)))
      .toEqual([]);
    const answered = answer(problem);
    expect(answered).toMatchObject({ status, code });
    expect(answered.detail).toBe((problem as DomainProblem).message);
    for (const text of [secret, refusal.message, (refusal as { code: string }).code, 'work_items']) {
      expect(JSON.stringify(answered)).not.toContain(text);
    }
  });

  it.each([
    // A refusal of a later statement is a defect of the command, not a verdict on the order: it stays 500.
    ['23514 of the requested-test insert (lab.validate_work_item_child)', /insert into lab\.work_item_requested_tests\b/,
      databaseError('23514', 'Lab work item child does not match its parent')],
    ['42501 of the outbox insert', /insert into lab\.outbox_events\b/,
      databaseError('42501', 'permission denied for table outbox_events')],
    ['23505 of another table', /insert into lab\.work_item_events\b/,
      uniqueViolation('work_item_events', 'work_item_events_work_item_id_event_version_key')],
  ])('passes %s on unchanged, so it answers 500', async (_label, statement, error) => {
    const { service } = harness([], undefined, { statement, error });
    await expect(service.acceptEhrOrder(context, command(1))).rejects.toBe(error);
    expect(answer(error)).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });

  it.each(['23503', '23502', '22001', '22P02', '40001', '40P01', 'XX000', 'P0001'])(
    'passes database error %s of the work-item insert on unchanged, so it answers 500', async (code) => {
      const error = databaseError(code, `${secret} failed`);
      const { service } = harness([], error);
      await expect(service.acceptEhrOrder(context, command(1))).rejects.toBe(error);
      expect(answer(error)).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
    });
});

/**
 * The work list answered the 200 oldest rows the member could read, done or
 * not, so a busy facility stopped seeing new work. Open work now comes first,
 * oldest first, and done work fills the rest, newest first. The database does
 * the ordering (checked against Postgres 16 with 250 work items, 30 open in
 * every open state, all 30 answered first); these tests hold the query to that
 * rule and the service to answering exactly what the query returns.
 */
describe('LabWorkItemsService.list order: open work first', () => {
  const RECEIVES = 'select lab.order_route_receives_here() as receives, lab.order_routes_here() as routes_here';
  const row = (n: number) => ({ id: `61000000-0000-4000-8000-${String(n).padStart(12, '0')}`, patient_id: patientId,
    facility_id: facilityId, ordering_facility_id: facilityId, source_ehr_order_id: orderId, source_ehr_order_version: '1',
    source_encounter_id: '70000000-0000-4000-8000-000000000001', status: 'accepted', priority: 'routine', accepted_by: accountId,
    accepted_at: new Date(Date.UTC(2026, 0, 1, 0, n)), row_version: '1', created_at: new Date(Date.UTC(2026, 0, 1, 0, n)),
    order_route_id: null, test_name: `Test ${n}`, accession_id: null, accession_number: null, specimen_statuses: null });
  const build = (rows: ReturnType<typeof row>[]) => {
    const statements: string[] = [];
    const client = { query: jest.fn(async (sql: string) => {
      statements.push(sql);
      if (sql === WORK_LIST_QUERY) return { rows };
      if (sql === RECEIVES) return { rows: [{ receives: null, routes_here: null }] };
      return { rows: [] };
    }) } as unknown as PoolClient;
    const database = { withTransaction: async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>) => fn(client),
      query: jest.fn(async () => ({ rows: [{ orders: false, work: false }] })) } as unknown as DatabaseService;
    const identity = { authorize: jest.fn() } as unknown as IdentityService;
    const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) };
    const service = new LabWorkItemsService(database, identity, audit as unknown as AuditService,
      new LabOrderRouteAccess(identity), new LabOrderRouteCards(database));
    return { service, statements, audit };
  };
  const reader = { ...context, actor: { ...context.actor, permissions: ['lab.work-item.read'] } };

  it('asks for open work oldest first, then done work newest first, 200 rows in all', () => {
    const order = WORK_LIST_QUERY.slice(WORK_LIST_QUERY.lastIndexOf('order by'));
    expect(order.replace(/\s+/g, ' ')).toBe('order by o.open_work desc,case when o.open_work then w.accepted_at end asc,'
      + 'case when o.open_work then null else w.accepted_at end desc, case when o.open_work then w.id end asc,'
      + 'case when o.open_work then null else w.id end desc limit 200');
    expect(WORK_LIST_QUERY).not.toMatch(/order by w\.accepted_at asc,w\.id asc/);
    // The open test is worked out once per work item, not copied into each sort key.
    expect(WORK_LIST_QUERY).toMatch(/cross join lateral \(select [\s\S]+ as open_work offset 0\) o/);
    expect(WORK_LIST_QUERY).toMatch(/group by w\.id,a\.id,a\.accession_number,o\.open_work/);
  });

  it('counts work as done only when every requested test has a released, current, valid result', () => {
    const open = WORK_LIST_QUERY.slice(WORK_LIST_QUERY.indexOf('cross join lateral'), WORK_LIST_QUERY.indexOf(' o\n'));
    // No requested test, or a requested test without such a result, is open work.
    expect(open).toContain('not exists(select 1 from lab.work_item_requested_tests t where t.work_item_id=w.id)');
    expect(open).toContain('or exists(select 1 from lab.work_item_requested_tests t where t.work_item_id=w.id and not exists(');
    // The result must be for that test, on this work item's specimens, released at its current version...
    expect(open).toContain('join lab.test_executions oe on oe.specimen_id=os.id and oe.requested_test_id=t.id');
    expect(open).toContain('where oa.work_item_id=w.id');
    expect(open).toContain('join lab.result_releases orel on orel.result_id=orr.id and orel.result_version=orr.current_version');
    // ...and not marked entered in error, so a corrected or withdrawn result brings the work back.
    expect(open).toContain('not exists(select 1 from lab.result_invalidations oi');
    expect(open).toContain('oi.result_version=orr.current_version');
  });

  it('answers what the query returns, in its order and shape: 250 items with 30 open answers all 30 first', async () => {
    // What Postgres answers for 250 work items of which 30 are open (indexes 0-9, 120-129, 240-249):
    // the 30 open oldest first, then the 170 newest done.
    const openRows = [...Array.from({ length: 10 }, (_, i) => i), ...Array.from({ length: 10 }, (_, i) => 120 + i),
      ...Array.from({ length: 10 }, (_, i) => 240 + i)].map(row);
    const doneRows = Array.from({ length: 250 }, (_, i) => i).filter((i) => !(i < 10 || (i >= 120 && i < 130) || i >= 240))
      .reverse().slice(0, 170).map(row);
    const { service, statements, audit } = build([...openRows, ...doneRows]);
    const answer = await service.list(reader);
    expect(answer.items).toHaveLength(200);
    expect(answer.items.slice(0, 30).map((item) => item.id)).toEqual(openRows.map((r) => r.id));
    expect(answer.items.slice(30).map((item) => item.id)).toEqual(doneRows.map((r) => r.id));
    // The newest open work (which the old query left out once 200 older rows existed) is answered.
    expect(answer.items.map((item) => item.id)).toContain(row(249).id);
    // One work-list read; the answer's shape is as before.
    expect(statements.filter((sql) => sql.includes('from lab.work_items w'))).toEqual([WORK_LIST_QUERY]);
    expect(Object.keys(answer.items[0]!)).toEqual(['id', 'patientId', 'facilityId', 'sourceEhrOrderVersion', 'status',
      'priority', 'acceptedAt', 'version', 'sourceEhrOrderId', 'testName', 'accessionId', 'accessionNumber', 'specimenStatuses']);
    expect(Object.keys(answer)).toEqual(['items', 'crossFacilityOrders', 'crossFacilityWork']);
    // Same-facility rows name no patient on the list, as before: no audit row.
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });
});
