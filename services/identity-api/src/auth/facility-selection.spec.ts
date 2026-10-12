jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { randomUUID } from 'node:crypto';
import { UnauthorizedException, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { AuditService } from '../audit/audit.service';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSessionAuditService } from './auth-session-audit.service';
import { GoogleAuthenticationService } from './google-authentication.service';
import { SecurityGuard } from './security.guard';
import { TokenService } from './token.service';
import { TurnstileService } from './turnstile.service';
import { WorkloadAuthService } from './workload-auth.service';

// A staff member's explicitly chosen working facility is kept per sign-in
// (0080, auth.session_facility_selection): a page reload, which reads
// GET /auth/session or refreshes, used to report the primary facility again.
// The stand-in below models only what the database guarantees: one selection
// per sign-in family, written for a live staff session of the same account and
// an active membership, read back only through a live session of the family.

const ORIGIN = 'https://staging.healthidentitydirectory.com';
const OIDC_BEARER = 'external-oidc-access-token';
const facility = (name: string, primary: boolean, role: string): FacilityAssignment => ({
  id: randomUUID(), membershipId: randomUUID(), organizationId: randomUUID(), name,
  roles: [role], permissions: [`${role}.permission`], isPrimary: primary,
});

interface StoredSession { familyId: string; accountId: string; kind: 'staff' | 'patient'; live: boolean }

class SignInStore {
  readonly sessions = new Map<string, StoredSession>();
  readonly access = new Map<string, string>();
  readonly refresh = new Map<string, string>();
  readonly selections = new Map<string, { facilityId: string; membershipId: string }>();
  readonly memberships = new Map<string, FacilityAssignment[]>();

  signIn(accountId: string, kind: 'staff' | 'patient' = 'staff') {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { familyId: sessionId, accountId, kind, live: true });
    return this.tokensFor(sessionId);
  }

  rotate(refreshToken: string) {
    const sessionId = this.refresh.get(refreshToken);
    const old = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!sessionId || !old?.live) throw new UnauthorizedException('Invalid refresh session');
    old.live = false;
    const next = randomUUID();
    this.sessions.set(next, { ...old, live: true });
    return this.tokensFor(next);
  }

  actor(sessionId: string): ActorContext {
    const session = this.sessions.get(sessionId)!;
    if (session.kind === 'patient') {
      return { kind: 'patient', patientId: randomUUID(), id: `patient:${session.accountId}`,
        subject: `patient:${session.accountId}`, accountId: session.accountId, sessionId, roles: [], permissions: [],
        platformRoles: [], platformPermissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local' };
    }
    // As CurrentStaffContextService resolves it: no kind, the primary facility first and bound.
    const facilities = [...(this.memberships.get(session.accountId) ?? [])]
      .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary) || left.name.localeCompare(right.name));
    const bound = facilities[0]!;
    return { id: `staff:${session.accountId}`, subject: `staff:${session.accountId}`, accountId: session.accountId,
      sessionId, roles: bound.roles, role: bound.roles[0], permissions: bound.permissions, platformRoles: [],
      platformPermissions: [], facilityIds: facilities.map((candidate) => candidate.id), facilities, facility: bound,
      authenticationMethod: 'local' };
  }

  private tokensFor(sessionId: string) {
    const accessToken = `access-${sessionId}`;
    const refreshToken = `refresh-${sessionId}`;
    this.access.set(accessToken, sessionId);
    this.refresh.set(refreshToken, sessionId);
    return { sessionId, accessToken, refreshToken, csrfToken: `csrf-${refreshToken}` };
  }
}

