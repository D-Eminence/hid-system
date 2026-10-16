import { createHash } from 'node:crypto';
import { readConfig } from './config';
import { NovuOrchestrator } from './novu.orchestrator';

// The subscriber calls behind NOVU_SUBSCRIBER_SYNC=email (ADR-064). trigger()
// is main's call and is covered, unchanged, by providers.spec.ts.
const event = {
  schema: 'ng.hid.event-envelope' as const, schemaVersion: 1 as const,
  id: '10000000-0000-4000-8000-000000000001', type: 'PatientAccessPinVerified', version: 1 as const,
  occurredAt: '2026-08-12T10:00:00.000Z', producer: 'identity' as const, correlationId: 'correlation-0001',
  context: { facilityId: '20000000-0000-4000-8000-000000000001', patientId: '30000000-0000-4000-8000-000000000001' },
  payload: { consentGrantId: '40000000-0000-4000-8000-000000000001', reviewRequired: true },
};
const subscriberId = event.context.patientId;
const email = 'synthetic.patient@example.invalid';
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const live = () => new NovuOrchestrator(readConfig({ NODE_ENV: 'test', HID_DEPLOYMENT_ENV: 'development',
  NOVU_MODE: 'live', NOVU_API_KEY: 'server-secret', NOVU_API_URL: 'https://novu.example.invalid/',
  NOVU_SUBSCRIBER_SYNC: 'email' }));
const respond = (status: number, body: unknown = {}) =>
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
const headers = (fetchMock: jest.SpyInstance) => new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
const body = (fetchMock: jest.SpyInstance) => JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));

