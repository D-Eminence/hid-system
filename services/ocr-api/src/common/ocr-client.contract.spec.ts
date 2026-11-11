import { OcrApiClient, OcrContractError } from '@hid/api-client';

const job = { id: 'job-id', facilityId: 'facility-id', documentId: 'document-id',
  patientId: null, status: 'queued', provider: 'textract', attemptCount: 0,
  maxAttempts: 3, version: 1, createdAt: '2026-08-11T10:00:00.000Z', patientConfirmation: null };

describe('OcrApiClient browser contract', () => {
  it('uses stable public routes and forwards idempotency, purpose, and abort context', async () => {
    const transport = jest.fn().mockResolvedValue(job);
    const client = new OcrApiClient({ transport });
    const signal = new AbortController().signal;
    await expect(client.createJob({ documentId: 'document-id', provider: 'textract',
      purpose: 'healthcare-operations' }, 'ocr-job-key-1234', signal)).resolves.toEqual(job);
    expect(transport).toHaveBeenCalledWith({ path: '/api/v1/ocr/jobs', method: 'POST',
      body: { documentId: 'document-id', provider: 'textract', purpose: 'healthcare-operations' },
      idempotencyKey: 'ocr-job-key-1234', purposeOfUse: 'healthcare-operations', signal });
  });

  it('rejects malformed numeric and enum fields instead of reporting success', async () => {
    const transport = jest.fn().mockResolvedValue({ ...job, attemptCount: 'zero' });
    const client = new OcrApiClient({ transport });
    await expect(client.getJob('job-id')).rejects.toBeInstanceOf(OcrContractError);

    transport.mockResolvedValueOnce({ id: 'publication-id', validationId: 'validation-id',
      validationVersion: 1, patientConfirmationId: 'confirmation-id', patientId: 'patient-id',
      targetDomain: 'UNCLASSIFIED', targetOperation: 'retain_validated_document', status: 'published',
      targetResourceType: 'document', targetResourceId: 'document-id', failureCode: null,
      failureSummary: null, attemptCount: 1, maxAttempts: 3, version: 2 });
    await expect(client.publish('validation-id', { validationVersion: 1,
      patientConfirmationId: 'confirmation-id', targetOperation: 'retain_validated_document',
      purpose: 'direct-care' }, 'ocr-publication-key-1234')).rejects.toBeInstanceOf(OcrContractError);
  });

  describe('extractions (migration 0111: a reading deleted after 24 hours)', () => {
    const extraction = { id: 'extraction-id', version: 1, attempt: 1, provider: 'textract', providerModel: null,
      contentDeleted: false, rawText: 'Fictional reading line', structuredPayload: { contract: 'hid-paper-reading-v2' },
      confidence: 0.9, provenance: {}, createdAt: '2026-11-10T10:00:00.000Z' };

    it('parses a normal extraction with its text', async () => {
      const client = new OcrApiClient({ transport: jest.fn().mockResolvedValue({ items: [extraction] }) });
      await expect(client.listExtractions('job-id')).resolves.toEqual([extraction]);
    });

    it('parses an extraction ocr-api marks deleted to a clear content-deleted state, without text', async () => {
      const deleted = { ...extraction, contentDeleted: true, rawText: '', structuredPayload: {} };
      const client = new OcrApiClient({ transport: jest.fn().mockResolvedValue({ items: [deleted] }) });
      await expect(client.listExtractions('job-id')).resolves.toEqual([{ ...deleted }]);
      const withNull = new OcrApiClient({ transport: jest.fn().mockResolvedValue({ items: [{ ...deleted, rawText: null }] }) });
      await expect(withNull.listExtractions('job-id')).resolves.toMatchObject([{ contentDeleted: true, rawText: '' }]);
    });

    it('still rejects an empty rawText on an extraction that is not marked deleted', async () => {
      for (const item of [{ ...extraction, rawText: '' }, { ...extraction, contentDeleted: undefined, rawText: '' },
        { ...extraction, rawText: null }]) {
        const client = new OcrApiClient({ transport: jest.fn().mockResolvedValue({ items: [item] }) });
        await expect(client.listExtractions('job-id')).rejects.toBeInstanceOf(OcrContractError);
      }
    });

    it('rejects a malformed contentDeleted, or text on an extraction marked deleted', async () => {
      for (const item of [{ ...extraction, contentDeleted: 'yes' }, { ...extraction, contentDeleted: true }]) {
        const client = new OcrApiClient({ transport: jest.fn().mockResolvedValue({ items: [item] }) });
        await expect(client.listExtractions('job-id')).rejects.toBeInstanceOf(OcrContractError);
      }
    });

    it('accepts an extraction from an ocr-api built before 0111 (no contentDeleted field) as not deleted', async () => {
      const { contentDeleted: _omitted, ...older } = extraction;
      const client = new OcrApiClient({ transport: jest.fn().mockResolvedValue({ items: [older] }) });
      await expect(client.listExtractions('job-id')).resolves.toEqual([{ ...older, contentDeleted: false }]);
    });
  });
});
