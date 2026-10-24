import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateDemoRequestDto } from '../commercial/demo-request.dto';
import { StartOrganizationProfileCompletionDto, SubmitOrganizationApplicationDto } from '../identity/dto/organization-application.dto';
import { StartPatientEnrollmentDto } from '../identity/dto/patient-enrollment.dto';
import { StartProviderEnrollmentDto } from '../identity/dto/provider-enrollment.dto';

// TS-8 (main D-Eminence/hid-system#79): a missing Turnstile token reaches
// TurnstileService, which answers 400 TURNSTILE_REQUIRED, instead of failing
// request validation as 400 VALIDATION_FAILED. A token that is present must
// still be a string of at most 2048 characters.
const dtos = [
  ['StartPatientEnrollmentDto', StartPatientEnrollmentDto],
  ['StartProviderEnrollmentDto', StartProviderEnrollmentDto],
  ['SubmitOrganizationApplicationDto', SubmitOrganizationApplicationDto],
  ['StartOrganizationProfileCompletionDto', StartOrganizationProfileCompletionDto],
  ['CreateDemoRequestDto', CreateDemoRequestDto],
] as const;

async function tokenErrors(dto: (typeof dtos)[number][1], value: Record<string, unknown>) {
  const errors = await validate(plainToInstance(dto as new () => object, value));
  return errors.filter((error) => error.property === 'turnstileToken');
}

describe('Turnstile token validation on gated routes (TS-8)', () => {
  it.each(dtos)('%s accepts a missing token for TurnstileService to refuse', async (_name, dto) => {
    expect(await tokenErrors(dto, {})).toEqual([]);
  });

  it.each(dtos)('%s still refuses a token that is not a string or is too long', async (_name, dto) => {
    expect(await tokenErrors(dto, { turnstileToken: 42 })).toHaveLength(1);
    expect(await tokenErrors(dto, { turnstileToken: 'x'.repeat(2049) })).toHaveLength(1);
    expect(await tokenErrors(dto, { turnstileToken: 'x'.repeat(2048) })).toEqual([]);
  });
});
