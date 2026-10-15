import { DomainProblem } from './problem';
import type { HidRequest } from './request-context';

/**
 * Checks shared by the accountless public flows (provider self-enrollment,
 * clinician self sign-up, ADR-064). The security guard does not run on their
 * @Public routes, so each route makes them itself.
 */

/** A browser write must come from one of the CORS origins (CORS_ORIGINS). */
export function assertAllowedOrigin(request: HidRequest, allowedOrigins: ReadonlySet<string>): void {
  const origin = request.header('origin');
  if (!origin || !allowedOrigins.has(origin)) {
    throw new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
  }
}

/**
 * The request carries no HID session: no session or refresh cookie and no
 * Authorization header. A flow that creates an account refuses a signed-in
 * browser with its own 409 code.
 */
export function assertAccountless(request: HidRequest, authCookieName: string, refusal: { code: string; detail: string }): void {
  const authCookie = (request.header('cookie') ?? '').split(';').some((part) =>
    part.trim().startsWith(`${authCookieName}=`)
    || part.trim().startsWith(`${authCookieName}_refresh=`));
  if (authCookie || request.header('authorization')) {
    throw new DomainProblem(409, refusal.code, refusal.detail);
  }
}

/** The value of a cookie the request carries exactly once, or undefined. */
export function singleCookie(request: HidRequest, name: string): string | undefined {
  const values = (request.header('cookie') ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0]?.slice(name.length + 1) : undefined;
}
