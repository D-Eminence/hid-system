import type { Response } from 'express';

/**
 * The clinician application capability (ADR-066): host-only, HttpOnly,
 * SameSite=Strict and scoped to the clinician application routes. It is never
 * a session: it opens no route outside /identity/clinician-applications, and
 * the 0088 challenge it drives is derived on the server and never set as a
 * cookie. Its value is a 43-character token; the database holds only its
 * keyed digest. A draft (after the sign-up email code) lives 60 minutes, an
 * account capability (after submitting, or the status code) 30 minutes, as
 * the database records them.
 */
export const CLINICIAN_APPLICATION_COOKIE_NAME = 'hid_clinician_application';
export const CLINICIAN_APPLICATION_COOKIE_PATH = '/api/v1/identity/clinician-applications';
const MAX_AGE_MS = { draft: 60 * 60 * 1000, account: 30 * 60 * 1000 } as const;

export type ClinicianApplicationCapabilityKind = keyof typeof MAX_AGE_MS;

export function clinicianApplicationCookieOptions(secure: boolean, kind: ClinicianApplicationCapabilityKind) {
  return { httpOnly: true, sameSite: 'strict' as const, secure,
    path: CLINICIAN_APPLICATION_COOKIE_PATH, maxAge: MAX_AGE_MS[kind] };
}

/** Expires the capability cookie on the path it was set on. */
export function clearClinicianApplicationCookie(response: Response, secure: boolean): void {
  response.clearCookie(CLINICIAN_APPLICATION_COOKIE_NAME, { secure, sameSite: 'strict', httpOnly: true,
    path: CLINICIAN_APPLICATION_COOKIE_PATH });
}
