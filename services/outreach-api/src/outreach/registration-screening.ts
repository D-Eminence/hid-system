import { DomainProblem } from '../common/problem';
import type { BloodGroup, Genotype, SaveRegistrationScreeningDto } from './dto/registration-screening.dto';

/** One medicine given, as saved and answered. */
export interface ScreeningMedicine { name: string; dose: string | null }

/** The screening fields a save carries, each null when not given (0118). */
export interface ScreeningFields {
  bpSystolic: number | null;
  bpDiastolic: number | null;
  pulseBpm: number | null;
  temperatureC: number | null;
  weightKg: number | null;
  heightCm: number | null;
  glucoseValue: number | null;
  glucoseUnit: 'mmol/L' | 'mg/dL' | null;
  glucoseTiming: 'fasting' | 'random' | null;
  malariaRdt: 'positive' | 'negative' | 'not_done' | null;
  hearingLeft: 'pass' | 'refer' | 'not_done' | null;
  hearingRight: 'pass' | 'refer' | 'not_done' | null;
  mainComplaint: string | null;
  seenByClinician: boolean | null;
  clinicianName: string | null;
  outcome: string | null;
  medicinesGiven: ScreeningMedicine[];
  referred: boolean | null;
  referredTo: string | null;
  /**
   * Since 0122: absent when the save did not carry it (an update then keeps
   * the recorded value), null to leave it empty or clear it.
   */
  genotype?: Genotype | null;
  bloodGroup?: BloodGroup | null;
}

/** The screening of an outreach registration as the API answers it. */
export interface RegistrationScreening extends ScreeningFields {
  /**
   * Since 0122: answered (null when not recorded) when the database has
   * 0122's columns, left out when it does not, so a website never takes a
   * screening without them as a sign that the service records them.
   */
  genotype?: Genotype | null;
  bloodGroup?: BloodGroup | null;
  caseId: string;
  version: number;
  recordedAt: string;
  recordedByMembershipId: string;
  updatedAt: string;
}

export interface ScreeningRow {
  registration_case_id: string;
  bp_systolic: number | null;
  bp_diastolic: number | null;
  pulse_bpm: number | null;
  temperature_c: string | number | null;
  weight_kg: string | number | null;
  height_cm: number | null;
  glucose_value: string | number | null;
  glucose_unit: ScreeningFields['glucoseUnit'];
  glucose_timing: ScreeningFields['glucoseTiming'];
  malaria_rdt: ScreeningFields['malariaRdt'];
  hearing_left: ScreeningFields['hearingLeft'];
  hearing_right: ScreeningFields['hearingRight'];
  main_complaint: string | null;
  seen_by_clinician: boolean | null;
  clinician_name: string | null;
  outcome: string | null;
  medicines_given: unknown;
  referred: boolean | null;
  referred_to: string | null;
  /** 0122's columns (absent only on a row read before 0122). */
  genotype?: Genotype | null;
  blood_group?: BloodGroup | null;
  version: string | number;
  recorded_at: Date | string;
  recorded_by_membership_id: string;
  updated_at: Date | string;
  idempotency_key: string;
  request_sha256: string;
}

const text = (value: string | null | undefined): string | null => {
  const trimmed = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return trimmed === '' ? null : trimmed;
};
const nullable = <Value>(value: Value | null | undefined): Value | null => value ?? null;
const decimal = (value: string | number | null): number | null => value === null ? null : Number(value);

/**
 * A save body with every 0118 field present (null when not given), texts
 * trimmed. Genotype and blood group (0122) are present only when the body
 * carried them (null included), so a body without them digests as before.
 */
export function normalizeScreening(input: SaveRegistrationScreeningDto): ScreeningFields {
  return {
    bpSystolic: nullable(input.bpSystolic),
    bpDiastolic: nullable(input.bpDiastolic),
    pulseBpm: nullable(input.pulseBpm),
    temperatureC: nullable(input.temperatureC),
    weightKg: nullable(input.weightKg),
    heightCm: nullable(input.heightCm),
    glucoseValue: nullable(input.glucoseValue),
    glucoseUnit: nullable(input.glucoseUnit),
    glucoseTiming: nullable(input.glucoseTiming),
    malariaRdt: nullable(input.malariaRdt),
    hearingLeft: nullable(input.hearingLeft),
    hearingRight: nullable(input.hearingRight),
    mainComplaint: text(input.mainComplaint),
    seenByClinician: nullable(input.seenByClinician),
    clinicianName: text(input.clinicianName),
    outcome: text(input.outcome),
    medicinesGiven: (input.medicinesGiven ?? []).map((medicine) => ({
      name: text(medicine.name) ?? '', dose: text(medicine.dose) })),
    referred: nullable(input.referred),
    referredTo: text(input.referredTo),
    ...(input.genotype === undefined ? {} : { genotype: input.genotype }),
    ...(input.bloodGroup === undefined ? {} : { bloodGroup: input.bloodGroup }),
  };
}

function incomplete(detail: string): DomainProblem {
  return new DomainProblem(422, 'OUTREACH_SCREENING_INCOMPLETE', detail);
}

function outOfRange(detail: string): DomainProblem {
  return new DomainProblem(422, 'OUTREACH_SCREENING_OUT_OF_RANGE', detail);
}

function within(value: number | null, minimum: number, maximum: number): boolean {
  return value === null || (value >= minimum && value <= maximum);
}

