jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import type { Response } from 'express';
import type { MfaService } from '../auth/mfa/mfa.service';
import type { TurnstileService } from '../auth/turnstile.service';
import type { HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { OrganizationProfileCompletionService } from './organization-profile-completion.service';
import { ProviderEnrollmentController } from './provider-enrollment.controller';
import type { ProviderEnrollmentService } from './provider-enrollment.service';

const originalEnvironment = { ...process.env };
const origin = 'https://www.healthidentitydirectory.com';

function request(cookie: string): HidRequest {
  return { correlationId: 'provider-enrollment-controller-test', ip: '203.0.113.10',
    header: jest.fn((name: string) => {
      if (name === 'origin') return origin;
      if (name === 'cookie') return cookie;
      return undefined;
    }) } as unknown as HidRequest;
}

describe('ProviderEnrollmentController activation', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: origin, AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      AUTH_COOKIE_SECURE: 'true',
    });
    resetEnvironmentForTests();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  it('opens the first staff sign-in at enrolment, proven by the activation, and sets no session cookie (MFA-1)', async () => {
    const completion = { activate: jest.fn().mockResolvedValue({ email: 'provider@example.invalid',
      organizationId: 'organization-1', facilityId: 'facility-1', accountId: 'account-1' }) };
    const expiresAt = new Date(Date.now() + 600_000);
    const mfa = { beginLogin: jest.fn().mockResolvedValue({ purpose: 'enroll', token: 'P'.repeat(43), expiresAt }) };
    const controller = new ProviderEnrollmentController({} as ProviderEnrollmentService,
      completion as unknown as OrganizationProfileCompletionService, {} as TurnstileService,
      mfa as unknown as MfaService);
    const response = { cookie: jest.fn(), clearCookie: jest.fn(), setHeader: jest.fn() };

    const result = await controller.activate({ password: 'a-strong-test-password' },
      request('hid_provider_enrollment=opaque-provider-value'), response as unknown as Response);

    expect(completion.activate).toHaveBeenCalledWith('opaque-provider-value', 'a-strong-test-password',
      'provider-enrollment-controller-test');
    // The password just set opens a staff challenge whose enrolment proof is this activation.
    expect(mfa.beginLogin).toHaveBeenCalledWith('provider@example.invalid', 'a-strong-test-password',
      expect.objectContaining({ correlationId: 'provider-enrollment-controller-test' }), 'staff', { activationProof: true });
    expect(response.cookie.mock.calls.map(([name]) => name)).toEqual(['hid_access_mfa']);
    expect(response.cookie).toHaveBeenCalledWith('hid_access_mfa', 'P'.repeat(43), { secure: true, sameSite: 'strict',
      httpOnly: true, path: '/api/v1/auth/mfa', expires: expiresAt });
    expect(result).toEqual({ activated: true, organizationId: 'organization-1', facilityId: 'facility-1',
      accountId: 'account-1', status: 'mfa_enrollment_required', expiresAt: expiresAt.toISOString() });
    expect(result).not.toHaveProperty('actor');
    expect(response.clearCookie).toHaveBeenCalledWith('hid_provider_enrollment', expect.objectContaining({
      path: '/api/v1/identity/provider-enrollments' }));
    // ENR-3: the device's public patient enrollment cookie is retired, as at any sign-in.
    expect(response.clearCookie).toHaveBeenCalledWith('hid_enrollment', { secure: true, sameSite: 'strict',
      httpOnly: true, path: '/api/v1/identity/patient-enrollments' });
  });
});
