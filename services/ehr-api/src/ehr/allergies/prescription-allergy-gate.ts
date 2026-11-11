import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import type { AllergyMatch } from './allergy-match';
import { checkMedicineAgainstAllergies, lockPatientAllergies, patientReportedTerm, warningToken } from './allergy-reader';
import { type AllergyAcknowledgementDto, isValidAcknowledgementReason, WARNING_TOKEN } from './allergies.dto';

/** When the prescriber gave the reason: at create, on Activate (draft), on Resume (on hold) or on sending a draft elsewhere. */
export type AllergyAcknowledgementStage = 'create' | 'activate' | 'resume' | 'send';

/**
 * What failed in the acknowledgement, as one `errors[]` entry each
 * (`field: allergyAcknowledgement.rejected`, `code`, a plain-English message):
 * - ALLERGY_ACKNOWLEDGEMENT_MISSING: none was sent (the first warning);
 * - ALLERGY_ACKNOWLEDGEMENT_REASON_MISSING: no reason, or only spaces;
 * - ALLERGY_ACKNOWLEDGEMENT_REASON_INVALID: under 10 or over 500 characters
 *   after trimming, no word of three letters, or a control character;
 * - ALLERGY_WARNING_TOKEN_INVALID: no warningToken, or not 64 lower-case hex;
 * - ALLERGY_WARNING_TOKEN_STALE: a well-formed token of another warning (an
 *   allergy recorded meanwhile, another medicine, the patient's text changed).
 * A reason and a token can both fail: two entries.
 */
export type AllergyAcknowledgementFailure =
  | 'ALLERGY_ACKNOWLEDGEMENT_MISSING'
  | 'ALLERGY_ACKNOWLEDGEMENT_REASON_MISSING'
  | 'ALLERGY_ACKNOWLEDGEMENT_REASON_INVALID'
  | 'ALLERGY_WARNING_TOKEN_INVALID'
  | 'ALLERGY_WARNING_TOKEN_STALE';

export const ALLERGY_ACKNOWLEDGEMENT_REJECTED_FIELD = 'allergyAcknowledgement.rejected';

const FAILURE_MESSAGES: Readonly<Record<AllergyAcknowledgementFailure, string>> = {
  ALLERGY_ACKNOWLEDGEMENT_MISSING: 'Check the allergies and give a reason to go ahead.',
  ALLERGY_ACKNOWLEDGEMENT_REASON_MISSING: 'Give a reason to go ahead with this medicine.',
  ALLERGY_ACKNOWLEDGEMENT_REASON_INVALID:
    'The reason must be 10 to 500 characters, with at least one word, and no control characters other than new lines.',
  ALLERGY_WARNING_TOKEN_INVALID: 'The allergy warning was not identified. Check the allergies again.',
  ALLERGY_WARNING_TOKEN_STALE:
    'The allergy warning changed since it was shown. Check the allergies again and give a reason to go ahead.',
};

/** Which parts of the acknowledgement fail for the current warning (empty: it is accepted). */
export function acknowledgementFailures(
  acknowledgement: AllergyAcknowledgementDto | undefined, currentToken: string,
): AllergyAcknowledgementFailure[] {
  if (!acknowledgement) return ['ALLERGY_ACKNOWLEDGEMENT_MISSING'];
  const failures: AllergyAcknowledgementFailure[] = [];
  const reason = typeof acknowledgement.reason === 'string' ? acknowledgement.reason.trim() : '';
  if (reason.length === 0) failures.push('ALLERGY_ACKNOWLEDGEMENT_REASON_MISSING');
  else if (!isValidAcknowledgementReason(reason)) failures.push('ALLERGY_ACKNOWLEDGEMENT_REASON_INVALID');
  const token = acknowledgement.warningToken;
  if (typeof token !== 'string' || !WARNING_TOKEN.test(token)) failures.push('ALLERGY_WARNING_TOKEN_INVALID');
  else if (token !== currentToken) failures.push('ALLERGY_WARNING_TOKEN_STALE');
  return failures;
}

