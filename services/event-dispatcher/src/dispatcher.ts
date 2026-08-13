import { eventEnvelope } from './event-contracts';
import type { EventDispatcherConfig } from './config';
import { EventContractFailure, type ClaimedEvent, type DeliveryRepository,
  type EventTransport, type HidEventEnvelopeV1, type SafeDeliveryFailure,
  type TransportResult } from './types';

export class EventDispatcher {
  private readonly stopRequested = new AbortController();
  private readonly transportAbort = new AbortController();
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private acceptingDispatch = false;
  private startupReady = false;

  constructor(private readonly config: EventDispatcherConfig,
    private readonly repository: DeliveryRepository, private readonly transport: EventTransport,
    private readonly dispatcherId: string, private readonly random: () => number = Math.random,
    private readonly now: () => Date = () => new Date()) {}

  async run(): Promise<void> {
    try {
      await this.repository.checkReadiness();
      await this.transport.checkReadiness(this.transportAbort.signal);
      this.startupReady = true;
      this.acceptingDispatch = true;
      this.log('info', 'event_dispatcher.ready', { transport: this.transport.name,
        acceptingDispatch: true, concurrency: this.config.EVENT_DISPATCHER_CONCURRENCY });
      await Promise.all(Array.from({ length: this.config.EVENT_DISPATCHER_CONCURRENCY },
        (_, index) => this.dispatchLoop(index)));
    } finally {
      this.acceptingDispatch = false;
      if (this.drainTimer) clearTimeout(this.drainTimer);
      this.drainTimer = null;
      await this.repository.close();
      this.log('info', 'event_dispatcher.stopped', { acceptingDispatch: false });
    }
  }

  stop(): void {
    if (this.stopRequested.signal.aborted) return;
    this.acceptingDispatch = false;
    this.log('info', 'event_dispatcher.draining', { acceptingDispatch: false });
    this.stopRequested.abort(new Error('dispatcher shutdown requested'));
    this.drainTimer = setTimeout(() => {
      this.log('error', 'event_dispatcher.drain_timeout', {
        acceptingDispatch: false, drainTimeoutMs: this.config.EVENT_DISPATCHER_DRAIN_TIMEOUT_MS,
      });
      this.transportAbort.abort(new Error('dispatcher drain timeout'));
    }, this.config.EVENT_DISPATCHER_DRAIN_TIMEOUT_MS);
    this.drainTimer.unref();
  }

  status(): Readonly<{ acceptingDispatch: boolean; startupReady: boolean; transport: string }> {
    return { acceptingDispatch: this.acceptingDispatch, startupReady: this.startupReady,
      transport: this.transport.name };
  }

  async checkTransportReadiness(): Promise<void> {
    if (!this.startupReady || !this.acceptingDispatch || this.stopRequested.signal.aborted) {
      throw new Error('Dispatcher is not accepting work');
    }
    await this.transport.checkReadiness(this.transportAbort.signal);
  }

