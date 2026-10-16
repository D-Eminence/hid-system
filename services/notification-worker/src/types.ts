export type DeliveryOutcome = 'accepted' | 'definitive_failure' | 'unknown';
export type EventProducer = 'identity' | 'ocr' | 'lab' | 'pharmacy' | 'outreach';

export interface HidEventEnvelope {
  schema: 'ng.hid.event-envelope';
  schemaVersion: 1;
  id: string;
  type: string;
  version: 1;
  occurredAt: string;
  producer: EventProducer;
  correlationId: string;
  context: { facilityId: string | null; patientId: string | null };
  payload: Readonly<Record<string, unknown>>;
}

export interface OrchestrationResult {
  outcome: DeliveryOutcome;
  provider: 'novu';
  providerMessageId?: string;
  safeCode?: string;
}

export interface ClaimedInbox {
  status: 'claimed' | 'already_processed' | 'failed_terminal' | 'busy' | 'retry_scheduled';
  claimToken?: string;
  attemptCount: number;
}

/**
 * The claim-bound recipient answer (0095, ADR-064). It never carries a name.
 * `withhold` covers every patient who may not be emailed; `bound` is false
 * when the claim bound no outbox event of that patient.
 */
export type RecipientDelivery =
  | { delivery: 'email'; email: string }
  | { delivery: 'withhold'; bound: boolean };

/** The outcome of a Novu subscriber call: confirmed, rejected (4xx) or unknown. */
export interface SubscriberOperationResult {
  outcome: 'confirmed' | 'rejected' | 'unknown';
  provider: 'novu';
  safeCode?: string;
}

export type SubscriberOperation = 'email' | 'clear';
