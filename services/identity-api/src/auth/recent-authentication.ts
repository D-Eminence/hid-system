import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import type { ActorContext } from '../common/request-context';

export type PatientSessionActor = ActorContext & { patientId: string; sessionId: string };

/**
 * Sensitive patient commands (an Access PIN change, approving a clinician's
 * access request) require that the current session family was first issued
 * within the last ten minutes (main's requireRecentPatientAuthentication).
 * Refresh rotates a session within the same family, so checking the earliest
 * issuance in that family prevents silent refresh from counting as a fresh
 * patient authentication. Fails closed: no answer is not recent.
 */
export async function requireRecentPatientAuthentication(client: PoolClient, actor: PatientSessionActor,
  detail: string): Promise<void> {
  const result = await client.query<{ recent: boolean }>(
    `select coalesce(min(family.issued_at) >= clock_timestamp() - interval '10 minutes', false) as recent
       from auth.sessions current_session
       join auth.sessions family on family.family_id = current_session.family_id
      where current_session.id = $1 and current_session.account_id = $2
        and current_session.patient_id = $3 and current_session.session_kind = 'patient'
        and current_session.revoked_at is null`,
    [actor.sessionId, actor.accountId, actor.patientId],
  );
  if (result.rows[0]?.recent !== true) {
    throw new DomainProblem(403, 'PATIENT_RECENT_AUTH_REQUIRED', detail);
  }
}

/** How long an OTP account recovery holds the commands that grant or redirect access. */
export const RECOVERY_HOLD_HOURS = 24;

/**
 * For 24 hours after an OTP account recovery (a consumed recovery challenge of
 * the account, whatever its purpose), refuse the commands that would let
 * whoever recovered the account grant or redirect access: adding or changing
 * an emergency contact, and approving a clinician's access request
 * (REC-NOTIFY, as main). Deactivation and denial stay available. Facility
 * staff management (P4b) holds inviting, resending an invitation and
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
