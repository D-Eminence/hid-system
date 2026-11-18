/**
 * The keys of a staff patient search and how far they reach (0132; owner
 * decisions of 18 November 2026). This is the same rule
 * identity.staff_patient_search applies in the database; Identity checks it
 * first only to refuse a search that is too broad without asking the
 * database.
 *
 * Strong keys find any active patient:
 *   - first name + last name + date of birth;
 *   - Health ID + (last name or date of birth);
 *   - phone + last name.
 * Weak keys find only this facility's own patients (0131's basis):
 *   - last name + date of birth;
 *   - phone;
 *   - Health ID.
 * Anything else is too broad. Every key given must match.
 */
export type PatientSearchKeyKind = 'first_name' | 'last_name' | 'date_of_birth' | 'health_id' | 'phone';
export type PatientSearchReach = 'everywhere' | 'here';
export type PatientSearchMode = 'standard' | 'emergency';

export interface PatientSearchKeys {
  /** Lower case, trimmed, inner spaces collapsed, as the database compares it. */
  firstName?: string;
  lastName?: string;
  /** YYYY-MM-DD. */
  dateOfBirth?: string;
  /** Upper case HID-... */
  healthId?: string;
  /** E.164, as normalizePatientPhone answers it. */
  phone?: string;
}

/** A name as the database compares it, or undefined when nothing is left. */
export function normalizeSearchName(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().replace(/\s+/g, ' ').toLowerCase();
  return name ? name : undefined;
}

/** The kinds of keys given, in a fixed order (as the audit row lists them). */
export function patientSearchKeyKinds(keys: PatientSearchKeys): PatientSearchKeyKind[] {
  const kinds: PatientSearchKeyKind[] = [];
  if (keys.firstName) kinds.push('first_name');
  if (keys.lastName) kinds.push('last_name');
  if (keys.dateOfBirth) kinds.push('date_of_birth');
  if (keys.healthId) kinds.push('health_id');
  if (keys.phone) kinds.push('phone');
  return kinds;
}

/** How far a standard search with these keys reaches, or null when it is too broad. */
export function patientSearchReach(keys: PatientSearchKeys): PatientSearchReach | null {
  const { firstName, lastName, dateOfBirth, healthId, phone } = keys;
  if ((firstName && lastName && dateOfBirth) || (healthId && (lastName || dateOfBirth)) || (phone && lastName)) {
    return 'everywhere';
  }
  if ((lastName && dateOfBirth) || phone || healthId) return 'here';
  return null;
}
