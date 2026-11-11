import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { EhrApiService } from '../integrations/ehr-api.service';
import type { IdentityApiService } from '../integrations/identity-api.service';
import type { LabApiService } from '../integrations/lab-api.service';
import type { PharmacyApiService } from '../integrations/pharmacy-api.service';
import type { CreateOcrPublicationDto } from './dto/create-ocr-publication.dto';
import type { ValidateOcrJobDto } from './dto/validate-ocr-job.dto';
import type { OcrPublicationSwitch } from './ocr-publication-switch';
import type { OcrReadingSwitch } from './ocr-reading-switch';
import { OcrService } from './ocr.service';

const context = {
  correlationId: 'ocr-read-audit-correlation', facilityId: '10000000-0000-4000-8000-000000000001',
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'healthcare-operations',
  actor: { id: 'actor', subject: 'staff:records', accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['records'], permissions: ['ocr.job.read'], facilityIds: [], facilities: [], authenticationMethod: 'local' },
  authorization: 'Bearer test',
} satisfies DataAccessContext;

const patientId = '50000000-0000-4000-8000-000000000001';
const documentId = '60000000-0000-4000-8000-000000000001';
const jobId = '70000000-0000-4000-8000-000000000001';
const validationId = '90000000-0000-4000-8000-000000000001';
const confirmationId = 'b0000000-0000-4000-8000-000000000001';
const publicationId = 'a0000000-0000-4000-8000-000000000001';

// A job created without a patient keeps patient_id null for its whole life
// (0016 ocr.validate_job_write); the canonical patient comes from the source
// document that authorizeJob resolves.
const job = { id: jobId, facility_id: context.facilityId, document_id: documentId, patient_id: null,
  status: 'awaiting_validation', provider: 'test', attempt_count: 1, max_attempts: 3,
  row_version: '4', created_at: new Date('2026-10-09T10:00:00Z') };
const validation = { id: validationId, job_id: jobId, facility_id: context.facilityId,
  extraction_id: '80000000-0000-4000-8000-000000000001', validation_version: 1, disposition: 'validated',
  target_domain: 'DOCUMENT_ONLY', candidate_type: 'document_only', accepted_fields: { note: 'clinical text' },
  rejected_fields: [], corrections: [], reason: 'Reviewed', validated_by: context.actor.accountId,
  created_at: new Date('2026-10-09T10:05:00Z'), document_id: documentId, patient_id: null,
  job_status: 'validated' };
const confirmation = { id: confirmationId, job_id: jobId, patient_id: patientId, confirmation_version: 1,
  method: 'source_document', created_at: new Date('2026-10-09T10:05:30Z'), request_sha256: 'c'.repeat(64) };
const publication = { id: publicationId, job_id: jobId, validation_id: validationId, validation_version: 1,
  patient_confirmation_id: confirmationId, facility_id: context.facilityId, patient_id: patientId,
  target_domain: 'DOCUMENT_ONLY', target_operation: 'retain_validated_document', status: 'pending',
  request_sha256: 'a'.repeat(64), attempt_count: 0, max_attempts: 3, target_resource_type: null,
  target_resource_id: null, failure_code: null, failure_summary: null, row_version: '1',
  requested_at: new Date('2026-10-09T10:06:00Z'), completed_at: null };
const source = { id: documentId, patientId, facilityId: context.facilityId, status: 'available',
  scanStatus: 'clean', objectVersionId: 'object-version-1', sha256Hex: 'a'.repeat(64) };

interface Options {
  jobRow?: Record<string, unknown> | null;
  allowed?: boolean;
  auditFails?: boolean;
  reusable?: boolean;
  outboxError?: Error;
  publicationPaused?: boolean;
  publishLost?: boolean;
  replayed?: Record<string, unknown>;
  claimRefused?: boolean;
  current?: Record<string, unknown>;
  validationRow?: Record<string, unknown>;
  publicationRow?: Record<string, unknown>;
  labApi?: Partial<LabApiService>;
  pharmacyApi?: Partial<PharmacyApiService>;
  /** structured_payload of the reviewed extraction, read when a review lists several medicines. */
  extractionPayload?: unknown;
  ehrNote?: jest.Mock;
  /** Thrown by the validation read of the claimed attempt (the second one). */
  attemptReadError?: Error;
  /** attempt_count once the claim has raised it; the failure update returns it unchanged (default 1). */
  claimedAttempt?: number;
  /** A validation already stored under the request's Idempotency-Key. */
  validationReplay?: Record<string, unknown>;
}

type Rows = { rows: unknown[]; rowCount: number };
const rows = (items: unknown[]): Rows => ({ rows: items, rowCount: items.length });

