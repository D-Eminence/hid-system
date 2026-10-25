import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { LabAccessionsService } from './lab-accessions.service';
import { LabExecutionsService } from './lab-executions.service';
import { LabWorkItemsService } from './lab-work-items.service';
import { LabOrderRouteAccess } from './order-route-access';
import { LabOrderRouteCards } from './order-route-cards';

// P4c (SPEC-FINAL §4.3, §9.2, §14.1, PRIV P12): every per-item Lab route
// authorizes the resource it acts on through C11, which derives the work item
// in the database. A route-backed resource is worked on the route's basis and
// Identity is not asked; any other resource is Identity's consent decision as
// before, so a receiving member with a live route for patient P is refused on
// P's other rows at this facility.
const facilityId = '10000000-0000-4000-8000-000000000001';
const patientId = '50000000-0000-4000-8000-000000000001';
const workItemId = '60000000-0000-4000-8000-000000000001';
const accessionId = '70000000-0000-4000-8000-000000000001';
const specimenId = '80000000-0000-4000-8000-000000000001';
const executionId = '90000000-0000-4000-8000-000000000001';
const resultId = 'a0000000-0000-4000-8000-000000000001';
const routeId = 'b0000000-0000-4000-8000-000000000001';
const permissions = ['lab.work-item.read', 'lab.accession.create', 'lab.accession.read', 'lab.specimen.collect',
  'lab.specimen.receive', 'lab.specimen.reject', 'lab.execution.start', 'lab.execution.read', 'lab.execution.complete',
  'lab.result.enter', 'lab.result.correct', 'lab.result.verify', 'lab.result.release', 'lab.result.released.read',
  'lab.order-route.receive'];
const context = { correlationId: 'route-access-correlation', facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
  purposeOfUse: 'direct-care', actor: { id: 'actor', subject: 'staff:lab', accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['lab'], permissions, facilityIds: [facilityId], facilities: [], authenticationMethod: 'local' } } satisfies DataAccessContext;

const executionRow = { id: executionId, accession_id: accessionId, specimen_id: specimenId, requested_test_id: workItemId,
  patient_id: patientId, facility_id: facilityId, status: 'completed', method: null, started_at: new Date(), completed_at: new Date(),
  row_version: '2', idempotency_key: 'k', request_sha256: 'x', completed_idempotency_key: null, completed_request_sha256: null,
  test_name: 'Hemoglobin', test_code: '718-7', test_code_system: 'loinc' };

/** The rows each command reads before it authorizes, and C11's answer. */
function harness(access: { outcome: string; route_id: string | null; work_item_id?: string | null },
  decision = { allowed: false, breakGlass: false }) {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
    statements.push({ sql, values });
    if (sql.includes('lab.order_route_access_for')) return { rows: [{ work_item_id: workItemId, ...access }] };
    if (sql.includes('from lab.work_items')) return { rows: [{ id: workItemId, patient_id: patientId, facility_id: facilityId,
      ordering_facility_id: facilityId, source_ehr_order_id: routeId, source_ehr_order_version: '1', source_encounter_id: routeId,
      status: 'accepted', priority: 'routine', accepted_by: 'a', accepted_at: new Date(), row_version: '1', created_at: new Date(),
      test_code_system: 'loinc', test_code: '718-7', test_name: 'Hemoglobin', order_route_id: null }] };
    if (sql.includes('from lab.accessions where id=$1')) return { rows: [{ id: accessionId, accession_number: 'LAB-1',
      work_item_id: workItemId, patient_id: patientId, facility_id: facilityId, status: 'accessioned', priority: 'routine',
      row_version: '1', created_at: new Date(), request_sha256: 'x' }] };
    if (sql.includes('from lab.specimens s join lab.accessions a')) return { rows: [{ id: specimenId, accession_id: accessionId,
      patient_id: patientId, facility_id: facilityId, status: 'received', row_version: '3', work_item_id: workItemId }] };
    if (sql.includes('from lab.specimens')) return { rows: [{ id: specimenId, specimen_identifier: 'S', requirement_id: routeId,
      accession_id: accessionId, patient_id: patientId, facility_id: facilityId, specimen_type: 'blood', container_type: null,
      status: 'required', collected_at: null, received_at: null, rejected_at: null, rejection_reason: null, row_version: '1' }] };
    if (sql.includes('from lab.test_executions e')) return { rows: [executionRow] };
    if (sql.includes('from lab.results where id=$1')) return { rows: [{ id: resultId, execution_id: executionId,
      patient_id: patientId, facility_id: facilityId, current_version: '1' }] };
    return { rows: [] };
  }) };
  const database = { withTransaction: async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>) =>
    fn(client as unknown as PoolClient), query: jest.fn().mockRejectedValue(new Error('no pool here')) } as unknown as DatabaseService;
  const identity = { authorize: jest.fn().mockResolvedValue(decision) } as unknown as IdentityService & { authorize: jest.Mock };
  const audits: Array<Record<string, unknown>> = [];
  const audit = { recordWithClient: jest.fn(async (_c: unknown, event: Record<string, unknown>) => { audits.push(event); }) } as
    unknown as AuditService;
  const routeAccess = new LabOrderRouteAccess(identity);
  const workItems = new LabWorkItemsService(database, identity, audit, routeAccess, new LabOrderRouteCards(database));
  const accessions = new LabAccessionsService(database, audit, routeAccess);
  const executions = new LabExecutionsService(database, audit, routeAccess);
  return { statements, identity, audits, workItems, accessions, executions };
}

