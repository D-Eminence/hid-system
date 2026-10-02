import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { StartPatientEnrollmentDto } from './dto/patient-enrollment.dto';

describe('Patient enrollment request contract', () => {
  const options = { whitelist: true, forbidNonWhitelisted: true };

  it('accepts NIN and Turnstile evidence without applicant demographic claims', async () => {
    const input = plainToInstance(StartPatientEnrollmentDto, {
      nin: '12345678901', turnstileAction: 'patient-enrollment', turnstileToken: 'opaque-token',
    });
    expect(await validate(input, options)).toHaveLength(0);
  });

  it('rejects name or DOB claims and malformed NINs at the public request boundary', async () => {
    const claimed = plainToInstance(StartPatientEnrollmentDto, {
      nin: '12345678901', turnstileAction: 'patient-enrollment', turnstileToken: 'opaque-token',
      firstName: 'Amina', lastName: 'Okafor', dateOfBirth: '1990-01-02',
    });
    const claimErrors = await validate(claimed, options);
    expect(claimErrors.map(({ property }) => property).sort()).toEqual(['dateOfBirth', 'firstName', 'lastName']);
    for (const invalid of ['1234567890', '123456789012', 'abc12345678']) {
      const input = plainToInstance(StartPatientEnrollmentDto, {
        nin: invalid, turnstileAction: 'patient-enrollment', turnstileToken: 'opaque-token',
      });
      expect(await validate(input, options)).not.toHaveLength(0);
    }
  });
});
