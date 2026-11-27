import { ValidationPipe } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { AcceptEhrOrderDto } from './dto/accept-ehr-order.dto';
import { LabWorkItemsService, WORK_LIST_QUERY } from './lab-work-items.service';
import type { AcceptEhrLabOrderCommand } from './lab-work-items.types';
import { LabOrderRouteAccess } from './order-route-access';
import { LabOrderRouteCards } from './order-route-cards';

/*
 * ORD-6 (0158): several tests in one lab request. lab-api only reads the
 * group (Rahman's form of decision 4): lab.validate_work_item copies it from
 * the EHR row into Lab's own work item, so the acceptance takes no group from
 * its caller and names none. Lab answers it as `requestGroupId` on its own
 * work items (get, list, the acceptance answer and its replay), so the board
 * can show a group's tests together; never on a routed one. Fictional data.
 */
const facilityId = '10000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-000000000001';
const orderId = '30000000-0000-4000-8000-000000000001';
const patientId = '50000000-0000-4000-8000-000000000001';
const workItemId = '60000000-0000-4000-8000-000000000001';
const groupId = '80000000-0000-4000-8000-000000000001';
const routeId = 'b0000000-0000-4000-8000-000000000001';
const context = { correlationId: 'request-group-correlation', facilityId,
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care', actor: { id: 'actor',
    subject: 'staff:lab', accountId, roles: ['lab'], permissions: ['lab.work-item.accept', 'lab.work-item.read'],
    facilityIds: [facilityId], facilities: [], authenticationMethod: 'local' } } satisfies DataAccessContext;
const command: AcceptEhrLabOrderCommand = { sourceEhrOrderId: orderId, sourceEhrOrderVersion: 1,
  sourceEncounterId: '70000000-0000-4000-8000-000000000001', patientId, orderingFacilityId: facilityId,
  testCodeSystem: 'LOINC', testCode: '58410-2', testName: 'Full blood count', priority: 'routine',
  clinicalIndication: 'Fever for 3 days', requestedBy: accountId, requestedAt: '2026-12-01T09:00:00.123456Z' };
/** Lab's own work item as the database holds it: the group the validator copied, or null. */
const row = (fields: Record<string, unknown> = {}) => ({ id: workItemId, patient_id: patientId, facility_id: facilityId,
  ordering_facility_id: facilityId, source_ehr_order_id: orderId, source_ehr_order_version: '1',
  source_encounter_id: '70000000-0000-4000-8000-000000000001', status: 'accepted', priority: 'routine',
  accepted_by: accountId, accepted_at: new Date('2026-12-01T09:00:01Z'), row_version: '1',
  created_at: new Date('2026-12-01T09:00:01Z'), order_route_id: null, request_group_id: groupId,
  clinical_indication: 'Fever for 3 days', test_name: 'Full blood count', accession_id: null, accession_number: null,
  open_work: true, specimen_statuses: null, ...fields });

/**
 * A fake database: `stored` answers the replay read and the get; the insert
 * returns `inserted` (`returning *`), or fails with `insertError`.
 */
const harness = (stored: ReturnType<typeof row>[], inserted = row(), listed: ReturnType<typeof row>[] = [],
  insertError?: Error) => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql === WORK_LIST_QUERY) return { rows: listed };
    if (sql.includes('lab.order_route_access_for')) return { rows: [{ work_item_id: workItemId, outcome: 'none',
      route_id: null }] };
    if (/insert into lab\.work_items\b/.test(sql)) {
      if (insertError) throw insertError;
      return { rows: [inserted] };
    }
    if (/^\s*select\b/i.test(sql) && /from lab\.work_items\b/.test(sql)) return { rows: stored };
    return { rows: [], rowCount: 1 };
  }) } as unknown as PoolClient;
  const database = { withTransaction: async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>) => fn(client),
    query: jest.fn(async () => ({ rows: [{ orders: false, work: false }] })) } as unknown as DatabaseService;
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: false }) } as unknown as IdentityService;
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return { statements, service: new LabWorkItemsService(database, identity, audit, new LabOrderRouteAccess(identity),
    new LabOrderRouteCards(database)) };
};
const flat = (sql: string) => sql.replace(/\s+/g, ' ');

