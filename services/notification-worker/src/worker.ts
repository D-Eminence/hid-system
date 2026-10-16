import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient, type Message } from '@aws-sdk/client-sqs';
import type { NotificationWorkerConfig } from './config';
import { parseSqsEvent } from './event';
import type { NotificationOrchestrator } from './novu.orchestrator';
import { ClaimLostError, type NotificationRepository } from './repository';
import type { HidEventEnvelope, OrchestrationResult, RecipientDelivery, SubscriberOperation,
  SubscriberOperationResult } from './types';

/**
 * What NOVU_SUBSCRIBER_SYNC=email did for one event, for the PHI-free
 * notification.worker.outcome line: fixed codes only.
 */
interface SubscriberDelivery {
  result: OrchestrationResult;
  // withdrawn: eligible at the first lookup, not confirmed by the second.
  recipient: 'email' | 'withhold' | 'unbound' | 'lookup_failed' | 'withdrawn';
  subscriber: 'synced' | 'sync_failed' | 'cleared' | 'clear_failed';
  subscriberCode?: string;
  trigger: 'standard' | 'email_withheld';
}
const LOGGABLE_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
// The outbox's own correlation id shape (identity.outbox_events and
// notification.delivery_attempts); anything else is reported as invalid.
const LOGGABLE_CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const correlation = (event: HidEventEnvelope) =>
  LOGGABLE_CORRELATION.test(event.correlationId) ? event.correlationId : 'invalid';

export class NotificationWorker {
  private stopping = false;
  private startupReady = false;
  constructor(
    private readonly config: NotificationWorkerConfig,
    private readonly repository: NotificationRepository,
    private readonly orchestrator: NotificationOrchestrator,
    private readonly sqs = new SQSClient({ region: config.AWS_REGION, maxAttempts: 1,
      ...(config.AWS_ENDPOINT_URL ? { endpoint: config.AWS_ENDPOINT_URL } : {}) }),
  ) {}

  async run(): Promise<void> {
    this.startupReady = true;
    while (!this.stopping) {
      let messages: Message[];
      try {
        const result = await this.sqs.send(new ReceiveMessageCommand({
          QueueUrl: this.config.NOTIFICATION_WORKER_QUEUE_URL,
          MaxNumberOfMessages: 10, WaitTimeSeconds: 20,
          VisibilityTimeout: this.config.NOTIFICATION_WORKER_LEASE_SECONDS,
        }));
        messages = result.Messages ?? [];
      } catch {
        process.stderr.write('notification_worker_receive_failed\n');
        continue;
      }
      await Promise.all(messages.map((message) => this.process(message)));
    }
  }

  async process(message: Message): Promise<void> {
    let event;
    try {
      event = parseSqsEvent(message.Body);
    } catch {
      process.stderr.write('notification_worker_contract_rejected\n');
      return;
    }
    const claim = await this.repository.claim(event).catch(() => undefined);
    if (!claim) return;
    if (claim.status === 'already_processed' || claim.status === 'failed_terminal') {
      await this.delete(message); return;
    }
    if (claim.status !== 'claimed' || !claim.claimToken) return;

    // ADR-064: with NOVU_SUBSCRIBER_SYNC=email the subscriber's email is set
    // or cleared first; the trigger and its outcome are then handled exactly
    // as main handles them. With the flag off nothing below the trigger changes.
    const sync = this.config.NOVU_SUBSCRIBER_SYNC === 'email'
      ? await this.deliverWithSubscriberEmail(event, claim.claimToken, claim.attemptCount) : undefined;
    if (sync === null) return;
    const result = sync ? sync.result : await this.orchestrator.trigger(event);
    if (result.outcome === 'accepted') {
      await this.repository.complete(event, claim.claimToken, result);
      await this.delete(message);
      if (sync) this.report(event, sync, 'processed');
      return;
    }
    const status = await this.repository.fail(event, claim.claimToken, result,
      result.outcome === 'unknown', claim.attemptCount);
    if (status === 'failed_terminal') await this.delete(message);
    if (sync) this.report(event, sync, status);
  }

  stop(): void { this.stopping = true; }
  status() { return { enabled: this.config.NOTIFICATION_WORKER_ENABLED, startupReady: this.startupReady, stopping: this.stopping }; }

