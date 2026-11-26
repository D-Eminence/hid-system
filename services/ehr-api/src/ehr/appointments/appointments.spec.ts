import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { ArgumentMetadata } from '@nestjs/common';
import { FACILITY_OPTIONAL, PATIENT_ALLOWED } from '../../common/decorators';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { createValidationPipe } from '../../common/validation-pipe';
import { getEnvironment, resetEnvironmentForTests } from '../../config/environment';
import type { DatabaseService } from '../../database/database.service';
import type { IdentityApiService } from '../../integrations/identity-api.service';
import {
  AppointmentClinicsController, AppointmentSettingsController, AppointmentsController, MyAppointmentsController,
  PatientAppointmentsController,
} from './appointments.controller';
import {
  BookAppointmentDto, CheckInAppointmentDto, ListAppointmentsQueryDto, MyAppointmentsQueryDto, RescheduleAppointmentDto,
} from './appointments.dto';
import {
  APPOINTMENT_MESSAGES, AppointmentReminderSweeper, AppointmentsService, BOOK_SQL, CHECK_IN_SQL, LIST_SQL, MY_LIST_SQL,
  REMINDER_SQL, RESCHEDULE_SQL, decodeDayCursor, encodeCursor, refusal, requireAppointmentAccess, translate,
} from './appointments.service';

// Fictional identifiers only.
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const appointmentId = '123e4567-e89b-42d3-a456-426614174071';
const entryId = '123e4567-e89b-42d3-a456-426614174051';
const sessionId = '123e4567-e89b-42d3-a456-426614174081';
const matchRef = `psr_${'a'.repeat(43)}`;
const key = 'appointment-test-key-0001';

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  actor: { id: accountId, subject: 'staff:test', accountId, permissions: [] } } as unknown as DataAccessContext;

const cardRow = (overrides: Record<string, unknown> = {}) => ({
  appointment_id: appointmentId, patient_id: patientId, full_name: 'Amaka Bookone', sex: 'female',
  date_of_birth: '1990-01-02', health_id_last4: 'AA22', chart_blocked: false, department_code: 'general_outpatient',
  clinic_id: null, clinic_name: null, clinician_membership_id: null, starts_at: new Date('2026-12-03T09:00:00Z'),
  ends_at: new Date('2026-12-03T09:30:00Z'), length_minutes: 30, appointment_day: '2026-12-03', visit_type: 'follow_up',
  reason: 'Blood pressure review', status: 'booked', booking_basis: 'search', visit_queue_entry_id: null,
  booked_at: new Date('2026-11-26T10:00:00Z'), booked_by_membership_id: membershipId,
  status_changed_at: new Date('2026-11-26T10:00:00Z'), reminder_sent_at: null, row_version: '1', ...overrides,
});

function fakeDatabase(rows: readonly Record<string, unknown>[] | Error) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const query = async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    if (rows instanceof Error) throw rows;
    return { rows };
  };
  const database = {
    withTransaction: jest.fn(async (_given: DataAccessContext, operation: (client: unknown) => Promise<unknown>) =>
      operation({ query })),
    withPatientTransaction: jest.fn(async (_authorization: unknown, _correlation: string,
      operation: (client: unknown) => Promise<unknown>) => operation({ query })),
    withSystemTransaction: jest.fn(async (_correlation: string, operation: (client: unknown) => Promise<unknown>) =>
      operation({ query })),
  } as unknown as DatabaseService;
  return { database, calls };
}

const identity = {
  authorizeSelf: jest.fn(async () => ({ patientId, accountId, subject: 'patient:test', sessionId,
    expiresAt: new Date(Date.now() + 30_000).toISOString() })),
} as unknown as IdentityApiService;

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
    correlationId: 'correlation-123456', facilityId,
    actor: { kind: 'staff', id: accountId, subject: 'staff:test', accountId, permissions, roles: ['receptionist'],
      facilityIds: [facilityId], facilities: [], facility: { id: facilityId, membershipId } },
  } as unknown as HidRequest;
}

