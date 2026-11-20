// Real openid-client and jose (ES modules, loaded through Node's own require):
// the fake provider signs real tokens and the relying party checks them. No
// network: the provider is built in this process and reached through SSO_HTTP.
jest.mock('openid-client', () => {
  const { createRequire } = process.getBuiltinModule('node:module');
  return createRequire(`${process.cwd()}/package.json`)('openid-client') as typeof import('openid-client');
});
jest.mock('jose', () => {
  const { createRequire } = process.getBuiltinModule('node:module');
  return createRequire(`${process.cwd()}/package.json`)('jose') as typeof import('jose');
});

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EXCEPTION_FILTERS_METADATA } from '@nestjs/common/constants';
import { type INestApplication, Logger, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { NextFunction, Response as ExpressResponse } from 'express';
import type { JWTPayload } from 'jose';
import request from 'supertest';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { createFakeProvider, type FakeProvider } from '../testing/sso-fake-provider';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSessionAuditService } from './auth-session-audit.service';
import { GoogleAuthenticationService } from './google-authentication.service';
import { facilityAdmittedOnProduct, productsForFacilities, type StaffProduct } from './product-gate';
import { SecurityGuard } from './security.guard';
import { SsoController } from './sso/sso.controller';
import { SSO_CLOCK, SSO_HTTP, SsoProviderClient } from './sso/sso-provider.client';
import { SsoService } from './sso/sso.service';
import { SsoSessionEndFilter } from './sso/sso-session-end.filter';
import { TokenService, type SingleSignOnProvenance } from './token.service';
import { TurnstileService } from './turnstile.service';
import { WorkloadAuthService } from './workload-auth.service';

/**
 * 0129 (a staff member's chosen facility, kept per sign-in) with #262's
 * single sign-on (0127, ADR-070) switched on, through the real
 * AuthController, SsoController, SsoService, SecurityGuard, AuditInterceptor
 * and SsoSessionEndFilter, the fake provider of sso-relying-party.spec.ts and
 * one in-memory sign-in store standing in for TokenService, AuthService and
 * the database. The store models what 0129's SQL and guard guarantee (one
 * choice per sign-in family, written for and read through a live staff
 * session of the account; see facility-selection.spec.ts and
 * session-facility-selection.integration.sql, whose section 9 proves the
 * same on PostgreSQL), and resolves the actor as CurrentStaffContextService
 * does: the memberships the session's own product admits
 * (facilityAdmittedOnProduct: Q88, Q97's own-job rule and 0126's
 * organisation kinds), primary first, then by name.
 *
 * It shows that:
 * - a staff sign-in a product issued after single sign-on keeps, reads,
 *   refreshes and loses its choice exactly as a password sign-in on that
 *   site does, under Q97's and Q90/Q91's (0126) gate;
 * - a back-channel logout (revocation_reason 'sso_logout'), and product
 *   sign-out everywhere, end the choice's reads exactly as today's sign-out
 *   does, and SsoSessionEndFilter still answers GET /auth/session;
 * - GET and POST /auth/service-session answer byte for byte as with the
 *   setting off.
 * Every host but the product sites' is fictional, and no test touches the
 * network.
 */
const ISSUER = 'https://auth.sso-facility.invalid';
const LAB = 'https://lab.healthidentitydirectory.com';
const ADMIN = 'https://admin.sso-facility.invalid';
const ACCOUNT = '7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const SUBJECT = 'synthetic:facility-sso-staff';
const EMAIL = 'facility-sso-staff@example.invalid';
const CORRELATION = 'facility-selection-sso-0001';
const LOG_EVENT = 'auth.facility_selection.unavailable';

type Mode = 'off' | 'keep' | 'ask';

const facility = (name: string, primary: boolean, role: string, permissions: string[],
  extra: Partial<FacilityAssignment> = {}): FacilityAssignment => ({
  id: randomUUID(), membershipId: randomUUID(), organizationId: randomUUID(), name, roles: [role],
  permissions: [...permissions, `${role}.synthetic`], isPrimary: primary, ...extra,
});

