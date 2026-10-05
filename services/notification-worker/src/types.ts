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
