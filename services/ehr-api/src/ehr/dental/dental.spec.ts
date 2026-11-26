import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { ArgumentMetadata } from '@nestjs/common';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { createValidationPipe } from '../../common/validation-pipe';
import { getEnvironment, resetEnvironmentForTests } from '../../config/environment';
import type { DatabaseService } from '../../database/database.service';
import type { ClinicalRepository } from '../shared/clinical.repository';
import { DentalController } from './dental.controller';
import {
  DentalChartSaveDto, DentalFollowUpDto, DentalProcedureDoneDto, DentalProcedureRecordDto, DentalProceduresQueryDto,
  DentalVisitsQueryDto,
} from './dental.dto';
import {
  CHART_ERROR_SQL, CHART_SAVE_SQL, DENTAL_MESSAGES, DentalService, FOLLOW_UP_SQL, LISTS_SQL, PROCEDURE_CANCEL_SQL,
  PROCEDURE_DONE_SQL, PROCEDURE_ERROR_SQL, PROCEDURE_RECORD_SQL, SUMMARY_SQL, VISIT_START_SQL, VISITS_LIST_SQL,
  canonicalSurfaces, fdiTooth, followUpWindow, refusal, requireDentalAccess, toothInDentition, translate,
} from './dental.service';

// Fictional identifiers only.
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const encounterId = '123e4567-e89b-42d3-a456-426614174061';
const procedureId = '123e4567-e89b-42d3-a456-426614174071';
const versionId = '123e4567-e89b-42d3-a456-426614174081';
const key = 'dental-test-key-0001';

const DENTIST = ['ehr.dental.read', 'ehr.dental.write', 'ehr.encounter.read', 'ehr.encounter.write'];
const DOCTOR = ['ehr.encounter.read', 'ehr.encounter.write', 'ehr.diagnosis.read', 'ehr.prescription.write'];

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  actor: { id: accountId, subject: 'staff:test', accountId, permissions: [] } } as unknown as DataAccessContext;

const visit = { visitId: '123e4567-e89b-42d3-a456-426614174091', patientId, encounterId,
  encounterStatus: 'in_progress', encounterStartedAt: '2026-12-03T08:40:00.000Z', startedAt: '2026-12-03T08:52:00.000Z',
  startedByMembershipId: membershipId, stage: 'started', followUpOn: null, followUpNote: null, rowVersion: 1 };
const chart = { versionId, versionNo: 1, basedOnVersionId: null, encounterId, dentition: 'permanent',
  recordedAt: '2026-12-03T09:05:00.000Z', recordedByMembershipId: membershipId, listVersion: 'HID-DENT-2026-11-DRAFT',
  listStatus: 'draft', findings: [{ tooth: 36, condition: 'decayed', surfaces: 'MO', note: null }], note: null,
  enteredInError: null };
const procedure = { procedureId, patientId, procedureCode: 'DEN-021', procedureName: 'Composite filling', byName: false,
  listVersion: 'HID-DENT-2026-11-DRAFT', listStatus: 'draft', site: 'tooth_surfaces', tooth: 36, surfaces: 'MO',
  quadrant: null, arch: null, status: 'planned', plannedEncounterId: encounterId, plannedAt: '2026-12-03T09:10:00.000Z',
  plannedByMembershipId: membershipId, doneEncounterId: null, doneAt: null, performedByMembershipId: null, signedAt: null,
  anaesthetic: null, notes: null, cancelled: null, enteredInError: null, rowVersion: 1 };

function fakeDatabase(rows: readonly Record<string, unknown>[] | Error) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const database = {
    withTransaction: jest.fn(async (_given: DataAccessContext, operation: (client: unknown) => Promise<unknown>) =>
      operation({
        query: async (sql: string, values: unknown[]) => {
          calls.push({ sql, values });
          if (rows instanceof Error) throw rows;
          return { rows };
        },
      })),
  } as unknown as DatabaseService;
  return { database, calls };
}

const noRepository = {} as ClinicalRepository;

async function validate<T>(type: new () => T, value: unknown, kind: ArgumentMetadata['type'] = 'body'): Promise<T> {
  return createValidationPipe().transform(value, { type: kind, metatype: type }) as Promise<T>;
}

