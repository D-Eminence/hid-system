jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { randomBytes } from 'node:crypto';
import { resetEnvironmentForTests } from '../config/environment';
import { PatientEnrollmentService } from '../identity/patient-enrollment.service';
import { PatientProfileCrypto } from './patient-profile-crypto';

const originalEnvironment = { ...process.env };
const NIN_KEY = randomBytes(32).toString('base64');
const OTP_KEY = randomBytes(32).toString('base64');

function environment(extra: Record<string, string | undefined> = {}) {
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
    NIN_ENCRYPTION_KEY_B64: NIN_KEY, NIN_KEY_VERSION: 'nin-v7', OTP_HMAC_KEY_B64: OTP_KEY, OTP_HMAC_KEY_VERSION: 'otp-v3',
  });
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  resetEnvironmentForTests();
}

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  resetEnvironmentForTests();
});

describe('PatientProfileCrypto (0094)', () => {
  it('encrypts a changed contact under its change and channel only', () => {
    environment();
    const crypto = new PatientProfileCrypto();
    const value = crypto.encryptContact('change-1', 'email', 'new@example.invalid');
    expect(value[0]).toBe(1);
    expect(value.length).toBe('new@example.invalid'.length + 29);
    expect(value.toString('utf8')).not.toContain('new@example.invalid');
    expect(crypto.decryptContact('change-1', 'email', 'nin-v7', value)).toBe('new@example.invalid');
    expect(crypto.decryptContact('change-2', 'email', 'nin-v7', value)).toBeUndefined();
    expect(crypto.decryptContact('change-1', 'phone', 'nin-v7', value)).toBeUndefined();
    expect(crypto.decryptContact('change-1', 'email', 'nin-v6', value)).toBeUndefined();
    expect(crypto.decryptContact('change-1', 'email', 'nin-v7', null)).toBeUndefined();
  });

  it('binds the photo to the patient and its sha256, and answers 503 when it does not decrypt', () => {
    environment();
    const crypto = new PatientProfileCrypto();
    const bytes = randomBytes(100);
    const value = crypto.encryptPhoto('patient-1', 'a'.repeat(64), bytes);
    expect(value.length).toBe(129);
    expect(crypto.decryptPhoto('patient-1', 'a'.repeat(64), 'nin-v7', value)).toEqual(bytes);
    expect(() => crypto.decryptPhoto('patient-2', 'a'.repeat(64), 'nin-v7', value)).toThrow('temporarily unavailable');
    expect(() => crypto.decryptPhoto('patient-1', 'b'.repeat(64), 'nin-v7', value)).toThrow('temporarily unavailable');
  });

  it('reads back what sign-up encrypted, with the NIN key or the OTP-derived key its row names', () => {
    environment();
    const crypto = new PatientProfileCrypto();
    const service = PatientEnrollmentService.prototype as unknown as {
      encryptWith(key: Buffer, id: string, purpose: string, value: string): Buffer;
      derivedEncryptionKey(this: { otpKey: Buffer }): Buffer;
    };
    const withNin = service.encryptWith(Buffer.from(NIN_KEY, 'base64'), 'enrollment-1', 'phone', '+447700900123');
    expect(crypto.decryptEnrollment('enrollment-1', 'phone', 'nin-v7', withNin)).toBe('+447700900123');
    expect(crypto.decryptEnrollment('enrollment-1', 'contact', 'nin-v7', withNin)).toBeUndefined();
    const derivedKey = service.derivedEncryptionKey.call({ otpKey: Buffer.from(OTP_KEY, 'base64') });
    const withDerived = service.encryptWith(derivedKey, 'enrollment-2', 'profile', '{"hospitalCurrentlyUsing":"A"}');
    expect(crypto.decryptEnrollment('enrollment-2', 'profile', 'otp-hkdf:otp-v3', withDerived))
      .toBe('{"hospitalCurrentlyUsing":"A"}');
    expect(crypto.decryptEnrollment('enrollment-2', 'profile', 'otp-hkdf:otp-v2', withDerived)).toBeUndefined();
    expect(crypto.decryptEnrollment('enrollment-2', 'profile', 'fixture', withDerived)).toBeUndefined();
  });

  it('keys the code verifier to the change, and refuses to work without the keys', () => {
    environment();
    const crypto = new PatientProfileCrypto();
    expect(crypto.codeVerifier('change-1', '123456')).toMatch(/^[0-9a-f]{64}$/);
    expect(crypto.codeVerifier('change-1', '123456')).not.toBe(crypto.codeVerifier('change-2', '123456'));
    expect(crypto.passwordFailureBucket('account-1')).not.toBe(crypto.codeVerifier('account-1', ''));
    environment({ NIN_ENCRYPTION_KEY_B64: undefined });
    const unconfigured = new PatientProfileCrypto();
    expect(() => unconfigured.assertConfigured()).toThrow('temporarily unavailable');
    expect(unconfigured.decryptContact('change-1', 'email', 'nin-v7', Buffer.alloc(40, 1))).toBeUndefined();
  });
});
