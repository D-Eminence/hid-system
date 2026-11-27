/**
 * Facility staff vocabulary (P4b, SPEC 3.6 and 4.2). These tables mirror the
 * database's own (0086 §5: identity.staff_invitable_roles,
 * identity.staff_role_licence_body, identity.self_service_reviewable_roles,
 * identity.self_service_administrator_role, identity.normalize_licence_number).
 * The database is authoritative and re-checks every command; Identity uses
 * these only to refuse a malformed request early with 400 and to describe the
 * choices to the browser.
 */

// CHW-1 (0209, owner decision Q130 A): community_health_worker is a staff role with no licence, like the front desk,
// invitable at hospitals and clinics only (the database's list puts it last). While COMMUNITY_HEALTH_WORKER_ENABLED is
// off it is neither offered nor accepted for invitations and SX-4's add (staffRoleOffered).
export const STAFF_ROLES = ['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist', 'community_health_worker'] as const;
export type StaffRole = typeof STAFF_ROLES[number];

/** The community health worker (CHW-1, 0209): an Outreach-only role at hospitals and clinics. */
export const COMMUNITY_HEALTH_WORKER_ROLE = 'community_health_worker' as const;

/**
 * The roles 0086's single "Change role" (identity.change_facility_staff_role) offers: every staff role but the
 * community health worker, which 0209 leaves to SX-4's add and remove (the database refuses it there too).
 */
export const CHANGEABLE_STAFF_ROLES = STAFF_ROLES.filter((role) => role !== COMMUNITY_HEALTH_WORKER_ROLE);

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
  community_health_worker: null,
});

/** The role's labels: the title the page shows and the lower-case word the email uses. */
export const STAFF_ROLE_LABELS: Readonly<Record<StaffRole, { title: string; lower: string }>> = Object.freeze({
  doctor: { title: 'Doctor', lower: 'doctor' },
  nurse: { title: 'Nurse', lower: 'nurse' },
  lab: { title: 'Laboratory scientist', lower: 'laboratory scientist' },
  pharmacist: { title: 'Pharmacist', lower: 'pharmacist' },
  receptionist: { title: 'Receptionist', lower: 'receptionist' },
  community_health_worker: { title: 'Community health worker', lower: 'community health worker' },
});

/**
 * The two narrow roles of owner decision Q137 B (migration 0147): given only to the administrators and the doctor
 * that 0136's count named, beside their own role, so they read the laboratory's and the pharmacy's work lists again
 * and the doctor starts paper readings again. A staff profile names them (the Staff page and support's staff view
 * list every role a membership holds). They are not staff roles: never invited, never added or removed through SX-4
 * (not in STAFF_ROLES, so every invitation and role DTO refuses them, and so does the database), and they need no
 * licence. Neither ever becomes a membership's own role (membership_role, app_role): 0147 also replaces SX-4's change
 * so that SX-4 leaves them out of what it counts and chooses, and removing doctor revokes them too (work_list_reader
 * stays while the membership holds admin); see the contract's 0147 section. SX-4's answers still list them.
 */
export const NARROW_ROLES = ['work_list_reader', 'reading_starter'] as const;
export type NarrowRole = typeof NARROW_ROLES[number];

/** The narrow roles' labels, as STAFF_ROLE_LABELS: the title a staff profile shows and the lower-case words. */
export const NARROW_ROLE_LABELS: Readonly<Record<NarrowRole, { title: string; lower: string }>> = Object.freeze({
  work_list_reader: { title: 'Lab and pharmacy work lists', lower: 'lab and pharmacy work lists' },
  reading_starter: { title: 'Start a paper reading', lower: 'start a paper reading' },
});

/** The licence body a role needs, or null (receptionist and community health worker: no licence). */
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
    case 'clinical': return ['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist', 'community_health_worker'];
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

/**
 * CHW-1 (0209): whether a role may be offered and given now. Every role is, but the community health worker only while
 * COMMUNITY_HEALTH_WORKER_ENABLED is on: while it is off (the default) Identity leaves the role out of the Staff page's
 * inviteOptions.roles and refuses an invitation or an SX-4 add naming it with 400 STAFF_INVITATION_ROLE_NOT_ALLOWED,
 * so the role stays hidden even after 0209 applies (the planned contract: "Before this ships, do not show the role
 * anywhere"). Removing the role is always allowed.
 */
export function staffRoleOffered(role: string, switches: { communityHealthWorkerEnabled: boolean }): boolean {
  return role !== COMMUNITY_HEALTH_WORKER_ROLE || switches.communityHealthWorkerEnabled;
}
