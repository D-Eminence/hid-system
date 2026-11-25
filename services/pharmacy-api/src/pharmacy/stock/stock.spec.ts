import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { REQUIRED_PERMISSIONS } from '../../common/decorators';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import { BILLING_MESSAGES } from './billing-errors';
import { PharmacyStockController } from './stock.controller';
import { AUDIT_REFUSAL_SQL, billingFields, PharmacyStockService, SOURCE_SQL, STOCK_FOR_CODES_SQL, SWITCHED_ON_SQL,
  WORK_ITEM_BILLS_SQL, workItemBilling } from './stock.service';

// Fictional identifiers only.
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const itemId = '123e4567-e89b-42d3-a456-426614174071';
const billId = '123e4567-e89b-42d3-a456-426614174051';
const key = 'stock-spec-key-0000001';
const PHARMACIST = ['pharmacy.stock.read', 'pharmacy.stock.manage', 'pharmacy.walk-in.create',
  'pharmacy.dispensing.create', 'billing.payment.record'];

function request(permissions: readonly string[] = PHARMACIST, purpose?: string) {
  const headers: Record<string, string | undefined> = { 'x-purpose-of-use': purpose, authorization: 'Bearer user' };
  return {
    correlationId: 'correlation-123456', facilityId, method: 'POST', header: (name: string) => headers[name.toLowerCase()],
    actor: { id: 'a', subject: 'staff:test', accountId: 'a', roles: ['pharmacist'], permissions,
      facility: { id: facilityId, membershipId, organizationId: facilityId, name: 'Test', roles: ['pharmacist'],
        permissions, isPrimary: true } },
  } as unknown as HidRequest;
}

function harness(answer: unknown | Error, switchedOn = true) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const contexts: DataAccessContext[] = [];
  const database = {
    withTransaction: jest.fn(async (context: DataAccessContext, operation: (client: unknown) => Promise<unknown>) => {
      contexts.push(context);
      return operation({ query: async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values });
        if (sql === SWITCHED_ON_SQL) return { rows: [{ switched_on: switchedOn }] };
        if (sql === AUDIT_REFUSAL_SQL || sql === SOURCE_SQL) return { rows: [{}] };
        if (answer instanceof Error) throw answer;
        return { rows: [{ answer }] };
      } });
    }),
  } as unknown as DatabaseService;
  return { calls, contexts, controller: new PharmacyStockController(new PharmacyStockService(database, false)) };
}

async function problemOf(attempt: () => unknown): Promise<DomainProblem> {
  try {
    await attempt();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainProblem);
    return error as DomainProblem;
  }
  throw new Error('expected a refusal');
}

