import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';

export interface TransactionOptions {
  readOnly?: boolean;
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
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
      application_name: 'hid-outreach-api', ssl, idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000, statement_timeout: 15_000, query_timeout: 20_000 });
    this.pool.on('error', (error) => {
      const code = typeof (error as Error & { code?: unknown }).code === 'string'
        ? (error as Error & { code: string }).code : 'unknown';
      process.stderr.write(`PostgreSQL pool failure (hid-outreach-api, code=${code})\n`);
    });
  }

  query<Row extends QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, [...values]);
  }

  async withTransaction<Result>(context: DataAccessContext,
    operation: (client: PoolClient) => Promise<Result>, options: TransactionOptions = {}): Promise<Result> {
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
