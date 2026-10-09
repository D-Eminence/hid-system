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

  it('Novu sends only generic content and uses the event id for idempotency', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { transactionId: 'novu-1' } }), { status: 201 }));
    const config = readConfig({ NODE_ENV: 'test', NOVU_MODE: 'live', NOVU_API_KEY: 'server-secret' });
    await expect(new NovuOrchestrator(config).trigger(event)).resolves.toMatchObject({ outcome: 'accepted', providerMessageId: 'novu-1' });
    const init = fetchMock.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('idempotency-key')).toBe(event.id);
    const body = JSON.parse(String(init.body));
    expect(body.payload).toEqual({ message: 'You have a new update in HID. Sign in securely to view it.' });
    expect(JSON.stringify(body)).not.toMatch(/diagnosis|resultValue|medication|nin/i);
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
