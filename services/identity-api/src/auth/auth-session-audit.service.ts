import { createHash, createHmac } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { getEnvironment } from '../config/environment';

export type AuthSessionEventType =
  | 'login_succeeded'
  | 'login_failed'
  | 'refresh'
  | 'rotated'
  | 'revoked'
  | 'logout'
  | 'expired'
  | 'reuse_detected';

export interface AuthSessionEvent {
  correlationId: string;
  actorSubject?: string;
  sessionId?: string;
  eventType: AuthSessionEventType;
  outcome: 'success' | 'denied' | 'failure';
  sourceIp?: string;
  userAgent?: string;
  details?: Readonly<Record<string, unknown>>;
}

@Injectable()
export class AuthSessionAuditService {
  private readonly environment = getEnvironment();
  constructor(private readonly database: DatabaseService) {}

  async record(event: AuthSessionEvent): Promise<void> {
    try {
      await this.database.query(
        `insert into auth.session_events (
           session_id, account_id, event_type, outcome, correlation_id,
           source_ip, user_agent_sha256, details
         ) values (
           $1,
           (select id from auth.accounts where subject = $2),
           $3, $4, $5, $6, $7, $8::jsonb
         )`,
        [
          event.sessionId ?? null,
          event.actorSubject ?? null,
          event.eventType,
          event.outcome,
          event.correlationId,
          event.sourceIp ?? null,
          event.userAgent ? this.hash(event.userAgent) : null,
          JSON.stringify(event.details ?? {}),
        ],
      );
    } catch {
      throw new ServiceUnavailableException('Authentication audit persistence is unavailable');
    }
  }

  async recordLoginFailure(
    email: string,
    event: Omit<AuthSessionEvent, 'eventType' | 'outcome' | 'details'>,
  ): Promise<void> {
    const pepper = this.environment.AUTH_LOGIN_PEPPER;
    if (!pepper) throw new ServiceUnavailableException('Login-attempt protection is unavailable');
    const principalHmac = createHmac('sha256', pepper)
      .update(email.trim().toLowerCase(), 'utf8')
      .digest('hex');
    try {
      await this.database.withSystemTransaction(event.correlationId, async (client) => {
        await client.query(
          `insert into auth.login_attempts (
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
                 last_failed_at = clock_timestamp(), updated_at = clock_timestamp()`,
          [principalHmac, this.environment.AUTH_LOGIN_PEPPER_VERSION],
        );
        await client.query(
          `insert into auth.session_events (
             session_id, account_id, event_type, outcome, correlation_id,
             source_ip, user_agent_sha256, details
           ) values (null, null, 'login_failed', 'denied', $1, $2, $3, $4::jsonb)`,
          [
            event.correlationId,
            event.sourceIp ?? null,
            event.userAgent ? this.hash(event.userAgent) : null,
            JSON.stringify({ principal_hmac: principalHmac, pepper_version: this.environment.AUTH_LOGIN_PEPPER_VERSION }),
          ],
        );
      });
    } catch {
      throw new ServiceUnavailableException('Authentication audit persistence is unavailable');
    }
  }

  private hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }
}
