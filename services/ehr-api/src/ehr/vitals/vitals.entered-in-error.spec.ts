import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { PoolClient } from 'pg';
import { REQUIRED_PERMISSIONS } from '../../common/decorators';
import { DomainProblem } from '../../common/problem';
import { createValidationPipe } from '../../common/validation-pipe';
import type { DataAccessContext } from '../../common/request-context';
import type { ClinicalRepository } from '../shared/clinical.repository';
import { VitalsController } from './vitals.controller';
import { MarkVitalEnteredInErrorDto, VitalsListQueryDto } from './vitals.dto';
import { LATEST_VITALS_SQL, VITAL_MESSAGES, VitalsService } from './vitals.service';

// EHR-C8b (0142): one vitals reading marked entered in error, for good. The
// database's own rules (the guard, the patient's own read) are
// services/ehr-api/test/database/vitals-entered-in-error.integration.sql.
// Fictional identifiers only.
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const vitalId = '123e4567-e89b-42d3-a456-426614174031';

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  authorization: 'Bearer user', actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local',
    roles: ['nurse'], permissions: [], facilityIds: [facilityId], facilities: [] } } as unknown as DataAccessContext;
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const databaseError = (code: string, message: string) => Object.assign(new Error(message), { code });

function harness(options: { locked?: Record<string, unknown> | null; updated?: Record<string, unknown>[] | Error;
  exists?: boolean } = {}) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const locked = options.locked === undefined
    ? { id: vitalId, status: 'recorded', rowVersion: '2', currentCorrectionNo: 0 } : options.locked;
  const client = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql: squash(sql), values });
      if (/for update$/.test(squash(sql))) return { rows: locked ? [locked] : [], rowCount: locked ? 1 : 0 };
      if (/^update ehr\.vitals set status/.test(squash(sql))) {
        if (options.updated instanceof Error) throw options.updated;
        const updated = options.updated ?? [{ id: vitalId, status: 'entered_in_error', rowVersion: '3',
          statusChangedAt: new Date('2026-11-20T01:00:00Z') }];
        return { rows: updated, rowCount: updated.length };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  const events: unknown[] = [];
  const repository = {
    // As ClinicalRepository.run: the scoped lookup first (a miss is audited not_found and answered 404).
    run: jest.fn(async (_context: unknown, _patient: string, access: string, event: unknown,
      operation: (client: PoolClient) => Promise<{ value: unknown }>,
      scopedLookup?: (client: PoolClient) => Promise<boolean>) => {
      events.push({ access, event, scopedLookup });
      if (scopedLookup && !(await scopedLookup(client as unknown as PoolClient))) {
        throw new DomainProblem(404, 'CLINICAL_RESOURCE_NOT_FOUND', 'Clinical resource was not found');
      }
      return (await operation(client as unknown as PoolClient)).value;
    }),
    exists: jest.fn(async () => options.exists ?? true),
    encounterExists: jest.fn(async () => true),
    setChangeReason: jest.fn(async () => undefined),
    executeCreate: jest.fn(async (_client: unknown, _context: unknown, _patient: unknown, _key: unknown, _operation: unknown,
      _digest: unknown, _type: unknown, create: () => Promise<{ value: unknown }>) => (await create()).value)
      .mockName('executeCreate'),
  };
  const service = new VitalsService(repository as unknown as ClinicalRepository);
  return { service, client, repository, statements, events };
}

const body = (overrides: Record<string, unknown> = {}) =>
  ({ expectedRowVersion: 2, status: 'entered_in_error', changeReason: 'Recorded on the wrong patient', ...overrides });