  /**
   * The subscriber step and the trigger, or null when the claim was lost.
   * The in-app trigger never depends on a subscriber call:
   * - a verified login email is synced, and the recipient is then asked again
   *   under the same claim. Only the same address keeps the sync: main's
   *   trigger follows whatever the sync answered (a failed sync only means
   *   this event may not email). Any other second answer (withheld, another
   *   address or a failed lookup) means an event handled meanwhile may have
   *   cleared the email before this upsert landed at Novu, so the email is
   *   cleared again, as for a withheld recipient;
   * - every other recipient, a lookup that fails included, has its Novu email
   *   cleared first; main's trigger follows a confirmed clear, and otherwise
   *   the trigger that clears the email in the same request, so the opt-out
   *   holds after an earlier sync and safety notices still go in-app.
   * Both subscriber calls are keyed by this attempt's claim token.
   */
  private async deliverWithSubscriberEmail(event: HidEventEnvelope, claimToken: string,
    attemptCount: number): Promise<SubscriberDelivery | null> {
    const patientId = event.context.patientId!;
    const first = await this.lookup(event, claimToken);
    if (first === 'claim_lost') {
      this.reportClaimLost(event, 'not_run');
      return null;
    }
    if (first?.delivery !== 'email') {
      return this.withhold(event, claimToken, attemptCount,
        first === undefined ? 'lookup_failed' : first.bound ? 'withhold' : 'unbound');
    }
    const synced = await this.orchestrator.syncSubscriberEmail(patientId, first.email, event.id, claimToken);
    await this.record(event, 'email', synced, attemptCount);
    const second = await this.lookup(event, claimToken);
    if (second === 'claim_lost') {
      // Another worker holds the event now and decides for itself; the
      // address this attempt may have set is cleared, failing safe.
      const cleared = await this.orchestrator.clearSubscriberEmail(patientId, event.id, claimToken);
      await this.record(event, 'clear', cleared, attemptCount);
      this.reportClaimLost(event, cleared.outcome === 'confirmed' ? 'cleared' : 'clear_failed');
      return null;
    }
    if (second?.delivery === 'email' && second.email === first.email) {
      return { result: await this.orchestrator.trigger(event), recipient: 'email',
        subscriber: synced.outcome === 'confirmed' ? 'synced' : 'sync_failed', ...this.code(synced), trigger: 'standard' };
    }
    return this.withhold(event, claimToken, attemptCount, 'withdrawn');
  }

  /** Clear the Novu email, then main's trigger if confirmed, else the trigger that clears the email itself. */
  private async withhold(event: HidEventEnvelope, claimToken: string, attemptCount: number,
    recipient: SubscriberDelivery['recipient']): Promise<SubscriberDelivery> {
    const cleared = await this.orchestrator.clearSubscriberEmail(event.context.patientId!, event.id, claimToken);
    await this.record(event, 'clear', cleared, attemptCount);
    const confirmed = cleared.outcome === 'confirmed';
    return {
      result: confirmed ? await this.orchestrator.trigger(event) : await this.orchestrator.triggerWithEmailWithheld(event),
      recipient, subscriber: confirmed ? 'cleared' : 'clear_failed', ...(confirmed ? {} : this.code(cleared)),
      trigger: confirmed ? 'standard' : 'email_withheld',
    };
  }

  /** The claim-bound recipient answer; undefined when the lookup failed, 'claim_lost' on 55000. */
  private async lookup(event: HidEventEnvelope, claimToken: string): Promise<RecipientDelivery | undefined | 'claim_lost'> {
    try {
      return await this.repository.resolveRecipient(event, claimToken);
    } catch (error) {
      return error instanceof ClaimLostError ? 'claim_lost' : undefined;
    }
  }

  private reportClaimLost(event: HidEventEnvelope, subscriber: 'not_run' | 'cleared' | 'clear_failed'): void {
    this.write({ event: 'notification.worker.outcome', eventType: event.type, correlationId: correlation(event),
      recipient: 'claim_lost', subscriber, trigger: 'not_sent', inbox: 'claim_lost' });
  }

  /** A disclosure row that cannot be written never holds back the in-app trigger. */
  private async record(event: HidEventEnvelope, operation: SubscriberOperation, result: SubscriberOperationResult,
    attemptCount: number): Promise<void> {
    try {
      await this.repository.recordSubscriberOperation(event, operation, result, attemptCount);
    } catch {
      process.stderr.write('notification_worker_subscriber_record_failed\n');
    }
  }

  private code(result: SubscriberOperationResult): { subscriberCode?: string } {
    return result.outcome !== 'confirmed' && result.safeCode && LOGGABLE_CODE.test(result.safeCode)
      ? { subscriberCode: result.safeCode } : {};
  }

  /**
   * One PHI-free line per event handled with NOVU_SUBSCRIBER_SYNC=email: the
   * event type, the correlation id and fixed codes. Never the address, the
   * patient, the event id or an idempotency key.
   */
  private report(event: HidEventEnvelope, sync: SubscriberDelivery, inbox: 'processed' | 'retry_scheduled' | 'failed_terminal'): void {
    const triggerCode: { triggerCode?: string } = sync.result.outcome !== 'accepted' && sync.result.safeCode
      && LOGGABLE_CODE.test(sync.result.safeCode) ? { triggerCode: sync.result.safeCode } : {};
    this.write({ event: 'notification.worker.outcome', eventType: event.type, correlationId: correlation(event),
      recipient: sync.recipient, subscriber: sync.subscriber,
      ...(sync.subscriberCode ? { subscriberCode: sync.subscriberCode } : {}),
      trigger: sync.trigger, triggerOutcome: sync.result.outcome, ...triggerCode, inbox });
  }

  private write(line: Record<string, string | undefined>): void {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }

  private async delete(message: Message): Promise<void> {
    if (!message.ReceiptHandle) return;
    await this.sqs.send(new DeleteMessageCommand({
      QueueUrl: this.config.NOTIFICATION_WORKER_QUEUE_URL, ReceiptHandle: message.ReceiptHandle,
    }));
  }
}
