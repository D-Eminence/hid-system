import { EventContractFailure, type ClaimedEvent, type EventProducer,
  type HidEventEnvelopeV1 } from './types';

const EVENT_TYPES: Readonly<Record<EventProducer, ReadonlySet<string>>> = {
  identity: new Set(['PatientRegistered', 'PatientIdentifierAdded', 'PatientIdentityResolved']),
  ocr: new Set(['OcrJobQueued', 'OcrProcessingStarted', 'OcrExtractionCreated',
    'OcrAwaitingValidation', 'OcrValidated', 'OcrValidationRejected', 'OcrFailed',
    'OcrJobCancelled', 'OcrPatientConfirmed', 'OcrPublicationRequested',
    'OcrPublicationSucceeded', 'OcrPublicationFailed']),
  lab: new Set(['LabImportedEvidenceCreated', 'LabImportedEvidenceAmended', 'LabWorkItemCreated',
    'LabAccessionCreated', 'LabSpecimenCollected', 'LabSpecimenReceived', 'LabSpecimenRejected',
    'LabTestExecutionStarted', 'LabTestExecutionCompleted', 'LabResultEntered',
    'LabResultCorrected', 'LabResultVerified', 'LabResultReleased', 'LabResultAmended',
    'LabResultEnteredInError']),
  pharmacy: new Set(['PharmacyWorkItemCreated', 'MedicationDispensed',
    'MedicationDispensingReversed', 'PharmacyImportedMedicationEvidenceCreated']),
  outreach: new Set(['OutreachRegistrationCaseCreated', 'OutreachPatientResolved']),
};

const ALLOWED_PAYLOAD_KEYS: Readonly<Record<EventProducer, ReadonlySet<string>>> = {
  identity: new Set(['source', 'identifierType', 'verified', 'resolution']),
  ocr: new Set(['jobId', 'documentId', 'status', 'patientResolved', 'confirmationId',
    'publicationId', 'validationId', 'targetResourceType', 'targetResourceId',
    'failureCode', 'retryable']),
  lab: new Set(['importId', 'sourceType', 'workItemId', 'sourceEhrOrderId',
    'sourceEhrOrderVersion', 'status', 'accessionId', 'specimenId', 'rowVersion',
    'requestedTestId', 'executionId', 'resultId', 'version', 'verificationStatus',
    'entrySource', 'resultVersion']),
  pharmacy: new Set(['workItemId', 'sourceEhrPrescriptionId', 'sourceEhrPrescriptionVersion',
    'sourcePrescriptionId', 'sourcePrescriptionVersion', 'status', 'dispensingId',
    'reversalId', 'importId', 'importedMedicationEvidenceId', 'sourceType', 'activityStatus']),
  outreach: new Set(['registrationCaseId', 'temporaryPatientId', 'canonicalPatientId',
    'status', 'resolutionKind']),
};

const FORBIDDEN_KEYS = new Set(['nin', 'rawnin', 'name', 'firstname', 'lastname', 'fullname',
  'dateofbirth', 'dob', 'email', 'phone', 'demographics', 'rawtext', 'extractedtext',
  'ocrtext', 'fulltext', 'resultvalue', 'numericvalue', 'textvalue', 'value',
  'medicationtext', 'strengthtext', 'dosetext', 'frequencytext', 'instructions']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function eventEnvelope(event: ClaimedEvent): HidEventEnvelopeV1 {
  if (!EVENT_TYPES[event.producer].has(event.eventType) || event.eventVersion !== 1) {
    throw new EventContractFailure('UNSUPPORTED_EVENT_CONTRACT',
      'Event type or version is not registered for external delivery');
  }
  for (const value of [event.eventId, event.aggregateId, event.facilityId, event.patientId, event.causationId]) {
    if (value !== null && !UUID.test(value)) {
      throw new EventContractFailure('INVALID_EVENT_ENVELOPE', 'Event envelope contains an invalid identifier');
    }
  }
  if (!Number.isSafeInteger(event.aggregateVersion) || event.aggregateVersion < 1
      || !event.correlationId || event.correlationId.length > 128
      || !Number.isFinite(event.occurredAt.getTime())) {
    throw new EventContractFailure('INVALID_EVENT_ENVELOPE', 'Event envelope metadata is invalid');
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify(event.payload), 'utf8');
  if (payloadBytes > 8_192 || !isPlainObject(event.payload)) {
    throw new EventContractFailure('EVENT_PAYLOAD_POLICY_REJECTED', 'Event payload violates the delivery size or shape policy');
  }
  for (const key of Object.keys(event.payload)) {
    if (!ALLOWED_PAYLOAD_KEYS[event.producer].has(key)) {
      throw new EventContractFailure('EVENT_PAYLOAD_POLICY_REJECTED', 'Event payload contains a field outside its producer contract');
    }
  }
  validateRecursively(event.payload, 0);
  return Object.freeze({ schema: 'ng.hid.event-envelope', schemaVersion: 1,
    id: event.eventId, type: event.eventType, version: event.eventVersion,
    occurredAt: event.occurredAt.toISOString(), producer: event.producer,
    aggregate: Object.freeze({ type: event.aggregateType, id: event.aggregateId,
      version: event.aggregateVersion }), correlationId: event.correlationId,
    causationId: event.causationId, context: Object.freeze({ facilityId: event.facilityId,
      patientId: event.patientId }), payload: event.payload });
}

function validateRecursively(value: unknown, depth: number): void {
  if (depth > 4) throw policyFailure();
  if (typeof value === 'string' && value.length > 512) throw policyFailure();
  if (Array.isArray(value)) {
    if (value.length > 50) throw policyFailure();
    value.forEach((item) => validateRecursively(item, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) throw policyFailure();
      validateRecursively(nested, depth + 1);
    }
  }
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function policyFailure(): EventContractFailure {
  return new EventContractFailure('EVENT_PAYLOAD_POLICY_REJECTED',
    'Event payload violates the minimum-necessary delivery policy');
}
