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
  /**
   * ORD-4: where the item is in this pharmacy's own steps. Set only when
   * pharmacy.own_work_item_steps answered the row; never from 0133's reader,
   * which cannot tell an item sent automatically from one handed in by hand.
   */
  steps?: OwnWorkSteps;
}

export type OwnWorkWithdrawnReason = 'changed' | 'sent_elsewhere';

/**
 * ORD-4: whether the item was sent to this pharmacy automatically when its
 * prescription was activated (a 'sent' row of 0133's
 * pharmacy.own_prescription_sends, which no runtime may read itself), and
 * the pharmacist's acceptance pharmacy.work_item_acceptances holds for it,
 * or null. An own item not sent automatically was handed in by a pharmacist
 * (accept-ehr-prescription) and is accepted from the moment it was made.
 */
export interface OwnWorkSteps {
  sentAutomatically: boolean;
  acceptance: OwnWorkAcceptance | null;
}

/** A pharmacist's acceptance of an own item: by the accept route ('accept') or by its first dispensing ('dispensing'). */
export interface OwnWorkAcceptance {
  acceptedAt: Date;
  acceptedByMembershipId: string;
  acceptedWith: 'accept' | 'dispensing';
}

interface StateRow {
  work_item_id: string;
  basis: string;
  withdrawn: boolean;
  withdrawn_reason: string | null;
}

interface StepsRow extends StateRow {
  sent_automatically: boolean | null;
  accepted_at: Date | null;
  accepted_by_membership_id: string | null;
  accepted_with: string | null;
}

/** At most this many ids per statement (0133's reader and ORD-4's both take 200). */
const STATE_BATCH = 200;

/**
 * ORD-4's reader: 0133's four columns (the same rows, basis and withdrawn
 * rule as pharmacy.own_work_item_states) and the steps. Exported for the tests.
 */
export const OWN_WORK_STEPS_QUERY = `select work_item_id::text as work_item_id, basis, withdrawn, withdrawn_reason,
             sent_automatically, accepted_at, accepted_by_membership_id::text as accepted_by_membership_id, accepted_with
        from pharmacy.own_work_item_steps($1::uuid[])`;

/** 0133's reader, asked only on a schema without ORD-4's (42883). Exported for the tests. */
export const OWN_WORK_STATES_QUERY = `select work_item_id::text as work_item_id, basis, withdrawn, withdrawn_reason
             from pharmacy.own_work_item_states($1::uuid[])`;

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
 * ORD-4: `states` asks `pharmacy.own_work_item_steps` first, which answers
 * the same rows and columns as 0133's reader plus each item's steps (sent
 * automatically or handed in, and the pharmacist's acceptance), so the work
 * list, a single read and the prescriber's progress still make one reader
 * statement. On a schema without it (42883) the savepoint is rolled back and
 * 0133's reader answers in the same savepoint, as before, with no steps: the
 * caller then answers no pharmacy step, never a guessed one. `steps` asks
 * ORD-4's reader alone, for the accept route and for a dispensing: it
 * answers undefined when the reader is not there (42883) or the module is
 * off, and passes any other failure on after rolling its savepoint back.
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
      // ORD-4's reader first; on a schema without it, 0133's, for every batch (the first batch tells).
      let withSteps = true;
      for (let start = 0; start < workItemIds.length; start += STATE_BATCH) {
        const batch = workItemIds.slice(start, start + STATE_BATCH);
        let rows: readonly StateRow[];
        if (withSteps) {
          try {
            rows = (await client.query<StepsRow>(OWN_WORK_STEPS_QUERY, [batch])).rows;
          } catch (error) {
            if (start > 0 || sqlState(error) !== '42883') throw error;
            await client.query('rollback to savepoint pharmacy_own_work_states');
            withSteps = false;
            rows = (await client.query<StateRow>(OWN_WORK_STATES_QUERY, [batch])).rows;
          }
        } else {
          rows = (await client.query<StateRow>(OWN_WORK_STATES_QUERY, [batch])).rows;
        }
        for (const row of rows) {
          const state = stateOf(row, withSteps);
          if (state) found.set(row.work_item_id, state);
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

  /**
   * ORD-4's reader alone (the accept route; a dispensing that accepts a
   * received item first): each own item's state with its steps. undefined
   * when the module is off or the reader is not there (42883, a schema
   * without ORD-4); a row the reader does not answer (not own here, or not
   * readable by this session) is absent. Any other failure is passed on,
   * after its savepoint is rolled back so the caller's transaction can go
   * on; a serialization failure or deadlock is passed on as it is, so
   * DatabaseService runs the whole transaction again.
   */
  async steps(client: PoolClient, workItemIds: readonly string[], correlationId: string):
  Promise<Map<string, OwnWorkState> | undefined> {
    if (!this.enabled) return undefined;
    const found = new Map<string, OwnWorkState>();
    if (workItemIds.length === 0) return found;
    await client.query('savepoint pharmacy_own_work_steps');
    try {
      for (let start = 0; start < workItemIds.length; start += STATE_BATCH) {
        const result = await client.query<StepsRow>(OWN_WORK_STEPS_QUERY, [workItemIds.slice(start, start + STATE_BATCH)]);
        for (const row of result.rows) {
          const state = stateOf(row, true);
          if (state) found.set(row.work_item_id, state);
        }
      }
      await client.query('release savepoint pharmacy_own_work_steps');
    } catch (error) {
      if (mustRetry(error)) throw error;
      await client.query('rollback to savepoint pharmacy_own_work_steps');
      const code = sqlState(error);
      if (code === '42883') return undefined;
      this.logger.warn({ message: 'Own pharmacy work steps could not be read', sqlState: code, correlationId });
      throw error;
    }
    return found;
  }
}

/**
 * A reader row as a state: none unless the basis is one of the two; with
 * `steps` only from ORD-4's reader, and only when they read cleanly (an
 * acceptance needs its time, member and one of the two ways; anything else
 * answers no steps for that item rather than a guessed one).
 */
function stateOf(row: StateRow, withSteps: boolean): OwnWorkState | undefined {
  if (row.basis !== 'consent' && row.basis !== 'own-work') return undefined;
  const state: OwnWorkState = row.withdrawn === true
    ? { basis: row.basis, withdrawn: true, withdrawnReason: withdrawnReason(row.withdrawn_reason) }
    : { basis: row.basis, withdrawn: false };
  const steps = withSteps ? stepsOf(row as StepsRow) : undefined;
  return steps ? { ...state, steps } : state;
}

function stepsOf(row: StepsRow): OwnWorkSteps | undefined {
  if (typeof row.sent_automatically !== 'boolean') return undefined;
  if (row.accepted_at === null || row.accepted_at === undefined) {
    return { sentAutomatically: row.sent_automatically, acceptance: null };
  }
  const acceptedAt = row.accepted_at instanceof Date ? row.accepted_at : new Date(row.accepted_at);
  if (Number.isNaN(acceptedAt.getTime()) || typeof row.accepted_by_membership_id !== 'string'
    || (row.accepted_with !== 'accept' && row.accepted_with !== 'dispensing')) return undefined;
  return { sentAutomatically: row.sent_automatically, acceptance: { acceptedAt,
    acceptedByMembershipId: row.accepted_by_membership_id, acceptedWith: row.accepted_with } };
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
