jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { HttpException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { useTestEnvironment } from '../testing/platform-assurance';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { AuthSessionAuditService } from './auth-session-audit.service';
import type { GoogleAuthenticationService } from './google-authentication.service';
import type { LocalAuthProvider } from './local-auth.provider';
import { MfaSecretProtector } from './mfa/mfa-secret-protector';
import { MfaService } from './mfa/mfa.service';
import type { TokenService } from './token.service';
import type { TurnstileService } from './turnstile.service';
import type { WorkloadAuthService } from './workload-auth.service';

// LOGIN-DETAIL-ORACLE: a sign-in refusal raised after the password was
// verified kept its internal message as the 401 detail ("Patient account is
// unavailable", "Account is inactive", "Staff account or facility membership
// is inactive"), so the detail confirmed a correct password.
// A10: a staff account whose password is correct but which has no active
// facility membership was answered as a wrong password and counted toward the
// sign-in lockout. Owner default (a): refuse with 403
// NO_ACTIVE_FACILITY_MEMBERSHIP, issue no session and no MFA challenge, audit
// the refusal, and do not count it as a failed password.

const ORIGIN = 'https://www.healthidentitydirectory.com';

useTestEnvironment({ CORS_ORIGINS: ORIGIN, AUTH_COOKIE_NAME: 'hid_access', TURNSTILE_MODE: 'disabled',
  MFA_SECRET_KEY_B64: Buffer.alloc(32, 0x5a).toString('base64'), MFA_KEY_VERSION: 'sign-in-refusal-v1' });

function requestFor(): HidRequest {
  const headers: Record<string, string> = { origin: ORIGIN, 'user-agent': 'sign-in-refusal-spec' };
  return { correlationId: 'sign-in-refusal-test', ip: '203.0.113.10', cookies: {},
    header: (name: string) => headers[name.toLowerCase()] } as unknown as HidRequest;
}

function responseFor() {
  return { cookie: jest.fn(), clearCookie: jest.fn(), setHeader: jest.fn(), status: jest.fn() } as unknown as Response
    & { cookie: jest.Mock; clearCookie: jest.Mock; setHeader: jest.Mock };
}

function controllerHarness() {
  const auth = { login: jest.fn() };
  const mfa = { beginLogin: jest.fn() };
  const sessionAudit = { record: jest.fn().mockResolvedValue(undefined), recordLoginFailure: jest.fn().mockResolvedValue(undefined) };
  const controller = new AuthController(auth as unknown as AuthService, {} as TokenService,
    sessionAudit as unknown as AuthSessionAuditService, { record: jest.fn() } as unknown as AuditService,
    {} as WorkloadAuthService, { verifyLogin: jest.fn().mockResolvedValue(undefined) } as unknown as TurnstileService,
    {} as GoogleAuthenticationService, mfa as unknown as MfaService);
  return { controller, auth, mfa, sessionAudit };
}

async function failure(promise: Promise<unknown>): Promise<HttpException> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpException);
  return error as HttpException;
}

const patientLogin = { email: 'ada@example.invalid', password: 'a-password', turnstileAction: 'patient-login' } as const;
const staffLogin = { email: 'doctor@example.invalid', password: 'a-password', turnstileAction: 'staff-login' } as const;

describe('sign-in refusals carry one uniform detail (LOGIN-DETAIL-ORACLE)', () => {
  it.each([
    ['a wrong password', 'Invalid credentials'],
    ['a staff-only account at the patient sign-in', 'Patient account is unavailable'],
    ['an account deactivated during sign-in', 'Account is inactive'],
    ['credentials changed during sign-in', 'Credentials changed during authentication; retry login'],
    ['an account that resolved to another identity', 'Resolved account does not match the authenticated identity'],
  ])('patient sign-in: %s is 401 "Invalid credentials" and counts as a failed sign-in', async (_label, internal) => {
    const { controller, auth, sessionAudit } = controllerHarness();
    auth.login.mockRejectedValue(new UnauthorizedException(internal));
    const error = await failure(controller.patientLogin(patientLogin, requestFor(), responseFor()));
    expect(error.getStatus()).toBe(401);
    expect(error.message).toBe('Invalid credentials');
    expect(sessionAudit.recordLoginFailure).toHaveBeenCalledWith(patientLogin.email, expect.any(Object));
  });

  it.each([
    ['a wrong password', 'Invalid credentials'],
    ['an account without a staff membership', 'Invalid credentials'],
    ['an account deactivated during sign-in', 'Account is inactive'],
    ['a stale staff context', 'Staff account or facility membership is inactive'],
  ])('staff password step: %s is 401 "Invalid credentials" and counts as a failed sign-in', async (_label, internal) => {
    const { controller, mfa, sessionAudit } = controllerHarness();
    mfa.beginLogin.mockRejectedValue(new UnauthorizedException(internal));
    const error = await failure(controller.login(staffLogin, requestFor(), responseFor()));
    expect(error.getStatus()).toBe(401);
    expect(error.message).toBe('Invalid credentials');
    expect(sessionAudit.recordLoginFailure).toHaveBeenCalledWith(staffLogin.email, expect.any(Object));
  });
});

