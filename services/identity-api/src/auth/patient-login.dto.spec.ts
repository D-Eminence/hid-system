import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from './dto/login.dto';
import { PatientLoginDto } from './dto/patient-login.dto';

describe('Patient sign-in identifier contract', () => {
  const password = 'correct-password';

  it('normalizes and accepts an issued HID for patient sign-in', async () => {
    const input = plainToInstance(PatientLoginDto, { email: '  hid-abcdefgh  ', password });
    expect(input.email).toBe('HID-ABCDEFGH');
    expect(await validate(input)).toHaveLength(0);
  });

  it('retains email sign-in for patients and rejects malformed HID values', async () => {
    expect(await validate(plainToInstance(PatientLoginDto, {
      email: 'patient@example.test', password,
    }))).toHaveLength(0);
    for (const email of ['HID-IO01', 'HID-ABC', 'HID-ABC_DEF', '12345678901']) {
      expect(await validate(plainToInstance(PatientLoginDto, { email, password })))
        .not.toHaveLength(0);
    }
  });

  it('keeps staff and admin credentials restricted to email', async () => {
    expect(await validate(plainToInstance(LoginDto, { email: 'HID-ABCDEFGH', password })))
      .not.toHaveLength(0);
    const staff = plainToInstance(LoginDto, { email: ' Staff@Example.Test ', password });
    expect(staff.email).toBe('staff@example.test');
    expect(await validate(staff)).toHaveLength(0);
  });
});
