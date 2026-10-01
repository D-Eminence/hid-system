import type { Response } from 'express';
import type { HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { TurnstileService } from '../auth/turnstile.service';
import { PatientEnrollmentController } from './patient-enrollment.controller';
import type { PatientEnrollmentService } from './patient-enrollment.service';

const originalEnvironment = { ...process.env };
const origin = 'https://www.healthidentitydirectory.com';
const correlationId = 'enrollment-controller-test';

function request(cookie?: string, requestOrigin: string | undefined = origin): HidRequest {
  return { correlationId, ip: '203.0.113.10', header: jest.fn((name: string) => {
    if (name === 'origin') return requestOrigin;
    if (name === 'cookie') return cookie;
    return undefined;
  }) } as unknown as HidRequest;
}

describe('PatientEnrollmentController', () => {
  let service: {
    start: jest.Mock; current: jest.Mock; startContact: jest.Mock;
    verifyContact: jest.Mock; activate: jest.Mock;
  };
  let turnstile: { verify: jest.Mock };
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
      verifyContact: jest.fn(), activate: jest.fn().mockResolvedValue({ stage: 'active', hidCode: 'HID-TEST' }) };
    turnstile = { verify: jest.fn().mockResolvedValue(undefined) };
    controller = new PatientEnrollmentController(service as unknown as PatientEnrollmentService,
      turnstile as unknown as TurnstileService);
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
      '203.0.113.10', correlationId);
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
      request('hid_enrollment=opaque-value'));
    expect(service.activate).toHaveBeenCalledWith('opaque-value', 'a-strong-test-password', correlationId);
  });
});
