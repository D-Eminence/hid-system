import type { Response } from 'express';
import type { Environment } from '../config/environment';
import type { LoginResult } from './auth.types';

/**
 * The three session cookies of a password sign-in: the HttpOnly access cookie
 * (path '/'), the HttpOnly refresh cookie (path '/api/v1/auth') and the CSRF
 * cookie the browser reads (path '/'), all SameSite=Strict and host-only.
 * Shared by POST /auth/login and the facility self sign-up activation, so the
 * two cannot drift.
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