describe('EHR-C8b: PATCH .../vitals/:vitalId marks a reading entered in error', () => {
  it('is a PATCH for vitals writers on the visit\'s vitals controller', () => {
    const handler = VitalsController.prototype.markEnteredInError;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':vitalId');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.PATCH);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['ehr.vital.write']);
  });

  it.each([
    ['another status', { status: 'recorded' }],
    ['a reason under 3 characters', { changeReason: ' ab ' }],
    ['a reason over 500 characters', { changeReason: 'x'.repeat(501) }],
    ['a version under 1', { expectedRowVersion: 0 }],
    ['a null reason', { changeReason: null }],
  ])('the body refuses %s (400 VALIDATION_FAILED)', (_label, overrides) => {
    expect(validateSync(plainToInstance(MarkVitalEnteredInErrorDto, body(overrides))).length).toBeGreaterThan(0);
  });

  it('the body takes exactly its three fields, the reason trimmed', () => {
    const dto = plainToInstance(MarkVitalEnteredInErrorDto, body({ changeReason: '  Wrong patient  ' }));
    expect(validateSync(dto)).toEqual([]);
    expect(dto.changeReason).toBe('Wrong patient');
  });

  it('writes the status under write_records, locked first, with the reason on the version row, audited without it',
    async () => {
      const { service, statements, repository, events } = harness();
      const answer = await service.markEnteredInError(context, patientId, encounterId, vitalId,
        body() as MarkVitalEnteredInErrorDto);
      expect(answer).toMatchObject({ id: vitalId, status: 'entered_in_error', rowVersion: '3' });
      expect(events).toEqual([{ access: 'write_records', scopedLookup: expect.any(Function), event: { action: 'ehr.vital.update',
        resourceType: 'vital', resourceId: vitalId, details: { enteredInError: true } } }]);
      expect(repository.exists).toHaveBeenCalledWith(expect.anything(), 'vitals', vitalId, patientId, facilityId, encounterId);
      expect(statements).toHaveLength(2);
      expect(statements[0]!.sql).toMatch(/^select .* from ehr\.vitals where id = \$1 and encounter_id = \$2 and patient_id = \$3 and facility_id = \$4 for update$/);
      expect(statements[0]!.values).toEqual([vitalId, encounterId, patientId, facilityId]);
      expect(repository.setChangeReason).toHaveBeenCalledWith(expect.anything(), 'Recorded on the wrong patient');
      expect(statements[1]!.sql).toMatch(/^update ehr\.vitals set status = 'entered_in_error' where id = \$1 and encounter_id = \$2 and patient_id = \$3 and facility_id = \$4 and row_version = \$5 returning /);
      expect(statements[1]!.values).toEqual([vitalId, encounterId, patientId, facilityId, 2]);
      expect(JSON.stringify(events)).not.toContain('wrong patient');
    });

  it('a missing reason is 400 CHANGE_REASON_REQUIRED before anything is read', async () => {
    const { service, repository } = harness();
    await expect(Promise.resolve().then(() => service.markEnteredInError(context, patientId, encounterId, vitalId,
      body({ changeReason: undefined }) as MarkVitalEnteredInErrorDto))).rejects.toMatchObject({ status: 400,
      code: 'CHANGE_REASON_REQUIRED', message: 'Please say why you are changing this.' });
    expect(repository.run).not.toHaveBeenCalled();
  });

  it('a reason of only spaces is 400 VALIDATION_FAILED from the route\'s validation (trimmed to nothing)', async () => {
    await expect(createValidationPipe().transform(body({ changeReason: '   ' }),
      { type: 'body', metatype: MarkVitalEnteredInErrorDto })).rejects.toMatchObject({ status: 400,
      code: 'VALIDATION_FAILED', errors: [expect.objectContaining({ field: 'changeReason' })] });
  });

  it('a reading of another visit, patient or facility is 404 VITAL_NOT_FOUND after the audited lookup, with nothing read',
    async () => {
      const { service, statements } = harness({ exists: false });
      await expect(service.markEnteredInError(context, patientId, encounterId, vitalId, body() as MarkVitalEnteredInErrorDto))
        .rejects.toMatchObject({ status: 404, code: 'VITAL_NOT_FOUND', message: 'These vitals were not found.' });
      expect(statements).toHaveLength(0);
    });

  it('an unknown reading is 404 VITAL_NOT_FOUND', async () => {
    const { service } = harness({ locked: null });
    await expect(service.markEnteredInError(context, patientId, encounterId, vitalId, body() as MarkVitalEnteredInErrorDto))
      .rejects.toMatchObject({ status: 404, code: 'VITAL_NOT_FOUND', message: 'These vitals were not found.' });
  });

  it('a reading already entered in error is 409, with nothing written', async () => {
    const { service, statements, repository } = harness({ locked: { id: vitalId, status: 'entered_in_error', rowVersion: '3' } });
    await expect(service.markEnteredInError(context, patientId, encounterId, vitalId, body() as MarkVitalEnteredInErrorDto))
      .rejects.toMatchObject({ status: 409, code: 'VITAL_ALREADY_ENTERED_IN_ERROR',
        message: 'These vitals are already marked as entered in error.' });
    expect(statements).toHaveLength(1);
    expect(repository.setChangeReason).not.toHaveBeenCalled();
  });

  it('another version is 412 VERSION_CONFLICT, with nothing written', async () => {
    const { service, statements } = harness({ locked: { id: vitalId, status: 'recorded', rowVersion: '5' } });
    await expect(service.markEnteredInError(context, patientId, encounterId, vitalId, body() as MarkVitalEnteredInErrorDto))
      .rejects.toMatchObject({ status: 412, code: 'VERSION_CONFLICT',
        message: 'Someone else changed these vitals. Reload them and try again.' });
    expect(statements).toHaveLength(1);
  });

  it('no row written is 412', async () => {
    const { service } = harness({ updated: [] });
    await expect(service.markEnteredInError(context, patientId, encounterId, vitalId, body() as MarkVitalEnteredInErrorDto))
      .rejects.toMatchObject({ status: 412, code: 'VERSION_CONFLICT' });
  });

  it.each([
    ['a database without 0142 (no column)', databaseError('42703', 'column "status" of relation "vitals" does not exist')],
    ['any other failure of the write', new Error('Connection terminated unexpectedly')],
  ])('%s is 503 VITALS_STATUS_UNAVAILABLE', async (_label, error) => {
    const { service } = harness({ updated: error });
    await expect(service.markEnteredInError(context, patientId, encounterId, vitalId, body() as MarkVitalEnteredInErrorDto))
      .rejects.toMatchObject({ status: 503, code: 'VITALS_STATUS_UNAVAILABLE',
        message: 'This cannot be done right now. Please try again.' });
  });

  it('0142\'s guard refusing a reading already entered in error is 409', async () => {
    const { service } = harness({ updated: databaseError('55000', 'VITAL_ENTERED_IN_ERROR') });
    await expect(service.markEnteredInError(context, patientId, encounterId, vitalId, body() as MarkVitalEnteredInErrorDto))
      .rejects.toMatchObject({ status: 409, code: 'VITAL_ALREADY_ENTERED_IN_ERROR' });
  });
});

