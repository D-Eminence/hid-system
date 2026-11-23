jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { randomUUID } from 'node:crypto';
import { Logger, type MiddlewareConsumer, Module, type NestModule, UnauthorizedException, ValidationPipe,
  type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { AuditService } from '../audit/audit.service';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { AuthSessionAuditService } from '../auth/auth-session-audit.service';
import { GoogleAuthenticationService } from '../auth/google-authentication.service';
import { SecurityGuard } from '../auth/security.guard';
import { TokenService } from '../auth/token.service';
import { TurnstileService } from '../auth/turnstile.service';
import { WorkloadAuthService } from '../auth/workload-auth.service';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { OpenPatientController } from './open-patient.controller';
import { OpenPatientOffMiddleware } from './open-patient-off.middleware';
import { OpenPatientService } from './open-patient.service';

// SX-8 (0140): the two open-patient routes and the session read's
// `openPatient`, through the real AuthController, OpenPatientController,
// OpenPatientOffMiddleware, SecurityGuard and main.ts's pipe and filter.
// OpenPatientService is a stand-in here (its own logic is
// open-patient.service.spec.ts); its `reportsFor` is the real rule.

const EHR = 'https://ehr.staging.healthidentitydirectory.com';
const OIDC_BEARER = 'external-oidc-access-token';

const facility = (name: string, primary: boolean): FacilityAssignment => ({
  id: randomUUID(), membershipId: randomUUID(), organizationId: randomUUID(), name, roles: ['doctor'],
  permissions: ['ehr.encounter.write', 'doctor.synthetic'], isPrimary: primary,
});
const primary = facility('Fictional Alpha General', true);
const secondary = facility('Fictional Beta Clinic', false);
const elsewhere = facility('Fictional Delta Hospital', true);

describe('keep the open patient across a reload: routes and session read (SX-8, 0140)', () => {
  const original = { ...process.env };
  let app: INestApplication | undefined;
  let warn: jest.SpyInstance;
  const accountId = randomUUID();
  const sessions = new Map<string, { kind: 'staff' | 'patient' | 'outreach'; live: boolean }>();
  const access = (sessionId: string) => `access-${sessionId}`;
  let tokens: Record<string, jest.Mock>;
  let audit: { record: jest.Mock; recordWithClient: jest.Mock };
  let openPatients: { reportsFor: (actor: ActorContext) => boolean; set: jest.Mock; clear: jest.Mock; restore: jest.Mock };
  const auditClient = { query: jest.fn() };

  const staffActor = (sessionId?: string): ActorContext => ({
    id: `staff:${accountId}`, subject: `staff:${accountId}`, accountId, ...(sessionId ? { sessionId } : {}),
    roles: primary.roles, role: primary.roles[0], permissions: primary.permissions, platformRoles: [],
    platformPermissions: [], facilityIds: [primary.id, secondary.id], facilities: [primary, secondary],
    facility: primary, authenticationMethod: 'local',
  });
  const actorOf = (sessionId: string): ActorContext => {
    const session = sessions.get(sessionId)!;
    if (session.kind === 'patient') {
      return { kind: 'patient', patientId: randomUUID(), id: `patient:${accountId}`, subject: `patient:${accountId}`,
        accountId, sessionId, roles: [], permissions: [], platformRoles: [], platformPermissions: [], facilityIds: [],
        facilities: [], authenticationMethod: 'local' };
    }
    if (session.kind === 'outreach') {
      return { id: `staff:${accountId}`, subject: `staff:${accountId}`, accountId, sessionId, roles: [], permissions: [],
        platformRoles: [], platformPermissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local',
        accountOnly: true };
    }
    return staffActor(sessionId);
  };
  const signIn = (kind: 'staff' | 'patient' | 'outreach' = 'staff') => {
    const sessionId = randomUUID();
    sessions.set(sessionId, { kind, live: true });
    return sessionId;
  };

  beforeEach(() => {
    sessions.clear();
    auditClient.query.mockReset();
    tokens = {
      verify: jest.fn(async (token: string) => {
        if (token === OIDC_BEARER) return { actor: { ...staffActor(), authenticationMethod: 'oidc' }, claims: {} };
        const sessionId = token.slice('access-'.length);
        if (!sessions.get(sessionId)?.live) throw new UnauthorizedException('Session is no longer active');
        return { actor: actorOf(sessionId), claims: {} };
      }),
      verifyCsrf: jest.fn(() => false),
      verifyRefreshCsrf: jest.fn((refresh: string, cookie?: string, header?: string) =>
        cookie === `csrf-${refresh}` && header === cookie),
      selectedFacilityId: jest.fn(async () => undefined),
      recordFacilitySelection: jest.fn(async (_input: unknown, _event: unknown,
        within: (client: unknown) => Promise<void>) => { await within(auditClient); return 'selected'; }),
      clearOpenPatientElsewhere: jest.fn(async (_input: unknown, _event: unknown,
        within: (client: unknown) => Promise<void>) => { await within(auditClient); }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined), recordWithClient: jest.fn().mockResolvedValue(undefined) };
    openPatients = {
      reportsFor: (actor: ActorContext) => OpenPatientService.prototype.reportsFor.call(undefined, actor),
      set: jest.fn(async (_actor: ActorContext, patientId: string) => ({ openPatient: { state: 'kept', patientId,
        expiresAt: '2026-11-20T17:00:00.000Z' } })),
      clear: jest.fn(async () => ({ openPatient: null })),
      restore: jest.fn(async () => undefined),
    };
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    warn.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  async function boot(enabled: string | undefined, facilitySelectionMode: 'off' | 'keep' = 'off'): Promise<void> {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: EHR, AUTH_MODE: 'local', AUTH_COOKIE_NAME: 'hid_access', AUTH_COOKIE_SECURE: 'false',
      TURNSTILE_MODE: 'disabled', STAFF_FACILITY_SELECTION_MODE: facilitySelectionMode,
      AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
    if (enabled === undefined) delete process.env.STAFF_OPEN_PATIENT_ENABLED;
    else process.env.STAFF_OPEN_PATIENT_ENABLED = enabled;
    resetEnvironmentForTests();
    const database = { query: jest.fn(async (_sql: string, values: unknown[]) =>
      ({ rows: [{ enabled: values[0] !== 'maintenance_mode' }] })) };
    const providers = [
      { provide: AuthService, useValue: { login: jest.fn(), revoke: jest.fn(),
        refresh: jest.fn(async (refreshToken: string) => {
          const sessionId = refreshToken.slice('refresh-'.length);
          return { actor: actorOf(sessionId), accessToken: access(sessionId), refreshToken, csrfToken: `csrf-${refreshToken}`,
            expiresAt: new Date(Date.now() + 900_000), refreshExpiresAt: new Date(Date.now() + 28_800_000) };
        }) } },
      { provide: TokenService, useValue: tokens },
      { provide: AuthSessionAuditService, useValue: { record: jest.fn(), recordLoginFailure: jest.fn() } },
      { provide: AuditService, useValue: audit },
      { provide: WorkloadAuthService, useValue: { authenticateService: jest.fn().mockResolvedValue({}) } },
      { provide: TurnstileService, useValue: { verifyLogin: jest.fn().mockResolvedValue(undefined) } },
      { provide: GoogleAuthenticationService, useValue: { login: jest.fn(), exchange: jest.fn(),
        onboardingStatus: jest.fn(), onboardingCookieName: 'hid_access_google_onboarding' } },
      { provide: DatabaseService, useValue: database },
      { provide: OpenPatientService, useValue: openPatients },
    ];
    @Module({ controllers: [AuthController, OpenPatientController], providers })
    class OpenPatientTestModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void {
        consumer.apply(OpenPatientOffMiddleware).forRoutes(OpenPatientController);
      }
    }
    const module = await Test.createTestingModule({ imports: [OpenPatientTestModule] }).compile();
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
  const setOpen = (token: string, body: unknown, facilityId: string | null = primary.id) => {
    const call = http().post('/api/v1/auth/open-patient').set('Authorization', `Bearer ${token}`).set('Origin', EHR);
    return (facilityId ? call.set('X-Facility-ID', facilityId) : call).send(body as object);
  };
  const clearOpen = (token: string, facilityId: string | null = primary.id) => {
    const call = http().post('/api/v1/auth/open-patient/clear').set('Authorization', `Bearer ${token}`).set('Origin', EHR);
    return (facilityId ? call.set('X-Facility-ID', facilityId) : call).send({});
  };
  const session = (token: string, facilityId?: string) => {
    const call = http().get('/api/v1/auth/session').set('Authorization', `Bearer ${token}`);
    return facilityId ? call.set('X-Facility-ID', facilityId) : call;
  };
  const select = (token: string, facilityId: string) => http().post('/api/v1/auth/facility')
    .set('Authorization', `Bearer ${token}`).set('Origin', EHR).send({ facilityId });
  const patientId = randomUUID();

  describe.each([['unset', undefined], ['false', 'false']] as const)('STAFF_OPEN_PATIENT_ENABLED %s: as today', (_label, value) => {
    beforeEach(async () => { await boot(value); });

    it('both routes answer a plain 404 before any guard, signed in or not', async () => {
      const sessionId = signIn();
      for (const response of [
        await setOpen(access(sessionId), { patientId, purpose: 'direct-care' }),
        await clearOpen(access(sessionId)),
        await http().post('/api/v1/auth/open-patient').send({ patientId, purpose: 'direct-care' }),
        await http().post('/api/v1/auth/open-patient/clear').send({}),
      ]) {
        expect(response.status).toBe(404);
      }
      expect(tokens.verify).not.toHaveBeenCalled();
      expect(openPatients.set).not.toHaveBeenCalled();
      expect(openPatients.clear).not.toHaveBeenCalled();
    });

    it('the session read never carries openPatient and reads nothing', async () => {
      openPatients.restore.mockResolvedValue({ state: 'unavailable' });
      const read = await session(access(signIn()));
      expect(read.status).toBe(200);
      expect(read.body).not.toHaveProperty('openPatient');
      expect(openPatients.restore).not.toHaveBeenCalled();
    });

    it('a move to another facility is today\'s, with no clear', async () => {
      const chosen = await select(access(signIn()), secondary.id);
      expect(chosen.status).toBe(200);
      expect(tokens.clearOpenPatientElsewhere).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.facility.select' }));
      expect(audit.recordWithClient).not.toHaveBeenCalled();
    });
  });

  describe('STAFF_OPEN_PATIENT_ENABLED=true', () => {
    beforeEach(async () => { await boot('true'); });

    it('sets the open patient as the member at the X-Facility-ID facility', async () => {
      const sessionId = signIn();
      const response = await setOpen(access(sessionId), { patientId, purpose: 'emergency' }, secondary.id)
        .set('User-Agent', 'synthetic-browser');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ openPatient: { state: 'kept', patientId, expiresAt: '2026-11-20T17:00:00.000Z' } });
      expect(openPatients.set).toHaveBeenCalledTimes(1);
      const [actor, id, purpose, meta] = openPatients.set.mock.calls[0]!;
      expect(actor).toMatchObject({ sessionId, accountId, facility: { id: secondary.id, membershipId: secondary.membershipId } });
      expect([id, purpose]).toEqual([patientId, 'emergency']);
      expect(meta).toEqual({ correlationId: expect.any(String), sourceIp: expect.any(String), userAgent: 'synthetic-browser' });
    });

    it.each(['hid', 'healthId', 'matchRef', 'nin'])('a body with %s is refused with 400 VALIDATION_FAILED', async (field) => {
      const response = await setOpen(access(signIn()), { patientId, purpose: 'direct-care', [field]: 'HID-QQ22-AA22' });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(openPatients.set).not.toHaveBeenCalled();
    });

    it.each([
      ['no patientId', { purpose: 'direct-care' }],
      ['a patientId that is not a UUID', { patientId: 'HID-QQ22-AA22', purpose: 'direct-care' }],
      ['a numeric patientId', { patientId: 12, purpose: 'direct-care' }],
    ])('%s is 400 VALIDATION_FAILED', async (_label, body) => {
      const response = await setOpen(access(signIn()), body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(openPatients.set).not.toHaveBeenCalled();
    });

    it.each([['missing', undefined], ['healthcare-operations', 'healthcare-operations'], ['unknown', 'curiosity']])(
      'a %s purpose is 400 PURPOSE_OF_USE_REQUIRED', async (_label, purpose) => {
        const response = await setOpen(access(signIn()), { patientId, ...(purpose ? { purpose } : {}) });
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ code: 'PURPOSE_OF_USE_REQUIRED', detail: 'Choose why you are opening this record.' });
        expect(openPatients.set).not.toHaveBeenCalled();
      });

    it('needs X-Facility-ID (400 FACILITY_REQUIRED) at one of the actor\'s facilities (403 FACILITY_ACCESS_DENIED)', async () => {
      const token = access(signIn());
      const missing = await setOpen(token, { patientId, purpose: 'direct-care' }, null);
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('FACILITY_REQUIRED');
      const other = await setOpen(token, { patientId, purpose: 'direct-care' }, elsewhere.id);
      expect(other.status).toBe(403);
      expect(other.body.code).toBe('FACILITY_ACCESS_DENIED');
      const clear = await clearOpen(token, null);
      expect(clear.status).toBe(400);
      expect(clear.body.code).toBe('FACILITY_REQUIRED');
      expect(openPatients.set).not.toHaveBeenCalled();
      expect(openPatients.clear).not.toHaveBeenCalled();
    });

    it('a patient session is refused with 403 PATIENT_SCOPE_DENIED; an account-only session with 403', async () => {
      const patient = await setOpen(access(signIn('patient')), { patientId, purpose: 'direct-care' });
      expect(patient.status).toBe(403);
      expect(patient.body.code).toBe('PATIENT_SCOPE_DENIED');
      const outreach = await setOpen(access(signIn('outreach')), { patientId, purpose: 'direct-care' });
      expect(outreach.status).toBe(403);
      expect(openPatients.set).not.toHaveBeenCalled();
    });

    it('an OIDC bearer caller (no Identity sign-in) is answered as not served: 404', async () => {
      expect((await setOpen(OIDC_BEARER, { patientId, purpose: 'direct-care' })).status).toBe(404);
      expect((await clearOpen(OIDC_BEARER)).status).toBe(404);
      expect(openPatients.set).not.toHaveBeenCalled();
      expect(openPatients.clear).not.toHaveBeenCalled();
    });

    it('a cookie request needs Origin and CSRF, as every cookie POST does', async () => {
      const sessionId = signIn();
      const response = await http().post('/api/v1/auth/open-patient').set('Cookie', `hid_access=${access(sessionId)}`)
        .set('X-Facility-ID', primary.id).send({ patientId, purpose: 'direct-care' });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('ORIGIN_DENIED');
      expect(openPatients.set).not.toHaveBeenCalled();
    });

    it('clears with an empty body and answers null; safe to repeat', async () => {
      const token = access(signIn());
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await clearOpen(token);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ openPatient: null });
      }
      expect(openPatients.clear).toHaveBeenCalledTimes(2);
    });

    it('the session read carries the restore answer for the facility reported', async () => {
      const answer = { state: 'restored', patientId, purpose: 'direct-care', expiresAt: '2026-11-20T17:00:00.000Z',
        card: { fullName: 'Amaka Okafor', sex: 'female', dateOfBirth: '1990-05-01', healthIdLast4: 'AA22',
          ninStatus: 'verified' } };
      openPatients.restore.mockResolvedValue(answer);
      const sessionId = signIn();
      const read = await session(access(sessionId), secondary.id);
      expect(read.status).toBe(200);
      expect(read.body.openPatient).toEqual(answer);
      expect(openPatients.restore).toHaveBeenCalledWith(expect.objectContaining({ sessionId,
        facility: expect.objectContaining({ id: secondary.id }) }), expect.objectContaining({ correlationId: expect.any(String) }));
      // The session read's own audit row is unchanged.
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.session.read', facilityId: secondary.id }));
    });

    it.each([['ended'], ['expired'], ['unavailable']])('a %s answer carries no card', async (state) => {
      openPatients.restore.mockResolvedValue({ state });
      const read = await session(access(signIn()));
      expect(read.status).toBe(200);
      expect(read.body.openPatient).toEqual({ state });
    });

    it('nothing to report: the field is absent', async () => {
      const read = await session(access(signIn()));
      expect(read.status).toBe(200);
      expect(read.body).not.toHaveProperty('openPatient');
    });

    it('a restore that throws still answers 200 with unavailable, logged with no identifier', async () => {
      openPatients.restore.mockRejectedValue(new Error('surprise'));
      const read = await session(access(signIn()));
      expect(read.status).toBe(200);
      expect(read.body.openPatient).toEqual({ state: 'unavailable' });
      expect(warn.mock.calls.map(([message]) => message)).toContainEqual({ event: 'auth.open_patient.unavailable',
        operation: 'read' });
    });

    it('patients, account-only sessions and OIDC bearer callers never get the field', async () => {
      openPatients.restore.mockResolvedValue({ state: 'unavailable' });
      for (const token of [access(signIn('patient')), access(signIn('outreach')), OIDC_BEARER]) {
        const read = await session(token);
        expect(read.status).toBe(200);
        expect(read.body).not.toHaveProperty('openPatient');
      }
      expect(openPatients.restore).not.toHaveBeenCalled();
    });

    it('a refresh never carries it, and reads nothing', async () => {
      openPatients.restore.mockResolvedValue({ state: 'unavailable' });
      const sessionId = signIn();
      const refreshToken = `refresh-${sessionId}`;
      const refreshed = await http().post('/api/v1/auth/refresh').set('Origin', EHR)
        .set('x-csrf-token', `csrf-${refreshToken}`)
        .set('Cookie', `hid_access_refresh=${refreshToken}; hid_access_csrf=csrf-${refreshToken}`);
      expect(refreshed.status).toBe(200);
      expect(refreshed.body).not.toHaveProperty('openPatient');
      expect(openPatients.restore).not.toHaveBeenCalled();
    });

    it('the service session never carries it', async () => {
      openPatients.restore.mockResolvedValue({ state: 'unavailable' });
      const read = await http().get('/api/v1/auth/service-session').set('Authorization', `Bearer ${access(signIn())}`)
        .set('x-hid-internal-caller', 'ehr-api');
      expect(read.status).toBe(200);
      expect(read.body).not.toHaveProperty('openPatient');
      expect(openPatients.restore).not.toHaveBeenCalled();
    });

    it('with 0129 off, a move clears the open patient kept elsewhere with the move\'s audit row, in one transaction',
      async () => {
        const sessionId = signIn();
        const chosen = await select(access(sessionId), secondary.id);
        expect(chosen.status).toBe(200);
        expect(chosen.body).not.toHaveProperty('facilitySelection');
        expect(tokens.clearOpenPatientElsewhere).toHaveBeenCalledWith(
          { sessionId, accountId, facilityId: secondary.id }, expect.objectContaining({ correlationId: expect.any(String) }),
          expect.any(Function));
        expect(audit.recordWithClient).toHaveBeenCalledWith(auditClient, expect.objectContaining({
          action: 'auth.facility.select', facilityId: secondary.id }));
        expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.facility.select' }));
      });

    it('with 0129 off, a failed clear is 503 with the move not audited', async () => {
      tokens.clearOpenPatientElsewhere!.mockRejectedValue(new Error('down'));
      const chosen = await select(access(signIn()), secondary.id);
      expect(chosen.status).toBe(503);
      expect(chosen.body.code).toBe('DEPENDENCY_UNAVAILABLE');
      expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.facility.select' }));
    });

    it('an OIDC bearer caller\'s move is today\'s, with no clear', async () => {
      const chosen = await select(OIDC_BEARER, secondary.id);
      expect(chosen.status).toBe(200);
      expect(tokens.clearOpenPatientElsewhere).not.toHaveBeenCalled();
    });
  });

  it('with 0129 keep, the move goes through recordFacilitySelection, which clears in its own transaction', async () => {
    await boot('true', 'keep');
    const sessionId = signIn();
    const chosen = await select(access(sessionId), secondary.id);
    expect(chosen.status).toBe(200);
    expect(chosen.body.facilitySelection).toBe('selected');
    expect(tokens.recordFacilitySelection).toHaveBeenCalledTimes(1);
    expect(tokens.clearOpenPatientElsewhere).not.toHaveBeenCalled();
  });
});
