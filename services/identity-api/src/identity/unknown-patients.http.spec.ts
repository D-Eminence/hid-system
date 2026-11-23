jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { createHmac, randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { SecurityGuard } from '../auth/security.guard';
import { TokenService } from '../auth/token.service';
import { AUDIT_ACTION, REQUIRED_PERMISSIONS } from '../common/decorators';
import { requestDigest } from '../common/idempotency';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { CollectedFieldProtector } from './collected-field-protector';
import { HidCodeGenerator } from './hid-code-generator.service';
import { UnknownPatientsController } from './unknown-patients.controller';
import { arrivalNoteLabel, encodeUnknownPatientCursor, UNKNOWN_PATIENT_MESSAGES, UnknownPatientsService,
  unknownPatientContactLabel } from './unknown-patients.service';

// ID-7 (0145): the six routes. The database's own decisions are 0145's suite's
// (services/ehr-api/test/database/unknown-patient-record.integration.sql).

const facilityId = '10000000-0000-4000-8000-000000000002';
const patientId = '50000000-0000-4000-8000-000000000001';
const contactKey = Buffer.alloc(32, 4);
const fieldKey = Buffer.alloc(32, 7);
const base = '/api/v1/identity/unknown-patients';

function assignment(permissions: string[]): FacilityAssignment {
  return { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
    organizationId: '10000000-0000-4000-8000-000000000001', name: 'Synthetic Hospital', roles: ['receptionist'],
    permissions, isPrimary: true };
}
function staff(permissions = ['identity.registration.write']): ActorContext {
  const facility = assignment(permissions);
  return { kind: 'staff', id: 'staff:desk', subject: 'staff:desk', accountId: '20000000-0000-4000-8000-000000000001',
    email: 'desk@example.test', roles: facility.roles, permissions: facility.permissions, platformRoles: [],
    platformPermissions: [], facilityIds: [facility.id], facilities: [facility], facility, authenticationMethod: 'local' };
}
const meta = (key: symbol, target: object) => Reflect.getMetadata(key, target) as unknown;
const databaseError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('ID-7 routes: metadata', () => {
  it('writes and reads need identity.registration.write; the decisions identity.registration.approve', () => {
    const routes = UnknownPatientsController.prototype as unknown as Record<string, object>;
    const expected: Record<string, [string, string]> = {
      create: ['identity.registration.write', 'identity.unknown-patient.create.request'],
      list: ['identity.registration.write', 'identity.unknown-patient.list.request'],
      read: ['identity.registration.write', 'identity.unknown-patient.read.request'],
      identify: ['identity.registration.write', 'identity.unknown-patient.identify.request'],
      review: ['identity.registration.approve', 'identity.unknown-patient.review.request'],
      confirmSeparate: ['identity.registration.approve', 'identity.unknown-patient.confirm-separate.request'],
      cancel: ['identity.registration.approve', 'identity.unknown-patient.cancel.request'],
    };
    for (const [handler, [permission, action]] of Object.entries(expected)) {
      expect(meta(REQUIRED_PERMISSIONS, routes[handler] as object)).toEqual([permission]);
      expect(meta(AUDIT_ACTION, routes[handler] as object)).toBe(action);
    }
  });
});

describe('ID-7 routes over HTTP', () => {
  const originalEnvironment = { ...process.env };
  let app: INestApplication;
  const handlers: Record<string, (values: unknown[]) => unknown> = {};
  const calls: { sql: string; values: unknown[] }[] = [];
  const respond = jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    for (const [needle, handler] of Object.entries(handlers)) if (sql.includes(needle)) return handler(values);
    if (sql.includes('platform.control_enabled($1)')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }] };
    return { rows: [] };
  });
  const database = {
    query: respond,
    withTransaction: jest.fn(async (_context: unknown, work: (client: unknown) => Promise<unknown>) => work({ query: respond })),
    withSystemTransaction: jest.fn(),
    withPlatformTransaction: jest.fn(),
  };
  const tokens = { verify: jest.fn(), verifyCsrf: jest.fn() };
  const audit = { record: jest.fn(), recordWithClient: jest.fn() };
  const hids = { reserve: jest.fn(async (work: (candidate: string) => Promise<{ reserved: boolean; result?: unknown }>) => {
    const attempt = await work('HID-UNKAAA2');
    return attempt.reserved ? attempt.result : (await work('HID-UNKAAA3')).result;
  }) };
  const sqlCalls = (needle: string) => calls.filter((call) => call.sql.includes(needle));
  const rows = (action: string) => audit.record.mock.calls.map(([event]) => event as { action: string; outcome: string;
    details?: Record<string, unknown> }).filter((event) => event.action === action);
  const createdRow = (overrides: Record<string, unknown> = {}) => ({ patient_id: patientId, hid_code: 'HID-UNKAAA2',
    record_kind: 'unknown', label: 'U-0007', display_name: 'Unknown patient U-0007', sex: 'male',
    date_of_birth: '1991-07-01', dob_estimated: true, status: 'open', created_at: new Date('2026-11-19T14:05:00Z'),
    row_version: '1', facility_daily_count: 1, replayed: false, ...overrides });

  beforeEach(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid', CORS_ORIGINS: 'https://app.healthidentitydirectory.com',
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456', AUTH_COOKIE_SECURE: 'true',
      OTP_HMAC_KEY_B64: Buffer.alloc(32, 3).toString('base64'), CONTACT_LOOKUP_HMAC_KEY_B64: contactKey.toString('base64'),
      NIN_ENCRYPTION_KEY_B64: fieldKey.toString('base64'), NIN_KEY_VERSION: 'test-v1',
    });
    resetEnvironmentForTests();
    jest.clearAllMocks();
    calls.length = 0;
    for (const key of Object.keys(handlers)) delete handlers[key];
    tokens.verify.mockResolvedValue({ actor: staff(), claims: {} });
    tokens.verifyCsrf.mockReturnValue(true);
    audit.record.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [UnknownPatientsController],
      providers: [
        UnknownPatientsService,
        { provide: HidCodeGenerator, useValue: hids },
        { provide: DatabaseService, useValue: database },
        { provide: TokenService, useValue: tokens },
        { provide: AuditService, useValue: audit },
        { provide: APP_GUARD, useFactory: (reflector: Reflector) => new SecurityGuard(reflector,
          tokens as unknown as TokenService, audit as unknown as AuditService, database as unknown as DatabaseService),
        inject: [Reflector] },
        { provide: APP_INTERCEPTOR, useFactory: (reflector: Reflector) => new AuditInterceptor(reflector,
          audit as unknown as AuditService), inject: [Reflector] },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.use((incoming: HidRequest, _response: Response, next: NextFunction) => {
      incoming.correlationId = randomUUID();
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  const post = (path: string) => request(app.getHttpServer()).post(`${base}${path}`).set('Authorization', 'Bearer synthetic')
    .set('X-Facility-ID', facilityId);
  const get = (path: string, purpose: string | null = 'healthcare-operations') => {
    const call = request(app.getHttpServer()).get(`${base}${path}`).set('Authorization', 'Bearer synthetic')
      .set('X-Facility-ID', facilityId);
    return purpose ? call.set('X-Purpose-Of-Use', purpose) : call;
  };
  const createBody = { gender: 'male', estimatedAgeYears: 35, unknownReason: 'unconscious',
    arrivalNote: 'Brought by ambulance from the junction, blue shirt', purpose: 'healthcare-operations' };

  describe('create', () => {
    it('answers 201 once with the Health ID; the note is encrypted for this record and never logged', async () => {
      handlers['identity.create_unknown_patient'] = () => ({ rows: [createdRow()] });
      const answer = await post('').set('Idempotency-Key', 'unknown-create-dialog-0001').send(createBody);
      expect(answer.status).toBe(201);
      expect(answer.body).toEqual(expect.objectContaining({ patientId, hid: 'HID-UNKAAA2', recordKind: 'unknown',
        label: 'U-0007', displayName: 'Unknown patient U-0007', sex: 'male', dateOfBirth: '1991-07-01',
        dateOfBirthEstimated: true, ninStatus: 'not_verified', status: 'open', createdAt: '2026-11-19T14:05:00.000Z',
        overdue: false, version: 1, replayed: false }));
      const [call] = sqlCalls('identity.create_unknown_patient');
      const [newId, hid, gender, age, reason, note, keyVersion, key, digest] = call?.values ?? [];
      expect([hid, gender, age, reason, keyVersion, key]).toEqual(['HID-UNKAAA2', 'male', 35, 'unconscious', 'test-v1',
        'unknown-create-dialog-0001']);
      expect(new CollectedFieldProtector().decrypt(arrivalNoteLabel(String(newId)), 'test-v1', note as Buffer))
        .toBe(createBody.arrivalNote);
      expect(digest).toBe(requestDigest('identity.unknown-patient.create', { gender: 'male', estimatedAgeYears: 35,
        unknownReason: 'unconscious', arrivalNote: createBody.arrivalNote, purpose: 'healthcare-operations' }));
      expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(/ambulance|HID-/);
    });

    it('answers a replay 200 with replayed: true', async () => {
      handlers['identity.create_unknown_patient'] = () => ({ rows: [createdRow({ replayed: true, facility_daily_count: null })] });
      const answer = await post('').set('Idempotency-Key', 'unknown-create-dialog-0001').send(createBody);
      expect([answer.status, answer.body.replayed]).toEqual([200, true]);
    });

    it('needs an Idempotency-Key, the gender and reason, an age of 0-120 and a note of at most 1000 characters', async () => {
      const noKey = await post('').send(createBody);
      expect([noKey.status, noKey.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
      for (const body of [{ ...createBody, estimatedAgeYears: 121 }, { ...createBody, gender: undefined },
        { ...createBody, unknownReason: 'asleep' }, { ...createBody, arrivalNote: 'x'.repeat(1001) },
        { ...createBody, firstName: 'Ada' }, { ...createBody, purpose: 'direct-care' }]) {
        const invalid = await post('').set('Idempotency-Key', 'unknown-create-dialog-0002').send(body);
        expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
      expect(sqlCalls('create_unknown_patient')).toEqual([]);
    });

    it('maps the database\'s refusals and writes one denied row; a database without 0145 is 503 with none', async () => {
      for (const [error, status, code] of [
        [databaseError('42501', 'UNKNOWN_PATIENT_SEALED_FACILITY'), 403, 'UNKNOWN_PATIENT_NOT_AVAILABLE'],
        [databaseError('42501', 'UNKNOWN_PATIENT_DENIED'), 403, 'PERMISSION_DENIED'],
        [databaseError('22023', 'IDEMPOTENCY_KEY_REUSED'), 409, 'IDEMPOTENCY_KEY_REUSED'],
      ] as [unknown, number, string][]) {
        handlers['identity.create_unknown_patient'] = () => { throw error; };
        const answer = await post('').set('Idempotency-Key', 'unknown-create-dialog-0003').send(createBody);
        expect([answer.status, answer.body.code]).toEqual([status, code]);
      }
      expect(rows('identity.unknown-patient.create').map((row) => [row.outcome, row.details?.refusal])).toEqual([
        ['denied', 'UNKNOWN_PATIENT_NOT_AVAILABLE'], ['denied', 'PERMISSION_DENIED'], ['denied', 'IDEMPOTENCY_KEY_REUSED']]);
      handlers['identity.create_unknown_patient'] = () => { throw databaseError('42883', 'function does not exist'); };
      const missing = await post('').set('Idempotency-Key', 'unknown-create-dialog-0004').send(createBody);
      expect([missing.status, missing.body.code]).toEqual([503, 'UNKNOWN_PATIENT_UNAVAILABLE']);
      expect(rows('identity.unknown-patient.create')).toHaveLength(3);
    });
  });

  describe('list and read', () => {
    it('lists with X-Purpose-Of-Use healthcare-operations, marks an open record over 30 days overdue, pages by cursor', async () => {
      const old = new Date(Date.now() - 31 * 86_400_000);
      handlers['identity.list_unknown_patients'] = () => ({ rows: [
        { ...createdRow(), health_id_last4: 'AAA2', unknown_reason: 'unconscious', nin_verified: false, created_at: old,
          has_more: true }] });
      const listed = await get('?status=open&limit=1');
      expect(listed.status).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(listed.body.items[0]).toEqual(expect.objectContaining({ healthIdLast4: 'AAA2', unknownReason: 'unconscious',
        overdue: true, openDays: 31 }));
      expect(listed.body.items[0]).not.toHaveProperty('arrivalNote');
      expect(listed.body.nextCursor).toBe(encodeUnknownPatientCursor(old.toISOString(), patientId));
      await get(`?cursor=${listed.body.nextCursor}`);
      expect(sqlCalls('identity.list_unknown_patients')[1]?.values).toEqual(['open', 25, old.toISOString(), patientId]);
      expect((await get('?cursor=not-a-real-cursor-at-all')).body.code).toBe('VALIDATION_FAILED');
      expect((await get('', 'direct-care')).body.code).toBe('PURPOSE_OF_USE_REQUIRED');
      expect((await get('', null)).body.code).toBe('PURPOSE_OF_USE_REQUIRED');
    });

    it('reads one record with its decrypted note; another facility\'s is 404 PATIENT_NOT_FOUND', async () => {
      const note = new CollectedFieldProtector().encrypt(arrivalNoteLabel(patientId), 'Blue shirt');
      handlers['identity.read_unknown_patient'] = () => ({ rows: [{ ...createdRow(), outcome: 'found', health_id_last4: 'AAA2',
        unknown_reason: 'unconscious', nin_verified: false, arrival_note_ciphertext: note, arrival_note_key_version: 'test-v1' }] });
      const found = await get(`/${patientId}`);
      expect([found.status, found.body.arrivalNote, found.body.label]).toEqual([200, 'Blue shirt', 'U-0007']);
      handlers['identity.read_unknown_patient'] = () => ({ rows: [{ outcome: 'not_found' }] });
      const missing = await get(`/${patientId}`);
      expect([missing.status, missing.body.code, missing.body.detail]).toEqual([404, 'PATIENT_NOT_FOUND', 'No such patient.']);
      // The database wrote the not-found row with its reason; Identity writes none.
      expect(rows('identity.unknown-patient.read')).toEqual([]);
    });
  });

  describe('identify', () => {
    const identifyBody = { firstName: 'Zara', lastName: 'Bello', dateOfBirth: '1985-01-01', gender: 'female',
      phone: '+2348031234567', addressLine: '12 Market Road', city: 'Ikeja', stateCode: 'LA', lga: 'Ikeja',
      expectedVersion: 1, purpose: 'healthcare-operations' };
    const identifyRow = (outcome: string, overrides: Record<string, unknown> = {}) => ({ outcome, patient_id: patientId,
      record_kind: outcome === 'identified' ? 'standard' : 'unknown',
      label: 'U-0007', display_name: outcome === 'identified' ? 'Zara Bello' : 'Unknown patient U-0007', sex: 'female',
      date_of_birth: '1985-01-01', dob_estimated: false, status: outcome, row_version: '2', candidate_count: 0,
      replayed: false, ...overrides });

    it('identifies: the contact encrypted for this record, the phone by its lookup hashes only', async () => {
      handlers['identity.identify_unknown_patient'] = () => ({ rows: [identifyRow('identified')] });
      const answer = await post(`/${patientId}/identify`).set('Idempotency-Key', 'unknown-identify-0001').send(identifyBody);
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual(expect.objectContaining({ outcome: 'identified', recordKind: 'standard',
        displayName: 'Zara Bello', message: UNKNOWN_PATIENT_MESSAGES.identified, version: 2 }));
      const values = sqlCalls('identity.identify_unknown_patient')[0]?.values ?? [];
      const lookups = String(values[6]).split(',');
      expect(lookups).toContain(createHmac('sha256', contactKey)
        .update(['hid-contact-lookup:v1', 'phone', '+2348031234567'].join('\u001f'), 'utf8').digest('hex'));
      expect(new CollectedFieldProtector().decrypt(unknownPatientContactLabel(patientId, 'phone'), 'test-v1',
        values[7] as Buffer)).toBe('+2348031234567');
      expect(JSON.stringify(values)).not.toContain('8031234567');
    });

    it('answers sent_for_review with the plain message and no one else\'s details', async () => {
      handlers['identity.identify_unknown_patient'] = () => ({ rows: [identifyRow('sent_for_review', { candidate_count: 1 })] });
      const answer = await post(`/${patientId}/identify`).set('Idempotency-Key', 'unknown-identify-0002').send(identifyBody);
      expect(answer.body).toEqual(expect.objectContaining({ outcome: 'sent_for_review', recordKind: 'unknown',
        message: UNKNOWN_PATIENT_MESSAGES.sentForReview }));
      expect(answer.body).not.toHaveProperty('candidateCount');
    });

    it('maps the phone rule, the version and a second identify', async () => {
      for (const [error, status, code] of [
        [databaseError('22023', 'UNKNOWN_PATIENT_PHONE_REQUIRED'), 400, 'PHONE_REQUIRED'],
        [databaseError('40001', 'VERSION_CONFLICT'), 412, 'VERSION_CONFLICT'],
        [databaseError('P0001', 'UNKNOWN_PATIENT_ALREADY_IDENTIFIED'), 409, 'UNKNOWN_PATIENT_ALREADY_IDENTIFIED'],
        [databaseError('P0001', 'UNKNOWN_PATIENT_CANCELLED'), 409, 'UNKNOWN_PATIENT_CANCELLED'],
      ] as [unknown, number, string][]) {
        handlers['identity.identify_unknown_patient'] = () => { throw error; };
        const answer = await post(`/${patientId}/identify`).set('Idempotency-Key', 'unknown-identify-0003')
          .send({ firstName: 'Zara', lastName: 'Bello', dateOfBirth: '1985-01-01', expectedVersion: 1,
            purpose: 'healthcare-operations' });
        expect([answer.status, answer.body.code]).toEqual([status, code]);
      }
      expect(rows('identity.unknown-patient.identify')).toHaveLength(4);
    });
  });

  describe('review', () => {
    const reviewRow = (overrides: Record<string, unknown> = {}) => ({ outcome: 'found', patient_id: patientId,
      label: 'U-0007', status: 'sent_for_review', row_version: '3', proposed_first_name: 'Ada', proposed_last_name: 'Obi',
      proposed_date_of_birth: '1990-05-01', proposed_sex: 'female', identified_at: new Date('2026-11-20T08:00:00Z'),
      open_registration_count: 1, candidates: [{ position: 1, fullName: 'Ada Obi', dateOfBirth: '1990-05-01', sex: 'female',
        healthIdLast4: 'STD2', matchReasons: ['date_of_birth', 'first_name', 'last_name'], active: true }], ...overrides });

    it('needs identity.registration.approve and healthcare operations', async () => {
      const denied = await get(`/${patientId}/review`);
      expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
      tokens.verify.mockResolvedValue({ actor: staff(['identity.registration.approve']), claims: {} });
      const noPurpose = await get(`/${patientId}/review`, null);
      expect(noPurpose.status).toBe(400);
      expect(sqlCalls('review_unknown_patient')).toEqual([]);
    });

    it('shows the approver the held details and each candidate\'s card, never a candidate\'s id', async () => {
      tokens.verify.mockResolvedValue({ actor: staff(['identity.registration.approve']), claims: {} });
      handlers['identity.review_unknown_patient'] = () => ({ rows: [reviewRow()] });
      const answer = await get(`/${patientId}/review`);
      expect(answer.status).toBe(200);
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.body).toEqual({ patientId, label: 'U-0007', status: 'sent_for_review', version: 3,
        identifiedAt: '2026-11-20T08:00:00.000Z',
        heldDetails: { firstName: 'Ada', lastName: 'Obi', dateOfBirth: '1990-05-01', sex: 'female' },
        openRegistrationCount: 1, candidates: [{ position: 1, fullName: 'Ada Obi', dateOfBirth: '1990-05-01', sex: 'female',
          healthIdLast4: 'STD2', matchReasons: ['date_of_birth', 'first_name', 'last_name'], active: true }] });
      expect(sqlCalls('identity.review_unknown_patient')[0]?.values).toEqual([patientId]);
    });

    it('answers a record not in review 409, the member who identified it 403, another facility\'s 404', async () => {
      tokens.verify.mockResolvedValue({ actor: staff(['identity.registration.approve']), claims: {} });
      for (const [outcome, status, code] of [['not_in_review', 409, 'UNKNOWN_PATIENT_NOT_IN_REVIEW'],
        ['second_person_required', 403, 'UNKNOWN_PATIENT_SECOND_PERSON_REQUIRED'], ['not_found', 404, 'PATIENT_NOT_FOUND'],
      ] as [string, number, string][]) {
        handlers['identity.review_unknown_patient'] = () => ({ rows: [reviewRow({ outcome, candidates: null })] });
        const answer = await get(`/${patientId}/review`);
        expect([answer.status, answer.body.code]).toEqual([status, code]);
        expect(JSON.stringify(answer.body)).not.toContain('Ada');
      }
      // The database audited those itself; the service writes no second refusal row.
      expect(rows('identity.unknown-patient.review')).toEqual([]);
    });
  });

  describe('confirm-separate and cancel', () => {
    const decideBody = { expectedVersion: 3, reason: 'Checked with the family', purpose: 'healthcare-operations' };

    it('needs identity.registration.approve', async () => {
      const denied = await post(`/${patientId}/cancel`).set('Idempotency-Key', 'unknown-cancel-0001').send(decideBody);
      expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
      expect(sqlCalls('decide_unknown_patient')).toEqual([]);
    });

    it('confirms separate and cancels, and maps the second-person rule and attached records', async () => {
      tokens.verify.mockResolvedValue({ actor: staff(['identity.registration.write', 'identity.registration.approve']), claims: {} });
      handlers['identity.decide_unknown_patient'] = (values) => ({ rows: [{ outcome: values[1] === 'cancel' ? 'cancelled' : 'identified',
        patient_id: patientId, record_kind: values[1] === 'cancel' ? 'unknown' : 'standard', label: 'U-0007',
        display_name: 'Zara Bello', sex: 'female', date_of_birth: '1985-01-01', dob_estimated: false,
        status: values[1] === 'cancel' ? 'cancelled' : 'identified', row_version: '4', replayed: false }] });
      const confirmed = await post(`/${patientId}/confirm-separate`).set('Idempotency-Key', 'unknown-confirm-0001').send(decideBody);
      expect([confirmed.status, confirmed.body.outcome, confirmed.body.message]).toEqual([200, 'identified',
        UNKNOWN_PATIENT_MESSAGES.confirmed]);
      const cancelled = await post(`/${patientId}/cancel`).set('Idempotency-Key', 'unknown-cancel-0002').send(decideBody);
      expect([cancelled.status, cancelled.body.outcome, cancelled.body.status]).toEqual([200, 'cancelled', 'cancelled']);
      expect(sqlCalls('identity.decide_unknown_patient').map((call) => call.values.slice(1, 4))).toEqual([
        ['confirm_separate', 3, 'Checked with the family'], ['cancel', 3, 'Checked with the family']]);
      for (const [error, status, code] of [
        [databaseError('42501', 'UNKNOWN_PATIENT_SECOND_PERSON_REQUIRED'), 403, 'UNKNOWN_PATIENT_SECOND_PERSON_REQUIRED'],
        [databaseError('P0001', 'UNKNOWN_PATIENT_NOT_IN_REVIEW'), 409, 'UNKNOWN_PATIENT_NOT_IN_REVIEW'],
        [databaseError('P0001', 'UNKNOWN_PATIENT_HAS_RECORDS'), 409, 'UNKNOWN_PATIENT_HAS_RECORDS'],
      ] as [unknown, number, string][]) {
        handlers['identity.decide_unknown_patient'] = () => { throw error; };
        const answer = await post(`/${patientId}/confirm-separate`).set('Idempotency-Key', 'unknown-confirm-0002').send(decideBody);
        expect([answer.status, answer.body.code]).toEqual([status, code]);
      }
      for (const body of [{ ...decideBody, reason: 'short' }, { ...decideBody, expectedVersion: 0 }]) {
        const invalid = await post(`/${patientId}/cancel`).set('Idempotency-Key', 'unknown-cancel-0003').send(body);
        expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
    });
  });
});
