import { createHmac } from 'node:crypto';
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
    // Through 0093's lookup, which also finds patients migrated from hid-1.0
    // (identity.patients' RLS hid them from the old direct query).
    expect(f.accountQuery).toHaveBeenCalledWith(expect.stringContaining('from auth.find_patient_account($1, $2) found'),
      ['hid', hid]);
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

  it('answers an invalid Health ID like an unknown email, reading no account and verifying the dummy hash', async () => {
    const f = fixture(null);
    await expect(f.provider.authenticate('HID-IO01', 'wrong-password', 'patient', 'login-correlation'))
      .rejects.toMatchObject({ status: 401 });
    expect(f.withSystemTransaction).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(argon2.verify).toHaveBeenCalledTimes(1);
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
    const f = fixture({ ...account, status: 'disabled' });
    await f.provider.authenticate(email, 'correct-password', 'patient', 'login-correlation').catch(() => undefined);
    const sql = String(f.query.mock.calls[1]?.[0]);
    // Revoked roles and inactive staff records count too: a departed
    // clinician or administrator is exactly the case to protect.
    expect(sql).toContain('auth.account_roles role_assignment where role_assignment.account_id = account.id');
    expect(sql).toContain('identity.staff staff_record where staff_record.account_id = account.id');
    expect(sql).toContain('identity.staff_facility_memberships staff_membership where staff_membership.account_id = account.id');
    expect(sql).toContain('as workforce');
    expect(sql).not.toContain('revoked_at is null');
    // By Health ID or phone, 0093's lookup computes the same flag (its suite
    // checks the SQL); the provider reads it from there.
    const g = fixture({ ...account, status: 'disabled' });
    await g.provider.authenticate(hid, 'correct-password', 'patient', 'login-correlation').catch(() => undefined);
    expect(String(g.accountQuery.mock.calls[0]?.[0])).toContain('found.workforce');
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

describe('LocalAuthProvider phone sign-in and migrated patients (0093; owner decisions of 2026-10-28)', () => {
  const contactKey = Buffer.alloc(32, 9);
  const phoneHmac = (phone: string) => createHmac('sha256', contactKey)
    .update(['hid-contact-lookup:v1', 'phone', phone].join('\u001f'), 'utf8').digest('hex');
  /** A Nigerian number's lookup: its +234... and +2340... forms, comma separated. */
  const nigerianLookup = (canonical: string) => `${phoneHmac(canonical)},${phoneHmac(`+2340${canonical.slice(4)}`)}`;
  const lockoutHmac = (principal: string) => createHmac('sha256', 'abcdefghijklmnopqrstuvwxyz123456')
    .update(principal, 'utf8').digest('hex');

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      CONTACT_LOOKUP_HMAC_KEY_B64: contactKey.toString('base64'),
    });
    resetEnvironmentForTests();
    (argon2.verify as jest.Mock).mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  it.each(['08031234567', '0803 123 4567', '+2348031234567', '+234 (803) 123-4567', '+2340803-123-4567'])(
    'signs in by the phone %s through the lookup, under one lockout', async (typed) => {
      const f = fixture();
      const identity = await f.provider.authenticate(typed, 'correct-password', 'patient', 'login-correlation');
      expect(identity).toMatchObject({ subject: account.subject, accountId: account.id });
      expect(f.withSystemTransaction).toHaveBeenCalledTimes(1);
      expect(f.accountQuery).toHaveBeenCalledWith(expect.stringContaining('auth.find_patient_account'),
        ['phone', nigerianLookup('+2348031234567')]);
      // The lockout is keyed by the E.164 number, however it was typed.
      expect((f.query.mock.calls[0] as unknown[] | undefined)?.[1]).toEqual([lockoutHmac('+2348031234567'), 1]);
      expect(f.provider.principalHash('+2348031234567')).toBe(lockoutHmac('+2348031234567'));
    });

  it('signs in by an international number', async () => {
    const f = fixture();
    await f.provider.authenticate('+44 7700 900123', 'correct-password', 'patient', 'login-correlation');
    expect(f.accountQuery).toHaveBeenCalledWith(expect.any(String), ['phone', phoneHmac('+447700900123')]);
  });

  it('finds a migrated hid-1.0 patient stored with the trunk 0 (+2340...) however the number is typed', async () => {
    // hid-1.0 kept "+234 0803 000 9920" as +23408030009920, and the importer
    // kept that form: the lookup carries its HMAC next to +2348030009920's,
    // in one call, and the lockout stays keyed by +2348030009920.
    for (const typed of ['08030009920', '+2348030009920', '+23408030009920', '+234 0803 000 9920']) {
      const f = fixture();
      f.accountQuery.mockImplementation(async (_sql: string, values: string[]) => ({
        rows: values[1]?.split(',').includes(phoneHmac('+23408030009920')) ? [account] : [] }));
      await expect(f.provider.authenticate(typed, 'correct-password', 'patient', 'login-correlation'))
        .resolves.toMatchObject({ subject: account.subject, accountId: account.id });
      expect(f.accountQuery).toHaveBeenCalledTimes(1);
      expect(f.accountQuery).toHaveBeenCalledWith(expect.any(String), ['phone', nigerianLookup('+2348030009920')]);
      expect((f.query.mock.calls[0] as unknown[] | undefined)?.[1]).toEqual([lockoutHmac('+2348030009920'), 1]);
    }
  });

  it('answers an unknown phone (none or several accounts) like a wrong email: the dummy hashes, then 401', async () => {
    const f = fixture(null);
    const compare = jest.spyOn(bcrypt, 'compare');
    try {
      await expect(f.provider.authenticate('08039999999', 'any-password', 'patient', 'login-correlation'))
        .rejects.toMatchObject({ status: 401, message: 'Invalid credentials' });
      expect(argon2.verify).toHaveBeenCalledWith('$argon2id$dummy-hash', 'any-password');
      expect(compare).toHaveBeenCalledTimes(1);
      expect(compare.mock.calls[0]?.[1]).toMatch(/^\$2[aby]\$10\$/);
    } finally {
      compare.mockRestore();
    }
  });

  it('answers a phone that is not one like a wrong email, reading no account', async () => {
    const f = fixture();
    await expect(f.provider.authenticate('+12 34', 'any-password', 'patient', 'login-correlation'))
      .rejects.toMatchObject({ status: 401, message: 'Invalid credentials' });
    expect(f.withSystemTransaction).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(argon2.verify).toHaveBeenCalledWith('$argon2id$dummy-hash', 'any-password');
  });

  it('never looks a phone up for staff sign-in', async () => {
    const f = fixture(null);
    await expect(f.provider.authenticate('08031234567', 'any-password', 'staff', 'login-correlation'))
      .rejects.toMatchObject({ status: 401 });
    expect(f.withSystemTransaction).not.toHaveBeenCalled();
    expect(String(f.query.mock.calls[1]?.[0])).toContain('lower(account.email) = lower($1)');
  });

  it('tells a migrated patient whose suspension came from hid-1.0 (disabled_until) so, by Health ID and by phone', async () => {
    for (const principal of ['HID-MGRA23', '08031234567']) {
      const f = fixture({ ...account, disabled_now: true, workforce: false });
      await expect(f.provider.authenticate(principal, 'correct-password', 'patient', 'login-correlation'))
        .rejects.toBeInstanceOf(AccountSuspendedProblem);
      const wrong = fixture({ ...account, disabled_now: true, workforce: false });
      (argon2.verify as jest.Mock).mockResolvedValueOnce(false).mockResolvedValueOnce(false);
      await expect(wrong.provider.authenticate(principal, 'wrong-password', 'patient', 'login-correlation'))
        .rejects.toMatchObject({ status: 401, message: 'Invalid credentials' });
      const worker = fixture({ ...account, status: 'disabled', workforce: true });
      await expect(worker.provider.authenticate(principal, 'correct-password', 'patient', 'login-correlation'))
        .rejects.toMatchObject({ status: 401, message: 'Invalid credentials' });
    }
  });

  it('fails a phone sign-in closed (503) when the contact lookup key is not configured', async () => {
    delete process.env.CONTACT_LOOKUP_HMAC_KEY_B64;
    resetEnvironmentForTests();
    const f = fixture();
    await expect(f.provider.authenticate('08031234567', 'correct-password', 'patient', 'login-correlation'))
      .rejects.toMatchObject({ status: 503, code: 'CONTACT_LOOKUP_UNAVAILABLE' });
    expect(f.withSystemTransaction).not.toHaveBeenCalled();
  });
});

