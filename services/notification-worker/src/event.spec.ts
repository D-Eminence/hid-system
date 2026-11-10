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
it('routes the minimal patient-PIN verification notice through the same patient workflow', () => {
  const pinAccess = { ...event, type: 'PatientAccessPinVerified' };
  expect(parseSqsEvent(JSON.stringify({ detail: pinAccess }))).toEqual(pinAccess);
  expect(WORKFLOW_BY_EVENT.PatientAccessPinVerified).toBe('patient-update-v1');
});
it.each(['write_records', 'read_records'])('routes a patient-PIN notice that names its grant\'s scope (%s, 0121)', (scope) => {
  const pinAccess = { ...event, type: 'PatientAccessPinVerified', payload: { ...event.payload, scope } };
  expect(parseSqsEvent(JSON.stringify({ detail: pinAccess }))).toEqual(pinAccess);
});
it.each([
  { payload: { ...event.payload, scope: 'break_glass' } },
  { payload: { ...event.payload, scope: null } },
  { payload: { consentGrantId: event.payload.consentGrantId, scope: 'write_records' } },
  { payload: { ...event.payload, scope: 'write_records', reviewRequired: false } },
])('rejects an invalid patient-PIN notice %j', (change) => {
  expect(() => parseSqsEvent(JSON.stringify({ detail: { ...event, type: 'PatientAccessPinVerified', ...change } })))
    .toThrow('INVALID_PATIENT_PIN_NOTIFICATION_CONTRACT');
});
it('rejects an emergency notice that names a scope', () => {
  expect(() => parseSqsEvent(JSON.stringify({ detail: { ...event, payload: { ...event.payload, scope: 'write_records' } } })))
    .toThrow('INVALID_EMERGENCY_NOTIFICATION_CONTRACT');
});
it.each([
  { producer: 'lab' },
  { payload: { ...event.payload, reason: 'Sensitive emergency reason' } },
  { payload: { ...event.payload, reviewRequired: false } },
  { payload: { ...event.payload, consentGrantId: 'unknown' } },
])('rejects invalid or overbroad emergency notification %j', (change) => {
  expect(() => parseSqsEvent(JSON.stringify({ detail: { ...event, ...change } }))).toThrow('INVALID_EMERGENCY_NOTIFICATION_CONTRACT');
});
