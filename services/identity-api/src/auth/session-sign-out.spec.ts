jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { AuthSessionAuditService } from './auth-session-audit.service';
import type { GoogleAuthenticationService } from './google-authentication.service';
import type { TokenService } from './token.service';
import type { TurnstileService } from './turnstile.service';
import type { WorkloadAuthService } from './workload-auth.service';

// P1: a browser whose access cookie has expired (15 minutes) still holds its
// refresh cookie (8 hours). Logout used to need a live access token, so the
// sign-in it meant to end stayed live. And the staff and patient apps share
// the session cookies, so either app could refresh, and so rotate, the
// other's sign-in.

const ORIGIN = 'https://www.healthidentitydirectory.com';
const sessionA = '90000000-0000-4000-8000-00000000000a';
const sessionB = '90000000-0000-4000-8000-00000000000b';

function actor(kind: 'staff' | 'patient' | 'platform', sessionId = sessionA): ActorContext {
  return { id: `${kind}:a`, subject: `${kind}:a`, accountId: '20000000-0000-4000-8000-00000000000a', kind, sessionId,
    roles: [], permissions: [], platformRoles: [], platformPermissions: [], facilityIds: [], facilities: [],
    authenticationMethod: 'local' } as unknown as ActorContext;
}

/** A staff actor as CurrentStaffContextService builds it: with no `kind` at all. */
function staffActor(sessionId = sessionB): ActorContext {
  const { kind: _omitted, ...rest } = actor('staff', sessionId) as ActorContext & { kind?: string };
  return { ...rest, id: 'staff:s', subject: 'staff:s' } as unknown as ActorContext;
}

/** Access token "access-A" is live for sign-in A with CSRF "csrf-A"; refresh tokens derive "csrf-<token>". */
function harness(liveAccess: Record<string, ActorContext> = { 'access-A': actor('patient') },
  refreshKinds: Record<string, 'staff' | 'patient'> = { 'refresh-A': 'patient', 'refresh-B': 'staff' }) {
  const tokens = {
    verify: jest.fn(async (token: string) => {
      const live = liveAccess[token];
      if (!live) throw new UnauthorizedException('Invalid or expired access token');
      return { actor: live, claims: { csrf_hash: `hash-of-csrf-${token.slice('access-'.length)}` } };
    }),
    verifyCsrf: jest.fn((claims: { csrf_hash: string }, cookie?: string, header?: string) =>
      Boolean(cookie) && cookie === header && claims.csrf_hash === `hash-of-${cookie}`),
    verifyRefreshCsrf: jest.fn((refresh: string, cookie?: string, header?: string) =>
      Boolean(cookie) && cookie === header && cookie === `csrf-${refresh.slice('refresh-'.length)}`),
    refreshSessionKind: jest.fn(async (refresh: string) => refreshKinds[refresh]),
  };
  const auth = {
    revoke: jest.fn().mockResolvedValue(true),
    // As TokenService decides it: a sign-in of another kind than the one the
    // calling app names is refused before anything is ended while refresh
    // could renew it ('refresh-old' stands for one it could not: an older
    // rotated token, an expired sign-in or a suspended account).
    revokeByRefreshToken: jest.fn(async (refresh: string, _event: unknown, expectedKind?: 'staff' | 'patient') => {
      const kind = refresh === 'refresh-old' ? 'staff' : refreshKinds[refresh];
      if (!kind) return undefined;
      if (expectedKind && kind !== expectedKind && refresh !== 'refresh-old') return { refusedKind: kind };
      return { sessionId: refresh === 'refresh-A' ? sessionA : sessionB, accountId: 'account', actorSubject: 'subject', kind };
    }),
    refresh: jest.fn(async () => ({ actor: actor('patient', 'rotated'), accessToken: 'new-access', refreshToken: 'new-refresh',
      csrfToken: 'new-csrf', expiresAt: new Date('2030-01-01T00:00:00Z'), refreshExpiresAt: new Date('2030-01-01T08:00:00Z') })),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const controller = new AuthController(auth as unknown as AuthService, tokens as unknown as TokenService,
    { record: jest.fn() } as unknown as AuthSessionAuditService, audit as unknown as AuditService,
    {} as WorkloadAuthService, {} as TurnstileService, {} as GoogleAuthenticationService);
  return { controller, tokens, auth, audit };
}

function request(headers: Record<string, string>, cookies: Record<string, string>): HidRequest {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return { correlationId: 'session-sign-out-test', ip: '127.0.0.1', cookies,
    header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
}

function response() {
  return { cookie: jest.fn(), clearCookie: jest.fn(), setHeader: jest.fn() };
}

const cleared = (res: ReturnType<typeof response>) => res.clearCookie.mock.calls.map(([name]) => name).sort();
const ALL_COOKIES = ['hid_access', 'hid_access_csrf', 'hid_access_refresh'];

async function refusal(promise: Promise<unknown>): Promise<DomainProblem> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: ORIGIN, AUTH_MODE: 'local', AUTH_COOKIE_NAME: 'hid_access', AUTH_COOKIE_SECURE: 'false',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters', TURNSTILE_MODE: 'disabled' });
  resetEnvironmentForTests();
});

