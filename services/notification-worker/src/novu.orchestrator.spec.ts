import { NovuOrchestrator } from './novu.orchestrator';
import { readConfig } from './config';
import type { NotificationRecipient } from './types';

const recipient: NotificationRecipient = {
  id: '30000000-0000-4000-8000-000000000001',
  firstName: 'Test',
  lastName: 'Patient',
  email: 'controlled@example.test',
};

function config() {
  return readConfig({
    NODE_ENV: 'test',
    NOTIFICATION_WORKER_ENABLED: 'false',
    NOVU_MODE: 'live',
    NOVU_API_KEY: 'test-key',
  });
}

const testEvent = (id: string) => ({
  schema: 'ng.hid.event-envelope' as const,
  schemaVersion: 1 as const,
  id,
  type: 'LabResultReleased',
  version: 1 as const,
  occurredAt: '2026-08-12T10:00:00.000Z',
  producer: 'lab' as const,
  correlationId: 'correlation-0001',
  context: { facilityId: null, patientId: recipient.id },
  payload: {},
});

describe('NovuOrchestrator subscriber synchronization', () => {
  afterEach(() => jest.restoreAllMocks());

  it('upserts the canonical subscriber before triggering the workflow', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { subscriberId: recipient.id } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { transactionId: 'transaction-1' } }), { status: 201 }));

    const result = await new NovuOrchestrator(config()).trigger(testEvent('10000000-0000-4000-8000-000000000001'), recipient);

    expect(result.outcome).toBe('accepted');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const subscriberRequest = fetchMock.mock.calls[0][1] as RequestInit;
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.novu.co/v2/subscribers');
    expect(JSON.parse(String(subscriberRequest.body))).toEqual({
      subscriberId: recipient.id,
      email: recipient.email,
      firstName: recipient.firstName,
      lastName: recipient.lastName,
    });
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers)
      .toEqual(expect.objectContaining({ 'idempotency-key': '10000000-0000-4000-8000-000000000001' }));
  });

  it('reconciles an existing subscriber to the current verified email before triggering', async () => {
    const updatedRecipient = { ...recipient, email: 'new-controlled@example.test' };
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { subscriberId: recipient.id } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { transactionId: 'transaction-2' } }), { status: 201 }));

    const result = await new NovuOrchestrator(config()).trigger(
      testEvent('10000000-0000-4000-8000-000000000004'),
      updatedRecipient,
    );

    expect(result.outcome).toBe('accepted');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      subscriberId: updatedRecipient.id,
      email: updatedRecipient.email,
      firstName: updatedRecipient.firstName,
      lastName: updatedRecipient.lastName,
    });
  });

  it('does not trigger when no verified recipient exists', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    const result = await new NovuOrchestrator(config()).trigger(testEvent('10000000-0000-4000-8000-000000000002'), null);
    expect(result).toEqual({
      outcome: 'definitive_failure',
      provider: 'novu',
      safeCode: 'PATIENT_VERIFIED_EMAIL_UNAVAILABLE',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps subscriber sync failures retryable for transient Novu errors', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('', { status: 503 }));
    const result = await new NovuOrchestrator(config()).trigger(testEvent('10000000-0000-4000-8000-000000000003'), recipient);
    expect(result.outcome).toBe('unknown');
    expect(result.safeCode).toBe('NOVU_HTTP_503');
  });
});
