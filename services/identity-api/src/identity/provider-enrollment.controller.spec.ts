jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import type { Response } from 'express';
import type { AuthService } from '../auth/auth.service';
import type { TurnstileService } from '../auth/turnstile.service';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { OrganizationProfileCompletionService } from './organization-profile-completion.service';
import { ProviderEnrollmentController } from './provider-enrollment.controller';
import type { ProviderEnrollmentService } from './provider-enrollment.service';

const originalEnvironment = { ...process.env };
const origin = 'https://app.healthidentitydirectory.com';
const correlationId = 'provider-enrollment-controller-test';
const startInput = {
  productCode: 'ehr' as const, organizationType: 'hospital' as const, cacRegistrationNumber: 'RC1234567',
  administratorName: 'Synthetic Provider Admin', administratorEmail: 'provider@example.invalid',
  turnstileAction: 'provider-enrollment' as const, turnstileToken: 'opaque-proof',
};
const verifyInput = { challengeId: '8ce75fc3-0bda-4300-b198-f5688df65d6c', code: '123456' };
const closed = () => new DomainProblem(423, 'PROVIDER_ENROLLMENT_UNAVAILABLE', 'Facility self sign-up is not open');

// requestOrigin null sends no Origin header.
function request(cookie?: string, requestOrigin: string | null = origin, authorization?: string): HidRequest {
  return { correlationId, ip: '203.0.113.10',
    header: jest.fn((name: string) => {
      if (name === 'origin') return requestOrigin ?? undefined;
      if (name === 'cookie') return cookie;
      if (name === 'authorization') return authorization;
      if (name === 'user-agent') return 'synthetic-agent';
      return undefined;
    }) } as unknown as HidRequest;
}

const loginResult = {
  actor: { subject: 'org-onboarding:account-1', accountId: 'account-1', kind: 'staff' },
  accessToken: 'access-token', refreshToken: 'refresh-token', csrfToken: 'csrf-token',
  expiresAt: new Date('2030-01-01T00:00:00.000Z'), refreshExpiresAt: new Date('2030-01-02T00:00:00.000Z'),
};

