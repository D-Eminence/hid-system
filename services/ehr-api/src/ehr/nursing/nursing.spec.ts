import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { ArgumentMetadata } from '@nestjs/common';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { createValidationPipe } from '../../common/validation-pipe';
import { getEnvironment, resetEnvironmentForTests } from '../../config/environment';
import type { DatabaseService } from '../../database/database.service';
import { CreatePrescriptionBodyPipe, PrescriptionDispensingDetails } from '../prescriptions/prescription-dispensing-details';
import {
  PrescriptionInpatientSchedule, scheduleProblem, type InpatientScheduleDto,
} from '../prescriptions/inpatient-schedule';
import { CreateVitalDto } from '../shared/clinical.dto';
import { checkObservationRules, observationColumnsSql, requireObservationFieldsAllowed } from '../vitals/observation-fields';
import { NursingController } from './nursing.controller';
import {
  CreateTaskDto, FluidEntryDto, RecordDoseDto, SetAssignmentsDto, TaskListQueryDto,
} from './nursing.dto';
import {
  NURSING_MESSAGES, NursingService, readingFlags, refusal, requireNursingAccess, translate,
} from './nursing.service';

// Fictional identifiers only.
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const admissionId = '123e4567-e89b-42d3-a456-426614174071';
const wardId = '123e4567-e89b-42d3-a456-426614174081';
const prescriptionId = '123e4567-e89b-42d3-a456-426614174091';
const taskId = '123e4567-e89b-42d3-a456-426614174061';
const shiftId = '123e4567-e89b-42d3-a456-426614174051';
const handoverId = '123e4567-e89b-42d3-a456-426614174041';
const key = 'nursing-test-key-0001';

const NURSE = ['ehr.vital.read', 'ehr.vital.write', 'ehr.admission.read', 'ehr.ward.read', 'ehr.mar.read',
  'ehr.mar.record', 'ehr.nursing-task.read', 'ehr.nursing-task.write', 'ehr.handover.write',
  'ehr.shift-assignment.manage'];
const DOCTOR = ['ehr.vital.read', 'ehr.vital.write', 'ehr.admission.read', 'ehr.mar.read', 'ehr.mar.record',
  'ehr.nursing-task.read', 'ehr.nursing-task.write'];
const ADMIN = ['ehr.ward.manage', 'ehr.shift-assignment.manage', 'ehr.clinical-shift.manage'];
const DESK = ['ehr.vital.read', 'identity.patient.read'];

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  actor: { id: accountId, subject: 'staff:test', accountId, permissions: [] } } as unknown as DataAccessContext;

function fakeDatabase(answers: readonly unknown[] | Error) {
  const calls: { sql: string; values: unknown[] }[] = [];
  let index = 0;
  const database = {
    withTransaction: jest.fn(async (_given: DataAccessContext, operation: (client: unknown) => Promise<unknown>) =>
      operation({
        query: async (sql: string, values: unknown[]) => {
          calls.push({ sql, values });
          if (answers instanceof Error) throw answers;
          const answer = answers[Math.min(index, answers.length - 1)];
          index += 1;
          if (answer instanceof Error) throw answer;
          return { rows: [{ answer }] };
        },
      })),
  } as unknown as DatabaseService;
  return { database, calls };
}

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

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
    actor: { kind: 'staff', id: accountId, subject: 'staff:test', accountId, permissions, roles: ['nurse'],
      facilityIds: [facilityId], facilities: [], facility: { id: facilityId, membershipId } },
  } as unknown as HidRequest;
}

