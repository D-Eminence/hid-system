import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ValidateOcrJobDto } from './validate-ocr-job.dto';

const base = { extractionId: '80000000-0000-4000-8000-000000000001', expectedVersion: 4, validatedPayload: {},
  disposition: 'rejected', targetDomain: 'UNCLASSIFIED', candidateType: 'unclassified', acceptedFields: {},
  rejectedFields: [], corrections: [], reason: 'Reviewed against the fictional source', purpose: 'healthcare-operations' };
const errorsOf = async (extra: Record<string, unknown>) =>
  (await validate(plainToInstance(ValidateOcrJobDto, { ...base, ...extra }), { whitelist: true,
    forbidNonWhitelisted: true, forbidUnknownValues: true })).map((error) => error.property);

describe('optional review signals on a validation', () => {
  it('leaves an existing request (none of them, free-form corrections) valid', async () => {
    expect(await errorsOf({ corrections: [{ field: 'title', originalValue: 'a', correctedValue: 'b' }] })).toEqual([]);
  });

  it('accepts every signal within its bounds', async () => {
    expect(await errorsOf({ reviewConfirmed: true, missedItems: 200, rejectionReasonCode: 'pages_missing',
      removedItems: [{ itemId: 'it-00000000000000a1', removalReason: 'other_patient' }],
      corrections: [{ itemId: 'it-00000000000000a1', fields: ['name', 'dose'], changeReason: 'clinical_update' }] }))
      .toEqual([]);
  });

  it.each([
    ['reviewConfirmed', { reviewConfirmed: 'yes' }],
    ['reviewConfirmed', { reviewConfirmed: null }],
    ['missedItems', { missedItems: 201 }],
    ['missedItems', { missedItems: -1 }],
    ['missedItems', { missedItems: 1.5 }],
    ['rejectionReasonCode', { rejectionReasonCode: 'Patient said so' }],
    ['removedItems', { removedItems: [{ itemId: 'it-00000000000000a1', removalReason: 'because' }] }],
    ['removedItems', { removedItems: [{ itemId: 'Fictional name', removalReason: 'duplicate' }] }],
    ['removedItems', { removedItems: [{ itemId: 'it-00000000000000a1', removalReason: 'duplicate', note: 'x' }] }],
    ['removedItems', { removedItems: Array.from({ length: 201 }, () => ({ itemId: 'it-00000000000000a1',
      removalReason: 'duplicate' })) }],
    ['corrections', { corrections: [{ fields: ['colour'] }] }],
    ['corrections', { corrections: [{ fields: ['name', 'name'] }] }],
    ['corrections', { corrections: [{ fields: [] }] }],
    ['corrections', { corrections: [{ changeReason: 'typo' }] }],
    ['corrections', { corrections: [{ itemId: 'not-an-item' }] }],
    ['corrections', { corrections: ['text'] }],
  ])('refuses an invalid %s', async (property, extra) => {
    expect(await errorsOf(extra)).toContain(property);
  });
});
