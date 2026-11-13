import type { PoolClient } from 'pg';
import type { AuditService } from '../../audit/audit.service';
import { requestDigest } from '../../common/idempotency';
import type { DataAccessContext } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import type { EhrApiService } from '../../integrations/ehr-api.service';
import type { IdentityApiService } from '../../integrations/identity-api.service';
import type { LabApiService } from '../../integrations/lab-api.service';
import type { PharmacyApiService } from '../../integrations/pharmacy-api.service';
import { plainToInstance } from 'class-transformer';
import { ValidateOcrJobDto } from '../dto/validate-ocr-job.dto';
import type { OcrPublicationSwitch } from '../ocr-publication-switch';
import type { OcrReadingSwitch } from '../ocr-reading-switch';
import { OcrService } from '../ocr.service';

// Fictional data only.
const context = {
  correlationId: 'ocr-review-outcome-correlation', facilityId: '10000000-0000-4000-8000-000000000001',
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'healthcare-operations',
  actor: { id: 'actor', subject: 'staff:records', accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['records'], permissions: ['ocr.validation.write'], facilityIds: [], facilities: [],
    authenticationMethod: 'local' },
  authorization: 'Bearer test',
} satisfies DataAccessContext;
const jobId = '70000000-0000-4000-8000-000000000001';
const extractionId = '80000000-0000-4000-8000-000000000001';
const job = { id: jobId, facility_id: context.facilityId, document_id: '60000000-0000-4000-8000-000000000001',
  patient_id: null, status: 'awaiting_validation', provider: 'test', attempt_count: 1, max_attempts: 3,
  row_version: '4', created_at: new Date('2026-11-09T10:00:00Z') };
const source = { id: job.document_id, patientId: '50000000-0000-4000-8000-000000000001',
  facilityId: context.facilityId, status: 'available', scanStatus: 'clean', objectVersionId: 'v1', sha256Hex: 'a'.repeat(64) };

const box = { left: 0.1, top: 0.1, width: 0.5, height: 0.02 };
const itemId = 'it-00000000000000a1';
const reading = { contract: 'hid-paper-reading-v2', pages: [{ page: 1, flagged: false, flagReasons: [], lines: [] }],
  identity: { nameAsWritten: 'Fictional Patient Okonkwo-Example' }, items: [
    { id: itemId, kind: 'medicine', asWritten: 'Zentoprilax 5mg od', plain: 'Zentoprilax five', dateAsWritten: null,
      page: 1, lineIds: ['p1-l1'], box, confidence: 'check_carefully', checkReasons: ['handwritten'],
      checkReason: 'Handwritten.', readBy: 'first_pass', prescription: null,
      fields: { name: 'Zentoprilax', strength: '5mg', form: null, route: null, frequency: 'od', duration: null,
        status: 'current' } },
    { id: 'it-00000000000000b2', kind: 'medicine', asWritten: 'Quorvadine 10mg bd', plain: 'q', dateAsWritten: null,
      page: 1, lineIds: ['p1-l2'], box, confidence: 'clear', checkReasons: [], checkReason: null, readBy: 'first_pass',
      prescription: null, fields: { name: 'Quorvadine', strength: '10mg', form: null, route: null, frequency: 'bd',
        duration: null, status: 'current' } },
  ], reading: { status: 'read', promptVersion: 'hid-paper-reading-prompt-13', itemCount: 2 } };
const extractionProvenance = { processingContract: 'hid-textract-v2',
  reading: { status: 'read', promptVersion: 'hid-paper-reading-prompt-13', hardPages: [] } };
const FIXTURE_TEXT = ['Zentoprilax', 'Quorvadine', 'Okonkwo', 'Fictional', '25mg', 'Fictional history', itemId];

type Rows = { rows: unknown[]; rowCount: number };
const rows = (items: unknown[]): Rows => ({ rows: items, rowCount: items.length });

