import { createHmac } from 'node:crypto';
jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn().mockResolvedValue('$argon2id$test-password-hash'),
}));
import type { PoolClient } from 'pg';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { NotificationOtpClient } from './notification-otp.client';
import { generateSixDigitOtp, OtpService } from './otp.service';

describe('Identity OTP credentials', () => {
  const original = { ...process.env };
  const key = Buffer.alloc(32, 7);

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      OTP_HMAC_KEY_B64: key.toString('base64'),
    });
    resetEnvironmentForTests();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('generates exactly six numeric digits and preserves leading zeroes', () => {
    expect(generateSixDigitOtp(() => 0)).toBe('000000');
    expect(generateSixDigitOtp(() => 7)).toBe('000007');
    expect(generateSixDigitOtp(() => 999_999)).toBe('999999');
  });

  it('stores only verifier metadata and sends plaintext only to the direct delivery boundary', async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('from auth.otp_rate_limits')) return { rows: [] };
      if (sql.includes('from auth.accounts account')) return { rows: [{ id: 'account-1', email: 'person@example.test' }] };
      if (sql.includes('from auth.otp_challenges')) return { rows: [] };
      if (sql.includes('insert into auth.otp_challenges')) return { rows: [] };
      return { rows: [] };
    }) } as unknown as PoolClient;
    const database = {
      withSystemTransaction: jest.fn(async (_correlation: string, work: (value: PoolClient) => Promise<unknown>) => work(client)),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as DatabaseService;
    const notificationMock = { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'ses' }) };
    const notification: NotificationOtpClient = notificationMock as unknown as NotificationOtpClient;
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await new OtpService(database, notification).start({
      identifier: 'person@example.test', purpose: 'PASSWORD_RESET',
      remoteIp: '192.0.2.10', correlationId: 'otp-correlation-0001',
    });

    const delivered = (notification.deliver as jest.Mock).mock.calls[0][0] as { code: string };
    expect(delivered.code).toMatch(/^\d{6}$/);
    const inserted = calls.find((call) => call.sql.includes('insert into auth.otp_challenges'));
    expect(inserted?.values).not.toContain(delivered.code);
    expect(stdout.mock.calls.flat().join(' ')).not.toContain(delivered.code);
    expect(stderr.mock.calls.flat().join(' ')).not.toContain(delivered.code);
  });

  it('binds verification to purpose and commits bounded failed-attempt evidence', async () => {
    const recipient = hmac('recipient', 'person@example.test');
    const verifier = hmac('otp', 'PASSWORD_RESET', recipient, '000007');
    const updates: string[] = [];
    const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('from auth.otp_challenges')) {
        expect(values[1]).toBe('LEGACY_ACCOUNT_RECOVERY');
        return { rows: [{ id: 'challenge-1', account_id: 'account-1', recipient_hmac: recipient, verifier_hmac: verifier,
          expires_at: new Date(Date.now() + 60_000), failed_attempts: 0, max_attempts: 5 }] };
      }
      updates.push(sql);
      return { rows: [] };
    }) } as unknown as PoolClient;
    const database = {
      withSystemTransaction: jest.fn(async (_correlation: string, work: (value: PoolClient) => Promise<unknown>) => work(client)),
      query: jest.fn(),
    } as unknown as DatabaseService;
    const notification = { deliver: jest.fn() } as unknown as NotificationOtpClient;

    await expect(new OtpService(database, notification).verify({
      challengeId: '86e1e934-dac3-40a4-b15f-bd76904a9a32',
      purpose: 'LEGACY_ACCOUNT_RECOVERY', code: '000007', correlationId: 'otp-correlation-0002',
    })).rejects.toMatchObject({ code: 'OTP_INVALID_OR_EXPIRED' });
    expect(updates.some((sql) => sql.includes('failed_attempts = failed_attempts + 1'))).toBe(true);
  });

  it('invalidates an expired challenge without issuing a completion credential', async () => {
    const updates: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('from auth.otp_challenges')) return { rows: [{
        id: 'challenge-expired', account_id: 'account-1', recipient_hmac: hmac('recipient', 'person@example.test'),
        verifier_hmac: hmac('otp', 'PASSWORD_RESET', hmac('recipient', 'person@example.test'), '123456'),
        expires_at: new Date(Date.now() - 1_000), failed_attempts: 0, max_attempts: 5,
      }] };
      updates.push({ sql, values });
      return { rows: [] };
    }) } as unknown as PoolClient;
    const database = transactionDatabase(client);

    await expect(new OtpService(database, { deliver: jest.fn() } as unknown as NotificationOtpClient).verify({
      challengeId: '86e1e934-dac3-40a4-b15f-bd76904a9a32', purpose: 'PASSWORD_RESET',
      code: '123456', correlationId: 'otp-correlation-0003',
    })).rejects.toMatchObject({ code: 'OTP_INVALID_OR_EXPIRED' });
    expect(updates.some(({ values }) => values.includes('expired'))).toBe(true);
    expect(updates.some(({ sql }) => sql.includes('completion_token_hmac'))).toBe(false);
  });

  it('issues an opaque completion credential only after a valid purpose-bound code', async () => {
    const recipient = hmac('recipient', 'person@example.test');
    const updates: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('from auth.otp_challenges')) return { rows: [{
        id: 'challenge-valid', account_id: 'account-1', recipient_hmac: recipient,
        verifier_hmac: hmac('otp', 'PASSWORD_RESET', recipient, '012345'),
        expires_at: new Date(Date.now() + 60_000), failed_attempts: 0, max_attempts: 5,
      }] };
      updates.push({ sql, values });
      return { rows: [] };
    }) } as unknown as PoolClient;

    const result = await new OtpService(
      transactionDatabase(client), { deliver: jest.fn() } as unknown as NotificationOtpClient,
    ).verify({ challengeId: '86e1e934-dac3-40a4-b15f-bd76904a9a32', purpose: 'PASSWORD_RESET',
      code: '012345', correlationId: 'otp-correlation-0004' });

    expect(result.verificationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const completion = updates.find(({ sql }) => sql.includes('completion_token_hmac = $2'));
    expect(completion?.values[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(completion?.values).not.toContain(result.verificationToken);
  });

  it('allows password completion only once and revokes prior sessions', async () => {
    const challengeId = '86e1e934-dac3-40a4-b15f-bd76904a9a32';
    const verificationToken = 'opaque-completion-token-with-more-than-32-characters';
    let consumed = false;
    const sqlCalls: string[] = [];
    const client = { query: jest.fn(async (sql: string) => {
      sqlCalls.push(sql);
      if (sql.includes('select id::text, account_id::text')) return { rows: consumed ? [] : [{
        id: challengeId, account_id: 'account-1',
        completion_token_hmac: hmac('otp-completion', challengeId, verificationToken),
        completion_expires_at: new Date(Date.now() + 60_000),
      }] };
      if (sql.includes('set consumed_at = clock_timestamp()')) consumed = true;
      return { rows: [] };
    }) } as unknown as PoolClient;
    const service = new OtpService(
      transactionDatabase(client), { deliver: jest.fn() } as unknown as NotificationOtpClient,
    );
    const input = { challengeId, purpose: 'LEGACY_ACCOUNT_RECOVERY' as const, verificationToken,
      newPassword: 'a-strong-test-password', correlationId: 'otp-correlation-0005' };

    await expect(service.complete(input)).resolves.toEqual({ completed: true });
    await expect(service.complete(input)).rejects.toMatchObject({ code: 'OTP_INVALID_OR_EXPIRED' });
    expect(sqlCalls.some((sql) => sql.includes("password_algorithm = 'argon2id'"))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes("revocation_reason = 'password_recovered_with_otp'"))).toBe(true);
    expect(sqlCalls.filter((sql) => sql.includes('set consumed_at = clock_timestamp()'))).toHaveLength(1);
  });

  it('invalidates the old active code before inserting and delivering a resend', async () => {
    const calls: string[] = [];
    const client = { query: jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('from auth.accounts account')) return { rows: [{ id: 'account-1', email: 'person@example.test' }] };
      if (sql.includes('from auth.otp_rate_limits')) return { rows: [] };
      if (sql.includes('select id::text, created_at from auth.otp_challenges')) return { rows: [{
        id: 'old-challenge', created_at: new Date(Date.now() - 61_000),
      }] };
      return { rows: [] };
    }) } as unknown as PoolClient;
    const notification = { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'ses' }) };

    await new OtpService(transactionDatabase(client), notification as unknown as NotificationOtpClient).start({
      identifier: 'person@example.test', purpose: 'PASSWORD_RESET',
      remoteIp: '192.0.2.12', correlationId: 'otp-correlation-0006',
    });

    const invalidated = calls.findIndex((sql) => sql.includes("invalidation_reason = 'resend'"));
    const inserted = calls.findIndex((sql) => sql.includes('insert into auth.otp_challenges'));
    expect(invalidated).toBeGreaterThan(-1);
    expect(inserted).toBeGreaterThan(invalidated);
    expect(notification.deliver).toHaveBeenCalledTimes(1);
  });

  function hmac(...parts: string[]): string {
    return createHmac('sha256', key).update(parts.join('\u001f'), 'utf8').digest('hex');
  }

  function transactionDatabase(client: PoolClient): DatabaseService {
    return {
      withSystemTransaction: jest.fn(async (
        _correlation: string, work: (value: PoolClient) => Promise<unknown>,
      ) => work(client)),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as DatabaseService;
  }
});
