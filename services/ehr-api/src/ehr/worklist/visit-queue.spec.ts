import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { ArgumentMetadata } from '@nestjs/common';
import { REQUIRED_PERMISSIONS } from '../../common/decorators';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { createValidationPipe } from '../../common/validation-pipe';
import type { DatabaseService } from '../../database/database.service';
import { VisitQueueController } from './visit-queue.controller';
import { CheckInToVisitQueueDto, ListVisitQueueQueryDto, UpdateVisitQueueEntryDto } from './visit-queue.dto';
import { CHECK_IN_SQL, LIST_SQL, RECORD_KINDS_PRESENT_SQL, RECORD_KINDS_SQL, UPDATE_SQL, VisitQueueService,
  translate } from './visit-queue.service';

// Fictional identifiers only.
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const entryId = '123e4567-e89b-42d3-a456-426614174051';
const doctorMembershipId = '123e4567-e89b-42d3-a456-426614174061';
const matchRef = `psr_${'a'.repeat(43)}`;

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  authorization: 'Bearer user', actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local',
    roles: ['receptionist'], permissions: [], facilityIds: [facilityId], facilities: [],
    facility: { id: facilityId, membershipId, organizationId: facilityId, name: 'Test', roles: ['receptionist'],
      permissions: [], isPrimary: true } } } as unknown as DataAccessContext;

const cardRow = (overrides: Record<string, unknown> = {}) => ({
  entry_id: entryId, patient_id: patientId, full_name: 'Amaka Queueone', sex: 'female', date_of_birth: '1990-01-02',
  health_id_last4: 'AA22', stage: 'waiting', triage_level: null, assigned_membership_id: null,
  check_in_basis: 'search', checked_in_at: new Date('2026-11-18T09:00:00Z'), queue_day: '2026-11-18',
  stage_changed_at: new Date('2026-11-18T09:00:00Z'), closed_at: null, row_version: '1', chart_blocked: false,
  ...overrides,
});

