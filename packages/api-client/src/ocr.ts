export type OcrTargetDomain = 'EHR' | 'LAB' | 'PHARMACY' | 'DOCUMENT_ONLY' | 'UNCLASSIFIED';
export type OcrCandidateType = 'clinical_note' | 'document_only' | 'lab_document'
  | 'historical_medication_evidence' | 'unclassified';
export type OcrPurposeOfUse = 'direct-care' | 'healthcare-operations';

export interface OcrCreateJobInput {
  documentId: string;
  patientId?: string;
  provider: string;
  maxAttempts?: number;
  purpose: 'healthcare-operations';
}
export interface OcrValidationInput {
  extractionId: string; expectedVersion: number; validatedPayload: Record<string, unknown>;
  disposition: 'validated' | 'rejected'; targetDomain: OcrTargetDomain;
  candidateType: OcrCandidateType; acceptedFields: Record<string, unknown>;
  rejectedFields: Record<string, unknown>[]; corrections: Record<string, unknown>[];
  reason: string; purpose: 'healthcare-operations';
}
export interface OcrPatientConfirmationInput {
  patientId: string; expectedJobVersion: number;
  method: 'source_document' | 'hid' | 'verified_nin' | 'reviewed_candidate';
  reason: string; purpose: 'healthcare-operations';
}
export interface OcrPublicationInput {
  validationVersion: number; patientConfirmationId: string;
  targetOperation: 'create_imported_clinical_note' | 'create_imported_lab_evidence'
    | 'create_imported_medication_evidence' | 'retain_validated_document';
  purpose: 'direct-care';
}
export interface OcrRetryInput {
  expectedVersion: number;
  reason: string;
  purpose: 'healthcare-operations';
}
export interface OcrPatientConfirmation {
  id: string; patientId: string; version: number; method: string; confirmedAt: string;
}
export interface OcrJob {
  id: string; facilityId: string; documentId: string; patientId: string | null;
  status: string; provider: string; attemptCount: number; maxAttempts: number;
  version: number; createdAt: string; patientConfirmation: OcrPatientConfirmation | null;
}
export interface OcrExtraction {
  id: string; version: number; attempt: number; provider: string; providerModel: string | null;
  rawText: string; structuredPayload: Record<string, unknown>; confidence: number | null;
  provenance: Record<string, unknown>; createdAt: string;
}
export interface OcrValidation {
  id: string; jobId: string; extractionId: string; version: number;
  disposition: 'validated' | 'rejected'; targetDomain: OcrTargetDomain;
  candidateType: OcrCandidateType; acceptedFields: Record<string, unknown>;
  rejectedFields: Record<string, unknown>[]; corrections: Record<string, unknown>[];
  reason: string; reviewedAt: string;
}
export interface OcrPublicationResult {
  id: string; validationId: string; validationVersion: number; patientConfirmationId: string;
  patientId: string; targetDomain: Exclude<OcrTargetDomain, 'UNCLASSIFIED'>;
  targetOperation: OcrPublicationInput['targetOperation'];
  status: 'pending' | 'processing' | 'published' | 'failed';
  targetResourceType: string | null; targetResourceId: string | null;
  failureCode: string | null; failureSummary: string | null;
  attemptCount: number; maxAttempts: number; version: number;
}
export interface OcrTransportRequest {
  path: string; method: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string;
  purposeOfUse: OcrPurposeOfUse; signal?: AbortSignal;
}
export type OcrTransport = (request: OcrTransportRequest) => Promise<unknown>;
export interface OcrClientOptions { transport: OcrTransport; }

export class OcrContractError extends Error {
  constructor(message: string) { super(message); this.name = 'OcrContractError'; }
}

