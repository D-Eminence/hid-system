import { Injectable, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
import { getEnvironment } from '../config/environment';
import type { DataAccessContext } from '../common/request-context';

export interface TransactionOptions {
  readOnly?: boolean;
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
}

/** How many times a SERIALIZABLE transaction PostgreSQL cancels is run in all (as pharmacy-api). */
export const SERIALIZABLE_ATTEMPTS = 12;

/**
 * The pause before attempt `attempt + 1`: a random time within a window that doubles from 20 ms
 * up to 1000 ms, so transactions that cancelled each other commit in turn (as pharmacy-api).
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(1000, 20 * 2 ** (attempt - 1)));
}

/** A serialization failure (40001) or a deadlock (40P01): PostgreSQL cancelled the transaction. */
export function isSerializationConflict(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === '40001' || code === '40P01';
}

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly pool: Pool;
  private readonly workloadPool?: Pool;

  constructor() {
    const environment = getEnvironment();
    const ssl: PoolConfig['ssl'] = environment.DATABASE_SSL
      ? {
          rejectUnauthorized: true,
          ...(environment.DATABASE_SSL_ROOT_CERT_BASE64
            ? { ca: Buffer.from(environment.DATABASE_SSL_ROOT_CERT_BASE64, 'base64').toString('utf8') }
            : {}),
        }
      : false;
    this.pool = this.createPool({
      connectionString: environment.DATABASE_URL,
      max: environment.DATABASE_POOL_MAX,
      application_name: 'hid-ehr-api',
      ssl,
    });
    if (environment.WORKLOAD_DATABASE_URL) {
      this.workloadPool = this.createPool({
        connectionString: environment.WORKLOAD_DATABASE_URL,
        max: environment.WORKLOAD_DATABASE_POOL_MAX,
        application_name: 'hid-document-scanner-callback',
        ssl,
      });
    }
  }

  query<Row extends QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, [...values]);
  }

  /**
   * Runs the operation in one transaction with the request context. A SERIALIZABLE transaction
   * that PostgreSQL cancels to keep concurrent ones serializable (40001, 40P01) is run again from
   * the start, up to SERIALIZABLE_ATTEMPTS in all; any other transaction or error is not retried.
   * The operation must therefore do nothing outside the database (the order route send, its one
   * SERIALIZABLE caller, does not).
   */
  async withTransaction<Result>(
    context: DataAccessContext,
    operation: (client: PoolClient) => Promise<Result>,
    options: TransactionOptions = {},
  ): Promise<Result> {
    const attempts = options.isolationLevel === 'SERIALIZABLE' ? SERIALIZABLE_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.transaction(context, operation, options);
      } catch (error) {
        if (attempt >= attempts || !isSerializationConflict(error)) throw error;
        await this.pauseBeforeRetry(attempt);
      }
    }
  }

  /** Waits before the next attempt of a cancelled SERIALIZABLE transaction. */
  protected async pauseBeforeRetry(attempt: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
  }

  private async transaction<Result>(
    context: DataAccessContext,
    operation: (client: PoolClient) => Promise<Result>,
    options: TransactionOptions,
  ): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const isolationLevel = options.isolationLevel ?? 'READ COMMITTED';
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
      if (options.readOnly) await client.query('SET TRANSACTION READ ONLY');
      await client.query(
        `select
           set_config('app.actor_subject', $1, true),
           set_config('app.facility_id', $2, true),
           set_config('app.correlation_id', $3, true),
           set_config('app.membership_id', $4, true),
           set_config('app.purpose_of_use', $5, true)`,
        [
          context.actor.subject,
          context.facilityId,
          context.correlationId,
          context.membershipId,
          context.purposeOfUse,
        ],
      );
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async withSystemTransaction<Result>(
    correlationId: string,
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `select
           set_config('app.actor_subject', 'system:auth', true),
           set_config('app.correlation_id', $1, true)`,
        [correlationId],
      );
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async withPatientTransaction<Result>(
    context: { subject: string; accountId: string; sessionId: string; patientId: string; expiresAt: string },
    correlationId: string,
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    if (!Number.isFinite(Date.parse(context.expiresAt)) || Date.parse(context.expiresAt) <= Date.now()
      || Date.parse(context.expiresAt) > Date.now() + 60_000) throw new Error('Patient authorization is stale');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`select set_config('app.actor_subject',$1,true),
        set_config('app.account_id',$2,true),set_config('app.session_id',$3,true),
        set_config('app.patient_id',$4,true),set_config('app.correlation_id',$5,true),
        set_config('app.self_authorized_until',$6,true),set_config('app.purpose_of_use','patient-self',true),
        set_config('app.facility_id','',true),set_config('app.membership_id','',true)`,
      [context.subject,context.accountId,context.sessionId,context.patientId,correlationId,context.expiresAt]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  /**
   * The read of a card-link view (0118): read only; sets the view's digest
   * (the SHA-256 of its cookie secret), the correlation id and purpose
   * card-share, transaction-local, and blanks every subject, patient,
   * account, session, facility and membership setting, so
   * ehr.card_share_read_context never combines with another context.
   */
  async withCardShareTransaction<Result>(
    digest: string,
    correlationId: string,
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('A card view digest is required');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY');
      await client.query(`select set_config('app.card_view_digest',$1,true), set_config('app.correlation_id',$2,true),
        set_config('app.purpose_of_use','card-share',true), set_config('app.actor_subject','',true),
        set_config('app.patient_id','',true), set_config('app.account_id','',true),
        set_config('app.session_id','',true), set_config('app.facility_id','',true),
        set_config('app.membership_id','',true), set_config('app.self_authorized_until','',true)`,
      [digest, correlationId]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async withWorkloadTransaction<Result>(
    actorSubject: string,
    correlationId: string,
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    if (!this.workloadPool) {
      throw new ServiceUnavailableException('The isolated workload database role is not configured');
    }
    const client = await this.workloadPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `select
           set_config('app.actor_subject', $1, true),
           set_config('app.correlation_id', $2, true)`,
        [actorSubject, correlationId],
      );
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async healthCheck(): Promise<void> {
    await Promise.all([
      this.pool.query('select 1'),
      ...(this.workloadPool ? [this.workloadPool.query('select 1')] : []),
    ]);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      this.pool.end(),
      ...(this.workloadPool ? [this.workloadPool.end()] : []),
    ]);
  }

  private createPool(config: PoolConfig): Pool {
    const pool = new Pool({
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      query_timeout: 20_000,
      ...config,
    });
    pool.on('error', (error) => {
      // Never log driver messages: they may contain SQL, identifiers, hosts, or PHI.
      const code = typeof (error as Error & { code?: unknown }).code === 'string'
        ? (error as Error & { code: string }).code
        : 'unknown';
      process.stderr.write(`PostgreSQL pool failure (${config.application_name ?? 'hid'}, code=${code})\n`);
    });
    return pool;
  }
}
