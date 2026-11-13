jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { createHmac } from 'node:crypto';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import type { WorkloadAuthService } from '../auth/workload-auth.service';
import { DomainProblem } from '../common/problem';
import type { ActorContext, DataAccessContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { createContactLookupHmac } from './contact-lookup';
import type { HidCodeGenerator } from './hid-code-generator.service';
import { OutreachHealthIdController } from './outreach-health-id.controller';
import { emailHint, OutreachHealthIdService } from './outreach-health-id.service';
import { PatientProfileCrypto } from '../patient-profile/patient-profile-crypto';
import { contactKeyForVersion, currentContactEncryption, decryptContactValue,
  encryptContactValue } from './patient-contact-crypto';

// Assisted Health ID at an outreach (0119) on a fake database and notification
// client. Synthetic people and Health IDs only.
const OTP_KEY = Buffer.alloc(32, 7).toString('base64');
const CONTACT_KEY = Buffer.alloc(32, 9).toString('base64');
const NIN_KEY = Buffer.alloc(32, 11).toString('base64');
const caseId = '7c1e2d3f-4a5b-4c6d-8e7f-901a2b3c4d5e';
const facilityId = '10000000-0000-4000-8000-00000000000a';
const membershipId = '40000000-0000-4000-8000-00000000000a';

const actor = {
  id: 'staff:volunteer', subject: 'staff:volunteer', accountId: '20000000-0000-4000-8000-000000000001', kind: 'staff',
  roles: ['outreach_volunteer'], permissions: ['outreach.registration.read', 'outreach.registration.write'],
  facilityIds: [facilityId], facilities: [], authenticationMethod: 'local',
} as unknown as ActorContext;
const context: DataAccessContext = { correlationId: 'outreach-health-id-test', actor, facilityId, membershipId,
  purposeOfUse: 'direct-care' };

interface Registration {
  registration_case_id: string; facility_id: string; full_name: string; sex: string; age_years: number;
  phone: string | null; group_name: string | null; existing_hid_code: string | null;
}

function pgError(message: string, code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

describe('OutreachHealthIdService (0119)', () => {
  const original = { ...process.env };
  let registration: Registration;
  let open: Record<string, unknown> | undefined;
  let bound: Record<string, boolean>;
  let startResult: () => unknown;
  let confirmResult: (parameters: unknown[]) => unknown;
  let rateBlocked: boolean;
  const blockedBuckets = new Set<string>();
  const queries: { sql: string; parameters: unknown[]; system: boolean }[] = [];
  const notification = { deliverOutreachHealthIdCode: jest.fn() };
  const hidCodes = { generate: jest.fn() };

  function client(system: boolean) {
    return {
      query: jest.fn(async (sql: string, parameters: unknown[] = []) => {
        queries.push({ sql, parameters, system });
        if (sql.includes('outreach_health_id_registration(')) return { rows: [registration] };
        if (sql.includes('outreach_health_id_open_challenge(')) return { rows: open ? [open] : [] };
        if (sql.includes('outreach_health_id_start(')) {
          const value = startResult();
          return { rows: value ? [value] : [] };
        }
        if (sql.includes('outreach_health_id_confirm(')) return { rows: [confirmResult(parameters)] };
        if (sql.includes('outreach_health_id_delivery_failed(')) return { rows: [] };
        if (sql.includes('patient_contact_lookup_ready')) return { rows: [{ ready: true }] };
        if (sql.includes('public_patient_contact_already_bound')) {
          return { rows: [{ bound: bound[`${parameters[0]}:${parameters[1]}`] === true }] };
        }
        if (sql.includes('from auth.otp_rate_limits')) {
          const blocked = rateBlocked || blockedBuckets.has(String(parameters[1]));
          return { rows: blocked ? [{ request_count: 1, window_started_at: new Date(),
            blocked_until: new Date(Date.now() + 60_000) }] : [] };
        }
        return { rows: [] };
      }),
    };
  }
  const database = {
    withTransaction: jest.fn(async (_context: DataAccessContext, operation: (c: unknown) => Promise<unknown>) =>
      operation(client(false))),
    withSystemTransaction: jest.fn(async (_correlationId: string, operation: (c: unknown) => Promise<unknown>) =>
      operation(client(true))),
  };

  function service() {
    return new OutreachHealthIdService(database as unknown as DatabaseService,
      notification as unknown as NotificationOtpClient, hidCodes as unknown as HidCodeGenerator);
  }

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid', DATABASE_SSL: 'false',
      CORS_ORIGINS: 'https://outreach.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      STORAGE_MODE: 'disabled', OTP_HMAC_KEY_B64: OTP_KEY, OTP_HMAC_KEY_VERSION: 'otp-v3',
      CONTACT_LOOKUP_HMAC_KEY_B64: CONTACT_KEY, NIN_ENCRYPTION_KEY_B64: NIN_KEY, NIN_KEY_VERSION: 'nin-v2',
      OTP_EXPIRY_SECONDS: '600', OTP_MAX_ATTEMPTS: '5',
    });
    resetEnvironmentForTests();
    queries.length = 0;
    registration = { registration_case_id: caseId, facility_id: facilityId, full_name: 'Ada Example', sex: 'female',
      age_years: 34, phone: '08012345678', group_name: 'Lagos Health Walk', existing_hid_code: null };
    open = undefined;
    bound = {};
    rateBlocked = false;
    startResult = () => ({ challenge_id: queries.find((q) => q.sql.includes('outreach_health_id_start('))?.parameters[1],
      expires_at: new Date('2026-11-14T08:10:00Z') });
    confirmResult = () => ({ outcome: 'created', hid_code: 'HID-AB2CD3', patient_id: 'p' });
    notification.deliverOutreachHealthIdCode.mockReset().mockResolvedValue({ outcome: 'accepted' });
    hidCodes.generate.mockReset().mockReturnValue('HID-AB2CD3');
    database.withTransaction.mockClear();
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  async function refusal(promise: Promise<unknown>): Promise<DomainProblem> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof DomainProblem) return error;
      throw error;
    }
    throw new Error('expected a refusal');
  }

  describe('start', () => {
    it('stores the keyed verifier, the encrypted email and both lookups, then emails the code with the group', async () => {
      const answer = await service().start({ caseId, channel: 'email', email: '  Ada.Example@Example.TEST ' }, context);
      expect(answer).toEqual({ channel: 'email', expiresAt: '2026-11-14T08:10:00.000Z',
        destinationHint: 'a***@example.test', resendAfterSeconds: 60 });
      const call = queries.find((q) => q.sql.includes('outreach_health_id_start('))!;
      expect(call.system).toBe(false);
      const [requestedCase, challengeId, email, emailLookup, ciphertext, phoneLookup, keyVersion, verifier,
        verifierVersion, ttl, attempts] = call.parameters as [string, string, string, string, Buffer, string, string,
        string, string, number, number];
      expect(requestedCase).toBe(caseId);
      expect(email).toBe('ada.example@example.test');
      expect(emailLookup).toBe(createContactLookupHmac('email', 'ada.example@example.test'));
      expect(phoneLookup).toBe(createContactLookupHmac('phone', '+2348012345678'));
      expect(keyVersion).toBe('nin-v2');
      expect(decryptContactValue(contactKeyForVersion(process.env as never, keyVersion)!, challengeId, 'contact',
        ciphertext)).toBe('ada.example@example.test');
      expect(verifierVersion).toBe('otp-v3');
      expect([ttl, attempts]).toEqual([600, 5]);
      const delivery = notification.deliverOutreachHealthIdCode.mock.calls[0][0];
      expect(delivery).toEqual({ challengeId, recipient: 'ada.example@example.test', code: expect.stringMatching(/^\d{6}$/),
        groupName: 'Lagos Health Walk', expiresInMinutes: 10, correlationId: context.correlationId });
      expect(verifier).toBe(service().verifier(caseId, challengeId, delivery.code));
      expect(JSON.stringify(call.parameters)).not.toContain(delivery.code);
    });

    it('passes no phone lookup when the registration has no phone (the phone is optional)', async () => {
      registration.phone = null;
      await service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context);
      const call = queries.find((q) => q.sql.includes('outreach_health_id_start('))!;
      expect(call.parameters[5]).toBeNull();
      expect(queries.some((q) => q.sql.includes('already_bound') && q.parameters[0] === 'phone')).toBe(false);
    });

    it('answers SMS 503 and a bad email 422 before reading anything', async () => {
      expect(await refusal(service().start({ caseId, channel: 'sms' }, context))).toMatchObject({
        code: 'OUTREACH_HEALTH_ID_UNAVAILABLE', status: 503,
        message: "Codes by SMS aren't available yet. Use the person's email." });
      for (const email of [undefined, '', 'not-an-email', `${'a'.repeat(250)}@x.io`]) {
        expect((await refusal(service().start({ caseId, channel: 'email', email }, context))).code)
          .toBe('OUTREACH_HEALTH_ID_EMAIL_INVALID');
      }
      expect(queries).toHaveLength(0);
    });

    it('refuses an existing Health ID with it, an under-18 and an invalid phone, before sending', async () => {
      registration.existing_hid_code = 'HID-ZZ9YY8';
      const created = await refusal(service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context));
      expect(created).toMatchObject({ code: 'OUTREACH_HEALTH_ID_ALREADY_CREATED', status: 409,
        extensions: { healthId: 'HID-ZZ9YY8' } });
      registration.existing_hid_code = null;
      registration.age_years = 16;
      expect(await refusal(service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context)))
        .toMatchObject({ code: 'OUTREACH_HEALTH_ID_UNDER_18', status: 422 });
      registration.age_years = 30;
      registration.phone = '12';
      expect((await refusal(service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context))).code)
        .toBe('OUTREACH_HEALTH_ID_PHONE_INVALID');
      expect(notification.deliverOutreachHealthIdCode).not.toHaveBeenCalled();
    });

    it('answers the same 202 for an email already on a patient and a fresh one, and never looks the email up', async () => {
      const answer = async (email: string) => {
        queries.length = 0;
        startResult = () => ({ challenge_id: 'x', expires_at: new Date('2026-11-14T08:10:00Z') });
        const result = await service().start({ caseId, channel: 'email', email }, context);
        return { result, statements: queries.filter((q) => !q.sql.includes('outreach_health_id_start('))
          .map((q) => q.sql) };
      };
      bound[`email:${createContactLookupHmac('email', 'taken@example.test')}`] = true;
      const taken = await answer('taken@example.test');
      const fresh = await answer('fresh@example.test');
      expect(taken.result).toEqual({ channel: 'email', expiresAt: '2026-11-14T08:10:00.000Z',
        destinationHint: 't***@example.test', resendAfterSeconds: 60 });
      expect({ ...taken.result, destinationHint: '' }).toEqual({ ...fresh.result, destinationHint: '' });
      // The same statements on the same path, and none of them an email lookup.
      expect(taken.statements).toEqual(fresh.statements);
      expect(queries.some((q) => q.sql.includes('already_bound') && q.parameters[0] === 'email')).toBe(false);
      expect(notification.deliverOutreachHealthIdCode).toHaveBeenCalledTimes(2);
    });

    it('refuses a phone (any stored form) already on a Health ID', async () => {
      bound = { [`phone:${createContactLookupHmac('phone', '+23408012345678')}`]: true };
      expect(await refusal(service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context)))
        .toMatchObject({ code: 'OUTREACH_HEALTH_ID_PHONE_TAKEN', status: 409 });
    });

    it('answers 429 with a retry time when the volunteer or recipient window is spent', async () => {
      rateBlocked = true;
      expect(await refusal(service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context)))
        .toMatchObject({ code: 'OUTREACH_HEALTH_ID_TOO_MANY_CODES', status: 429,
          extensions: { retryAfterSeconds: expect.any(Number) } });
    });

    it.each([
      ['OUTREACH_REGISTRATION_NOT_FOUND', '42501', 404], ['OUTREACH_REGISTRATION_REDACTED', '55000', 409],
      ['OUTREACH_HEALTH_ID_NOT_AVAILABLE', '42501', 403], ['OUTREACH_ORGANISER_SUSPENDED', '55000', 423],
      ['OUTREACH_HEALTH_ID_TOO_MANY_CODES', 'P0001', 429],
      ['OUTREACH_HEALTH_ID_REQUEST_USED', '55000', 409],
      ['OUTREACH_HEALTH_ID_PHONE_TAKEN', '23505', 409], ['OUTREACH_HEALTH_ID_EMAIL_INVALID', '22023', 422],
      ['OUTREACH_HEALTH_ID_NAME_INVALID', '23514', 422],
    ])('maps the database refusal %s (%s) to %d', async (message, sqlstate, status) => {
      startResult = () => { throw pgError(message, sqlstate); };
      expect(await refusal(service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context)))
        .toMatchObject({ code: message, status });
    });

    it('ends the code and answers 503 when the email definitively fails', async () => {
      notification.deliverOutreachHealthIdCode.mockResolvedValue({ outcome: 'definitive_failure' });
      expect(await refusal(service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context)))
        .toMatchObject({ code: 'OUTREACH_HEALTH_ID_UNAVAILABLE', status: 503 });
      const challengeId = queries.find((q) => q.sql.includes('outreach_health_id_start('))!.parameters[1];
      expect(queries.find((q) => q.sql.includes('delivery_failed'))?.parameters).toEqual([challengeId]);
    });

    it('refuses a volunteer past the configurable daily limit, after the short window', async () => {
      const dayBucket = createHmac('sha256', Buffer.from(OTP_KEY, 'base64'))
        .update(['outreach-health-id-volunteer-day', actor.accountId].join('\u001f')).digest('hex');
      blockedBuckets.add(dayBucket);
      try {
        expect(await refusal(service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context)))
          .toMatchObject({ code: 'OUTREACH_HEALTH_ID_TOO_MANY_CODES', status: 429,
            message: 'You have sent too many codes today. Try again tomorrow.' });
        expect(notification.deliverOutreachHealthIdCode).not.toHaveBeenCalled();
      } finally {
        blockedBuckets.clear();
      }
    });

    it('answers the short rate windows with their own words and wait, and maps the cross-registration caps', async () => {
      rateBlocked = true;
      const windowed = await refusal(service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context));
      expect(windowed).toMatchObject({ code: 'OUTREACH_HEALTH_ID_TOO_MANY_CODES', status: 429 });
      expect(windowed.message).toMatch(/^Too many codes were sent just now\. Try again in \d+ minutes?\.$/);
      expect(windowed.extensions).toMatchObject({ retryAfterSeconds: expect.any(Number) });
      rateBlocked = false;
      startResult = () => { throw pgError('OUTREACH_HEALTH_ID_TOO_MANY_CODES', 'P0001', { detail: 'email_daily' }); };
      expect(await refusal(service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context)))
        .toMatchObject({ code: 'OUTREACH_HEALTH_ID_TOO_MANY_CODES', status: 429,
          message: 'Too many codes were sent to this email today. Try again tomorrow, or use another email.' });
      startResult = () => { throw pgError('OUTREACH_HEALTH_ID_TOO_MANY_CODES', 'P0001', { detail: 'volunteer_daily' }); };
      expect(await refusal(service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context)))
        .toMatchObject({ code: 'OUTREACH_HEALTH_ID_TOO_MANY_CODES', status: 429,
          message: 'You have sent too many codes today. Try again tomorrow.' });
    });

    it('tells the daily limit from the cooldown, and a used request id', async () => {
      startResult = () => { throw pgError('OUTREACH_HEALTH_ID_TOO_MANY_CODES', 'P0001', { detail: 'daily' }); };
      const daily = await refusal(service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context));
      expect(daily).toMatchObject({ code: 'OUTREACH_HEALTH_ID_TOO_MANY_CODES',
        message: 'Too many codes for this person today. Try again tomorrow.' });
      expect(daily.extensions).toBeUndefined();
      startResult = () => { throw pgError('OUTREACH_HEALTH_ID_TOO_MANY_CODES', 'P0001', { detail: 'cooldown:42' }); };
      const cooldown = await refusal(service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context));
      expect(cooldown).toMatchObject({ code: 'OUTREACH_HEALTH_ID_TOO_MANY_CODES',
        message: 'Wait a minute before sending another code.', extensions: { retryAfterSeconds: 42 } });
      expect(cooldown.getStatus()).toBe(429);
      startResult = () => { throw pgError('OUTREACH_HEALTH_ID_REQUEST_USED', '55000'); };
      const used = await refusal(service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context));
      expect(used).toMatchObject({ code: 'OUTREACH_HEALTH_ID_REQUEST_USED',
        message: 'This request was already used. Start again to send a new code.' });
      expect(used.getStatus()).toBe(409);
    });

    it('does not answer a retried key with an expired code: the start goes on and the used id is refused', async () => {
      const key = 'outreach-health-id-key-0002';
      await service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context, key);
      const challengeId = queries.find((q) => q.sql.includes('outreach_health_id_start('))!.parameters[1];
      open = { challenge_id: challengeId, expires_at: new Date(Date.now() - 1000) };
      queries.length = 0;
      startResult = () => { throw pgError('OUTREACH_HEALTH_ID_REQUEST_USED', '55000'); };
      expect((await refusal(service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context, key))).code)
        .toBe('OUTREACH_HEALTH_ID_REQUEST_USED');
      expect(queries.find((q) => q.sql.includes('outreach_health_id_start('))?.parameters[1]).toBe(challengeId);
      expect(notification.deliverOutreachHealthIdCode).toHaveBeenCalledTimes(1);
    });

    it('answers a retry with the same Idempotency-Key again without sending another code', async () => {
      const key = 'outreach-health-id-key-0001';
      await service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context, key);
      const challengeId = queries.find((q) => q.sql.includes('outreach_health_id_start('))!.parameters[1];
      open = { challenge_id: challengeId, expires_at: new Date('2026-11-14T08:10:00Z') };
      queries.length = 0;
      await expect(service().start({ caseId, channel: 'email', email: 'ada@example.test' }, context, key))
        .resolves.toMatchObject({ expiresAt: '2026-11-14T08:10:00.000Z', destinationHint: 'a***@example.test' });
      expect(queries.some((q) => q.sql.includes('outreach_health_id_start('))).toBe(false);
      expect(notification.deliverOutreachHealthIdCode).toHaveBeenCalledTimes(1);
    });
  });

  describe('confirm', () => {
    const challengeId = '0b7e4c2a-9d1f-4e6b-8a3c-5f2d1e0c9b8a';
    function openChallenge(email = 'ada@example.test') {
      const encryption = currentContactEncryption(process.env as never);
      open = { challenge_id: challengeId, expires_at: new Date(Date.now() + 60_000), verifier_key_version: 'otp-v3',
        email_ciphertext: encryptContactValue(encryption.key, challengeId, 'contact', email),
        key_version: encryption.version };
    }

    it('creates the Health ID from the decrypted email and the keyed verifier, and never sends the unproven phone', async () => {
      openChallenge();
      await expect(service().confirm({ caseId, code: '123456' }, context))
        .resolves.toEqual({ healthId: 'HID-AB2CD3', outcome: 'created' });
      const call = queries.find((q) => q.sql.includes('outreach_health_id_confirm('))!;
      expect(call.sql).toContain('outreach_health_id_confirm($1,$2,$3,$4,$5)');
      expect(call.parameters).toHaveLength(5);
      const [requestedCase, requestedChallenge, verifier, email, hid] = call.parameters as [string, string, string, string, string];
      expect([requestedCase, requestedChallenge, email, hid]).toEqual([caseId, challengeId, 'ada@example.test', 'HID-AB2CD3']);
      expect(verifier).toBe(createHmac('sha256', Buffer.from(OTP_KEY, 'base64'))
        .update(['outreach-health-id-otp', caseId, challengeId, '123456'].join('\u001f')).digest('hex'));
      // The registration's phone (+2348012345678) is not stored on the Health ID.
      expect(JSON.stringify(call.parameters)).not.toContain('2348012345678');
      expect(call.parameters).not.toContain(createContactLookupHmac('phone', '+2348012345678'));
    });

    it('answers a replay 201 and maps invalid, expired and too many tries', async () => {
      openChallenge();
      confirmResult = () => ({ outcome: 'replayed', hid_code: 'HID-AB2CD3', patient_id: 'p' });
      await expect(service().confirm({ caseId, code: '123456' }, context))
        .resolves.toEqual({ healthId: 'HID-AB2CD3', outcome: 'replayed' });
      for (const [outcome, code, status] of [['invalid', 'OUTREACH_HEALTH_ID_CODE_INVALID', 422],
        ['expired', 'OUTREACH_HEALTH_ID_CODE_EXPIRED', 422], ['too_many_tries', 'OUTREACH_HEALTH_ID_TOO_MANY_TRIES', 429]] as const) {
        confirmResult = () => ({ outcome, hid_code: null, patient_id: null });
        expect(await refusal(service().confirm({ caseId, code: '123456' }, context))).toMatchObject({ code, status });
      }
    });

    it('refuses a malformed code without reading, and answers expired without an open code', async () => {
      expect((await refusal(service().confirm({ caseId, code: '12ab56' }, context))).code)
        .toBe('OUTREACH_HEALTH_ID_CODE_INVALID');
      expect(queries).toHaveLength(0);
      expect((await refusal(service().confirm({ caseId, code: '123456' }, context))).code)
        .toBe('OUTREACH_HEALTH_ID_CODE_EXPIRED');
      registration.existing_hid_code = 'HID-ZZ9YY8';
      expect(await refusal(service().confirm({ caseId, code: '123456' }, context)))
        .toMatchObject({ code: 'OUTREACH_HEALTH_ID_ALREADY_CREATED', extensions: { healthId: 'HID-ZZ9YY8' } });
      expect(queries.some((q) => q.sql.includes('outreach_health_id_confirm('))).toBe(false);
    });

    it('counts confirms per volunteer and email, and refuses past the day\'s limit before asking the database', async () => {
      openChallenge();
      rateBlocked = true;
      expect(await refusal(service().confirm({ caseId, code: '123456' }, context)))
        .toMatchObject({ code: 'OUTREACH_HEALTH_ID_TOO_MANY_TRIES', status: 429,
          message: 'Too many codes were tried for this email today. Try again tomorrow.' });
      expect(queries.some((q) => q.sql.includes('outreach_health_id_confirm('))).toBe(false);
      rateBlocked = false;
    });

    it('answers expired for a code keyed with another OTP key version', async () => {
      openChallenge();
      open!.verifier_key_version = 'otp-v2';
      expect((await refusal(service().confirm({ caseId, code: '123456' }, context))).code)
        .toBe('OUTREACH_HEALTH_ID_CODE_EXPIRED');
    });

    it('draws another Health ID when the generated one is taken', async () => {
      openChallenge();
      hidCodes.generate.mockReturnValueOnce('HID-TAKEN2').mockReturnValueOnce('HID-FREE34');
      confirmResult = (parameters) => {
        if (parameters[4] === 'HID-TAKEN2') throw pgError('duplicate', '23505', { constraint: 'patients_hid_code_ci_uq' });
        return { outcome: 'created', hid_code: parameters[4], patient_id: 'p' };
      };
      await expect(service().confirm({ caseId, code: '123456' }, context))
        .resolves.toEqual({ healthId: 'HID-FREE34', outcome: 'created' });
    });

    it('answers a concurrent account or patient with the same contact 409, not 5xx', async () => {
      openChallenge();
      for (const [constraint, code] of [['accounts_email_ci_uq', 'OUTREACH_HEALTH_ID_EMAIL_TAKEN'],
        ['patients_email_hmac_uq', 'OUTREACH_HEALTH_ID_EMAIL_TAKEN']] as const) {
        confirmResult = () => { throw pgError('duplicate key value', '23505', { constraint }); };
        const taken = await refusal(service().confirm({ caseId, code: '123456' }, context));
        expect(taken.code).toBe(code);
        if (code === 'OUTREACH_HEALTH_ID_EMAIL_TAKEN') {
          expect(taken.message).toBe('This email is already used by another Health ID or account. Use another email.');
        }
        expect(taken.getStatus()).toBe(409);
      }
    });

    it('maps the database refusals: already created (with the Health ID), phone and email taken', async () => {
      openChallenge();
      confirmResult = () => { throw pgError('OUTREACH_HEALTH_ID_ALREADY_CREATED', '23505', { detail: 'HID-ZZ9YY8' }); };
      expect(await refusal(service().confirm({ caseId, code: '123456' }, context)))
        .toMatchObject({ status: 409, extensions: { healthId: 'HID-ZZ9YY8' } });
      confirmResult = () => { throw pgError('OUTREACH_HEALTH_ID_EMAIL_TAKEN', '23505'); };
      expect(await refusal(service().confirm({ caseId, code: '123456' }, context))).toMatchObject({
        code: 'OUTREACH_HEALTH_ID_EMAIL_TAKEN',
        message: 'This email is already used by another Health ID or account. Use another email.' });
      confirmResult = () => { throw pgError('OUTREACH_HEALTH_ID_PHONE_TAKEN', '23505'); };
      expect((await refusal(service().confirm({ caseId, code: '123456' }, context))).code)
        .toBe('OUTREACH_HEALTH_ID_PHONE_TAKEN');
      confirmResult = () => { throw pgError('OUTREACH_HEALTH_ID_REQUEST_INVALID', '22023'); };
      expect((await refusal(service().confirm({ caseId, code: "123456" }, context))).getStatus()).toBe(503);
    });
  });

  it('hints an email by its first character and domain', () => {
    expect(emailHint('ada@gmail.com')).toBe('a***@gmail.com');
  });
});

