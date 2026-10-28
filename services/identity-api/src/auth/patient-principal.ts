import { normalizePatientPhone } from '../identity/contact-lookup';

/**
 * What a patient typed to sign in or to reset the password (owner decision of
 * 2026-10-28): an email address, a Health ID or a phone number, in the one
 * field the wire still calls `email` (sign-in) or `identifier` (recovery).
 * - email: anything with an "@", lowercased;
 * - hid: HID- and 6-32 Health ID characters, uppercased;
 * - phone: "+" and 7-15 digits (E.164, any country) or a Nigerian local
 *   number (0 and 10 digits, read as +234), after spaces, dots, dashes and
 *   brackets are removed; the value is the E.164 number;
 * - invalid: anything else (a phone that is not one); it matches no account,
 *   so it is answered exactly as an unknown email is.
 */
export type PatientPrincipal =
  | { kind: 'email'; value: string }
  | { kind: 'hid'; value: string }
  | { kind: 'phone'; value: string }
  | { kind: 'invalid'; value: string };

const HEALTH_ID = /^HID-[A-HJ-NP-Z2-9]{6,32}$/i;

/**
 * The shapes the sign-in and recovery DTOs accept: an email, a Health ID, or
 * a phone ("+" and 7-15 digits, or 0 and 10 digits, with spaces, dots,
 * dashes and brackets anywhere). The digit counts are checked again after
 * normalization; a number that passes here but not there is `invalid`.
 */
export const PATIENT_PRINCIPAL_PATTERN = new RegExp([
  '^(?:[^\\s@]+@[^\\s@]+\\.[^\\s@]+',
  '|HID-[A-HJ-NP-Z2-9]{6,32}',
  '|[\\s().-]*\\+[\\s().-]*[1-9](?:[\\s().-]*\\d){6,14}[\\s().-]*',
  '|[\\s().-]*0(?:[\\s().-]*\\d){10}[\\s().-]*)$',
].join(''), 'i');

export function patientPrincipal(raw: string): PatientPrincipal {
  const value = raw.trim();
  if (value.includes('@')) return { kind: 'email', value: value.toLowerCase() };
  if (HEALTH_ID.test(value)) return { kind: 'hid', value: value.toUpperCase() };
  const phone = normalizePatientPhone(value);
  return phone ? { kind: 'phone', value: phone } : { kind: 'invalid', value: value.toLowerCase() };
}

/**
 * The principal a sign-in's lockout (auth.login_attempts) is kept under. A
 * patient's phone is its E.164 number, so 0803... and +234803... share one
 * lockout; an email and a Health ID are lowercased as before, so existing
 * lockouts carry over. Staff sign in with an email only.
 */
export function loginPrincipalKey(raw: string, actorKind: 'staff' | 'patient'): string {
  if (actorKind !== 'patient') return raw.trim().toLowerCase();
  return patientPrincipal(raw).value.toLowerCase();
}
