import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
import { getEnvironment } from '../config/environment';
import type { DataAccessContext } from '../common/request-context';

export interface TransactionOptions {
  readOnly?: boolean;
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
}

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly pool: Pool;

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
      application_name: 'hid-lab-api',
      ssl,
    });
  }

  query<Row extends QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, [...values]);
  }

  async withPatientTransaction<T>(auth:{subject:string;accountId:string;patientId:string;sessionId:string;expiresAt:string},correlationId:string,operation:(client:PoolClient)=>Promise<T>):Promise<T> {
    const expiry=Date.parse(auth.expiresAt);
    if (!Number.isFinite(expiry) || expiry<=Date.now() || expiry>Date.now()+60_000) throw new Error('Patient authorization is stale');
    const client=await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.actor_subject',$1,true),set_config('app.account_id',$2,true),
        set_config('app.patient_id',$3,true),set_config('app.session_id',$4,true),set_config('app.self_authorized_until',$5,true),
        set_config('app.correlation_id',$6,true),set_config('app.purpose_of_use','patient-self',true),
        set_config('app.facility_id','',true),set_config('app.membership_id','',true)`,
        [auth.subject,auth.accountId,auth.patientId,auth.sessionId,auth.expiresAt,correlationId]);
      const result=await operation(client);await client.query('commit');return result;
    } catch(error) {await client.query('rollback');throw error;} finally {client.release();}
  }

  async withTransaction<Result>(
    context: DataAccessContext,
    operation: (client: PoolClient) => Promise<Result>,
    options: TransactionOptions = {},
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

  async healthCheck(): Promise<void> {
    await this.pool.query('select 1');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
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
