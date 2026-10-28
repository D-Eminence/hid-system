jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import type { AuditService } from '../audit/audit.service';
import type { AuthService } from '../auth/auth.service';
import type { HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { TurnstileService } from '../auth/turnstile.service';
import type { GoogleAuthenticationService } from '../auth/google-authentication.service';
import { PatientEnrollmentController } from './patient-enrollment.controller';
import type { PatientEnrollmentService } from './patient-enrollment.service';

const originalEnvironment = { ...process.env };
const origin = 'https://www.healthidentitydirectory.com';
const correlationId = 'enrollment-controller-test';

function request(cookie?: string, requestOrigin: string | undefined = origin,
  authorization?: string): HidRequest {
  return { correlationId, ip: '203.0.113.10', header: jest.fn((name: string) => {
    if (name === 'origin') return requestOrigin;
    if (name === 'cookie') return cookie;
    if (name === 'authorization') return authorization;
    if (name === 'user-agent') return 'enrollment-browser';
    return undefined;
  }) } as unknown as HidRequest;
}

/** The session POST /auth/patient/login would issue for the new Health ID. */
const session = {
  actor: { kind: 'patient' as const, id: 'patient:account-7', subject: 'patient:account-7', accountId: 'account-7',
    patientId: 'patient-7', sessionId: 'session-7', roles: [], permissions: [], platformRoles: [],
    platformPermissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local' as const },
  accessToken: 'access-token', refreshToken: 'refresh-token', csrfToken: 'csrf-token',
  expiresAt: new Date('2030-01-01T00:15:00.000Z'), refreshExpiresAt: new Date('2030-01-08T00:00:00.000Z'),
};
const responseFor = () => ({ cookie: jest.fn(), clearCookie: jest.fn(), setHeader: jest.fn() });

describe('PatientEnrollmentController', () => {
  let service: {
    start: jest.Mock; signup: jest.Mock; availability: jest.Mock; current: jest.Mock; startContact: jest.Mock;
    verifyContact: jest.Mock; activate: jest.Mock; bindGoogle: jest.Mock;
  };
  let turnstile: { verify: jest.Mock };
  let google: { onboardingStatus: jest.Mock; onboardingCookieName: string };
  let auth: { login: jest.Mock; revoke: jest.Mock };
  let audit: { record: jest.Mock };
  let controller: PatientEnrollmentController;

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: origin, AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      AUTH_COOKIE_SECURE: 'true',
    });
    resetEnvironmentForTests();
    service = { start: jest.fn().mockResolvedValue({ cookie: 'opaque-enrollment-cookie',
      progress: { stage: 'verify_contact' } }),
      signup: jest.fn(async (_input: unknown, _key: string, _ip: string, _correlation: string,
        setCookie: (cookie: string) => void) => { setCookie('opaque-signup-cookie');
        return { cookie: 'opaque-signup-cookie', progress: { stage: 'verify_contact', contactChannel: 'email' } }; }),
      availability: jest.fn().mockResolvedValue({ open: false }), current: jest.fn(), startContact: jest.fn(),
      verifyContact: jest.fn(), bindGoogle: jest.fn().mockResolvedValue({ bound: true }),
      activate: jest.fn().mockResolvedValue({ stage: 'active', hidCode: 'HID-ABC234', replayed: false }) };
    turnstile = { verify: jest.fn().mockResolvedValue(undefined) };
    google = { onboardingStatus: jest.fn().mockResolvedValue({
      stage: 'GOOGLE_AUTHENTICATED_PENDING_IDENTITY' }),
    onboardingCookieName: 'hid_access_google_onboarding' };
    auth = { login: jest.fn().mockResolvedValue(session), revoke: jest.fn().mockResolvedValue(undefined) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    controller = new PatientEnrollmentController(service as unknown as PatientEnrollmentService,
      turnstile as unknown as TurnstileService,
      google as unknown as GoogleAuthenticationService,
      auth as unknown as AuthService, audit as unknown as AuditService);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  it('reads only public availability without requiring an enrollment cookie or Turnstile', async () => {
    await expect(controller.availability({ correlationId } as HidRequest)).resolves.toEqual({ open: false });
    expect(service.availability).toHaveBeenCalledWith(correlationId);
    expect(service.start).not.toHaveBeenCalled();
    expect(turnstile.verify).not.toHaveBeenCalled();
    expect(google.onboardingStatus).not.toHaveBeenCalled();
  });

  describe('POST signup (no NIN)', () => {
    const body = { firstName: 'Ada', lastName: 'Obi', email: 'ada@example.test', phone: '08031234567',
      gender: 'female' as const, hospitalCurrentlyUsing: 'LUTH', termsAccepted: true as const,
      turnstileToken: 'token', turnstileAction: 'patient-enrollment' as const };

    it('checks origin, then Turnstile with the enrollment action, then sets the scoped enrollment cookie', async () => {
      const response = { cookie: jest.fn() };
      await expect(controller.signup(body, 'key', request(), response as unknown as Response))
        .resolves.toEqual({ stage: 'verify_contact', contactChannel: 'email' });
      expect(turnstile.verify).toHaveBeenCalledWith({ token: 'token', action: 'patient-enrollment',
        origin, remoteIp: '203.0.113.10' });
      expect(service.signup).toHaveBeenCalledWith({ firstName: 'Ada', lastName: 'Obi', email: 'ada@example.test',
        phone: '08031234567', gender: 'female', hospitalCurrentlyUsing: 'LUTH' }, 'key', '203.0.113.10',
      correlationId, expect.any(Function));
      expect(response.cookie).toHaveBeenCalledWith('hid_enrollment', 'opaque-signup-cookie', expect.objectContaining({
        httpOnly: true, sameSite: 'strict', secure: true, path: '/api/v1/identity/patient-enrollments' }));
    });

    it('refuses another origin and a signed-in caller before Turnstile or any write', async () => {
      await expect(controller.signup(body, 'key', request(undefined, 'https://attacker.example'),
        { cookie: jest.fn() } as unknown as Response)).rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
      await expect(controller.signup(body, 'key', request(undefined, origin, 'Bearer token'),
        { cookie: jest.fn() } as unknown as Response)).rejects.toMatchObject({ code: 'PATIENT_ENROLLMENT_REQUIRES_SIGN_OUT' });
      expect(service.signup).not.toHaveBeenCalled();
    });
  });

  it('requires an approved origin before Turnstile or provider work', async () => {
    await expect(controller.start({ nin: '12345678901', turnstileToken: 'token',
      turnstileAction: 'patient-enrollment' }, 'key', request(undefined, 'https://attacker.example'),
    { cookie: jest.fn() } as unknown as Response)).rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
    expect(turnstile.verify).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
  });

  it('verifies the enrollment action and sets only an HttpOnly scoped cookie', async () => {
    const response = { cookie: jest.fn() };
    const result = await controller.start({ nin: '12345678901', turnstileToken: 'token',
      turnstileAction: 'patient-enrollment' }, 'idempotency-key', request(),
    response as unknown as Response);
    expect(turnstile.verify).toHaveBeenCalledWith({ token: 'token',
      action: 'patient-enrollment', origin, remoteIp: '203.0.113.10' });
    expect(service.start).toHaveBeenCalledWith('12345678901', 'idempotency-key',
      '203.0.113.10', correlationId, undefined);
    expect(response.cookie).toHaveBeenCalledWith('hid_enrollment', 'opaque-enrollment-cookie', {
      httpOnly: true, sameSite: 'strict', secure: true,
      path: '/api/v1/identity/patient-enrollments', maxAge: 86_400_000,
    });
    expect(result).toEqual({ stage: 'verify_contact' });
  });

  it('passes only the scoped cookie value to contact and verification operations', async () => {
    const challenge = '6ec117dd-68b0-402a-91a0-c2cf311dcaf7';
    const cookie = 'other=value; hid_enrollment=opaque-value; session=unrelated';
    await controller.contact({ channel: 'phone', contact: '08012345678' }, request(cookie));
    await controller.verifyContact({ challengeId: challenge, code: '123456' }, request(cookie));
    expect(service.startContact).toHaveBeenCalledWith('opaque-value', 'phone', '08012345678',
      '203.0.113.10', correlationId);
    expect(service.verifyContact).toHaveBeenCalledWith('opaque-value', challenge, '123456', correlationId);
  });

  it('rejects duplicate enrollment cookies and keeps the enrollment cookie for replay after activation', async () => {
    await controller.current(request('hid_enrollment=first; hid_enrollment=second'));
    expect(service.current).toHaveBeenCalledWith(undefined, correlationId);
    const response = responseFor();
    await controller.activate({ password: 'a-strong-test-password' },
      request('hid_enrollment=opaque-value'), response as unknown as Response);
    expect(service.activate).toHaveBeenCalledWith('opaque-value', 'a-strong-test-password',
      correlationId, undefined);
    // Activation keeps the enrollment cookie, so a reload or a lost response can
    // show the HID again; the service refuses it 15 minutes after activation.
    expect(response.clearCookie).not.toHaveBeenCalled();
  });

  it('binds pending Google proof to enrollment and clears it only after successful activation', async () => {
    const pending = '30000000-0000-4000-8000-000000000001.' + 'A'.repeat(43);
    const cookie = `hid_access_google_onboarding=${pending}; hid_enrollment=opaque-value`;
    const response = responseFor();
    await controller.start({ nin: '12345678901', turnstileToken: 'token',
      turnstileAction: 'patient-enrollment' }, 'idempotency-key', request(cookie),
    response as unknown as Response);
    expect(google.onboardingStatus).toHaveBeenCalledWith(pending);
    expect(service.start).toHaveBeenCalledWith('12345678901', 'idempotency-key',
      '203.0.113.10', correlationId, pending);
    await expect(controller.bindGoogle(request(cookie))).resolves.toEqual({ bound: true });
    expect(google.onboardingStatus).toHaveBeenLastCalledWith(pending);
    expect(service.bindGoogle).toHaveBeenCalledWith('opaque-value', pending, correlationId);
    await controller.activate({ password: 'a-strong-test-password' }, request(cookie),
      response as unknown as Response);
    expect(service.activate).toHaveBeenCalledWith('opaque-value', 'a-strong-test-password',
      correlationId, pending);
    expect(response.clearCookie).toHaveBeenCalledWith('hid_access_google_onboarding', {
      secure: true, sameSite: 'strict', httpOnly: true, path: '/api/v1',
    });

    response.clearCookie.mockClear();
    service.activate.mockRejectedValueOnce(new Error('activation failed'));
    await expect(controller.activate({ password: 'a-strong-test-password' }, request(cookie),
      response as unknown as Response)).rejects.toThrow('activation failed');
    expect(response.clearCookie).not.toHaveBeenCalled();
  });

  it('refuses pending Google enrollment while an HID session cookie is present', async () => {
    const pending = '30000000-0000-4000-8000-000000000001.' + 'A'.repeat(43);
    const cookie = `hid_access_google_onboarding=${pending}; hid_access=existing-session`;
    await expect(controller.start({ nin: '12345678901', turnstileToken: 'token',
      turnstileAction: 'patient-enrollment' }, 'idempotency-key', request(cookie),
      { cookie: jest.fn() } as unknown as Response)).rejects.toMatchObject({
      code: 'GOOGLE_ONBOARDING_REQUIRES_SIGN_OUT',
    });
    expect(google.onboardingStatus).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
    await expect(controller.activate({ password: 'a-strong-test-password' }, request(cookie),
      { clearCookie: jest.fn() } as unknown as Response)).rejects.toMatchObject({
      code: 'GOOGLE_ONBOARDING_REQUIRES_SIGN_OUT',
    });
    expect(service.activate).not.toHaveBeenCalled();
  });

  it('refuses ordinary public enrollment while an HID session is present', async () => {
    await expect(controller.start({ nin: '12345678901', turnstileToken: 'token',
      turnstileAction: 'patient-enrollment' }, 'idempotency-key',
    request('hid_access=existing-session'),
    { cookie: jest.fn() } as unknown as Response)).rejects.toMatchObject({
      code: 'PATIENT_ENROLLMENT_REQUIRES_SIGN_OUT',
    });
    expect(service.start).not.toHaveBeenCalled();

    expect(() => controller.current(request(undefined, origin, 'Bearer existing-session')))
      .toThrow(expect.objectContaining({ code: 'PATIENT_ENROLLMENT_REQUIRES_SIGN_OUT' }));
    expect(service.current).not.toHaveBeenCalled();
  });

  it('refuses public enrollment when the HID session cookie is repeated', async () => {
    // A repeated cookie must not read as "no session". Reading it that way
    // would let a signed-in patient reach public enrollment.
    const duplicated = 'hid_access=existing-session; hid_access=existing-session';
    await expect(controller.start({ nin: '12345678901', turnstileToken: 'token',
      turnstileAction: 'patient-enrollment' }, 'idempotency-key',
    request(duplicated),
    { cookie: jest.fn() } as unknown as Response)).rejects.toMatchObject({
      code: 'PATIENT_ENROLLMENT_REQUIRES_SIGN_OUT',
    });
    expect(service.start).not.toHaveBeenCalled();

    await expect(controller.start({ nin: '12345678901', turnstileToken: 'token',
      turnstileAction: 'patient-enrollment' }, 'idempotency-key',
    request('hid_access_refresh=existing-session; hid_access_refresh=existing-session'),
    { cookie: jest.fn() } as unknown as Response)).rejects.toMatchObject({
      code: 'PATIENT_ENROLLMENT_REQUIRES_SIGN_OUT',
    });
    expect(service.start).not.toHaveBeenCalled();
  });

  describe('POST activate signs the new patient in (owner decision of 2026-10-28)', () => {
    const cookieOptions = { secure: true, sameSite: 'strict' };

    it.each([
      ['the sign-up without a NIN', 'hid_enrollment=opaque-value', undefined],
      ['the NIN route with Google onboarding', `hid_access_google_onboarding=${'30000000-0000-4000-8000-000000000001.' + 'A'.repeat(43)}; hid_enrollment=opaque-value`,
        '30000000-0000-4000-8000-000000000001.' + 'A'.repeat(43)],
    ])('%s: a first activation signs in as POST /auth/patient/login does and answers signedIn true', async (_route, cookie, pending) => {
      const response = responseFor();
      await expect(controller.activate({ password: 'a-strong-test-password' }, request(cookie),
        response as unknown as Response)).resolves.toEqual({ stage: 'active', hidCode: 'HID-ABC234', signedIn: true });
      // The patient sign-in itself: the new Health ID and this password, with the request's device facts.
      expect(auth.login).toHaveBeenCalledWith({ email: 'HID-ABC234', password: 'a-strong-test-password' },
        { correlationId, sourceIp: '203.0.113.10', userAgent: 'enrollment-browser' }, 'patient');
      expect(audit.record).toHaveBeenCalledWith({ correlationId, actorType: 'patient', actorSubject: 'patient:account-7',
        actorAccountId: 'account-7', actorMembershipId: undefined, organizationId: undefined, facilityId: undefined,
        action: 'auth.login', resourceType: 'session', resourceId: 'session-7', outcome: 'success',
        sourceIp: '203.0.113.10', userAgent: 'enrollment-browser' });
      expect(response.cookie.mock.calls).toEqual([
        ['hid_access', 'access-token', { ...cookieOptions, httpOnly: true, path: '/', expires: session.expiresAt }],
        ['hid_access_refresh', 'refresh-token', { ...cookieOptions, httpOnly: true, path: '/api/v1/auth',
          expires: session.refreshExpiresAt }],
        ['hid_access_csrf', 'csrf-token', { ...cookieOptions, httpOnly: false, path: '/', expires: session.refreshExpiresAt }],
      ]);
      expect(response.setHeader).toHaveBeenCalledWith('x-csrf-token', 'csrf-token');
      // The Google onboarding cookie is still cleared on the NIN route; the enrollment cookie is kept.
      if (pending) {
        expect(response.clearCookie).toHaveBeenCalledWith('hid_access_google_onboarding', {
          secure: true, sameSite: 'strict', httpOnly: true, path: '/api/v1' });
      } else {
        expect(response.clearCookie).not.toHaveBeenCalled();
      }
      expect(response.clearCookie).not.toHaveBeenCalledWith('hid_enrollment', expect.anything());
    });

    it('a replay (the enrollment was already active) signs nobody in and answers signedIn false', async () => {
      service.activate.mockResolvedValue({ stage: 'active', hidCode: 'HID-ABC234', replayed: true });
      const response = responseFor();
      await expect(controller.activate({ password: 'any-other-password' }, request('hid_enrollment=opaque-value'),
        response as unknown as Response)).resolves.toEqual({ stage: 'active', hidCode: 'HID-ABC234', signedIn: false });
      expect(auth.login).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(response.cookie).not.toHaveBeenCalled();
      expect(response.setHeader).not.toHaveBeenCalled();
    });

    it('a browser that is signed in after its activation cannot activate again: no second session', async () => {
      await expect(controller.activate({ password: 'a-strong-test-password' },
        request('hid_enrollment=opaque-value; hid_access=access-token'), responseFor() as unknown as Response))
        .rejects.toMatchObject({ code: 'PATIENT_ENROLLMENT_REQUIRES_SIGN_OUT' });
      expect(service.activate).not.toHaveBeenCalled();
      expect(auth.login).not.toHaveBeenCalled();
    });

    it('still activates, with signedIn false and no cookie, when the session cannot be created', async () => {
      auth.login.mockRejectedValue(new UnauthorizedException('Patient account is unavailable'));
      const warn = jest.spyOn((controller as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      const response = responseFor();
      await expect(controller.activate({ password: 'a-strong-test-password' }, request('hid_enrollment=opaque-value'),
        response as unknown as Response)).resolves.toEqual({ stage: 'active', hidCode: 'HID-ABC234', signedIn: false });
      expect(response.cookie).not.toHaveBeenCalled();
      expect(response.setHeader).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      // Logged with the correlation id and a status only: no Health ID, password or address.
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]?.[0]);
      expect(logged).toContain(correlationId);
      expect(logged).toContain('401');
      for (const secret of ['HID-ABC234', 'a-strong-test-password', 'account-7']) expect(logged).not.toContain(secret);
    });

    it('revokes a session whose audit failed and hands over no cookie', async () => {
      audit.record.mockRejectedValue(new Error('audit unavailable'));
      jest.spyOn((controller as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      const response = responseFor();
      await expect(controller.activate({ password: 'a-strong-test-password' }, request('hid_enrollment=opaque-value'),
        response as unknown as Response)).resolves.toMatchObject({ signedIn: false });
      expect(auth.revoke).toHaveBeenCalledWith('session-7', 'patient:account-7',
        { correlationId, sourceIp: '203.0.113.10', userAgent: 'enrollment-browser' });
      expect(response.cookie).not.toHaveBeenCalled();
    });

    it('a failed activation signs nobody in', async () => {
      service.activate.mockRejectedValue(new Error('activation failed'));
      await expect(controller.activate({ password: 'a-strong-test-password' }, request('hid_enrollment=opaque-value'),
        responseFor() as unknown as Response)).rejects.toThrow('activation failed');
      expect(auth.login).not.toHaveBeenCalled();
    });
  });
});
