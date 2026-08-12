import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AcceptEhrPrescriptionDto } from './accept-ehr-prescription.dto';
import { OcrMedicationImportDto } from './ocr-medication-import.dto';

const uuid = '123e4567-e89b-42d3-a456-426614174000';

describe('Pharmacy DTOs', () => {
  it('accepts only an explicitly active exact EHR prescription version', async () => {
    const input = plainToInstance(AcceptEhrPrescriptionDto, {
      sourceEhrPrescriptionId: uuid, sourceEhrPrescriptionVersion: 2, sourceEncounterId: uuid,
      patientId: uuid, orderingFacilityId: uuid, sourceStatus: 'draft', medicationDisplay: 'Amoxicillin',
      frequency: 'Three times daily', instructions: 'Take with food', prescribedBy: uuid,
      prescribedAt: '2026-08-10T10:00:00.000Z', acceptanceReason: 'Accepted against active prescription',
    });
    expect((await validate(input)).some((error) => error.property === 'sourceStatus')).toBe(true);
  });

  it('bounds imported evidence and does not accept an activity status claim', async () => {
    const input = plainToInstance(OcrMedicationImportDto, {
      patientId: uuid, sourceDocumentId: uuid, ocrJobId: uuid, extractionId: uuid,
      validationId: uuid, validationVersion: 1, publicationId: uuid, reviewedBy: uuid,
      medicationText: 'A'.repeat(501), activityStatus: 'active',
    });
    const errors = await validate(input, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.some((error) => error.property === 'medicationText')).toBe(true);
    expect(errors.some((error) => error.property === 'activityStatus')).toBe(true);
  });
});
