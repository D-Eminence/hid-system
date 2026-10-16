import { Injectable, OnApplicationShutdown, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
import { getEnvironment } from '../config/environment';
import { assertRuntimeDatabaseRole } from './runtime-role-guard';
import type { DataAccessContext } from '../common/request-context';

export interface TransactionOptions {
  readOnly?: boolean;
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly pool: Pool;
  private readonly verifyRuntimeRole: boolean;
  private readonly workloadPool?: Pool;

  constructor() {
    const environment = getEnvironment();
    this.verifyRuntimeRole = environment.NODE_ENV === 'production';
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

  /**
   * A patient-self transaction bound to Identity's fresh authorization. It
   * releases no record category to the database (app.patient_release empty)
   * until PatientRecordRelease.bind names the configured ones (0095).
   */
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
        set_config('app.facility_id','',true),set_config('app.membership_id','',true),
        set_config('app.patient_release','',true)`,
      [context.subject,context.accountId,context.sessionId,context.patientId,correlationId,context.expiresAt]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
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

  /** In production, refuse to start over a superuser, BYPASSRLS or owner connection (runtime-role-guard.ts). */
  async onModuleInit(): Promise<void> {
    if (!this.verifyRuntimeRole) return;
    await assertRuntimeDatabaseRole(this.pool);
    if (this.workloadPool) await assertRuntimeDatabaseRole(this.workloadPool);
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
