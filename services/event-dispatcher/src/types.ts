export type EventProducer = 'identity' | 'ocr' | 'lab' | 'pharmacy' | 'outreach';

export interface ClaimedEvent {
  producer: EventProducer;
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: Date;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  correlationId: string;
  causationId: string | null;
  facilityId: string | null;
  patientId: string | null;
  payload: Readonly<Record<string, unknown>>;
  attemptCount: number;
  claimToken: string;
  claimExpiresAt: Date;
}

export interface HidEventEnvelopeV1 {
  schema: 'ng.hid.event-envelope';
  schemaVersion: 1;
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  producer: EventProducer;
  aggregate: Readonly<{ type: string; id: string; version: number }>;
  correlationId: string;
  causationId: string | null;
  context: Readonly<{ facilityId: string | null; patientId: string | null }>;
  payload: Readonly<Record<string, unknown>>;
}

export interface SafeDeliveryFailure {
  code: string;
  safeSummary: string;
  retryable: boolean;
}

export type TransportResult = Readonly<{
  eventId: string;
  accepted: true;
  messageId: string;
}> | Readonly<{
  eventId: string;
  accepted: false;
  failure: SafeDeliveryFailure;
}>;

export interface EventTransport {
  readonly name: string;
  checkReadiness(signal: AbortSignal): Promise<void>;
  publish(events: readonly HidEventEnvelopeV1[], signal: AbortSignal): Promise<readonly TransportResult[]>;
}

export interface DeliveryMetrics {
  pendingCount: number;
  claimedCount: number;
  retryScheduledCount: number;
  deliveredCount: number;
  terminalFailureCount: number;
  oldestPendingAgeSeconds: number;
  dispatchSuccessCount: number;
  dispatchFailureCount: number;
  retryCount: number;
  averageDispatchLatencyMs: number;
}

export interface TerminalDeliveryFailure {
  eventId: string;
  eventType: string;
  producer: EventProducer;
  attemptCount: number;
  errorCode: string;
  errorSummary: string;
  failedAt: string;
  nextAttemptAt: string;
  correlationId: string;
}

export interface DeliveryRepository {
  checkReadiness(): Promise<void>;
  claim(dispatcherId: string): Promise<readonly ClaimedEvent[]>;
  delivered(event: ClaimedEvent, transport: string, messageId: string): Promise<void>;
  failed(event: ClaimedEvent, transport: string, failure: SafeDeliveryFailure,
    nextAttemptAt: Date | null): Promise<'retry_scheduled' | 'failed_terminal'>;
  metrics(): Promise<DeliveryMetrics>;
  terminalFailures(limit: number): Promise<readonly TerminalDeliveryFailure[]>;
  close(): Promise<void>;
}

export class EventContractFailure extends Error implements SafeDeliveryFailure {
  readonly retryable = false;
  constructor(readonly code: string, readonly safeSummary: string) { super(safeSummary); }
}
