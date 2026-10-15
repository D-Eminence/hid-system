import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ActivatePatientEnrollmentDto, StartPatientEnrollmentDto,
  VerifyPatientEnrollmentHolderDto } from './dto/patient-enrollment.dto';

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

  // ADR-062: the holder code check takes the challenge and the code, nothing
  // else; the phone is never a value the caller gives.
  it('accepts a holder code check with a v4 challenge id and six digits only', async () => {
    const challengeId = '6ec117dd-68b0-402a-91a0-c2cf311dcaf7';
    const errors = async (body: Record<string, unknown>) => (await validate(
      plainToInstance(VerifyPatientEnrollmentHolderDto, body), options)).map(({ property }) => property).sort();
    expect(await errors({ challengeId, code: '012345' })).toEqual([]);
    expect(await errors({ challengeId, code: '12345' })).toEqual(['code']);
    expect(await errors({ challengeId, code: '1234567' })).toEqual(['code']);
    expect(await errors({ challengeId, code: 123456 })).toEqual(['code']);
    expect(await errors({ challengeId: 'not-a-uuid', code: '123456' })).toEqual(['challengeId']);
    expect(await errors({ challengeId, code: '123456', phone: '08031234567' })).toEqual(['phone']);
  });

  // ADR-061: a NIN record without a date of birth or gender asks the patient
  // for them at activation. Both are optional at the request boundary; the
  // service decides which are required and checks the date against the calendar.
  describe('activation', () => {
    const password = 'a-strong-test-password';
    const errors = async (body: Record<string, unknown>) => (await validate(
      plainToInstance(ActivatePatientEnrollmentDto, body), options)).map(({ property }) => property).sort();

    it('accepts a password alone, or with a date of birth and a gender', async () => {
      expect(await errors({ password })).toEqual([]);
      expect(await errors({ password, dateOfBirth: '1990-01-02' })).toEqual([]);
      expect(await errors({ password, gender: 'unknown' })).toEqual([]);
      for (const gender of ['female', 'male', 'intersex', 'other', 'unknown']) {
        expect(await errors({ password, dateOfBirth: '1990-01-02', gender })).toEqual([]);
      }
    });

    it('refuses a date of birth that is not YYYY-MM-DD and a gender outside the list', async () => {
      for (const dateOfBirth of ['02-01-1990', '1990/01/02', '19900102', '1990-1-2', ' 1990-01-02', 19900102, '']) {
        expect(await errors({ password, dateOfBirth })).toEqual(['dateOfBirth']);
      }
      for (const gender of ['F', 'Female', 'woman', '', 1]) {
        expect(await errors({ password, gender })).toEqual(['gender']);
      }
    });

    it('still refuses any other field, such as a name', async () => {
      expect(await errors({ password, firstName: 'Amina', dateOfBirth: '1990-01-02' })).toEqual(['firstName']);
    });
  });
});
