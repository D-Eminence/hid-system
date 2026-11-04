import { createHmac } from 'node:crypto';
import { resetEnvironmentForTests } from '../config/environment';
import { cardLinksEnabled } from './card-links.flag';
import { CardLinksProtector, cardRecipientHint, isLinkToken, networkPrefix, normalizeCardEmail } from './card-links.protector';

describe('Card links (0118): protector and flag', () => {
  const original = { ...process.env };
  const otpKey = Buffer.alloc(32, 5);
  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://app.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      NIN_ENCRYPTION_KEY_B64: Buffer.alloc(32, 3).toString('base64'), NIN_KEY_VERSION: 'test-v1',
      OTP_HMAC_KEY_B64: otpKey.toString('base64') });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('is on unless CARD_LINKS_ENABLED is exactly false, read without the rest of the configuration', () => {
    delete process.env.DATABASE_URL;
    for (const value of [undefined, 'true', 'TRUE', '1', 'yes', '']) {
      if (value === undefined) delete process.env.CARD_LINKS_ENABLED; else process.env.CARD_LINKS_ENABLED = value;
      expect(cardLinksEnabled()).toBe(true);
    }
    process.env.CARD_LINKS_ENABLED = 'false';
    expect(cardLinksEnabled()).toBe(false);
  });

  it('round-trips the address and private label, bound to the link id', () => {
    const protector = new CardLinksProtector();
    const sealed = protector.encrypt('5e100000-0000-4000-8000-000000000001', { email: 'kemi@example.com', label: 'Dr Kemi' });
    expect(sealed.toString('utf8')).not.toContain('kemi');
    expect(protector.decrypt('5e100000-0000-4000-8000-000000000001', 'test-v1', sealed))
      .toEqual({ email: 'kemi@example.com', label: 'Dr Kemi' });
    expect(() => protector.decrypt('5e100000-0000-4000-8000-000000000002', 'test-v1', sealed)).toThrow();
    expect(() => protector.decrypt('5e100000-0000-4000-8000-000000000001', 'old-v0', sealed)).toThrow();
    expect(protector.decrypt('5e100000-0000-4000-8000-000000000001', 'test-v1',
      protector.encrypt('5e100000-0000-4000-8000-000000000001', { email: 'kemi@example.com', label: null })).label).toBeNull();
  });

  it('keys the address, the link, the code, the network and the stop link under distinct labels', () => {
    const protector = new CardLinksProtector();
    const hmac = (...parts: string[]) => createHmac('sha256', otpKey).update(parts.join('\0')).digest('hex');
    expect(protector.recipientHmac('kemi@example.com')).toBe(hmac('card-share', 'address', 'kemi@example.com'));
    const token = protector.newLinkToken();
    expect(isLinkToken(token)).toBe(true);
    expect(protector.tokenHmac(token)).toBe(hmac('card-share', 'link', token));
    expect(protector.codeVerifier('ab'.repeat(32), '482913')).toBe(hmac('card-share', 'code', 'ab'.repeat(32), '482913'));
    expect(protector.networkHmac('102.89.34.17')).toBe(hmac('card-share', 'network', '102.89.34.0/24'));
    expect(protector.networkHmac(undefined)).toBeNull();
    const stop = protector.stopToken('5e100000-0000-4000-8000-000000000001');
    expect(stop).toMatch(/^5e100000-0000-4000-8000-000000000001\.[A-Za-z0-9_-]{43}$/);
    expect(protector.stopShareId(stop)).toBe('5e100000-0000-4000-8000-000000000001');
    expect(protector.stopShareId(`5e100000-0000-4000-8000-000000000002.${stop.split('.')[1]}`)).toBeNull();
    expect(new Set([protector.recipientHmac('x'), protector.tokenHmac('x')]).size).toBe(2);
    expect(protector.newCode()).toMatch(/^[0-9]{6}$/);
    expect(new Set(Array.from({ length: 20 }, () => protector.newLinkToken())).size).toBe(20);
  });

  it('masks the address: the first character and a common provider; other domains masked too', () => {
    expect(cardRecipientHint('kemi.doctor@gmail.com')).toBe('k•••@gmail.com');
    expect(cardRecipientHint('ada@yahoo.com')).toBe('a•••@yahoo.com');
    expect(cardRecipientHint('ada@lagosgeneral.org.ng')).toBe('a•••@l•••.ng');
    expect(cardRecipientHint('b@clinic.example')).toBe('b•••@c•••.example');
  });

  it('normalises an address and refuses what is not one', () => {
    expect(normalizeCardEmail(' Kemi@Example.COM ')).toBe('kemi@example.com');
    for (const value of ['', 'kemi', 'kemi@', '@example.com', 'a b@example.com', `${'a'.repeat(250)}@example.com`]) {
      expect(normalizeCardEmail(value)).toBeNull();
    }
  });

  it('keys the network by /24 for IPv4 and /48 for IPv6', () => {
    expect(networkPrefix('102.89.34.17')).toBe('102.89.34.0/24');
    expect(networkPrefix('::ffff:102.89.34.17')).toBe('102.89.34.0/24');
    expect(networkPrefix('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(networkPrefix('not-an-ip')).toBeNull();
  });
});
