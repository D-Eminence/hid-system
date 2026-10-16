import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import { readConfig } from './config';
import { NovuOrchestrator, type NotificationOrchestrator } from './novu.orchestrator';
import { ClaimLostError, type NotificationRepository } from './repository';
import { NotificationWorker } from './worker';

const event = {
  schema: 'ng.hid.event-envelope', schemaVersion: 1,
  id: '10000000-0000-4000-8000-000000000001', type: 'LabResultReleased', version: 1,
  occurredAt: '2026-08-12T10:00:00.000Z', producer: 'lab', correlationId: 'correlation-0001',
  context: { facilityId: '20000000-0000-4000-8000-000000000001', patientId: '30000000-0000-4000-8000-000000000001' },
  payload: { status: 'released' },
};
const message: Message = { Body: JSON.stringify({ detail: event }), ReceiptHandle: 'receipt-1' };

function harness(outcome: 'accepted' | 'definitive_failure' | 'unknown', sync: 'disabled' | 'email' = 'disabled') {
  const repositoryValue = { claim: jest.fn().mockResolvedValue({ status: 'claimed', claimToken: 'claim-1', attemptCount: 1 }),
    complete: jest.fn(), fail: jest.fn().mockResolvedValue(outcome === 'unknown' ? 'retry_scheduled' : 'failed_terminal'),
    resolveRecipient: jest.fn(), recordSubscriberOperation: jest.fn() };
  const repository: NotificationRepository = repositoryValue as unknown as NotificationRepository;
  const orchestratorValue = { trigger: jest.fn().mockResolvedValue({ outcome, provider: 'novu', safeCode: 'NOVU_TEST' }), readiness: jest.fn(),
    syncSubscriberEmail: jest.fn(), clearSubscriberEmail: jest.fn(), triggerWithEmailWithheld: jest.fn() };
  const orchestrator: NotificationOrchestrator = orchestratorValue as unknown as NotificationOrchestrator;
  const sqs = { send: jest.fn().mockResolvedValue({}) } as unknown as SQSClient;
  const config = readConfig({ NODE_ENV: 'test', NOTIFICATION_WORKER_ENABLED: 'true',
    NOTIFICATION_WORKER_DATABASE_URL: 'postgresql://test:test@localhost/hid',
    NOTIFICATION_WORKER_QUEUE_URL: 'https://sqs.example/queue', NOVU_MODE: 'test',
    ...(sync === 'email' ? { HID_DEPLOYMENT_ENV: 'development', NOVU_SUBSCRIBER_SYNC: 'email' } : {}) });
  return { repository, orchestrator, sqs, repositoryValue, orchestratorValue,
    worker: new NotificationWorker(config, repository, orchestrator, sqs) };
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
  it('durably records emergency notification through established orchestration', async () => {
    const { worker, repository, orchestrator } = harness('accepted');
    const emergency = { ...event, type: 'EmergencyAccessActivated', producer: 'identity',
      payload: { consentGrantId: '40000000-0000-4000-8000-000000000001', reviewRequired: true } };
    await worker.process({ ...message, Body: JSON.stringify({ detail: emergency }) });
    expect(orchestrator.trigger).toHaveBeenCalledWith(expect.objectContaining({ type: 'EmergencyAccessActivated' }));
    expect(repository.complete).toHaveBeenCalledWith(expect.objectContaining({ type: 'EmergencyAccessActivated' }),
      'claim-1', expect.objectContaining({ outcome: 'accepted' }));
  });
});

// NOVU_SUBSCRIBER_SYNC (ADR-064, migration 0095).
const patientId = event.context.patientId;
const verifiedEmail = 'synthetic.patient@example.invalid';
const pinEvent = { ...event, id: '10000000-0000-4000-8000-000000000002', type: 'PatientAccessPinVerified', producer: 'identity',
  payload: { consentGrantId: '40000000-0000-4000-8000-000000000002', reviewRequired: true } };
const emergencyEvent = { ...pinEvent, id: '10000000-0000-4000-8000-000000000003', type: 'EmergencyAccessActivated' };
const sqsMessage = (detail: object): Message => ({ Body: JSON.stringify({ detail }), ReceiptHandle: 'receipt-1' });

