import * as argon2 from 'argon2';
jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn().mockResolvedValue('$argon2id$dummy-hash'),
  verify: jest.fn(),
}));
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

function fixture(accountRow: typeof account | null = account) {
  const accountQuery = jest.fn().mockResolvedValue({ rows: accountRow ? [accountRow] : [] });
  const client = { query: accountQuery } as unknown as PoolClient;
  const query = jest.fn(async (sql: string) => sql.includes('auth.login_attempts')
    ? { rows: [] } : { rows: accountRow ? [accountRow] : [] });
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
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
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
    expect(f.query).toHaveBeenCalledTimes(1);
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
});
