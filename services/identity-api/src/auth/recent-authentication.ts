import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import type { ActorContext } from '../common/request-context';

export type PatientSessionActor = ActorContext & { patientId: string; sessionId: string };

/**
 * Sensitive patient commands (PIN changes, account deletion) require that the
 * current session family was first issued within the last ten minutes.
 * Refresh rotates a session within the same family, so checking the earliest
 * issuance in that family prevents silent refresh from counting as a fresh
 * patient authentication.
 */
export async function requireRecentPatientAuthentication(
  client: PoolClient,
  actor: PatientSessionActor,
  detail: string,
): Promise<void> {
  const result = await client.query<{ recent: boolean }>(
    `select coalesce(min(family.issued_at) >= clock_timestamp() - interval '10 minutes', false) as recent
       from auth.sessions current_session
       join auth.sessions family on family.family_id = current_session.family_id
      where current_session.id = $1 and current_session.account_id = $2
        and current_session.patient_id = $3 and current_session.session_kind = 'patient'
        and current_session.revoked_at is null`,
    [actor.sessionId, actor.accountId, actor.patientId],
  );
  if (!result.rows[0]?.recent) {
    throw new DomainProblem(403, 'PATIENT_RECENT_AUTH_REQUIRED', detail);
  }
}
