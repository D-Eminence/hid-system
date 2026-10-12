// The database repeats this list: identity.has_active_membership (0008) and the
// staff facility selection guard (0080). Change them together.
export const ACTIVE_STAFF_VERIFICATION_STATUSES = ['verified', 'approved', 'active'] as const;

const ACTIVE_STAFF_STATUS_SET = new Set<string>(ACTIVE_STAFF_VERIFICATION_STATUSES);

export function isActiveStaffVerificationStatus(value: string): boolean {
  return ACTIVE_STAFF_STATUS_SET.has(value.trim().toLowerCase());
}
