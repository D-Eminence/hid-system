import type { Response } from 'express';

/**
 * The public patient enrollment capability (`PatientEnrollmentController`):
 * host-only, HttpOnly, SameSite=Strict and scoped to the enrollment routes.
 * For 15 minutes after activation it also lets `GET /current` and an
 * activation replay show the enrollment's HID (a lost activation response).
 * Every successful activation response expires it, and so does every staff or
 * patient sign-in, refresh and sign-out (`clearEnrollmentCookie`): a
 * signed-in patient reads the HID from the session, and the enrollment routes
 * refuse while session cookies exist.
 */
export const ENROLLMENT_COOKIE_NAME = 'hid_enrollment';
export const ENROLLMENT_COOKIE_PATH = '/api/v1/identity/patient-enrollments';
const ENROLLMENT_COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function enrollmentCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: 'strict' as const, secure,
    path: ENROLLMENT_COOKIE_PATH, maxAge: ENROLLMENT_COOKIE_MAX_AGE_MS };
}

/** Expires the enrollment cookie on the path it was set on (Express ignores maxAge here). */
export function clearEnrollmentCookie(response: Response, secure: boolean): void {
  response.clearCookie(ENROLLMENT_COOKIE_NAME, { secure, sameSite: 'strict', httpOnly: true,
    path: ENROLLMENT_COOKIE_PATH });
}
