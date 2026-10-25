import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { PharmacyOrderRouteAccess } from './order-route-access';
import { PharmacyOrderRouteCards } from './order-route-cards';
import { PharmacyService } from './pharmacy.service';

// P4c (SPEC-FINAL §10.2): a route-backed work item is hidden from a member
// without consent once its route stops allowing the action (strict policy).
// The work-item routes then ask C17, which finds the item through its route,
// and answer why: work on routes paused (423) or the route closed (409);
// otherwise the item's own 404. Identity is not asked.
const facilityId = '10000000-0000-4000-8000-000000000001';
const workItemId = '60000000-0000-4000-8000-000000000001';
const context = { correlationId: 'hidden-correlation', facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
  purposeOfUse: 'direct-care', actor: { id: 'actor', subject: 'staff:pharmacist', accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['pharmacist'], permissions: ['pharmacy.work-item.read', 'pharmacy.dispensing.create'], facilityIds: [facilityId],
    facilities: [], authenticationMethod: 'local' } } as unknown as DataAccessContext;

function harness(outcome: string) {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
    statements.push({ sql, values });
    if (sql.includes('pharmacy.order_route_access_for')) {
      return { rows: [{ outcome, route_id: outcome === 'none' ? null : 'b0000000-0000-4000-8000-000000000001',
        work_item_id: outcome === 'none' ? null : workItemId }] };
    }
    return { rows: [] };
  }) };
  const database = { withTransaction: async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>) =>
    fn(client as unknown as PoolClient), query: jest.fn().mockRejectedValue(new Error('no pool here')) };
  const identity = { authorize: jest.fn() };
  const service = new PharmacyService(database as never, identity as never, { recordWithClient: jest.fn() } as never,
    new PharmacyOrderRouteAccess(identity as never), new PharmacyOrderRouteCards(database as never));
  return { statements, identity, service };
}

const commands: Array<[string, 'read_records' | 'write_records', (h: ReturnType<typeof harness>) => Promise<unknown>]> = [
  ['GET work-items/:id', 'read_records', (h) => h.service.getWorkItem(context, workItemId)],
  ['POST work-items/:id/dispensings', 'write_records', (h) => h.service.dispense(context, workItemId,
    { expectedWorkItemVersion: 2, quantityDispensed: 30, quantityUnit: 'tablet', reason: 'Hidden item dispensing' },
    'hidden-item-key-0001')],
];

describe.each(commands)('%s on a work item the session cannot see', (_name, action, run) => {
  it.each([
    ['paused', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE'],
    ['closed', 409, 'ORDER_ROUTE_CLOSED'],
    ['none', 404, 'PHARMACY_WORK_ITEM_NOT_FOUND'],
    ['allowed', 404, 'PHARMACY_WORK_ITEM_NOT_FOUND'],
  ])('C17 %s answers %s %s, and Identity is not asked', async (outcome, status, code) => {
    const h = harness(outcome);
    const error = await run(h).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainProblem);
    expect(error).toMatchObject({ code });
    expect((error as DomainProblem).getStatus()).toBe(status);
    const asked = h.statements.filter((statement) => statement.sql.includes('pharmacy.order_route_access_for'));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.values).toEqual([workItemId, action]);
    expect(h.identity.authorize).not.toHaveBeenCalled();
  });
});