interface StoredSession {
  id: string; familyId: string; accountId: string; product?: StaffProduct; refreshHash: string;
  /** null while live. */
  revocationReason: string | null;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

let app: INestApplication | undefined;
let provider: FakeProvider;
let store: {
  sessions: StoredSession[];
  links: Array<{ familyId: string; accountId: string; clientId: string; sid: string }>;
  spent: Set<string>;
  memberships: FacilityAssignment[];
  selections: Map<string, { facilityId: string; membershipId: string }>;
};
let tokens: { issue: jest.Mock; verify: jest.Mock; verifyCsrf: jest.Mock; verifyRefreshCsrf: jest.Mock;
  recordSessionEvent: jest.Mock; refreshSessionKind: jest.Mock; revokeByRefreshToken: jest.Mock; revoke: jest.Mock;
  selectedFacilityId: jest.Mock; recordFacilitySelection: jest.Mock };
let auth: { login: jest.Mock; refresh: jest.Mock; revoke: jest.Mock };
let audit: { record: jest.Mock; recordWithClient: jest.Mock };
let warn: jest.SpyInstance;

// Fictional workforce of one account. On lab. (Q97 and 0126): the two
// laboratory memberships and the administrator of a laboratory-only
// organisation; the hospital doctor's primary membership is ehr.'s, not lab.'s.
let doctor: FacilityAssignment;
let epsilon: FacilityAssignment;
let gamma: FacilityAssignment;
let zetaAdmin: FacilityAssignment;

function live(sessionId: string): StoredSession | undefined {
  return store.sessions.find((session) => session.id === sessionId && session.revocationReason === null);
}

/** As CurrentStaffContextService resolves it under the session's product: no kind, primary first and bound. */
function actorFor(session: StoredSession): ActorContext {
  const admitted = session.product
    ? store.memberships.filter((candidate) => facilityAdmittedOnProduct(candidate, session.product!))
    : store.memberships;
  const facilities = [...admitted].sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary)
    || left.name.localeCompare(right.name));
  const bound = facilities[0];
  if (!bound) throw new UnauthorizedException('Session no longer fits this site');
  return { id: SUBJECT, subject: SUBJECT, accountId: session.accountId, sessionId: session.id,
    roles: bound.roles, role: bound.roles[0], permissions: bound.permissions, platformRoles: [],
    platformPermissions: [], facilityIds: facilities.map((candidate) => candidate.id), facilities, facility: bound,
    products: productsForFacilities(store.memberships), authenticationMethod: 'local' };
}

/** A new sign-in or a rotation, as TokenService.issue and refresh write it: the family is its first session's id. */
function sessionTokens(session: StoredSession) {
  const refreshToken = `${session.id}.${randomBytes(16).toString('base64url')}.${session.product ? `${session.product}.` : ''}local`;
  session.refreshHash = sha256(refreshToken);
  return { actor: actorFor(session), accessToken: `access-${session.id}`, refreshToken, csrfToken: `csrf-${session.id}`,
    expiresAt: new Date(Date.now() + 900_000), refreshExpiresAt: new Date(Date.now() + 28_800_000) };
}

function newSignIn(product: StaffProduct | undefined, provenance?: SingleSignOnProvenance) {
  const id = randomUUID();
  const session: StoredSession = { id, familyId: id, accountId: ACCOUNT, product, refreshHash: '', revocationReason: null };
  store.sessions.push(session);
  if (provenance) store.links.push({ familyId: id, accountId: ACCOUNT, clientId: provenance.clientId, sid: provenance.providerSid });
  return sessionTokens(session);
}