describe('LocalAuthProvider: every attempt costs one bcrypt and one argon2 verification', () => {
  // Measured: bcryptjs at cost 10 about 100 ms, argon2id (64 MiB, t=3) about
  // 220 ms. A sign-in that ran only one of them told, by timing, which
  // accounts still hold a hid-1.0 bcrypt hash, by email, Health ID or phone.
  const bcryptHash = '$2a$10$abcdefghijklmnopqrstuuXtu8cvh2v4nUSPSWJ3yJXzFzEaOeQ8m';
  const legacy = { ...account, password_algorithm: 'bcrypt_legacy', password_hash: bcryptHash };

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
    });
    resetEnvironmentForTests();
    (argon2.verify as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  it.each([
    ['an unknown principal, wrong password', null, false, false, 'Invalid credentials'],
    ['an argon2id account, wrong password', account, false, false, 'Invalid credentials'],
    ['a hid-1.0 bcrypt account, wrong password', legacy, false, false, 'Invalid credentials'],
    ['a disabled hid-1.0 bcrypt workforce account, right password', { ...legacy, status: 'disabled', workforce: true },
      true, false, 'Invalid credentials'],
    ['a disabled argon2id workforce account, right password', { ...account, status: 'disabled', workforce: true },
      false, true, 'Invalid credentials'],
  ] as const)('%s: one bcrypt, then one argon2 verification', async (_label, row, bcryptAnswer, argonAnswer, message) => {
    const order: string[] = [];
    const compare = jest.spyOn(bcrypt, 'compare').mockImplementation((async () => {
      order.push('bcrypt');
      return bcryptAnswer;
    }) as never);
    (argon2.verify as jest.Mock).mockImplementation(async () => {
      order.push('argon2');
      return argonAnswer;
    });
    const f = fixture(row as typeof account | null);
    for (const principal of ['amina@example.test', 'HID-MGRA23']) {
      order.length = 0;
      await expect(f.provider.authenticate(principal, 'some-password', 'patient', 'login-correlation'))
        .rejects.toMatchObject({ status: 401, message });
      expect(order).toEqual(['bcrypt', 'argon2']);
    }
    const legacyRow = row?.password_algorithm === 'bcrypt_legacy';
    expect(compare).toHaveBeenLastCalledWith('some-password', legacyRow ? bcryptHash : expect.stringMatching(/^\$2[aby]\$10\$/));
    expect(argon2.verify).toHaveBeenLastCalledWith(
      row && !legacyRow ? row.password_hash : '$argon2id$dummy-hash', 'some-password');
  });

  it('decides by the account\'s own algorithm: a right bcrypt password signs in and is upgraded, a dummy match never does', async () => {
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);
    (argon2.verify as jest.Mock).mockResolvedValue(false);
    const upgraded = await fixture(legacy).provider.authenticate('amina@example.test', 'right-password', 'patient', 'c');
    expect(upgraded).toMatchObject({ subject: account.subject, passwordUpgrade: { expectedRowVersion: 1 } });
    // An argon2id account whose (dummy) bcrypt check came back true is still refused.
    await expect(fixture(account).provider.authenticate('amina@example.test', 'wrong-password', 'patient', 'c'))
      .rejects.toMatchObject({ status: 401 });
    await expect(fixture(null).provider.authenticate('amina@example.test', 'wrong-password', 'patient', 'c'))
      .rejects.toMatchObject({ status: 401 });
  });
});
