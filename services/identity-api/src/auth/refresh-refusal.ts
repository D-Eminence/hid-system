import { HttpException } from '@nestjs/common';

/**
 * True when a refresh failed because its refresh token was definitively
 * refused (a 4xx answer: an unknown, ended, reused or expired token, a staff
 * sign-in without MFA assurance, an actor that no longer resolves). Only then
 * are the session cookies cleared. A 5xx or any other error is a fault: the
 * rotation either rolled back or never started, so the cookies the browser
 * holds still refresh and are kept, and the client may retry (A6).
 */
export function refreshRefused(error: unknown): boolean {
  return error instanceof HttpException && error.getStatus() < 500;
}
