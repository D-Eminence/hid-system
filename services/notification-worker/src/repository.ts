import { createHash } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import type { NotificationWorkerConfig } from './config';
import { WORKFLOW_BY_EVENT } from './event';
import type { ClaimedInbox, HidEventEnvelope, OrchestrationResult } from './types';

export class NotificationRepository {
  private readonly pool: Pool;
  constructor(private readonly config: NotificationWorkerConfig) {
    const ssl: PoolConfig['ssl'] = config.NOTIFICATION_WORKER_DATABASE_SSL ? {
      rejectUnauthorized: true,
      ...(config.NOTIFICATION_WORKER_DATABASE_SSL_ROOT_CERT_BASE64 ? {
        ca: Buffer.from(config.NOTIFICATION_WORKER_DATABASE_SSL_ROOT_CERT_BASE64, 'base64').toString('utf8'),
      } : {}),
    } : false;
    this.pool = new Pool({ connectionString: config.NOTIFICATION_WORKER_DATABASE_URL,
      application_name: 'hid-notification-worker', max: config.NOTIFICATION_WORKER_DATABASE_POOL_MAX, ssl,
      connectionTimeoutMillis: 5_000, statement_timeout: 15_000, query_timeout: 20_000 });
  }

  async claim(event: HidEventEnvelope): Promise<ClaimedInbox> {
    const result = await this.pool.query<{
      claim_status: ClaimedInbox['status']; claim_token: string | null; attempt_count: number;
    }>(
      `select * from integration.claim_inbox_message(
         'notification-worker-v1', $1, $2, $3, $4, $5, $6, $7, $8
       )`,
      [event.id, event.producer, event.type, event.version, event.correlationId,
        this.payloadHash(event), this.config.NOTIFICATION_WORKER_ID,
        this.config.NOTIFICATION_WORKER_LEASE_SECONDS],
    );
    const row = result.rows[0];
    if (!row) throw new Error('INBOX_CLAIM_MISSING');
    return { status: row.claim_status, attemptCount: row.attempt_count,
      ...(row.claim_token ? { claimToken: row.claim_token } : {}) };
  }

  async complete(event: HidEventEnvelope, claimToken: string, result: OrchestrationResult): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into notification.delivery_attempts (
           event_id, idempotency_key, workflow_id, channel, provider, outcome,
           provider_message_id, safe_code, correlation_id
         ) values ($1, $2, $3, 'in_app', $4, $5, $6, $7, $8)
         on conflict (idempotency_key, provider) do nothing`,
        [event.id, this.idempotencyKey(event), WORKFLOW_BY_EVENT[event.type], result.provider,
          result.outcome, result.providerMessageId ?? null, result.safeCode ?? null,
          event.correlationId],
      );
      await client.query(
        `select integration.complete_inbox_message('notification-worker-v1', $1, $2)`,
        [event.id, claimToken],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async fail(event: HidEventEnvelope, claimToken: string, result: OrchestrationResult,
    retryable: boolean, attemptCount: number): Promise<'retry_scheduled' | 'failed_terminal'> {
    const delaySeconds = Math.min(3600, 2 ** Math.min(attemptCount, 10));
    const nextAttempt = new Date(Date.now() + delaySeconds * 1000);
    const response = await this.pool.query<{ fail_inbox_message: 'retry_scheduled' | 'failed_terminal' }>(
      `select integration.fail_inbox_message(
         'notification-worker-v1', $1, $2, $3, $4, $5, $6
       )`,
      [event.id, claimToken, result.safeCode ?? 'NOTIFICATION_ORCHESTRATION_FAILED',
        retryable, nextAttempt, this.config.NOTIFICATION_WORKER_MAX_ATTEMPTS],
    );
    return response.rows[0]?.fail_inbox_message ?? 'failed_terminal';
  }

  async readiness(): Promise<void> { await this.pool.query('select 1'); }
  async close(): Promise<void> { await this.pool.end(); }

  private payloadHash(event: HidEventEnvelope): string {
    return createHash('sha256').update(JSON.stringify(event), 'utf8').digest('hex');
  }

  private idempotencyKey(event: HidEventEnvelope): string {
    return createHash('sha256').update(`${event.id}\u001f${WORKFLOW_BY_EVENT[event.type]}`, 'utf8').digest('hex');
  }
}
