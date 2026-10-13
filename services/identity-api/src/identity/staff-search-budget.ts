import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { consumeRateLimit, rateLimitBlocked } from '../auth/rate-limit';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

export type StaffSearchOperation = 'patient_lookup' | 'access_request';

/**
 * Per-actor and per-facility budgets for the two staff commands that take a
 * patient's HID before any consent: patient lookup and access-request
 * creation (PSEARCH-1, 0086), kept in auth.otp_rate_limits. A bucket is the
 * SHA-256 of a labelled account or facility id: neither is a secret, and the
 * label keeps the four budgets apart.
 *
 * Access-request creation is counted before the command runs, whatever its
 * outcome. Patient lookup reads the budgets first (`refuseWhileBlocked`) and
 * counts only a refused lookup, unknown and unauthorized alike (FE-10): a
 * lookup that returns a patient the caller is already authorized for tells it
 * nothing new, and Health-id repeats it before each clinical read and write.
 */
@Injectable()
export class StaffSearchBudget {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Counts one call in its own committed transaction and refuses it with 429
   * once the actor's or the facility's maximum is crossed.
   */
  async consume(operation: StaffSearchOperation, context: DataAccessContext): Promise<void> {
    const environment = getEnvironment();
    const limits = operation === 'patient_lookup'
      ? { windowSeconds: environment.PATIENT_LOOKUP_RATE_WINDOW_SECONDS,
          actor: environment.PATIENT_LOOKUP_ACTOR_MAX_REQUESTS,
          facility: environment.PATIENT_LOOKUP_FACILITY_MAX_REQUESTS }
      : { windowSeconds: environment.ACCESS_REQUEST_RATE_WINDOW_SECONDS,
          actor: environment.ACCESS_REQUEST_ACTOR_MAX_REQUESTS,
          facility: environment.ACCESS_REQUEST_FACILITY_MAX_REQUESTS };
    const limited = await this.database.withTransaction(context, async (client) => {
      // Always the actor bucket, then the facility bucket: one lock order. A
      // blocked actor spends nothing more of its facility's budget, so one
      // member cannot exhaust it for the others beyond its own allowance.
      if (await consumeRateLimit(client, `${operation}_actor`,
        staffSearchBucket(operation, 'actor', context.actor.accountId),
        { windowSeconds: limits.windowSeconds, maxRequests: limits.actor })) return true;
      return consumeRateLimit(client, `${operation}_facility`,
        staffSearchBucket(operation, 'facility', context.facilityId),
        { windowSeconds: limits.windowSeconds, maxRequests: limits.facility });
    });
    if (limited) throw rateLimited(operation);
  }

  /**
   * Refuses with 429 while the actor's or the facility's bucket is blocked,
   * reading both and counting nothing. A bucket at its maximum is not yet
   * blocked: only a counted call over it blocks it, for one window.
   */
  async refuseWhileBlocked(operation: StaffSearchOperation, context: DataAccessContext): Promise<void> {
    const blocked = await this.database.withTransaction(context, async (client) =>
      await rateLimitBlocked(client, `${operation}_actor`, staffSearchBucket(operation, 'actor', context.actor.accountId))
      || rateLimitBlocked(client, `${operation}_facility`, staffSearchBucket(operation, 'facility', context.facilityId)),
    { readOnly: true });
    if (blocked) throw rateLimited(operation);
  }
}

function rateLimited(operation: StaffSearchOperation): DomainProblem {
  return operation === 'patient_lookup'
    ? new DomainProblem(429, 'PATIENT_LOOKUP_RATE_LIMITED', 'Too many patient lookups; wait and try again')
    : new DomainProblem(429, 'ACCESS_REQUEST_RATE_LIMITED', 'Too many access requests; wait and try again');
}

export function staffSearchBucket(operation: StaffSearchOperation, scope: 'actor' | 'facility', id: string): string {
  return createHash('sha256').update(`staff-search\u001f${operation}\u001f${scope}\u001f${id}`, 'utf8').digest('hex');
}
