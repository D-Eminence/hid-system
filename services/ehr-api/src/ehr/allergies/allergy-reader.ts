import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { allergyTerms, matchAllergies, normalizeMedicineText, type AllergyForCheck,
  type AllergyMatch } from './allergy-match';

export interface RecordedAllergyRow extends QueryResultRow {
  id: string;
  patientId: string;
  facilityId: string;
  createdBy: string;
  createdByMembershipId: string;
  substance: string;
  reaction: string | null;
  severity: string;
  status: 'active' | 'entered_in_error';
  enteredInErrorBy: string | null;
  enteredInErrorAt: Date | null;
  enteredInErrorReason: string | null;
  rowVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export const RECORDED_ALLERGY_COLUMNS = `
  id, patient_id as "patientId", facility_id as "facilityId", created_by as "createdBy",
  created_by_membership_id as "createdByMembershipId", substance, reaction, severity, status,
  entered_in_error_by as "enteredInErrorBy", entered_in_error_at as "enteredInErrorAt",
  entered_in_error_reason as "enteredInErrorReason", row_version as "rowVersion",
  created_at as "createdAt", updated_at as "updatedAt"`;

export interface PatientReportedAllergies {
  /** The patient's own text (0094), or null when they entered none. */
  text: string | null;
  updatedAt: Date | null;
}

/**
 * Everything the allergy check reads, inside the caller's transaction (forced
 * RLS: the clinician's access to the patient at the current facility): the
 * active recorded allergies (any facility, with where and when each was
 * recorded) and the patient's own allergy text.
 */
export async function allergiesForCheck(
  client: PoolClient, patientId: string, facilityId: string,
): Promise<AllergyForCheck[]> {
  const recorded = await client.query<{
    id: string; substance: string; reaction: string | null; severity: string;
    facility_id?: string; created_at?: Date | string;
  }>(
    `select id, substance, reaction, severity, facility_id, created_at from ehr.recorded_allergies
     where patient_id = $1 and status = 'active' order by created_at, id`,
    [patientId],
  );
  const reported = await patientReportedAllergies(client, patientId);
  return [
    ...recorded.rows.map((row) => ({ source: 'recorded' as const, id: row.id, substance: row.substance,
      reaction: row.reaction, severity: row.severity,
      ...(row.facility_id ? { facilityId: row.facility_id, recordedHere: row.facility_id === facilityId } : {}),
      ...(row.created_at ? { recordedOn: new Date(row.created_at) } : {}) })),
    ...(reported.text && allergyTerms(reported.text).length > 0
      ? [{ source: 'patient_reported' as const, substance: reported.text }] : []),
  ];
}

export async function patientReportedAllergies(client: PoolClient, patientId: string): Promise<PatientReportedAllergies> {
  const result = await client.query<{ allergies: string | null; updated_at: Date | null }>(
    'select allergies, updated_at from ehr.patient_reported_health_profiles where patient_id = $1',
    [patientId],
  );
  const row = result.rows[0];
  return { text: row?.allergies ?? null, updatedAt: row?.updated_at ?? null };
}

export async function checkMedicineAgainstAllergies(
  client: PoolClient, patientId: string, facilityId: string, medicine: { display: string; code?: string | null },
): Promise<AllergyMatch[]> {
  return matchAllergies(medicine, await allergiesForCheck(client, patientId, facilityId));
}

/**
 * Names exactly the warning a prescriber was shown: the sha256 (hex) of the
 * sorted allergies that matched (a recorded allergy by id, the patient's own
 * text by its normalized term). A reason given for one warning is refused for
 * another (a new allergy recorded meanwhile, or a changed medicine).
 */
export function warningToken(matches: readonly AllergyMatch[]): string {
  const pairs = matches.flatMap((match) => match.source === 'recorded'
    ? (match.allergyIds ?? (match.allergyId ? [match.allergyId] : [])).map((id) => [match.source, id])
    : [[match.source, normalizeMedicineText(match.substance).trim()]]);
  // JSON.stringify of the sorted pairs.
  const sorted = pairs.map((pair) => JSON.stringify(pair)).sort();
  return createHash('sha256').update(`[${sorted.join(',')}]`).digest('hex');
}