async function problemOf(promise: Promise<unknown> | (() => unknown)): Promise<DomainProblem> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainProblem);
    return error as DomainProblem;
  }
  throw new Error('expected a refusal');
}

function staffRequest(permissions: string[], purpose = 'direct-care'): HidRequest {
  return {
    header: (name: string) => (name.toLowerCase() === 'x-purpose-of-use' ? purpose : undefined),
    correlationId: 'correlation-123456', facilityId, method: 'POST',
    actor: { kind: 'staff', id: accountId, subject: 'staff:test', accountId, permissions, roles: ['dentist'],
      facilityIds: [facilityId], facilities: [], facility: { id: facilityId, membershipId } },
  } as unknown as HidRequest;
}

describe('DEN-1 the dental clinic (0194, 0195)', () => {
  const original = { ...process.env };
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost:5432/hid',
    CORS_ORIGINS: 'http://localhost:3000', STORAGE_MODE: 'disabled' };
  beforeEach(() => {
    Object.assign(process.env, base, { DENTAL_ENABLED: 'true' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('is off unless set to true, and photos are off unless set to true', () => {
    delete process.env.DENTAL_ENABLED;
    resetEnvironmentForTests();
    expect(getEnvironment().DENTAL_ENABLED).toBe(false);
    expect(getEnvironment().DENTAL_PHOTOS_ENABLED).toBe(false);
  });

  it('serves the fourteen routes of the contract', () => {
    const routes = Object.getOwnPropertyNames(DentalController.prototype).filter((name) => name !== 'constructor')
      .map((name) => {
        const handler = (DentalController.prototype as unknown as Record<string, object>)[name] as object;
        return `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]} ${Reflect.getMetadata(PATH_METADATA,
          handler) as string} ${(Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined) ?? ''}`.trim();
      });
    expect(Reflect.getMetadata(PATH_METADATA, DentalController)).toBe('ehr');
    expect(routes).toEqual([
      'GET dental/lists',
      'POST patients/:patientId/encounters/:encounterId/dental-visit 201',
      'GET patients/:patientId/encounters/:encounterId/dental-visit',
      'PATCH patients/:patientId/encounters/:encounterId/dental-visit 200',
      'GET dental-visits',
      'GET patients/:patientId/dental-chart',
      'POST patients/:patientId/encounters/:encounterId/dental-chart 201',
      'POST patients/:patientId/dental-chart/:versionId/entered-in-error 200',
      'POST patients/:patientId/encounters/:encounterId/dental-procedures 201',
      'POST patients/:patientId/encounters/:encounterId/dental-procedures/:procedureId/done 200',
      'POST patients/:patientId/dental-procedures/:procedureId/cancel 200',
      'POST patients/:patientId/dental-procedures/:procedureId/entered-in-error 200',
      'GET patients/:patientId/dental-procedures',
      'GET patients/:patientId/encounters/:encounterId/dental-summary',
    ]);
    expect(routes.join(' ')).not.toMatch(/health-?id|nin/i);
  });

  it('answers 503 DENTAL_NOT_AVAILABLE on every route while DENTAL_ENABLED is off, before anything else', async () => {
    delete process.env.DENTAL_ENABLED;
    resetEnvironmentForTests();
    const { database, calls } = fakeDatabase([]);
    const controller = new DentalController(new DentalService(database, noRepository));
    const request = staffRequest([], 'emergency');
    const attempts: (() => unknown)[] = [
      () => controller.lists(request),
      () => controller.startVisit(request, patientId, encounterId, undefined, {}),
      () => controller.readVisit(request, patientId, encounterId),
      () => controller.followUp(request, patientId, encounterId, undefined, { expectedRowVersion: 1 } as DentalFollowUpDto),
      () => controller.listVisits(request, {}),
      () => controller.readChart(request, patientId, {}),
      () => controller.saveChart(request, patientId, encounterId, undefined, {} as DentalChartSaveDto),
      () => controller.chartEnteredInError(request, patientId, versionId, undefined, {}),
      () => controller.recordProcedure(request, patientId, encounterId, undefined, {} as DentalProcedureRecordDto),
      () => controller.procedureDone(request, patientId, encounterId, procedureId, undefined, {} as DentalProcedureDoneDto),
      () => controller.cancelProcedure(request, patientId, procedureId, undefined, { expectedRowVersion: 1 }),
      () => controller.procedureEnteredInError(request, patientId, procedureId, undefined, { expectedRowVersion: 1 }),
      () => controller.listProcedures(request, patientId, {}),
      () => controller.summary(request, patientId, encounterId),
    ];
    for (const attempt of attempts) {
      const refused = await problemOf(attempt);
      expect([refused.getStatus(), refused.code, refused.message]).toEqual([503, 'DENTAL_NOT_AVAILABLE',
        DENTAL_MESSAGES.notAvailable]);
    }
    expect(calls).toHaveLength(0);
  });

  it('needs direct care, a dental code (dentists only, Q-DEN-1 A) and the write code for writes', async () => {
    const { database, calls } = fakeDatabase([]);
    const controller = new DentalController(new DentalService(database, noRepository));
    const purpose = await problemOf(() => controller.lists(staffRequest(DENTIST, 'emergency')));
    expect([purpose.getStatus(), purpose.code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
    const doctor = await problemOf(() => controller.readChart(staffRequest(DOCTOR), patientId, {}));
    expect([doctor.getStatus(), doctor.code, doctor.message]).toEqual([403, 'DENTAL_NOT_ALLOWED', DENTAL_MESSAGES.notAllowed]);
    const readOnly = await problemOf(() => controller.startVisit(staffRequest(['ehr.dental.read']), patientId,
      encounterId, key, {}));
    expect(readOnly.code).toBe('DENTAL_NOT_ALLOWED');
    expect(() => requireDentalAccess(staffRequest(['ehr.dental.read']), 'read')).not.toThrow();
    expect(JSON.stringify(DENTAL_MESSAGES)).not.toMatch(/permission/i);
    expect(calls).toHaveLength(0);
  });

  it('needs an Idempotency-Key on every write, and route 2 takes an empty body only', async () => {
    const { database, calls } = fakeDatabase([]);
    const controller = new DentalController(new DentalService(database, noRepository));
    const request = staffRequest(DENTIST);
    expect((await problemOf(() => controller.startVisit(request, patientId, encounterId, undefined, {}))).code)
      .toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await problemOf(() => controller.cancelProcedure(request, patientId, procedureId, 'short',
      { expectedRowVersion: 1, reason: 'Patient chose to wait' }))).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const extra = await problemOf(() => controller.startVisit(request, patientId, encounterId, key, { healthId: 'x' }));
    expect([extra.code, extra.errors?.[0]?.field]).toEqual(['VALIDATION_FAILED', 'healthId']);
    expect(calls).toHaveLength(0);
  });

  it('validates bodies and queries with the global pipe: unknown fields are refused', async () => {
    await expect(validate(DentalChartSaveDto, { dentition: 'permanent', findings: [], healthId: 'HID-X' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(validate(DentalChartSaveDto, { dentition: 'adult', findings: [] }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(validate(DentalChartSaveDto, { dentition: 'mixed', findings: [{ tooth: 36, condition: 'decayed',
      colour: 'grey' }] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(validate(DentalChartSaveDto, { dentition: 'mixed',
      findings: Array.from({ length: 201 }, () => ({ tooth: 36, condition: 'missing' })) }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(validate(DentalProcedureRecordDto, { status: 'done', procedureCode: 'DEN-040', tooth: 38,
      anaesthetic: { agentCode: 'none', dose: 2 } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(validate(DentalProcedureRecordDto, { status: 'cancelled', procedureCode: 'DEN-040' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(validate(DentalProcedureRecordDto, { status: 'done', procedureCode: 'DEN-040', tooth: 38,
      doneAt: '2026-12-03 09:30' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(validate(DentalVisitsQueryDto, { days: '31' }, 'query')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(validate(DentalVisitsQueryDto, { days: '7' }, 'query')).resolves.toMatchObject({ days: 7 });
    await expect(validate(DentalProceduresQueryDto, { status: 'cancelled' }, 'query'))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(validate(DentalFollowUpDto, { expectedRowVersion: 1, followUpOn: '3 June 2027' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const saved = await validate(DentalChartSaveDto, { basedOnVersionId: null, dentition: 'permanent',
      findings: [{ tooth: 36, condition: 'decayed', surfaces: 'om', note: '  deep  ' }], note: ' plaque ' });
    expect([saved.findings[0]?.note, saved.note]).toEqual(['deep', 'plaque']);
  });

  it('checks FDI teeth, the dentition and the surfaces as the contract says', () => {
    expect([11, 18, 28, 38, 48, 51, 55, 65, 75, 85].every(fdiTooth)).toBe(true);
    expect([10, 19, 29, 49, 50, 56, 86, 91, 9, 100, 36.5].some(fdiTooth)).toBe(false);
    expect([toothInDentition(36, 'permanent'), toothInDentition(55, 'permanent'), toothInDentition(55, 'primary'),
      toothInDentition(36, 'primary'), toothInDentition(55, 'mixed'), toothInDentition(36, 'mixed')])
      .toEqual([true, false, true, false, true, true]);
    expect([canonicalSurfaces('om'), canonicalSurfaces('LBDOM'), canonicalSurfaces('MM'), canonicalSurfaces('X'),
      canonicalSurfaces(''), canonicalSurfaces('MODBLM')]).toEqual(['MO', 'MODBL', undefined, undefined, undefined, undefined]);
  });

  it('takes a follow-up from tomorrow to two years ahead, in Lagos days', () => {
    const now = new Date('2026-12-03T23:30:00Z'); // 00:30 on 4 December in Lagos
    expect(['2026-12-04', '2026-12-05', '2028-12-04', '2028-12-05', '2027-02-30', '2026-12-03']
      .map((date) => followUpWindow(date, now))).toEqual([false, true, true, false, false, false]);
  });

  it('route 1: the lists, their draft status and photosAvailable from DENTAL_PHOTOS_ENABLED', async () => {
    const { database, calls } = fakeDatabase([
      { kind: 'anaesthetic', version_label: 'HID-DENT-2026-11-DRAFT', status: 'draft', code: 'none',
        label: 'No local anaesthetic', category: null, site: null, takes_surfaces: null },
      { kind: 'procedure', version_label: 'HID-DENT-2026-11-DRAFT', status: 'draft', code: 'DEN-021',
        label: 'Composite filling', category: 'restorative', site: 'tooth_surfaces', takes_surfaces: null },
      { kind: 'tooth_condition', version_label: 'HID-DENT-2026-11-DRAFT', status: 'draft', code: 'decayed',
        label: 'Decayed', category: null, site: null, takes_surfaces: true },
    ]);
    const lists = await new DentalService(database, noRepository).lists(context);
    expect(calls[0]?.sql).toBe(LISTS_SQL);
    expect(lists).toEqual({
      toothConditions: { version: 'HID-DENT-2026-11-DRAFT', status: 'draft',
        items: [{ code: 'decayed', label: 'Decayed', takesSurfaces: true }] },
      procedures: { version: 'HID-DENT-2026-11-DRAFT', status: 'draft',
        items: [{ code: 'DEN-021', name: 'Composite filling', category: 'restorative', site: 'tooth_surfaces' }] },
      anaesthetics: { version: 'HID-DENT-2026-11-DRAFT', status: 'draft', items: [{ code: 'none', name: 'No local anaesthetic' }] },
      techniques: { version: null, status: null, items: [] },
      surfaces: ['M', 'O', 'D', 'B', 'L'], photosAvailable: false,
    });
    process.env.DENTAL_PHOTOS_ENABLED = 'true';
    resetEnvironmentForTests();
    expect((await new DentalService(fakeDatabase([]).database, noRepository).lists(context)).photosAvailable).toBe(true);
  });

  it('route 2: started, already started and a replay; the digest names the patient and visit', async () => {
    const { database, calls } = fakeDatabase([{ outcome: 'started', replayed: false, visit }]);
    const service = new DentalService(database, noRepository);
    await expect(service.startVisit(context, patientId, encounterId, key))
      .resolves.toEqual({ outcome: 'started', visit, replayed: false });
    expect(calls[0]?.sql).toBe(VISIT_START_SQL);
    expect(calls[0]?.values.slice(0, 3)).toEqual([patientId, encounterId, key]);
    expect(calls[0]?.values[3]).toMatch(/^[0-9a-f]{64}$/);
    const replay = new DentalService(fakeDatabase([{ outcome: 'already_started', replayed: true, visit }]).database,
      noRepository);
    await expect(replay.startVisit(context, patientId, encounterId, key))
      .resolves.toEqual({ outcome: 'already_started', visit, replayed: true });
  });

  it('route 4: at least one field, the window, and the unchanged field kept out of the call', async () => {
    const service = new DentalService(fakeDatabase([]).database, noRepository);
    expect((await problemOf(service.followUp(context, patientId, encounterId, { expectedRowVersion: 1 }, key))).code)
      .toBe('VALIDATION_FAILED');
    expect((await problemOf(service.followUp(context, patientId, encounterId,
      { expectedRowVersion: 1, followUpOn: '2020-01-01' }, key))).code).toBe('DENTAL_FOLLOW_UP_INVALID');
    const { database, calls } = fakeDatabase([{ outcome: 'updated', replayed: false, visit }]);
    await new DentalService(database, noRepository).followUp(context, patientId, encounterId,
      { expectedRowVersion: 2, followUpNote: 'Recall for scaling' }, key);
    expect(calls[0]?.sql).toBe(FOLLOW_UP_SQL);
    expect(calls[0]?.values.slice(0, 7)).toEqual([patientId, encounterId, 2, false, null, true, 'Recall for scaling']);
  });

  it('route 5: cards and hiddenCount; a counts-only row is no item', async () => {
    const card = { patientId, fullName: 'Ada Toothone', sex: 'female', dateOfBirth: '1990-05-14', healthIdLast4: 'DE77' };
    const { database, calls } = fakeDatabase([{ ord: '1', patient: card, visit, hidden_count: 2, has_more: false }]);
    await expect(new DentalService(database, noRepository).listVisits(context, 7))
      .resolves.toEqual({ items: [{ patient: card, visit }], hiddenCount: 2, hasMore: false, limit: 200 });
    expect([calls[0]?.sql, calls[0]?.values]).toEqual([VISITS_LIST_SQL, [7]]);
    const none = fakeDatabase([{ ord: '0', patient: null, visit: null, hidden_count: 3, has_more: false }]);
    await expect(new DentalService(none.database, noRepository).listVisits(context, 1))
      .resolves.toEqual({ items: [], hiddenCount: 3, hasMore: false, limit: 200 });
  });

  it('route 7: refuses before the database on bad teeth, surfaces, conditions and duplicates; sends MODBL order', async () => {
    const { database, calls } = fakeDatabase([{ outcome: 'saved', replayed: false, chart }]);
    const service = new DentalService(database, noRepository);
    const save = (findings: DentalChartSaveDto['findings'], dentition: DentalChartSaveDto['dentition'] = 'permanent') =>
      service.saveChart(context, patientId, encounterId, { dentition, findings } as DentalChartSaveDto, key);
    expect((await problemOf(save([{ tooth: 19, condition: 'missing' }]))).code).toBe('DENTAL_TOOTH_INVALID');
    expect((await problemOf(save([{ tooth: 55, condition: 'missing' }]))).code).toBe('DENTAL_TOOTH_INVALID');
    expect((await problemOf(save([{ tooth: 36, condition: 'decayed', surfaces: 'MX' }]))).code)
      .toBe('DENTAL_SURFACES_INVALID');
    expect((await problemOf(save([{ tooth: 36, condition: 'Not A Code' }]))).code).toBe('DENTAL_CONDITION_INVALID');
    expect((await problemOf(save([{ tooth: 36, condition: 'missing' }, { tooth: 36, condition: 'missing' }]))).code)
      .toBe('VALIDATION_FAILED');
    expect(calls).toHaveLength(0);
    await expect(save([{ tooth: 55, condition: 'decayed', surfaces: 'om' }], 'mixed'))
      .resolves.toEqual({ chart, replayed: false });
    expect(calls[0]?.sql).toBe(CHART_SAVE_SQL);
    expect(JSON.parse(calls[0]?.values[4] as string)).toEqual([{ tooth: 55, condition: 'decayed', surfaces: 'MO', note: null }]);
  });

  it('route 8: a reason of at least 8 characters; the answer is the newest chart after the change', async () => {
    const service = new DentalService(fakeDatabase([]).database, noRepository);
    expect((await problemOf(service.chartEnteredInError(context, patientId, versionId, 'short', key))).code)
      .toBe('DENTAL_REASON_REQUIRED');
    const { database, calls } = fakeDatabase([{ outcome: 'updated', replayed: false, chart: null }]);
    await expect(new DentalService(database, noRepository).chartEnteredInError(context, patientId, versionId,
      'Charted the wrong patient', key)).resolves.toEqual({ chart: null, replayed: false });
    expect(calls[0]?.sql).toBe(CHART_ERROR_SQL);
  });

  it('route 9: the procedure, site and anaesthetic rules (Q-DEN-5 A, Q-DEN-6 A)', async () => {
    const service = new DentalService(fakeDatabase([]).database, noRepository);
    const record = (input: Partial<DentalProcedureRecordDto>) =>
      service.recordProcedure(context, patientId, encounterId, { status: 'planned', ...input } as DentalProcedureRecordDto, key);
    expect((await problemOf(record({ procedureCode: 'DEN-021', procedureName: 'Filling' }))).code)
      .toBe('DENTAL_PROCEDURE_INVALID');
    expect((await problemOf(record({}))).code).toBe('DENTAL_PROCEDURE_INVALID');
    expect((await problemOf(record({ procedureCode: 'D2391' }))).code).toBe('DENTAL_PROCEDURE_INVALID');
    expect((await problemOf(record({ procedureName: 'Gum massage' }))).code).toBe('DENTAL_SITE_INVALID');
    expect((await problemOf(record({ procedureName: 'Gum massage', site: 'tooth' }))).code).toBe('DENTAL_SITE_INVALID');
    expect((await problemOf(record({ procedureName: 'Gum massage', site: 'quadrant', quadrant: 5 }))).code)
      .toBe('DENTAL_SITE_INVALID');
    expect((await problemOf(record({ procedureCode: 'DEN-040', tooth: 49 }))).code).toBe('DENTAL_TOOTH_INVALID');
    expect((await problemOf(record({ procedureCode: 'DEN-021', tooth: 36, surfaces: 'OO' }))).code)
      .toBe('DENTAL_SURFACES_INVALID');
    expect((await problemOf(record({ procedureCode: 'DEN-040', tooth: 38, anaesthetic: { agentCode: 'none' } }))).code)
      .toBe('DENTAL_ANAESTHETIC_INVALID');
    expect((await problemOf(record({ status: 'done', procedureCode: 'DEN-040', tooth: 38 }))).code)
      .toBe('DENTAL_ANAESTHETIC_INVALID');
    for (const anaesthetic of [{ agentCode: 'none', techniqueCode: 'infiltration' },
      { agentCode: 'lidocaine_2_adrenaline', techniqueCode: 'infiltration' },
      { agentCode: 'lidocaine_2_adrenaline', techniqueCode: 'infiltration', cartridges: 0.3 },
      { agentCode: 'lidocaine_2_adrenaline', techniqueCode: 'infiltration', cartridges: 10.5 },
      { agentCode: 'other', techniqueCode: 'infiltration', cartridges: 1 }]) {
      expect((await problemOf(record({ status: 'done', procedureCode: 'DEN-040', tooth: 38, anaesthetic })))
        .code).toBe('DENTAL_ANAESTHETIC_INVALID');
    }
    const { database, calls } = fakeDatabase([{ outcome: 'recorded', replayed: false, procedure }]);
    await new DentalService(database, noRepository).recordProcedure(context, patientId, encounterId, {
      status: 'done', procedureCode: 'DEN-021', tooth: 36, surfaces: 'om', doneAt: '2026-12-03T09:30:00Z',
      anaesthetic: { agentCode: 'lidocaine_2_adrenaline', techniqueCode: 'inferior_alveolar_block', cartridges: 1.5 },
    } as DentalProcedureRecordDto, key);
    expect(calls[0]?.sql).toBe(PROCEDURE_RECORD_SQL);
    expect(calls[0]?.values.slice(0, 17)).toEqual([patientId, encounterId, 'done', 'DEN-021', null, null, 36, 'MO', null,
      null, '2026-12-03T09:30:00Z', 'lidocaine_2_adrenaline', null, 'inferior_alveolar_block', 1.5, null, key]);
  });

  it('routes 10-12: done, cancel and entered in error go to their functions with the row version', async () => {
    const done = fakeDatabase([{ outcome: 'updated', replayed: false, procedure: { ...procedure, status: 'done' } }]);
    await new DentalService(done.database, noRepository).procedureDone(context, patientId, encounterId, procedureId, {
      expectedRowVersion: 1, anaesthetic: { agentCode: 'none' }, surfaces: 'dom' } as DentalProcedureDoneDto, key);
    expect(done.calls[0]?.sql).toBe(PROCEDURE_DONE_SQL);
    expect(done.calls[0]?.values.slice(0, 14)).toEqual([patientId, encounterId, procedureId, 1, null, 'none', null, null,
      null, true, 'MOD', false, null, key]);
    const service = new DentalService(fakeDatabase([]).database, noRepository);
    expect((await problemOf(service.cancelProcedure(context, patientId, procedureId, 1, undefined, key))).code)
      .toBe('DENTAL_REASON_REQUIRED');
    const cancel = fakeDatabase([{ outcome: 'updated', replayed: true, procedure: { ...procedure, status: 'cancelled' } }]);
    await expect(new DentalService(cancel.database, noRepository).cancelProcedure(context, patientId, procedureId, 1,
      'Patient chose to wait', key)).resolves.toMatchObject({ replayed: true, procedure: { status: 'cancelled' } });
    expect(cancel.calls[0]?.sql).toBe(PROCEDURE_CANCEL_SQL);
    const error = fakeDatabase([{ outcome: 'not_signer', replayed: false, procedure: null }]);
    const refused = await problemOf(new DentalService(error.database, noRepository).procedureEnteredInError(context,
      patientId, procedureId, 2, 'Recorded on the wrong tooth', key));
    expect([refused.getStatus(), refused.code, refused.message]).toEqual([403, 'DENTAL_NOT_SIGNER', DENTAL_MESSAGES.notSigner]);
    expect(error.calls[0]?.sql).toBe(PROCEDURE_ERROR_SQL);
  });

  it('route 14: the dental part, then the visit''s diagnoses and prescriptions under the same consent', async () => {
    const { database, calls } = fakeDatabase([{ outcome: 'found', patient: { patientId, fullName: 'Ada Toothone',
      sex: 'female', dateOfBirth: '1990-05-14', healthIdLast4: 'DE77' }, facility_name: 'Fictional Dental Clinic', visit,
      encounter: { startedAt: visit.encounterStartedAt, endedAt: null, status: 'in_progress', chiefComplaint: 'Toothache' },
      chart, done_this_visit: [], planned_procedures: [procedure], list_status: 'draft',
      printed_at: new Date('2026-12-03T09:50:00Z') }]);
    const queries: string[] = [];
    const repository = {
      run: jest.fn(async (_context: unknown, givenPatient: string, access: string, event: { action: string },
        operation: (client: unknown) => Promise<{ value: unknown }>) => {
        expect([givenPatient, access, event.action]).toEqual([patientId, 'read_records', 'ehr.dental.summary.orders']);
        return (await operation({ query: async (sql: string) => {
          queries.push(sql);
          return { rows: sql.includes('ehr.diagnoses')
            ? [{ codeSystem: 'ICD-11', code: 'DA08.0', display: 'Dental caries', clinicalStatus: 'active' }]
            : [{ medicationDisplay: 'Amoxicillin 500 mg', doseQuantity: '1', doseUnit: 'capsule', routeCode: 'oral',
              frequency: 'three times a day', instructions: 'After food', startsOn: '2026-12-03', endsOn: '2026-12-08',
              status: 'active' }] };
        } })).value;
      }),
      encounterExists: jest.fn(),
    } as unknown as ClinicalRepository;
    const summary = await new DentalService(database, repository).summary(context, patientId, encounterId);
    expect(calls[0]?.sql).toBe(SUMMARY_SQL);
    expect(queries.join(' ')).toMatch(/verification_status <> 'entered_in_error'[\s\S]*status not in \('cancelled', 'entered_in_error'\)/);
    expect(summary).toMatchObject({ facilityName: 'Fictional Dental Clinic', listStatus: 'draft',
      printedAt: '2026-12-03T09:50:00.000Z', diagnoses: [{ code: 'DA08.0' }],
      prescriptions: [{ doseQuantity: 1, startsOn: '2026-12-03' }], plannedProcedures: [procedure] });
    const missing = new DentalService(fakeDatabase([{ outcome: 'visit_not_found' }]).database, repository);
    expect((await problemOf(missing.summary(context, patientId, encounterId))).code).toBe('DENTAL_VISIT_NOT_FOUND');
  });

  it('answers every refusal the database gives with the contract''s code and status', () => {
    const pairs = ['consent_required', 'encounter_not_found', 'visit_encounter_invalid', 'visit_closed',
      'visit_not_started', 'visit_not_found', 'chart_not_found', 'chart_changed', 'chart_not_latest',
      'procedure_not_found', 'procedure_not_planned', 'procedure_not_done', 'not_signer', 'version_conflict',
      'key_reused'].map((outcome) => {
      const answer = refusal(outcome);
      return `${outcome}:${answer.getStatus()}:${answer.code}`;
    });
    expect(pairs).toEqual(['consent_required:403:CONSENT_REQUIRED', 'encounter_not_found:404:ENCOUNTER_NOT_FOUND',
      'visit_encounter_invalid:400:DENTAL_VISIT_ENCOUNTER_INVALID', 'visit_closed:409:DENTAL_VISIT_CLOSED',
      'visit_not_started:409:DENTAL_VISIT_NOT_STARTED', 'visit_not_found:404:DENTAL_VISIT_NOT_FOUND',
      'chart_not_found:404:DENTAL_CHART_NOT_FOUND', 'chart_changed:409:DENTAL_CHART_CHANGED',
      'chart_not_latest:409:DENTAL_CHART_NOT_LATEST', 'procedure_not_found:404:DENTAL_PROCEDURE_NOT_FOUND',
      'procedure_not_planned:409:DENTAL_PROCEDURE_NOT_PLANNED', 'procedure_not_done:409:DENTAL_PROCEDURE_NOT_DONE',
      'not_signer:403:DENTAL_NOT_SIGNER', 'version_conflict:412:DENTAL_VERSION_CONFLICT',
      'key_reused:409:IDEMPOTENCY_KEY_REUSED']);
  });

  it('translates the database''s raised refusals, and a schema without 0195 to 503', () => {
    const of = (code: string, message: string) => translate(Object.assign(new Error(message), { code })) as DomainProblem;
    expect([of('42501', 'DENTAL_NOT_ALLOWED').code, of('22023', 'DENTAL_DIRECT_CARE_ONLY').code,
      of('22023', 'DENTAL_TOOTH_INVALID').code, of('22023', 'DENTAL_CONDITION_INVALID').code,
      of('22023', 'DENTAL_DONE_TIME_INVALID').code, of('22023', 'DENTAL_FOLLOW_UP_INVALID').code,
      of('22023', 'DENTAL_IDEMPOTENCY_KEY_INVALID').code, of('22023', 'DENTAL_VALIDATION').code,
      of('40P01', 'deadlock').code, of('42883', 'function does not exist').code, of('42P01', 'relation').code])
      .toEqual(['DENTAL_NOT_ALLOWED', 'PURPOSE_OF_USE_REQUIRED', 'DENTAL_TOOTH_INVALID', 'DENTAL_CONDITION_INVALID',
        'DENTAL_DONE_TIME_INVALID', 'DENTAL_FOLLOW_UP_INVALID', 'IDEMPOTENCY_KEY_REQUIRED', 'VALIDATION_FAILED',
        'DENTAL_VERSION_CONFLICT', 'DENTAL_NOT_AVAILABLE', 'DENTAL_NOT_AVAILABLE']);
    const other = new Error('boom');
    expect(translate(other)).toBe(other);
  });

  it('passes a database refusal on through the service', async () => {
    const { database } = fakeDatabase(Object.assign(new Error('DENTAL_NOT_ALLOWED'), { code: '42501' }));
    const refused = await problemOf(new DentalService(database, noRepository).readChart(context, patientId, undefined));
    expect([refused.getStatus(), refused.code]).toEqual([403, 'DENTAL_NOT_ALLOWED']);
  });
});
