import { DomainProblem } from '../../common/problem';
import { getEnvironment } from '../../config/environment';
import type { VitalMeasurementsDto } from '../shared/clinical.dto';

/**
 * NUR-1 (0174, owner decisions Q195 A and Q199 A; Q-NUR-7 A): the observation
 * chart's fields on today's vitals. They are entered wherever vitals are
 * entered (Triage & Vitals and the ward chart), one vitals history, once
 * NURSING_ENABLED is on. Off, a reading carrying any of them is refused with
 * 400 NURSING_FIELDS_NOT_AVAILABLE and every vitals answer is exactly as
 * before. No early-warning or severity score is ever computed from them.
 */
export const OBSERVATION_FIELD_KEYS = {
  painScore: 'pain_score',
  avpu: 'avpu',
  bloodGlucoseMmolL: 'blood_glucose_mmol_l',
  oxygenDevice: 'oxygen_device',
  oxygenFlowLPerMin: 'oxygen_flow_l_per_min',
  fio2Percent: 'fio2_percent',
  gcsEye: 'gcs_eye',
  gcsVerbal: 'gcs_verbal',
  gcsVerbalNotTestable: 'gcs_verbal_not_testable',
  gcsMotor: 'gcs_motor',
} as const;

export type ObservationField = keyof typeof OBSERVATION_FIELD_KEYS;
export const OBSERVATION_FIELDS = Object.keys(OBSERVATION_FIELD_KEYS) as ObservationField[];

export const OBSERVATION_MESSAGES = {
  notAvailable: 'These fields are not switched on yet.',
  oxygen: 'Enter the flow or FiO2 with an oxygen device, or 21% on room air.',
  gcs: 'Enter all three GCS parts, or mark the verbal part as not testable.',
} as const;

/** Whether the new fields are on (NURSING_ENABLED and INPATIENT_ENABLED); off when the configuration cannot be read. */
export function observationFieldsEnabled(): boolean {
  try {
    const environment = getEnvironment();
    return environment.NURSING_ENABLED && environment.INPATIENT_ENABLED;
  } catch {
    return false;
  }
}

/**
 * The new fields as a vitals answer adds them, read through the whole row so
 * a database without 0174 answers nulls (only while the flag is on: off, the
 * answer has none of these keys). `alias` is a table alias written by this
 * code, never input.
 */
export function observationColumnsSql(alias: string): string {
  if (!/^[a-z_]+$/.test(alias)) throw new Error('A table alias is required');
  const row = `to_jsonb(${alias})`;
  return `,
  (${row}->>'pain_score')::smallint as "painScore", ${row}->>'avpu' as "avpu",
  (${row}->>'blood_glucose_mmol_l')::numeric as "bloodGlucoseMmolL", ${row}->>'oxygen_device' as "oxygenDevice",
  (${row}->>'oxygen_flow_l_per_min')::numeric as "oxygenFlowLPerMin", (${row}->>'fio2_percent')::smallint as "fio2Percent",
  (${row}->>'gcs_eye')::smallint as "gcsEye", (${row}->>'gcs_verbal')::smallint as "gcsVerbal",
  (${row}->>'gcs_verbal_not_testable')::boolean as "gcsVerbalNotTestable", (${row}->>'gcs_motor')::smallint as "gcsMotor"`;
}

export type ObservationValues = Partial<Record<ObservationField, number | string | boolean | null>>;

function given(value: ObservationValues, field: ObservationField): boolean {
  return value[field] !== undefined && value[field] !== null;
}

/** Whether a reading or correction carries any of the new fields. */
export function hasObservationFields(value: VitalMeasurementsDto | ObservationValues): boolean {
  return OBSERVATION_FIELDS.some((field) => given(value as ObservationValues, field));
}

/** Refuses the new fields while the flag is off (400 NURSING_FIELDS_NOT_AVAILABLE). */
export function requireObservationFieldsAllowed(value: VitalMeasurementsDto | ObservationValues, enabled: boolean): void {
  if (!enabled && hasObservationFields(value)) {
    throw new DomainProblem(400, 'NURSING_FIELDS_NOT_AVAILABLE', OBSERVATION_MESSAGES.notAvailable);
  }
}

/**
 * The oxygen and GCS rules on a whole reading (for a correction: the values
 * after it), as 0174's CHECKs hold them: a flow or FiO2 only with a device; on
 * room air no flow and FiO2 21 only; the three GCS parts or none, the verbal
 * part replaced by "not testable".
 */
export function checkObservationRules(value: ObservationValues): void {
  const device = value.oxygenDevice ?? null;
  if ((device === null && (given(value, 'oxygenFlowLPerMin') || given(value, 'fio2Percent')))
    || (device === 'room_air' && (given(value, 'oxygenFlowLPerMin')
      || (given(value, 'fio2Percent') && Number(value.fio2Percent) !== 21)))) {
    throw new DomainProblem(400, 'OXYGEN_FIELDS_INVALID', OBSERVATION_MESSAGES.oxygen);
  }
  const eye = given(value, 'gcsEye');
  const motor = given(value, 'gcsMotor');
  const verbal = given(value, 'gcsVerbal');
  const notTestable = value.gcsVerbalNotTestable === true;
  const anyGcs = eye || motor || verbal || notTestable;
  if (anyGcs && !(eye && motor && verbal !== notTestable)) {
    throw new DomainProblem(400, 'GCS_INCOMPLETE', OBSERVATION_MESSAGES.gcs);
  }
}

/** The new fields of a create, as the INSERT stores them (GCS "not testable" false when a GCS is given without it). */
export function observationInsertValues(value: VitalMeasurementsDto): unknown[] {
  const hasGcs = value.gcsEye !== undefined;
  return [value.painScore ?? null, value.avpu ?? null, value.bloodGlucoseMmolL ?? null, value.oxygenDevice ?? null,
    value.oxygenFlowLPerMin ?? null, value.fio2Percent ?? null, value.gcsEye ?? null, value.gcsVerbal ?? null,
    hasGcs ? value.gcsVerbalNotTestable === true : null, value.gcsMotor ?? null];
}

export const OBSERVATION_INSERT_COLUMNS = 'pain_score, avpu, blood_glucose_mmol_l, oxygen_device, oxygen_flow_l_per_min, '
  + 'fio2_percent, gcs_eye, gcs_verbal, gcs_verbal_not_testable, gcs_motor';
