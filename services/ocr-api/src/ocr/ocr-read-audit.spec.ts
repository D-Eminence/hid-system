import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { EhrApiService } from '../integrations/ehr-api.service';
import type { IdentityApiService } from '../integrations/identity-api.service';
import { LabApiService } from '../integrations/lab-api.service';
import { PharmacyApiService } from '../integrations/pharmacy-api.service';
import type { ServiceWorkloadIdentityService } from '../integrations/service-workload-identity.service';
import type { CreateOcrPublicationDto } from './dto/create-ocr-publication.dto';
import type { ValidateOcrJobDto } from './dto/validate-ocr-job.dto';
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
  pharmacyApi?: Partial<PharmacyApiService>;
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
    (options.labApi ?? {}) as LabApiService, (options.pharmacyApi ?? {}) as PharmacyApiService);
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

  it('ocr.publication.fail names the publication patient', async () => {
    // A failure inside an attempt that still holds its claim, so the failure
    // update matches the publication and records the event.
    const attemptReadError = new Error('Synthetic attempt read failure');
    const { service, audit } = harness({ jobRow: validatedJob, attemptReadError });

    await expect(service.createPublication(validationId, { validationVersion: 1,
      patientConfirmationId: confirmationId, targetOperation: 'retain_validated_document',
      purpose: 'direct-care' }, 'ocr-publish-key-000002', context))
      .rejects.toBe(attemptReadError);

    const events = auditEvents(audit).map(([, event]) => event);
    expect(events.map((event) => event.action)).toEqual(['ocr.publication.request', 'ocr.publication.fail']);
    expect(events[1]?.patientId).toBe(patientId);
  });

  it('a lost claim answers claim lost and records no failure event', async () => {
    const { service, audit, clients } = harness({ jobRow: validatedJob, publishLost: true });

    await expect(service.createPublication(validationId, { validationVersion: 1,
      patientConfirmationId: confirmationId, targetOperation: 'retain_validated_document',
      purpose: 'direct-care' }, 'ocr-publish-key-000003', context))
      .rejects.toMatchObject({ code: 'OCR_PUBLICATION_CLAIM_LOST' });

    expect(auditEvents(audit).map(([, event]) => event.action)).toEqual(['ocr.publication.request']);
    const outbox = clients.flatMap((client) => (client.query as unknown as jest.Mock).mock.calls)
      .filter(([sql]) => String(sql).includes('insert into ocr.outbox_events'))
      .map(([, params]) => (params as unknown[])[0]);
    expect(outbox).toEqual(['OcrPublicationRequested']);
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

// Phase 4 Stage 9: every publication transaction reaches the job row before the
// publication row. verify-ocr-runtime.mjs races both against PostgreSQL.
describe('OCR publication lock order', () => {
  const validatedJob = { ...job, status: 'validated', row_version: '5' };
  const publish = (service: OcrService) => service.createPublication(validationId, { validationVersion: 1,
    patientConfirmationId: confirmationId, targetOperation: 'retain_validated_document',
    purpose: 'direct-care' }, 'ocr-publish-key-000003', context);
  const statements = (client: PoolClient) => (client.query as unknown as jest.Mock).mock.calls
    .map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());
  const transactionWith = (clients: PoolClient[], fragment: string) => {
    const found = clients.map(statements).find((list) => list.some((sql) => sql.includes(fragment)));
    if (!found) throw new Error(`No transaction ran ${fragment}`);
    return found;
  };

  it('locks the job, then reads a replayed publication without locking it', async () => {
    const { service, clients } = harness({ jobRow: validatedJob });
    await publish(service);
    const request = transactionWith(clients, 'insert into ocr.publications');
    const jobLock = request.findIndex((sql) => /from ocr\.jobs where id = \$1 for update$/.test(sql));
    const replay = request.findIndex((sql) => sql.includes('from ocr.publications where facility_id=$1'));
    expect(jobLock).toBeGreaterThanOrEqual(0);
    expect(replay).toBeGreaterThan(jobLock);
    expect(request[replay]).not.toMatch(/ for (update|no key update|share|key share)/);
  });

  it.each([
    { name: 'publish', options: {}, update: "update ocr.publications set status='published'" },
    { name: 'failure', options: { publishLost: true }, update: "update ocr.publications set status='failed'" },
  ])('the $name transaction takes the job key share before the publication row', async ({ options, update }) => {
    const { service, clients } = harness({ jobRow: validatedJob, ...options });
    await publish(service).catch(() => undefined);
    const [first, second] = transactionWith(clients, update);
    expect(first).toBe('select id from ocr.jobs where id = $1 for key share');
    expect(second).toContain(update);
  });

  it('refuses at the claim a terminal failure that committed after the replay read', async () => {
    // The replay waited for the job while the failure transaction recorded the
    // terminal failure, so its snapshot still shows the publication processing.
    const digest = requestDigest('ocr.publication.create', { validationId, validationVersion: 1,
      patientConfirmationId: confirmationId, targetOperation: 'retain_validated_document', purpose: 'direct-care' });
    const { service, clients } = harness({ jobRow: validatedJob, claimRefused: true,
      replayed: { ...publication, status: 'processing', attempt_count: 1, request_sha256: digest },
      current: { ...publication, status: 'failed', attempt_count: 1, failure_code: 'LAB_IMPORT_REJECTED' } });
    await expect(publish(service)).rejects.toMatchObject({ code: 'OCR_PUBLICATION_TERMINAL' });
    const claim = clients.flatMap((client) => (client.query as unknown as jest.Mock).mock.calls)
      .find(([sql]) => String(sql).includes("update ocr.publications set status='processing'"));
    expect(String(claim?.[0])).toContain("status='failed' and failure_code = any($4::text[])");
    expect(claim?.[1]?.[3]).toEqual(['OWNING_SERVICE_UNAVAILABLE', 'REQUEST_IN_PROGRESS']);
  });
});

// Phase 4 Stage 9 review: the integrations turn every outage or timeout of an
// owning domain into a DomainProblem with their own 503 code (LabApiService,
// PharmacyApiService and EhrApiService translate). A later request and the
// claim retry only the codes in RETRYABLE_PUBLICATION_FAILURES, and a validated
// job cannot be validated again, so a transient failure stored under the
// owner's code blocked the publication for good.
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

  // EHR, Lab and Pharmacy refuse OCR's own workload credential with these codes
  // (every JWT failure, a JWKS fetch failure included, is 401
  // INVALID_WORKLOAD_IDENTITY). Through the real integration client the
  // publication stores such a refusal as retryable; a refusal of the user's own
  // credential keeps the owner code and stays terminal, as before.
  describe('through the real owning-service clients', () => {
    const environment = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
      DATABASE_SSL: 'false', CORS_ORIGINS: 'https://app.example', IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
      IDENTITY_OCR_INTERNAL_SERVICE_TOKEN: 'w'.repeat(32), EHR_API_URL: 'https://ehr.example',
      LAB_API_URL: 'https://lab.example', PHARMACY_API_URL: 'https://pharmacy.example',
      EHR_SERVICE_IDENTITY_MODE: 'local-secret', EHR_INTERNAL_SERVICE_TOKEN: 'e'.repeat(32),
      LAB_SERVICE_IDENTITY_MODE: 'local-secret', LAB_INTERNAL_SERVICE_TOKEN: 'l'.repeat(32),
      PHARMACY_SERVICE_IDENTITY_MODE: 'local-secret', PHARMACY_INTERNAL_SERVICE_TOKEN: 'p'.repeat(32) };
    const workloadIdentity = {} as ServiceWorkloadIdentityService;
    const medicationValidation = { ...validation, target_domain: 'PHARMACY', candidate_type: 'historical_medication_evidence',
      accepted_fields: { medicationText: 'Metformin', strengthText: '500 mg' } };
    const medicationPublication = { ...publication, target_domain: 'PHARMACY',
      target_operation: 'create_imported_medication_evidence' };
    const originalFetch = global.fetch;
    let fetchMock: jest.Mock;
    beforeEach(() => {
      Object.assign(process.env, environment);
      resetEnvironmentForTests();
      fetchMock = jest.fn();
      global.fetch = fetchMock;
    });
    afterEach(() => { global.fetch = originalFetch; });

    const owners = {
      EHR: () => {
        const ehr = new EhrApiService(workloadIdentity);
        const ehrNote = jest.fn((...args: Parameters<EhrApiService['createOcrClinicalNote']>) => ehr.createOcrClinicalNote(...args));
        return { built: harness({ jobRow: validatedJob, validationRow: noteValidation, publicationRow: notePublication, ehrNote }),
          operation: 'create_imported_clinical_note' as const };
      },
      LAB: () => ({ built: harness({ jobRow: validatedJob, validationRow: labValidation, publicationRow: labPublication,
        labApi: new LabApiService(workloadIdentity) }), operation: 'create_imported_lab_evidence' as const }),
      PHARMACY: () => ({ built: harness({ jobRow: validatedJob, validationRow: medicationValidation,
        publicationRow: medicationPublication, pharmacyApi: new PharmacyApiService(workloadIdentity) }),
      operation: 'create_imported_medication_evidence' as const }),
    };
    const ownerAnswers = (status: number, code: string) => fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ code, detail: 'Synthetic owner refusal' }),
        { status, headers: { 'content-type': 'application/problem+json' } }));
    const refusal = async (publishing: Promise<unknown>) => {
      const error = await publishing.then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(DomainProblem);
      return error as DomainProblem;
    };

    it.each((['EHR', 'LAB', 'PHARMACY'] as const).flatMap((owner) => [
      { owner, status: 401, code: 'INVALID_WORKLOAD_IDENTITY' },
      { owner, status: 401, code: 'INTERNAL_SERVICE_AUTH_REQUIRED' },
      { owner, status: 403, code: 'WORKLOAD_CALLER_DENIED' },
    ]))('stores $owner $status $code as a retryable failure and answers 503', async ({ owner, status, code }) => {
      ownerAnswers(status, code);
      const { built: { service, clients, audit }, operation } = owners[owner]();
      const problem = await refusal(publishTo(service, operation));
      expect(failureUpdate(clients)).toEqual({ code: 'OWNING_SERVICE_UNAVAILABLE',
        summary: `Owning clinical service is temporarily unavailable (${owner}_SERVICE_AUTH_UNAVAILABLE)`, retryable: true });
      expect([problem.getStatus(), problem.code]).toEqual([503, `${owner}_SERVICE_AUTH_UNAVAILABLE`]);
      // The owner was asked once, with the publication's own key.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ 'idempotency-key': ownerKey });
      const event = auditEvents(audit).find(([, item]) => item.action === 'ocr.publication.fail')?.[1];
      expect(event?.details).toEqual({ publicationId, failureCode: 'OWNING_SERVICE_UNAVAILABLE',
        ownerFailureCode: `${owner}_SERVICE_AUTH_UNAVAILABLE`, retryable: true });
      expect(failedEvent(clients)).toEqual({ jobId, publicationId, failureCode: 'OWNING_SERVICE_UNAVAILABLE',
        retryable: true });
    });

    it.each((['EHR', 'LAB', 'PHARMACY'] as const).flatMap((owner) => [
      { owner, status: 401, code: 'AUTHENTICATION_REQUIRED' },
      { owner, status: 403, code: 'FACILITY_ACCESS_DENIED' },
      { owner, status: 403, code: 'PERMISSION_DENIED' },
    ]))('keeps $owner $status $code a terminal failure under the owner code', async ({ owner, status, code }) => {
      ownerAnswers(status, code);
      const { built: { service, clients, audit }, operation } = owners[owner]();
      const problem = await refusal(publishTo(service, operation));
      expect([problem.getStatus(), problem.code]).toEqual([status, code]);
      expect(failureUpdate(clients)).toEqual({ code, summary: 'Publication was rejected by the owning domain',
        retryable: false });
      const event = auditEvents(audit).find(([, item]) => item.action === 'ocr.publication.fail')?.[1];
      expect(event?.details).toEqual({ publicationId, failureCode: code, ownerFailureCode: code, retryable: false });
    });
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
