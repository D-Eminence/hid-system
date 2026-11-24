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
       refill_open, closed_reason, to_char(next_fill_on, 'YYYY-MM-DD') as next_fill_on
  from pharmacy.work_item_refills($1::uuid[])`;

/**
 * 0152's open refills, `pharmacy.open_refill_work_items()` (SECURITY DEFINER,
 * no ids): the session's own items whose refill is open now, by the per-item
 * reader's rule (the session's facility, pharmacy.work-item.read and the work
 * items' two read policies; a fill recorded and fewer than 1 + refills
 * allowed; the prescription active at the accepted version; its end date not
 * past in Lagos; the refill interval passed), the refill that opened first
 * first (then by id), at most 200. It starts from the facility's active
 * prescriptions that allow refills, so a refill that is open is found however
 * many items were filled after it. The list keeps its order among the open
 * refills. Exported for the tests.
 */
export const OPEN_REFILLS_QUERY = `select work_item_id::text as work_item_id
  from pharmacy.open_refill_work_items()`;

/** A row of 0152's reader (next_fill_on as YYYY-MM-DD, the Lagos day). */
export interface WorkItemRefillsRow {
  work_item_id: string;
  refills_allowed: number;
  fills_recorded: number;
  refill_open: boolean;
  closed_reason: string | null;
  next_fill_on?: string | null;
}

/**
 * Why no further fill can be recorded now (0152's reader); null while one is
 * open, and before the first fill. `not_yet`: the refill interval has not
 * passed (the clinical owner's rule, 24 November 2026); it opens on
 * `nextFillOn`.
 */
export type RefillsClosedReason = 'none_left' | 'changed' | 'stopped' | 'ended' | 'not_yet';
const CLOSED_REASONS: ReadonlySet<string> = new Set(['none_left', 'changed', 'stopped', 'ended', 'not_yet']);
const LAGOS_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The `refills` an item carries while refills are on:
 * - `allowed`: the refills the prescription allows (0-11; none given is 0);
 * - `recorded`: the fills recorded on the item, a reversed fill included;
 * - `open`: another fill may be recorded now ("Dispense" again);
 * - `closedReason`: why not, once at least one fill is recorded (null while
 *   open, and before the first fill); `not_yet` while the refill interval
 *   runs;
 * - `nextFillOn`: the Lagos day (YYYY-MM-DD) from which the next fill may be
 *   recorded: in the future while `not_yet` ("Refill from <date>"), today or
 *   earlier while open; null before the first fill and once closed for good.
 * The label "Fill 2 of 3" is fill `recorded` (or `recorded + 1` when
 * dispensing again) of `allowed + 1`.
 */
export interface WorkItemRefills {
  allowed: number;
  recorded: number;
  open: boolean;
  closedReason: RefillsClosedReason | null;
  nextFillOn: string | null;
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
 * - an own item with a refill open is open work on the list, of any age
 *   (0152's open refills, asked once before the rows are chosen, in a
 *   savepoint: a failure opens no item for a refill and never fails the list);
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
   * The work list's first step while on: the own items whose refill is open
   * now (OPEN_REFILLS_QUERY, at most 200), which the list then counts as open
   * work. One statement in a savepoint; a failure answers none (a warning).
   * The per-item reader is asked afterwards only about the rows the list
   * shows (read()). Nothing while off.
   */
  async openForList(client: PoolClient, correlationId: string): Promise<string[]> {
    if (!this.enabled) return [];
    await client.query('savepoint pharmacy_open_refills');
    try {
      const open = (await client.query<{ work_item_id: string }>(OPEN_REFILLS_QUERY)).rows.map((row) => row.work_item_id);
      await client.query('release savepoint pharmacy_open_refills');
      return open;
    } catch (error) {
      await client.query('rollback to savepoint pharmacy_open_refills');
      this.logger.warn({ message: 'Own work with refills open could not be read', sqlState: sqlState(error),
        correlationId });
      return [];
    }
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
      return { allowed: 0, recorded, open: false, closedReason: recorded > 0 ? 'none_left' : null, nextFillOn: null };
    }
    if (!found) return undefined;
    const closed = found.closed_reason;
    const next = found.next_fill_on;
    return { allowed: Number(found.refills_allowed), recorded: Number(found.fills_recorded),
      open: found.refill_open === true && closed === null,
      closedReason: closed !== null && CLOSED_REASONS.has(closed) ? closed as RefillsClosedReason : null,
      nextFillOn: typeof next === 'string' && LAGOS_DAY.test(next) ? next : null };
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

/**
 * 409: a refill before the refill interval has passed (0152's REFILL_TOO_SOON,
 * the clinical owner's rule of 24 November 2026: the Lagos day of the latest
 * fill not reversed plus 3/4 of the prescription's duration). `refillOpensOn`
 * is the Lagos day it opens (YYYY-MM-DD, the refusal's DETAIL), left out if
 * the DETAIL is not a day. No override: a clinician writes a new
 * prescription.
 */
export function refillTooSoon(opensOn: string | undefined): DomainProblem {
  const day = typeof opensOn === 'string' && LAGOS_DAY.test(opensOn) ? opensOn : undefined;
  return new DomainProblem(409, 'PHARMACY_REFILL_TOO_SOON',
    day ? `This refill is too early. It can be dispensed from ${day}.`
      : 'This refill is too early. Reload the prescription to see when it can be dispensed.',
    undefined, day ? { extensions: { refillOpensOn: day } } : undefined);
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
 * 0152's three refill refusals (23514, by message), answered with their own
 * codes; anything else is undefined (the caller's mapping goes on).
 */
export function refillRefusal(error: unknown): DomainProblem | undefined {
  const { code, message, detail } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown;
    message?: unknown; detail?: unknown };
  if (code !== '23514') return undefined;
  if (message === 'NO_REFILLS_LEFT') return noRefillsLeft();
  if (message === 'REFILL_PRESCRIPTION_ENDED') return refillPrescriptionEnded();
  if (message === 'REFILL_TOO_SOON') return refillTooSoon(typeof detail === 'string' ? detail : undefined);
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
