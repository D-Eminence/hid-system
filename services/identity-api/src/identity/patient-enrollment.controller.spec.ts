jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { Response } from 'express';
import { AUDIT_ACTION, NO_AUDIT, PUBLIC_ROUTE } from '../common/decorators';
import { DomainProblem } from '../common/problem';
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
    verifyContact: jest.Mock; activate: jest.Mock; bindGoogle: jest.Mock; availability: jest.Mock;
    sendHolderCode: jest.Mock; verifyHolderCode: jest.Mock;
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
      activate: jest.fn().mockResolvedValue({ stage: 'active', hidCode: 'HID-TEST' }),
      availability: jest.fn().mockResolvedValue({ open: false, online: false, facility: false }),
      sendHolderCode: jest.fn().mockResolvedValue({ challengeId: 'c', expiresInSeconds: 300, resendAfterSeconds: 60 }),
      verifyHolderCode: jest.fn().mockResolvedValue({ stage: 'verify_contact', requiredProfileFields: [] }) };
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

  it('answers enrollment availability to anyone, unaudited and briefly cacheable (FE-4)', async () => {
    const route = PatientEnrollmentController.prototype.availability;
    expect(Reflect.getMetadata(PATH_METADATA, PatientEnrollmentController)).toBe('identity/patient-enrollments');
    expect(Reflect.getMetadata(PUBLIC_ROUTE, PatientEnrollmentController)).toBe(true);
    expect(Reflect.getMetadata(PATH_METADATA, route)).toBe('availability');
    expect(Reflect.getMetadata(METHOD_METADATA, route)).toBe(RequestMethod.GET);
    // Every caller gets the same answer and it carries no PHI: no audit row
    // per anonymous read, as for GET /commercial/pricing.
    expect(Reflect.getMetadata(NO_AUDIT, route)).toBe(true);

    for (const answer of [{ open: false, online: false, facility: false }, { open: true, online: true, facility: false }]) {
      service.availability = jest.fn().mockResolvedValue(answer);
      const response = { setHeader: jest.fn(), removeHeader: jest.fn() };
      await expect(controller.availability(response as unknown as Response)).resolves.toEqual(answer);
      expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=30');
      for (const name of ['Pragma', 'Expires', 'Surrogate-Control']) {
        expect(response.removeHeader).toHaveBeenCalledWith(name);
      }
    }
    // It reads no input, cookie, Origin or Turnstile token.
    expect(turnstile.verify).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
  });

  it('keeps a failed availability read uncacheable', async () => {
    service.availability = jest.fn()
      .mockRejectedValue(new Error('runtime state unavailable'));
    const response = { setHeader: jest.fn(), removeHeader: jest.fn() };
    await expect(controller.availability(response as unknown as Response)).rejects.toThrow('runtime state unavailable');
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(response.removeHeader).not.toHaveBeenCalled();
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

  // ADR-062: the holder step. No body for the send: the recipient is the
  // registry phone, never a value the caller gives.
  it('serves the holder routes as accountless, Origin-checked, audited POSTs', () => {
    for (const [method, path, action] of [['holder', 'holder', 'identity.patient-enrollment.holder'],
      ['verifyHolder', 'holder/verify', 'identity.patient-enrollment.holder-verify']] as const) {
      const route = PatientEnrollmentController.prototype[method];
      expect(Reflect.getMetadata(PATH_METADATA, route)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, route)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(NO_AUDIT, route)).toBeUndefined();
      expect(Reflect.getMetadata(AUDIT_ACTION, route)).toBe(action);
    }
    expect(PatientEnrollmentController.prototype.holder.length).toBe(1);
  });

  it('passes only the scoped cookie value to the holder send and verify', async () => {
    const challenge = '6ec117dd-68b0-402a-91a0-c2cf311dcaf7';
    const cookie = 'other=value; hid_enrollment=opaque-value; session=unrelated';
    await controller.holder(request(cookie));
    expect(service.sendHolderCode).toHaveBeenCalledWith('opaque-value', '203.0.113.10', correlationId);
    const response = { clearCookie: jest.fn() };
    await expect(controller.verifyHolder({ challengeId: challenge, code: '123456' }, request(cookie),
      response as unknown as Response)).resolves.toEqual({ stage: 'verify_contact', requiredProfileFields: [] });
    expect(service.verifyHolderCode).toHaveBeenCalledWith('opaque-value', challenge, '123456', correlationId);
    expect(response.clearCookie).not.toHaveBeenCalled();
  });

  it('refuses the holder routes from an unapproved origin or with an HID session, before the service', async () => {
    const challenge = '6ec117dd-68b0-402a-91a0-c2cf311dcaf7';
    const response = { clearCookie: jest.fn() } as unknown as Response;
    const holder = async (incoming: HidRequest) => controller.holder(incoming);
    await expect(holder(request('hid_enrollment=v', 'https://attacker.example')))
      .rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
    await expect(controller.verifyHolder({ challengeId: challenge, code: '123456' },
      request('hid_enrollment=v', 'https://attacker.example'), response)).rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
    await expect(holder(request('hid_enrollment=v; hid_access=session-token')))
      .rejects.toMatchObject({ status: 409 });
    await expect(controller.verifyHolder({ challengeId: challenge, code: '123456' },
      request('hid_enrollment=v', origin, 'Bearer token'), response)).rejects.toMatchObject({ status: 409 });
    expect(service.sendHolderCode).not.toHaveBeenCalled();
    expect(service.verifyHolderCode).not.toHaveBeenCalled();
  });

  it('expires the enrollment cookie when a correct code shows the NIN already has a Health ID, and only then', async () => {
    const challenge = '6ec117dd-68b0-402a-91a0-c2cf311dcaf7';
    const response = { clearCookie: jest.fn() };
    service.verifyHolderCode.mockRejectedValueOnce(new DomainProblem(409, 'NIN_ALREADY_REGISTERED',
      'This NIN already has a Health ID. Use account recovery to sign in.'));
    await expect(controller.verifyHolder({ challengeId: challenge, code: '123456' },
      request('hid_enrollment=opaque-value'), response as unknown as Response))
      .rejects.toMatchObject({ status: 409, code: 'NIN_ALREADY_REGISTERED' });
    expect(response.clearCookie).toHaveBeenCalledWith('hid_enrollment', {
      secure: true, sameSite: 'strict', httpOnly: true, path: '/api/v1/identity/patient-enrollments',
    });
    for (const refusal of [new DomainProblem(422, 'OTP_INVALID', 'The verification code is invalid or expired'),
      new DomainProblem(409, 'NIN_HOLDER_PROOF_CONFLICT', 'Registration for this NIN is in progress at a facility.'),
      new DomainProblem(429, 'NIN_HOLDER_ROUTE_LIMITED', 'Use a participating facility to register.')]) {
      response.clearCookie.mockClear();
      service.verifyHolderCode.mockRejectedValueOnce(refusal);
      await expect(controller.verifyHolder({ challengeId: challenge, code: '123456' },
        request('hid_enrollment=opaque-value'), response as unknown as Response)).rejects.toBe(refusal);
      expect(response.clearCookie).not.toHaveBeenCalled();
    }
  });

  it('rejects duplicate enrollment cookies and expires the enrollment cookie in a successful activation response', async () => {
    await controller.current(request('hid_enrollment=first; hid_enrollment=second'));
    expect(service.current).toHaveBeenCalledWith(undefined, correlationId);
    const response = { clearCookie: jest.fn() };
    await expect(controller.activate({ password: 'a-strong-test-password' },
      request('hid_enrollment=opaque-value'), response as unknown as Response))
      .resolves.toEqual({ stage: 'active', hidCode: 'HID-TEST' });
    expect(service.activate).toHaveBeenCalledWith('opaque-value', 'a-strong-test-password',
      correlationId, undefined, {});
    // The response that carries the HID expires the cookie on its path (N2(b)):
    // a lost response can still be replayed with the cookie, for 15 minutes.
    expect(response.clearCookie).toHaveBeenCalledTimes(1);
    expect(response.clearCookie).toHaveBeenCalledWith('hid_enrollment', {
      secure: true, sameSite: 'strict', httpOnly: true, path: '/api/v1/identity/patient-enrollments',
    });

    // A refused activation keeps it.
    response.clearCookie.mockClear();
    service.activate.mockRejectedValueOnce(new Error('activation failed'));
    await expect(controller.activate({ password: 'a-strong-test-password' },
      request('hid_enrollment=opaque-value'), response as unknown as Response)).rejects.toThrow('activation failed');
    expect(response.clearCookie).not.toHaveBeenCalled();
  });

  // ADR-061: the fields a NIN record did not provide reach the service as
  // sent; the service decides whether each is required or refused.
  it('passes a self-reported date of birth and gender to the activation, and nothing else', async () => {
    const body = { password: 'a-strong-test-password', dateOfBirth: '1990-01-02', gender: 'female' as const };
    const response = { clearCookie: jest.fn() };
    await controller.activate(body, request('hid_enrollment=opaque-value'), response as unknown as Response);
    expect(service.activate).toHaveBeenLastCalledWith('opaque-value', 'a-strong-test-password',
      correlationId, undefined, { dateOfBirth: '1990-01-02', gender: 'female' });
    const genderOnly = { password: 'a-strong-test-password', gender: 'unknown' as const };
    await controller.activate(genderOnly, request('hid_enrollment=opaque-value'), response as unknown as Response);
    expect(service.activate).toHaveBeenLastCalledWith('opaque-value', 'a-strong-test-password',
      correlationId, undefined, { gender: 'unknown' });
    expect(service.activate.mock.calls.at(-1)?.[4]).not.toHaveProperty('dateOfBirth');
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
      correlationId, pending, {});
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