describe('staff facility selection per sign-in', () => {
  const original = { ...process.env };
  let app: INestApplication;
  let store: SignInStore;
  let tokens: { verify: jest.Mock; verifyCsrf: jest.Mock; verifyRefreshCsrf: jest.Mock; refreshSessionKind: jest.Mock;
    selectedFacilityId: jest.Mock; recordFacilitySelection: jest.Mock };
  let audit: { record: jest.Mock; recordWithClient: jest.Mock };
  const auditClient = { query: jest.fn() };
  const accountId = randomUUID();
  const primary = facility('Alpha General', true, 'doctor');
  const secondary = facility('Beta Clinic', false, 'nurse');
  const elsewhere = facility('Gamma Hospital', true, 'doctor');

  beforeEach(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: ORIGIN, AUTH_MODE: 'local', STORAGE_MODE: 'disabled', AUTH_COOKIE_NAME: 'hid_access',
      AUTH_COOKIE_SECURE: 'false', TURNSTILE_MODE: 'disabled',
      AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
    resetEnvironmentForTests();
    store = new SignInStore();
    store.memberships.set(accountId, [secondary, primary]);
    store.memberships.set('other-account', [elsewhere]);
    tokens = {
      verify: jest.fn(async (token: string) => {
        if (token === OIDC_BEARER) {
          // As TokenService.verifyOidc resolves it (AUTH_MODE=oidc): no Identity sign-in, no session id.
          const { sessionId: _none, ...actor } = store.actor(store.signIn(accountId).sessionId);
          return { actor: { ...actor, authenticationMethod: 'oidc' }, claims: {} };
        }
        const sessionId = store.access.get(token);
        if (!sessionId || !store.sessions.get(sessionId)?.live) throw new UnauthorizedException('Session is no longer active');
        return { actor: store.actor(sessionId), claims: {} };
      }),
      verifyCsrf: jest.fn(() => false),
      verifyRefreshCsrf: jest.fn((refresh: string, cookie?: string, header?: string) =>
        cookie === `csrf-${refresh}` && header === cookie),
      refreshSessionKind: jest.fn(async () => undefined),
      selectedFacilityId: jest.fn(async (sessionId: string, account: string) => {
        const session = store.sessions.get(sessionId);
        if (!session?.live || session.kind !== 'staff' || session.accountId !== account) return undefined;
        return store.selections.get(session.familyId)?.facilityId;
      }),
      recordFacilitySelection: jest.fn(async (input: { sessionId: string; accountId: string; facilityId: string;
        membershipId: string }, _event: unknown, within: (client: unknown) => Promise<void>) => {
        const session = store.sessions.get(input.sessionId);
        if (!session?.live || session.kind !== 'staff' || session.accountId !== input.accountId) return 'session_ended';
        const active = (store.memberships.get(input.accountId) ?? [])
          .some((candidate) => candidate.id === input.facilityId && candidate.membershipId === input.membershipId);
        if (!active) return 'refused';
        await within(auditClient);
        store.selections.set(session.familyId, { facilityId: input.facilityId, membershipId: input.membershipId });
        return 'selected';
      }),
    };
    const auth = {
      login: jest.fn(async (_input: unknown, _event: unknown, kind: 'staff' | 'patient') => {
        const signIn = store.signIn(kind === 'patient' ? 'patient-account' : accountId, kind);
        return { actor: store.actor(signIn.sessionId), accessToken: signIn.accessToken, refreshToken: signIn.refreshToken,
          csrfToken: signIn.csrfToken, expiresAt: new Date(Date.now() + 900_000),
          refreshExpiresAt: new Date(Date.now() + 28_800_000) };
      }),
      refresh: jest.fn(async (refreshToken: string) => {
        const rotated = store.rotate(refreshToken);
        return { actor: store.actor(rotated.sessionId), accessToken: rotated.accessToken,
          refreshToken: rotated.refreshToken, csrfToken: rotated.csrfToken,
          expiresAt: new Date(Date.now() + 900_000), refreshExpiresAt: new Date(Date.now() + 28_800_000) };
      }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined), recordWithClient: jest.fn().mockResolvedValue(undefined) };
    // Runtime controls: the portals are enabled and maintenance mode is off.
    const database = { query: jest.fn(async (_sql: string, values: unknown[]) =>
      ({ rows: [{ enabled: values[0] !== 'maintenance_mode' }] })) };
    const module = await Test.createTestingModule({ controllers: [AuthController], providers: [
      { provide: AuthService, useValue: auth },
      { provide: TokenService, useValue: tokens },
      { provide: AuthSessionAuditService, useValue: { record: jest.fn() } },
      { provide: AuditService, useValue: audit },
      { provide: WorkloadAuthService, useValue: { authenticateService: jest.fn().mockResolvedValue({}) } },
      { provide: TurnstileService, useValue: { verifyLogin: jest.fn().mockResolvedValue(undefined) } },
      { provide: GoogleAuthenticationService, useValue: {} },
      { provide: DatabaseService, useValue: database },
    ] }).compile();
    app = module.createNestApplication({ logger: false });
    app.use(cookieParser());
    app.use((req: HidRequest, _res: Response, next: NextFunction) => { req.correlationId = randomUUID(); next(); });
    app.setGlobalPrefix('api/v1');
    // As main.ts configures it.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    app.useGlobalGuards(new SecurityGuard(module.get(Reflector), tokens as unknown as TokenService,
      audit as unknown as AuditService, database as unknown as DatabaseService));
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    process.env = { ...original };
    resetEnvironmentForTests();
  });

  const http = () => request(app.getHttpServer());
  const select = (accessToken: string, facilityId: unknown) => http().post('/api/v1/auth/facility')
    .set('Authorization', `Bearer ${accessToken}`).send({ facilityId });
  const session = (accessToken: string) => http().get('/api/v1/auth/session').set('Authorization', `Bearer ${accessToken}`);
  const refresh = (signIn: { refreshToken: string; csrfToken: string }) => http().post('/api/v1/auth/refresh')
    .set('Origin', ORIGIN).set('x-csrf-token', signIn.csrfToken)
    .set('Cookie', `hid_access_refresh=${signIn.refreshToken}; hid_access_csrf=${signIn.csrfToken}`);
  const selectionAudits = () => audit.recordWithClient.mock.calls.filter(([, event]) => event.action === 'auth.facility.select');

  it('persists the selection for the sign-in, audits it in the same transaction, and reports selected', async () => {
    const signIn = store.signIn(accountId);

    const response = await select(signIn.accessToken, secondary.id);

    expect(response.status).toBe(200);
    expect(response.body.facilitySelection).toBe('selected');
    expect(response.body.actor.facility).toMatchObject({ id: secondary.id, membershipId: secondary.membershipId });
    expect(response.body.actor).toMatchObject({ roles: ['nurse'], role: 'nurse', permissions: ['nurse.permission'] });
    expect(store.selections.get(signIn.sessionId)).toEqual({ facilityId: secondary.id, membershipId: secondary.membershipId });
    expect(tokens.recordFacilitySelection).toHaveBeenCalledWith(
      { sessionId: signIn.sessionId, accountId, facilityId: secondary.id, membershipId: secondary.membershipId },
      expect.objectContaining({ correlationId: expect.any(String) }), expect.any(Function));
    // The success audit is written on the selection's own transaction, so a
    // selection is never stored without it (nor audited without being stored).
    expect(selectionAudits()).toHaveLength(1);
    expect(selectionAudits()[0]![0]).toBe(auditClient);
    expect(selectionAudits()[0]![1]).toMatchObject({ actorType: 'staff', actorAccountId: accountId,
      actorMembershipId: secondary.membershipId, organizationId: secondary.organizationId, facilityId: secondary.id,
      resourceType: 'session', resourceId: signIn.sessionId, outcome: 'success' });
    expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.facility.select' }));
  });

  it('reports the default facility before any selection and the chosen facility after it (a reload)', async () => {
    const signIn = store.signIn(accountId);
    const before = await session(signIn.accessToken);
    expect(before.status).toBe(200);
    expect(before.body.facilitySelection).toBe('default');
    expect(before.body.actor.facility.id).toBe(primary.id);

    expect((await select(signIn.accessToken, secondary.id)).status).toBe(200);
    const after = await session(signIn.accessToken);

    expect(after.status).toBe(200);
    expect(after.body.facilitySelection).toBe('selected');
    expect(after.body.actor.facility.id).toBe(secondary.id);
    expect(after.body.actor).toMatchObject({ roles: ['nurse'], role: 'nurse', permissions: ['nurse.permission'],
      facilityIds: expect.arrayContaining([primary.id, secondary.id]) });
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'auth.session.read',
      facilityId: secondary.id, actorMembershipId: secondary.membershipId }));
  });

  it('keeps the selection across refresh: the rotated session belongs to the same sign-in', async () => {
    const signIn = store.signIn(accountId);
    expect((await select(signIn.accessToken, secondary.id)).status).toBe(200);

    const refreshed = await refresh(signIn);

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.facilitySelection).toBe('selected');
    expect(refreshed.body.actor.facility.id).toBe(secondary.id);
    expect(refreshed.body.actor.sessionId).not.toBe(signIn.sessionId);
    const reloaded = await session(`access-${refreshed.body.actor.sessionId}`);
    expect(reloaded.body).toMatchObject({ facilitySelection: 'selected', actor: { facility: { id: secondary.id } } });
  });

  it('reports reselect and the default facility once the selected membership has ended', async () => {
    const signIn = store.signIn(accountId);
    expect((await select(signIn.accessToken, secondary.id)).status).toBe(200);
    store.memberships.set(accountId, [primary]);

    const reloaded = await session(signIn.accessToken);
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.facilitySelection).toBe('reselect');
    expect(reloaded.body.actor.facility.id).toBe(primary.id);
    expect(reloaded.body.actor.facilityIds).toEqual([primary.id]);

    const refreshed = await refresh(signIn);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.facilitySelection).toBe('reselect');
    expect(refreshed.body.actor.facility.id).toBe(primary.id);
  });

  it('refuses a facility the actor is not active at with 403 and writes nothing', async () => {
    const signIn = store.signIn(accountId);
    expect((await select(signIn.accessToken, secondary.id)).status).toBe(200);
    tokens.recordFacilitySelection.mockClear();
    audit.recordWithClient.mockClear();

    const refused = await select(signIn.accessToken, elsewhere.id);

    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FACILITY_ACCESS_DENIED');
    expect(tokens.recordFacilitySelection).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
    expect(store.selections.get(signIn.sessionId)?.facilityId).toBe(secondary.id);
    expect((await session(signIn.accessToken)).body.actor.facility.id).toBe(secondary.id);
  });

  it('refuses with 403 and writes nothing when the database refuses the membership after the request was authorized', async () => {
    const signIn = store.signIn(accountId);
    tokens.recordFacilitySelection.mockResolvedValueOnce('refused');

    const refused = await select(signIn.accessToken, secondary.id);

    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FACILITY_ACCESS_DENIED');
    expect(store.selections.size).toBe(0);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('answers 401 and writes nothing when the sign-in ended while the selection waited for it', async () => {
    const signIn = store.signIn(accountId);
    tokens.recordFacilitySelection.mockResolvedValueOnce('session_ended');

    const refused = await select(signIn.accessToken, secondary.id);

    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('AUTHENTICATION_REQUIRED');
    expect(store.selections.size).toBe(0);
  });

  it.each([
    ['a malformed id', { facilityId: 'not-a-facility' }],
    ['a missing id', {}],
    ['an unexpected field', { facilityId: secondary.id, familyId: randomUUID() }],
  ])('answers 400 for %s and writes nothing', async (_label, body) => {
    const signIn = store.signIn(accountId);

    const refused = await http().post('/api/v1/auth/facility').set('Authorization', `Bearer ${signIn.accessToken}`).send(body);

    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('VALIDATION_FAILED');
    expect(tokens.recordFacilitySelection).not.toHaveBeenCalled();
    expect(store.selections.size).toBe(0);
  });

  it('leaves patient sessions unchanged: no selection is read, written or reported', async () => {
    const patient = store.signIn('patient-account', 'patient');

    const read = await session(patient.accessToken);
    expect(read.status).toBe(200);
    expect(read.body).not.toHaveProperty('facilitySelection');
    expect(read.body.actor.kind).toBe('patient');

    const refreshed = await refresh(patient);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).not.toHaveProperty('facilitySelection');

    const refused = await select(`access-${refreshed.body.actor.sessionId}`, secondary.id);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('PATIENT_SCOPE_DENIED');
    expect(tokens.selectedFacilityId).not.toHaveBeenCalled();
    expect(tokens.recordFacilitySelection).not.toHaveBeenCalled();
  });

  it('does not affect another sign-in of the same account', async () => {
    const first = store.signIn(accountId);
    const second = store.signIn(accountId);

    expect((await select(first.accessToken, secondary.id)).status).toBe(200);

    const other = await session(second.accessToken);
    expect(other.body.facilitySelection).toBe('default');
    expect(other.body.actor.facility.id).toBe(primary.id);
    const otherRefreshed = await refresh(second);
    expect(otherRefreshed.body).toMatchObject({ facilitySelection: 'default', actor: { facility: { id: primary.id } } });
    expect((await session(first.accessToken)).body.actor.facility.id).toBe(secondary.id);
  });

  it('reports default for a new staff sign-in and nothing for a patient sign-in', async () => {
    const staff = await http().post('/api/v1/auth/login').set('Origin', ORIGIN)
      .send({ email: 'staff@example.test', password: 'synthetic-password', turnstileAction: 'staff-login' });
    expect(staff.status).toBe(200);
    expect(staff.body).toMatchObject({ facilitySelection: 'default', actor: { facility: { id: primary.id } } });

    const patient = await http().post('/api/v1/auth/patient/login').set('Origin', ORIGIN)
      .send({ email: 'patient@example.test', password: 'synthetic-password', turnstileAction: 'patient-login' });
    expect(patient.status).toBe(200);
    expect(patient.body).not.toHaveProperty('facilitySelection');
    expect(tokens.selectedFacilityId).not.toHaveBeenCalled();
  });

  it('keeps the browser on the rotated session when the selection cannot be read after rotation: 503, new cookies, nothing cleared', async () => {
    const signIn = store.signIn(accountId);
    expect((await select(signIn.accessToken, secondary.id)).status).toBe(200);
    tokens.selectedFacilityId.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: '08006' }));

    const refreshed = await refresh(signIn);

    expect(refreshed.status).toBe(503);
    expect(refreshed.body.code).toBe('DEPENDENCY_UNAVAILABLE');
    // No actor at all: neither a facility the user did not choose nor the old session.
    expect(refreshed.body).not.toHaveProperty('actor');
    expect(refreshed.body).not.toHaveProperty('facilitySelection');
    const setCookies: string[] = refreshed.headers['set-cookie'] as unknown as string[];
    expect(setCookies.filter((cookie) => /Expires=Thu, 01 Jan 1970/i.test(cookie))).toEqual([]);
    const issued = Object.fromEntries(setCookies.map((cookie) => cookie.split(';')[0]!.split('=') as [string, string]));
    const rotatedSession = issued.hid_access!.slice('access-'.length);
    expect(rotatedSession).not.toBe(signIn.sessionId);
    expect(issued).toEqual({ hid_access: `access-${rotatedSession}`, hid_access_refresh: `refresh-${rotatedSession}`,
      hid_access_csrf: `csrf-refresh-${rotatedSession}` });
    expect(refreshed.headers['x-csrf-token']).toBe(`csrf-refresh-${rotatedSession}`);
    // The rotation committed: the old session is not live, the rotated one is,
    // and it still reports the sign-in's selection once the read succeeds.
    expect(store.sessions.get(signIn.sessionId)?.live).toBe(false);
    expect((await session(signIn.accessToken)).status).toBe(401);
    const reloaded = await session(issued.hid_access!);
    expect(reloaded.body).toMatchObject({ facilitySelection: 'selected', actor: { sessionId: rotatedSession,
      facility: { id: secondary.id } } });
    expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.refresh' }));
  });

  it('answers GET /auth/session with 503 and keeps the cookies when the selection cannot be read', async () => {
    const signIn = store.signIn(accountId);
    tokens.selectedFacilityId.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: '08006' }));

    const read = await http().get('/api/v1/auth/session')
      .set('Cookie', `hid_access=${signIn.accessToken}; hid_access_refresh=${signIn.refreshToken}; hid_access_csrf=${signIn.csrfToken}`);

    expect(read.status).toBe(503);
    expect(read.body.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(read.body).not.toHaveProperty('actor');
    expect(read.headers['set-cookie']).toBeUndefined();
    expect(store.sessions.get(signIn.sessionId)?.live).toBe(true);
  });

  it('answers a selection without an Identity sign-in (AUTH_MODE=oidc bearer) as before: audited, nothing stored, no field', async () => {
    const selected = await select(OIDC_BEARER, secondary.id);

    expect(selected.status).toBe(200);
    expect(selected.body).not.toHaveProperty('facilitySelection');
    expect(selected.body.actor).toMatchObject({ facility: { id: secondary.id }, roles: ['nurse'] });
    expect(selected.body.actor).not.toHaveProperty('sessionId');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.facility.select', outcome: 'success',
      actorAccountId: accountId, facilityId: secondary.id, actorMembershipId: secondary.membershipId }));
    expect(tokens.recordFacilitySelection).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
    expect(store.selections.size).toBe(0);

    const read = await session(OIDC_BEARER);
    expect(read.status).toBe(200);
    expect(read.body).not.toHaveProperty('facilitySelection');
    expect(tokens.selectedFacilityId).not.toHaveBeenCalled();
  });

  it('keeps X-Facility-ID authoritative: a valid header on GET /auth/session binds the reported facility', async () => {
    const signIn = store.signIn(accountId);
    expect((await select(signIn.accessToken, secondary.id)).status).toBe(200);

    const read = await session(signIn.accessToken).set('X-Facility-ID', primary.id);

    expect(read.body.actor.facility.id).toBe(primary.id);
    expect(read.body.facilitySelection).toBe('selected');
  });

  it('adds no query or field to the per-request service session', async () => {
    const signIn = store.signIn(accountId);
    expect((await select(signIn.accessToken, secondary.id)).status).toBe(200);
    tokens.selectedFacilityId.mockClear();

    const delegated = await http().get('/api/v1/auth/service-session').set('Authorization', `Bearer ${signIn.accessToken}`)
      .set('X-Facility-ID', primary.id).set('x-hid-internal-caller', 'ehr-api').set('x-hid-service-token', 'token');

    expect(delegated.status).toBe(200);
    expect(delegated.body).not.toHaveProperty('facilitySelection');
    expect(delegated.body.actor.facility.id).toBe(primary.id);
    expect(tokens.selectedFacilityId).not.toHaveBeenCalled();
  });
});
