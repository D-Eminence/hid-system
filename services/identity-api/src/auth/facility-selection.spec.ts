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
import { MfaService } from './mfa/mfa.service';
import { SecurityGuard } from './security.guard';
import { TokenService } from './token.service';
import { TurnstileService } from './turnstile.service';
import { WorkloadAuthService } from './workload-auth.service';

// A staff member's explicitly chosen working facility is kept per sign-in
// (0089, auth.session_facility_selection): a page reload, which reads
// GET /auth/session or refreshes, used to report the primary facility again.
// The stand-in below models only what the database guarantees: one selection
// per sign-in family, written for a live staff session of the same account and
// an active membership, read back only through a live session of the family.
// Every staff session here is MFA-verified (0088): a staff session is issued
// only after its second factor, and SecurityGuard authorizes nothing for one
// without live assurance (STAFF_MFA_REQUIRED).

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
  let mfa: { beginLogin: jest.Mock; completeLogin: jest.Mock; activateEnrollment: jest.Mock };
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
          // It carries no MFA assurance (0088).
          const { sessionId: _none, ...actor } = store.actor(store.signIn(accountId).sessionId);
          return { actor: { ...actor, authenticationMethod: 'oidc' }, claims: {}, mfaAssured: false };
        }
        const sessionId = store.access.get(token);
        if (!sessionId || !store.sessions.get(sessionId)?.live) throw new UnauthorizedException('Session is no longer active');
        // An Identity staff session is issued after its second factor (0088): its family has live assurance.
        return { actor: store.actor(sessionId), claims: {}, mfaAssured: store.sessions.get(sessionId)!.kind === 'staff' };
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
      // The rotation hook runs inside the rotation transaction, as TokenService runs it.
      refresh: jest.fn(async (refreshToken: string, _event: unknown,
        onRotated?: (client: unknown, actor: ReturnType<typeof store.actor>) => Promise<void>) => {
        const rotated = store.rotate(refreshToken);
        await onRotated?.({ rotation: rotated.sessionId }, store.actor(rotated.sessionId));
        return { actor: store.actor(rotated.sessionId), accessToken: rotated.accessToken,
          refreshToken: rotated.refreshToken, csrfToken: rotated.csrfToken,
          expiresAt: new Date(Date.now() + 900_000), refreshExpiresAt: new Date(Date.now() + 28_800_000) };
      }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined), recordWithClient: jest.fn().mockResolvedValue(undefined) };
    // Staff sign-in (0088): the password step yields only a challenge; the
    // session is issued by the second factor or by the first enrolment.
    const staffSession = () => {
      const signIn = store.signIn(accountId);
      return { actor: store.actor(signIn.sessionId), accessToken: signIn.accessToken, refreshToken: signIn.refreshToken,
        csrfToken: signIn.csrfToken, expiresAt: new Date(Date.now() + 900_000),
        refreshExpiresAt: new Date(Date.now() + 28_800_000) };
    };
    mfa = {
      beginLogin: jest.fn(async () => ({ token: 'synthetic-staff-challenge', purpose: 'verify',
        expiresAt: new Date(Date.now() + 300_000) })),
      completeLogin: jest.fn(async () => staffSession()),
      activateEnrollment: jest.fn(async () => ({ session: staffSession(), recoveryCodes: ['synthetic-recovery-a'] })),
    };
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
      { provide: MfaService, useValue: mfa },
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
  const challenge = 'hid_access_mfa=synthetic-staff-challenge';
  const mfaStep = (path: string, body: object) => http().post(`/api/v1/auth/mfa/${path}`).set('Origin', ORIGIN)
    .set('Cookie', challenge).send(body);
  const issuedAccess = (response: request.Response) => ((response.headers['set-cookie'] as unknown as string[]) ?? [])
    .find((cookie) => cookie.startsWith('hid_access='))!.split(';')[0]!.slice('hid_access='.length);

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

  it('reports nothing for a patient sign-in', async () => {
    const patient = await http().post('/api/v1/auth/patient/login').set('Origin', ORIGIN)
      .send({ email: 'patient@example.test', password: 'synthetic-password', turnstileAction: 'patient-login' });
    expect(patient.status).toBe(200);
    expect(patient.body).not.toHaveProperty('facilitySelection');
    expect(tokens.selectedFacilityId).not.toHaveBeenCalled();
  });

  it('answers a refresh whose selection read fails after the rotation with 200, the rotated cookies and facilitySelection unavailable, and clears nothing', async () => {
    const signIn = store.signIn(accountId);
    expect((await select(signIn.accessToken, secondary.id)).status).toBe(200);
    tokens.selectedFacilityId.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: '08006' }));

    const refreshed = await refresh(signIn);

    // Not a 5xx: behind the gateway a 5xx loses its Set-Cookie, and the
    // browser would keep the spent refresh token. The rotation has committed,
    // so the rotated session is answered, with a state that is not a choice:
    // the client asks where the user is working (it never takes the default
    // facility reported here as chosen).
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.facilitySelection).toBe('unavailable');
    expect(refreshed.body.actor.facility.id).toBe(primary.id);
    const setCookies: string[] = refreshed.headers['set-cookie'] as unknown as string[];
    const sessionCookies = setCookies.filter((cookie) => /^hid_access(_refresh|_csrf)?=/.test(cookie));
    expect(sessionCookies.filter((cookie) => /Expires=Thu, 01 Jan 1970/i.test(cookie))).toEqual([]);
    const issued = Object.fromEntries(sessionCookies.map((cookie) => cookie.split(';')[0]!.split('=') as [string, string]));
    const rotatedSession = issued.hid_access!.slice('access-'.length);
    expect(rotatedSession).not.toBe(signIn.sessionId);
    expect(refreshed.body.actor.sessionId).toBe(rotatedSession);
    expect(issued).toEqual({ hid_access: `access-${rotatedSession}`, hid_access_refresh: `refresh-${rotatedSession}`,
      hid_access_csrf: `csrf-refresh-${rotatedSession}` });
    expect(refreshed.headers['x-csrf-token']).toBe(`csrf-refresh-${rotatedSession}`);
    // The refresh happened and is audited in the rotation's own transaction,
    // at the facility the rotation resolved (the default, as reported).
    expect(audit.recordWithClient).toHaveBeenCalledWith({ rotation: rotatedSession }, expect.objectContaining({
      action: 'auth.refresh', outcome: 'success', resourceId: rotatedSession, facilityId: primary.id }));
    expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.refresh' }));
    // The stored choice is untouched: once it can be read again the rotated
    // session reports it.
    expect(store.sessions.get(signIn.sessionId)?.live).toBe(false);
    expect(store.selections.get(signIn.sessionId)?.facilityId).toBe(secondary.id);
    const reloaded = await session(issued.hid_access!);
    expect(reloaded.body).toMatchObject({ facilitySelection: 'selected', actor: { sessionId: rotatedSession,
      facility: { id: secondary.id } } });
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

  it('reports no facilitySelection and no actor at the password step, which issues no session (0088)', async () => {
    const step = await http().post('/api/v1/auth/login').set('Origin', ORIGIN)
      .send({ email: 'staff@example.test', password: 'synthetic-password', turnstileAction: 'staff-login' });

    expect(step.status).toBe(200);
    expect(step.body).toEqual({ status: 'mfa_required', expiresAt: expect.any(String) });
    expect(tokens.selectedFacilityId).not.toHaveBeenCalled();
    expect(tokens.recordFacilitySelection).not.toHaveBeenCalled();
  });

  it('reports facilitySelection default on the staff session issued after the second factor (POST /auth/mfa/verify)', async () => {
    const verified = await mfaStep('verify', { code: '123456' });

    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ facilitySelection: 'default', actor: { facility: { id: primary.id } } });
    expect(mfa.completeLogin).toHaveBeenCalledWith('synthetic-staff-challenge', { code: '123456' },
      expect.objectContaining({ correlationId: expect.any(String) }), 'staff');
    // A new sign-in has no selection to read.
    expect(tokens.selectedFacilityId).not.toHaveBeenCalled();

    // The selection applies to that session: chosen, then kept on a reload.
    const access = issuedAccess(verified);
    expect((await select(access, secondary.id)).body.facilitySelection).toBe('selected');
    expect((await session(access)).body).toMatchObject({ facilitySelection: 'selected',
      actor: { facility: { id: secondary.id } } });
  });

  it('reports facilitySelection default on the staff session issued by the first enrolment (POST /auth/mfa/enroll/activate)', async () => {
    const activated = await mfaStep('enroll/activate', { code: '654321' });

    expect(activated.status).toBe(200);
    expect(activated.body).toMatchObject({ facilitySelection: 'default', actor: { facility: { id: primary.id } },
      recoveryCodes: ['synthetic-recovery-a'] });
    expect(tokens.selectedFacilityId).not.toHaveBeenCalled();
  });

  it('refuses an external OIDC bearer token (no MFA assurance) before any selection is read or stored', async () => {
    // Since staff MFA (0088) SecurityGuard authorizes nothing for a staff
    // token without live assurance, which an AUTH_MODE=oidc token never has.
    const selected = await select(OIDC_BEARER, secondary.id);

    expect(selected.status).toBe(403);
    expect(selected.body.code).toBe('STAFF_MFA_REQUIRED');
    expect(tokens.recordFacilitySelection).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.facility.select', outcome: 'success' }));
    expect(store.selections.size).toBe(0);

    const read = await session(OIDC_BEARER);
    expect(read.status).toBe(403);
    expect(read.body.code).toBe('STAFF_MFA_REQUIRED');
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
