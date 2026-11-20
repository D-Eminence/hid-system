import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { PoolClient } from 'pg';
import { REQUIRED_PERMISSIONS } from '../../common/decorators';
import type { DataAccessContext } from '../../common/request-context';
import type { ClinicalRepository } from '../shared/clinical.repository';
import { measureWarning, moreSerious, USUAL_RANGE_BANDS, usualRanges, vitalWarnings, type WarnedMeasure } from './usual-ranges';
import { UsualRangesController } from './usual-ranges.controller';
import { VitalsService } from './vitals.service';

// VIT-1 (Akos P1-11): soft "abnormal" vitals warnings from a fixed adult
// table, never stored and never blocking a save; one new hard rule.
// Fictional identifiers only.
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const vitalId = '123e4567-e89b-42d3-a456-426614174031';
const context = { correlationId: 'correlation-123456', facilityId, membershipId: facilityId, purposeOfUse: 'direct-care',
  actor: { accountId: facilityId, subject: 'staff:test' } } as unknown as DataAccessContext;

describe('VIT-1: the usual-ranges table', () => {
  it('GET /ehr/vitals/usual-ranges: vitals readers, cached privately for an hour', () => {
    expect(Reflect.getMetadata(PATH_METADATA, UsualRangesController)).toBe('ehr/vitals');
    const handler = UsualRangesController.prototype.usualRanges;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('usual-ranges');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['ehr.vital.read']);
    expect(Reflect.getMetadata('__headers__', handler)).toEqual([{ name: 'Cache-Control', value: 'private, max-age=3600' }]);
  });

  it('is the adult draft, not yet approved', () => {
    const table = usualRanges();
    expect(table).toMatchObject({ version: '2026-11-adult-1', appliesTo: 'adults (18 and over)', approvedBy: null });
    expect(table.ranges).toHaveLength(USUAL_RANGE_BANDS.length);
    expect(table.ranges).toContainEqual({ measure: 'pulseBpm', level: 'far_outside_usual', atOrBelow: 40 });
    expect(table.ranges).toContainEqual({ measure: 'pulseBpm', level: 'outside_usual', from: 41, to: 50 });
    expect(table.ranges).toContainEqual({ measure: 'pulseBpm', level: 'outside_usual', from: 111, to: 130 });
    expect(table.ranges).toContainEqual({ measure: 'pulseBpm', level: 'far_outside_usual', atOrAbove: 131 });
    expect(table.ranges.some((entry) => ['heightCm', 'weightKg'].includes(entry.measure))).toBe(false);
  });

  // The draft table, edge by edge: [measure, value, level or null].
  it.each([
    ['respiratoryRate', 8, 'far_outside_usual'], ['respiratoryRate', 9, 'outside_usual'], ['respiratoryRate', 11, 'outside_usual'],
    ['respiratoryRate', 12, null], ['respiratoryRate', 20, null], ['respiratoryRate', 21, 'outside_usual'],
    ['respiratoryRate', 24, 'outside_usual'], ['respiratoryRate', 25, 'far_outside_usual'], ['respiratoryRate', 60, 'far_outside_usual'],
    ['respiratoryRate', 61, 'check_entry'],
    ['oxygenSaturationPercent', 49.99, 'check_entry'], ['oxygenSaturationPercent', 50, 'far_outside_usual'],
    ['oxygenSaturationPercent', 91.99, 'far_outside_usual'], ['oxygenSaturationPercent', 92, 'outside_usual'],
    ['oxygenSaturationPercent', 95.5, 'outside_usual'], ['oxygenSaturationPercent', 96, null], ['oxygenSaturationPercent', 100, null],
    ['systolicMmhg', 90, 'far_outside_usual'], ['systolicMmhg', 91, 'outside_usual'], ['systolicMmhg', 100, 'outside_usual'],
    ['systolicMmhg', 101, null], ['systolicMmhg', 179, null], ['systolicMmhg', 180, 'outside_usual'],
    ['systolicMmhg', 219, 'outside_usual'], ['systolicMmhg', 220, 'far_outside_usual'], ['systolicMmhg', 300, 'far_outside_usual'],
    ['systolicMmhg', 301, 'check_entry'],
    ['diastolicMmhg', 40, 'outside_usual'], ['diastolicMmhg', 41, null], ['diastolicMmhg', 109, null],
    ['diastolicMmhg', 110, 'outside_usual'], ['diastolicMmhg', 200, 'outside_usual'], ['diastolicMmhg', 201, 'check_entry'],
    ['pulseBpm', 40, 'far_outside_usual'], ['pulseBpm', 41, 'outside_usual'], ['pulseBpm', 50, 'outside_usual'],
    ['pulseBpm', 51, null], ['pulseBpm', 110, null], ['pulseBpm', 111, 'outside_usual'], ['pulseBpm', 130, 'outside_usual'],
    ['pulseBpm', 131, 'far_outside_usual'], ['pulseBpm', 250, 'far_outside_usual'], ['pulseBpm', 251, 'check_entry'],
    ['temperatureC', 29.9, 'check_entry'], ['temperatureC', 30, 'far_outside_usual'], ['temperatureC', 35, 'far_outside_usual'],
    ['temperatureC', 35.1, null], ['temperatureC', 38, null], ['temperatureC', 38.1, 'outside_usual'],
    ['temperatureC', 39, 'outside_usual'], ['temperatureC', 39.1, 'far_outside_usual'], ['temperatureC', 44, 'far_outside_usual'],
    ['temperatureC', 44.1, 'check_entry'],
  ] as const)('%s %s: %s', (measure, value, level) => {
    expect(measureWarning(measure as WarnedMeasure, value)?.level ?? null).toBe(level);
  });

  it('words the warnings as the contract does', () => {
    expect(measureWarning('pulseBpm', 135)).toEqual({ measure: 'pulseBpm', value: 135, level: 'far_outside_usual',
      code: 'VITAL_FAR_OUTSIDE_USUAL_RANGE', message: 'Pulse is very high: 135 a minute. Usual for adults: 51 to 110.' });
    expect(measureWarning('temperatureC', 45)).toMatchObject({ code: 'VITAL_CHECK_ENTRY',
      message: 'Check this entry: a temperature of 45 °C is very unlikely.' });
    expect(measureWarning('oxygenSaturationPercent', 93)).toMatchObject({ code: 'VITAL_OUTSIDE_USUAL_RANGE',
      message: 'Oxygen is low: 93%. Usual for adults: 96 to 100.' });
    expect(measureWarning('temperatureC', 34.5)?.message).toBe('Temperature is very low: 34.5 °C. Usual for adults: 35.1 to 38.');
  });

  it('gives [] when nothing is outside the usual range, and nothing for height, weight or no value', () => {
    expect(vitalWarnings({ pulseBpm: 72, systolicMmhg: 120, diastolicMmhg: 80, temperatureC: 36.8 })).toEqual([]);
    expect(vitalWarnings({ pulseBpm: null })).toEqual([]);
  });

  it('blood pressure on latest: the more serious half', () => {
    const systolic = measureWarning('systolicMmhg', 185);
    const diastolic = measureWarning('diastolicMmhg', 210);
    expect(moreSerious(systolic, diastolic)?.measure).toBe('diastolicMmhg');
    expect(moreSerious(systolic, null)).toBe(systolic);
    expect(moreSerious(null, null)).toBeNull();
  });
});

