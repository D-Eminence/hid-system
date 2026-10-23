import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { EhrApiService } from '../integrations/ehr-api.service';
import type { IdentityApiService } from '../integrations/identity-api.service';
import type { LabApiService } from '../integrations/lab-api.service';
import type { PharmacyApiService } from '../integrations/pharmacy-api.service';
import type { OcrPublicationSwitch } from './ocr-publication-switch';
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
    (options.labApi ?? {}) as LabApiService, {} as PharmacyApiService,
    { enabled: options.publicationPaused !== true } as OcrPublicationSwitch);
  return { service, clients, database, audit, identity, ehrApi, order };
}

function auditEvents(audit: AuditService) {
  return (audit.recordWithClient as jest.Mock).mock.calls as [PoolClient, Record<string, unknown>][];
}

describe('OCR evidence reads write a patient-linked audit event in the read transaction', () => {
  const reads = [
    { name: 'findForDocument', action: 'ocr.job.find', details: { documentId },
      run: (service: OcrService) => service.findForDocument(documentId, context) },
    { name: 'listValidations', action: 'ocr.validation.list', details: { validationCount: 1 },
      run: (service: OcrService) => service.listValidations(jobId, context) },
    { name: 'listPublications', action: 'ocr.publication.list',
      details: { validationId, publicationCount: 1 },
      run: (service: OcrService) => service.listPublications(validationId, context) },
  ];

  it.each(reads)('$name records $action for the canonical patient after authorization', async (read) => {
    const { service, clients, database, audit, order } = harness();

    await read.run(service);

    expect(database.withTransaction).toHaveBeenCalledTimes(1);
    const events = auditEvents(audit);
    expect(events).toHaveLength(1);
    const [auditClient, event] = events[0]!;
    expect(auditClient).toBe(clients[0]);
    expect(event).toMatchObject({
      action: read.action, patientId, resourceType: 'ocr-job', resourceId: jobId,
      outcome: 'success', facilityId: context.facilityId, actorAccountId: context.actor.accountId,
      actorMembershipId: context.membershipId, purposeOfUse: context.purposeOfUse,
      correlationId: context.correlationId, sourceSystem: 'ocr-api',
    });
    // Identifiers and counts only: no extracted text, fields or corrections.
    expect(event.details).toEqual(read.details);
    expect(order.indexOf('authorize')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('authorize')).toBeLessThan(order.indexOf(`audit ${read.action}`));
  });

  it.each(reads)('$name fails closed when its audit event cannot be written', async (read) => {
    const { service } = harness({ auditFails: true });

    await expect(read.run(service)).rejects.toThrow('audit insert failed');
  });

  it.each(reads)('$name writes no audit event when the patient is not authorized', async (read) => {
    const { service, audit } = harness({ allowed: false });

    await expect(read.run(service)).rejects.toMatchObject({ code: 'OCR_JOB_NOT_FOUND' });
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('findForDocument discloses nothing and writes no event when the document has no job', async () => {
    const { service, audit, identity } = harness({ jobRow: null });

    await expect(service.findForDocument(documentId, context)).resolves.toEqual({ job: null });
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });
});

describe('Every OCR API job event names the canonical patient', () => {
  const validatedJob = { ...job, status: 'validated', row_version: '5' };
  it.each([
    { actions: ['ocr.job.read'], run: (service: OcrService) => service.getJob(jobId, context) },
    { actions: ['ocr.extraction.list'], run: (service: OcrService) => service.listExtractions(jobId, context) },
    { actions: ['ocr.job.retry'],
      run: (service: OcrService) => service.retry(jobId, { expectedVersion: 4, reason: 'Provider timeout',
        purpose: 'healthcare-operations' }, context) },
    { actions: ['ocr.job.create'],
      run: (service: OcrService) => service.createJob({ documentId, provider: 'textract',
        purpose: 'healthcare-operations' }, 'ocr-create-key-000001', context) },
    { actions: ['ocr.job.reuse'], options: { reusable: true },
      run: (service: OcrService) => service.createJob({ documentId, provider: 'textract',
        purpose: 'healthcare-operations' }, 'ocr-create-key-000002', context) },
    { actions: ['ocr.validation.accept'],
      run: (service: OcrService) => service.validate(jobId, { extractionId: validation.extraction_id,
        expectedVersion: 4, validatedPayload: {}, disposition: 'validated', targetDomain: 'DOCUMENT_ONLY',
        candidateType: 'document_only', acceptedFields: {}, rejectedFields: [], corrections: [],
        reason: 'Reviewed against the source', purpose: 'healthcare-operations' },
      'ocr-validate-key-000001', context) },
    { actions: ['ocr.patient.confirm'], options: { jobRow: validatedJob },
      run: (service: OcrService) => service.confirmPatient(jobId, { patientId, expectedJobVersion: 5,
        method: 'source_document', reason: 'Matches the source document', purpose: 'healthcare-operations' },
      'ocr-confirm-key-000001', context) },
    { actions: ['ocr.publication.request', 'ocr.publication.succeed'], options: { jobRow: validatedJob },
      run: (service: OcrService) => service.createPublication(validationId, { validationVersion: 1,
        patientConfirmationId: confirmationId, targetOperation: 'retain_validated_document',
        purpose: 'direct-care' }, 'ocr-publish-key-000001', context) },
  ] as { actions: string[]; options?: Options; run: (service: OcrService) => Promise<unknown> }[])(
    '$actions links the source document patient when the job has none', async ({ actions, options, run }) => {
      const { service, audit } = harness(options);

      await run(service);

      const events = auditEvents(audit).map(([, event]) => event);
      expect(events.map((event) => event.action)).toEqual(actions);
      for (const event of events) expect(event.patientId).toBe(patientId);
    });

  // A lost claim updates no row here (the failure update needs the same
  // processing token), so an owning-service outage produces the failure.
  it('ocr.publication.fail names the publication patient', async () => {
    const error = new DomainProblem(503, 'EHR_SERVICE_UNAVAILABLE', 'EHR service is unavailable');
    const built = harness({ jobRow: validatedJob });
    (built.ehrApi.getOcrDocumentSource as jest.Mock).mockResolvedValueOnce(source).mockRejectedValueOnce(error);
    const { service, audit } = built;

    await expect(service.createPublication(validationId, { validationVersion: 1,
      patientConfirmationId: confirmationId, targetOperation: 'retain_validated_document',
      purpose: 'direct-care' }, 'ocr-publish-key-000002', context))
      .rejects.toBe(error);

    const events = auditEvents(audit).map(([, event]) => event);
    expect(events.map((event) => event.action)).toEqual(['ocr.publication.request', 'ocr.publication.fail']);
    expect(events[1]?.patientId).toBe(patientId);
  });
});

describe('OCR patient confirmation outbox', () => {
  const validatedJob = { ...job, status: 'validated', row_version: '5' };
  const confirm = (service: OcrService) => service.confirmPatient(jobId, { patientId, expectedJobVersion: 5,
    method: 'source_document', reason: 'Matches the source document', purpose: 'healthcare-operations' },
  'ocr-confirm-key-000002', context);

  it('refuses a second confirmation of the same job version with 409, not a server error', async () => {
    const duplicate = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505', constraint: 'outbox_events_aggregate_id_event_type_aggregate_version_key' });
    const { service } = harness({ jobRow: validatedJob, outboxError: duplicate });

    const failure = await confirm(service).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DomainProblem);
    expect(failure).toMatchObject({ code: 'OCR_PATIENT_ALREADY_CONFIRMED' });
    expect((failure as DomainProblem).getStatus()).toBe(409);
  });

  it('keeps any other outbox failure as it is', async () => {
    const other = Object.assign(new Error('connection lost'), { code: '08006' });
    const { service } = harness({ jobRow: validatedJob, outboxError: other });

    await expect(confirm(service)).rejects.toBe(other);
  });
});

describe('OCR publication switch', () => {
  it('answers 503 OCR_PUBLICATION_PAUSED and writes nothing while publication is paused', async () => {
    const { service, database, audit } = harness({ jobRow: { ...job, status: 'validated', row_version: '5' },
      publicationPaused: true });

    const failure = await service.createPublication(validationId, { validationVersion: 1,
      patientConfirmationId: confirmationId, targetOperation: 'retain_validated_document',
      purpose: 'direct-care' }, 'ocr-publish-key-000003', context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DomainProblem);
    expect(failure).toMatchObject({ code: 'OCR_PUBLICATION_PAUSED' });
    expect((failure as DomainProblem).getStatus()).toBe(503);
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('still confirms the patient while publication is paused', async () => {
    const { service, audit } = harness({ jobRow: { ...job, status: 'validated', row_version: '5' },
      publicationPaused: true });

    await service.confirmPatient(jobId, { patientId, expectedJobVersion: 5, method: 'source_document',
      reason: 'Matches the source document', purpose: 'healthcare-operations' }, 'ocr-confirm-key-000003', context);
    expect(auditEvents(audit).map(([, event]) => event.action)).toEqual(['ocr.patient.confirm']);
  });
});
