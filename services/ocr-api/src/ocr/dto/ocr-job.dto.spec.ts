import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOcrJobDto } from './create-ocr-job.dto';
import { RetryOcrJobDto } from './retry-ocr-job.dto';
import { ValidateOcrJobDto } from './validate-ocr-job.dto';
import { ConfirmOcrPatientDto } from './confirm-ocr-patient.dto';
import { CreateOcrPublicationDto } from './create-ocr-publication.dto';

describe('OCR job DTOs', () => {
  it('accepts an unresolved patient while requiring an exact document reference', async () => {
    const errors = await validate(plainToInstance(CreateOcrJobDto, {
      documentId: '90000000-0000-4000-8000-000000000001',
      provider: 'provider-neutral',
      purpose: 'healthcare-operations',
    }));
    expect(errors).toHaveLength(0);
  });

  it('rejects unsafe retry metadata and stale-version omissions', async () => {
    const errors = await validate(plainToInstance(RetryOcrJobDto, {
      reason: 'short',
      purpose: 'healthcare-operations',
    }));
    expect(errors.some((error) => error.property === 'expectedVersion')).toBe(true);
    expect(errors.some((error) => error.property === 'reason')).toBe(true);
  });

  it('requires human validation to identify its immutable source extraction', async () => {
    const errors = await validate(plainToInstance(ValidateOcrJobDto, {
      expectedVersion: 4,
      validatedPayload: { candidate: 'reviewed' },
      corrections: [],
      reason: 'Verified against the source document',
      purpose: 'healthcare-operations',
    }));
    expect(errors.some((error) => error.property === 'extractionId')).toBe(true);
  });

  it('accepts a governed document-only validation without publishing it', async () => {
    const errors = await validate(plainToInstance(ValidateOcrJobDto, {
      extractionId: '90000000-0000-4000-8000-000000000001', expectedVersion: 4,
      validatedPayload: { summary: 'reviewed' }, disposition: 'validated',
      targetDomain: 'DOCUMENT_ONLY', candidateType: 'document_only',
      acceptedFields: { retention: 'source-document' }, rejectedFields: [], corrections: [],
      reason: 'Compared with the source document', purpose: 'healthcare-operations',
    }));
    expect(errors).toHaveLength(0);
  });

  it('requires explicit patient and validation versions for confirmation and publication', async () => {
    const confirmation = await validate(plainToInstance(ConfirmOcrPatientDto, {
      patientId: '50000000-0000-4000-8000-000000000001', method: 'source_document',
      reason: 'Confirmed from governed document evidence', purpose: 'healthcare-operations',
    }));
    const publication = await validate(plainToInstance(CreateOcrPublicationDto, {
      patientConfirmationId: '60000000-0000-4000-8000-000000000001',
      targetOperation: 'retain_validated_document', purpose: 'direct-care',
    }));
    expect(confirmation.some((error) => error.property === 'expectedJobVersion')).toBe(true);
    expect(publication.some((error) => error.property === 'validationVersion')).toBe(true);
  });
});