  async processOnce(): Promise<number> {
    const events = await this.repository.claim(this.dispatcherId);
    if (events.length === 0) return 0;
    try {
      const metrics = await this.repository.metrics();
      this.log('info', 'event_dispatcher.backlog', {
        pendingCount: metrics.pendingCount,
        oldestPendingAgeSeconds: metrics.oldestPendingAgeSeconds,
        drainRate: events.length,
      });
    } catch (error) {
      this.log('warn', 'event_dispatcher.metrics_unavailable', { code: safeErrorCode(error) });
    }
    const deliverable: Array<{ claimed: ClaimedEvent; envelope: HidEventEnvelopeV1 }> = [];
    for (const event of events) {
      try {
        deliverable.push({ claimed: event, envelope: eventEnvelope(event) });
      } catch (error) {
        const failure = error instanceof EventContractFailure ? error
          : new EventContractFailure('EVENT_CONTRACT_VALIDATION_FAILED',
            'Event contract validation failed unexpectedly');
        await this.persistFailure(event, 'contract-validator', failure);
      }
    }
    if (deliverable.length === 0) return events.length;
    let results: readonly TransportResult[];
    const transportStartedAt = Date.now();
    try {
      results = await this.transport.publish(deliverable.map((item) => item.envelope),
        this.transportAbort.signal);
    } catch (_error) {
      const failure = { code: 'TRANSPORT_ADAPTER_FAILURE',
        safeSummary: 'Event transport adapter failed unexpectedly', retryable: true };
      await Promise.all(deliverable.map((item) => this.persistFailure(item.claimed,
        this.transport.name, failure, Date.now() - transportStartedAt)));
      return events.length;
    }
    const transportDurationMs = Math.max(0, Date.now() - transportStartedAt);
    const byEvent = new Map(results.map((result) => [result.eventId, result]));
    await Promise.all(deliverable.map(async ({ claimed }) => {
      const result = byEvent.get(claimed.eventId);
      if (!result) {
        await this.persistFailure(claimed, this.transport.name, {
          code: 'TRANSPORT_PROTOCOL_ERROR', safeSummary: 'Event transport omitted an event result',
          retryable: true,
        }, transportDurationMs);
        return;
      }
      if (!result.accepted) {
        await this.persistFailure(claimed, this.transport.name, result.failure, transportDurationMs);
        return;
      }
      try {
        await this.repository.delivered(claimed, this.transport.name, result.messageId);
        this.log('info', 'event_dispatcher.delivered', { ...this.eventFields(claimed),
          transport: this.transport.name, durationMs: transportDurationMs });
      } catch (error) {
        // The transport may already have accepted the event. Never rewrite this
        // as a transport failure; leave the lease to expire for at-least-once redelivery.
        this.log('error', 'event_dispatcher.delivery_state_persistence_failed', {
          ...this.eventFields(claimed), code: safeErrorCode(error),
          transport: this.transport.name, durationMs: transportDurationMs,
        });
      }
    }));
    return events.length;
  }

  private async dispatchLoop(workerIndex: number): Promise<void> {
    let consecutiveErrors = 0;
    while (!this.stopRequested.signal.aborted) {
      try {
        const count = await this.processOnce();
        consecutiveErrors = 0;
        if (count === 0) await delay(this.config.EVENT_DISPATCHER_POLL_MS, this.stopRequested.signal);
      } catch (error) {
        if (this.stopRequested.signal.aborted) break;
        consecutiveErrors += 1;
        this.log('error', 'event_dispatcher.loop_error', { workerIndex,
          code: safeErrorCode(error), consecutiveErrors });
        const cap = Math.min(30_000, this.config.EVENT_DISPATCHER_POLL_MS
          * (2 ** Math.min(consecutiveErrors, 5)));
        await delay(cap + Math.floor(this.random() * Math.min(cap, 1_000)), this.stopRequested.signal)
          .catch(() => undefined);
      }
    }
  }

  private async persistFailure(event: ClaimedEvent, transport: string,
    failure: SafeDeliveryFailure, durationMs?: number): Promise<void> {
    const nextAttemptAt = failure.retryable ? this.nextAttemptAt(event.attemptCount) : null;
    try {
      const outcome = await this.repository.failed(event, transport, failure, nextAttemptAt);
      this.log(outcome === 'retry_scheduled' ? 'warn' : 'error',
        outcome === 'retry_scheduled' ? 'event_dispatcher.retry_scheduled'
          : 'event_dispatcher.failed_terminal', { ...this.eventFields(event), code: failure.code,
          transport, ...(durationMs === undefined ? {} : { durationMs }) });
    } catch (error) {
      this.log('error', 'event_dispatcher.failure_state_persistence_failed', {
        ...this.eventFields(event), code: safeErrorCode(error),
        transport, ...(durationMs === undefined ? {} : { durationMs }),
      });
    }
  }

  private nextAttemptAt(attempt: number): Date {
    const exponent = Math.max(0, Math.min(attempt - 1, 30));
    const cap = Math.min(this.config.EVENT_DISPATCHER_RETRY_MAX_MS,
      this.config.EVENT_DISPATCHER_RETRY_BASE_MS * (2 ** exponent));
    const jitter = Math.floor(cap / 2) + Math.floor(this.random() * Math.ceil(cap / 2));
    return new Date(this.now().getTime() + jitter);
  }

  private eventFields(event: ClaimedEvent): Readonly<Record<string, unknown>> {
    return { eventId: event.eventId, eventType: event.eventType,
      eventVersion: event.eventVersion, producer: event.producer,
      correlationId: event.correlationId, attempt: event.attemptCount };
  }

  private log(level: string, event: string, fields: Readonly<Record<string, unknown>>): void {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields });
    (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
  }
}

function safeErrorCode(error: unknown): string {
  const candidate = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof candidate === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(candidate)
    ? candidate : 'UNKNOWN';
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}
