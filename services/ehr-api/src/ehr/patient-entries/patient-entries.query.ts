import type { PoolClient } from 'pg';
import type { PatientEntryKind } from './patient-entries.dto';

/** One record the patient added, as the records answer and the staff read list it. */
export interface PatientEntryItem {
  id: string;
  source: 'patient';
  kind: PatientEntryKind;
  title: string;
  facilityName: string | null;
  /** YYYY-MM-DD, the calendar date as entered. */
  occurredOn: string;
  notes: string | null;
  createdAt: string;
  /** Photos and files come with a later migration; none yet. */
  documents: [];
}

export interface PatientEntryPage {
  items: PatientEntryItem[];
  more: boolean;
}

export const PATIENT_ENTRIES_LIMIT = 50;

interface PatientEntryRow {
  id: string;
  kind: PatientEntryKind;
  title: string;
  facility_name: string | null;
  occurred_on: string;
  notes: string | null;
  created_at: Date | string;
}

export function patientEntryItem(row: PatientEntryRow): PatientEntryItem {
  return { id: row.id, source: 'patient', kind: row.kind, title: row.title, facilityName: row.facility_name,
    occurredOn: row.occurred_on, notes: row.notes, createdAt: new Date(row.created_at).toISOString(), documents: [] };
}

/**
 * The patient's active entries, newest first (the date entered, then when it
 * was added), at most 50, and whether there are more. Row-level security
 * (0116's read policy) limits the rows to the patient's own session or a
 * clinician whose access is granted; withdrawn ones are never read. The date
 * is read as text: node-postgres turns a date into local midnight.
 */
export async function readPatientEntries(client: Pick<PoolClient, 'query'>, patientId: string): Promise<PatientEntryPage> {
  const rows = (await client.query<PatientEntryRow>(`select id, kind, title, facility_name, occurred_on::text as occurred_on,
      notes, created_at
    from ehr.patient_entries
    where patient_id = $1 and status = 'active'
    order by occurred_on desc, created_at desc, id desc
    limit ${PATIENT_ENTRIES_LIMIT + 1}`, [patientId])).rows;
  return { items: rows.slice(0, PATIENT_ENTRIES_LIMIT).map(patientEntryItem), more: rows.length > PATIENT_ENTRIES_LIMIT };
}
