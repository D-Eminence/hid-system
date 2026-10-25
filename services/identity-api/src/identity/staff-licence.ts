/**
 * Facility staff vocabulary (P4b, SPEC 3.6 and 4.2). These tables mirror the
 * database's own (0086 §5: identity.staff_invitable_roles,
 * identity.staff_role_licence_body, identity.self_service_reviewable_roles,
 * identity.self_service_administrator_role, identity.normalize_licence_number).
 * The database is authoritative and re-checks every command; Identity uses
 * these only to refuse a malformed request early with 400 and to describe the
 * choices to the browser.
 */

export const STAFF_ROLES = ['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist'] as const;
export type StaffRole = typeof STAFF_ROLES[number];

export const LICENCE_BODIES = ['MDCN', 'NMCN', 'MLSCN', 'PCN'] as const;
export type LicenceBody = typeof LICENCE_BODIES[number];

/** The administrator's clinical role support may grant at review (S1, Q2, Q3); 'none' manages only. */
export const ADMINISTRATOR_GRANTABLE_ROLES = ['none', 'doctor', 'nurse', 'lab', 'pharmacist'] as const;
export type AdministratorGrantableRole = typeof ADMINISTRATOR_GRANTABLE_ROLES[number];

/** How support checked the administrator at review (SPEC 3.5). */
export const VERIFICATION_METHODS = [
  'cac_registered_contact', 'officer_match', 'regulator_register', 'in_person', 'other',
] as const;
export type VerificationMethod = typeof VERIFICATION_METHODS[number];

export const ORGANIZATION_TYPES = ['clinic', 'hospital', 'laboratory', 'pharmacy', 'other'] as const;
export type OrganizationType = typeof ORGANIZATION_TYPES[number];

const LICENCE_BODY_BY_ROLE: Readonly<Record<StaffRole, LicenceBody | null>> = Object.freeze({
  doctor: 'MDCN',
  nurse: 'NMCN',
  lab: 'MLSCN',
  pharmacist: 'PCN',
  receptionist: null,
});

/** The role's labels: the title the page shows and the lower-case word the email uses. */
export const STAFF_ROLE_LABELS: Readonly<Record<StaffRole, { title: string; lower: string }>> = Object.freeze({
  doctor: { title: 'Doctor', lower: 'doctor' },
  nurse: { title: 'Nurse', lower: 'nurse' },
  lab: { title: 'Laboratory scientist', lower: 'laboratory scientist' },
  pharmacist: { title: 'Pharmacist', lower: 'pharmacist' },
  receptionist: { title: 'Receptionist', lower: 'receptionist' },
});

/** The licence body a role needs, or null (receptionist: no licence). */
export function staffRoleLicenceBody(role: string): LicenceBody | null {
  return (STAFF_ROLES as readonly string[]).includes(role) ? LICENCE_BODY_BY_ROLE[role as StaffRole] : null;
}

type Family = 'clinical' | 'laboratory' | 'pharmacy';

/** hospital and clinic: clinical; laboratory and pharmacy by type; 'other' by product. */
function family(organizationType: string, productCode: string): Family | null {
  if (organizationType === 'hospital' || organizationType === 'clinic') return 'clinical';
  if (organizationType === 'laboratory') return 'laboratory';
  if (organizationType === 'pharmacy') return 'pharmacy';
  if (organizationType !== 'other') return null;
  if (productCode === 'ehr' || productCode === 'migrate') return 'clinical';
  if (productCode === 'laboratory') return 'laboratory';
  if (productCode === 'pharmacy') return 'pharmacy';
  return null;
}

/** The roles a reviewed self-signed-up facility may invite (S9, Q5; SPEC 4.2). */
export function staffInvitableRoles(organizationType: string, productCode: string): StaffRole[] {
  switch (family(organizationType, productCode)) {
    case 'clinical': return ['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist'];
    case 'laboratory': return ['lab', 'receptionist'];
    case 'pharmacy': return ['pharmacist', 'receptionist'];
    default: return [];
  }
}

/** The administrator's clinical roles support may choose at review, besides 'none' (SPEC 3.6). */
export function selfServiceReviewableRoles(organizationType: string, productCode: string): StaffRole[] {
  switch (family(organizationType, productCode)) {
    case 'clinical': return ['doctor', 'nurse'];
    case 'laboratory': return ['lab'];
    case 'pharmacy': return ['pharmacist'];
    default: return [];
  }
}

/** The role preselected at review: none for 'other' (Q3). */
export function selfServiceAdministratorRole(organizationType: string, productCode: string): StaffRole | null {
  if (organizationType === 'other') return null;
  return selfServiceReviewableRoles(organizationType, productCode)[0] ?? null;
}

/** A licence number as stored: upper case, whitespace runs collapsed to one space, trimmed (SPEC 4.2). */
export function normalizeLicenceNumber(value: string): string {
  return value.toUpperCase().replace(/\s+/g, ' ').trim();
}

/** A normalized licence number the database accepts: 3-100 characters of A-Z, 0-9, '/', '.', '-' and single spaces. */
export const LICENCE_NUMBER = /^[A-Z0-9][A-Z0-9/. -]{1,98}[A-Z0-9]$/;

export function licenceNumberAcceptable(normalized: string): boolean {
  return LICENCE_NUMBER.test(normalized) && !normalized.includes('  ');
}
