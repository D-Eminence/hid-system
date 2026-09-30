jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
  SignJWT: class {
    setProtectedHeader() { return this; }
    setSubject() { return this; }
    setIssuer() { return this; }
    setAudience() { return this; }
    setJti() { return this; }
    setIssuedAt() { return this; }
    setExpirationTime() { return this; }
    async sign() { return 'signed-access-token'; }
  },
}));

import type { Response } from 'express';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { AuditService } from '../audit/audit.service';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { AuthSessionAuditService } from './auth-session-audit.service';
import type { GoogleAuthenticationService } from './google-authentication.service';
import type { TokenService } from './token.service';
import type { TurnstileService } from './turnstile.service';
import type { WorkloadAuthService } from './workload-auth.service';

const originalEnvironment = { ...process.env };
const origin = 'https://www.healthidentitydirectory.com';
const nonceCookie = 'hid_access_google_nonce';
const correlationId = '01J5A2C3D4E5F6G7H8J9K0MNPQ';

const actor: ActorContext = {
  id: 'account-subject',
  subject: 'account-subject',
  accountId: '10000000-0000-4000-8000-000000000001',
  patientId: '20000000-0000-4000-8000-000000000001',
  kind: 'patient',
  email: 'patient@example.test',
  displayName: 'Test Patient',
  authenticationMethod: 'oidc',
  roles: [],
  permissions: [],
  platformRoles: [],
  platformPermissions: [],
  facilityIds: [],
  facilities: [],
};

