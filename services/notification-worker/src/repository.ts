import { createHash } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import type { NotificationWorkerConfig } from './config';
import { assertRuntimeDatabaseRole } from './runtime-role-guard';
import { WORKFLOW_BY_EVENT } from './event';
import type {
  ClaimedInbox, HidEventEnvelope, OrchestrationResult, RecipientDelivery, SubscriberOperation, SubscriberOperationResult,
} from './types';

/** The inbox claim is stale or held by another worker (SQLSTATE 55000): stop without failing or acknowledging. */
export class ClaimLostError extends Error {
  override readonly name = 'ClaimLostError';
  constructor() { super('NOTIFICATION_CLAIM_LOST'); }
}

const DISCLOSURE_WORKFLOW: Readonly<Record<SubscriberOperation, string>> = Object.freeze({
  email: 'novu-subscriber-email-v1',
  clear: 'novu-subscriber-email-clear-v1',
});
const DISCLOSURE_OUTCOME = Object.freeze({ confirmed: 'accepted', rejected: 'definitive_failure', unknown: 'unknown' } as const);

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

  /**
   * The recipient of the claimed event (0095, ADR-064), through the
   * claim-bound SECURITY DEFINER lookup only: the worker reads no Identity or
   * Auth table. No row means the claim bound no outbox event of that patient.
   * Any answer outside the contract is refused, and the caller withholds email.
   */
  async resolveRecipient(event: HidEventEnvelope, claimToken: string): Promise<RecipientDelivery> {
    let rows: Array<{ delivery: unknown; email: unknown }>;
    try {
      rows = (await this.pool.query<{ delivery: unknown; email: unknown }>(
        `select delivery, email
         from integration.notification_recipient_for_claim($1, $2, $3)`,
        [event.id, claimToken, event.context.patientId],
      )).rows;
    } catch (error) {
      if ((error as { code?: unknown }).code === '55000') throw new ClaimLostError();
      throw error;
    }
    if (rows.length === 0) return { delivery: 'withhold', bound: false };
    const [row] = rows;
    if (rows.length === 1 && row.delivery === 'email' && typeof row.email === 'string' && row.email.trim()) {
      return { delivery: 'email', email: row.email };
    }
    if (rows.length === 1 && row.delivery === 'withhold' && row.email === null) return { delivery: 'withhold', bound: true };
    throw new Error('NOTIFICATION_RECIPIENT_CONTRACT_VIOLATION');
  }

  /**
   * A PHI-free record of one Novu subscriber call per attempt: which event,
   * which operation and its outcome, never the address or anything derived
   * from it. Existing reconciliation rows are left as they are.
   */
  async recordSubscriberOperation(event: HidEventEnvelope, operation: SubscriberOperation,
    result: SubscriberOperationResult, attemptCount: number): Promise<void> {
    const workflow = DISCLOSURE_WORKFLOW[operation];
    await this.pool.query(
      `insert into notification.delivery_attempts (
         event_id, idempotency_key, workflow_id, channel, provider, outcome, safe_code, correlation_id
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (idempotency_key, provider) do nothing`,
      [event.id, createHash('sha256').update(`${workflow}\u001f${event.id}\u001f${attemptCount}`, 'utf8').digest('hex'),
        workflow, 'email', result.provider, DISCLOSURE_OUTCOME[result.outcome], result.safeCode ?? null, event.correlationId],
    );
  }

  /**
   * With NOVU_SUBSCRIBER_SYNC=email, refuse to start unless 0095's lookup
   * exists and this login may execute it, so a task deployed before the
   * migration or its grants fails its rollout instead of handling events.
   */
  async verifySubscriberSyncPrivilege(): Promise<void> {
    try {
      const result = await this.pool.query<{ executable: boolean | null }>(
        `select has_function_privilege(current_user,
           to_regprocedure('integration.notification_recipient_for_claim(uuid,uuid,uuid)'), 'EXECUTE') as executable`,
      );
      if (result.rows[0]?.executable !== true) throw new Error('NOTIFICATION_RECIPIENT_LOOKUP_NOT_EXECUTABLE');
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      throw error;
    }
  }

  /** In production, refuse to start over a superuser, BYPASSRLS or owner connection (runtime-role-guard.ts). */
  async verifyRuntimeRole(): Promise<void> {
    if (this.config.NODE_ENV !== 'production') return;
    try {
      await assertRuntimeDatabaseRole(this.pool);
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      throw error;
    }
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
