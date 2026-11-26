import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { ArgumentMetadata } from '@nestjs/common';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { createValidationPipe } from '../../common/validation-pipe';
import { getEnvironment, resetEnvironmentForTests } from '../../config/environment';
import type { DatabaseService } from '../../database/database.service';
import {
  ED_ATTENDANCES_SQL, LIST_SQL as QUEUE_LIST_SQL, RECORD_KINDS_PRESENT_SQL, VisitQueueService,
} from '../worklist/visit-queue.service';
import { EdBoardController } from './ed-board.controller';
import { EdArriveDto, EdCancelDto, EdDispositionDto, EdMoveDto, EdTriageDto } from './ed-board.dto';
import {
  ARRIVE_SQL, BOARD_SQL, CANCEL_SQL, DISPOSITION_SQL, ED_MESSAGES, EdBoardService, LEAVE_SQL, LINK_VISIT_SQL, MOVE_SQL,
  READ_SQL, TRIAGE_SQL, refusal, requireEdAccess, translate,
} from './ed-board.service';

// Fictional identifiers only.
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const attendanceId = '123e4567-e89b-42d3-a456-426614174071';
const entryId = '123e4567-e89b-42d3-a456-426614174051';
const encounterId = '123e4567-e89b-42d3-a456-426614174061';
const matchRef = `psr_${'a'.repeat(43)}`;
const key = 'ed-board-test-key-0001';

const DESK = ['ehr.encounter.read', 'ehr.encounter.write', 'ehr.ed.read', 'ehr.ed.arrive'];
const NURSE = [...DESK, 'ehr.ed.triage'];
const DOCTOR = [...NURSE, 'ehr.ed.disposition'];
const LAB = ['ehr.encounter.read', 'lab.result.enter'];

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  actor: { id: accountId, subject: 'staff:test', accountId, permissions: [] } } as unknown as DataAccessContext;

const cardRow = (overrides: Record<string, unknown> = {}) => ({
  attendance_id: attendanceId, entry_id: entryId, patient_id: patientId, full_name: 'Tunde Boardone',
  record_kind: 'standard', unknown_label: null, sex: 'male', date_of_birth: '1984-03-09', dob_estimated: false,
  health_id_last4: 'BB33', chart_blocked: false, arrival_basis: 'search', arrival_mode: 'ambulance',
  arrived_at: new Date('2026-12-03T08:10:00Z'), minutes_in_department: 42, board_column: 'waiting', stage: 'ready',
  triage_level: 2, triaged_at: new Date('2026-12-03T08:16:00Z'), triaged_by_membership_id: membershipId,
  presenting_complaint: 'Fall from motorcycle, left leg pain', complaint_hidden: false, assigned_membership_id: null,
  encounter_id: null, status: 'open', disposition_outcome: null, decided_at: null, decided_by_membership_id: null,
  admit_to_department_code: null, admitting_membership_id: null, referred_to_facility_name: null, left_at: null,
  row_version: '3', ...overrides,
});

function fakeDatabase(rows: readonly Record<string, unknown>[] | Error) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const contexts: DataAccessContext[] = [];
  const database = {
    withTransaction: jest.fn(async (given: DataAccessContext, operation: (client: unknown) => Promise<unknown>) => {
      contexts.push(given);
      return operation({
        query: async (sql: string, values: unknown[]) => {
          calls.push({ sql, values });
          if (rows instanceof Error) throw rows;
          return { rows };
        },
      });
    }),
  } as unknown as DatabaseService;
  return { database, calls, contexts };
}

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

