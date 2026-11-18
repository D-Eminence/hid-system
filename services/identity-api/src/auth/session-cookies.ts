import type { Response } from 'express';
import type { Environment } from '../config/environment';
import type { LoginResult } from './auth.types';

/**
 * The three session cookies of a password sign-in: the HttpOnly access cookie
 * (path '/'), the HttpOnly refresh cookie (path '/api/v1/auth') and the CSRF
 * cookie the browser reads (path '/'), all SameSite=Strict and host-only.
 * Shared by POST /auth/login, the facility self sign-up activation and a
 * product's single sign-on callback (ADR-070), so they cannot drift.
 */
export function setSessionCookies(response: Response, result: LoginResult,
  environment: Pick<Environment, 'AUTH_COOKIE_NAME' | 'AUTH_COOKIE_SECURE'>): void {
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
}

/**
 * Clears the three session cookies, with the attributes they were set with.
 * Shared by sign-out, a refused refresh and single sign-on's session check
 * (SsoSessionEndFilter, ADR-070), so they cannot drift.
 */
export function clearSessionCookies(response: Response,
  environment: Pick<Environment, 'AUTH_COOKIE_NAME' | 'AUTH_COOKIE_SECURE'>): void {
  const common = {
    secure: environment.AUTH_COOKIE_SECURE,
    sameSite: 'strict' as const,
  };
  response.clearCookie(environment.AUTH_COOKIE_NAME, { ...common, httpOnly: true, path: '/' });
  response.clearCookie(`${environment.AUTH_COOKIE_NAME}_refresh`, { ...common, httpOnly: true, path: '/api/v1/auth' });
  response.clearCookie(`${environment.AUTH_COOKIE_NAME}_csrf`, { ...common, httpOnly: false, path: '/' });
}
