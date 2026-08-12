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

function harness(outcome: 'accepted' | 'definitive_failure' | 'unknown') {
  const repositoryValue = { claim: jest.fn().mockResolvedValue({ status: 'claimed', claimToken: 'claim-1', attemptCount: 1 }),
    complete: jest.fn(), fail: jest.fn().mockResolvedValue(outcome === 'unknown' ? 'retry_scheduled' : 'failed_terminal') };
  const repository: NotificationRepository = repositoryValue as unknown as NotificationRepository;
  const orchestratorValue = { trigger: jest.fn().mockResolvedValue({ outcome, provider: 'novu', safeCode: 'NOVU_TEST' }), readiness: jest.fn() };
  const orchestrator: NotificationOrchestrator = orchestratorValue as unknown as NotificationOrchestrator;
  const sqs = { send: jest.fn().mockResolvedValue({}) } as unknown as SQSClient;
  const config = readConfig({ NODE_ENV: 'test', NOTIFICATION_WORKER_ENABLED: 'true',
    NOTIFICATION_WORKER_DATABASE_URL: 'postgresql://test:test@localhost/hid',
    NOTIFICATION_WORKER_QUEUE_URL: 'https://sqs.example/queue', NOVU_MODE: 'test' });
  return { repository, orchestrator, sqs, worker: new NotificationWorker(config, repository, orchestrator, sqs) };
}

describe('ordinary notification worker', () => {
  it('records and acknowledges an accepted idempotent orchestration', async () => {
    const { worker, repository, sqs } = harness('accepted');
    await worker.process(message);
    expect(repository.complete).toHaveBeenCalledWith(expect.objectContaining({ id: event.id }), 'claim-1', expect.objectContaining({ outcome: 'accepted' }));
    expect(sqs.send).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge an unknown outcome so inbox/SQS retry can converge', async () => {
    const { worker, repository, sqs } = harness('unknown');
    await worker.process(message);
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), 'claim-1', expect.anything(), true, 1);
    expect(sqs.send).not.toHaveBeenCalled();
  });

  it('terminally records a definitive failure and acknowledges it', async () => {
    const { worker, repository, sqs } = harness('definitive_failure');
    await worker.process(message);
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), 'claim-1', expect.anything(), false, 1);
    expect(sqs.send).toHaveBeenCalledTimes(1);
  });
});
