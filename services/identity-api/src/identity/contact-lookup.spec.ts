import { resetEnvironmentForTests } from '../config/environment';
import {
  contactLookupHmacWithKey, normalizeContactForLookup, normalizePatientPhone, patientPhoneLookupValue,
  patientPhoneStoredForms,
} from './contact-lookup';

describe('canonical contact lookup', () => {
  const key = Buffer.alloc(32, 4);

  it.each([
    ['phone' as const, '08012345678', '+2348012345678',
      'f581b89538c9b7b250b3678c2671a37f0211abfa1a8b813ba963ae17adfc5248'],
    ['email' as const, ' Patient@Example.Test ', 'patient@example.test',
      'e15c0546f956495899f58ae92277b215dc3cb4183f8ce379b04f70f18c5047a8'],
  ])('matches the migration vector for %s', (channel, input, normalized, expected) => {
    expect(normalizeContactForLookup(channel, input)).toBe(normalized);
    expect(contactLookupHmacWithKey(channel, normalized, key)).toBe(expected);
  });

  it.each([
    ['08012345678', '+2348012345678'], ['0801 234 5678', '+2348012345678'], ['+234 (801) 234-5678', '+2348012345678'],
    ['+2340801.234.5678', '+2348012345678'], ['+44 7700 900123', '+447700900123'], ['+6834002', '+6834002'],
    ['+123456789012345', '+123456789012345'],
  ])('reads the patient phone %s as %s (owner decision of 2026-10-28)', (typed, normalized) => {
    expect(normalizePatientPhone(typed)).toBe(normalized);
  });

  it.each(['0801234567', '+123456', '+1234567890123456', '+0447700900123', '447700900123', 'phone'])(
    'refuses the patient phone %s', (typed) => {
      expect(normalizePatientPhone(typed)).toBeUndefined();
    });

  it('keeps the migration vector for a Nigerian phone and also hashes a 7-digit E.164 number', () => {
    expect(contactLookupHmacWithKey('phone', normalizePatientPhone('08012345678')!, key))
      .toBe('f581b89538c9b7b250b3678c2671a37f0211abfa1a8b813ba963ae17adfc5248');
    expect(contactLookupHmacWithKey('phone', '+6834002', key)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => contactLookupHmacWithKey('phone', '08012345678', key)).toThrow('Contact lookup is unavailable');
    expect(() => contactLookupHmacWithKey('email', 'Not An Email', key)).toThrow('Contact lookup is unavailable');
  });

  it('looks a Nigerian number up in both forms hid-1.0 may have stored, the canonical one first', () => {
    // hid-1.0 kept a phone as typed (digits and "+"): "+234 0803 000 9920" was
    // migrated as +23408030009920, and the importer and rekey keep that form.
    expect(patientPhoneStoredForms('+2348030009920')).toEqual(['+2348030009920', '+23408030009920']);
    for (const typed of ['08030009920', '+2348030009920', '+234 0803 000 9920', '+2340803-000-9920']) {
      expect(patientPhoneStoredForms(normalizePatientPhone(typed)!)).toEqual(['+2348030009920', '+23408030009920']);
    }
    expect(patientPhoneStoredForms('+447700900123')).toEqual(['+447700900123']);
    expect(patientPhoneStoredForms('+234803000992')).toEqual(['+234803000992']);
    expect(patientPhoneStoredForms('+6834002')).toEqual(['+6834002']);
  });

  it('gives auth.find_patient_account the HMAC of each stored form, comma separated', () => {
    const original = { ...process.env };
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      CONTACT_LOOKUP_HMAC_KEY_B64: key.toString('base64'),
    });
    resetEnvironmentForTests();
    try {
      expect(patientPhoneLookupValue('+2348012345678')).toBe([
        'f581b89538c9b7b250b3678c2671a37f0211abfa1a8b813ba963ae17adfc5248',
        contactLookupHmacWithKey('phone', '+23408012345678', key)].join(','));
      expect(patientPhoneLookupValue('+447700900123')).toBe(contactLookupHmacWithKey('phone', '+447700900123', key));
      expect(patientPhoneLookupValue('+2348012345678')).toMatch(/^[0-9a-f]{64},[0-9a-f]{64}$/);
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
      Object.assign(process.env, original);
      resetEnvironmentForTests();
    }
  });
});
