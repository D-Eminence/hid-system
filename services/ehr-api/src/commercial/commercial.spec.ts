import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { createHmac } from 'node:crypto';
import { PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { BILLING_MESSAGES, classifyBillingError, searchTextRefused } from './commercial-errors';
import { CommercialController } from './commercial.controller';
import { AUDIT_REFUSAL_SQL, CommercialService, SWITCHED_ON_SQL, type CommercialSwitches } from './commercial.service';
import { noPaystackSecrets, OnlinePaymentService, paystackSignatureValid } from './online-payment.service';

// Fictional identifiers only.
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const billId = '123e4567-e89b-42d3-a456-426614174051';
const paymentId = '123e4567-e89b-42d3-a456-426614174061';
const key = 'billing-spec-key-000001';

const CASHIER = ['billing.catalogue.read', 'billing.bill.read', 'billing.bill.create', 'billing.payment.record',
  'billing.shift.own'];

function request(permissions: readonly string[] = CASHIER, purpose: string | undefined = 'healthcare-operations') {
  const headers: Record<string, string | undefined> = { 'x-purpose-of-use': purpose };
  return {
    correlationId: 'correlation-123456', facilityId, method: 'POST',
    header: (name: string) => headers[name.toLowerCase()],
    actor: { id: 'a', subject: 'staff:test', accountId: 'a', authenticationMethod: 'local', roles: ['cashier'],
      permissions, facilityIds: [facilityId], facilities: [],
      facility: { id: facilityId, membershipId, organizationId: facilityId, name: 'Test', roles: ['cashier'],
        permissions, isPrimary: true } },
  } as unknown as HidRequest;
}

interface Call { sql: string; values: unknown[] }
function fakeDatabase(answer: unknown | Error, switchedOn = true) {
  const calls: Call[] = [];
  const contexts: DataAccessContext[] = [];
  const database = {
    withTransaction: jest.fn(async (context: DataAccessContext, operation: (client: unknown) => Promise<unknown>) => {
      contexts.push(context);
      return operation({
        query: async (sql: string, values: unknown[] = []) => {
          calls.push({ sql, values });
          if (sql === SWITCHED_ON_SQL) return { rows: [{ switched_on: switchedOn }] };
          if (sql === AUDIT_REFUSAL_SQL) return { rows: [{}] };
          if (answer instanceof Error) throw answer;
          return { rows: [{ answer }] };
        },
      });
    }),
  } as unknown as DatabaseService;
  return { database, calls, contexts };
}

const switches: CommercialSwitches = { billingEnabled: false, payBeforeAvailable: false, onlineAvailable: false };
function controller(answer: unknown | Error, switchedOn = true, given: CommercialSwitches = switches) {
  const fake = fakeDatabase(answer, switchedOn);
  const service = new CommercialService(fake.database, given);
  const online = new OnlinePaymentService(service, fake.database, noPaystackSecrets,
    jest.fn() as never);
  return { ...fake, controller: new CommercialController(service, online), service };
}

function databaseError(code: string, message: string, detail?: string) {
  return Object.assign(new Error(message), { code, detail });
}

async function problemOf(promise: Promise<unknown> | (() => unknown)): Promise<DomainProblem> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainProblem);
    return error as DomainProblem;
  }
  throw new Error('expected a refusal');
}