describe('AuthController Google exchange', () => {
  let controller: AuthController;
  let google: { login: jest.Mock };
  let turnstile: { verifyLogin: jest.Mock };
  let sessionAudit: { record: jest.Mock };
  let audit: { record: jest.Mock };

  beforeEach(() => {
    restoreEnvironment();
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
      DATABASE_SSL: 'false',
      CORS_ORIGINS: origin,
      AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters',
      AUTH_COOKIE_NAME: 'hid_access',
      AUTH_COOKIE_SECURE: 'false',
      TURNSTILE_MODE: 'disabled',
    });
    resetEnvironmentForTests();

    google = { login: jest.fn() };
    turnstile = { verifyLogin: jest.fn().mockResolvedValue(undefined) };
    sessionAudit = { record: jest.fn().mockResolvedValue(undefined) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    controller = new AuthController(
      {} as AuthService,
      {} as TokenService,
      sessionAudit as unknown as AuthSessionAuditService,
      audit as unknown as AuditService,
      {} as WorkloadAuthService,
      turnstile as unknown as TurnstileService,
      google as unknown as GoogleAuthenticationService,
    );
  });

  afterEach(() => {
    restoreEnvironment();
    resetEnvironmentForTests();
  });

  it('issues a short-lived HttpOnly nonce cookie only for an allowed origin', () => {
    const request = requestFor();
    const response = responseFor();

    const result = controller.googleNonce(request, response);

    expect(result.nonce).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(response.cookie).toHaveBeenCalledWith(nonceCookie, expect.any(String), expect.objectContaining({
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      path: '/api/v1/auth/oidc',
      expires: expect.any(Date),
    }));
    const cookieValue = response.cookie.mock.calls[0]?.[1];
    expect(cookieValue).not.toBe(result.nonce);
    expect(cookieValue).toMatch(/^[A-Za-z0-9_-]{43}\.[1-9][0-9]{9,12}\.[A-Za-z0-9_-]{43}$/);
    const options = response.cookie.mock.calls[0]?.[2] as { expires: Date };
    expect(options.expires.getTime()).toBeGreaterThan(Date.now());
    expect(options.expires.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1_000 + 1_000);
  });

  it('rejects nonce issuance from an unapproved origin', () => {
    const response = responseFor();

    let error: unknown;
    try {
      controller.googleNonce(requestFor({ origin: 'https://attacker.example' }), response);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'ORIGIN_DENIED' });
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it('accepts an allowed same-origin Referer when a browser omits Origin on nonce GET', () => {
    const response = responseFor();

    const result = controller.googleNonce(requestFor({ origin: null, referer: `${origin}/patient/login` }), response);

    expect(result.nonce).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(response.cookie).toHaveBeenCalledWith(nonceCookie, expect.any(String), expect.any(Object));
  });

  it('rejects an unapproved Referer when Origin is absent on nonce GET', () => {
    const response = responseFor();

    expect(() => controller.googleNonce(
      requestFor({ origin: null, referer: 'https://attacker.example/login' }),
      response,
    )).toThrow(expect.objectContaining({ code: 'ORIGIN_DENIED' }));
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it('rejects a patient Turnstile action on the workforce password route', async () => {
    await expect(controller.login(
      { email: 'staff@example.test', password: 'valid-password', turnstileAction: 'patient-login' },
      requestFor(),
      responseFor(),
    )).rejects.toMatchObject({ code: 'INVALID_LOGIN_ACTION' });
    expect(turnstile.verifyLogin).not.toHaveBeenCalled();
  });

  it('verifies Turnstile, consumes the nonce, and establishes a patient cookie session', async () => {
    const challenge = issueNonce(controller);
    const request = requestFor({ cookies: { [nonceCookie]: challenge.cookie } });
    const response = responseFor();
    const expiresAt = new Date('2030-01-01T00:00:00.000Z');
    const refreshExpiresAt = new Date('2030-01-02T00:00:00.000Z');
    google.login.mockResolvedValue({
      actor,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      csrfToken: 'csrf-token',
      expiresAt,
      refreshExpiresAt,
    });

    await expect(controller.exchangeGoogleIdToken(googleInput('patient-login'), request, response)).resolves.toEqual({
      actor,
      expiresAt: expiresAt.toISOString(),
    });

    expect(turnstile.verifyLogin).toHaveBeenCalledWith({
      token: 'turnstile-token', action: 'patient-login', origin, remoteIp: '203.0.113.10',
    });
    expect(google.login).toHaveBeenCalledWith(
      'g'.repeat(64),
      challenge.nonce,
      'patient',
      { correlationId, sourceIp: '203.0.113.10', userAgent: 'Google-exchange-test' },
    );
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auth.google.login',
      actorAccountId: actor.accountId,
      outcome: 'success',
    }));
    expect(response.cookie).toHaveBeenCalledWith('hid_access', 'access-token', expect.objectContaining({ httpOnly: true }));
    expect(response.cookie).toHaveBeenCalledWith('hid_access_refresh', 'refresh-token', expect.objectContaining({
      httpOnly: true,
      path: '/api/v1/auth',
    }));
    expect(response.setHeader).toHaveBeenCalledWith('x-csrf-token', 'csrf-token');
    expect(response.clearCookie).toHaveBeenCalledWith(nonceCookie, expect.objectContaining({
      httpOnly: true,
      path: '/api/v1/auth/oidc',
    }));
  });

  it('uses the staff actor boundary for the staff Google-login action', async () => {
    const challenge = issueNonce(controller);
    const staffActor = { ...actor, kind: 'staff' as const, patientId: undefined, roles: ['clinician'] };
    google.login.mockResolvedValue({
      actor: staffActor,
      accessToken: 'access-token', refreshToken: 'refresh-token', csrfToken: 'csrf-token',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'), refreshExpiresAt: new Date('2030-01-02T00:00:00.000Z'),
    });

    await controller.exchangeGoogleIdToken(
      googleInput('staff-login'),
      requestFor({ cookies: { [nonceCookie]: challenge.cookie } }),
      responseFor(),
    );

    expect(google.login).toHaveBeenCalledWith(
      'g'.repeat(64),
      challenge.nonce,
      'staff',
      expect.any(Object),
    );
  });

  it('audits a denied exchange without logging the Google token or nonce and clears the nonce cookie', async () => {
    const challenge = issueNonce(controller);
    google.login.mockRejectedValue(new DomainProblem(401, 'GOOGLE_SIGN_IN_DENIED', 'Google sign-in could not be completed'));
    const request = requestFor({ cookies: { [nonceCookie]: challenge.cookie } });
    const response = responseFor();

    await expect(controller.exchangeGoogleIdToken(googleInput('patient-login'), request, response))
      .rejects.toMatchObject({ code: 'GOOGLE_SIGN_IN_DENIED' });

    expect(sessionAudit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'login_failed',
      outcome: 'denied',
      details: { authentication_method: 'oidc', identity_provider: 'google' },
    }));
    expect(JSON.stringify(sessionAudit.record.mock.calls)).not.toContain('g'.repeat(64));
    expect(JSON.stringify(sessionAudit.record.mock.calls)).not.toContain(challenge.nonce);
    expect(response.clearCookie).toHaveBeenCalledWith(nonceCookie, expect.any(Object));
  });

  it('rejects a forged raw nonce cookie with the same generic denial before token verification', async () => {
    const response = responseFor();

    await expect(controller.exchangeGoogleIdToken(
      googleInput('patient-login'),
      requestFor({ cookies: { [nonceCookie]: 'forged-nonce-value-that-is-not-a-server-envelope' } }),
      response,
    )).rejects.toMatchObject({ code: 'GOOGLE_SIGN_IN_DENIED' });

    expect(google.login).not.toHaveBeenCalled();
    expect(sessionAudit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'login_failed', outcome: 'denied',
    }));
    expect(response.clearCookie).toHaveBeenCalledWith(nonceCookie, expect.any(Object));
  });

  it('rejects an expired signed nonce cookie with the same generic denial', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
      const challenge = issueNonce(controller);
      jest.advanceTimersByTime(5 * 60 * 1_000 + 1);

      await expect(controller.exchangeGoogleIdToken(
        googleInput('patient-login'),
        requestFor({ cookies: { [nonceCookie]: challenge.cookie } }),
        responseFor(),
      )).rejects.toMatchObject({ code: 'GOOGLE_SIGN_IN_DENIED' });

      expect(google.login).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

function googleInput(turnstileAction: 'patient-login' | 'staff-login') {
  return { idToken: 'g'.repeat(64), turnstileToken: 'turnstile-token', turnstileAction };
}

function issueNonce(controller: AuthController): { nonce: string; cookie: string } {
  const response = responseFor();
  const result = controller.googleNonce(requestFor(), response);
  const cookie = response.cookie.mock.calls[0]?.[1];
  if (typeof cookie !== 'string') throw new Error('Google nonce cookie was not issued');
  return { nonce: result.nonce, cookie };
}

function requestFor(input: { origin?: string | null; referer?: string; cookies?: Record<string, string> } = {}): HidRequest {
  const requestOrigin = input.origin === undefined ? origin : input.origin;
  return {
    correlationId,
    ip: '203.0.113.10',
    cookies: input.cookies ?? {},
    header: jest.fn((name: string) => {
      if (name === 'origin') return requestOrigin;
      if (name === 'referer') return input.referer;
      if (name === 'user-agent') return 'Google-exchange-test';
      return undefined;
    }),
  } as unknown as HidRequest;
}

function responseFor() {
  return {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    setHeader: jest.fn(),
  } as unknown as Response & { cookie: jest.Mock; clearCookie: jest.Mock; setHeader: jest.Mock };
}

function restoreEnvironment(): void {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
}
