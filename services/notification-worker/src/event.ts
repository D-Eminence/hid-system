import type { HidEventEnvelope } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCERS = new Set(['identity', 'ocr', 'lab', 'pharmacy', 'outreach']);

export const WORKFLOW_BY_EVENT: Readonly<Record<string, string>> = Object.freeze({
  PatientRegistered: 'identity-registration-update-v1',
  PatientIdentityResolved: 'identity-resolution-update-v1',
  OcrPublicationSucceeded: 'document-update-v1',
  LabResultReleased: 'patient-update-v1',
  MedicationDispensed: 'patient-update-v1',
  OutreachPatientResolved: 'identity-resolution-update-v1',
});

export function parseSqsEvent(body: string | undefined): HidEventEnvelope {
  if (!body || Buffer.byteLength(body, 'utf8') > 64 * 1024) throw new Error('INVALID_EVENT_MESSAGE');
  const outer = JSON.parse(body) as { detail?: unknown };
  const event = outer.detail as Partial<HidEventEnvelope> | undefined;
  if (!event || event.schema !== 'ng.hid.event-envelope' || event.schemaVersion !== 1
      || event.version !== 1 || !UUID.test(String(event.id))
      || !PRODUCERS.has(String(event.producer))
      || typeof event.type !== 'string' || !WORKFLOW_BY_EVENT[event.type]
      || typeof event.correlationId !== 'string' || event.correlationId.length < 8
      || !event.context || !UUID.test(String(event.context.patientId))
      || typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) {
    throw new Error('INVALID_EVENT_CONTRACT');
  }
  return event as HidEventEnvelope;
}