/**
 * The pairs and plausible ranges 0118's checks enforce, answered in plain
 * words before anything is written: 422 OUTREACH_SCREENING_INCOMPLETE for a
 * missing partner field, 422 OUTREACH_SCREENING_OUT_OF_RANGE for a typo.
 */
export function assertScreeningPlausible(fields: ScreeningFields): void {
  if ((fields.bpSystolic === null) !== (fields.bpDiastolic === null)) {
    throw incomplete('Enter both blood pressure numbers (systolic and diastolic), or leave both empty.');
  }
  const glucoseParts = [fields.glucoseValue, fields.glucoseUnit, fields.glucoseTiming];
  if (glucoseParts.some((part) => part !== null) && glucoseParts.some((part) => part === null)) {
    throw incomplete('Enter the blood sugar value with its unit (mmol/L or mg/dL) and whether it was fasting or random, '
      + 'or leave all three empty.');
  }
  if (fields.referredTo !== null && fields.referred !== true) {
    throw incomplete('Tick "referred" to say where the person was referred, or leave "referred to" empty.');
  }
  if (!within(fields.bpSystolic, 50, 300)) {
    throw outOfRange('Check the blood pressure: systolic must be 50–300 mmHg.');
  }
  if (!within(fields.bpDiastolic, 20, 200)) {
    throw outOfRange('Check the blood pressure: diastolic must be 20–200 mmHg.');
  }
  if (fields.bpSystolic !== null && fields.bpDiastolic !== null && fields.bpDiastolic >= fields.bpSystolic) {
    throw outOfRange('Check the blood pressure: diastolic must be lower than systolic.');
  }
  if (!within(fields.pulseBpm, 20, 250)) throw outOfRange('Check the pulse: it must be 20–250 beats per minute.');
  if (!within(fields.temperatureC, 30, 45)) throw outOfRange('Check the temperature: it must be 30.0–45.0 °C.');
  if (!within(fields.weightKg, 0.5, 400)) throw outOfRange('Check the weight: it must be 0.5–400 kg.');
  if (!within(fields.heightCm, 30, 250)) throw outOfRange('Check the height: it must be 30–250 cm.');
  if (fields.glucoseUnit === 'mmol/L' && !within(fields.glucoseValue, 1, 40)) {
    throw outOfRange('Check the blood sugar: in mmol/L it must be 1.0–40.0.');
  }
  if (fields.glucoseUnit === 'mg/dL' && !within(fields.glucoseValue, 18, 720)) {
    throw outOfRange('Check the blood sugar: in mg/dL it must be 18–720.');
  }
}

export function registrationScreening(row: ScreeningRow): RegistrationScreening {
  const medicines = Array.isArray(row.medicines_given) ? row.medicines_given as { name?: unknown; dose?: unknown }[] : [];
  return {
    caseId: row.registration_case_id,
    bpSystolic: row.bp_systolic === null ? null : Number(row.bp_systolic),
    bpDiastolic: row.bp_diastolic === null ? null : Number(row.bp_diastolic),
    pulseBpm: row.pulse_bpm === null ? null : Number(row.pulse_bpm),
    temperatureC: decimal(row.temperature_c),
    weightKg: decimal(row.weight_kg),
    heightCm: row.height_cm === null ? null : Number(row.height_cm),
    glucoseValue: decimal(row.glucose_value),
    glucoseUnit: row.glucose_unit,
    glucoseTiming: row.glucose_timing,
    malariaRdt: row.malaria_rdt,
    hearingLeft: row.hearing_left,
    hearingRight: row.hearing_right,
    mainComplaint: row.main_complaint,
    seenByClinician: row.seen_by_clinician,
    clinicianName: row.clinician_name,
    outcome: row.outcome,
    medicinesGiven: medicines.map((medicine) => ({ name: String(medicine.name ?? ''),
      dose: typeof medicine.dose === 'string' ? medicine.dose : null })),
    referred: row.referred,
    referredTo: row.referred_to,
    ...('genotype' in row ? { genotype: row.genotype ?? null } : {}),
    ...('blood_group' in row ? { bloodGroup: row.blood_group ?? null } : {}),
    version: Number(row.version),
    recordedAt: new Date(row.recorded_at).toISOString(),
    recordedByMembershipId: row.recorded_by_membership_id,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * 0118's refusals as problems: a redacted registration (55000) is 409, a case
 * the trigger cannot find is 404, and any remaining check violation (23514 on
 * a registration_screenings_* constraint, or the medicines check) is 422.
 * Undefined for any other error.
 */
export function screeningRefusal(error: unknown): DomainProblem | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message, constraint } = error as { code?: unknown; message?: unknown; constraint?: unknown };
  if (message === 'OUTREACH_REGISTRATION_REDACTED') {
    return new DomainProblem(409, 'OUTREACH_REGISTRATION_REDACTED',
      'This registration has been removed, so its screening cannot be saved.');
  }
  if (code === '23514' && message === 'OUTREACH_REGISTRATION_NOT_FOUND') {
    return new DomainProblem(404, 'OUTREACH_REGISTRATION_NOT_FOUND', 'The Outreach registration case was not found');
  }
  if (code === '23514' && message === 'OUTREACH_SCREENING_MEDICINES_INVALID') {
    return outOfRange('Check the medicines: list up to 10, each with a name of up to 100 characters and a dose of up to 200.');
  }
  if (code === '23514' && typeof constraint === 'string' && constraint.startsWith('registration_screenings_')) {
    return outOfRange('Check the screening values: one of them is outside the range that can be saved.');
  }
  return undefined;
}