describe('POST /auth/logout', () => {
  it('signs out with only the refresh cookie when the access cookie has expired, and clears the cookies', async () => {
    const { controller, auth, audit } = harness();
    const res = response();
    await controller.logout(request({ origin: ORIGIN, 'x-csrf-token': 'csrf-A' },
      { hid_access_refresh: 'refresh-A', hid_access_csrf: 'csrf-A' }), res as unknown as Response);
    expect(auth.revokeByRefreshToken).toHaveBeenCalledWith('refresh-A', expect.objectContaining({
      correlationId: 'session-sign-out-test' }), undefined);
    expect(auth.revoke).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.logout', resourceId: sessionA,
      actorType: 'patient', outcome: 'success' }));
    expect(cleared(res)).toEqual(ALL_COOKIES);
  });

  it('falls back to the refresh cookie when the access cookie it carries is no longer live', async () => {
    const { controller, auth } = harness();
    const res = response();
    await controller.logout(request({ origin: ORIGIN, 'x-csrf-token': 'csrf-A' },
      { hid_access: 'access-expired', hid_access_refresh: 'refresh-A', hid_access_csrf: 'csrf-A' }),
    res as unknown as Response);
    expect(auth.revokeByRefreshToken).toHaveBeenCalledWith('refresh-A', expect.anything(), undefined);
    expect(cleared(res)).toEqual(ALL_COOKIES);
  });

  it('ends only the live access token\'s sign-in when another account\'s refresh cookie rides along', async () => {
    const { controller, auth } = harness();
    const res = response();
    await controller.logout(request({ origin: ORIGIN, 'x-csrf-token': 'csrf-A' },
      { hid_access: 'access-A', hid_access_refresh: 'refresh-B', hid_access_csrf: 'csrf-A' }), res as unknown as Response);
    expect(auth.revoke).toHaveBeenCalledWith(sessionA, 'patient:a', expect.anything());
    expect(auth.revokeByRefreshToken).not.toHaveBeenCalled();
    expect(cleared(res)).toEqual(ALL_COOKIES);
  });

  it('refuses another account\'s refresh cookie presented with this session\'s CSRF token, ending nothing', async () => {
    const { controller, auth } = harness();
    const res = response();
    const problem = await refusal(controller.logout(request({ origin: ORIGIN, 'x-csrf-token': 'csrf-A' },
      { hid_access_refresh: 'refresh-B', hid_access_csrf: 'csrf-A' }), res as unknown as Response));
    expect([problem.getStatus(), problem.code]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    expect(auth.revokeByRefreshToken).not.toHaveBeenCalled();
    expect(auth.revoke).not.toHaveBeenCalled();
    expect(cleared(res)).toEqual(ALL_COOKIES);
  });

  it('refuses a refresh-cookie sign-out without the CSRF header', async () => {
    const { controller, auth } = harness();
    const res = response();
    const problem = await refusal(controller.logout(request({ origin: ORIGIN },
      { hid_access_refresh: 'refresh-A', hid_access_csrf: 'csrf-A' }), res as unknown as Response));
    expect(problem.code).toBe('CSRF_VALIDATION_FAILED');
    expect(auth.revokeByRefreshToken).not.toHaveBeenCalled();
  });

  it('keeps the CSRF check for a live access cookie, and audits the refusal against that actor', async () => {
    const { controller, auth } = harness();
    const res = response();
    const forged = request({ origin: ORIGIN, 'x-csrf-token': 'forged' },
      { hid_access: 'access-A', hid_access_refresh: 'refresh-A', hid_access_csrf: 'csrf-A' });
    const problem = await refusal(controller.logout(forged, res as unknown as Response));
    expect(problem.code).toBe('CSRF_VALIDATION_FAILED');
    expect(forged.actor?.sessionId).toBe(sessionA);
    expect(auth.revoke).not.toHaveBeenCalled();
    expect(auth.revokeByRefreshToken).not.toHaveBeenCalled();
    expect(cleared(res)).toEqual(ALL_COOKIES);
  });

  it.each([['no Origin', {}], ['an unapproved Origin', { origin: 'https://attacker.example' }]])(
    'changes nothing for a cookie sign-out with %s, cookies included', async (_label, headers) => {
      const { controller, auth } = harness();
      const res = response();
      const problem = await refusal(controller.logout(request({ ...headers, 'x-csrf-token': 'csrf-A' },
        { hid_access_refresh: 'refresh-A', hid_access_csrf: 'csrf-A' }), res as unknown as Response));
      expect(problem.code).toBe('ORIGIN_DENIED');
      expect(auth.revokeByRefreshToken).not.toHaveBeenCalled();
      expect(res.clearCookie).not.toHaveBeenCalled();
    });

  it('clears the cookies when no sign-in is left to end', async () => {
    const { controller, auth } = harness();
    const res = response();
    await controller.logout(request({ origin: ORIGIN }, {}), res as unknown as Response);
    expect(auth.revoke).not.toHaveBeenCalled();
    expect(auth.revokeByRefreshToken).not.toHaveBeenCalled();
    expect(cleared(res)).toEqual(ALL_COOKIES);
  });

  it('ends a bearer sign-in without Origin or CSRF, and refuses a dead or platform bearer token', async () => {
    const { controller, auth } = harness({ 'access-A': actor('staff'), 'access-P': actor('platform') });
    await controller.logout(request({ authorization: 'Bearer access-A' }, {}), response() as unknown as Response);
    expect(auth.revoke).toHaveBeenCalledWith(sessionA, 'staff:a', expect.anything());
    expect((await refusal(controller.logout(request({ authorization: 'Bearer access-expired' }, {}),
      response() as unknown as Response))).code).toBe('AUTHENTICATION_REQUIRED');
    expect((await refusal(controller.logout(request({ authorization: 'Bearer access-P' }, {}),
      response() as unknown as Response))).code).toBe('PLATFORM_SESSION_SCOPE_DENIED');
    expect(auth.revoke).toHaveBeenCalledTimes(1);
  });
});