describe('EHR-C8b: every vitals answer carries status; withdrawn readings leave the default reads', () => {
  it('a correction of a reading entered in error is 409 VITAL_ENTERED_IN_ERROR, with nothing written', async () => {
    const { service, statements } = harness({ locked: { id: vitalId, status: 'entered_in_error', rowVersion: '3',
      currentCorrectionNo: 0 } });
    await expect(service.correct(context, patientId, encounterId, vitalId,
      { expectedRowVersion: 3, changeReason: 'Typo', replacementValues: { pulseBpm: 70 } }, 'key-123456789'))
      .rejects.toMatchObject({ status: 409, code: 'VITAL_ENTERED_IN_ERROR', message: VITAL_MESSAGES.enteredInError });
    expect(statements).toHaveLength(1);
  });

  it('a correction of a recorded reading at another version is 412 with the new words', async () => {
    const { service } = harness({ locked: { id: vitalId, status: 'recorded', rowVersion: '4', currentCorrectionNo: 0 } });
    await expect(service.correct(context, patientId, encounterId, vitalId,
      { expectedRowVersion: 3, changeReason: 'Typo', replacementValues: { pulseBpm: 70 } }, 'key-123456789'))
      .rejects.toMatchObject({ status: 412, code: 'VERSION_CONFLICT', message: VITAL_MESSAGES.versionConflict });
  });

  it('the columns read status and its time through the whole row (recorded on a database without 0142)', async () => {
    const { service, statements } = harness();
    await service.get(context, patientId, encounterId, vitalId).catch(() => undefined);
    expect(statements[0]!.sql).toContain(`coalesce(to_jsonb(vitals)->>'status', 'recorded') as status`);
    expect(statements[0]!.sql).toContain(`(to_jsonb(vitals)->>'status_changed_at')::timestamptz as "statusChangedAt"`);
  });

  it.each([
    [undefined, false], ['false', false], ['true', true],
  ] as const)('the list with includeEnteredInError=%s lists withdrawn readings: %s', async (flag, included) => {
    const { service, statements } = harness();
    const query = plainToInstance(VitalsListQueryDto, flag === undefined ? {} : { includeEnteredInError: flag });
    expect(validateSync(query)).toEqual([]);
    await service.list(context, patientId, encounterId, query);
    expect(statements[0]!.sql).toContain(`and ($7 or coalesce(to_jsonb(vitals)->>'status', 'recorded') = 'recorded')`);
    expect(statements[0]!.values[6]).toBe(included);
  });

  it('the list flag takes only true or false', () => {
    expect(validateSync(plainToInstance(VitalsListQueryDto, { includeEnteredInError: 'yes' })).length).toBeGreaterThan(0);
  });

  it('a page cursor belongs to one choice of the flag', async () => {
    const { service, client } = harness();
    client.query.mockImplementationOnce(async () => ({ rows: Array.from({ length: 2 }, (_, index) => ({
      id: `123e4567-e89b-42d3-a456-42661417400${index}`, recordedAt: new Date(), cursorAt: '2026-11-20T00:00:00.000000Z',
      status: 'recorded' })), rowCount: 2 }));
    const page = await service.list(context, patientId, encounterId,
      plainToInstance(VitalsListQueryDto, { limit: 1 })) as { nextCursor?: string };
    expect(page.nextCursor).toEqual(expect.any(String));
    await expect(Promise.resolve().then(() => service.list(context, patientId, encounterId,
      plainToInstance(VitalsListQueryDto, { limit: 1, includeEnteredInError: 'true', cursor: page.nextCursor }))))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
  });

  it('the latest reading of each measure leaves out readings entered in error', () => {
    expect(squash(LATEST_VITALS_SQL)).toContain(
      "where v.patient_id = $1 and v.facility_id = $2 and e.status <> 'entered_in_error' and coalesce(to_jsonb(v)->>'status', 'recorded') = 'recorded'");
  });
});
