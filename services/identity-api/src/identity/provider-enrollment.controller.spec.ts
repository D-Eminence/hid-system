jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import type { Response } from 'express';
import type { AuthService } from '../auth/auth.service';
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

describe('ProviderEnrollmentController activation sign-in', () => {
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

  it('signs the new administrator in and retires the public patient enrollment cookie (ENR-3)', async () => {
    const completion = { activate: jest.fn().mockResolvedValue({ email: 'provider@example.invalid',
      organizationId: 'organization-1', facilityId: 'facility-1', accountId: 'account-1' }) };
    const auth = { login: jest.fn().mockResolvedValue({ actor: { subject: 'staff:provider' },
      accessToken: 'access-token', refreshToken: 'refresh-token', csrfToken: 'csrf-token',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'), refreshExpiresAt: new Date('2030-01-02T00:00:00.000Z') }) };
    const controller = new ProviderEnrollmentController({} as ProviderEnrollmentService,
      completion as unknown as OrganizationProfileCompletionService, {} as TurnstileService,
      auth as unknown as AuthService);
    const response = { cookie: jest.fn(), clearCookie: jest.fn(), setHeader: jest.fn() };

    await controller.activate({ password: 'a-strong-test-password' },
      request('hid_provider_enrollment=opaque-provider-value'), response as unknown as Response);

    expect(completion.activate).toHaveBeenCalledWith('opaque-provider-value', 'a-strong-test-password',
      'provider-enrollment-controller-test');
    expect(response.cookie.mock.calls.map(([name]) => name).sort())
      .toEqual(['hid_access', 'hid_access_csrf', 'hid_access_refresh']);
    expect(response.clearCookie).toHaveBeenCalledWith('hid_provider_enrollment', expect.objectContaining({
      path: '/api/v1/identity/provider-enrollments' }));
    expect(response.clearCookie).toHaveBeenCalledWith('hid_enrollment', { secure: true, sameSite: 'strict',
      httpOnly: true, path: '/api/v1/identity/patient-enrollments' });
  });
});
