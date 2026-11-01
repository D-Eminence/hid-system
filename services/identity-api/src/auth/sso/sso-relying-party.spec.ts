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
import { type INestApplication, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { NextFunction, Response as ExpressResponse } from 'express';
import type { JWTPayload } from 'jose';
import request from 'supertest';
import { AuditInterceptor } from '../../audit/audit.interceptor';
import { AuditService } from '../../audit/audit.service';
import { ProblemDetailsFilter } from '../../common/problem';
import type { ActorContext, HidRequest } from '../../common/request-context';
import { resetEnvironmentForTests } from '../../config/environment';
import { DatabaseService } from '../../database/database.service';
import { clientKeyPair, createFakeProvider, type FakeProvider } from '../../testing/sso-fake-provider';
import { AuthController } from '../auth.controller';
import { AuthService } from '../auth.service';
import { AuthSessionAuditService } from '../auth-session-audit.service';
import { GoogleAuthenticationService } from '../google-authentication.service';
import { MfaService } from '../mfa/mfa.service';
import { SecurityGuard } from '../security.guard';
import { TokenService, type SingleSignOnProvenance } from '../token.service';
import { TurnstileService } from '../turnstile.service';
import { WorkloadAuthService } from '../workload-auth.service';
import { SSO_FALLBACK_COOKIE, SsoController } from './sso.controller';
import { SSO_CLOCK, SSO_HTTP, SSO_METADATA_TTL_MS, SsoProviderClient } from './sso-provider.client';
import { SsoService } from './sso.service';
import { newTransaction, sealTransaction, transactionCookieName } from './sso-transaction';

/**
 * ADR-070, contract v2 "The relying party in identity-api", through the real
 * controllers, guard, interceptor and problem filter, with the session store
 * and the provider faked. Every host is fictional.
 */
const ISSUER = 'https://auth.sso-rp.invalid';
const LAB = 'https://lab.sso-rp.invalid';
const PORTAL = 'https://app.sso-rp.invalid';
const ADMIN = 'https://admin.sso-rp.invalid';
const STAFF_ACCOUNT = '3b9a1c2d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const PATIENT_ACCOUNT = '6d5c4b3a-2f1e-4d0c-9b8a-7f6e5d4c3b2a';
const OTHER_PATIENT_ACCOUNT = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const OTHER_STAFF_ACCOUNT = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const SIGNING_SECRET = 'test-signing-secret-with-at-least-32-characters';
const CORRELATION = 'sso-relying-party-0001';

interface StoredSession { id: string; familyId: string; accountId: string; kind: 'staff' | 'patient'; refreshHash: string;
  revoked: boolean }
interface StoredLink { familyId: string; accountId: string; clientId: string; sid: string }

let app: INestApplication | undefined;
/** Moves the relying party's clock (its discovery and key-set caches) forward. */
let clockOffset = 0;
let provider: FakeProvider;
let store: { accounts: Map<string, string>; factors: Map<string, string>; sessions: StoredSession[]; links: StoredLink[];
  spent: Set<string>; access: Map<string, { actor: ActorContext; claims: { csrf_hash: string }; mfaAssured: boolean }>;
  passwordChangedAt: Map<string, Date>; factorActivatedAt: Map<string, Date> };
let tokens: { issueStaffSession: jest.Mock; issue: jest.Mock; verify: jest.Mock; verifyCsrf: jest.Mock;
  verifyRefreshCsrf: jest.Mock; recordSessionEvent: jest.Mock; refreshSessionKind: jest.Mock; revoke: jest.Mock };
let auth: { revoke: jest.Mock; revokeByRefreshToken: jest.Mock; refresh: jest.Mock };
let audit: { record: jest.Mock; recordWithClient: jest.Mock };
let sessionAudit: { record: jest.Mock };
let database: { query: jest.Mock; withSystemTransaction: jest.Mock };

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const nowSeconds = () => Math.floor(Date.now() / 1_000);

function newSession(kind: 'staff' | 'patient', accountId: string, provenance?: SingleSignOnProvenance) {
  const id = randomUUID();
  const refreshToken = `${id}.${randomBytes(16).toString('base64url')}.local`;
  const csrfToken = `csrf-${id}`;
  store.sessions.push({ id, familyId: id, accountId, kind, refreshHash: sha256(refreshToken), revoked: false });
  if (provenance) {
    store.links.push({ familyId: id, accountId, clientId: provenance.clientId, sid: provenance.providerSid });
  }
  const actor = { ...(kind === 'patient' ? { kind } : {}), id: `synthetic:${kind}`, subject: `synthetic:${kind}`,
    accountId, sessionId: id, roles: [], permissions: [], platformRoles: [], platformPermissions: [], facilityIds: [],
    facilities: [], authenticationMethod: 'local' } as ActorContext;
  store.access.set(`access-${id}`, { actor, claims: { csrf_hash: `hash-${csrfToken}` }, mfaAssured: kind === 'staff' });
  return { actor, accessToken: `access-${id}`, refreshToken, csrfToken, expiresAt: new Date(Date.now() + 900_000),
    refreshExpiresAt: new Date(Date.now() + 28_800_000) };
}

/** The statements SsoService sends, answered from the in-memory store. */
async function runQuery(sql: string, values: unknown[] = []) {
  const none = { rows: [], rowCount: 0 };
  if (sql.includes('delete from auth.sso_spent_tokens')) return none;
  if (sql.includes('insert into auth.sso_spent_tokens')) {
    const key = `${values[0]}:${values[1]}`;
    if (store.spent.has(key)) return none;
    store.spent.add(key);
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes('auth.lock_account_for_mfa') || sql.includes('auth.lock_account_sessions')) return { rows: [{}], rowCount: 1 };
  if (sql.includes('select subject, password_changed_at from auth.accounts')) {
    const subject = store.accounts.get(String(values[0]));
    return subject ? { rows: [{ subject, password_changed_at: store.passwordChangedAt.get(String(values[0])) ?? null }],
      rowCount: 1 } : none;
  }
  if (sql.includes('from auth.mfa_factors')) {
    expect(sql).toContain('enrollment_proof is not null');
    expect(sql).toContain('for update');
    const id = store.factors.get(String(values[0]));
    return id ? { rows: [{ id, activated_at: store.factorActivatedAt.get(String(values[0])) ?? new Date(0) }], rowCount: 1 }
      : none;
  }
  if (sql.includes('select distinct account_id::text from auth.session_single_sign_on')) {
    const accounts = [...new Set(store.links.filter((link) => link.sid === values[0]
      && (values[1] === null || link.accountId === values[1])).map((link) => link.accountId))].sort();
    return { rows: accounts.map((account_id) => ({ account_id })), rowCount: accounts.length };
  }
  if (sql.includes('update auth.sessions')) {
    const families = sql.includes('from auth.session_single_sign_on')
      ? new Set(store.links.filter((link) => link.sid === values[0] && (values[1] === null || link.accountId === values[1]))
        .map((link) => link.familyId))
      : undefined;
    const ended = store.sessions.filter((session) => !session.revoked
      && (families ? families.has(session.familyId) : session.accountId === values[0])
      && (!sql.includes('session_kind = $2') || session.kind === values[1]));
    for (const session of ended) session.revoked = true;
    return { rows: ended.map((session) => ({ id: session.id, account_id: session.accountId, family_id: session.familyId })),
      rowCount: ended.length };
  }
  if (sql.includes('platform.control_enabled')) return { rows: [{ enabled: true }], rowCount: 1 };
  throw new Error(`unexpected SQL: ${sql}`);
}

async function buildApp(ssoOn: boolean): Promise<void> {
  const labKeys = await clientKeyPair('lab-client-key');
  const secret = randomBytes(24).toString('hex');
  const ssoSettings = {
    AUTH_SSO_ISSUER: ISSUER,
    AUTH_SSO_CLIENTS: JSON.stringify([
      { client_id: 'lab', host: new URL(LAB).host, kind: 'staff', token_endpoint_auth_method: 'private_key_jwt' },
      { client_id: 'web', host: new URL(PORTAL).host, kind: 'patient', token_endpoint_auth_method: 'client_secret_basic' },
    ]),
    AUTH_SSO_CLIENT_CREDENTIALS: JSON.stringify({ lab: { private_jwk: labKeys.privateJwk }, web: { client_secret: secret } }),
  };
  for (const name of ['AUTH_SSO_ISSUER', 'AUTH_SSO_INTERNAL_BASE_URL', 'AUTH_SSO_CLIENTS', 'AUTH_SSO_CLIENT_CREDENTIALS']) {
    delete process.env[name];
  }
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid', CORS_ORIGINS: `${LAB},${PORTAL},${ADMIN}`,
    AUTH_MODE: 'local', AUTH_COOKIE_NAME: 'hid_access', AUTH_COOKIE_SECURE: 'true', AUTH_SIGNING_SECRET: SIGNING_SECRET,
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters', TURNSTILE_MODE: 'disabled',
    ...(ssoOn ? ssoSettings : {}),
  });
  resetEnvironmentForTests();
  clockOffset = 0;
  provider = await createFakeProvider(ISSUER, {
    lab: { kind: 'staff', redirectUri: `${LAB}/api/v1/auth/sso/callback`, publicJwk: labKeys.publicJwk },
    web: { kind: 'patient', redirectUri: `${PORTAL}/api/v1/auth/sso/callback`, secret },
  });
  store = { accounts: new Map([[STAFF_ACCOUNT, 'synthetic:staff'], [PATIENT_ACCOUNT, 'synthetic:patient'],
    [OTHER_PATIENT_ACCOUNT, 'synthetic:other-patient']]),
    factors: new Map([[STAFF_ACCOUNT, 'f1000000-0000-4000-8000-000000000001']]), sessions: [], links: [], spent: new Set(),
    access: new Map(), passwordChangedAt: new Map(), factorActivatedAt: new Map() };
  tokens = {
    issueStaffSession: jest.fn(async (_client: unknown, assurance: { accountId: string }, _event: unknown,
      provenance?: SingleSignOnProvenance) => newSession('staff', assurance.accountId, provenance)),
    issue: jest.fn(async (identity: { accountId: string }, _event: unknown, provenance?: SingleSignOnProvenance) =>
      newSession('patient', identity.accountId, provenance)),
    verify: jest.fn(async (token: string) => {
      const live = store.access.get(token);
      if (!live || store.sessions.find((session) => session.id === live.actor.sessionId)?.revoked) {
        throw new UnauthorizedException('Invalid or expired access token');
      }
      return live;
    }),
    verifyCsrf: jest.fn((claims: { csrf_hash: string }, cookie?: string, header?: string) =>
      Boolean(cookie) && cookie === header && claims.csrf_hash === `hash-${cookie}`),
    verifyRefreshCsrf: jest.fn((refresh: string, cookie?: string, header?: string) =>
      Boolean(cookie) && cookie === header && cookie === `csrf-${refresh.split('.')[0]}`),
    recordSessionEvent: jest.fn(async () => undefined),
    // As TokenService answers it: the kind of a sign-in refresh could renew now, else nothing.
    refreshSessionKind: jest.fn(async (refresh: string) => {
      const session = store.sessions.find((candidate) => candidate.refreshHash === sha256(refresh));
      return session && !session.revoked ? session.kind : undefined;
    }),
    // As TokenService.revoke (today's sign-out): the whole sign-in of that session.
    revoke: jest.fn(async (sessionId: string) => {
      const session = store.sessions.find((candidate) => candidate.id === sessionId);
      if (!session || session.revoked) return false;
      for (const member of store.sessions) if (member.familyId === session.familyId) member.revoked = true;
      return true;
    }),
  };
  auth = {
    revoke: jest.fn(async (sessionId: string) => {
      const session = store.sessions.find((candidate) => candidate.id === sessionId);
      if (!session || session.revoked) return false;
      for (const member of store.sessions) if (member.familyId === session.familyId) member.revoked = true;
      return true;
    }),
    // As TokenService.refresh answers a sign-in that ended other than by rotation (refresh-revocation-reason.spec.ts).
    refresh: jest.fn(async (refresh: string) => {
      const session = store.sessions.find((candidate) => candidate.refreshHash === sha256(refresh));
      if (!session || session.revoked) throw new UnauthorizedException('Refresh session ended');
      throw new Error('a live refresh is not part of these tests');
    }),
    revokeByRefreshToken: jest.fn(async (refresh: string) => {
      const session = store.sessions.find((candidate) => candidate.refreshHash === sha256(refresh));
      if (!session || session.revoked) return undefined;
      session.revoked = true;
      return { sessionId: session.id, accountId: session.accountId, actorSubject: 'synthetic', kind: session.kind };
    }),
  };
  audit = { record: jest.fn(async () => undefined), recordWithClient: jest.fn(async () => undefined) };
  sessionAudit = { record: jest.fn(async () => undefined) };
  database = { query: jest.fn(runQuery),
    withSystemTransaction: jest.fn(async (_id: string, operation: (client: unknown) => unknown) =>
      operation({ query: runQuery })) };
  const module = await Test.createTestingModule({
    controllers: [SsoController, AuthController],
    providers: [
      SsoService, SsoProviderClient,
      { provide: SSO_HTTP, useValue: provider.http },
      { provide: SSO_CLOCK, useValue: () => Date.now() + clockOffset },
      { provide: TokenService, useValue: tokens },
      { provide: AuthService, useValue: auth },
      { provide: AuditService, useValue: audit },
      { provide: AuthSessionAuditService, useValue: sessionAudit },
      { provide: DatabaseService, useValue: database },
      { provide: WorkloadAuthService, useValue: {} },
      { provide: TurnstileService, useValue: {} },
      { provide: GoogleAuthenticationService, useValue: {} },
      { provide: MfaService, useValue: {} },
      // As AppModule wires them.
      SecurityGuard, { provide: APP_GUARD, useExisting: SecurityGuard },
      { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    ],
  }).compile();
  const nest = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  // As main.ts configures it: cookies, the JSON body parser only, the problem filter.
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
const cookieNamed = (response: request.Response, prefix: string) =>
  cookiesOf(response).find((cookie) => cookie.startsWith(prefix));
const valueOf = (cookie: string | undefined) => cookie?.split(';')[0]!.split('=').slice(1).join('=') ?? '';
const staffClaims = (extra: JWTPayload = {}): JWTPayload =>
  ({ sub: STAFF_ACCOUNT, sid: 'provider-session-1', hid_kind: 'staff', amr: ['pwd', 'otp'], ...extra });

/** start → provider sign-in → the callback request it leads to (not yet sent). */
async function signIn(origin: string, claims: JWTPayload, returnTo = '/lab/queue') {
  const started = await http().get(`/api/v1/auth/sso/start?return_to=${encodeURIComponent(returnTo)}`)
    .set('X-HID-Edge-Origin', origin);
  expect(started.status).toBe(303);
  const transaction = cookieNamed(started, '__Host-hid_sso_tx_')!;
  const location = new URL(started.headers.location as string);
  const code = provider.authorize(location.href, claims);
  const callbackPath = `/api/v1/auth/sso/callback?code=${encodeURIComponent(code)}&state=${location.searchParams.get('state')}`;
  return { started, transaction, location, code, callbackPath,
    callback: () => http().get(callbackPath).set('X-HID-Edge-Origin', origin)
      .set('Cookie', transaction.split(';')[0]!) };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});
