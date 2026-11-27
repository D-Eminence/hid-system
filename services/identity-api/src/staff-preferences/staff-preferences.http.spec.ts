jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { randomUUID } from 'node:crypto';
import { Global, type INestApplication, Module, ServiceUnavailableException, UnauthorizedException,
  ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { databaseError, fakeStaffPreferencesDatabase } from '../../test/staff-preferences.fixtures';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { SecurityGuard } from '../auth/security.guard';
import { TokenService } from '../auth/token.service';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { STAFF_PREFERENCES_STARTUP_SQL } from './staff-preferences';
import { StaffPreferencesModule } from './staff-preferences.module';

// SX-7 (0206): the three routes through the real StaffPreferencesModule (its
// controller, service, start-up check and its own wiring of
// StaffPreferencesOffMiddleware), SecurityGuard, AuditInterceptor and
// main.ts's pipe and filter, over an in-memory stand-in for 0206's functions
// (test/staff-preferences.fixtures.ts; the database suite
// staff-preferences.integration.sql runs the service's statements against the
// real ones). Only DatabaseService and AuditService, which AppModule's global
// modules provide, are stand-ins.

const EHR = 'https://ehr.staging.healthidentitydirectory.com';
const DOCTOR = ['identity.patient.read', 'ehr.vital.read', 'ehr.vital.write', 'ehr.diagnosis.read', 'ehr.diagnosis.write',
  'ehr.note.write', 'ehr.lab-request.write', 'ehr.prescription.write', 'ehr.prescription.read'];
const facility = (name: string, primary: boolean, permissions: string[]): FacilityAssignment => ({
  id: randomUUID(), membershipId: randomUUID(), organizationId: randomUUID(), name, roles: ['doctor'], permissions,
  isPrimary: primary,
});

describe('staff preferences and Home shortcuts over HTTP (SX-7, 0206)', () => {
  const original = { ...process.env };
  let app: INestApplication | undefined;
  let fake: ReturnType<typeof fakeStaffPreferencesDatabase>;
  let audit: { record: jest.Mock };
  let tokens: { verify: jest.Mock; verifyCsrf: jest.Mock };
  const accountId = randomUUID();
  let primary: FacilityAssignment;
  let secondary: FacilityAssignment;
  const sessions = new Map<string, 'staff' | 'patient' | 'outreach' | 'admin'>();

  const actorOf = (sessionId: string): ActorContext => {
    const kind = sessions.get(sessionId)!;
    const base = { id: `staff:${accountId}`, subject: `staff:${accountId}`, accountId, sessionId, platformRoles: [],
      platformPermissions: [], authenticationMethod: 'local' as const };
    if (kind === 'patient') {
      return { ...base, kind: 'patient', patientId: randomUUID(), subject: `patient:${accountId}`, roles: [], permissions: [],
        facilityIds: [], facilities: [] };
    }
    if (kind === 'outreach') return { ...base, roles: [], permissions: [], facilityIds: [], facilities: [], accountOnly: true };
    if (kind === 'admin') {
      return { ...base, roles: [], permissions: [], facilityIds: [], facilities: [], platformRoles: ['platform_admin'],
        platformPermissions: ['platform.admin.access'] };
    }
    return { ...base, kind: 'staff', roles: ['doctor'], permissions: [], facilityIds: [primary.id, secondary.id],
      facilities: [primary, secondary] };
  };
  const signIn = (kind: 'staff' | 'patient' | 'outreach' | 'admin' = 'staff') => {
    const sessionId = randomUUID();
    sessions.set(sessionId, kind);
    return `access-${sessionId}`;
  };

  beforeEach(() => {
    sessions.clear();
    primary = facility('Fictional Alpha General', true, DOCTOR);
    secondary = facility('Fictional Beta Clinic', false, ['identity.patient.read', 'ehr.vital.read']);
    tokens = {
      verify: jest.fn(async (token: string) => {
        const sessionId = token.slice('access-'.length);
        if (!sessions.has(sessionId)) throw new UnauthorizedException('Session is no longer active');
        return { actor: actorOf(sessionId), claims: {} };
      }),
      verifyCsrf: jest.fn(() => false),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  async function boot(enabled: string | undefined, failWith?: () => unknown): Promise<void> {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: EHR, AUTH_MODE: 'local', AUTH_COOKIE_NAME: 'hid_access', AUTH_COOKIE_SECURE: 'false',
      TURNSTILE_MODE: 'disabled', AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
    if (enabled === undefined) delete process.env.STAFF_PREFERENCES_ENABLED;
    else process.env.STAFF_PREFERENCES_ENABLED = enabled;
    resetEnvironmentForTests();
    fake = fakeStaffPreferencesDatabase({ failWith });
    @Global()
    @Module({ providers: [{ provide: DatabaseService, useValue: fake.database }, { provide: AuditService, useValue: audit }],
      exports: [DatabaseService, AuditService] })
    class GlobalStandIns {}
    const module = await Test.createTestingModule({ imports: [GlobalStandIns, StaffPreferencesModule] }).compile();
    app = module.createNestApplication({ logger: false });
    app.use((req: HidRequest, _res: Response, next: NextFunction) => { req.correlationId = 'sx7-http-correlation'; next(); });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    app.useGlobalGuards(new SecurityGuard(module.get(Reflector), tokens as unknown as TokenService,
      audit as unknown as AuditService, fake.database as unknown as DatabaseService));
    app.useGlobalInterceptors(new AuditInterceptor(module.get(Reflector), audit as unknown as AuditService));
    await app.init();
  }

  const http = () => request(app!.getHttpServer());
  const read = (token: string, facilityId?: string) => {
    const call = http().get('/api/v1/identity/me/preferences').set('Authorization', `Bearer ${token}`);
    return facilityId ? call.set('X-Facility-ID', facilityId) : call;
  };
  let keys = 0;
  const nextKey = () => `sx7-http-key-${String(++keys).padStart(8, '0')}`;
  const savePreferences = (token: string, body: unknown, options: { facilityId?: string; key?: string | null } = {}) => {
    let call = http().post('/api/v1/identity/me/preferences').set('Authorization', `Bearer ${token}`).set('Origin', EHR);
    if (options.facilityId) call = call.set('X-Facility-ID', options.facilityId);
    if (options.key !== null) call = call.set('Idempotency-Key', options.key ?? nextKey());
    return call.send(body as object);
  };
  const saveShortcuts = (token: string, body: unknown, options: { facilityId?: string | null; key?: string | null } = {}) => {
    let call = http().post('/api/v1/identity/me/shortcuts').set('Authorization', `Bearer ${token}`).set('Origin', EHR);
    const facilityId = options.facilityId === undefined ? primary.id : options.facilityId;
    if (facilityId) call = call.set('X-Facility-ID', facilityId);
    if (options.key !== null) call = call.set('Idempotency-Key', options.key ?? nextKey());
    return call.send(body as object);
  };
  const items = (...modules: string[]) => modules.map((module) => ({ module }));
  const sessionOf = (token: string) => token.slice('access-'.length);
  const recorded = () => audit.record.mock.calls.map(([event]) => ({ action: event.action, outcome: event.outcome,
    resourceType: event.resourceType, resourceId: event.resourceId ?? null, facilityId: event.facilityId ?? null,
    actorMembershipId: event.actorMembershipId ?? null, organizationId: event.organizationId ?? null,
    purposeOfUse: event.purposeOfUse ?? null, code: event.details?.code }));

  describe.each([['unset', undefined], ['false', 'false']] as const)('STAFF_PREFERENCES_ENABLED %s', (_label, value) => {
    beforeEach(async () => { await boot(value); });

    it('every route answers a plain 404 before any guard, signed in or not', async () => {
      const token = signIn();
      for (const response of [
        await read(token), await read(token, primary.id),
        await savePreferences(token, { language: 'en', expectedVersion: 0 }),
        await saveShortcuts(token, { items: items('patients'), expectedVersion: 0 }),
        await http().get('/api/v1/identity/me/preferences'),
        await http().post('/api/v1/identity/me/shortcuts').send({}),
      ]) {
        expect(response.status).toBe(404);
      }
      expect(tokens.verify).not.toHaveBeenCalled();
      expect(fake.database.withStaffAccountTransaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      // The start-up check reads nothing while the setting is off.
      expect(fake.database.query).not.toHaveBeenCalledWith(STAFF_PREFERENCES_STARTUP_SQL);
    });
  });

  describe('STAFF_PREFERENCES_ENABLED=true', () => {
    beforeEach(async () => { await boot('true'); });

    it('the real module\'s start-up check asked for 0206\'s functions before the routes opened', () => {
      expect(fake.database.query).toHaveBeenCalledWith(STAFF_PREFERENCES_STARTUP_SQL);
    });

    it('GET with no X-Facility-ID: the defaults, the contract\'s shape, shortcuts null, one auth.* row on session', async () => {
      const token = signIn();
      const response = await read(token);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ version: 0, language: 'en', languagesAvailable: ['en'],
        notices: { served: false, labResultReady: true, prescriptionDispensed: true, criticalResult: true,
          criticalResultCanChange: false }, shortcuts: null });
      expect(fake.contexts[0]).toMatchObject({ correlationId: 'sx7-http-correlation' });
      expect(fake.contexts[0]).not.toHaveProperty('facilityId');
      expect(recorded()).toEqual([{ action: 'auth.staff-preferences.read', outcome: 'success', resourceType: 'session',
        resourceId: sessionOf(token), facilityId: null, actorMembershipId: null, organizationId: null, purposeOfUse: null,
        code: undefined }]);
    });

    it('GET at a facility: that membership\'s shortcuts, recorded at that facility with its membership and organization', async () => {
      const token = signIn();
      const response = await read(token, secondary.id);
      expect(response.status).toBe(200);
      expect(response.body.shortcuts).toEqual({ facilityId: secondary.id, version: 0, max: 12, items: [] });
      expect(fake.contexts[0]).toMatchObject({ facilityId: secondary.id, membershipId: secondary.membershipId });
      expect(recorded()).toEqual([{ action: 'auth.staff-preferences.read', outcome: 'success', resourceType: 'session',
        resourceId: sessionOf(token), facilityId: secondary.id, actorMembershipId: secondary.membershipId,
        organizationId: secondary.organizationId, purposeOfUse: null, code: undefined }]);
    });

    it('GET for a platform administrator with no membership answers and is recorded with no facility', async () => {
      const response = await read(signIn('admin'));
      expect(response.status).toBe(200);
      expect(response.body.shortcuts).toBeNull();
      expect(recorded()).toEqual([expect.objectContaining({ outcome: 'success', facilityId: null })]);
    });

    it('GET with a facility the caller is not at: 403 FACILITY_ACCESS_DENIED, recorded as denied', async () => {
      const token = signIn();
      const response = await read(token, randomUUID());
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FACILITY_ACCESS_DENIED');
      expect(fake.database.withStaffAccountTransaction).not.toHaveBeenCalled();
      expect(recorded()).toEqual([{ action: 'auth.staff-preferences.read', outcome: 'denied', resourceType: 'session',
        resourceId: sessionOf(token), facilityId: null, actorMembershipId: null, organizationId: null, purposeOfUse: null,
        code: 'FACILITY_ACCESS_DENIED' }]);
    });

    it('POST preferences with a facility the caller is not at: 403 FACILITY_ACCESS_DENIED, nothing saved, recorded as denied on the account', async () => {
      const response = await savePreferences(signIn(), { language: 'en', expectedVersion: 0 }, { facilityId: randomUUID() });
      expect([response.status, response.body.code]).toEqual([403, 'FACILITY_ACCESS_DENIED']);
      expect(fake.database.withStaffAccountTransaction).not.toHaveBeenCalled();
      expect(fake.state().preferences.size).toBe(0);
      expect(recorded()).toEqual([{ action: 'auth.staff-preferences.update', outcome: 'denied', resourceType: 'session',
        resourceId: accountId, facilityId: null, actorMembershipId: null, organizationId: null, purposeOfUse: null,
        code: 'FACILITY_ACCESS_DENIED' }]);
    });

    it('a refused preferences save at a resolved facility is recorded on the account, with that membership and organization', async () => {
      const response = await savePreferences(signIn(), { language: 'en', expectedVersion: 3 }, { facilityId: primary.id });
      expect([response.status, response.body.code]).toEqual([412, 'VERSION_CONFLICT']);
      expect(recorded()).toEqual([{ action: 'auth.staff-preferences.update', outcome: 'failure', resourceType: 'session',
        resourceId: accountId, facilityId: primary.id, actorMembershipId: primary.membershipId,
        organizationId: primary.organizationId, purposeOfUse: null, code: 'VERSION_CONFLICT' }]);
    });

    it('Identity\'s preferences rows hold no purpose of use, even when one is sent; the shortcuts failure row carries one only when sent', async () => {
      const token = signIn();
      await http().get('/api/v1/identity/me/preferences').set('Authorization', `Bearer ${token}`)
        .set('X-Facility-ID', primary.id).set('X-Purpose-Of-Use', 'treatment');
      await savePreferences(token, { language: 'en', expectedVersion: 7 }).set('X-Purpose-Of-Use', 'treatment');
      await saveShortcuts(token, { items: items('pharmacy'), expectedVersion: 0 });
      await saveShortcuts(token, { items: items('pharmacy'), expectedVersion: 0 }).set('X-Purpose-Of-Use', 'treatment');
      expect(recorded().map((row) => `${row.action} ${row.outcome} ${row.purposeOfUse}`)).toEqual([
        'auth.staff-preferences.read success null', 'auth.staff-preferences.update failure null',
        'api.identity.staff-shortcuts.update failure null', 'api.identity.staff-shortcuts.update failure treatment']);
      expect(fake.state().audit).toHaveLength(0);
    });

    it('refuses a patient (PATIENT_SCOPE_DENIED) and an account-only session (NO_ACTIVE_FACILITY_MEMBERSHIP) at the guard', async () => {
      const patient = signIn('patient');
      const outreach = signIn('outreach');
      for (const [token, code] of [[patient, 'PATIENT_SCOPE_DENIED'], [outreach, 'NO_ACTIVE_FACILITY_MEMBERSHIP']] as const) {
        for (const response of [await read(token), await savePreferences(token, { language: 'en', expectedVersion: 0 }),
          await saveShortcuts(token, { items: [], expectedVersion: 0 })]) {
          expect([response.status, response.body.code]).toEqual([403, code]);
        }
      }
      expect(fake.database.withStaffAccountTransaction).not.toHaveBeenCalled();
    });

    it('POST preferences: the first save with version 0, a replay, key reuse (409) and a stale version (412)', async () => {
      const token = signIn();
      const first = await savePreferences(token, { language: 'en', expectedVersion: 0 }, { key: 'sx7-http-replayed-0001' });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ version: 1, language: 'en', languagesAvailable: ['en'],
        notices: expect.objectContaining({ served: false }), shortcuts: null, replayed: false });
      const again = await savePreferences(token, { language: 'en', expectedVersion: 0 }, { key: 'sx7-http-replayed-0001' });
      expect([again.status, again.body.version, again.body.replayed]).toEqual([200, 1, true]);
      const reused = await savePreferences(token, { language: 'en', expectedVersion: 1 }, { key: 'sx7-http-replayed-0001' });
      expect([reused.status, reused.body.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
      const stale = await savePreferences(token, { language: 'en', expectedVersion: 0 });
      expect([stale.status, stale.body.code]).toEqual([412, 'VERSION_CONFLICT']);
      expect(fake.state().audit.map((row) => row.action)).toEqual(['auth.staff-preferences.update', 'auth.staff-preferences.update']);
      expect(recorded()).toEqual([
        expect.objectContaining({ action: 'auth.staff-preferences.update', outcome: 'failure', resourceType: 'session',
          code: 'IDEMPOTENCY_KEY_REUSED' }),
        expect.objectContaining({ action: 'auth.staff-preferences.update', outcome: 'failure', code: 'VERSION_CONFLICT' }),
      ]);
    });

    it('POST preferences with X-Facility-ID answers that facility\'s shortcuts too', async () => {
      const response = await savePreferences(signIn(), { language: 'en', expectedVersion: 0 }, { facilityId: primary.id });
      expect(response.status).toBe(200);
      expect(response.body.shortcuts).toEqual({ facilityId: primary.id, version: 0, max: 12, items: [] });
    });

    it('a platform administrator with no facility saves their own language', async () => {
      const response = await savePreferences(signIn('admin'), { language: 'en', expectedVersion: 0 });
      expect([response.status, response.body.version]).toEqual([200, 1]);
    });

    it.each([
      ['notices', { language: 'en', expectedVersion: 0, notices: { labResultReady: false } }],
      ['criticalResult', { language: 'en', expectedVersion: 0, criticalResult: false }],
      ['an unknown key', { language: 'en', expectedVersion: 0, theme: 'dark' }],
      ['no expectedVersion', { language: 'en' }],
      ['a negative expectedVersion', { language: 'en', expectedVersion: -1 }],
      ['a fractional expectedVersion', { language: 'en', expectedVersion: 1.5 }],
      ['a string expectedVersion', { language: 'en', expectedVersion: '0' }],
      ['no language', { expectedVersion: 0 }],
    ])('POST preferences with %s is 400 VALIDATION_FAILED', async (_label, body) => {
      const response = await savePreferences(signIn(), body);
      expect([response.status, response.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      expect(fake.database.withStaffAccountTransaction).not.toHaveBeenCalled();
    });

    it.each(['fr', 'EN', 'yo', ''])('POST preferences with language %j is 400 LANGUAGE_NOT_AVAILABLE', async (language) => {
      const response = await savePreferences(signIn(), { language, expectedVersion: 0 });
      expect([response.status, response.body.code]).toEqual([400, 'LANGUAGE_NOT_AVAILABLE']);
      expect(response.body.detail).toBe('Only English is available for now.');
      expect(fake.database.withStaffAccountTransaction).not.toHaveBeenCalled();
    });

    it.each([['missing', null], ['too short', 'short'], ['with a space', 'sx7 http key 000001']])(
      'an Idempotency-Key %s is 400 IDEMPOTENCY_KEY_REQUIRED on both saves', async (_label, key) => {
        const token = signIn();
        const preferences = await savePreferences(token, { language: 'en', expectedVersion: 0 }, { key });
        const shortcuts = await saveShortcuts(token, { items: items('patients'), expectedVersion: 0 }, { key });
        expect([preferences.status, preferences.body.code, shortcuts.status, shortcuts.body.code])
          .toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED', 400, 'IDEMPOTENCY_KEY_REQUIRED']);
        expect(fake.database.withStaffAccountTransaction).not.toHaveBeenCalled();
      });

    it('POST shortcuts: saved in order at the X-Facility-ID membership, then read back there and not elsewhere', async () => {
      const token = signIn();
      const saved = await saveShortcuts(token, { items: items('triage', 'patients', 'consultation'), expectedVersion: 0 });
      expect(saved.status).toBe(200);
      expect(saved.body).toEqual({ version: 0, language: 'en', languagesAvailable: ['en'],
        notices: expect.objectContaining({ served: false }), replayed: false,
        shortcuts: { facilityId: primary.id, version: 1, max: 12, items: [{ module: 'triage', available: true },
          { module: 'patients', available: true }, { module: 'consultation', available: true }] } });
      expect(fake.state().shortcuts.get(primary.membershipId)?.modules).toEqual(['triage', 'patients', 'consultation']);
      expect((await read(token, primary.id)).body.shortcuts.items.map((item: { module: string }) => item.module))
        .toEqual(['triage', 'patients', 'consultation']);
      expect((await read(token, secondary.id)).body.shortcuts).toEqual({ facilityId: secondary.id, version: 0, max: 12, items: [] });
      expect(fake.state().audit).toEqual([{ action: 'identity.staff-shortcuts.update', accountId,
        membershipId: primary.membershipId, facilityId: primary.id,
        details: { modules: ['triage', 'patients', 'consultation'], version: 1 } }]);
    });

    it('POST shortcuts with 0 and 12 items', async () => {
      const token = signIn();
      const twelve = ['patients', 'registration', 'accessRequests', 'emergencyAccess', 'triage', 'consultation', 'orders',
        'lab', 'labResults', 'pharmacy', 'prescriptions', 'migrate'];
      primary = { ...primary, permissions: [...primary.permissions, 'identity.registration.write', 'identity.consent.write',
        'identity.break-glass.write', 'lab.result.enter', 'lab.result.released.read', 'pharmacy.dispensing.create',
        'ocr.job.read', 'ocr.publication.write'] };
      const full = await saveShortcuts(token, { items: items(...twelve), expectedVersion: 0 });
      expect([full.status, full.body.shortcuts.items.length]).toEqual([200, 12]);
      const none = await saveShortcuts(token, { items: [], expectedVersion: 1 });
      expect([none.status, none.body.shortcuts.items]).toEqual([200, []]);
    });

    it.each([
      ['13 items', ['patients', 'registration', 'accessRequests', 'emergencyAccess', 'triage', 'consultation', 'orders',
        'lab', 'labResults', 'pharmacy', 'prescriptions', 'migrate', 'outreach'], 'SHORTCUTS_TOO_MANY'],
      ['a key SX-1 does not know', ['patients', 'find-patient'], 'SHORTCUT_UNKNOWN'],
      ['a UUID', [randomUUID()], 'SHORTCUT_UNKNOWN'],
      ['a Health ID', ['HID-QPA2B3C4'], 'SHORTCUT_UNKNOWN'],
      ['a matchRef', [`psr_${'A'.repeat(43)}`], 'SHORTCUT_UNKNOWN'],
      ['a repeat', ['patients', 'triage', 'patients'], 'SHORTCUT_DUPLICATE'],
      ['a page the roles here do not show', ['patients', 'pharmacy'], 'SHORTCUT_NOT_ALLOWED'],
    ])('POST shortcuts with %s is 400 with its own code, nothing saved, the refusal recorded by the interceptor', async (_label, modules, code) => {
      const response = await saveShortcuts(signIn(), { items: items(...modules), expectedVersion: 0 });
      expect([response.status, response.body.code]).toEqual([400, code]);
      expect(fake.state().shortcuts.size).toBe(0);
      expect(recorded()).toEqual([{ action: 'api.identity.staff-shortcuts.update', outcome: 'failure',
        resourceType: 'http-request', resourceId: null, facilityId: primary.id, actorMembershipId: primary.membershipId,
        organizationId: primary.organizationId, purposeOfUse: null, code: undefined }]);
    });

    it.each([
      ['an item with a patientId', { items: [{ module: 'patients', patientId: randomUUID() }], expectedVersion: 0 }],
      ['an item that is a bare string', { items: ['patients'], expectedVersion: 0 }],
      ['a numeric module', { items: [{ module: 7 }], expectedVersion: 0 }],
      ['no items', { expectedVersion: 0 }],
      ['a hid field', { items: [], expectedVersion: 0, hid: 'HID-QPA2B3C4' }],
      ['no expectedVersion', { items: [] }],
      ['a negative expectedVersion', { items: [], expectedVersion: -1 }],
      ['a fractional expectedVersion', { items: [], expectedVersion: 1.5 }],
      ['a string expectedVersion', { items: [], expectedVersion: '0' }],
      ['an expectedVersion past the largest safe integer', { items: [], expectedVersion: Number.MAX_SAFE_INTEGER + 2 }],
    ])('POST shortcuts with %s is 400 VALIDATION_FAILED', async (_label, body) => {
      const response = await saveShortcuts(signIn(), body);
      expect([response.status, response.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      expect(fake.database.withStaffAccountTransaction).not.toHaveBeenCalled();
    });

    it('POST shortcuts needs the X-Facility-ID facility: FACILITY_REQUIRED, FACILITY_ACCESS_DENIED, and none for an administrator', async () => {
      const token = signIn();
      const missing = await saveShortcuts(token, { items: [], expectedVersion: 0 }, { facilityId: null });
      const elsewhere = await saveShortcuts(token, { items: [], expectedVersion: 0 }, { facilityId: randomUUID() });
      const admin = await saveShortcuts(signIn('admin'), { items: [], expectedVersion: 0 }, { facilityId: null });
      expect([missing.status, missing.body.code, elsewhere.status, elsewhere.body.code, admin.status, admin.body.code])
        .toEqual([400, 'FACILITY_REQUIRED', 403, 'FACILITY_ACCESS_DENIED', 400, 'FACILITY_REQUIRED']);
      expect(fake.database.withStaffAccountTransaction).not.toHaveBeenCalled();
    });

    it('a saved shortcut the roles no longer show is kept: answered unavailable, and may be sent again', async () => {
      const token = signIn();
      await saveShortcuts(token, { items: items('triage', 'patients'), expectedVersion: 0 });
      // SX-4 removes the role that showed triage; the session is resolved again on the next request.
      primary = { ...primary, permissions: ['identity.patient.read'] };
      const after = await read(token, primary.id);
      expect(after.body.shortcuts.items).toEqual([{ module: 'triage', available: false }, { module: 'patients', available: true }]);
      const kept = await saveShortcuts(token, { items: items('patients', 'triage'), expectedVersion: 1 });
      expect([kept.status, kept.body.shortcuts.items]).toEqual([200,
        [{ module: 'patients', available: true }, { module: 'triage', available: false }]]);
      const added = await saveShortcuts(token, { items: items('patients', 'triage', 'consultation'), expectedVersion: 2 });
      expect([added.status, added.body.code]).toEqual([400, 'SHORTCUT_NOT_ALLOWED']);
    });

    it('a saved key this image does not know (a newer image\'s, or retired) is kept when sent back; one not saved is SHORTCUT_UNKNOWN', async () => {
      const token = signIn();
      fake.state().shortcuts.set(primary.membershipId, { facilityId: primary.id, modules: ['retiredDepartment', 'patients'],
        version: 4, key: 'sx7-http-older-image-01', sha: 'a'.repeat(64) });
      const after = await read(token, primary.id);
      expect(after.body.shortcuts.items).toEqual([{ module: 'retiredDepartment', available: false },
        { module: 'patients', available: true }]);
      const kept = await saveShortcuts(token, { items: items('patients', 'retiredDepartment', 'triage'), expectedVersion: 4 });
      expect([kept.status, kept.body.shortcuts]).toEqual([200, { facilityId: primary.id, version: 5, max: 12, items: [
        { module: 'patients', available: true }, { module: 'retiredDepartment', available: false },
        { module: 'triage', available: true }] }]);
      expect(fake.state().shortcuts.get(primary.membershipId)?.modules).toEqual(['patients', 'retiredDepartment', 'triage']);
      // Not saved for this membership (the other one's, or dropped by the save above): refused, nothing changed.
      const elsewhere = await saveShortcuts(token, { items: items('retiredDepartment'), expectedVersion: 0 },
        { facilityId: secondary.id });
      expect([elsewhere.status, elsewhere.body.code]).toEqual([400, 'SHORTCUT_UNKNOWN']);
      const dropped = await saveShortcuts(token, { items: items('patients'), expectedVersion: 5 });
      expect(dropped.status).toBe(200);
      const again = await saveShortcuts(token, { items: items('patients', 'retiredDepartment'), expectedVersion: 6 });
      expect([again.status, again.body.code]).toEqual([400, 'SHORTCUT_UNKNOWN']);
      expect(fake.state().shortcuts.get(primary.membershipId)?.modules).toEqual(['patients']);
      expect(fake.state().shortcuts.has(secondary.membershipId)).toBe(false);
    });

    it('POST shortcuts: a replay, key reuse and a stale version', async () => {
      const token = signIn();
      const body = { items: items('patients'), expectedVersion: 0 };
      expect((await saveShortcuts(token, body, { key: 'sx7-http-shortcut-0001' })).body.replayed).toBe(false);
      const again = await saveShortcuts(token, body, { key: 'sx7-http-shortcut-0001' });
      expect([again.status, again.body.replayed, again.body.shortcuts.version]).toEqual([200, true, 1]);
      const reused = await saveShortcuts(token, { items: items('triage'), expectedVersion: 1 }, { key: 'sx7-http-shortcut-0001' });
      expect([reused.status, reused.body.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
      const stale = await saveShortcuts(token, { items: items('triage'), expectedVersion: 0 });
      expect([stale.status, stale.body.code]).toEqual([412, 'VERSION_CONFLICT']);
      // The same key at another facility is that membership's own first save (the digest is scoped by facility).
      const other = await saveShortcuts(token, body, { key: 'sx7-http-shortcut-0001', facilityId: secondary.id });
      expect([other.status, other.body.replayed, other.body.shortcuts.facilityId]).toEqual([200, false, secondary.id]);
    });
  });

  describe('STAFF_PREFERENCES_ENABLED=true with the database failing', () => {
    it('answers 503 PREFERENCES_UNAVAILABLE with the generic detail and no diagnostic, and records the failure', async () => {
      await boot('true', () => databaseError('42883', 'function identity.read_my_staff_preferences() does not exist'));
      const token = signIn();
      for (const response of [await read(token), await savePreferences(token, { language: 'en', expectedVersion: 0 }),
        await saveShortcuts(token, { items: items('patients'), expectedVersion: 0 })]) {
        expect([response.status, response.body.code]).toEqual([503, 'PREFERENCES_UNAVAILABLE']);
        // Every 5xx carries the filter's generic detail; the website words its own message.
        expect(response.body.detail).toBe('The service could not complete the request.');
        expect(JSON.stringify(response.body)).not.toMatch(/identity\.|function|42883|Your settings/);
      }
      expect(recorded().map((row) => `${row.action} ${row.outcome}`)).toEqual([
        'auth.staff-preferences.read failure', 'auth.staff-preferences.update failure', 'api.identity.staff-shortcuts.update failure']);
    });

    it('answers 503 DEPENDENCY_UNAVAILABLE when the audit row cannot be written either (the database unreachable)', async () => {
      await boot('true', () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      audit.record.mockRejectedValue(new ServiceUnavailableException('Audit persistence is unavailable; request was denied'));
      const token = signIn();
      for (const response of [await read(token), await savePreferences(token, { language: 'en', expectedVersion: 0 }),
        await saveShortcuts(token, { items: items('patients'), expectedVersion: 0 })]) {
        expect([response.status, response.body.code, response.body.detail])
          .toEqual([503, 'DEPENDENCY_UNAVAILABLE', 'The service could not complete the request.']);
      }
    });
  });
});
