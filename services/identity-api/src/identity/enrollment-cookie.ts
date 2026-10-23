/**
 * The public patient enrollment capability (`PatientEnrollmentController`):
 * host-only, HttpOnly, SameSite=Strict and scoped to the enrollment routes.
 * After activation it lets `GET /current` and an activation replay show the
 * enrollment's HID, for 15 minutes only (PatientEnrollmentService).
 */
export const ENROLLMENT_COOKIE_NAME = 'hid_enrollment';
export const ENROLLMENT_COOKIE_PATH = '/api/v1/identity/patient-enrollments';
const ENROLLMENT_COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function enrollmentCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: 'strict' as const, secure,
    path: ENROLLMENT_COOKIE_PATH, maxAge: ENROLLMENT_COOKIE_MAX_AGE_MS };
}
