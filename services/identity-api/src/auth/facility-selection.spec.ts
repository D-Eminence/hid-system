jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { randomUUID } from 'node:crypto';
import { Logger, UnauthorizedException, ValidationPipe, type INestApplication } from '@nestjs/common';
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
import { facilityAdmittedOnProduct, type StaffProduct } from './product-gate';
import { SecurityGuard } from './security.guard';
import { TokenService } from './token.service';
import { TurnstileService } from './turnstile.service';
import { WorkloadAuthService } from './workload-auth.service';

// 0129 (port of main 0089, #73): a staff sign-in keeps the facility it chose
// with POST /auth/facility, so a reload (GET /auth/session) or a refresh after
// the access token runs out opens there again, behind
// STAFF_FACILITY_SELECTION_MODE (off, the default, keep or ask).
//
// The stand-in below models what the database guarantees (0129's guard and
// TokenService's SQL, exercised by session-facility-selection.integration.sql
// and facility-selection-store.spec.ts): one choice per sign-in family,
// written for a live staff session of the same account and an active
// membership, read back only through a live staff session of the family. The
// actor is resolved as CurrentStaffContextService resolves it: a staff actor
// has no kind, its facilities are those admitted on the session's own product
// (Q88, with Q97's own-job rule: facilityAdmittedOnProduct), the primary
// facility first and bound.
//
// The app runs with main.ts's pipe and filter and SecurityGuard, without the
// global AuditInterceptor: these are the handler's own answers. Through the
// interceptor a refusal without X-Facility-ID still answers 503 on staging
// today (#258 question 3); the runtime verifier records that separately.

const EHR = 'https://ehr.staging.healthidentitydirectory.com';
const LAB = 'https://lab.staging.healthidentitydirectory.com';
const OUTREACH = 'https://outreach.staging.healthidentitydirectory.com';
const ADMIN = 'https://admin.staging.healthidentitydirectory.com';
const OIDC_BEARER = 'external-oidc-access-token';
const LOG_EVENT = 'auth.facility_selection.unavailable';

type Mode = 'off' | 'keep' | 'ask';

const facility = (name: string, primary: boolean, role: string, permissions: string[],
  id: string = randomUUID()): FacilityAssignment => ({
  id, membershipId: randomUUID(), organizationId: randomUUID(), name, roles: [role],
  permissions: [...permissions, `${role}.synthetic`], isPrimary: primary,
});

// Fictional workforce. The doctor and nurse memberships are hospital clinical
// ones, admitted on ehr. (and migrate.) only since Q97; the laboratory ones
// are admitted on lab. only.
const primary = facility('Fictional Alpha General', true, 'doctor', ['ehr.encounter.write']);
const secondary = facility('Fictional Beta Clinic', false, 'nurse', ['ehr.encounter.write']);
const laboratory = facility('Fictional Gamma Laboratory', false, 'lab', ['lab.work-item.read']);
// A second laboratory, for the lab. sign-ins that need two facilities there.
const epsilonLaboratory = facility('Fictional Epsilon Laboratory', false, 'lab', ['lab.work-item.read']);
const elsewhere = facility('Fictional Delta Hospital', true, 'doctor', ['ehr.encounter.write']);

interface StoredSession { familyId: string; accountId: string; kind: 'staff' | 'patient'; live: boolean; product?: StaffProduct }

class SignInStore {
  readonly sessions = new Map<string, StoredSession>();
  readonly access = new Map<string, string>();
  readonly refresh = new Map<string, string>();
  readonly selections = new Map<string, { facilityId: string; membershipId: string }>();
  readonly memberships = new Map<string, FacilityAssignment[]>();
  readonly platformAdmins = new Set<string>();

  signIn(accountId: string, kind: 'staff' | 'patient' = 'staff', product?: StaffProduct) {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { familyId: sessionId, accountId, kind, live: true,
      ...(kind === 'staff' && product ? { product } : {}) });
    this.actor(sessionId);
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
    return this.staffActor(session.accountId, session.product, sessionId);
  }

  /** As CurrentStaffContextService resolves it under the session's product: no kind, primary first and bound. */
  staffActor(accountId: string, product?: StaffProduct, sessionId?: string): ActorContext {
    const all = this.memberships.get(accountId) ?? [];
    const fitting = product ? all.filter((candidate) => facilityAdmittedOnProduct(candidate, product)) : all;
    const facilities = [...fitting].sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary)
      || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    const bound = facilities[0];
    const base = { id: `staff:${accountId}`, subject: `staff:${accountId}`, accountId,
      ...(sessionId ? { sessionId } : {}), platformRoles: [] as string[], facilityIds: facilities.map((f) => f.id),
      facilities, authenticationMethod: 'local' as const };
    if (bound) {
      return { ...base, roles: bound.roles, role: bound.roles[0], permissions: bound.permissions,
        platformPermissions: [], facility: bound };
    }
    if (!product && this.platformAdmins.has(accountId)) {
      return { ...base, roles: [], permissions: [], platformRoles: ['platform_super_admin'],
        platformPermissions: ['platform.admin.access'] };
    }
    if (product === 'outreach') return { ...base, roles: [], permissions: [], platformPermissions: [], accountOnly: true };
    throw new UnauthorizedException('Session no longer fits this site');
  }

  private tokensFor(sessionId: string) {
    const accessToken = `access-${sessionId}`;
    const refreshToken = `refresh-${sessionId}`;
    this.access.set(accessToken, sessionId);
    this.refresh.set(refreshToken, sessionId);
    return { sessionId, accessToken, refreshToken, csrfToken: `csrf-${refreshToken}` };
  }
}

