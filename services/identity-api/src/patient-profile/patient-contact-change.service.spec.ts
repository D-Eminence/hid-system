import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { createContactLookupHmac } from '../identity/contact-lookup';
import { contactChangeHint, PASSWORD_FAILURES_ALLOWED, PatientContactChangeService } from './patient-contact-change.service';
import { PatientContactReader } from './patient-contact-reader';
import { PatientProfileCrypto } from './patient-profile-crypto';

// argon2's exports cannot be spied on; a wrapper counts the hash checks.
jest.mock('argon2', () => {
  const actual = jest.requireActual<typeof import('argon2')>('argon2');
  return { ...actual, verify: jest.fn((...args: Parameters<typeof actual.verify>) => actual.verify(...args)) };
});
const hashChecks = () => {
  const verify = argon2.verify as unknown as jest.Mock;
  verify.mockClear();
  return verify;
};

const originalEnvironment = { ...process.env };
const request = { actor: { kind: 'patient', patientId: 'patient-id', accountId: 'account-id', subject: 'patient-subject',
  sessionId: 'session-id' }, correlationId: 'contact-change-request', header: () => undefined } as unknown as HidRequest;
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await argon2.hash('correct horse battery', { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3,
    parallelism: 1 });
});
beforeEach(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
    NIN_ENCRYPTION_KEY_B64: randomBytes(32).toString('base64'), NIN_KEY_VERSION: 'nin-v7',
    OTP_HMAC_KEY_B64: randomBytes(32).toString('base64'), OTP_HMAC_KEY_VERSION: 'otp-v3',
    CONTACT_LOOKUP_HMAC_KEY_B64: randomBytes(32).toString('base64'),
  });
  resetEnvironmentForTests();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  resetEnvironmentForTests();
});

type Handler = (values: unknown[]) => { rows: unknown[] };

/**
 * A fake database: each withSystemTransaction is a transaction; a
 * transaction-scoped advisory lock is held until that transaction ends (as
 * in Postgres), and auth.otp_rate_limits is a table, so concurrent requests
 * meet the budget as they would.
 */
function setup(handlers: Record<string, Handler> = {}, credentials: Record<string, unknown> = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const commits: string[][] = [];
  const limits = new Map<string, { request_count: number; window_started_at: Date; blocked_until: Date | null }>();
  const locks = new Map<string, Promise<void>>();
  const transaction = async (work: (c: PoolClient) => Promise<unknown>) => {
    const held: Array<() => void> = [];
    const query = jest.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('pg_advisory_xact_lock')) {
        const key = String(values[0]);
        while (locks.has(key)) await locks.get(key);
        let release!: () => void;
        locks.set(key, new Promise<void>((resolve) => { release = () => { locks.delete(key); resolve(); }; }));
        held.push(release);
        return { rows: [] };
      }
      for (const [needle, handler] of Object.entries(handlers)) if (sql.includes(needle)) return handler(values);
      if (sql.includes('my_contact_change_credentials')) {
        return { rows: [{ account_id: 'account-id', email: 'old@example.invalid', email_verified: true,
          password_hash: passwordHash, password_algorithm: 'argon2id', patient_first_name: 'Ada',
          patient_hid_code: 'HID-ADAAAA', ...credentials }] };
      }
      // No OTP recovery in the last 24 hours.
      if (sql.includes('from auth.otp_challenges')) return { rows: [{ held: false }] };
      const bucket = `${String(values[0])}:${String(values[1])}`;
      if (sql.includes('from auth.otp_rate_limits')) {
        const row = limits.get(bucket);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (sql.includes('insert into auth.otp_rate_limits')) {
        const [, , windowExpired, nextCount, blocked, windowSeconds] = values as [string, string, boolean, number, boolean, number];
        const current = limits.get(bucket);
        limits.set(bucket, { request_count: nextCount,
          window_started_at: windowExpired || !current ? new Date() : current.window_started_at,
          blocked_until: blocked ? new Date(Date.now() + windowSeconds * 1000) : null });
        return { rows: [] };
      }
      if (sql.includes('update auth.otp_rate_limits')) {
        const row = limits.get(bucket);
        if (row && row.request_count > 0 && (!row.blocked_until || row.blocked_until.getTime() <= Date.now())) {
          row.request_count -= 1;
        }
        return { rows: [] };
      }
      return { rows: [] };
    });
    const before = calls.length;
    try {
      const answer = await work({ query } as unknown as PoolClient);
      commits.push(calls.slice(before).map((call) => call.sql));
      return answer;
    } finally {
      for (const release of held) release();
    }
  };
  const database = { withSystemTransaction: jest.fn(async (_id: string, work: (c: PoolClient) => Promise<unknown>) =>
    transaction(work)) } as unknown as DatabaseService;
  const notification = {
    deliverEmailChangeCode: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'brevo' }),
    deliverContactChanged: jest.fn().mockResolvedValue({ outcome: 'accepted' }),
  };
  const crypto = new PatientProfileCrypto();
  const service = new PatientContactChangeService(database, crypto,
    notification as unknown as NotificationOtpClient, new PatientContactReader(crypto));
  return { service, calls, commits, notification, crypto, limits };
}

