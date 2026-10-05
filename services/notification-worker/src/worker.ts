import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient, type Message } from '@aws-sdk/client-sqs';
import type { NotificationWorkerConfig } from './config';
import { parseSqsEvent } from './event';
import type { NotificationOrchestrator } from './novu.orchestrator';
import type { NotificationRepository } from './repository';

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

    let verifiedEmail: string | null;
    try {
      verifiedEmail = await this.repository.verifiedPatientEmail(event.context.patientId!);
    } catch {
      await this.settle(event, message, claim.claimToken, claim.attemptCount, {
        outcome: 'unknown', provider: 'novu', safeCode: 'NOVU_RECIPIENT_LOOKUP_UNAVAILABLE',
      });
      return;
    }
    if (!verifiedEmail) {
      await this.settle(event, message, claim.claimToken, claim.attemptCount, {
        outcome: 'definitive_failure', provider: 'novu', safeCode: 'NOVU_RECIPIENT_EMAIL_UNAVAILABLE',
      });
      return;
    }
    const result = await this.orchestrator.trigger(event, verifiedEmail).catch(() => ({
      outcome: 'unknown' as const, provider: 'novu' as const, safeCode: 'NOVU_ORCHESTRATION_UNAVAILABLE',
    }));
    await this.settle(event, message, claim.claimToken, claim.attemptCount, result);
  }

  private async settle(event: ReturnType<typeof parseSqsEvent>, message: Message, claimToken: string,
    attemptCount: number, result: Awaited<ReturnType<NotificationOrchestrator['trigger']>>): Promise<void> {
    if (result.outcome === 'accepted') {
      await this.repository.complete(event, claimToken, result);
      await this.delete(message);
      return;
    }
    const status = await this.repository.fail(event, claimToken, result,
      result.outcome === 'unknown', attemptCount);
    if (status === 'failed_terminal') await this.delete(message);
  }

  stop(): void { this.stopping = true; }
  status() { return { enabled: this.config.NOTIFICATION_WORKER_ENABLED, startupReady: this.startupReady, stopping: this.stopping }; }

  private async delete(message: Message): Promise<void> {
    if (!message.ReceiptHandle) return;
    await this.sqs.send(new DeleteMessageCommand({
      QueueUrl: this.config.NOTIFICATION_WORKER_QUEUE_URL, ReceiptHandle: message.ReceiptHandle,
    }));
  }
}
