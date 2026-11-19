import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';

/**
 * FR-1 (owner decision of 18 Nov 2026): no typed reason is needed to sign a
 * draft note for the first time or to activate a draft prescription for the
 * first time. The server then records one of these fixed, recognisable
 * reasons in ehr.record_versions.change_reason (who and when are recorded
 * there as before). A reason is still needed for everything else: amending,
 * holding, resuming, stopping or entering in error, and any change to
 * something already signed or active.
 *
 * Q105 (owner decision of 18 Nov 2026, owner question 6 answered yes) adds,
 * with the same fixed-reason rule and the same fail-closed "first" check:
 * - the first activation of a draft lab request (which sends it to Lab);
 * - starting a planned visit (planned to in progress) and finishing a visit
 *   (in progress to completed);
 * - editing a draft note (its title or text), a draft prescription or a draft
 *   lab request that was never signed or active.
 * Holds, resumes, cancels, entered in error, and every change after signing
 * or activation still need a typed reason.
 */
export const FIRST_SIGNATURE_REASON = 'First signature (no reason needed)';
export const FIRST_ACTIVATION_REASON = 'First activation (no reason needed)';
export const DRAFT_EDIT_REASON = 'Draft edit (no reason needed)';
export const VISIT_START_REASON = 'Visit started (no reason needed)';
export const VISIT_FINISH_REASON = 'Visit finished (no reason needed)';

export const CHANGE_REASON_REQUIRED_CODE = 'CHANGE_REASON_REQUIRED';
export const CHANGE_REASON_REQUIRED_MESSAGE = 'Please say why you are changing this.';

export type FixedReasonKind = 'first_signature' | 'first_activation' | 'draft_edit' | 'visit_start' | 'visit_finish';

const FIXED_REASONS: Readonly<Record<FixedReasonKind, string>> = {
  first_signature: FIRST_SIGNATURE_REASON,
  first_activation: FIRST_ACTIVATION_REASON,
  draft_edit: DRAFT_EDIT_REASON,
  visit_start: VISIT_START_REASON,
  visit_finish: VISIT_FINISH_REASON,
};

/** True when a typed reason was given (a non-blank string). */
export function hasTypedReason(reason: string | undefined): boolean {
  return reason !== undefined && reason.trim().length > 0;
}

export function changeReasonRequired(): DomainProblem {
  return new DomainProblem(400, CHANGE_REASON_REQUIRED_CODE, CHANGE_REASON_REQUIRED_MESSAGE);
}

/** The typed reason, or the 400 CHANGE_REASON_REQUIRED answer when there is none. */
export function requireChangeReason(reason: string | undefined): string {
  if (reason === undefined || reason.trim().length === 0) throw changeReasonRequired();
  return reason;
}

/**
 * Whether the record has never reached any of `statuses` (and was never
 * signed) in its version history. "First" is decided here, not only from the
 * current row: a resume after a hold, or anything that was ever signed or
 * active, is not first.
 *
 * Fails closed: if the record's create version cannot be seen (row-level
 * security hides it, or the history is missing), the answer is false and a
 * typed reason is needed.
 */
export async function neverReachedBefore(
  client: PoolClient,
  resourceType: 'clinical_notes' | 'prescriptions' | 'lab_requests' | 'encounters',
  resourceId: string,
  statuses: readonly string[],
): Promise<boolean> {
  const result = await client.query<{ createdSeen: number; reached: number }>(
    `select count(*) filter (where version_no = 1 and operation = 'create')::int as "createdSeen",
            count(*) filter (where resulting_state->>'status' = any($3::text[])
                               or resulting_state->>'signed_at' is not null)::int as "reached"
     from ehr.record_versions
     where resource_type = $1 and resource_id = $2`,
    [resourceType, resourceId, statuses],
  );
  const row = result.rows[0];
  return Boolean(row && Number(row.createdSeen) === 1 && Number(row.reached) === 0);
}

/**
 * The reason to record for an update: the typed one when it was given;
 * otherwise the fixed reason when `fixed` names one that applies; otherwise
 * 400 CHANGE_REASON_REQUIRED. When the fixed reason is used, the audit details
 * say so (`fixedReason`); a typed reason leaves the audit details as before
 * (never the typed text).
 */
export function resolveChangeReason(
  typed: string | undefined,
  fixed: FixedReasonKind | undefined,
): { reason: string; details: { fixedReason?: FixedReasonKind } } {
  if (hasTypedReason(typed)) return { reason: typed as string, details: {} };
  if (fixed) return { reason: FIXED_REASONS[fixed], details: { fixedReason: fixed } };
  throw changeReasonRequired();
}
