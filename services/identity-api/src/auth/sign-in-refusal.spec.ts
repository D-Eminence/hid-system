jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { HttpException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { AuthSessionAuditService } from './auth-session-audit.service';
import type { GoogleAuthenticationService } from './google-authentication.service';
import type { TokenService } from './token.service';
import type { TurnstileService } from './turnstile.service';
import type { WorkloadAuthService } from './workload-auth.service';

// LOGIN-DETAIL-ORACLE (main D-Eminence/hid-system#76): a sign-in refusal
// raised after the password was verified kept its internal message as the 401
// detail ("Patient account is unavailable", "Staff account or facility
// membership is inactive", "Credentials changed during authentication"), so
// the detail confirmed a correct password.

const ORIGIN = 'https://www.healthidentitydirectory.com';
const originalEnvironment = { ...process.env };

function requestFor(): HidRequest {
  const headers: Record<string, string> = { origin: ORIGIN, 'user-agent': 'sign-in-refusal-spec' };
  return { correlationId: 'sign-in-refusal-test', ip: '203.0.113.10', cookies: {},
    header: (name: string) => headers[name.toLowerCase()] } as unknown as HidRequest;
}

function responseFor() {
  return { cookie: jest.fn(), clearCookie: jest.fn(), setHeader: jest.fn(), status: jest.fn() } as unknown as Response
    & { cookie: jest.Mock; clearCookie: jest.Mock; setHeader: jest.Mock };
}

function harness() {
  const auth = { login: jest.fn() };
  const sessionAudit = { record: jest.fn().mockResolvedValue(undefined), recordLoginFailure: jest.fn().mockResolvedValue(undefined) };
  const controller = new AuthController(auth as unknown as AuthService, {} as TokenService,
    sessionAudit as unknown as AuthSessionAuditService, { record: jest.fn() } as unknown as AuditService,
    {} as WorkloadAuthService, { verifyLogin: jest.fn().mockResolvedValue(undefined) } as unknown as TurnstileService,
    {} as GoogleAuthenticationService);
  return { controller, auth, sessionAudit };
}

async function failure(promise: Promise<unknown>): Promise<HttpException> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpException);
  return error as HttpException;
}

const patientLogin = { email: 'ada@example.invalid', password: 'a-password', turnstileAction: 'patient-login' } as const;
const staffLogin = { email: 'doctor@example.invalid', password: 'a-password', turnstileAction: 'staff-login' } as const;

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
    DATABASE_SSL: 'false', CORS_ORIGINS: ORIGIN, AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters', AUTH_COOKIE_NAME: 'hid_access',
    AUTH_COOKIE_SECURE: 'false', TURNSTILE_MODE: 'disabled' });
  resetEnvironmentForTests();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  resetEnvironmentForTests();
});

describe('sign-in refusals carry one uniform detail (LOGIN-DETAIL-ORACLE)', () => {
  const internal = [
    ['a wrong password', 'Invalid credentials'],
    ['an account that is not a patient', 'Patient account is unavailable'],
    ['an inactive staff membership', 'Staff account or facility membership is inactive'],
    ['credentials changed during sign-in', 'Credentials changed during authentication; retry login'],
    ['an account that resolved to another identity', 'Resolved account does not match the authenticated identity'],
  ];

  it.each(internal)('patient sign-in: %s is 401 "Invalid credentials" and counts as a failed sign-in', async (_label, reason) => {
    const { controller, auth, sessionAudit } = harness();
    auth.login.mockRejectedValue(new UnauthorizedException(reason));
    const error = await failure(controller.patientLogin(patientLogin, requestFor(), responseFor()));
    expect(error.getStatus()).toBe(401);
    expect(error.message).toBe('Invalid credentials');
    expect(error.getResponse()).toEqual({ statusCode: 401, message: 'Invalid credentials', error: 'Unauthorized' });
    expect(sessionAudit.recordLoginFailure).toHaveBeenCalledWith(patientLogin.email, expect.any(Object));
  });

  it.each(internal)('staff sign-in: %s is 401 "Invalid credentials" and counts as a failed sign-in', async (_label, reason) => {
    const { controller, auth, sessionAudit } = harness();
    auth.login.mockRejectedValue(new UnauthorizedException(reason));
    const error = await failure(controller.login(staffLogin, requestFor(), responseFor()));
    expect(error.getStatus()).toBe(401);
    expect(error.message).toBe('Invalid credentials');
    expect(sessionAudit.recordLoginFailure).toHaveBeenCalledWith(staffLogin.email, expect.any(Object));
  });

  it('keeps any other refusal or fault as it is, not counted as a failed password', async () => {
    const { controller, auth, sessionAudit } = harness();
    const locked = new DomainProblem(429, 'LOGIN_RATE_LIMITED', 'Too many attempts');
    auth.login.mockRejectedValueOnce(locked);
    await expect(controller.patientLogin(patientLogin, requestFor(), responseFor())).rejects.toBe(locked);
    const fault = new ServiceUnavailableException('Database is unavailable');
    auth.login.mockRejectedValueOnce(fault);
    await expect(controller.login(staffLogin, requestFor(), responseFor())).rejects.toBe(fault);
    expect(sessionAudit.recordLoginFailure).not.toHaveBeenCalled();
    expect(sessionAudit.record).toHaveBeenCalledTimes(2);
  });
});
