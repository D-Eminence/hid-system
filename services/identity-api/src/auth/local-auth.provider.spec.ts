import * as argon2 from 'argon2';
jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn().mockResolvedValue('$argon2id$dummy-hash'),
  verify: jest.fn(),
}));
import { createHmac } from 'node:crypto';
import type { PoolClient } from 'pg';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { LocalAuthProvider } from './local-auth.provider';

const originalEnvironment = { ...process.env };
const hid = 'HID-ABCDEFGH';
const account = {
  id: '10000000-0000-4000-8000-000000000001',
  subject: 'patient-subject', email: null, display_name: 'Amina Okafor',
  password_hash: '$argon2id$account-hash', password_algorithm: 'argon2id', row_version: '1',
};

const PEPPER = 'abcdefghijklmnopqrstuvwxyz123456';
/** The account's own failure bucket (SIGNIN-LOCKOUT, 0086): its own HMAC label under the login pepper. */
const accountBucket = createHmac('sha256', PEPPER).update(`login-account\u001f${account.id}`, 'utf8').digest('hex');
const identifierBucket = (value: string) => createHmac('sha256', PEPPER).update(value.trim().toLowerCase(), 'utf8').digest('hex');

/**
 * `attempts` maps a login_attempts bucket to its row: present and locked, or
 * present and not locked. Absent buckets have no row.
 */
function fixture(accountRow: typeof account | null = account, attempts: Record<string, { locked: boolean }> = {}) {
  const accountQuery = jest.fn().mockResolvedValue({ rows: accountRow ? [accountRow] : [] });
  const client = { query: accountQuery } as unknown as PoolClient;
  const query = jest.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (!sql.includes('auth.login_attempts')) return { rows: accountRow ? [accountRow] : [] };
    if (/^\s*select/.test(sql)) {
      const row = attempts[String(values[0])];
      return { rows: row ? [{ locked: row.locked }] : [] };
    }
    return { rows: [] };
  });
  const withSystemTransaction = jest.fn(async (_correlationId: string,
    work: (client: PoolClient) => Promise<unknown>) => work(client));
  const database = { query, withSystemTransaction } as unknown as DatabaseService;
  return { provider: new LocalAuthProvider(database), query, accountQuery, withSystemTransaction };
}

