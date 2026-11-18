import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';

export const VISIT_ENTERED_IN_ERROR_CODE = 'VISIT_ENTERED_IN_ERROR';
export const VISIT_ENTERED_IN_ERROR_MESSAGE =
  'This visit was marked as entered in error. Nothing new can be added to it or started on it.';

/**
 * EHR-C8a (review finding 1): nothing new is added to, or started on, a visit
 * entered in error. A new prescription, lab request or note, activating or
 * resuming an order, sending it to the pharmacy or laboratory, and signing a
 * note all call this first.
 *
 * The visit row is locked FOR SHARE until the transaction ends. Marking a
 * completed visit as entered in error locks it FOR UPDATE before it counts the
 * visit's orders and signed notes, so the two wait for each other: either the
 * order or note change commits first and the count sees it (409), or the visit
 * is entered in error first and this check sees that (409). FOR SHARE does not
 * conflict with the FOR KEY SHARE that foreign keys take, so two orders on the
 * same visit do not wait for each other.
 *
 * `lock: false` only reads the status, for a path that changes nothing in
 * the EHR (sending an active lab request to the laboratory again): a
 * completed visit cannot be entered in error while it has an active order.
 *
 * A visit that cannot be seen is left to the caller's own 404.
 */
export async function requireVisitOpenForWork(
  client: PoolClient,
  patientId: string,
  facilityId: string,
  encounterId: string,
  options: { lock: boolean } = { lock: true },
): Promise<void> {
  const result = await client.query<{ status: string }>(
    `select status from ehr.encounters
     where id = $1 and patient_id = $2 and facility_id = $3${options.lock ? ' for share' : ''}`,
    [encounterId, patientId, facilityId],
  );
  if (result.rows[0]?.status === 'entered_in_error') {
    throw new DomainProblem(409, VISIT_ENTERED_IN_ERROR_CODE, VISIT_ENTERED_IN_ERROR_MESSAGE);
  }
}
