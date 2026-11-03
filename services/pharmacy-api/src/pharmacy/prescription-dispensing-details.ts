import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CARD_BATCH, day } from './order-route-cards';

/** A row of `pharmacy.work_item_prescription_details` (0114); the quantity as text. */
export interface PrescriptionDetailsRow {
  work_item_id: string;
  priority: string | null;
  medication_strength: string | null;
  medication_dose_form: string | null;
  duration_value: number | null;
  duration_unit: string | null;
  quantity_to_dispense: string | null;
  quantity_unit: string | null;
}

/** What an own work item adds while the details are on: each value there is, nothing for the others. */
export interface WorkItemDispensingDetails {
  priority?: string;
  strength?: string;
  doseForm?: string;
  duration?: { value: number; unit: string };
  quantityToDispense?: number;
  quantityUnit?: string;
}

/** The work-item columns the date fallback reads. */
interface WorkItemDates {
  order_route_id?: string | null;
  starts_on: string | Date | null;
  ends_on: string | Date | null;
}

const DAY_MS = 86_400_000;

/** Whole days from start to end, both included ('2026-11-02'..'2026-11-08' is 7); null when not a forward range. */
export function inclusiveDays(start: string | null, end: string | null): number | null {
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS + 1;
  return Number.isInteger(days) && days >= 1 ? days : null;
}

/**
 * The prescriber's priority, strength, dose form, duration and quantity to
 * dispense on this facility's own work (0114; owner decision 25 of 2026-11-01,
 * D-Eminence: "all recommended except D5", items 3b and 4; D9: the pharmacist
 * still confirms the quantity, and nothing compares the two).
 *
 * Behind PRESCRIPTION_DISPENSING_DETAILS_ENABLED (off by default). Off, it
 * reads nothing and adds nothing, so the work list and the work item are
 * exactly as before. On, it asks `pharmacy.work_item_prescription_details`
 * (the values of the prescription version Pharmacy accepted, from its
 * snapshot, for the session's own rows the member may read) in the caller's
 * transaction, in a savepoint, at most 200 ids a statement: a failure (a
 * schema without 0114, a refusal) leaves the rows without them and never fails
 * the answer. An own row's duration falls back to the whole days from its
 * start date to its end date when the prescription gave none and both are
 * set. Route-backed work gets nothing (item 4b, later). No audit row: no new
 * person is shown.
 */
export class PharmacyPrescriptionDetails {
  private readonly logger = new Logger(PharmacyPrescriptionDetails.name);

  constructor(readonly enabled: boolean) {}

  async details(client: PoolClient, workItemIds: readonly string[], correlationId: string):
  Promise<Map<string, PrescriptionDetailsRow>> {
    const found = new Map<string, PrescriptionDetailsRow>();
    if (!this.enabled || workItemIds.length === 0) return found;
    await client.query('savepoint pharmacy_prescription_details');
    try {
      for (let start = 0; start < workItemIds.length; start += CARD_BATCH) {
        const result = await client.query<PrescriptionDetailsRow>(
          `select work_item_id::text as work_item_id, priority, medication_strength, medication_dose_form,
                  duration_value, duration_unit, quantity_to_dispense::text as quantity_to_dispense, quantity_unit
             from pharmacy.work_item_prescription_details($1::uuid[])`,
          [workItemIds.slice(start, start + CARD_BATCH)],
        );
        for (const row of result.rows) found.set(row.work_item_id, row);
      }
      await client.query('release savepoint pharmacy_prescription_details');
    } catch (error) {
      await client.query('rollback to savepoint pharmacy_prescription_details');
      this.logger.warn({ message: 'Prescription details on own work could not be read', sqlState: sqlState(error),
        correlationId });
      return new Map();
    }
    return found;
  }

  /** What a work row adds: nothing while off or for route-backed work. */
  forRow(row: WorkItemDates, found: PrescriptionDetailsRow | undefined): WorkItemDispensingDetails | undefined {
    if (!this.enabled || row.order_route_id) return undefined;
    const quantity = found?.quantity_to_dispense == null ? null : Number(found.quantity_to_dispense);
    const fallback = inclusiveDays(day(row.starts_on), day(row.ends_on));
    const duration = found?.duration_value != null && found.duration_unit
      ? { value: Number(found.duration_value), unit: found.duration_unit }
      : fallback === null ? undefined : { value: fallback, unit: 'day' };
    return {
      ...(found?.priority ? { priority: found.priority } : {}),
      ...(found?.medication_strength ? { strength: found.medication_strength } : {}),
      ...(found?.medication_dose_form ? { doseForm: found.medication_dose_form } : {}),
      ...(duration ? { duration } : {}),
      ...(quantity !== null && Number.isFinite(quantity) && found?.quantity_unit
        ? { quantityToDispense: quantity, quantityUnit: found.quantity_unit } : {}),
    };
  }
}

/** Off: no statement and nothing added (the tests' and every caller's default). */
export const PRESCRIPTION_DETAILS_OFF = new PharmacyPrescriptionDetails(false);

function sqlState(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
}