function harness(options: { extractionError?: Error; replay?: Record<string, unknown> } = {}) {
  const calls: [string, unknown[]][] = [];
  const route = (sql: string, params: unknown[] = []): Rows => {
    calls.push([sql, params]);
    if (/from ocr\.jobs\s+where id = \$1/.test(sql)) return rows([job]);
    if (sql.includes('validation.idempotency_key = $3')) return rows(options.replay ? [options.replay] : []);
    if (sql.startsWith('savepoint') || sql.startsWith('release savepoint') || sql.startsWith('rollback to')) return rows([]);
    if (sql.includes('select structured_payload, provenance from ocr.extractions')) {
      if (options.extractionError) throw options.extractionError;
      return rows([{ structured_payload: reading, provenance: extractionProvenance }]);
    }
    if (sql.includes('from ocr.extractions where id = $1 and job_id = $2')) return rows([{ structured_payload: reading }]);
    if (sql.includes('coalesce(max(validation_version), 0) + 1')) return rows([{ version: 1 }]);
    if (sql.includes('insert into ocr.validations')) return rows([{ id: '90000000-0000-4000-8000-000000000001' }]);
    if (sql.includes('update ocr.jobs set status = $5')) return rows([{ ...job, status: 'validated', row_version: '5' }]);
    throw new Error(`Unexpected SQL in test: ${sql}`);
  };
  const client = { query: jest.fn(async (sql: string, params?: unknown[]) => route(sql, params)) } as unknown as PoolClient;
  const database = { withTransaction: jest.fn(async <T>(_c: DataAccessContext, operation: (db: PoolClient) => Promise<T>) =>
    operation(client)) } as unknown as DatabaseService;
  const audit = { recordWithClient: jest.fn(async () => undefined) } as unknown as AuditService;
  const service = new OcrService(database,
    { authorize: jest.fn(async () => ({ allowed: true, breakGlass: false })) } as unknown as IdentityApiService, audit,
    { getOcrDocumentSource: jest.fn(async () => source) } as unknown as EhrApiService, {} as LabApiService,
    {} as PharmacyApiService, { enabled: true } as OcrPublicationSwitch, { aiReadingOn: true } as OcrReadingSwitch);
  const insertedProvenance = () => {
    const call = calls.find(([sql]) => sql.includes('insert into ocr.validations'));
    return call ? JSON.parse(String(call[1][14])) as Record<string, unknown> : undefined;
  };
  const auditDetails = () => ((audit.recordWithClient as jest.Mock).mock.calls as [PoolClient, { action: string;
    details: Record<string, unknown> }][]).map(([, event]) => event);
  return { service, calls, insertedProvenance, auditDetails, database };
}

const body = (overrides: Partial<ValidateOcrJobDto> = {}): ValidateOcrJobDto => ({ extractionId, expectedVersion: 4,
  validatedPayload: { note: 'Fictional history' }, disposition: 'validated', targetDomain: 'PHARMACY',
  candidateType: 'historical_medication_evidence',
  acceptedFields: { medications: [{ itemId, page: 1, medicationText: 'Zentoprilax', strengthText: '25mg',
    frequencyText: 'od', historicalContext: 'Fictional history' }] },
  rejectedFields: [], corrections: [{ itemId, fields: ['strength'], changeReason: 'misread',
    originalValue: '5mg', correctedValue: '25mg' }], reason: 'Reviewed against the fictional source',
  purpose: 'healthcare-operations', reviewConfirmed: true, missedItems: 0,
  removedItems: [{ itemId: 'it-00000000000000b2', removalReason: 'not_on_paper' }], ...overrides });

describe('OCR learning after the validation (0118/0119)', () => {
  it('runs in its own READ COMMITTED transaction after the SERIALIZABLE save, never inside it', async () => {
    const { service, calls, database } = harness();
    await service.validate(jobId, body(), 'ocr-review-learning-key-0001', context);
    const options = (database.withTransaction as jest.Mock).mock.calls.map((call) => call[2]);
    expect(options).toEqual([{ isolationLevel: 'SERIALIZABLE' }, { isolationLevel: 'READ COMMITTED' }]);
    const update = calls.findIndex(([sql]) => sql.includes('update ocr.jobs set status = $5'));
    const learning = calls.findIndex(([sql]) => sql === 'savepoint ocr_learning_review');
    expect(update).toBeGreaterThan(-1);
    expect(learning).toBeGreaterThan(update);
  });

  it('answers the saved validation even when the learning transaction fails', async () => {
    const { service, database } = harness();
    const original = (database.withTransaction as jest.Mock).getMockImplementation()!;
    (database.withTransaction as jest.Mock).mockImplementation(async (c: DataAccessContext,
      operation: (db: PoolClient) => Promise<unknown>, options?: { isolationLevel?: string }) => {
      if (options?.isolationLevel === 'READ COMMITTED') throw Object.assign(new Error('down'), { code: '57P01' });
      return original(c, operation, options);
    });
    await expect(service.validate(jobId, body(), 'ocr-review-learning-key-0002', context)).resolves.toMatchObject({
      validationId: '90000000-0000-4000-8000-000000000001', disposition: 'validated' });
  });
});