/** The statements SsoService and SecurityGuard send, answered from the store (as sso-relying-party.spec.ts does). */
async function runQuery(sql: string, values: unknown[] = []) {
  const none = { rows: [], rowCount: 0 };
  if (sql.includes('delete from auth.sso_spent_tokens')) return none;
  if (sql.includes('insert into auth.sso_spent_tokens')) {
    const key = `${values[0]}:${values[1]}`;
    if (store.spent.has(key)) return none;
    store.spent.add(key);
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes('select subject, password_changed_at, token_version::text from auth.accounts')) {
    return values[0] === ACCOUNT
      ? { rows: [{ subject: SUBJECT, password_changed_at: null, token_version: '1' }], rowCount: 1 } : none;
  }
  if (sql.includes('update auth.sessions')) {
    // SsoService's single sign-on revocations: by provider sid (back-channel
    // logout), or every sign-in of the account and kind (sign out everywhere).
    expect(sql).toContain("revocation_reason = 'sso_logout'");
    const families = sql.includes('from auth.session_single_sign_on')
      ? new Set(store.links.filter((link) => link.sid === values[0] && (values[1] === null || link.accountId === values[1]))
        .map((link) => link.familyId))
      : undefined;
    const ended = store.sessions.filter((session) => session.revocationReason === null
      && (families ? families.has(session.familyId) : session.accountId === values[0]));
    for (const session of ended) session.revocationReason = 'sso_logout';
    return { rows: ended.map((session) => ({ id: session.id, account_id: session.accountId, family_id: session.familyId })),
      rowCount: ended.length };
  }
  if (sql.includes('platform.control_enabled')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }], rowCount: 1 };
  throw new Error(`unexpected SQL: ${sql}`);
}

function endFamily(sessionId: string, reason: string): boolean {
  const session = live(sessionId);
  if (!session) return false;
  for (const member of store.sessions) {
    if (member.familyId === session.familyId && member.revocationReason === null) member.revocationReason = reason;
  }
  return true;
}

beforeEach(async () => {
  doctor = facility('Fictional Alpha General', true, 'doctor', ['ehr.encounter.write']);
  epsilon = facility('Fictional Epsilon Laboratory', false, 'lab', ['lab.work-item.read']);
  gamma = facility('Fictional Gamma Laboratory', false, 'lab', ['lab.work-item.read']);
  zetaAdmin = facility('Fictional Zeta Laboratory', false, 'org_admin', ['organization.manage', 'workforce.manage'],
    { organizationKinds: ['laboratory'] });
  store = { sessions: [], links: [], spent: new Set(), memberships: [doctor, epsilon, gamma, zetaAdmin],
    selections: new Map() };
  provider = await createFakeProvider(ISSUER, {
    lab: { kind: 'staff', redirectUri: `${LAB}/api/v1/auth/sso/callback`, secret: 'lab-client-secret-for-the-facility-spec' },
  });
  tokens = {
    // As TokenService.issue: one path for a password and a single sign-on sign-in (Q92 B); the provenance only
    // records where it came from.
    issue: jest.fn(async (_identity: unknown, event: { product?: StaffProduct }, provenance?: SingleSignOnProvenance) =>
      newSignIn(event.product, provenance)),
    verify: jest.fn(async (token: string) => {
      const session = token.startsWith('access-') ? live(token.slice('access-'.length)) : undefined;
      if (!session) throw new UnauthorizedException('Invalid or expired access token');
      return { actor: actorFor(session), claims: { csrf_hash: `hash-csrf-${session.id}`, product: session.product } };
    }),
    verifyCsrf: jest.fn((claims: { csrf_hash: string }, cookie?: string, header?: string) =>
      Boolean(cookie) && cookie === header && claims.csrf_hash === `hash-${cookie}`),
    verifyRefreshCsrf: jest.fn((refresh: string, cookie?: string, header?: string) =>
      Boolean(cookie) && cookie === header && cookie === `csrf-${refresh.split('.')[0]}`),
    recordSessionEvent: jest.fn(async () => undefined),
    refreshSessionKind: jest.fn(async (refresh: string) => {
      const session = store.sessions.find((candidate) => candidate.refreshHash === sha256(refresh));
      return session && session.revocationReason === null ? 'staff' : undefined;
    }),
    revokeByRefreshToken: jest.fn(async (refresh: string) => {
      const session = store.sessions.find((candidate) => candidate.refreshHash === sha256(refresh));
      if (!session || !endFamily(session.id, 'logout')) return undefined;
      return { sessionId: session.id, accountId: session.accountId, subject: SUBJECT };
    }),
    revoke: jest.fn(async (sessionId: string) => endFamily(sessionId, 'logout')),
    // 0129's read and write, as TokenService's SQL answers them: through a live staff session of the account only.
    selectedFacilityId: jest.fn(async (sessionId: string, accountId: string) => {
      const session = live(sessionId);
      if (!session || session.accountId !== accountId) return undefined;
      return store.selections.get(session.familyId)?.facilityId;
    }),
    recordFacilitySelection: jest.fn(async (input: { sessionId: string; accountId: string; facilityId: string;
      membershipId: string }, _event: unknown, within: (client: unknown) => Promise<void>) => {
      const session = live(input.sessionId);
      if (!session || session.accountId !== input.accountId) return 'session_ended';
      if (!store.memberships.some((candidate) => candidate.id === input.facilityId
        && candidate.membershipId === input.membershipId)) return 'refused';
      await within({ query: jest.fn() });
      store.selections.set(session.familyId, { facilityId: input.facilityId, membershipId: input.membershipId });
      return 'selected';
    }),
  };
  auth = {
    // Today's password sign-in on the site of the request's Origin.
    login: jest.fn(async (_input: unknown, event: { product?: StaffProduct }) => newSignIn(event.product)),
    // As TokenService.refresh: the product rides in the refresh token; the family is kept and the old session rotated.
    refresh: jest.fn(async (refresh: string, event: { product?: StaffProduct }) => {
      const session = store.sessions.find((candidate) => candidate.refreshHash === sha256(refresh));
      if (!session || session.revocationReason !== null) throw new UnauthorizedException('Refresh session ended');
      if (session.product && event.product !== session.product) throw new UnauthorizedException('Another site');
      session.revocationReason = 'rotated';
      const next: StoredSession = { ...session, id: randomUUID(), revocationReason: null };
      store.sessions.push(next);
      return sessionTokens(next);
    }),
    // Today's sign-out: the whole sign-in.
    revoke: jest.fn(async (sessionId?: string) => (sessionId ? endFamily(sessionId, 'logout') : false)),
  };
  audit = { record: jest.fn(async () => undefined), recordWithClient: jest.fn(async () => undefined) };
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  warn.mockRestore();
});
afterAll(() => resetEnvironmentForTests());

