import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { EhrApiService } from '../integrations/ehr-api.service';
import type { IdentityApiService } from '../integrations/identity-api.service';
import type { LabApiService } from '../integrations/lab-api.service';
import type { PharmacyApiService } from '../integrations/pharmacy-api.service';
import type { CreateOcrPublicationDto } from './dto/create-ocr-publication.dto';
import type { OcrPublicationSwitch } from './ocr-publication-switch';
import type { OcrReadingSwitch } from './ocr-reading-switch';
import { OcrService } from './ocr.service';

// Publishing needs the publisher's own direct-care write_records grant, for
// every target. A caller who can read the job but has no such grant (a
// records-processing cover holder) gets 403 OCR_PUBLISH_NEEDS_DIRECT_CARE;
// one who cannot read it gets 404, as before; break-glass stays refused with
// 404. Fictional ids throughout.

const context = {
  correlationId: 'ocr-publish-refusal-correlation', facilityId: '10000000-0000-4000-8000-000000000001',
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care',
  actor: { id: 'actor', subject: 'staff:migrate', accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['nurse'], permissions: ['ocr.publication.write'], facilityIds: [], facilities: [],
    authenticationMethod: 'local' },
  authorization: 'Bearer test',
} satisfies DataAccessContext;

const patientId = '50000000-0000-4000-8000-000000000001';
const documentId = '60000000-0000-4000-8000-000000000001';
const jobId = '70000000-0000-4000-8000-000000000001';
const validationId = '90000000-0000-4000-8000-000000000001';
const confirmationId = 'b0000000-0000-4000-8000-000000000001';
const publicationId = 'a0000000-0000-4000-8000-000000000001';
const noteId = 'd0000000-0000-4000-8000-000000000001';

const job = { id: jobId, facility_id: context.facilityId, document_id: documentId, patient_id: null,
  status: 'validated', provider: 'test', attempt_count: 1, max_attempts: 3,
  row_version: '5', created_at: new Date('2026-10-09T10:00:00Z') };
const targets = {
  EHR: { operation: 'create_imported_clinical_note', candidate_type: 'clinical_note',
    accepted_fields: { encounterId: 'c0000000-0000-4000-8000-000000000001', noteType: 'progress',
      title: 'Imported note', content: 'Fictional clinical text' } },
  LAB: { operation: 'create_imported_lab_evidence', candidate_type: 'lab_document',
    accepted_fields: { observations: [{ testName: 'Haemoglobin', value: '12.5', unit: 'g/dL' }] } },
  PHARMACY: { operation: 'create_imported_medication_evidence', candidate_type: 'medication_list',
    accepted_fields: { medicationName: 'Paracetamol' } },
  DOCUMENT_ONLY: { operation: 'retain_validated_document', candidate_type: 'document_only',
    accepted_fields: { note: 'Fictional text' } },
} as const;
type Domain = keyof typeof targets;
const confirmation = { id: confirmationId, job_id: jobId, patient_id: patientId, confirmation_version: 1,
  method: 'source_document', created_at: new Date('2026-10-09T10:05:30Z'), request_sha256: 'c'.repeat(64) };
const source = { id: documentId, patientId, facilityId: context.facilityId, status: 'available',
  scanStatus: 'clean', objectVersionId: 'object-version-1', sha256Hex: 'a'.repeat(64) };

interface Access {
  /** EHR's answer to the source read: the source, or a refusal status. */
  source: 'visible' | 404 | 403;
  write: { allowed: boolean; breakGlass?: boolean };
}

type Rows = { rows: unknown[]; rowCount: number };
const rows = (items: unknown[]): Rows => ({ rows: items, rowCount: items.length });

