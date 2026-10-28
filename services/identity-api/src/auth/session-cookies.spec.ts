jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import type { Response } from 'express';
import type { AuditService } from '../audit/audit.service';
import type { HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { OrganizationProfileCompletionService } from '../identity/organization-profile-completion.service';
import { PatientEnrollmentController } from '../identity/patient-enrollment.controller';
import type { PatientEnrollmentService } from '../identity/patient-enrollment.service';
import { ProviderEnrollmentController } from '../identity/provider-enrollment.controller';
import type { ProviderEnrollmentService } from '../identity/provider-enrollment.service';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { AuthSessionAuditService } from './auth-session-audit.service';
import type { LoginDto } from './dto/login.dto';
import type { GoogleAuthenticationService } from './google-authentication.service';
import { setSessionCookies } from './session-cookies';
import type { TokenService } from './token.service';
import type { TurnstileService } from './turnstile.service';
import type { WorkloadAuthService } from './workload-auth.service';

/**
 * The staff sign-in and facility self sign-up's activation set their session
 * with one helper (CRITIC C18); this pins the cookies and proves both routes
 * set exactly the same ones.
 */
const originalEnvironment = { ...process.env };
const origin = 'https://app.healthidentitydirectory.com';
const issued = {
  actor: { id: 'staff-subject', subject: 'staff-subject', accountId: 'account-1', kind: 'staff' as const,
    roles: [], permissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local' as const },
  accessToken: 'access-token', refreshToken: 'refresh-token', csrfToken: 'csrf-token',
  expiresAt: new Date('2030-01-01T00:00:00.000Z'), refreshExpiresAt: new Date('2030-01-02T00:00:00.000Z'),
};
const response = () => ({ cookie: jest.fn(), clearCookie: jest.fn(), setHeader: jest.fn() });
const request = (cookie?: string) => ({ correlationId: 'session-cookie-test', ip: '203.0.113.10',
  cookies: {}, header: (name: string) => name === 'origin' ? origin : name === 'cookie' ? cookie : undefined,
}) as unknown as HidRequest;

describe('session cookies', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid', CORS_ORIGINS: origin,
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456', AUTH_COOKIE_SECURE: 'true', TURNSTILE_MODE: 'disabled',
    });
    resetEnvironmentForTests();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  it('sets the access, refresh and CSRF cookies with their paths and lifetimes', () => {
    const res = response();
    setSessionCookies(res as unknown as Response, issued, { AUTH_COOKIE_NAME: 'hid_access', AUTH_COOKIE_SECURE: true });
    expect(res.cookie.mock.calls).toEqual([
      ['hid_access', 'access-token', { secure: true, sameSite: 'strict', httpOnly: true, path: '/',
        expires: issued.expiresAt }],
      ['hid_access_refresh', 'refresh-token', { secure: true, sameSite: 'strict', httpOnly: true,
        path: '/api/v1/auth', expires: issued.refreshExpiresAt }],
      ['hid_access_csrf', 'csrf-token', { secure: true, sameSite: 'strict', httpOnly: false, path: '/',
        expires: issued.refreshExpiresAt }],
    ]);
  });

  it('is the same at a staff sign-in and at the facility self sign-up activation', async () => {
    const auth = { login: jest.fn().mockResolvedValue(issued) };
    const signIn = new AuthController(auth as unknown as AuthService, {} as TokenService,
      { record: jest.fn(), recordLoginFailure: jest.fn() } as unknown as AuthSessionAuditService,
      { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService, {} as WorkloadAuthService,
      { verifyLogin: jest.fn().mockResolvedValue(undefined) } as unknown as TurnstileService,
      {} as GoogleAuthenticationService);
    const signedIn = response();
    await signIn.login({ email: 'provider@example.invalid', password: 'a-strong-test-password',
      turnstileAction: 'staff-login', turnstileToken: 'proof' } as LoginDto, request(),
    signedIn as unknown as Response);

    const activation = new ProviderEnrollmentController(
      { assertSelfServiceOpen: jest.fn().mockResolvedValue(undefined) } as unknown as ProviderEnrollmentService,
      { activate: jest.fn().mockResolvedValue({ email: 'provider@example.invalid', organizationId: 'o',
        facilityId: 'f', accountId: 'a' }) } as unknown as OrganizationProfileCompletionService,
      {} as TurnstileService, auth as unknown as AuthService);
    const activated = response();
    await activation.activate({ password: 'a-strong-test-password' }, request('hid_provider_enrollment=x'),
      activated as unknown as Response);

    expect(activated.cookie.mock.calls).toEqual(signedIn.cookie.mock.calls);
    expect(activated.setHeader).toHaveBeenCalledWith('x-csrf-token', 'csrf-token');
    expect(signedIn.setHeader).toHaveBeenCalledWith('x-csrf-token', 'csrf-token');
  });

  it('is the same at a patient sign-in and at the patient enrollment activation, with the same audit and device facts', async () => {
    const patientSession = { ...issued, actor: { ...issued.actor, kind: 'patient' as const, id: 'patient:account-1',
      subject: 'patient:account-1', patientId: 'patient-1', sessionId: 'session-1' },
    refreshExpiresAt: new Date('2030-01-08T00:00:00.000Z') };
    const signInAuth = { login: jest.fn().mockResolvedValue(patientSession) };
    const signInAudit = { record: jest.fn().mockResolvedValue(undefined) };
    const signIn = new AuthController(signInAuth as unknown as AuthService, {} as TokenService,
      { record: jest.fn(), recordLoginFailure: jest.fn() } as unknown as AuthSessionAuditService,
      signInAudit as unknown as AuditService, {} as WorkloadAuthService,
      { verifyLogin: jest.fn().mockResolvedValue(undefined) } as unknown as TurnstileService,
      {} as GoogleAuthenticationService);
    const signedIn = response();
    await expect(signIn.patientLogin({ email: 'HID-ABC234', password: 'a-strong-test-password',
      turnstileAction: 'patient-login', turnstileToken: 'proof' }, patientRequest(), signedIn as unknown as Response))
      .resolves.toMatchObject({ actor: { kind: 'patient' } });

    const activationAuth = { login: jest.fn().mockResolvedValue(patientSession), revoke: jest.fn() };
    const activationAudit = { record: jest.fn().mockResolvedValue(undefined) };
    const activation = new PatientEnrollmentController(
      { activate: jest.fn().mockResolvedValue({ stage: 'active', hidCode: 'HID-ABC234', replayed: false }) } as unknown as PatientEnrollmentService,
      {} as TurnstileService, { onboardingCookieName: 'hid_access_google_onboarding' } as unknown as GoogleAuthenticationService,
      activationAuth as unknown as AuthService, activationAudit as unknown as AuditService);
    const activated = response();
    await expect(activation.activate({ password: 'a-strong-test-password' }, patientRequest('hid_enrollment=x'),
      activated as unknown as Response)).resolves.toEqual({ stage: 'active', hidCode: 'HID-ABC234', signedIn: true });

    expect(activated.cookie.mock.calls).toEqual(signedIn.cookie.mock.calls);
    expect(activated.cookie.mock.calls[1]?.[2]).toMatchObject({ expires: patientSession.refreshExpiresAt });
    expect(activated.setHeader).toHaveBeenCalledWith('x-csrf-token', 'csrf-token');
    expect(signedIn.setHeader).toHaveBeenCalledWith('x-csrf-token', 'csrf-token');
    // The same sign-in (a patient, with the request's correlation, address and user agent) and the same audit event.
    expect(activationAuth.login.mock.calls[0]?.slice(1)).toEqual(signInAuth.login.mock.calls[0]?.slice(1));
    expect(activationAuth.login.mock.calls[0]?.[0]).toEqual({ email: 'HID-ABC234', password: 'a-strong-test-password' });
    expect(activationAudit.record.mock.calls).toEqual(signInAudit.record.mock.calls);
    expect(activationAudit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.login', actorType: 'patient' }));
  });
});

function patientRequest(cookie?: string): HidRequest {
  const headers: Record<string, string | undefined> = { origin, cookie, 'user-agent': 'patient-browser' };
  return { correlationId: 'session-cookie-test', ip: '203.0.113.10', cookies: {},
    header: (name: string) => headers[name.toLowerCase()] } as unknown as HidRequest;
}