/**
 * The 409 that asks for (or again for) the prescriber's reason, with every
 * current warning, its token, and one entry per part of the acknowledgement
 * that failed (`failures`; ALLERGY_ACKNOWLEDGEMENT_MISSING when none is given).
 */
export function allergyAcknowledgementRequired(
  matches: readonly AllergyMatch[], medicine: { display: string; code?: string | null },
  failures: readonly AllergyAcknowledgementFailure[] = ['ALLERGY_ACKNOWLEDGEMENT_MISSING'],
): DomainProblem {
  const stale = failures.includes('ALLERGY_WARNING_TOKEN_STALE');
  const onlyMissing = failures.length === 1 && failures[0] === 'ALLERGY_ACKNOWLEDGEMENT_MISSING';
  return new DomainProblem(409, 'ALLERGY_ACKNOWLEDGEMENT_REQUIRED',
    stale
      ? FAILURE_MESSAGES.ALLERGY_WARNING_TOKEN_STALE
      : onlyMissing
        ? 'This medicine may match an allergy on the patient\'s record. Check the allergies and give a reason to go ahead.'
        : 'The reason to go ahead after the allergy warning was not accepted. Check the allergies and give a reason to go ahead.',
    [
      ...matches.map((match) => ({ field: 'allergyAcknowledgement', messages: [match.message] })),
      { field: 'allergyAcknowledgement.warningToken', messages: [warningToken(matches, medicine)] },
      ...failures.map((code) => ({ field: ALLERGY_ACKNOWLEDGEMENT_REJECTED_FIELD, code, messages: [FAILURE_MESSAGES[code]] })),
    ]);
}

/**
 * The allergy check before a prescription is written as, or becomes, active
 * (0124). Answers the matches the prescriber's reason covers (empty: nothing
 * to record). A match already covered by a reason stored for this
 * prescription (`prescriptionId`, on Activate, Resume or send) needs none.
 * Otherwise the request must carry an acknowledgement with a valid reason
 * whose warningToken is the one of the current warning; if not, 409 with the
 * current warning and what failed. With no match, an acknowledgement is
 * ignored, whatever it holds.
 */
export async function checkPrescriptionAllergies(
  client: PoolClient,
  context: DataAccessContext,
  patientId: string,
  medicine: { display: string; code?: string | null },
  acknowledgement: AllergyAcknowledgementDto | undefined,
  prescriptionId?: string,
): Promise<AllergyMatch[]> {
  // Serialized with recording an allergy for this patient, in the transaction that writes the prescription.
  await lockPatientAllergies(client, patientId);
  const matches = await checkMedicineAgainstAllergies(client, patientId, context.facilityId, medicine);
  if (matches.length === 0) return [];
  if (prescriptionId && await allCovered(client, context, patientId, prescriptionId, matches)) return [];
  const failures = acknowledgementFailures(acknowledgement, warningToken(matches, medicine));
  if (failures.length > 0) throw allergyAcknowledgementRequired(matches, medicine, failures);
  return matches;
}

async function allCovered(
  client: PoolClient, context: DataAccessContext, patientId: string, prescriptionId: string, matches: readonly AllergyMatch[],
): Promise<boolean> {
  const stored = await client.query<{ matchedRecordedAllergyIds: string[] | null; patientReportedTerms: string[] | null }>(
    `select matched_recorded_allergy_ids as "matchedRecordedAllergyIds", patient_reported_terms as "patientReportedTerms"
       from ehr.prescription_allergy_acknowledgements
      where prescription_id = $1 and patient_id = $2 and facility_id = $3`,
    [prescriptionId, patientId, context.facilityId],
  );
  const acknowledged = new Set(stored.rows.flatMap((row) => row.matchedRecordedAllergyIds ?? []));
  // Each of the patient's own terms must have been acknowledged itself: a term added since is new.
  const terms = new Set(stored.rows.flatMap((row) => row.patientReportedTerms ?? []));
  return matches.every((match) => match.source === 'patient_reported'
    ? terms.has(patientReportedTerm(match))
    : (match.allergyIds ?? (match.allergyId ? [match.allergyId] : [])).every((id) => acknowledged.has(id)));
}

