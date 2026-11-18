/**
 * ID-0 (Akos wave 1, owner decision of 18 November 2026): every staff answer
 * about a patient says whether the patient's NIN was checked, as one of two
 * values. Screens show them as "NIN Verified" and "NIN Not Verified".
 *
 * No internal verification value is ever returned as it is stored: a patient
 * with no checked NIN, or whose checked NIN was revoked, is 'not_verified'.
 */
export type NinStatus = 'verified' | 'not_verified';

export const NIN_STATUSES: readonly NinStatus[] = ['verified', 'not_verified'];

const SQL_REFERENCE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/**
 * A SQL boolean: the patient holds a checked NIN that has not been revoked.
 * `patientId` is a column reference written by this code (for example
 * `patient_row.id`), never caller input. Other lanes (desk search cards)
 * import this so every answer uses one rule.
 */
export function patientHasVerifiedNinSql(patientId: string): string {
  if (!SQL_REFERENCE.test(patientId)) throw new Error('A column reference is required');
  return `exists (select 1 from identity.patient_identifiers nin_identifier
     where nin_identifier.patient_id = ${patientId}
       and nin_identifier.identifier_type = 'nin'
       and nin_identifier.verified
       and nin_identifier.revoked_at is null)`;
}

/** Only an explicit true is 'verified'; anything else (missing, null, false) is 'not_verified'. */
export function ninStatusOf(verified: unknown): NinStatus {
  return verified === true ? 'verified' : 'not_verified';
}
