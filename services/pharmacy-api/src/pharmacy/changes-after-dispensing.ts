import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';

/**
 * Q132 A (owner decision of 19 November 2026: "If a prescription is held,
 * cancelled, entered in error or edited after the pharmacy dispensed it, the
 * dispensed item shows a clear notice ... so the pharmacist can contact the
 * patient"; the shape is the coordinator's decision 1 on #258, 20 November
 * 2026). What the prescribing team did to an item's prescription after this
 * pharmacy first dispensed it, as migration 0148's reader labels it from the
 * facts its trigger recorded:
 * - `entered_in_error`, `cancelled`, `on_hold`: the prescription was entered
 *   in error, cancelled or put on hold (a stop wins over an edit sent in the
 *   same change);
 * - `edited`: an active prescription's content changed, or it was resumed
 *   from a hold and what it now says is not what was dispensed (an edit made
 *   during the hold, in the same change, or before the hold);
 * - `resumed`: resumed from a hold exactly as dispensed (the coordinator's
 *   decision adds it; the owner named four).
 * The database decides these words' codes, not pharmacy-api: the labels are
 * set by the reader from recorded facts, so a later rule change (a replaced
 * reader) applies to rows already recorded. This file only checks that what
 * the reader answers reads cleanly.
 */
export type ChangeAfterDispensing = 'on_hold' | 'cancelled' | 'entered_in_error' | 'edited' | 'resumed';

/** The five codes this pharmacy-api knows, in the reader's order of checks. */
export const CHANGES_AFTER_DISPENSING: readonly ChangeAfterDispensing[] = ['entered_in_error', 'cancelled', 'on_hold',
  'edited', 'resumed'];

/**
 * One work item's notice: the latest shown change (highest prescription
 * version: decision 1's "the latest change first" means `change` and
 * `changedAt`, not a list), when it was recorded (after any dispensing it
 * waited for), and how many shown changes there were (1 or more). `change` is
 * left out, and the notice kept, when the database answers a code this
 * pharmacy-api does not know (a newer database than this image): a safety
 * notice is better shown without its reason than not at all.
 */
export interface ChangedAfterDispensing {
  change?: ChangeAfterDispensing;
  changedAt: Date;
  changeCount: number;
}

/**
 * A row of `pharmacy.work_item_changes_after_dispensing` (0148) as
 * node-postgres hands it over: the id as text, the code as text, the time as a
 * Date (timestamptz) and the count as a number (the reader casts it to
 * integer). Typed unknown on purpose: changeOf checks each one, so a row in
 * another shape answers no notice for its item instead of a guessed one.
 */
export interface ChangeAfterDispensingRow {
  work_item_id: unknown;
  change: unknown;
  changed_at: unknown;
  change_count: unknown;
}

/**
 * 0148's reader (C3). It answers only the session's facility's items the
 * session may read (pharmacy.work_items' two read policies, repeated as
 * conditions, and pharmacy.work-item.read checked again), one row per item
 * with at least one shown change. Exported for the tests, which pin its text.
 */
export const CHANGES_AFTER_DISPENSING_QUERY = `select work_item_id::text as work_item_id, change, changed_at, change_count
        from pharmacy.work_item_changes_after_dispensing($1::uuid[])`;

/** The savepoint each call runs in (one per call, whatever the number of batches). */
const SAVEPOINT = 'pharmacy_changes_after_dispensing';

/** At most this many ids per statement: 0148's reader refuses more than 200 with 22023. */
const CHANGE_BATCH = 200;

/** A timestamptz as text, as JSON or toISOString writes it: date, time and an explicit zone, nothing guessed. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Q132 A's notices for the work list, a single read and the hand-off replay
 * (SPEC decision 19). The service asks it for dispensed items only (own,
 * handed in by hand, or from another facility's order route); it never
 * decides which items those are itself.
 *
 * Off, or with no ids, it sends no statement and answers an empty map. On, it
 * asks `pharmacy.work_item_changes_after_dispensing` in the caller's
 * transaction, inside one savepoint, at most 200 ids a statement, and answers
 * a map only when every batch was read: a batch that fails fails the whole
 * call, so the answer never shows a notice on some items while another
 * batch's items silently lose theirs.
 *
 * Failures, in this order:
 * - a serialization failure or deadlock (40001, 40P01) is passed on as it
 *   is, without rolling the savepoint back, so DatabaseService runs the whole
 *   transaction again (the hand-off replay is SERIALIZABLE, and a retried
 *   transaction must not carry on past a cancelled statement);
 * - 42883 or 42P01 (a database without 0148, or one whose undo was stopped
 *   part way: the reader dropped, or the table under it) rolls the savepoint
 *   back and answers an empty map with no warning: that is the expected
 *   answer while either image may be deployed first;
 * - anything else rolls the savepoint back, logs one warning with its SQL
 *   state and the correlation id, and answers an empty map. The list and the
 *   read never fail because a notice could not be read (Ola's decision on
 *   open point 4: leave the field out, warn, no list flag); operations alert
 *   on the warning text, because the screen cannot tell "no change" from
 *   "not known".
 *
 * Each row is checked (changeOf). A row whose time or count does not read
 * cleanly gives its item no notice, never a guessed one, and one warning
 * that names that work item's id and nothing of the row. A row whose code
 * this pharmacy-api does not know keeps its notice without `change`, with one
 * warning per call. Row warnings are logged only once the map is answered,
 * so they describe what the answer left out.
 *
 * No audit row: the notice shows no new person (0125's rule,
 * prescription-dispensing-details.ts). The list's and the read's audit rows
 * already name the item and the patient, and the change itself is audited
 * where it was made (ehr-api's ehr.prescription.update).
 */
