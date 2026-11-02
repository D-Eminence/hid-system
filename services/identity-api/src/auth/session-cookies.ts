import type { Response } from 'express';
import type { Environment } from '../config/environment';
import { clearEnrollmentCookie } from '../identity/enrollment-cookie';
import type { LoginResult } from './auth.types';

type CookieEnvironment = Pick<Environment, 'AUTH_COOKIE_NAME' | 'AUTH_COOKIE_SECURE'>;

/**
 * The staff and patient session cookies (INTERFACE_CONTRACT.md, "Auth session
 * contract"): host-only (no Domain is ever passed, and production refuses
 * AUTH_COOKIE_DOMAIN, ADR-033), SameSite=Strict, Secure as configured. Moved
 * unchanged out of AuthController so a product's single sign-on callback
 * (ADR-070) sets exactly the cookies a sign-in sets.
 *
 * Sets the session cookies of a sign-in or refresh, and expires the public
 * patient enrollment cookie: once a sign-in exists on this device, its HID
 * comes from the session, not from whichever enrollment the device last made.
 */
export function setSessionCookies(response: Response, result: LoginResult, environment: CookieEnvironment): void {
  const common = {
    secure: environment.AUTH_COOKIE_SECURE,
    sameSite: 'strict' as const,
  };
  response.cookie(environment.AUTH_COOKIE_NAME, result.accessToken, {
    ...common, httpOnly: true, path: '/', expires: result.expiresAt,
  });
  response.cookie(`${environment.AUTH_COOKIE_NAME}_refresh`, result.refreshToken, {
    ...common, httpOnly: true, path: '/api/v1/auth', expires: result.refreshExpiresAt,
  });
  response.cookie(`${environment.AUTH_COOKIE_NAME}_csrf`, result.csrfToken, {
    ...common, httpOnly: false, path: '/', expires: result.refreshExpiresAt,
  });
  clearEnrollmentCookie(response, environment.AUTH_COOKIE_SECURE);
}

/** Clears the session cookies and the public patient enrollment cookie. */
export function clearSessionCookies(response: Response, environment: CookieEnvironment): void {
  const common = {
    secure: environment.AUTH_COOKIE_SECURE,
    sameSite: 'strict' as const,
  };
  response.clearCookie(environment.AUTH_COOKIE_NAME, { ...common, httpOnly: true, path: '/' });
  response.clearCookie(`${environment.AUTH_COOKIE_NAME}_refresh`, { ...common, httpOnly: true, path: '/api/v1/auth' });
  response.clearCookie(`${environment.AUTH_COOKIE_NAME}_csrf`, { ...common, httpOnly: false, path: '/' });
  clearEnrollmentCookie(response, environment.AUTH_COOKIE_SECURE);
}
