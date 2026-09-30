import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { QoreIdVerificationAdapter } from '../identity/qoreid-verification.adapter';
import { IntegrationRuntimeService } from './integration-runtime.service';

interface ProviderRow extends QueryResultRow {
  provider: string; display_name: string; enabled: boolean; runtime_control: boolean;
  configuration: Record<string, string>; credential_source: string; last_test_status: string | null;
  last_tested_at: Date | null; last_successful_test_at: Date | null; last_failed_test_at: Date | null;
  row_version: string; capabilities: string[];
}
interface RouteRow extends QueryResultRow {
  capability: string; active_provider: string; fallback_provider: string | null; row_version: string;
}
interface EventRow extends QueryResultRow {
  sequence_id: string; action: string; reason: string; actor_account_id: string;
  correlation_id: string; occurred_at: Date; capability: string | null;
}
interface ProviderCommandRow extends QueryResultRow {
  provider: string; enabled: boolean; configuration: Record<string, string>; row_version: string; replayed: boolean;
}
interface RouteCommandRow extends QueryResultRow {
  capability: string; active_provider: string; fallback_provider: string | null;
  row_version: string; replayed: boolean;
}
interface TestCommandRow extends QueryResultRow {
  provider: string; last_test_status: string; row_version: string; replayed: boolean;
}

const providerKey = /^[a-z][a-z0-9-]{1,63}$/;
const configurable = new Set(['ses', 'termii', 'meta-whatsapp', 'brevo']);
const routes = new Set(['email', 'sms', 'whatsapp']);

