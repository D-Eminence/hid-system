import { parseSqsEvent, WORKFLOW_BY_EVENT } from './event';
const event = { schema: 'ng.hid.event-envelope', schemaVersion: 1, version: 1,
  id: '10000000-0000-4000-8000-000000000001', type: 'EmergencyAccessActivated',
  producer: 'identity', correlationId: 'synthetic-correlation',
  context: { patientId: '20000000-0000-4000-8000-000000000001', facilityId: '30000000-0000-4000-8000-000000000001' },
  payload: { consentGrantId: '40000000-0000-4000-8000-000000000001', reviewRequired: true } };
it('routes minimal emergency notice through the existing generic patient workflow', () => {
  expect(parseSqsEvent(JSON.stringify({ detail: event }))).toEqual(event);
  expect(WORKFLOW_BY_EVENT.EmergencyAccessActivated).toBe('patient-update-v1');
});
it.each([
  { producer: 'lab' },
  { payload: { ...event.payload, reason: 'Sensitive emergency reason' } },
  { payload: { ...event.payload, reviewRequired: false } },
  { payload: { ...event.payload, consentGrantId: 'unknown' } },
])('rejects invalid or overbroad emergency notification %j', (change) => {
  expect(() => parseSqsEvent(JSON.stringify({ detail: { ...event, ...change } }))).toThrow('INVALID_EMERGENCY_NOTIFICATION_CONTRACT');
});
