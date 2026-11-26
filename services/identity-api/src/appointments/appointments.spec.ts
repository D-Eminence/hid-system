import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import { CollectedFieldProtector, registrationCaseContactLabel } from '../identity/collected-field-protector';
import { AppointmentCallListController } from './appointment-call-list.controller';
import { AppointmentCallListService, CALL_LIST_MESSAGES, CALL_LIST_SQL, translate } from './appointment-call-list.service';
import { AppointmentNoticeDispatcher, emailOutcome, safeCode } from './appointment-notice.dispatcher';

// Fictional values only.
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const caseId = '123e4567-e89b-42d3-a456-426614174091';
const appointmentId = '123e4567-e89b-42d3-a456-426614174071';
const key = Buffer.alloc(32, 7).toString('base64');

describe('APPT-1 identity-api: the call list and the appointment senders (0161)', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      APPOINTMENTS_ENABLED: 'true', NIN_ENCRYPTION_KEY_B64: key, NIN_KEY_VERSION: 'v1' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  function database(rows: Record<string, unknown>[] | Error) {
    const calls: { sql: string; values: unknown[] }[] = [];
    const query = async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (rows instanceof Error) throw rows;
      return { rows };
    };
    return { calls, database: {
      withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => Promise<unknown>) => operation({ query })),
      withSystemTransaction: jest.fn(async (_correlation: string, operation: (client: unknown) => Promise<unknown>) =>
        operation({ query })),
    } as unknown as DatabaseService };
  }
  const context = { facilityId, correlationId: 'correlation-1' } as unknown as DataAccessContext;

  it('serves GET identity/appointment-call-list', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AppointmentCallListController)).toBe('identity');
    expect(Reflect.getMetadata(PATH_METADATA, AppointmentCallListController.prototype.list)).toBe('appointment-call-list');
    expect(Reflect.getMetadata(METHOD_METADATA, AppointmentCallListController.prototype.list)).toBe(RequestMethod.GET);
  });

  it('answers 503 while the flag is off, and refuses in plain words a member without ehr.appointment.write', () => {
    const controller = new AppointmentCallListController(new AppointmentCallListService(database([]).database));
    const request = { header: () => 'direct-care', actor: { permissions: ['ehr.appointment.read'] }, facilityId,
      correlationId: 'correlation-1' } as unknown as HidRequest;
    let problem = (() => { try { controller.list(request, { day: '2026-12-03' }); } catch (error) { return error; } })() as DomainProblem;
    expect(problem).toBeInstanceOf(DomainProblem);
    expect([problem.getStatus(), problem.code, problem.message]).toEqual([403, 'APPOINTMENT_NOT_ALLOWED', CALL_LIST_MESSAGES.notAllowed]);
    expect(problem.message.toLowerCase()).not.toContain('permission');
    process.env.APPOINTMENTS_ENABLED = 'false';
    resetEnvironmentForTests();
    problem = (() => { try { controller.list(request, { day: '2026-12-03' }); } catch (error) { return error; } })() as DomainProblem;
    expect([problem.getStatus(), problem.code]).toEqual([503, 'APPOINTMENTS_NOT_AVAILABLE']);
  });

  it('decrypts the phone this facility recorded, and shows none it cannot read', async () => {
    const protector = new CollectedFieldProtector();
    const ciphertext = protector.encrypt(registrationCaseContactLabel(caseId, 'phone'), '+2348030000001');
    const base = { appointment_id: appointmentId, starts_at: new Date('2026-12-03T09:00:00Z'), clinic_name: 'Medical outpatients',
      clinician_membership_id: null, full_name: 'Amaka Bookone', health_id_last4: 'AA22' };
    const { database: db, calls } = database([
      { ...base, registration_case_id: caseId, phone_ciphertext: ciphertext, key_version: 'v1' },
      { ...base, registration_case_id: '123e4567-e89b-42d3-a456-426614174099', phone_ciphertext: ciphertext, key_version: 'v1' },
      { ...base, registration_case_id: null, phone_ciphertext: null, key_version: null },
    ]);
    const answer = await new AppointmentCallListService(db).list(context, '2026-12-03', null, null);
    expect(calls[0]).toEqual({ sql: CALL_LIST_SQL, values: ['2026-12-03', null, null] });
    expect(answer.items.map((item) => [item.phone, item.phoneSource])).toEqual([
      ['+2348030000001', 'facility_contact'], [null, null], [null, null]]);
    expect(answer.items[0]).toEqual({ appointmentId, startsAt: '2026-12-03T09:00:00.000Z', clinicName: 'Medical outpatients',
      clinicianMembershipId: null, fullName: 'Amaka Bookone', healthIdLast4: 'AA22', phone: '+2348030000001',
      phoneSource: 'facility_contact' });
    expect(JSON.stringify(answer)).not.toMatch(/HID-|reason|visitType|dateOfBirth/);
  });

  it('translates the database refusals', () => {
    expect((translate({ code: '42501' }) as DomainProblem).code).toBe('APPOINTMENT_NOT_ALLOWED');
    expect((translate({ code: '22023', message: 'APPOINTMENT_DIRECT_CARE_ONLY' }) as DomainProblem).code)
      .toBe('PURPOSE_OF_USE_REQUIRED');
    expect((translate({ code: '42883' }) as DomainProblem).code).toBe('APPOINTMENTS_NOT_AVAILABLE');
  });

  it('sends each claimed email once, generic, and records the outcome', async () => {
    const { database: db, calls } = database([{ email_id: appointmentId, recipient: 'patient@example.test',
      notice_code: 'APPOINTMENT_REMINDER', attempt_count: 1, next: 'delivered' }]);
    const notification = { deliverAppointmentEmail: jest.fn().mockResolvedValue({ outcome: 'accepted' }) } as unknown as
      NotificationOtpClient;
    const summary = await new AppointmentNoticeDispatcher(db, notification).dispatchEmails('correlation-1');
    expect(notification.deliverAppointmentEmail).toHaveBeenCalledWith({ emailId: appointmentId,
      recipient: 'patient@example.test', kind: 'reminder', correlationId: 'correlation-1' });
    expect(calls.map((call) => call.sql)).toEqual([
      'select email_id::text, recipient, notice_code, attempt_count from identity.appointment_email_claim($1, $2, $3)',
      'select identity.appointment_email_record($1, $2, $3, $4) as next']);
    expect(calls[1]?.values.slice(2)).toEqual(['delivered', null]);
    expect(summary).toEqual({ claimed: 1, delivered: 1, retried: 0, failed: 0 });
  });

  it('claims nothing while APPOINTMENTS_ENABLED is off', async () => {
    process.env.APPOINTMENTS_ENABLED = 'false';
    resetEnvironmentForTests();
    const { database: db, calls } = database([]);
    const dispatcher = new AppointmentNoticeDispatcher(db, {} as NotificationOtpClient);
    expect(await dispatcher.dispatchEmails('c')).toEqual({ claimed: 0, delivered: 0, retried: 0, failed: 0 });
    expect(await dispatcher.dispatchSms('c')).toEqual({ claimed: 0, delivered: 0, retried: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });

  it('sends a claimed SMS to the decrypted facility phone, and fails one it cannot read without sending', async () => {
    const protector = new CollectedFieldProtector();
    const good = { sms_id: appointmentId, facility_name: 'Booking Clinic A', starts_at: new Date('2026-12-03T09:00:00Z'),
      registration_case_id: caseId, phone_ciphertext: protector.encrypt(registrationCaseContactLabel(caseId, 'phone'),
        '+2348030000001'), key_version: 'v1' };
    const unreadable = { ...good, registration_case_id: '123e4567-e89b-42d3-a456-426614174099' };
    const calls: { sql: string; values: unknown[] }[] = [];
    // The claim answers the two rows; each record answers what 0161 would for this worker's lease.
    const query = async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: sql.includes('appointment_sms_claim') ? [good, unreadable] : [{ next: values[2] === 'sent' ? 'sent' : 'failed' }] };
    };
    const db = { withSystemTransaction: jest.fn(async (_correlation: string, operation: (client: unknown) => Promise<unknown>) =>
      operation({ query })) } as unknown as DatabaseService;
    const notification = { deliverAppointmentReminderSms: jest.fn().mockResolvedValue({ outcome: 'accepted' }) } as unknown as
      NotificationOtpClient;
    const summary = await new AppointmentNoticeDispatcher(db, notification).dispatchSms('correlation-1');
    expect(notification.deliverAppointmentReminderSms).toHaveBeenCalledTimes(1);
    expect(notification.deliverAppointmentReminderSms).toHaveBeenCalledWith({ smsId: appointmentId,
      recipient: '+2348030000001', facilityName: 'Booking Clinic A', startsAt: new Date('2026-12-03T09:00:00Z'),
      correlationId: 'correlation-1' });
    const worker = calls[0]?.values[0];
    expect(calls[0]?.sql).toContain('identity.appointment_sms_claim($1, $2)');
    expect(worker).toMatch(/^identity-api:/);
    expect(calls[0]?.values[1]).toBe(10);
    expect(calls.filter((call) => call.sql.includes('appointment_sms_record')).map((call) => call.values.slice(1)))
      .toEqual([[worker, 'sent', null], [worker, 'failed', 'PHONE_UNREADABLE']]);
    expect(summary).toEqual({ claimed: 2, delivered: 1, retried: 0, failed: 1 });
  });

  it('counts nothing for an SMS whose lease went to another sender (stale)', async () => {
    const protector = new CollectedFieldProtector();
    const claimedRow = { sms_id: appointmentId, facility_name: 'Booking Clinic A', starts_at: new Date('2026-12-03T09:00:00Z'),
      registration_case_id: caseId, phone_ciphertext: protector.encrypt(registrationCaseContactLabel(caseId, 'phone'),
        '+2348030000001'), key_version: 'v1' };
    const query = async (sql: string) => ({ rows: sql.includes('appointment_sms_claim') ? [claimedRow] : [{ next: 'stale' }] });
    const db = { withSystemTransaction: jest.fn(async (_correlation: string, operation: (client: unknown) => Promise<unknown>) =>
      operation({ query })) } as unknown as DatabaseService;
    const notification = { deliverAppointmentReminderSms: jest.fn().mockResolvedValue({ outcome: 'accepted' }) } as unknown as
      NotificationOtpClient;
    expect(await new AppointmentNoticeDispatcher(db, notification).dispatchSms('correlation-1'))
      .toEqual({ claimed: 1, delivered: 0, retried: 0, failed: 0 });
  });

  it('maps delivery answers and safe codes to what 0161 records', () => {
    expect([emailOutcome('accepted'), emailOutcome('unknown'), emailOutcome('definitive_failure')])
      .toEqual(['delivered', 'retry', 'failed']);
    expect([safeCode('http_404', false), safeCode('http_404', true), safeCode('500', false), safeCode(undefined, true)])
      .toEqual(['http_404', 'HTTP_404', 'delivery_error', null]);
  });
});
