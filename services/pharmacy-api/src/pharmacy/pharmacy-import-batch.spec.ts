import { requestDigest } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import type { OcrMedicationImportBatchDto } from './dto/ocr-medication-import.dto';
import { PharmacyOrderRouteAccess } from './order-route-access';
import { PharmacyOrderRouteCards } from './order-route-cards';
import { batchItemKey, batchPublicationId, MAX_BATCH_KEY_LENGTH, PharmacyService } from './pharmacy.service';

// Fictional test data only.
const ids = {
  patient: '123e4567-e89b-42d3-a456-426614174001', facility: '123e4567-e89b-42d3-a456-426614174002',
  account: '123e4567-e89b-42d3-a456-426614174003', membership: '123e4567-e89b-42d3-a456-426614174004',
  document: '123e4567-e89b-42d3-a456-426614174005', job: '123e4567-e89b-42d3-a456-426614174006',
  extraction: '123e4567-e89b-42d3-a456-426614174007', validation: '123e4567-e89b-42d3-a456-426614174008',
  publication: '123e4567-e89b-42d3-a456-426614174009', reviewer: '123e4567-e89b-42d3-a456-42661417400a',
};
const context: DataAccessContext = {
  correlationId: 'correlation-123456', facilityId: ids.facility, membershipId: ids.membership,
  purposeOfUse: 'direct-care', authorization: 'Bearer user', actor: {
    id: ids.account, subject: 'staff:test', accountId: ids.account, authenticationMethod: 'local',
    roles: ['records'], permissions: ['pharmacy.import.write'], facilityIds: [ids.facility], facilities: [],
  },
};
const key = 'ocr-publication:123e4567-e89b-42d3-a456-426614174009';
const batch: OcrMedicationImportBatchDto = {
  patientId: ids.patient, sourceDocumentId: ids.document, ocrJobId: ids.job, extractionId: ids.extraction,
  validationId: ids.validation, validationVersion: 1, publicationId: ids.publication, reviewedBy: ids.reviewer,
  medications: [
    { medicationText: 'Amlodipine', strengthText: '5mg', frequencyText: 'once daily',
      historicalContext: 'From a paper record, page 2. As written: Amlodipine 5mg od. Dated 12/03/2019' },
    { medicationText: 'Metformin', strengthText: '500mg', frequencyText: 'twice daily',
      historicalContext: 'From a paper record, page 3. As written: Metformin 500mg bd' },
    { medicationText: 'Metformin', strengthText: '500mg', frequencyText: 'twice daily',
      historicalContext: 'From a paper record, page 3. As written: Metformin 500mg bd' },
  ],
};
const digest = requestDigest('pharmacy.imported-medication-evidence.create-batch', batch);

function row(index: number, overrides: Record<string, unknown> = {}) {
  const item = batch.medications[index];
  return { id: `223e4567-e89b-42d3-a456-42661417400${index}`, patient_id: ids.patient, facility_id: ids.facility,
    source_type: 'IMPORTED_MEDICATION_EVIDENCE', activity_status: 'unknown', source_document_id: ids.document,
    ocr_job_id: ids.job, extraction_id: ids.extraction, validation_id: ids.validation, validation_version: 1,
    publication_id: batchPublicationId(ids.publication, index), medication_text: item?.medicationText,
    strength_text: item?.strengthText ?? null, dose_text: null, frequency_text: item?.frequencyText ?? null,
    historical_context: item?.historicalContext ?? null, reviewed_by: ids.reviewer, row_version: '1',
    created_at: new Date('2026-11-05T10:00:00Z'), request_sha256: digest,
    idempotency_key: batchItemKey(key, index), ...overrides };
}

function harness(query: jest.Mock) {
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: false }) };
  const audit = { recordWithClient: jest.fn() };
  const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => unknown) =>
    operation({ query })) };
  const service = new PharmacyService(database as never, identity as never, audit as never,
    new PharmacyOrderRouteAccess(identity as never), new PharmacyOrderRouteCards(database as never));
  return { service, identity, audit, database };
}

/** Answers the replay lookup with `existing` and each insert with its row; the rest with nothing. */
function routed(existing: unknown[], failAtInsert?: number) {
  let inserts = 0;
  return jest.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes('select * from pharmacy.imported_medication_evidence')) return { rows: existing };
    if (sql.includes('insert into pharmacy.imported_medication_evidence')) {
      const index = inserts;
      inserts += 1;
      if (failAtInsert === index) {
        throw Object.assign(new Error('new row violates check constraint'), { code: '23514' });
      }
      return { rows: [row(index)] };
    }
    return { rows: [] };
  });
}

