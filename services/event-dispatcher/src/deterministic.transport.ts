import type { EventTransport, HidEventEnvelopeV1, TransportResult } from './types';

export class DeterministicEventTransport implements EventTransport {
  readonly name = 'deterministic';
  async checkReadiness(_signal: AbortSignal): Promise<void> { return Promise.resolve(); }
  async publish(events: readonly HidEventEnvelopeV1[], _signal: AbortSignal): Promise<readonly TransportResult[]> {
    return events.map((event) => ({ eventId: event.id, accepted: true as const,
      messageId: `deterministic:${event.id}` }));
  }
}