type Harness = ReturnType<typeof harness>;
const key = 'route-access-key-0001';
const at = '2026-10-25T10:00:00Z';
/** Every per-item route of SPEC-FINAL §9.2, the resource it passes to C11, and the action. */
const ROUTES: Array<[string, string, string, 'read_records' | 'write_records', (h: Harness) => Promise<unknown>]> = [
  ['GET work-items/:id', 'work_item', workItemId, 'read_records', (h) => h.workItems.get(context, workItemId)],
  ['POST work-items/:id/accession', 'work_item', workItemId, 'write_records', (h) => h.accessions.create(context, workItemId,
    { requirements: [{ specimenType: 'blood' }], reason: 'Accession' }, key)],
  ['GET accessions/:id', 'accession', accessionId, 'read_records', (h) => h.accessions.get(context, accessionId)],
  ['GET accessions/:id/specimens', 'accession', accessionId, 'read_records', (h) => h.accessions.listSpecimens(context, accessionId)],
  ['POST specimens/:id/collect', 'specimen', specimenId, 'write_records', (h) => h.accessions.collect(context, accessionId,
    specimenId, { expectedVersion: 1, collectedAt: at }, key)],
  ['POST specimens/:id/receive', 'specimen', specimenId, 'write_records', (h) => h.accessions.receive(context, accessionId,
    specimenId, { expectedVersion: 1, receivedAt: at }, key)],
  ['POST specimens/:id/reject', 'specimen', specimenId, 'write_records', (h) => h.accessions.reject(context, accessionId,
    specimenId, { expectedVersion: 1, reason: 'Haemolysed' }, key)],
  ['POST specimens/:id/executions', 'specimen', specimenId, 'write_records', (h) => h.executions.start(context, specimenId,
    { expectedSpecimenVersion: 3, startedAt: at, reason: 'Start' }, key)],
  ['GET specimens/:id/executions', 'specimen', specimenId, 'read_records', (h) => h.executions.listForSpecimen(context, specimenId)],
  ['GET executions/:id', 'execution', executionId, 'read_records', (h) => h.executions.get(context, executionId)],
  ['POST executions/:id/complete', 'execution', executionId, 'write_records', (h) => h.executions.complete(context, executionId,
    { expectedVersion: 1, completedAt: at }, key)],
  ['POST executions/:id/results', 'execution', executionId, 'write_records', (h) => h.executions.enterResult(context, executionId,
    { expectedExecutionVersion: 2, resultType: 'numeric', numericValue: 13 }, key)],
  ['POST executions/:id/results/:resultId/corrections', 'execution', executionId, 'write_records', (h) =>
    h.executions.correctResult(context, executionId, resultId, { expectedExecutionVersion: 2, resultType: 'numeric',
      numericValue: 12, expectedResultVersion: 1, reason: 'Recalibrated' }, key)],
  ['POST results/:id/verify', 'result', resultId, 'write_records', (h) => h.executions.verifyResult(context, resultId,
    { expectedResultVersion: 1, occurredAt: at, reason: 'Verified' }, key)],
  ['POST results/:id/release', 'result', resultId, 'write_records', (h) => h.executions.releaseResult(context, resultId,
    { expectedResultVersion: 1, occurredAt: at, reason: 'Released' }, key)],
  ['GET results/:id/history', 'result', resultId, 'read_records', (h) => h.executions.getResultHistory(context, resultId)],
  ['GET ehr-orders/:id/released-results', 'work_item', workItemId, 'read_records', (h) =>
    h.executions.listReleasedForEhrOrder(context, routeId)],
];