afterAll(() => resetEnvironmentForTests());

describe('dark until configured', () => {
  /** The answer, without the parts that name the request, for comparing with an unknown route's. */
  const shape = (response: request.Response) => ({ status: response.status, code: response.body.code,
    title: response.body.title, type: response.body.type, detail: String(response.body.detail).replace(/ \/\S*$/, ''),
    setCookie: response.headers['set-cookie'], location: response.headers.location,
    referrerPolicy: response.headers['referrer-policy'] });

  it.each<[string, (origin: string) => request.Test, () => request.Test]>([
    ['GET start', (origin) => http().get('/api/v1/auth/sso/start?return_to=%2Flab').set('X-HID-Edge-Origin', origin),
      () => http().get('/api/v1/auth/sso/no-such-route?return_to=%2Flab')],
    ['GET callback', (origin) => http().get('/api/v1/auth/sso/callback?code=c&state=s').set('X-HID-Edge-Origin', origin),
      () => http().get('/api/v1/auth/sso/no-such-route?code=c&state=s')],
    ['POST back-channel logout', (origin) => http().post('/api/v1/auth/sso/backchannel-logout').set('X-HID-Edge-Origin', origin)
      .type('form').send('logout_token=x'), () => http().post('/api/v1/auth/sso/no-such-route').type('form').send('logout_token=x')],
    ['POST product sign-out', (origin) => http().post('/api/v1/auth/sso/logout').set('X-HID-Edge-Origin', origin)
      .set('Origin', origin).send({}), () => http().post('/api/v1/auth/sso/no-such-route').set('Origin', LAB).send({})],
  ])('%s answers exactly as a route that does not exist while the settings are unset', async (_label, call, unknown) => {
    await buildApp(false);
    const expected = shape(await unknown());
    expect(expected).toMatchObject({ status: 404, code: 'NOT_FOUND', setCookie: undefined, location: undefined });
    expect(shape(await call(LAB))).toEqual(expected);
    expect(audit.record).not.toHaveBeenCalled();
    expect(sessionAudit.record).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
    expect(provider.calls).toEqual([]);
  });

  it('answers the same on a host that is not a client while single sign-on is on', async () => {
    await buildApp(true);
    for (const origin of [ADMIN, ISSUER, undefined]) {
      const call = http().get('/api/v1/auth/sso/start?return_to=%2F');
      const response = origin ? await call.set('X-HID-Edge-Origin', origin) : await call;
      expect([response.status, response.body.code, response.headers['set-cookie']]).toEqual([404, 'NOT_FOUND', undefined]);
    }
    expect(provider.calls).toEqual([]);
  });

  it('answers a refused session check as today, clearing no cookie, while the settings are unset', async () => {
    await buildApp(false);
    const session = newSession('staff', STAFF_ACCOUNT);
    store.sessions[0]!.revoked = true;
    const response = await http().get('/api/v1/auth/session').set('X-HID-Edge-Origin', LAB)
      .set('Cookie', [`hid_access=${session.accessToken}`, `hid_access_refresh=${session.refreshToken}`,
        `hid_access_csrf=${session.csrfToken}`]);
    expect([response.status, response.body.code]).toEqual([401, 'AUTHENTICATION_REQUIRED']);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(tokens.refreshSessionKind).not.toHaveBeenCalled();
  });

  it('leaves today\'s sign-out as it is, single sign-on on or off: 204 and no address', async () => {
    for (const on of [false, true]) {
      await app?.close();
      await buildApp(on);
      const session = newSession('staff', STAFF_ACCOUNT);
      const response = await http().post('/api/v1/auth/logout').set('X-HID-Edge-Origin', LAB).set('Origin', LAB)
        .set('X-CSRF-Token', session.csrfToken)
        .set('Cookie', [`hid_access=${session.accessToken}`, `hid_access_csrf=${session.csrfToken}`]);
      expect([response.status, response.text]).toEqual([204, '']);
    }
  });
});