describe('ED-1 the emergency department board (0168, 0169)', () => {
  const original = { ...process.env };
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost:5432/hid',
    CORS_ORIGINS: 'http://localhost:3000', STORAGE_MODE: 'disabled' };
  beforeEach(() => {
    Object.assign(process.env, base, { ED_BOARD_ENABLED: 'true' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('is off unless set to true', () => {
    delete process.env.ED_BOARD_ENABLED;
    resetEnvironmentForTests();
    expect(getEnvironment().ED_BOARD_ENABLED).toBe(false);
  });

  describe('routes', () => {
    it('serves the contract paths and methods', () => {
      expect(Reflect.getMetadata(PATH_METADATA, EdBoardController)).toBe('ehr');
      const routes: [keyof EdBoardController, string, RequestMethod, number | undefined][] = [
        ['arrive', 'ed-attendances', RequestMethod.POST, 201],
        ['list', 'ed-board', RequestMethod.GET, undefined],
        ['read', 'ed-attendances/:attendanceId', RequestMethod.GET, undefined],
        ['triage', 'ed-attendances/:attendanceId/triage', RequestMethod.POST, 200],
        ['move', 'ed-attendances/:attendanceId/move', RequestMethod.POST, 200],
        ['linkVisit', 'ed-attendances/:attendanceId/visit', RequestMethod.POST, 200],
        ['disposition', 'ed-attendances/:attendanceId/disposition', RequestMethod.POST, 200],
        ['leave', 'ed-attendances/:attendanceId/leave', RequestMethod.POST, 200],
        ['cancel', 'ed-attendances/:attendanceId/cancel', RequestMethod.POST, 200],
      ];
      for (const [method, path, verb, status] of routes) {
        const handler = EdBoardController.prototype[method];
        expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
        expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(verb);
        expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(status);
      }
    });

    it('answers 503 ED_BOARD_NOT_AVAILABLE on every route while the flag is off, before anything else', async () => {
      process.env.ED_BOARD_ENABLED = 'false';
      resetEnvironmentForTests();
      const { database } = fakeDatabase([]);
      const controller = new EdBoardController(new EdBoardService(database));
      const request = staffRequest([]);
      const attempts: (() => unknown)[] = [
        () => controller.arrive(request, key, { matchRef, arrivalMode: 'walk_in' }),
        () => controller.list(request, {}),
        () => controller.read(request, attendanceId),
        () => controller.triage(request, attendanceId, key, { expectedRowVersion: 1, triageLevel: 2 }),
        () => controller.move(request, attendanceId, key, { expectedRowVersion: 1, stage: 'triage' }),
        () => controller.linkVisit(request, attendanceId, key, { expectedRowVersion: 1, encounterId }),
        () => controller.disposition(request, attendanceId, key, { expectedRowVersion: 1, outcome: 'discharged' }),
        () => controller.leave(request, attendanceId, key, { expectedRowVersion: 1 }),
        () => controller.cancel(request, attendanceId, key, { expectedRowVersion: 1, reason: 'Added by mistake' }),
      ];
      for (const attempt of attempts) {
        const problem = await problemOf(attempt);
        expect([problem.getStatus(), problem.code, problem.message])
          .toEqual([503, 'ED_BOARD_NOT_AVAILABLE', 'The emergency board is not available yet.']);
      }
      expect(database.withTransaction).not.toHaveBeenCalled();
    });

    it('needs direct care, and emergency only for an arrival from an emergency search\'s matchRef', async () => {
      const { database, contexts } = fakeDatabase([{ outcome: 'arrived', replayed: false,
        ...cardRow({ arrival_basis: 'emergency' }) }]);
      const controller = new EdBoardController(new EdBoardService(database));
      const answer = await controller.arrive(staffRequest(DOCTOR, 'emergency'), key, { matchRef, arrivalMode: 'ambulance' });
      expect(answer.attendance.arrivalBasis).toBe('emergency');
      expect(contexts[0]?.purposeOfUse).toBe('emergency');
      for (const attempt of [
        () => controller.arrive(staffRequest(DOCTOR, 'emergency'), key, { patientId, arrivalMode: 'ambulance' }),
        () => controller.list(staffRequest(DOCTOR, 'emergency'), {}),
        () => controller.triage(staffRequest(DOCTOR, 'emergency'), attendanceId, key, { expectedRowVersion: 1, triageLevel: 2 }),
        () => controller.arrive(staffRequest(DOCTOR, 'healthcare-operations'), key, { matchRef, arrivalMode: 'walk_in' }),
      ]) {
        const problem = await problemOf(attempt);
        expect([problem.getStatus(), problem.code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
      }
    });

    it('lets the front desk arrive and read; nurses triage; clinicians and doctors decide; others nothing', async () => {
      const { database } = fakeDatabase([{ outcome: 'updated', replayed: false, ...cardRow() }]);
      const controller = new EdBoardController(new EdBoardService(database));
      const refused = async (attempt: () => unknown) => {
        const problem = await problemOf(attempt);
        expect(problem.message).not.toMatch(/permission/i);
        return [problem.getStatus(), problem.code];
      };
      expect(await refused(() => controller.list(staffRequest(LAB), {}))).toEqual([403, 'ED_BOARD_NOT_ALLOWED']);
      expect(await refused(() => controller.arrive(staffRequest(['ehr.ed.read', 'ehr.encounter.read', 'ehr.encounter.write']),
        key, { matchRef, arrivalMode: 'walk_in' }))).toEqual([403, 'ED_BOARD_NOT_ALLOWED']);
      expect(await refused(() => controller.arrive(staffRequest(DESK), key, { matchRef, arrivalMode: 'walk_in', triageLevel: 2 })))
        .toEqual([403, 'ED_TRIAGE_NOT_ALLOWED']);
      expect(await refused(() => controller.arrive(staffRequest(DESK), key,
        { matchRef, arrivalMode: 'walk_in', presentingComplaint: 'Chest pain' }))).toEqual([403, 'ED_TRIAGE_NOT_ALLOWED']);
      expect(await refused(() => controller.triage(staffRequest(DESK), attendanceId, key,
        { expectedRowVersion: 1, triageLevel: 2 }))).toEqual([403, 'ED_TRIAGE_NOT_ALLOWED']);
      expect(await refused(() => controller.move(staffRequest(DESK), attendanceId, key,
        { expectedRowVersion: 1, stage: 'triage' }))).toEqual([403, 'ED_TRIAGE_NOT_ALLOWED']);
      expect(await refused(() => controller.leave(staffRequest(DESK), attendanceId, key, { expectedRowVersion: 1 })))
        .toEqual([403, 'ED_TRIAGE_NOT_ALLOWED']);
      expect(await refused(() => controller.disposition(staffRequest(NURSE), attendanceId, key,
        { expectedRowVersion: 1, outcome: 'discharged' }))).toEqual([403, 'ED_DISPOSITION_NOT_ALLOWED']);
      expect(await refused(() => controller.cancel(staffRequest(LAB), attendanceId, key,
        { expectedRowVersion: 1, reason: 'Added by mistake' }))).toEqual([403, 'ED_BOARD_NOT_ALLOWED']);
      await expect(controller.list(staffRequest(DESK), {})).resolves.toBeDefined();
      await expect(controller.cancel(staffRequest(DESK), attendanceId, key, { expectedRowVersion: 1, reason: 'Added by mistake' }))
        .resolves.toBeDefined();
      await expect(controller.triage(staffRequest(NURSE), attendanceId, key, { expectedRowVersion: 1, triageLevel: 2 }))
        .resolves.toBeDefined();
      await expect(controller.disposition(staffRequest(DOCTOR), attendanceId, key, { expectedRowVersion: 1, outcome: 'discharged' }))
        .resolves.toBeDefined();
    });

    it('needs an Idempotency-Key on every write', async () => {
      const { database } = fakeDatabase([]);
      const controller = new EdBoardController(new EdBoardService(database));
      const problem = await problemOf(() => controller.arrive(staffRequest(DOCTOR), undefined, { matchRef, arrivalMode: 'walk_in' }));
      expect(problem.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('never says "permission" in any message', () => {
      for (const message of Object.values(ED_MESSAGES)) expect(message).not.toMatch(/permission/i);
    });
  });

  describe('request bodies', () => {
    it('takes the arrival fields and refuses others', async () => {
      await expect(validate(EdArriveDto, { matchRef, arrivalMode: 'ambulance', arrivedAt: '2026-12-03T08:10:00.000Z',
        triageLevel: 2, presentingComplaint: '  Fall from motorcycle  ' }))
        .resolves.toMatchObject({ presentingComplaint: 'Fall from motorcycle' });
      for (const body of [
        { matchRef, arrivalMode: 'helicopter' },
        { matchRef },
        { matchRef, arrivalMode: 'walk_in', arrivedAt: '2026-12-03T08:10:00' },
        { matchRef, arrivalMode: 'walk_in', arrivedAt: '2026-12-03T09:10:00+01:00' },
        { matchRef, arrivalMode: 'walk_in', presentingComplaint: 'x'.repeat(121) },
        { matchRef, arrivalMode: 'walk_in', presentingComplaint: '   ' },
        { matchRef, arrivalMode: 'walk_in', presentingComplaint: 'line\nbreak' },
        { matchRef: 'HID-QWAA22', arrivalMode: 'walk_in' },
        { healthId: 'HID-QWAA22', arrivalMode: 'walk_in' },
        { matchRef, arrivalMode: 'walk_in', triageLevel: 1.5 },
      ]) {
        await expect(validate(EdArriveDto, body)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      }
    });

    it('takes null to clear a complaint and an assignee, and refuses an unknown stage or outcome', async () => {
      await expect(validate(EdTriageDto, { expectedRowVersion: 2, triageLevel: 1, presentingComplaint: null }))
        .resolves.toMatchObject({ presentingComplaint: null });
      await expect(validate(EdMoveDto, { expectedRowVersion: 2, assignedMembershipId: null }))
        .resolves.toMatchObject({ assignedMembershipId: null });
      await expect(validate(EdMoveDto, { expectedRowVersion: 2, stage: 'finished' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(EdDispositionDto, { expectedRowVersion: 2, outcome: 'admitted' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(EdDispositionDto, { expectedRowVersion: 2, outcome: 'referred_out', referredToFacilityName: 'A' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(EdCancelDto, { expectedRowVersion: 0, reason: 'Added by mistake' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('the service', () => {
    it('puts a patient on the board through ehr.ed_arrive and answers the card', async () => {
      const { database, calls, contexts } = fakeDatabase([{ outcome: 'arrived', replayed: false, ...cardRow() }]);
      const answer = await new EdBoardService(database).arrive(context,
        { matchRef, arrivalMode: 'ambulance', arrivedAt: '2026-12-03T08:10:00.000Z', triageLevel: 2,
          presentingComplaint: 'Fall from motorcycle, left leg pain' }, key);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.sql).toBe(ARRIVE_SQL);
      expect(calls[0]?.values.slice(0, 7)).toEqual([matchRef, null, 'ambulance', '2026-12-03T08:10:00.000Z', 2,
        'Fall from motorcycle, left leg pain', key]);
      expect(calls[0]?.values[7]).toMatch(/^[0-9a-f]{64}$/);
      expect(contexts).toEqual([context]);
      expect(answer).toEqual({
        outcome: 'arrived', replayed: false,
        attendance: {
          attendanceId, entryId, patientId, fullName: 'Tunde Boardone', recordKind: 'standard', unknownLabel: null,
          sex: 'male', dateOfBirth: '1984-03-09', dateOfBirthEstimated: false, healthIdLast4: 'BB33', chartBlocked: false,
          arrivalBasis: 'search', arrivalMode: 'ambulance', arrivedAt: '2026-12-03T08:10:00.000Z', minutesInDepartment: 42,
          column: 'waiting', stage: 'ready', triageLevel: 2, triagedAt: '2026-12-03T08:16:00.000Z',
          triagedByMembershipId: membershipId, presentingComplaint: 'Fall from motorcycle, left leg pain',
          complaintHidden: false, assignedMembershipId: null, encounterId: null, status: 'open', disposition: null,
          leftAt: null, rowVersion: 3,
        },
      });
    });

    it('gives the same digest for the same body, and another for another body', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'arrived', replayed: false, ...cardRow() }]);
      const service = new EdBoardService(database);
      await service.arrive(context, { matchRef, arrivalMode: 'ambulance' }, key);
      await service.arrive(context, { matchRef, arrivalMode: 'ambulance' }, key);
      await service.arrive(context, { matchRef, arrivalMode: 'walk_in' }, key);
      expect(calls[0]?.values[7]).toBe(calls[1]?.values[7]);
      expect(calls[0]?.values[7]).not.toBe(calls[2]?.values[7]);
    });

    it('answers moved_from_waiting_list, already_on_board and replays', async () => {
      for (const outcome of ['moved_from_waiting_list', 'already_on_board'] as const) {
        const { database } = fakeDatabase([{ outcome, replayed: outcome === 'already_on_board', ...cardRow() }]);
        const answer = await new EdBoardService(database).arrive(context, { patientId, arrivalMode: 'walk_in' }, key);
        expect([answer.outcome, answer.replayed]).toEqual([outcome, outcome === 'already_on_board']);
      }
    });

    it('shows an unknown record by its label, an emergency basis and own-facility in the contract\'s spelling', async () => {
      const { database } = fakeDatabase([{ outcome: 'arrived', replayed: false, ...cardRow({ record_kind: 'unknown',
        unknown_label: 'U-0007', full_name: 'Unknown patient U-0007', dob_estimated: true, arrival_basis: 'own_facility' }) }]);
      const answer = await new EdBoardService(database).arrive(context, { patientId, arrivalMode: 'ambulance' }, key);
      expect(answer.attendance).toMatchObject({ fullName: 'Unknown patient U-0007', recordKind: 'unknown',
        unknownLabel: 'U-0007', dateOfBirthEstimated: true, arrivalBasis: 'own-facility' });
    });

    it('needs exactly one patient and a level from 1 to 5, before any database call', async () => {
      const { database } = fakeDatabase([]);
      const service = new EdBoardService(database);
      for (const input of [{ arrivalMode: 'walk_in' as const }, { matchRef, patientId, arrivalMode: 'walk_in' as const }]) {
        expect((await problemOf(service.arrive(context, input, key))).code).toBe('ED_ARRIVAL_NEEDS_ONE_PATIENT');
      }
      for (const triageLevel of [0, 6]) {
        expect((await problemOf(service.arrive(context, { matchRef, arrivalMode: 'walk_in', triageLevel }, key))).code)
          .toBe('ED_TRIAGE_INVALID');
        expect((await problemOf(service.triage(context, attendanceId, { expectedRowVersion: 1, triageLevel }, key))).code)
          .toBe('ED_TRIAGE_INVALID');
      }
      expect((await problemOf(service.move(context, attendanceId, { expectedRowVersion: 1 }, key))).code)
        .toBe('ED_NOTHING_TO_CHANGE');
      expect((await problemOf(service.cancel(context, attendanceId, { expectedRowVersion: 1 }, key))).code)
        .toBe('ED_REASON_REQUIRED');
      expect((await problemOf(service.cancel(context, attendanceId, { expectedRowVersion: 1, reason: 'Oops' }, key))).code)
        .toBe('ED_REASON_REQUIRED');
      expect((await problemOf(service.disposition(context, attendanceId,
        { expectedRowVersion: 1, outcome: 'discharged', reason: 'Short' }, key))).code).toBe('ED_REASON_REQUIRED');
      const misplaced = await problemOf(service.disposition(context, attendanceId,
        { expectedRowVersion: 1, outcome: 'discharged', admitToDepartmentCode: 'inpatient' }, key));
      expect([misplaced.code, misplaced.errors?.[0]?.field]).toEqual(['VALIDATION_FAILED', 'admitToDepartmentCode']);
      expect(database.withTransaction).not.toHaveBeenCalled();
    });

    it('gives every refused arrival the same answer, after the database has committed its audit row', async () => {
      const { database } = fakeDatabase([{ outcome: 'needs_search', attendance_id: null }]);
      const problem = await problemOf(new EdBoardService(database).arrive(context, { patientId, arrivalMode: 'walk_in' }, key));
      expect([problem.getStatus(), problem.code, problem.message]).toEqual([403, 'ED_ARRIVAL_NEEDS_SEARCH',
        'Search for the patient first, then add them to the board. A search result can be used for 10 minutes.']);
      expect(database.withTransaction).toHaveBeenCalledTimes(1);
    });

    it('answers the board with counts and hides the complaint from the front desk', async () => {
      const rows = [
        cardRow({ has_more: false, waiting_count: 4, being_seen_count: 2, disposition_count: 1, complaint_hidden: true,
          presenting_complaint: null }),
      ];
      const { database, calls } = fakeDatabase(rows);
      const answer = await new EdBoardService(database).board(context, true);
      expect(calls).toEqual([{ sql: BOARD_SQL, values: [true] }]);
      expect(BOARD_SQL).toContain('order by ord');
      expect(answer).toMatchObject({ counts: { waiting: 4, beingSeen: 2, disposition: 1 }, hasMore: false, limit: 200 });
      expect(answer.items[0]).toMatchObject({ presentingComplaint: null, complaintHidden: true });
    });

    it('never shows a complaint the database marked hidden', async () => {
      const { database } = fakeDatabase([{ outcome: 'arrived', replayed: false,
        ...cardRow({ complaint_hidden: true, presenting_complaint: 'should not show' }) }]);
      const answer = await new EdBoardService(database).arrive(context, { patientId, arrivalMode: 'walk_in' }, key);
      expect(answer.attendance.presentingComplaint).toBeNull();
    });

    it('answers an empty board', async () => {
      const { database } = fakeDatabase([]);
      await expect(new EdBoardService(database).board(context, false)).resolves.toEqual({
        items: [], counts: { waiting: 0, beingSeen: 0, disposition: 0 }, hasMore: false, limit: 200 });
    });

    it('reads one record with its history', async () => {
      const history = [{ kind: 'arrived', at: '2026-12-03T08:10:00.123456+00:00', byMembershipId: membershipId,
        fromStage: null, toStage: 'waiting', triageLevel: null, outcome: null, reason: null, complaintChanged: false },
      { kind: 'disposition', at: '2026-12-03T09:00:00+00:00', byMembershipId: membershipId, fromStage: 'with_clinician',
        toStage: 'with_clinician', triageLevel: null, outcome: 'admit_requested', reason: null, complaintChanged: null }];
      const { database, calls } = fakeDatabase([{ outcome: 'found', ...cardRow({ status: 'decided',
        board_column: 'disposition', disposition_outcome: 'admit_requested', decided_at: new Date('2026-12-03T09:00:00Z'),
        decided_by_membership_id: membershipId, admit_to_department_code: 'inpatient' }), history }]);
      const record = await new EdBoardService(database).read(context, attendanceId);
      expect(calls).toEqual([{ sql: READ_SQL, values: [attendanceId] }]);
      expect(record.attendance.disposition).toEqual({ outcome: 'admit_requested', decidedAt: '2026-12-03T09:00:00.000Z',
        decidedByMembershipId: membershipId, admitToDepartmentCode: 'inpatient', admittingMembershipId: null,
        referredToFacilityName: null });
      expect(record.history.map((entry) => [entry.kind, entry.at, entry.outcome])).toEqual([
        ['arrived', '2026-12-03T08:10:00.123Z', null], ['disposition', '2026-12-03T09:00:00.000Z', 'admit_requested']]);
      const missing = fakeDatabase([{ outcome: 'not_found', attendance_id: null }]);
      expect((await problemOf(new EdBoardService(missing.database).read(context, attendanceId))).code)
        .toBe('ED_ATTENDANCE_NOT_FOUND');
    });

    it('passes each write to its function', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'updated', replayed: true, ...cardRow() }]);
      const service = new EdBoardService(database);
      expect((await service.triage(context, attendanceId, { expectedRowVersion: 3, triageLevel: 1,
        presentingComplaint: null }, key)).replayed).toBe(true);
      await service.triage(context, attendanceId, { expectedRowVersion: 3, triageLevel: 1 }, key);
      await service.move(context, attendanceId, { expectedRowVersion: 3, stage: 'with_clinician',
        assignedMembershipId: membershipId }, key);
      await service.move(context, attendanceId, { expectedRowVersion: 3, assignedMembershipId: null }, key);
      await service.linkVisit(context, attendanceId, { expectedRowVersion: 3, encounterId }, key);
      await service.disposition(context, attendanceId, { expectedRowVersion: 3, outcome: 'admit_requested',
        admitToDepartmentCode: 'inpatient', admittingMembershipId: membershipId }, key);
      await service.leave(context, attendanceId, { expectedRowVersion: 3 }, key);
      await service.cancel(context, attendanceId, { expectedRowVersion: 3, reason: 'Added by mistake' }, key);
      expect(calls.map((call) => [call.sql, call.values.slice(0, -1)])).toEqual([
        [TRIAGE_SQL, [attendanceId, 3, 1, null, true, key]],
        [TRIAGE_SQL, [attendanceId, 3, 1, null, false, key]],
        [MOVE_SQL, [attendanceId, 3, 'with_clinician', membershipId, false, key]],
        [MOVE_SQL, [attendanceId, 3, null, null, true, key]],
        [LINK_VISIT_SQL, [attendanceId, 3, encounterId, key]],
        [DISPOSITION_SQL, [attendanceId, 3, 'admit_requested', 'inpatient', membershipId, null, null, key]],
        [LEAVE_SQL, [attendanceId, 3, key]],
        [CANCEL_SQL, [attendanceId, 3, 'Added by mistake', key]],
      ]);
      expect(calls[0]?.values.at(-1)).not.toBe(calls[1]?.values.at(-1));
    });

    it('never answers a Health ID', async () => {
      const { database } = fakeDatabase([{ outcome: 'arrived', replayed: false, ...cardRow(), hid_code: 'HID-EDAA22' }]);
      const answer = await new EdBoardService(database).arrive(context, { matchRef, arrivalMode: 'walk_in' }, key);
      expect(JSON.stringify(answer)).not.toContain('HID-');
    });
  });

  describe('refusals', () => {
    it.each([
      ['needs_search', 403, 'ED_ARRIVAL_NEEDS_SEARCH'], ['time_invalid', 400, 'ED_ARRIVAL_TIME_INVALID'],
      ['key_reused', 409, 'IDEMPOTENCY_KEY_REUSED'], ['not_found', 404, 'ED_ATTENDANCE_NOT_FOUND'],
      ['closed', 409, 'ED_ATTENDANCE_CLOSED'], ['decided', 409, 'ED_ATTENDANCE_DECIDED'],
      ['not_decided', 409, 'ED_ATTENDANCE_NOT_DECIDED'], ['cancel_not_allowed', 409, 'ED_CANCEL_NOT_ALLOWED'],
      ['changed', 412, 'ED_VERSION_CONFLICT'], ['assignee_invalid', 400, 'ED_ASSIGNEE_INVALID'],
      ['visit_invalid', 400, 'ED_VISIT_INVALID'], ['admit_department_invalid', 400, 'ED_ADMIT_DEPARTMENT_INVALID'],
      ['admitting_invalid', 400, 'VALIDATION_FAILED'], ['reason_required', 400, 'ED_REASON_REQUIRED'],
    ])('%s answers %i %s', async (outcome, status, code) => {
      const problem = refusal(outcome);
      expect([problem.getStatus(), problem.code]).toEqual([status, code]);
      expect(problem.message).not.toMatch(/permission/i);
      const { database } = fakeDatabase([{ outcome, attendance_id: null }]);
      const answered = await problemOf(new EdBoardService(database).leave(context, attendanceId, { expectedRowVersion: 1 }, key));
      expect(answered.code).toBe(code);
    });

    it.each([
      [{ code: '42501', message: 'ED_BOARD_NOT_ALLOWED' }, 403, 'ED_BOARD_NOT_ALLOWED'],
      [{ code: '42501', message: 'ED_TRIAGE_NOT_ALLOWED' }, 403, 'ED_TRIAGE_NOT_ALLOWED'],
      [{ code: '42501', message: 'ED_DISPOSITION_NOT_ALLOWED' }, 403, 'ED_DISPOSITION_NOT_ALLOWED'],
      [{ code: '22023', message: 'ED_DIRECT_CARE_ONLY' }, 400, 'PURPOSE_OF_USE_REQUIRED'],
      [{ code: '22023', message: 'ED_ARRIVAL_NEEDS_ONE_PATIENT' }, 400, 'ED_ARRIVAL_NEEDS_ONE_PATIENT'],
      [{ code: '22023', message: 'ED_TRIAGE_INVALID' }, 400, 'ED_TRIAGE_INVALID'],
      [{ code: '22023', message: 'ED_NOTHING_TO_CHANGE' }, 400, 'ED_NOTHING_TO_CHANGE'],
      [{ code: '22023', message: 'ED_REASON_REQUIRED' }, 400, 'ED_REASON_REQUIRED'],
      [{ code: '22023', message: 'ED_IDEMPOTENCY_KEY_INVALID' }, 400, 'IDEMPOTENCY_KEY_REQUIRED'],
      [{ code: '22023', message: 'ED_INVALID' }, 400, 'VALIDATION_FAILED'],
      [{ code: '40P01', message: 'deadlock detected' }, 412, 'ED_VERSION_CONFLICT'],
      [{ code: '42883', message: 'function ehr.ed_board(boolean) does not exist' }, 503, 'ED_BOARD_NOT_AVAILABLE'],
      [{ code: '42P01', message: 'relation does not exist' }, 503, 'ED_BOARD_NOT_AVAILABLE'],
    ])('translates %j', async (error, status, code) => {
      const problem = translate(error) as DomainProblem;
      expect([problem.getStatus(), problem.code]).toEqual([status, code]);
      const { database } = fakeDatabase(Object.assign(new Error(error.message), error));
      expect((await problemOf(new EdBoardService(database).board(context, false))).code).toBe(code);
    });

    it('passes on anything else', () => {
      const error = new Error('connection reset');
      expect(translate(error)).toBe(error);
    });

    it('checks the session\'s codes in the order the database does', () => {
      expect(() => requireEdAccess(staffRequest(['ehr.ed.read', 'ehr.ed.triage']), 'triage'))
        .toThrow(expect.objectContaining({ code: 'ED_BOARD_NOT_ALLOWED' }));
      expect(() => requireEdAccess(staffRequest(DESK), 'read')).not.toThrow();
      expect(() => requireEdAccess(staffRequest(NURSE), 'triage')).not.toThrow();
      expect(() => requireEdAccess(staffRequest(DOCTOR), 'disposition')).not.toThrow();
    });
  });

  describe('the waiting list (EHR-C7) with 0168', () => {
    it('marks the rows on the board with their ED record', async () => {
      const queueRow = (id: string) => ({ entry_id: id, patient_id: patientId, full_name: 'Tunde Boardone', sex: 'male',
        date_of_birth: '1984-03-09', health_id_last4: 'BB33', stage: 'ready', triage_level: 2, assigned_membership_id: null,
        check_in_basis: 'emergency', checked_in_at: new Date('2026-12-03T08:10:00Z'), queue_day: '2026-12-03',
        stage_changed_at: new Date('2026-12-03T08:16:00Z'), closed_at: null, row_version: '2', chart_blocked: false });
      const calls: string[] = [];
      const database = {
        withTransaction: jest.fn(async (_given: DataAccessContext, operation: (client: unknown) => Promise<unknown>) =>
          operation({
            query: async (sql: string) => {
              calls.push(sql);
              if (sql === RECORD_KINDS_PRESENT_SQL) return { rows: [{ present: false, ed_present: true }] };
              if (sql === ED_ATTENDANCES_SQL) return { rows: [{ entry_id: entryId, attendance_id: attendanceId }] };
              return { rows: [{ ...queueRow(entryId), has_more: false }, { ...queueRow('second'), has_more: false }] };
            },
          })),
      } as unknown as DatabaseService;
      const list = await new VisitQueueService(database).list(context, false);
      expect(calls).toEqual([QUEUE_LIST_SQL, RECORD_KINDS_PRESENT_SQL, ED_ATTENDANCES_SQL]);
      expect(list.items.map((item) => [item.edAttendanceId, item.checkInBasis])).toEqual([
        [attendanceId, 'emergency'], [null, 'emergency']]);
    });
  });
});