/** Records the order of every repository and orchestrator call, and the worker's stdout lines. */
function recorded(outcome: 'accepted' | 'definitive_failure' | 'unknown', sync: 'disabled' | 'email' = 'email') {
  const value = harness(outcome, sync);
  const mocks = [...Object.entries(value.repositoryValue), ...Object.entries(value.orchestratorValue)] as Array<[string, jest.Mock]>;
  /** Every repository and orchestrator call so far, in call order. */
  const order = () => mocks.flatMap(([name, mock]) => mock.mock.invocationCallOrder.map((position) => ({ name, position })))
    .sort((left, right) => left.position - right.position).map(({ name }) => name);
  const lines: string[] = [];
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk)); return true;
  });
  return { ...value, order, lines, stdout };
}
const outcomeLines = (lines: string[]) => lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  .filter((line) => line.event === 'notification.worker.outcome');

describe('flag off (the default): exactly main', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([['accepted'], ['unknown'], ['definitive_failure']] as const)(
    'a %s trigger looks up no recipient, calls no subscriber API and writes no stdout line', async (outcome) => {
      const { worker, repositoryValue, orchestratorValue, order, lines } = recorded(outcome, 'disabled');
      await worker.process(message);
      await worker.process(sqsMessage(pinEvent));
      expect(repositoryValue.resolveRecipient).not.toHaveBeenCalled();
      expect(repositoryValue.recordSubscriberOperation).not.toHaveBeenCalled();
      expect(orchestratorValue.syncSubscriberEmail).not.toHaveBeenCalled();
      expect(orchestratorValue.clearSubscriberEmail).not.toHaveBeenCalled();
      expect(orchestratorValue.triggerWithEmailWithheld).not.toHaveBeenCalled();
      expect(order().filter((name) => name === 'trigger')).toHaveLength(2);
      expect(lines).toEqual([]);
    });
});

