import * as argon2 from 'argon2';
jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn().mockResolvedValue('$argon2id$dummy-hash'),
  verify: jest.fn(),
}));
jest.mock('bcryptjs', () => ({ __esModule: true, default: { compare: jest.fn(), hash: jest.fn().mockResolvedValue('$2a$10$dummy') } }));
import { createHmac } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { LocalAuthProvider } from './local-auth.provider';

// SX-6 (0205): what the password change asks of LocalAuthProvider: the lock read that counts no try, the stored-hash
// check with both verifications every time, and the lockout key a success clears.

const PEPPER = 'abcdefghijklmnopqrstuvwxyz123456';

describe('LocalAuthProvider for the own password change (SX-6)', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: PEPPER });
    resetEnvironmentForTests();
    (argon2.verify as jest.Mock).mockReset().mockResolvedValue(false);
    (bcrypt.compare as unknown as jest.Mock).mockReset().mockResolvedValue(false);
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  const provider = (locked: boolean | undefined) => {
    const query = jest.fn(async (_sql: string, _values: unknown[]) => ({ rows: locked === undefined ? [] : [{ locked }] }));
    return { query, provider: new LocalAuthProvider({ query } as unknown as DatabaseService) };
  };
  const hmac = (value: string) => createHmac('sha256', PEPPER).update(value, 'utf8').digest('hex');

  it('isLockedOut reads the lock of the staff email key (lower case, trimmed) and counts nothing', async () => {
    const locked = provider(true);
    await expect(locked.provider.isLockedOut(' Ada@Example.test ', 'staff')).resolves.toBe(true);
    expect(locked.query).toHaveBeenCalledTimes(1);
    expect(locked.query.mock.calls[0]![0]).toMatch(/^select locked_until is not null/);
    expect(locked.query.mock.calls[0]![0]).not.toMatch(/insert|update|delete/i);
    expect(locked.query.mock.calls[0]![1]).toEqual([hmac('ada@example.test'), 1]);
    await expect(provider(false).provider.isLockedOut('ada@example.test')).resolves.toBe(false);
    await expect(provider(undefined).provider.isLockedOut('ada@example.test')).resolves.toBe(false);
  });

  it('lockoutKey is the same key recordLoginFailure counts on', () => {
    expect(provider(false).provider.lockoutKey('Ada@Example.test')).toEqual({ principalHmac: hmac('ada@example.test'),
      pepperVersion: 1 });
  });

  it('verifyStoredPassword: argon2id verified by argon2, bcrypt run on a dummy too', async () => {
    const { provider: local } = provider(false);
    (argon2.verify as jest.Mock).mockResolvedValue(true);
    await expect(local.verifyStoredPassword('fictional pass', '$argon2id$stored', 'argon2id')).resolves.toBe(true);
    expect(argon2.verify).toHaveBeenCalledWith('$argon2id$stored', 'fictional pass');
    expect(bcrypt.compare).toHaveBeenCalledTimes(1);
  });

  it('verifyStoredPassword: a legacy bcrypt hash verified by bcrypt, argon2 run on a dummy too', async () => {
    const { provider: local } = provider(false);
    (bcrypt.compare as unknown as jest.Mock).mockResolvedValue(true);
    (argon2.verify as jest.Mock).mockResolvedValue(true);
    await expect(local.verifyStoredPassword('fictional pass', '$2a$10$stored', 'bcrypt_legacy')).resolves.toBe(true);
    expect(bcrypt.compare).toHaveBeenCalledWith('fictional pass', '$2a$10$stored');
    expect(argon2.verify).toHaveBeenCalledTimes(1);
    expect((argon2.verify as jest.Mock).mock.calls[0]![0]).not.toBe('$2a$10$stored');
  });

  it('verifyStoredPassword: no hash, or an unknown algorithm, is never right (both verifications still run)', async () => {
    const { provider: local } = provider(false);
    (argon2.verify as jest.Mock).mockResolvedValue(true);
    (bcrypt.compare as unknown as jest.Mock).mockResolvedValue(true);
    await expect(local.verifyStoredPassword('fictional pass', null, null)).resolves.toBe(false);
    await expect(local.verifyStoredPassword('fictional pass', '$md5$x', 'md5')).resolves.toBe(false);
    expect(argon2.verify).toHaveBeenCalledTimes(2);
    expect(bcrypt.compare).toHaveBeenCalledTimes(2);
  });
});
