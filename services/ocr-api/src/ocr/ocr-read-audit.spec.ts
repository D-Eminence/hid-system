import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { EhrApiService } from '../integrations/ehr-api.service';
import type { IdentityApiService } from '../integrations/identity-api.service';
import type { LabApiService } from '../integrations/lab-api.service';
import type { PharmacyApiService } from '../integrations/pharmacy-api.service';
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
}

type Rows = { rows: unknown[]; rowCount: number };
const rows = (items: unknown[]): Rows => ({ rows: items, rowCount: items.length });

function harness(options: Options = {}) {
  const order: string[] = [];
  const jobRow = options.jobRow === undefined ? job : options.jobRow;
  const route = (sql: string): Rows => {
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
    if (sql.includes('on job.id=validation.job_id')) return rows([validation]);
    if (sql.includes('from ocr.extractions where job_id')) { order.push('select extractions'); return rows([]); }
    if (sql.includes('from ocr.patient_confirmations where facility_id = $1')) return rows([]);
    if (sql.includes('coalesce(max(confirmation_version),0)+1')) return rows([{ version: 1 }]);
    if (sql.includes('insert into ocr.patient_confirmations')) return rows([confirmation]);
    if (sql.includes('from ocr.patient_confirmations where id=$1')) return rows([confirmation]);
    if (sql.includes('insert into ocr.outbox_events')) {
      if (options.outboxError) throw options.outboxError;
      return rows([]);
    }
    if (sql.includes('from ocr.publications where facility_id=$1')) return rows([]);
    if (sql.includes('select id::text from ocr.publications where validation_id=$1')) return rows([]);
    if (sql.includes('insert into ocr.publications')) return rows([publication]);
    if (sql.includes("update ocr.publications set status='processing'")) {
      return rows([{ ...publication, status: 'processing', attempt_count: 1, row_version: '2' }]);
    }
    if (sql.includes("update ocr.publications set status='published'")) {
      return rows(options.publishLost ? [] : [{ ...publication, status: 'published', row_version: '3' }]);
    }
    if (sql.includes("update ocr.publications set status='failed'")) {
      return rows([{ ...publication, status: 'failed', failure_code: 'OCR_PUBLICATION_CLAIM_LOST', row_version: '3' }]);
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
    const client = { query: jest.fn(async (sql: string) => route(sql)) } as unknown as PoolClient;
    clients.push(client);
    return operation(client);
  }) } as unknown as DatabaseService;
  const ehrApi = { getOcrDocumentSource: jest.fn(async () => {
    order.push('source');
    return source;
  }) } as unknown as EhrApiService;
  const identity = { authorize: jest.fn(async () => {
    order.push('authorize');
    return { allowed: options.allowed ?? true, breakGlass: false };
  }) } as unknown as IdentityApiService;
  const audit = { recordWithClient: jest.fn(async (_client: PoolClient, event: { action: string }) => {
    order.push(`audit ${event.action}`);
    if (options.auditFails) throw new Error('audit insert failed');
  }) } as unknown as AuditService;
  const service = new OcrService(database, identity, audit, ehrApi,
    {} as LabApiService, {} as PharmacyApiService);
  return { service, clients, database, audit, identity, order };
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
    const { service, audit } = harness({ jobRow: validatedJob, publishLost: true });

    await expect(service.createPublication(validationId, { validationVersion: 1,
      patientConfirmationId: confirmationId, targetOperation: 'retain_validated_document',
      purpose: 'direct-care' }, 'ocr-publish-key-000002', context))
      .rejects.toMatchObject({ code: 'OCR_PUBLICATION_CLAIM_LOST' });

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
});