describe('ORD-6 in Lab: the acceptance is unchanged and names no group', () => {
  // lab-api's global validation pipe (main.ts).
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false });

  it('AcceptEhrOrderDto takes no group: a caller\'s requestGroupId is refused (400)', async () => {
    await expect(pipe.transform({ ...command, requestGroupId: groupId }, { type: 'body', metatype: AcceptEhrOrderDto }))
      .rejects.toMatchObject({ status: 400 });
    await expect(pipe.transform({ ...command }, { type: 'body', metatype: AcceptEhrOrderDto })).resolves.toBeDefined();
  });

  it('the insert names no group, and the answer carries the one the validator copied', async () => {
    const { statements, service } = harness([]);
    const answer = await service.acceptEhrOrder(context, command);
    const insert = statements.find(({ sql }) => /insert into lab\.work_items\b/.test(sql));
    expect(insert?.sql).not.toMatch(/request_group_id/);
    expect(insert?.sql).toMatch(/returning \*/);
    expect(answer).toMatchObject({ id: workItemId, sourceEhrOrderId: orderId, requestGroupId: groupId });
    // The outbox event and the requested test carry no group.
    for (const { sql, values } of statements.filter(({ sql: text }) => /insert into lab\.(outbox_events|work_item_requested_tests)/
      .test(text))) {
      expect(sql).not.toMatch(/request_group_id/);
      expect(JSON.stringify(values)).not.toContain(groupId);
    }
  });

  it('a request ordered on its own answers requestGroupId null', async () => {
    const { service } = harness([], row({ request_group_id: null }));
    await expect(service.acceptEhrOrder(context, command)).resolves.toMatchObject({ requestGroupId: null });
  });

  it('a replay reads the group with the work item and answers it', async () => {
    const stored = { ...row(), request_sha256: requestDigest('lab.work-item.accept-ehr-order', command) };
    const { statements, service } = harness([stored]);
    await expect(service.acceptEhrOrder(context, command)).resolves.toMatchObject({ id: workItemId, requestGroupId: groupId });
    const replay = statements.find(({ sql }) => /from lab\.work_items where \(facility_id=\$1/.test(flat(sql)));
    expect(flat(replay?.sql ?? '')).toMatch(/,created_at,request_group_id::text,request_sha256 from lab\.work_items/);
    expect(statements.some(({ sql }) => /insert into lab\./.test(sql))).toBe(false);
  });

  it('0158\'s LAB_REQUEST_GROUP_MISMATCH (only a direct insert can meet it) is answered as any 23514: no new code', async () => {
    const mismatch = Object.assign(new Error('LAB_REQUEST_GROUP_MISMATCH'), { code: '23514' });
    const { service } = harness([], row(), [], mismatch);
    const problem = await service.acceptEhrOrder(context, command).catch((error: unknown) => error);
    expect(problem).toMatchObject({ status: 409, code: 'LAB_ORDER_NOT_CURRENT' });
    expect((problem as { cause?: unknown }).cause).toBe(mismatch);
    expect((problem as Error).message).not.toMatch(/GROUP/);
  });
});

describe('ORD-6 in Lab: own work items answer their group; a routed one never does', () => {
  const reader = { ...context, actor: { ...context.actor, permissions: ['lab.work-item.read'] } };

  it('the work item read selects the group and answers it', async () => {
    const { statements, service } = harness([row()]);
    await expect(service.get(reader, workItemId)).resolves.toMatchObject({ id: workItemId, requestGroupId: groupId });
    expect(flat(statements.find(({ sql }) => /from lab\.work_items where id=\$1/.test(sql))?.sql ?? ''))
      .toMatch(/,order_route_id::text, request_group_id::text,clinical_indication from lab\.work_items where id=\$1$/);
    const alone = harness([row({ request_group_id: null })]);
    await expect(alone.service.get(reader, workItemId)).resolves.toMatchObject({ requestGroupId: null });
  });

  it('the list chooses its 200 rows with the column and answers it on own rows, never on routed ones', async () => {
    const query = flat(WORK_LIST_QUERY);
    const cut = query.indexOf(' limit 200)');
    expect(query.slice(0, cut)).toMatch(/select w\.id,.*,w\.order_route_id,w\.request_group_id,w\.test_name,/);
    expect(query.slice(cut)).toMatch(/^ limit 200\) select .*,w\.order_route_id::text, w\.request_group_id::text,w\.test_name,/);
    expect(query).toMatch(/ group by w\.id,.*,w\.order_route_id,w\.request_group_id,w\.test_name,/);
    // Still one read of the work items.
    expect(query.match(/\blab\.work_items\b/g)).toHaveLength(1);
    const own = row();
    const second = row({ id: '60000000-0000-4000-8000-000000000002', source_ehr_order_id: '30000000-0000-4000-8000-000000000002' });
    const alone = row({ id: '60000000-0000-4000-8000-000000000003', source_ehr_order_id: '30000000-0000-4000-8000-000000000003',
      request_group_id: null });
    // A routed row never holds a group (0158's validator); were one read, it is still not answered.
    const routed = row({ id: '60000000-0000-4000-8000-000000000004', order_route_id: routeId, ordering_facility_id: routeId });
    const { service } = harness([], row(), [own, second, alone, routed]);
    const page = await service.list(reader);
    expect(page.items.map((item) => [item.id, (item as { requestGroupId?: unknown }).requestGroupId]))
      .toEqual([[own.id, groupId], [second.id, groupId], [alone.id, null], [routed.id, undefined]]);
    expect(page.items[3]).not.toHaveProperty('requestGroupId');
    expect(page.items[3]).not.toHaveProperty('sourceEhrOrderId');
  });
});
