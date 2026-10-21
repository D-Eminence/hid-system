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
  publishLost?: boolean;
  replayed?: Record<string, unknown>;
  claimRefused?: boolean;
  current?: Record<string, unknown>;
  validationRow?: Record<string, unknown>;
  publicationRow?: Record<string, unknown>;
  labApi?: Partial<LabApiService>;
  ehrNote?: jest.Mock;
  /** Thrown by the validation read of the claimed attempt (the second one). */
  attemptReadError?: Error;
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
    if (sql.includes('validation.idempotency_key = $3')) return rows([]);
    if (sql.includes('coalesce(max(validation_version), 0) + 1')) return rows([{ version: 1 }]);
    if (sql.includes('insert into ocr.validations')) return rows([{ id: validationId }]);
    if (sql.includes('on job.id = validation.job_id')) { order.push('select validations'); return rows([validation]); }
    if (sql.includes('on job.id=validation.job_id')) {
      validationReads += 1;
      if (options.attemptReadError && validationReads > 1) throw options.attemptReadError;
      return rows([validationRow]);
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
      return rows(options.claimRefused ? [] : [{ ...publicationRow, status: 'processing', attempt_count: 1, row_version: '2' }]);
    }
    if (sql === 'select * from ocr.publications where id=$1') return rows(options.current ? [options.current] : []);
    if (sql.includes("update ocr.publications set status='published'")) {
      return rows(options.publishLost ? [] : [{ ...publicationRow, status: 'published', row_version: '3' }]);
    }
    if (sql.includes("update ocr.publications set status='failed'")) {
      // The failure update requires the same processing token as the publish
      // update, so after a lost claim it matches no row either.
      return rows(options.publishLost ? [] : [{ ...publicationRow, status: 'failed', failure_code: params[2],
        failure_summary: params[3], row_version: '3' }]);
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
    (options.labApi ?? {}) as LabApiService, {} as PharmacyApiService);
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
  const failAtLab = (error: Error) => {
    const createOcrImport = jest.fn().mockRejectedValue(error);
    return { ...harness({ jobRow: validatedJob, validationRow: labValidation, publicationRow: labPublication,
      labApi: { createOcrImport } }), createOcrImport };
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
});
