import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { REQUIRED_PERMISSIONS } from '../../common/decorators';
import type { DataAccessContext } from '../../common/request-context';
import { ClinicalRepository } from '../shared/clinical.repository';
import { PatientVitalsController } from './patient-vitals.controller';
import { LATEST_VITALS_SQL, VitalsService } from './vitals.service';

// Fictional identifiers only.
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const vitalA = '123e4567-e89b-42d3-a456-426614174031';
const vitalB = '123e4567-e89b-42d3-a456-426614174032';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  authorization: 'Bearer user', actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local',
    roles: ['nurse'], permissions: [], facilityIds: [facilityId], facilities: [],
    facility: { id: facilityId, membershipId, organizationId: facilityId, name: 'Test', roles: ['nurse'],
      permissions: [], isPrimary: true } } } as unknown as DataAccessContext;

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('EHR-C3 GET ehr/patients/:patientId/vitals/latest', () => {
  it('is a GET for vitals readers on its own patient-level controller', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PatientVitalsController)).toBe('ehr/patients/:patientId/vitals');
    const handler = PatientVitalsController.prototype.latest;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('latest');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['ehr.vital.read']);
  });

  it('reads only this patient at this facility, applies the current correction and leaves out visits entered in error', () => {
    const sql = squash(LATEST_VITALS_SQL);
    expect(sql).toContain('where v.patient_id = $1 and v.facility_id = $2 and e.status <> \'entered_in_error\'');
    expect(sql).toContain('to_jsonb(v) || coalesce(c.replacement_values, \'{}\'::jsonb) as m');
    expect(sql).toContain('c.correction_no = v.current_correction_no');
    expect(sql).toContain('select distinct on (x.measure)');
    expect(sql).toContain('order by x.measure, effective.recorded_at desc, effective.created_at desc, effective.id desc');
  });

  // Review finding 4: `corrected` is worked out per measure, from the keys the current correction set.
  it('says a measure is corrected only when the current correction set that measure', () => {
    const sql = squash(LATEST_VITALS_SQL);
    expect(sql).toContain("coalesce(c.replacement_values, '{}'::jsonb) as r");
    expect(sql).not.toContain('c.id is not null as corrected');
    for (const [measure, key] of [['heightCm', 'height_cm'], ['weightKg', 'weight_kg'], ['temperatureC', 'temperature_c'],
      ['pulseBpm', 'pulse_bpm'], ['respiratoryRate', 'respiratory_rate'],
      ['oxygenSaturationPercent', 'oxygen_saturation_percent']]) {
      expect(sql).toContain(`('${measure}', effective.m->'${key}', effective.r ? '${key}')`);
    }
    expect(sql).toContain("end, effective.r ?| array['systolic_mmhg', 'diastolic_mmhg'])");
    expect(sql).toContain('as x(measure, value, corrected)');
    expect(sql).toContain('effective.encounter_id as "encounterId", x.corrected');
  });

  it('keeps blood pressure as one measure, only when both halves of the same reading are present', () => {
    const sql = squash(LATEST_VITALS_SQL);
    expect(sql).toContain("('bloodPressure', case when jsonb_typeof(effective.m->'systolic_mmhg') = 'number' and "
      + "jsonb_typeof(effective.m->'diastolic_mmhg') = 'number' then jsonb_build_object('systolicMmhg', "
      + "effective.m->'systolic_mmhg', 'diastolicMmhg', effective.m->'diastolic_mmhg') end, ");
    expect(sql).not.toMatch(/'systolicMmhg', effective\.m->'systolic_mmhg'\),/);
  });

  function setup(rows: unknown[]) {
    const calls: { sql: string; values: unknown[] }[] = [];
    const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows };
    }) };
    const audits: Record<string, unknown>[] = [];
    const repository = { run: jest.fn(async (_c, _p, access, event, operation) => {
      const result = await operation(client);
      audits.push({ access, action: event.action, details: { ...event.details, ...result.details } });
      return result.value;
    }) };
    return { service: new VitalsService(repository as never), calls, audits };
  }

  it('answers each measure with where and when it was taken, numbers as numbers, the pressure as a pair', async () => {
    const recordedAt = new Date('2026-11-18T09:00:00Z');
    const { service, calls, audits } = setup([
      { measure: 'bloodPressure', value: { systolicMmhg: 128, diastolicMmhg: 84 }, recordedAt, vitalId: vitalA,
        encounterId, corrected: true },
      { measure: 'pulseBpm', value: 76, recordedAt, vitalId: vitalB, encounterId, corrected: false },
      { measure: 'temperatureC', value: '37.2', recordedAt, vitalId: vitalB, encounterId, corrected: false },
      { measure: 'notAMeasure', value: 1, recordedAt, vitalId: vitalB, encounterId, corrected: false },
    ]);
    // VIT-1: each measure carries its warning (null within the usual range) and the table version.
    await expect(service.latest(context, patientId)).resolves.toEqual({ facilityId, usualRangesVersion: '2026-11-adult-1', measures: {
      bloodPressure: { value: { systolicMmhg: 128, diastolicMmhg: 84 }, recordedAt, vitalId: vitalA, encounterId,
        corrected: true, warning: null },
      pulseBpm: { value: 76, recordedAt, vitalId: vitalB, encounterId, corrected: false, warning: null },
      temperatureC: { value: 37.2, recordedAt, vitalId: vitalB, encounterId, corrected: false, warning: null },
    } });
    expect(calls[0]?.values).toEqual([patientId, facilityId]);
    expect(audits).toEqual([{ access: 'read_records', action: 'ehr.vital.latest', details: { measureCount: 3 } }]);
  });

  it('answers a partly corrected reading measure by measure (weight as taken, pulse corrected)', async () => {
    const recordedAt = new Date('2026-11-18T09:00:00Z');
    const { service } = setup([
      { measure: 'pulseBpm', value: 80, recordedAt, vitalId: vitalA, encounterId, corrected: true },
      { measure: 'weightKg', value: 70, recordedAt, vitalId: vitalA, encounterId, corrected: false },
    ]);
    await expect(service.latest(context, patientId)).resolves.toEqual({ facilityId, usualRangesVersion: '2026-11-adult-1', measures: {
      pulseBpm: { value: 80, recordedAt, vitalId: vitalA, encounterId, corrected: true, warning: null },
      weightKg: { value: 70, recordedAt, vitalId: vitalA, encounterId, corrected: false, warning: null },
    } });
  });

  it('answers no measures when there are none', async () => {
    const { service } = setup([]);
    await expect(service.latest(context, patientId)).resolves.toEqual({ facilityId, measures: {},
      usualRangesVersion: '2026-11-adult-1' });
  });

  it('audits a refusal (403) through the clinical repository and reads nothing', async () => {
    const audit = { record: jest.fn(async () => undefined), recordWithClient: jest.fn() };
    const identity = { authorize: jest.fn(async () => ({ allowed: false })) };
    const database = { withTransaction: jest.fn() };
    const repository = new ClinicalRepository(database as never, audit as never, identity as never);
    const service = new VitalsService(repository);
    await expect(service.latest(context, patientId)).rejects.toMatchObject({ status: 403, code: 'CONSENT_REQUIRED' });
    expect(identity.authorize).toHaveBeenCalledWith(patientId, 'read_records', 'direct-care', context);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'ehr.vital.latest', outcome: 'denied',
      patientId, facilityId, resourceType: 'vital' }));
    expect(database.withTransaction).not.toHaveBeenCalled();
  });
});