describe('Lab per-item routes authorize the resource they act on (P12)', () => {
  it.each(ROUTES)('%s asks C11 about its %s and, with no route and no consent, answers 403 (a non-route row of P)',
    async (_name, resource, resourceId, action, call) => {
      const h = harness({ outcome: 'none', route_id: null });
      await expect(call(h)).rejects.toMatchObject({ status: 403 });
      const asked = h.statements.filter((s) => s.sql.includes('lab.order_route_access_for'));
      expect(asked.map((s) => s.values)).toEqual([[resource, resourceId, action]]);
      expect(h.identity.authorize).toHaveBeenCalledWith(patientId, action, 'direct-care', context);
      expect(h.audits).toEqual([]);
    });

  it.each(ROUTES)('%s answers a closed route 409 ORDER_ROUTE_CLOSED without asking Identity', async (...[, , , , call]) => {
    const h = harness({ outcome: 'closed', route_id: routeId });
    await expect(call(h)).rejects.toMatchObject({ status: 409, code: 'ORDER_ROUTE_CLOSED' });
    expect(h.identity.authorize).not.toHaveBeenCalled();
    expect(h.audits).toEqual([]);
  });

  it.each(ROUTES)('%s answers paused route access 423 CROSS_FACILITY_ORDERS_UNAVAILABLE without asking Identity',
    async (...[, , , , call]) => {
      const h = harness({ outcome: 'paused', route_id: routeId });
      await expect(call(h)).rejects.toMatchObject({ status: 423, code: 'CROSS_FACILITY_ORDERS_UNAVAILABLE' });
      expect(h.identity.authorize).not.toHaveBeenCalled();
    });

  it.each(ROUTES)('%s refuses an unknown C11 outcome with 503, never proceeding', async (...[, , , , call]) => {
    const h = harness({ outcome: 'maybe', route_id: routeId });
    await expect(call(h)).rejects.toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
    expect(h.identity.authorize).not.toHaveBeenCalled();
  });

  it('works an allowed route-backed work item without Identity, on the route\'s basis in the audit row', async () => {
    const h = harness({ outcome: 'allowed', route_id: routeId });
    await expect(h.workItems.get(context, workItemId)).resolves.toMatchObject({ id: workItemId });
    expect(h.identity.authorize).not.toHaveBeenCalled();
    expect(h.audits).toEqual([expect.objectContaining({ action: 'lab.work-item.read', patientId,
      details: { basis: 'order-route', orderRouteId: routeId } })]);
  });

  it('reads an allowed route-backed accession without Identity, and its audit row says so', async () => {
    const h = harness({ outcome: 'allowed', route_id: routeId });
    await expect(h.accessions.get(context, accessionId)).resolves.toMatchObject({ id: accessionId });
    expect(h.identity.authorize).not.toHaveBeenCalled();
    expect(h.audits).toEqual([expect.objectContaining({ action: 'lab.accession.read',
      details: { basis: 'order-route', orderRouteId: routeId } })]);
  });

  it('keeps a consent-based audit row as it was (no basis)', async () => {
    const h = harness({ outcome: 'none', route_id: null }, { allowed: true, breakGlass: false });
    await h.accessions.get(context, accessionId);
    expect(h.identity.authorize).toHaveBeenCalledTimes(1);
    // Stored as {} either way (AuditService writes details ?? {}): no basis, no route id.
    expect(h.audits[0]?.details ?? {}).toEqual({});
  });

  it('refuses a break-glass write on a non-route row, as before', async () => {
    const h = harness({ outcome: 'none', route_id: null }, { allowed: true, breakGlass: true });
    await expect(h.executions.complete(context, executionId, { expectedVersion: 1, completedAt: at }, key))
      .rejects.toMatchObject({ status: 403, code: 'LAB_EXECUTION_ACCESS_DENIED' });
  });
});

describe('Lab release on a closed route (the return trigger, SPEC-FINAL §6)', () => {
  it.each([
    ['ORDER_ROUTE_CLOSED', { status: 409, code: 'ORDER_ROUTE_CLOSED' }],
    ['new row for relation "result_releases" violates check constraint', { code: '23514' }],
  ])('answers the release insert\'s 23514 %s as %o', async (message, expected) => {
    const client = { query: jest.fn(async (sql: string) => {
      if (sql.includes('lab.order_route_access_for')) return { rows: [{ outcome: 'allowed', route_id: routeId, work_item_id: workItemId }] };
      if (sql.includes('from lab.results where id=$1 for update')) return { rows: [{ id: resultId, execution_id: executionId,
        patient_id: patientId, facility_id: facilityId, current_version: '1' }] };
      if (sql.includes('from lab.result_verifications where result_id')) return { rows: [{ id: routeId }] };
      if (sql.includes('insert into lab.result_releases')) throw Object.assign(new Error(message), { code: '23514' });
      return { rows: [] };
    }) };
    const database = { withTransaction: async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>) =>
      fn(client as unknown as PoolClient) } as unknown as DatabaseService;
    const identity = { authorize: jest.fn() } as unknown as IdentityService;
    const audit = { recordWithClient: jest.fn() } as unknown as AuditService;
    const service = new LabExecutionsService(database, audit, new LabOrderRouteAccess(identity));
    await expect(service.releaseResult(context, resultId, { expectedResultVersion: 1, occurredAt: at, reason: 'Released' }, key))
      .rejects.toMatchObject(expected);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });
});
