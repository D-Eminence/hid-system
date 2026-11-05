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
import type { OcrReadingSwitch } from './ocr-reading-switch';
import { OcrService } from './ocr.service';

// Fictional identifiers only.
const context = {
  correlationId: 'ocr-create-consent-correlation', facilityId: '10000000-0000-4000-8000-000000000001',
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'healthcare-operations',
  actor: { id: 'actor', subject: 'staff:records', accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['records'], permissions: ['ocr.job.create'], facilityIds: [], facilities: [], authenticationMethod: 'local' },
  authorization: 'Bearer test',
} satisfies DataAccessContext;

const patientId = '50000000-0000-4000-8000-000000000001';
const otherPatientId = '50000000-0000-4000-8000-000000000002';
const documentId = '60000000-0000-4000-8000-000000000001';
const jobId = '70000000-0000-4000-8000-000000000001';
const job = { id: jobId, facility_id: context.facilityId, document_id: documentId, patient_id: patientId,
  status: 'queued', provider: 'textract', attempt_count: 0, max_attempts: 3,
  row_version: '1', created_at: new Date('2026-10-09T10:00:00Z') };
const source = { id: documentId, patientId, facilityId: context.facilityId, status: 'available',
  scanStatus: 'clean', objectVersionId: 'object-version-1', sha256Hex: 'a'.repeat(64) };

interface Options {
  /** Patients whose records-processing cover lets this staff member read. */
  allowedPatients?: readonly string[];
  /** The EHR source read hides the document (row-level security answers 404). */
  sourceHidden?: boolean;
}

function harness(options: Options = {}) {
  const allowed = new Set(options.allowedPatients ?? [patientId]);
  const order: string[] = [];
  const route = (sql: string) => {
    if (sql.includes("operation = 'ocr.extract' and idempotency_key = $3")) return { rows: [], rowCount: 0 };
    if (sql.includes('ocr.extractions extraction')) return { rows: [], rowCount: 0 };
    if (sql.includes('insert into ocr.jobs')) { order.push('insert job'); return { rows: [job], rowCount: 1 }; }
    throw new Error('Unexpected SQL in test');
  };
  const database = { withTransaction: jest.fn(async <T>(_context: DataAccessContext,
    operation: (db: PoolClient) => Promise<T>) => {
    const client = { query: jest.fn(async (sql: string) => route(sql)) } as unknown as PoolClient;
    return operation(client);
  }) } as unknown as DatabaseService;
  const ehrApi = { getOcrDocumentSource: jest.fn(async () => {
    order.push('source');
    if (options.sourceHidden) throw new DomainProblem(404, 'DOCUMENT_NOT_FOUND', 'Document was not found');
    return source;
  }) } as unknown as EhrApiService;
  const identity = { authorize: jest.fn(async (id: string) => {
    order.push(`authorize ${id === patientId ? 'patient' : 'other'}`);
    return { allowed: allowed.has(id), breakGlass: false };
  }) } as unknown as IdentityApiService;
  const audit = { recordWithClient: jest.fn(async () => undefined) } as unknown as AuditService;
  const service = new OcrService(database, identity, audit, ehrApi, {} as LabApiService, {} as PharmacyApiService,
    { enabled: true } as OcrPublicationSwitch, { aiReadingOn: false } as OcrReadingSwitch);
  return { service, ehrApi, identity, audit, order };
}

const create = (service: OcrService, patient: string | undefined) => service.createJob({ documentId,
  ...(patient ? { patientId: patient } : {}), provider: 'textract', purpose: 'healthcare-operations' },
'ocr-create-consent-key-0001', context);

describe('OCR job creation asks for records-processing consent before reading the document', () => {
  it('creates the job as before when the named patient allows records processing', async () => {
    const { service, identity, order } = harness();

    await expect(create(service, patientId)).resolves.toMatchObject({ id: jobId, status: 'queued' });

    expect(order).toEqual(['authorize patient', 'source', 'authorize patient', 'insert job']);
    expect(identity.authorize).toHaveBeenNthCalledWith(1, patientId, 'read_records', 'healthcare-operations', context);
  });

  it('refuses with 403 OCR_RECORDS_PROCESSING_CONSENT_REQUIRED and makes no EHR call', async () => {
    const { service, ehrApi, audit } = harness({ allowedPatients: [] });

    const refusal = await create(service, patientId).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(DomainProblem);
    expect(refusal).toMatchObject({ code: 'OCR_RECORDS_PROCESSING_CONSENT_REQUIRED' });
    expect((refusal as DomainProblem).getStatus()).toBe(403);
    expect(ehrApi.getOcrDocumentSource).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('refuses a wrong patient without consent before any document read, so the document is not revealed', async () => {
    const { service, ehrApi } = harness({ allowedPatients: [patientId] });

    await expect(create(service, otherPatientId)).rejects.toMatchObject({
      code: 'OCR_RECORDS_PROCESSING_CONSENT_REQUIRED' });
    expect(ehrApi.getOcrDocumentSource).not.toHaveBeenCalled();
  });

  it('keeps the patient-mismatch answer when the named patient allows processing but is not the source patient', async () => {
    const { service, order } = harness({ allowedPatients: [patientId, otherPatientId] });

    await expect(create(service, otherPatientId)).rejects.toMatchObject({ code: 'OCR_PATIENT_MISMATCH' });
    expect(order).toEqual(['authorize other', 'source']);
  });

  it('keeps the 404 when a named, consenting patient does not reach the hidden document', async () => {
    const { service } = harness({ allowedPatients: [patientId, otherPatientId], sourceHidden: true });

    const refusal = await create(service, otherPatientId).catch((error: unknown) => error);
    expect((refusal as DomainProblem).getStatus()).toBe(404);
  });

  it('keeps the source 404 without a patientId and does not guess at consent', async () => {
    const { service, identity } = harness({ sourceHidden: true });

    const refusal = await create(service, undefined).catch((error: unknown) => error);

    expect((refusal as DomainProblem).getStatus()).toBe(404);
    expect(identity.authorize).not.toHaveBeenCalled();
  });

  it('keeps the post-source OCR_ACCESS_DENIED check without a patientId', async () => {
    const { service } = harness({ allowedPatients: [] });

    await expect(create(service, undefined)).rejects.toMatchObject({ code: 'OCR_ACCESS_DENIED' });
  });
});
