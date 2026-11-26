import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { CreatePrescriptionWithRefillsDto } from '../shared/clinical.dto';

/**
 * Refills on prescriptions (ORD-12; owner decision Q131 A, 19 November 2026;
 * the clinical owner's design note on hid-system#258, Rahman's review of it
 * and the clinical owner's answers, 23 November 2026; migration 0154, which
 * adds `ehr.prescriptions.refills_allowed`, nullable, CHECK 0-11).
 *
 * Behind PRESCRIPTION_REFILLS_ENABLED (off by default), separate from 0125's
 * PRESCRIPTION_DISPENSING_DETAILS_ENABLED and read the same way. Off, the
 * prescriptions routes are exactly as before: a create body is checked
 * without `refillsAllowed` (refused 400 VALIDATION_FAILED, "property
 * refillsAllowed should not exist"), no statement names the column, and no
 * answer carries it. On:
 * - a create may carry `refillsAllowed` (0-11; left out is stored as null,
 *   none), stored with the prescription; the update route never changes it;
 *   above 0 it needs a duration (requireDuration);
 * - every prescription answer of these routes (list, read, create, its
 *   replay, update) carries `refillsAllowed`, a number (null read as 0);
 * - the list says `refills: true`, so the website sends the field only to a
 *   backend that takes it.
 * The prescriber sees the refills allowed. How many are left, and whether one
 * is open, is the pharmacy's (pharmacy-api, 0154's reader): a change after the
 * first fill ends the remaining refills (0101's version check), and ehr-api
 * tells nobody that it did (0154 leaves ehr.withdraw_own_pharmacy_send and
 * 0133's steps as they are; the change is the prescriber's own).
 * The refills also end on their last day (the clinical owner's decision D9,
 * 24 November 2026; 0154's ehr.prescription_refills_end_on, the one place the
 * day is computed): the earliest of the end date, the Lagos day the
 * prescription was written (created_at, which ehr-api never changes) plus
 * (refills + 2) times one fill's duration in days (a day 1, a week 7, a month
 * 30), and that day plus 365. ehr-api answers no new field for it: the
 * prescribe form works the same day out from what it sends ("Refills can be
 * collected until <date>"), and pharmacy-api answers it as `refills.endsOn`.
 * One limit follows from it (Rahman's review of 25 November 2026; the
 * clinical owner's call on #258, 26 November 2026): a prescription whose
 * first refill could open only after that day can never have a refill
 * collected (one fill longer than 486 days, or an end date before the day
 * written plus the refill interval). The database would close it at the
 * first fill; ehr-api refuses it at create instead (requireCollectable,
 * 400 REFILLS_CANNOT_BE_COLLECTED), asking the database's own rule.
 */
/**
 * REFILLS_NEED_DURATION's words. With refills above 0, the duration (0125's
 * `durationValue` and `durationUnit`) is how long ONE fill lasts, not the
 * whole course: each refill opens 3/4 of it after the latest fill not
 * reversed (0154), so a course length entered there would hold every refill
 * back for weeks after the supply ran out. Exported for the tests.
 */
export const REFILLS_NEED_DURATION_MESSAGE = 'A prescription with refills needs the duration of each fill: how long '
  + 'one supply lasts, not the whole course. Add it, or set refills to 0.';

/**
 * Whether any refill of a prescription just written could ever be collected,
 * by the database's own rule, on the row as stored (so on the very values
 * 0154's dispensing check, reader and open refills use): the refills' last
 * day is 0154's `ehr.prescription_refills_end_on` (R8, which the EHR runtime
 * may execute), and the earliest a refill can open is the Lagos day the
 * prescription was written (the earliest first fill) plus 0154's refill
 * interval, 3/4 of one fill's duration in days rounded up, at least 1 (the
 * expression of 0154's dispensing check, pharmacy.validate_dispensing, with
 * the prescription's own columns; prescription-refills.spec.ts pins that it
 * is the same text). Never collectable when that day is after the last day.
 * Exported for the tests.
 */
export const REFILLS_COLLECTABLE_QUERY = `select first_refill_on > refills_end_on as "neverCollectable",
  to_char(refills_end_on, 'YYYY-MM-DD') as "refillsEndOn", to_char(first_refill_on, 'YYYY-MM-DD') as "firstRefillOn"
  from (select ehr.prescription_refills_end_on(p.created_at, p.refills_allowed, p.duration_value, p.duration_unit,
                 p.ends_on) as refills_end_on,
               (p.created_at at time zone 'Africa/Lagos')::date
                 + greatest(1, ceil(0.75 * p.duration_value
                     * case p.duration_unit when 'week' then 7 when 'month' then 30 else 1 end))::integer
                 as first_refill_on
          from ehr.prescriptions p where p.id = $1::uuid) refills`;

/** REFILLS_CANNOT_BE_COLLECTED's words, with the two days. Exported for the tests. */
export function refillsCannotBeCollectedMessage(refillsEndOn: string, firstRefillOn: string): string {
  return `No refill of this prescription could ever be collected: refills end on ${refillsEndOn}, before the first `
    + `refill would be due (${firstRefillOn} at the earliest). Use a shorter duration of each fill or a later end `
    + 'date, or set refills to 0.';
}

