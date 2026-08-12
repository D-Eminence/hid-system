import { Injectable } from '@nestjs/common';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';

interface ServiceTarget { name: string; url?: string }

@Injectable()
export class AdminOperationsService {
  private readonly environment = getEnvironment();

  async services(context: DataAccessContext) {
    const targets: ServiceTarget[] = [
      { name: 'Identity', url: this.environment.ADMIN_IDENTITY_STATUS_URL },
      { name: 'EHR', url: this.environment.ADMIN_EHR_STATUS_URL },
      { name: 'Lab', url: this.environment.ADMIN_LAB_STATUS_URL },
      { name: 'Pharmacy', url: this.environment.ADMIN_PHARMACY_STATUS_URL },
      { name: 'OCR', url: this.environment.ADMIN_OCR_STATUS_URL },
      { name: 'Outreach', url: this.environment.ADMIN_OUTREACH_STATUS_URL },
      { name: 'Event Dispatcher', url: this.environment.ADMIN_EVENT_DISPATCHER_STATUS_URL },
    ];
    const checkedAt = new Date().toISOString();
    const services = await Promise.all(targets.map((target) => this.check(target, checkedAt, context.correlationId)));
    services.push({ service: 'OCR Worker', live: null, ready: null, state: 'not_observable',
      checkedAt, code: 'NO_STATUS_ENDPOINT' });
    return { checkedAt, services };
  }

  async events(context: DataAccessContext) {
    const baseUrl = this.environment.ADMIN_EVENT_DISPATCHER_STATUS_URL;
    if (!baseUrl) return { state: 'unavailable', code: 'DISPATCHER_NOT_CONFIGURED', metrics: null, failures: [] };
    const [metrics, failures] = await Promise.all([
      this.fetchText(new URL('/metrics', baseUrl).toString(), context.correlationId),
      this.fetchJson(new URL('/api/v1/operations/failures?limit=50', baseUrl).toString(), context.correlationId),
    ]);
    if (!metrics.ok) return { state: 'unavailable', code: metrics.code, metrics: null, failures: [] };
    return {
      state: failures.ok ? 'available' : 'degraded',
      code: failures.ok ? null : failures.code,
      metrics: this.parseMetrics(metrics.body),
      failures: failures.ok ? this.safeFailures(failures.body) : [],
    };
  }

  private async check(target: ServiceTarget, checkedAt: string, correlationId: string) {
    if (!target.url) return { service: target.name, live: null, ready: null,
      state: 'not_configured', checkedAt, code: 'STATUS_URL_NOT_CONFIGURED' };
    const result = await this.fetchJson(new URL('/api/v1/health/ready', target.url).toString(), correlationId);
    if (!result.ok) return { service: target.name, live: null, ready: false,
      state: 'unavailable', checkedAt, code: result.code };
    const body = this.record(result.body);
    const ready = body?.status === 'ready';
    return { service: target.name, live: true, ready, state: ready ? 'ready' : 'degraded',
      checkedAt, code: ready ? null : this.safeCode(body?.code) ?? 'DEPENDENCY_NOT_READY' };
  }

  private async fetchJson(url: string, correlationId: string): Promise<{ ok: true; body: unknown } | { ok: false; code: string }> {
    const result = await this.request(url, 'application/json', correlationId);
    if (!result.ok) return result;
    try { return { ok: true, body: JSON.parse(result.body) as unknown }; }
    catch { return { ok: false, code: 'INVALID_STATUS_RESPONSE' }; }
  }

  private fetchText(url: string, correlationId: string) { return this.request(url, 'text/plain', correlationId); }

  private async request(url: string, accept: string, correlationId: string): Promise<{ ok: true; body: string } | { ok: false; code: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.environment.ADMIN_OPERATIONS_TIMEOUT_MS);
    try {
      const response = await fetch(url, { headers: { accept, 'x-correlation-id': correlationId },
        signal: controller.signal, cache: 'no-store' });
      if (!response.ok) return { ok: false, code: `HTTP_${response.status}` };
      return { ok: true, body: await response.text() };
    } catch (error) {
      return { ok: false, code: error instanceof Error && error.name === 'AbortError'
        ? 'STATUS_TIMEOUT' : 'STATUS_UNAVAILABLE' };
    } finally { clearTimeout(timer); }
  }

  private parseMetrics(body: string) {
    const values = new Map<string, number>();
    for (const line of body.split('\n')) {
      const match = /^([a-z_][a-z0-9_]*)\s+(-?[0-9]+(?:\.[0-9]+)?)$/i.exec(line.trim());
      const name = match?.[1];
      const value = match?.[2];
      if (name && value) values.set(name, Number(value));
    }
    return {
      acceptingDispatch: values.get('hid_event_dispatcher_accepting_dispatch') === 1,
      pending: values.get('hid_event_delivery_pending') ?? 0,
      oldestPendingAgeSeconds: values.get('hid_event_delivery_oldest_pending_age_seconds') ?? 0,
      retrying: values.get('hid_event_delivery_retry_scheduled') ?? 0,
      terminalFailures: values.get('hid_event_delivery_terminal_failures') ?? 0,
      delivered: values.get('hid_event_delivery_delivered_total') ?? 0,
      dispatchSuccesses: values.get('hid_event_dispatch_success_total') ?? 0,
      dispatchFailures: values.get('hid_event_dispatch_failure_total') ?? 0,
    };
  }

  private safeFailures(value: unknown) {
    const items = this.record(value)?.items;
    if (!Array.isArray(items)) return [];
    return items.flatMap((candidate) => {
      const item = this.record(candidate);
      const eventId = this.safeText(item?.eventId, 128);
      const eventType = this.safeText(item?.eventType, 160);
      const producer = this.safeText(item?.producer, 80);
      const attemptCount = item?.attemptCount;
      const errorCode = this.safeCode(item?.errorCode);
      const errorSummary = this.safeText(item?.errorSummary, 500);
      const failedAt = this.safeText(item?.failedAt, 64);
      const nextAttemptAt = this.safeText(item?.nextAttemptAt, 64);
      const correlationId = this.safeText(item?.correlationId, 128);
      if (!eventId || !eventType || !producer || !Number.isSafeInteger(attemptCount)
          || Number(attemptCount) < 0 || !errorCode || !errorSummary || !failedAt
          || !nextAttemptAt || !correlationId) return [];
      return [{ eventId, eventType, producer, attemptCount: Number(attemptCount), errorCode,
        errorSummary, failedAt, nextAttemptAt, correlationId }];
    });
  }
  private record(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  }
  private safeCode(value: unknown): string | null {
    return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value) ? value : null;
  }
  private safeText(value: unknown, maximum: number): string | null {
    return typeof value === 'string' && value.length >= 1 && value.length <= maximum ? value : null;
  }
}
