import type { CreatePrescriptionWithRefillsDto } from '../shared/clinical.dto';

/**
 * Refills on prescriptions (ORD-12; owner decision Q131 A, 19 November 2026;
 * the clinical owner's design note on hid-system#258, Rahman's review of it
 * and the clinical owner's answers, 23 November 2026; migration 0152, which
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
 * - every prescription answer of these routes (list, read, create, its
 *   replay, update) carries `refillsAllowed`, a number (null read as 0);
 * - the list says `refills: true`, so the website sends the field only to a
 *   backend that takes it.
 * The prescriber sees the refills allowed. How many are left, and whether one
 * is open, is the pharmacy's (pharmacy-api, 0152's reader): a change after the
 * first fill ends the remaining refills (0101's version check), and ehr-api
 * tells nobody that it did (0152 leaves ehr.withdraw_own_pharmacy_send and
 * 0133's steps as they are; the change is the prescriber's own).
 */
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