function harness(domain: Domain, access: Access) {
  const target = targets[domain];
  const validation = { id: validationId, job_id: jobId, facility_id: context.facilityId,
    extraction_id: '80000000-0000-4000-8000-000000000001', validation_version: 1, disposition: 'validated',
    target_domain: domain, candidate_type: target.candidate_type, accepted_fields: target.accepted_fields,
    rejected_fields: [], corrections: [], reason: 'Reviewed', validated_by: context.actor.accountId,
    created_at: new Date('2026-10-09T10:05:00Z'), document_id: documentId, patient_id: null, job_status: 'validated' };
  const publication = { id: publicationId, job_id: jobId, validation_id: validationId, validation_version: 1,
    patient_confirmation_id: confirmationId, facility_id: context.facilityId, patient_id: patientId,
    target_domain: domain, target_operation: target.operation, status: 'pending',
    request_sha256: 'a'.repeat(64), attempt_count: 0, max_attempts: 3, target_resource_type: null,
    target_resource_id: null, failure_code: null, failure_summary: null, row_version: '1',
    requested_at: new Date('2026-10-09T10:06:00Z'), completed_at: null };
  const route = (sql: string, params: unknown[] = []): Rows => {
    if (sql.includes('for key share')) return rows([{ id: jobId }]);
    if (/from ocr\.jobs\s+where id = \$1/.test(sql)) return rows([job]);
    if (sql.includes('on job.id=validation.job_id')) return rows([validation]);
    if (sql.includes('from ocr.patient_confirmations where id=$1')) return rows([confirmation]);
    if (sql.includes('insert into ocr.outbox_events')) return rows([]);
    if (sql.includes('from ocr.publications where facility_id=$1')) return rows([]);
    if (sql.includes('select id::text from ocr.publications where validation_id=$1')) return rows([]);
    if (sql.includes('insert into ocr.publications')) return rows([publication]);
    if (sql.includes("update ocr.publications set status='processing'")) {
      return rows([{ ...publication, status: 'processing', attempt_count: 1, row_version: '2' }]);
    }
    if (sql.includes("update ocr.publications set status='published'")) {
      return rows([{ ...publication, status: 'published', row_version: '3', target_resource_type: params[2],
        target_resource_id: params[3] }]);
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  };
  const clients: PoolClient[] = [];
  const database = { withTransaction: jest.fn(async <T>(_context: DataAccessContext,
    operation: (db: PoolClient) => Promise<T>) => {
    const client = { query: jest.fn(async (sql: string, params?: unknown[]) => route(sql, params)) } as unknown as PoolClient;
    clients.push(client);
    return operation(client);
  }) } as unknown as DatabaseService;
  const ehrApi = {
    getOcrDocumentSource: jest.fn(async () => {
      if (access.source === 'visible') return source;
      throw new DomainProblem(access.source, 'DOCUMENT_REFUSED', 'Document was not available');
    }),
    createOcrClinicalNote: jest.fn(async (_patient: string, _input: unknown, _call: DataAccessContext, _key: string) =>
      ({ id: noteId, status: 'draft' })),
  };
  const identity = { authorize: jest.fn(async () => ({ allowed: access.write.allowed,
    breakGlass: access.write.breakGlass ?? false })) };
  const labApi = { createOcrImport: jest.fn() };
  const pharmacyApi = { createOcrImport: jest.fn(), createOcrImportBatch: jest.fn() };
  const audit = { recordWithClient: jest.fn(async () => undefined) };
  const service = new OcrService(database, identity as unknown as IdentityApiService,
    audit as unknown as AuditService, ehrApi as unknown as EhrApiService,
    labApi as unknown as LabApiService, pharmacyApi as unknown as PharmacyApiService,
    { enabled: true } as OcrPublicationSwitch, { aiReadingOn: false } as OcrReadingSwitch);
  const publish = () => service.createPublication(validationId,
    { validationVersion: 1, patientConfirmationId: confirmationId,
      targetOperation: target.operation as CreateOcrPublicationDto['targetOperation'], purpose: 'direct-care' },
    'ocr-publish-refusal-key-0001', context);
  const sql = () => clients.flatMap((client) => (client.query as unknown as jest.Mock).mock.calls
    .map(([text]) => text as string));
  const nothingWritten = () => {
    expect(sql().some((text) => text.includes('insert into ocr.publications'))).toBe(false);
    expect(ehrApi.createOcrClinicalNote).not.toHaveBeenCalled();
    expect(labApi.createOcrImport).not.toHaveBeenCalled();
    expect(pharmacyApi.createOcrImport).not.toHaveBeenCalled();
    expect(pharmacyApi.createOcrImportBatch).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  };
  return { publish, ehrApi, identity, nothingWritten };
}

async function refusal(run: () => Promise<unknown>): Promise<DomainProblem> {
  try { await run(); } catch (error) {
    expect(error).toBeInstanceOf(DomainProblem);
    return error as DomainProblem;
  }
  throw new Error('The publication was not refused');
}

describe('OCR publication refusals', () => {
  it('publishes an EHR note under the publisher\'s own direct-care write grant, under direct-care', async () => {
    const run = harness('EHR', { source: 'visible', write: { allowed: true } });
    await expect(run.publish()).resolves.toMatchObject({ status: 'published', targetResourceId: noteId });
    expect(run.identity.authorize.mock.calls.map((call) => (call as unknown[]).slice(1, 3)))
      .toEqual([['write_records', 'direct-care'], ['write_records', 'direct-care']]);
    expect(run.ehrApi.createOcrClinicalNote.mock.calls[0]?.[2]).toMatchObject({ purposeOfUse: 'direct-care' });
  });

  it.each(['EHR', 'LAB', 'PHARMACY', 'DOCUMENT_ONLY'] as const)(
    'answers 403 OCR_PUBLISH_NEEDS_DIRECT_CARE for %s to a caller who can read the job but has no direct-care write',
    async (domain) => {
      const run = harness(domain, { source: 'visible', write: { allowed: false } });
      const problem = await refusal(run.publish);
      expect([problem.getStatus(), problem.code, problem.message]).toEqual([403, 'OCR_PUBLISH_NEEDS_DIRECT_CARE',
        'Ask a clinician with access to this patient to publish it.']);
      expect(run.identity.authorize).toHaveBeenCalledWith(patientId, 'write_records', 'direct-care', context);
      run.nothingWritten();
    });

  it.each([404, 403] as const)('keeps 404 OCR_JOB_NOT_FOUND when EHR answers the source with %s', async (status) => {
    const run = harness('EHR', { source: status, write: { allowed: true } });
    const problem = await refusal(run.publish);
    expect([problem.getStatus(), problem.code]).toEqual([404, 'OCR_JOB_NOT_FOUND']);
    expect(run.identity.authorize).not.toHaveBeenCalled();
    run.nothingWritten();
  });

  it('still refuses a break-glass write as before, with 404 OCR_JOB_NOT_FOUND', async () => {
    const run = harness('EHR', { source: 'visible', write: { allowed: true, breakGlass: true } });
    const problem = await refusal(run.publish);
    expect([problem.getStatus(), problem.code]).toEqual([404, 'OCR_JOB_NOT_FOUND']);
    run.nothingWritten();
  });
});
