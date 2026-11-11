import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import type { AllergyMatch } from './allergy-match';
import { checkMedicineAgainstAllergies, lockPatientAllergies, patientReportedTerm, warningToken } from './allergy-reader';
import type { AllergyAcknowledgementDto } from './allergies.dto';

/** When the prescriber gave the reason: at create, on Activate (draft), on Resume (on hold) or on sending a draft elsewhere. */
export type AllergyAcknowledgementStage = 'create' | 'activate' | 'resume' | 'send';

/** The 409 that asks for (or again for) the prescriber's reason, with every current warning and its token. */
export function allergyAcknowledgementRequired(
  matches: readonly AllergyMatch[], medicine: { display: string; code?: string | null }, changed = false,
): DomainProblem {
  return new DomainProblem(409, 'ALLERGY_ACKNOWLEDGEMENT_REQUIRED',
    changed
      ? 'The allergy warning changed since it was shown. Check the allergies again and give a reason to go ahead.'
      : 'This medicine may match an allergy on the patient\'s record. Check the allergies and give a reason to go ahead.',
    [
      ...matches.map((match) => ({ field: 'allergyAcknowledgement', messages: [match.message] })),
      { field: 'allergyAcknowledgement.warningToken', messages: [warningToken(matches, medicine)] },
    ]);
}

/**
 * The allergy check before a prescription is written as, or becomes, active
 * (0124). Answers the matches the prescriber's reason covers (empty: nothing
 * to record). A match already covered by a reason stored for this
 * prescription (`prescriptionId`, on Activate, Resume or send) needs none.
 * Otherwise the request must carry an acknowledgement whose warningToken is
 * the one of the current warning; if not, 409 with the current warning.
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
  if (!acknowledgement) throw allergyAcknowledgementRequired(matches, medicine);
  if (acknowledgement.warningToken !== warningToken(matches, medicine)) {
    throw allergyAcknowledgementRequired(matches, medicine, true);
  }
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
  reason: string,
): Promise<{ allergyOverride: true; matchedRecordedCount: number; patientReportedMatched: boolean }> {
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
