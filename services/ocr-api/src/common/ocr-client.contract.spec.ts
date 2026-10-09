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
});
