import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SignupPatientEnrollmentDto, StartPatientEnrollmentDto } from './dto/patient-enrollment.dto';

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

  describe('sign-up without NIN', () => {
    const valid = { firstName: 'Ada', lastName: 'Obi', email: 'ada@example.test', phone: '08031234567',
      gender: 'female', termsAccepted: true, turnstileToken: 'opaque-token', turnstileAction: 'patient-enrollment' };

    it('accepts the declared profile, with or without the hospital, and both phone forms', async () => {
      for (const body of [valid, { ...valid, hospitalCurrentlyUsing: 'LUTH' }, { ...valid, phone: '+2348031234567' },
        { ...valid, gender: 'male' }]) {
        expect(await validate(plainToInstance(SignupPatientEnrollmentDto, body), options)).toHaveLength(0);
      }
    });

    it.each([
      ['firstName', { firstName: '' }], ['firstName', { firstName: 'a'.repeat(81) }],
      ['lastName', { lastName: undefined }], ['email', { email: 'not-an-email' }],
      ['phone', { phone: '+447700900123' }], ['gender', { gender: 'robot' }],
      ['hospitalCurrentlyUsing', { hospitalCurrentlyUsing: 'h'.repeat(121) }],
      ['termsAccepted', { termsAccepted: false }], ['turnstileAction', { turnstileAction: 'login' }],
      ['nin', { nin: '12345678901' }],
    ] as const)('refuses an invalid or unexpected %s', async (field, change) => {
      const errors = await validate(plainToInstance(SignupPatientEnrollmentDto, { ...valid, ...change }), options);
      expect(errors.map(({ property }) => property)).toEqual([field]);
    });
  });
});