describe('a staff member\'s chosen facility, kept per sign-in (0129)', () => {
  const original = { ...process.env };
  let app: INestApplication | undefined;
  let store: SignInStore;
  let tokens: { verify: jest.Mock; verifyCsrf: jest.Mock; verifyRefreshCsrf: jest.Mock;
    selectedFacilityId: jest.Mock; recordFacilitySelection: jest.Mock };
  let audit: { record: jest.Mock; recordWithClient: jest.Mock };
  let auth: { login: jest.Mock; refresh: jest.Mock; revoke: jest.Mock };
  let google: { login: jest.Mock; exchange: jest.Mock; onboardingStatus: jest.Mock; onboardingCookieName: string };
  let warn: jest.SpyInstance;
  const auditClient = { query: jest.fn() };
  const accountId = randomUUID();
  const otherAccount = randomUUID();
  const outreachOnlyAccount = randomUUID();
  const platformAdminAccount = randomUUID();
  const patientAccount = randomUUID();
  const emails: Record<string, string> = {
    'staff@example.invalid': accountId,
    'organiser@example.invalid': outreachOnlyAccount,
    'administrator@example.invalid': platformAdminAccount,
    'patient@example.invalid': patientAccount,
  };

  const issued = (signIn: { sessionId: string; accessToken: string; refreshToken: string; csrfToken: string }) => ({
    actor: store.actor(signIn.sessionId), accessToken: signIn.accessToken, refreshToken: signIn.refreshToken,
    csrfToken: signIn.csrfToken, expiresAt: new Date(Date.now() + 900_000),
    refreshExpiresAt: new Date(Date.now() + 28_800_000) });

  beforeEach(() => {
    store = new SignInStore();
    store.memberships.set(accountId, [secondary, primary, laboratory]);
    store.memberships.set(otherAccount, [elsewhere]);
    store.platformAdmins.add(platformAdminAccount);
    auditClient.query.mockReset();
    tokens = {
      verify: jest.fn(async (token: string) => {
        if (token === OIDC_BEARER) {
          // As TokenService.verifyOidc resolves it (AUTH_MODE=oidc): no Identity sign-in, no session id.
          return { actor: { ...store.staffActor(accountId), authenticationMethod: 'oidc' }, claims: {} };
        }
        const sessionId = store.access.get(token);
        if (!sessionId || !store.sessions.get(sessionId)?.live) throw new UnauthorizedException('Session is no longer active');
        return { actor: store.actor(sessionId), claims: {} };
      }),
      verifyCsrf: jest.fn(() => false),
      verifyRefreshCsrf: jest.fn((refresh: string, cookie?: string, header?: string) =>
        cookie === `csrf-${refresh}` && header === cookie),
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
    auth = {
      login: jest.fn(async (input: { email: string }, event: { product?: StaffProduct }, kind: 'staff' | 'patient') =>
        issued(store.signIn(emails[input.email] ?? randomUUID(), kind, event.product))),
      // As TokenService.refresh (Q88-1): the product rides in the refresh token,
      // and a refresh whose Origin names another product ends with 401.
      refresh: jest.fn(async (refreshToken: string, event: { product?: StaffProduct }) => {
        const session = store.sessions.get(store.refresh.get(refreshToken) ?? '');
        if (session?.kind === 'staff' && session.product && event.product !== session.product) {
          throw new UnauthorizedException('Refresh session belongs to another site');
        }
        return issued(store.rotate(refreshToken));
      }),
      revoke: jest.fn(async (sessionId?: string) => {
        const session = sessionId ? store.sessions.get(sessionId) : undefined;
        if (session) session.live = false;
      }),
    };
    google = {
      login: jest.fn(async (_idToken: string, _nonce: string, kind: 'staff' | 'patient', event: { product?: StaffProduct }) =>
        issued(store.signIn(kind === 'patient' ? patientAccount : accountId, kind, event.product))),
      exchange: jest.fn(), onboardingStatus: jest.fn(), onboardingCookieName: 'hid_access_google_onboarding',
    };
    audit = { record: jest.fn().mockResolvedValue(undefined), recordWithClient: jest.fn().mockResolvedValue(undefined) };
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

  async function boot(mode: Mode | undefined): Promise<void> {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: [EHR, LAB, OUTREACH, ADMIN].join(','), AUTH_MODE: 'local', AUTH_COOKIE_NAME: 'hid_access',
      AUTH_COOKIE_SECURE: 'false', TURNSTILE_MODE: 'disabled',
      AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
    if (mode === undefined) delete process.env.STAFF_FACILITY_SELECTION_MODE;
    else process.env.STAFF_FACILITY_SELECTION_MODE = mode;
    resetEnvironmentForTests();
    // Runtime controls: the portals are enabled and maintenance mode is off.
    const database = { query: jest.fn(async (_sql: string, values: unknown[]) =>
      ({ rows: [{ enabled: values[0] !== 'maintenance_mode' }] })) };
    const module = await Test.createTestingModule({ controllers: [AuthController], providers: [
      { provide: AuthService, useValue: auth },
      { provide: TokenService, useValue: tokens },
      { provide: AuthSessionAuditService, useValue: { record: jest.fn(), recordLoginFailure: jest.fn() } },
      { provide: AuditService, useValue: audit },
      { provide: WorkloadAuthService, useValue: { authenticateService: jest.fn().mockResolvedValue({}) } },
      { provide: TurnstileService, useValue: { verifyLogin: jest.fn().mockResolvedValue(undefined) } },
      { provide: GoogleAuthenticationService, useValue: google },
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
  }

  const http = () => request(app!.getHttpServer());
  const select = (accessToken: string, facilityId: unknown, origin = EHR) => http().post('/api/v1/auth/facility')
    .set('Authorization', `Bearer ${accessToken}`).set('Origin', origin).send({ facilityId });
  const session = (accessToken: string) => http().get('/api/v1/auth/session').set('Authorization', `Bearer ${accessToken}`);
  const refresh = (signIn: { refreshToken: string; csrfToken: string }, origin = EHR) => http().post('/api/v1/auth/refresh')
    .set('Origin', origin).set('x-csrf-token', signIn.csrfToken)
    .set('Cookie', `hid_access_refresh=${signIn.refreshToken}; hid_access_csrf=${signIn.csrfToken}`);
  const login = (email: string, origin = EHR) => http().post('/api/v1/auth/login').set('Origin', origin)
    .send({ email, password: 'synthetic-password', turnstileAction: 'staff-login' });
  const setCookies = (response: request.Response) => (response.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const accessFrom = (response: request.Response) => setCookies(response)
    .find((cookie) => cookie.startsWith('hid_access='))!.split(';')[0]!.slice('hid_access='.length);
  const selectionAudits = () => audit.recordWithClient.mock.calls.filter(([, event]) => event.action === 'auth.facility.select');
  const recorded = (action: string) => audit.record.mock.calls.map(([event]) => event).filter((event) => event.action === action);
  const selectionLogs = () => warn.mock.calls.filter(([message]) => typeof message === 'object' && message !== null
    && (message as { event?: unknown }).event === LOG_EVENT);
  const familyOf = (sessionId: string) => store.sessions.get(sessionId)!.familyId;

  describe('STAFF_FACILITY_SELECTION_MODE off (the default): today\'s answers, nothing read or stored', () => {
    it.each([['unset', undefined], ['off', 'off']] as const)('%s: no field anywhere, no read, no store', async (_label, mode) => {
      await boot(mode);
      const signedIn = await login('staff@example.invalid');
      expect(signedIn.status).toBe(200);
      expect(signedIn.body).not.toHaveProperty('facilitySelection');
      const access = accessFrom(signedIn);
      const sessionId: string = signedIn.body.actor.sessionId;
      // Even a stored row (written while the setting was on) is ignored.
      store.selections.set(familyOf(sessionId), { facilityId: secondary.id, membershipId: secondary.membershipId });

      const read = await session(access);
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ actor: expect.objectContaining({ facility: expect.objectContaining({ id: primary.id }) }) });

      const chosen = await select(access, secondary.id);
      expect(chosen.status).toBe(200);
      expect(chosen.body).toEqual({ actor: expect.objectContaining({ facility: expect.objectContaining({ id: secondary.id }) }) });
      // Today's audit row, on its own: nothing is written in a transaction.
      expect(recorded('auth.facility.select')).toHaveLength(1);
      expect(recorded('auth.facility.select')[0]).toMatchObject({ facilityId: secondary.id, outcome: 'success' });

      const signIn = { refreshToken: `refresh-${sessionId}`, csrfToken: `csrf-refresh-${sessionId}` };
      const refreshed = await refresh(signIn);
      expect(refreshed.status).toBe(200);
      expect(refreshed.body).not.toHaveProperty('facilitySelection');
      expect(refreshed.body.actor.facility.id).toBe(primary.id);

      expect(tokens.selectedFacilityId).not.toHaveBeenCalled();
      expect(tokens.recordFacilitySelection).not.toHaveBeenCalled();
      expect(audit.recordWithClient).not.toHaveBeenCalled();
      expect(selectionLogs()).toHaveLength(0);
    });
  });

  describe.each(['keep', 'ask'] as const)('STAFF_FACILITY_SELECTION_MODE %s', (mode) => {
    beforeEach(async () => { await boot(mode); });

    it('stores the choice for the sign-in with its audit row on the same transaction, and answers selected', async () => {
      const signIn = store.signIn(accountId, 'staff', 'ehr');

      const response = await select(signIn.accessToken, secondary.id);

      expect(response.status).toBe(200);
      expect(response.body.facilitySelection).toBe('selected');
      expect(response.body.actor.facility).toMatchObject({ id: secondary.id, membershipId: secondary.membershipId });
      expect(response.body.actor).toMatchObject({ roles: ['nurse'], role: 'nurse', permissions: secondary.permissions });
      expect(store.selections.get(signIn.sessionId)).toEqual({ facilityId: secondary.id, membershipId: secondary.membershipId });
      expect(tokens.recordFacilitySelection).toHaveBeenCalledWith(
        { sessionId: signIn.sessionId, accountId, facilityId: secondary.id, membershipId: secondary.membershipId },
        expect.objectContaining({ correlationId: expect.any(String), product: 'ehr' }), expect.any(Function));
      // Written on the store's own transaction, so a choice is never stored
      // without its audit row, nor audited without being stored.
      expect(selectionAudits()).toHaveLength(1);
      expect(selectionAudits()[0]![0]).toBe(auditClient);
      expect(selectionAudits()[0]![1]).toMatchObject({ actorType: 'staff', actorAccountId: accountId,
        actorMembershipId: secondary.membershipId, organizationId: secondary.organizationId, facilityId: secondary.id,
        action: 'auth.facility.select', resourceType: 'session', resourceId: signIn.sessionId, outcome: 'success' });
      expect(recorded('auth.facility.select')).toHaveLength(0);
    });

    it('opens at the chosen facility on a reload, audited there', async () => {
      const signIn = store.signIn(accountId, 'staff', 'ehr');
      const before = await session(signIn.accessToken);
      expect(before.status).toBe(200);
      expect(before.body.actor.facility.id).toBe(primary.id);
      if (mode === 'keep') expect(before.body).not.toHaveProperty('facilitySelection');
      else expect(before.body.facilitySelection).toBe('default');

      expect((await select(signIn.accessToken, secondary.id)).status).toBe(200);
      const after = await session(signIn.accessToken);

      expect(after.status).toBe(200);
      expect(after.body.facilitySelection).toBe('selected');
      expect(after.body.actor.facility.id).toBe(secondary.id);
      expect(after.body.actor).toMatchObject({ roles: ['nurse'], role: 'nurse', permissions: secondary.permissions,
        facilityIds: expect.arrayContaining([primary.id, secondary.id]) });
      expect(recorded('auth.session.read').at(-1)).toMatchObject({ facilityId: secondary.id,
        actorMembershipId: secondary.membershipId, organizationId: secondary.organizationId, resourceId: signIn.sessionId });
      expect(tokens.selectedFacilityId).toHaveBeenLastCalledWith(signIn.sessionId, accountId);
    });

    it('keeps the choice across a refresh, read after the rotation through the new session and audited there', async () => {
      const signIn = store.signIn(accountId, 'staff', 'ehr');
      expect((await select(signIn.accessToken, secondary.id)).status).toBe(200);
      tokens.selectedFacilityId.mockClear();

      const refreshed = await refresh(signIn);

      expect(refreshed.status).toBe(200);
      const rotated: string = refreshed.body.actor.sessionId;
      expect(rotated).not.toBe(signIn.sessionId);
      expect(refreshed.body).toMatchObject({ facilitySelection: 'selected', expiresAt: expect.any(String),
        actor: { facility: { id: secondary.id }, roles: ['nurse'] } });
      expect(tokens.selectedFacilityId).toHaveBeenCalledTimes(1);
      expect(tokens.selectedFacilityId).toHaveBeenCalledWith(rotated, accountId);
      expect(tokens.selectedFacilityId.mock.invocationCallOrder[0]!).toBeGreaterThan(auth.refresh.mock.invocationCallOrder[0]!);
      expect(recorded('auth.refresh')).toHaveLength(1);
      expect(recorded('auth.refresh')[0]).toMatchObject({ actorType: 'staff', facilityId: secondary.id,
        actorMembershipId: secondary.membershipId, resourceId: rotated, outcome: 'success' });
      const reloaded = await session(`access-${rotated}`);
      expect(reloaded.body).toMatchObject({ facilitySelection: 'selected', actor: { facility: { id: secondary.id } } });
    });

    it('reports reselect at the default facility once the chosen membership has ended, and keeps the row', async () => {
      const signIn = store.signIn(accountId, 'staff', 'ehr');
      expect((await select(signIn.accessToken, secondary.id)).status).toBe(200);
      store.memberships.set(accountId, [primary, laboratory]);

      const reloaded = await session(signIn.accessToken);
      expect(reloaded.status).toBe(200);
      expect(reloaded.body.facilitySelection).toBe('reselect');
      expect(reloaded.body.actor.facility.id).toBe(primary.id);
      expect(reloaded.body.actor.facilityIds).toEqual([primary.id]);
      expect(recorded('auth.session.read').at(-1)).toMatchObject({ facilityId: primary.id });

      const refreshed = await refresh(signIn);
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.facilitySelection).toBe('reselect');
      expect(refreshed.body.actor.facility.id).toBe(primary.id);
      expect(recorded('auth.refresh').at(-1)).toMatchObject({ facilityId: primary.id, actorMembershipId: primary.membershipId });
      expect(store.selections.get(signIn.sessionId)).toEqual({ facilityId: secondary.id, membershipId: secondary.membershipId });
    });

    it('matches the stored facility by id only, reporting the membership the guard binds for X-Facility-ID', async () => {
      // Two roles at one facility (no one-membership-per-facility index on
      // staging): the stored membership is not the one reported; the first
      // match in actor.facilities is, as SecurityGuard binds X-Facility-ID.
      const shared = randomUUID();
      const asNurse = facility('Fictional Epsilon Hospital', false, 'nurse', ['ehr.encounter.write'], shared);
      const asAdmin = facility('Fictional Epsilon Hospital', false, 'admin', ['organization.manage'], shared);
      store.memberships.set(accountId, [primary, asAdmin, asNurse]);
      const signIn = store.signIn(accountId, 'staff', 'ehr');
      const firstMatch = store.actor(signIn.sessionId).facilities.find((candidate) => candidate.id === shared)!;
      const other = firstMatch.membershipId === asNurse.membershipId ? asAdmin : asNurse;
      store.selections.set(signIn.sessionId, { facilityId: shared, membershipId: other.membershipId });

      const reloaded = await session(signIn.accessToken);
      const bound = await session(signIn.accessToken).set('X-Facility-ID', shared);

      expect(reloaded.body.facilitySelection).toBe('selected');
      expect(reloaded.body.actor.facility.membershipId).toBe(firstMatch.membershipId);
      expect(reloaded.body.actor.facility.membershipId).toBe(bound.body.actor.facility.membershipId);
      expect(reloaded.body.actor.roles).toEqual(bound.body.actor.roles);
      expect(reloaded.body.actor.permissions).toEqual(bound.body.actor.permissions);
    });

    it('keeps X-Facility-ID authoritative: a valid header binds the reported facility', async () => {
      const signIn = store.signIn(accountId, 'staff', 'ehr');
      expect((await select(signIn.accessToken, secondary.id)).status).toBe(200);

      const read = await session(signIn.accessToken).set('X-Facility-ID', primary.id);

      expect(read.body.actor.facility.id).toBe(primary.id);
      expect(read.body.actor.roles).toEqual(['doctor']);
      expect(read.body.facilitySelection).toBe('selected');
      expect(recorded('auth.session.read').at(-1)).toMatchObject({ facilityId: primary.id });
    });

    it('re-checks the choice against the facilities of the session\'s own product, never the request\'s Origin', async () => {
      // Since Q97 the lab. sign-in holds the two laboratories only, not the
      // doctor's or the nurse's hospital memberships.
      store.memberships.set(accountId, [secondary, primary, laboratory, epsilonLaboratory]);
      const signIn = store.signIn(accountId, 'staff', 'lab');
      expect([...store.actor(signIn.sessionId).facilityIds].sort()).toEqual([laboratory.id, epsilonLaboratory.id].sort());
      expect((await select(signIn.accessToken, laboratory.id, LAB)).status).toBe(200);

      // An Origin whose product the laboratory does not fit changes nothing:
      // the session's own product (its token claim) decides.
      const fromEhr = await session(signIn.accessToken).set('Origin', EHR);
      expect(fromEhr.body).toMatchObject({ facilitySelection: 'selected', actor: { facility: { id: laboratory.id } } });

      // The laboratory membership now holds only an outreach role: it no
      // longer fits the session's product, so the choice is reselect, even
      // with an Origin whose product it would fit.
      store.memberships.set(accountId, [secondary, primary,
        { ...laboratory, roles: ['outreach_volunteer'], permissions: ['outreach.registration.read'] }, epsilonLaboratory]);
      const fromOutreach = await session(signIn.accessToken).set('Origin', OUTREACH);
      expect(fromOutreach.body.facilitySelection).toBe('reselect');
      expect(fromOutreach.body.actor.facility.id).toBe(epsilonLaboratory.id);
      expect(fromOutreach.body.actor.facilityIds).not.toContain(laboratory.id);
    });

    it('ends a refresh from another site with 401 and clears the cookies before any read', async () => {
      const signIn = store.signIn(accountId, 'staff', 'ehr');
      expect((await select(signIn.accessToken, secondary.id)).status).toBe(200);
      tokens.selectedFacilityId.mockClear();

      const refused = await refresh(signIn, LAB);

      expect(refused.status).toBe(401);
      expect(refused.body).not.toHaveProperty('facilitySelection');
      expect(setCookies(refused).filter((cookie) => /^hid_access(_refresh|_csrf)?=;/.test(cookie))).toHaveLength(3);
      expect(tokens.selectedFacilityId).not.toHaveBeenCalled();
      expect(recorded('auth.refresh')).toHaveLength(0);
    });

    it('refuses a choice sent from another site\'s Origin, or of a facility not the actor\'s, with 403 and stores nothing',
      async () => {
        store.memberships.set(accountId, [secondary, primary, laboratory, epsilonLaboratory]);
        const signIn = store.signIn(accountId, 'staff', 'lab');
        expect((await select(signIn.accessToken, laboratory.id, LAB)).status).toBe(200);
        tokens.recordFacilitySelection.mockClear();
        audit.recordWithClient.mockClear();

        // The lab. sign-in holds the laboratories, which ehr.'s product does
        // not admit: a choice of one sent with ehr.'s Origin is refused.
        expect(store.actor(signIn.sessionId).facilityIds).toContain(epsilonLaboratory.id);
        const fromEhr = await select(signIn.accessToken, epsilonLaboratory.id, EHR);
        expect(fromEhr.status).toBe(403);
        expect(fromEhr.body.code).toBe('FACILITY_ACCESS_DENIED');

        const elsewhereChoice = await select(signIn.accessToken, elsewhere.id, LAB);
        expect(elsewhereChoice.status).toBe(403);
        expect(elsewhereChoice.body.code).toBe('FACILITY_ACCESS_DENIED');

        expect(tokens.recordFacilitySelection).not.toHaveBeenCalled();
        expect(audit.recordWithClient).not.toHaveBeenCalled();
        expect(store.selections.get(signIn.sessionId)?.facilityId).toBe(laboratory.id);
        expect((await session(signIn.accessToken)).body.actor.facility.id).toBe(laboratory.id);
      });

    it('stores only a facility that fits the Origin\'s product for a session issued before the gate', async () => {
      // No product in the session (issued before Q88): the Origin filters the choice.
      const signIn = store.signIn(accountId, 'staff');
      expect(store.actor(signIn.sessionId).facilityIds).toContain(laboratory.id);

      const refused = await select(signIn.accessToken, laboratory.id, EHR);

      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('FACILITY_ACCESS_DENIED');
      expect(tokens.recordFacilitySelection).not.toHaveBeenCalled();
      expect(store.selections.size).toBe(0);
    });

    it('answers 401 and stores nothing when the sign-in ended while the choice waited for it', async () => {
      const signIn = store.signIn(accountId, 'staff', 'ehr');
      tokens.recordFacilitySelection.mockResolvedValueOnce('session_ended');

      const refused = await select(signIn.accessToken, secondary.id);

      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe('AUTHENTICATION_REQUIRED');
      expect(refused.body).not.toHaveProperty('actor');
      expect(store.selections.size).toBe(0);
      expect(audit.recordWithClient).not.toHaveBeenCalled();
    });

    it('answers 403 and stores nothing when the database guard refuses the membership', async () => {
      const signIn = store.signIn(accountId, 'staff', 'ehr');
      tokens.recordFacilitySelection.mockResolvedValueOnce('refused');

      const refused = await select(signIn.accessToken, secondary.id);

      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('FACILITY_ACCESS_DENIED');
      expect(store.selections.size).toBe(0);
      expect(audit.recordWithClient).not.toHaveBeenCalled();
    });

    it.each([
      ['a database error that is not the guard\'s', Object.assign(new Error('connection reset'), { code: '08006' })],
      ['a missing grant', Object.assign(new Error('permission denied'), { code: '42501' })],
      ['an unexpected answer', new Error('Facility selection was not stored')],
    ])('answers 503 DEPENDENCY_UNAVAILABLE with nothing stored for %s, and logs one event with no identifiers',
      async (_label, failure) => {
        const signIn = store.signIn(accountId, 'staff', 'ehr');
        tokens.recordFacilitySelection.mockRejectedValueOnce(failure);

        const refused = await select(signIn.accessToken, secondary.id);

        expect(refused.status).toBe(503);
        expect(refused.body.code).toBe('DEPENDENCY_UNAVAILABLE');
        expect(refused.body).not.toHaveProperty('actor');
        expect(store.selections.size).toBe(0);
        expect(selectionLogs()).toHaveLength(1);
        expect(selectionLogs()[0]![0]).toEqual({ event: LOG_EVENT, operation: 'store' });
        const logged = JSON.stringify(warn.mock.calls);
        for (const identifier of [signIn.sessionId, accountId, secondary.id, secondary.membershipId, `staff:${accountId}`]) {
          expect(logged).not.toContain(identifier);
        }
      });

    it('answers 503 with nothing stored when the audit row cannot be written on the store\'s transaction', async () => {
      const signIn = store.signIn(accountId, 'staff', 'ehr');
      // A raw database error (recordWithClient does not map its own) and the
      // audit layer's refusal are both 503, never 500.
      for (const failure of [Object.assign(new Error('audit insert failed'), { code: '23514' }),
        new Error('Staff audit events require a resolved facility context')]) {
        audit.recordWithClient.mockRejectedValueOnce(failure);
        const refused = await select(signIn.accessToken, secondary.id);
        expect(refused.status).toBe(503);
        expect(refused.body.code).toBe('DEPENDENCY_UNAVAILABLE');
      }
      expect(store.selections.size).toBe(0);
    });

    it.each([
      ['a malformed id', { facilityId: 'not-a-facility' }],
      ['a missing id', {}],
      ['an unexpected field', { facilityId: secondary.id, familyId: randomUUID() }],
    ])('answers 400 for %s and stores nothing', async (_label, body) => {
      const signIn = store.signIn(accountId, 'staff', 'ehr');

      const refused = await http().post('/api/v1/auth/facility').set('Authorization', `Bearer ${signIn.accessToken}`)
        .set('Origin', EHR).send(body);

      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
      expect(tokens.recordFacilitySelection).not.toHaveBeenCalled();
      expect(store.selections.size).toBe(0);
    });

    it('answers a refresh whose read fails with 200, the rotated cookies and unavailable at the default facility', async () => {
      const signIn = store.signIn(accountId, 'staff', 'ehr');
      expect((await select(signIn.accessToken, secondary.id)).status).toBe(200);
      tokens.selectedFacilityId.mockRejectedValueOnce(
        Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));

      const refreshed = await refresh(signIn);

      // The rotation committed before the read; a 5xx would leave the
      // sign-in unrenewable while the choice is unreadable. 'unavailable' is
      // never a choice: the website asks where the user is working.
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.facilitySelection).toBe('unavailable');
      expect(refreshed.body.actor.facility.id).toBe(primary.id);
      const rotated: string = refreshed.body.actor.sessionId;
      const sessionCookies = setCookies(refreshed).filter((cookie) => /^hid_access(_refresh|_csrf)?=/.test(cookie));
      expect(sessionCookies.filter((cookie) => /Expires=Thu, 01 Jan 1970/i.test(cookie))).toEqual([]);
      expect(Object.fromEntries(sessionCookies.map((cookie) => cookie.split(';')[0]!.split('=') as [string, string])))
        .toEqual({ hid_access: `access-${rotated}`, hid_access_refresh: `refresh-${rotated}`,
          hid_access_csrf: `csrf-refresh-${rotated}` });
      expect(refreshed.headers['x-csrf-token']).toBe(`csrf-refresh-${rotated}`);
      expect(recorded('auth.refresh').at(-1)).toMatchObject({ facilityId: primary.id, resourceId: rotated });
      expect(selectionLogs()).toHaveLength(1);
      expect(selectionLogs()[0]![0]).toEqual({ event: LOG_EVENT, operation: 'read' });
      // The stored choice is untouched: once it can be read again it is reported.
      expect(store.selections.get(signIn.sessionId)?.facilityId).toBe(secondary.id);
      const reloaded = await session(`access-${rotated}`);
      expect(reloaded.body).toMatchObject({ facilitySelection: 'selected', actor: { facility: { id: secondary.id } } });
    });

    it('answers GET /auth/session whose read fails with 200 and unavailable at the default facility (never as no choice)',
      async () => {
        const signIn = store.signIn(accountId, 'staff', 'ehr');
        expect((await select(signIn.accessToken, secondary.id)).status).toBe(200);
        tokens.selectedFacilityId.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: '08006' }));

        const read = await http().get('/api/v1/auth/session')
          .set('Cookie', `hid_access=${signIn.accessToken}; hid_access_refresh=${signIn.refreshToken}; hid_access_csrf=${signIn.csrfToken}`);

        expect(read.status).toBe(200);
        expect(read.body.facilitySelection).toBe('unavailable');
        expect(read.body.actor.facility.id).toBe(primary.id);
        expect(read.headers['set-cookie']).toBeUndefined();
        expect(read.headers['x-csrf-token']).toBe(signIn.csrfToken);
        expect(recorded('auth.session.read').at(-1)).toMatchObject({ facilityId: primary.id });
        expect(selectionLogs()).toHaveLength(1);
        expect(selectionLogs()[0]![0]).toEqual({ event: LOG_EVENT, operation: 'read' });
        const logged = JSON.stringify(warn.mock.calls);
        for (const identifier of [signIn.sessionId, accountId, secondary.id, primary.id, `staff:${accountId}`]) {
          expect(logged).not.toContain(identifier);
        }
        expect(store.sessions.get(signIn.sessionId)?.live).toBe(true);
      });

    it('keeps one choice per sign-in: another sign-in of the same account is not affected', async () => {
      const first = store.signIn(accountId, 'staff', 'ehr');
      const second = store.signIn(accountId, 'staff', 'ehr');

      expect((await select(first.accessToken, secondary.id)).status).toBe(200);

      const other = await session(second.accessToken);
      expect(other.body.actor.facility.id).toBe(primary.id);
      expect(other.body.facilitySelection).toBe(mode === 'ask' ? 'default' : undefined);
      const otherRefreshed = await refresh(second);
      expect(otherRefreshed.body.actor.facility.id).toBe(primary.id);
      expect((await session(first.accessToken)).body.actor.facility.id).toBe(secondary.id);
    });

    it('reads, stores and reports nothing for a patient sign-in', async () => {
      const patient = await http().post('/api/v1/auth/patient/login').set('Origin', EHR)
        .send({ email: 'patient@example.invalid', password: 'synthetic-password', turnstileAction: 'patient-login' });
      expect(patient.status).toBe(200);
      expect(patient.body).not.toHaveProperty('facilitySelection');
      const access = accessFrom(patient);

      const read = await session(access);
      expect(read.status).toBe(200);
      expect(read.body).not.toHaveProperty('facilitySelection');
      expect(read.body.actor.kind).toBe('patient');

      const sessionId: string = patient.body.actor.sessionId;
      const refreshed = await refresh({ refreshToken: `refresh-${sessionId}`, csrfToken: `csrf-refresh-${sessionId}` });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body).not.toHaveProperty('facilitySelection');

      const refused = await select(`access-${refreshed.body.actor.sessionId}`, secondary.id);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('PATIENT_SCOPE_DENIED');
      expect(tokens.selectedFacilityId).not.toHaveBeenCalled();
      expect(tokens.recordFacilitySelection).not.toHaveBeenCalled();
    });

    it('reads and reports nothing for an account-only outreach. session (no facility)', async () => {
      const signedIn = await login('organiser@example.invalid', OUTREACH);
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.actor.accountOnly).toBe(true);
      expect(signedIn.body).not.toHaveProperty('facilitySelection');

      const read = await session(accessFrom(signedIn));
      expect(read.status).toBe(200);
      expect(read.body).not.toHaveProperty('facilitySelection');
      const sessionId: string = signedIn.body.actor.sessionId;
      const refreshed = await refresh({ refreshToken: `refresh-${sessionId}`, csrfToken: `csrf-refresh-${sessionId}` },
        OUTREACH);
      expect(refreshed.status).toBe(200);
      expect(refreshed.body).not.toHaveProperty('facilitySelection');
      expect(tokens.selectedFacilityId).not.toHaveBeenCalled();
    });

    it('reads and reports nothing for a staff sign-in with no facility on this site (a platform administrator)', async () => {
      const signedIn = await login('administrator@example.invalid', ADMIN);
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.actor.facilities).toEqual([]);
      expect(signedIn.body).not.toHaveProperty('facilitySelection');

      const read = await session(accessFrom(signedIn));
      expect(read.status).toBe(200);
      expect(read.body).not.toHaveProperty('facilitySelection');
      expect(tokens.selectedFacilityId).not.toHaveBeenCalled();
    });

    it('answers an OIDC bearer caller (no Identity sign-in) as today: nothing read, stored or reported', async () => {
      const read = await session(OIDC_BEARER);
      expect(read.status).toBe(200);
      expect(read.body).not.toHaveProperty('facilitySelection');

      const chosen = await select(OIDC_BEARER, secondary.id);
      expect(chosen.status).toBe(200);
      expect(chosen.body).toEqual({ actor: expect.objectContaining({ facility: expect.objectContaining({ id: secondary.id }) }) });
      expect(recorded('auth.facility.select')).toHaveLength(1);
      expect(tokens.selectedFacilityId).not.toHaveBeenCalled();
      expect(tokens.recordFacilitySelection).not.toHaveBeenCalled();
      expect(audit.recordWithClient).not.toHaveBeenCalled();
    });

    it.each(['get', 'post'] as const)('leaves %s /auth/service-session exactly as today: no read, no field', async (method) => {
      const signIn = store.signIn(accountId, 'staff', 'ehr');
      expect((await select(signIn.accessToken, secondary.id)).status).toBe(200);
      tokens.selectedFacilityId.mockClear();
      audit.record.mockClear();

      const delegated = await http()[method]('/api/v1/auth/service-session').set('Authorization', `Bearer ${signIn.accessToken}`)
        .set('X-Facility-ID', primary.id).set('x-hid-internal-caller', 'ehr-api').set('x-hid-service-token', 'token');
      const unbound = await http()[method]('/api/v1/auth/service-session').set('Authorization', `Bearer ${signIn.accessToken}`)
        .set('x-hid-internal-caller', 'lab-api').set('x-hid-service-token', 'token');

      expect(delegated.status).toBe(200);
      expect(Object.keys(delegated.body)).toEqual(['actor']);
      expect(delegated.body.actor.facility.id).toBe(primary.id);
      // Without X-Facility-ID it is still the default facility, not the choice.
      expect(Object.keys(unbound.body)).toEqual(['actor']);
      expect(unbound.body.actor.facility.id).toBe(primary.id);
      expect(tokens.selectedFacilityId).not.toHaveBeenCalled();
      expect(audit.record.mock.calls.map(([event]) => event)).toEqual([
        expect.objectContaining({ action: 'auth.session.read', facilityId: primary.id, resourceId: signIn.sessionId,
          actorMembershipId: primary.membershipId, resourceType: 'session', outcome: 'success' }),
        expect.objectContaining({ action: 'auth.session.read', facilityId: primary.id, resourceId: signIn.sessionId }),
      ]);
    });

    it('answers the password sign-in with facilitySelection default only in ask mode', async () => {
      const signedIn = await login('staff@example.invalid');

      expect(signedIn.status).toBe(200);
      expect(signedIn.body.actor.facility.id).toBe(primary.id);
      if (mode === 'ask') expect(signedIn.body.facilitySelection).toBe('default');
      else expect(signedIn.body).not.toHaveProperty('facilitySelection');
      // A new sign-in has no choice to read.
      expect(tokens.selectedFacilityId).not.toHaveBeenCalled();

      // The choice applies to that sign-in: chosen, then kept on a reload.
      const access = accessFrom(signedIn);
      expect((await select(access, secondary.id)).body.facilitySelection).toBe('selected');
      expect((await session(access)).body).toMatchObject({ facilitySelection: 'selected',
        actor: { facility: { id: secondary.id } } });
    });

    it('answers the Google staff sign-in with facilitySelection default only in ask mode, and a Google patient with none',
      async () => {
        const exchange = async (turnstileAction: 'staff-login' | 'patient-login') => {
          const nonce = await http().get('/api/v1/auth/google/nonce').set('Origin', EHR);
          const cookie = setCookies(nonce).find((value) => value.startsWith('hid_access_google_nonce='))!.split(';')[0]!;
          return http().post('/api/v1/auth/oidc/exchange').set('Origin', EHR).set('Cookie', cookie)
            .send({ idToken: 'g'.repeat(64), turnstileAction });
        };

        const staff = await exchange('staff-login');
        expect(staff.status).toBe(200);
        expect(staff.body.actor.facility.id).toBe(primary.id);
        if (mode === 'ask') expect(staff.body.facilitySelection).toBe('default');
        else expect(staff.body).not.toHaveProperty('facilitySelection');

        const patient = await exchange('patient-login');
        expect(patient.status).toBe(200);
        expect(patient.body).not.toHaveProperty('facilitySelection');
        expect(tokens.selectedFacilityId).not.toHaveBeenCalled();
      });
  });

  describe('keep and ask differ only where no choice is stored yet', () => {
    it.each([['keep', undefined], ['ask', 'default']] as const)('%s: a staff sign-in with facilities and no choice reports %p',
      async (mode, expected) => {
        await boot(mode);
        const signIn = store.signIn(accountId, 'staff', 'ehr');
        const read = await session(signIn.accessToken);
        const refreshed = await refresh(signIn);
        expect(read.body.facilitySelection).toBe(expected);
        expect(refreshed.body.facilitySelection).toBe(expected);
        expect(read.body.actor.facility.id).toBe(primary.id);
        expect(refreshed.body.actor.facility.id).toBe(primary.id);
      });
  });
});