describe('NUR-1 nursing on the ward (0174-0177)', () => {
  const original = { ...process.env };
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost:5432/hid',
    CORS_ORIGINS: 'http://localhost:3000', STORAGE_MODE: 'disabled' };
  beforeEach(() => {
    Object.assign(process.env, base, { INPATIENT_ENABLED: 'true', NURSING_ENABLED: 'true' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  describe('the flag', () => {
    it('is off unless set to true', () => {
      delete process.env.NURSING_ENABLED;
      resetEnvironmentForTests();
      expect(getEnvironment().NURSING_ENABLED).toBe(false);
    });

    it.each([['NURSING_ENABLED'], ['INPATIENT_ENABLED']])(
      'while %s is off, every route answers 503 NURSING_NOT_AVAILABLE before reading anything', async (flag) => {
        process.env[flag] = 'false';
        resetEnvironmentForTests();
        const { database, calls } = fakeDatabase([{}]);
        const controller = new NursingController(new NursingService(database));
        const request = staffRequest([...NURSE, ...ADMIN], 'healthcare-operations');
        const direct = staffRequest(NURSE);
        for (const call of [
          () => controller.chart(direct, admissionId, {}),
          () => controller.medicineRound(direct, admissionId, {}),
          () => controller.wardRound(direct, { wardId }),
          () => controller.recordDose(direct, admissionId, key, {} as RecordDoseDto),
          () => controller.tasks(direct, {}),
          () => controller.createTask(direct, admissionId, key, {} as CreateTaskDto),
          () => controller.fluidDay(direct, admissionId, {}),
          () => controller.shifts(request),
          () => controller.handover(direct, { wardId, date: '2026-12-03', shiftId }),
          () => controller.give(direct, handoverId, key, { expectedRowVersion: 1 }),
        ]) {
          const problem = await problemOf(call);
          expect([problem.getStatus(), problem.code, problem.message])
            .toEqual([503, 'NURSING_NOT_AVAILABLE', NURSING_MESSAGES.notAvailable]);
        }
        expect(calls).toEqual([]);
      });
  });

  describe('who may use each route (Q200 A), in plain words', () => {
    it.each<[string, string[], Parameters<typeof requireNursingAccess>[1], string | null]>([
      ['a nurse reads the chart', NURSE, 'chart', null],
      ['the front desk (vitals, no admissions) cannot read the chart', DESK, 'chart', 'NURSING_NOT_ALLOWED'],
      ['a doctor records doses', DOCTOR, 'mar_record', null],
      ['the front desk cannot record doses', DESK, 'mar_record', 'MAR_RECORD_NOT_ALLOWED'],
      ['a doctor cannot write handover notes', DOCTOR, 'handover', 'NURSING_NOT_ALLOWED'],
      ['a nurse assigns shifts', NURSE, 'assign', null],
      ['a doctor cannot assign shifts', DOCTOR, 'assign', 'SHIFT_ASSIGN_NOT_ALLOWED'],
      ['a nurse cannot set up shifts', NURSE, 'shift_setup', 'SHIFT_SETUP_NOT_ALLOWED'],
      ['an admin sets up shifts', ADMIN, 'shift_setup', null],
      ['an admin sees the shift list', ADMIN, 'shift_list', null],
      ['an admin cannot see the medicine round', ADMIN, 'mar_read', 'NURSING_NOT_ALLOWED'],
    ])('%s', (_name, permissions, access, code) => {
      const check = () => requireNursingAccess(staffRequest(permissions), access);
      if (code === null) {
        expect(check).not.toThrow();
      } else {
        let problem: DomainProblem | undefined;
        try { check(); } catch (error) { problem = error as DomainProblem; }
        expect([problem?.getStatus(), problem?.code]).toEqual([403, code]);
        expect(problem?.message).not.toMatch(/permission/i);
      }
    });

    it('needs direct care, and healthcare operations for shift setup', async () => {
      const { database } = fakeDatabase([{ outcome: 'created', shiftId }]);
      const controller = new NursingController(new NursingService(database));
      const problem = await problemOf(() => controller.createShift(staffRequest(ADMIN), key,
        { name: 'Morning', startsAt: '07:30', endsAt: '14:30' }));
      expect([problem.getStatus(), problem.code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
      await expect(controller.createShift(staffRequest(ADMIN, 'healthcare-operations'), key,
        { name: 'Morning', startsAt: '07:30', endsAt: '14:30' })).resolves.toEqual({ shiftId, replayed: false });
    });
  });

  describe('the observation chart (Q195 A, Q199 A, Q202 A)', () => {
    const reading = (values: Record<string, unknown>, status = 'recorded') => ({ vitalId: prescriptionId,
      recordedAt: '2026-12-03T05:00:00.000Z', status, values });

    it('adds VIT-1\'s soft flags per value, none for a reading in error, and never a score', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'found', admissionId, wardType: 'general', from: 'a', to: 'b',
        readings: [reading({ pulseBpm: 132, oxygenSaturationPercent: 97, painScore: 4 }),
          reading({ pulseBpm: 140 }, 'entered_in_error')], hours: [{ hourStart: 'h' }] }]);
      const answer = await new NursingService(database).observationChart(context, admissionId, undefined, undefined,
        undefined) as Record<string, unknown>;
      const readings = answer.readings as { flags: { measure: string }[] }[];
      expect(readings[0]?.flags.map((flag) => flag.measure)).toEqual(['pulseBpm']);
      expect(readings[1]?.flags).toEqual([]);
      expect(answer.score).toBeNull();
      expect(answer.rangesVersion).toBe('2026-11-adult-1');
      expect(answer).not.toHaveProperty('hours');
      expect(calls[0]?.values[3]).toBe(true);
    });

    it('answers the hourly grid by default for an ICU ward, and not when "all" is asked for', async () => {
      const icu = { outcome: 'found', admissionId, wardType: 'icu', readings: [], hours: [{ hourStart: 'h' }] };
      expect(await new NursingService(fakeDatabase([icu]).database).observationChart(context, admissionId, undefined,
        undefined, undefined)).toHaveProperty('hours');
      const { database, calls } = fakeDatabase([icu]);
      expect(await new NursingService(database).observationChart(context, admissionId, undefined, undefined, 'all'))
        .not.toHaveProperty('hours');
      expect(calls[0]?.values[3]).toBe(false);
    });

    it('refuses a window over 7 days before reading', async () => {
      const { database, calls } = fakeDatabase([{}]);
      const problem = await problemOf(new NursingService(database).observationChart(context, admissionId,
        '2026-11-01T00:00:00Z', '2026-11-09T00:00:00Z', 'all'));
      expect([problem.getStatus(), problem.code]).toEqual([400, 'VALIDATION_FAILED']);
      expect(calls).toEqual([]);
    });

    it('flags each value on its own (no total of flags)', () => {
      expect(readingFlags({ pulseBpm: 132, respiratoryRate: 30, systolicMmhg: 120 }).map((flag) => flag.measure))
        .toEqual(['pulseBpm', 'respiratoryRate']);
    });
  });

  describe('the new vitals fields (route 1, Q-NUR-7 A)', () => {
    it('validates each new field', async () => {
      await expect(validate(CreateVitalDto, { recordedAt: '2026-12-03T05:00:00.000Z', painScore: 11 }))
        .rejects.toBeDefined();
      await expect(validate(CreateVitalDto, { recordedAt: '2026-12-03T05:00:00.000Z', avpu: 'confused' }))
        .rejects.toBeDefined();
      await expect(validate(CreateVitalDto, { recordedAt: '2026-12-03T05:00:00.000Z', painScore: 3, avpu: 'alert',
        bloodGlucoseMmolL: 7.2, oxygenDevice: 'nasal_cannula', oxygenFlowLPerMin: 2, gcsEye: 4, gcsVerbal: 5,
        gcsMotor: 6 })).resolves.toBeDefined();
    });

    it('are refused while the flag is off', () => {
      let problem: DomainProblem | undefined;
      try { requireObservationFieldsAllowed({ painScore: 2 }, false); } catch (error) { problem = error as DomainProblem; }
      expect([problem?.getStatus(), problem?.code]).toEqual([400, 'NURSING_FIELDS_NOT_AVAILABLE']);
      expect(() => requireObservationFieldsAllowed({ pulseBpm: 80 } as never, false)).not.toThrow();
    });

    it.each<[string, Record<string, unknown>, string | null]>([
      ['a flow on room air', { oxygenDevice: 'room_air', oxygenFlowLPerMin: 2 }, 'OXYGEN_FIELDS_INVALID'],
      ['FiO2 28 on room air', { oxygenDevice: 'room_air', fio2Percent: 28 }, 'OXYGEN_FIELDS_INVALID'],
      ['FiO2 21 on room air', { oxygenDevice: 'room_air', fio2Percent: 21 }, null],
      ['a flow with no device', { oxygenFlowLPerMin: 2 }, 'OXYGEN_FIELDS_INVALID'],
      ['a ventilator', { oxygenDevice: 'ventilator', fio2Percent: 40 }, null],
      ['GCS missing the verbal part', { gcsEye: 3, gcsMotor: 5 }, 'GCS_INCOMPLETE'],
      ['GCS with verbal not testable', { gcsEye: 3, gcsMotor: 5, gcsVerbalNotTestable: true }, null],
      ['a verbal score and not testable', { gcsEye: 3, gcsVerbal: 2, gcsMotor: 5, gcsVerbalNotTestable: true }, 'GCS_INCOMPLETE'],
    ])('%s', (_name, value, code) => {
      if (code === null) {
        expect(() => checkObservationRules(value)).not.toThrow();
      } else {
        let problem: DomainProblem | undefined;
        try { checkObservationRules(value); } catch (error) { problem = error as DomainProblem; }
        expect(problem?.code).toBe(code);
      }
    });

    it('reads the new fields through the whole row', () => {
      expect(observationColumnsSql('vitals')).toContain(`to_jsonb(vitals)->>'gcs_eye'`);
      expect(() => observationColumnsSql('v; drop')).toThrow();
    });
  });

  describe('inpatient orders (route 3, Q197 A)', () => {
    const schedule = (value: Partial<InpatientScheduleDto>) => ({ medicationDisplay: 'Fictional Med',
      frequency: 'as scheduled', instructions: 'Fictional', status: 'active', inpatientSchedule: value });

    it('off, a body with a schedule is refused with NURSING_FIELDS_NOT_AVAILABLE', async () => {
      const pipe = new CreatePrescriptionBodyPipe(new PrescriptionDispensingDetails(false),
        new PrescriptionInpatientSchedule(false));
      const problem = await problemOf(() => pipe.transform(schedule({ kind: 'stat' })));
      expect([problem.getStatus(), problem.code]).toEqual([400, 'NURSING_FIELDS_NOT_AVAILABLE']);
    });

    it('on, the schedule is validated by kind', async () => {
      const pipe = new CreatePrescriptionBodyPipe(new PrescriptionDispensingDetails(false),
        new PrescriptionInpatientSchedule(true));
      await expect(pipe.transform(schedule({ kind: 'regular', times: ['25:00'] }))).rejects.toBeDefined();
      const checker = new PrescriptionInpatientSchedule(true);
      for (const value of [{ kind: 'regular', times: ['14:00', '06:00'] }, { kind: 'regular' },
        { kind: 'as_needed', times: ['06:00'] }, { kind: 'once' },
        { kind: 'as_needed', asNeeded: { reason: 'Pain', minIntervalMinutes: 240, maxDosesPer24h: 4 },
          infusion: { rateMlPerHour: 100, volumeMl: 500 } }]) {
        const problem = await problemOf(() => checker.check({ inpatientSchedule: value as InpatientScheduleDto }));
        expect(problem.code).toBe('INPATIENT_SCHEDULE_INVALID');
      }
      expect(() => checker.check({ inpatientSchedule: { kind: 'regular', times: ['06:00', '14:00', '22:00'] } }))
        .not.toThrow();
    });

    it('keeps today\'s digest for a body without a schedule, and inserts the nine columns after the details', () => {
      const checker = new PrescriptionInpatientSchedule(true);
      expect(checker.digestInput({ a: 1, inpatientSchedule: undefined })).toEqual({ a: 1 });
      expect(checker.insertPlaceholders({ inpatientSchedule: { kind: 'stat' } }, 24)).toBe(
        ',$24,$25,$26,$27,$28,$29,$30,$31,$32');
      expect(new PrescriptionInpatientSchedule(false).selectList()).toBe('');
    });

    it('answers the schedule as one object', () => {
      expect(new PrescriptionInpatientSchedule(true).project({ id: prescriptionId, scheduleKind: 'regular',
        scheduledTimes: ['06:00'], firstDueAt: '2026-12-03T05:00:00.000Z', asNeededReason: null,
        infusionRateMlPerHour: null })).toEqual({ id: prescriptionId, inpatientSchedule: { kind: 'regular',
        times: ['06:00'], firstDueAt: '2026-12-03T05:00:00.000Z', asNeeded: null, infusion: null } });
    });

    it('turns 0175\'s guard into plain words', () => {
      expect((scheduleProblem(pgError('22023', 'INPATIENT_SCHEDULE_NOT_ALLOWED')) as DomainProblem).code)
        .toBe('INPATIENT_SCHEDULE_NOT_ALLOWED');
      expect((scheduleProblem(pgError('23514', 'violates check constraint "prescriptions_inpatient_schedule_ck"')) as
        DomainProblem).code).toBe('INPATIENT_SCHEDULE_INVALID');
    });
  });

  describe('the medicine round (Q196 A, Q198 A)', () => {
    it('records a dose with its warnings and passes every field, with no Health ID anywhere', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'created', replayed: false,
        administration: { administrationId: taskId }, warnings: ['before_dispensing'] }]);
      const input = await validate(RecordDoseDto, { prescriptionId, scheduledFor: '2026-12-03T05:00:00.000Z',
        outcome: 'given', givenAt: '2026-12-03T05:20:00.000Z', dose: { quantity: 1, unit: 'g' }, route: 'IV',
        supplySource: 'ward_stock', doseDiffersReason: null, reasonCode: null });
      await expect(new NursingService(database).recordDose(context, admissionId, input, key)).resolves.toEqual({
        administration: { administrationId: taskId }, warnings: ['before_dispensing'], replayed: false });
      expect(calls[0]?.sql).toContain('ehr.mar_record(');
      expect(calls[0]?.values.slice(0, 5)).toEqual([admissionId, prescriptionId, '2026-12-03T05:00:00.000Z', 'given',
        '2026-12-03T05:20:00.000Z']);
      expect(calls[0]?.values[11]).toBe('ward_stock');
    });

    it.each<[string, number, string]>([
      ['supply_source_required', 400, 'SUPPLY_SOURCE_REQUIRED'],
      ['dose_differs_reason_required', 400, 'DOSE_DIFFERS_REASON_REQUIRED'],
      ['override_reason_required', 400, 'AS_NEEDED_OVERRIDE_REASON_REQUIRED'],
      ['already_recorded', 409, 'DOSE_ALREADY_RECORDED'],
      ['order_not_active', 409, 'MAR_ORDER_NOT_ACTIVE'],
      ['admission_not_open', 409, 'ADMISSION_NOT_OPEN'],
      ['chart_access_required', 403, 'CHART_ACCESS_REQUIRED'],
      ['key_reused', 409, 'IDEMPOTENCY_KEY_REUSED'],
      ['not_found', 404, 'ADMISSION_NOT_FOUND'],
    ])('a refusal %s', async (outcome, status, code) => {
      const { database } = fakeDatabase([{ outcome, administrationId: taskId }]);
      const input = await validate(RecordDoseDto, { prescriptionId, outcome: 'held', givenAt: '2026-12-03T05:20:00.000Z',
        reasonCode: 'nil_by_mouth' });
      const problem = await problemOf(new NursingService(database).recordDose(context, admissionId, input, key));
      expect([problem.getStatus(), problem.code]).toEqual([status, code]);
      expect(problem.message).not.toMatch(/permission/i);
    });

    it('a dose not given needs a reason before the database', async () => {
      const { database, calls } = fakeDatabase([{}]);
      const input = await validate(RecordDoseDto, { prescriptionId, outcome: 'held', givenAt: '2026-12-03T05:20:00.000Z' });
      const problem = await problemOf(new NursingService(database).recordDose(context, admissionId, input, key));
      expect(problem.code).toBe('DOSE_REASON_REQUIRED');
      expect(calls).toEqual([]);
    });
  });

  describe('tasks, fluid balance, shifts and handover', () => {
    it('the task list needs a ward or an admission', async () => {
      const { database } = fakeDatabase([{}]);
      const both = await validate(TaskListQueryDto, { wardId, admissionId, mine: 'true' }, 'query');
      expect(both.mine).toBe(true);
      expect((await problemOf(new NursingService(database).tasks(context, both))).code).toBe('VALIDATION_FAILED');
    });

    it('a task step answers the task and the next repeat', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'updated', task: { taskId }, nextTaskId: shiftId }]);
      await expect(new NursingService(database).completeTask(context, taskId,
        { expectedRowVersion: 2, completionRecord: 'Done (fictional)' }, key))
        .resolves.toEqual({ task: { taskId }, nextTaskId: shiftId, replayed: false });
      expect(calls[0]?.sql).toContain('ehr.nursing_task_complete(');
      const problem = await problemOf(new NursingService(fakeDatabase([{ outcome: 'state_invalid' }]).database)
        .startTask(context, taskId, 1, key));
      expect([problem.getStatus(), problem.code]).toEqual([409, 'TASK_STATE_INVALID']);
    });

    it('a fluid entry is an amount or "not measured"', async () => {
      const { database, calls } = fakeDatabase([{}]);
      const input = await validate(FluidEntryDto, { direction: 'out', kind: 'urine', volumeMl: 200, notMeasured: true,
        recordedAt: '2026-12-03T05:00:00.000Z' });
      expect((await problemOf(new NursingService(database).recordFluid(context, admissionId, input, key))).code)
        .toBe('FLUID_ENTRY_INVALID');
      expect(calls).toEqual([]);
    });

    it('assignments: the list is sent once per member, with distinct admissions', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'updated', list: { outcome: 'found', version: 1 },
        warnings: ['icu_nurse_over_two'] }]);
      const input = await validate(SetAssignmentsDto, { date: '2026-12-03', shiftId, wardId, expectedVersion: 0,
        assignments: [{ membershipId, duty: 'nurse', admissionIds: [admissionId, admissionId] }] });
      await expect(new NursingService(database).setAssignments(context, input, key)).resolves.toEqual({
        list: { version: 1 }, warnings: ['icu_nurse_over_two'], replayed: false });
      expect(JSON.parse(String(calls[0]?.values[4]))).toEqual([{ membershipId, duty: 'nurse', admissionIds: [admissionId] }]);
      const problem = await problemOf(new NursingService(fakeDatabase([{ outcome: 'assignee_invalid' }]).database)
        .setAssignments(context, input, key));
      expect(problem.code).toBe('SHIFT_ASSIGNEE_INVALID');
    });

    it('the handover sheet counts flagged readings and never passes their values on', async () => {
      const { database } = fakeDatabase([{ outcome: 'found', handoverId: null, status: 'draft', patients: [
        { admissionId, noteHidden: false, shiftReadings: [{ pulse_bpm: 140 }, { pulse_bpm: 80 }] },
        { admissionId: taskId, noteHidden: true, shiftReadings: null }] }]);
      const answer = await new NursingService(database).handover(context, wardId, '2026-12-03', shiftId) as {
        patients: Record<string, unknown>[] };
      expect(answer.patients.map((patient) => patient.flagsSinceLastShift)).toEqual([1, null]);
      expect(JSON.stringify(answer)).not.toContain('shiftReadings');
    });

    it.each<[string, number, string]>([
      ['not_yours', 409, 'HANDOVER_NOT_YOURS'], ['not_draft', 409, 'HANDOVER_NOT_DRAFT'],
      ['not_given', 409, 'HANDOVER_NOT_GIVEN'], ['changed', 412, 'NURSING_VERSION_CONFLICT'],
      ['not_found', 404, 'HANDOVER_NOT_FOUND'],
    ])('a handover refusal %s', async (outcome, status, code) => {
      const problem = await problemOf(new NursingService(fakeDatabase([{ outcome }]).database)
        .handoverStep(context, handoverId, 'accept', 2, key));
      expect([problem.getStatus(), problem.code]).toEqual([status, code]);
    });
  });

  describe('the database\'s refusals', () => {
    it.each<[unknown, number, string]>([
      [pgError('42501', 'MAR_RECORD_NOT_ALLOWED'), 403, 'MAR_RECORD_NOT_ALLOWED'],
      [pgError('42501', 'SHIFT_SETUP_NOT_ALLOWED'), 403, 'SHIFT_SETUP_NOT_ALLOWED'],
      [pgError('22023', 'DOSE_TIME_INVALID'), 400, 'DOSE_TIME_INVALID'],
      [pgError('22023', 'NURSING_PURPOSE_REQUIRED'), 400, 'PURPOSE_OF_USE_REQUIRED'],
      [pgError('22023', 'NURSING_INVALID'), 400, 'VALIDATION_FAILED'],
      [pgError('42883', 'function ehr.mar_read does not exist'), 503, 'NURSING_NOT_AVAILABLE'],
      [pgError('23505', 'duplicate key'), 412, 'NURSING_VERSION_CONFLICT'],
    ])('%#', (error, status, code) => {
      const problem = translate(error) as DomainProblem;
      expect([problem.getStatus(), problem.code]).toEqual([status, code]);
    });

    it('unknown outcomes are 404 for the route\'s record', () => {
      expect(refusal(undefined, 'task').code).toBe('TASK_NOT_FOUND');
      expect(refusal('name_taken', 'shift').code).toBe('SHIFT_NAME_TAKEN');
    });
  });

  describe('the routes', () => {
    it('name records by UUID only (no Health ID or NIN in any path)', () => {
      const paths = Object.getOwnPropertyNames(NursingController.prototype)
        .filter((name) => name !== 'constructor')
        .map((name) => {
          const handler = (NursingController.prototype as unknown as Record<string, object>)[name] as object;
          return [Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
            Reflect.getMetadata(PATH_METADATA, handler) as string];
        });
      expect(paths.length).toBe(24);
      for (const [, path] of paths) expect(path).not.toMatch(/hid|nin|health-?id/i);
      const newNote = paths.findIndex(([, path]) => path === 'handovers/new/patients/:admissionId');
      const sheetNote = paths.findIndex(([, path]) => path === 'handovers/:handoverId/patients/:admissionId');
      expect(newNote).toBeGreaterThanOrEqual(0);
      expect(newNote).toBeLessThan(sheetNote);
    });
  });
});