describe('Novu subscriber email sync', () => {
  afterEach(() => jest.restoreAllMocks());

  it('upserts the subscriber with exactly its id and the verified email, keyed by event and email digest', async () => {
    const fetchMock = respond(201, { data: { subscriberId } });
    await expect(live().syncSubscriberEmail(subscriberId, email, event.id))
      .resolves.toEqual({ outcome: 'confirmed', provider: 'novu' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://novu.example.invalid/v2/subscribers');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(headers(fetchMock).get('authorization')).toBe('ApiKey server-secret');
    expect(headers(fetchMock).get('content-type')).toBe('application/json');
    expect(headers(fetchMock).get('idempotency-key'))
      .toBe(sha256(`hid-novu-subscriber-email-v1\u001f${event.id}\u001f${sha256(email)}`));
    expect(headers(fetchMock).get('idempotency-key')).toMatch(/^[0-9a-f]{64}$/);
    expect(String(init.body)).toBe(JSON.stringify({ subscriberId, email }));
    expect(String(init.body)).not.toMatch(/firstName|lastName|phone|name/i);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('binds the key to the email: the same input gives the same key, another email another key', async () => {
    const fetchMock = respond(201);
    const orchestrator = live();
    await orchestrator.syncSubscriberEmail(subscriberId, email, event.id);
    await orchestrator.syncSubscriberEmail(subscriberId, email, event.id);
    await orchestrator.syncSubscriberEmail(subscriberId, 'other.synthetic@example.invalid', event.id);
    const keys = fetchMock.mock.calls.map((call) => new Headers((call[1] as RequestInit).headers).get('idempotency-key'));
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys.join()).not.toContain(email);
  });

  it.each([[408], [409], [429], [500], [503]])('answers unknown for HTTP %i', async (status) => {
    respond(status);
    await expect(live().syncSubscriberEmail(subscriberId, email, event.id))
      .resolves.toEqual({ outcome: 'unknown', provider: 'novu', safeCode: `NOVU_SUBSCRIBER_HTTP_${status}` });
  });

  it('answers unknown for a timeout or network failure', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('synthetic network failure'));
    await expect(live().syncSubscriberEmail(subscriberId, email, event.id))
      .resolves.toEqual({ outcome: 'unknown', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_TIMEOUT_OR_UNAVAILABLE' });
  });

  it.each([[400], [401], [404], [422]])('answers rejected for HTTP %i', async (status) => {
    respond(status);
    await expect(live().syncSubscriberEmail(subscriberId, email, event.id))
      .resolves.toEqual({ outcome: 'rejected', provider: 'novu', safeCode: `NOVU_SUBSCRIBER_HTTP_${status}` });
  });

  it('makes no request in test mode and refuses without a key', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const test = new NovuOrchestrator(readConfig({ NODE_ENV: 'test', HID_DEPLOYMENT_ENV: 'development',
      NOVU_MODE: 'test', NOVU_SUBSCRIBER_SYNC: 'email' }));
    await expect(test.syncSubscriberEmail(subscriberId, email, event.id)).resolves.toEqual({ outcome: 'confirmed', provider: 'novu' });
    await expect(test.clearSubscriberEmail(subscriberId, event.id)).resolves.toEqual({ outcome: 'confirmed', provider: 'novu' });
    await expect(test.triggerWithEmailWithheld(event)).resolves.toMatchObject({ outcome: 'accepted', provider: 'novu' });
    const keyless = new NovuOrchestrator(readConfig({ NODE_ENV: 'test', NOVU_MODE: 'disabled' }));
    await expect(keyless.syncSubscriberEmail(subscriberId, email, event.id))
      .resolves.toEqual({ outcome: 'rejected', provider: 'novu', safeCode: 'NOVU_NOT_CONFIGURED' });
    await expect(keyless.clearSubscriberEmail(subscriberId, event.id))
      .resolves.toEqual({ outcome: 'rejected', provider: 'novu', safeCode: 'NOVU_NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Novu subscriber email clear (the opt-out holds after an earlier sync)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sets the subscriber email to null and nothing else, keyed by the event', async () => {
    const fetchMock = respond(200, { data: { subscriberId } });
    await expect(live().clearSubscriberEmail(subscriberId, event.id)).resolves.toEqual({ outcome: 'confirmed', provider: 'novu' });
    expect(fetchMock.mock.calls[0][0]).toBe(`https://novu.example.invalid/v2/subscribers/${subscriberId}`);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
    expect(String((fetchMock.mock.calls[0][1] as RequestInit).body)).toBe('{"email":null}');
    expect(headers(fetchMock).get('idempotency-key')).toBe(sha256(`hid-novu-subscriber-email-clear-v1\u001f${event.id}`));
  });

  it('treats a subscriber Novu does not have as cleared', async () => {
    respond(404);
    await expect(live().clearSubscriberEmail(subscriberId, event.id))
      .resolves.toEqual({ outcome: 'confirmed', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_ABSENT' });
  });

  it.each([[408, 'unknown'], [409, 'unknown'], [429, 'unknown'], [503, 'unknown'], [400, 'rejected'], [422, 'rejected']])(
    'answers HTTP %i as %s', async (status, outcome) => {
      respond(status);
      await expect(live().clearSubscriberEmail(subscriberId, event.id))
        .resolves.toEqual({ outcome, provider: 'novu', safeCode: `NOVU_SUBSCRIBER_HTTP_${status}` });
    });
});

describe('Novu trigger with the email withheld (used only when the clear is not confirmed)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends main\'s workflow and generic message to the subscriber id with the email cleared in the same request', async () => {
    const fetchMock = respond(201, { data: { transactionId: 'novu-withheld-1' } });
    await expect(live().triggerWithEmailWithheld(event))
      .resolves.toEqual({ outcome: 'accepted', provider: 'novu', providerMessageId: 'novu-withheld-1' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://novu.example.invalid/v1/events/trigger');
    expect(body(fetchMock)).toEqual({ name: 'patient-update-v1', to: { subscriberId, email: null },
      payload: { message: 'You have a new update in HID. Sign in securely to view it.' } });
    expect(headers(fetchMock).get('idempotency-key')).toBe(sha256(`hid-novu-trigger-email-withheld-v1\u001f${event.id}`));
  });

  it.each([[408, 'unknown'], [429, 'unknown'], [503, 'unknown'], [400, 'definitive_failure']])(
    'classifies HTTP %i as main\'s trigger does (%s)', async (status, outcome) => {
      respond(status);
      await expect(live().triggerWithEmailWithheld(event))
        .resolves.toEqual({ outcome, provider: 'novu', safeCode: `NOVU_HTTP_${status}` });
    });

  it('main\'s trigger is unchanged: one call, the event id as key, the subscriber id only', async () => {
    const fetchMock = respond(201, { data: { transactionId: 'novu-1' } });
    await live().trigger(event);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headers(fetchMock).get('idempotency-key')).toBe(event.id);
    expect(body(fetchMock)).toEqual({ name: 'patient-update-v1', to: { subscriberId },
      payload: { message: 'You have a new update in HID. Sign in securely to view it.' } });
  });
});