/**
 * Stores the reason with the allergies it covers (append-only), in the
 * caller's transaction. Answers the audit details: flags and counts only,
 * never the substance or the reason text.
 */
export async function recordAllergyAcknowledgement(
  client: PoolClient,
  context: DataAccessContext,
  patientId: string,
  prescriptionId: string,
  stage: AllergyAcknowledgementStage,
  matches: readonly AllergyMatch[],
  acknowledgement: AllergyAcknowledgementDto,
): Promise<{ allergyOverride: true; matchedRecordedCount: number; patientReportedMatched: boolean }> {
  // checkPrescriptionAllergies accepted it; checked again so nothing else is ever stored.
  const reason = acknowledgement.reason?.trim() ?? '';
  if (!isValidAcknowledgementReason(reason)) {
    throw new Error('An allergy acknowledgement reason reached storage unchecked');
  }
  const matchedRecordedAllergyIds = [...new Set(matches.flatMap((match) =>
    match.allergyIds ?? (match.allergyId ? [match.allergyId] : [])))];
  const patientReportedTerms = [...new Set(matches.flatMap((match) =>
    match.source === 'patient_reported' ? [patientReportedTerm(match)] : []))];
  const patientReportedMatched = patientReportedTerms.length > 0;
  await client.query(
    `insert into ehr.prescription_allergy_acknowledgements (
       prescription_id, patient_id, facility_id, created_by, created_by_membership_id,
       reason, matched_recorded_allergy_ids, patient_reported_matched, stage, patient_reported_terms
     ) values ($1, $2, $3, $4, $5, $6, $7::uuid[], $8, $9, $10::text[])`,
    [prescriptionId, patientId, context.facilityId, context.actor.accountId, context.membershipId,
      reason, matchedRecordedAllergyIds, patientReportedMatched, stage, patientReportedTerms],
  );
  return { allergyOverride: true, matchedRecordedCount: matchedRecordedAllergyIds.length, patientReportedMatched };
}

/**
 * A stored acknowledgement as the prescription reads answer it (0124): when
 * (`stage`, `createdAt`), who (`createdBy` account, `createdByMembershipId`),
 * the reason, and what it covered (the recorded allergy ids, whether the
 * patient's own text matched and which of its terms). Oldest first.
 */
export interface PrescriptionAllergyAcknowledgement {
  id: string;
  stage: AllergyAcknowledgementStage;
  reason: string;
  createdBy: string;
  createdByMembershipId: string;
  createdAt: Date;
  matchedRecordedAllergyIds: string[];
  patientReportedMatched: boolean;
  patientReportedTerms: string[];
}

/**
 * The acknowledgements stored for these prescriptions, by prescription id,
 * in the caller's transaction (RLS: read access at their own facility).
 */
export async function readAllergyAcknowledgements(
  client: PoolClient, context: DataAccessContext, patientId: string, prescriptionIds: readonly string[],
): Promise<Map<string, PrescriptionAllergyAcknowledgement[]>> {
  const byPrescription = new Map<string, PrescriptionAllergyAcknowledgement[]>();
  if (prescriptionIds.length === 0) return byPrescription;
  const result = await client.query<PrescriptionAllergyAcknowledgement & { prescriptionId: string }>(
    `select id, prescription_id as "prescriptionId", stage, reason, created_by as "createdBy",
            created_by_membership_id as "createdByMembershipId", created_at as "createdAt",
            matched_recorded_allergy_ids as "matchedRecordedAllergyIds",
            patient_reported_matched as "patientReportedMatched", patient_reported_terms as "patientReportedTerms"
       from ehr.prescription_allergy_acknowledgements
      where prescription_id = any($1::uuid[]) and patient_id = $2 and facility_id = $3
      order by created_at, id`,
    [prescriptionIds, patientId, context.facilityId],
  );
  for (const { prescriptionId, ...row } of result.rows) {
    const list = byPrescription.get(prescriptionId) ?? [];
    list.push(row);
    byPrescription.set(prescriptionId, list);
  }
  return byPrescription;
}
