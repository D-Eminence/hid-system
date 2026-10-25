import type { DataAccessContext } from '../../common/request-context';
import { OrderRouteReader } from './order-route-reader';
import { routeInForce, withOrderRoute, type OrderRouteSummary } from './order-route.mapping';

const patientId = '123e4567-e89b-42d3-a456-426614174001';
const orderA = '123e4567-e89b-42d3-a456-42661417000a';
const orderB = '123e4567-e89b-42d3-a456-42661417000b';
const routeId = '123e4567-e89b-42d3-a456-426614174008';
const context = (purposeOfUse: DataAccessContext['purposeOfUse']) =>
  ({ correlationId: 'correlation-123456', purposeOfUse }) as DataAccessContext;

const summary = { id: routeId, reference: '123E4567', kind: 'lab_request', version: 1, effectiveState: 'sent',
  receivingFacility: { id: orderB, name: 'Receiving Laboratory', available: true }, createdAt: '2026-10-25T09:00:00Z',
  respondBy: '2026-11-01T09:00:00Z', acceptedAt: null, completedAt: null, endedAt: null, endedKind: null,
  declineReason: null, acceptLocked: false, resendAllowed: false };

describe('OrderRouteReader', () => {
  const client = (answer: (sql: string) => unknown) => {
    const statements: string[] = [];
    return { statements, query: jest.fn(async (sql: string, _values?: unknown[]) => { statements.push(sql); return answer(sql); }) };
  };

  it('reads C4 for the listed orders in a savepoint of the caller\'s transaction, under direct care', async () => {
    const fake = client((sql) => (sql.includes('ehr.order_route_summaries')
      ? { rows: [{ order_id: orderA, summary }] } : { rows: [] }));
    const reader = new OrderRouteReader({} as never);
    const found = await reader.summaries(fake as never, context('direct-care'), 'lab_request', patientId, [orderA, orderB]);
    expect(fake.statements).toEqual(['savepoint order_route_summaries',
      'select order_id::text as order_id, summary from ehr.order_route_summaries($1, $2, $3::uuid[])',
      'release savepoint order_route_summaries']);
    expect(fake.query.mock.calls[1]?.[1]).toEqual(['lab_request', patientId, [orderA, orderB]]);
    expect(found?.get(orderA)).toMatchObject({ id: routeId, effectiveState: 'sent', receivingFacility: { available: true } });
    expect(found?.has(orderB)).toBe(false);
  });

  it('reads at most 200 orders per call (C4\'s limit)', async () => {
    const fake = client(() => ({ rows: [] }));
    const ids = Array.from({ length: 401 }, (_, index) => `123e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}`);
    await new OrderRouteReader({} as never).summaries(fake as never, context('direct-care'), 'prescription', patientId, ids);
    const batches = fake.query.mock.calls.filter(([sql]) => String(sql).includes('ehr.order_route_summaries'))
      .map(([, values]) => ((values as unknown[])[2] as unknown[]).length);
    expect(batches).toEqual([200, 200, 1]);
  });

  it.each(['emergency', 'healthcare-operations'] as const)('reads nothing under %s (V7): the answer has no orderRoute', async (purpose) => {
    const fake = client(() => ({ rows: [] }));
    const found = await new OrderRouteReader({} as never).summaries(fake as never, context(purpose), 'lab_request',
      patientId, [orderA]);
    expect(found).toBeUndefined();
    expect(fake.statements).toEqual([]);
    expect(withOrderRoute({ id: orderA }, found)).toEqual({ id: orderA });
  });

  it('rolls back to its savepoint and answers undefined when C4 fails, so the clinical read goes on', async () => {
    const fake = client((sql) => {
      if (sql.includes('ehr.order_route_summaries')) throw Object.assign(new Error('x'), { code: '42883' });
      return { rows: [] };
    });
    const found = await new OrderRouteReader({} as never).summaries(fake as never, context('direct-care'), 'lab_request',
      patientId, [orderA]);
    expect(found).toBeUndefined();
    expect(fake.statements.at(-1)).toBe('rollback to savepoint order_route_summaries');
  });

  it('answers an order with no route as null', async () => {
    const fake = client(() => ({ rows: [] }));
    await expect(new OrderRouteReader({} as never).summary(fake as never, context('direct-care'), 'lab_request', patientId,
      orderA)).resolves.toBeNull();
    expect(withOrderRoute({ id: orderA }, new Map())).toEqual({ id: orderA, orderRoute: null });
  });

  it('reads cross_facility_orders_enabled with a pool statement, never in a transaction, and closed when it fails', async () => {
    const database = { query: jest.fn().mockResolvedValue({ rows: [{ enabled: true }] }) };
    const reader = new OrderRouteReader(database as never);
    await expect(reader.crossFacilityOrdersEnabled()).resolves.toBe(true);
    expect(database.query).toHaveBeenCalledWith(`select platform.control_enabled('cross_facility_orders_enabled') as enabled`);
    database.query.mockResolvedValueOnce({ rows: [{ enabled: false }] });
    await expect(reader.crossFacilityOrdersEnabled()).resolves.toBe(false);
    database.query.mockRejectedValueOnce(Object.assign(new Error('unknown key'), { code: '22023' }));
    await expect(reader.crossFacilityOrdersEnabled()).resolves.toBe(false);
  });
});

describe('routeInForce (SPEC-FINAL §7.5)', () => {
  const at = (effectiveState: string, acceptedAt: string | null = null) =>
    ({ ...summary, effectiveState, acceptedAt }) as unknown as OrderRouteSummary;

  it.each(['sent', 'accepted', 'completed'])('holds the order while the route is %s', (state) => {
    expect(routeInForce(at(state, state === 'sent' ? null : '2026-10-25T10:00:00Z'))).toBe(true);
  });

  it('holds the order for good once any route was accepted (one work item per order, ever)', () => {
    expect(routeInForce(at('cancelled', '2026-10-25T10:00:00Z'))).toBe(true);
    expect(routeInForce(at('expired', '2026-10-25T10:00:00Z'))).toBe(true);
  });

  it.each(['declined', 'withdrawn', 'expired'])('releases the order when an unaccepted route is %s', (state) => {
    expect(routeInForce(at(state))).toBe(false);
  });

  it('releases it when there is no route, or routes could not be read', () => {
    expect(routeInForce(null)).toBe(false);
    expect(routeInForce(undefined)).toBe(false);
  });
});