let savedEnvironment: NodeJS.ProcessEnv;
beforeEach(() => { savedEnvironment = { ...process.env }; });
afterEach(() => { process.env = savedEnvironment; resetEnvironmentForTests(); });

/** The app as AppModule wires these routes, with single sign-on configured for lab. and the given 0129 mode. */
async function boot(mode: Mode): Promise<void> {
  await app?.close();
  for (const name of ['AUTH_SSO_ISSUER', 'AUTH_SSO_INTERNAL_BASE_URL', 'AUTH_SSO_CLIENTS', 'AUTH_SSO_CLIENT_CREDENTIALS']) {
    delete process.env[name];
  }
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid', CORS_ORIGINS: `${LAB},${ADMIN}`,
    AUTH_MODE: 'local', AUTH_COOKIE_NAME: 'hid_access', AUTH_COOKIE_SECURE: 'true',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters', TURNSTILE_MODE: 'disabled',
    STAFF_FACILITY_SELECTION_MODE: mode,
    AUTH_SSO_ISSUER: ISSUER,
    AUTH_SSO_CLIENTS: JSON.stringify([
      { client_id: 'lab', host: new URL(LAB).host, kind: 'staff', token_endpoint_auth_method: 'client_secret_basic' },
    ]),
    AUTH_SSO_CLIENT_CREDENTIALS: JSON.stringify({ lab: { client_secret: 'lab-client-secret-for-the-facility-spec' } }),
  });
  resetEnvironmentForTests();
  const database = { query: jest.fn(runQuery),
    withSystemTransaction: jest.fn(async (_id: string, operation: (client: unknown) => unknown) =>
      operation({ query: runQuery })) };
  const module = await Test.createTestingModule({
    controllers: [SsoController, AuthController],
    providers: [
      SsoService, SsoProviderClient,
      { provide: SSO_HTTP, useValue: provider.http },
      { provide: SSO_CLOCK, useValue: () => Date.now() },
      { provide: TokenService, useValue: tokens },
      { provide: AuthService, useValue: auth },
      { provide: AuditService, useValue: audit },
      { provide: AuthSessionAuditService, useValue: { record: jest.fn(async () => undefined), recordLoginFailure: jest.fn() } },
      { provide: DatabaseService, useValue: database },
      { provide: WorkloadAuthService, useValue: { authenticateService: jest.fn(async () => ({})) } },
      { provide: TurnstileService, useValue: { verifyLogin: jest.fn(async () => undefined) } },
      { provide: GoogleAuthenticationService, useValue: {} },
      SecurityGuard, { provide: APP_GUARD, useExisting: SecurityGuard },
      { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    ],
  }).compile();
  const nest = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  nest.use((req: HidRequest, _res: ExpressResponse, next: NextFunction) => { req.correlationId = CORRELATION; next(); });
  nest.use(cookieParser());
  nest.setGlobalPrefix('api/v1');
  nest.useBodyParser('json', { limit: 256 * 1024, strict: true, type: ['application/json', 'application/*+json'] });
  nest.useGlobalFilters(new ProblemDetailsFilter());
  await nest.init();
  app = nest;
}

