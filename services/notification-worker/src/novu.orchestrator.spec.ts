import { readConfig } from './config';
import { NovuOrchestrator } from './novu.orchestrator';

const patientId = '30000000-0000-4000-8000-000000000001';
const verifiedEmail = 'controlled@example.test';

function config() {
  return readConfig({
    NODE_ENV: 'test',
    NOTIFICATION_WORKER_ENABLED: 'false',
    NOVU_MODE: 'live',
    NOVU_API_KEY: 'test-key',
  });
}

function testEvent(id: string) {
  return {
    schema: 'ng.hid.event-envelope' as const,
    schemaVersion: 1 as const,
    id,
    type: 'LabResultReleased',
    version: 1 as const,
    occurredAt: '2026-08-12T10:00:00.000Z',
    producer: 'lab' as const,
    correlationId: 'correlation-0001',
    context: { facilityId: null, patientId },
    payload: {},
  };
}

describe('NovuOrchestrator subscriber synchronization', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reconciles a concurrent subscriber create before triggering the workflow', async () => {
    const id = '10000000-0000-4000-8000-000000000001';
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { transactionId: 'transaction-1' } }), { status: 201 }));

    await expect(new NovuOrchestrator(config()).trigger(testEvent(id), verifiedEmail))
      .resolves.toMatchObject({ outcome: 'accepted', providerMessageId: 'transaction-1' });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.novu.co/v2/subscribers/${patientId}`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.novu.co/v2/subscribers');
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`https://api.novu.co/v2/subscribers/${patientId}`);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ subscriberId: patientId, email: verifiedEmail });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('idempotency-key')).toBe(`subscriber:${id}`);
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('idempotency-key')).toBe(`subscriber:${id}`);
    expect(new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get('idempotency-key')).toBe(id);
    const triggerBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
    expect(triggerBody).toEqual(expect.objectContaining({
      to: { subscriberId: patientId },
      payload: { message: 'You have a new update in HID. Sign in securely to view it.' },
    }));
    expect(JSON.stringify(triggerBody)).not.toContain(verifiedEmail);
  });

  it('does not trigger after a definitive subscriber synchronization failure', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 400 }));

    await expect(new NovuOrchestrator(config()).trigger(
      testEvent('10000000-0000-4000-8000-000000000002'), verifiedEmail,
    )).resolves.toEqual({ outcome: 'definitive_failure', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_HTTP_400' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
