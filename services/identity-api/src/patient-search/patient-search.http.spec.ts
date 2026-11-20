jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { createHmac, randomUUID } from 'node:crypto';
import { type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { SecurityGuard } from '../auth/security.guard';
import { TokenService } from '../auth/token.service';
import { AUDIT_ACTION, FACILITY_OPTIONAL, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { MATCH_REF_PATTERN, resolvePatientMatchRef } from './match-ref';
import { PatientSearchController } from './patient-search.controller';
import { normalizeSearchName, patientSearchKeyKinds, patientSearchReach } from './patient-search-keys';
import {
  PATIENT_SEARCH_LIMITED_EVENT, PATIENT_SEARCH_MESSAGES, PatientSearchService, validDateOfBirth,
} from './patient-search.service';

// 0132 (ID-3a, ID-3b; owner decisions of 18 November 2026): staff patient
// search over HTTP with the real guard, interceptor, validation and problem
// filter, on a fake database. Fictional people and identifiers only.
const facilityId = '10000000-0000-4000-8000-000000000002';
const membershipId = '40000000-0000-4000-8000-000000000001';
const otpKey = Buffer.alloc(32, 3);
const contactKey = Buffer.alloc(32, 4);
const ref = (n: number) => `psr_${String(n).repeat(43).slice(0, 43)}`;
const meta = (key: symbol, target: object) => Reflect.getMetadata(key, target) as unknown;
const databaseError = (code: string, message: string) => Object.assign(new Error(message), { code });

function staffAt(roles: string[], permissions: string[]): ActorContext {
  const facility: FacilityAssignment = { id: facilityId, membershipId, organizationId: '10000000-0000-4000-8000-000000000001',
    name: 'Synthetic Clinic', roles, permissions, isPrimary: true };
  return { kind: 'staff', id: 'staff:desk', subject: 'staff:desk', accountId: '20000000-0000-4000-8000-000000000001',
    roles, permissions, platformRoles: [], platformPermissions: [], facilityIds: [facilityId], facilities: [facility],
    facility, authenticationMethod: 'local' };
}
const desk = () => staffAt(['receptionist'], ['identity.registration.write', 'identity.patient.read']);
const doctor = () => staffAt(['doctor'], ['identity.registration.write', 'identity.break-glass.write', 'identity.patient.read']);
const lab = () => staffAt(['lab'], ['identity.patient.read']);

describe('patient search keys (0132)', () => {
  it('names are compared lower case, trimmed, inner spaces collapsed', () => {
    expect(normalizeSearchName('  Amaka   Grace ')).toBe('amaka grace');
    expect(normalizeSearchName('   ')).toBeUndefined();
    expect(normalizeSearchName(undefined)).toBeUndefined();
  });

  it.each([
    [{ firstName: 'a', lastName: 'b', dateOfBirth: '1990-05-01' }, 'everywhere'],
    [{ healthId: 'HID-QSAA22', lastName: 'b' }, 'everywhere'],
    [{ healthId: 'HID-QSAA22', dateOfBirth: '1990-05-01' }, 'everywhere'],
    [{ phone: '+2348030000001', lastName: 'b' }, 'everywhere'],
    [{ lastName: 'b', dateOfBirth: '1990-05-01' }, 'here'],
    [{ phone: '+2348030000001' }, 'here'],
    [{ phone: '+2348030000001', dateOfBirth: '1990-05-01' }, 'here'],
    [{ healthId: 'HID-QSAA22' }, 'here'],
    [{ firstName: 'a', lastName: 'b' }, null],
    [{ lastName: 'b' }, null],
    [{ dateOfBirth: '1990-05-01' }, null],
    [{ firstName: 'a', dateOfBirth: '1990-05-01' }, null],
    [{}, null],
  ])('the strong and weak key rule: %j reaches %s', (keys, reach) => {
    expect(patientSearchReach(keys)).toBe(reach);
  });

  it('lists the kinds in a fixed order', () => {
    expect(patientSearchKeyKinds({ phone: 'x', healthId: 'y', firstName: 'z' })).toEqual(['first_name', 'health_id', 'phone']);
  });

  it('a date of birth is a real past day', () => {
    expect([validDateOfBirth('1990-05-01'), validDateOfBirth('1990-02-30'), validDateOfBirth('2999-01-01'),
      validDateOfBirth('1870-01-01'), validDateOfBirth('01-05-1990')]).toEqual([true, false, false, false, false]);
  });
});

describe('matchRef reader (0132)', () => {
  it('asks the database only for a well-formed matchRef, under the given purpose', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ patient_id: '30000000-0000-4000-8000-000000000001' }] });
    const client = { query } as never;
    expect(await resolvePatientMatchRef(client, 'HID-QSAA22', 'direct-care')).toBeNull();
    expect(query).not.toHaveBeenCalled();
    expect(await resolvePatientMatchRef(client, ref(1), 'emergency')).toBe('30000000-0000-4000-8000-000000000001');
    expect(query).toHaveBeenCalledWith('select identity.resolve_patient_search_ref($1, $2)::text as patient_id', [ref(1), 'emergency']);
    expect(MATCH_REF_PATTERN.test(ref(1))).toBe(true);
  });
});

