/**
 * VIT-1 (Akos P1-11): soft "abnormal" vitals warnings, worked out each time
 * from this fixed adult table and never stored. A warning never blocks a
 * save. Draft for Health ID's named clinical lead to approve (owner decision
 * Q124 A): `approvedBy` stays null until then. The low bands and the very high
 * pulse, breathing and temperature bands follow the Royal College of
 * Physicians' NEWS2 score; the high blood pressure bands (systolic 180,
 * diastolic 110) follow common severe-hypertension thresholds. Child ranges
 * are a later version of the table.
 */
export const USUAL_RANGES_VERSION = '2026-11-adult-1';

export type WarningLevel = 'outside_usual' | 'far_outside_usual' | 'check_entry';
export type WarnedMeasure =
  | 'pulseBpm' | 'respiratoryRate' | 'oxygenSaturationPercent' | 'systolicMmhg' | 'diastolicMmhg' | 'temperatureC';

/**
 * One band. Bounds are inclusive (`from`, `to`, `atOrBelow`, `atOrAbove`) or
 * exclusive (`below`, `above`); a band names one or two of them.
 */
export interface UsualRangeBand {
  measure: WarnedMeasure;
  level: WarningLevel;
  from?: number;
  to?: number;
  atOrBelow?: number;
  atOrAbove?: number;
  below?: number;
  above?: number;
}

const band = (measure: WarnedMeasure, level: WarningLevel, bounds: Omit<UsualRangeBand, 'measure' | 'level'>): UsualRangeBand =>
  ({ measure, level, ...bounds });

/**
 * The draft table. Oxygen is stored to two decimals, so its bands meet
 * without a gap (92 up to 96 is outside the usual range, under 92 far
 * outside); temperature is stored to one decimal, the rest as whole numbers.
 */
export const USUAL_RANGE_BANDS: readonly UsualRangeBand[] = [
  band('respiratoryRate', 'far_outside_usual', { atOrBelow: 8 }),
  band('respiratoryRate', 'outside_usual', { from: 9, to: 11 }),
  band('respiratoryRate', 'outside_usual', { from: 21, to: 24 }),
  band('respiratoryRate', 'far_outside_usual', { atOrAbove: 25 }),
  band('respiratoryRate', 'check_entry', { atOrAbove: 61 }),
  band('oxygenSaturationPercent', 'check_entry', { below: 50 }),
  band('oxygenSaturationPercent', 'far_outside_usual', { below: 92 }),
  band('oxygenSaturationPercent', 'outside_usual', { from: 92, below: 96 }),
  band('systolicMmhg', 'far_outside_usual', { atOrBelow: 90 }),
  band('systolicMmhg', 'outside_usual', { from: 91, to: 100 }),
  band('systolicMmhg', 'outside_usual', { from: 180, to: 219 }),
  band('systolicMmhg', 'far_outside_usual', { atOrAbove: 220 }),
  band('systolicMmhg', 'check_entry', { above: 300 }),
  band('diastolicMmhg', 'outside_usual', { atOrBelow: 40 }),
  band('diastolicMmhg', 'outside_usual', { atOrAbove: 110 }),
  band('diastolicMmhg', 'check_entry', { above: 200 }),
  band('pulseBpm', 'far_outside_usual', { atOrBelow: 40 }),
  band('pulseBpm', 'outside_usual', { from: 41, to: 50 }),
  band('pulseBpm', 'outside_usual', { from: 111, to: 130 }),
  band('pulseBpm', 'far_outside_usual', { atOrAbove: 131 }),
  band('pulseBpm', 'check_entry', { above: 250 }),
  band('temperatureC', 'check_entry', { below: 30 }),
  band('temperatureC', 'far_outside_usual', { atOrBelow: 35 }),
  band('temperatureC', 'outside_usual', { from: 38.1, to: 39 }),
  band('temperatureC', 'far_outside_usual', { atOrAbove: 39.1 }),
  band('temperatureC', 'check_entry', { above: 44 }),
];

