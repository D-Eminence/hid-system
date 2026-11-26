import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DataAccessContext } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { billingProblem, classifyBillingError } from './billing-errors';

export const STOCK_BILLING_ENABLED = Symbol('STOCK_BILLING_ENABLED');
export const SWITCHED_ON_SQL = 'select commercial.billing_switched_on($1) as switched_on';
export const AUDIT_REFUSAL_SQL = 'select commercial.audit_refusal($1, $2, $3, $4, $5)';
/** Marks the transaction as pharmacy-api's, so the billing functions' audit rows name it. */
export const SOURCE_SQL = "select set_config('hid.billing_source', 'pharmacy-api', true)";

export interface StockCall {
  action: string;
  code: string;
  resourceType: string;
  resourceId?: string | null;
  sql: string;
  values: readonly unknown[];
}

/**
 * BILL-1 (0166): pharmacy point-of-care stock and counter sales
 * (POINT_OF_CARE_SPEC sections 4 and 5). Each route is one SECURITY DEFINER
 * function (the pharmacy schema's stock functions, 0166), in one transaction
 * with the request's context, after the switched-on check (404
 * BILLING_NOT_AVAILABLE at a real facility until go-live). A refusal is
 * audited after the rollback; any other failure is 503 BILLING_UNAVAILABLE,
 * logged with its SQLSTATE only.
 */
@Injectable()
export class PharmacyStockService {
  private readonly logger = new Logger(PharmacyStockService.name);

  constructor(private readonly database: DatabaseService,
    @Inject(STOCK_BILLING_ENABLED) private readonly billingEnabled: boolean) {}

  async run<Answer = Record<string, unknown>>(context: DataAccessContext, call: StockCall): Promise<Answer> {
    try {
      if (!context.actor.permissions.includes(call.code)) throw billingProblem('BILLING_NOT_ALLOWED');
      return await this.database.withTransaction(context, async (client: PoolClient) => {
        await client.query(SOURCE_SQL);
        const on = (await client.query<{ switched_on: boolean }>(SWITCHED_ON_SQL, [this.billingEnabled])).rows[0];
        if (on?.switched_on !== true) throw billingProblem('BILLING_NOT_AVAILABLE');
        const row = (await client.query<{ answer: Answer }>(call.sql, [...call.values])).rows[0];
        if (!row) throw billingProblem('BILLING_UNAVAILABLE');
        return row.answer;
      });
    } catch (error) {
      const failure = classifyBillingError(error);
      if (failure.refusal === null) {
        this.logger.warn(`Stock call failed (${failure.sqlstate ?? 'no database code'})`);
      } else if (failure.refusal !== 'BILLING_NOT_AVAILABLE') {
        await this.auditRefusal(context, call.action, failure.refusal, call.resourceType, call.resourceId ?? null);
      }
      throw failure.problem;
    }
  }

  async auditRefusal(context: DataAccessContext, action: string, code: string, resourceType: string,
    resourceId: string | null): Promise<void> {
    const id = resourceId && /^[0-9a-f-]{36}$/i.test(resourceId) ? resourceId : null;
    try {
      await this.database.withTransaction(context, (client) =>
        client.query(AUDIT_REFUSAL_SQL, [action, code, resourceType, id, 'pharmacy-api']));
    } catch (error) {
      const sqlstate = (error as { code?: unknown })?.code;
      this.logger.warn(`Stock refusal audit failed (${typeof sqlstate === 'string' ? sqlstate : 'no database code'})`);
    }
  }
}

/** The bill and stock a pharmacy work item shows (POC sections 3 and 5). */
export interface WorkItemBilling {
  bill: Record<string, unknown> | null;
  stock: { onHand: number; unit: string } | null;
}
export const WORK_ITEM_BILLS_SQL = "select work_item_id::text as work_item_id, bill from commercial.work_item_bills('pharmacy', $1::uuid[])";
export const STOCK_FOR_CODES_SQL = 'select pharmacy.stock_for_codes($1::jsonb) as answer';

/**
 * Reads, in a savepoint of the list's or read's own transaction, each own
 * work item's bill (commercial.work_item_bills) and the stock of its
 * medication code (pharmacy.stock_for_codes). Anything that fails (a schema
 * without 0164-0166, billing not set up) answers nothing for every row, as
 * before: the work list never fails for billing.
 */
export async function workItemBilling(client: PoolClient,
  rows: readonly { id: string; medication_code_system?: string | null; medication_code?: string | null }[])
  : Promise<Map<string, WorkItemBilling>> {
  const answer = new Map<string, WorkItemBilling>();
  if (rows.length === 0) return answer;
  await client.query('savepoint work_item_billing');
  try {
    const bills = new Map((await client.query<{ work_item_id: string; bill: Record<string, unknown> }>(
      WORK_ITEM_BILLS_SQL, [rows.map((row) => row.id)])).rows.map((row) => [row.work_item_id, row.bill]));
    const codes = rows.filter((row) => row.medication_code_system && row.medication_code)
      .map((row) => ({ codeSystem: row.medication_code_system, code: row.medication_code }));
    const stock = (await client.query<{ answer: { codeSystem: string; code: string; onHand: number; unit: string }[] }>(
      STOCK_FOR_CODES_SQL, [JSON.stringify(codes.slice(0, 200))])).rows[0]?.answer ?? [];
    for (const row of rows) {
      const kept = stock.find((entry) => entry.codeSystem === row.medication_code_system
        && entry.code === row.medication_code);
      answer.set(row.id, { bill: bills.get(row.id) ?? null,
        stock: kept ? { onHand: kept.onHand, unit: kept.unit } : null });
    }
    await client.query('release savepoint work_item_billing');
  } catch {
    await client.query('rollback to savepoint work_item_billing');
    answer.clear();
  }
  return answer;
}

/** The work item's bill and stock fields, only when it has either (a facility without billing shows neither). */
export function billingFields(entry: WorkItemBilling | undefined): Partial<WorkItemBilling> {
  return entry && (entry.bill !== null || entry.stock !== null) ? { bill: entry.bill, stock: entry.stock } : {};
}
