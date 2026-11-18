import type { PoolClient } from 'pg';

/**
 * A matchRef (0132): what a staff patient search hands out on each card
 * instead of a Health ID or a patient id. It is a random server-side token
 * ('psr_' and 43 characters); the database keeps only its SHA-256, bound to
 * the patient, the member's account, membership and facility and the purpose
 * (direct-care, or emergency for an emergency search), for 10 minutes. No key
 * or setting is involved.
 *
 * Other packages (break-glass by matchRef, check-in) import this and do not
 * change it.
 */
export const MATCH_REF_PATTERN = /^psr_[A-Za-z0-9_-]{43}$/;
export const MATCH_REF_MINUTES = 10;

export type MatchRefPurpose = 'direct-care' | 'emergency';

/**
 * The patient id behind a matchRef that this account, membership and
 * facility made for this purpose (which must be the transaction's purpose)
 * in the last 10 minutes, while the patient is active and the facility's
 * seal allows it; null for anything else. Runs in the caller's
 * DatabaseService transaction (its session context); reads only, so the
 * caller audits what it does with the patient.
 */
export async function resolvePatientMatchRef(client: PoolClient, matchRef: string,
  purpose: MatchRefPurpose): Promise<string | null> {
  if (!MATCH_REF_PATTERN.test(matchRef)) return null;
  const result = await client.query<{ patient_id: string | null }>(
    'select identity.resolve_patient_search_ref($1, $2)::text as patient_id', [matchRef, purpose]);
  return result.rows[0]?.patient_id ?? null;
}
