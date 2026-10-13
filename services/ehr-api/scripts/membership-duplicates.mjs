// N5 (0087): one active, resolvable membership per account and facility.
//
// The legacy promotion copies hid-1.0 memberships one for one. It promotes a
// membership active and unheld when the source row is active, names a facility
// and is not a platform_admin membership (promote-legacy-identity.mjs holds
// the other two). Two such rows for one staff identity at one facility would
// violate staff_memberships_one_active_per_facility_uq, so the promotion
// refuses them before writing anything; operator plan I4 resolves them in the
// source with the facility's confirmation.

/** True when the promotion would make this staged membership an active, unheld binding. */
export function bindingMembership(source) {
  return source?.active === true && typeof source.facility_id === 'string' && source.facility_id.length > 0
    && source.app_role !== 'platform_admin';
}

/**
 * Groups of staged memberships that would bind one staff identity at one
 * facility more than once. A staff record belongs to exactly one account
 * (identity.staff.account_id is unique), so the staff id stands for the
 * account. Each group lists its source keys in order.
 */
export function duplicateFacilityMemberships(stagedRows) {
  const groups = new Map();
  for (const row of stagedRows) {
    const source = row.payload;
    if (!bindingMembership(source)) continue;
    const key = `${source.staff_account_id}\u0000${source.facility_id}`;
    const group = groups.get(key) ?? { staffId: source.staff_account_id, facilityId: source.facility_id, sourcePks: [] };
    group.sourcePks.push(row.source_pk);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.sourcePks.length > 1)
    .map((group) => ({ ...group, sourcePks: [...group.sourcePks].sort() }));
}
