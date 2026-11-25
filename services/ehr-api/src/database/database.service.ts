import { Injectable, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
import { getEnvironment } from '../config/environment';
import type { DataAccessContext } from '../common/request-context';

/**
 * 0133 D13 and D14 (owner's Q120 B and Q121 A): a staff session that sets
 * app.own_facility_work to this value gets 0133's rules. In ehr-api it
 * switches the order-route send and its resend flag to D14's rule: until
 * this hospital's own pharmacy has dispensed a prescription it holds, the
 * prescription can still be sent to an outside pharmacy, and the send
 * withdraws the own item ("sent elsewhere"). This image always sets it, in
 * withTransaction's staff transactions only (never withStaffTransaction's,
 * which reads no order route, nor a patient, system or workload one). An
 * older image never sets it, so it keeps ORDER_ROUTE_ORDER_IN_WORK for any
 * prescription with a work item here, whichever schema it meets. On a
 * schema without 0133 the setting is unused.
 */
export const OWN_FACILITY_WORK = '0133';

/**
 * 0142 D2 (EHR-C8b): a staff session that sets app.vitals_status to this
 * value reads vitals readings marked entered in error (with their status,
 * which this image filters as the contract says); every other session, an
 * older image's above all, never sees them. Set beside OWN_FACILITY_WORK, in
 * withTransaction's staff transactions only (never withStaffTransaction's,
 * which reads no vitals). On a schema without 0142 the setting is unused.
 */
export const VITALS_STATUS_AWARE = '0142';

export interface TransactionOptions {
  readOnly?: boolean;
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
}

/** Who a staff transaction runs as (withStaffTransaction): no patient, no purpose of use. */
export interface StaffTransactionContext {
  subject: string;
  facilityId: string;
  membershipId: string;
  correlationId: string;
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
           set_config('app.purpose_of_use', $5, true),
           set_config('app.own_facility_work', $6, true),
           set_config('app.vitals_status', $7, true)`,
        [
          context.actor.subject,
          context.facilityId,
          context.correlationId,
          context.membershipId,
          context.purposeOfUse,
          OWN_FACILITY_WORK,
          VITALS_STATUS_AWARE,
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

  /**
   * A staff member's own work that reads no patient (ORD-9's recent
   * diagnoses, 0153): the actor, facility and membership the guards
   * established, and no purpose of use, as there is no patient. It sets
   * neither app.own_facility_work nor app.vitals_status: the recent list
   * reads no order route and no vitals.
   */
  async withStaffTransaction<Result>(
    staff: StaffTransactionContext,
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `select
           set_config('app.actor_subject', $1, true),
           set_config('app.facility_id', $2, true),
           set_config('app.correlation_id', $3, true),
           set_config('app.membership_id', $4, true)`,
        [staff.subject, staff.facilityId, staff.correlationId, staff.membershipId],
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
