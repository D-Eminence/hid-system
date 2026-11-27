jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { randomUUID } from 'node:crypto';
import { Global, Logger, Module, UnauthorizedException, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { AuditService } from '../audit/audit.service';
import { AuthSessionAuditService } from '../auth/auth-session-audit.service';
import { LocalAuthProvider } from '../auth/local-auth.provider';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { SecurityGuard } from '../auth/security.guard';
import { type SessionRenewal, TokenService } from '../auth/token.service';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import {
  CHANGE_OWN_DISPLAY_NAME_SQL, CHANGE_OWN_PASSWORD_SQL, CLEAR_LOGIN_ATTEMPTS_SQL, OWN_PASSWORD_ACCOUNT_SQL,
  OWN_PASSWORD_REPLAY_SQL, OWN_PROFILE_STARTUP_SQL, OWN_PROFILE_VERSION_SQL,
} from './staff-profile-changes';
import { StaffProfileChangesService } from './staff-profile-changes.service';
import { STAFF_PROFILE_SQL } from './staff-profile.service';
import { StaffProfileModule } from './staff-profile.module';

// SX-6 (0205): POST /identity/me/password and POST /identity/me/staff-profile as served: the real
// StaffProfileModule (its two off-middlewares, its start-up check, both controllers, StaffProfileChangesService and
// SX-5's read), the real SecurityGuard, and main.ts's validation pipe and problem filter. The database, the token
// service's verify and renewal, the password check, the audit store and the email client are stand-ins; 0205
// itself is own-password-and-name.integration.sql. Every password here is fictional.

const EHR = 'https://ehr.staging.healthidentitydirectory.com';
const CURRENT = 'fictional current passphrase';
const NEW = 'fictional new passphrase';
const STORED = '$argon2id$v=19$m=65536,t=3,p=1$c3RvcmVk$c3RvcmVkLWZpY3Rpb25hbC1oYXNo';
const KEY = 'own-change-key-000001';
const ACCOUNT = randomUUID();
const facility: FacilityAssignment = { id: randomUUID(), membershipId: randomUUID(), organizationId: randomUUID(),
  name: 'Fictional Alpha General', roles: ['doctor'], permissions: ['ehr.encounter.read'], isPrimary: true };

describe('own password and name (SX-6, 0205) as served', () => {
  const original = { ...process.env };
  let app: INestApplication | undefined;
  let logs: jest.SpyInstance[];
  let state: { displayName: string; version: number; hash: string | null; locked: boolean; replay?: boolean;
    passwordError?: Error; nameError?: Error; nameReplayed?: boolean };
  const sessions = new Map<string, { kind: 'staff' | 'patient'; live: boolean }>();
  let audit: { record: jest.Mock; recordWithClient: jest.Mock };
  let tokens: { verify: jest.Mock; verifyCsrf: jest.Mock; renewSignIn: jest.Mock };
  let local: { isLockedOut: jest.Mock; verifyStoredPassword: jest.Mock; lockoutKey: jest.Mock };
  let sessionAudit: { record: jest.Mock; recordLoginFailure: jest.Mock };
  let notification: { deliverPasswordUpdated: jest.Mock };
  let database: { query: jest.Mock; withTransaction: jest.Mock };
  let client: { query: jest.Mock };

  const actorOf = (sessionId: string): ActorContext => sessions.get(sessionId)?.kind === 'patient'
    ? { kind: 'patient', patientId: randomUUID(), id: `patient:${ACCOUNT}`, subject: `patient:${ACCOUNT}`,
      accountId: ACCOUNT, sessionId, roles: [], permissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local' }
    : { kind: 'staff', id: `staff:${ACCOUNT}`, subject: `staff:${ACCOUNT}`, accountId: ACCOUNT, sessionId,
      email: 'ada@example.test', displayName: state.displayName, roles: facility.roles, permissions: facility.permissions,
      facilityIds: [facility.id], facilities: [facility], authenticationMethod: 'local', products: ['ehr'] };
  const signIn = (kind: 'staff' | 'patient' = 'staff') => {
    const sessionId = randomUUID();
    sessions.set(sessionId, { kind, live: true });
    return sessionId;
  };

  beforeEach(() => {
    sessions.clear();
    state = { displayName: 'Ada Fictional', version: 1, hash: STORED, locked: false };
    audit = { record: jest.fn().mockResolvedValue(undefined), recordWithClient: jest.fn().mockResolvedValue(undefined) };
    tokens = {
      verify: jest.fn(async (token: string) => {
        const sessionId = token.slice('access-'.length);
        if (!sessions.get(sessionId)?.live) throw new UnauthorizedException('Session is no longer active');
        return { actor: actorOf(sessionId), claims: { jti: `jti-${sessionId}`, product: 'ehr', csrf_hash: 'h' } };
      }),
      verifyCsrf: jest.fn((_claims: unknown, cookie?: string, header?: string) => cookie === 'csrf-ok' && header === 'csrf-ok'),
      renewSignIn: jest.fn(async (_presented: unknown, commit: (renewal: SessionRenewal) => Promise<{ tokenVersion: number;
        refreshExpiresAt: Date }>) => {
        const renewal = { sessionId: randomUUID(), accessJti: randomUUID(), refreshTokenSha256: 'ab'.repeat(32),
          refreshExpiresAt: new Date(Date.now() + 28_800_000) };
        const renewed = await commit(renewal);
        return { actor: actorOf(renewal.sessionId), accessToken: `renewed-access-v${renewed.tokenVersion}`,
          refreshToken: 'renewed-refresh', csrfToken: 'renewed-csrf', expiresAt: new Date(Date.now() + 900_000),
          refreshExpiresAt: renewed.refreshExpiresAt };
      }),
    };
    local = {
      isLockedOut: jest.fn(async () => state.locked),
      verifyStoredPassword: jest.fn(async (password: string, hash: string | null) => hash === STORED && password === CURRENT),
      lockoutKey: jest.fn(() => ({ principalHmac: 'c'.repeat(64), pepperVersion: 1 })),
    };
    sessionAudit = { record: jest.fn(), recordLoginFailure: jest.fn().mockResolvedValue(undefined) };
    notification = { deliverPasswordUpdated: jest.fn().mockResolvedValue({ outcome: 'accepted' }) };
    const profileRow = () => ({ account_id: ACCOUNT, display_name: state.displayName, email: 'ada@example.test',
      password_changed_at: null, has_password: state.hash !== null, account_created_at: '2026-01-05T08:00:00Z',
      full_name: 'Ada Registered Fictional', licence_number: null });
    client = {
      query: jest.fn(async (text: string, values: unknown[] = []) => {
        if (text === OWN_PASSWORD_REPLAY_SQL) {
          return { rows: state.replay ? [{ change_id: randomUUID(), token_version: null,
            password_changed_at: '2026-11-26T09:00:00.000Z', other_sign_ins_ended: 1, session_id: randomUUID(),
            session_expires_at: null, replayed: true }] : [] };
        }
        if (text === CHANGE_OWN_PASSWORD_SQL) {
          if (state.passwordError) throw state.passwordError;
          return { rows: [{ change_id: randomUUID(), token_version: '5', password_changed_at: '2026-11-26T09:00:00.000Z',
            other_sign_ins_ended: 2, session_id: values[5], session_expires_at: values[8], replayed: false }] };
        }
        if (text === CLEAR_LOGIN_ATTEMPTS_SQL) return { rows: [] };
        if (text === CHANGE_OWN_DISPLAY_NAME_SQL) {
          if (state.nameError) throw state.nameError;
          if (!state.nameReplayed) { state.displayName = String(values[0]); state.version += 1; }
          return { rows: [{ profile_version: String(state.version), display_name: state.displayName,
            replayed: state.nameReplayed === true }] };
        }
        if (text === STAFF_PROFILE_SQL) return { rows: [profileRow()] };
        if (text === OWN_PROFILE_VERSION_SQL) return { rows: [{ profile_version: String(state.version) }] };
        throw new Error(`unexpected transaction query: ${text.slice(0, 40)}`);
      }),
    };
    database = {
      query: jest.fn(async (text: string, values: unknown[] = []) => {
        if (text.startsWith('select platform.control_enabled')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }] };
        if (text === OWN_PROFILE_STARTUP_SQL) {
          return { rows: [{ can_change_password: true, can_change_name: true, can_read_version: true }] };
        }
        if (text === OWN_PASSWORD_ACCOUNT_SQL) {
          return { rows: [{ email: 'ada@example.test', display_name: state.displayName, password_hash: state.hash,
            password_algorithm: state.hash ? 'argon2id' : null }] };
        }
        if (text === STAFF_PROFILE_SQL) return { rows: [profileRow()] };
        throw new Error(`unexpected query: ${text.slice(0, 40)}`);
      }),
      withTransaction: jest.fn(async (_context: unknown, work: (c: typeof client) => Promise<unknown>) => work(client)),
    };
    // Every log method Nest or the code could write through, so "no password anywhere" covers any log.
    logs = [
      ...(['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const).map((method) =>
        jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined)),
      ...(['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const).map((method) =>
        jest.spyOn(Logger, method).mockImplementation(() => undefined)),
      ...(['log', 'info', 'error', 'warn', 'debug', 'trace'] as const).map((method) =>
        jest.spyOn(console, method).mockImplementation(() => undefined)),
    ];
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const spy of logs) spy.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  async function boot(settings: Record<string, string> = {}): Promise<void> {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: EHR, AUTH_MODE: 'local', AUTH_COOKIE_NAME: 'hid_access', AUTH_COOKIE_SECURE: 'false',
      TURNSTILE_MODE: 'disabled', AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
    delete process.env.STAFF_PASSWORD_CHANGE_ENABLED;
    delete process.env.STAFF_NAME_CHANGE_ENABLED;
    Object.assign(process.env, settings);
    resetEnvironmentForTests();
    @Global()
    @Module({
      providers: [
        { provide: DatabaseService, useValue: database }, { provide: AuditService, useValue: audit },
        { provide: TokenService, useValue: tokens }, { provide: LocalAuthProvider, useValue: local },
        { provide: AuthSessionAuditService, useValue: sessionAudit }, { provide: NotificationOtpClient, useValue: notification },
      ],
      exports: [DatabaseService, AuditService, TokenService, LocalAuthProvider, AuthSessionAuditService, NotificationOtpClient],
    })
    class StandIns {}
    const module = await Test.createTestingModule({ imports: [StandIns, StaffProfileModule] }).compile();
    app = module.createNestApplication({ logger: false });
    app.use(cookieParser());
    app.use((req: HidRequest, _res: Response, next: NextFunction) => { req.correlationId = randomUUID(); next(); });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    app.useGlobalGuards(new SecurityGuard(module.get(Reflector), tokens as unknown as TokenService,
      audit as unknown as AuditService, database as unknown as DatabaseService));
    await app.init();
  }

  const http = () => request(app!.getHttpServer());
  /** A cookie POST from the website: the access cookie, Origin, and the CSRF cookie and header. */
  const cookiePost = (path: string, sessionId: string, body: object, key: string | null = KEY) => {
    const call = http().post(`/api/v1/identity/me/${path}`).set('Origin', EHR)
      .set('Cookie', [`hid_access=access-${sessionId}`, 'hid_access_csrf=csrf-ok']).set('X-CSRF-Token', 'csrf-ok');
    return (key ? call.set('Idempotency-Key', key) : call).send(body);
  };
  const changePassword = (sessionId: string, body: object = { currentPassword: CURRENT, newPassword: NEW },
    key: string | null = KEY) => cookiePost('password', sessionId, body, key);
  const changeName = (sessionId: string, body: object, key: string | null = KEY) => cookiePost('staff-profile', sessionId, body, key);
  const rows = () => audit.record.mock.calls.map(([event]) => event as Record<string, unknown>);
  /** Nothing that was recorded, logged (by any Logger or console method) or sent to the database holds a password. */
  const noPasswordAnywhere = () => {
    const seen = JSON.stringify([audit.record.mock.calls, sessionAudit.recordLoginFailure.mock.calls,
      logs.map((spy) => spy.mock.calls), database.query.mock.calls, client.query.mock.calls,
      notification.deliverPasswordUpdated.mock.calls], (_key, value: unknown) =>
      value instanceof Error ? `${value.name}: ${value.message} ${value.stack ?? ''}` : value);
    expect(seen).not.toContain(CURRENT);
    expect(seen).not.toContain(NEW);
    expect(seen).not.toContain('wrong fictional pass');
  };

  describe('both settings off (the default): as today', () => {
    beforeEach(async () => { await boot(); });

    it('both POST routes answer a plain 404 before any guard; GET staff-profile is unchanged', async () => {
      const sessionId = signIn();
      expect((await changePassword(sessionId)).status).toBe(404);
      expect((await changeName(sessionId, { name: 'Ada Bello', expectedVersion: 1 })).status).toBe(404);
      expect((await http().post('/api/v1/identity/me/password').send({})).status).toBe(404);
      expect(tokens.verify).not.toHaveBeenCalled();
      const read = await http().get('/api/v1/identity/me/staff-profile').set('Authorization', `Bearer access-${sessionId}`);
      expect(read.status).toBe(200);
      expect(read.body.canChange).toEqual({ name: false, password: false, preferences: false });
      expect(read.body).not.toHaveProperty('profileVersion');
      expect(database.withTransaction).not.toHaveBeenCalled();
    });
  });

  it('the password setting under AUTH_MODE=oidc: the route does not exist (404)', async () => {
    await boot({ STAFF_PASSWORD_CHANGE_ENABLED: 'true', AUTH_MODE: 'oidc', OIDC_ISSUER_URL: 'https://issuer.invalid',
      OIDC_AUDIENCE: 'hid', OIDC_JWKS_URL: 'https://issuer.invalid/jwks' });
    expect((await changePassword(signIn())).status).toBe(404);
    expect(tokens.verify).not.toHaveBeenCalled();
  });

  it('the name setting under AUTH_MODE=oidc: the route does not exist (404), and SX-5 offers no edit', async () => {
    await boot({ STAFF_NAME_CHANGE_ENABLED: 'true', AUTH_MODE: 'oidc', OIDC_ISSUER_URL: 'https://issuer.invalid',
      OIDC_AUDIENCE: 'hid', OIDC_JWKS_URL: 'https://issuer.invalid/jwks' });
    const sessionId = signIn();
    expect((await http().post('/api/v1/identity/me/staff-profile').set('Authorization', `Bearer access-${sessionId}`)
      .set('Idempotency-Key', KEY).send({ name: 'Ada Bello', expectedVersion: 1 })).status).toBe(404);
    const read = await http().get('/api/v1/identity/me/staff-profile').set('Authorization', `Bearer access-${sessionId}`);
    expect(read.status).toBe(200);
    expect(read.body).not.toHaveProperty('profileVersion');
    expect(read.body.canChange).toEqual({ name: false, password: false, preferences: false });
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  describe('STAFF_PASSWORD_CHANGE_ENABLED=true', () => {
    beforeEach(async () => { await boot({ STAFF_PASSWORD_CHANGE_ENABLED: 'true' }); });

    it('changes: 200, the renewed sign-in\'s three cookies and x-csrf-token, no-store, the email after; no password anywhere', async () => {
      const sessionId = signIn();
      const response = await changePassword(sessionId);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ changed: true, otherSignInsEnded: 2, passwordChangedAt: '2026-11-26T09:00:00.000Z',
        replayed: false });
      const cookies = (response.headers['set-cookie'] as unknown as string[]).map((cookie) => cookie.split(';')[0]);
      expect(cookies).toEqual(['hid_access=renewed-access-v5', 'hid_access_refresh=renewed-refresh',
        'hid_access_csrf=renewed-csrf']);
      expect((response.headers['set-cookie'] as unknown as string[])[1]).toContain('Path=/api/v1/auth');
      expect(response.headers['x-csrf-token']).toBe('renewed-csrf');
      expect(response.headers['cache-control']).toBe('no-store');
      // Bound to the presented session and its token, under the session's product, with the account-only context.
      const values = client.query.mock.calls.find(([text]) => text === CHANGE_OWN_PASSWORD_SQL)![1] as unknown[];
      expect(values.slice(0, 3)).toEqual([sessionId, `jti-${sessionId}`, STORED]);
      expect(tokens.renewSignIn).toHaveBeenCalledWith(expect.objectContaining({ product: 'ehr', origin: EHR }), expect.any(Function));
      expect(database.withTransaction).toHaveBeenCalledWith(expect.objectContaining({ facilityId: '', membershipId: '',
        purposeOfUse: 'healthcare-operations' }), expect.any(Function));
      // The success row is 0205's (in the change's transaction): none written here.
      expect(rows()).toEqual([]);
      await app!.get(StaffProfileChangesService).settleConfirmations();
      expect(notification.deliverPasswordUpdated).toHaveBeenCalledWith(expect.objectContaining({ recipient: 'ada@example.test',
        firstName: 'Ada' }));
      noPasswordAnywhere();
    });

    it('a replay answers the stored change, replayed true, with no cookie and its own success row', async () => {
      state.replay = true;
      const response = await changePassword(signIn(), { currentPassword: 'no longer right at all', newPassword: NEW });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ changed: true, otherSignInsEnded: 1, replayed: true });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(local.verifyStoredPassword).not.toHaveBeenCalled();
      expect(rows()).toEqual([expect.objectContaining({ action: 'auth.password.change', outcome: 'success',
        resourceType: 'session', details: expect.objectContaining({ replayed: true }) })]);
      expect(rows()[0]!.facilityId).toBeUndefined();
    });

    it('a bearer caller: 403 COOKIE_SESSION_REQUIRED before anything is read, and the refusal recorded', async () => {
      const sessionId = signIn();
      const response = await http().post('/api/v1/identity/me/password').set('Authorization', `Bearer access-${sessionId}`)
        .set('Idempotency-Key', KEY).send({ currentPassword: CURRENT, newPassword: NEW });
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'COOKIE_SESSION_REQUIRED', detail: 'Change your password on the Health ID website.' });
      expect(database.withTransaction).not.toHaveBeenCalled();
      expect(rows()).toEqual([expect.objectContaining({ action: 'auth.password.change', outcome: 'denied',
        resourceType: 'session', resourceId: sessionId, details: expect.objectContaining({ code: 'COOKIE_SESSION_REQUIRED' }) })]);
      noPasswordAnywhere();
    });

    it('a bearer caller naming another facility: still 403 COOKIE_SESSION_REQUIRED (the transport is checked first)', async () => {
      const sessionId = signIn();
      const response = await http().post('/api/v1/identity/me/password').set('Authorization', `Bearer access-${sessionId}`)
        .set('X-Facility-ID', randomUUID()).send({ currentPassword: CURRENT, newPassword: NEW });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('COOKIE_SESSION_REQUIRED');
      expect(rows()).toEqual([expect.objectContaining({ details: expect.objectContaining({ code: 'COOKIE_SESSION_REQUIRED' }) })]);
    });

    it('a patient session: 403 PATIENT_SCOPE_DENIED (the guard), with no auth.password.change row of its own', async () => {
      const response = await changePassword(signIn('patient'));
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('PATIENT_SCOPE_DENIED');
      expect(rows().filter((row) => row.action === 'auth.password.change')).toEqual([]);
    });

    it('a cookie POST without the CSRF header: 403 CSRF_VALIDATION_FAILED (the guard)', async () => {
      const sessionId = signIn();
      const response = await http().post('/api/v1/identity/me/password').set('Origin', EHR)
        .set('Cookie', [`hid_access=access-${sessionId}`]).set('Idempotency-Key', KEY)
        .send({ currentPassword: CURRENT, newPassword: NEW });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('CSRF_VALIDATION_FAILED');
    });

    it('no Idempotency-Key: 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
      const response = await changePassword(signIn(), undefined, null);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it.each([
      ['no current password', { newPassword: NEW }],
      ['a new password over 256 characters', { currentPassword: CURRENT, newPassword: 'x'.repeat(257) }],
      ['another field', { currentPassword: CURRENT, newPassword: NEW, name: 'Ada' }],
    ])('%s: 400 VALIDATION_FAILED, nothing read, no audit row', async (_label, body) => {
      const response = await changePassword(signIn(), body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(database.withTransaction).not.toHaveBeenCalled();
      expect(rows()).toEqual([]);
    });

    it('an X-Facility-ID that is not the caller\'s: 403 FACILITY_ACCESS_DENIED', async () => {
      const sessionId = signIn();
      const response = await http().post('/api/v1/identity/me/password').set('Origin', EHR)
        .set('Cookie', [`hid_access=access-${sessionId}`, 'hid_access_csrf=csrf-ok']).set('X-CSRF-Token', 'csrf-ok')
        .set('X-Facility-ID', randomUUID()).set('Idempotency-Key', KEY).send({ currentPassword: CURRENT, newPassword: NEW });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FACILITY_ACCESS_DENIED');
    });

    it('a wrong current password: 403 STAFF_REAUTHENTICATION_FAILED, counted towards the lockout, recorded', async () => {
      const response = await changePassword(signIn(), { currentPassword: 'wrong fictional pass', newPassword: NEW });
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'STAFF_REAUTHENTICATION_FAILED', detail: 'That password isn\'t right' });
      expect(sessionAudit.recordLoginFailure).toHaveBeenCalledWith('ada@example.test', expect.any(Object));
      expect(rows()).toEqual([expect.objectContaining({ outcome: 'denied',
        details: { method: 'POST', route: 'identity/me/password', code: 'STAFF_REAUTHENTICATION_FAILED' } })]);
      noPasswordAnywhere();
    });

    it.each([
      ['locked', () => { state.locked = true; }, 429, 'STAFF_REAUTHENTICATION_LOCKED'],
      ['no password', () => { state.hash = null; }, 409, 'PASSWORD_NOT_SET'],
      ['changed meanwhile', () => { state.passwordError = Object.assign(new Error('PASSWORD_CHANGED_MEANWHILE'), { code: '40001' }); },
        409, 'PASSWORD_CHANGED_MEANWHILE'],
      ['a sealed login', () => { state.passwordError = Object.assign(new Error('STAFF_PROFILE_CHANGE_NOT_ALLOWED'), { code: '42501' }); },
        403, 'STAFF_PROFILE_CHANGE_NOT_ALLOWED'],
      ['a session rotated meanwhile', () => { state.passwordError = Object.assign(new Error('OWN_SESSION_NOT_CURRENT'), { code: '42501' }); },
        401, 'AUTHENTICATION_REQUIRED'],
      ['the database down', () => { state.passwordError = Object.assign(new Error('terminating connection'), { code: '57P01' }); },
        503, 'DEPENDENCY_UNAVAILABLE'],
    ])('%s: %s %s, recorded, no cookie', async (_label, arrange, status, code) => {
      arrange();
      const response = await changePassword(signIn());
      expect(response.status).toBe(status);
      expect(response.body.code).toBe(code);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(rows()).toEqual([expect.objectContaining({ action: 'auth.password.change',
        outcome: status >= 500 ? 'failure' : 'denied', details: expect.objectContaining({ code }) })]);
      if (status >= 500) expect(response.body.detail).toBe('The service could not complete the request.');
      noPasswordAnywhere();
    });

    it('the account read failing (before the change): 503 DEPENDENCY_UNAVAILABLE, not 500, a failure row', async () => {
      const read = database.query.getMockImplementation()!;
      database.query.mockImplementation(async (text: string, values?: unknown[]) => {
        if (text === OWN_PASSWORD_ACCOUNT_SQL) throw Object.assign(new Error('terminating connection'), { code: '57P01' });
        return read(text, values);
      });
      const response = await changePassword(signIn());
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE',
        detail: 'The service could not complete the request.' });
      expect(local.verifyStoredPassword).not.toHaveBeenCalled();
      expect(tokens.renewSignIn).not.toHaveBeenCalled();
      expect(rows()).toEqual([expect.objectContaining({ action: 'auth.password.change', outcome: 'failure',
        details: expect.objectContaining({ code: 'DEPENDENCY_UNAVAILABLE' }) })]);
      noPasswordAnywhere();
    });

    it('PASSWORD_TOO_SHORT and PASSWORD_SAME_AS_CURRENT, after the current password is checked', async () => {
      const short = await changePassword(signIn(), { currentPassword: CURRENT, newPassword: 'short' });
      expect(short.status).toBe(400);
      expect(short.body).toMatchObject({ code: 'PASSWORD_TOO_SHORT', detail: 'Use at least 12 characters.' });
      const same = await changePassword(signIn(), { currentPassword: CURRENT, newPassword: CURRENT });
      expect(same.status).toBe(400);
      expect(same.body.code).toBe('PASSWORD_SAME_AS_CURRENT');
      expect(local.verifyStoredPassword).toHaveBeenCalledTimes(2);
      expect(tokens.renewSignIn).not.toHaveBeenCalled();
      noPasswordAnywhere();
    });

    it('SX-5 says the password can change; the name edit stays off', async () => {
      const read = await http().get('/api/v1/identity/me/staff-profile').set('Authorization', `Bearer access-${signIn()}`);
      expect(read.body.canChange).toEqual({ name: false, password: true, preferences: false });
      expect((await changeName(signIn(), { name: 'Ada Bello', expectedVersion: 1 })).status).toBe(404);
    });
  });

  describe('STAFF_NAME_CHANGE_ENABLED=true', () => {
    beforeEach(async () => { await boot({ STAFF_NAME_CHANGE_ENABLED: 'true' }); });

    it('SX-5 carries profileVersion and canChange.name; the password route stays off', async () => {
      const read = await http().get('/api/v1/identity/me/staff-profile').set('Authorization', `Bearer access-${signIn()}`);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ profileVersion: 1, canChange: { name: true, password: false, preferences: false } });
      expect((await changePassword(signIn())).status).toBe(404);
    });

    it('changes the name: 200 with the SX-5 profile, the new name and version; the success row is 0205\'s', async () => {
      const response = await changeName(signIn(), { name: ' Ada Ọlá Bello ', expectedVersion: 1 });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ accountId: ACCOUNT, name: 'Ada Ọlá Bello', profileVersion: 2,
        canChange: { name: true } });
      expect(client.query).toHaveBeenCalledWith(CHANGE_OWN_DISPLAY_NAME_SQL, ['Ada Ọlá Bello', 1, KEY, expect.any(String),
        expect.anything(), null]);
      expect(rows()).toEqual([]);
    });

    it('an X-Facility-ID that is not the caller\'s: 403 FACILITY_ACCESS_DENIED, nothing changed', async () => {
      const sessionId = signIn();
      const response = await http().post('/api/v1/identity/me/staff-profile').set('Origin', EHR)
        .set('Cookie', [`hid_access=access-${sessionId}`, 'hid_access_csrf=csrf-ok']).set('X-CSRF-Token', 'csrf-ok')
        .set('X-Facility-ID', randomUUID()).set('Idempotency-Key', KEY).send({ name: 'Ada Bello', expectedVersion: 1 });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FACILITY_ACCESS_DENIED');
      expect(client.query).not.toHaveBeenCalledWith(CHANGE_OWN_DISPLAY_NAME_SQL, expect.anything());
      expect(state.displayName).toBe('Ada Fictional');
      expect(rows()).toEqual([expect.objectContaining({ action: 'auth.staff-profile.update', outcome: 'denied',
        details: expect.objectContaining({ code: 'FACILITY_ACCESS_DENIED' }) })]);
    });

    it('the change committed but the profile read after it failing: 503 DEPENDENCY_UNAVAILABLE, no failure row', async () => {
      const inTransaction = client.query.getMockImplementation()!;
      client.query.mockImplementation(async (text: string, values?: unknown[]) => {
        if (text === STAFF_PROFILE_SQL) throw Object.assign(new Error('terminating connection'), { code: '57P01' });
        return inTransaction(text, values);
      });
      const response = await changeName(signIn(), { name: 'Ada Bello', expectedVersion: 1 });
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE',
        detail: 'The service could not complete the request.' });
      // 0205 wrote the success row with the change; Identity writes no failure row beside it.
      expect(state.displayName).toBe('Ada Bello');
      expect(rows()).toEqual([]);
    });

    it('a bearer caller may change the name (no cookie to renew)', async () => {
      const response = await http().post('/api/v1/identity/me/staff-profile').set('Authorization', `Bearer access-${signIn()}`)
        .set('Idempotency-Key', KEY).send({ name: 'Ada Bello', expectedVersion: 1 });
      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Ada Bello');
    });

    it('a replay answers the profile and records its own success row', async () => {
      state.nameReplayed = true;
      state.displayName = 'Ada Bello';
      state.version = 2;
      const response = await changeName(signIn(), { name: 'Ada Bello', expectedVersion: 1 });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ name: 'Ada Bello', profileVersion: 2 });
      expect(rows()).toEqual([expect.objectContaining({ action: 'auth.staff-profile.update', outcome: 'success',
        details: expect.objectContaining({ replayed: true, profileVersion: 2 }) })]);
    });

    it('an invalid name: 400 STAFF_NAME_INVALID with the corrected message, before the database', async () => {
      const response = await changeName(signIn(), { name: 'Dr. Ada', expectedVersion: 1 });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('STAFF_NAME_INVALID');
      expect(response.body.detail).toContain('2 to 6 words of letters (2 to 80 characters in all)');
      expect(database.withTransaction).not.toHaveBeenCalled();
      expect(rows()).toEqual([expect.objectContaining({ action: 'auth.staff-profile.update', outcome: 'denied' })]);
    });

    it.each([
      ['40001', 'VERSION_CONFLICT', 412], ['55000', 'STAFF_NAME_CHANGE_LIMITED', 429], ['22023', 'STAFF_NAME_UNCHANGED', 400],
      ['23505', 'IDEMPOTENCY_KEY_REUSED', 409], ['42501', 'STAFF_PROFILE_CHANGE_NOT_ALLOWED', 403],
    ])('the database\'s %s %s: %s', async (sqlstate, code, status) => {
      state.nameError = Object.assign(new Error(code), { code: sqlstate });
      const response = await changeName(signIn(), { name: 'Ada Bello', expectedVersion: 1 });
      expect(response.status).toBe(status);
      expect(response.body.code).toBe(code);
    });

    it.each([
      ['no expected version', { name: 'Ada Bello' }], ['a version that is not a whole number', { name: 'Ada Bello', expectedVersion: '1' }],
      ['version 0', { name: 'Ada Bello', expectedVersion: 0 }], ['an email field', { name: 'Ada Bello', expectedVersion: 1, email: 'x@y.z' }],
    ])('%s: 400 VALIDATION_FAILED', async (_label, body) => {
      const response = await changeName(signIn(), body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('no Idempotency-Key: 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
      const response = await changeName(signIn(), { name: 'Ada Bello', expectedVersion: 1 }, null);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });
  });
});
