import { createHmac } from 'node:crypto';

/**
 * Failed sign-in buckets in auth.login_attempts (0002). A bucket is an HMAC
 * under the login pepper: of the identifier as typed (email or HID, trimmed
 * and lower-cased), and, since 0086, of the resolved account id under its own
 * label, so that the email and the HID of one account share one budget. The
 * fifth failure within 15 minutes of a bucket's first locks it for 15 minutes;
 * every refused attempt while it is locked extends the lock.
 */
export const RECORD_LOGIN_FAILURE_SQL = `insert into auth.login_attempts (
     principal_hmac, pepper_version, failure_count, window_started_at,
     locked_until, last_failed_at
   ) values ($1, $2, 1, clock_timestamp(), null, clock_timestamp())
   on conflict (principal_hmac, pepper_version) do update
     set failure_count = case
           when auth.login_attempts.window_started_at < clock_timestamp() - interval '15 minutes' then 1
           else auth.login_attempts.failure_count + 1
         end,
         window_started_at = case
           when auth.login_attempts.window_started_at < clock_timestamp() - interval '15 minutes'
           then clock_timestamp() else auth.login_attempts.window_started_at
         end,
         locked_until = case
           when (case
             when auth.login_attempts.window_started_at < clock_timestamp() - interval '15 minutes' then 1
             else auth.login_attempts.failure_count + 1
           end) >= 5 then clock_timestamp() + interval '15 minutes'
           else null
         end,
         last_failed_at = clock_timestamp(), updated_at = clock_timestamp()`;

/** The account's own bucket; the label keeps it apart from every identifier bucket. */
export function accountLoginBucket(pepper: string, accountId: string): string {
  return createHmac('sha256', pepper).update(`login-account\u001f${accountId}`, 'utf8').digest('hex');
}