describe('flag email: a verified login email is synced, and the in-app trigger never depends on it', () => {
  afterEach(() => jest.restoreAllMocks());

  it('syncs the subscriber, records the disclosure, sends main\'s trigger and completes', async () => {
    const { worker, repositoryValue, orchestratorValue, order, sqs } = recorded('accepted');
    repositoryValue.resolveRecipient.mockResolvedValue({ delivery: 'email', email: verifiedEmail });
    orchestratorValue.syncSubscriberEmail.mockResolvedValue({ outcome: 'confirmed', provider: 'novu' });
    await worker.process(message);
    expect(repositoryValue.resolveRecipient).toHaveBeenCalledWith(expect.objectContaining({ id: event.id }), 'claim-1');
    expect(orchestratorValue.syncSubscriberEmail).toHaveBeenCalledWith(patientId, verifiedEmail, event.id, 'claim-1');
    expect(repositoryValue.recordSubscriberOperation).toHaveBeenCalledWith(expect.objectContaining({ id: event.id }),
      'email', { outcome: 'confirmed', provider: 'novu' }, 1);
    expect(orchestratorValue.trigger).toHaveBeenCalledWith(expect.objectContaining({ id: event.id }));
    expect(orchestratorValue.clearSubscriberEmail).not.toHaveBeenCalled();
    expect(orchestratorValue.triggerWithEmailWithheld).not.toHaveBeenCalled();
    // The recipient is asked again under the same claim once the sync has answered (ADR-064).
    expect(order()).toEqual(['claim', 'resolveRecipient', 'syncSubscriberEmail', 'recordSubscriberOperation',
      'resolveRecipient', 'trigger', 'complete']);
    expect(repositoryValue.resolveRecipient).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: event.id }), 'claim-1');
    expect(repositoryValue.complete).toHaveBeenCalledWith(expect.anything(), 'claim-1', expect.objectContaining({ outcome: 'accepted' }));
    expect(sqs.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['NOVU_SUBSCRIBER_HTTP_408'], ['NOVU_SUBSCRIBER_HTTP_409'], ['NOVU_SUBSCRIBER_HTTP_429'],
    ['NOVU_SUBSCRIBER_HTTP_503'], ['NOVU_SUBSCRIBER_TIMEOUT_OR_UNAVAILABLE'],
  ])('a sync that is unknown (%s) still sends main\'s trigger and completes, never failing the event', async (safeCode) => {
    const { worker, repositoryValue, orchestratorValue, sqs } = recorded('accepted');
    repositoryValue.resolveRecipient.mockResolvedValue({ delivery: 'email', email: verifiedEmail });
    orchestratorValue.syncSubscriberEmail.mockResolvedValue({ outcome: 'unknown', provider: 'novu', safeCode });
    await worker.process(sqsMessage(pinEvent));
    expect(orchestratorValue.trigger).toHaveBeenCalledTimes(1);
    expect(orchestratorValue.trigger).toHaveBeenCalledWith(expect.objectContaining({ type: 'PatientAccessPinVerified' }));
    expect(repositoryValue.fail).not.toHaveBeenCalled();
    expect(repositoryValue.complete).toHaveBeenCalledTimes(1);
    expect(sqs.send).toHaveBeenCalledTimes(1);
  });

  it('a sync that is unknown on the last attempt still sends the trigger; the inbox is never terminal because of the sync', async () => {
    const { worker, repositoryValue, orchestratorValue } = recorded('accepted');
    repositoryValue.claim.mockResolvedValue({ status: 'claimed', claimToken: 'claim-8', attemptCount: 8 });
    repositoryValue.resolveRecipient.mockResolvedValue({ delivery: 'email', email: verifiedEmail });
    orchestratorValue.syncSubscriberEmail.mockResolvedValue({ outcome: 'unknown', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_HTTP_503' });
    await worker.process(sqsMessage(emergencyEvent));
    expect(orchestratorValue.trigger).toHaveBeenCalledWith(expect.objectContaining({ type: 'EmergencyAccessActivated' }));
    expect(repositoryValue.fail).not.toHaveBeenCalled();
    expect(repositoryValue.complete).toHaveBeenCalledWith(expect.anything(), 'claim-8', expect.objectContaining({ outcome: 'accepted' }));
  });

  it('a rejected sync still sends the trigger', async () => {
    const { worker, repositoryValue, orchestratorValue } = recorded('accepted');
    repositoryValue.resolveRecipient.mockResolvedValue({ delivery: 'email', email: verifiedEmail });
    orchestratorValue.syncSubscriberEmail.mockResolvedValue({ outcome: 'rejected', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_HTTP_422' });
    await worker.process(message);
    expect(orchestratorValue.trigger).toHaveBeenCalledTimes(1);
    expect(repositoryValue.complete).toHaveBeenCalledTimes(1);
  });

  it('a disclosure record that cannot be written does not hold back the trigger', async () => {
    const { worker, repositoryValue, orchestratorValue } = recorded('accepted');
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    repositoryValue.resolveRecipient.mockResolvedValue({ delivery: 'email', email: verifiedEmail });
    orchestratorValue.syncSubscriberEmail.mockResolvedValue({ outcome: 'confirmed', provider: 'novu' });
    repositoryValue.recordSubscriberOperation.mockRejectedValue(new Error('synthetic database failure'));
    await worker.process(message);
    expect(orchestratorValue.trigger).toHaveBeenCalledTimes(1);
    expect(repositoryValue.complete).toHaveBeenCalledTimes(1);
  });

  it('the trigger\'s own unknown outcome is retried exactly as main retries it', async () => {
    const { worker, repositoryValue, orchestratorValue, sqs } = recorded('unknown');
    repositoryValue.resolveRecipient.mockResolvedValue({ delivery: 'email', email: verifiedEmail });
    orchestratorValue.syncSubscriberEmail.mockResolvedValue({ outcome: 'confirmed', provider: 'novu' });
    await worker.process(message);
    expect(repositoryValue.fail).toHaveBeenCalledWith(expect.anything(), 'claim-1', expect.objectContaining({ outcome: 'unknown' }), true, 1);
    expect(sqs.send).not.toHaveBeenCalled();
  });
});

describe('flag email: the opt-out holds after an email was synced earlier, and in-app still goes', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['an opted-out patient', { delivery: 'withhold', bound: true }],
    ['a deleted or inactive login', { delivery: 'withhold', bound: true }],
    ['an event that binds to no outbox row', { delivery: 'withhold', bound: false }],
  ])('%s: the stored email is cleared before main\'s trigger, and nothing is synced', async (_label, answer) => {
    const { worker, repositoryValue, orchestratorValue, order } = recorded('accepted');
    repositoryValue.resolveRecipient.mockResolvedValue(answer);
    orchestratorValue.clearSubscriberEmail.mockResolvedValue({ outcome: 'confirmed', provider: 'novu' });
    await worker.process(message);
    expect(orchestratorValue.syncSubscriberEmail).not.toHaveBeenCalled();
    expect(orchestratorValue.clearSubscriberEmail).toHaveBeenCalledWith(patientId, event.id, 'claim-1');
    expect(repositoryValue.recordSubscriberOperation).toHaveBeenCalledWith(expect.anything(), 'clear',
      { outcome: 'confirmed', provider: 'novu' }, 1);
    expect(orchestratorValue.triggerWithEmailWithheld).not.toHaveBeenCalled();
    expect(order()).toEqual(['claim', 'resolveRecipient', 'clearSubscriberEmail', 'recordSubscriberOperation', 'trigger', 'complete']);
  });

  it.each([
    [{ outcome: 'unknown', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_HTTP_503' }],
    [{ outcome: 'unknown', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_TIMEOUT_OR_UNAVAILABLE' }],
    [{ outcome: 'rejected', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_HTTP_400' }],
  ])('a clear that is not confirmed (%j) sends the trigger that clears the email itself, never main\'s', async (clear) => {
    const { worker, repositoryValue, orchestratorValue, sqs } = recorded('accepted');
    repositoryValue.resolveRecipient.mockResolvedValue({ delivery: 'withhold', bound: true });
    orchestratorValue.clearSubscriberEmail.mockResolvedValue(clear);
    orchestratorValue.triggerWithEmailWithheld.mockResolvedValue({ outcome: 'accepted', provider: 'novu', providerMessageId: 'withheld-1' });
    await worker.process(sqsMessage(pinEvent));
    expect(orchestratorValue.trigger).not.toHaveBeenCalled();
    expect(orchestratorValue.triggerWithEmailWithheld).toHaveBeenCalledWith(expect.objectContaining({ type: 'PatientAccessPinVerified' }));
    expect(repositoryValue.fail).not.toHaveBeenCalled();
    expect(repositoryValue.complete).toHaveBeenCalledWith(expect.anything(), 'claim-1',
      expect.objectContaining({ outcome: 'accepted', providerMessageId: 'withheld-1' }));
    expect(sqs.send).toHaveBeenCalledTimes(1);
  });

  it.each([[pinEvent], [emergencyEvent]])('a safety notice for an opted-out patient still goes in-app (%#)', async (safety) => {
    const { worker, repositoryValue, orchestratorValue } = recorded('accepted');
    repositoryValue.resolveRecipient.mockResolvedValue({ delivery: 'withhold', bound: true });
    orchestratorValue.clearSubscriberEmail.mockResolvedValue({ outcome: 'confirmed', provider: 'novu' });
    await worker.process(sqsMessage(safety));
    expect(orchestratorValue.trigger).toHaveBeenCalledWith(expect.objectContaining({ type: safety.type }));
    expect(repositoryValue.complete).toHaveBeenCalledWith(expect.objectContaining({ type: safety.type }), 'claim-1',
      expect.objectContaining({ outcome: 'accepted' }));
  });

  it('a recipient lookup that fails is handled as withheld: clear, then the trigger, and no retry', async () => {
    const { worker, repositoryValue, orchestratorValue } = recorded('accepted');
    repositoryValue.resolveRecipient.mockRejectedValue(Object.assign(new Error('synthetic'), { code: '08006' }));
    orchestratorValue.clearSubscriberEmail.mockResolvedValue({ outcome: 'confirmed', provider: 'novu' });
    await worker.process(sqsMessage(pinEvent));
    expect(orchestratorValue.syncSubscriberEmail).not.toHaveBeenCalled();
    expect(orchestratorValue.clearSubscriberEmail).toHaveBeenCalledTimes(1);
    expect(orchestratorValue.trigger).toHaveBeenCalledTimes(1);
    expect(repositoryValue.fail).not.toHaveBeenCalled();
    expect(repositoryValue.complete).toHaveBeenCalledTimes(1);
  });

  it('a claim lost to another worker stops: no Novu call, no completion, no failure and no acknowledgement', async () => {
    const { worker, repositoryValue, orchestratorValue, sqs } = recorded('accepted');
    repositoryValue.resolveRecipient.mockRejectedValue(new ClaimLostError());
    await worker.process(message);
    for (const name of ['trigger', 'syncSubscriberEmail', 'clearSubscriberEmail', 'triggerWithEmailWithheld'] as const) {
      expect(orchestratorValue[name]).not.toHaveBeenCalled();
    }
    expect(repositoryValue.complete).not.toHaveBeenCalled();
    expect(repositoryValue.fail).not.toHaveBeenCalled();
    expect(sqs.send).not.toHaveBeenCalled();
  });

  it('an already processed event is neither looked up nor triggered', async () => {
    const { worker, repositoryValue, orchestratorValue, sqs } = recorded('accepted');
    repositoryValue.claim.mockResolvedValue({ status: 'already_processed', attemptCount: 1 });
    await worker.process(message);
    expect(repositoryValue.resolveRecipient).not.toHaveBeenCalled();
    expect(orchestratorValue.trigger).not.toHaveBeenCalled();
    expect(sqs.send).toHaveBeenCalledTimes(1);
  });
});

describe('flag email: one PHI-free outcome line per processed event', () => {
  afterEach(() => jest.restoreAllMocks());
  const allowed = ['event', 'eventType', 'correlationId', 'recipient', 'subscriber', 'subscriberCode', 'trigger',
    'triggerOutcome', 'triggerCode', 'inbox'];

  it.each([
    ['email', { delivery: 'email', email: verifiedEmail }, { outcome: 'unknown', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_HTTP_503' },
      { recipient: 'email', subscriber: 'sync_failed', subscriberCode: 'NOVU_SUBSCRIBER_HTTP_503', trigger: 'standard' }],
    ['withhold', { delivery: 'withhold', bound: true }, { outcome: 'confirmed', provider: 'novu' },
      { recipient: 'withhold', subscriber: 'cleared', trigger: 'standard' }],
    ['unbound', { delivery: 'withhold', bound: false }, { outcome: 'unknown', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_HTTP_429' },
      { recipient: 'unbound', subscriber: 'clear_failed', subscriberCode: 'NOVU_SUBSCRIBER_HTTP_429', trigger: 'email_withheld' }],
  ])('%s: fixed codes and the correlation id only', async (_label, answer, subscriberResult, expected) => {
    const { worker, repositoryValue, orchestratorValue, lines } = recorded('accepted');
    repositoryValue.resolveRecipient.mockResolvedValue(answer);
    orchestratorValue.syncSubscriberEmail.mockResolvedValue(subscriberResult);
    orchestratorValue.clearSubscriberEmail.mockResolvedValue(subscriberResult);
    orchestratorValue.triggerWithEmailWithheld.mockResolvedValue({ outcome: 'accepted', provider: 'novu' });
    await worker.process(message);
    const [line, ...rest] = outcomeLines(lines);
    expect(rest).toEqual([]);
    expect(line).toEqual({ event: 'notification.worker.outcome', eventType: 'LabResultReleased',
      correlationId: event.correlationId, triggerOutcome: 'accepted', inbox: 'processed', ...expected });
    expect(Object.keys(line).every((key) => allowed.includes(key))).toBe(true);
    const text = lines.join('');
    for (const secret of [verifiedEmail, patientId, event.id, 'claim-1']) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it('a retried trigger and a lost claim are reported without identifiers', async () => {
    const retried = recorded('unknown');
    retried.repositoryValue.resolveRecipient.mockResolvedValue({ delivery: 'email', email: verifiedEmail });
    retried.orchestratorValue.syncSubscriberEmail.mockResolvedValue({ outcome: 'confirmed', provider: 'novu' });
    await retried.worker.process(message);
    expect(outcomeLines(retried.lines)).toEqual([expect.objectContaining({ subscriber: 'synced', triggerOutcome: 'unknown',
      triggerCode: 'NOVU_TEST', inbox: 'retry_scheduled' })]);
    jest.restoreAllMocks();
    const lost = recorded('accepted');
    lost.repositoryValue.resolveRecipient.mockRejectedValue(new ClaimLostError());
    await lost.worker.process(message);
    expect(outcomeLines(lost.lines)).toEqual([{ event: 'notification.worker.outcome', eventType: 'LabResultReleased',
      correlationId: event.correlationId, recipient: 'claim_lost', subscriber: 'not_run', trigger: 'not_sent', inbox: 'claim_lost' }]);
    expect(lost.lines.join('')).not.toContain(patientId);
  });
});

describe('flag email: the outcome line echoes only a correlation id of the outbox shape', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a correlation id outside the outbox pattern is reported as invalid, never echoed', async () => {
    const { worker, repositoryValue, orchestratorValue, lines } = recorded('accepted');
    repositoryValue.resolveRecipient.mockResolvedValue({ delivery: 'withhold', bound: false });
    orchestratorValue.clearSubscriberEmail.mockResolvedValue({ outcome: 'confirmed', provider: 'novu' });
    const forged = { ...event, correlationId: 'synthetic.patient@example.invalid' };
    await worker.process(sqsMessage(forged));
    expect(outcomeLines(lines)).toEqual([expect.objectContaining({ correlationId: 'invalid', inbox: 'processed' })]);
    expect(lines.join('')).not.toContain('@');
  });
});

describe('flag email: the recipient is asked again after the sync, under the same claim', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['withheld by now', { delivery: 'withhold', bound: true }],
    ['another address', { delivery: 'email', email: 'other.synthetic@example.invalid' }],
  ])('an answer that is %s at the second lookup clears the email just synced before main\'s trigger', async (_label, second) => {
    const { worker, repositoryValue, orchestratorValue, order, lines } = recorded('accepted');
    repositoryValue.resolveRecipient.mockResolvedValueOnce({ delivery: 'email', email: verifiedEmail }).mockResolvedValueOnce(second);
    orchestratorValue.syncSubscriberEmail.mockResolvedValue({ outcome: 'confirmed', provider: 'novu' });
    orchestratorValue.clearSubscriberEmail.mockResolvedValue({ outcome: 'confirmed', provider: 'novu' });
    await worker.process(message);
    expect(order()).toEqual(['claim', 'resolveRecipient', 'syncSubscriberEmail', 'recordSubscriberOperation',
      'resolveRecipient', 'clearSubscriberEmail', 'recordSubscriberOperation', 'trigger', 'complete']);
    expect(orchestratorValue.clearSubscriberEmail).toHaveBeenCalledWith(patientId, event.id, 'claim-1');
    expect(repositoryValue.recordSubscriberOperation).toHaveBeenNthCalledWith(2, expect.anything(), 'clear',
      { outcome: 'confirmed', provider: 'novu' }, 1);
    expect(orchestratorValue.triggerWithEmailWithheld).not.toHaveBeenCalled();
    expect(outcomeLines(lines)).toEqual([expect.objectContaining({ recipient: 'withdrawn', subscriber: 'cleared',
      trigger: 'standard', inbox: 'processed' })]);
    expect(lines.join('')).not.toContain('other.synthetic');
  });

  it('a second lookup that fails is handled as withheld; an unconfirmed clear sends the trigger that clears the email', async () => {
    const { worker, repositoryValue, orchestratorValue, lines } = recorded('accepted');
    repositoryValue.resolveRecipient.mockResolvedValueOnce({ delivery: 'email', email: verifiedEmail })
      .mockRejectedValueOnce(Object.assign(new Error('synthetic'), { code: '08006' }));
    orchestratorValue.syncSubscriberEmail.mockResolvedValue({ outcome: 'unknown', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_HTTP_503' });
    orchestratorValue.clearSubscriberEmail.mockResolvedValue({ outcome: 'unknown', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_HTTP_503' });
    orchestratorValue.triggerWithEmailWithheld.mockResolvedValue({ outcome: 'accepted', provider: 'novu' });
    await worker.process(sqsMessage(pinEvent));
    expect(orchestratorValue.trigger).not.toHaveBeenCalled();
    expect(orchestratorValue.triggerWithEmailWithheld).toHaveBeenCalledWith(expect.objectContaining({ type: 'PatientAccessPinVerified' }));
    expect(repositoryValue.fail).not.toHaveBeenCalled();
    expect(outcomeLines(lines)).toEqual([expect.objectContaining({ recipient: 'withdrawn', subscriber: 'clear_failed',
      subscriberCode: 'NOVU_SUBSCRIBER_HTTP_503', trigger: 'email_withheld', inbox: 'processed' })]);
  });

  it('a claim lost after the sync clears the email it may have set and stops: no trigger, completion, failure or acknowledgement', async () => {
    const { worker, repositoryValue, orchestratorValue, sqs, lines } = recorded('accepted');
    repositoryValue.resolveRecipient.mockResolvedValueOnce({ delivery: 'email', email: verifiedEmail })
      .mockRejectedValueOnce(new ClaimLostError());
    orchestratorValue.syncSubscriberEmail.mockResolvedValue({ outcome: 'confirmed', provider: 'novu' });
    orchestratorValue.clearSubscriberEmail.mockResolvedValue({ outcome: 'confirmed', provider: 'novu' });
    await worker.process(message);
    expect(orchestratorValue.clearSubscriberEmail).toHaveBeenCalledWith(patientId, event.id, 'claim-1');
    expect(orchestratorValue.trigger).not.toHaveBeenCalled();
    expect(orchestratorValue.triggerWithEmailWithheld).not.toHaveBeenCalled();
    expect(repositoryValue.complete).not.toHaveBeenCalled();
    expect(repositoryValue.fail).not.toHaveBeenCalled();
    expect(sqs.send).not.toHaveBeenCalled();
    expect(outcomeLines(lines)).toEqual([{ event: 'notification.worker.outcome', eventType: 'LabResultReleased',
      correlationId: event.correlationId, recipient: 'claim_lost', subscriber: 'cleared', trigger: 'not_sent', inbox: 'claim_lost' }]);
  });
});

/**
 * A fake Novu behind global fetch that keeps each subscriber's email and
 * applies Novu's documented idempotency rule (idempotency.md): a request
 * whose Idempotency-Key was seen gets the cached answer, success or error,
 * and is not processed again. Each trigger it processes records the email
 * its subscriber had at that moment. A trigger key in `drop` never reaches
 * Novu (nothing is cached); `holdNextSync` stops the next upsert at Novu
 * until released, then applies it before answering.
 */
function fakeNovu() {
  const subscribers = new Map<string, string | null>();
  const cache = new Map<string, { status: number; body: unknown }>();
  const triggers: Array<{ key: string; emailAtTrigger: string | null }> = [];
  const replays: string[] = [];
  const drop = new Set<string>();
  let held: { arrived: () => void; released: Promise<void> } | undefined;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const key = new Headers(init?.headers).get('idempotency-key') ?? '';
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.pathname === '/v1/events/trigger' && drop.delete(key)) throw new TypeError('synthetic network failure');
    const cached = cache.get(key);
    if (cached) {
      replays.push(`${init?.method} ${url.pathname}`);
      return new Response(JSON.stringify(cached.body), { status: cached.status, headers: { 'idempotency-replay': 'true' } });
    }
    let status = 200;
    let answer: unknown = {};
    if (init?.method === 'POST' && url.pathname === '/v2/subscribers') {
      const hold = held;
      held = undefined;
      if (hold) { hold.arrived(); await hold.released; }
      subscribers.set(String(body.subscriberId), body.email as string | null);
      status = 201;
    } else if (init?.method === 'PATCH' && url.pathname.startsWith('/v2/subscribers/')) {
      const id = decodeURIComponent(url.pathname.slice('/v2/subscribers/'.length));
      if (subscribers.has(id)) subscribers.set(id, body.email as string | null); else status = 404;
    } else if (init?.method === 'POST' && url.pathname === '/v1/events/trigger') {
      const to = body.to as { subscriberId: string; email?: string | null };
      if ('email' in to) subscribers.set(to.subscriberId, to.email ?? null);
      triggers.push({ key, emailAtTrigger: subscribers.get(to.subscriberId) ?? null });
      status = 201;
      answer = { data: { transactionId: `novu-fake-${triggers.length}` } };
    }
    cache.set(key, { status, body: answer });
    return new Response(JSON.stringify(answer), { status });
  });
  const holdNextSync = () => {
    let arrived!: () => void;
    let release!: () => void;
    const arrival = new Promise<void>((resolve) => { arrived = resolve; });
    held = { arrived, released: new Promise<void>((resolve) => { release = resolve; }) };
    return { arrival, release };
  };
  return { subscribers, triggers, replays, drop, holdNextSync };
}

/** The real worker and orchestrator (live mode) over a stub repository whose answer follows `state`. */
function liveWorker(state: { eligible: boolean }) {
  const attempts = new Map<string, number>();
  const repositoryValue = {
    claim: jest.fn(async (claimed: { id: string }) => {
      const attempt = (attempts.get(claimed.id) ?? 0) + 1;
      attempts.set(claimed.id, attempt);
      return { status: 'claimed', claimToken: `50000000-0000-4000-8000-00000000000${attempt}`, attemptCount: attempt };
    }),
    resolveRecipient: jest.fn(async () => (state.eligible ? { delivery: 'email', email: verifiedEmail } : { delivery: 'withhold', bound: true })),
    recordSubscriberOperation: jest.fn(), complete: jest.fn(), fail: jest.fn().mockResolvedValue('retry_scheduled'),
  };
  const config = readConfig({ NODE_ENV: 'test', HID_DEPLOYMENT_ENV: 'development', NOTIFICATION_WORKER_ENABLED: 'true',
    NOTIFICATION_WORKER_DATABASE_URL: 'postgresql://test:test@localhost/hid', NOTIFICATION_WORKER_QUEUE_URL: 'https://sqs.example/queue',
    NOVU_MODE: 'live', NOVU_API_URL: 'https://novu.example.invalid', NOVU_API_KEY: 'example-novu-spec-key', NOVU_SUBSCRIBER_SYNC: 'email' });
  const orchestrator: NotificationOrchestrator = new NovuOrchestrator(config);
  const sqs = { send: jest.fn().mockResolvedValue({}) } as unknown as SQSClient;
  return { repositoryValue,
    worker: new NotificationWorker(config, repositoryValue as unknown as NotificationRepository, orchestrator, sqs) };
}

describe('flag email against a fake Novu that replays seen idempotency keys', () => {
  beforeEach(() => { jest.spyOn(process.stdout, 'write').mockImplementation(() => true); });
  afterEach(() => jest.restoreAllMocks());

  it('a retried event clears the email again: the first attempt\'s cached clear cannot stand in for it', async () => {
    const novu = fakeNovu();
    const state = { eligible: false };
    const { worker, repositoryValue } = liveWorker(state);
    novu.subscribers.set(patientId, null);
    const later = { ...event, id: '10000000-0000-4000-8000-000000000004', correlationId: 'correlation-0004' };
    // Attempt 1 of the event, patient withheld: cleared, but the trigger never reaches Novu, so the event is retried.
    novu.drop.add(event.id);
    await worker.process(message);
    expect(repositoryValue.fail).toHaveBeenCalledWith(expect.objectContaining({ id: event.id }),
      '50000000-0000-4000-8000-000000000001', expect.objectContaining({ outcome: 'unknown' }), true, 1);
    // A later event while the patient is eligible syncs the email.
    state.eligible = true;
    await worker.process(sqsMessage(later));
    expect(novu.subscribers.get(patientId)).toBe(verifiedEmail);
    // Attempt 2 of the first event, patient withheld again: its clear is processed, not replayed.
    state.eligible = false;
    await worker.process(message);
    expect(novu.replays).toEqual([]);
    expect(novu.triggers.at(-1)).toEqual({ key: event.id, emailAtTrigger: null });
    expect(novu.subscribers.get(patientId)).toBeNull();
  });

  it('concurrent events for one patient: an upsert that lands after a later event\'s clear leaves no email at Novu', async () => {
    const novu = fakeNovu();
    const state = { eligible: true };
    const { worker } = liveWorker(state);
    novu.subscribers.set(patientId, null);
    const withheld = { ...event, id: '10000000-0000-4000-8000-000000000005', correlationId: 'correlation-0005' };
    const gate = novu.holdNextSync();
    // The first event looks the patient up as eligible; its upsert reaches Novu and waits there.
    const first = worker.process(message);
    await gate.arrival;
    // The login is then deleted, and a second event is handled in full: withheld, cleared, in-app only.
    state.eligible = false;
    await worker.process(sqsMessage(withheld));
    expect(novu.triggers).toEqual([{ key: withheld.id, emailAtTrigger: null }]);
    // Novu applies the first upsert only now, after that clear.
    gate.release();
    await first;
    expect(novu.subscribers.get(patientId)).toBeNull();
    expect(novu.triggers.map((trigger) => trigger.emailAtTrigger)).toEqual([null, null]);
  });
});
