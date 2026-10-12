import { VITAL_STORAGE_KEYS } from './vitals.service';

/**
 * SQL for a vital's current values (INTERFACE_CONTRACT.md §11, "Vital corrections").
 *
 * A correction appends a replacement set to ehr.vital_corrections and moves
 * ehr.vitals.current_correction_no to it; the recorded columns never change.
 * Current default semantics, the same as the Health-id provider chart:
 * - with no correction (current_correction_no = 0), the current values are the recorded ones;
 * - otherwise they are exactly the replacement set of the correction numbered current_correction_no:
 *   a measurement that correction omits is not current (null). Corrections are not merged with each
 *   other or with the recorded row;
 * - if that correction cannot be read, every measurement is null and correctionUnavailable is true.
 *   Recorded values are never passed off as current.
 *
 * Each value is cast to its column's type, so it reads as a recorded value does (numeric as a
 * string, smallint as a number). A replacement value that does not cast fails the whole statement.
 */
const VITAL_SQL_TYPES: Readonly<Record<keyof typeof VITAL_STORAGE_KEYS, string>> = {
  heightCm: 'numeric(6,2)',
  weightKg: 'numeric(7,3)',
  temperatureC: 'numeric(4,1)',
  pulseBpm: 'smallint',
  respiratoryRate: 'smallint',
  systolicMmhg: 'smallint',
  diastolicMmhg: 'smallint',
  oxygenSaturationPercent: 'numeric(5,2)',
};

/** [API key, column and correction key, column type] for each of the eight measurements, in storage order. */
export const VITAL_MEASUREMENTS: ReadonlyArray<readonly [string, string, string]> = Object.entries(VITAL_STORAGE_KEYS)
  .map(([key, column]) => [key, column, VITAL_SQL_TYPES[key as keyof typeof VITAL_STORAGE_KEYS]] as const);

/** Joins the vital's current correction only: same vital, patient and facility, numbered current_correction_no. */
export function currentVitalJoin(vital: string, correction: string): string {
  const v = alias(vital);
  const c = alias(correction);
  return `left join ehr.vital_corrections ${c} on ${c}.vital_id=${v}.id`
    + ` and ${c}.patient_id=${v}.patient_id and ${c}.facility_id=${v}.facility_id`
    + ` and ${c}.correction_no=${v}.current_correction_no and ${v}.current_correction_no>0`;
}

/** The eight current measurements, currentCorrectionNo, correctedAt and correctionUnavailable. */
export function currentVitalProjection(vital: string, correction: string): string {
  const v = alias(vital);
  const c = alias(correction);
  const measurements = VITAL_MEASUREMENTS.map(([key, column, type]) =>
    `case when ${v}.current_correction_no=0 then ${v}.${column}`
    + ` when ${c}.id is not null then (${c}.replacement_values->>'${column}')::${type} end as "${key}"`);
  return [
    ...measurements,
    `${v}.current_correction_no as "currentCorrectionNo"`,
    `${c}.created_at as "correctedAt"`,
    `(${v}.current_correction_no>0 and ${c}.id is null) as "correctionUnavailable"`,
  ].join(',');
}

/** The measurements as first recorded, as a JSON object, for a corrected vital only (null otherwise). */
export function recordedVitalProjection(vital: string): string {
  const v = alias(vital);
  const pairs = VITAL_MEASUREMENTS.map(([key, column]) => `'${key}',${v}.${column}`).join(',');
  return `case when ${v}.current_correction_no>0 then jsonb_build_object(${pairs}) end as "recordedValues"`;
}

function alias(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Invalid SQL alias');
  return value;
}
