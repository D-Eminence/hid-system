import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';

/** The resources 0133's `lab.own_work_access_for` derives an own work item from (as C11). */
export type LabOwnWorkResource = 'work_item' | 'accession' | 'specimen' | 'execution' | 'result';

/** Why the session sees an own work item (0133 D10). */
export interface OwnWorkState {
  basis: 'consent' | 'own-work';
}

interface StateRow {
  work_item_id: string;
  basis: string;
}

/** At most this many ids per statement (0133's reader takes 200). */
const STATE_BATCH = 200;

/**
 * This facility's own lab work for its lab staff (0133; owner, 18 November
 * 2026: "pharmacy and lab staff get their own facility's work items only,
 * never the chart"; finding F2 of the Akos EHR plan).
 *
 * `allows` asks `lab.own_work_access_for` whether the session works for this
 * facility's laboratory (direct care, lab.work-item.read and
 * lab.order-route.receive here, the patient active and no deny directive) on
 * the own work item (no order route) a work item, accession, specimen,
 * execution or result belongs to. `states` asks `lab.own_work_item_bases`
 * why the session sees each own row ('consent' or 'own-work').
 *
 * Each runs in the caller's transaction, in a savepoint: a schema without
 * 0133 (42883) or any other refusal answers "no own-work basis" and an empty
 * map, so the command falls back to Identity's consent as before. A
 * serialization failure or deadlock is passed on, so DatabaseService runs the
 * whole transaction again. The module provides it on; the tests' default is
 * off (no statement).
 */
export class LabOwnWork {
  private readonly logger = new Logger(LabOwnWork.name);

  constructor(readonly enabled: boolean) {}

  async allows(client: PoolClient, resource: LabOwnWorkResource, resourceId: string,
    action: 'read_records' | 'write_records', correlationId: string): Promise<boolean> {
    if (!this.enabled) return false;
    await client.query('savepoint lab_own_work_access');
    try {
      const result = await client.query<{ work_item_id: string }>(
        'select work_item_id::text as work_item_id from lab.own_work_access_for($1, $2::uuid, $3)',
        [resource, resourceId, action],
      );
      await client.query('release savepoint lab_own_work_access');
      return result.rows.length > 0;
    } catch (error) {
      if (mustRetry(error)) throw error;
      await client.query('rollback to savepoint lab_own_work_access');
      this.logger.warn({ message: 'Own lab work access could not be checked', sqlState: sqlState(error),
        correlationId });
      return false;
    }
  }

  async states(client: PoolClient, workItemIds: readonly string[], correlationId: string):
  Promise<Map<string, OwnWorkState>> {
    const found = new Map<string, OwnWorkState>();
    if (!this.enabled || workItemIds.length === 0) return found;
    await client.query('savepoint lab_own_work_bases');
    try {
      for (let start = 0; start < workItemIds.length; start += STATE_BATCH) {
        const result = await client.query<StateRow>(
          `select work_item_id::text as work_item_id, basis
             from lab.own_work_item_bases($1::uuid[])`,
          [workItemIds.slice(start, start + STATE_BATCH)],
        );
        for (const row of result.rows) {
          if (row.basis === 'consent' || row.basis === 'own-work') {
            found.set(row.work_item_id, { basis: row.basis });
          }
        }
      }
      await client.query('release savepoint lab_own_work_bases');
    } catch (error) {
      if (mustRetry(error)) throw error;
      await client.query('rollback to savepoint lab_own_work_bases');
      this.logger.warn({ message: 'Own lab work bases could not be read', sqlState: sqlState(error),
        correlationId });
      return new Map();
    }
    return found;
  }
}

/** Off: no statement, no own-work basis (the tests' and every direct caller's default). */
export const OWN_WORK_OFF = new LabOwnWork(false);

function sqlState(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
}

function mustRetry(error: unknown): boolean {
  const code = sqlState(error);
  return code === '40001' || code === '40P01';
}