const http = () => request(app!.getHttpServer());
const cookiesOf = (response: request.Response): string[] => {
  const header = response.headers['set-cookie'] as unknown;
  return Array.isArray(header) ? header as string[] : typeof header === 'string' ? [header] : [];
};
const cookieValue = (response: request.Response, name: string) =>
  cookiesOf(response).find((cookie) => cookie.startsWith(`${name}=`))?.split(';')[0]!.slice(name.length + 1) ?? '';
const cleared = (response: request.Response) => ['hid_access=', 'hid_access_refresh=', 'hid_access_csrf=']
  .every((name) => /Expires=Thu, 01 Jan 1970/.test(cookiesOf(response).find((cookie) => cookie.startsWith(name)) ?? ''));

interface Browser { access: string; refresh: string; csrf: string; sessionId: string }
const browserFrom = (response: request.Response): Browser => {
  const access = cookieValue(response, 'hid_access');
  return { access, refresh: cookieValue(response, 'hid_access_refresh'), csrf: cookieValue(response, 'hid_access_csrf'),
    sessionId: access.slice('access-'.length) };
};

/** A staff sign-in on lab. through single sign-on: start, the provider, the callback (303 with today's cookies). */
async function ssoSignIn(claims: JWTPayload = {}): Promise<Browser> {
  const started = await http().get('/api/v1/auth/sso/start?return_to=%2Flab%2Fqueue').set('X-HID-Edge-Origin', LAB);
  expect(started.status).toBe(303);
  const transaction = cookiesOf(started).find((cookie) => cookie.startsWith('__Host-hid_sso_tx_'))!;
  const location = new URL(started.headers.location as string);
  const code = provider.authorize(location.href, { sub: ACCOUNT, sid: 'provider-session-1', hid_kind: 'staff',
    amr: ['pwd'], ...claims });
  const callback = await http().get(`/api/v1/auth/sso/callback?code=${encodeURIComponent(code)}&state=${location.searchParams.get('state')}`)
    .set('X-HID-Edge-Origin', LAB).set('Cookie', transaction.split(';')[0]!);
  expect([callback.status, callback.headers.location]).toEqual([303, '/lab/queue']);
  return browserFrom(callback);
}

/** Today's password sign-in on lab. */
async function passwordSignIn(): Promise<Browser> {
  const response = await http().post('/api/v1/auth/login').set('Origin', LAB).set('X-HID-Edge-Origin', LAB)
    .send({ email: EMAIL, password: 'synthetic-password', turnstileAction: 'staff-login' });
  expect(response.status).toBe(200);
  return browserFrom(response);
}

const session = (browser: Browser) => http().get('/api/v1/auth/session').set('X-HID-Edge-Origin', LAB)
  .set('Cookie', [`hid_access=${browser.access}`, `hid_access_refresh=${browser.refresh}`, `hid_access_csrf=${browser.csrf}`]);
const choose = (browser: Browser, facilityId: string) => http().post('/api/v1/auth/facility')
  .set('Origin', LAB).set('X-HID-Edge-Origin', LAB).set('X-CSRF-Token', browser.csrf)
  .set('Cookie', [`hid_access=${browser.access}`, `hid_access_csrf=${browser.csrf}`]).send({ facilityId });
const refresh = (browser: Browser) => http().post('/api/v1/auth/refresh').set('Origin', LAB).set('X-HID-Edge-Origin', LAB)
  .set('X-CSRF-Token', browser.csrf).set('Cookie', [`hid_access_refresh=${browser.refresh}`, `hid_access_csrf=${browser.csrf}`]);
