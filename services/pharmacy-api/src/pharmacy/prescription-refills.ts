import { Injectable, Logger, Optional, type PipeTransform } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import { createValidationPipe } from '../common/validation-pipe';
import { CreateDispensingDto, CreateRefillDispensingDto } from './dto/dispensing.dto';

/** The body a dispensing carries: today's, or with `fillNumber` while refills are on. */
export type CreateDispensingInput = CreateDispensingDto | CreateRefillDispensingDto;

/** At most this many ids in one call of 0152's reader (it refuses 201 with 22023). */
export const REFILLS_BATCH = 200;

/**
 * 0152's key on pharmacy.dispensings, UNIQUE (work_item_id, fill_number), by
 * the name 0152 gives it: two fills of one item with the same number.
 */
export const FILL_KEY_CONSTRAINT = 'dispensings_work_item_fill_number_key';

/**
 * 0023's UNIQUE (facility_id, dispensed_by, idempotency_key) on
 * pharmacy.dispensings, by the name PostgreSQL gave it (0023 names none):
 * this member's Idempotency-Key at this facility, used once.
 */
export const DISPENSING_KEY_CONSTRAINT = 'dispensings_facility_id_dispensed_by_idempotency_key_key';

/**
 * 0152's reader, `pharmacy.work_item_refills(uuid[])` (SECURITY DEFINER, own
 * items only, at most 200 ids, the session's facility, pharmacy.work-item.read
 * and the work items' two read policies): one row per own item the session
 * may read. Exported for the tests.
 */
export const WORK_ITEM_REFILLS_QUERY = `select work_item_id::text as work_item_id, refills_allowed, fills_recorded,
       refill_open, closed_reason
  from pharmacy.work_item_refills($1::uuid[])`;

/**
 * ORD-12: the own items that may have a refill open, at most 200, so that the
 * work list can ask 0152's reader about them before it chooses its rows: the
 * session's own items (no order route) it may read under row-level security,
 * with 1 to 11 fills (a 12th fill is never open: 1 + 11 refills at most), whose
 * end date is not before today in Lagos (`ends_on` is the prescription's as
 * accepted; a refill after any change is closed anyway), the latest fill
 * first. Only the reader says which of them are open (refills allowed, the
 * prescription active at the accepted version). An own item with a refill open
 * beyond these 200 is listed with the done work, by the day it was received.
 * Exported for the tests.
 */
export const REFILL_CANDIDATES_QUERY = `select w.id::text as work_item_id
  from pharmacy.work_items w
  cross join lateral (select count(*)::integer as fills, max(df.dispensed_at) as last_filled_at
    from pharmacy.dispensings df where df.work_item_id=w.id) f
  where w.order_route_id is null and f.fills between 1 and 11
    and (w.ends_on is null or w.ends_on >= (now() at time zone 'Africa/Lagos')::date)
  order by f.last_filled_at desc, w.id desc limit 200`;

/** A row of 0152's reader. */
export interface WorkItemRefillsRow {
  work_item_id: string;
  refills_allowed: number;
  fills_recorded: number;
  refill_open: boolean;
  closed_reason: string | null;
}

/** Why no further fill can be recorded (0152's reader); null while one is open, and before the first fill. */
export type RefillsClosedReason = 'none_left' | 'changed' | 'stopped' | 'ended';
const CLOSED_REASONS: ReadonlySet<string> = new Set(['none_left', 'changed', 'stopped', 'ended']);

/**
 * The `refills` an item carries while refills are on:
 * - `allowed`: the refills the prescription allows (0-11; none given is 0);
 * - `recorded`: the fills recorded on the item, a reversed fill included;
 * - `open`: another fill may be recorded now ("Dispense" again);
 * - `closedReason`: why not, once at least one fill is recorded (null while
 *   open, and before the first fill).
 * The label "Fill 2 of 3" is fill `recorded` (or `recorded + 1` when
 * dispensing again) of `allowed + 1`.
 */
export interface WorkItemRefills {
  allowed: number;
  recorded: number;
  open: boolean;
  closedReason: RefillsClosedReason | null;
}

/** The work-item columns the refills field reads. */
interface RefillsWorkRow {
  order_route_id?: string | null;
  fills_recorded?: number | string | null;
}

