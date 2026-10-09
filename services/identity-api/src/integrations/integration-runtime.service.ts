import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../common/problem';
import type { AccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';

interface RuntimeProviderRow extends QueryResultRow {
  enabled: boolean;
  configuration: Record<string, string>;
}

interface RuntimeRouteRow extends QueryResultRow {
  active_provider: string;
  fallback_provider: string | null;
}

export interface OtpDeliveryPlan {
  capability: 'email' | 'sms' | 'whatsapp';
  primary: 'ses' | 'termii' | 'meta-whatsapp' | 'brevo';
  fallback: 'ses' | 'termii' | 'meta-whatsapp' | 'brevo' | null;
  configuration: Record<string, Record<string, string>>;
}

const otpProviders = new Set(['ses', 'termii', 'meta-whatsapp', 'brevo']);
export type QoreIdQuotaOperation = 'patient_nin' | 'existing_cac' | 'application_cac' | 'connection_test';

/** The database is the decision point for new provider requests. Never cache a
 * pause decision: an administrator's committed change must affect new work. */
@Injectable()
export class IntegrationRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntegrationRuntimeService.name);
  private pruneTimer?: NodeJS.Timeout;
  private pruning = false;
  constructor(private readonly database: DatabaseService) {}

  onModuleInit(): void {
    void this.pruneExpiredQuotaRows();
    this.pruneTimer = setInterval(() => void this.pruneExpiredQuotaRows(), 60 * 60 * 1000);
    this.pruneTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  private async pruneExpiredQuotaRows(): Promise<void> {
    if (this.pruning) return;
    this.pruning = true;
    try {
      await this.database.withSystemTransaction(`quota-prune-${randomUUID()}`, async (client) => {
        await client.query('select platform.prune_verification_quotas()');
      });
    } catch {
      // No SQL diagnostics or identifiers may enter service logs.
      this.logger.warn('Verification quota retention cleanup is unavailable');
    } finally {
      this.pruning = false;
    }
  }

  async assertAvailable(provider: string, capability: string): Promise<void> {
    const state = await this.provider(provider, capability);
    if (!state?.enabled) {
      throw new DomainProblem(503, 'INTEGRATION_PAUSED', 'External verification is temporarily unavailable');
    }
  }

  async consumePatientQuota(correlationId: string, subject: string, sessionId: string): Promise<void> {
    try {
      await this.database.withSystemTransaction(correlationId, async (client) => {
        await client.query("select set_config('app.actor_subject',$1,true)", [subject]);
        await this.consumeQuotaWithClient(client, 'patient_nin', null, sessionId);
      });
    } catch (error) { throw this.quotaError(error); }
  }

  async consumeQuota(context: AccessContext,
    operation: 'existing_cac' | 'application_cac' | 'connection_test',
    targetId: string | null = null, idempotencyHash: string | null = null,
    requestSha256: string | null = null): Promise<void> {
    try {
      await this.database.withTransaction(context, (client) =>
        this.consumeQuotaWithClient(client, operation, targetId, null, idempotencyHash, requestSha256));
    } catch (error) { throw this.quotaError(error); }
  }

  /** Accountless provider self-enrollment has no account to charge. Its CAC
   * lookup is charged to the keyed client-network digest and the application's
   * daily limit (0063); the account-scoped operations above are unchanged. */
  async consumeSelfServiceCacQuota(correlationId: string, applicationId: string,
    networkDigest: string): Promise<void> {
    let admitted: boolean | undefined;
    try {
      admitted = await this.database.withSystemTransaction(correlationId, async (client) => {
        const result = await client.query<{ admitted: boolean }>(
          'select platform.consume_self_service_cac_quota($1,$2) as admitted', [applicationId, networkDigest]);
        return result.rows[0]?.admitted;
      });
    } catch (error) { throw this.quotaError(error); }
    // A denial is committed with its audit event, then refused here.
    if (admitted === false) throw this.quotaError({ code: 'P4290' });
    if (admitted !== true) throw this.quotaError(undefined);
  }

  async consumeQuotaWithClient(client: PoolClient, operation: QoreIdQuotaOperation,
    targetId: string | null = null, sessionId: string | null = null,
    idempotencyHash: string | null = null, requestSha256: string | null = null): Promise<void> {
    try {
      await client.query('select platform.consume_qoreid_quota($1,$2,$3,$4,$5)',
        [operation, targetId, sessionId, idempotencyHash, requestSha256]);
    } catch (error) { throw this.quotaError(error); }
  }

  async deliveryPlan(capability: OtpDeliveryPlan['capability']): Promise<OtpDeliveryPlan> {
    let route: RuntimeRouteRow | undefined;
    try {
      const result = await this.database.query<RuntimeRouteRow>(
        'select * from platform.integration_runtime_route($1)', [capability]);
      route = result.rows[0];
    } catch {
      throw this.unavailable();
    }
    if (!route || !otpProviders.has(route.active_provider) ||
      (route.fallback_provider !== null && !otpProviders.has(route.fallback_provider))) {
      throw this.unavailable();
    }
    const [selected, fallback] = await Promise.all([
      this.provider(route.active_provider, capability),
      route.fallback_provider ? this.provider(route.fallback_provider, capability) : Promise.resolve(undefined),
    ]);
    const fallbackReady = route.fallback_provider !== null && fallback?.enabled === true;
    const primary = selected?.enabled === true ? route.active_provider
      : fallbackReady ? route.fallback_provider : null;
    if (!primary) throw this.unavailable();
    return {
      capability,
      primary: primary as OtpDeliveryPlan['primary'],
      fallback: primary === route.active_provider && fallbackReady
        ? route.fallback_provider as OtpDeliveryPlan['fallback'] : null,
      configuration: {
        [primary]: primary === route.active_provider ? selected!.configuration : fallback!.configuration,
        ...(primary === route.active_provider && fallbackReady
          ? { [route.fallback_provider!]: fallback!.configuration } : {}),
      },
    };
  }

  private async provider(provider: string, capability: string): Promise<RuntimeProviderRow | undefined> {
    try {
      const result = await this.database.query<RuntimeProviderRow>(
        'select * from platform.integration_runtime_provider($1,$2)', [provider, capability]);
      return result.rows[0];
    } catch {
      throw this.unavailable();
    }
  }

  private unavailable(): DomainProblem {
    return new DomainProblem(503, 'INTEGRATION_UNAVAILABLE', 'Delivery provider is temporarily unavailable');
  }

  private quotaError(error: unknown): DomainProblem {
    if (error instanceof DomainProblem) return error;
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'P4290') {
      return new DomainProblem(429, 'VERIFICATION_QUOTA_EXCEEDED',
        'Verification request limit reached; try again later');
    }
    if (code === 'P4090') {
      return new DomainProblem(409, 'INTEGRATION_TEST_ALREADY_ATTEMPTED',
        'A connection test with this idempotency key is already in progress or requires a new key');
    }
    if (code === '42501') {
      return new DomainProblem(403, 'PERMISSION_DENIED', 'Verification is not permitted');
    }
    return new DomainProblem(503, 'VERIFICATION_QUOTA_UNAVAILABLE',
      'Verification request limit is temporarily unavailable');
  }
}
