import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VerifyPatientAccessPinDto } from './verify-patient-access-pin.dto';

const errorsFor = async (body: Record<string, unknown>) =>
  validate(plainToInstance(VerifyPatientAccessPinDto, body), { whitelist: true, forbidNonWhitelisted: true });

describe('VerifyPatientAccessPinDto', () => {
  const base = { hid: 'hid-abcdefgh', pin: '12 34' };

  it('accepts no duration (the service then asks for 24 hours)', async () => {
    await expect(errorsFor(base)).resolves.toHaveLength(0);
  });

  it.each([5, 60, 61, 1439, 1440])('accepts %i minutes (0121: up to 24 hours)', async (durationMinutes) => {
    await expect(errorsFor({ ...base, durationMinutes })).resolves.toHaveLength(0);
  });

  it.each([4, 1441, 2880, 0, -1, 60.5])('refuses %p minutes', async (durationMinutes) => {
    const errors = await errorsFor({ ...base, durationMinutes });
    expect(errors.map((error) => error.property)).toEqual(['durationMinutes']);
  });

  it('takes no scope from the caller: the database fixes it', async () => {
    const errors = await errorsFor({ ...base, scope: 'read_records' });
    expect(errors.map((error) => error.property)).toEqual(['scope']);
  });
});
