import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CARD_BATCH, day, type WorkItemRoutePatient } from './order-route-cards';

/** A row of `pharmacy.work_item_patient_cards` (0113). */
export interface OwnWorkPatientCardRow {
  work_item_id: string;
  patient_full_name: string | null;
  patient_sex: string | null;
  patient_date_of_birth: string | Date | null;
  patient_health_id_last4: string | null;
}

/** An own-work row's patient as the work list shows it: the shape a route-backed row's patient has. */
export function ownWorkPatient(row: OwnWorkPatientCardRow): WorkItemRoutePatient | undefined {
  if (!row.patient_full_name) return undefined;
  return { fullName: row.patient_full_name, sex: row.patient_sex, dateOfBirth: day(row.patient_date_of_birth),
    healthIdLast4: row.patient_health_id_last4 };
}

/**
 * The patient on this facility's own work (0113; owner decision 25 of
 * 2026-11-01, D-Eminence: "all recommended except D5", D8 emergency
 * included): name, sex, date of birth and Health ID ending, as a route-backed
 * row already shows them, so staff of a stand-alone pharmacy can match a
 * medicine to the person in front of them.
 *
 * Behind OWN_WORK_PATIENT_CARD_ENABLED (off by default). Off, it reads
 * nothing and answers no patient, so the work list, the work item and their
 * audit rows are exactly as before. On, it asks `pharmacy.work_item_patient_cards`
 * (the session's own rows the member may read: pharmacy.work-item.read here and
 * the read consent test of the work items' read policy) in the caller's
 * transaction, in a savepoint, at most 200 ids a statement: a failure (a
 * schema without 0113, a refusal) leaves the rows without a patient and never
 * fails the answer.
 */
export class PharmacyOwnWorkPatientCards {
  private readonly logger = new Logger(PharmacyOwnWorkPatientCards.name);

  constructor(readonly enabled: boolean) {}

  async patients(client: PoolClient, workItemIds: readonly string[], correlationId: string):
  Promise<Map<string, WorkItemRoutePatient>> {
    const found = new Map<string, WorkItemRoutePatient>();
    if (!this.enabled || workItemIds.length === 0) return found;
    await client.query('savepoint pharmacy_own_work_patient_cards');
    try {
      for (let start = 0; start < workItemIds.length; start += CARD_BATCH) {
        const result = await client.query<OwnWorkPatientCardRow>(
          `select work_item_id::text as work_item_id, patient_full_name, patient_sex,
                  patient_date_of_birth::text as patient_date_of_birth, patient_health_id_last4
             from pharmacy.work_item_patient_cards($1::uuid[])`,
          [workItemIds.slice(start, start + CARD_BATCH)],
        );
        for (const row of result.rows) {
          const patient = ownWorkPatient(row);
          if (patient) found.set(row.work_item_id, patient);
        }
      }
      await client.query('release savepoint pharmacy_own_work_patient_cards');
    } catch (error) {
      await client.query('rollback to savepoint pharmacy_own_work_patient_cards');
      this.logger.warn({ message: 'Patients on own work could not be read', sqlState: sqlState(error), correlationId });
      return new Map();
    }
    return found;
  }
}

/** Off: no statement and no patient (the tests' and every caller's default). */
export const OWN_WORK_PATIENT_CARDS_OFF = new PharmacyOwnWorkPatientCards(false);

function sqlState(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
}