export class PharmacyChangesAfterDispensing {
  private readonly logger = new Logger(PharmacyChangesAfterDispensing.name);

  constructor(readonly enabled: boolean) {}

  async changes(client: PoolClient, workItemIds: readonly string[], correlationId: string):
  Promise<Map<string, ChangedAfterDispensing>> {
    const found = new Map<string, ChangedAfterDispensing>();
    if (!this.enabled || workItemIds.length === 0) return found;
    const unreadable: (string | null)[] = [];
    let unknownChange = false;
    await client.query(`savepoint ${SAVEPOINT}`);
    try {
      for (let start = 0; start < workItemIds.length; start += CHANGE_BATCH) {
        const result = await client.query<ChangeAfterDispensingRow>(CHANGES_AFTER_DISPENSING_QUERY,
          [workItemIds.slice(start, start + CHANGE_BATCH)]);
        for (const row of result.rows) {
          // The reader casts the id to text; anything else cannot be matched to an item, so it is dropped
          // with the same warning (no id to name).
          const workItemId = typeof row.work_item_id === 'string' && row.work_item_id ? row.work_item_id : null;
          const changed = workItemId === null ? undefined : changeOf(row);
          if (!changed || workItemId === null) {
            unreadable.push(workItemId);
            continue;
          }
          if (changed.change === undefined) unknownChange = true;
          found.set(workItemId, changed);
        }
      }
      await client.query(`release savepoint ${SAVEPOINT}`);
    } catch (error) {
      if (mustRetry(error)) throw error;
      await client.query(`rollback to savepoint ${SAVEPOINT}`);
      const code = sqlState(error);
      if (code !== '42883' && code !== '42P01') {
        this.logger.warn({ message: 'Changes after dispensing could not be read', sqlState: code, correlationId });
      }
      return new Map();
    }
    for (const workItemId of unreadable) {
      this.logger.warn({ message: 'A change after dispensing could not be read', workItemId, correlationId });
    }
    if (unknownChange) {
      this.logger.warn({ message: 'A change after dispensing has a code this pharmacy-api does not know; '
        + 'the notice is answered without it', correlationId });
    }
    return found;
  }
}

/** Off: no statement and no notice (the tests' and every direct caller's default). */
export const CHANGES_AFTER_DISPENSING_OFF = new PharmacyChangesAfterDispensing(false);

/**
 * A reader row as a notice, or undefined when it does not read cleanly:
 * `changed_at` must be a valid Date (node-postgres makes one of a
 * timestamptz) or an ISO time with its zone, and `change_count` a whole
 * number of 1 or more (the reader counts shown rows, so 0 is never a
 * notice). `change` is kept only when it is one of the five codes; any other
 * value (a newer database's code) leaves it out and keeps the notice.
 */
export function changeOf(row: Pick<ChangeAfterDispensingRow, 'change' | 'changed_at' | 'change_count'>):
ChangedAfterDispensing | undefined {
  const changedAt = timeOf(row.changed_at);
  const count = row.change_count;
  if (!changedAt || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return undefined;
  const change = CHANGES_AFTER_DISPENSING.find((known) => known === row.change);
  return { ...(change ? { change } : {}), changedAt, changeCount: count };
}

function timeOf(value: unknown): Date | undefined {
  const time = value instanceof Date ? value
    : typeof value === 'string' && ISO_TIME.test(value) ? new Date(value) : undefined;
  return time && Number.isFinite(time.getTime()) ? time : undefined;
}

function sqlState(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
}

function mustRetry(error: unknown): boolean {
  const code = sqlState(error);
  return code === '40001' || code === '40P01';
}
