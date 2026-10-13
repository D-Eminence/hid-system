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

import { UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { AuditService } from '../audit/audit.service';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { AuthSessionAuditService } from './auth-session-audit.service';
import type { LoginDto } from './dto/login.dto';
import type { PatientLoginDto } from './dto/patient-login.dto';
import type { GoogleAuthenticationService } from './google-authentication.service';
import type { MfaService } from './mfa/mfa.service';
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
  let google: { login: jest.Mock; exchange: jest.Mock; onboardingStatus: jest.Mock;
    linkExistingPatient: jest.Mock; onboardingCookieName: string };
  let turnstile: { verifyLogin: jest.Mock };
  let sessionAudit: { record: jest.Mock; recordLoginFailure: jest.Mock };
  let audit: { record: jest.Mock };
  let mfa: { beginLogin: jest.Mock; completeLogin: jest.Mock; sendEnrollmentCode: jest.Mock;
    startEnrollment: jest.Mock; activateEnrollment: jest.Mock };

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

    google = { login: jest.fn(), exchange: jest.fn(), onboardingStatus: jest.fn(),
      linkExistingPatient: jest.fn(), onboardingCookieName: 'hid_access_google_onboarding' };
    turnstile = { verifyLogin: jest.fn().mockResolvedValue(undefined) };
    sessionAudit = { record: jest.fn().mockResolvedValue(undefined), recordLoginFailure: jest.fn().mockResolvedValue(undefined) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    mfa = { beginLogin: jest.fn(), completeLogin: jest.fn(), sendEnrollmentCode: jest.fn(), startEnrollment: jest.fn(),
      activateEnrollment: jest.fn() };
    controller = new AuthController(
      {} as AuthService,
      {} as TokenService,
      sessionAudit as unknown as AuthSessionAuditService,
      audit as unknown as AuditService,
      {} as WorkloadAuthService,
      turnstile as unknown as TurnstileService,
      google as unknown as GoogleAuthenticationService,
      mfa as unknown as MfaService,
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
      path: '/api/v1/auth',
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
      path: '/api/v1/auth',
    }));
  });

  it('refuses a staff Google-login action before Turnstile or token exchange, audited (MFA-1)', async () => {
    const challenge = issueNonce(controller);
    const response = responseFor();
    for (const intent of [undefined, 'enroll' as const]) {
      await expect(controller.exchangeGoogleIdToken(
        { ...googleInput('staff-login'), ...(intent ? { intent } : {}) },
        requestFor({ cookies: { [nonceCookie]: challenge.cookie } }),
        response,
      )).rejects.toMatchObject({ status: 403, code: 'GOOGLE_STAFF_SIGN_IN_DISABLED' });
    }
    expect(turnstile.verifyLogin).not.toHaveBeenCalled();
    expect(google.login).not.toHaveBeenCalled();
    expect(google.exchange).not.toHaveBeenCalled();
    expect(response.cookie).not.toHaveBeenCalled();
    expect(sessionAudit.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'login_failed',
      outcome: 'denied', details: { authentication_method: 'oidc', identity_provider: 'google' } }));
    // The nonce is spent either way.
    expect(response.clearCookie).toHaveBeenCalledWith(nonceCookie, expect.objectContaining({ path: '/api/v1/auth' }));
  });

  it('exchanges a patient Google sign-in only as a patient', async () => {
    const challenge = issueNonce(controller);
    google.login.mockResolvedValue({ actor, accessToken: 'access-token', refreshToken: 'refresh-token',
      csrfToken: 'csrf-token', expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      refreshExpiresAt: new Date('2030-01-02T00:00:00.000Z') });
    await controller.exchangeGoogleIdToken(googleInput('patient-login'),
      requestFor({ cookies: { [nonceCookie]: challenge.cookie } }), responseFor());
    expect(google.login).toHaveBeenCalledWith('g'.repeat(64), challenge.nonce, 'patient', expect.any(Object));
  });

  it('keeps an unknown Google enrollee accountless and writes only a pending capability cookie', async () => {
    const challenge = issueNonce(controller);
    const request = requestFor({ cookies: { [nonceCookie]: challenge.cookie } });
    const response = responseFor();
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    google.exchange.mockResolvedValue({ kind: 'pending', cookie: 'pending-id.pending-token',
      expiresAt, progress: { stage: 'GOOGLE_AUTHENTICATED_PENDING_IDENTITY',
        expiresAt: expiresAt.toISOString() } });

    const result = await controller.exchangeGoogleIdToken(
      { ...googleInput('patient-login'), intent: 'enroll' }, request, response);

    expect(result).toEqual({ stage: 'GOOGLE_AUTHENTICATED_PENDING_IDENTITY',
      expiresAt: expiresAt.toISOString() });
    expect(google.exchange).toHaveBeenCalledWith('g'.repeat(64), challenge.nonce, 'patient',
      'enroll', expect.any(Object));
    expect(response.cookie).toHaveBeenCalledWith('hid_access_google_onboarding',
      'pending-id.pending-token', expect.objectContaining({ httpOnly: true,
        sameSite: 'strict', path: '/api/v1', expires: expiresAt }));
    expect(response.cookie).not.toHaveBeenCalledWith('hid_access', expect.anything(), expect.anything());
    expect(response.status).toHaveBeenCalledWith(202);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('requires sign-out before Google enrollment in a browser with an HID session', async () => {
    const challenge = issueNonce(controller);
    await expect(controller.exchangeGoogleIdToken({ ...googleInput('patient-login'),
      intent: 'enroll' }, requestFor({ cookies: {
      [nonceCookie]: challenge.cookie, hid_access: 'existing-session-token',
    } }), responseFor())).rejects.toMatchObject({
      code: 'GOOGLE_ONBOARDING_REQUIRES_SIGN_OUT',
    });
    expect(google.exchange).not.toHaveBeenCalled();
    expect(turnstile.verifyLogin).not.toHaveBeenCalled();
  });

  it('requires sign-out before Google enrollment when the HID session cookie is repeated', async () => {
    // cookie-parser yields an array for a repeated name; the guard must treat
    // that as "signed in" rather than dropping the key and reading as absent.
    const challenge = issueNonce(controller);
    await expect(controller.exchangeGoogleIdToken({ ...googleInput('patient-login'),
      intent: 'enroll' }, requestFor({ cookies: {
      [nonceCookie]: challenge.cookie, hid_access: ['existing-session-token', 'existing-session-token'],
    } as unknown as Record<string, string> }), responseFor())).rejects.toMatchObject({
      code: 'GOOGLE_ONBOARDING_REQUIRES_SIGN_OUT',
    });
    expect(google.exchange).not.toHaveBeenCalled();
    expect(turnstile.verifyLogin).not.toHaveBeenCalled();
  });

  it('reads a pending Google capability only with an allowed same-origin request', async () => {
    google.onboardingStatus.mockResolvedValue({ stage: 'GOOGLE_AUTHENTICATED_PENDING_IDENTITY',
      expiresAt: '2030-01-01T00:00:00.000Z' });
    const cookie = '30000000-0000-4000-8000-000000000001.' + 'A'.repeat(43);
    await expect(controller.googleOnboarding(requestFor({ origin: null,
      referer: `${origin}/patient/enroll`,
      cookies: { 'hid_access_google_onboarding': cookie } }))).resolves.toMatchObject({
      stage: 'GOOGLE_AUTHENTICATED_PENDING_IDENTITY',
    });
    expect(google.onboardingStatus).toHaveBeenCalledWith(cookie);
    await expect(async () => controller.googleOnboarding(requestFor({ origin: null,
      referer: 'https://attacker.example/patient/enroll',
      cookies: { 'hid_access_google_onboarding': cookie } }))).rejects.toMatchObject({
      code: 'ORIGIN_DENIED',
    });
  });

  it('requires a patient session and fresh Google nonce for explicit account linking', async () => {
    const challenge = issueNonce(controller);
    const request = requestFor({ cookies: { [nonceCookie]: challenge.cookie }, actor });
    const response = responseFor();
    google.linkExistingPatient.mockResolvedValue(undefined);
    await expect(controller.linkGoogleIdentity({ ...googleInput('patient-login'),
      principal: 'patient@example.test', password: 'valid-password' }, request, response))
      .resolves.toEqual({ linked: true });
    expect(google.linkExistingPatient).toHaveBeenCalledWith('g'.repeat(64), challenge.nonce,
      'patient@example.test', 'valid-password', actor, expect.any(Object));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.google.link',
      actorAccountId: actor.accountId, outcome: 'success' }));
    expect(response.clearCookie).toHaveBeenCalledWith(nonceCookie, expect.objectContaining({ path: '/api/v1/auth' }));
  });

  it('rejects Google linking without an existing patient actor before checking account credentials', async () => {
    const challenge = issueNonce(controller);
    await expect(controller.linkGoogleIdentity({ ...googleInput('patient-login'),
      principal: 'patient@example.test', password: 'valid-password' },
    requestFor({ cookies: { [nonceCookie]: challenge.cookie } }), responseFor()))
      .rejects.toMatchObject({ code: 'PATIENT_SCOPE_DENIED' });
    expect(google.linkExistingPatient).not.toHaveBeenCalled();
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

  describe('the public patient enrollment cookie (ENR-3)', () => {
    // A sign-in sets the session cookies (setCookies); it also expires the
    // enrollment capability, which would otherwise show this device's last
    // enrollment HID to whoever uses it next. The enrollment routes refuse
    // while session cookies exist, so no enrollment in progress needs it.
    const enrollmentCleared = ['hid_enrollment', { secure: false, sameSite: 'strict', httpOnly: true,
      path: '/api/v1/identity/patient-enrollments' }];
    const enrollmentClears = (response: ReturnType<typeof responseFor>) =>
      response.clearCookie.mock.calls.filter(([name]) => name === 'hid_enrollment');
    const issued = () => ({ actor, accessToken: 'access-token', refreshToken: 'refresh-token',
      csrfToken: 'csrf-token', expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      refreshExpiresAt: new Date('2030-01-02T00:00:00.000Z') });
    const credentials = (turnstileAction: 'patient-login' | 'staff-login') => ({ email: 'person@example.test',
      password: 'a-strong-test-password', turnstileToken: 'turnstile-token', turnstileAction });
    const withPasswordLogin = (login: jest.Mock) => new AuthController(
      { login } as unknown as AuthService, {} as TokenService,
      { record: jest.fn(), recordLoginFailure: jest.fn() } as unknown as AuthSessionAuditService,
      audit as unknown as AuditService, {} as WorkloadAuthService,
      turnstile as unknown as TurnstileService, google as unknown as GoogleAuthenticationService,
      mfa as unknown as MfaService);

    it('is retired by a patient password sign-in', async () => {
      const login = jest.fn().mockResolvedValue(issued());
      const response = responseFor();
      await withPasswordLogin(login).patientLogin(credentials('patient-login') as PatientLoginDto,
        requestFor(), response);
      expect(login).toHaveBeenCalledWith(expect.objectContaining({ email: 'person@example.test' }),
        expect.any(Object), 'patient');
      expect(response.cookie).toHaveBeenCalledWith('hid_access', 'access-token', expect.any(Object));
      expect(enrollmentClears(response)).toEqual([enrollmentCleared]);
    });

    it('is kept by the staff password step, which sets no session cookie, and retired by its MFA step', async () => {
      const login = jest.fn();
      mfa.beginLogin.mockResolvedValue({ purpose: 'verify', token: 'T'.repeat(43), expiresAt: new Date(Date.now() + 300_000) });
      const passwordStep = responseFor();
      await withPasswordLogin(login).login(credentials('staff-login') as LoginDto, requestFor(), passwordStep);
      expect(login).not.toHaveBeenCalled();
      expect(enrollmentClears(passwordStep)).toEqual([]);
      mfa.completeLogin.mockResolvedValue(issued());
      const mfaStep = responseFor();
      await withPasswordLogin(login).verifyStaffMfa({ code: '123456' },
        requestFor({ cookies: { hid_access_mfa: 'T'.repeat(43) } }), mfaStep);
      expect(enrollmentClears(mfaStep)).toEqual([enrollmentCleared]);
    });

    it('is kept when a password sign-in fails', async () => {
      const login = jest.fn().mockRejectedValue(new UnauthorizedException('Invalid credentials'));
      const response = responseFor();
      await expect(withPasswordLogin(login).patientLogin(credentials('patient-login') as PatientLoginDto,
        requestFor(), response)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(response.cookie).not.toHaveBeenCalled();
      expect(response.clearCookie).not.toHaveBeenCalled();
    });

    it('is retired by a Google sign-in that sets the session cookies', async () => {
      google.login.mockResolvedValue(issued());
      const response = responseFor();
      await controller.exchangeGoogleIdToken(googleInput('patient-login'),
        requestFor({ cookies: { [nonceCookie]: issueNonce(controller).cookie } }), response);
      expect(enrollmentClears(response)).toEqual([enrollmentCleared]);
    });

    it('is kept for a pending Google enrollee and for a refused Google sign-in', async () => {
      const expiresAt = new Date(Date.now() + 30 * 60_000);
      google.exchange.mockResolvedValue({ kind: 'pending', cookie: 'pending-id.pending-token', expiresAt,
        progress: { stage: 'GOOGLE_AUTHENTICATED_PENDING_IDENTITY', expiresAt: expiresAt.toISOString() } });
      const pending = responseFor();
      await controller.exchangeGoogleIdToken({ ...googleInput('patient-login'), intent: 'enroll' },
        requestFor({ cookies: { [nonceCookie]: issueNonce(controller).cookie } }), pending);
      expect(pending.status).toHaveBeenCalledWith(202);
      expect(enrollmentClears(pending)).toEqual([]);

      google.login.mockRejectedValue(new DomainProblem(401, 'GOOGLE_SIGN_IN_DENIED', 'Google sign-in could not be completed'));
      const refused = responseFor();
      await expect(controller.exchangeGoogleIdToken(googleInput('patient-login'),
        requestFor({ cookies: { [nonceCookie]: issueNonce(controller).cookie } }), refused))
        .rejects.toMatchObject({ code: 'GOOGLE_SIGN_IN_DENIED' });
      expect(enrollmentClears(refused)).toEqual([]);
    });
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

describe('AuthController staff sign-in is two-step (MFA-1)', () => {
  const challengeCookie = 'hid_access_mfa';
  const challengeToken = 'S'.repeat(43);
  const expiresAt = new Date(Date.now() + 300_000);
  let controller: AuthController;
  let turnstile: { verifyLogin: jest.Mock };
  let sessionAudit: { record: jest.Mock; recordLoginFailure: jest.Mock };
  let mfa: { beginLogin: jest.Mock; completeLogin: jest.Mock; sendEnrollmentCode: jest.Mock;
    startEnrollment: jest.Mock; activateEnrollment: jest.Mock };
  let authService: { login: jest.Mock };
  const staffSession = () => ({ actor: { ...actor, kind: undefined, patientId: undefined, sessionId: 'session-1' },
    accessToken: 'access-token', refreshToken: 'refresh-token', csrfToken: 'csrf-token',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'), refreshExpiresAt: new Date('2030-01-02T00:00:00.000Z') });
  const sessionCookies = (response: ReturnType<typeof responseFor>) => response.cookie.mock.calls
    .map(([name]) => String(name)).filter((name) => ['hid_access', 'hid_access_refresh', 'hid_access_csrf'].includes(name));

  beforeEach(() => {
    restoreEnvironment();
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid', DATABASE_SSL: 'false',
      CORS_ORIGINS: origin, AUTH_MODE: 'local', AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters', AUTH_COOKIE_NAME: 'hid_access',
      AUTH_COOKIE_SECURE: 'true', TURNSTILE_MODE: 'disabled',
    });
    resetEnvironmentForTests();
    turnstile = { verifyLogin: jest.fn().mockResolvedValue(undefined) };
    sessionAudit = { record: jest.fn().mockResolvedValue(undefined), recordLoginFailure: jest.fn().mockResolvedValue(undefined) };
    mfa = { beginLogin: jest.fn(), completeLogin: jest.fn(), sendEnrollmentCode: jest.fn(), startEnrollment: jest.fn(),
      activateEnrollment: jest.fn() };
    authService = { login: jest.fn() };
    controller = new AuthController(authService as unknown as AuthService, {} as TokenService,
      sessionAudit as unknown as AuthSessionAuditService, { record: jest.fn() } as unknown as AuditService,
      {} as WorkloadAuthService, turnstile as unknown as TurnstileService, {} as GoogleAuthenticationService,
      mfa as unknown as MfaService);
  });

  afterEach(() => {
    restoreEnvironment();
    resetEnvironmentForTests();
  });

  it.each([
    ['verify', 'mfa_required'],
    ['enroll', 'mfa_enrollment_required'],
  ])('answers a valid staff password (%s) with only an httpOnly challenge cookie, no session cookie', async (purpose, status) => {
    mfa.beginLogin.mockResolvedValue({ purpose, token: challengeToken, expiresAt });
    const response = responseFor();
    const result = await controller.login({ email: 'staff@example.test', password: 'valid-password',
      turnstileToken: 'turnstile-token', turnstileAction: 'staff-login' }, requestFor(), response);
    expect(result).toEqual({ status, expiresAt: expiresAt.toISOString() });
    expect(turnstile.verifyLogin).toHaveBeenCalledWith(expect.objectContaining({ action: 'staff-login' }));
    expect(mfa.beginLogin).toHaveBeenCalledWith('staff@example.test', 'valid-password', expect.any(Object), 'staff');
    // The password alone never yields a session: no session cookie, no CSRF header, nothing cleared.
    expect(authService.login).not.toHaveBeenCalled();
    expect(sessionCookies(response)).toEqual([]);
    expect(response.cookie).toHaveBeenCalledTimes(1);
    expect(response.cookie).toHaveBeenCalledWith(challengeCookie, challengeToken, { secure: true, sameSite: 'strict',
      httpOnly: true, path: '/api/v1/auth/mfa', expires: expiresAt });
    expect(response.setHeader).not.toHaveBeenCalledWith('x-csrf-token', expect.anything());
    expect(response.clearCookie).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('actor');
  });

  it('records a wrong staff password as a login failure and sets no cookie', async () => {
    mfa.beginLogin.mockRejectedValue(new UnauthorizedException('Invalid credentials'));
    const response = responseFor();
    await expect(controller.login({ email: 'staff@example.test', password: 'wrong-password',
      turnstileAction: 'staff-login' }, requestFor(), response)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessionAudit.recordLoginFailure).toHaveBeenCalledWith('staff@example.test', expect.any(Object));
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it('refuses the staff password step from an unapproved origin before Turnstile', async () => {
    await expect(controller.login({ email: 'staff@example.test', password: 'valid-password',
      turnstileAction: 'staff-login' }, requestFor({ origin: 'https://attacker.example' }), responseFor()))
      .rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
    expect(turnstile.verifyLogin).not.toHaveBeenCalled();
    expect(mfa.beginLogin).not.toHaveBeenCalled();
  });

  it('issues the staff session cookies only at the second factor, and clears the challenge cookie', async () => {
    mfa.completeLogin.mockResolvedValue(staffSession());
    const response = responseFor();
    const result = await controller.verifyStaffMfa({ code: '123456' },
      requestFor({ cookies: { [challengeCookie]: challengeToken } }), response);
    expect(mfa.completeLogin).toHaveBeenCalledWith(challengeToken, { code: '123456' }, expect.any(Object), 'staff');
    expect(sessionCookies(response).sort()).toEqual(['hid_access', 'hid_access_csrf', 'hid_access_refresh']);
    expect(response.setHeader).toHaveBeenCalledWith('x-csrf-token', 'csrf-token');
    expect(response.clearCookie).toHaveBeenCalledWith(challengeCookie, expect.objectContaining({ path: '/api/v1/auth/mfa' }));
    expect(result).toMatchObject({ actor: { sessionId: 'session-1' }, expiresAt: '2030-01-01T00:00:00.000Z' });
  });

  it.each([
    ['verify', (c: AuthController, r: HidRequest, s: Response) => c.verifyStaffMfa({ code: '123456' }, r, s)],
    ['enrolment code', (c: AuthController, r: HidRequest, s: Response) => c.sendStaffEnrollmentCode(r, s)],
    ['enrolment start', (c: AuthController, r: HidRequest, s: Response) => c.startStaffEnrollment({ emailCode: '123456' }, r, s)],
    ['enrolment activation', (c: AuthController, r: HidRequest, s: Response) => c.activateStaffEnrollment({ code: '123456' }, r, s)],
  ])('refuses the %s step without the challenge cookie (401 MFA_CHALLENGE_INVALID) or from another origin', async (_label, step) => {
    await expect(step(controller, requestFor(), responseFor())).rejects.toMatchObject({ status: 401, code: 'MFA_CHALLENGE_INVALID' });
    await expect(step(controller, requestFor({ origin: 'https://attacker.example', cookies: { [challengeCookie]: challengeToken } }),
      responseFor())).rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
    for (const call of Object.values(mfa)) expect(call).not.toHaveBeenCalled();
  });

  it('starts a staff enrolment with the emailed code and activates it into a session with recovery codes', async () => {
    mfa.sendEnrollmentCode.mockResolvedValue({ accepted: true, channel: 'email', expiresAt });
    mfa.startEnrollment.mockResolvedValue({ secret: 'A'.repeat(32), otpauthUri: 'otpauth://totp/x', algorithm: 'SHA1',
      digits: 6, periodSeconds: 30, expiresAt });
    mfa.activateEnrollment.mockResolvedValue({ session: staffSession(), recoveryCodes: ['ABCDE-12345'] });
    const request = requestFor({ cookies: { [challengeCookie]: challengeToken } });
    const sent = responseFor();
    await expect(controller.sendStaffEnrollmentCode(request, sent)).resolves.toEqual({ accepted: true, channel: 'email',
      expiresAt: expiresAt.toISOString() });
    expect(sent.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    const started = responseFor();
    await controller.startStaffEnrollment({ emailCode: '654321' }, request, started);
    expect(mfa.startEnrollment).toHaveBeenCalledWith(challengeToken, expect.any(Object), 'staff', { emailCode: '654321' });
    expect(sessionCookies(started)).toEqual([]);
    const activated = responseFor();
    const result = await controller.activateStaffEnrollment({ code: '123456' }, request, activated);
    expect(mfa.activateEnrollment).toHaveBeenCalledWith(challengeToken, '123456', expect.any(Object), 'staff');
    expect(result.recoveryCodes).toEqual(['ABCDE-12345']);
    expect(sessionCookies(activated).sort()).toEqual(['hid_access', 'hid_access_csrf', 'hid_access_refresh']);
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

function requestFor(input: { origin?: string | null; referer?: string; cookies?: Record<string, string>;
  actor?: ActorContext } = {}): HidRequest {
  const requestOrigin = input.origin === undefined ? origin : input.origin;
  return {
    correlationId,
    ip: '203.0.113.10',
    cookies: input.cookies ?? {},
    actor: input.actor,
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
    status: jest.fn(),
  } as unknown as Response & { cookie: jest.Mock; clearCookie: jest.Mock; setHeader: jest.Mock;
    status: jest.Mock };
}

function restoreEnvironment(): void {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
}