describe('OutreachHealthIdController (0119)', () => {
  const healthIds = { start: jest.fn().mockResolvedValue({ channel: 'email' }), confirm: jest.fn().mockResolvedValue({}) };
  const workloadAuth = { authenticateOutreach: jest.fn().mockResolvedValue({ subject: 'local:outreach-api' }) };
  const subject = new OutreachHealthIdController(healthIds as unknown as OutreachHealthIdService,
    workloadAuth as unknown as WorkloadAuthService);
  function request(permissions: string[], extra: Partial<HidRequest> = {}): HidRequest {
    const headers: Record<string, string> = { 'x-hid-internal-caller': 'outreach-api', 'x-hid-service-token': 't',
      'idempotency-key': 'outreach-health-id-key-0001' };
    return { correlationId: 'c', facilityId, actor: { ...actor, permissions, facility: { membershipId } },
      header: (name: string) => headers[name.toLowerCase()], ...extra } as unknown as HidRequest;
  }

  it('authenticates the Outreach workload and passes the volunteer\'s direct-care context and the key', async () => {
    await subject.start({ caseId, channel: 'email', email: 'ada@example.test' }, request(['outreach.registration.write']));
    expect(workloadAuth.authenticateOutreach).toHaveBeenCalledWith('outreach-api', undefined, 't');
    expect(healthIds.start).toHaveBeenCalledWith({ caseId, channel: 'email', email: 'ada@example.test' },
      expect.objectContaining({ facilityId, membershipId, purposeOfUse: 'direct-care' }), 'outreach-health-id-key-0001');
    await subject.confirm({ caseId, code: '123456' }, request(['outreach.registration.write']));
    expect(healthIds.confirm).toHaveBeenCalledWith({ caseId, code: '123456' }, expect.objectContaining({ facilityId }));
  });

  it('refuses without outreach.registration.write, a reported browser read, or a refused workload', async () => {
    await expect(subject.start({ caseId, channel: 'email' }, request(['outreach.registration.read'])))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(subject.confirm({ caseId, code: '1' }, request(['outreach.registration.write'],
      { delegatedBrowserMethod: 'GET' }))).rejects.toMatchObject({ code: 'CSRF_VALIDATION_FAILED' });
    workloadAuth.authenticateOutreach.mockRejectedValueOnce(new DomainProblem(401, 'WORKLOAD_AUTHENTICATION_REQUIRED', 'x'));
    await expect(subject.confirm({ caseId, code: '1' }, request(['outreach.registration.write'])))
      .rejects.toMatchObject({ code: 'WORKLOAD_AUTHENTICATION_REQUIRED' });
  });
});