describe('ProviderEnrollmentController', () => {
  let enrollments: { start: jest.Mock; assertSelfServiceOpen: jest.Mock; availability: jest.Mock };
  let completion: { verify: jest.Mock; activate: jest.Mock };
  let turnstile: { verify: jest.Mock };
  let auth: { login: jest.Mock };
  let controller: ProviderEnrollmentController;
  const response = () => ({ cookie: jest.fn(), clearCookie: jest.fn(), setHeader: jest.fn() });

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: `${origin},https://staging.healthidentitydirectory.com`, AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      AUTH_COOKIE_SECURE: 'true',
    });
    resetEnvironmentForTests();
    enrollments = {
      start: jest.fn().mockResolvedValue({ accepted: true, challengeId: verifyInput.challengeId }),
      assertSelfServiceOpen: jest.fn().mockResolvedValue(undefined),
      availability: jest.fn().mockResolvedValue({ open: true }),
    };
    completion = {
      verify: jest.fn().mockResolvedValue({ verified: true, cookie: 'opaque-provider-value' }),
      activate: jest.fn().mockResolvedValue({ email: 'provider@example.invalid',
        organizationId: 'organization-1', facilityId: 'facility-1', accountId: 'account-1' }),
    };
    turnstile = { verify: jest.fn().mockResolvedValue(undefined) };
    auth = { login: jest.fn().mockResolvedValue(loginResult) };
    controller = new ProviderEnrollmentController(enrollments as unknown as ProviderEnrollmentService,
      completion as unknown as OrganizationProfileCompletionService, turnstile as unknown as TurnstileService,
      auth as unknown as AuthService);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  it('signs the new administrator in with exactly the three session cookies and leaves hid_enrollment alone', async () => {
    const res = response();
    const answer = await controller.activate({ password: 'a-strong-test-password' },
      request('theme=dark; hid_provider_enrollment=opaque-provider-value'), res as unknown as Response);

    expect(enrollments.assertSelfServiceOpen).toHaveBeenCalledTimes(1);
    expect(completion.activate).toHaveBeenCalledWith('opaque-provider-value', 'a-strong-test-password', correlationId);
    expect(auth.login).toHaveBeenCalledWith({ email: 'provider@example.invalid', password: 'a-strong-test-password' },
      { correlationId, sourceIp: '203.0.113.10', userAgent: 'synthetic-agent' }, 'staff');
    expect(res.cookie.mock.calls.map(([name]) => name).sort())
      .toEqual(['hid_access', 'hid_access_csrf', 'hid_access_refresh']);
    expect(res.cookie).toHaveBeenCalledWith('hid_access', 'access-token', { secure: true, sameSite: 'strict',
      httpOnly: true, path: '/', expires: loginResult.expiresAt });
    expect(res.cookie).toHaveBeenCalledWith('hid_access_refresh', 'refresh-token', { secure: true, sameSite: 'strict',
      httpOnly: true, path: '/api/v1/auth', expires: loginResult.refreshExpiresAt });
    expect(res.cookie).toHaveBeenCalledWith('hid_access_csrf', 'csrf-token', { secure: true, sameSite: 'strict',
      httpOnly: false, path: '/', expires: loginResult.refreshExpiresAt });
    expect(res.setHeader).toHaveBeenCalledWith('x-csrf-token', 'csrf-token');
    expect(res.clearCookie).toHaveBeenCalledTimes(1);
    expect(res.clearCookie).toHaveBeenCalledWith('hid_provider_enrollment', { secure: true, sameSite: 'strict',
      httpOnly: true, path: '/api/v1/identity/provider-enrollments' });
    // Novu never expires the public patient enrollment cookie at sign-in.
    expect(res.clearCookie).not.toHaveBeenCalledWith('hid_enrollment', expect.anything());
    expect(answer).toEqual({ activated: true, organizationId: 'organization-1', facilityId: 'facility-1',
      accountId: 'account-1', actor: loginResult.actor, expiresAt: '2030-01-01T00:00:00.000Z' });
    expect(answer).not.toHaveProperty('status');
  });

  it('passes no cookie value when hid_provider_enrollment is missing or repeated', async () => {
    for (const cookie of [undefined, 'hid_provider_enrollment=one; hid_provider_enrollment=two']) {
      completion.activate.mockClear();
      await controller.activate({ password: 'a-strong-test-password' }, request(cookie),
        response() as unknown as Response);
      expect(completion.activate).toHaveBeenCalledWith(undefined, 'a-strong-test-password', correlationId);
    }
  });

  it('sets the restricted one-hour enrollment cookie after the emailed code', async () => {
    const res = response();
    await expect(controller.verify(verifyInput, request(), res as unknown as Response))
      .resolves.toEqual({ verified: true });
    expect(enrollments.assertSelfServiceOpen).toHaveBeenCalledTimes(1);
    expect(completion.verify).toHaveBeenCalledWith(verifyInput.challengeId, verifyInput.code, correlationId);
    expect(res.cookie).toHaveBeenCalledWith('hid_provider_enrollment', 'opaque-provider-value', {
      httpOnly: true, sameSite: 'strict', secure: true, path: '/api/v1/identity/provider-enrollments',
      maxAge: 60 * 60 * 1000 });
  });

  it('verifies the provider-enrollment Turnstile action at start, then hands over to the service', async () => {
    await expect(controller.start(startInput, request())).resolves.toMatchObject({ accepted: true });
    expect(turnstile.verify).toHaveBeenCalledWith({ token: 'opaque-proof', action: 'provider-enrollment',
      origin, remoteIp: '203.0.113.10' });
    expect(enrollments.start).toHaveBeenCalledWith(startInput, expect.objectContaining({ correlationId }));
    expect(turnstile.verify.mock.invocationCallOrder[0]).toBeLessThan(enrollments.start.mock.invocationCallOrder[0]!);
  });

  describe('a signed-in browser', () => {
    it.each([
      ['the access cookie', 'hid_access=token', undefined],
      ['the CSRF cookie alone (the access cookie expired)', 'hid_access_csrf=token', undefined],
      ['the refresh cookie', 'hid_access_refresh=token', undefined],
      ['an Authorization header', undefined, 'Bearer token'],
    ])('is refused 409 PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT with %s, on every route', async (_label, cookie, authorization) => {
      const conflict = { status: 409, code: 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT' };
      await expect(controller.start(startInput, request(cookie, origin, authorization))).rejects.toMatchObject(conflict);
      await expect(controller.verify(verifyInput, request(cookie, origin, authorization),
        response() as unknown as Response)).rejects.toMatchObject(conflict);
      await expect(controller.activate({ password: 'a-strong-test-password' }, request(cookie, origin, authorization),
        response() as unknown as Response)).rejects.toMatchObject(conflict);
      expect(turnstile.verify).not.toHaveBeenCalled();
      expect(enrollments.start).not.toHaveBeenCalled();
      expect(enrollments.assertSelfServiceOpen).not.toHaveBeenCalled();
      expect(completion.verify).not.toHaveBeenCalled();
      expect(completion.activate).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['another site', 'https://attacker.example'],
    ['a product host', 'https://ehr.healthidentitydirectory.com'],
    ['no Origin', null],
  ])('refuses %s with 403 ORIGIN_DENIED on every route before anything else', async (_label, requestOrigin) => {
    const denied = { status: 403, code: 'ORIGIN_DENIED' };
    await expect(controller.start(startInput, request(undefined, requestOrigin))).rejects.toMatchObject(denied);
    await expect(controller.verify(verifyInput, request(undefined, requestOrigin),
      response() as unknown as Response)).rejects.toMatchObject(denied);
    await expect(controller.activate({ password: 'a-strong-test-password' },
      request('hid_provider_enrollment=x', requestOrigin), response() as unknown as Response)).rejects.toMatchObject(denied);
    expect(turnstile.verify).not.toHaveBeenCalled();
    expect(enrollments.start).not.toHaveBeenCalled();
    expect(enrollments.assertSelfServiceOpen).not.toHaveBeenCalled();
    expect(completion.verify).not.toHaveBeenCalled();
    expect(completion.activate).not.toHaveBeenCalled();
  });

  describe('while self sign-up is closed', () => {
    it('answers start 423 after Turnstile', async () => {
      enrollments.start.mockRejectedValue(closed());
      await expect(controller.start(startInput, request()))
        .rejects.toMatchObject({ status: 423, code: 'PROVIDER_ENROLLMENT_UNAVAILABLE' });
      expect(turnstile.verify).toHaveBeenCalledTimes(1);
    });

    it('answers verify 423 before the code is checked or a cookie is set', async () => {
      enrollments.assertSelfServiceOpen.mockRejectedValue(closed());
      const res = response();
      await expect(controller.verify(verifyInput, request(), res as unknown as Response))
        .rejects.toMatchObject({ status: 423, code: 'PROVIDER_ENROLLMENT_UNAVAILABLE' });
      expect(completion.verify).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it('answers activate 423 before the cookie, the password hash or a sign-in', async () => {
      enrollments.assertSelfServiceOpen.mockRejectedValue(closed());
      const res = response();
      await expect(controller.activate({ password: 'a-strong-test-password' },
        request('hid_provider_enrollment=opaque-provider-value'), res as unknown as Response))
        .rejects.toMatchObject({ status: 423, code: 'PROVIDER_ENROLLMENT_UNAVAILABLE' });
      expect(completion.activate).not.toHaveBeenCalled();
      expect(auth.login).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
      expect(res.clearCookie).not.toHaveBeenCalled();
    });
  });

  describe('availability', () => {
    it('reads the service with no Origin, cookie, Turnstile or gate call', async () => {
      await expect(controller.availability()).resolves.toEqual({ open: true });
      enrollments.availability.mockResolvedValue({ open: false });
      await expect(controller.availability()).resolves.toEqual({ open: false });
      expect(turnstile.verify).not.toHaveBeenCalled();
      expect(enrollments.start).not.toHaveBeenCalled();
    });

    it.each([
      ['a rejected promise', () => enrollments.availability.mockRejectedValue(new Error('database down'))],
      ['a thrown error', () => enrollments.availability.mockImplementation(() => { throw new Error('configuration'); })],
      ['a 503 problem', () => enrollments.availability.mockRejectedValue(
        new DomainProblem(503, 'PROVIDER_ENROLLMENT_UNAVAILABLE', 'unavailable'))],
      ['a malformed answer', () => enrollments.availability.mockResolvedValue({ open: 'yes' })],
    ])('answers { open: false } on %s, never an error', async (_label, arrange) => {
      arrange();
      await expect(controller.availability()).resolves.toEqual({ open: false });
    });
  });
});