describe('patient search routes: metadata', () => {
  it('search needs identity.registration.write, emergency search identity.break-glass.write; both audited, facility required', () => {
    const p = PatientSearchController.prototype;
    expect([meta(REQUIRED_PERMISSIONS, p.search), meta(AUDIT_ACTION, p.search), meta(FACILITY_OPTIONAL, p.search)])
      .toEqual([['identity.registration.write'], 'identity.patient.search.request', undefined]);
    expect([meta(REQUIRED_PERMISSIONS, p.emergencySearch), meta(AUDIT_ACTION, p.emergencySearch),
      meta(FACILITY_OPTIONAL, p.emergencySearch)])
      .toEqual([['identity.break-glass.write'], 'identity.patient.emergency-search.request', undefined]);
  });
});

describe('patient search routes over HTTP', () => {
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
  const contexts: Array<{ purposeOfUse: string }> = [];
  const database = {
    query: respond,
    withTransaction: jest.fn(async (context: { purposeOfUse: string }, work: (client: unknown) => Promise<unknown>) => {
      contexts.push(context); return work({ query: respond });
    }),
  };
  const tokens = { verify: jest.fn(), verifyCsrf: jest.fn() };
  const audit = { record: jest.fn(), recordWithClient: jest.fn() };
  const sqlCalls = (needle: string) => calls.filter((call) => call.sql.includes(needle));
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  beforeEach(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://ehr.healthidentitydirectory.com',
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456', AUTH_COOKIE_SECURE: 'true',
      OTP_HMAC_KEY_B64: otpKey.toString('base64'), CONTACT_LOOKUP_HMAC_KEY_B64: contactKey.toString('base64'),
    });
    resetEnvironmentForTests();
    jest.clearAllMocks();
    calls.length = 0;
    contexts.length = 0;
    for (const key of Object.keys(handlers)) delete handlers[key];
    tokens.verify.mockResolvedValue({ actor: desk(), claims: {} });
    tokens.verifyCsrf.mockReturnValue(true);
    audit.record.mockResolvedValue(undefined);
    audit.recordWithClient.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [PatientSearchController],
      providers: [
        PatientSearchService,
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

  afterAll(() => warn.mockRestore());

  const server = () => app.getHttpServer();
  const search = (body: object, purpose = 'direct-care') => request(server()).post('/api/v1/identity/patient-search')
    .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId).set('X-Purpose-Of-Use', purpose)
    .set('X-CSRF-Token', 'synthetic').send(body);
  const emergency = (body: object, purpose = 'emergency') => request(server())
    .post('/api/v1/identity/patient-search/emergency')
    .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId).set('X-Purpose-Of-Use', purpose)
    .set('X-CSRF-Token', 'synthetic').send(body);
  const card = (n: number, last4: string, nin: boolean) => ({ outcome: 'found', reach: 'everywhere', match_ref: ref(n),
    full_name: 'Amaka Okafor', sex: 'female', date_of_birth: '1990-05-01', health_id_last4: last4, nin_verified: nin,
    match_ref_expires_at: new Date('2026-11-18T10:10:00Z') });
  const only = (outcome: string, reach: string | null) => ({ outcome, reach, match_ref: null, full_name: null, sex: null,
    date_of_birth: null, health_id_last4: null, nin_verified: null, match_ref_expires_at: null });
  const bucket = (label: string, id: string) => createHmac('sha256', otpKey).update(`${label}\0`).update(id).digest('hex');
  const phoneHmac = (phone: string) => createHmac('sha256', contactKey)
    .update(['hid-contact-lookup:v1', 'phone', phone].join('\u001f'), 'utf8').digest('hex');
  const auditEvents = () => JSON.stringify([audit.record.mock.calls, audit.recordWithClient.mock.calls]);

  describe('ID-7 (0146): record kind', () => {
    it('carries an unknown record\'s kind, and reads a database without 0146 as standard', async () => {
      handlers['identity.staff_patient_search'] = () => ({ rows: [{ ...card(1, 'AA22', false), record_kind: 'unknown' }] });
      const unknown = await search({ healthId: 'HID-AAAA22' });
      expect(unknown.body.patients.map((patient: { recordKind: string }) => patient.recordKind)).toEqual(['unknown']);
      expect(sqlCalls('identity.staff_patient_search')[0]?.sql).toContain("to_jsonb(answer) ->> 'record_kind'");
      handlers['identity.staff_patient_search'] = () => ({ rows: [card(1, 'AA22', false)] });
      const older = await search({ healthId: 'HID-AAAA22' });
      expect(older.body.patients.map((patient: { recordKind: string }) => patient.recordKind)).toEqual(['standard']);
    });
  });

  describe('standard search', () => {
    it('counts the search for the member and the facility, then searches with normalized keys; cards carry matchRefs only', async () => {
      handlers['identity.staff_patient_search'] = () => ({ rows: [card(1, 'AA22', false), card(2, 'AB22', true)] });
      const answer = await search({ firstName: '  Amaka ', lastName: 'OKAFOR', dateOfBirth: '1990-05-01' });
      expect(answer.status).toBe(200);
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.body).toEqual({ mode: 'standard', outcome: 'found', reach: 'everywhere', message: null, patients: [
        { matchRef: ref(1), matchRefExpiresAt: '2026-11-18T10:10:00.000Z', fullName: 'Amaka Okafor', sex: 'female',
          dateOfBirth: '1990-05-01', healthIdLast4: 'AA22', ninStatus: 'not_verified', recordKind: 'standard' },
        { matchRef: ref(2), matchRefExpiresAt: '2026-11-18T10:10:00.000Z', fullName: 'Amaka Okafor', sex: 'female',
          dateOfBirth: '1990-05-01', healthIdLast4: 'AB22', ninStatus: 'verified', recordKind: 'standard' }] });
      expect(JSON.stringify(answer.body)).not.toMatch(/HID-|patientId|"hid"|unverified/i);
      expect(sqlCalls('from auth.otp_rate_limits').map((call) => call.values[1])).toEqual([
        bucket('patient-search-member', membershipId), bucket('patient-search-facility', facilityId)]);
      const values = sqlCalls('identity.staff_patient_search')[0]?.values ?? [];
      expect(values.slice(0, 7)).toEqual(['standard', 'amaka', 'okafor', '1990-05-01', null, null, null]);
      expect(values[7]).toMatch(/^[0-9a-f]{64}$/);
      expect(contexts.map((context) => context.purposeOfUse)).toEqual(['direct-care', 'direct-care']);
      expect(calls.findIndex((call) => call.sql.includes('otp_rate_limits')))
        .toBeLessThan(calls.findIndex((call) => call.sql.includes('staff_patient_search')));
    });

    it('sends the phone as the lookup HMACs of each form it may be stored in, never the number', async () => {
      handlers['identity.staff_patient_search'] = () => ({ rows: [only('no_match', 'here')] });
      const answer = await search({ phone: '0803 000 0001' });
      expect([answer.status, answer.body]).toEqual([200, { mode: 'standard', outcome: 'no_match', reach: 'here',
        message: PATIENT_SEARCH_MESSAGES.noMatchHere, patients: [] }]);
      const values = sqlCalls('identity.staff_patient_search')[0]?.values ?? [];
      expect(values[5]).toEqual([phoneHmac('+2348030000001'), phoneHmac('+23408030000001')]);
      expect(JSON.stringify(calls)).not.toContain('8030000001"');
      expect(auditEvents()).not.toMatch(/803000|0803/);
    });

    it('a Health ID that no patient has: "No patient has this Health ID." (owner Q100 B)', async () => {
      handlers['identity.staff_patient_search'] = () => ({ rows: [only('no_such_health_id', 'here')] });
      const answer = await search({ healthId: ' hid-qszz99 ' });
      expect([answer.status, answer.body]).toEqual([200, { mode: 'standard', outcome: 'no_such_patient', reach: 'here',
        message: 'No patient has this Health ID.', patients: [] }]);
      expect(sqlCalls('identity.staff_patient_search')[0]?.values[4]).toBe('HID-QSZZ99');
    });

    it('too many matches: no card, ask for the date of birth or phone', async () => {
      handlers['identity.staff_patient_search'] = () => ({ rows: [only('too_many', 'everywhere')] });
      const answer = await search({ firstName: 'Tunde', lastName: 'Bakare', dateOfBirth: '2000-01-01' });
      expect(answer.body).toEqual({ mode: 'standard', outcome: 'too_many', reach: 'everywhere',
        message: 'Too many matches. Add the date of birth or phone.', patients: [] });
    });

    it('too broad: 400 without counting or searching, audited with the key kinds only', async () => {
      const answer = await search({ firstName: 'Amaka', lastName: 'Okafor' });
      expect([answer.status, answer.body.code]).toEqual([400, 'PATIENT_SEARCH_TOO_BROAD']);
      expect(sqlCalls('otp_rate_limits')).toHaveLength(0);
      expect(sqlCalls('staff_patient_search')).toHaveLength(0);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.patient.search', outcome: 'denied',
        details: { mode: 'standard', criteria: ['first_name', 'last_name'], refusal: 'too_broad' } }));
      expect(auditEvents()).not.toMatch(/amaka|okafor/i);
    });

    it.each([
      [{ phone: '12' }, 400, 'VALIDATION_FAILED'],
      [{ phone: 'not a phone number' }, 400, 'PATIENT_SEARCH_PHONE_INVALID'],
      [{ lastName: 'Okafor', dateOfBirth: '1990-02-30' }, 400, 'PATIENT_SEARCH_DATE_INVALID'],
      [{ healthId: 'HID-0000' }, 400, 'VALIDATION_FAILED'],
      [{ hid: 'HID-QSAA22' }, 400, 'VALIDATION_FAILED'],
      [{ lastName: 'x'.repeat(101), dateOfBirth: '1990-05-01' }, 400, 'VALIDATION_FAILED'],
    ])('refuses %j with %s %s and searches nothing', async (body, status, code) => {
      const answer = await search(body);
      expect([answer.status, answer.body.code]).toEqual([status, code]);
      expect(sqlCalls('staff_patient_search')).toHaveLength(0);
    });

    it('needs the direct-care purpose', async () => {
      const answer = await search({ healthId: 'HID-QSAA22' }, 'emergency');
      expect([answer.status, answer.body.code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
    });

    it('lab staff are refused by the guard (no identity.registration.write)', async () => {
      tokens.verify.mockResolvedValue({ actor: lab(), claims: {} });
      const answer = await search({ healthId: 'HID-QSAA22' });
      expect(answer.status).toBe(403);
      expect(sqlCalls('staff_patient_search')).toHaveLength(0);
    });

    it('the 31st search in 10 minutes answers 429, logs the alert and is audited, without searching', async () => {
      handlers['from auth.otp_rate_limits'] = () => ({ rows: [{ request_count: 30, window_started_at: new Date(),
        blocked_until: null }] });
      const answer = await search({ healthId: 'HID-QSAA22' });
      expect([answer.status, answer.body.code, answer.body.detail]).toEqual([429, 'PATIENT_SEARCH_LIMITED',
        PATIENT_SEARCH_MESSAGES.limited]);
      expect(sqlCalls('staff_patient_search')).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: PATIENT_SEARCH_LIMITED_EVENT, limit: 'member',
        mode: 'standard' }));
      expect(JSON.stringify(warn.mock.calls)).not.toContain('HID-');
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.patient.search', outcome: 'denied',
        details: { mode: 'standard', criteria: ['health_id'], refusal: 'limited_member' } }));
    });

    it('the facility\'s 301st search in an hour answers 429 with the facility alert', async () => {
      handlers['from auth.otp_rate_limits'] = (values) => ({ rows: [{
        request_count: values[1] === bucket('patient-search-facility', facilityId) ? 300 : 0,
        window_started_at: new Date(), blocked_until: null }] });
      const answer = await search({ healthId: 'HID-QSAA22' });
      expect([answer.status, answer.body.code]).toEqual([429, 'PATIENT_SEARCH_LIMITED']);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: PATIENT_SEARCH_LIMITED_EVENT, limit: 'facility' }));
    });

    it.each([
      ['42501', 'PATIENT_SEARCH_NOT_PERMITTED', 403, 'PATIENT_SEARCH_NOT_PERMITTED', 'denied'],
      ['22023', 'PATIENT_SEARCH_INVALID', 400, 'PATIENT_SEARCH_INVALID', 'denied'],
      ['XX000', 'internal', 503, 'PATIENT_SEARCH_UNAVAILABLE', 'failure'],
    ])('a database refusal %s %s answers %s %s, audited %s, never with the database text', async (sqlState, message,
      status, code, outcome) => {
      handlers['identity.staff_patient_search'] = () => { throw databaseError(sqlState, message); };
      const answer = await search({ healthId: 'HID-QSAA22' });
      expect([answer.status, answer.body.code]).toEqual([status, code]);
      expect(JSON.stringify(answer.body)).not.toContain('internal');
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.patient.search', outcome }));
    });
  });

  describe('emergency search', () => {
    beforeEach(() => tokens.verify.mockResolvedValue({ actor: doctor(), claims: {} }));
    const body = { firstName: 'Amaka', lastName: 'Okafor', dateOfBirth: '1990-05-01',
      reason: '  Unconscious patient brought in by ambulance ' };

    it('needs the break-glass permission, the emergency purpose and a reason; sends the trimmed reason', async () => {
      handlers['identity.staff_patient_search'] = () => ({ rows: [card(1, 'AA22', false)] });
      const answer = await emergency(body);
      expect([answer.status, answer.body.mode, answer.body.patients.length]).toEqual([200, 'emergency', 1]);
      expect(sqlCalls('from auth.otp_rate_limits').map((call) => call.values[1])).toEqual([
        bucket('patient-emergency-search-member', membershipId)]);
      expect(sqlCalls('identity.staff_patient_search')[0]?.values.slice(0, 7)).toEqual(['emergency', 'amaka', 'okafor',
        '1990-05-01', null, null, 'Unconscious patient brought in by ambulance']);
      expect(contexts.map((context) => context.purposeOfUse)).toEqual(['emergency', 'emergency']);
    });

    it('more than 5 matches: ask for a phone number or the Health ID', async () => {
      handlers['identity.staff_patient_search'] = () => ({ rows: [only('too_many', 'everywhere')] });
      const answer = await emergency(body);
      expect(answer.body.message).toBe('More than 5 people match. Ask for a phone number or the Health ID.');
    });

    it.each([
      [{ ...body, reason: 'Hurry' }, 'VALIDATION_FAILED'],
      [{ ...body, reason: undefined }, 'VALIDATION_FAILED'],
      [{ ...body, healthId: 'HID-QSAA22' }, 'VALIDATION_FAILED'],
      [{ ...body, dateOfBirth: undefined }, 'VALIDATION_FAILED'],
      [{ ...body, dateOfBirth: '2999-01-01' }, 'PATIENT_SEARCH_DATE_INVALID'],
    ])('refuses %j (%s) before any result', async (input, code) => {
      const answer = await emergency(input);
      expect([answer.status, answer.body.code]).toEqual([400, code]);
      expect(sqlCalls('staff_patient_search')).toHaveLength(0);
    });

    it('the front desk is refused by the guard (no identity.break-glass.write)', async () => {
      tokens.verify.mockResolvedValue({ actor: desk(), claims: {} });
      const answer = await emergency(body);
      expect(answer.status).toBe(403);
      expect(sqlCalls('staff_patient_search')).toHaveLength(0);
    });

    it('needs the emergency purpose', async () => {
      const answer = await emergency(body, 'direct-care');
      expect([answer.status, answer.body.code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
    });

    it('the 6th emergency search in an hour answers 429 with the alert', async () => {
      handlers['from auth.otp_rate_limits'] = () => ({ rows: [{ request_count: 5, window_started_at: new Date(),
        blocked_until: null }] });
      const answer = await emergency(body);
      expect([answer.status, answer.body.code]).toEqual([429, 'PATIENT_SEARCH_LIMITED']);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: PATIENT_SEARCH_LIMITED_EVENT, limit: 'member',
        mode: 'emergency' }));
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.patient.emergency-search',
        outcome: 'denied' }));
      expect(auditEvents()).not.toMatch(/amaka|okafor|Unconscious/i);
    });

    it('emergency access switched off on the platform answers 423 BREAK_GLASS_DISABLED', async () => {
      handlers['identity.staff_patient_search'] = () => {
        throw databaseError('55000', 'PLATFORM_CONTROL_DISABLED:break_glass_enabled');
      };
      const answer = await emergency(body);
      expect([answer.status, answer.body.code]).toEqual([423, 'BREAK_GLASS_DISABLED']);
    });
  });

  it('no message says "unverified"', () => {
    expect(JSON.stringify(PATIENT_SEARCH_MESSAGES)).not.toMatch(/unverified/i);
  });
});