/** The usual adult range of each measure, as the messages say it. */
const USUAL: Record<WarnedMeasure, { low: number; high: number; name: string; unit: string; entry: string }> = {
  pulseBpm: { low: 51, high: 110, name: 'Pulse', unit: ' a minute', entry: 'a pulse of' },
  respiratoryRate: { low: 12, high: 20, name: 'Breathing rate', unit: ' a minute', entry: 'a breathing rate of' },
  oxygenSaturationPercent: { low: 96, high: 100, name: 'Oxygen', unit: '%', entry: 'an oxygen level of' },
  systolicMmhg: { low: 101, high: 179, name: 'Systolic pressure', unit: ' mmHg', entry: 'a systolic pressure of' },
  diastolicMmhg: { low: 41, high: 109, name: 'Diastolic pressure', unit: ' mmHg', entry: 'a diastolic pressure of' },
  temperatureC: { low: 35.1, high: 38, name: 'Temperature', unit: ' °C', entry: 'a temperature of' },
};

export const WARNED_MEASURES = Object.keys(USUAL) as WarnedMeasure[];

const LEVEL_ORDER: Record<WarningLevel, number> = { outside_usual: 1, far_outside_usual: 2, check_entry: 3 };
const CODES: Record<WarningLevel, string> = {
  outside_usual: 'VITAL_OUTSIDE_USUAL_RANGE',
  far_outside_usual: 'VITAL_FAR_OUTSIDE_USUAL_RANGE',
  check_entry: 'VITAL_CHECK_ENTRY',
};

export interface VitalWarning {
  measure: WarnedMeasure;
  value: number;
  level: WarningLevel;
  code: string;
  message: string;
}

/** GET /ehr/vitals/usual-ranges: the table as published. */
export function usualRanges() {
  return { version: USUAL_RANGES_VERSION, appliesTo: 'adults (18 and over)', approvedBy: null,
    ranges: USUAL_RANGE_BANDS.map((entry) => ({ ...entry })) };
}

function inBand(value: number, entry: UsualRangeBand): boolean {
  return (entry.from === undefined || value >= entry.from) && (entry.to === undefined || value <= entry.to)
    && (entry.atOrBelow === undefined || value <= entry.atOrBelow) && (entry.atOrAbove === undefined || value >= entry.atOrAbove)
    && (entry.below === undefined || value < entry.below) && (entry.above === undefined || value > entry.above);
}

function shown(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/** One measure's warning: the most serious band its value falls in, or null. */
export function measureWarning(measure: WarnedMeasure, value: number | null | undefined): VitalWarning | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  let level: WarningLevel | undefined;
  for (const entry of USUAL_RANGE_BANDS) {
    if (entry.measure !== measure || !inBand(value, entry)) continue;
    if (!level || LEVEL_ORDER[entry.level] > LEVEL_ORDER[level]) level = entry.level;
  }
  if (!level) return null;
  const usual = USUAL[measure];
  const reading = `${shown(value)}${usual.unit}`;
  const message = level === 'check_entry'
    ? `Check this entry: ${usual.entry} ${reading} is very unlikely.`
    : `${usual.name} is ${level === 'far_outside_usual' ? 'very ' : ''}${value < usual.low ? 'low' : 'high'}: ${reading}. `
      + `Usual for adults: ${shown(usual.low)} to ${shown(usual.high)}.`;
  return { measure, value, level, code: CODES[level], message };
}

/** Every measure's warning, in the table's measure order; `[]` when nothing is outside the usual range. */
export function vitalWarnings(values: Partial<Record<WarnedMeasure, number | null | undefined>>): VitalWarning[] {
  return WARNED_MEASURES.map((measure) => measureWarning(measure, values[measure])).filter(
    (warning): warning is VitalWarning => warning !== null);
}

/** The more serious of two warnings (blood pressure's two halves), or null. */
export function moreSerious(first: VitalWarning | null, second: VitalWarning | null): VitalWarning | null {
  if (!first) return second;
  if (!second) return first;
  return LEVEL_ORDER[second.level] > LEVEL_ORDER[first.level] ? second : first;
}
