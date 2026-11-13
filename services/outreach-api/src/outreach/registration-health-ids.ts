import type { PoolClient } from 'pg';

/**
 * The Health IDs created at the outreach (0119) for these registrations, read
 * in the caller's transaction through identity.outreach_registration_health_ids_for
 * (granted to the Outreach runtime), which answers only registrations this
 * session can see, at most 500. A read only: Outreach never writes Identity.
 */
export async function registrationHealthIds(client: PoolClient, caseIds: readonly string[]): Promise<Map<string, string>> {
  if (caseIds.length === 0) return new Map();
  const result = await client.query<{ registration_case_id: string; hid_code: string }>(
    'select registration_case_id,hid_code from identity.outreach_registration_health_ids_for($1::uuid[])', [caseIds]);
  return new Map(result.rows.map((row) => [row.registration_case_id, row.hid_code]));
}
