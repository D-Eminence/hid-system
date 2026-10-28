import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { StartOtpDto } from './dto/otp.dto';
import { PatientLoginDto } from './dto/patient-login.dto';
import { loginPrincipalKey, PATIENT_PRINCIPAL_PATTERN, patientPrincipal } from './patient-principal';

describe('What a patient types to sign in or reset (owner decision of 2026-10-28)', () => {
  it.each([
    ['Ada@Example.Test', { kind: 'email', value: 'ada@example.test' }],
    ['hid-abc234', { kind: 'hid', value: 'HID-ABC234' }],
    ['08031234567', { kind: 'phone', value: '+2348031234567' }],
    ['0803 123 4567', { kind: 'phone', value: '+2348031234567' }],
    ['(0803) 123-4567', { kind: 'phone', value: '+2348031234567' }],
    ['+2348031234567', { kind: 'phone', value: '+2348031234567' }],
    ['+234 0803 123 4567', { kind: 'phone', value: '+2348031234567' }],
    ['+44 7700 900123', { kind: 'phone', value: '+447700900123' }],
    ['+1.415.555.0100', { kind: 'phone', value: '+14155550100' }],
    ['+6834002', { kind: 'phone', value: '+6834002' }],
    ['+123456', { kind: 'invalid', value: '+123456' }],
    ['+1234567890123456', { kind: 'invalid', value: '+1234567890123456' }],
    ['0803123456', { kind: 'invalid', value: '0803123456' }],
    ['2348031234567', { kind: 'invalid', value: '2348031234567' }],
    ['HID-IO01', { kind: 'invalid', value: 'hid-io01' }],
  ])('reads %s', (typed, expected) => {
    expect(patientPrincipal(typed)).toEqual(expected);
  });

  it('keys the lockout by the E.164 number for every way of typing a phone, and as before for email and Health ID', () => {
    for (const typed of ['08031234567', '0803 123 4567', '+2348031234567', '+234-0803-123-4567']) {
      expect(loginPrincipalKey(typed, 'patient')).toBe('+2348031234567');
    }
    expect(loginPrincipalKey(' Ada@Example.Test ', 'patient')).toBe('ada@example.test');
    expect(loginPrincipalKey('HID-ABC234', 'patient')).toBe('hid-abc234');
    expect(loginPrincipalKey(' Doctor@Example.Test ', 'staff')).toBe('doctor@example.test');
    expect(loginPrincipalKey('08031234567', 'staff')).toBe('08031234567');
  });

  it.each(['ada@example.test', 'HID-ABC234', '08031234567', '0803 123 4567', '(0803) 123-4567', '+2348031234567',
    '+44 7700 900123', '+1 (415) 555-0100', '+6834002'])('lets the DTOs through: %s', async (typed) => {
    expect(PATIENT_PRINCIPAL_PATTERN.test(typed)).toBe(true);
    expect(await validate(plainToInstance(PatientLoginDto, { email: typed, password: 'correct-password' })))
      .toHaveLength(0);
    expect(await validate(plainToInstance(StartOtpDto, { identifier: typed, purpose: 'PASSWORD_RESET',
      turnstileAction: 'patient-reset-start' }))).toHaveLength(0);
  });

  it.each(['12345678901', '2348031234567', '+12345', '0803', 'call me', '+44 7700 900123 ext 4', 'HID-IO01', ''])(
    'refuses at the DTOs: %s', async (typed) => {
      expect(await validate(plainToInstance(PatientLoginDto, { email: typed, password: 'correct-password' })))
        .not.toHaveLength(0);
      expect(await validate(plainToInstance(StartOtpDto, { identifier: typed, purpose: 'PASSWORD_RESET',
        turnstileAction: 'patient-reset-start' }))).not.toHaveLength(0);
    });
});
