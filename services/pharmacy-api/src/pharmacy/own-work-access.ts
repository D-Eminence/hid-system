import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';

/** The resources 0133's `pharmacy.own_work_access_for` derives an own work item from. */
export type PharmacyOwnWorkResource = 'work_item' | 'dispensing';

/**
 * Why the session sees an own work item (0133 D10), whether it was withdrawn
 * before it was dispensed, and why: 'changed' when its automatic send was
 * withdrawn (the prescription was held, cancelled, entered in error, edited
 * or resumed after it was sent), 'sent_elsewhere' when the prescription was
 * sent to another facility's pharmacy (D14, owner's Q121 A). Set only with
 * `withdrawn: true`.
 */
export interface OwnWorkState {
  basis: 'consent' | 'own-work';
  withdrawn: boolean;
  withdrawnReason?: OwnWorkWithdrawnReason;
}

export type OwnWorkWithdrawnReason = 'changed' | 'sent_elsewhere';

interface StateRow {
  work_item_id: string;
  basis: string;
  withdrawn: boolean;
  withdrawn_reason: string | null;
}

/** At most this many ids per statement (0133's reader takes 200). */
const STATE_BATCH = 200;

/**
 * This facility's own pharmacy work for its pharmacy staff (0133; owner, 18
 * November 2026: "pharmacy and lab staff get their own facility's work items
 * only, never the chart"; finding F2 of the Akos EHR plan).
 *
 * `basis` asks `pharmacy.own_work_access_for` whether the session works for
 * this facility's pharmacy (direct care, pharmacy.work-item.read and
 * pharmacy.order-route.receive here, the patient active and no deny
 * directive) on the own work item (no order route) a work item or
 * dispensing belongs to, and with which audit basis: 'consent' when the
 * member holds its own consent for the action (as the work list's reader
 * records it), else 'own-work'. `states` asks `pharmacy.own_work_item_states` why
 * the session sees each own row ('consent' or 'own-work') and whether it was
 * withdrawn before it was dispensed, with the reason: 'changed' (its
 * automatic send was withdrawn: the prescription was held, cancelled,
 * entered in error, edited or resumed after it was sent) or 'sent_elsewhere'
 * (the prescription was sent to another facility's pharmacy, D14). A
 * withdrawn row with no reason or another one counts as 'changed'.
 *
 * Each runs in the caller's transaction, in a savepoint. `basis`: a schema
 * without 0133 (42883) or any other refusal answers "no own-work basis", so
 * the command falls back to Identity's consent as before. `states` has two
 * modes. For the work list ('audit'), whose per-patient audit rows carry the
 * basis, it answers undefined on a schema without 0133 (the list then
 * records as 0124 did) and passes any other failure on, so the list fails
 * rather than record a basis it could not read. For one item's withdrawn
 * flag ('flag') any failure answers an empty map (no flag; dispensing is
 * refused by 0101 anyway). A serialization failure or deadlock is passed on
 * in every case, so DatabaseService runs the whole transaction again. The
 * module provides it on; the tests' default is off (no statement, and the
 * list records as 0124 did).
 */
export class PharmacyOwnWork {
  private readonly logger = new Logger(PharmacyOwnWork.name);

  constructor(readonly enabled: boolean) {}

  /** The own-work access and its audit basis; undefined when there is none (or it cannot be read). */
  async basis(client: PoolClient, resource: PharmacyOwnWorkResource, resourceId: string,
    action: 'read_records' | 'write_records', correlationId: string): Promise<OwnWorkState['basis'] | undefined> {
    if (!this.enabled) return undefined;
    await client.query('savepoint pharmacy_own_work_access');
    try {
      const result = await client.query<{ work_item_id: string; basis: string }>(
        'select work_item_id::text as work_item_id, basis from pharmacy.own_work_access_for($1, $2::uuid, $3)',
        [resource, resourceId, action],
      );
      await client.query('release savepoint pharmacy_own_work_access');
      const found = result.rows[0];
      if (!found) return undefined;
      return found.basis === 'consent' ? 'consent' : 'own-work';
    } catch (error) {
      if (mustRetry(error)) throw error;
      await client.query('rollback to savepoint pharmacy_own_work_access');
      this.logger.warn({ message: 'Own pharmacy work access could not be checked', sqlState: sqlState(error),
        correlationId });
      return undefined;
    }
  }

  /** One item's withdrawn flag: an empty map when the states cannot be read. */
  async states(client: PoolClient, workItemIds: readonly string[], correlationId: string, mode: 'flag'):
  Promise<Map<string, OwnWorkState>>;
  /** The work list's audit bases: undefined without 0133 (42883); any other failure is passed on. */
  async states(client: PoolClient, workItemIds: readonly string[], correlationId: string, mode: 'audit'):
  Promise<Map<string, OwnWorkState> | undefined>;
  async states(client: PoolClient, workItemIds: readonly string[], correlationId: string, mode: 'flag' | 'audit'):
  Promise<Map<string, OwnWorkState> | undefined> {
    const found = new Map<string, OwnWorkState>();
    if (!this.enabled) return mode === 'audit' ? undefined : found;
    if (workItemIds.length === 0) return found;
    await client.query('savepoint pharmacy_own_work_states');
    try {
      for (let start = 0; start < workItemIds.length; start += STATE_BATCH) {
        const result = await client.query<StateRow>(
          `select work_item_id::text as work_item_id, basis, withdrawn, withdrawn_reason
             from pharmacy.own_work_item_states($1::uuid[])`,
          [workItemIds.slice(start, start + STATE_BATCH)],
        );
        for (const row of result.rows) {
          if (row.basis === 'consent' || row.basis === 'own-work') {
            found.set(row.work_item_id, row.withdrawn === true
              ? { basis: row.basis, withdrawn: true, withdrawnReason: withdrawnReason(row.withdrawn_reason) }
              : { basis: row.basis, withdrawn: false });
          }
        }
      }
      await client.query('release savepoint pharmacy_own_work_states');
    } catch (error) {
      if (mustRetry(error)) throw error;
      await client.query('rollback to savepoint pharmacy_own_work_states');
      const code = sqlState(error);
      if (mode === 'audit' && code === '42883') return undefined;
      this.logger.warn({ message: 'Own pharmacy work states could not be read', sqlState: code, correlationId });
      if (mode === 'audit') throw error;
      return new Map();
    }
    return found;
  }
}

/** Off: no statement, no own-work basis (the tests' and every direct caller's default). */
export const OWN_WORK_OFF = new PharmacyOwnWork(false);

/** 'sent_elsewhere' only for exactly that text; any other reason, or none, is 'changed'. */
function withdrawnReason(value: string | null | undefined): OwnWorkWithdrawnReason {
  return value === 'sent_elsewhere' ? 'sent_elsewhere' : 'changed';
}

function sqlState(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
}

function mustRetry(error: unknown): boolean {
  const code = sqlState(error);
  return code === '40001' || code === '40P01';
}