describe('PharmacyService.createImportBatch', () => {
  it('stores every medicine as its own record, event and audit row, in reading order', async () => {
    const query = routed([]);
    const { service, identity, audit, database } = harness(query);
    const result = await service.createImportBatch(context, batch, key);
    expect(identity.authorize).toHaveBeenCalledWith(ids.patient, 'write_records', context);
    expect(database.withTransaction).toHaveBeenCalledWith(context, expect.any(Function),
      { isolationLevel: 'SERIALIZABLE' });
    expect(result.count).toBe(3);
    expect(result.id).toBe(result.items[0]?.id);
    expect(result.items.map((item) => item.medicationText)).toEqual(['Amlodipine', 'Metformin', 'Metformin']);
    const inserts = query.mock.calls.filter(([sql]) => String(sql).includes('insert into pharmacy.imported_medication_evidence'));
    // Two identical lines stay two records, each with its own key and publication id.
    expect(inserts).toHaveLength(3);
    expect(inserts.map(([, values]) => (values as unknown[])[17]))
      .toEqual([`${key}:m01`, `${key}:m02`, `${key}:m03`]);
    const publicationIds = inserts.map(([, values]) => (values as unknown[])[8]);
    expect(new Set(publicationIds).size).toBe(3);
    expect(publicationIds).not.toContain(ids.publication);
    inserts.forEach(([, values], index) => {
      const v = values as unknown[];
      expect(v[6]).toBe(ids.validation);
      expect(v[9]).toBe(batch.medications[index]?.medicationText);
      expect(v[13]).toBe(batch.medications[index]?.historicalContext);
      expect(v[18]).toBe(digest);
    });
    const outbox = query.mock.calls.filter(([sql]) => String(sql).includes('pharmacy.outbox_events'));
    expect(outbox).toHaveLength(3);
    for (const [, values] of outbox) {
      expect(Object.keys(JSON.parse(String((values as unknown[])[6]))).sort())
        .toEqual(['activityStatus', 'importedMedicationEvidenceId', 'sourceType']);
    }
    expect(audit.recordWithClient).toHaveBeenCalledTimes(3);
    expect(audit.recordWithClient.mock.calls[2]?.[4]).toMatchObject({ batchIndex: 3, batchSize: 3,
      publicationId: ids.publication, validationId: ids.validation });
  });

  it('lets a failure on one medicine abort the whole transaction, so none is kept', async () => {
    const query = routed([], 1);
    const { service, audit } = harness(query);
    await expect(service.createImportBatch(context, batch, key)).rejects.toMatchObject({ code: '23514' });
    // The error leaves the transaction callback, so DatabaseService rolls back the first insert too.
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('insert into pharmacy.imported_medication_evidence')))
      .toHaveLength(2);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
  });

  it('answers an identical replay with the stored records and writes nothing', async () => {
    const query = routed([row(0), row(1), row(2)]);
    const { service, audit } = harness(query);
    const result = await service.createImportBatch(context, batch, key);
    expect(result).toMatchObject({ count: 3, id: row(0).id });
    expect(query).toHaveBeenCalledTimes(1);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it.each([
    ['a partial replay', [row(0), row(1)]],
    ['a replay of a different request', [row(0, { request_sha256: 'f'.repeat(64) }), row(1), row(2)]],
    ['a publication already stored through the single route',
      [row(0, { publication_id: ids.publication, idempotency_key: key })]],
  ])('refuses %s with 409 and writes nothing', async (_name, existing) => {
    const query = routed(existing);
    const { service } = harness(query);
    await expect(service.createImportBatch(context, batch, key))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a view-only share', { allowed: false, breakGlass: false }],
    ['break-glass', { allowed: true, breakGlass: true }],
  ])('refuses %s with 403 before any transaction', async (_name, decision) => {
    const query = routed([]);
    const { service, identity, database } = harness(query);
    identity.authorize.mockResolvedValue(decision);
    await expect(service.createImportBatch(context, batch, key))
      .rejects.toMatchObject({ status: 403, code: 'PHARMACY_ACCESS_DENIED' });
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it('refuses a key too long to carry the per-medicine suffix', async () => {
    const query = routed([]);
    const { service, database } = harness(query);
    await expect(service.createImportBatch(context, batch, 'k'.repeat(MAX_BATCH_KEY_LENGTH + 1)))
      .rejects.toMatchObject({ status: 400 });
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(batchItemKey('k'.repeat(MAX_BATCH_KEY_LENGTH), 49)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/);
  });

  it('derives stable, distinct UUID version 5 publication ids', () => {
    const first = batchPublicationId(ids.publication, 0);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(batchPublicationId(ids.publication.toUpperCase(), 0)).toBe(first);
    expect(batchPublicationId(ids.publication, 1)).not.toBe(first);
    expect(batchPublicationId('123e4567-e89b-42d3-a456-426614174010', 0)).not.toBe(first);
  });
});
