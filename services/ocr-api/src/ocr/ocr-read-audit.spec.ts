import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
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
} satisfies DataAccessContext;

const patientId = '50000000-0000-4000-8000-000000000001';
const documentId = '60000000-0000-4000-8000-000000000001';
const jobId = '70000000-0000-4000-8000-000000000001';
const validationId = '90000000-0000-4000-8000-000000000001';

// A job created without a patient keeps patient_id null for its whole life
// (0016 ocr.validate_job_write); the canonical patient comes from the source
// document that authorizeJob resolves.
const job = { id: jobId, facility_id: context.facilityId, document_id: documentId, patient_id: null,
  status: 'awaiting_validation', provider: 'test', attempt_count: 1, max_attempts: 3,
  row_version: '4', created_at: new Date('2026-10-09T10:00:00Z') };
const validation = { id: validationId, job_id: jobId, facility_id: context.facilityId,
  extraction_id: '80000000-0000-4000-8000-000000000001', validation_version: 1, disposition: 'validated',
  target_domain: 'EHR', candidate_type: 'clinical_note', accepted_fields: { note: 'clinical text' },
  rejected_fields: [], corrections: [], reason: 'Reviewed', validated_by: context.actor.accountId,
  created_at: new Date('2026-10-09T10:05:00Z'), document_id: documentId, patient_id: null,
  job_status: 'validated' };
const publication = { id: 'a0000000-0000-4000-8000-000000000001', job_id: jobId,
  validation_id: validationId, validation_version: 1,
  patient_confirmation_id: 'b0000000-0000-4000-8000-000000000001', facility_id: context.facilityId,
  patient_id: patientId, target_domain: 'EHR', target_operation: 'create_imported_clinical_note',
  status: 'published', request_sha256: 'a'.repeat(64), attempt_count: 1, max_attempts: 3,
  target_resource_type: 'clinical-note', target_resource_id: 'c0000000-0000-4000-8000-000000000001',
  failure_code: null, failure_summary: null, row_version: '2',
  requested_at: new Date('2026-10-09T10:06:00Z'), completed_at: new Date('2026-10-09T10:06:01Z') };

function harness(options: { jobRow?: typeof job | null; allowed?: boolean; auditFails?: boolean } = {}) {
  const order: string[] = [];
  const jobRow = options.jobRow === undefined ? job : options.jobRow;
  const client = { query: jest.fn(async (sql: string) => {
    if (sql.includes('from ocr.validations validation join ocr.jobs job on job.id = validation.job_id')) {
      order.push('select validations');
      return { rows: [validation], rowCount: 1 };
    }
    if (sql.includes('from ocr.validations validation join ocr.jobs job')) {
      return { rows: [validation], rowCount: 1 };
    }
    if (sql.includes('from ocr.publications where validation_id')) {
      order.push('select publications');
      return { rows: [publication], rowCount: 1 };
    }
    if (sql.includes('from ocr.extractions where job_id')) {
      order.push('select extractions');
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('update ocr.jobs set status = \'queued\'')) {
      return { rows: [{ ...job, status: 'queued', row_version: '5' }], rowCount: 1 };
    }
    if (sql.includes('from ocr.jobs')) {
      order.push('select job');
      return { rows: jobRow ? [jobRow] : [], rowCount: jobRow ? 1 : 0 };
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  }) } as unknown as PoolClient;
  const database = { withTransaction: jest.fn(async <T>(_context: DataAccessContext,
    operation: (db: PoolClient) => Promise<T>) => operation(client)) } as unknown as DatabaseService;
  const ehrApi = { getOcrDocumentSource: jest.fn(async () => {
    order.push('source');
    return { id: documentId, patientId, facilityId: context.facilityId };
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
  return { service, client, audit, identity, order };
}

function auditEvent(audit: AuditService) {
  const calls = (audit.recordWithClient as jest.Mock).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0] as [PoolClient, Record<string, unknown>];
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
    const { service, client, audit, order } = harness();

    await read.run(service);

    const [auditClient, event] = auditEvent(audit);
    expect(auditClient).toBe(client);
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

describe('Existing OCR job events also name the canonical patient', () => {
  it.each([
    { action: 'ocr.job.read', run: (service: OcrService) => service.getJob(jobId, context) },
    { action: 'ocr.extraction.list', run: (service: OcrService) => service.listExtractions(jobId, context) },
    { action: 'ocr.job.retry',
      run: (service: OcrService) => service.retry(jobId, { expectedVersion: 4, reason: 'Provider timeout',
        purpose: 'healthcare-operations' }, context) },
  ])('$action links the source document patient when the job has none', async ({ action, run }) => {
    const { service, audit } = harness();

    await run(service);

    const [, event] = auditEvent(audit);
    expect(event).toMatchObject({ action, patientId });
  });
});
