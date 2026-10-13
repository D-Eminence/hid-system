import { createCipheriv, createHmac } from 'node:crypto';
import * as argon2 from 'argon2';
jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn().mockResolvedValue('$argon2id$test-password-hash'),
}));
import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { RecoveryOtpPurpose } from './dto/otp.dto';
import type { NotificationOtpClient, OtpDeliveryOutcome } from './notification-otp.client';
import { generateSixDigitOtp, OtpService } from './otp.service';

/**
 * A start names the account kind of its recovery page (REC-AUDIENCE, 0086).
 * Cast so that these specs also compile, and fail at their own assertions,
 * against a service that takes no audience.
 */
type StartInput = Parameters<OtpService['start']>[0];
type Audience = 'patient' | 'staff' | 'platform';
const startArgs = (input: { identifier: string; purpose: RecoveryOtpPurpose; remoteIp?: string; correlationId: string;
  audience?: Audience }): StartInput => ({ audience: 'patient', ...input }) as unknown as StartInput;

// Deliveries run after the response (REC-3). Optional here so that these specs
// also run, and fail at their own assertions, against a service without them.
interface AfterResponseLifecycle {
  settleDeliveries?(): Promise<void>;
  beforeApplicationShutdown?(): Promise<void>;
}
const lifecycle = (service: OtpService): AfterResponseLifecycle => service as unknown as AfterResponseLifecycle;
/** Lets every pending promise chain run; timers are not involved. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const KNOWN_EMAIL = 'person@example.test';
const KNOWN_HID = 'HID-ABCDEFGH';
const OTHER_EMAIL = 'other.person@example.test';
const UNKNOWN_EMAIL = 'nobody@example.test';
const STAFF_EMAIL = 'clinician@example.test';
const ADMIN_EMAIL = 'administrator@example.test';
const UNVERIFIED_EMAIL = 'unconfirmed@example.test';
const UNVERIFIED_HID = 'HID-UNCNFRMD';

interface SqlCall { sql: string; values: readonly unknown[] }
interface StoredChallenge {
  id: string; account_id: string; recipient_hmac: string; purpose: string; verifier_hmac: string;
  expires_at: Date; failed_attempts: number; max_attempts: number; created_at: Date;
  invalidated_at: Date | null; invalidation_reason: string | null; verified_at: Date | null;
}
interface RateRow { request_count: number; window_started_at: Date; blocked_until: Date | null }
interface Delivered { challengeId: string; recipient: string; code: string; purpose: string }
interface RecordingNotification { client: NotificationOtpClient; deliveries: Delivered[] }
interface Captured { challengeId: string; code: string; purpose: RecoveryOtpPurpose }

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
      if (sql.includes('from auth.accounts account')) return { rows: [{ id: 'account-1', email: 'person@example.test',
        email_verified: true, audience_matches: true }] };
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

    await new OtpService(database, notification).start(startArgs({
      identifier: 'person@example.test', purpose: 'PASSWORD_RESET',
      remoteIp: '192.0.2.10', correlationId: 'otp-correlation-0001',
    }));

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
        id: 'account-1', email: null, email_verified: false, audience_matches: true, token_version: '1',
        phone_enrollment_id: enrollmentId, phone_ciphertext: ciphertext, phone_key_version: 'local-v1',
      }] };
      return { rows: [] };
    }) } as unknown as PoolClient;
    const notification = { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'test_sms' }) };

    const result = await new OtpService(transactionDatabase(client), notification as unknown as NotificationOtpClient)
      .start(startArgs({ identifier: 'hid-abcdefgh', purpose: 'PASSWORD_RESET',
        remoteIp: '192.0.2.30', correlationId: 'phone-recovery-0001' }));

    expect(result).toEqual(expect.objectContaining({ accepted: true, deliveryChannels: ['email', 'sms'] }));
    expect(result.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(notification.deliver).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'sms', recipient: phone, purpose: 'PASSWORD_RESET', challengeId: result.challengeId,
    }));
    const lookup = calls.find(({ sql }) => sql.includes('from auth.accounts account'));
    expect(lookup?.values).toEqual(['hid-abcdefgh', 'patient']);
    expect(lookup?.sql).toContain('auth.recovery_account_audience(account.id, $2) as audience_matches');
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
        id: 'account-1', email: null, email_verified: false, audience_matches: true, token_version: '1',
        phone_enrollment_id: enrollmentId, phone_ciphertext: tampered, phone_key_version: 'local-v1',
      }] : [] };
      return { rows: [] };
    }) } as unknown as PoolClient;
    const notification = { deliver: jest.fn() };
    const service = new OtpService(transactionDatabase(client), notification as unknown as NotificationOtpClient);

    const unknown = await service.start(startArgs({ identifier: 'HID-ZYXWVUTS', purpose: 'PASSWORD_RESET',
      remoteIp: '192.0.2.31', correlationId: 'phone-recovery-unknown' }));
    const unusable = await service.start(startArgs({ identifier: 'HID-ABCDEFGH', purpose: 'PASSWORD_RESET',
      remoteIp: '192.0.2.32', correlationId: 'phone-recovery-tampered' }));

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

  it('tells a bound recovery-notice sink of each completed recovery after it commits, and nothing of a refused one', async () => {
    const challengeId = '86e1e934-dac3-40a4-b15f-bd76904a9a33';
    const verificationToken = 'opaque-completion-token-with-more-than-32-characters';
    let consumed = false;
    const client = { query: jest.fn(async (sql: string) => {
      if (sql.includes('select challenge.id::text, challenge.account_id::text')) return { rows: consumed ? [] : [{
        id: challengeId, account_id: 'account-7',
        completion_token_hmac: hmac('otp-completion', challengeId, verificationToken),
        completion_expires_at: new Date(Date.now() + 60_000),
      }] };
      if (sql.includes('select auth.complete_recovery_otp')) { consumed = true; return { rows: [{ completed: true }] }; }
      return { rows: [] };
    }) } as unknown as PoolClient;
    const recoveryCompleted = jest.fn().mockResolvedValue(undefined);
    // The sink is an optional third dependency (REC-NOTIFY hook, 0086); constructed
    // loosely so that this spec also compiles against a service without it.
    const service = new (OtpService as unknown as new (...dependencies: unknown[]) => OtpService)(
      transactionDatabase(client), { deliver: jest.fn() }, { recoveryCompleted });
    const input = { challengeId, purpose: 'PASSWORD_RESET' as const, verificationToken,
      newPassword: 'a-strong-test-password', correlationId: 'otp-correlation-notice' };

    await expect(service.complete(input)).resolves.toEqual({ completed: true });
    await expect(service.complete(input)).rejects.toMatchObject({ code: 'OTP_INVALID_OR_EXPIRED' });
    await lifecycle(service).settleDeliveries?.();
    expect(recoveryCompleted.mock.calls).toEqual([[{
      accountId: 'account-7', purpose: 'PASSWORD_RESET', correlationId: 'otp-correlation-notice',
    }]]);
  });

  it('completes a recovery without a notice sink, and a failing sink never undoes it', async () => {
    const challengeId = '86e1e934-dac3-40a4-b15f-bd76904a9a34';
    const verificationToken = 'opaque-completion-token-with-more-than-32-characters';
    const client = { query: jest.fn(async (sql: string) => {
      if (sql.includes('select challenge.id::text, challenge.account_id::text')) return { rows: [{
        id: challengeId, account_id: 'account-8',
        completion_token_hmac: hmac('otp-completion', challengeId, verificationToken),
        completion_expires_at: new Date(Date.now() + 60_000),
      }] };
      if (sql.includes('select auth.complete_recovery_otp')) return { rows: [{ completed: true }] };
      return { rows: [] };
    }) } as unknown as PoolClient;
    const input = { challengeId, purpose: 'PASSWORD_RESET' as const, verificationToken,
      newPassword: 'a-strong-test-password', correlationId: 'otp-correlation-no-sink' };
    const unbound = new OtpService(transactionDatabase(client), { deliver: jest.fn() } as unknown as NotificationOtpClient);
    await expect(unbound.complete(input)).resolves.toEqual({ completed: true });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const failing = new (OtpService as unknown as new (...dependencies: unknown[]) => OtpService)(
      transactionDatabase(client), { deliver: jest.fn() },
      { recoveryCompleted: jest.fn().mockRejectedValue(new Error('synthetic notice outage')) });
    await expect(failing.complete(input)).resolves.toEqual({ completed: true });
    await lifecycle(failing).settleDeliveries?.();
    expect(warn.mock.calls.flat().join(' ')).not.toContain('synthetic notice outage');
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
    await expect(new OtpService(transactionDatabase(client), notification as unknown as NotificationOtpClient).start(startArgs({
      identifier: 'person@example.test', purpose: 'PASSWORD_RESET',
      remoteIp: '192.0.2.12', correlationId: 'otp-rate-denial-0001',
    }))).rejects.toMatchObject({ code: 'OTP_RATE_LIMITED' });
    expect(notification.deliver).not.toHaveBeenCalled();
    expect(statements.findIndex(sql => sql.includes('pg_advisory_xact_lock')))
      .toBeLessThan(statements.findIndex(sql => sql.includes('from auth.otp_rate_limits')));
  });

  it('invalidates the old active code before inserting and delivering a resend', async () => {
    const calls: string[] = [];
    const client = { query: jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('from auth.accounts account')) return { rows: [{ id: 'account-1', email: 'person@example.test',
        email_verified: true, audience_matches: true }] };
      if (sql.includes('from auth.otp_rate_limits')) return { rows: [] };
      if (/^\s*select id::text, created_at/.test(sql)) return { rows: [{
        id: 'old-challenge', created_at: new Date(Date.now() - 61_000), cooling: false,
      }] };
      return { rows: [] };
    }) } as unknown as PoolClient;
    const notification = { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'ses' }) };

    await new OtpService(transactionDatabase(client), notification as unknown as NotificationOtpClient).start(startArgs({
      identifier: 'person@example.test', purpose: 'PASSWORD_RESET',
      remoteIp: '192.0.2.12', correlationId: 'otp-correlation-0006',
    }));

    const invalidated = calls.findIndex((sql) => sql.includes("invalidation_reason = 'resend'"));
    const inserted = calls.findIndex((sql) => sql.includes('insert into auth.otp_challenges'));
    expect(invalidated).toBeGreaterThan(-1);
    expect(inserted).toBeGreaterThan(invalidated);
    expect(notification.deliver).toHaveBeenCalledTimes(1);
  });

  describe('recovery start answers before the code is delivered (REC-3)', () => {
    afterEach(() => jest.useRealTimers());

    it('answers a known account before its delivery settles, then records the outcome', async () => {
      const store = recoveryStore();
      const delivery = deferredDelivery();
      const service = new OtpService(store.database, delivery.notification);
      let answered: Awaited<ReturnType<OtpService['start']>> | undefined;
      const started = service.start(startInput(KNOWN_EMAIL)).then((result) => { answered = result; });
      try {
        await flush();
        expect({ answeredBeforeDelivery: answered !== undefined }).toEqual({ answeredBeforeDelivery: true });
        expect(delivery.notification.deliver).toHaveBeenCalledTimes(1);
        expect(delivery.notification.deliver).toHaveBeenCalledWith(expect.objectContaining({
          challengeId: answered!.challengeId, recipient: KNOWN_EMAIL, purpose: 'PASSWORD_RESET',
        }));
        expect(store.recorded).toHaveLength(0);
      } finally {
        delivery.release('accepted');
        await started;
      }
      await lifecycle(service).settleDeliveries?.();
      expect(store.recorded).toEqual([[answered!.challengeId, 'accepted', 'ses']]);
    });

    it('answers a known and an unknown identifier alike while a delivery is slow', async () => {
      const store = recoveryStore();
      const delivery = deferredDelivery();
      const service = new OtpService(store.database, delivery.notification);
      const answered: string[] = [];
      const known = service.start(startInput(KNOWN_EMAIL)).then((result) => { answered.push('known'); return result; });
      const unknown = service.start(startInput(UNKNOWN_EMAIL, '192.0.2.41'))
        .then((result) => { answered.push('unknown'); return result; });
      try {
        await flush();
        expect(answered.sort()).toEqual(['known', 'unknown']);
      } finally {
        delivery.release('accepted');
      }
      const [knownBody, unknownBody] = await Promise.all([known, unknown]);
      expect({ ...knownBody, challengeId: '<opaque>' }).toEqual({ ...unknownBody, challengeId: '<opaque>' });
      await lifecycle(service).settleDeliveries?.();
    });

    it('contains a failed delivery bookkeeping write and logs neither the code nor the recipient', async () => {
      const store = recoveryStore({ recordDeliveryError: new Error(`write failed for ${KNOWN_EMAIL}`) });
      const notification = recordingNotification();
      const warn = jest.spyOn(Logger.prototype, 'warn');
      const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const service = new OtpService(store.database, notification.client);
        const result = await service.start(startInput(KNOWN_EMAIL));
        await lifecycle(service).settleDeliveries?.();
        await flush();
        const code = notification.deliveries[0]!.code;
        expect(result.challengeId).toBe(notification.deliveries[0]?.challengeId);
        expect(unhandled).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        const logged = [...warn.mock.calls.flat(), ...stdout.mock.calls.flat(), ...stderr.mock.calls.flat()]
          .map(String).join(' ');
        expect(logged).toContain('otp-start-0001');
        expect(logged).not.toContain(code);
        expect(logged).not.toContain(KNOWN_EMAIL);
        expect(logged).not.toContain('write failed');
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('waits at shutdown for deliveries in flight, including ones started while it waits, for at most six seconds', async () => {
      const store = recoveryStore();
      const delivery = deferredDelivery();
      const service = new OtpService(store.database, delivery.notification);
      let answered = false;
      const started = service.start(startInput(KNOWN_EMAIL)).then(() => { answered = true; });
      try {
        await flush();
        expect({ answeredBeforeDelivery: answered }).toEqual({ answeredBeforeDelivery: true });
        let closed = false;
        const shutdown = lifecycle(service).beforeApplicationShutdown!().then(() => { closed = true; });
        // A start that arrives while shutdown waits is awaited too.
        await service.start(startInput(KNOWN_HID, '192.0.2.42'));
        await service.start(startInput(OTHER_EMAIL, '192.0.2.43'));
        await flush();
        expect(delivery.notification.deliver).toHaveBeenCalledTimes(2);
        delivery.release('accepted');
        await flush();
        expect(closed).toBe(false);
        delivery.release('accepted');
        await shutdown;
        expect(closed).toBe(true);
        expect(store.recorded).toHaveLength(2);
      } finally {
        delivery.release('accepted');
        await started;
      }

      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      const stuck = deferredDelivery();
      const bounded = new OtpService(recoveryStore().database, stuck.notification);
      await bounded.start(startInput(KNOWN_EMAIL));
      let done = false;
      const shutdown = lifecycle(bounded).beforeApplicationShutdown!().then(() => { done = true; });
      await jest.advanceTimersByTimeAsync(5_999);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await shutdown;
      expect(done).toBe(true);
      jest.useRealTimers();
      stuck.release('accepted');
      await lifecycle(bounded).settleDeliveries?.();
    });
  });

  describe('recovery start cooldown is the same for every identifier (REC-1)', () => {
    it('answers a repeated start for an unknown identifier inside the cooldown with the same challenge id', async () => {
      const store = recoveryStore();
      const notification = recordingNotification();
      const service = new OtpService(store.database, notification.client);
      const first = await service.start(startInput(UNKNOWN_EMAIL, '192.0.2.50'));
      const repeat = await service.start(startInput(UNKNOWN_EMAIL, '192.0.2.51'));
      expect({ unknownRepeatChallengeId: repeat.challengeId }).toEqual({ unknownRepeatChallengeId: first.challengeId });
      expect(repeat).toEqual(first);
      expect(notification.deliveries).toHaveLength(0);
    });

    it('answers a repeated start for a known identifier with the same challenge id and sends one code', async () => {
      const store = recoveryStore();
      const notification = recordingNotification();
      const service = new OtpService(store.database, notification.client);
      const first = await service.start(startInput(KNOWN_EMAIL));
      const repeat = await service.start(startInput(KNOWN_EMAIL, '192.0.2.52'));
      await lifecycle(service).settleDeliveries?.();
      expect(repeat.challengeId).toBe(first.challengeId);
      expect(notification.deliveries.map(({ challengeId }) => challengeId)).toEqual([first.challengeId]);
    });

    it('folds the identifier case: "Nobody@Example.TEST" and "nobody@example.test" share one cooldown', async () => {
      const store = recoveryStore();
      const service = new OtpService(store.database, recordingNotification().client);
      const first = await service.start(startInput('Nobody@Example.TEST', '192.0.2.53'));
      const repeat = await service.start(startInput('nobody@example.test', '192.0.2.54'));
      expect({ caseFoldedChallengeId: repeat.challengeId }).toEqual({ caseFoldedChallengeId: first.challengeId });
    });

    it('gives the other identifier of a cooling account a new id and sends nothing, as for an unknown identifier', async () => {
      const store = recoveryStore();
      const notification = recordingNotification();
      const service = new OtpService(store.database, notification.client);
      const byEmail = await service.start(startInput(KNOWN_EMAIL));
      const byHid = await service.start(startInput(KNOWN_HID, '192.0.2.55'));
      await lifecycle(service).settleDeliveries?.();
      expect({ otherIdentifierGetsLiveChallengeId: byHid.challengeId === byEmail.challengeId })
        .toEqual({ otherIdentifierGetsLiveChallengeId: false });
      expect(byHid.challengeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(Object.keys(byHid).sort()).toEqual(Object.keys(byEmail).sort());
      expect(notification.deliveries).toHaveLength(1);
      expect(store.challenges.filter(({ invalidated_at }) => invalidated_at === null)
        .map(({ id }) => id)).toEqual([byEmail.challengeId]);
    });

    it('lets an identifier restart once its own cooldown has passed, although its challenge was created a moment later', async () => {
      const store = recoveryStore();
      const notification = recordingNotification();
      const service = new OtpService(store.database, notification.client);
      const first = await service.start(startInput(KNOWN_EMAIL));
      await lifecycle(service).settleDeliveries?.();
      // The challenge row is written after the cooldown row, so at the
      // boundary the identifier's cooldown has ended while its own challenge
      // is still younger than the cooldown.
      store.ageCooldowns(61_000);
      store.ageChallenges(59_000);
      const retry = await service.start(startInput(KNOWN_EMAIL, '192.0.2.62'));
      await lifecycle(service).settleDeliveries?.();
      expect({ boundaryRetrySendsNewCode: retry.challengeId !== first.challengeId
        && notification.deliveries.at(-1)?.challengeId === retry.challengeId })
        .toEqual({ boundaryRetrySendsNewCode: true });
      expect(notification.deliveries).toHaveLength(2);
    });

    it('keeps the id of a challenge whose delivery definitively failed until the cooldown ends', async () => {
      const store = recoveryStore();
      const notification = recordingNotification('definitive_failure');
      const service = new OtpService(store.database, notification.client);
      const first = await service.start(startInput(KNOWN_EMAIL));
      await lifecycle(service).settleDeliveries?.();
      expect(store.challenges[0]?.invalidation_reason).toBe('delivery_failed');
      const repeat = await service.start(startInput(KNOWN_EMAIL, '192.0.2.56'));
      await lifecycle(service).settleDeliveries?.();
      expect({ failedDeliveryRepeatChallengeId: repeat.challengeId })
        .toEqual({ failedDeliveryRepeatChallengeId: first.challengeId });
      expect(notification.deliveries).toHaveLength(1);
    });

    it('issues fresh ids for known and unknown identifiers once the cooldown has passed', async () => {
      const store = recoveryStore();
      const notification = recordingNotification();
      const service = new OtpService(store.database, notification.client);
      const known = await service.start(startInput(KNOWN_EMAIL));
      const unknown = await service.start(startInput(UNKNOWN_EMAIL, '192.0.2.57'));
      await lifecycle(service).settleDeliveries?.();
      store.ageCooldowns(61_000);
      store.ageChallenges(61_000);
      const knownAgain = await service.start(startInput(KNOWN_EMAIL, '192.0.2.58'));
      const unknownAgain = await service.start(startInput(UNKNOWN_EMAIL, '192.0.2.59'));
      await lifecycle(service).settleDeliveries?.();
      expect(knownAgain.challengeId).not.toBe(known.challengeId);
      expect(unknownAgain.challengeId).not.toBe(unknown.challengeId);
      expect(notification.deliveries.map(({ challengeId }) => challengeId))
        .toEqual([known.challengeId, knownAgain.challengeId]);
    });

    it('reads the cooldown after the three rate limits, whose recipient lock serializes one identifier, and before the challenge lock', async () => {
      const store = recoveryStore();
      const service = new OtpService(store.database, recordingNotification().client);
      await service.start(startInput(KNOWN_EMAIL));
      await lifecycle(service).settleDeliveries?.();
      const index = (match: (call: SqlCall) => boolean) => store.calls.findIndex(match);
      const consumes = store.calls.filter(({ sql }) => sql.includes('insert into auth.otp_rate_limits'));
      expect(consumes).toHaveLength(3);
      const recipientLock = index(({ sql, values }) => sql.includes('pg_advisory_xact_lock')
        && String(values[0]).startsWith('otp-rate:recipient:'));
      const lastConsume = store.calls.length - 1
        - [...store.calls].reverse().findIndex(({ sql }) => sql.includes('insert into auth.otp_rate_limits'));
      const cooldownRead = index(({ sql }) => sql.includes('from auth.otp_start_cooldowns'));
      const cooldownWrite = index(({ sql }) => sql.includes('insert into auth.otp_start_cooldowns'));
      const challengeLock = index(({ sql }) => /^\s*select id::text, created_at/.test(sql));
      expect({ cooldownReadAfterRateLimits: cooldownRead > lastConsume })
        .toEqual({ cooldownReadAfterRateLimits: true });
      expect(recipientLock).toBeGreaterThan(-1);
      expect(recipientLock).toBeLessThan(cooldownRead);
      expect(cooldownWrite).toBeGreaterThan(cooldownRead);
      expect(challengeLock).toBeGreaterThan(cooldownWrite);
      // Both cooldowns use the database clock, never the process clock.
      expect(store.calls[cooldownRead]?.sql).toContain('clock_timestamp()');
      expect(store.calls[challengeLock]?.sql).toContain('clock_timestamp()');
      expect(store.calls.some(({ sql }) => sql.includes('delete from auth.otp_start_cooldowns'))).toBe(false);
      expect(JSON.stringify(store.calls.filter(({ sql }) => sql.includes('otp_start_cooldowns'))))
        .not.toContain(KNOWN_EMAIL);
    });
  });

  describe('a recovery start reaches only its own kind of account (REC-AUDIENCE)', () => {
    const accountBuckets = (limits: Map<string, RateRow>) => [...limits.keys()].filter((key) => key.startsWith('account:'));

    it('answers a start from another page like an unknown identifier: same answer, nothing counted or sent', async () => {
      const store = recoveryStore();
      const notification = recordingNotification();
      const service = new OtpService(store.database, notification.client);

      const answers = [
        await service.start(startInput(UNKNOWN_EMAIL, '192.0.2.80', 'PASSWORD_RESET', 'patient')),
        await service.start(startInput(STAFF_EMAIL, '192.0.2.81', 'PASSWORD_RESET', 'patient')),
        await service.start(startInput(ADMIN_EMAIL, '192.0.2.82', 'PASSWORD_RESET', 'staff')),
        await service.start(startInput(KNOWN_EMAIL, '192.0.2.83', 'PASSWORD_RESET', 'platform')),
        await service.start(startInput(KNOWN_HID, '192.0.2.84', 'PASSWORD_RESET', 'staff')),
      ];
      await service.settleDeliveries?.();

      expect(notification.deliveries).toEqual([]);
      expect(store.challenges).toEqual([]);
      expect(accountBuckets(store.limits)).toEqual([]);
      const shapes = answers.map(({ challengeId, ...rest }) => ({ ...rest, challengeId: typeof challengeId }));
      for (const shape of shapes) expect(shape).toEqual(shapes[0]);
      expect(new Set(answers.map(({ challengeId }) => challengeId)).size).toBe(answers.length);
    });

    it('keeps a cooldown per page: a start on another page does not hold back the account\'s own page', async () => {
      const store = recoveryStore();
      const notification = recordingNotification();
      const service = new OtpService(store.database, notification.client);

      const elsewhere = await service.start(startInput(STAFF_EMAIL, '192.0.2.88', 'PASSWORD_RESET', 'patient'));
      const own = await service.start(startInput(STAFF_EMAIL, '192.0.2.89', 'PASSWORD_RESET', 'staff'));
      await service.settleDeliveries?.();

      expect(own.challengeId).not.toBe(elsewhere.challengeId);
      expect(notification.deliveries.map(({ challengeId }) => challengeId)).toEqual([own.challengeId]);
    });

    it('delivers through the page of the account kind, and asks the database for exactly that kind', async () => {
      const store = recoveryStore();
      const notification = recordingNotification();
      const service = new OtpService(store.database, notification.client);

      const patient = await service.start(startInput(KNOWN_EMAIL, '192.0.2.85', 'PASSWORD_RESET', 'patient'));
      const staff = await service.start(startInput(STAFF_EMAIL, '192.0.2.86', 'PASSWORD_RESET', 'staff'));
      const admin = await service.start(startInput(ADMIN_EMAIL, '192.0.2.87', 'PASSWORD_RESET', 'platform'));
      await service.settleDeliveries?.();

      expect(notification.deliveries.map(({ challengeId, recipient }) => [challengeId, recipient])).toEqual([
        [patient.challengeId, KNOWN_EMAIL], [staff.challengeId, STAFF_EMAIL], [admin.challengeId, ADMIN_EMAIL],
      ]);
      const lookups = store.calls.filter(({ sql }) => sql.includes('from auth.accounts account'));
      expect(lookups.map(({ values }) => values)).toEqual([
        [KNOWN_EMAIL, 'patient'], [STAFF_EMAIL, 'staff'], [ADMIN_EMAIL, 'platform'],
      ]);
      expect(lookups[0]?.sql).toContain('auth.recovery_account_audience(account.id, $2) as audience_matches');
    });
  });

  describe('a patient recovery code goes only to a verified contact (REC-UNVERIFIED-CONTACT)', () => {
    it('sends nothing to a patient with an unverified email and no verified phone, by email or HID', async () => {
      const store = recoveryStore();
      const notification = recordingNotification();
      const service = new OtpService(store.database, notification.client);

      const unknown = await service.start(startInput(UNKNOWN_EMAIL, '192.0.2.90'));
      const byEmail = await service.start(startInput(UNVERIFIED_EMAIL, '192.0.2.91'));
      const byHid = await service.start(startInput(UNVERIFIED_HID, '192.0.2.92'));
      const legacy = await service.start(startInput(UNVERIFIED_EMAIL, '192.0.2.93', 'LEGACY_ACCOUNT_RECOVERY'));
      await service.settleDeliveries?.();

      expect(notification.deliveries).toEqual([]);
      expect(store.challenges).toEqual([]);
      expect([...store.limits.keys()].filter((key) => key.startsWith('account:'))).toEqual([]);
      for (const answer of [byEmail, byHid, legacy]) {
        expect({ ...answer, challengeId: '<opaque>' }).toEqual({ ...unknown, challengeId: '<opaque>' });
      }
      expect(store.calls.find(({ sql }) => sql.includes('from auth.accounts account'))?.sql)
        .toContain('account.email_verified_at is not null as email_verified');
    });

    it('sends a patient with an unverified email the code by its verified phone, never by email', async () => {
      const enrollmentId = '50000000-0000-4000-8000-000000000002';
      const phone = '+2348012345679';
      const client = { query: jest.fn(async (sql: string) => {
        if (sql.includes('from auth.accounts account')) return { rows: [{
          id: 'account-1', email: 'unconfirmed@example.test', email_verified: false, audience_matches: true,
          token_version: '1', phone_enrollment_id: enrollmentId, phone_ciphertext: encryptedContact(enrollmentId, phone),
          phone_key_version: 'local-v1',
        }] };
        return { rows: [] };
      }) } as unknown as PoolClient;
      const notification = { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'test_sms' }) };
      const service = new OtpService(transactionDatabase(client), notification as unknown as NotificationOtpClient);

      await service.start(startInput('unconfirmed@example.test', '192.0.2.94'));
      await service.settleDeliveries?.();

      expect(notification.deliver).toHaveBeenCalledTimes(1);
      expect(notification.deliver).toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms', recipient: phone }));
    });

    it('sends a staff or platform account its code at the provisioned work email, which no flow marks verified', async () => {
      const store = recoveryStore();
      const notification = recordingNotification();
      const service = new OtpService(store.database, notification.client);

      await service.start(startInput(STAFF_EMAIL, '192.0.2.95', 'PASSWORD_RESET', 'staff'));
      await service.settleDeliveries?.();

      expect(notification.deliveries.map(({ recipient }) => recipient)).toEqual([STAFF_EMAIL]);
    });
  });

  describe('recovery codes have one failure budget per account across challenges (REC-4)', () => {
    it('defaults to five failures per 15 minutes and bounds both settings', () => {
      const environment = getEnvironment() as unknown as Record<string, unknown>;
      expect({ max: environment.OTP_VERIFY_FAILURE_MAX, window: environment.OTP_VERIFY_FAILURE_WINDOW_SECONDS })
        .toEqual({ max: 5, window: 900 });
      for (const [name, value] of [['OTP_VERIFY_FAILURE_MAX', '1'], ['OTP_VERIFY_FAILURE_MAX', '101'],
        ['OTP_VERIFY_FAILURE_WINDOW_SECONDS', '59'], ['OTP_VERIFY_FAILURE_WINDOW_SECONDS', '86401']] as const) {
        process.env[name] = value;
        resetEnvironmentForTests();
        expect(() => getEnvironment()).toThrow(name);
        delete process.env[name];
        resetEnvironmentForTests();
      }
    });

    it('refuses a correct code once the account has spent its failure budget on another challenge', async () => {
      const store = recoveryStore();
      const notification = recordingNotification();
      const service = new OtpService(store.database, notification.client);
      const probe = await startAndCapture(service, notification, KNOWN_EMAIL, 'LEGACY_SESSION_FALLBACK');
      await spendFailures(service, notification, 5);
      await lifecycle(service).settleDeliveries?.();

      await expect(service.verify({ challengeId: probe.challengeId, purpose: 'LEGACY_SESSION_FALLBACK',
        code: probe.code, correlationId: 'verify-after-budget' }))
        .rejects.toMatchObject({ status: 403, code: 'OTP_INVALID_OR_EXPIRED' });
      const probeRow = store.challenges.find(({ id }) => id === probe.challengeId);
      expect(probeRow?.verified_at).toBeNull();
      expect(probeRow?.invalidation_reason).toBe('attempts_exhausted');
      expect(store.calls.some(({ sql }) => sql.includes('completion_token_hmac = $2'))).toBe(false);
      const blocked = [...store.limits.values()].filter(({ blocked_until }) => blocked_until !== null);
      expect(blocked).toHaveLength(1);
      expect(blocked[0]!.blocked_until!.getTime() - Date.now()).toBeGreaterThan(900_000 - 60_000);
      expect(blocked[0]!.blocked_until!.getTime() - Date.now()).toBeLessThanOrEqual(900_000);
    });

    it('spends the budget across challenges, purposes and identifiers, and honours a configured budget', async () => {
      process.env.OTP_VERIFY_FAILURE_MAX = '12';
      resetEnvironmentForTests();
      const store = recoveryStore();
      const notification = recordingNotification();
      const service = new OtpService(store.database, notification.client);
      const below = await startAndCapture(service, notification, KNOWN_EMAIL, 'LEGACY_SESSION_FALLBACK');
      const spent = await spendFailures(service, notification, 11);
      await expect(service.verify({ challengeId: below.challengeId, purpose: 'LEGACY_SESSION_FALLBACK',
        code: below.code, correlationId: 'verify-below-budget' })).resolves.toMatchObject({ verified: true });
      const last = spent.at(-1)!;
      await expect(service.verify({ challengeId: last.challengeId, purpose: last.purpose,
        code: wrongCode(last.code), correlationId: 'verify-twelfth' })).rejects.toMatchObject({ status: 403 });
      expect({ blockedAfterConfiguredBudget: [...store.limits.values()].some(({ blocked_until }) => blocked_until !== null) })
        .toEqual({ blockedAfterConfiguredBudget: true });
      await expect(service.verify({ challengeId: last.challengeId, purpose: last.purpose,
        code: last.code, correlationId: 'verify-after-twelfth' })).rejects.toMatchObject({ code: 'OTP_INVALID_OR_EXPIRED' });
    });

    it('answers a start for an account whose budget is spent like an unknown identifier and sends nothing', async () => {
      const store = recoveryStore();
      const notification = recordingNotification();
      const service = new OtpService(store.database, notification.client);
      const unknown = await service.start(startInput(UNKNOWN_EMAIL, '192.0.2.60'));
      await spendFailures(service, notification, 5);
      await lifecycle(service).settleDeliveries?.();
      store.ageCooldowns(61_000);
      store.ageChallenges(61_000);
      const sent = notification.deliveries.length;
      const suspended = await service.start(startInput(KNOWN_EMAIL, '192.0.2.61'));
      await lifecycle(service).settleDeliveries?.();
      expect({ codesSentToSuspendedAccount: notification.deliveries.length - sent })
        .toEqual({ codesSentToSuspendedAccount: 0 });
      expect({ ...suspended, challengeId: '<opaque>' }).toEqual({ ...unknown, challengeId: '<opaque>' });
    });

    it('counts nothing for an unknown challenge id', async () => {
      const store = recoveryStore();
      const service = new OtpService(store.database, recordingNotification().client);
      await expect(service.verify({ challengeId: '86e1e934-dac3-40a4-b15f-bd76904a9a32', purpose: 'PASSWORD_RESET',
        code: '123456', correlationId: 'verify-unknown' })).rejects.toMatchObject({ code: 'OTP_INVALID_OR_EXPIRED' });
      expect(store.calls.filter(({ sql }) => sql.includes('otp_rate_limits') || sql.includes('pg_advisory_xact_lock')))
        .toEqual([]);
    });

    it('locks the challenge, then the account failure bucket, reads it before comparing, and keys nothing on the IP', async () => {
      const store = recoveryStore();
      const notification = recordingNotification();
      const service = new OtpService(store.database, notification.client);
      const started = await startAndCapture(service, notification, KNOWN_EMAIL, 'PASSWORD_RESET');
      const from = store.calls.length;
      await expect(service.verify({ challengeId: started.challengeId, purpose: 'PASSWORD_RESET',
        code: wrongCode(started.code), correlationId: 'verify-order' })).rejects.toMatchObject({ status: 403 });
      const calls = store.calls.slice(from);
      const challengeLock = calls.findIndex(({ sql }) => sql.includes('for update of challenge'));
      const bucketLock = calls.findIndex(({ sql, values }) => sql.includes('pg_advisory_xact_lock')
        && String(values[0]).startsWith('otp-rate:account:'));
      const blockedRead = calls.findIndex(({ sql }) => sql.includes('coalesce(blocked_until'));
      const failure = calls.findIndex(({ sql }) => sql.includes('failed_attempts = failed_attempts + 1'));
      expect({ failureBucketLockAfterChallenge: bucketLock > challengeLock })
        .toEqual({ failureBucketLockAfterChallenge: true });
      expect(blockedRead).toBeGreaterThan(bucketLock);
      expect(failure).toBeGreaterThan(blockedRead);
      const counted = calls.filter(({ sql }) => sql.includes('insert into auth.otp_rate_limits'));
      expect(counted.map(({ values }) => values[0])).toEqual(['account']);
      expect(calls.some(({ values }) => values[0] === 'ip' || String(values[0]).startsWith('otp-rate:ip:'))).toBe(false);
      // The bucket is keyed apart from the start bucket of the same account.
      const startBuckets = store.calls.slice(0, from).filter(({ sql, values }) =>
        sql.includes('insert into auth.otp_rate_limits') && values[0] === 'account').map(({ values }) => values[1]);
      expect(startBuckets).not.toContain(counted[0]?.values[1]);
    });

    it('invalidates no other challenge while it holds the failure-bucket lock', async () => {
      const store = recoveryStore();
      const notification = recordingNotification();
      const service = new OtpService(store.database, notification.client);
      const other = await startAndCapture(service, notification, KNOWN_EMAIL, 'LEGACY_ACCOUNT_RECOVERY');
      const from = store.calls.length;
      await spendFailures(service, notification, 5);
      const updates = store.calls.slice(from).filter(({ sql }) => /^\s*update auth\.otp_challenges/.test(sql)
        && !sql.includes("invalidation_reason = 'resend'"));
      expect(updates.length).toBeGreaterThan(0);
      expect(updates.every(({ sql }) => /where id = \$1/.test(sql))).toBe(true);
      expect(store.challenges.find(({ id }) => id === other.challengeId)?.invalidated_at).toBeNull();
    });

    it('fails closed: a correct code is not accepted when the failure budget cannot be read', async () => {
      const store = recoveryStore();
      const notification = recordingNotification();
      const service = new OtpService(store.database, notification.client);
      const started = await startAndCapture(service, notification, KNOWN_EMAIL, 'PASSWORD_RESET');
      store.failOn('coalesce(blocked_until', new Error('synthetic budget read failure'));
      await expect(service.verify({ challengeId: started.challengeId, purpose: 'PASSWORD_RESET',
        code: started.code, correlationId: 'verify-budget-unavailable' })).rejects.toThrow();
      expect(store.challenges.find(({ id }) => id === started.challengeId)?.verified_at).toBeNull();
      expect(store.calls.some(({ sql }) => sql.includes('completion_token_hmac = $2'))).toBe(false);
    });

    async function spendFailures(service: OtpService, notification: RecordingNotification, failures: number) {
      // Two purposes, each started by email and then by HID: up to four
      // challenges of at most five failures each, without waiting out a cooldown.
      const started: Captured[] = [];
      let remaining = failures;
      for (const purpose of ['PASSWORD_RESET', 'LEGACY_ACCOUNT_RECOVERY'] as const) {
        for (const identifier of [KNOWN_EMAIL, KNOWN_HID]) {
          if (remaining === 0) return started;
          const challenge = await startAndCapture(service, notification, identifier, purpose);
          started.push(challenge);
          for (let attempt = 0; attempt < 5 && remaining > 0; attempt++, remaining--) {
            await expect(service.verify({ challengeId: challenge.challengeId, purpose,
              code: wrongCode(challenge.code), correlationId: `spend-${remaining}` }))
              .rejects.toMatchObject({ code: 'OTP_INVALID_OR_EXPIRED' });
          }
        }
      }
      expect(remaining).toBe(0);
      return started;
    }
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

  /**
   * An in-memory stand-in for the recovery tables (auth.otp_challenges,
   * auth.otp_rate_limits, auth.otp_start_cooldowns) that answers the service's
   * statements as PostgreSQL would for one connection at a time. Statements it
   * does not know fail the test.
   */
  function recoveryStore(options: { recordDeliveryError?: Error } = {}) {
    const accounts: Array<{ id: string; email: string; hid: string | null; kinds: Audience[]; emailVerified: boolean }> = [
      { id: '70000000-0000-4000-8000-000000000001', email: KNOWN_EMAIL, hid: KNOWN_HID, kinds: ['patient'], emailVerified: true },
      { id: '70000000-0000-4000-8000-000000000002', email: OTHER_EMAIL, hid: null, kinds: ['patient'], emailVerified: true },
      { id: '70000000-0000-4000-8000-000000000003', email: STAFF_EMAIL, hid: null, kinds: ['staff'], emailVerified: false },
      { id: '70000000-0000-4000-8000-000000000004', email: ADMIN_EMAIL, hid: null, kinds: ['platform'], emailVerified: false },
      { id: '70000000-0000-4000-8000-000000000005', email: UNVERIFIED_EMAIL, hid: UNVERIFIED_HID, kinds: ['patient'],
        emailVerified: false },
    ];
    const calls: SqlCall[] = [];
    const challenges: StoredChallenge[] = [];
    const cooldowns = new Map<string, { challenge_id: string; started_at: Date }>();
    const limits = new Map<string, RateRow>();
    const recorded: unknown[][] = [];
    const injected: Array<{ pattern: string; error: Error }> = [];
    const find = (id: unknown) => {
      const row = challenges.find((challenge) => challenge.id === id);
      if (!row) throw new Error(`Unknown synthetic challenge ${String(id)}`);
      return row;
    };
    const query = async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      const failure = injected.find(({ pattern }) => sql.includes(pattern));
      if (failure) throw failure.error;
      const now = Date.now();
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('from auth.accounts account')) {
        const identifier = String(values[0]);
        const account = accounts.find(({ email }) => email.toLowerCase() === identifier.toLowerCase())
          ?? accounts.find(({ hid }) => hid?.toUpperCase() === identifier.toUpperCase());
        return { rows: account ? [{ id: account.id, email: account.email, token_version: '1',
          email_verified: account.emailVerified, audience_matches: account.kinds.includes(values[1] as Audience),
          phone_enrollment_id: null, phone_ciphertext: null, phone_key_version: null }] : [] };
      }
      if (sql.includes('coalesce(blocked_until')) {
        const row = limits.get(`${values[0]}:${values[1]}`);
        return { rows: row ? [{ blocked: row.blocked_until !== null && row.blocked_until.getTime() > now }] : [] };
      }
      if (sql.includes('from auth.otp_rate_limits')) {
        const row = limits.get(`${values[0]}:${values[1]}`);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (sql.includes('insert into auth.otp_rate_limits')) {
        const [scope, bucket, windowExpired, nextCount, blocked, windowSeconds] =
          values as [string, string, boolean, number, boolean, number];
        const row = limits.get(`${scope}:${bucket}`);
        limits.set(`${scope}:${bucket}`, row ? {
          request_count: nextCount,
          window_started_at: windowExpired ? new Date(now) : row.window_started_at,
          blocked_until: blocked ? new Date(now + windowSeconds * 1000) : null,
        } : { request_count: 1, window_started_at: new Date(now), blocked_until: null });
        return { rows: [] };
      }
      if (sql.includes('from auth.otp_start_cooldowns')) {
        const row = cooldowns.get(`${values[0]}:${values[1]}`);
        return { rows: row ? [{ challenge_id: row.challenge_id,
          cooling: row.started_at.getTime() > now - Number(values[2]) * 1000 }] : [] };
      }
      if (sql.includes('insert into auth.otp_start_cooldowns')) {
        cooldowns.set(`${values[0]}:${values[1]}`, { challenge_id: String(values[2]), started_at: new Date(now) });
        return { rows: [] };
      }
      if (sql.includes('challenge.verifier_hmac')) {
        const row = challenges.find((challenge) => challenge.id === values[0] && challenge.purpose === values[1]
          && challenge.invalidated_at === null && challenge.verified_at === null);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (/^\s*select id::text, created_at/.test(sql)) {
        const row = challenges.filter((challenge) => challenge.account_id === values[0]
          && challenge.purpose === values[1] && challenge.invalidated_at === null).at(-1);
        return { rows: row ? [{ id: row.id, created_at: row.created_at,
          cooling: row.created_at.getTime() > now - Number(values[2] ?? 0) * 1000 }] : [] };
      }
      if (sql.includes("invalidation_reason = 'resend'")) {
        for (const challenge of challenges) {
          if (challenge.account_id === values[0] && challenge.purpose === values[1] && challenge.invalidated_at === null) {
            Object.assign(challenge, { invalidated_at: new Date(now), invalidation_reason: 'resend' });
          }
        }
        return { rows: [] };
      }
      if (sql.includes('insert into auth.otp_challenges')) {
        challenges.push({ id: String(values[0]), account_id: String(values[1]), recipient_hmac: String(values[2]),
          purpose: String(values[3]), verifier_hmac: String(values[5]),
          expires_at: new Date(now + Number(values[7]) * 1000), max_attempts: Number(values[8]),
          failed_attempts: 0, created_at: new Date(now), invalidated_at: null, invalidation_reason: null,
          verified_at: null });
        return { rows: [] };
      }
      if (sql.includes('failed_attempts = failed_attempts + 1')) {
        const challenge = find(values[0]);
        challenge.failed_attempts += 1;
        if (challenge.failed_attempts >= challenge.max_attempts) {
          Object.assign(challenge, { invalidated_at: new Date(now), invalidation_reason: 'attempts_exhausted' });
        }
        return { rows: [] };
      }
      if (sql.includes('set verified_at')) {
        find(values[0]).verified_at = new Date(now);
        return { rows: [] };
      }
      if (sql.includes('invalidation_reason = $2')) {
        Object.assign(find(values[0]), { invalidated_at: new Date(now), invalidation_reason: String(values[1]) });
        return { rows: [] };
      }
      throw new Error(`Unexpected recovery statement: ${sql}`);
    };
    const database = {
      withSystemTransaction: jest.fn(async (_correlation: string, work: (client: PoolClient) => Promise<unknown>) =>
        work({ query } as unknown as PoolClient)),
      query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        if (!sql.includes('set delivery_outcome')) throw new Error(`Unexpected recovery statement: ${sql}`);
        if (options.recordDeliveryError) throw options.recordDeliveryError;
        recorded.push([...values]);
        const challenge = challenges.find(({ id }) => id === values[0]);
        if (challenge && values[1] === 'definitive_failure' && challenge.invalidated_at === null) {
          Object.assign(challenge, { invalidated_at: new Date(), invalidation_reason: 'delivery_failed' });
        }
        return { rows: [] };
      }),
    };
    const shift = (date: Date, milliseconds: number) => new Date(date.getTime() - milliseconds);
    return {
      database: database as unknown as DatabaseService,
      calls, challenges, limits, recorded,
      failOn(pattern: string, error: Error) { injected.push({ pattern, error }); },
      ageCooldowns(milliseconds: number) {
        for (const row of cooldowns.values()) row.started_at = shift(row.started_at, milliseconds);
      },
      ageChallenges(milliseconds: number) {
        for (const row of challenges) row.created_at = shift(row.created_at, milliseconds);
      },
    };
  }

  function recordingNotification(outcome: OtpDeliveryOutcome = 'accepted'): RecordingNotification {
    const deliveries: Delivered[] = [];
    const deliver = jest.fn(async (input: Delivered) => {
      deliveries.push({ challengeId: input.challengeId, recipient: input.recipient, code: input.code,
        purpose: input.purpose });
      return { outcome, provider: 'ses' };
    });
    return { client: { deliver } as unknown as NotificationOtpClient, deliveries };
  }

  /** Each delivery stays in flight until `release` settles the oldest one. */
  function deferredDelivery() {
    const waiting: Array<(value: { outcome: OtpDeliveryOutcome; provider: string }) => void> = [];
    const deliver = jest.fn(() => new Promise<{ outcome: OtpDeliveryOutcome; provider: string }>((resolve) => {
      waiting.push(resolve);
    }));
    return {
      notification: { deliver } as unknown as NotificationOtpClient,
      release(outcome: OtpDeliveryOutcome) { waiting.shift()?.({ outcome, provider: 'ses' }); },
    };
  }

  function startInput(identifier: string, remoteIp = '192.0.2.40', purpose: RecoveryOtpPurpose = 'PASSWORD_RESET',
    audience: Audience = 'patient'): StartInput {
    return startArgs({ identifier, purpose, remoteIp, correlationId: 'otp-start-0001', audience });
  }

  async function startAndCapture(service: OtpService, notification: RecordingNotification, identifier: string,
    purpose: RecoveryOtpPurpose): Promise<Captured> {
    const sent = notification.deliveries.length;
    const started = await service.start(startInput(identifier, '192.0.2.70', purpose));
    const delivered = notification.deliveries[sent];
    expect(delivered?.challengeId).toBe(started.challengeId);
    return { challengeId: started.challengeId, code: delivered!.code, purpose };
  }

  function wrongCode(code: string): string {
    return code === '000000' ? '000001' : '000000';
  }
});
