import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import type { ActorContext } from '../common/request-context';

export type PatientSessionActor = ActorContext & { patientId: string; sessionId: string };

/** How long an OTP account recovery holds the commands that grant or redirect access. */
export const RECOVERY_HOLD_HOURS = 24;

/**
 * For 24 hours after an OTP account recovery (a consumed recovery challenge of
 * the account, whatever its purpose), refuse the commands that would let
 * whoever recovered the account redirect where emergency alerts go: adding or
 * changing an emergency contact (REC-NOTIFY). Deactivation stays available.
 * Facility staff management (P4b) holds inviting, resending an invitation and
 * changing a member's role the same way, answering STAFF_RECENT_RECOVERY_HOLD.
 * Fails closed: no answer is a hold.
 */
export async function requireNoRecentRecoveryHold(client: PoolClient, accountId: string, what: string,
  code: 'PATIENT_RECENT_RECOVERY_HOLD' | 'STAFF_RECENT_RECOVERY_HOLD' = 'PATIENT_RECENT_RECOVERY_HOLD'): Promise<void> {
  const result = await client.query<{ held: boolean }>(
    `select exists (
       select 1 from auth.otp_challenges
        where account_id = $1 and consumed_at is not null
          and consumed_at > clock_timestamp() - make_interval(hours => $2)
     ) as held`,
    [accountId, RECOVERY_HOLD_HOURS],
  );
  if (result.rows[0]?.held !== false) {
    throw new DomainProblem(403, code,
      `This account was recovered with a verification code less than ${RECOVERY_HOLD_HOURS} hours ago; `
      + `${what} are available again once that period ends`);
  }
}
