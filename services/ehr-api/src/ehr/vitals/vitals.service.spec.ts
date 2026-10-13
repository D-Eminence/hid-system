import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { REQUIRED_PERMISSIONS } from '../../common/decorators';
import type { DataAccessContext } from '../../common/request-context';
import { VitalsController } from './vitals.controller';
import { type VitalCorrectionRow, type VitalRow, VitalsService, vitalCorrectionFromStorage,
  vitalMeasurementsToStorage } from './vitals.service';

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


const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const vitalId = '123e4567-e89b-42d3-a456-426614174005';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  authorization: 'Bearer user', actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local',
    roles: ['nurse'], permissions: ['ehr.vital.write'], facilityIds: [facilityId], facilities: [] } } as unknown as DataAccessContext;

const vital = (status: string, rowVersion = '2'): VitalRow & { status: string } => ({
  id: vitalId, encounterId, patientId, facilityId, createdBy: accountId, createdByMembershipId: membershipId,
  recordedAt: new Date('2026-10-01T08:10:00.000Z'), heightCm: null, weightKg: null, temperatureC: null, pulseBpm: 72,
  respiratoryRate: null, systolicMmhg: 120, diastolicMmhg: 80, oxygenSaturationPercent: null, source: 'manual',
  currentCorrectionNo: 0, status, rowVersion, createdAt: new Date('2026-10-01T08:10:00.000Z'),
  updatedAt: new Date('2026-10-01T08:10:00.000Z'),
});

/** A fake transaction over one vital in `status`; the UPDATE answers the row at the next version unless `stale`. */
function vitalHarness(status: string, { stale = false } = {}) {
  const query = jest.fn(async (sql: string) => {
    const statement = sql.replace(/\s+/g, ' ').trim();
    if (/^select .* from ehr\.vitals .* for update$/i.test(statement)) return { rows: [vital(status)] };
    if (/^update ehr\.vitals\b/i.test(statement)) {
      return stale ? { rows: [], rowCount: 0 } : { rows: [vital('entered_in_error', '3')], rowCount: 1 };
    }
    if (/^select .* from ehr\.vitals\b/i.test(statement)) return { rows: [vital(status)] };
    return { rows: [] };
  });
  const events: unknown[] = [];
  const repository = {
    run: jest.fn(async (_context: unknown, _patientId: unknown, _access: unknown, event: unknown,
      operation: (client: unknown) => Promise<{ value: unknown }>) => { events.push(event); return (await operation({ query })).value; }),
    executeCreate: jest.fn(async (...args: unknown[]) => ({ value: await (args[7] as () => Promise<unknown>)() })),
    setChangeReason: jest.fn(async () => undefined),
    exists: jest.fn(async () => true),
  };
  const service = new VitalsService(repository as never);
  const writes = () => query.mock.calls.filter(([sql]) => /^\s*(update|insert)\b/i.test(String(sql)));
  return { query, repository, service, events, writes };
}

type EnteredInError = (context: DataAccessContext, patientId: string, encounterId: string, vitalId: string,
  input: { expectedRowVersion: number; changeReason: string }) => Promise<unknown>;
/** VitalsService.markEnteredInError, the vital retraction command (ENC-RETRACT-2). */
const markEnteredInError = (service: VitalsService): EnteredInError =>
  (service as unknown as { markEnteredInError: EnteredInError }).markEnteredInError.bind(service);
const retraction = { expectedRowVersion: 2, changeReason: 'Recorded on the wrong patient' };

describe('VitalsService marks a vital entered in error (ENC-RETRACT-2)', () => {
  it('marks a final vital entered in error with the reason, after locking it, and audits the change', async () => {
    const { service, query, repository, events, writes } = vitalHarness('final');
    await expect(markEnteredInError(service)(context, patientId, encounterId, vitalId, retraction))
      .resolves.toMatchObject({ id: vitalId, status: 'entered_in_error', rowVersion: '3' });
    expect(events).toEqual([expect.objectContaining({ action: 'ehr.vital.entered-in-error', resourceType: 'vital',
      resourceId: vitalId })]);
    expect(repository.setChangeReason).toHaveBeenCalledWith(expect.anything(), 'Recorded on the wrong patient');
    expect(writes()).toHaveLength(1);
    expect(String(writes()[0]?.[0]).replace(/\s+/g, ' ').trim()).toMatch(
      /^update ehr\.vitals set status = 'entered_in_error' where id = \$1 and encounter_id = \$2 and patient_id = \$3 and facility_id = \$4 and row_version = \$5 returning /i);
    const lockAt = query.mock.calls.findIndex(([sql]) => /for update\s*$/i.test(String(sql)));
    const updateAt = query.mock.calls.findIndex(([sql]) => /^\s*update\b/i.test(String(sql)));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(updateAt).toBeGreaterThan(lockAt);
  });

  it('refuses a vital already entered in error with 409 VITAL_NOT_AMENDABLE and writes nothing', async () => {
    const { service, writes } = vitalHarness('entered_in_error');
    await expect(markEnteredInError(service)(context, patientId, encounterId, vitalId, retraction))
      .rejects.toMatchObject({ status: 409, code: 'VITAL_NOT_AMENDABLE' });
    expect(writes()).toEqual([]);
  });

  it('refuses a stale version with 412 VERSION_CONFLICT and writes nothing', async () => {
    const { service, writes } = vitalHarness('final');
    await expect(markEnteredInError(service)(context, patientId, encounterId, vitalId, { ...retraction, expectedRowVersion: 1 }))
      .rejects.toMatchObject({ status: 412, code: 'VERSION_CONFLICT' });
    expect(writes()).toEqual([]);
  });

  it('refuses a correction of a vital entered in error with 409 VITAL_NOT_AMENDABLE before writing it', async () => {
    const { service, writes } = vitalHarness('entered_in_error');
    await expect(service.correct(context, patientId, encounterId, vitalId,
      { expectedRowVersion: 2, changeReason: 'Corrected pulse', replacementValues: { pulseBpm: 70 } } as never, 'correction-key-1234'))
      .rejects.toMatchObject({ status: 409, code: 'VITAL_NOT_AMENDABLE' });
    expect(writes()).toEqual([]);
  });

  it('returns each vital with its status', async () => {
    const { service, query } = vitalHarness('final');
    await service.get(context, patientId, encounterId, vitalId);
    const read = String(query.mock.calls.find(([sql]) => /from ehr\.vitals/i.test(String(sql)))?.[0]);
    expect(read).toMatch(/\bstatus\b/);
  });

  it('is routed as POST .../vitals/:vitalId/entered-in-error, for the vital write permission', () => {
    const handler = (VitalsController.prototype as unknown as Record<string, unknown>).markEnteredInError;
    expect(typeof handler).toBe('function');
    expect(Reflect.getMetadata(PATH_METADATA, handler as object)).toBe(':vitalId/entered-in-error');
    expect(Reflect.getMetadata(METHOD_METADATA, handler as object)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler as object)).toEqual(['ehr.vital.write']);
  });
});
