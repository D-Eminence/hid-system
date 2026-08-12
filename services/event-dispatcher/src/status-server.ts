import { createServer, type Server } from 'node:http';
import type { EventDispatcherConfig } from './config';
import type { EventDispatcher } from './dispatcher';
import type { DeliveryMetrics, DeliveryRepository } from './types';

const ZERO_METRICS: DeliveryMetrics = { pendingCount: 0, claimedCount: 0,
  retryScheduledCount: 0, deliveredCount: 0, terminalFailureCount: 0,
  oldestPendingAgeSeconds: 0, dispatchSuccessCount: 0, dispatchFailureCount: 0,
  retryCount: 0, averageDispatchLatencyMs: 0 };

export class DispatcherStatusServer {
  private server: Server | null = null;
  constructor(private readonly config: EventDispatcherConfig,
    private readonly dispatcher: EventDispatcher | null,
    private readonly repository: DeliveryRepository | null) {}

  async start(): Promise<void> {
    this.server = createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      try {
        if (request.method !== 'GET') { this.json(response, 405, { code: 'METHOD_NOT_ALLOWED' }); return; }
        if (request.url === '/api/v1/health/live') {
          this.json(response, 200, { status: 'live', enabled: this.config.EVENT_DISPATCHER_ENABLED }); return;
        }
        if (request.url === '/api/v1/health/ready') {
          const readiness = await dispatcherReadiness(this.config, this.dispatcher, this.repository);
          this.json(response, readiness.statusCode, readiness.body);
          return;
        }
        if (request.url === '/metrics') {
          const metrics = this.repository ? await this.repository.metrics() : ZERO_METRICS;
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
          response.end(prometheus(metrics, this.dispatcher?.status().acceptingDispatch ?? false));
          return;
        }
        const operations = request.url ? new URL(request.url, 'http://status.local') : null;
        if (operations?.pathname === '/api/v1/operations/failures') {
          const requested = Number(operations.searchParams.get('limit') ?? '50');
          const limit = Number.isInteger(requested) && requested >= 1 && requested <= 100 ? requested : 50;
          const items = this.repository ? await this.repository.terminalFailures(limit) : [];
          this.json(response, 200, { items });
          return;
        }
        this.json(response, 404, { code: 'NOT_FOUND' });
      } catch (_error) {
        this.json(response, 503, { status: 'not_ready', code: 'STATUS_DEPENDENCY_UNAVAILABLE' });
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.config.EVENT_DISPATCHER_STATUS_PORT,
        this.config.EVENT_DISPATCHER_STATUS_HOST, resolve);
    });
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server?.close((error) => error ? reject(error) : resolve()));
    this.server = null;
  }

  private json(response: import('node:http').ServerResponse, status: number,
    value: Readonly<Record<string, unknown>>): void {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(value));
  }
}

export async function dispatcherReadiness(config: EventDispatcherConfig,
  dispatcher: EventDispatcher | null, repository: DeliveryRepository | null): Promise<Readonly<{
    statusCode: 200 | 503;
    body: Readonly<Record<string, unknown>>;
  }>> {
  const status = dispatcher?.status();
  if (!config.EVENT_DISPATCHER_ENABLED || !status?.startupReady
      || !status.acceptingDispatch || !repository || !dispatcher) {
    return { statusCode: 503, body: { status: 'not_ready', enabled: config.EVENT_DISPATCHER_ENABLED,
      acceptingDispatch: status?.acceptingDispatch ?? false,
      dependencies: { database: 'unknown', transport: {
        name: status?.transport ?? config.EVENT_DISPATCHER_TRANSPORT, status: 'unknown',
      } } } };
  }
  let database: 'ready' | 'unavailable' = 'ready';
  let transport: 'ready' | 'unavailable' = 'ready';
  await repository.checkReadiness().catch(() => { database = 'unavailable'; });
  await dispatcher.checkTransportReadiness().catch(() => { transport = 'unavailable'; });
  const ready = database === 'ready' && transport === 'ready';
  return { statusCode: ready ? 200 : 503, body: { status: ready ? 'ready' : 'not_ready',
    enabled: true, acceptingDispatch: true,
    dependencies: { database, transport: { name: status.transport, status: transport } } } };
}

function prometheus(metrics: DeliveryMetrics, accepting: boolean): string {
  const values: Readonly<Record<string, number>> = {
    hid_event_dispatcher_accepting_dispatch: accepting ? 1 : 0,
    hid_event_delivery_pending: metrics.pendingCount,
    hid_event_delivery_claimed: metrics.claimedCount,
    hid_event_delivery_retry_scheduled: metrics.retryScheduledCount,
    hid_event_delivery_delivered_total: metrics.deliveredCount,
    hid_event_delivery_terminal_failures: metrics.terminalFailureCount,
    hid_event_delivery_oldest_pending_age_seconds: metrics.oldestPendingAgeSeconds,
    hid_event_dispatch_success_total: metrics.dispatchSuccessCount,
    hid_event_dispatch_failure_total: metrics.dispatchFailureCount,
    hid_event_dispatch_retry_total: metrics.retryCount,
    hid_event_dispatch_latency_milliseconds_avg: metrics.averageDispatchLatencyMs,
  };
  return Object.entries(values).map(([name, value]) => `${name} ${value}`).join('\n') + '\n';
}