describe('POST /auth/logout, concurrent', () => {
  it('audits a live access token\'s sign-out only when it ended the sign-in, not when another tab got there first', async () => {
    const { controller, auth, audit } = harness({ 'access-A': actor('patient') });
    auth.revoke.mockResolvedValueOnce(false);
    const res = response();
    await controller.logout(request({ origin: ORIGIN, 'x-csrf-token': 'csrf-A' }, { hid_access: 'access-A', hid_access_csrf: 'csrf-A' }),
      res as unknown as Response);
    expect(auth.revoke).toHaveBeenCalledWith(sessionA, expect.anything(), expect.anything());
    expect(audit.record).not.toHaveBeenCalled();
    expect(cleared(res)).toEqual(ALL_COOKIES);
  });
});

describe('POST /auth/logout with X-HID-Client', () => {
  // The staff and patient apps share the session cookies on one origin. An app
  // that names itself signs out only its own kind of sign-in: the other app's
  // is refused before anything ends, and its cookies are kept.
  const liveAccess = { 'access-A': actor('patient'), 'access-S': staffActor() };
  const signingOut = (client: string | undefined, cookies: Record<string, string>, csrf: string) => request(
    { origin: ORIGIN, 'x-csrf-token': csrf, ...(client ? { 'x-hid-client': client } : {}) },
    { ...cookies, hid_access_csrf: csrf });

  it.each([
    ['staff-web', 'refresh-A', 'patient'],
    ['patient-web', 'refresh-B', 'staff'],
  ])('refuses %s signing out %s, a %s sign-in held by the refresh cookie, ending nothing and keeping the cookies',
    async (client, refresh, kind) => {
      const { controller, auth, audit } = harness(liveAccess);
      const res = response();
      const problem = await refusal(controller.logout(signingOut(client, { hid_access_refresh: refresh },
        `csrf-${refresh.slice('refresh-'.length)}`), res as unknown as Response));
      expect([problem.getStatus(), problem.code]).toEqual([403, 'SESSION_CLIENT_MISMATCH']);
      expect(problem.message).toContain(kind);
      expect(auth.revokeByRefreshToken).toHaveBeenCalledWith(refresh, expect.anything(), client === 'staff-web' ? 'staff' : 'patient');
      expect(auth.revoke).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(res.clearCookie).not.toHaveBeenCalled();
    });

  it.each([
    ['staff-web', 'access-A', 'patient', 'csrf-A', sessionA],
    ['patient-web', 'access-S', 'staff', 'csrf-S', sessionB],
  ])('refuses %s signing out %s, a live %s access token, ending nothing and keeping the cookies',
    async (client, access, kind, csrf, sessionId) => {
      const { controller, auth } = harness(liveAccess);
      const res = response();
      const signOut = signingOut(client, { hid_access: access, hid_access_refresh: 'refresh-A' }, csrf);
      const problem = await refusal(controller.logout(signOut, res as unknown as Response));
      expect([problem.getStatus(), problem.code]).toEqual([403, 'SESSION_CLIENT_MISMATCH']);
      expect(problem.message).toContain(kind);
      // The refusal is audited against the signed-in actor, as other refusals on this path are.
      expect(signOut.actor?.sessionId).toBe(sessionId);
      expect(auth.revoke).not.toHaveBeenCalled();
      expect(auth.revokeByRefreshToken).not.toHaveBeenCalled();
      expect(res.clearCookie).not.toHaveBeenCalled();
    });

  it('ends the sign-in the calling app names, on either path, and clears the cookies', async () => {
    const { controller, auth } = harness(liveAccess);
    const byRefresh = response();
    await controller.logout(signingOut('patient-web', { hid_access_refresh: 'refresh-A' }, 'csrf-A'),
      byRefresh as unknown as Response);
    expect(auth.revokeByRefreshToken).toHaveBeenCalledWith('refresh-A', expect.anything(), 'patient');
    expect(cleared(byRefresh)).toEqual(ALL_COOKIES);
    // A staff actor carries no kind: staff-web must still end it.
    const byAccess = response();
    await controller.logout(signingOut('staff-web', { hid_access: 'access-S' }, 'csrf-S'), byAccess as unknown as Response);
    expect(auth.revoke).toHaveBeenCalledWith(sessionB, 'staff:s', expect.anything());
    expect(cleared(byAccess)).toEqual(ALL_COOKIES);
  });

  it.each([[undefined], ['admin-web']])('signs out as before when the client names %s', async (client) => {
    const { controller, auth } = harness(liveAccess);
    const res = response();
    await controller.logout(signingOut(client, { hid_access_refresh: 'refresh-B' }, 'csrf-B'), res as unknown as Response);
    expect(auth.revokeByRefreshToken).toHaveBeenCalledWith('refresh-B', expect.anything(), undefined);
    expect(cleared(res)).toEqual(ALL_COOKIES);
  });

  it('ends, audited as its own kind, a sign-in of the other kind that refresh could not renew, and clears the cookies', async () => {
    const { controller, auth, audit } = harness(liveAccess);
    const res = response();
    await controller.logout(signingOut('patient-web', { hid_access_refresh: 'refresh-old' }, 'csrf-old'), res as unknown as Response);
    expect(auth.revokeByRefreshToken).toHaveBeenCalledWith('refresh-old', expect.anything(), 'patient');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.logout', actorType: 'staff',
      outcome: 'success' }));
    expect(cleared(res)).toEqual(ALL_COOKIES);
  });

  it('checks the CSRF token before reading whose sign-in it is', async () => {
    const { controller, auth } = harness(liveAccess);
    const problem = await refusal(controller.logout(request({ origin: ORIGIN, 'x-csrf-token': 'forged', 'x-hid-client': 'staff-web' },
      { hid_access_refresh: 'refresh-A', hid_access_csrf: 'csrf-A' }), response() as unknown as Response));
    expect(problem.code).toBe('CSRF_VALIDATION_FAILED');
    expect(auth.revokeByRefreshToken).not.toHaveBeenCalled();
  });

  it('checks the CSRF token before naming the kind of a live access token', async () => {
    // The other app's live access cookie with a forged CSRF header: the
    // refusal must not say whose sign-in it is.
    const { controller, auth } = harness(liveAccess);
    const res = response();
    const problem = await refusal(controller.logout(request({ origin: ORIGIN, 'x-csrf-token': 'forged', 'x-hid-client': 'staff-web' },
      { hid_access: 'access-A', hid_access_refresh: 'refresh-A', hid_access_csrf: 'csrf-A' }), res as unknown as Response));
    expect([problem.getStatus(), problem.code]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    expect(problem.message).not.toContain('patient');
    expect(auth.revoke).not.toHaveBeenCalled();
    expect(auth.revokeByRefreshToken).not.toHaveBeenCalled();
  });

  it('ignores the header on a bearer sign-out, which names its sign-in explicitly', async () => {
    const { controller, auth } = harness(liveAccess);
    await controller.logout(request({ authorization: 'Bearer access-S', 'x-hid-client': 'patient-web' }, {}),
      response() as unknown as Response);
    expect(auth.revoke).toHaveBeenCalledWith(sessionB, 'staff:s', expect.anything());
  });
});

