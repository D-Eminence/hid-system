import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';

export interface TransactionOptions {
  readOnly?: boolean;
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
}

export const SERIALIZABLE_ATTEMPTS = 12;

/**
 * The pause before attempt `attempt + 1`: a random time within a window that
 * doubles from 20 ms up to 1000 ms. PostgreSQL tracks SERIALIZABLE reads by
 * index page, so on small tables requests for different rows also cancel each
 * other, and of a group that overlapped only one commits; spreading the
 * retries apart lets the others commit in turn.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(1000, 20 * 2 ** (attempt - 1)));
}

/**
 * Conflicts PostgreSQL resolves by cancelling one SERIALIZABLE transaction: a
 * serialization failure (40001), a deadlock (40P01), and a unique violation
 * (23505), which is how two transactions that each looked for a key and then
 * inserted it can surface (PostgreSQL manual, "Serialization Failure
 * Handling"). Domain problems carry their own non-SQLSTATE codes.
 */
export function isRetryableConflict(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === '40001' || code === '40P01' || code === '23505';
}

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly pool: Pool;

  constructor() {
    const environment = getEnvironment();
    const ssl: PoolConfig['ssl'] = environment.DATABASE_SSL ? {
      rejectUnauthorized: true,
      ...(environment.DATABASE_SSL_ROOT_CERT_BASE64
        ? { ca: Buffer.from(environment.DATABASE_SSL_ROOT_CERT_BASE64, 'base64').toString('utf8') }
        : {}),
    } : false;
    this.pool = new Pool({ connectionString: environment.DATABASE_URL, max: environment.DATABASE_POOL_MAX,
      application_name: 'hid-pharmacy-api', ssl, idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000, statement_timeout: 15_000, query_timeout: 20_000 });
    this.pool.on('error', (error) => {
      const code = typeof (error as Error & { code?: unknown }).code === 'string'
        ? (error as Error & { code: string }).code : 'unknown';
      process.stderr.write(`PostgreSQL pool failure (hid-pharmacy-api, code=${code})\n`);
    });
  }

  query<Row extends QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, [...values]);
  }

  /**
   * Runs the operation in one transaction. A SERIALIZABLE transaction that
   * PostgreSQL cancels to keep concurrent requests serializable is run again
   * from the start, up to twelve attempts in all: the Pharmacy write commands
   * take no row locks, and the retry sees the committed winner, so it replays
   * it or refuses the request instead of failing with a 5xx (Phase 4 Stage 9).
   */
  async withTransaction<Result>(context: DataAccessContext,
    operation: (client: PoolClient) => Promise<Result>, options: TransactionOptions = {}): Promise<Result> {
    const attempts = options.isolationLevel === 'SERIALIZABLE' ? SERIALIZABLE_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.transaction(context, operation, options);
      } catch (error) {
        if (attempt >= attempts || !isRetryableConflict(error)) throw error;
        await this.pauseBeforeRetry(attempt);
      }
    }
  }

  /** Waits before the next attempt of a cancelled SERIALIZABLE transaction. */
  protected async pauseBeforeRetry(attempt: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
  }

  private async transaction<Result>(context: DataAccessContext,
    operation: (client: PoolClient) => Promise<Result>, options: TransactionOptions): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolationLevel ?? 'READ COMMITTED'}`);
      if (options.readOnly) await client.query('SET TRANSACTION READ ONLY');
      await client.query(`select set_config('app.actor_subject',$1,true),set_config('app.facility_id',$2,true),
        set_config('app.correlation_id',$3,true),set_config('app.membership_id',$4,true),
        set_config('app.purpose_of_use',$5,true)`, [context.actor.subject, context.facilityId,
        context.correlationId, context.membershipId, context.purposeOfUse]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async healthCheck(): Promise<void> { await this.pool.query('select 1'); }
  async onApplicationShutdown(): Promise<void> { await this.pool.end(); }
}
