import { createHash, createHmac } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { getEnvironment } from '../config/environment';
import { RECORD_LOGIN_FAILURE_SQL } from './login-attempts';

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
        await client.query(RECORD_LOGIN_FAILURE_SQL,
          [principalHmac, this.environment.AUTH_LOGIN_PEPPER_VERSION]);
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