@Injectable()
export class IntegrationAdminService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService,
    private readonly qoreid: QoreIdVerificationAdapter,
    private readonly runtime: IntegrationRuntimeService) {}

  async list(context: DataAccessContext) {
    try {
      return await this.database.withTransaction(context, async (client) => {
        const providers = await client.query<ProviderRow>('select * from platform.admin_list_integration_providers()');
        const routing = await client.query<RouteRow>('select * from platform.admin_list_integration_routes()');
        return this.catalog(providers.rows, routing.rows);
      }, { readOnly: true });
    } catch (error) { throw this.mapError(error); }
  }

  async get(context: DataAccessContext, provider: string) {
    this.assertProvider(provider);
    const catalog = await this.list(context);
    const found = catalog.items.find((item) => item.provider === provider);
    if (!found) throw new DomainProblem(404, 'INTEGRATION_NOT_FOUND', 'Integration was not found');
    return found;
  }

  async auditHistory(context: DataAccessContext, provider: string) {
    this.assertProvider(provider);
    await this.get(context, provider);
    try {
      return await this.database.withTransaction(context, async (client) => {
        const result = await client.query<EventRow>(
          'select * from platform.admin_list_integration_events($1,$2)', [provider, 100]);
        return { items: result.rows.map((row) => ({ eventId: String(row.sequence_id), action: row.action,
          occurredAt: new Date(row.occurred_at).toISOString(), actorSubject: null,
          actorAccountId: row.actor_account_id, correlationId: row.correlation_id,
          capability: row.capability, reason: row.reason, outcome: 'success' })) };
      }, { readOnly: true });
    } catch (error) { throw this.mapError(error); }
  }

  async changeProvider(context: DataAccessContext, provider: string, expectedVersion: number,
    action: 'enable' | 'pause' | 'configure', reason: string,
    requestedConfiguration: Record<string, unknown> | undefined, idempotencyKey: string) {
    this.assertProvider(provider);
    const current = await this.get(context, provider);
    if (action === 'configure' && !configurable.has(provider)) {
      throw new DomainProblem(409, 'INTEGRATION_CONFIGURATION_EXTERNAL',
        'This integration has no dashboard-editable settings');
    }
    if (action === 'enable' && provider === 'qoreid' && !this.qoreidConfigured()) {
      throw new DomainProblem(409, 'INTEGRATION_CREDENTIAL_UNAVAILABLE',
        'QoreID requires approved deployment configuration and credentials');
    }
    const enabled = action === 'enable' ? true : action === 'pause' ? false : current.enabled;
    const configuration = action === 'configure' ? requestedConfiguration : current.configuration;
    const digest = requestDigest('platform.integration.provider.update',
      { provider, expectedVersion, action, enabled, configuration, reason });
    try {
      return await this.database.withTransaction(context, async (client) => {
        const result = await client.query<ProviderCommandRow>(
          'select * from platform.admin_set_integration_provider($1,$2,$3,$4::jsonb,$5,$6,$7,$8)',
          [provider, expectedVersion, enabled, JSON.stringify(configuration), action, reason, idempotencyKey, digest]);
        const row = result.rows[0];
        if (!row) throw new DomainProblem(503, 'INTEGRATION_UNAVAILABLE', 'Integration update was unavailable');
        if (!row.replayed) await this.recordAudit(client, context, `admin.integration.${action}`, provider, reason,
          { enabled: row.enabled, version: Number(row.row_version) });
        return { provider: row.provider, enabled: row.enabled, configuration: row.configuration,
          version: Number(row.row_version), replayed: row.replayed };
      });
    } catch (error) { throw this.mapError(error); }
  }

  async changeRoute(context: DataAccessContext, capability: string, expectedVersion: number,
    action: 'select' | 'fallback', provider: string | null, reason: string, idempotencyKey: string) {
    if (!routes.has(capability) || (provider !== null && !providerKey.test(provider))) {
      throw new DomainProblem(400, 'INTEGRATION_ROUTE_INVALID', 'Provider route is invalid');
    }
    const catalog = await this.list(context);
    const current = catalog.capabilities.find((item) => item.capability === capability);
    if (!current) throw new DomainProblem(404, 'INTEGRATION_ROUTE_NOT_FOUND', 'Provider route was not found');
    const active = action === 'select' ? provider : current.activeProvider;
    const fallback = action === 'fallback' ? provider : current.fallbackProvider;
    if (!active) throw new DomainProblem(400, 'INTEGRATION_ROUTE_INVALID', 'An active provider is required');
    const digest = requestDigest('platform.integration.route.update',
      { capability, expectedVersion, action, active, fallback, reason });
    try {
      return await this.database.withTransaction(context, async (client) => {
        const result = await client.query<RouteCommandRow>(
          'select * from platform.admin_set_integration_route($1,$2,$3,$4,$5,$6,$7,$8)',
          [capability, expectedVersion, active, fallback, action, reason, idempotencyKey, digest]);
        const row = result.rows[0];
        if (!row) throw new DomainProblem(503, 'INTEGRATION_UNAVAILABLE', 'Provider route was unavailable');
        if (!row.replayed) await this.recordAudit(client, context, `admin.integration.${action}`,
          capability, reason, { activeProvider: row.active_provider,
            fallbackProvider: row.fallback_provider, version: Number(row.row_version) });
        return { capability: row.capability, activeProvider: row.active_provider,
          fallbackProvider: row.fallback_provider, version: Number(row.row_version), replayed: row.replayed };
      });
    } catch (error) { throw this.mapError(error); }
  }

  async test(context: DataAccessContext, provider: string, expectedVersion: number,
    reason: string, idempotencyKey: string) {
    if (provider !== 'qoreid') {
      throw new DomainProblem(409, 'INTEGRATION_TEST_UNSUPPORTED',
        'This provider has no approved non-sending connection test');
    }
    if (!this.qoreidConfigured()) {
      throw new DomainProblem(409, 'INTEGRATION_CREDENTIAL_UNAVAILABLE',
        'QoreID requires approved deployment configuration and credentials');
    }
    const digest = requestDigest('platform.integration.provider.test',
      { provider, expectedVersion, reason });
    try {
      // This read-only preflight checks permission, idempotent replay and the
      // row version without holding a pool client during quota reservation.
      const existing = await this.database.withTransaction(context,
        (client) => this.connectionTestPreflight(client, provider, expectedVersion, idempotencyKey, digest),
        { readOnly: true });
      if (existing) return existing;
      const keyHash = createHash('sha256').update('integration.provider.test\0')
        .update(idempotencyKey).digest('hex');
      await this.runtime.consumeQuota(context, 'connection_test', null, keyHash, digest);
      return await this.database.withTransaction(context, async (client) => {
        // Serialize equal idempotency keys across the bounded token-only probe.
        // Replays return the prior result without another provider request.
        await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',
          [`${context.actor.accountId}:integration-test:${idempotencyKey}`]);
        const prior = await this.connectionTestPreflight(client, provider, expectedVersion, idempotencyKey, digest);
        if (prior) return prior;
        let status: 'healthy' | 'degraded' | 'failed' = 'healthy';
        try { await this.qoreid.testConnection(); }
        catch (error) {
          status = error instanceof DomainProblem && ['QOREID_TIMEOUT', 'QOREID_NETWORK_UNAVAILABLE',
            'QOREID_PROVIDER_UNAVAILABLE'].includes(error.code) ? 'degraded' : 'failed';
        }
        const result = await client.query<TestCommandRow>(
          'select * from platform.admin_record_integration_test($1,$2,$3,$4,$5,$6)',
          [provider, expectedVersion, status, reason, idempotencyKey, digest]);
        const row = result.rows[0];
        if (!row) throw new DomainProblem(503, 'INTEGRATION_UNAVAILABLE', 'Connection test could not be recorded');
        if (!row.replayed) await this.recordAudit(client, context, 'admin.integration.test', provider, reason,
          { status: row.last_test_status, version: Number(row.row_version) });
        return { provider: row.provider, status: row.last_test_status,
          version: Number(row.row_version), replayed: row.replayed };
      });
    } catch (error) { throw this.mapError(error); }
  }

  private async connectionTestPreflight(client: PoolClient, provider: string, expectedVersion: number,
    idempotencyKey: string, digest: string) {
    const replay = await client.query<{ response: { provider: string; status: string; version: number } | null }>(
      'select platform.admin_integration_test_replay($1,$2) as response',
      [idempotencyKey, digest]);
    const prior = replay.rows[0]?.response;
    if (prior) return { provider: prior.provider, status: prior.status,
      version: Number(prior.version), replayed: true };
    const catalog = await client.query<ProviderRow>('select * from platform.admin_list_integration_providers()');
    const current = catalog.rows.find((row) => row.provider === provider);
    if (!current) throw new DomainProblem(404, 'INTEGRATION_NOT_FOUND', 'Integration was not found');
    if (Number(current.row_version) !== expectedVersion) {
      throw new DomainProblem(409, 'VERSION_CONFLICT', 'Integration changed; reload before retrying');
    }
    return null;
  }

  private catalog(providers: ProviderRow[], routing: RouteRow[]) {
    const env = getEnvironment();
    const items = providers.map((row) => {
      const credential = row.provider === 'qoreid'
        ? { state: this.qoreidConfigured() ? 'configured' : 'missing', masked: '••••', rotationSupported: false }
        : row.credential_source === 'none'
          ? { state: 'unsupported', masked: null, rotationSupported: false }
          : { state: 'external', masked: '••••', rotationSupported: false };
      const activeCapabilities = row.capabilities.filter((capability) =>
        row.enabled && (capability === 'patient_nin' || capability === 'provider_cac'
          ? row.provider === 'qoreid' && env.QOREID_ENABLED
          : routing.some((route) => route.capability === capability &&
            (route.active_provider === row.provider || route.fallback_provider === row.provider))));
      const availableActions = ['audit',
        ...(row.runtime_control ? [row.enabled ? 'pause' : 'enable'] : []),
        ...(configurable.has(row.provider) ? ['configure'] : []),
        ...(row.provider === 'qoreid' && this.qoreidConfigured() ? ['test'] : []),
        ...(row.capabilities.some((capability) => routes.has(capability)) ? ['select', 'fallback'] : [])];
      return { provider: row.provider, name: row.display_name, capabilities: row.capabilities,
        enabled: row.enabled, health: row.last_test_status ?? 'unknown', activeCapabilities,
        version: Number(row.row_version), configuration: row.configuration,
        credential, lastTestedAt: row.last_tested_at?.toISOString() ?? null,
        lastSuccessfulTestAt: row.last_successful_test_at?.toISOString() ?? null,
        lastFailedTestAt: row.last_failed_test_at?.toISOString() ?? null, availableActions };
    });
    return { items, capabilities: routing.map((route) => ({ capability: route.capability,
      activeProvider: route.active_provider, fallbackProvider: route.fallback_provider,
      eligibleProviders: providers.filter((row) => row.runtime_control &&
        row.capabilities.includes(route.capability)).map((row) => row.provider),
      version: Number(route.row_version) })) };
  }

  private qoreidConfigured(): boolean {
    const env = getEnvironment();
    return env.QOREID_ENABLED && Boolean(env.QOREID_CLIENT_ID && env.QOREID_CLIENT_SECRET);
  }

  private assertProvider(provider: string): void {
    if (!providerKey.test(provider)) {
      throw new DomainProblem(400, 'INTEGRATION_PROVIDER_INVALID', 'Provider key is invalid');
    }
  }

  private async recordAudit(client: PoolClient, context: DataAccessContext,
    action: string, resourceId: string, reason: string, details: Record<string, unknown>) {
    await this.audit.recordWithClient(client, {
      correlationId: context.correlationId, actorType: 'staff', actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId, facilityId: context.facilityId,
      action, resourceType: 'provider-integration', resourceId, outcome: 'success',
      purposeOfUse: context.purposeOfUse, reason, details,
    });
  }

  private mapError(error: unknown): DomainProblem {
    if (error instanceof DomainProblem) return error;
    const message = typeof error === 'object' && error && 'message' in error ? String(error.message) : '';
    if (message.includes('ADMIN_PERMISSION_DENIED')) return new DomainProblem(403, 'PERMISSION_DENIED', 'Integration administration is not permitted');
    if (message.includes('ADMIN_VERSION_CONFLICT')) return new DomainProblem(409, 'VERSION_CONFLICT', 'Integration changed; reload before retrying');
    if (message.includes('ADMIN_IDEMPOTENCY_CONFLICT')) return new DomainProblem(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was used for another command');
    if (message.includes('ADMIN_INTEGRATION_NOT_FOUND') || message.includes('ADMIN_CAPABILITY_NOT_FOUND')) return new DomainProblem(404, 'INTEGRATION_NOT_FOUND', 'Integration was not found');
    if (message.includes('ADMIN_NO_STATE_CHANGE')) return new DomainProblem(409, 'INTEGRATION_UNCHANGED', 'Integration already has the requested state');
    if (message.includes('ADMIN_INTEGRATION_INFRASTRUCTURE_CONTROL')) return new DomainProblem(409, 'INTEGRATION_INFRASTRUCTURE_CONTROL', 'This integration requires infrastructure control');
    if (message.includes('ADMIN_INCOMPATIBLE_PROVIDER')) return new DomainProblem(400, 'INTEGRATION_PROVIDER_INCOMPATIBLE', 'Provider does not support or is not enabled for this capability');
    if (message.includes('ADMIN_INVALID')) return new DomainProblem(400, 'INTEGRATION_INVALID', 'Integration command is invalid');
    return new DomainProblem(503, 'INTEGRATION_UNAVAILABLE', 'Integration management is unavailable');
  }
}
