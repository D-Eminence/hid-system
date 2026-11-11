import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import { requestDigest } from '../common/idempotency';
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
  /** An earlier job under the same Idempotency-Key, with the digest it was stored with. */
  replay?: { requestSha256: string };
  /** Identity has no precheck route yet (an older Identity answers 404). */
  noPrecheck?: boolean;
}

function harness(options: Options = {}) {
  const allowed = new Set(options.allowedPatients ?? [patientId]);
  const order: string[] = [];
  const name = (id: string) => (id === patientId ? 'patient' : 'other');
  const route = (sql: string) => {
    if (sql.includes("operation = 'ocr.extract' and idempotency_key = $3")) {
      return options.replay ? { rows: [job], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes('select request_sha256 from ocr.jobs')) {
      return { rows: [{ request_sha256: options.replay?.requestSha256 }], rowCount: 1 };
    }
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
  // authorize is the call that notes ("Your records were opened") and audits a
  // read in Identity; precheckRecordsRead has neither side effect.
  const identity = {
    precheckRecordsRead: jest.fn(async (id: string) => {
      order.push(`precheck ${name(id)}`);
      return options.noPrecheck ? undefined : { allowed: allowed.has(id), breakGlass: false };
    }),
    authorize: jest.fn(async (id: string) => {
      order.push(`authorize ${name(id)}`);
      return { allowed: allowed.has(id), breakGlass: false };
    }),
  } as unknown as IdentityApiService;
  const audit = { recordWithClient: jest.fn(async () => undefined) } as unknown as AuditService;
  const service = new OcrService(database, identity, audit, ehrApi, {} as LabApiService, {} as PharmacyApiService,
    { enabled: true } as OcrPublicationSwitch, { aiReadingOn: false } as OcrReadingSwitch);
  return { service, ehrApi, identity, audit, order };
}

const create = (service: OcrService, patient: string | undefined) => service.createJob({ documentId,
  ...(patient ? { patientId: patient } : {}), provider: 'textract', purpose: 'healthcare-operations' },
'ocr-create-consent-key-0001', context);

/** The digest createJob stores for this test's request naming the given patient. */
const digestFor = (patient: string) => requestDigest('ocr.job.create', { facilityId: context.facilityId,
  documentId, patientId: patient, provider: 'textract', maxAttempts: 3 });

describe('OCR job creation asks for records-processing consent before reading the document', () => {
  it('creates the job with one authorize, on the source patient, after a precheck that notes nothing', async () => {
    const { service, identity, order } = harness();

    await expect(create(service, patientId)).resolves.toMatchObject({ id: jobId, status: 'queued' });

    expect(order).toEqual(['precheck patient', 'source', 'authorize patient', 'insert job']);
    expect(identity.precheckRecordsRead).toHaveBeenCalledWith(patientId, 'healthcare-operations', context);
    expect(identity.authorize).toHaveBeenCalledTimes(1);
    expect(identity.authorize).toHaveBeenCalledWith(patientId, 'read_records', 'healthcare-operations', context);
  });

  it('refuses with 403 OCR_RECORDS_PROCESSING_CONSENT_REQUIRED and makes no EHR call or authorize', async () => {
    const { service, ehrApi, identity, audit } = harness({ allowedPatients: [] });

    const refusal = await create(service, patientId).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(DomainProblem);
    expect(refusal).toMatchObject({ code: 'OCR_RECORDS_PROCESSING_CONSENT_REQUIRED' });
    expect((refusal as DomainProblem).getStatus()).toBe(403);
    expect(ehrApi.getOcrDocumentSource).not.toHaveBeenCalled();
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('refuses a wrong patient without consent before any document read, so the document is not revealed', async () => {
    const { service, ehrApi } = harness({ allowedPatients: [patientId] });

    await expect(create(service, otherPatientId)).rejects.toMatchObject({
      code: 'OCR_RECORDS_PROCESSING_CONSENT_REQUIRED' });
    expect(ehrApi.getOcrDocumentSource).not.toHaveBeenCalled();
  });

  it('never authorizes (so never notes) a consenting wrong patient before the mismatch answer', async () => {
    const { service, identity, order } = harness({ allowedPatients: [patientId, otherPatientId] });

    await expect(create(service, otherPatientId)).rejects.toMatchObject({ code: 'OCR_PATIENT_MISMATCH' });
    expect(order).toEqual(['precheck other', 'source']);
    expect(identity.authorize).not.toHaveBeenCalled();
  });

  it('keeps the 404 when a named, consenting patient does not reach the hidden document, authorizing nobody', async () => {
    const { service, identity } = harness({ allowedPatients: [patientId, otherPatientId], sourceHidden: true });

    const refusal = await create(service, otherPatientId).catch((error: unknown) => error);
    expect((refusal as DomainProblem).getStatus()).toBe(404);
    expect(identity.authorize).not.toHaveBeenCalled();
  });

  it('keeps the source 404 without a patientId and does not guess at consent', async () => {
    const { service, identity } = harness({ sourceHidden: true });

    const refusal = await create(service, undefined).catch((error: unknown) => error);

    expect((refusal as DomainProblem).getStatus()).toBe(404);
    expect(identity.precheckRecordsRead).not.toHaveBeenCalled();
    expect(identity.authorize).not.toHaveBeenCalled();
  });

  it('keeps the post-source OCR_ACCESS_DENIED check without a patientId', async () => {
    const { service } = harness({ allowedPatients: [] });

    await expect(create(service, undefined)).rejects.toMatchObject({ code: 'OCR_ACCESS_DENIED' });
  });

  it('goes on to the source read as before against an Identity without the precheck route', async () => {
    const { service, order } = harness({ allowedPatients: [], noPrecheck: true, sourceHidden: true });

    const refusal = await create(service, patientId).catch((error: unknown) => error);
    expect((refusal as DomainProblem).getStatus()).toBe(404);
    expect(order).toEqual(['precheck patient', 'source']);
  });
});

describe('OCR job creation answers an Idempotency-Key replay before the consent precheck', () => {
  it('answers 409 IDEMPOTENCY_CONFLICT for a key reused with a different patient who has no cover', async () => {
    const { service, identity, ehrApi } = harness({ allowedPatients: [patientId],
      replay: { requestSha256: digestFor(patientId) } });

    const refusal = await create(service, otherPatientId).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((refusal as DomainProblem).getStatus()).toBe(409);
    expect(identity.precheckRecordsRead).not.toHaveBeenCalled();
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(ehrApi.getOcrDocumentSource).not.toHaveBeenCalled();
  });

  it('answers 404 OCR_JOB_NOT_FOUND, not 403, for an exact replay after the cover has lapsed', async () => {
    const { service, identity, order } = harness({ allowedPatients: [],
      replay: { requestSha256: digestFor(patientId) } });

    const refusal = await create(service, patientId).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ code: 'OCR_JOB_NOT_FOUND' });
    expect((refusal as DomainProblem).getStatus()).toBe(404);
    expect(identity.precheckRecordsRead).not.toHaveBeenCalled();
    expect(order).toEqual(['source', 'authorize patient']);
  });

  it('returns the existing job for an exact replay while the cover holds', async () => {
    const { service, identity, order } = harness({ replay: { requestSha256: digestFor(patientId) } });

    await expect(create(service, patientId)).resolves.toMatchObject({ id: jobId });
    expect(identity.precheckRecordsRead).not.toHaveBeenCalled();
    expect(order).toEqual(['source', 'authorize patient']);
  });
});