const signOut = (browser: Browser) => http().post('/api/v1/auth/logout').set('Origin', LAB).set('X-HID-Edge-Origin', LAB)
  .set('X-CSRF-Token', browser.csrf).set('Cookie', [`hid_access=${browser.access}`, `hid_access_csrf=${browser.csrf}`]);
const backchannelLogout = async (sid: string) => http().post('/api/v1/auth/sso/backchannel-logout')
  .set('X-HID-Edge-Origin', LAB).type('form')
  .send(`logout_token=${await provider.signLogoutToken({ aud: 'lab', sid, sub: ACCOUNT })}`);

/** What a website sees of a session answer: status, state and the facility reported. */
const seen = (response: request.Response) => ({ status: response.status,
  facilitySelection: response.body?.facilitySelection, facility: response.body?.actor?.facility?.name,
  code: response.body?.code });
const readsOf = (sessionId: string) => tokens.selectedFacilityId.mock.calls.filter(([id]) => id === sessionId).length;

describe.each(['keep', 'ask'] as const)('0129 with single sign-on on (STAFF_FACILITY_SELECTION_MODE %s)', (mode) => {
  beforeEach(() => boot(mode));

  it('a single sign-on staff sign-in keeps, refreshes and loses its choice exactly as a password sign-in on that site', async () => {
    const sso = await ssoSignIn();
    const password = await passwordSignIn();
    // The single sign-on sign-in went through today's issue with its provenance, as the first session of its family.
    expect(tokens.issue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ product: 'lab' }),
      expect.objectContaining({ clientId: 'lab', providerSid: 'provider-session-1' }));
    expect(store.links).toEqual([{ familyId: sso.sessionId, accountId: ACCOUNT, clientId: 'lab', sid: 'provider-session-1' }]);
    const ssoFamily = sso.sessionId;
    expect(store.sessions.find((stored) => stored.id === ssoFamily)?.familyId).toBe(ssoFamily);

    // Each step on both sign-ins, in turn; `label` names the step for the reader.
    const answers = new Map<Browser, ReturnType<typeof seen>[]>([[sso, []], [password, []]]);
    const both = async (_label: string, step: (browser: Browser) => Promise<request.Response>) => {
      for (const browser of [sso, password]) answers.get(browser)!.push(seen(await step(browser)));
    };
    // No choice yet: today's answer in keep, 'default' in ask, at lab.'s default (the first laboratory by name).
    await both('first read', session);
    // The choice is stored for the sign-in, and read back on reload and after a refresh.
    await both('choose Gamma', (browser) => choose(browser, gamma.id));
    await both('reload', session);
    for (const browser of [sso, password]) {
      const refreshed = await refresh(browser);
      answers.get(browser)!.push(seen(refreshed));
      Object.assign(browser, browserFrom(refreshed));
    }
    await both('reload after the refresh', session);
    // Q97: the chosen laboratory membership becomes a nurse's, which lab. no longer admits.
    store.memberships = store.memberships.map((candidate) => (candidate.id === gamma.id
      ? { ...candidate, roles: ['nurse'], permissions: ['ehr.encounter.write', 'lab.work-item.read', 'nurse.synthetic'] }
      : candidate));
    await both('reload after Q97 narrows lab.', session);
    // A hospital doctor's membership is not lab.'s: refused, nothing stored.
    await both('choose the doctor\'s hospital', (browser) => choose(browser, doctor.id));
    // 0126 (Q90/Q91): the administrator of a laboratory-only organisation is admitted on lab. ...
    await both('choose the laboratory organisation\'s administrator', (browser) => choose(browser, zetaAdmin.id));
    await both('reload', session);
    // ... until the organisation is recorded as a pharmacy only: then it is not lab.'s.
    store.memberships = store.memberships.map((candidate) => (candidate.id === zetaAdmin.id
      ? { ...candidate, organizationKinds: ['pharmacy'] } : candidate));
    await both('reload after the organisation\'s kinds change', session);

    const expected = [
      { status: 200, facilitySelection: mode === 'ask' ? 'default' : undefined, facility: epsilon.name, code: undefined },
      { status: 200, facilitySelection: 'selected', facility: gamma.name, code: undefined },
      { status: 200, facilitySelection: 'selected', facility: gamma.name, code: undefined },
      { status: 200, facilitySelection: 'selected', facility: gamma.name, code: undefined },
      { status: 200, facilitySelection: 'selected', facility: gamma.name, code: undefined },
      { status: 200, facilitySelection: 'reselect', facility: epsilon.name, code: undefined },
      { status: 403, facilitySelection: undefined, facility: undefined, code: 'FACILITY_ACCESS_DENIED' },
      { status: 200, facilitySelection: 'selected', facility: zetaAdmin.name, code: undefined },
      { status: 200, facilitySelection: 'selected', facility: zetaAdmin.name, code: undefined },
      { status: 200, facilitySelection: 'reselect', facility: epsilon.name, code: undefined },
    ];
    expect(answers.get(sso)).toEqual(expected);
    expect(answers.get(password)).toEqual(answers.get(sso));
    // One choice per sign-in, kept on the family through the refresh; the refused choice stored nothing.
    expect(sso.sessionId).not.toBe(ssoFamily);
    expect(store.sessions.find((stored) => stored.id === sso.sessionId)?.familyId).toBe(ssoFamily);
    expect(store.selections.get(ssoFamily)).toEqual({ facilityId: zetaAdmin.id, membershipId: zetaAdmin.membershipId });
    expect(store.selections.size).toBe(2);
    expect(store.links.map((link) => link.familyId)).toEqual([ssoFamily]);
    expect(audit.recordWithClient.mock.calls.filter(([, event]) => event.action === 'auth.facility.select')).toHaveLength(4);
    expect(warn).not.toHaveBeenCalledWith(expect.objectContaining({ event: LOG_EVENT }));
  });

  it('a back-channel logout ends the choice\'s reads exactly as today\'s sign-out does, and the session check still clears the cookies', async () => {
    const sso = await ssoSignIn();
    const password = await passwordSignIn();
    for (const browser of [sso, password]) expect(seen(await choose(browser, gamma.id)).facilitySelection).toBe('selected');

    // The provider ends provider-session-1: only the single sign-on sign-in, with reason sso_logout.
    const logout = await backchannelLogout('provider-session-1');
    expect(logout.status).toBe(200);
    expect(store.sessions.filter((stored) => stored.revocationReason === 'sso_logout').map((stored) => stored.id))
      .toEqual([sso.sessionId]);
    // The password sign-in was not in that provider session: it still reads its choice.
    expect(seen(await session(password))).toMatchObject({ status: 200, facilitySelection: 'selected', facility: gamma.name });
    // Today's sign-out of the password sign-in.
    expect((await signOut(password)).status).toBe(204);

    const afterEnd = async (browser: Browser) => {
      const before = readsOf(browser.sessionId);
      const check = await session(browser);
      const renewal = await refresh(browser);
      const again = await choose(browser, epsilon.id);
      return { check: { ...seen(check), cleared: cleared(check) }, renewal: { ...seen(renewal), cleared: cleared(renewal) },
        choice: seen(again), reads: readsOf(browser.sessionId) - before,
        // As 0129's read answers it for the ended session (its SQL wants a live staff session).
        stored: await tokens.selectedFacilityId(browser.sessionId, ACCOUNT) };
    };
    const ssoEnded = await afterEnd(sso);
    const passwordEnded = await afterEnd(password);
    // Ended: the session check is 401 and, on this single sign-on host, clears the cookies (SsoSessionEndFilter);
    // the refresh is 401 and clears them; a new choice is 401; nothing reads or stores the choice.
    expect(ssoEnded).toEqual({
      check: { status: 401, facilitySelection: undefined, facility: undefined, code: 'AUTHENTICATION_REQUIRED', cleared: true },
      renewal: { status: 401, facilitySelection: undefined, facility: undefined, code: 'AUTHENTICATION_REQUIRED', cleared: true },
      choice: { status: 401, facilitySelection: undefined, facility: undefined, code: 'AUTHENTICATION_REQUIRED' },
      reads: 0, stored: undefined,
    });
    expect(passwordEnded).toEqual(ssoEnded);
    // The rows stay (nothing deletes a choice), with the choice made before.
    expect([...store.selections.values()]).toEqual([
      { facilityId: gamma.id, membershipId: gamma.membershipId }, { facilityId: gamma.id, membershipId: gamma.membershipId }]);
    expect(tokens.recordFacilitySelection).toHaveBeenCalledTimes(2);
  });

  it('product sign-out (POST /auth/sso/logout) signs every sign-in out of its choice, as today\'s sign-out does', async () => {
    const sso = await ssoSignIn();
    const password = await passwordSignIn();
    for (const browser of [sso, password]) expect(seen(await choose(browser, zetaAdmin.id)).facilitySelection).toBe('selected');
    const response = await http().post('/api/v1/auth/sso/logout').set('X-HID-Edge-Origin', LAB).set('Origin', LAB)
      .set('X-CSRF-Token', sso.csrf).set('Cookie', [`hid_access=${sso.access}`, `hid_access_csrf=${sso.csrf}`]);
    expect(response.status).toBe(200);
    expect(response.body.endSessionUrl).toContain(ISSUER);
    // This sign-in by today's sign-out, the other by single sign-on's sign out everywhere.
    expect(store.sessions.map((stored) => stored.revocationReason)).toEqual(['logout', 'sso_logout']);
    for (const browser of [sso, password]) {
      const before = readsOf(browser.sessionId);
      const check = await session(browser);
      expect({ ...seen(check), cleared: cleared(check) })
        .toEqual({ status: 401, facilitySelection: undefined, facility: undefined, code: 'AUTHENTICATION_REQUIRED', cleared: true });
      expect(readsOf(browser.sessionId)).toBe(before);
      expect(await tokens.selectedFacilityId(browser.sessionId, ACCOUNT)).toBeUndefined();
    }
  });
});