describe('BILL-1 patient billing (0162-0167)', () => {
  describe('routes', () => {
    it('lives at commercial with the contract\'s paths, and never answers in "permission" words', () => {
      expect(Reflect.getMetadata(PATH_METADATA, CommercialController)).toBe('commercial');
      const routes: [keyof CommercialController, string, RequestMethod][] = [
        ['settings', 'payment-settings', RequestMethod.GET],
        ['putSettings', 'payment-settings', RequestMethod.PUT],
        ['catalogue', 'catalogue-items', RequestMethod.GET],
        ['unpriced', 'catalogue-items/unpriced-codes', RequestMethod.GET],
        ['createItem', 'catalogue-items', RequestMethod.POST],
        ['updateItem', 'catalogue-items/:itemId', RequestMethod.PATCH],
        ['bills', 'bills', RequestMethod.GET],
        ['summary', 'bills/summary', RequestMethod.GET],
        ['createBill', 'bills', RequestMethod.POST],
        ['bill', 'bills/:billId', RequestMethod.GET],
        ['addLine', 'bills/:billId/lines', RequestMethod.POST],
        ['cancelLine', 'bills/:billId/lines/:lineId/cancel', RequestMethod.POST],
        ['pay', 'bills/:billId/payments', RequestMethod.POST],
        ['confirm', 'bills/:billId/payments/:paymentId/confirm', RequestMethod.POST],
        ['voidPayment', 'bills/:billId/payments/:paymentId/void', RequestMethod.POST],
        ['cancelCover', 'bills/:billId/hmo-covers/:coverId/cancel', RequestMethod.POST],
        ['defer', 'bills/:billId/defer', RequestMethod.POST],
        ['attach', 'bills/:billId/patient', RequestMethod.POST],
        ['voidBill', 'bills/:billId/void', RequestMethod.POST],
        ['receipt', 'bills/:billId/receipt', RequestMethod.GET],
        ['onlineLink', 'bills/:billId/online-payment-links', RequestMethod.POST],
        ['webhook', 'paystack/webhook', RequestMethod.POST],
        ['outstanding', 'outstanding', RequestMethod.GET],
        ['receivables', 'hmo-receivables', RequestMethod.GET],
        ['current', 'shifts/current', RequestMethod.GET],
        ['days', 'shifts', RequestMethod.GET],
        ['openDay', 'shifts', RequestMethod.POST],
        ['closeDay', 'shifts/:shiftId/close', RequestMethod.POST],
      ];
      for (const [name, path, method] of routes) {
        const handler = CommercialController.prototype[name];
        expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
        expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
        // The guard's own refusal says "permission"; billing checks its codes itself (BILLING_NOT_ALLOWED).
        expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toBeUndefined();
      }
      expect(Reflect.getMetadata(PUBLIC_ROUTE, CommercialController.prototype.webhook)).toBe(true);
      for (const [, message] of Object.values(BILLING_MESSAGES)) expect(message).not.toMatch(/permission/i);
    });
  });

  describe('the service', () => {
    it('answers 404 BILLING_NOT_AVAILABLE where billing is not switched on, and audits nothing', async () => {
      const { controller: routes, calls } = controller({}, false);
      const problem = await problemOf(routes.bill(request(), billId));
      expect([problem.getStatus(), problem.code]).toEqual([404, 'BILLING_NOT_AVAILABLE']);
      expect(calls.map((call) => call.sql)).toEqual([SWITCHED_ON_SQL]);
      expect(calls[0]?.values).toEqual([false]);
    });

    it('refuses a member without the code before the database, in plain words, and audits the refusal', async () => {
      const { controller: routes, calls } = controller({});
      const problem = await problemOf(routes.voidPayment(request(), billId, paymentId,
        { reason: 'Refund: wrong amount', expectedVersion: 3 }, key));
      expect([problem.getStatus(), problem.code, problem.message]).toEqual([403, 'BILLING_NOT_ALLOWED',
        'Your role here does not include this. Ask a billing officer or administrator.']);
      expect(calls).toEqual([{ sql: AUDIT_REFUSAL_SQL,
        values: ['commercial.payment.void', 'BILLING_NOT_ALLOWED', 'payment', paymentId, 'ehr-api'] }]);
    });

    it('records a payment with the body less expectedVersion and purpose, the key and the request digest', async () => {
      const { controller: routes, calls, contexts } = controller({ id: billId, dueKobo: 0 });
      const answer = await routes.pay(request(), billId, { method: 'pos', amountKobo: 150000,
        reference: '123456789012', expectedVersion: 5, purpose: 'healthcare-operations' }, key);
      expect(answer).toEqual({ id: billId, dueKobo: 0 });
      const call = calls.find((entry) => entry.sql.includes('payment_record'));
      expect(call?.values.slice(0, 4)).toEqual([billId, { method: 'pos', amountKobo: 150000,
        reference: '123456789012' }, 5, key]);
      expect(call?.values[4]).toMatch(/^[0-9a-f]{64}$/);
      expect(contexts[0]?.purposeOfUse).toBe('healthcare-operations');
    });

    it('turns the functions\' refusals into the contract\'s answers, with OUT_OF_STOCK\'s fields', async () => {
      const overpay = await problemOf(controller(databaseError('HB409', 'OVERPAYMENT')).controller
        .pay(request(), billId, { method: 'cash', amountKobo: 10 }, key));
      expect([overpay.getStatus(), overpay.code, overpay.message]).toEqual([409, 'OVERPAYMENT',
        'That is more than is due. Enter the amount due or less.']);
      const stock = classifyBillingError(databaseError('HB409', 'OUT_OF_STOCK',
        '{"onHand": 12, "unit": "tablet", "expiredOnHand": 30}'));
      expect([stock.problem.getStatus(), stock.problem.code, stock.problem.extensions]).toEqual([409, 'OUT_OF_STOCK',
        { onHand: 12, unit: 'tablet', expiredOnHand: 30 }]);
      const stale = classifyBillingError(databaseError('HB412', 'VERSION_CONFLICT'));
      expect([stale.problem.getStatus(), stale.problem.code]).toEqual([412, 'VERSION_CONFLICT']);
    });

    it('answers 503 BILLING_UNAVAILABLE on a schema without 0162-0167 and logs the SQLSTATE only', async () => {
      const { controller: routes, calls } = controller(databaseError('42883', 'function commercial.bill_get(uuid) does not exist'));
      const problem = await problemOf(routes.bill(request(), billId));
      expect([problem.getStatus(), problem.code]).toEqual([503, 'BILLING_UNAVAILABLE']);
      expect(calls.some((call) => call.sql === AUDIT_REFUSAL_SQL)).toBe(false);
    });

    it('needs healthcare-operations on routes that show patients', async () => {
      const { controller: routes, calls } = controller({});
      const problem = await problemOf(() => routes.bills(request(CASHIER, 'direct-care'), {}));
      expect([problem.getStatus(), problem.code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
      expect(calls).toEqual([]);
    });

    it('refuses a Health ID or an 11-digit NIN in q before any search, and never passes q on', async () => {
      const { controller: routes, calls } = controller({ items: [] });
      for (const q of ['HID-BLAA22', '12345678901', '123 4567 8901']) {
        const problem = await problemOf(() => routes.bills(request(), { q }));
        expect([problem.getStatus(), problem.code]).toEqual([400, 'BILLING_SEARCH_TEXT_NOT_ALLOWED']);
      }
      expect(calls).toEqual([]);
      expect(searchTextRefused('Ada')).toBe(false);
      expect(searchTextRefused('B-000412')).toBe(false);
    });

    it('adds the server\'s switches to the settings, and passes them to the save', async () => {
      const officer = [...CASHIER, 'billing.settings.manage'];
      const { controller: routes, calls } = controller({ wherePaid: 'cashier', version: 1 });
      expect(await routes.settings(request(officer))).toEqual({ wherePaid: 'cashier', version: 1,
        payBeforeAvailable: false, onlinePaymentAvailable: false });
      await routes.putSettings(request(officer), { wherePaid: 'both', expectedVersion: 1, version: 1,
        payBeforeAvailable: true }, key);
      const put = calls.find((call) => call.sql.includes('settings_put'));
      expect(put?.values.slice(0, 4)).toEqual([{ wherePaid: 'both' }, 1, false, false]);
    });

    it('validates expectedVersion, counts and dates before the database', async () => {
      const { controller: routes, calls } = controller({});
      const officer = [...CASHIER, 'billing.catalogue.manage', 'billing.shift.manage'];
      for (const attempt of [
        () => routes.updateItem(request(officer), billId, { active: false }, key),
        () => routes.openDay(request(), { openingCashKobo: '100' }, key),
        () => routes.closeDay(request(officer), billId, { countedCashKobo: 1 }, key),
        () => routes.summary(request(), { date: '26/11/2026' }),
        () => routes.outstanding(request([...CASHIER, 'billing.report.read']), { olderThanDays: '400' }),
      ]) {
        const problem = await problemOf(attempt);
        expect([problem.getStatus(), problem.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
      expect(calls).toEqual([]);
    });
  });

  describe('online payment (BILL-14): built, switched off', () => {
    it('answers 404 ONLINE_PAYMENT_NOT_AVAILABLE while switched off', async () => {
      const { controller: routes, calls } = controller({});
      for (const attempt of [() => routes.onlineLink(request(), billId, { amountKobo: 100 }, key),
        () => routes.webhook({ event: 'charge.success' }, 'a'.repeat(128))]) {
        const problem = await problemOf(attempt);
        expect([problem.getStatus(), problem.code]).toEqual([404, 'ONLINE_PAYMENT_NOT_AVAILABLE']);
      }
      expect(calls).toEqual([]);
    });

    it('accepts only Paystack\'s HMAC-SHA512 signature of the body with the facility\'s secret', () => {
      const body = JSON.stringify({ event: 'charge.success', data: { reference: 'hid-1' } });
      const secret = 'sk_test_fictional';
      const signature = createHmac('sha512', secret).update(body).digest('hex');
      expect(paystackSignatureValid(body, signature, secret)).toBe(true);
      expect(paystackSignatureValid(body, signature, 'sk_test_other')).toBe(false);
      expect(paystackSignatureValid(body, undefined, secret)).toBe(false);
      expect(paystackSignatureValid(body, 'short', secret)).toBe(false);
    });

    it('with the switch on but no facility secret, a link is not available and Paystack is never called', async () => {
      const fake = fakeDatabase({ dueKobo: 5000, number: 'B-000001' });
      const service = new CommercialService(fake.database, { ...switches, onlineAvailable: true });
      const http = jest.fn();
      const routes = new CommercialController(service, new OnlinePaymentService(service, fake.database,
        noPaystackSecrets, http as never));
      const problem = await problemOf(routes.onlineLink(request(), billId, { amountKobo: 100 }, key));
      expect(problem.code).toBe('ONLINE_PAYMENT_NOT_AVAILABLE');
      expect(http).not.toHaveBeenCalled();
    });
  });
});
