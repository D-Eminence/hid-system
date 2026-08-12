import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { EventDispatcherConfig } from './config';
import { EventBridgeEventTransport, classifyEventBridgeFailure } from './eventbridge.transport';
import type { HidEventEnvelopeV1 } from './types';

const config = { AWS_REGION: 'eu-west-1', EVENTBRIDGE_EVENT_BUS_NAME: 'hid-events',
  EVENT_DISPATCHER_TRANSPORT_TIMEOUT_MS: 5_000 } as EventDispatcherConfig;
const first: HidEventEnvelopeV1 = { schema: 'ng.hid.event-envelope', schemaVersion: 1,
  id: '10000000-0000-4000-8000-000000000001', type: 'PatientRegistered', version: 1,
  occurredAt: '2026-08-11T10:00:00.000Z', producer: 'identity', aggregate: {
    type: 'identity-registration-case', id: '20000000-0000-4000-8000-000000000001', version: 1 },
  correlationId: 'correlation-12345678', causationId: null,
  context: { facilityId: null, patientId: null }, payload: { source: 'governed-nin-registration' } };

describe('EventBridge transport', () => {
  it('preserves partial success per input entry', async () => {
    const client = new EventBridgeClient({ region: 'eu-west-1' });
    const send = jest.spyOn(client, 'send').mockResolvedValue({ FailedEntryCount: 1,
      Entries: [{ EventId: 'provider-id' }, { ErrorCode: 'ThrottlingException' }] } as never);
    const second = { ...first, id: '10000000-0000-4000-8000-000000000002' };
    const result = await new EventBridgeEventTransport(config, client)
      .publish([first, second], new AbortController().signal);
    expect(result).toEqual([{ eventId: first.id, accepted: true, messageId: 'provider-id' },
      { eventId: second.id, accepted: false, failure: expect.objectContaining({ retryable: true }) }]);
    const command = send.mock.calls[0]?.[0];
    expect(command?.input).toMatchObject({ Entries: expect.arrayContaining([expect.objectContaining({
      EventBusName: 'hid-events', Source: 'ng.hid.identity', DetailType: 'PatientRegistered.v1' })]) });
    const input = command?.input as { Entries?: Array<{ Detail?: string }> };
    expect(JSON.parse(String(input.Entries?.[0]?.Detail))).toEqual(first);
  });

  it('classifies authorization failures as terminal and timeouts as retryable', () => {
    expect(classifyEventBridgeFailure(Object.assign(new Error(), { name: 'AccessDeniedException' })))
      .toMatchObject({ retryable: false });
    expect(classifyEventBridgeFailure(Object.assign(new Error(), { name: 'TimeoutError' })))
      .toMatchObject({ code: 'EVENTBRIDGE_TIMEOUT', retryable: true });
  });
});