describe('OCR validation review outcome', () => {
  it('stores the review outcome in the validation provenance and the accept audit, with no patient text', async () => {
    const { service, insertedProvenance, auditDetails } = harness();
    await service.validate(jobId, body(), 'ocr-review-outcome-key-0001', context);
    const provenance = insertedProvenance();
    expect(provenance).toMatchObject({ source: 'human_review', extractionId, reviewOutcome: {
      schema: 'hid.ocr.review-outcome/v1', promptVersion: 'hid-paper-reading-prompt-13', linkage: 'item_ids',
      totals: { read: 2, keptChanged: 1, removed: 1 } } });
    const [accept] = auditDetails();
    expect(accept?.action).toBe('ocr.validation.accept');
    expect(accept?.details.reviewOutcome).toEqual(provenance?.reviewOutcome);
    const serialized = JSON.stringify([provenance, accept?.details]);
    for (const text of FIXTURE_TEXT) expect(serialized).not.toContain(text);
  });

  it('stores the outcome of a rejected review in the reject audit', async () => {
    const { service, insertedProvenance, auditDetails } = harness();
    await service.validate(jobId, body({ disposition: 'rejected', targetDomain: 'UNCLASSIFIED',
      candidateType: 'unclassified', acceptedFields: {}, rejectionReasonCode: 'reading_unusable' }),
    'ocr-review-outcome-key-0002', context);
    expect(insertedProvenance()?.reviewOutcome).toMatchObject({ disposition: 'rejected',
      totals: { rejectedWithDocument: 2 }, reviewer: { rejectionReasonCode: 'reading_unusable' } });
    expect(auditDetails()[0]?.action).toBe('ocr.validation.reject');
  });

  it('still saves the review when the extraction cannot be read, storing summary_failed only', async () => {
    const { service, calls, insertedProvenance, auditDetails } = harness({
      extractionError: Object.assign(new Error('Zentoprilax read failed'), { code: '57014' }) });
    await expect(service.validate(jobId, body(), 'ocr-review-outcome-key-0003', context))
      .resolves.toMatchObject({ status: 'validated' });
    expect(calls.some(([sql]) => sql === 'rollback to savepoint ocr_review_outcome')).toBe(true);
    const failure = { schema: 'hid.ocr.review-outcome/v1', error: 'summary_failed' };
    expect(insertedProvenance()?.reviewOutcome).toEqual(failure);
    expect(auditDetails()[0]?.details.reviewOutcome).toEqual(failure);
  });

  it('still saves the review when the computation throws', async () => {
    // A correction whose fields cannot be read (a non-enumerable throwing getter: the digest and the stored
    // corrections never touch it, the outcome computation does).
    const hostile = { field: 'strength' };
    Object.defineProperty(hostile, 'fields', { enumerable: false, get() { throw new Error('Zentoprilax'); } });
    const { service, insertedProvenance } = harness();
    await expect(service.validate(jobId, body({ corrections: [hostile] }), 'ocr-review-outcome-key-0004', context))
      .resolves.toMatchObject({ status: 'validated' });
    expect(insertedProvenance()?.reviewOutcome).toEqual({ schema: 'hid.ocr.review-outcome/v1', error: 'summary_failed' });
  });

  it('refuses a rejection reason code on a validated review before anything is read', async () => {
    const { service, calls } = harness();
    await expect(service.validate(jobId, body({ rejectionReasonCode: 'wrong_patient' }),
      'ocr-review-outcome-key-0005', context)).rejects.toMatchObject({ code: 'OCR_REJECTION_REASON_NOT_ALLOWED' });
    expect(calls).toHaveLength(0);
  });

  it('keeps the digest of a request without the new fields unchanged, and joins them when sent', async () => {
    const legacyPlain = { extractionId, expectedVersion: 4, validatedPayload: {}, disposition: 'validated',
      targetDomain: 'DOCUMENT_ONLY', candidateType: 'document_only', acceptedFields: { retention: 'source-document' },
      rejectedFields: [], corrections: [], reason: 'Reviewed against the fictional source',
      purpose: 'healthcare-operations' };
    // The digest an existing client's request had before these fields existed.
    const before = requestDigest('ocr.validation.create', { jobId, ...legacyPlain });
    // The same request through the DTO class now (every declared field is an own key, the new ones undefined).
    const instance = plainToInstance(ValidateOcrJobDto, legacyPlain);
    expect(Object.keys(instance)).toEqual(expect.arrayContaining(['missedItems']));
    const replayed = harness({ replay: { request_sha256: before, id: 'v', job_id: jobId, extraction_id: extractionId,
      validation_version: 1, disposition: 'validated', target_domain: 'DOCUMENT_ONLY', candidate_type: 'document_only',
      accepted_fields: {}, rejected_fields: [], corrections: [], reason: 'r', created_at: new Date() } });
    await expect(replayed.service.validate(jobId, instance, 'ocr-review-outcome-key-0006', context))
      .resolves.toMatchObject({ id: 'v' });
    // The same key with a review signal added is a different request.
    const conflict = harness({ replay: { request_sha256: before } });
    await expect(conflict.service.validate(jobId, plainToInstance(ValidateOcrJobDto, { ...legacyPlain, missedItems: 2 }),
      'ocr-review-outcome-key-0006', context)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});