describe('with single sign-on configured', () => {
  beforeEach(() => buildApp(true));

  describe('GET /auth/sso/start', () => {
    it('sends the browser to the provider with PKCE S256, state, nonce and max_age, and keeps the rest in a __Host- cookie', async () => {
      const response = await http().get('/api/v1/auth/sso/start?return_to=%2Flab%2Fqueue').set('X-HID-Edge-Origin', LAB);
      expect(response.status).toBe(303);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      const location = new URL(response.headers.location as string);
      expect(location.origin + location.pathname).toBe(`${ISSUER}/auth`);
      expect(Object.fromEntries(location.searchParams)).toEqual({
        client_id: 'lab', redirect_uri: `${LAB}/api/v1/auth/sso/callback`, response_type: 'code', scope: 'openid',
        state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: 'S256', max_age: '86400',
      });
      // The return page never travels to the provider.
      expect(location.href).not.toContain('queue');
      const cookie = cookieNamed(response, '__Host-hid_sso_tx_')!;
      expect(cookie.split(';')[0]!.split('=')[0]).toBe(transactionCookieName(location.searchParams.get('state')!));
      expect(cookie).toMatch(/; Max-Age=600; /);
      expect(cookie).toMatch(/; Path=\//);
      expect(cookie).toMatch(/; HttpOnly/);
      expect(cookie).toMatch(/; Secure/);
      expect(cookie).toMatch(/; SameSite=Lax/);
      expect(cookie).not.toMatch(/Domain=/i);
      expect(cookie).not.toContain(location.searchParams.get('nonce')!);
    });

    it('asks the provider for no page, or for a fresh sign-in, only when asked', async () => {
      const prompt = async (query: string) => new URL((await http().get(`/api/v1/auth/sso/start?return_to=%2F${query}`)
        .set('X-HID-Edge-Origin', LAB)).headers.location as string).searchParams.get('prompt');
      expect(await prompt('&prompt=none')).toBe('none');
      expect(await prompt('&prompt=login')).toBe('login');
      for (const other of ['', '&prompt=consent', '&prompt=none%20login', '&prompt=select_account']) {
        expect(await prompt(other)).toBeNull();
      }
    });

    it('goes straight back with a live session of this product, without asking the provider', async () => {
      const session = newSession('staff', STAFF_ACCOUNT);
      const response = await http().get('/api/v1/auth/sso/start?return_to=%2Flab%2Fqueue').set('X-HID-Edge-Origin', LAB)
        .set('Cookie', `hid_access=${session.accessToken}`);
      expect([response.status, response.headers.location]).toEqual([303, '/lab/queue']);
      expect(provider.calls).toEqual([]);
      // A patient session does not count on a staff product.
      const patient = newSession('patient', PATIENT_ACCOUNT);
      const other = await http().get('/api/v1/auth/sso/start?return_to=%2Flab%2Fqueue').set('X-HID-Edge-Origin', LAB)
        .set('Cookie', `hid_access=${patient.accessToken}`);
      expect(new URL(other.headers.location as string).origin).toBe(ISSUER);
    });

    it('asks the provider for a fresh sign-in when asked, even over a live session of this product', async () => {
      // As before a PIN change: the recent sign-in check counts from the provider's auth_time.
      for (const [origin, session] of [[PORTAL, newSession('patient', PATIENT_ACCOUNT)],
        [LAB, newSession('staff', STAFF_ACCOUNT)]] as const) {
        const response = await http().get('/api/v1/auth/sso/start?return_to=%2Fsettings&prompt=login')
          .set('X-HID-Edge-Origin', origin).set('Cookie', `hid_access=${session.accessToken}`);
        expect(response.status).toBe(303);
        const location = new URL(response.headers.location as string);
        expect([location.origin, location.searchParams.get('prompt')]).toEqual([ISSUER, 'login']);
        expect(cookieNamed(response, '__Host-hid_sso_tx_')).toMatch(/Max-Age=600/);
      }
    });

    it.each(['//evil.invalid/', 'https://evil.invalid/', '/api/v1/auth/logout', '/patients/HID-ABCDEFGH',
      '/patients/HIDZDEMAAA2', '/a/../b', '/%61pi/v1/auth/logout', '/patients/h%69d-ABCDEFGH'])(
      'never returns to %s: the page is replaced by / and never repaired', async (returnTo) => {
        const { callback } = await signIn(LAB, staffClaims(), returnTo);
        const response = await callback();
        expect([response.status, response.headers.location]).toEqual([303, '/']);
      });

    it('sends the browser to the product\'s own sign-in page when the provider cannot be asked', async () => {
      provider.down.discovery = true;
      const response = await http().get('/api/v1/auth/sso/start?return_to=%2Flab').set('X-HID-Edge-Origin', LAB);
      expect([response.status, response.headers.location]).toEqual([303, '/provider/sign-in']);
      expect(cookieNamed(response, '__Host-hid_sso_tx_')).toBeUndefined();
      expect(cookieNamed(response, `${SSO_FALLBACK_COOKIE}=`)).toBeDefined();
      expect(sessionAudit.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'login_failed',
        outcome: 'failure', details: { authentication_method: 'sso', sso_client: 'lab', reason: 'unreachable' } }));
    });

    it('clears the open sign-ins of a browser that holds too many', async () => {
      const open = [1, 2, 3, 4].map((index) => `__Host-hid_sso_tx_${String(index).repeat(16)}=x`);
      const response = await http().get('/api/v1/auth/sso/start?return_to=%2F').set('X-HID-Edge-Origin', LAB)
        .set('Cookie', open.join('; '));
      const cleared = cookiesOf(response).filter((cookie) => /Expires=Thu, 01 Jan 1970/.test(cookie));
      expect(cleared).toHaveLength(4);
    });
  });

  describe('GET /auth/sso/callback', () => {
    it('issues the staff session as a staff sign-in does, stores the provider sid, and returns to the page', async () => {
      const { callback } = await signIn(LAB, staffClaims());
      const response = await callback();
      expect([response.status, response.headers.location]).toEqual([303, '/lab/queue']);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      // Today's session cookies, host-only and Strict, and the transaction cookie cleared.
      for (const name of ['hid_access=', 'hid_access_refresh=', 'hid_access_csrf=']) {
        const cookie = cookieNamed(response, name);
        expect(cookie).toMatch(/SameSite=Strict/);
        expect(cookie).not.toMatch(/Domain=/i);
      }
      expect(cookieNamed(response, '__Host-hid_sso_tx_')).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(tokens.issueStaffSession).toHaveBeenCalledWith(expect.anything(),
        { accountId: STAFF_ACCOUNT, subject: 'synthetic:staff', factorId: 'f1000000-0000-4000-8000-000000000001', method: 'totp' },
        expect.objectContaining({ correlationId: CORRELATION }),
        { clientId: 'lab', providerSid: 'provider-session-1', authenticatedAt: expect.any(Date) });
      expect(database.withSystemTransaction).toHaveBeenCalled();
      expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'auth.login', actorType: 'staff', actorAccountId: STAFF_ACCOUNT, outcome: 'success',
        details: { mfaMethod: 'totp', singleSignOn: 'lab' } }));
      // Nothing identifying in the address it answers.
      expect(response.headers.location).not.toContain(STAFF_ACCOUNT);
    });

    it('issues a patient session for the patient portal through today\'s patient issue', async () => {
      const { callback } = await signIn(PORTAL, { sub: PATIENT_ACCOUNT, sid: 'provider-session-2', hid_kind: 'patient' }, '/');
      const response = await callback();
      expect([response.status, response.headers.location]).toEqual([303, '/']);
      expect(tokens.issue).toHaveBeenCalledWith(expect.objectContaining({ actorKind: 'patient', accountId: PATIENT_ACCOUNT,
        subject: 'synthetic:patient', authenticationMethod: 'local' }), expect.anything(),
      expect.objectContaining({ clientId: 'web', providerSid: 'provider-session-2' }));
      expect(provider.lastTokenRequest!.authorization).toMatch(/^Basic /);
    });

    async function refusedCallback(response: request.Response, reason: string | RegExp, signInPath = '/provider/sign-in') {
      expect([response.status, response.headers.location]).toEqual([303, signInPath]);
      expect(cookieNamed(response, `${SSO_FALLBACK_COOKIE}=`)).toMatch(/^__Host-hid_sso_fallback=1; Max-Age=120; Path=\/; Expires=[^;]+; HttpOnly; Secure; SameSite=Lax$/);
      expect(cookiesOf(response).some((cookie) => cookie.startsWith('hid_access'))).toBe(false);
      expect(tokens.issueStaffSession).not.toHaveBeenCalled();
      expect(tokens.issue).not.toHaveBeenCalled();
      const details = sessionAudit.record.mock.calls.at(-1)?.[0]?.details;
      expect(details).toMatchObject({ authentication_method: 'sso' });
      expect(details.reason).toMatch(reason);
    }

    it('spends the transaction once: the same callback again is refused', async () => {
      const { callback } = await signIn(LAB, staffClaims());
      expect((await callback()).headers.location).toBe('/lab/queue');
      tokens.issueStaffSession.mockClear();
      await refusedCallback(await callback(), 'transaction_replayed');
    });

    it('refuses a callback without its transaction cookie (login CSRF)', async () => {
      const { callbackPath } = await signIn(LAB, staffClaims());
      await refusedCallback(await http().get(callbackPath).set('X-HID-Edge-Origin', LAB), /^transaction$/);
    });

    it('refuses a transaction cookie that was changed, belongs to another state or has expired', async () => {
      const { callbackPath, transaction, location } = await signIn(LAB, staffClaims());
      const [name, value] = transaction.split(';')[0]!.split('=') as [string, string];
      const [payload, mac] = value.split('.') as [string, string];
      const changed = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
        r: '/elsewhere' })).toString('base64url')}.${mac}`;
      await refusedCallback(await http().get(callbackPath).set('X-HID-Edge-Origin', LAB).set('Cookie', `${name}=${changed}`),
        /^transaction$/);
      const other = sealTransaction(SIGNING_SECRET, newTransaction('lab', '/lab/queue', false));
      await refusedCallback(await http().get(callbackPath).set('X-HID-Edge-Origin', LAB).set('Cookie', `${name}=${other}`),
        /^transaction$/);
      const expired = sealTransaction(SIGNING_SECRET, { ...newTransaction('lab', '/', false, Date.now() - 601_000),
        state: location.searchParams.get('state')! });
      await refusedCallback(await http().get(callbackPath).set('X-HID-Edge-Origin', LAB).set('Cookie', `${name}=${expired}`),
        /^transaction$/);
    });

    it('refuses a transaction another product host started', async () => {
      const { callbackPath, transaction } = await signIn(LAB, staffClaims());
      await refusedCallback(await http().get(callbackPath).set('X-HID-Edge-Origin', PORTAL)
        .set('Cookie', transaction.split(';')[0]!), 'transaction_client', '/sign-in');
    });

    it('starts again with a page when a silent attempt needs the person, and refuses that answer otherwise', async () => {
      const started = await http().get('/api/v1/auth/sso/start?return_to=%2Flab&prompt=none').set('X-HID-Edge-Origin', LAB);
      const state = new URL(started.headers.location as string).searchParams.get('state')!;
      const response = await http().get(`/api/v1/auth/sso/callback?error=login_required&state=${state}`)
        .set('X-HID-Edge-Origin', LAB).set('Cookie', cookieNamed(started, '__Host-hid_sso_tx_')!.split(';')[0]!);
      expect(response.status).toBe(303);
      const again = new URL(response.headers.location as string);
      expect(again.origin).toBe(ISSUER);
      expect(again.searchParams.has('prompt')).toBe(false);
      expect(again.searchParams.get('state')).not.toBe(state);
      expect(cookieNamed(response, transactionCookieName(again.searchParams.get('state')!))).toMatch(/Max-Age=600/);

      const page = await http().get('/api/v1/auth/sso/start?return_to=%2Flab').set('X-HID-Edge-Origin', LAB);
      const pageState = new URL(page.headers.location as string).searchParams.get('state')!;
      await refusedCallback(await http().get(`/api/v1/auth/sso/callback?error=login_required&state=${pageState}`)
        .set('X-HID-Edge-Origin', LAB).set('Cookie', cookieNamed(page, '__Host-hid_sso_tx_')!.split(';')[0]!),
      'provider_error:login_required');
    });

    it.each<[string, () => void, string | RegExp]>([
      ['an ID token for another nonce', () => { provider.idTokenOverrides = { nonce: 'x'.repeat(43) }; }, /"nonce" claim value/],
      ['an ID token for another audience', () => { provider.idTokenOverrides = { aud: 'ehr' }; }, /"aud" \(audience\) claim value/],
      ['an ID token from another issuer', () => { provider.idTokenOverrides = { iss: 'https://auth.elsewhere.invalid' }; },
        /"iss" \(issuer\) claim value/],
      ['an expired ID token', () => { provider.idTokenOverrides = { exp: Math.floor(Date.now() / 1_000) - 120 }; },
        /"exp" \(expiration time\) claim value/],
      ['a patient sign-in', () => { provider.idTokenOverrides = { hid_kind: 'patient' }; }, 'kind'],
      ['a password without a second factor', () => { provider.idTokenOverrides = { amr: ['pwd'] }; }, 'staff_mfa'],
      ['a sign-in older than the absolute lifetime', () => {
        provider.idTokenOverrides = { auth_time: Math.floor(Date.now() / 1_000) - 86_400 - 120 }; },
      /too much time has elapsed/],
      ['an account without a proven authenticator', () => { store.factors.clear(); }, 'session_refused_403'],
      ['a provider sign-in from before the password was changed (recovery)', () => {
        provider.idTokenOverrides = { auth_time: nowSeconds() - 600 };
        store.passwordChangedAt.set(STAFF_ACCOUNT, new Date(Date.now() - 60_000));
      }, 'stale_provider_sign_in'],
      ['a provider sign-in from before its authenticator was activated (a new enrolment after a reset)', () => {
        provider.idTokenOverrides = { auth_time: nowSeconds() - 600 };
        store.factorActivatedAt.set(STAFF_ACCOUNT, new Date(Date.now() - 60_000));
      }, 'stale_provider_sign_in'],
      ['a password change that cannot be read', () => { store.passwordChangedAt.set(STAFF_ACCOUNT, new Date(Number.NaN)); },
        'stale_provider_sign_in'],
      ['an unknown account', () => { store.accounts.clear(); }, 'session_refused_401'],
      ['a refused code', () => { provider.tokenAnswer = { status: 400, body: { error: 'invalid_grant' } }; },
        'token endpoint refused the code: invalid_grant'],
      ['a provider outage', () => { provider.down.token = true; }, 'unreachable'],
    ])('refuses %s and sends the browser to the product\'s own sign-in page', async (_label, arrange, reason) => {
      const { callback } = await signIn(LAB, staffClaims());
      arrange();
      await refusedCallback(await callback(), reason);
    });

    describe('a fresh sign-in asked for over a live session', () => {
      async function freshSignIn(claims: JWTPayload) {
        const earlier = newSession('patient', PATIENT_ACCOUNT);
        const started = await http().get('/api/v1/auth/sso/start?return_to=%2Fsettings&prompt=login')
          .set('X-HID-Edge-Origin', PORTAL).set('Cookie', `hid_access=${earlier.accessToken}`);
        const location = new URL(started.headers.location as string);
        const code = provider.authorize(location.href, claims);
        const response = await http()
          .get(`/api/v1/auth/sso/callback?code=${encodeURIComponent(code)}&state=${location.searchParams.get('state')}`)
          .set('X-HID-Edge-Origin', PORTAL)
          .set('Cookie', [cookieNamed(started, '__Host-hid_sso_tx_')!.split(';')[0]!, `hid_access=${earlier.accessToken}`]);
        return { earlier, response };
      }
      const earlierRevoked = (sessionId: string | undefined) =>
        store.sessions.find((session) => session.id === sessionId)?.revoked;

      it('replaces the earlier sign-in of the same account, so the browser keeps one', async () => {
        const { earlier, response } = await freshSignIn({ sub: PATIENT_ACCOUNT, sid: 'provider-session-2', hid_kind: 'patient' });
        expect([response.status, response.headers.location]).toEqual([303, '/settings']);
        expect(valueOf(cookieNamed(response, 'hid_access='))).not.toBe(earlier.accessToken);
        expect(tokens.issue).toHaveBeenCalledTimes(1);
        expect(tokens.revoke).toHaveBeenCalledWith(earlier.actor.sessionId, 'synthetic:patient',
          expect.objectContaining({ correlationId: CORRELATION }));
        expect(earlierRevoked(earlier.actor.sessionId)).toBe(true);
      });

      it('refuses a fresh sign-in as another account, and leaves the earlier sign-in as it was', async () => {
        const { earlier, response } = await freshSignIn({ sub: OTHER_PATIENT_ACCOUNT, sid: 'provider-session-3',
          hid_kind: 'patient' });
        await refusedCallback(response, 'account_changed', '/sign-in');
        expect(tokens.revoke).not.toHaveBeenCalled();
        expect(earlierRevoked(earlier.actor.sessionId)).toBe(false);
      });
    });

    it('refuses a patient\'s provider sign-in from before the password was changed', async () => {
      store.passwordChangedAt.set(PATIENT_ACCOUNT, new Date(Date.now() - 60_000));
      const { callback } = await signIn(PORTAL, { sub: PATIENT_ACCOUNT, sid: 'provider-session-2', hid_kind: 'patient',
        auth_time: nowSeconds() - 600 }, '/');
      await refusedCallback(await callback(), 'stale_provider_sign_in', '/sign-in');
    });

    it('accepts credentials changed before the provider sign-in, or within five seconds after it', async () => {
      const signedInAt = nowSeconds() - 600;
      store.passwordChangedAt.set(STAFF_ACCOUNT, new Date(signedInAt * 1_000 - 86_400_000));
      store.factorActivatedAt.set(STAFF_ACCOUNT, new Date(signedInAt * 1_000 + 4_000));
      store.passwordChangedAt.set(PATIENT_ACCOUNT, new Date(signedInAt * 1_000 + 4_000));
      const staff = await (await signIn(LAB, staffClaims({ auth_time: signedInAt }))).callback();
      expect([staff.status, staff.headers.location]).toEqual([303, '/lab/queue']);
      const patient = await (await signIn(PORTAL, { sub: PATIENT_ACCOUNT, sid: 'provider-session-2', hid_kind: 'patient',
        auth_time: signedInAt }, '/')).callback();
      expect([patient.status, patient.headers.location]).toEqual([303, '/']);
    });

    it('never hands off silently again just after a fallback: the person is asked, or the browser goes to the root', async () => {
      const fallback = `${SSO_FALLBACK_COOKIE}=1`;
      // A refused hand-off (here a patient sign-in on a staff product) leaves the marker.
      const { callback } = await signIn(LAB, staffClaims({ hid_kind: 'patient' }));
      const refused = await callback();
      expect([refused.status, refused.headers.location]).toEqual([303, '/provider/sign-in']);
      expect(cookieNamed(refused, `${SSO_FALLBACK_COOKIE}=1`)).toBeDefined();
      // The next start asks for a fresh sign-in, even when a quiet check was asked for.
      for (const query of ['', '&prompt=none']) {
        const again = await http().get(`/api/v1/auth/sso/start?return_to=%2Flab${query}`).set('X-HID-Edge-Origin', LAB)
          .set('Cookie', fallback);
        expect(new URL(again.headers.location as string).searchParams.get('prompt')).toBe('login');
      }
      // While the provider stays unreachable, the root (the landing page while signed out), never the sign-in page again.
      provider.down.discovery = true;
      clockOffset = SSO_METADATA_TTL_MS + 1;
      const down = await http().get('/api/v1/auth/sso/start?return_to=%2Flab').set('X-HID-Edge-Origin', LAB)
        .set('Cookie', fallback);
      expect([down.status, down.headers.location]).toEqual([303, '/']);
      // A sign-in that succeeds clears it.
      provider.down.discovery = false;
      const signedIn = await (await signIn(LAB, staffClaims())).callback();
      expect(signedIn.headers.location).toBe('/lab/queue');
      expect(cookieNamed(signedIn, `${SSO_FALLBACK_COOKIE}=`)).toMatch(/Expires=Thu, 01 Jan 1970/);
    });
  });

  describe('POST /auth/sso/backchannel-logout', () => {
    const post = (body: string, type = 'application/x-www-form-urlencoded', origin = LAB) =>
      http().post('/api/v1/auth/sso/backchannel-logout').set('X-HID-Edge-Origin', origin).set('Content-Type', type).send(body);

    async function signedInEverywhere() {
      await (await signIn(LAB, staffClaims())).callback();
      await (await signIn(LAB, staffClaims({ sid: 'provider-session-9' }))).callback();
      const other = newSession('staff', STAFF_ACCOUNT);
      return other;
    }

    it('ends every sign-in of the provider session, once, and answers 200 with no-store', async () => {
      await signedInEverywhere();
      const token = await provider.signLogoutToken({ aud: 'lab', sid: 'provider-session-1', sub: STAFF_ACCOUNT });
      const response = await post(`logout_token=${token}`);
      expect([response.status, response.text]).toEqual([200, '']);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['set-cookie']).toBeUndefined();
      const linked = (sid: string) => store.links.filter((link) => link.sid === sid).map((link) => link.familyId);
      expect(store.sessions.filter((session) => session.revoked).map((session) => session.id)).toEqual(linked('provider-session-1'));
      expect(tokens.recordSessionEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'revoked',
        details: { reason: 'sso_logout', sso_client: 'lab' } }));
      expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorType: 'system',
        action: 'auth.sso.backchannel-logout', details: { client: 'lab', matchedBy: 'sid', endedSignIns: 1 } }));
      // The same token again (its jti) is refused.
      const replay = await post(`logout_token=${token}`);
      expect([replay.status, replay.body.code]).toEqual([400, 'SSO_LOGOUT_TOKEN_INVALID']);
    });

    it('ends every staff and patient sign-in of the account when the token names only the account', async () => {
      await signedInEverywhere();
      const response = await post(`logout_token=${await provider.signLogoutToken({ aud: 'lab', sub: STAFF_ACCOUNT })}`);
      expect(response.status).toBe(200);
      expect(store.sessions.every((session) => session.revoked)).toBe(true);
    });

    const FORM = 'application/x-www-form-urlencoded';
    it.each<[string, () => Promise<string>, string]>([
      ['a refused token', async () => `logout_token=${await provider.signLogoutToken({ aud: 'lab', sid: 'p', nonce: 'n' })}`,
        FORM],
      ['a token for another product', async () => `logout_token=${await provider.signLogoutToken({ aud: 'web', sid: 'p' })}`,
        FORM],
      ['no token', async () => 'other=1', FORM],
      ['two tokens', async () => {
        const token = await provider.signLogoutToken({ aud: 'lab', sid: 'p' });
        return `logout_token=${token}&logout_token=${token}`;
      }, FORM],
      ['a JSON body', async () => JSON.stringify({ logout_token: await provider.signLogoutToken({ aud: 'lab', sid: 'p' }) }),
        'application/json'],
    ])('answers 400 to %s and ends nothing', async (_label, body, type) => {
      await signedInEverywhere();
      const response = await post(await body(), type);
      expect([response.status, response.body.code]).toEqual([400, 'SSO_LOGOUT_TOKEN_INVALID']);
      expect(store.sessions.some((session) => session.revoked)).toBe(false);
    });

    it('answers 503 when the provider\'s key set cannot be read, so the provider may retry', async () => {
      provider.down.keys = true;
      const response = await post(`logout_token=${await provider.signLogoutToken({ aud: 'lab', sid: 'provider-session-1' })}`);
      expect([response.status, response.body.code]).toEqual([503, 'SSO_PROVIDER_UNAVAILABLE']);
    });

    it('refuses a form larger than 16 KiB', async () => {
      const response = await post(`logout_token=${'a'.repeat(17_000)}`);
      expect(response.status).toBe(413);
    });
  });

  describe('after sign-out everywhere, on a site that kept its cookies', () => {
    async function signedInThenSignedOutEverywhere() {
      const response = await (await signIn(LAB, staffClaims())).callback();
      const cookie = (name: string) => valueOf(cookieNamed(response, `${name}=`));
      const session = { access: cookie('hid_access'), refresh: cookie('hid_access_refresh'), csrf: cookie('hid_access_csrf') };
      const logout = await http().post('/api/v1/auth/sso/backchannel-logout').set('X-HID-Edge-Origin', LAB)
        .type('form').send(`logout_token=${await provider.signLogoutToken({ aud: 'lab', sid: 'provider-session-1' })}`);
      expect(logout.status).toBe(200);
      return session;
    }
    const cleared = (response: request.Response) => ['hid_access=', 'hid_access_refresh=', 'hid_access_csrf=']
      .map((name) => cookieNamed(response, name)).every((cookie) => /Expires=Thu, 01 Jan 1970/.test(cookie ?? ''));

    it('the first refused session check clears this site\'s session cookies, so the edge shows the landing page', async () => {
      const session = await signedInThenSignedOutEverywhere();
      const response = await http().get('/api/v1/auth/session').set('X-HID-Edge-Origin', LAB)
        .set('Cookie', [`hid_access=${session.access}`, `hid_access_refresh=${session.refresh}`, `hid_access_csrf=${session.csrf}`]);
      expect([response.status, response.body.code]).toEqual([401, 'AUTHENTICATION_REQUIRED']);
      expect(cleared(response)).toBe(true);
      // The csrf cookie is Path=/, so the edge no longer sees it.
      expect(cookieNamed(response, 'hid_access_csrf=')).toMatch(/Path=\//);
    });

    it('a refused refresh clears them too', async () => {
      const session = await signedInThenSignedOutEverywhere();
      const response = await http().post('/api/v1/auth/refresh').set('X-HID-Edge-Origin', LAB).set('Origin', LAB)
        .set('X-CSRF-Token', `csrf-${session.refresh.split('.')[0]}`)
        .set('Cookie', [`hid_access_refresh=${session.refresh}`, `hid_access_csrf=csrf-${session.refresh.split('.')[0]}`]);
      expect(response.status).toBe(401);
      expect(cleared(response)).toBe(true);
    });

    it('keeps the cookies of a sign-in that still renews: only its access token expired', async () => {
      const response = await (await signIn(LAB, staffClaims())).callback();
      const refresh = valueOf(cookieNamed(response, 'hid_access_refresh='));
      const check = await http().get('/api/v1/auth/session').set('X-HID-Edge-Origin', LAB)
        .set('Cookie', [`hid_access_refresh=${refresh}`, `hid_access_csrf=csrf-${refresh.split('.')[0]}`]);
      expect(check.status).toBe(401);
      expect(check.headers['set-cookie']).toBeUndefined();
    });

    it('keeps them when whether the sign-in ended cannot be read', async () => {
      const session = await signedInThenSignedOutEverywhere();
      tokens.refreshSessionKind.mockRejectedValueOnce(new Error('database unavailable'));
      const response = await http().get('/api/v1/auth/session').set('X-HID-Edge-Origin', LAB)
        .set('Cookie', [`hid_access=${session.access}`, `hid_access_refresh=${session.refresh}`, `hid_access_csrf=${session.csrf}`]);
      expect([response.status, response.body.code]).toEqual([401, 'AUTHENTICATION_REQUIRED']);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('is today\'s answer, clearing nothing, on a host that is not a client', async () => {
      const session = await signedInThenSignedOutEverywhere();
      const response = await http().get('/api/v1/auth/session').set('X-HID-Edge-Origin', ADMIN)
        .set('Cookie', [`hid_access=${session.access}`, `hid_access_refresh=${session.refresh}`, `hid_access_csrf=${session.csrf}`]);
      expect([response.status, response.body.code]).toEqual([401, 'AUTHENTICATION_REQUIRED']);
      expect(response.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('POST /auth/sso/logout', () => {
    async function signedIn() {
      const response = await (await signIn(LAB, staffClaims())).callback();
      const cookie = (name: string) => valueOf(cookieNamed(response, `${name}=`));
      return { access: cookie('hid_access'), refresh: cookie('hid_access_refresh'), csrf: cookie('hid_access_csrf') };
    }

    it('ends this sign-in as today\'s sign-out does, then answers the end-session address, which carries no token', async () => {
      const session = await signedIn();
      const response = await http().post('/api/v1/auth/sso/logout').set('X-HID-Edge-Origin', LAB).set('Origin', LAB)
        .set('X-CSRF-Token', session.csrf).set('Cookie', [`hid_access=${session.access}`, `hid_access_csrf=${session.csrf}`,
          `hid_access_refresh=${session.refresh}`]);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(auth.revoke).toHaveBeenCalled();
      expect(cookiesOf(response).filter((cookie) => cookie.startsWith('hid_access')).every((cookie) =>
        /Expires=Thu, 01 Jan 1970/.test(cookie))).toBe(true);
      const address = new URL(response.body.endSessionUrl);
      expect(address.origin + address.pathname).toBe(`${ISSUER}/session/end`);
      // Only the client and the product's root: no ID token (no id_token_hint) reaches page JavaScript or an address.
      expect(Object.fromEntries(address.searchParams)).toEqual({ post_logout_redirect_uri: `${LAB}/`, client_id: 'lab' });
      expect(response.text).not.toMatch(/eyJ/);
    });

    const revoked = (sessionId: string | undefined) => store.sessions.find((session) => session.id === sessionId)?.revoked;

    it('also ends the account\'s other sign-ins of that kind, one made on a product\'s own sign-in page included', async () => {
      const session = await signedIn();
      // The provider never saw this one (the fallback page), so its back-channel logout cannot reach it.
      const ownPage = newSession('staff', STAFF_ACCOUNT);
      // Nor one from an earlier provider session.
      await (await signIn(LAB, staffClaims({ sid: 'provider-session-0' }))).callback();
      const earlier = store.sessions.at(-1)!;
      const patientOfSameAccount = newSession('patient', STAFF_ACCOUNT);
      const otherAccount = newSession('staff', OTHER_STAFF_ACCOUNT);
      const response = await http().post('/api/v1/auth/sso/logout').set('X-HID-Edge-Origin', LAB).set('Origin', LAB)
        .set('X-CSRF-Token', session.csrf).set('Cookie', [`hid_access=${session.access}`, `hid_access_csrf=${session.csrf}`]);
      expect(response.status).toBe(200);
      expect([revoked(ownPage.actor.sessionId), revoked(earlier.id)]).toEqual([true, true]);
      expect(store.sessions.filter((each) => each.accountId === STAFF_ACCOUNT && each.kind === 'staff')
        .every((each) => each.revoked)).toBe(true);
      expect([revoked(patientOfSameAccount.actor.sessionId), revoked(otherAccount.actor.sessionId)]).toEqual([false, false]);
      expect(tokens.recordSessionEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        eventType: 'revoked', sessionId: ownPage.actor.sessionId, details: { reason: 'sso_logout', sso_client: 'lab' } }));
      expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'auth.sso.logout', actorType: 'staff', actorAccountId: STAFF_ACCOUNT, outcome: 'success',
        details: { client: 'lab', endedSignIns: 2 } }));
    });

    it('ends the sign-in by the refresh cookie once the access token has expired, with the same address', async () => {
      const session = await signedIn();
      const ownPage = newSession('staff', STAFF_ACCOUNT);
      const response = await http().post('/api/v1/auth/sso/logout').set('X-HID-Edge-Origin', LAB).set('Origin', LAB)
        .set('X-CSRF-Token', `csrf-${session.refresh.split('.')[0]}`)
        .set('Cookie', [`hid_access_csrf=csrf-${session.refresh.split('.')[0]}`, `hid_access_refresh=${session.refresh}`]);
      expect(response.status).toBe(200);
      expect(auth.revokeByRefreshToken).toHaveBeenCalled();
      expect(revoked(ownPage.actor.sessionId)).toBe(true);
      expect(Object.fromEntries(new URL(response.body.endSessionUrl).searchParams))
        .toEqual({ post_logout_redirect_uri: `${LAB}/`, client_id: 'lab' });
    });

    it('answers the same address to a browser with no sign-in, and nothing to a refused sign-out', async () => {
      const session = await signedIn();
      // Neither ends any other sign-in: neither proved one.
      const ownPage = newSession('staff', STAFF_ACCOUNT);
      const afterwards = () => {
        expect(revoked(ownPage.actor.sessionId)).toBe(false);
        expect(audit.recordWithClient).not.toHaveBeenCalledWith(expect.anything(),
          expect.objectContaining({ action: 'auth.sso.logout' }));
      };
      // The refresh cookie without its CSRF token: refused, and no address at all.
      const refused = await http().post('/api/v1/auth/sso/logout').set('X-HID-Edge-Origin', LAB).set('Origin', LAB)
        .set('Cookie', [`hid_access_refresh=${session.refresh}`]);
      expect([refused.status, refused.body.code, refused.body.endSessionUrl]).toEqual([403, 'CSRF_VALIDATION_FAILED', undefined]);
      const none = await http().post('/api/v1/auth/sso/logout').set('X-HID-Edge-Origin', LAB).set('Origin', LAB);
      expect(Object.fromEntries(new URL(none.body.endSessionUrl).searchParams))
        .toEqual({ post_logout_redirect_uri: `${LAB}/`, client_id: 'lab' });
      afterwards();
    });

    it('refuses another origin before anything ends, as today\'s sign-out does', async () => {
      const session = await signedIn();
      const response = await http().post('/api/v1/auth/sso/logout').set('X-HID-Edge-Origin', LAB)
        .set('Origin', 'https://evil.invalid').set('X-CSRF-Token', session.csrf)
        .set('Cookie', [`hid_access=${session.access}`, `hid_access_csrf=${session.csrf}`]);
      expect([response.status, response.body.code]).toEqual([403, 'ORIGIN_DENIED']);
      expect(auth.revoke).not.toHaveBeenCalled();
    });

    it('still ends this sign-in when the provider cannot be reached, and says so', async () => {
      const session = await signedIn();
      provider.down.discovery = true;
      clockOffset = SSO_METADATA_TTL_MS + 1;
      const response = await http().post('/api/v1/auth/sso/logout').set('X-HID-Edge-Origin', LAB).set('Origin', LAB)
        .set('X-CSRF-Token', session.csrf).set('Cookie', [`hid_access=${session.access}`, `hid_access_csrf=${session.csrf}`]);
      expect([response.status, response.body.code]).toEqual([503, 'SSO_PROVIDER_UNAVAILABLE']);
      expect(auth.revoke).toHaveBeenCalled();
    });
  });
});