function harness(options: Options = {}) {
  const order: string[] = [];
  const jobRow = options.jobRow === undefined ? job : options.jobRow;
  const validationRow = options.validationRow ?? validation;
  const publicationRow = options.publicationRow ?? publication;
  let validationReads = 0;
  const route = (sql: string, params: unknown[] = []): Rows => {
    if (sql.includes("operation = 'ocr.extract' and idempotency_key = $3")) return rows([]);
    if (sql.includes('ocr.extractions extraction')) return rows(options.reusable ? [job] : []);
    if (sql.includes('insert into ocr.jobs')) return rows([{ ...job, status: 'queued', row_version: '1' }]);
    if (sql.includes('for key share')) return rows(jobRow ? [{ id: jobId }] : []);
    if (sql.includes('where document_id=$1')) { order.push('select job'); return rows(jobRow ? [jobRow] : []); }
    if (/from ocr\.jobs\s+where id = \$1/.test(sql)) { order.push('select job'); return rows(jobRow ? [jobRow] : []); }
    if (sql.includes("update ocr.jobs set status = 'queued'")) return rows([{ ...job, status: 'queued', row_version: '5' }]);
    if (sql.includes('update ocr.jobs set status = $5')) return rows([{ ...job, status: 'validated', row_version: '5' }]);
    if (sql.includes('validation.idempotency_key = $3')) return rows(options.validationReplay ? [options.validationReplay] : []);
    if (sql.includes('coalesce(max(validation_version), 0) + 1')) return rows([{ version: 1 }]);
    if (sql.includes('insert into ocr.validations')) return rows([{ id: validationId }]);
    if (sql.includes('on job.id = validation.job_id')) { order.push('select validations'); return rows([validation]); }
    if (sql.includes('on job.id=validation.job_id')) {
      validationReads += 1;
      if (options.attemptReadError && validationReads > 1) throw options.attemptReadError;
      return rows([validationRow]);
    }
    if (sql.includes('from ocr.extractions where id = $1 and job_id = $2')) {
      return rows(options.extractionPayload === undefined ? [] : [{ structured_payload: options.extractionPayload }]);
    }
    if (sql.includes('from ocr.extractions where job_id')) { order.push('select extractions'); return rows([]); }
    if (sql.includes('from ocr.patient_confirmations where facility_id = $1')) return rows([]);
    if (sql.includes('coalesce(max(confirmation_version),0)+1')) return rows([{ version: 1 }]);
    if (sql.includes('insert into ocr.patient_confirmations')) return rows([confirmation]);
    if (sql.includes('from ocr.patient_confirmations where id=$1')) return rows([confirmation]);
    if (sql.includes('insert into ocr.outbox_events')) {
      if (options.outboxError) throw options.outboxError;
      return rows([]);
    }
    if (sql.includes('from ocr.publications where facility_id=$1')) return rows(options.replayed ? [options.replayed] : []);
    if (sql.includes('select id::text from ocr.publications where validation_id=$1')) return rows([]);
    if (sql.includes('insert into ocr.publications')) return rows([publicationRow]);
    if (sql.includes("update ocr.publications set status='processing'")) {
      return rows(options.claimRefused ? [] : [{ ...publicationRow, status: 'processing',
        attempt_count: options.claimedAttempt ?? 1, row_version: '2' }]);
    }
    if (sql === 'select * from ocr.publications where id=$1') return rows(options.current ? [options.current] : []);
    if (sql.includes("update ocr.publications set status='published'")) {
      return rows(options.publishLost ? [] : [{ ...publicationRow, status: 'published', row_version: '3' }]);
    }
    if (sql.includes("update ocr.publications set status='failed'")) {
      // The failure update requires the same processing token as the publish
      // update, so after a lost claim it matches no row either.
      return rows(options.publishLost ? [] : [{ ...publicationRow, status: 'failed', failure_code: params[2],
        failure_summary: params[3], attempt_count: options.claimedAttempt ?? 1, row_version: '3' }]);
    }
    if (sql.includes('from ocr.publications where validation_id=$1 order by requested_at')) {
      order.push('select publications');
      return rows([{ ...publication, status: 'published' }]);
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  };
  // Each transaction gets its own client, so an event written in a separate
  // transaction would not match the read's client.
  const clients: PoolClient[] = [];
  const database = { withTransaction: jest.fn(async <T>(_context: DataAccessContext,
    operation: (db: PoolClient) => Promise<T>) => {
    const client = { query: jest.fn(async (sql: string, params?: unknown[]) => route(sql, params)) } as unknown as PoolClient;
    clients.push(client);
    return operation(client);
  }) } as unknown as DatabaseService;
  const ehrApi = { getOcrDocumentSource: jest.fn(async () => {
    order.push('source');
    return source;
  }), createOcrClinicalNote: options.ehrNote ?? jest.fn() } as unknown as EhrApiService;
  const identity = { authorize: jest.fn(async () => {
    order.push('authorize');
    return { allowed: options.allowed ?? true, breakGlass: false };
  }) } as unknown as IdentityApiService;
  const audit = { recordWithClient: jest.fn(async (_client: PoolClient, event: { action: string }) => {
    order.push(`audit ${event.action}`);
    if (options.auditFails) throw new Error('audit insert failed');
  }) } as unknown as AuditService;
  const service = new OcrService(database, identity, audit, ehrApi,
    (options.labApi ?? {}) as LabApiService, (options.pharmacyApi ?? {}) as PharmacyApiService,
    { enabled: options.publicationPaused !== true } as OcrPublicationSwitch, { aiReadingOn: false } as OcrReadingSwitch);
  return { service, clients, database, audit, identity, ehrApi, order };
}

function auditEvents(audit: AuditService) {
  return (audit.recordWithClient as jest.Mock).mock.calls as [PoolClient, Record<string, unknown>][];
}


describe('OCR publication failure classification', () => {
  const validatedJob = { ...job, status: 'validated', row_version: '5' };
  const labValidation = { ...validation, target_domain: 'LAB', candidate_type: 'lab_document',
    accepted_fields: { observations: [{ testName: 'Haemoglobin', value: '12.5', unit: 'g/dL' }] } };
  const labPublication = { ...publication, target_domain: 'LAB', target_operation: 'create_imported_lab_evidence' };
  const noteValidation = { ...validation, target_domain: 'EHR', candidate_type: 'clinical_note',
    accepted_fields: { encounterId: 'c0000000-0000-4000-8000-000000000001', noteType: 'progress',
      title: 'Imported note', content: 'clinical text' } };
  const notePublication = { ...publication, target_domain: 'EHR', target_operation: 'create_imported_clinical_note' };
  const requestKey = 'ocr-publish-key-000004';
  const ownerKey = `ocr-publication:${publicationId}`;
  const publishTo = (service: OcrService, targetOperation: CreateOcrPublicationDto['targetOperation']) =>
    service.createPublication(validationId,
      { validationVersion: 1, patientConfirmationId: confirmationId, targetOperation, purpose: 'direct-care' },
      requestKey, context);
  const calls = (clients: PoolClient[]) => clients
    .flatMap((client) => (client.query as unknown as jest.Mock).mock.calls as [string, unknown[]][]);
  const failureUpdate = (clients: PoolClient[]) => {
    const call = calls(clients).find(([sql]) => sql.includes("update ocr.publications set status='failed'"));
    if (!call) throw new Error('No failure transaction ran');
    const [, params] = call;
    return { code: params[2], summary: params[3], retryable: params[4] };
  };
  const failedEvent = (clients: PoolClient[]) => {
    const call = calls(clients).find(([sql, params]) => sql.includes('insert into ocr.outbox_events')
      && params[0] === 'OcrPublicationFailed');
    if (!call) throw new Error('No OcrPublicationFailed event');
    return JSON.parse(String(call[1][4])) as Record<string, unknown>;
  };
  const failAtLab = (error: Error, overrides: Options = {}) => {
    const createOcrImport = jest.fn().mockRejectedValue(error);
    return { ...harness({ jobRow: validatedJob, validationRow: labValidation, publicationRow: labPublication,
      labApi: { createOcrImport }, ...overrides }), createOcrImport };
  };

  it.each([
    { name: 'Lab outage or timeout (LabApiService after the client retry)',
      error: new DomainProblem(503, 'LAB_SERVICE_UNAVAILABLE', 'Lab service is unavailable') },
    { name: 'Lab 503 problem', error: new DomainProblem(503, 'DEPENDENCY_UNAVAILABLE', 'The service could not complete the request.') },
    { name: 'Lab answer without a code or an import id', error: new DomainProblem(502, 'LAB_SERVICE_ERROR', 'Lab service request failed') },
  ])('stores a $name as a retryable failure and keeps the Lab code', async ({ error }) => {
    const { service, clients, audit, createOcrImport } = failAtLab(error);
    await expect(publishTo(service, 'create_imported_lab_evidence')).rejects.toBe(error);
    expect(createOcrImport).toHaveBeenCalledTimes(1);
    expect(createOcrImport.mock.calls[0]?.[2]).toBe(ownerKey);
    expect(failureUpdate(clients)).toEqual({ code: 'OWNING_SERVICE_UNAVAILABLE',
      summary: `Owning clinical service is temporarily unavailable (${error.code})`, retryable: true });
    const event = auditEvents(audit).find(([, item]) => item.action === 'ocr.publication.fail')?.[1];
    expect(event?.details).toEqual({ publicationId, failureCode: 'OWNING_SERVICE_UNAVAILABLE',
      ownerFailureCode: error.code, retryable: true });
    // The dispatcher allows only these keys in an OCR event payload (event-contracts.ts).
    expect(failedEvent(clients)).toEqual({ jobId, publicationId, failureCode: 'OWNING_SERVICE_UNAVAILABLE',
      retryable: true });
  });

  it.each([
    { name: 'rejection', error: new DomainProblem(422, 'LAB_IMPORT_REJECTED', 'Rejected') },
    { name: 'denial', error: new DomainProblem(403, 'PERMISSION_DENIED', 'Denied') },
  ])('stores a Lab $name as a terminal failure under the Lab code', async ({ error }) => {
    const { service, clients, audit } = failAtLab(error);
    await expect(publishTo(service, 'create_imported_lab_evidence')).rejects.toBe(error);
    expect(failureUpdate(clients)).toEqual({ code: error.code,
      summary: 'Publication was rejected by the owning domain', retryable: false });
    const event = auditEvents(audit).find(([, item]) => item.action === 'ocr.publication.fail')?.[1];
    expect(event?.details).toEqual({ publicationId, failureCode: error.code, ownerFailureCode: error.code,
      retryable: false });
  });

  it('stores an EHR outage during the attempt evidence read as a retryable failure', async () => {
    const error = new DomainProblem(503, 'EHR_SERVICE_UNAVAILABLE', 'EHR service is unavailable');
    const built = harness({ jobRow: validatedJob });
    // The first source read authorizes the request; the second is the attempt's own evidence read.
    (built.ehrApi.getOcrDocumentSource as jest.Mock).mockResolvedValueOnce(source).mockRejectedValueOnce(error);
    await expect(publishTo(built.service, 'retain_validated_document')).rejects.toBe(error);
    expect(failureUpdate(built.clients)).toEqual({ code: 'OWNING_SERVICE_UNAVAILABLE',
      summary: 'Owning clinical service is temporarily unavailable (EHR_SERVICE_UNAVAILABLE)', retryable: true });
  });

  it('keeps REQUEST_IN_PROGRESS from the EHR clinical-note command retryable under its own code', async () => {
    const error = new DomainProblem(409, 'REQUEST_IN_PROGRESS', 'An operation with this Idempotency-Key is already in progress');
    const ehrNote = jest.fn().mockRejectedValue(error);
    const { service, clients } = harness({ jobRow: validatedJob, validationRow: noteValidation,
      publicationRow: notePublication, ehrNote });
    await expect(publishTo(service, 'create_imported_clinical_note')).rejects.toBe(error);
    expect(ehrNote.mock.calls[0]?.[3]).toBe(ownerKey);
    expect(failureUpdate(clients)).toEqual({ code: 'REQUEST_IN_PROGRESS',
      summary: 'Owning clinical service is temporarily unavailable (REQUEST_IN_PROGRESS)', retryable: true });
  });

  // 0112: a publication started near the 72-hour cap, whose source is claimed for deletion or deleted between the
  // request and the attempt, fails cleanly and terminally: no owning-domain call, nothing published.
  it.each(['source_deleting', 'source_deleted'])('fails terminally without publishing once the source is %s', async (status) => {
    const ehrNote = jest.fn();
    const built = harness({ jobRow: validatedJob, validationRow: noteValidation, publicationRow: notePublication, ehrNote });
    (built.ehrApi.getOcrDocumentSource as jest.Mock).mockResolvedValueOnce(source)
      .mockResolvedValueOnce({ ...source, status });
    await expect(publishTo(built.service, 'create_imported_clinical_note'))
      .rejects.toMatchObject({ code: 'DOCUMENT_SOURCE_DELETED' });
    expect(ehrNote).not.toHaveBeenCalled();
    expect(failureUpdate(built.clients)).toEqual({ code: 'DOCUMENT_SOURCE_DELETED',
      summary: 'Publication was rejected by the owning domain', retryable: false });
  });

  it('never publishes a blanked validation: empty accepted fields fail as an invalid candidate', async () => {
    const ehrNote = jest.fn();
    const { service, clients } = harness({ jobRow: validatedJob,
      validationRow: { ...noteValidation, accepted_fields: {} }, publicationRow: notePublication, ehrNote });
    await expect(publishTo(service, 'create_imported_clinical_note'))
      .rejects.toMatchObject({ code: 'OCR_INVALID_CLINICAL_NOTE' });
    expect(ehrNote).not.toHaveBeenCalled();
    expect(failureUpdate(clients)).toMatchObject({ code: 'OCR_INVALID_CLINICAL_NOTE', retryable: false });
  });

  it('stores a database error inside the attempt as a retryable failure', async () => {
    const error = new Error('connection terminated');
    const { service, clients } = harness({ jobRow: validatedJob, attemptReadError: error });
    await expect(publishTo(service, 'retain_validated_document')).rejects.toBe(error);
    expect(failureUpdate(clients)).toEqual({ code: 'OWNING_SERVICE_UNAVAILABLE',
      summary: 'Owning clinical service is temporarily unavailable (OWNING_SERVICE_UNAVAILABLE)', retryable: true });
  });

  it('claims a publication again after a retryable failure and sends the same idempotency key to the Lab API', async () => {
    const digest = requestDigest('ocr.publication.create', { validationId, validationVersion: 1,
      patientConfirmationId: confirmationId, targetOperation: 'create_imported_lab_evidence', purpose: 'direct-care' });
    const createOcrImport = jest.fn().mockResolvedValue({ id: 'd0000000-0000-4000-8000-000000000001' });
    const { service, clients } = harness({ jobRow: validatedJob, validationRow: labValidation,
      publicationRow: labPublication, labApi: { createOcrImport },
      replayed: { ...labPublication, status: 'failed', attempt_count: 1, request_sha256: digest,
        failure_code: 'OWNING_SERVICE_UNAVAILABLE' } });
    await expect(publishTo(service, 'create_imported_lab_evidence')).resolves.toMatchObject({ status: 'published' });
    expect(calls(clients).some(([sql]) => sql.includes("update ocr.publications set status='processing'"))).toBe(true);
    expect(createOcrImport).toHaveBeenCalledTimes(1);
    expect(createOcrImport.mock.calls[0]?.[2]).toBe(ownerKey);
  });

  it('refuses a publication whose failure is stored under a rejection code and does not call the Lab API', async () => {
    const digest = requestDigest('ocr.publication.create', { validationId, validationVersion: 1,
      patientConfirmationId: confirmationId, targetOperation: 'create_imported_lab_evidence', purpose: 'direct-care' });
    const createOcrImport = jest.fn();
    const { service, clients } = harness({ jobRow: validatedJob, validationRow: labValidation,
      publicationRow: labPublication, labApi: { createOcrImport },
      replayed: { ...labPublication, status: 'failed', attempt_count: 1, request_sha256: digest,
        failure_code: 'LAB_IMPORT_REJECTED' } });
    await expect(publishTo(service, 'create_imported_lab_evidence')).rejects.toMatchObject({ code: 'OCR_PUBLICATION_TERMINAL' });
    expect(calls(clients).some(([sql]) => sql.includes("update ocr.publications set status='processing'"))).toBe(false);
    expect(createOcrImport).not.toHaveBeenCalled();
  });

  // The claim takes a failed publication again only while attempt_count < max_attempts,
  // counted after the claim that started the attempt, so the last permitted attempt's
  // failure is reported as not retryable although its code stays retryable.
  it.each([
    { claimedAttempt: 1, maxAttempts: 3, retryable: true },
    { claimedAttempt: 2, maxAttempts: 3, retryable: true },
    { claimedAttempt: 3, maxAttempts: 3, retryable: false },
    { claimedAttempt: 1, maxAttempts: 1, retryable: false },
  ])('reports a Lab outage on attempt $claimedAttempt of $maxAttempts as retryable: $retryable', async ({
    claimedAttempt, maxAttempts, retryable }) => {
    const error = new DomainProblem(503, 'LAB_SERVICE_UNAVAILABLE', 'Lab service is unavailable');
    const { service, clients, audit } = failAtLab(error,
      { claimedAttempt, publicationRow: { ...labPublication, max_attempts: maxAttempts } });
    await expect(publishTo(service, 'create_imported_lab_evidence')).rejects.toBe(error);
    // The stored code and the backoff parameter keep the outage retryable; the
    // failure update itself skips the backoff once attempt_count reaches max_attempts.
    expect(failureUpdate(clients)).toEqual({ code: 'OWNING_SERVICE_UNAVAILABLE',
      summary: 'Owning clinical service is temporarily unavailable (LAB_SERVICE_UNAVAILABLE)', retryable: true });
    const event = auditEvents(audit).find(([, item]) => item.action === 'ocr.publication.fail')?.[1];
    expect(event?.details).toEqual({ publicationId, failureCode: 'OWNING_SERVICE_UNAVAILABLE',
      ownerFailureCode: 'LAB_SERVICE_UNAVAILABLE', retryable });
    expect(failedEvent(clients)).toEqual({ jobId, publicationId, failureCode: 'OWNING_SERVICE_UNAVAILABLE', retryable });
  });

  it.each([
    { claimedAttempt: 1, retryable: true },
    { claimedAttempt: 2, retryable: true },
    { claimedAttempt: 3, retryable: false },
  ])('reports REQUEST_IN_PROGRESS on attempt $claimedAttempt of 3 as retryable: $retryable', async ({
    claimedAttempt, retryable }) => {
    const error = new DomainProblem(409, 'REQUEST_IN_PROGRESS', 'An operation with this Idempotency-Key is already in progress');
    const { service, clients, audit } = harness({ jobRow: validatedJob, validationRow: noteValidation,
      publicationRow: notePublication, ehrNote: jest.fn().mockRejectedValue(error), claimedAttempt });
    await expect(publishTo(service, 'create_imported_clinical_note')).rejects.toBe(error);
    expect(failureUpdate(clients)).toMatchObject({ code: 'REQUEST_IN_PROGRESS', retryable: true });
    const event = auditEvents(audit).find(([, item]) => item.action === 'ocr.publication.fail')?.[1];
    expect(event?.details).toMatchObject({ failureCode: 'REQUEST_IN_PROGRESS', retryable });
    expect(failedEvent(clients)).toMatchObject({ failureCode: 'REQUEST_IN_PROGRESS', retryable });
  });

  it.each([1, 2])('reports a Lab rejection on attempt %i of 3 as not retryable in both events', async (claimedAttempt) => {
    const error = new DomainProblem(422, 'LAB_IMPORT_REJECTED', 'Rejected');
    const { service, clients, audit } = failAtLab(error, { claimedAttempt });
    await expect(publishTo(service, 'create_imported_lab_evidence')).rejects.toBe(error);
    expect(failureUpdate(clients)).toMatchObject({ code: 'LAB_IMPORT_REJECTED', retryable: false });
    const event = auditEvents(audit).find(([, item]) => item.action === 'ocr.publication.fail')?.[1];
    expect(event?.details).toMatchObject({ failureCode: 'LAB_IMPORT_REJECTED', retryable: false });
    expect(failedEvent(clients)).toMatchObject({ failureCode: 'LAB_IMPORT_REJECTED', retryable: false });
  });

  it('answers a resend after the last permitted attempt failed with 409 in progress and does not call the Lab API', async () => {
    const digest = requestDigest('ocr.publication.create', { validationId, validationVersion: 1,
      patientConfirmationId: confirmationId, targetOperation: 'create_imported_lab_evidence', purpose: 'direct-care' });
    const exhausted = { ...labPublication, status: 'failed', attempt_count: 3, max_attempts: 3, request_sha256: digest,
      failure_code: 'OWNING_SERVICE_UNAVAILABLE' };
    const createOcrImport = jest.fn();
    const { service, clients, audit } = harness({ jobRow: validatedJob, validationRow: labValidation,
      publicationRow: labPublication, labApi: { createOcrImport }, replayed: exhausted, claimRefused: true,
      current: exhausted });
    await expect(publishTo(service, 'create_imported_lab_evidence')).rejects.toMatchObject({ code: 'OCR_PUBLICATION_IN_PROGRESS' });
    // The harness refuses the claim; the attempt budget it stands for is the claim's own guard.
    const claim = calls(clients).find(([sql]) => sql.includes("update ocr.publications set status='processing'"));
    expect(String(claim?.[0])).toContain('attempt_count < max_attempts');
    expect(createOcrImport).not.toHaveBeenCalled();
    expect(calls(clients).some(([sql]) => sql.includes("update ocr.publications set status='failed'"))).toBe(false);
    expect(calls(clients).some(([sql]) => sql.includes('insert into ocr.outbox_events'))).toBe(false);
    expect(auditEvents(audit).some(([, item]) => item.action === 'ocr.publication.fail')).toBe(false);
  });
});

describe('OCR validation refuses a candidate that publication would refuse', () => {
  // Publication stores these refusals as terminal and a validated job cannot be
  // validated again (0077), so a validation that publication would refuse
  // stranded the reviewed record.
  const note = { encounterId: 'c0000000-0000-4000-8000-000000000001', noteType: 'historical-record',
    title: 'Imported discharge note', content: 'Reviewed content' };
  const body = (fields: Partial<ValidateOcrJobDto>): ValidateOcrJobDto => ({
    extractionId: validation.extraction_id, expectedVersion: 4, validatedPayload: {}, disposition: 'validated',
    targetDomain: 'EHR', candidateType: 'clinical_note', acceptedFields: note, rejectedFields: [], corrections: [],
    reason: 'Reviewed against the source', purpose: 'healthcare-operations', ...fields });
  const writes = (clients: PoolClient[]) => clients.flatMap((client) => (client.query as unknown as jest.Mock).mock.calls)
    .map(([sql]) => String(sql))
    .filter((sql) => sql.includes('insert into ocr.validations') || sql.includes('update ocr.jobs'));

  it.each([
    { targetDomain: 'EHR', candidateType: 'clinical_note', acceptedFields: {}, code: 'OCR_INVALID_CLINICAL_NOTE' },
    { targetDomain: 'EHR', candidateType: 'clinical_note', acceptedFields: { ...note, encounterId: undefined },
      code: 'OCR_INVALID_CLINICAL_NOTE' },
    { targetDomain: 'EHR', candidateType: 'clinical_note', acceptedFields: { ...note, content: ' ' },
      code: 'OCR_INVALID_CLINICAL_NOTE' },
    { targetDomain: 'LAB', candidateType: 'lab_document', acceptedFields: {}, code: 'OCR_INVALID_LAB_EVIDENCE' },
    { targetDomain: 'LAB', candidateType: 'lab_document', acceptedFields: { observations: [{ testName: 'Sodium' }] },
      code: 'OCR_INVALID_LAB_EVIDENCE' },
    { targetDomain: 'PHARMACY', candidateType: 'historical_medication_evidence', acceptedFields: {},
      code: 'OCR_INVALID_MEDICATION_EVIDENCE' },
  ] as (Partial<ValidateOcrJobDto> & { code: string })[])(
    'refuses a validated $targetDomain candidate with 400 $code and writes nothing', async ({ code, ...fields }) => {
      const { service, clients, audit } = harness();

      const failure = await service.validate(jobId, body(fields), 'ocr-validate-key-000101', context)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(DomainProblem);
      expect(failure).toMatchObject({ code });
      expect((failure as DomainProblem).getStatus()).toBe(400);
      expect(writes(clients)).toEqual([]);
      expect(auditEvents(audit)).toEqual([]);
    });

  it.each([
    { targetDomain: 'EHR', candidateType: 'clinical_note', acceptedFields: note },
    { targetDomain: 'LAB', candidateType: 'lab_document',
      acceptedFields: { observations: [{ testName: 'Sodium', value: '140', unit: 'mmol/L' }] } },
    { targetDomain: 'PHARMACY', candidateType: 'historical_medication_evidence',
      acceptedFields: { medicationText: 'Metformin 500 mg' } },
    { targetDomain: 'DOCUMENT_ONLY', candidateType: 'document_only', acceptedFields: {} },
  ] as Partial<ValidateOcrJobDto>[])('validates a publishable $targetDomain candidate', async (fields) => {
    const { service, clients, audit } = harness();

    await service.validate(jobId, body(fields), 'ocr-validate-key-000102', context);

    expect(writes(clients)).toHaveLength(2);
    expect(auditEvents(audit).map(([, event]) => event.action)).toEqual(['ocr.validation.accept']);
  });

  it('still records a rejection whose fields could not be published', async () => {
    const { service, clients, audit } = harness();

    await service.validate(jobId, body({ disposition: 'rejected', acceptedFields: {} }), 'ocr-validate-key-000103', context);

    expect(writes(clients)).toHaveLength(2);
    expect(auditEvents(audit).map(([, event]) => event.action)).toEqual(['ocr.validation.reject']);
  });

  it('answers a replay with the stored validation, even one this check would now refuse', async () => {
    const input = body({ acceptedFields: {} });
    const stored = { ...validation, target_domain: 'EHR', candidate_type: 'clinical_note', accepted_fields: {},
      request_sha256: requestDigest('ocr.validation.create', { jobId, ...input }) };
    const { service, clients } = harness({ validationReplay: stored });

    await expect(service.validate(jobId, input, 'ocr-validate-key-000104', context))
      .resolves.toMatchObject({ id: validationId, targetDomain: 'EHR' });
    expect(writes(clients)).toEqual([]);
  });

  it('authorizes the caller before checking the candidate', async () => {
    const { service } = harness({ allowed: false });

    await expect(service.validate(jobId, body({ acceptedFields: {} }), 'ocr-validate-key-000105', context))
      .rejects.toMatchObject({ code: 'OCR_JOB_NOT_FOUND' });
  });
});

// OCR publication writes validated OCR evidence into EHR, Lab and Pharmacy.
// It is on unless OCR_PUBLICATION_ENABLED=false, which pauses it again.
describe('OCR publication switch', () => {
  it('answers 503 OCR_PUBLICATION_PAUSED and starts no transaction while publication is paused', async () => {
    const { service, database, audit } = harness({ jobRow: { ...job, status: 'validated', row_version: '5' },
      publicationPaused: true });
    const failure = await service.createPublication(validationId, { validationVersion: 1,
      patientConfirmationId: confirmationId, targetOperation: 'retain_validated_document',
      purpose: 'direct-care' }, 'ocr-publish-key-000009', context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DomainProblem);
    expect(failure).toMatchObject({ code: 'OCR_PUBLICATION_PAUSED' });
    expect((failure as DomainProblem).getStatus()).toBe(503);
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });
});

// Fictional test data only: medicines read from a paper record of patient "Ada Test".
const itemId = (index: number) => `it-${index.toString(16).padStart(16, '0')}`;
const keptMedicine = (index: number, overrides: Record<string, unknown> = {}) => ({
  itemId: itemId(index), page: 2, medicationText: index % 2 ? 'Amlodipine' : 'Metformin',
  strengthText: index % 2 ? '5mg' : '500mg', frequencyText: index % 2 ? 'once daily' : 'twice daily',
  historicalContext: `From a paper record, page 2. As written: medicine ${index}. Dated 12/03/2019`, ...overrides });
const readingOf = (count: number, overrides: Record<string, unknown> = {}) => ({
  contract: 'hid-paper-reading-v2',
  items: Array.from({ length: count }, (_v, index) => ({ id: itemId(index + 1), kind: 'medicine', page: 2,
    ...overrides })),
});

describe('OCR publication of several medicines from one paper', () => {
  const validatedJob = { ...job, status: 'validated', row_version: '5' };
  const pharmacyValidation = (acceptedFields: Record<string, unknown>) => ({ ...validation,
    target_domain: 'PHARMACY', candidate_type: 'historical_medication_evidence', accepted_fields: acceptedFields });
  const pharmacyPublication = { ...publication, target_domain: 'PHARMACY',
    target_operation: 'create_imported_medication_evidence' };
  const ownerKey = `ocr-publication:${publicationId}`;
  const publish = (service: OcrService) => service.createPublication(validationId,
    { validationVersion: 1, patientConfirmationId: confirmationId,
      targetOperation: 'create_imported_medication_evidence', purpose: 'direct-care' },
    'ocr-publish-key-000201', context);
  const sqlCalls = (clients: PoolClient[]) => clients
    .flatMap((client) => (client.query as unknown as jest.Mock).mock.calls as [string, unknown[]][]);
  const provenance = { patientId, sourceDocumentId: documentId, ocrJobId: jobId,
    extractionId: validation.extraction_id, validationId, validationVersion: 1, publicationId,
    reviewedBy: context.actor.accountId };

  it('sends a list of one medicine through the single route, exactly as the legacy shape', async () => {
    const single = { medicationText: 'Amlodipine', strengthText: '5mg', frequencyText: 'once daily',
      historicalContext: keptMedicine(1).historicalContext };
    const legacyCall = jest.fn().mockResolvedValue({ id: 'e0000000-0000-4000-8000-000000000001' });
    await publish(harness({ jobRow: validatedJob, validationRow: pharmacyValidation(single),
      publicationRow: pharmacyPublication, pharmacyApi: { createOcrImport: legacyCall } }).service);
    const listCall = jest.fn().mockResolvedValue({ id: 'e0000000-0000-4000-8000-000000000001' });
    const createOcrImportBatch = jest.fn();
    await expect(publish(harness({ jobRow: validatedJob,
      validationRow: pharmacyValidation({ items: {}, medications: [keptMedicine(1)] }),
      publicationRow: pharmacyPublication, pharmacyApi: { createOcrImport: listCall, createOcrImportBatch } }).service))
      .resolves.toMatchObject({ status: 'published' });
    expect(createOcrImportBatch).not.toHaveBeenCalled();
    expect(listCall.mock.calls[0]?.[1]).toEqual(legacyCall.mock.calls[0]?.[1]);
    expect(listCall.mock.calls[0]?.[2]).toBe(ownerKey);
    expect(JSON.stringify(listCall.mock.calls[0]?.[1])).not.toMatch(/itemId|"page"/);
  });

  it('sends several medicines in one batch call and records every created record', async () => {
    const medications = [keptMedicine(1), keptMedicine(2), keptMedicine(3, { medicationText: 'Amlodipine' })];
    const created = ['e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002',
      'e0000000-0000-4000-8000-000000000003'];
    const createOcrImportBatch = jest.fn().mockResolvedValue({ id: created[0], count: 3,
      items: created.map((id) => ({ id })) });
    const createOcrImport = jest.fn();
    const { service, clients, audit } = harness({ jobRow: validatedJob,
      validationRow: pharmacyValidation({ items: {}, medications }), publicationRow: pharmacyPublication,
      pharmacyApi: { createOcrImport, createOcrImportBatch } });
    await expect(publish(service)).resolves.toMatchObject({ status: 'published' });
    expect(createOcrImport).not.toHaveBeenCalled();
    expect(createOcrImportBatch).toHaveBeenCalledTimes(1);
    expect(createOcrImportBatch.mock.calls[0]?.[2]).toBe(ownerKey);
    expect(createOcrImportBatch.mock.calls[0]?.[1]).toEqual({ ...provenance,
      medications: medications.map(({ itemId: _id, page: _page, ...item }) => ({ doseText: undefined, ...item })) });
    const published = sqlCalls(clients).find(([sql]) => sql.includes("update ocr.publications set status='published'"));
    expect(published?.[1]).toEqual(expect.arrayContaining(['pharmacy-imported-medication-evidence', created[0]]));
    const event = auditEvents(audit).find(([, item]) => item.action === 'ocr.publication.succeed')?.[1];
    expect(event?.details).toMatchObject({ targetResourceIds: created, medicationCount: 3 });
    const outbox = sqlCalls(clients).find(([sql, params]) => sql.includes('insert into ocr.outbox_events')
      && params[0] === 'OcrPublicationSucceeded');
    // The dispatcher allows only these keys in an OCR event payload (event-contracts.ts).
    expect(Object.keys(JSON.parse(String(outbox?.[1][4]))).sort())
      .toEqual(['jobId', 'publicationId', 'targetResourceId', 'targetResourceType']);
  });

  it('publishes medicines typed from the page (no item id) as separate records in one batch', async () => {
    const medications = [keptMedicine(1, { itemId: undefined }), keptMedicine(2, { itemId: undefined, page: 1 }),
      keptMedicine(3, { itemId: undefined, medicationText: 'Amlodipine' })];
    const createOcrImportBatch = jest.fn().mockResolvedValue({ id: 'e0000000-0000-4000-8000-000000000001', count: 3,
      items: [1, 2, 3].map((n) => ({ id: `e0000000-0000-4000-8000-00000000000${n}` })) });
    const { service } = harness({ jobRow: validatedJob, validationRow: pharmacyValidation({ medications }),
      publicationRow: pharmacyPublication, pharmacyApi: { createOcrImportBatch } });
    await expect(publish(service)).resolves.toMatchObject({ status: 'published' });
    const sent = createOcrImportBatch.mock.calls[0]?.[1] as { medications: unknown[] };
    expect(sent.medications).toHaveLength(3);
    expect(JSON.stringify(sent)).not.toMatch(/itemId|"page"/);
  });

  it('stores a Pharmacy refusal of the batch as terminal, so nothing is published', async () => {
    const error = new DomainProblem(400, 'VALIDATION_FAILED', 'medications.1.medicationText is too long');
    const createOcrImportBatch = jest.fn().mockRejectedValue(error);
    const { service, clients } = harness({ jobRow: validatedJob,
      validationRow: pharmacyValidation({ medications: [keptMedicine(1), keptMedicine(2)] }),
      publicationRow: pharmacyPublication, pharmacyApi: { createOcrImportBatch } });
    await expect(publish(service)).rejects.toBe(error);
    expect(sqlCalls(clients).some(([sql]) => sql.includes("update ocr.publications set status='published'"))).toBe(false);
    const failed = sqlCalls(clients).find(([sql]) => sql.includes("update ocr.publications set status='failed'"));
    expect(failed?.[1].slice(2)).toEqual(['VALIDATION_FAILED', 'Publication was rejected by the owning domain', false]);
  });
});

describe('OCR validation of several medicines', () => {
  const body = (acceptedFields: Record<string, unknown>): ValidateOcrJobDto => ({
    extractionId: validation.extraction_id, expectedVersion: 4, validatedPayload: {}, disposition: 'validated',
    targetDomain: 'PHARMACY', candidateType: 'historical_medication_evidence', acceptedFields,
    rejectedFields: [], corrections: [], reason: 'Reviewed against the source', purpose: 'healthcare-operations' });
  const writes = (clients: PoolClient[]) => clients.flatMap((client) => (client.query as unknown as jest.Mock).mock.calls)
    .map(([sql]) => String(sql))
    .filter((sql) => sql.includes('insert into ocr.validations') || sql.includes('update ocr.jobs'));

  it('stores a review of two medicines that were read from the paper', async () => {
    const { service, clients, audit } = harness({ extractionPayload: readingOf(2) });
    await service.validate(jobId, body({ items: {}, medications: [keptMedicine(1), keptMedicine(2)] }),
      'ocr-validate-key-000201', context);
    expect(writes(clients)).toHaveLength(2);
    expect(auditEvents(audit).map(([, event]) => event.action)).toEqual(['ocr.validation.accept']);
  });

  // AI reading is off by default (OCR_AI_MODE 'off'): the reading has pages but no items.
  const pagesOnly = (pages: number, status = 'ai_off') => ({ contract: 'hid-paper-reading-v2',
    pages: Array.from({ length: pages }, (_v, index) => ({ page: index + 1, flagged: false, flagReasons: [],
      lines: [] })), items: [], reading: { status, itemCount: 0 } });
  const typed = (index: number, overrides: Record<string, unknown> = {}) =>
    keptMedicine(index, { itemId: undefined, ...overrides });

  it.each([['ai_off'], ['ai_declined'], ['ai_failed']])(
    'stores a review of three medicines typed from a paper read with AI reading %s', async (status) => {
      const { service, clients, audit } = harness({ extractionPayload: pagesOnly(2, status) });
      await service.validate(jobId, body({ medications: [typed(1), typed(2, { page: 1 }), typed(3)] }),
        'ocr-validate-key-000205', context);
      expect(writes(clients)).toHaveLength(2);
      expect(auditEvents(audit).map(([, event]) => event.action)).toEqual(['ocr.validation.accept']);
    });

  it('stores a typed medicine the AI reading missed, next to the ones it read', async () => {
    const { service, clients } = harness({ extractionPayload: { ...readingOf(2), pages: [{ page: 1 }, { page: 2 }] } });
    await service.validate(jobId, body({ medications: [keptMedicine(1), keptMedicine(2), typed(3)] }),
      'ocr-validate-key-000206', context);
    expect(writes(clients)).toHaveLength(2);
  });

  it('stores typed medicines from an older extraction (hid-textract-v1) that lists its pages', async () => {
    const { service, clients } = harness({ extractionPayload: { pages: [{ page: 1, text: 'x', confidence: 0.9 },
      { page: 2, text: 'y', confidence: 0.9 }] } });
    await service.validate(jobId, body({ medications: [typed(1), typed(2)] }), 'ocr-validate-key-000207', context);
    expect(writes(clients)).toHaveLength(2);
  });

  it.each([
    ['a page the paper does not have', pagesOnly(1)],
    ['an extraction that cannot be found', undefined],
  ])('refuses a typed medicine on %s with 400 and writes nothing', async (_name, payload) => {
    const { service, clients } = harness({ extractionPayload: payload });
    await expect(service.validate(jobId, body({ medications: [typed(1, { page: 1 }), typed(2, { page: 2 })] }),
      'ocr-validate-key-000208', context)).rejects.toMatchObject({ code: 'OCR_MEDICATION_PAGE_NOT_FOUND' });
    expect(writes(clients)).toEqual([]);
  });

  it('still refuses an item id the reading did not find, even with AI reading off', async () => {
    const { service, clients } = harness({ extractionPayload: pagesOnly(2) });
    await expect(service.validate(jobId, body({ medications: [typed(1), keptMedicine(2)] }),
      'ocr-validate-key-000209', context)).rejects.toMatchObject({ code: 'OCR_MEDICATION_NOT_READ' });
    expect(writes(clients)).toEqual([]);
  });

  it.each([
    ['a medicine the reading did not find', readingOf(1)],
    ['a medicine on another page', readingOf(2, { page: 3 })],
    ['an item that is not a medicine', readingOf(2, { kind: 'diagnosis' })],
    ['a reading without items', { contract: 'hid-textract-v1', pages: [] }],
  ])('refuses %s with 400 and writes nothing', async (_name, payload) => {
    const { service, clients } = harness({ extractionPayload: payload });
    await expect(service.validate(jobId, body({ medications: [keptMedicine(1), keptMedicine(2)] }),
      'ocr-validate-key-000202', context)).rejects.toMatchObject({ code: 'OCR_MEDICATION_NOT_READ' });
    expect(writes(clients)).toEqual([]);
  });

  it.each([
    ['51 medicines', { medications: Array.from({ length: 51 }, (_v, index) => keptMedicine(index + 1)) }],
    ['one medicine too long', { medications: [keptMedicine(1), keptMedicine(2, { medicationText: 'A'.repeat(501) })] }],
    ['both shapes', { medicationText: 'Amlodipine', medications: [keptMedicine(1), keptMedicine(2)] }],
  ])('refuses the whole review for %s and writes nothing', async (_name, fields) => {
    const { service, clients } = harness({ extractionPayload: readingOf(51) });
    await expect(service.validate(jobId, body(fields), 'ocr-validate-key-000203', context))
      .rejects.toMatchObject({ code: 'OCR_INVALID_MEDICATION_EVIDENCE' });
    expect(writes(clients)).toEqual([]);
  });

  it('refuses a view-only share of typed medicines before reading the candidate', async () => {
    const { service, clients } = harness({ allowed: false, extractionPayload: pagesOnly(2) });
    await expect(service.validate(jobId, body({ medications: [typed(1), typed(2)] }),
      'ocr-validate-key-000210', context)).rejects.toMatchObject({ code: 'OCR_JOB_NOT_FOUND' });
    expect(writes(clients)).toEqual([]);
  });

  it('refuses a view-only share before reading the candidate', async () => {
    const { service, clients } = harness({ allowed: false, extractionPayload: readingOf(2) });
    await expect(service.validate(jobId, body({ medications: [keptMedicine(1), keptMedicine(2)] }),
      'ocr-validate-key-000204', context)).rejects.toMatchObject({ code: 'OCR_JOB_NOT_FOUND' });
    expect(writes(clients)).toEqual([]);
  });
});

describe('OCR publication of a lab result dated on paper', () => {
  const validatedJob = { ...job, status: 'validated', row_version: '5' };
  const labPublication = { ...publication, target_domain: 'LAB', target_operation: 'create_imported_lab_evidence' };
  const labReview = (acceptedFields: Record<string, unknown>) => ({ ...validation, target_domain: 'LAB',
    candidate_type: 'lab_document', accepted_fields: acceptedFields });
  const publish = (service: OcrService) => service.createPublication(validationId,
    { validationVersion: 1, patientConfirmationId: confirmationId, targetOperation: 'create_imported_lab_evidence',
      purpose: 'direct-care' }, 'ocr-publish-key-000301', context);

  it('publishes a review dated "Mar 2025" with the date left out, instead of failing at Lab', async () => {
    const createOcrImport = jest.fn().mockResolvedValue({ id: 'd0000000-0000-4000-8000-000000000001' });
    const { service } = harness({ jobRow: validatedJob, publicationRow: labPublication,
      labApi: { createOcrImport }, validationRow: labReview({ reportedAtAsWritten: 'Mar 2025',
        observations: [{ testName: 'Haemoglobin', value: '12.5', unit: 'g/dL', reportedAt: 'Mar 2025',
          page: 1, itemId: 'it-00000000000000aa' }] }) });
    await expect(publish(service)).resolves.toMatchObject({ status: 'published' });
    const sent = JSON.parse(JSON.stringify(createOcrImport.mock.calls[0]?.[1])) as Record<string, unknown>;
    expect(sent.reportedAt).toBeUndefined();
    expect(sent.observations).toEqual([{ testName: 'Haemoglobin', value: '12.5', unit: 'g/dL' }]);
    expect(JSON.stringify(sent)).not.toMatch(/AsWritten|itemId|"page"/);
  });

  it('sends the real date of an unambiguous paper date, judged on the day the review was stored', async () => {
    const createOcrImport = jest.fn().mockResolvedValue({ id: 'd0000000-0000-4000-8000-000000000001' });
    const { service } = harness({ jobRow: validatedJob, publicationRow: labPublication,
      labApi: { createOcrImport }, validationRow: { ...labReview({ collectedAtAsWritten: '08/10/2026',
        observations: [{ testName: 'Sodium', value: '140', unit: 'mmol/L', reportedAtAsWritten: '9th Oct 2026' }] }),
      created_at: new Date('2026-10-09T10:05:00Z') } });
    await expect(publish(service)).resolves.toMatchObject({ status: 'published' });
    expect(createOcrImport.mock.calls[0]?.[1]).toMatchObject({ collectedAt: '2026-10-08T00:00:00.000Z',
      observations: [expect.objectContaining({ reportedAt: '2026-10-09T00:00:00.000Z' })] });
  });
});
