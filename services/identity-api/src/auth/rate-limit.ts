import type { PoolClient } from 'pg';

/**
 * Keyed request windows in `auth.otp_rate_limits` (0028). Callers pass an HMAC
 * bucket, never a raw identifier.
 */
export type RateLimitScope = 'ip' | 'account' | 'recipient';

export interface RateLimitWindow {
  windowSeconds: number;
  maxRequests: number;
}

/**
 * Counts one request in the bucket's window and returns true when the bucket is
 * (now) blocked. A blocked bucket stays blocked for one window.
 */
export async function consumeRateLimit(client: PoolClient, scope: RateLimitScope, bucket: string,
  window: RateLimitWindow): Promise<boolean> {
  // Serialize even an absent bucket: row locks alone lose concurrent first attempts.
  await lockRateLimitBucket(client, scope, bucket);
  const result = await client.query<{ request_count: number; window_started_at: Date; blocked_until: Date | null }>(
    `select request_count, window_started_at, blocked_until
       from auth.otp_rate_limits where scope = $1 and bucket_hmac = $2 for update`,
    [scope, bucket],
  );
  const current = result.rows[0];
  const now = Date.now();
  if (current?.blocked_until && current.blocked_until.getTime() > now) return true;
  const windowExpired = !current
    || current.window_started_at.getTime() + window.windowSeconds * 1000 <= now;
  const nextCount = windowExpired ? 1 : current.request_count + 1;
  const blocked = nextCount > window.maxRequests;
  await client.query(
    `insert into auth.otp_rate_limits (
       scope, bucket_hmac, window_started_at, request_count, blocked_until, updated_at
     ) values ($1, $2, clock_timestamp(), 1, null, clock_timestamp())
     on conflict (scope, bucket_hmac) do update set
       window_started_at = case when $3 then clock_timestamp()
         else auth.otp_rate_limits.window_started_at end,
       request_count = $4,
       blocked_until = case when $5 then clock_timestamp() + ($6 * interval '1 second')
         else null end,
       updated_at = clock_timestamp()`,
    [scope, bucket, windowExpired, nextCount, blocked, window.windowSeconds],
  );
  return blocked;
}

/**
 * Takes the transaction lock `consumeRateLimit` takes for the bucket, so that a
 * read with `rateLimitBlocked` and a later count in the same transaction see
 * no other transaction's count in between.
 */
export async function lockRateLimitBucket(client: PoolClient, scope: RateLimitScope, bucket: string): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`otp-rate:${scope}:${bucket}`]);
}

/**
 * Gives back one request counted by `consumeRateLimit` (for a reserved
 * attempt that turned out to be allowed, such as a right password), under the
 * same transaction lock. A blocked bucket stays blocked; a count never goes
 * below zero.
 */
export async function releaseRateLimit(client: PoolClient, scope: RateLimitScope, bucket: string): Promise<void> {
  await lockRateLimitBucket(client, scope, bucket);
  await client.query(
    `update auth.otp_rate_limits
        set request_count = greatest(request_count - 1, 0), updated_at = clock_timestamp()
      where scope = $1 and bucket_hmac = $2 and request_count > 0
        and (blocked_until is null or blocked_until <= clock_timestamp())`,
    [scope, bucket],
  );
}

/** True while a bucket is blocked. Reads only; it does not count a request. */
export async function rateLimitBlocked(client: PoolClient, scope: RateLimitScope, bucket: string): Promise<boolean> {
  const result = await client.query<{ blocked: boolean }>(
    `select coalesce(blocked_until > clock_timestamp(), false) as blocked
       from auth.otp_rate_limits where scope = $1 and bucket_hmac = $2`,
    [scope, bucket],
  );
  return result.rows[0]?.blocked === true;
}
