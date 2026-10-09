import { DescribeEventBusCommand, EventBridgeClient, PutEventsCommand,
  type PutEventsResultEntry } from '@aws-sdk/client-eventbridge';
import type { EventDispatcherConfig } from './config';
import type { EventTransport, HidEventEnvelopeV1, SafeDeliveryFailure,
  TransportResult } from './types';

const RETRYABLE_ENTRY_CODES = new Set(['InternalFailure', 'InternalException',
  'ThrottlingException', 'ServiceUnavailableException']);

export class EventBridgeEventTransport implements EventTransport {
  readonly name = 'eventbridge';
  private readonly client: EventBridgeClient;
  constructor(private readonly config: EventDispatcherConfig, client?: EventBridgeClient) {
    this.client = client ?? new EventBridgeClient({ region: config.AWS_REGION, maxAttempts: 1,
      ...(config.AWS_ENDPOINT_URL ? { endpoint: config.AWS_ENDPOINT_URL } : {}) });
  }

  async checkReadiness(signal: AbortSignal): Promise<void> {
    await this.client.send(new DescribeEventBusCommand({ Name: this.busName() }),
      { abortSignal: this.signal(signal) });
  }

  async publish(events: readonly HidEventEnvelopeV1[], signal: AbortSignal): Promise<readonly TransportResult[]> {
    if (events.length < 1 || events.length > 10) throw new Error('EventBridge batch must contain 1 to 10 events');
    try {
      const response = await this.client.send(new PutEventsCommand({ Entries: events.map((event) => ({
        EventBusName: this.busName(), Source: `ng.hid.${event.producer}`,
        DetailType: `${event.type}.v${event.version}`, Time: new Date(event.occurredAt),
        Detail: JSON.stringify(event),
      })) }), { abortSignal: this.signal(signal) });
      return events.map((event, index) => this.result(event, response.Entries?.[index]));
    } catch (error) {
      const failure = classifyEventBridgeFailure(error);
      return events.map((event) => ({ eventId: event.id, accepted: false as const, failure }));
    }
  }

  private result(event: HidEventEnvelopeV1, result: PutEventsResultEntry | undefined): TransportResult {
    if (result?.EventId && !result.ErrorCode) {
      return { eventId: event.id, accepted: true, messageId: result.EventId };
    }
    const providerCode = result?.ErrorCode ?? 'MISSING_RESULT';
    const retryable = RETRYABLE_ENTRY_CODES.has(providerCode) || providerCode === 'MISSING_RESULT';
    return { eventId: event.id, accepted: false, failure: {
      code: safeProviderCode(providerCode), retryable,
      safeSummary: retryable ? 'Event transport temporarily rejected the event'
        : 'Event transport rejected the event contract or authorization',
    } };
  }

  private signal(parent: AbortSignal): AbortSignal {
    return AbortSignal.any([parent, AbortSignal.timeout(this.config.EVENT_DISPATCHER_TRANSPORT_TIMEOUT_MS)]);
  }

  private busName(): string {
    if (!this.config.EVENTBRIDGE_EVENT_BUS_NAME) throw new Error('EventBridge bus name is absent');
    return this.config.EVENTBRIDGE_EVENT_BUS_NAME;
  }
}

export function classifyEventBridgeFailure(error: unknown): SafeDeliveryFailure {
  const name = error instanceof Error ? error.name : 'Unknown';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { code: 'EVENTBRIDGE_TIMEOUT', safeSummary: 'Event transport request timed out', retryable: true };
  }
  if (['AccessDeniedException', 'UnrecognizedClientException', 'CredentialsProviderError',
    'ValidationException', 'ResourceNotFoundException'].includes(name)) {
    return { code: safeProviderCode(name),
      safeSummary: 'Event transport configuration or authorization was rejected', retryable: false };
  }
  return { code: 'EVENTBRIDGE_UNAVAILABLE',
    safeSummary: 'Event transport is temporarily unavailable', retryable: true };
}

function safeProviderCode(value: string): string {
  const normalized = `EVENTBRIDGE_${value.replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`.slice(0, 80);
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(normalized) ? normalized : 'EVENTBRIDGE_REJECTED';
}