function harness(rows: { vital?: Record<string, unknown>; correction?: Record<string, unknown>; latest?: Record<string, unknown>[] }) {
  const client = {
    query: jest.fn(async (sql: string) => {
      if (/insert into ehr\.vital_corrections/.test(sql)) return { rows: [rows.correction], rowCount: 1 };
      if (/update ehr\.vitals set current_correction_no/.test(sql)) return { rows: [], rowCount: 1 };
      if (/select distinct on \(x\.measure\)/.test(sql)) return { rows: rows.latest ?? [], rowCount: 0 };
      if (/insert into ehr\.vitals|from ehr\.vitals/.test(sql)) return { rows: [rows.vital], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  const repository = {
    run: jest.fn(async (_c: unknown, _p: unknown, _a: unknown, _e: unknown,
      operation: (client: PoolClient) => Promise<{ value: unknown }>) => (await operation(client as unknown as PoolClient)).value),
    executeCreate: jest.fn(async (_client: unknown, _context: unknown, _patient: unknown, _key: unknown, _operation: unknown,
      _digest: unknown, _type: unknown, create: () => Promise<{ value: unknown }>) => create()),
    setChangeReason: jest.fn(),
    encounterExists: jest.fn(async () => true),
    exists: jest.fn(async () => true),
  };
  return new VitalsService(repository as unknown as ClinicalRepository);
}

describe('VIT-1: warnings on the answers, and the one new hard rule', () => {
  const recorded = { id: vitalId, status: 'recorded', rowVersion: '1', currentCorrectionNo: 0, pulseBpm: 135,
    respiratoryRate: null, oxygenSaturationPercent: '93.00', systolicMmhg: 120, diastolicMmhg: 80, temperatureC: '36.8',
    heightCm: null, weightKg: null };

  it('a create answers its warnings and the table version; it is still saved', async () => {
    const service = harness({ vital: recorded });
    const answer = await service.create(context, patientId, encounterId,
      { recordedAt: '2026-11-20T00:00:00.000Z', source: 'manual', pulseBpm: 135, oxygenSaturationPercent: 93,
        systolicMmhg: 120, diastolicMmhg: 80, temperatureC: 36.8 } as never, 'key-123456789');
    expect(answer).toMatchObject({ id: vitalId, usualRangesVersion: '2026-11-adult-1' });
    expect((answer as { warnings: { measure: string }[] }).warnings.map((warning) => warning.measure))
      .toEqual(['pulseBpm', 'oxygenSaturationPercent']);
  });

  it('a correction answers the warnings of the values after it', async () => {
    const service = harness({ vital: recorded, correction: { id: 'c1', vitalId, correctionNo: 1,
      replacementValues: { pulse_bpm: 72, temperature_c: 39.5 } } });
    const answer = await service.correct(context, patientId, encounterId, vitalId,
      { expectedRowVersion: 1, changeReason: 'Typo', replacementValues: { pulseBpm: 72, temperatureC: 39.5 } }, 'key-123456789');
    expect((answer as unknown as { warnings: { measure: string; level: string }[] }).warnings).toEqual([
      expect.objectContaining({ measure: 'oxygenSaturationPercent', level: 'outside_usual' }),
      expect.objectContaining({ measure: 'temperatureC', level: 'far_outside_usual' }),
    ]);
  });

  it('latest: each measure has its warning or null; blood pressure the more serious half', async () => {
    const service = harness({ latest: [
      { measure: 'pulseBpm', value: 72, recordedAt: new Date(), vitalId, encounterId, corrected: false },
      { measure: 'bloodPressure', value: { systolicMmhg: 185, diastolicMmhg: 115 }, recordedAt: new Date(), vitalId,
        encounterId, corrected: false },
      { measure: 'weightKg', value: 300, recordedAt: new Date(), vitalId, encounterId, corrected: false },
    ] });
    const answer = await service.latest(context, patientId);
    expect(answer.usualRangesVersion).toBe('2026-11-adult-1');
    expect(answer.measures.pulseBpm?.warning).toBeNull();
    expect(answer.measures.weightKg?.warning).toBeNull();
    expect(answer.measures.bloodPressure?.warning).toMatchObject({ measure: 'systolicMmhg', level: 'outside_usual' });
  });

  it.each([['equal', 80, 80], ['higher', 80, 90]])('a diastolic %s to the systolic is 400 BLOOD_PRESSURE_ORDER_INVALID',
    (_label, systolicMmhg, diastolicMmhg) => {
      const service = harness({});
      const refusal = { status: 400, code: 'BLOOD_PRESSURE_ORDER_INVALID', message: 'The lower blood pressure number '
        + '(diastolic) must be less than the upper one (systolic). Check the reading.' };
      expect(() => service.checkCreate({ systolicMmhg, diastolicMmhg } as never)).toThrow(
        expect.objectContaining(refusal) as unknown as Error);
      expect(() => service.correct(context, patientId, encounterId, vitalId,
        { expectedRowVersion: 1, changeReason: 'Typo', replacementValues: { systolicMmhg, diastolicMmhg } }, 'key-123456789'))
        .toThrow(expect.objectContaining(refusal) as unknown as Error);
    });
});