describe('POST /auth/refresh with X-HID-Client', () => {
  const refreshing = (client: string | undefined, refresh: string) => request(
    { origin: ORIGIN, 'x-csrf-token': `csrf-${refresh.slice('refresh-'.length)}`, ...(client ? { 'x-hid-client': client } : {}) },
    { hid_access_refresh: refresh, hid_access_csrf: `csrf-${refresh.slice('refresh-'.length)}` });

  it.each([
    ['staff-web', 'refresh-A', 'patient'],
    ['patient-web', 'refresh-B', 'staff'],
  ])('refuses %s refreshing %s, a %s sign-in, without rotating it or clearing its cookies',
    async (client, refresh, kind) => {
      const { controller, auth } = harness();
      const res = response();
      const problem = await refusal(controller.refresh(refreshing(client, refresh), res as unknown as Response));
      expect([problem.getStatus(), problem.code]).toEqual([403, 'SESSION_CLIENT_MISMATCH']);
      expect(problem.message).toContain(kind);
      expect(auth.refresh).not.toHaveBeenCalled();
      expect(res.clearCookie).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
    });

  it.each([
    ['patient-web', 'refresh-A'],
    ['staff-web', 'refresh-B'],
    [undefined, 'refresh-A'],
    ['admin-web', 'refresh-B'],
  ])('rotates when %s refreshes %s', async (client, refresh) => {
    const { controller, auth, tokens } = harness();
    await controller.refresh(refreshing(client, refresh), response() as unknown as Response);
    expect(auth.refresh).toHaveBeenCalledWith(refresh, expect.anything());
    expect(tokens.refreshSessionKind).toHaveBeenCalledTimes(client === 'patient-web' || client === 'staff-web' ? 1 : 0);
  });

  it('checks the refresh CSRF token before revealing the sign-in kind', async () => {
    const { controller, tokens } = harness();
    const forged = request({ origin: ORIGIN, 'x-csrf-token': 'forged', 'x-hid-client': 'staff-web' },
      { hid_access_refresh: 'refresh-A', hid_access_csrf: 'csrf-A' });
    expect((await refusal(controller.refresh(forged, response() as unknown as Response))).code)
      .toBe('CSRF_VALIDATION_FAILED');
    expect(tokens.refreshSessionKind).not.toHaveBeenCalled();
  });
});
