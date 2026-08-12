import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRegistrationCaseDto } from './create-registration-case.dto';

describe('Outreach registration DTO', () => {
  it('accepts only a temporary identifier independently generated as tmp_uuid-v4', async () => {
    const common = { localCommandId: '123e4567-e89b-42d3-a456-426614174000',
      fullName: 'Ada Person', sex: 'unknown', ageYears: 32 };
    const canonicalLooking = plainToInstance(CreateRegistrationCaseDto,
      { ...common, temporaryPatientId: '123e4567-e89b-42d3-a456-426614174001' });
    expect((await validate(canonicalLooking)).some((error) => error.property === 'temporaryPatientId')).toBe(true);
    const temporary = plainToInstance(CreateRegistrationCaseDto,
      { ...common, temporaryPatientId: 'tmp_123e4567-e89b-42d3-a456-426614174001' });
    expect(await validate(temporary)).toEqual([]);
  });

  it('does not accept canonical identity, clinical, campaign, or document fields', async () => {
    const input = plainToInstance(CreateRegistrationCaseDto, {
      localCommandId: '123e4567-e89b-42d3-a456-426614174000',
      temporaryPatientId: 'tmp_123e4567-e89b-42d3-a456-426614174001',
      fullName: 'Ada Person', sex: 'female', ageYears: 32,
      patientId: '123e4567-e89b-42d3-a456-426614174002', campaignId: 'campaign',
      diagnosis: 'not Outreach data', document: 'not Outreach data',
    });
    const errors = await validate(input, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((error) => error.property)).toEqual(expect.arrayContaining([
      'patientId', 'campaignId', 'diagnosis', 'document',
    ]));
  });
});
