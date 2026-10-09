import type { VitalCorrectionRow } from './vitals.service';
import { vitalCorrectionFromStorage, vitalMeasurementsToStorage } from './vitals.service';

describe('vital correction serialization', () => {
  it('writes only the snake_case keys permitted by the PostgreSQL integrity check', () => {
    expect(vitalMeasurementsToStorage({
      pulseBpm: 72,
      systolicMmhg: 120,
      diastolicMmhg: 80,
    })).toEqual({ pulse_bpm: 72, systolic_mmhg: 120, diastolic_mmhg: 80 });
  });

  it('returns correction values through the camelCase API contract', () => {
    const row = {
      replacementValues: {
        pulse_bpm: 72,
        oxygen_saturation_percent: 98.5,
      },
    } as unknown as VitalCorrectionRow;
    expect(vitalCorrectionFromStorage(row).replacementValues).toEqual({
      pulseBpm: 72,
      oxygenSaturationPercent: 98.5,
    });
  });
});
