import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import { readConfig } from './config';
import type { NotificationOrchestrator } from './novu.orchestrator';
import type { NotificationRepository } from './repository';
import { NotificationWorker } from './worker';

const event = {
  schema: 'ng.hid.event-envelope', schemaVersion: 1,
  id: '10000000-0000-4000-8000-000000000001', type: 'LabResultReleased', version: 1,
  occurredAt: '2026-08-12T10:00:00.000Z', producer: 'lab', correlationId: 'correlation-0001',
  context: { facilityId: '20000000-0000-4000-8000-000000000001', patientId: '30000000-0000-4000-8000-000000000001' },
  payload: { status: 'released' },
};
const message: Message = { Body: JSON.stringify({ detail: event }), ReceiptHandle: 'receipt-1' };

function harness(outcome: 'accepted' | 'definitive_failure' | 'unknown', options: {
  claim?: { status: string; claimToken?: string; attemptCount: number };
  verifiedEmail?: string | null;
  failStatus?: 'retry_scheduled' | 'failed_terminal';
  safeCode?: string;
} = {}) {
  const repositoryValue = {
    claim: jest.fn().mockResolvedValue(options.claim ?? { status: 'claimed', claimToken: 'claim-1', attemptCount: 1 }),
    verifiedPatientEmail: jest.fn().mockResolvedValue(
      Object.hasOwn(options, 'verifiedEmail') ? options.verifiedEmail : 'patient@example.invalid',
    ),
    complete: jest.fn(),
    fail: jest.fn().mockResolvedValue(options.failStatus ?? (outcome === 'unknown' ? 'retry_scheduled' : 'failed_terminal')),
  };
  const repository: NotificationRepository = repositoryValue as unknown as NotificationRepository;
  const orchestratorValue = { trigger: jest.fn().mockResolvedValue({
    outcome, provider: 'novu', safeCode: options.safeCode ?? 'NOVU_TEST',
  }), readiness: jest.fn() };
  const orchestrator: NotificationOrchestrator = orchestratorValue as unknown as NotificationOrchestrator;
  const sqs = { send: jest.fn().mockResolvedValue({}) } as unknown as SQSClient;
  const config = readConfig({ NODE_ENV: 'test', NOTIFICATION_WORKER_ENABLED: 'true',
    NOTIFICATION_WORKER_DATABASE_URL: 'postgresql://test:test@localhost/hid',
    NOTIFICATION_WORKER_QUEUE_URL: 'https://sqs.example/queue', NOVU_MODE: 'test' });
  return { repository, repositoryValue, orchestrator, orchestratorValue, sqs,
    worker: new NotificationWorker(config, repository, orchestrator, sqs) };
}

describe('ordinary notification worker', () => {
  it('records and acknowledges an accepted idempotent orchestration', async () => {
    const { worker, repository, repositoryValue, orchestrator, sqs } = harness('accepted');
    await worker.process(message);
    expect(repositoryValue.verifiedPatientEmail).toHaveBeenCalledWith(event.context.patientId);
    expect(orchestrator.trigger).toHaveBeenCalledWith(expect.objectContaining({ id: event.id }), 'patient@example.invalid');
    expect(repository.complete).toHaveBeenCalledWith(expect.objectContaining({ id: event.id }), 'claim-1', expect.objectContaining({ outcome: 'accepted' }));
    expect(sqs.send).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge an unknown outcome so inbox/SQS retry can converge', async () => {
    const { worker, repository, sqs } = harness('unknown', { safeCode: 'NOVU_SUBSCRIBER_HTTP_503' });
    await worker.process(message);
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), 'claim-1',
      expect.objectContaining({ safeCode: 'NOVU_SUBSCRIBER_HTTP_503' }), true, 1);
    expect(sqs.send).not.toHaveBeenCalled();
  });

  it('terminally records a definitive failure and acknowledges it', async () => {
    const { worker, repository, sqs } = harness('definitive_failure', { safeCode: 'NOVU_SUBSCRIBER_HTTP_400' });
    await worker.process(message);
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), 'claim-1',
      expect.objectContaining({ safeCode: 'NOVU_SUBSCRIBER_HTTP_400' }), false, 1);
    expect(sqs.send).toHaveBeenCalledTimes(1);
  });

  it('does not resolve or trigger a duplicate event that is already processed', async () => {
    const { worker, repositoryValue, orchestrator, sqs } = harness('accepted', {
      claim: { status: 'already_processed', attemptCount: 1 },
    });
    await worker.process(message);
    expect(repositoryValue.verifiedPatientEmail).not.toHaveBeenCalled();
    expect(orchestrator.trigger).not.toHaveBeenCalled();
    expect(sqs.send).toHaveBeenCalledTimes(1);
  });

  it('terminally records a missing verified email without triggering Novu', async () => {
    const { worker, repository, repositoryValue, orchestrator, sqs } = harness('accepted', { verifiedEmail: null });
    await worker.process(message);
    expect(repositoryValue.verifiedPatientEmail).toHaveBeenCalledWith(event.context.patientId);
    expect(orchestrator.trigger).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), 'claim-1',
      expect.objectContaining({ outcome: 'definitive_failure', safeCode: 'NOVU_RECIPIENT_EMAIL_UNAVAILABLE' }), false, 1);
    expect(sqs.send).toHaveBeenCalledTimes(1);
  });

  it('keeps the inbox claim retryable when verified-email resolution is unavailable', async () => {
    const { worker, repository, repositoryValue, orchestrator, sqs } = harness('accepted', {
      failStatus: 'retry_scheduled',
    });
    repositoryValue.verifiedPatientEmail.mockRejectedValueOnce(new Error('database unavailable'));
    await worker.process(message);
    expect(orchestrator.trigger).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), 'claim-1',
      expect.objectContaining({ outcome: 'unknown', safeCode: 'NOVU_RECIPIENT_LOOKUP_UNAVAILABLE' }), true, 1);
    expect(sqs.send).not.toHaveBeenCalled();
  });

  it('durably records emergency notification through established orchestration', async () => {
    const { worker, repository, orchestrator } = harness('accepted');
    const emergency = { ...event, type: 'EmergencyAccessActivated', producer: 'identity',
      payload: { consentGrantId: '40000000-0000-4000-8000-000000000001', reviewRequired: true } };
    await worker.process({ ...message, Body: JSON.stringify({ detail: emergency }) });
    expect(orchestrator.trigger).toHaveBeenCalledWith(expect.objectContaining({ type: 'EmergencyAccessActivated' }),
      'patient@example.invalid');
    expect(repository.complete).toHaveBeenCalledWith(expect.objectContaining({ type: 'EmergencyAccessActivated' }),
      'claim-1', expect.objectContaining({ outcome: 'accepted' }));
  });

});
