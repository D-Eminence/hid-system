jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { useTestEnvironment } from '../testing/platform-assurance';
import type { AuthSessionAuditService } from './auth-session-audit.service';
import type { MfaService } from './mfa/mfa.service';
import { PlatformAuthController } from './platform-auth.controller';
import { platformSessionEnded } from './platform-session-end';
import type { TokenService } from './token.service';
import type { TurnstileService } from './turnstile.service';

// A6: POST /auth/admin/refresh cleared the admin cookies on any failure, so a
// database fault signed the administrator out of a sign-in that was still
// live. Only a refusal of the presented refresh token clears them now.

const ORIGIN = 'http://localhost:5173';
const ADMIN_COOKIES = ['hid_access_admin', 'hid_access_admin_csrf', 'hid_access_admin_refresh'];

function harness() {
  const tokens = { verifyRefreshCsrf: jest.fn().mockReturnValue(true), refresh: jest.fn() };
  const controller = new PlatformAuthController({} as MfaService, tokens as unknown as TokenService,
    {} as AuthSessionAuditService, {} as TurnstileService);
  return { controller, tokens };
}

function request(cookies: Record<string, string>): HidRequest {
  const headers: Record<string, string> = { origin: ORIGIN, 'x-csrf-token': 'csrf-admin' };
  return { correlationId: 'platform-refresh-cookies-test', ip: '127.0.0.1', cookies,
    header: (name: string) => headers[name.toLowerCase()] } as unknown as HidRequest;
}

const signedIn = () => request({ hid_access_admin_refresh: 'refresh-admin', hid_access_admin_csrf: 'csrf-admin' });

function response() {
  return { cookie: jest.fn(), clearCookie: jest.fn(), setHeader: jest.fn() };
}

const cleared = (res: ReturnType<typeof response>) => res.clearCookie.mock.calls.map(([name]) => name).sort();

describe('POST /auth/admin/refresh cookies on failure (A6)', () => {
  useTestEnvironment();

  it.each([
    ['a database error', Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })],
    ['a 503', new ServiceUnavailableException('Audit persistence is unavailable; request was denied')],
  ])('keeps the platform cookies when the refresh fails with %s', async (_label, fault) => {
    const { controller, tokens } = harness();
    tokens.refresh.mockRejectedValueOnce(fault);
    const res = response();
    await expect(controller.refresh(signedIn(), res as unknown as Response)).rejects.toBe(fault);
    // Platform refresh passes no rotation hook: it writes no success audit.
    expect(tokens.refresh).toHaveBeenCalledWith('refresh-admin', expect.anything(), 'platform');
    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it.each([
    ['PLATFORM_SESSION_EXPIRED', platformSessionEnded('expired')],
    ['PLATFORM_SESSION_REVOKED', platformSessionEnded('revoked')],
    ['an invalid refresh session', new UnauthorizedException('Invalid refresh session')],
  ])('still clears the three admin cookies when the presented token is refused (%s)', async (_label, refused) => {
    const { controller, tokens } = harness();
    tokens.refresh.mockRejectedValueOnce(refused);
    const res = response();
    await expect(controller.refresh(signedIn(), res as unknown as Response)).rejects.toBe(refused);
    expect(cleared(res)).toEqual(ADMIN_COOKIES);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('answers 401 AUTHENTICATION_REQUIRED without a refresh cookie, touching no cookie', async () => {
    const { controller, tokens } = harness();
    const res = response();
    const error = await controller.refresh(request({}), res as unknown as Response)
      .then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(DomainProblem);
    expect([(error as DomainProblem).getStatus(), (error as DomainProblem).code]).toEqual([401, 'AUTHENTICATION_REQUIRED']);
    expect(tokens.refresh).not.toHaveBeenCalled();
    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });
});