describe('BILL-1 pharmacy point-of-care stock and counter sales (0166, 0167)', () => {
  it('serves the contract\'s paths with the codes checked by the service, never in "permission" words', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PharmacyStockController)).toBe('pharmacy');
    const routes: [keyof PharmacyStockController, string, RequestMethod][] = [
      ['list', 'stock', RequestMethod.GET], ['receive', 'stock/receipts', RequestMethod.POST],
      ['adjust', 'stock/adjustments', RequestMethod.POST],
      ['movements', 'stock/:catalogueItemId/movements', RequestMethod.GET],
      ['settings', 'stock/:catalogueItemId/settings', RequestMethod.PUT],
      ['counterSale', 'walk-in-orders', RequestMethod.POST], ['handOver', 'sales/:billId/hand-over', RequestMethod.POST],
    ];
    for (const [name, path, method] of routes) {
      const handler = PharmacyStockController.prototype[name];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toBeUndefined();
    }
    for (const [, message] of Object.values(BILLING_MESSAGES)) expect(message).not.toMatch(/permission/i);
  });

  it('answers 404 BILLING_NOT_AVAILABLE where billing is not switched on', async () => {
    const { controller, calls } = harness({}, false);
    const problem = await problemOf(() => controller.list(request(), {}));
    expect([problem.getStatus(), problem.code]).toEqual([404, 'BILLING_NOT_AVAILABLE']);
    expect(calls.map((call) => call.sql)).toEqual([SOURCE_SQL, SWITCHED_ON_SQL]);
  });

  it('refuses a member without the code, audits it, and never reaches the function', async () => {
    const { controller, calls } = harness({});
    const problem = await problemOf(() => controller.receive(request(['pharmacy.stock.read']), { lines: [] }, key));
    expect([problem.getStatus(), problem.code]).toEqual([403, 'BILLING_NOT_ALLOWED']);
    expect(calls).toEqual([{ sql: AUDIT_REFUSAL_SQL,
      values: ['pharmacy.stock.receipt', 'BILLING_NOT_ALLOWED', 'stock', null, 'pharmacy-api'] }]);
  });

  it('answers OUT_OF_STOCK with on hand, unit and expired on hand', async () => {
    const { controller } = harness(Object.assign(new Error('OUT_OF_STOCK'), { code: 'HB409',
      detail: '{"unit": "tablet", "onHand": 12, "expiredOnHand": 30}' }));
    const problem = await problemOf(() => controller.handOver(request(), billId, { expectedVersion: 4 }, key));
    expect([problem.getStatus(), problem.code, problem.message, problem.extensions]).toEqual([409, 'OUT_OF_STOCK',
      'Not enough in stock.', { unit: 'tablet', onHand: 12, expiredOnHand: 30 }]);
  });

  it('sells at the counter with the body less its purpose, and refuses a Health ID in the stock search', async () => {
    const { controller, calls, contexts } = harness({ workItemIds: [], bill: { id: billId } });
    await controller.counterSale(request(), { patient: { kind: 'anonymous' }, counter: true,
      items: [{ catalogueItemId: itemId, quantity: 2 }], purpose: 'healthcare-operations' }, key);
    const sale = calls.find((call) => call.sql.includes('counter_sale_create'));
    expect(sale?.values[0]).toEqual({ patient: { kind: 'anonymous' }, counter: true,
      items: [{ catalogueItemId: itemId, quantity: 2 }] });
    expect(contexts[0]?.purposeOfUse).toBe('healthcare-operations');
    const problem = await problemOf(() => controller.list(request(), { q: 'HID-ABCD22' }));
    expect(problem.code).toBe('BILLING_SEARCH_TEXT_NOT_ALLOWED');
    const filter = await problemOf(() => controller.list(request(), { filter: 'everything' }));
    expect(filter.code).toBe('VALIDATION_FAILED');
  });

  it('puts the stock settings with version 0 for a new item', async () => {
    const { controller, calls } = harness({ unit: 'tablet' });
    await controller.settings(request(), itemId, { unit: 'tablet', reorderLevel: 100 }, key);
    expect(calls.find((call) => call.sql.includes('stock_settings_put'))?.values.slice(0, 4))
      .toEqual([itemId, 'tablet', 100, 0]);
  });

  it('decorates own work items with their bill and stock, and with nothing when billing is not there', async () => {
    const queries: string[] = [];
    const client = { query: async (sql: string) => {
      queries.push(sql);
      if (sql === WORK_ITEM_BILLS_SQL) return { rows: [{ work_item_id: 'w1', bill: { billId, status: 'unpaid' } }] };
      if (sql === STOCK_FOR_CODES_SQL) return { rows: [{ answer: [{ codeSystem: 'HID-MED', code: 'MED-00042',
        onHand: 12, unit: 'capsule' }] }] };
      return { rows: [] };
    } };
    const found = await workItemBilling(client as never, [{ id: 'w1', medication_code_system: 'HID-MED',
      medication_code: 'MED-00042' }, { id: 'w2', medication_code_system: null, medication_code: null }]);
    expect(billingFields(found.get('w1'))).toEqual({ bill: { billId, status: 'unpaid' },
      stock: { onHand: 12, unit: 'capsule' } });
    expect(billingFields(found.get('w2'))).toEqual({});
    expect(queries.at(-1)).toBe('release savepoint work_item_billing');
    const failing = { query: async (sql: string) => {
      if (sql === WORK_ITEM_BILLS_SQL) throw Object.assign(new Error('missing'), { code: '42883' });
      return { rows: [] };
    } };
    expect((await workItemBilling(failing as never, [{ id: 'w1' }])).size).toBe(0);
  });
});