/** The cards' rows, and (0145) whether the record-kind function exists and what it answers. */
function fakeDatabase(rows: readonly Record<string, unknown>[] | Error,
  kinds: readonly Record<string, unknown>[] | null = null) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const contexts: DataAccessContext[] = [];
  const database = {
    withTransaction: jest.fn(async (given: DataAccessContext, operation: (client: unknown) => Promise<unknown>) => {
      contexts.push(given);
      return operation({
        query: async (sql: string, values: unknown[]) => {
          calls.push({ sql, values });
          if (rows instanceof Error) throw rows;
          if (sql === RECORD_KINDS_PRESENT_SQL) return { rows: [{ present: kinds !== null }] };
          if (sql === RECORD_KINDS_SQL) return { rows: kinds ?? [] };
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

async function problemOf(promise: Promise<unknown>): Promise<DomainProblem> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainProblem);
    return error as DomainProblem;
  }
  throw new Error('expected a refusal');
}

describe('EHR-C7 the waiting list (0135)', () => {
  describe('routes', () => {
    it('lives at ehr/visit-queue, for members with encounter read and write (not lab or pharmacy staff)', () => {
      expect(Reflect.getMetadata(PATH_METADATA, VisitQueueController)).toBe('ehr/visit-queue');
      const routes: [keyof VisitQueueController, string, RequestMethod][] = [
        ['list', '/', RequestMethod.GET],
        ['checkIn', 'check-in', RequestMethod.POST],
        ['update', ':entryId', RequestMethod.PATCH],
      ];
      for (const [name, path, method] of routes) {
        const handler = VisitQueueController.prototype[name];
        expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
        expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
        expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['ehr.encounter.read', 'ehr.encounter.write']);
      }
    });

    it('never takes a Health ID: unknown body fields are refused', async () => {
      await expect(validate(CheckInToVisitQueueDto, { healthId: 'HID-QWAA22' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(CheckInToVisitQueueDto, { matchRef, hid: 'HID-QWAA22' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('checks the shape of a check-in body', async () => {
      await expect(validate(CheckInToVisitQueueDto, { matchRef })).resolves.toMatchObject({ matchRef });
      await expect(validate(CheckInToVisitQueueDto, { patientId })).resolves.toMatchObject({ patientId });
      await expect(validate(CheckInToVisitQueueDto, { matchRef: 'not a ref' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      // Only 0132's shape: 'psr_' and exactly 43 base64url characters.
      for (const wrong of [`psr_${'a'.repeat(42)}`, `psr_${'a'.repeat(44)}`, `abc_${'a'.repeat(43)}`, 'a'.repeat(47)]) {
        await expect(validate(CheckInToVisitQueueDto, { matchRef: wrong })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      await expect(validate(CheckInToVisitQueueDto, { patientId: 'p1' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(CheckInToVisitQueueDto, { matchRef: null })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('reads includeClosedToday as exactly true or false', async () => {
      await expect(validate(ListVisitQueueQueryDto, { includeClosedToday: 'true' }, 'query'))
        .resolves.toMatchObject({ includeClosedToday: true });
      await expect(validate(ListVisitQueueQueryDto, { includeClosedToday: 'false' }, 'query'))
        .resolves.toMatchObject({ includeClosedToday: false });
      await expect(validate(ListVisitQueueQueryDto, { includeClosedToday: 'yes' }, 'query'))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('checks the shape of a change', async () => {
      await expect(validate(UpdateVisitQueueEntryDto, { expectedRowVersion: 2, triageLevel: null, assignedMembershipId: null }))
        .resolves.toMatchObject({ expectedRowVersion: 2, triageLevel: null, assignedMembershipId: null });
      await expect(validate(UpdateVisitQueueEntryDto, { expectedRowVersion: 2, stage: 'admitted' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(UpdateVisitQueueEntryDto, { expectedRowVersion: 2, triageLevel: 6 }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(UpdateVisitQueueEntryDto, { stage: 'triage' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(UpdateVisitQueueEntryDto, { expectedRowVersion: 2, stage: null }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('check-in', () => {
    it('sends the matchRef to the database function and answers the card', async () => {
      const { database, calls, contexts } = fakeDatabase([{ outcome: 'checked_in', ...cardRow() }]);
      const answer = await new VisitQueueService(database).checkIn(context, { matchRef });
      expect(calls).toEqual([{ sql: CHECK_IN_SQL, values: [matchRef, null] }, { sql: RECORD_KINDS_PRESENT_SQL, values: undefined }]);
      expect(contexts).toEqual([context]);
      expect(answer).toEqual({
        outcome: 'checked_in',
        entry: {
          entryId, patientId, fullName: 'Amaka Queueone', sex: 'female', dateOfBirth: '1990-01-02', healthIdLast4: 'AA22',
          stage: 'waiting', triageLevel: null, assignedMembershipId: null, checkInBasis: 'search',
          checkedInAt: '2026-11-18T09:00:00.000Z', checkInDay: '2026-11-18', stageChangedAt: '2026-11-18T09:00:00.000Z',
          closedAt: null, rowVersion: 1, chartBlocked: false, recordKind: 'standard', dateOfBirthEstimated: false,
          edAttendanceId: null,
        },
      });
    });

    it('answers already_on_list with the open row for a patient already waiting', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'already_open',
        ...cardRow({ check_in_basis: 'own_facility', chart_blocked: true, triage_level: 2, row_version: '4' }) }]);
      const answer = await new VisitQueueService(database).checkIn(context, { patientId });
      expect(calls[0]?.values).toEqual([null, patientId]);
      expect(answer.outcome).toBe('already_on_list');
      expect(answer.entry).toMatchObject({ checkInBasis: 'own-facility', chartBlocked: true, triageLevel: 2, rowVersion: 4 });
    });

    it('gives every refusal the same answer, after the database has committed its audit row', async () => {
      const { database } = fakeDatabase([{ outcome: 'refused', entry_id: null }]);
      const problem = await problemOf(new VisitQueueService(database).checkIn(context, { patientId }));
      expect(problem.getStatus()).toBe(403);
      expect(problem.code).toBe('CHECK_IN_NEEDS_SEARCH');
      expect(problem.message).toBe('Search for the patient first, then check them in. A search result can be used for 10 minutes.');
      expect(database.withTransaction).toHaveBeenCalledTimes(1);
    });

    it('needs exactly one of matchRef and patientId, before any database call', async () => {
      const { database } = fakeDatabase([]);
      for (const input of [{}, { matchRef, patientId }, { matchRef: '' }]) {
        const problem = await problemOf(new VisitQueueService(database).checkIn(context, input));
        expect(problem.getStatus()).toBe(400);
        expect(problem.code).toBe('CHECK_IN_NEEDS_ONE_PATIENT');
      }
      expect(database.withTransaction).not.toHaveBeenCalled();
    });

    it('never answers a Health ID', async () => {
      const { database } = fakeDatabase([{ outcome: 'checked_in', ...cardRow(), hid_code: 'HID-QWAA22' }]);
      const answer = await new VisitQueueService(database).checkIn(context, { matchRef });
      expect(JSON.stringify(answer)).not.toContain('HID-');
    });
  });

  describe('list', () => {
    it('answers the cards in the database order, at most 200, with hasMore', async () => {
      const rows = [cardRow({ has_more: true }), cardRow({ entry_id: 'second', full_name: 'Bayo Queuetwo', has_more: true })];
      const { database, calls } = fakeDatabase(rows);
      const answer = await new VisitQueueService(database).list(context, true);
      expect(calls).toEqual([{ sql: LIST_SQL, values: [true] }, { sql: RECORD_KINDS_PRESENT_SQL, values: undefined }]);
      expect(LIST_SQL).toContain('order by ord');
      expect(answer.limit).toBe(200);
      expect(answer.hasMore).toBe(true);
      expect(answer.items.map((item) => item.fullName)).toEqual(['Amaka Queueone', 'Bayo Queuetwo']);
    });

    it('adds each card\'s record kind and estimated date of birth where 0145 is applied (ID-7)', async () => {
      const rows = [cardRow(), cardRow({ entry_id: 'second', full_name: 'Unknown patient U-0007' })];
      const { database, calls } = fakeDatabase(rows, [{ entry_id: 'second', record_kind: 'unknown', dob_estimated: true }]);
      const answer = await new VisitQueueService(database).list(context, false);
      expect(calls.map((call) => call.sql)).toEqual([LIST_SQL, RECORD_KINDS_PRESENT_SQL, RECORD_KINDS_SQL]);
      expect(calls[2]?.values).toEqual([[entryId, 'second']]);
      expect(answer.items.map((item) => [item.fullName, item.recordKind, item.dateOfBirthEstimated])).toEqual([
        ['Amaka Queueone', 'standard', false], ['Unknown patient U-0007', 'unknown', true]]);
    });

    it('answers an empty list', async () => {
      const { database } = fakeDatabase([]);
      await expect(new VisitQueueService(database).list(context, false)).resolves.toEqual({ items: [], hasMore: false, limit: 200 });
    });

    it('reads dates as text, so no time zone moves a date of birth', () => {
      expect(LIST_SQL).toContain('date_of_birth::text as date_of_birth');
      expect(LIST_SQL).toContain('queue_day::text as queue_day');
    });
  });

  describe('update', () => {
    it('passes a stage, a level and an assignee', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'updated',
        ...cardRow({ stage: 'ready', triage_level: 2, assigned_membership_id: doctorMembershipId, row_version: '3' }) }]);
      const card = await new VisitQueueService(database).update(context, entryId,
        { expectedRowVersion: 2, stage: 'ready', triageLevel: 2, assignedMembershipId: doctorMembershipId });
      expect(calls).toEqual([{ sql: UPDATE_SQL, values: [entryId, 2, 'ready', 2, false, doctorMembershipId, false] },
        { sql: RECORD_KINDS_PRESENT_SQL, values: undefined }]);
      expect(card).toMatchObject({ stage: 'ready', triageLevel: 2, assignedMembershipId: doctorMembershipId, rowVersion: 3 });
    });

    it('clears the level and the assignee with null', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'updated', ...cardRow() }]);
      await new VisitQueueService(database).update(context, entryId,
        { expectedRowVersion: 2, triageLevel: null, assignedMembershipId: null });
      expect(calls[0]?.values).toEqual([entryId, 2, null, null, true, null, true]);
    });

    it('needs something to change, before any database call', async () => {
      const { database } = fakeDatabase([]);
      const problem = await problemOf(new VisitQueueService(database).update(context, entryId, { expectedRowVersion: 2 }));
      expect(problem.code).toBe('VISIT_QUEUE_NOTHING_TO_CHANGE');
      expect(database.withTransaction).not.toHaveBeenCalled();
    });

    it.each([
      ['changed', 409, 'VISIT_QUEUE_ENTRY_CHANGED'],
      ['closed', 409, 'VISIT_QUEUE_ENTRY_CLOSED'],
      ['assignee_invalid', 400, 'VISIT_QUEUE_ASSIGNEE_INVALID'],
      ['not_found', 404, 'VISIT_QUEUE_ENTRY_NOT_FOUND'],
    ])('answers %s as %i %s', async (outcome, status, code) => {
      const { database } = fakeDatabase([{ outcome, ...cardRow() }]);
      const problem = await problemOf(new VisitQueueService(database).update(context, entryId,
        { expectedRowVersion: 2, stage: 'triage' }));
      expect(problem.getStatus()).toBe(status);
      expect(problem.code).toBe(code);
    });
  });

  describe('database refusals', () => {
    it('answers a member without encounter read and write in plain words', async () => {
      const { database } = fakeDatabase(Object.assign(new Error('VISIT_QUEUE_NOT_PERMITTED'), { code: '42501' }));
      const problem = await problemOf(new VisitQueueService(database).list(context, false));
      expect(problem.getStatus()).toBe(403);
      expect(problem.code).toBe('VISIT_QUEUE_NOT_PERMITTED');
    });

    it('answers a change of an emergency department patient\'s row as 409, in plain words (0168\'s guard)', async () => {
      const { database } = fakeDatabase(Object.assign(new Error('VISIT_QUEUE_ON_ED_BOARD'), { code: '55000' }));
      const problem = await problemOf(new VisitQueueService(database).update(context, entryId,
        { expectedRowVersion: 2, stage: 'finished' }));
      expect(problem.getStatus()).toBe(409);
      expect(problem.code).toBe('VISIT_QUEUE_ON_ED_BOARD');
      expect(problem.message).toBe('This patient is on the emergency department board. Make this change on the board.');
      const other = Object.assign(new Error('something else'), { code: '55000' });
      expect(translate(other)).toBe(other);
    });

    it('keeps the routes closed (503) on a schema without 0135', () => {
      const problem = translate(Object.assign(new Error('function missing'), { code: '42883' })) as DomainProblem;
      expect(problem.getStatus()).toBe(503);
      expect(problem.code).toBe('VISIT_QUEUE_UNAVAILABLE');
    });

    it('maps the functions\' own input refusals and passes anything else on', () => {
      expect((translate(Object.assign(new Error('VISIT_QUEUE_DIRECT_CARE_ONLY'), { code: '22023' })) as DomainProblem).code)
        .toBe('PURPOSE_OF_USE_REQUIRED');
      expect((translate(Object.assign(new Error('VISIT_QUEUE_CHECK_IN_INVALID'), { code: '22023' })) as DomainProblem).code)
        .toBe('CHECK_IN_NEEDS_ONE_PATIENT');
      expect((translate(Object.assign(new Error('VISIT_QUEUE_UPDATE_INVALID'), { code: '22023' })) as DomainProblem).code)
        .toBe('VISIT_QUEUE_UPDATE_INVALID');
      const other = Object.assign(new Error('boom'), { code: '57014' });
      expect(translate(other)).toBe(other);
    });

    it('never says "unverified"', () => {
      const source = [CHECK_IN_SQL, LIST_SQL, UPDATE_SQL].join(' ');
      expect(source.toLowerCase()).not.toContain('unverified');
    });
  });
});