describe('LocalAuthProvider HID sign-in', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: PEPPER,
    });
    resetEnvironmentForTests();
    (argon2.verify as jest.Mock).mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  it('signs in a phone-only patient by HID under a system transaction', async () => {
    const f = fixture();
    const identity = await f.provider.authenticate(hid, 'correct-password', 'patient', 'login-correlation');

    expect(identity).toEqual({ subject: account.subject, accountId: account.id,
      displayName: account.display_name, facilities: [], authenticationMethod: 'local' });
    expect(identity).not.toHaveProperty('email');
    expect(f.withSystemTransaction).toHaveBeenCalledTimes(1);
    expect(f.withSystemTransaction.mock.calls[0]?.[0]).toBe('login-correlation');
    expect(f.accountQuery).toHaveBeenCalledWith(expect.stringContaining('identity.patients patient'), [hid]);
    expect(f.accountQuery.mock.calls[0]?.[0]).toContain("patient.status='active'");
    // The identifier's lock, then the account's (no row: nothing to clear).
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls.map(([, values]) => values?.[0])).toEqual([identifierBucket(hid), accountBucket]);
    expect(argon2.verify).toHaveBeenCalledWith(account.password_hash, 'correct-password');
  });

  it('keeps staff lookup email-only even if a HID is passed directly', async () => {
    const f = fixture(null);
    await expect(f.provider.authenticate(hid, 'wrong-password', 'staff', 'login-correlation'))
      .rejects.toMatchObject({ status: 401 });
    expect(f.withSystemTransaction).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls[1]?.[0]).toContain('lower(account.email) = lower($1)');
    expect(f.query.mock.calls[1]?.[0]).not.toContain('identity.patients');
  });

  it('does not take the privileged HID path for an invalid HID value', async () => {
    const f = fixture(null);
    await expect(f.provider.authenticate('HID-IO01', 'wrong-password', 'patient', 'login-correlation'))
      .rejects.toMatchObject({ status: 401 });
    expect(f.withSystemTransaction).not.toHaveBeenCalled();
    expect(f.query.mock.calls[1]?.[0]).toContain('lower(account.email) = lower($1)');
  });

  it('rejects an account with an incorrect password without returning identity', async () => {
    const f = fixture();
    (argon2.verify as jest.Mock).mockResolvedValue(false);
    await expect(f.provider.authenticate(hid, 'wrong-password', 'patient', 'login-correlation'))
      .rejects.toMatchObject({ status: 401 });
    expect(f.withSystemTransaction).toHaveBeenCalledTimes(1);
    expect(argon2.verify).toHaveBeenCalledWith(account.password_hash, 'wrong-password');
  });

  it('does not authenticate a HID account without a local password credential', async () => {
    const f = fixture({ ...account, password_hash: null, password_algorithm: null } as unknown as typeof account);
    await expect(f.provider.authenticate(hid, 'any-password', 'patient', 'login-correlation'))
      .rejects.toMatchObject({ status: 401 });
    expect(f.withSystemTransaction).toHaveBeenCalledTimes(1);
  });

  describe('one failure budget per resolved account (SIGNIN-LOCKOUT)', () => {
    const recorded = (f: ReturnType<typeof fixture>) => f.query.mock.calls
      .filter(([sql]) => String(sql).includes('insert into auth.login_attempts')).map(([, values]) => values?.[0]);

    it('counts a wrong password against the account as well as the identifier the controller records', async () => {
      const f = fixture();
      (argon2.verify as jest.Mock).mockResolvedValue(false);
      await expect(f.provider.authenticate(hid, 'wrong-password', 'patient', 'login-correlation'))
        .rejects.toMatchObject({ status: 401 });
      expect(recorded(f)).toEqual([accountBucket]);
    });

    it('refuses the correct password with the generic 401 while the account is locked, by any identifier', async () => {
      for (const principal of [hid, 'amina@example.test']) {
        const f = fixture({ ...account, email: 'amina@example.test' } as unknown as typeof account,
          { [accountBucket]: { locked: true } });
        const failure = await f.provider.authenticate(principal, 'correct-password', 'patient', 'login-correlation')
          .then(() => null, (error: unknown) => error);
        expect(failure).toMatchObject({ status: 401, message: 'Invalid credentials' });
        expect(argon2.verify).toHaveBeenCalled();
        expect(recorded(f)).toEqual([accountBucket]);
      }
    });

    it('refuses before any account work when the identifier itself is locked, as before', async () => {
      const f = fixture(account, { [identifierBucket(hid)]: { locked: true } });
      await expect(f.provider.authenticate(hid, 'correct-password', 'patient', 'login-correlation'))
        .rejects.toMatchObject({ status: 401 });
      expect(f.withSystemTransaction).not.toHaveBeenCalled();
      expect(recorded(f)).toEqual([]);
    });

    it('clears the account window after a correct password while it is not locked', async () => {
      const f = fixture(account, { [accountBucket]: { locked: false } });
      await f.provider.authenticate(hid, 'correct-password', 'patient', 'login-correlation');
      const cleared = f.query.mock.calls.filter(([sql]) => String(sql).startsWith('delete from auth.login_attempts'));
      expect(cleared.map(([, values]) => values?.[0])).toEqual([accountBucket]);
      expect(recorded(f)).toEqual([]);
    });

    it('records nothing for an unknown account, which has no account bucket', async () => {
      const f = fixture(null);
      await expect(f.provider.authenticate('nobody@example.test', 'wrong-password', 'patient', 'login-correlation'))
        .rejects.toMatchObject({ status: 401 });
      expect(recorded(f)).toEqual([]);
    });

    it('fails closed with 503 when the account failure cannot be recorded', async () => {
      const f = fixture();
      (argon2.verify as jest.Mock).mockResolvedValue(false);
      f.query.mockImplementation(async (sql: string) => {
        if (sql.includes('insert into auth.login_attempts')) throw new Error('synthetic write failure');
        return { rows: [] };
      });
      await expect(f.provider.authenticate(hid, 'wrong-password', 'patient', 'login-correlation'))
        .rejects.toMatchObject({ status: 503 });
    });
  });
});
