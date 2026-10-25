import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { LabAccessionsService } from './lab-accessions.service';
import { LabWorkItemsService } from './lab-work-items.service';
import { LabOrderRouteAccess } from './order-route-access';
import { LabOrderRouteCards } from './order-route-cards';

// P4c (SPEC-FINAL §10.2): a route-backed work item is hidden from a member
// without consent once its route stops allowing the action (strict policy).
// The work-item routes then ask C11, which finds the item through its route,
// and answer why: work on routes paused (423) or the route closed (409);
// otherwise the item's own 404. Identity is not asked.
const facilityId = '10000000-0000-4000-8000-000000000001';
const workItemId = '60000000-0000-4000-8000-000000000001';
const context = { correlationId: 'hidden-correlation', facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
  purposeOfUse: 'direct-care', actor: { id: 'actor', subject: 'staff:lab', accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['lab'], permissions: ['lab.work-item.read', 'lab.accession.create'], facilityIds: [facilityId], facilities: [],
    authenticationMethod: 'local' } } satisfies DataAccessContext;

function harness(outcome: string) {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
    statements.push({ sql, values });
    if (sql.includes('lab.order_route_access_for')) {
      return { rows: [{ outcome, route_id: outcome === 'none' ? null : 'b0000000-0000-4000-8000-000000000001',
        work_item_id: outcome === 'none' ? null : workItemId }] };
    }
    return { rows: [] };
  }) };
  const database = { withTransaction: async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>) =>
    fn(client as unknown as PoolClient), query: jest.fn().mockRejectedValue(new Error('no pool here')) } as unknown as DatabaseService;
  const identity = { authorize: jest.fn() } as unknown as IdentityService & { authorize: jest.Mock };
  const audit = { recordWithClient: jest.fn() } as unknown as AuditService;
  const routeAccess = new LabOrderRouteAccess(identity);
  return { statements, identity, workItems: new LabWorkItemsService(database, identity, audit, routeAccess,
    new LabOrderRouteCards(database)), accessions: new LabAccessionsService(database, audit, routeAccess) };
}

const commands: Array<[string, 'read_records' | 'write_records', (h: ReturnType<typeof harness>) => Promise<unknown>]> = [
  ['GET work-items/:id', 'read_records', (h) => h.workItems.get(context, workItemId)],
  ['POST work-items/:id/accession', 'write_records', (h) => h.accessions.create(context, workItemId,
    { requirements: [{ specimenType: 'blood' }], reason: 'Hidden item accession' }, 'hidden-item-key-0001')],
];

describe.each(commands)('%s on a work item the session cannot see', (_name, action, run) => {
  it.each([
    ['paused', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE'],
    ['closed', 409, 'ORDER_ROUTE_CLOSED'],
    ['none', 404, 'LAB_WORK_ITEM_NOT_FOUND'],
    ['allowed', 404, 'LAB_WORK_ITEM_NOT_FOUND'],
  ])('C11 %s answers %s %s, and Identity is not asked', async (outcome, status, code) => {
    const h = harness(outcome);
    const error = await run(h).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainProblem);
    expect(error).toMatchObject({ code });
    expect((error as DomainProblem).getStatus()).toBe(status);
    const asked = h.statements.filter((statement) => statement.sql.includes('lab.order_route_access_for'));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.values).toEqual(['work_item', workItemId, action]);
    expect(h.identity.authorize).not.toHaveBeenCalled();
  });
});