/**
 * Prescription refills on this facility's own work (ORD-12; owner decision
 * Q131 A, 19 November 2026; the clinical owner's design note on
 * hid-system#258, Rahman's review of it and the clinical owner's answers, all
 * 23 November 2026; migration 0152).
 *
 * Behind PRESCRIPTION_REFILLS_ENABLED (off by default), separate from 0125's
 * PRESCRIPTION_DISPENSING_DETAILS_ENABLED, and read the same way. Off, it
 * reads nothing and adds nothing: a dispensing body is checked against
 * CreateDispensingDto (so `fillNumber` is refused 400 VALIDATION_FAILED, as
 * today), no fill above the first is recorded, and the answers carry no new
 * field. What does not depend on it (PharmacyService): a work item is one row
 * whatever its number of fills, `dispensing` being the latest fill; a replay
 * is by the item, the fill number and the request; only the latest fill can
 * be reversed. On (only once 0152 is applied and both staff front ends handle
 * more than one fill):
 * - a dispensing may carry `fillNumber`, the fills already recorded plus one;
 * - an own item answers `refills` (0152's reader, in a savepoint, at most 200
 *   ids a statement: a failure leaves `refills` out and keeps no item open for
 *   a refill, and never fails the answer, as 0125's details do), a
 *   route-backed item `refills` with none allowed and one fill at most;
 * - an own item with a refill open is open work on the list, of any age;
 * - `dispensing.fillNumber`, `lastFilledAt` and a dispensing's `fillNumber`.
 * No audit row: no new person is shown.
 */
export class PharmacyRefills {
  private readonly logger = new Logger(PharmacyRefills.name);

  constructor(readonly enabled: boolean) {}

  /** 0152's reader for these own items, in batches of 200; nothing while off. */
  async read(client: PoolClient, workItemIds: readonly string[], correlationId: string):
  Promise<Map<string, WorkItemRefillsRow>> {
    const found = new Map<string, WorkItemRefillsRow>();
    if (!this.enabled || workItemIds.length === 0) return found;
    await client.query('savepoint pharmacy_work_item_refills');
    try {
      for (let start = 0; start < workItemIds.length; start += REFILLS_BATCH) {
        const result = await client.query<WorkItemRefillsRow>(WORK_ITEM_REFILLS_QUERY,
          [workItemIds.slice(start, start + REFILLS_BATCH)]);
        for (const row of result.rows) found.set(row.work_item_id, row);
      }
      await client.query('release savepoint pharmacy_work_item_refills');
    } catch (error) {
      await client.query('rollback to savepoint pharmacy_work_item_refills');
      this.logger.warn({ message: 'Refills on own work could not be read', sqlState: sqlState(error), correlationId });
      return new Map();
    }
    return found;
  }

  /**
   * The work list's first step while on: the candidates (REFILL_CANDIDATES_QUERY)
   * and 0152's answer for them, in one savepoint (a failure: none open, nothing
   * read, a warning). `open` names the items with a refill open, which the list
   * then counts as open work; `found` is kept for the rows the list shows.
   */
  async openForList(client: PoolClient, correlationId: string):
  Promise<{ open: string[]; found: Map<string, WorkItemRefillsRow> }> {
    if (!this.enabled) return { open: [], found: new Map() };
    await client.query('savepoint pharmacy_refill_candidates');
    let candidates: string[];
    try {
      candidates = (await client.query<{ work_item_id: string }>(REFILL_CANDIDATES_QUERY)).rows
        .map((row) => row.work_item_id);
      await client.query('release savepoint pharmacy_refill_candidates');
    } catch (error) {
      await client.query('rollback to savepoint pharmacy_refill_candidates');
      this.logger.warn({ message: 'Own work with refills could not be read', sqlState: sqlState(error), correlationId });
      return { open: [], found: new Map() };
    }
    const found = await this.read(client, candidates, correlationId);
    return { open: [...found.values()].filter((row) => row.refill_open === true).map((row) => row.work_item_id), found };
  }

  /**
   * The `refills` of a work row while on: a route-backed item takes one fill
   * (none allowed); an own item is 0152's answer, left out when there is none
   * (the reader failed, or did not answer the item). Nothing while off.
   */
  forRow(row: RefillsWorkRow, found: WorkItemRefillsRow | undefined): WorkItemRefills | undefined {
    if (!this.enabled) return undefined;
    if (row.order_route_id) {
      const recorded = Math.max(0, Number(row.fills_recorded ?? 0));
      return { allowed: 0, recorded, open: false, closedReason: recorded > 0 ? 'none_left' : null };
    }
    if (!found) return undefined;
    const closed = found.closed_reason;
    return { allowed: Number(found.refills_allowed), recorded: Number(found.fills_recorded),
      open: found.refill_open === true && closed === null,
      closedReason: closed !== null && CLOSED_REASONS.has(closed) ? closed as RefillsClosedReason : null };
  }
}