describe('the routes single sign-on and 0129 share', () => {
  it('GET /auth/session keeps SsoSessionEndFilter; the service-session routes have no filter of their own', () => {
    const filters = (handler: keyof AuthController) =>
      (Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, AuthController.prototype[handler]) ?? []) as unknown[];
    expect(filters('session')).toEqual([SsoSessionEndFilter]);
    expect(filters('serviceSession')).toEqual([]);
    expect(filters('validateServiceMutation')).toEqual([]);
  });

  it('GET and POST /auth/service-session answer byte for byte as with the setting off, with a choice stored', async () => {
    await boot('keep');
    const sso = await ssoSignIn();
    expect(seen(await choose(sso, gamma.id)).facilitySelection).toBe('selected');
    const service = (method: 'get' | 'post') => http()[method]('/api/v1/auth/service-session')
      .set('Authorization', `Bearer ${sso.access}`).set('X-HID-Edge-Origin', LAB)
      .set('X-HID-Internal-Caller', 'lab-api').set('X-HID-Service-Token', 'synthetic-service-token');
    const answer = async () => {
      const reads = tokens.selectedFacilityId.mock.calls.length;
      const audited = audit.record.mock.calls.length;
      const answers = [];
      for (const method of ['get', 'post'] as const) {
        const response = await service(method);
        answers.push({ status: response.status, text: response.text,
          headers: Object.fromEntries(['content-type', 'etag', 'set-cookie', 'x-csrf-token', 'cache-control']
            .map((name) => [name, response.headers[name]])) });
      }
      return { answers, reads: tokens.selectedFacilityId.mock.calls.length - reads,
        audit: audit.record.mock.calls.slice(audited).map(([event]) => event) };
    };
    const keep = await answer();
    await boot('ask');
    const ask = await answer();
    await boot('off');
    const off = await answer();
    expect(keep.answers.map((item) => item.status)).toEqual([200, 200]);
    // At the default (Epsilon), never the stored Gamma, and no facilitySelection member.
    for (const item of keep.answers) {
      expect(JSON.parse(item.text)).toEqual({ actor: expect.objectContaining({ facility: expect.objectContaining({ id: epsilon.id }) }) });
    }
    expect(keep).toEqual(off);
    expect(ask).toEqual(off);
    expect(off.reads).toBe(0);
    expect(off.audit.map((event) => event.action)).toEqual(['auth.session.read', 'auth.session.read']);
  });
});