async function problem(promise: Promise<unknown>): Promise<DomainProblem> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainProblem) return error;
    throw error;
  }
  throw new Error('No problem was raised');
}

describe('PatientContactChangeService (0094)', () => {
  it('starts an email change: password checked, new address encrypted and keyed, code to the new address only', async () => {
    const s = setup({ 'start_my_email_change': () => ({ rows: [{ outcome: 'started' }] }) });
    const answer = await s.service.start(request, { channel: 'email', email: ' New.Address@Example.INVALID ',
      currentPassword: 'correct horse battery' });
    expect(answer).toEqual({ changeId: expect.stringMatching(/^[0-9a-f-]{36}$/), maskedContact: 'n•••@example.invalid',
      expiresInSeconds: 300, resendAfterSeconds: 60 });
    const start = s.calls.find((call) => call.sql.includes('start_my_email_change'))!;
    const [subject, session, changeId, email, lookup, ciphertext, keyVersion, verifier, verifierVersion, ttl, attempts,
      resend] = start.values as [string, string, string, string, string, Buffer, string, string, string, number, number, number];
    expect([subject, session, email, keyVersion, verifierVersion, ttl, attempts, resend])
      .toEqual(['patient-subject', 'session-id', 'new.address@example.invalid', 'nin-v7', 'otp-v3', 300, 5, 60]);
    expect(lookup).toBe(createContactLookupHmac('email', 'new.address@example.invalid'));
    expect(s.crypto.decryptContact(changeId, 'email', 'nin-v7', ciphertext)).toBe('new.address@example.invalid');
    expect(verifier).toMatch(/^[0-9a-f]{64}$/);
    const code = (s.notification.deliverEmailChangeCode.mock.calls[0]?.[0] as { code: string }).code;
    // The new address is not yet proved to be the patient's: the code names neither them nor their Health ID.
    expect(s.notification.deliverEmailChangeCode).toHaveBeenCalledWith({ changeId, recipient: 'new.address@example.invalid',
      code, expiresInMinutes: 5, correlationId: 'contact-change-request' });
    expect(verifier).toBe(s.crypto.codeVerifier(changeId, code));
    expect(s.calls.find((call) => call.sql.includes('record_my_contact_change_delivery'))?.values)
      .toEqual(['patient-subject', 'session-id', changeId, 'accepted', 'brevo']);
    expect(JSON.stringify(s.calls.map((call) => call.values))).not.toContain(code);
  });

  it('counts a wrong password (403 PASSWORD_INCORRECT), blocks after the budget (429), and needs a password (409)', async () => {
    const wrong = setup();
    const refused = await problem(wrong.service.start(request, { channel: 'email', email: 'n@example.invalid',
      currentPassword: 'not the password' }));
    expect([refused.getStatus(), refused.code]).toEqual([403, 'PASSWORD_INCORRECT']);
    // Counted in the transaction that read the credentials, before the hash was checked.
    expect(wrong.commits).toHaveLength(1);
    expect(wrong.commits[0]?.some((sql) => sql.includes('insert into auth.otp_rate_limits'))).toBe(true);
    expect([...wrong.limits.values()].map((row) => row.request_count)).toEqual([1]);
    expect(wrong.calls.some((call) => call.sql.includes('start_my_email_change'))).toBe(false);

    const blocked = setup({ 'from auth.otp_rate_limits': () => ({ rows: [{ request_count: 5,
      window_started_at: new Date(), blocked_until: new Date(Date.now() + 60_000) }] }) });
    const verify = hashChecks();
    const limited = await problem(blocked.service.start(request, { channel: 'phone', phone: '08031234567',
      currentPassword: 'correct horse battery' }));
    expect([limited.getStatus(), limited.code]).toEqual([429, 'CONTACT_CHANGE_RATE_LIMITED']);
    expect(verify).not.toHaveBeenCalled();

    const google = setup({}, { password_hash: null, password_algorithm: null });
    const required = await problem(google.service.start(request, { channel: 'email', email: 'n@example.invalid',
      currentPassword: 'anything at all' }));
    expect([required.getStatus(), required.code, required.message])
      .toEqual([409, 'PASSWORD_REQUIRED', 'Set a password first to change your contact details.']);
  });

  it('checks at most four passwords however many requests arrive at once, and a right one gives its count back', async () => {
    const s = setup();
    const verify = hashChecks();
    const answers = await Promise.all(Array.from({ length: 12 }, (_, index) => problem(s.service.start(request,
      { channel: 'email', email: 'n@example.invalid', currentPassword: `guess ${index}` }))));
    expect(verify).toHaveBeenCalledTimes(PASSWORD_FAILURES_ALLOWED);
    expect(answers.filter((answer) => answer.code === 'PASSWORD_INCORRECT')).toHaveLength(PASSWORD_FAILURES_ALLOWED);
    expect(answers.filter((answer) => answer.getStatus() === 429)).toHaveLength(12 - PASSWORD_FAILURES_ALLOWED);

    // Right passwords are not counted: a patient who knows theirs is never blocked by their own changes.
    const right = setup({ 'start_my_email_change': () => ({ rows: [{ outcome: 'started' }] }) });
    for (let attempt = 0; attempt < PASSWORD_FAILURES_ALLOWED + 2; attempt += 1) {
      await right.service.start(request, { channel: 'email', email: 'n@example.invalid',
        currentPassword: 'correct horse battery' });
    }
    expect([...right.limits.values()].map((row) => [row.request_count, row.blocked_until])).toEqual([[0, null]]);
  });

  it('holds email and phone changes for 24 hours after an OTP recovery, before the password is checked', async () => {
    for (const input of [{ channel: 'email', email: 'n@example.invalid' }, { channel: 'phone', phone: '08031234567' }]) {
      const s = setup({ 'from auth.otp_challenges': () => ({ rows: [{ held: true }] }) });
      const verify = hashChecks();
      const held = await problem(s.service.start(request, { ...input, currentPassword: 'correct horse battery' } as never));
      expect([held.getStatus(), held.code]).toEqual([403, 'PATIENT_RECENT_RECOVERY_HOLD']);
      expect(held.message).toContain('email and phone number changes are available again');
      expect(s.calls.find((call) => call.sql.includes('from auth.otp_challenges'))?.values).toEqual(['account-id', 24]);
      expect(verify).not.toHaveBeenCalled();
      expect(s.limits.size).toBe(0);
      expect(s.calls.some((call) => /start_my_email_change|change_my_phone/.test(call.sql))).toBe(false);
      }
    // A change started before the recovery cannot be finished during the hold.
    const s = setup({ 'from auth.otp_challenges': () => ({ rows: [{ held: true }] }) });
    const held = await problem(s.service.verify(request, '1b2c3d4e-0000-4000-8000-000000000001', '123456'));
    expect([held.getStatus(), held.code]).toEqual([403, 'PATIENT_RECENT_RECOVERY_HOLD']);
    expect(s.calls.some((call) => /read_my_pending_email_change|complete_my_email_change/.test(call.sql))).toBe(false);
    // No answer is a hold (fails closed).
    const unknown = setup({ 'from auth.otp_challenges': () => ({ rows: [] }) });
    const closed = await problem(unknown.service.start(request, { channel: 'phone', phone: '08031234567',
      currentPassword: 'correct horse battery' }));
    expect(closed.code).toBe('PATIENT_RECENT_RECOVERY_HOLD');
  });

  it('refuses a patient account that is also a staff login, at the start and at completion (409)', async () => {
    const start = setup({ 'start_my_email_change': () => ({ rows: [{ outcome: 'workforce' }] }) });
    const refused = await problem(start.service.start(request, { channel: 'email', email: 'n@example.invalid',
      currentPassword: 'correct horse battery' }));
    expect([refused.getStatus(), refused.code]).toEqual([409, 'CONTACT_CHANGE_STAFF_ACCOUNT']);
    expect(start.notification.deliverEmailChangeCode).not.toHaveBeenCalled();
    const complete = setup({ 'complete_my_email_change': () => ({ rows: [{ outcome: 'workforce', email: null,
      previous_email: null, patient_first_name: null, patient_hid_code: null }] }) });
    const late = await problem(complete.service.verify(request, '1b2c3d4e-0000-4000-8000-000000000001', '123456'));
    expect([late.getStatus(), late.code]).toEqual([409, 'CONTACT_CHANGE_STAFF_ACCOUNT']);
    expect(complete.notification.deliverContactChanged).not.toHaveBeenCalled();
  });

  it('masks the new address for the notice from safe characters, whatever its spelling', () => {
    // notification-api's MASKED_CONTACT (deliver-patient-emails.dto.ts); contact-change-emails.spec.ts admits these strings.
    const masked = /^(?:[A-Za-z0-9]?•••@[A-Za-z0-9.•-]{1,253}|\+[0-9]{1,3}•••••[0-9]{3})$/u;
    const cases: Array<[string, string]> = [
      ['new.address@example.invalid', 'n•••@example.invalid'],
      ['&x@attacker.example', '•••@attacker.example'],
      ["'x@attacker.example", '•••@attacker.example'],
      ['+x@attacker.example', '•••@attacker.example'],
      ['x@mail_host.attacker.example', 'x•••@mail•host.attacker.example'],
      ['x@bücher.example', 'x•••@xn--bcher-kva.example'],
      ['x@a&b.example', 'x•••@a•b.example'],
    ];
    for (const [email, hint] of cases) {
      expect(contactChangeHint(email)).toBe(hint);
      expect(masked.test(contactChangeHint(email))).toBe(true);
    }
    const long = `x@${'a'.repeat(240)}.${'b'.repeat(10)}`;
    expect(masked.test(contactChangeHint(long))).toBe(true);
    expect(contactChangeHint('x@a<b>.example')).toMatch(masked);
  });

  it('accepts a migrated hid-1.0 bcrypt password', async () => {
    const legacyHash = await bcrypt.hash('legacy password 1', 4);
    const s = setup({ 'change_my_phone': () => ({ rows: [{ outcome: 'changed', notice_email: null,
      patient_first_name: null, patient_hid_code: null }] }) }, { password_hash: legacyHash, password_algorithm: 'bcrypt_legacy' });
    await expect(s.service.start(request, { channel: 'phone', phone: '+44 7700 900123', currentPassword: 'legacy password 1' }))
      .resolves.toEqual({ phone: '+447700900123', phoneVerified: false });
    expect(s.notification.deliverContactChanged).not.toHaveBeenCalled();
  });

  it('maps unchanged, rate-limited and unavailable starts, and an undeliverable code', async () => {
    for (const [outcome, status, code] of [['unchanged', 400, 'CONTACT_UNCHANGED'],
      ['rate_limited', 429, 'CONTACT_CHANGE_RATE_LIMITED'], ['unavailable', 409, 'CONTACT_UNAVAILABLE']] as const) {
      const s = setup({ 'start_my_email_change': () => ({ rows: [{ outcome }] }) });
      const refused = await problem(s.service.start(request, { channel: 'email', email: 'x@example.invalid',
        currentPassword: 'correct horse battery' }));
      expect([refused.getStatus(), refused.code]).toEqual([status, code]);
      if (outcome === 'unavailable') expect(refused.message).toBe("That email address or phone number can't be used.");
      expect(s.notification.deliverEmailChangeCode).not.toHaveBeenCalled();
    }
    const s = setup({ 'start_my_email_change': () => ({ rows: [{ outcome: 'started' }] }) });
    s.notification.deliverEmailChangeCode.mockResolvedValue({ outcome: 'definitive_failure' });
    const undeliverable = await problem(s.service.start(request, { channel: 'email', email: 'x@example.invalid',
      currentPassword: 'correct horse battery' }));
    expect([undeliverable.getStatus(), undeliverable.code]).toEqual([422, 'CONTACT_CODE_UNDELIVERABLE']);
    expect(s.calls.find((call) => call.sql.includes('record_my_contact_change_delivery'))?.values[3]).toBe('definitive_failure');
  });

  it('refuses a malformed or mixed body before reading the password', async () => {
    for (const input of [{ channel: 'email', email: 'not-an-email' }, { channel: 'email', phone: '+447700900123' },
      { channel: 'phone', phone: '12345' }, { channel: 'phone', email: 'a@example.invalid', phone: '+447700900123' }]) {
      const s = setup();
      const refused = await problem(s.service.start(request, { ...input, currentPassword: 'x' } as never));
      expect([refused.getStatus(), refused.code]).toEqual([400, 'CONTACT_INVALID']);
      expect(s.calls).toHaveLength(0);
    }
  });

  it('changes the phone at once: both stored forms of a Nigerian number, then tells the verified email', async () => {
    const s = setup({ 'change_my_phone': () => ({ rows: [{ outcome: 'changed', notice_email: 'old@example.invalid',
      patient_first_name: 'Ada', patient_hid_code: 'HID-ADAAAA' }] }) });
    await expect(s.service.start(request, { channel: 'phone', phone: '0803 123 4567', currentPassword: 'correct horse battery' }))
      .resolves.toEqual({ phone: '+2348031234567', phoneVerified: false });
    const change = s.calls.find((call) => call.sql.includes('change_my_phone'))!;
    // The profile showed no phone (none could be read): the same number would be written again.
    expect(change.values[7]).toBe(true);
    expect(change.values[3]).toBe(createContactLookupHmac('phone', '+2348031234567'));
    expect(change.values[4]).toEqual([createContactLookupHmac('phone', '+23408031234567')]);
    expect(s.crypto.decryptContact(change.values[2] as string, 'phone', 'nin-v7', change.values[5] as Buffer))
      .toBe('+2348031234567');
    await s.service.settleNotices();
    expect(s.notification.deliverContactChanged).toHaveBeenCalledWith(expect.objectContaining({
      recipient: 'old@example.invalid', kind: 'phone', newContactHint: '+234•••••567', firstName: 'Ada',
      healthId: 'HID-ADAAAA', changeId: change.values[2] }));
  });

  it('refuses the number the profile shows (400, nothing sent), rewrites one it could not show, refuses another patient\'s', async () => {
    const crypto = new PatientProfileCrypto();
    const shownId = '1b2c3d4e-0000-4000-8000-0000000000aa';
    const shown = crypto.encryptContact(shownId, 'phone', '+447700900123');
    const same = setup({
      'patient_self_contact': () => ({ rows: [{ email: 'old@example.invalid', email_verified: true, phone_ciphertext: shown,
        phone_lookup_hmac: 'a'.repeat(64), phone_change_id: shownId, phone_change_key_version: 'nin-v7', has_photo: false }] }),
      'change_my_phone': () => ({ rows: [{ outcome: 'unchanged', notice_email: null, patient_first_name: null,
        patient_hid_code: null }] }),
    });
    const unchanged = await problem(same.service.start(request, { channel: 'phone', phone: '+447700900123',
      currentPassword: 'correct horse battery' }));
    expect([unchanged.getStatus(), unchanged.code, unchanged.message])
      .toEqual([400, 'CONTACT_UNCHANGED', 'That is already the phone number on your account.']);
    expect(same.calls.find((call) => call.sql.includes('change_my_phone'))?.values[7]).toBe(false);
    await same.service.settleNotices();
    expect(same.notification.deliverContactChanged).not.toHaveBeenCalled();

    // A migrated number Identity cannot read (the profile shows none) is written again, as a change, and announced.
    const migrated = setup({
      'patient_self_contact': () => ({ rows: [{ email: 'old@example.invalid', email_verified: true,
        phone_ciphertext: Buffer.alloc(40, 7), phone_lookup_hmac: 'a'.repeat(64), phone_change_id: null,
        phone_change_key_version: null, has_photo: false }] }),
      'change_my_phone': () => ({ rows: [{ outcome: 'changed', notice_email: 'old@example.invalid',
        patient_first_name: 'Ada', patient_hid_code: 'HID-ADAAAA' }] }),
    });
    await expect(migrated.service.start(request, { channel: 'phone', phone: '+447700900123',
      currentPassword: 'correct horse battery' })).resolves.toEqual({ phone: '+447700900123', phoneVerified: false });
    expect(migrated.calls.find((call) => call.sql.includes('change_my_phone'))?.values[7]).toBe(true);
    await migrated.service.settleNotices();
    expect(migrated.notification.deliverContactChanged).toHaveBeenCalledWith(expect.objectContaining({
      recipient: 'old@example.invalid', kind: 'phone', newContactHint: '+447•••••123' }));

    const taken = setup({ 'change_my_phone': () => ({ rows: [{ outcome: 'unavailable', notice_email: null,
      patient_first_name: null, patient_hid_code: null }] }) });
    const refused = await problem(taken.service.start(request, { channel: 'phone', phone: '+447700900123',
      currentPassword: 'correct horse battery' }));
    expect([refused.getStatus(), refused.code]).toEqual([409, 'CONTACT_UNAVAILABLE']);
  });

  it('completes an email change with the code and tells the old address; a wrong code is 400 after it is counted', async () => {
    const crypto = new PatientProfileCrypto();
    const changeId = '1b2c3d4e-0000-4000-8000-000000000001';
    const pending = crypto.encryptContact(changeId, 'email', 'new@example.invalid');
    const s = setup({
      'read_my_pending_email_change': () => ({ rows: [{ new_ciphertext: pending, key_version: 'nin-v7' }] }),
      'complete_my_email_change': () => ({ rows: [{ outcome: 'completed', email: 'new@example.invalid',
        previous_email: 'Old@Example.invalid', patient_first_name: 'Ada', patient_hid_code: 'HID-ADAAAA' }] }),
    });
    await expect(s.service.verify(request, changeId, '123456')).resolves.toEqual({ email: 'new@example.invalid' });
    const complete = s.calls.find((call) => call.sql.includes('complete_my_email_change'))!;
    expect(complete.values).toEqual(['patient-subject', 'session-id', changeId, s.crypto.codeVerifier(changeId, '123456'),
      'new@example.invalid']);
    await s.service.settleNotices();
    expect(s.notification.deliverContactChanged).toHaveBeenCalledWith(expect.objectContaining({
      recipient: 'old@example.invalid', kind: 'email', newContactHint: 'n•••@example.invalid' }));
    // The hold was read in the transaction that completed the change, before it.
    const completing = s.commits.find((sqls) => sqls.some((sql) => sql.includes('complete_my_email_change')))!;
    expect(completing.findIndex((sql) => sql.includes('from auth.otp_challenges')))
      .toBeLessThan(completing.findIndex((sql) => sql.includes('complete_my_email_change')));

    // An address of any spelling still gets its notice: the hint is built from safe characters.
    const odd = setup({
      'read_my_pending_email_change': () => ({ rows: [{ new_ciphertext: crypto.encryptContact(changeId, 'email',
        '&x@mail_host.attacker.example'), key_version: 'nin-v7' }] }),
      'complete_my_email_change': () => ({ rows: [{ outcome: 'completed', email: '&x@mail_host.attacker.example',
        previous_email: 'old@example.invalid', patient_first_name: 'Ada', patient_hid_code: 'HID-ADAAAA' }] }),
    });
    await odd.service.verify(request, changeId, '123456');
    await odd.service.settleNotices();
    expect(odd.notification.deliverContactChanged).toHaveBeenCalledWith(expect.objectContaining({
      recipient: 'old@example.invalid', kind: 'email', newContactHint: '•••@mail•host.attacker.example' }));

    for (const [outcome, status, code] of [['invalid', 400, 'OTP_INVALID_OR_EXPIRED'], ['expired', 400, 'OTP_INVALID_OR_EXPIRED'],
      ['unavailable', 409, 'CONTACT_UNAVAILABLE']] as const) {
      const wrong = setup({ 'complete_my_email_change': () => ({ rows: [{ outcome, email: null, previous_email: null,
        patient_first_name: null, patient_hid_code: null }] }) });
      const refused = await problem(wrong.service.verify(request, changeId, '000000'));
      expect([refused.getStatus(), refused.code]).toEqual([status, code]);
      // The transaction that counted the attempt returned (committed) before the refusal.
      expect(wrong.commits.some((sqls) => sqls.some((sql) => sql.includes('complete_my_email_change')))).toBe(true);
      expect(wrong.notification.deliverContactChanged).not.toHaveBeenCalled();
    }
  });
});