export class PrescriptionRefills {
  constructor(readonly enabled: boolean) {}

  /** Appended to the prescription SELECT and RETURNING lists: nothing while off. */
  selectList(): string {
    return this.enabled ? ', refills_allowed as "refillsAllowed"' : '';
  }

  /** A row as the EHR answers it: `refillsAllowed` after the other fields, null as 0. Off, the row itself. */
  project<Row extends object>(row: Row): Row & { refillsAllowed?: number } {
    if (!this.enabled) return row;
    const { refillsAllowed, ...rest } = row as Row & { refillsAllowed?: number | string | null };
    return { ...rest, refillsAllowed: refillsAllowed == null ? 0 : Number(refillsAllowed) } as Row & { refillsAllowed: number };
  }

  /**
   * The clinical owner's rule (24 November 2026): a prescription with refills
   * carries a duration, from which the refill interval comes (0154: a refill
   * opens on the Lagos day of the latest fill not reversed plus 3/4 of the
   * duration in days, rounded up). With refills, the duration is how long one
   * fill lasts (a 30-day supply refilled from day 23), and the refusal says
   * so (REFILLS_NEED_DURATION_MESSAGE). `refillsAllowed` above 0 without 0125's
   * `durationValue` and `durationUnit` is 400 REFILLS_NEED_DURATION before
   * anything is written; 0154's CHECK refuses it in the database too. A create
   * carries a duration only while PRESCRIPTION_DISPENSING_DETAILS_ENABLED is
   * on as well, so with that setting off only 0 refills can be written.
   * Nothing while off.
   */
  requireDuration(input: object): void {
    if (!this.enabled) return;
    const { refillsAllowed, durationValue, durationUnit } = input as { refillsAllowed?: number | null;
      durationValue?: number | null; durationUnit?: string | null };
    if ((refillsAllowed ?? 0) > 0 && (durationValue == null || durationUnit == null)) {
      throw new DomainProblem(400, 'REFILLS_NEED_DURATION', REFILLS_NEED_DURATION_MESSAGE);
    }
  }

  /**
   * The clinical owner's call (26 November 2026): a prescription with refills
   * none of which could ever be collected is refused at create, 400
   * REFILLS_CANNOT_BE_COLLECTED, with the refills' last day and the earliest
   * day a first refill could open (as `refillsEndOn` and `firstRefillOn`), by
   * the database's own rule (REFILLS_COLLECTABLE_QUERY) on the row just
   * inserted, in the create's transaction, before the send to the pharmacy;
   * the refusal rolls the whole create back (idempotency key included), as
   * 0117's allergy check does. Only while on, and only with refills above 0
   * (requireDuration has made sure there is a duration). Nothing while off.
   */
  async requireCollectable(client: Pick<PoolClient, 'query'>, prescriptionId: string, input: object): Promise<void> {
    if (!this.enabled || ((input as { refillsAllowed?: number | null }).refillsAllowed ?? 0) <= 0) return;
    const { rows } = await client.query<{ neverCollectable: boolean | null; refillsEndOn: string | null;
      firstRefillOn: string | null }>(REFILLS_COLLECTABLE_QUERY, [prescriptionId]);
    const answer = rows[0];
    if (answer?.neverCollectable === true && answer.refillsEndOn && answer.firstRefillOn) {
      throw new DomainProblem(400, 'REFILLS_CANNOT_BE_COLLECTED',
        refillsCannotBeCollectedMessage(answer.refillsEndOn, answer.firstRefillOn), undefined,
        { refillsEndOn: answer.refillsEndOn, firstRefillOn: answer.firstRefillOn });
    }
  }

  /** The prescriptions list's served flag: present only while on. */
  flag(): { refills?: true } {
    return this.enabled ? { refills: true } : {};
  }

  /**
   * What the Idempotency-Key digest covers: the body without a
   * `refillsAllowed` it does not carry (the DTO keeps an absent optional field
   * as an own undefined property), so a body without it hashes as before this
   * release and a retry across the deploy replays.
   */
  digestInput(input: object): object {
    if (!this.enabled) return input;
    return Object.fromEntries(Object.entries(input).filter(([field, value]) => !(field === 'refillsAllowed'
      && value === undefined)));
  }

  /** The INSERT's extra column while on: none while off. */
  insertColumns(): string {
    return this.enabled ? ', refills_allowed' : '';
  }

  /** Its placeholder, `$<next>` after the columns before it: none while off. */
  insertPlaceholders(next: number): string {
    return this.enabled ? `,$${next}` : '';
  }

  insertValues(input: object): unknown[] {
    return this.enabled ? [(input as CreatePrescriptionWithRefillsDto).refillsAllowed ?? null] : [];
  }
}

/** Off: exactly today (the tests' and every direct caller's default). */
export const PRESCRIPTION_REFILLS_OFF = new PrescriptionRefills(false);
