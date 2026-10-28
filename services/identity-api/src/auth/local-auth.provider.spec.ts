import * as argon2 from 'argon2';
jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn().mockResolvedValue('$argon2id$dummy-hash'),
  verify: jest.fn(),
}));
import { UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { resetEnvironmentForTests } from '../config/environment';
import { AccountSuspendedProblem } from './account-suspended';
import type { DatabaseService } from '../database/database.service';
import { LocalAuthProvider } from './local-auth.provider';

const originalEnvironment = { ...process.env };
const hid = 'HID-ABCDEFGH';
const account = {
  id: '10000000-0000-4000-8000-000000000001',
  subject: 'patient-subject', email: null, display_name: 'Amina Okafor',
  password_hash: '$argon2id$account-hash', password_algorithm: 'argon2id', row_version: '1',
  status: 'active', disabled_now: false, workforce: false,
};

function fixture(accountRow: typeof account | null = account, locked = false) {
  const accountQuery = jest.fn().mockResolvedValue({ rows: accountRow ? [accountRow] : [] });
  const client = { query: accountQuery } as unknown as PoolClient;
  const query = jest.fn(async (sql: string) => sql.includes('auth.login_attempts')
    ? { rows: locked ? [{ locked: true }] : [] } : { rows: accountRow ? [accountRow] : [] });
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

describe('LocalAuthProvider suspended patient accounts (owner decision of 2026-10-28)', () => {
  const email = 'amina@example.test';
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

  const suspended = [
    ['status disabled', { status: 'disabled', disabled_now: false }],
    ['status locked', { status: 'locked', disabled_now: false }],
    ['disabled_until in the future', { status: 'active', disabled_now: true }],
  ] as const;

  it.each(suspended)('the right password for a patient account with %s is 403 ACCOUNT_SUSPENDED', async (_label, state) => {
    for (const principal of [email, hid]) {
      const f = fixture({ ...account, ...state });
      const refusal = await f.provider.authenticate(principal, 'correct-password', 'patient', 'login-correlation')
        .then(() => undefined, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(AccountSuspendedProblem);
      expect(refusal).toMatchObject({ status: 403, code: 'ACCOUNT_SUSPENDED', accountSubject: account.subject,
        message: 'This account is suspended. Contact support@healthidentitydirectory.com.' });
      expect(argon2.verify).toHaveBeenCalledWith(account.password_hash, 'correct-password');
    }
  });

  it.each(suspended)('a wrong password for a patient account with %s is still 401 "Invalid credentials"', async (_label, state) => {
    (argon2.verify as jest.Mock).mockResolvedValue(false);
    const f = fixture({ ...account, ...state });
    const refusal = await f.provider.authenticate(email, 'wrong-password', 'patient', 'login-correlation')
      .then(() => undefined, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(UnauthorizedException);
    expect(refusal).toMatchObject({ status: 401, message: 'Invalid credentials' });
  });

  it('a suspended legacy bcrypt account is refused before any hash upgrade', async () => {
    const legacy = { ...account, status: 'disabled', password_algorithm: 'bcrypt_legacy',
      password_hash: '$2a$10$abcdefghijklmnopqrstuuXtu8cvh2v4nUSPSWJ3yJXzFzEaOeQ8m' };
    const compare = jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);
    const f = fixture(legacy);
    await expect(f.provider.authenticate(email, 'correct-password', 'patient', 'login-correlation'))
      .rejects.toBeInstanceOf(AccountSuspendedProblem);
    // Only the provider's dummy hash (random bytes) was ever hashed: never the password.
    expect(argon2.hash).not.toHaveBeenCalledWith('correct-password', expect.anything());
    compare.mockRestore();
  });

  it('finds a suspended patient account (not deleted) and verifies the password either way, as long as the lockout allows', async () => {
    const f = fixture({ ...account, status: 'disabled' });
    await f.provider.authenticate(email, 'correct-password', 'patient', 'login-correlation').catch(() => undefined);
    const sql = String(f.query.mock.calls[1]?.[0]);
    expect(sql).toContain("account.status <> 'deleted'");
    expect(sql).not.toContain("account.status = 'active'");
    expect(sql).toContain('disabled_until > clock_timestamp()');
  });

  it('a locked-out principal gets "Invalid credentials" before any lookup, suspended or not', async () => {
    const f = fixture({ ...account, status: 'disabled' }, true);
    const refusal = await f.provider.authenticate(email, 'correct-password', 'patient', 'login-correlation')
      .then(() => undefined, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(UnauthorizedException);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(argon2.verify).not.toHaveBeenCalled();
  });

  it('a pending-reset patient account with the right password is "Invalid credentials", not suspended', async () => {
    const f = fixture({ ...account, status: 'pending_reset' });
    const refusal = await f.provider.authenticate(email, 'correct-password', 'patient', 'login-correlation')
      .then(() => undefined, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(UnauthorizedException);
    expect(refusal).not.toBeInstanceOf(AccountSuspendedProblem);
  });

  it.each(suspended)('the right password for a staff or admin account with %s on the patient route is still 401, not 403', async (_label, state) => {
    // A disabled clinician or platform administrator found by email (or a
    // workforce account that also holds a Health ID): the patient route must
    // not confirm the password of a workforce account.
    for (const principal of [email, hid]) {
      const f = fixture({ ...account, ...state, workforce: true });
      const refusal = await f.provider.authenticate(principal, 'correct-password', 'patient', 'login-correlation')
        .then(() => undefined, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(UnauthorizedException);
      expect(refusal).not.toBeInstanceOf(AccountSuspendedProblem);
      expect(refusal).toMatchObject({ status: 401, message: 'Invalid credentials' });
    }
  });

  it('a suspended account whose workforce flag is missing stays 401 (fails closed)', async () => {
    const { workforce: _omitted, ...withoutFlag } = { ...account, status: 'disabled' };
    const f = fixture(withoutFlag as unknown as typeof account);
    const refusal = await f.provider.authenticate(email, 'correct-password', 'patient', 'login-correlation')
      .then(() => undefined, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(UnauthorizedException);
    expect(refusal).not.toBeInstanceOf(AccountSuspendedProblem);
  });

  it('the patient lookup marks any account with a role, a staff record or a facility membership as workforce', async () => {
    for (const principal of [email, hid]) {
      const f = fixture({ ...account, status: 'disabled' });
      await f.provider.authenticate(principal, 'correct-password', 'patient', 'login-correlation').catch(() => undefined);
      const sql = String(principal === hid ? f.accountQuery.mock.calls[0]?.[0] : f.query.mock.calls[1]?.[0]);
      // Revoked roles and inactive staff records count too: a departed
      // clinician or administrator is exactly the case to protect.
      expect(sql).toContain('auth.account_roles role_assignment where role_assignment.account_id = account.id');
      expect(sql).toContain('identity.staff staff_record where staff_record.account_id = account.id');
      expect(sql).toContain('identity.staff_facility_memberships staff_membership where staff_membership.account_id = account.id');
      expect(sql).toContain('as workforce');
      expect(sql).not.toContain('revoked_at is null');
    }
  });

  it('staff sign-in is unchanged: it looks up active, unsuspended accounts only and never says suspended', async () => {
    const f = fixture(null);
    await expect(f.provider.authenticate('doctor@example.test', 'correct-password', 'staff', 'login-correlation'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    const sql = String(f.query.mock.calls[1]?.[0]);
    expect(sql).toContain("account.status = 'active'");
    expect(sql).toContain('account.disabled_until is null or account.disabled_until <= clock_timestamp()');
    expect(sql).not.toContain('as workforce');
    // Even a row that somehow came back suspended stays the uniform refusal.
    const g = fixture({ ...account, status: 'disabled' });
    const refusal = await g.provider.authenticate('doctor@example.test', 'correct-password', 'staff', 'login-correlation')
      .then(() => undefined, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(UnauthorizedException);
    expect(refusal).toMatchObject({ message: 'Invalid credentials' });
  });
});
