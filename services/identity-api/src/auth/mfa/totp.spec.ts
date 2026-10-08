import {
  base32Decode, base32Encode, generateRecoveryCode, hotp, matchTotp, normalizeRecoveryCode, otpauthUri, totp,
  TOTP_PERIOD_SECONDS,
} from './totp';

// RFC 6238 Appendix B (SHA-1 seed "12345678901234567890").
const rfcSecret = Buffer.from('12345678901234567890', 'ascii');
const rfcVectors: [number, string][] = [
  [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
  [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
];

describe('RFC 6238 TOTP', () => {
  it.each(rfcVectors)('matches the RFC 6238 SHA-1 vector at T=%i', (seconds, expected) => {
    const step = Math.floor(seconds / TOTP_PERIOD_SECONDS);
    expect(hotp(rfcSecret, step, 8)).toBe(expected);
    // Six-digit codes are the same truncation modulo 10^6.
    expect(totp(rfcSecret, seconds * 1000)).toBe(expected.slice(-6));
  });

  it('matches the RFC 4226 HOTP vectors', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((counter) => hotp(rfcSecret, counter))).toEqual([
      '755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']);
  });

  it('accepts the current step and one step of drift either side, and nothing else', () => {
    const now = 1_111_111_111_000;
    const step = Math.floor(now / 30_000);
    for (const offset of [-1, 0, 1]) {
      expect(matchTotp(rfcSecret, hotp(rfcSecret, step + offset), now)).toBe(step + offset);
    }
    for (const offset of [-3, -2, 2, 3]) {
      expect(matchTotp(rfcSecret, hotp(rfcSecret, step + offset), now)).toBeNull();
    }
  });

  it.each(['', '12345', '1234567', 'abcdef', ' 123456', '12345a'])('refuses the malformed code %j', (code) => {
    expect(matchTotp(rfcSecret, code, 1_111_111_111_000)).toBeNull();
  });

  it('encodes base32 per RFC 4648 and round-trips a 160-bit secret', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI======').toString()).toBe('foobar');
    const secret = Buffer.from('3132333435363738393031323334353637383930', 'hex');
    expect(base32Encode(secret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(base32Encode(secret))).toEqual(secret);
    expect(() => base32Decode('NOT-BASE32!')).toThrow('Invalid base32 value');
  });

  it('builds a standard otpauth provisioning URI', () => {
    const uri = new URL(otpauthUri('HID Platform Admin', 'admin@example.invalid', 'GEZDGNBVGY3TQOJQ'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/HID Platform Admin:admin@example.invalid');
    expect(Object.fromEntries(uri.searchParams)).toEqual({ secret: 'GEZDGNBVGY3TQOJQ', issuer: 'HID Platform Admin',
      algorithm: 'SHA1', digits: '6', period: '30' });
  });
});

describe('recovery codes', () => {
  it('generates XXXXX-XXXXX codes from an unambiguous alphabet', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(generateRecoveryCode()).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/);
    }
    expect(generateRecoveryCode(() => 0)).toBe('00000-00000');
  });

  it('normalizes case, separators and look-alike characters', () => {
    expect(normalizeRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode(' O1ILO 23456 ')).toBe('0111023456');
    expect(normalizeRecoveryCode('ABCDE-FGHJ')).toBeNull();
    expect(normalizeRecoveryCode('ABCDE-FGHJU')).toBeNull();
  });
});
