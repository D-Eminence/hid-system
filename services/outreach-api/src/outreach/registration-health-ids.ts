import type { PoolClient } from 'pg';

/** A Health ID created at the outreach for a registration, and how (0120). */
export interface RegistrationHealthId {
  healthId: string;
  /** 'verified': the person proved an email (0119); 'unclaimed': no contact, not claimed yet (0120). */
  status: 'verified' | 'unclaimed';
}

/**
 * The Health IDs created at the outreach (0119, 0120) for these registrations,
 * read in the caller's transaction through identity.outreach_registration_health_ids_for
 * (granted to the Outreach runtime), which answers only registrations this
 * session can see, at most 500. A read only: Outreach never writes Identity.
 */
export async function registrationHealthIds(client: PoolClient, caseIds: readonly string[])
  : Promise<Map<string, RegistrationHealthId>> {
  if (caseIds.length === 0) return new Map();
  const result = await client.query<{ registration_case_id: string; hid_code: string; created_via: string }>(
    'select registration_case_id,hid_code,created_via from identity.outreach_registration_health_ids_for($1::uuid[])',
    [caseIds]);
  return new Map(result.rows.map((row) => [row.registration_case_id,
    { healthId: row.hid_code, status: row.created_via === 'unclaimed' ? 'unclaimed' : 'verified' }]));
}
