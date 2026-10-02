import { createCipheriv, createHmac } from 'node:crypto';
import * as argon2 from 'argon2';
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
  const encryptionKey = Buffer.alloc(32, 8);

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      OTP_HMAC_KEY_B64: key.toString('base64'),
      NIN_ENCRYPTION_KEY_B64: encryptionKey.toString('base64'),
      NIN_KEY_VERSION: 'local-v1',
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

  it('sends recovery to the verified phone for a phone-only public patient identified by HID', async () => {
    const enrollmentId = '50000000-0000-4000-8000-000000000001';
    const phone = '+2348012345678';
    const ciphertext = encryptedContact(enrollmentId, phone);
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('from auth.accounts account')) return { rows: [{
        id: 'account-1', email: null, token_version: '1', phone_enrollment_id: enrollmentId,
        phone_ciphertext: ciphertext, phone_key_version: 'local-v1',
      }] };
      return { rows: [] };
    }) } as unknown as PoolClient;
    const notification = { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'test_sms' }) };

    const result = await new OtpService(transactionDatabase(client), notification as unknown as NotificationOtpClient)
      .start({ identifier: 'hid-abcdefgh', purpose: 'PASSWORD_RESET',
        remoteIp: '192.0.2.30', correlationId: 'phone-recovery-0001' });

    expect(result).toEqual(expect.objectContaining({ accepted: true, deliveryChannels: ['email', 'sms'] }));
    expect(result.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(notification.deliver).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'sms', recipient: phone, purpose: 'PASSWORD_RESET', challengeId: result.challengeId,
    }));
    const lookup = calls.find(({ sql }) => sql.includes('from auth.accounts account'));
    expect(lookup?.values).toEqual(['hid-abcdefgh']);
    expect(lookup?.sql).toContain("enrollment.state = 'active'");
    expect(lookup?.sql).toContain('enrollment.contact_verified_at is not null');
    expect(lookup?.sql).toContain("patient.status = 'active'");
    expect(lookup?.sql).toContain('patient.phone_lookup_hmac = enrollment.contact_lookup_hmac');
    expect(lookup?.sql).not.toContain('patient.phone_lookup_hmac = enrollment.contact_hmac');
    expect(lookup?.sql).toContain('enrollment.account_id = account.id and enrollment.patient_id = patient.id');
    const inserted = calls.find(({ sql }) => sql.includes('insert into auth.otp_challenges'));
    expect(inserted?.values[4]).toBe('sms');
    expect(inserted?.values).not.toContain(phone);
    expect(calls.map(({ values }) => values)).not.toContainEqual(expect.arrayContaining([phone]));
  });

  it('keeps an unknown HID and unusable phone evidence on the generic recovery path', async () => {
    const enrollmentId = '50000000-0000-4000-8000-000000000001';
    const tampered = Buffer.from(encryptedContact(enrollmentId, '+2348012345678'));
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('from auth.accounts account')) return { rows: values[0] === 'HID-ABCDEFGH' ? [{
        id: 'account-1', email: null, token_version: '1', phone_enrollment_id: enrollmentId,
        phone_ciphertext: tampered, phone_key_version: 'local-v1',
      }] : [] };
      return { rows: [] };
    }) } as unknown as PoolClient;
    const notification = { deliver: jest.fn() };
    const service = new OtpService(transactionDatabase(client), notification as unknown as NotificationOtpClient);

    const unknown = await service.start({ identifier: 'HID-ZYXWVUTS', purpose: 'PASSWORD_RESET',
      remoteIp: '192.0.2.31', correlationId: 'phone-recovery-unknown' });
    const unusable = await service.start({ identifier: 'HID-ABCDEFGH', purpose: 'PASSWORD_RESET',
      remoteIp: '192.0.2.32', correlationId: 'phone-recovery-tampered' });

    expect({ ...unknown, challengeId: '<opaque>' }).toEqual({ ...unusable, challengeId: '<opaque>' });
    expect(unknown.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(unusable.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(notification.deliver).not.toHaveBeenCalled();
    expect((client.query as jest.Mock).mock.calls.some(([sql]) => String(sql).includes('insert into auth.otp_challenges')))
      .toBe(false);
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

  it('uses the narrow recovery command and rejects an already consumed credential', async () => {
    const challengeId = '86e1e934-dac3-40a4-b15f-bd76904a9a32';
    const verificationToken = 'opaque-completion-token-with-more-than-32-characters';
    let consumed = false;
    const sqlCalls: string[] = [];
    const client = { query: jest.fn(async (sql: string) => {
      sqlCalls.push(sql);
      if (sql.includes('select challenge.id::text, challenge.account_id::text')) return { rows: consumed ? [] : [{
        id: challengeId, account_id: 'account-1',
        completion_token_hmac: hmac('otp-completion', challengeId, verificationToken),
        completion_expires_at: new Date(Date.now() + 60_000),
      }] };
      if (sql.includes('select auth.complete_recovery_otp')) {
        consumed = true;
        return { rows: [{ completed: true }] };
      }
      return { rows: [] };
    }) } as unknown as PoolClient;
    const service = new OtpService(
      transactionDatabase(client), { deliver: jest.fn() } as unknown as NotificationOtpClient,
    );
    const input = { challengeId, purpose: 'LEGACY_ACCOUNT_RECOVERY' as const, verificationToken,
      newPassword: 'a-strong-test-password', correlationId: 'otp-correlation-0005' };

    await expect(service.complete(input)).resolves.toEqual({ completed: true });
    await expect(service.complete(input)).rejects.toMatchObject({ code: 'OTP_INVALID_OR_EXPIRED' });
    expect(sqlCalls.some((sql) => /update auth.accounts|update auth.sessions/.test(sql))).toBe(false);
    expect(sqlCalls.filter((sql) => sql.includes('select auth.complete_recovery_otp'))).toHaveLength(1);
  });

  it('rejects completion when current database authority changes after the precheck', async () => {
    const challengeId = '86e1e934-dac3-40a4-b15f-bd76904a9a32';
    const verificationToken = 'opaque-completion-token-with-more-than-32-characters';
    const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('select challenge.id::text, challenge.account_id::text')) return { rows: [{
        id: challengeId, account_id: 'account-1',
        completion_token_hmac: hmac('otp-completion', challengeId, verificationToken),
        completion_expires_at: new Date(Date.now() + 60_000),
      }] };
      expect(sql).toContain('auth.complete_recovery_otp');
      expect(values).not.toContain(verificationToken);
      expect(values).not.toContain('a-strong-test-password');
      expect(values[2]).toBe(hmac('otp-completion', challengeId, verificationToken));
      return { rows: [{ completed: false }] };
    }) } as unknown as PoolClient;
    await expect(new OtpService(transactionDatabase(client), {} as NotificationOtpClient).complete({
      challengeId, purpose: 'PASSWORD_RESET', verificationToken,
      newPassword: 'a-strong-test-password', correlationId: 'otp-race-denial-0001',
    })).rejects.toMatchObject({ code: 'OTP_INVALID_OR_EXPIRED' });
  });

  it('does not hash a password or complete recovery for an ineligible account or invalid token', async () => {
    const hashesBefore = (argon2.hash as jest.Mock).mock.calls.length;
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
    await expect(new OtpService(transactionDatabase(client), {} as NotificationOtpClient).complete({
      challengeId: '86e1e934-dac3-40a4-b15f-bd76904a9a32', purpose: 'PASSWORD_RESET',
      verificationToken: 'opaque-completion-token-with-more-than-32-characters',
      newPassword: 'a-strong-test-password', correlationId: 'otp-disabled-denial-0001',
    })).rejects.toMatchObject({ code: 'OTP_INVALID_OR_EXPIRED' });
    expect((argon2.hash as jest.Mock).mock.calls.length).toBe(hashesBefore);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('returns a rate-limit denial without sending another code', async () => {
    const statements: string[] = [];
    const client = { query: jest.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('from auth.accounts account')) return { rows: [] };
      if (sql.includes('from auth.otp_rate_limits')) return { rows: [{
        request_count: 5, window_started_at: new Date(), blocked_until: null,
      }] };
      return { rows: [] };
    }) } as unknown as PoolClient;
    const notification = { deliver: jest.fn() };
    await expect(new OtpService(transactionDatabase(client), notification as unknown as NotificationOtpClient).start({
      identifier: 'person@example.test', purpose: 'PASSWORD_RESET',
      remoteIp: '192.0.2.12', correlationId: 'otp-rate-denial-0001',
    })).rejects.toMatchObject({ code: 'OTP_RATE_LIMITED' });
    expect(notification.deliver).not.toHaveBeenCalled();
    expect(statements.findIndex(sql => sql.includes('pg_advisory_xact_lock')))
      .toBeLessThan(statements.findIndex(sql => sql.includes('from auth.otp_rate_limits')));
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

  function encryptedContact(enrollmentId: string, phone: string): Buffer {
    const nonce = Buffer.alloc(12, 3);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
    cipher.setAAD(Buffer.from(`identity:public-patient-enrollment:${enrollmentId}:contact`));
    return Buffer.concat([Buffer.from([1]), nonce, cipher.update(phone, 'utf8'),
      cipher.final(), cipher.getAuthTag()]);
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
