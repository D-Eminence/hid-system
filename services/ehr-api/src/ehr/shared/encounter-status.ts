import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import { EncounterStatus } from './clinical.dto';

/**
 * What a write adds to an encounter (CLIN-EIE, migration 0084):
 * - `record`: a note, vital, diagnosis or document. Refused on a cancelled or
 *   entered-in-error encounter; late documentation on a completed one is kept.
 * - `order`: a new prescription or lab request, or the activation of a draft
 *   one. Also refused on a completed encounter.
 * - `resume`: an order put on hold, made active again. Refused like a record.
 */
export type EncounterChange = 'record' | 'order' | 'resume';

/**
 * The encounter read under the share lock ehr.require_open_encounter() takes
 * (0084). Holding it serialises the write with a retraction of the encounter,
 * which holds FOR UPDATE on it while it marks the encounter's records. Every
 * path takes it before any lock on a record of the encounter, the order the
 * retraction locks in.
 */
export const ENCOUNTER_SHARE_LOCK_SQL =
  'select status from ehr.encounters where id = $1 and patient_id = $2 and facility_id = $3 for share';

/** Share-locks the encounter and returns its status, or undefined when the writer cannot see or lock it. */
export async function lockEncounterStatus(
  client: PoolClient,
  encounterId: string,
  patientId: string,
  facilityId: string,
): Promise<EncounterStatus | undefined> {
  const result = await client.query<{ status: EncounterStatus }>(ENCOUNTER_SHARE_LOCK_SQL,
    [encounterId, patientId, facilityId]);
  return result.rows[0]?.status;
}

/** 409 ENCOUNTER_NOT_OPEN when an encounter in `status` cannot take the change. */
export function refuseClosedEncounter(status: EncounterStatus, change: EncounterChange): void {
  if (status === EncounterStatus.Cancelled || status === EncounterStatus.EnteredInError) {
    throw new DomainProblem(409, 'ENCOUNTER_NOT_OPEN',
      `The encounter is ${status === EncounterStatus.Cancelled ? 'cancelled' : 'entered in error'}`
      + ' and takes no further clinical records');
  }
  if (status === EncounterStatus.Completed && change === 'order') {
    throw new DomainProblem(409, 'ENCOUNTER_NOT_OPEN', 'A completed encounter takes no new orders');
  }
}
