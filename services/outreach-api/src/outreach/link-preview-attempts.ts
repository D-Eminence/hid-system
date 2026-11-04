import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';

/** Health ID checks (previews and Health ID links) a member may make in an hour. */
export const HEALTH_ID_HOURLY_LIMIT = 20;

export interface VisibleCase {
  id: string;
  status: 'identity_resolution_pending' | 'identity_resolved';
  resolved_patient_id: string | null;
  row_version: string | number;
}

/**
 * The registration case as the caller may see it at the session facility
 * (row-level security applies the permission and campaign membership), or
 * 404 OUTREACH_REGISTRATION_NOT_FOUND.
 */
export async function findVisibleCase(client: PoolClient, caseId: string,
  context: DataAccessContext): Promise<VisibleCase> {
  const result = await client.query<VisibleCase>(`select id,status,resolved_patient_id,row_version
    from outreach.registration_cases where id=$1 and facility_id=$2`, [caseId, context.facilityId]);
  const row = result.rows[0];
  if (!row) throw new DomainProblem(404, 'OUTREACH_REGISTRATION_NOT_FOUND',
    'The Outreach registration case was not found');
  return row;
}

/** 429 when the member used their hourly Health ID budget at this facility. */
export async function assertHealthIdBudget(client: PoolClient, context: DataAccessContext): Promise<void> {
  const result = await client.query<{ used: number }>(`select count(*)::int as used
    from outreach.link_preview_attempts where requested_by_membership_id=$1 and facility_id=$2
      and created_at > clock_timestamp() - interval '1 hour'`, [context.membershipId, context.facilityId]);
  if ((result.rows[0]?.used ?? 0) >= HEALTH_ID_HOURLY_LIMIT) throw new DomainProblem(429,
    'OUTREACH_HEALTH_ID_LIMIT', 'Too many Health ID checks in the last hour. Try again later.');
}

/** One attempt row: ids and a time only, never the Health ID. */
export async function recordHealthIdAttempt(client: PoolClient, caseId: string,
  context: DataAccessContext): Promise<void> {
  await client.query(`insert into outreach.link_preview_attempts (
    registration_case_id,facility_id,requested_by_account_id,requested_by_membership_id
  ) values ($1,$2,$3,$4)`, [caseId, context.facilityId, context.actor.accountId, context.membershipId]);
}

/**
 * Reserves one Health ID check before Identity is called: the case must be
 * visible and pending (and at expectedVersion, for a link), and the member
 * within the hourly budget; the attempt row is then written in the same
 * transaction. Run it in a SERIALIZABLE transaction so concurrent checks
 * cannot all pass the count (withTransaction retries the 40001).
 */
export async function reserveHealthIdCheck(client: PoolClient, caseId: string, context: DataAccessContext,
  expectedVersion?: number): Promise<VisibleCase> {
  const registration = await findVisibleCase(client, caseId, context);
  if (registration.status !== 'identity_resolution_pending') throw new DomainProblem(409,
    'OUTREACH_REGISTRATION_ALREADY_RESOLVED', 'The Outreach registration case is already resolved');
  if (expectedVersion !== undefined && Number(registration.row_version) !== expectedVersion) {
    throw new DomainProblem(412, 'VERSION_CONFLICT',
      'The Outreach registration case changed; reload before reconciling');
  }
  await assertHealthIdBudget(client, context);
  await recordHealthIdAttempt(client, caseId, context);
  return registration;
}
