import { FcmPushProvider } from './fcm.provider';
import { readConfig } from './config';
import { NovuOrchestrator } from './novu.orchestrator';

const event = {
  schema: 'ng.hid.event-envelope' as const, schemaVersion: 1 as const,
  id: '10000000-0000-4000-8000-000000000001', type: 'LabResultReleased', version: 1 as const,
  occurredAt: '2026-08-12T10:00:00.000Z', producer: 'lab' as const, correlationId: 'correlation-0001',
  context: { facilityId: null, patientId: '30000000-0000-4000-8000-000000000001' }, payload: {},
};

describe('ordinary notification providers', () => {
  afterEach(() => jest.restoreAllMocks());

  it('creates a first-time subscriber with the verified email before triggering generic content', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { transactionId: 'novu-1' } }), { status: 201 }));
    const config = readConfig({ NODE_ENV: 'test', NOVU_MODE: 'live', NOVU_API_KEY: 'server-secret' });
    await expect(new NovuOrchestrator(config).trigger(event, 'patient@example.invalid'))
      .resolves.toMatchObject({ outcome: 'accepted', providerMessageId: 'novu-1' });

    expect(fetchMock.mock.calls).toHaveLength(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.novu.co/v2/subscribers/${event.context.patientId}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ email: 'patient@example.invalid' });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.novu.co/v2/subscribers');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      subscriberId: event.context.patientId, email: 'patient@example.invalid',
    });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('idempotency-key'))
      .toBe(`subscriber:${event.id}`);
    const trigger = fetchMock.mock.calls[2]?.[1]!;
    expect(new Headers(trigger.headers).get('idempotency-key')).toBe(event.id);
    const triggerBody = JSON.parse(String(trigger.body));
    expect(triggerBody.payload).toEqual({ message: 'You have a new update in HID. Sign in securely to view it.' });
    expect(JSON.stringify(triggerBody)).not.toMatch(/patient@example\.invalid|diagnosis|resultValue|medication|nin/i);
  });

  it('updates an existing subscriber when the verified email changes before triggering', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { transactionId: 'novu-2' } }), { status: 201 }));
    const config = readConfig({ NODE_ENV: 'test', NOVU_MODE: 'live', NOVU_API_KEY: 'server-secret' });
    await expect(new NovuOrchestrator(config).trigger(event, 'changed@example.invalid'))
      .resolves.toMatchObject({ outcome: 'accepted', providerMessageId: 'novu-2' });
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ email: 'changed@example.invalid' });
    expect(JSON.stringify(fetchMock.mock.calls[1]?.[1]?.body)).not.toContain('changed@example.invalid');
  });

  it('returns a retryable result and does not trigger the workflow when subscriber sync is unavailable', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    const config = readConfig({ NODE_ENV: 'test', NOVU_MODE: 'live', NOVU_API_KEY: 'server-secret' });
    await expect(new NovuOrchestrator(config).trigger(event, 'patient@example.invalid'))
      .resolves.toEqual({ outcome: 'unknown', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_HTTP_503' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a definitive result and does not trigger the workflow when subscriber sync is rejected', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 400 }));
    const config = readConfig({ NODE_ENV: 'test', NOVU_MODE: 'live', NOVU_API_KEY: 'server-secret' });
    await expect(new NovuOrchestrator(config).trigger(event, 'patient@example.invalid'))
      .resolves.toEqual({ outcome: 'definitive_failure', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_HTTP_400' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('FCM keeps credentials server-side and sends only generic notification text', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ name: 'projects/hid/messages/1' }), { status: 200 }));
    const provider = new FcmPushProvider({ projectId: 'hid-project', apiUrl: 'https://fcm.googleapis.com' },
      { accessToken: async () => 'short-lived-server-token' });
    await expect(provider.send({ deviceToken: 'protected-device-token', idempotencyKey: event.id }))
      .resolves.toMatchObject({ outcome: 'accepted', provider: 'fcm' });
    const init = fetchMock.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer short-lived-server-token');
    expect(String(init.body)).toContain('Sign in securely to view it.');
  });
});
