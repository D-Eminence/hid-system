jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import type { Response } from 'express';
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
    return undefined;
  }) } as unknown as HidRequest;
}

describe('PatientEnrollmentController', () => {
  let service: {
    start: jest.Mock; current: jest.Mock; startContact: jest.Mock;
    verifyContact: jest.Mock; activate: jest.Mock; bindGoogle: jest.Mock;
  };
  let turnstile: { verify: jest.Mock };
  let google: { onboardingStatus: jest.Mock; onboardingCookieName: string };
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
      progress: { stage: 'verify_contact' } }), current: jest.fn(), startContact: jest.fn(),
      verifyContact: jest.fn(), bindGoogle: jest.fn().mockResolvedValue({ bound: true }),
      activate: jest.fn().mockResolvedValue({ stage: 'active', hidCode: 'HID-TEST' }) };
    turnstile = { verify: jest.fn().mockResolvedValue(undefined) };
    google = { onboardingStatus: jest.fn().mockResolvedValue({
      stage: 'GOOGLE_AUTHENTICATED_PENDING_IDENTITY' }),
    onboardingCookieName: 'hid_access_google_onboarding' };
    controller = new PatientEnrollmentController(service as unknown as PatientEnrollmentService,
      turnstile as unknown as TurnstileService,
      google as unknown as GoogleAuthenticationService);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
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

  it('rejects duplicate enrollment cookies and retains replay recovery after activation', async () => {
    await controller.current(request('hid_enrollment=first; hid_enrollment=second'));
    expect(service.current).toHaveBeenCalledWith(undefined, correlationId);
    await controller.activate({ password: 'a-strong-test-password' },
      request('hid_enrollment=opaque-value'), { clearCookie: jest.fn() } as unknown as Response);
    expect(service.activate).toHaveBeenCalledWith('opaque-value', 'a-strong-test-password',
      correlationId, undefined);
  });

  it('binds pending Google proof to enrollment and clears it only after successful activation', async () => {
    const pending = '30000000-0000-4000-8000-000000000001.' + 'A'.repeat(43);
    const cookie = `hid_access_google_onboarding=${pending}; hid_enrollment=opaque-value`;
    const response = { cookie: jest.fn(), clearCookie: jest.fn() };
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
});
