import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DataAccessContext } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { isRecord, orderRouteSummary, type OrderRouteKind, type OrderRouteSummary } from './order-route.mapping';

/** C4 takes at most 200 order ids (SPEC-FINAL §8.7). */
export const SUMMARY_BATCH = 200;

/**
 * The order-route reads the EHR's own lab-request and prescription routes
 * make (SPEC-FINAL §9.1): the latest route of each listed order (C4) and
 * whether orders between facilities are on (FEAS R4).
 */
@Injectable()
export class OrderRouteReader {
  private readonly logger = new Logger(OrderRouteReader.name);

  constructor(private readonly database: DatabaseService) {}

  /**
   * The latest route of each order (C4, `ehr.order_route_summaries`), in the
   * caller's clinical transaction, which already holds the patient's read
   * consent. Only under `direct-care` (PRIV P10, V7): under any other purpose
   * the answer is undefined and the caller leaves `orderRoute` out.
   *
   * The read runs in a savepoint. If it fails, the transaction goes on and
   * the answer is undefined: the clinical record never fails for a route
   * read, and every decision that depends on a route is made again by the
   * database (the work-item validators and the unique constraints, §7.5).
   */
  async summaries(client: PoolClient, context: DataAccessContext, kind: OrderRouteKind, patientId: string,
    orderIds: readonly string[]): Promise<Map<string, OrderRouteSummary> | undefined> {
    if (context.purposeOfUse !== 'direct-care') return undefined;
    const found = new Map<string, OrderRouteSummary>();
    if (orderIds.length === 0) return found;
    await client.query('savepoint order_route_summaries');
    try {
      for (let start = 0; start < orderIds.length; start += SUMMARY_BATCH) {
        const result = await client.query<{ order_id: string; summary: unknown }>(
          'select order_id::text as order_id, summary from ehr.order_route_summaries($1, $2, $3::uuid[])',
          [kind, patientId, orderIds.slice(start, start + SUMMARY_BATCH)],
        );
        for (const row of result.rows) {
          const summary = typeof row.summary === 'string' ? JSON.parse(row.summary) as unknown : row.summary;
          if (isRecord(summary)) found.set(row.order_id, orderRouteSummary(summary, kind));
        }
      }
      await client.query('release savepoint order_route_summaries');
      return found;
    } catch (error) {
      await client.query('rollback to savepoint order_route_summaries');
      this.logger.warn({ message: 'Order route summaries could not be read', sqlState: sqlState(error),
        correlationId: context.correlationId });
      return undefined;
    }
  }

  /** The latest route of one order, undefined when it could not be read. */
  async summary(client: PoolClient, context: DataAccessContext, kind: OrderRouteKind, patientId: string,
    orderId: string): Promise<OrderRouteSummary | null | undefined> {
    const found = await this.summaries(client, context, kind, patientId, [orderId]);
    return found === undefined ? undefined : found.get(orderId) ?? null;
  }

  /**
   * `cross_facility_orders_enabled`, read with a pool statement and never
   * inside a clinical transaction (V11). Off when it cannot be read.
   */
  async crossFacilityOrdersEnabled(): Promise<boolean> {
    try {
      const result = await this.database.query<{ enabled: boolean }>(
        `select platform.control_enabled('cross_facility_orders_enabled') as enabled`);
      return result.rows[0]?.enabled === true;
    } catch {
      return false;
    }
  }
}

function sqlState(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
}
