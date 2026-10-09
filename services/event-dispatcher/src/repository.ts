import { Pool, type PoolConfig, type QueryResultRow } from 'pg';
import type { EventDispatcherConfig } from './config';
import type { ClaimedEvent, DeliveryMetrics, DeliveryRepository, EventProducer,
  SafeDeliveryFailure, TerminalDeliveryFailure } from './types';

interface ClaimRow extends QueryResultRow {
  producer: EventProducer; event_id: string; event_type: string; event_version: number;
  occurred_at: Date; aggregate_type: string; aggregate_id: string; aggregate_version: string;
  correlation_id: string; causation_id: string | null; facility_id: string | null;
  patient_id: string | null; payload: Record<string, unknown>; attempt_count: number;
  claim_token: string; claim_expires_at: Date;
}

interface MetricsRow extends QueryResultRow {
  pending_count: string; claimed_count: string; retry_scheduled_count: string;
  delivered_count: string; terminal_failure_count: string; oldest_pending_age_seconds: string;
  dispatch_success_count: string; dispatch_failure_count: string; retry_count: string;
  average_dispatch_latency_ms: string;
}

interface TerminalFailureRow extends QueryResultRow {
  event_id: string; event_type: string; producer: EventProducer; attempt_count: number;
  error_code: string; error_summary: string; failed_at: Date; next_attempt_at: Date;
  correlation_id: string;
}

export class PostgresDeliveryRepository implements DeliveryRepository {
  private readonly pool: Pool;
  constructor(private readonly config: EventDispatcherConfig) {
    if (!config.EVENT_DISPATCHER_DATABASE_URL) throw new Error('Dispatcher database URL is absent');
    const ssl: PoolConfig['ssl'] = config.EVENT_DISPATCHER_DATABASE_SSL ? {
      rejectUnauthorized: true,
      ...(config.EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64 ? {
        ca: Buffer.from(config.EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64.replace(/\s+/g, ''),
          'base64').toString('utf8'),
      } : {}),
    } : false;
    this.pool = new Pool({ connectionString: config.EVENT_DISPATCHER_DATABASE_URL,
      max: config.EVENT_DISPATCHER_POOL_MAX, application_name: 'hid-event-dispatcher', ssl,
      connectionTimeoutMillis: 5_000, statement_timeout: 30_000, query_timeout: 35_000 });
    this.pool.on('error', (error) => this.logPoolFailure(error));
  }

  async checkReadiness(): Promise<void> { await this.pool.query('select 1'); }

  async claim(dispatcherId: string): Promise<readonly ClaimedEvent[]> {
    const result = await this.pool.query<ClaimRow>(
      'select * from integration.claim_outbox_events($1,$2,$3,$4)',
      [dispatcherId, this.config.EVENT_DISPATCHER_BATCH_SIZE,
        this.config.EVENT_DISPATCHER_LEASE_SECONDS, this.config.EVENT_DISPATCHER_MAX_ATTEMPTS],
    );
    return result.rows.map((row) => this.mapClaim(row));
  }

  async delivered(event: ClaimedEvent, transport: string, messageId: string): Promise<void> {
    await this.pool.query('select integration.record_outbox_delivered($1,$2,$3,$4,$5)',
      [event.producer, event.eventId, event.claimToken, transport, messageId]);
  }

  async failed(event: ClaimedEvent, transport: string, failure: SafeDeliveryFailure,
    nextAttemptAt: Date | null): Promise<'retry_scheduled' | 'failed_terminal'> {
    const result = await this.pool.query<{ record_outbox_failure: string }>(
      'select integration.record_outbox_failure($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [event.producer, event.eventId, event.claimToken, transport, failure.code,
        failure.safeSummary, failure.retryable, nextAttemptAt,
        this.config.EVENT_DISPATCHER_MAX_ATTEMPTS],
    );
    const outcome = result.rows[0]?.record_outbox_failure;
    if (outcome !== 'retry_scheduled' && outcome !== 'failed_terminal') {
      throw new Error('Outbox failure command returned an invalid outcome');
    }
    return outcome;
  }

  async metrics(): Promise<DeliveryMetrics> {
    const result = await this.pool.query<MetricsRow>('select * from integration.event_delivery_status()');
    const row = result.rows[0];
    if (!row) throw new Error('Event delivery status returned no row');
    return { pendingCount: number(row.pending_count), claimedCount: number(row.claimed_count),
      retryScheduledCount: number(row.retry_scheduled_count), deliveredCount: number(row.delivered_count),
      terminalFailureCount: number(row.terminal_failure_count),
      oldestPendingAgeSeconds: number(row.oldest_pending_age_seconds),
      dispatchSuccessCount: number(row.dispatch_success_count),
      dispatchFailureCount: number(row.dispatch_failure_count), retryCount: number(row.retry_count),
      averageDispatchLatencyMs: metricNumber(row.average_dispatch_latency_ms) };
  }

  async terminalFailures(limit: number): Promise<readonly TerminalDeliveryFailure[]> {
    const result = await this.pool.query<TerminalFailureRow>(
      'select * from integration.list_terminal_event_failures($1)', [limit]);
    return result.rows.map((row) => ({ eventId: row.event_id, eventType: row.event_type,
      producer: row.producer, attemptCount: number(row.attempt_count), errorCode: row.error_code,
      errorSummary: row.error_summary, failedAt: date(row.failed_at).toISOString(),
      nextAttemptAt: date(row.next_attempt_at).toISOString(), correlationId: row.correlation_id }));
  }

  async close(): Promise<void> { await this.pool.end(); }

  private mapClaim(row: ClaimRow): ClaimedEvent {
    const aggregateVersion = number(row.aggregate_version);
    const attemptCount = number(row.attempt_count);
    return { producer: row.producer, eventId: row.event_id, eventType: row.event_type,
      eventVersion: number(row.event_version), occurredAt: date(row.occurred_at),
      aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, aggregateVersion,
      correlationId: row.correlation_id, causationId: row.causation_id,
      facilityId: row.facility_id, patientId: row.patient_id, payload: row.payload,
      attemptCount, claimToken: row.claim_token, claimExpiresAt: date(row.claim_expires_at) };
  }

  private logPoolFailure(error: Error): void {
    const candidate = (error as Error & { code?: unknown }).code;
    const code = typeof candidate === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(candidate)
      ? candidate : 'UNKNOWN';
    process.stderr.write(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error',
      event: 'event_dispatcher.db_pool_error', code }) + '\n');
  }
}

function number(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Database returned an invalid numeric value');
  return result;
}

function metricNumber(value: string | number): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error('Database returned an invalid metric');
  return result;
}

function date(value: Date | string): Date {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error('Database returned an invalid timestamp');
  return result;
}
