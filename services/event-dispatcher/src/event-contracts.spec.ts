import { eventEnvelope } from './event-contracts';
import type { ClaimedEvent } from './types';

const event: ClaimedEvent = { producer: 'identity',
  eventId: '10000000-0000-4000-8000-000000000001', eventType: 'PatientRegistered',
  eventVersion: 1, occurredAt: new Date('2026-08-11T10:00:00.000Z'),
  aggregateType: 'identity-registration-case',
  aggregateId: '20000000-0000-4000-8000-000000000001', aggregateVersion: 2,
  correlationId: 'correlation-12345678', causationId: null,
  facilityId: '30000000-0000-4000-8000-000000000001',
  patientId: '40000000-0000-4000-8000-000000000001',
  payload: { source: 'governed-nin-registration' }, attemptCount: 1,
  claimToken: '50000000-0000-4000-8000-000000000001',
  claimExpiresAt: new Date('2026-08-11T10:01:00.000Z') };

describe('HID event envelope v1', () => {
  it('constructs the stable PHI-minimal versioned envelope', () => {
    expect(eventEnvelope(event)).toEqual({ schema: 'ng.hid.event-envelope', schemaVersion: 1,
      id: event.eventId, type: 'PatientRegistered', version: 1,
      occurredAt: '2026-08-11T10:00:00.000Z', producer: 'identity',
      aggregate: { type: event.aggregateType, id: event.aggregateId, version: 2 },
      correlationId: event.correlationId, causationId: null,
      context: { facilityId: event.facilityId, patientId: event.patientId }, payload: event.payload });
  });

  it('rejects unsupported type/version combinations terminally', () => {
    expect(() => eventEnvelope({ ...event, eventVersion: 2 })).toThrow(/not registered/);
    expect(() => eventEnvelope({ ...event, eventType: 'InventedPatientEffect' })).toThrow(/not registered/);
  });

  it('rejects unknown and recursively sensitive payload fields', () => {
    expect(() => eventEnvelope({ ...event, payload: { displayName: 'Patient Name' } }))
      .toThrow(/outside its producer contract/);
    expect(() => eventEnvelope({ ...event, payload: { source: { nested: { rawNin: '12345678901' } } } }))
      .toThrow(/minimum-necessary/);
  });
});