export class OcrApiClient {
  constructor(private readonly options: OcrClientOptions) {}
  async createJob(input: OcrCreateJobInput, key: string, signal?: AbortSignal): Promise<OcrJob> {
    return parseJob(await this.command('/api/v1/ocr/jobs', input, key,
      'healthcare-operations', signal));
  }
  async findJob(documentId: string, signal?: AbortSignal): Promise<OcrJob | null> {
    const payload = unwrap(await this.query(`/api/v1/ocr/jobs?documentId=${encodeURIComponent(documentId)}`,
      'healthcare-operations', signal));
    if (!isRecord(payload)) throw new OcrContractError('The OCR document job response is malformed.');
    return payload.job === null || payload.job === undefined ? null : parseJob(payload.job);
  }
  async getJob(jobId: string, signal?: AbortSignal): Promise<OcrJob> {
    return parseJob(await this.query(`/api/v1/ocr/jobs/${encodeURIComponent(jobId)}`,
      'healthcare-operations', signal));
  }
  async retryJob(jobId: string, input: OcrRetryInput, signal?: AbortSignal): Promise<OcrJob> {
    return parseJob(await this.options.transport({
      path: `/api/v1/ocr/jobs/${encodeURIComponent(jobId)}/retry`,
      method: 'POST', body: input, purposeOfUse: 'healthcare-operations', signal,
    }));
  }
  async listExtractions(jobId: string, signal?: AbortSignal): Promise<OcrExtraction[]> {
    return parseItems(await this.query(`/api/v1/ocr/jobs/${encodeURIComponent(jobId)}/extractions`,
      'healthcare-operations', signal), parseExtraction, 'OCR extraction');
  }
  async listValidations(jobId: string, signal?: AbortSignal): Promise<OcrValidation[]> {
    return parseItems(await this.query(`/api/v1/ocr/jobs/${encodeURIComponent(jobId)}/validations`,
      'healthcare-operations', signal), parseValidation, 'OCR validation');
  }
  async validate(jobId: string, input: OcrValidationInput, key: string,
    signal?: AbortSignal): Promise<void> {
    await this.command(`/api/v1/ocr/jobs/${encodeURIComponent(jobId)}/validations`, input, key,
      'healthcare-operations', signal);
  }
  async confirmPatient(jobId: string, input: OcrPatientConfirmationInput, key: string,
    signal?: AbortSignal): Promise<OcrPatientConfirmation> {
    return parseConfirmation(await this.command(
      `/api/v1/ocr/jobs/${encodeURIComponent(jobId)}/patient-confirmation`, input, key,
      'healthcare-operations', signal));
  }
  async publish(validationId: string, input: OcrPublicationInput, key: string,
    signal?: AbortSignal): Promise<OcrPublicationResult> {
    return parsePublication(await this.command(
      `/api/v1/ocr/validations/${encodeURIComponent(validationId)}/publications`, input, key,
      'direct-care', signal));
  }
  async listPublications(validationId: string, signal?: AbortSignal): Promise<OcrPublicationResult[]> {
    return parseItems(await this.query(
      `/api/v1/ocr/validations/${encodeURIComponent(validationId)}/publications`,
      'direct-care', signal), parsePublication, 'OCR publication');
  }
  private command(path: string, body: unknown, idempotencyKey: string,
    purposeOfUse: OcrPurposeOfUse, signal?: AbortSignal) {
    return this.options.transport({ path, method: 'POST', body, idempotencyKey, purposeOfUse, signal });
  }
  private query(path: string, purposeOfUse: OcrPurposeOfUse, signal?: AbortSignal) {
    return this.options.transport({ path, method: 'GET', purposeOfUse, signal });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function unwrap(value: unknown): unknown { return isRecord(value) && 'data' in value ? value.data : value; }
function string(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== 'string' || !value[key]) throw new OcrContractError(`OCR field ${key} is invalid.`);
  return value[key];
}
function number(value: Record<string, unknown>, key: string, minimum = 0): number {
  const parsed = value[key];
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < minimum) {
    throw new OcrContractError(`OCR field ${key} is invalid.`);
  }
  return parsed;
}
function integer(value: Record<string, unknown>, key: string, minimum = 0): number {
  const parsed = number(value, key, minimum);
  if (!Number.isInteger(parsed)) throw new OcrContractError(`OCR field ${key} is invalid.`);
  return parsed;
}
function oneOf<const Value extends string>(
  value: Record<string, unknown>, key: string, allowed: readonly Value[],
): Value {
  const parsed = string(value, key);
  if (!allowed.includes(parsed as Value)) throw new OcrContractError(`OCR field ${key} is invalid.`);
  return parsed as Value;
}
function record(value: unknown, label: string): Record<string, unknown> {
  const unwrapped = unwrap(value);
  if (!isRecord(unwrapped)) throw new OcrContractError(`${label} is malformed.`);
  return unwrapped;
}
function parseConfirmation(payload: unknown): OcrPatientConfirmation {
  const value = record(payload, 'The OCR patient confirmation response');
  return { id: string(value, 'id'), patientId: string(value, 'patientId'),
    version: integer(value, 'version', 1), method: string(value, 'method'),
    confirmedAt: string(value, 'confirmedAt') };
}
function parseJob(payload: unknown): OcrJob {
  const value = record(payload, 'The OCR job response');
  if (value.patientId !== null && typeof value.patientId !== 'string') {
    throw new OcrContractError('OCR field patientId is invalid.');
  }
  if (value.patientConfirmation !== null && value.patientConfirmation !== undefined
      && !isRecord(value.patientConfirmation)) {
    throw new OcrContractError('OCR field patientConfirmation is invalid.');
  }
  return { id: string(value, 'id'), facilityId: string(value, 'facilityId'),
    documentId: string(value, 'documentId'), patientId: typeof value.patientId === 'string' ? value.patientId : null,
    status: string(value, 'status'), provider: string(value, 'provider'),
    attemptCount: integer(value, 'attemptCount'), maxAttempts: integer(value, 'maxAttempts', 1),
    version: integer(value, 'version', 1), createdAt: string(value, 'createdAt'),
    patientConfirmation: isRecord(value.patientConfirmation) ? parseConfirmation(value.patientConfirmation) : null };
}
function parseExtraction(payload: unknown): OcrExtraction {
  const value = record(payload, 'An OCR extraction response');
  if (!isRecord(value.structuredPayload) || !isRecord(value.provenance)) {
    throw new OcrContractError('An OCR extraction response is malformed.');
  }
  if (value.confidence !== null && value.confidence !== undefined
      && (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence))) {
    throw new OcrContractError('OCR field confidence is invalid.');
  }
  return { id: string(value, 'id'), version: integer(value, 'version', 1),
    attempt: integer(value, 'attempt', 1),
    provider: string(value, 'provider'), providerModel: typeof value.providerModel === 'string' ? value.providerModel : null,
    rawText: string(value, 'rawText'), structuredPayload: value.structuredPayload,
    confidence: typeof value.confidence === 'number' ? value.confidence : null, provenance: value.provenance,
    createdAt: string(value, 'createdAt') };
}
function parseValidation(payload: unknown): OcrValidation {
  const value = record(payload, 'An OCR validation response');
  if (!isRecord(value.acceptedFields) || !Array.isArray(value.rejectedFields)
      || !value.rejectedFields.every(isRecord) || !Array.isArray(value.corrections)
      || !value.corrections.every(isRecord)) {
    throw new OcrContractError('An OCR validation response is malformed.');
  }
  return { id: string(value, 'id'), jobId: string(value, 'jobId'), extractionId: string(value, 'extractionId'),
    version: integer(value, 'version', 1),
    disposition: oneOf(value, 'disposition', ['validated', 'rejected'] as const),
    targetDomain: oneOf(value, 'targetDomain',
      ['EHR', 'LAB', 'PHARMACY', 'DOCUMENT_ONLY', 'UNCLASSIFIED'] as const),
    candidateType: oneOf(value, 'candidateType',
      ['clinical_note', 'document_only', 'lab_document',
        'historical_medication_evidence', 'unclassified'] as const),
    acceptedFields: value.acceptedFields, rejectedFields: value.rejectedFields,
    corrections: value.corrections, reason: string(value, 'reason'),
    reviewedAt: string(value, 'reviewedAt') };
}
function parsePublication(payload: unknown): OcrPublicationResult {
  const value = record(payload, 'The OCR publication response');
  return { id: string(value, 'id'), validationId: string(value, 'validationId'),
    validationVersion: integer(value, 'validationVersion', 1),
    patientConfirmationId: string(value, 'patientConfirmationId'), patientId: string(value, 'patientId'),
    targetDomain: oneOf(value, 'targetDomain', ['EHR', 'LAB', 'PHARMACY', 'DOCUMENT_ONLY'] as const),
    targetOperation: oneOf(value, 'targetOperation', ['create_imported_clinical_note',
      'create_imported_lab_evidence', 'create_imported_medication_evidence',
      'retain_validated_document'] as const),
    status: oneOf(value, 'status', ['pending', 'processing', 'published', 'failed'] as const),
    targetResourceType: typeof value.targetResourceType === 'string' ? value.targetResourceType : null,
    targetResourceId: typeof value.targetResourceId === 'string' ? value.targetResourceId : null,
    failureCode: typeof value.failureCode === 'string' ? value.failureCode : null,
    failureSummary: typeof value.failureSummary === 'string' ? value.failureSummary : null,
    attemptCount: integer(value, 'attemptCount'), maxAttempts: integer(value, 'maxAttempts', 1),
    version: integer(value, 'version', 1) };
}
function parseItems<T>(payload: unknown, parser: (item: unknown) => T, label: string): T[] {
  const value = record(payload, `The ${label} list response`);
  if (!Array.isArray(value.items)) throw new OcrContractError(`The ${label} list response is malformed.`);
  return value.items.map(parser);
}