describe('a staff account with no active facility membership (A10)', () => {
  it('is answered 403 NO_ACTIVE_FACILITY_MEMBERSHIP at the password step, not counted as a failed password', async () => {
    const { controller, mfa, sessionAudit } = controllerHarness();
    mfa.beginLogin.mockRejectedValue(new DomainProblem(403, 'NO_ACTIVE_FACILITY_MEMBERSHIP',
      'Your account has no active facility membership. Ask your organization administrator for access.'));
    const response = responseFor();
    const error = await failure(controller.login(staffLogin, requestFor(), response));
    expect(error.getStatus()).toBe(403);
    expect((error as DomainProblem).code).toBe('NO_ACTIVE_FACILITY_MEMBERSHIP');
    expect(sessionAudit.recordLoginFailure).not.toHaveBeenCalled();
    // MfaService recorded the refusal against the account in its own transaction.
    expect(sessionAudit.record).not.toHaveBeenCalled();
    expect(response.cookie).not.toHaveBeenCalled();
  });

  const ACCOUNT = '40000000-0000-4000-8000-0000000000e1';

  function mfaHarness(options: { eligible: boolean; workforceRecord: boolean; passwordValid?: boolean }) {
    const statements: string[] = [];
    const client = { query: jest.fn(async (sql: string) => {
      statements.push(String(sql));
      if (sql.includes(' as eligible')) {
        return { rowCount: 1, rows: [{ eligible: options.eligible, enrolled: false, unproven: false,
          token_version: '2', subject: 'synthetic:no-membership' }] };
      }
      if (sql.includes(' as workforce_record')) return { rowCount: 1, rows: [{ workforce_record: options.workforceRecord }] };
      if (sql.includes('insert into auth.mfa_login_challenges')) return { rowCount: 1, rows: [{ expires_at: new Date() }] };
      return { rowCount: 1, rows: [] };
    }) } as unknown as PoolClient;
    const database = { withSystemTransaction: jest.fn(async (_id: string, work: (c: PoolClient) => unknown) => work(client)) };
    const tokens = { recordSessionEvent: jest.fn().mockResolvedValue(undefined) };
    const localProvider = {
      authenticate: jest.fn(async () => {
        if (options.passwordValid === false) throw new UnauthorizedException('Invalid credentials');
        return { accountId: ACCOUNT, subject: 'synthetic:no-membership' };
      }),
      principalHash: () => 'principal-hash',
    };
    const service = new MfaService(database as unknown as DatabaseService, new MfaSecretProtector(),
      tokens as unknown as TokenService, localProvider as unknown as LocalAuthProvider,
      { recordWithClient: jest.fn() } as unknown as AuditService);
    return { service, statements, tokens };
  }
  const event = { correlationId: 'sign-in-refusal-test', sourceIp: '203.0.113.10' };

  it('MfaService issues no challenge and records the refusal for an active staff account without a membership', async () => {
    const { service, statements, tokens } = mfaHarness({ eligible: false, workforceRecord: true });
    const error = await failure(service.beginLogin('doctor@example.invalid', 'a-password', event, 'staff'));
    expect([error.getStatus(), (error as DomainProblem).code]).toEqual([403, 'NO_ACTIVE_FACILITY_MEMBERSHIP']);
    expect(statements.some((sql) => sql.includes('insert into auth.mfa_login_challenges'))).toBe(false);
    expect(statements.some((sql) => sql.includes('delete from auth.login_attempts'))).toBe(false);
    expect(tokens.recordSessionEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'login_failed', outcome: 'denied', accountId: ACCOUNT,
      details: { reason: 'no_active_membership', session_kind: 'staff' } }));
  });

  it('MfaService keeps the uniform 401 for an account with no staff record or membership at all', async () => {
    const { service, tokens } = mfaHarness({ eligible: false, workforceRecord: false });
    const error = await failure(service.beginLogin('patient@example.invalid', 'a-password', event, 'staff'));
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(error.message).toBe('Invalid credentials');
    expect(tokens.recordSessionEvent).not.toHaveBeenCalled();
  });

  it('MfaService keeps the uniform 401 for a wrong password, before any membership is read', async () => {
    const { service, statements } = mfaHarness({ eligible: false, workforceRecord: true, passwordValid: false });
    const error = await failure(service.beginLogin('doctor@example.invalid', 'wrong-password', event, 'staff'));
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(statements).toEqual([]);
  });

  it('MfaService keeps the platform sign-in refusal of a non-administrator the uniform 401', async () => {
    const { service } = mfaHarness({ eligible: false, workforceRecord: true });
    const error = await failure(service.beginLogin('doctor@example.invalid', 'a-password', event, 'platform'));
    expect(error).toBeInstanceOf(UnauthorizedException);
  });
});
