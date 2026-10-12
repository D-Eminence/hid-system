import {
  VITAL_MEASUREMENTS,
  currentVitalJoin,
  currentVitalProjection,
  recordedVitalProjection,
} from './vital-current-values';

describe('vital current values', () => {
  it('names the eight measurements with the column and type each is stored with', () => {
    expect(VITAL_MEASUREMENTS).toEqual([
      ['heightCm', 'height_cm', 'numeric(6,2)'],
      ['weightKg', 'weight_kg', 'numeric(7,3)'],
      ['temperatureC', 'temperature_c', 'numeric(4,1)'],
      ['pulseBpm', 'pulse_bpm', 'smallint'],
      ['respiratoryRate', 'respiratory_rate', 'smallint'],
      ['systolicMmhg', 'systolic_mmhg', 'smallint'],
      ['diastolicMmhg', 'diastolic_mmhg', 'smallint'],
      ['oxygenSaturationPercent', 'oxygen_saturation_percent', 'numeric(5,2)'],
    ]);
  });

  it('joins only the correction the vital names as current, at the same patient and facility', () => {
    expect(currentVitalJoin('v', 'c')).toBe('left join ehr.vital_corrections c on c.vital_id=v.id'
      + ' and c.patient_id=v.patient_id and c.facility_id=v.facility_id'
      + ' and c.correction_no=v.current_correction_no and v.current_correction_no>0');
  });

  it('takes the current correction as the whole current set and never falls back to recorded values', () => {
    const projection = currentVitalProjection('v', 'c');
    for (const [key, column, type] of VITAL_MEASUREMENTS) {
      // Uncorrected: the recorded value. Corrected: the correction's value, or null when it omits the measurement.
      // Corrected but the correction is not readable: null (no else branch).
      expect(projection).toContain(`case when v.current_correction_no=0 then v.${column}`
        + ` when c.id is not null then (c.replacement_values->>'${column}')::${type} end as "${key}"`);
    }
    expect(projection).not.toMatch(/coalesce|else/i);
    expect(projection).toContain('v.current_correction_no as "currentCorrectionNo"');
    expect(projection).toContain('c.created_at as "correctedAt"');
    expect(projection).toContain('(v.current_correction_no>0 and c.id is null) as "correctionUnavailable"');
  });

  it('returns the values as first recorded apart, and only for a corrected vital', () => {
    const recorded = recordedVitalProjection('v');
    const pairs = VITAL_MEASUREMENTS.map(([key, column]) => `'${key}',v.${column}`).join(',');
    expect(recorded).toBe(`case when v.current_correction_no>0 then jsonb_build_object(${pairs}) end as "recordedValues"`);
  });

  it('accepts only plain table aliases', () => {
    expect(() => currentVitalJoin('v;drop', 'c')).toThrow('Invalid SQL alias');
    expect(() => currentVitalProjection('v', 'c c')).toThrow('Invalid SQL alias');
    expect(() => recordedVitalProjection('"v"')).toThrow('Invalid SQL alias');
  });
});
