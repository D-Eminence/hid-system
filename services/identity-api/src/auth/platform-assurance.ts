import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { PLATFORM_ACTION_POLICIES, type PlatformAction } from '../admin/high-risk-policy';
import { DomainProblem } from '../common/problem';
import type { ActorContext, PlatformAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';

interface Queryable {
  query<Row extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
}

export interface PlatformAssuranceState {
  mfaVerifiedAt: Date;
  mfaMethod: 'totp' | 'recovery_code';
  stepUpAt: Date | null;
  stepUpFresh: boolean;
  stepUpExpiresAt: Date | null;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

/**
 * Reads the server-side assurance of the actor's current platform session. It
 * returns null unless the session is an active, unrevoked platform session of
 * this account, verified by a factor that is still active. Nothing the client
 * sends (headers, body, token claims) can change the result.
 */
export async function readPlatformAssurance(database: Queryable, actor: ActorContext,
  stepUpTtlSeconds = getEnvironment().PLATFORM_STEP_UP_TTL_SECONDS): Promise<PlatformAssuranceState | null> {
  if (actor.kind !== 'platform' || !actor.sessionId) return null;
  const result = await database.query<{
    mfa_verified_at: Date; mfa_method: 'totp' | 'recovery_code'; step_up_at: Date | null;
    step_up_fresh: boolean; step_up_expires_at: Date | null; expires_at: Date; absolute_expires_at: Date;
  }>(
    `select assurance.mfa_verified_at, assurance.mfa_method, assurance.step_up_at,
            coalesce(assurance.step_up_at > clock_timestamp() - ($3 * interval '1 second'), false) as step_up_fresh,
            assurance.step_up_at + ($3 * interval '1 second') as step_up_expires_at,
            session_row.expires_at, session_row.absolute_expires_at
       from auth.sessions session_row
       join auth.accounts account_row on account_row.id = session_row.account_id
       join auth.session_assurance assurance
         on assurance.family_id = session_row.family_id and assurance.account_id = session_row.account_id
       join auth.mfa_factors factor
         on factor.id = assurance.mfa_factor_id and factor.account_id = session_row.account_id
        and factor.status = 'active'
      where session_row.id = $1 and session_row.account_id = $2
        and session_row.session_kind = 'platform' and session_row.revoked_at is null
        and session_row.expires_at > clock_timestamp()
        and session_row.absolute_expires_at > clock_timestamp()
        and session_row.account_token_version = account_row.token_version
        and account_row.status = 'active'
        and (account_row.disabled_until is null or account_row.disabled_until <= clock_timestamp())`,
    [actor.sessionId, actor.accountId, stepUpTtlSeconds],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    mfaVerifiedAt: row.mfa_verified_at, mfaMethod: row.mfa_method, stepUpAt: row.step_up_at,
    stepUpFresh: row.step_up_fresh, stepUpExpiresAt: row.step_up_fresh ? row.step_up_expires_at : null,
    idleExpiresAt: row.expires_at, absoluteExpiresAt: row.absolute_expires_at,
  };
}

/**
 * Service-layer enforcement of the central policy, run inside the command's
 * own transaction. Every platform command calls it with its own action, so a
 * service invoked without the guard (or by a route missing its decorator) is
 * still refused without a verified platform session and, where the policy
 * requires it, a TOTP step-up from the last five minutes.
 */
export async function requirePlatformAssurance(client: Pick<PoolClient, 'query'>, context: PlatformAccessContext,
  action: PlatformAction): Promise<PlatformAssuranceState> {
  const policy = PLATFORM_ACTION_POLICIES[action];
  const state = await readPlatformAssurance(client as Queryable, context.actor);
  if (!state) {
    throw new DomainProblem(403, 'PLATFORM_SESSION_REQUIRED', 'An MFA-verified platform administration session is required');
  }
  const granted = new Set(context.actor.platformPermissions ?? []);
  if (policy.permissions.some((permission) => !granted.has(permission))) {
    throw new DomainProblem(403, 'PERMISSION_DENIED', 'Required permission is missing');
  }
  if (policy.stepUp && !state.stepUpFresh) throw stepUpProblem(state);
  return state;
}

/**
 * The 403 for a command whose step-up is not fresh (Stage 4A):
 * STEP_UP_EXPIRED when this session's last step-up is older than the
 * five-minute window, STEP_UP_REQUIRED when the session has none. It concerns
 * only the caller's own verified session.
 */
export function stepUpProblem(state: Pick<PlatformAssuranceState, 'stepUpAt'>): DomainProblem {
  return state.stepUpAt
    ? new DomainProblem(403, 'STEP_UP_EXPIRED', 'Your authenticator confirmation expired; confirm again to continue')
    : new DomainProblem(403, 'STEP_UP_REQUIRED', 'Confirm with your authenticator code to continue');
}