/** Off: no statement, no field, no refill recorded (the tests' and every direct caller's default). */
export const REFILLS_OFF = new PharmacyRefills(false);

/** The fill a dispensing body asks to record: its `fillNumber`, or the first fill when it carries none. */
export function requestedFill(input: CreateDispensingInput): number {
  return (input as CreateRefillDispensingDto).fillNumber ?? 1;
}

/**
 * What the Idempotency-Key digest covers: the body as today for a first fill
 * (`fillNumber` absent or 1), with `fillNumber` for a refill. So a first fill
 * recorded by an image before ORD-12 replays for a request that names fill 1,
 * and two refills with the same body are two requests.
 */
export function dispensingDigestInput(input: CreateDispensingInput): object {
  const { fillNumber, ...today } = input as CreateRefillDispensingDto;
  return fillNumber === undefined || fillNumber === 1 ? today : { ...today, fillNumber };
}

/**
 * 409: the fill asked for is not the next one (another fill was recorded
 * since the item was read: a second press, or another member). `fillsRecorded`
 * says how many there are now.
 */
export function fillNumberChanged(fillsRecorded: number): DomainProblem {
  return new DomainProblem(409, 'PHARMACY_FILL_NUMBER_CHANGED',
    'Another fill was recorded on this prescription since it was read. Reload it before recording a fill.',
    undefined, { extensions: { fillsRecorded } });
}

/** 409: no further fill (0152's NO_REFILLS_LEFT), or an item from another facility's order route. */
export function noRefillsLeft(): DomainProblem {
  return new DomainProblem(409, 'PHARMACY_NO_REFILLS_LEFT',
    'No refills are left on this prescription. Ask the prescriber for a new one.');
}

/** 409: a refill after the prescription's end date, the Lagos day (0152's REFILL_PRESCRIPTION_ENDED). */
export function refillPrescriptionEnded(): DomainProblem {
  return new DomainProblem(409, 'PHARMACY_REFILL_PRESCRIPTION_ENDED',
    'This prescription has ended. Ask the prescriber for a new one.');
}

/** 409: a refill asked of a pharmacy-api whose PRESCRIPTION_REFILLS_ENABLED is off (no HTTP body can ask it then). */
export function refillsNotRecorded(): DomainProblem {
  return new DomainProblem(409, 'PHARMACY_REFILLS_NOT_AVAILABLE',
    'Refills are not recorded here yet. Ask the prescriber for a new prescription.');
}

/** 409: the dispensing is not the item's latest fill; only the latest fill can be reversed. */
export function notLatestFill(): DomainProblem {
  return new DomainProblem(409, 'PHARMACY_DISPENSING_NOT_LATEST_FILL',
    'A later fill is recorded on this prescription. Only the latest fill can be reversed.');
}

/** 409: this member's Idempotency-Key at this facility recorded another dispensing. */
export function dispensingKeyConflict(): DomainProblem {
  return new DomainProblem(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used for another dispensing');
}

/**
 * 0152's two refill refusals (23514, by message), answered with their own
 * codes; anything else is undefined (the caller's mapping goes on).
 */
export function refillRefusal(error: unknown): DomainProblem | undefined {
  const { code, message } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown;
    message?: unknown };
  if (code !== '23514') return undefined;
  if (message === 'NO_REFILLS_LEFT') return noRefillsLeft();
  if (message === 'REFILL_PRESCRIPTION_ENDED') return refillPrescriptionEnded();
  return undefined;
}

/** A 23505 on one of pharmacy.dispensings' keys, by constraint name. */
export function dispensingKeyTaken(error: unknown, constraint: string): boolean {
  const found = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; constraint?: unknown };
  return found.code === '23505' && found.constraint === constraint;
}

/**
 * Validates a dispensing body with the class the setting picks:
 * CreateDispensingDto while off (today's checks and refusals, word for word),
 * CreateRefillDispensingDto while on, through the same validation the app
 * installs globally. The controller's body type is a union, so the global
 * pipe leaves the body to this one.
 */
@Injectable()
export class CreateDispensingBodyPipe implements PipeTransform<unknown, Promise<CreateDispensingInput>> {
  private readonly validation = createValidationPipe();

  constructor(@Optional() private readonly refills: PharmacyRefills = REFILLS_OFF) {}

  transform(value: unknown): Promise<CreateDispensingInput> {
    return this.validation.transform(value, { type: 'body', data: undefined,
      metatype: this.refills.enabled ? CreateRefillDispensingDto : CreateDispensingDto });
  }
}

function sqlState(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
}
