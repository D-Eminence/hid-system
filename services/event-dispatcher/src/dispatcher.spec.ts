import type { EventDispatcherConfig } from './config';
import { EventDispatcher } from './dispatcher';
import type { ClaimedEvent, DeliveryRepository, EventTransport } from './types';

const config = { EVENT_DISPATCHER_CONCURRENCY: 1, EVENT_DISPATCHER_POLL_MS: 100,
  EVENT_DISPATCHER_RETRY_BASE_MS: 1_000, EVENT_DISPATCHER_RETRY_MAX_MS: 10_000,
  EVENT_DISPATCHER_DRAIN_TIMEOUT_MS: 5_000,
} as EventDispatcherConfig;
const event: ClaimedEvent = { producer: 'identity',
  eventId: '10000000-0000-4000-8000-000000000001', eventType: 'PatientRegistered',
  eventVersion: 1, occurredAt: new Date(), aggregateType: 'identity-registration-case',
  aggregateId: '20000000-0000-4000-8000-000000000001', aggregateVersion: 1,
  correlationId: 'correlation-12345678', causationId: null,
  facilityId: '30000000-0000-4000-8000-000000000001',
  patientId: '40000000-0000-4000-8000-000000000001', payload: { source: 'governed-nin-registration' },
  attemptCount: 1, claimToken: '50000000-0000-4000-8000-000000000001',
  claimExpiresAt: new Date(Date.now() + 60_000) };

function harness(events: ClaimedEvent[] = [event]) {
  const repository: jest.Mocked<DeliveryRepository> = { checkReadiness: jest.fn(),
    claim: jest.fn().mockResolvedValue(events), delivered: jest.fn(),
    failed: jest.fn().mockResolvedValue('retry_scheduled'), metrics: jest.fn().mockResolvedValue({
      pendingCount: events.length, claimedCount: events.length, retryScheduledCount: 0,
      deliveredCount: 0, terminalFailureCount: 0, oldestPendingAgeSeconds: 1,
      dispatchSuccessCount: 0, dispatchFailureCount: 0, retryCount: 0,
      averageDispatchLatencyMs: 0,
    }),
    terminalFailures: jest.fn().mockResolvedValue([]), close: jest.fn() };
  const transport: jest.Mocked<EventTransport> = { name: 'test-transport', checkReadiness: jest.fn(),
    publish: jest.fn().mockResolvedValue(events.map((item) => ({ eventId: item.eventId,
      accepted: true as const, messageId: `accepted:${item.eventId}` }))) };
  const dispatcher = new EventDispatcher(config, repository, transport, 'dispatcher-test', () => 0.5,
    () => new Date('2026-08-11T10:00:00.000Z'));
  return { repository, transport, dispatcher };
}

describe('event dispatcher processing', () => {
  let stdout: jest.SpyInstance; let stderr: jest.SpyInstance;
  beforeEach(() => { stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true); });
  afterEach(() => { stdout.mockRestore(); stderr.mockRestore(); });

  it('marks each accepted transport result independently', async () => {
    const second = { ...event, eventId: '10000000-0000-4000-8000-000000000002',
      claimToken: '50000000-0000-4000-8000-000000000002' };
    const { repository, transport, dispatcher } = harness([event, second]);
    transport.publish.mockResolvedValue([{ eventId: event.eventId, accepted: true, messageId: 'provider-1' },
      { eventId: second.eventId, accepted: false, failure: { code: 'EVENTBRIDGE_THROTTLED',
        safeSummary: 'Event transport temporarily rejected the event', retryable: true } }]);
    await dispatcher.processOnce();
    expect(repository.delivered).toHaveBeenCalledWith(event, 'test-transport', 'provider-1');
    expect(repository.failed).toHaveBeenCalledWith(second, 'test-transport',
      expect.objectContaining({ code: 'EVENTBRIDGE_THROTTLED' }), new Date('2026-08-11T10:00:00.750Z'));
  });

  it('preserves the publish/mark crash window by not rewriting accepted transport as failure', async () => {
    const { repository, dispatcher } = harness();
    repository.delivered.mockRejectedValue(Object.assign(new Error('db unavailable'), { code: '57P01' }));
    await dispatcher.processOnce();
    expect(repository.failed).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join(' ')).toContain('delivery_state_persistence_failed');
  });

  it('terminally records unsupported event versions without invoking transport', async () => {
    const unsupported = { ...event, eventVersion: 2 };
    const { repository, transport, dispatcher } = harness([unsupported]);
    repository.failed.mockResolvedValue('failed_terminal');
    await dispatcher.processOnce();
    expect(transport.publish).not.toHaveBeenCalled();
    expect(repository.failed).toHaveBeenCalledWith(unsupported, 'contract-validator',
      expect.objectContaining({ code: 'UNSUPPORTED_EVENT_CONTRACT', retryable: false }), null);
  });

  it('stops new claims while allowing an in-flight publish to drain', async () => {
    const { transport, dispatcher } = harness();
    let releasePublish: (() => void) | undefined;
    transport.publish.mockImplementation((_events, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      releasePublish = () => resolve([{ eventId: event.eventId, accepted: true,
        messageId: 'provider-drained' }]);
    }));
    const processing = dispatcher.processOnce();
    await new Promise((resolve) => setImmediate(resolve));
    dispatcher.stop();
    expect(releasePublish).toBeDefined();
    releasePublish?.();
    await processing;
    expect(transport.publish.mock.calls[0]?.[1].aborted).toBe(false);
  });
});