describe('APPT-1 appointments (0160, 0161)', () => {
  const original = { ...process.env };
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost:5432/hid',
    CORS_ORIGINS: 'http://localhost:3000', STORAGE_MODE: 'disabled' };
  beforeEach(() => {
    Object.assign(process.env, base, { APPOINTMENTS_ENABLED: 'true' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('is off unless set to true', () => {
    delete process.env.APPOINTMENTS_ENABLED;
    resetEnvironmentForTests();
    expect(getEnvironment().APPOINTMENTS_ENABLED).toBe(false);
  });

  describe('routes', () => {
    it('serves the contract paths, bookable-staff before :appointmentId', () => {
      expect(Reflect.getMetadata(PATH_METADATA, AppointmentsController)).toBe('ehr/appointments');
      const methods = Object.getOwnPropertyNames(AppointmentsController.prototype).filter((name) => name !== 'constructor');
      expect(methods.indexOf('bookableStaff')).toBeLessThan(methods.indexOf('read'));
      const routes: [keyof AppointmentsController, string, RequestMethod][] = [
        ['book', '/', RequestMethod.POST], ['list', '/', RequestMethod.GET],
        ['bookableStaff', 'bookable-staff', RequestMethod.GET], ['read', ':appointmentId', RequestMethod.GET],
        ['reschedule', ':appointmentId/reschedule', RequestMethod.POST],
        ['cancel', ':appointmentId/cancel', RequestMethod.POST], ['noShow', ':appointmentId/no-show', RequestMethod.POST],
        ['checkIn', ':appointmentId/check-in', RequestMethod.POST],
      ];
      for (const [method, path, verb] of routes) {
        const handler = AppointmentsController.prototype[method];
        expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
        expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(verb);
      }
      expect(Reflect.getMetadata(PATH_METADATA, PatientAppointmentsController)).toBe('ehr/patients/:patientId/appointments');
      expect(Reflect.getMetadata(PATH_METADATA, AppointmentClinicsController)).toBe('ehr/appointment-clinics');
      expect(Reflect.getMetadata(PATH_METADATA, AppointmentSettingsController)).toBe('ehr/appointment-settings');
      expect(Reflect.getMetadata(METHOD_METADATA, AppointmentSettingsController.prototype.save)).toBe(RequestMethod.PATCH);
      expect(Reflect.getMetadata(PATH_METADATA, MyAppointmentsController)).toBe('ehr/me/appointments');
      expect(Reflect.getMetadata(PATIENT_ALLOWED, MyAppointmentsController)).toBe(true);
      expect(Reflect.getMetadata(FACILITY_OPTIONAL, MyAppointmentsController)).toBe(true);
    });

    it('answers 503 APPOINTMENTS_NOT_AVAILABLE on every route while the flag is off', async () => {
      process.env.APPOINTMENTS_ENABLED = 'false';
      resetEnvironmentForTests();
      const { database, calls } = fakeDatabase([]);
      const service = new AppointmentsService(database, identity);
      const controller = new AppointmentsController(service);
      const request = staffRequest(['ehr.appointment.read', 'ehr.appointment.write']);
      for (const attempt of [() => controller.list(request, { day: '2026-12-03' } as ListAppointmentsQueryDto),
        () => controller.read(request, appointmentId), () => controller.bookableStaff(request),
        () => new MyAppointmentsController(service).mine(request, { when: 'upcoming' } as MyAppointmentsQueryDto),
        () => new AppointmentSettingsController(service).read(request)]) {
        const problem = await problemOf(attempt);
        expect([problem.getStatus(), problem.code, problem.message])
          .toEqual([503, 'APPOINTMENTS_NOT_AVAILABLE', 'Appointments are not available yet.']);
      }
      expect(calls).toHaveLength(0);
    });

    it('refuses in plain words, never the word "permission", before the database', async () => {
      const problem = await problemOf(() => requireAppointmentAccess(staffRequest(['ehr.appointment.read']), 'write'));
      expect([problem.getStatus(), problem.code]).toEqual([403, 'APPOINTMENT_NOT_ALLOWED']);
      expect(problem.message).toBe(APPOINTMENT_MESSAGES.writeNotAllowed);
      const nurse = staffRequest(['ehr.appointment.read', 'ehr.encounter.read', 'ehr.encounter.write']);
      expect(() => requireAppointmentAccess(nurse, 'read')).not.toThrow();
      expect((await problemOf(() => requireAppointmentAccess(nurse, 'check-in'))).code).toBe('APPOINTMENT_NOT_ALLOWED');
      const desk = staffRequest(['ehr.appointment.read', 'ehr.appointment.write', 'ehr.encounter.read',
        'ehr.encounter.write']);
      expect(() => requireAppointmentAccess(desk, 'check-in')).not.toThrow();
      expect((await problemOf(() => requireAppointmentAccess(desk, 'settings-write'))).message)
        .toBe(APPOINTMENT_MESSAGES.settingsNotAllowed);
      expect(() => requireAppointmentAccess(staffRequest(['organization.manage']), 'settings-read')).not.toThrow();
      for (const message of Object.values(APPOINTMENT_MESSAGES)) expect(message.toLowerCase()).not.toContain('permission');
    });

    it('needs direct care', async () => {
      const controller = new AppointmentsController(new AppointmentsService(fakeDatabase([]).database, identity));
      const problem = await problemOf(() => controller.list(staffRequest(['ehr.appointment.read'], 'healthcare-operations'),
        { day: '2026-12-03' } as ListAppointmentsQueryDto));
      expect(problem.code).toBe('PURPOSE_OF_USE_REQUIRED');
    });
  });

  describe('bodies', () => {
    it('takes a booking body exactly as the contract writes it, and refuses a Health ID shaped field', async () => {
      const body = await validate(BookAppointmentDto, { matchRef, departmentCode: 'general_outpatient',
        startsAt: '2026-12-03T09:00:00.000Z', lengthMinutes: 30, visitType: 'follow_up', reason: ' Blood pressure review ' });
      expect(body.reason).toBe('Blood pressure review');
      await expect(validate(BookAppointmentDto, { matchRef, departmentCode: 'general_outpatient',
        startsAt: '2026-12-03T09:00:00.000Z', visitType: 'follow_up', healthId: 'HID-AAAA22' })).rejects.toBeDefined();
      await expect(validate(BookAppointmentDto, { matchRef, departmentCode: 'general_outpatient',
        startsAt: '2026-12-03T09:00:00.000Z', visitType: 'checkup' })).rejects.toBeDefined();
      await expect(validate(BookAppointmentDto, { matchRef, departmentCode: 'general_outpatient',
        startsAt: '2026-12-03T09:00:00.000Z', visitType: 'follow_up', reason: 'x'.repeat(201) })).rejects.toBeDefined();
      await expect(validate(RescheduleAppointmentDto, { expectedRowVersion: 1, startsAt: '2026-12-03T09:00:00.000Z',
        reason: 'short' })).rejects.toBeDefined();
    });

    it('reads the day-list query (statuses as a comma list)', async () => {
      const query = await validate(ListAppointmentsQueryDto, { day: '2026-12-03', status: 'booked,no_show', limit: '20' },
        'query');
      expect(query).toMatchObject({ day: '2026-12-03', status: ['booked', 'no_show'], limit: 20 });
      await expect(validate(ListAppointmentsQueryDto, { day: '2026-12-03', status: 'gone' }, 'query')).rejects.toBeDefined();
    });
  });

  describe('book', () => {
    it('sends one patient handle, the Idempotency-Key and the body digest, and answers the card', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'booked', replayed: false, ...cardRow() }]);
      const answer = await new AppointmentsService(database, identity).book(context, { matchRef,
        departmentCode: 'general_outpatient', startsAt: '2026-12-03T09:00:00.000Z', visitType: 'follow_up',
        reason: 'Blood pressure review' } as BookAppointmentDto, key);
      expect(calls[0]?.sql).toBe(BOOK_SQL);
      expect(calls[0]?.values.slice(0, 10)).toEqual([matchRef, null, 'general_outpatient', null, null,
        '2026-12-03T09:00:00.000Z', null, 'follow_up', 'Blood pressure review', key]);
      expect(calls[0]?.values[10]).toMatch(/^[0-9a-f]{64}$/);
      expect(answer).toEqual({ replayed: false, appointment: expect.objectContaining({ appointmentId, patientId,
        healthIdLast4: 'AA22', bookingBasis: 'search', status: 'booked', startsAt: '2026-12-03T09:00:00.000Z',
        appointmentDay: '2026-12-03', rowVersion: 1 }) });
      expect(JSON.stringify(answer)).not.toContain('HID-');
    });

    it('refuses neither or both handles', async () => {
      const service = new AppointmentsService(fakeDatabase([]).database, identity);
      for (const handles of [{}, { matchRef, patientId }]) {
        const problem = await problemOf(service.book(context, { ...handles, departmentCode: 'general_outpatient',
          startsAt: '2026-12-03T09:00:00.000Z', visitType: 'follow_up' } as BookAppointmentDto, key));
        expect(problem.code).toBe('APPOINTMENT_NEEDS_ONE_PATIENT');
      }
    });

    it('answers each refusal the database decides with the contract code', async () => {
      const cases: [string, number, string][] = [
        ['needs_search', 403, 'APPOINTMENT_NEEDS_SEARCH'], ['time_invalid', 400, 'APPOINTMENT_TIME_INVALID'],
        ['clinic_invalid', 400, 'APPOINTMENT_CLINIC_INVALID'], ['clinician_invalid', 400, 'APPOINTMENT_CLINICIAN_INVALID'],
        ['clinician_clash', 409, 'APPOINTMENT_CLINICIAN_CLASH'], ['patient_clash', 409, 'APPOINTMENT_PATIENT_CLASH'],
        ['key_reused', 409, 'IDEMPOTENCY_KEY_REUSED'], ['department_invalid', 400, 'VALIDATION_FAILED'],
      ];
      for (const [outcome, status, code] of cases) {
        const service = new AppointmentsService(fakeDatabase([{ outcome, replayed: false }]).database, identity);
        const problem = await problemOf(service.book(context, { patientId, departmentCode: 'general_outpatient',
          startsAt: '2026-12-03T09:00:00.000Z', visitType: 'follow_up' } as BookAppointmentDto, key));
        expect([problem.getStatus(), problem.code]).toEqual([status, code]);
      }
    });
  });

  describe('changes and check-in', () => {
    it('reschedules with null removing the clinician', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'updated', replayed: false, ...cardRow({ row_version: '2' }) }]);
      const answer = await new AppointmentsService(database, identity).reschedule(context, appointmentId,
        { expectedRowVersion: 1, startsAt: '2026-12-04T09:00:00.000Z', clinicianMembershipId: null,
          reason: 'The clinic moved the session' } as RescheduleAppointmentDto, key);
      expect(calls[0]?.sql).toBe(RESCHEDULE_SQL);
      expect(calls[0]?.values.slice(0, 8)).toEqual([appointmentId, 1, '2026-12-04T09:00:00.000Z', null, null, true,
        'The clinic moved the session', key]);
      expect(answer.appointment.rowVersion).toBe(2);
    });

    it('maps the change refusals', () => {
      expect([refusal('changed', 'cancel').getStatus(), refusal('changed', 'cancel').code])
        .toEqual([412, 'APPOINTMENT_VERSION_CONFLICT']);
      expect(refusal('not_booked', 'cancel').code).toBe('APPOINTMENT_NOT_BOOKED');
      expect(refusal('too_early', 'no-show').code).toBe('APPOINTMENT_NO_SHOW_TOO_EARLY');
      expect(refusal('wrong_day', 'check-in').code).toBe('APPOINTMENT_CHECK_IN_WRONG_DAY');
      expect(refusal('needs_search', 'check-in').code).toBe('APPOINTMENT_CHECK_IN_NEEDS_SEARCH');
      expect([refusal('not_found', 'read').getStatus(), refusal('not_found', 'read').code])
        .toEqual([404, 'APPOINTMENT_NOT_FOUND']);
    });

    it('checks in with the appointment as the basis and answers the waiting-list card', async () => {
      const entry = { entry_id: entryId, patient_id: patientId, full_name: 'Amaka Bookone', sex: 'female',
        date_of_birth: '1990-01-02', health_id_last4: 'AA22', stage: 'waiting', triage_level: null,
        assigned_membership_id: null, check_in_basis: 'appointment', checked_in_at: '2026-12-03T08:55:00+00:00',
        queue_day: '2026-12-03', stage_changed_at: '2026-12-03T08:55:00+00:00', closed_at: null, row_version: 1,
        chart_blocked: false };
      const { database, calls } = fakeDatabase([{ outcome: 'checked_in', replayed: false,
        ...cardRow({ status: 'checked_in', visit_queue_entry_id: entryId, row_version: '2' }), entry }]);
      const answer = await new AppointmentsService(database, identity).checkIn(context, appointmentId,
        { expectedRowVersion: 1, identityConfirmed: true } as CheckInAppointmentDto, key);
      expect(calls[0]?.sql).toBe(CHECK_IN_SQL);
      expect(calls[0]?.values.slice(0, 5)).toEqual([appointmentId, 1, true, null, key]);
      expect(answer.outcome).toBe('checked_in');
      expect(answer.entry).toMatchObject({ entryId, checkInBasis: 'appointment', stage: 'waiting',
        checkedInAt: '2026-12-03T08:55:00.000Z' });
      expect(answer.appointment.visitQueueEntryId).toBe(entryId);
    });

    it('refuses a check-in whose identity was not confirmed, without asking the database', async () => {
      const { database, calls } = fakeDatabase([]);
      const problem = await problemOf(new AppointmentsService(database, identity).checkIn(context, appointmentId,
        { expectedRowVersion: 1, identityConfirmed: false } as CheckInAppointmentDto, key));
      expect([problem.code, problem.message]).toEqual(['APPOINTMENT_IDENTITY_NOT_CONFIRMED',
        'Confirm the patient\'s name and date of birth with them before checking them in.']);
      expect(calls).toHaveLength(0);
    });
  });

  describe('lists', () => {
    it('pages the day list with a cursor bound to its day', async () => {
      const row = { ...cardRow(), has_more: true, resume_starts_at: '2026-12-03T09:00:00.000000Z',
        resume_booked_at: '2026-11-26T10:00:00.000000Z' };
      const { database, calls } = fakeDatabase([row]);
      const page = await new AppointmentsService(database, identity).list(context,
        { day: '2026-12-03', limit: 1 } as ListAppointmentsQueryDto);
      expect(calls[0]?.sql).toBe(LIST_SQL);
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();
      expect(decodeDayCursor(page.nextCursor!, '2026-12-03')).toMatchObject({ i: appointmentId });
      expect((await problemOf(() => decodeDayCursor(page.nextCursor!, '2026-12-04'))).code).toBe('INVALID_CURSOR');
      expect((await problemOf(() => decodeDayCursor(encodeCursor({ v: 1, d: '2026-12-03', s: 'x', b: 'y', i: 'z' }),
        '2026-12-03'))).code).toBe('INVALID_CURSOR');
    });

    it('serves "My appointments" only in the patient\'s own session, with no staff id or booking basis', async () => {
      const { database, calls } = fakeDatabase([{ appointment_id: appointmentId, facility_name: 'Booking Clinic A',
        clinic_name: 'Medical outpatients', department_code: 'general_outpatient', clinician_name: 'Chidi Doctor',
        starts_at: new Date('2026-12-03T09:00:00Z'), ends_at: new Date('2026-12-03T09:30:00Z'), length_minutes: 30,
        visit_type: 'follow_up', reason: null, status: 'booked', has_more: false,
        resume_starts_at: '2026-12-03T09:00:00.000000Z' }]);
      const service = new AppointmentsService(database, identity);
      const patient = { header: () => undefined, correlationId: 'correlation-123456',
        actor: { kind: 'patient', patientId, accountId, subject: 'patient:test', sessionId } } as unknown as HidRequest;
      const page = await service.mine(patient, { when: 'upcoming' } as MyAppointmentsQueryDto);
      expect(calls[0]?.sql).toBe(MY_LIST_SQL);
      expect(calls[0]?.values).toEqual([patientId, 'upcoming', 20, null, null]);
      expect(page).toEqual({ nextCursor: null, items: [{ appointmentId, facilityName: 'Booking Clinic A',
        clinicName: 'Medical outpatients', departmentCode: 'general_outpatient', clinicianName: 'Chidi Doctor',
        startsAt: '2026-12-03T09:00:00.000Z', endsAt: '2026-12-03T09:30:00.000Z', lengthMinutes: 30,
        visitType: 'follow_up', reason: null, status: 'booked' }] });
      expect(JSON.stringify(page)).not.toMatch(/membership|basis/i);
      const problem = await problemOf(service.mine(staffRequest(['ehr.appointment.read']),
        { when: 'upcoming' } as MyAppointmentsQueryDto));
      expect([problem.getStatus(), problem.code]).toEqual([403, 'PATIENT_SESSION_REQUIRED']);
    });
  });

  describe('the database answers', () => {
    it('translates the functions\' refusals and a schema without 0160', () => {
      const asProblem = (error: unknown) => translate(error, 'write') as DomainProblem;
      expect(asProblem({ code: '42501', message: 'APPOINTMENT_NOT_ALLOWED' }).code).toBe('APPOINTMENT_NOT_ALLOWED');
      expect(asProblem({ code: '42501', message: 'PATIENT_SESSION_REQUIRED' }).code).toBe('PATIENT_SESSION_REQUIRED');
      expect(asProblem({ code: '22023', message: 'APPOINTMENT_DIRECT_CARE_ONLY' }).code).toBe('PURPOSE_OF_USE_REQUIRED');
      expect(asProblem({ code: '22023', message: 'APPOINTMENT_INVALID' }).code).toBe('VALIDATION_FAILED');
      expect(asProblem({ code: '42883', message: 'function ehr.appointment_book does not exist' }).code)
        .toBe('APPOINTMENTS_NOT_AVAILABLE');
      const other = new Error('connection lost');
      expect(translate(other, 'read')).toBe(other);
    });
  });

  describe('the reminder sweep', () => {
    it('runs 0161\'s sweep as the system actor, at most 100 a run, and only while the flag is on', async () => {
      const { database, calls } = fakeDatabase([{ sent: 3 }]);
      const sweeper = new AppointmentReminderSweeper(database);
      expect(await sweeper.sweep()).toBe(3);
      expect(calls).toEqual([{ sql: REMINDER_SQL, values: [100] }]);
      expect((database.withSystemTransaction as jest.Mock).mock.calls[0]?.[0]).toMatch(/^appointment-reminders-/);
      process.env.APPOINTMENTS_ENABLED = 'false';
      resetEnvironmentForTests();
      expect(await sweeper.sweep()).toBe(0);
      expect(calls).toHaveLength(1);
    });

    it('logs and answers 0 when the database is unavailable', async () => {
      const sweeper = new AppointmentReminderSweeper(fakeDatabase(new Error('down')).database);
      expect(await sweeper.sweep()).toBe(0);
    });
  });
});
