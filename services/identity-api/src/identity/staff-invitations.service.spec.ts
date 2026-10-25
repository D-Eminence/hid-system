jest.mock('../auth/password-hash', () => {
  const actual = jest.requireActual('../auth/password-hash');
  return { ...actual, hashAccountPassword: jest.fn(async () => '$argon2id$v=19$m=65536,t=3,p=1$synthetic$hash') };
});

import { createHmac } from 'node:crypto';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import { hashAccountPassword } from '../auth/password-hash';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { ActorContext, DataAccessContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { staffCommandProblem } from './staff-invitation-problems';
import { STAFF_ATTESTATION_VERSION, StaffInvitationsService } from './staff-invitations.service';
import type { StaffReauthenticationService } from './staff-reauthentication.service';

const KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const KEY = Buffer.from(KEY_B64, 'base64');
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const facilityId = '10000000-0000-4000-8000-000000000002';
const invitationId = '3f2a9c1b-7d4e-4a5b-8c6d-0e1f2a3b4c5d';
const token = 'Ab3_-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVbNm';

function hmac(label: string, ...parts: string[]): string {
  const digest = createHmac('sha256', KEY).update('staff-invitation\0').update(label);
  for (const part of parts) digest.update('\0').update(part);
  return digest.digest('hex');
}

function facility(review?: 'pending' | 'reviewed'): FacilityAssignment {
  return { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
    organizationId: '10000000-0000-4000-8000-000000000001', name: 'Synthetic Clinic Ltd', roles: ['org_admin'],
    permissions: ['workforce.manage'], isPrimary: true,
    ...(review ? { selfService: { review, organizationType: 'hospital' as const } } : {}) };
}

function actor(review?: 'pending' | 'reviewed'): ActorContext {
  const assignment = facility(review);
  return { kind: 'staff', id: 'staff:administrator', subject: 'staff:administrator',
    accountId: '20000000-0000-4000-8000-000000000001', email: 'Admin@Example.TEST', displayName: 'Ada Obi',
    roles: assignment.roles, permissions: assignment.permissions, facilityIds: [facilityId], facilities: [assignment],
    facility: assignment, authenticationMethod: 'local' };
}

function staffContext(review?: 'pending' | 'reviewed'): DataAccessContext {
  return { actor: actor(review), facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
    correlationId: 'staff-invitation-test', purposeOfUse: 'healthcare-operations' };
}

const httpRequest = { correlationId: 'staff-invitation-test', ip: '203.0.113.7',
  header: (name: string) => (name === 'user-agent' ? 'synthetic-agent' : undefined) } as unknown as HidRequest;

type Handler = (sql: string, values: unknown[]) => unknown;

function harness(handlers: Record<string, Handler> = {}) {
  const calls: { sql: string; values: unknown[]; transaction: string }[] = [];
  const events: string[] = [];
  const respond = (transaction: string) => jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values, transaction });
    for (const [needle, handler] of Object.entries(handlers)) {
      if (sql.includes(needle)) return handler(sql, values);
    }
    if (sql.includes('otp_challenges')) return { rows: [{ held: false }] };
    if (sql.includes('platform.control_enabled')) return { rows: [{ invitations: true, provider_portal: true, maintenance: false }] };
    if (sql.includes('otp_rate_limits') || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    return { rows: [] };
  });
  const query = respond('none');
  const database = {
    query,
    withTransaction: jest.fn(async (_context: DataAccessContext, work: (client: unknown) => Promise<unknown>) => {
      events.push('transaction:begin');
      const result = await work({ query: respond('staff') });
      events.push('transaction:commit');
      return result;
    }),
    withSystemTransaction: jest.fn(async (_correlation: string, work: (client: unknown) => Promise<unknown>) => {
      events.push('system:begin');
      const result = await work({ query: respond('system') });
      events.push('system:commit');
      return result;
    }),
  };
  const notification = { deliverStaffInvitation: jest.fn(async (_input: Record<string, unknown>):
    Promise<{ outcome: 'accepted' | 'definitive_failure' | 'unknown'; provider?: string }> => {
    events.push('deliver');
    return { outcome: 'accepted', provider: 'ses' };
  }) };
  const reauthentication = { confirm: jest.fn(async () => { events.push('reauthenticate'); }) };
  const service = new StaffInvitationsService(database as unknown as DatabaseService,
    notification as unknown as NotificationOtpClient, reauthentication as unknown as StaffReauthenticationService);
  const sqlCalls = (needle: string) => calls.filter((call) => call.sql.includes(needle));
  return { service, database, notification, reauthentication, calls, events, sqlCalls };
}

const createInput = { name: 'Bola Adeyemi', email: 'Bola.Adeyemi@Example.TEST', role: 'doctor' as const,
  licenceBody: 'MDCN' as const, licenceNumber: ' mdcn/12  345 ', attested: true as const, currentPassword: 'secret pass' };
const createRow = { invitation_id: invitationId, row_version: '1', send_id: 'e0000000-0000-4000-8000-000000000001',
  expires_at: new Date('2026-11-01T13:35:00.000Z'), replayed: false, dispatch: true, facility_name: 'Synthetic Clinic Ltd',
  role_code: 'doctor', invitee_email: 'bola.adeyemi@example.test' };

describe('StaffInvitationsService', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid', CORS_ORIGINS: 'https://app.healthidentitydirectory.com',
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456', OTP_HMAC_KEY_B64: KEY_B64, OTP_HMAC_KEY_VERSION: 'test-v2',
    });
    resetEnvironmentForTests();
    (hashAccountPassword as jest.Mock).mockClear();
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  describe('invite', () => {
    it('refuses a governed facility 403 and a pending one 409 before the gate, the password or the database', async () => {
      const { service, calls, reauthentication } = harness();
      await expect(service.create(staffContext(), httpRequest, createInput, 'idempotency-key-0001'))
        .rejects.toMatchObject({ status: 403, code: 'STAFF_MANAGEMENT_NOT_AVAILABLE' });
      await expect(service.create(staffContext('pending'), httpRequest, createInput, 'idempotency-key-0001'))
        .rejects.toMatchObject({ status: 409, code: 'FACILITY_REVIEW_PENDING' });
      expect(calls).toHaveLength(0);
      expect(reauthentication.confirm).not.toHaveBeenCalled();
    });

    it('answers the closed gate 423 before the password', async () => {
      const { service, reauthentication, database } = harness({ 'platform.control_enabled': () => ({ rows: [
        { invitations: false, provider_portal: true, maintenance: false }] }) });
      await expect(service.create(staffContext('reviewed'), httpRequest, createInput, 'idempotency-key-0001'))
        .rejects.toMatchObject({ status: 423, code: 'STAFF_INVITATIONS_UNAVAILABLE' });
      expect(reauthentication.confirm).not.toHaveBeenCalled();
      expect(database.withTransaction).not.toHaveBeenCalled();
    });

    it('re-authenticates, then creates with the HMACs, the normalized licence and the request digest, then sends after commit and records', async () => {
      const { service, sqlCalls, events, notification, reauthentication } = harness({
        'identity.create_staff_invitation': () => ({ rows: [createRow] }),
      });
      const context = staffContext('reviewed');
      const answer = await service.create(context, httpRequest, createInput, 'idempotency-key-0001');
      expect(answer).toEqual({ status: 201, body: { invitationId, version: 1, expiresAt: '2026-11-01T13:35:00.000Z',
        deliveryOutcome: 'accepted', replayed: false } });
      expect(reauthentication.confirm).toHaveBeenCalledWith(context.actor, 'secret pass', httpRequest);
      // The recovery hold runs inside the command's transaction, before it.
      const [hold] = sqlCalls('otp_challenges');
      expect(hold).toMatchObject({ transaction: 'staff', values: [context.actor.accountId, 24] });
      const [create] = sqlCalls('identity.create_staff_invitation');
      expect(create?.sql).toBe('select * from identity.create_staff_invitation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)');
      const values = create?.values ?? [];
      expect(values[0]).toMatch(UUID4);
      expect(values[1]).toMatch(UUID4);
      expect(values.slice(2, 9)).toEqual(['Bola Adeyemi', 'bola.adeyemi@example.test', 'doctor', 'MDCN', 'MDCN/12 345',
        STAFF_ATTESTATION_VERSION, 'idempotency-key-0001']);
      expect(values[9]).toBe(requestDigest('staff-invitation.create', { facilityId, name: 'Bola Adeyemi',
        email: 'bola.adeyemi@example.test', role: 'doctor', licenceBody: 'MDCN', licenceNumber: 'MDCN/12 345' }));
      expect(values[12]).toBe('test-v2');
      // What was sent is what was stored: the link token and the code behind the HMACs.
      const sent = notification.deliverStaffInvitation.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
      expect(sent).toEqual({ sendId: createRow.send_id, invitationId, recipient: 'bola.adeyemi@example.test',
        facilityName: 'Synthetic Clinic Ltd', roleCode: 'doctor', token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        code: expect.stringMatching(/^\d{6}$/), expiresAt: new Date('2026-11-01T13:35:00.000Z'),
        correlationId: 'staff-invitation-test' });
      expect(Buffer.from(String(sent.token), 'base64url')).toHaveLength(32);
      expect(values[10]).toBe(hmac('link', String(values[0]), String(sent.token)));
      expect(values[11]).toBe(hmac('email-code', 'bola.adeyemi@example.test', String(sent.code)));
      expect(events).toEqual(['reauthenticate', 'transaction:begin', 'transaction:commit', 'deliver',
        'transaction:begin', 'transaction:commit']);
      const [recorded] = sqlCalls('identity.record_staff_invitation_delivery');
      expect(recorded).toMatchObject({ transaction: 'staff', sql: 'select identity.record_staff_invitation_delivery($1,$2)',
        values: [createRow.send_id, 'accepted'] });
    });

    it('never puts the password in the request digest, and a different licence changes the digest', () => {
      const base = { facilityId, name: 'Bola Adeyemi', email: 'bola.adeyemi@example.test', role: 'doctor',
        licenceBody: 'MDCN', licenceNumber: 'MDCN/12 345' };
      expect(requestDigest('staff-invitation.create', base))
        .not.toBe(requestDigest('staff-invitation.create', { ...base, licenceNumber: 'MDCN/12 346' }));
    });

    it('answers a replay 200 with the stored values and sends nothing', async () => {
      const { service, notification, sqlCalls } = harness({ 'identity.create_staff_invitation': () => ({ rows: [{
        ...createRow, replayed: true, dispatch: false, row_version: '3', delivery_outcome: 'definitive_failure' }] }) });
      await expect(service.create(staffContext('reviewed'), httpRequest, createInput, 'idempotency-key-0001'))
        .resolves.toEqual({ status: 200, body: { invitationId, version: 3, expiresAt: '2026-11-01T13:35:00.000Z',
          deliveryOutcome: 'definitive_failure', replayed: true } });
      expect(notification.deliverStaffInvitation).not.toHaveBeenCalled();
      expect(sqlCalls('record_staff_invitation_delivery')).toHaveLength(0);
    });

    it('sends nothing for an undispatched send (the cross-facility cap) and answers unknown', async () => {
      const { service, notification, sqlCalls } = harness({ 'identity.create_staff_invitation': () => ({ rows: [{
        ...createRow, dispatch: false }] }) });
      await expect(service.create(staffContext('reviewed'), httpRequest, createInput, 'idempotency-key-0001'))
        .resolves.toMatchObject({ status: 201, body: { deliveryOutcome: 'unknown', replayed: false } });
      expect(notification.deliverStaffInvitation).not.toHaveBeenCalled();
      // The database records the send as suppressed itself; nothing is recorded here.
      expect(sqlCalls('record_staff_invitation_delivery')).toHaveLength(0);
    });

    it('omits a domain-like facility name from the email, and answers a failed record with the outcome', async () => {
      const { service, notification } = harness({
        'identity.create_staff_invitation': () => ({ rows: [{ ...createRow, facility_name: 'hid-payroll.com Clinic' }] }),
        'record_staff_invitation_delivery': () => { throw Object.assign(new Error('x'), { code: '08006' }); },
      });
      notification.deliverStaffInvitation.mockResolvedValueOnce({ outcome: 'definitive_failure', provider: 'ses' });
      await expect(service.create(staffContext('reviewed'), httpRequest, createInput, 'idempotency-key-0001'))
        .resolves.toMatchObject({ status: 201, body: { deliveryOutcome: 'definitive_failure' } });
      expect(notification.deliverStaffInvitation.mock.calls[0]?.[0]).not.toHaveProperty('facilityName');
    });

    it('records unknown when the delivery call throws', async () => {
      const { service, notification, sqlCalls } = harness({ 'identity.create_staff_invitation': () => ({ rows: [createRow] }) });
      notification.deliverStaffInvitation.mockRejectedValueOnce(new Error('boom'));
      await expect(service.create(staffContext('reviewed'), httpRequest, createInput, 'idempotency-key-0001'))
        .resolves.toMatchObject({ body: { deliveryOutcome: 'unknown' } });
      expect(sqlCalls('record_staff_invitation_delivery')[0]?.values).toEqual([createRow.send_id, 'unknown']);
    });

    it('holds the invitation within 24 hours of an OTP recovery (403 STAFF_RECENT_RECOVERY_HOLD), before the command', async () => {
      const { service, sqlCalls, notification } = harness({ 'otp_challenges': () => ({ rows: [{ held: true }] }) });
      await expect(service.create(staffContext('reviewed'), httpRequest, createInput, 'idempotency-key-0001'))
        .rejects.toMatchObject({ status: 403, code: 'STAFF_RECENT_RECOVERY_HOLD' });
      expect(sqlCalls('identity.create_staff_invitation')).toHaveLength(0);
      expect(notification.deliverStaffInvitation).not.toHaveBeenCalled();
    });

    it('answers a production without the OTP key 503 before the password', async () => {
      delete process.env.OTP_HMAC_KEY_B64;
      process.env.NODE_ENV = 'production';
      jest.spyOn(require('../config/environment'), 'getEnvironment').mockReturnValue({
        NODE_ENV: 'production', OTP_HMAC_KEY_VERSION: 'x', OTP_HMAC_KEY_B64: undefined });
      const { service, reauthentication } = harness();
      await expect(service.create(staffContext('reviewed'), httpRequest, createInput, 'idempotency-key-0001'))
        .rejects.toMatchObject({ status: 503, code: 'STAFF_MANAGEMENT_UNAVAILABLE' });
      await expect(service.open({ invitationId, token, turnstileAction: 'staff-invitation' }, httpRequest))
        .rejects.toMatchObject({ status: 503, code: 'STAFF_INVITATION_UNAVAILABLE' });
      expect(reauthentication.confirm).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    });
  });

  describe('resend and revoke', () => {
    it('binds the new code to the invitee\'s email read from the facility\'s own list, then resends and records', async () => {
      const { service, sqlCalls, notification, reauthentication, events } = harness({
        'list_facility_staff_invitations': () => ({ rows: [{ invitee_email: 'bola.adeyemi@example.test' }] }),
        'identity.resend_staff_invitation': () => ({ rows: [{ row_version: '4', expires_at: '2026-11-08T13:35:00Z',
          send_id: 'e0000000-0000-4000-8000-000000000002', dispatch: true, facility_name: 'Synthetic Clinic Ltd',
          role_code: 'nurse', invitee_email: 'bola.adeyemi@example.test' }] }),
      });
      await expect(service.resend(staffContext('reviewed'), invitationId, 3)).resolves.toEqual({ version: 4,
        expiresAt: '2026-11-08T13:35:00.000Z', deliveryOutcome: 'accepted' });
      expect(reauthentication.confirm).not.toHaveBeenCalled();
      expect(sqlCalls('list_facility_staff_invitations')[0]).toMatchObject({ transaction: 'staff',
        sql: 'select invitee_email from identity.list_facility_staff_invitations() where invitation_id = $1',
        values: [invitationId] });
      const [resend] = sqlCalls('identity.resend_staff_invitation');
      const sent = notification.deliverStaffInvitation.mock.calls[0]?.[0] as unknown as Record<string, string>;
      expect(resend?.values).toEqual([invitationId, 3, expect.stringMatching(UUID4),
        hmac('link', invitationId, sent.token as string), hmac('email-code', 'bola.adeyemi@example.test', sent.code as string),
        'test-v2']);
      expect(sent.sendId).toBe('e0000000-0000-4000-8000-000000000002');
      expect(sqlCalls('otp_challenges')).toHaveLength(1);
      expect(events.filter((event) => event === 'deliver')).toHaveLength(1);
    });

    it('answers an invitation not in the facility\'s list 404 without calling the command', async () => {
      const { service, sqlCalls } = harness();
      await expect(service.resend(staffContext('reviewed'), invitationId, 3))
        .rejects.toMatchObject({ status: 404, code: 'STAFF_INVITATION_NOT_FOUND' });
      expect(sqlCalls('identity.resend_staff_invitation')).toHaveLength(0);
    });

    it.each([
      ['P0002', 'x', 404, 'STAFF_INVITATION_NOT_FOUND'], ['40001', 'x', 409, 'VERSION_CONFLICT'],
      ['P0001', 'STAFF_INVITATION_NOT_PENDING', 409, 'STAFF_INVITATION_NOT_PENDING'],
      ['P0001', 'STAFF_INVITATION_RESEND_TOO_SOON', 409, 'STAFF_INVITATION_RESEND_TOO_SOON'],
      ['P0001', 'STAFF_INVITATION_SEND_LIMIT', 409, 'STAFF_INVITATION_SEND_LIMIT'],
      ['P0001', 'STAFF_INVITATION_DAILY_LIMIT', 429, 'STAFF_INVITATION_DAILY_LIMIT'],
      ['P0001', 'STAFF_INVITATION_RECIPIENT_LIMIT', 429, 'STAFF_INVITATION_RECIPIENT_LIMIT'],
      ['P0001', 'STAFF_INVITATION_DELIVERY_PAUSED', 429, 'STAFF_INVITATION_DELIVERY_PAUSED'],
      ['P0001', 'STAFF_INVITATION_ALREADY_PENDING', 409, 'STAFF_INVITATION_ALREADY_PENDING'],
      ['P0001', 'FACILITY_REVIEW_PENDING', 409, 'FACILITY_REVIEW_PENDING'],
      ['55000', 'PLATFORM_CONTROL_DISABLED:staff_invitations_enabled', 423, 'STAFF_INVITATIONS_UNAVAILABLE'],
      ['42501', 'STAFF_MANAGEMENT_NOT_AVAILABLE', 403, 'STAFF_MANAGEMENT_NOT_AVAILABLE'],
    ])('maps a resend refused %s %s to %i %s', async (code, message, status, answer) => {
      const { service } = harness({
        'list_facility_staff_invitations': () => ({ rows: [{ invitee_email: 'bola.adeyemi@example.test' }] }),
        'identity.resend_staff_invitation': () => { throw Object.assign(new Error(message), { code }); },
      });
      await expect(service.resend(staffContext('reviewed'), invitationId, 3)).rejects.toMatchObject({ status, code: answer });
    });

    it('revokes with the version: not gated, not held, no password', async () => {
      const { service, sqlCalls, reauthentication } = harness({
        'platform.control_enabled': () => ({ rows: [{ invitations: false, provider_portal: true, maintenance: false }] }),
        'identity.revoke_staff_invitation': () => ({ rows: [{ row_version: '5', revoked_at: new Date('2026-10-26T10:00:00Z') }] }),
      });
      await expect(service.revoke(staffContext('reviewed'), invitationId, 4))
        .resolves.toEqual({ version: 5, revokedAt: '2026-10-26T10:00:00.000Z' });
      expect(sqlCalls('identity.revoke_staff_invitation')[0]?.values).toEqual([invitationId, 4]);
      expect(sqlCalls('otp_challenges')).toHaveLength(0);
      expect(sqlCalls('platform.control_enabled')).toHaveLength(0);
      expect(reauthentication.confirm).not.toHaveBeenCalled();
    });
  });

  describe('open', () => {
    const openRow = { result: 'ready', invitation_id: invitationId, facility_name: 'Synthetic Clinic Ltd', role_code: 'nurse',
      inviter_name: 'Ada Obi', invitee_name: 'Bola Adeyemi', invitee_email: 'bola.adeyemi@example.test',
      expires_at: new Date('2026-11-01T13:35:00.000Z'), account_case: 'new', link_required: false,
      session_expires_at: new Date('2026-10-25T14:35:00.000Z') };

    it('charges the network, then opens by link with the HMACs and starts a session for a new account', async () => {
      const { service, sqlCalls, events } = harness({ 'identity.open_staff_invitation': () => ({ rows: [openRow] }) });
      const opened = await service.open({ invitationId, token, turnstileAction: 'staff-invitation' }, httpRequest);
      expect(opened.body).toEqual({ invitationId, facilityName: 'Synthetic Clinic Ltd', roleCode: 'nurse',
        inviterName: 'Ada Obi', inviteeName: 'Bola Adeyemi', email: 'bola.adeyemi@example.test',
        expiresAt: '2026-11-01T13:35:00.000Z', accountCase: 'new', linkRequired: false });
      expect(opened.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // The network's 20 an hour, keyed by the HMAC of the address, in its own committed transaction.
      const lock = sqlCalls('pg_advisory_xact_lock')[0];
      expect(lock?.values).toEqual([`otp-rate:ip:${hmac('network', '203.0.113.7')}`]);
      expect(events.slice(0, 4)).toEqual(['system:begin', 'system:commit', 'system:begin', 'system:commit']);
      const [open] = sqlCalls('identity.open_staff_invitation');
      expect(open?.sql).toBe('select * from identity.open_staff_invitation($1,$2,$3,$4,$5)');
      expect(open?.values).toEqual([invitationId, hmac('link', invitationId, token), null, null,
        hmac('session', opened.sessionToken as string)]);
    });

    it('opens by typed email and code, lower-cased, and sets no session when the command set none', async () => {
      const { service, sqlCalls } = harness({ 'identity.open_staff_invitation': () => ({ rows: [{ ...openRow,
        account_case: 'dormant_staff', link_required: true, session_expires_at: null, inviter_name: 'hid-payroll.com' }] }) });
      const opened = await service.open({ email: 'Bola.Adeyemi@Example.TEST', code: '048213',
        turnstileAction: 'staff-invitation' }, httpRequest);
      expect(opened.sessionToken).toBeUndefined();
      expect(opened.body).toMatchObject({ accountCase: 'dormant_staff', linkRequired: true, inviterName: null });
      const values = sqlCalls('identity.open_staff_invitation')[0]?.values ?? [];
      expect(values.slice(0, 4)).toEqual([null, null, 'bola.adeyemi@example.test',
        hmac('email-code', 'bola.adeyemi@example.test', '048213')]);
      expect(values[4]).toMatch(/^[0-9a-f]{64}$/);
    });

    it.each([
      ['invalid', 401, 'STAFF_INVITATION_CODE_INVALID'], ['locked', 429, 'STAFF_INVITATION_LOCKED'],
      ['superseded', 410, 'STAFF_INVITATION_SUPERSEDED'], ['expired', 410, 'STAFF_INVITATION_EXPIRED'],
      ['withdrawn', 410, 'STAFF_INVITATION_WITHDRAWN'], ['accepted', 409, 'STAFF_INVITATION_ALREADY_ACCEPTED'],
      ['something-new', 503, 'STAFF_INVITATION_UNAVAILABLE'],
    ])('answers the result %s %i %s', async (result, status, code) => {
      const { service } = harness({ 'identity.open_staff_invitation': () => ({ rows: [{ result }] }) });
      await expect(service.open({ invitationId, token, turnstileAction: 'staff-invitation' }, httpRequest))
        .rejects.toMatchObject({ status, code });
    });

    it('answers the 21st open from a network in an hour 429 before the command, and an unusable address 503', async () => {
      const { service, sqlCalls } = harness({ 'select request_count': () => ({ rows: [{ request_count: 20,
        window_started_at: new Date(), blocked_until: null }] }) });
      await expect(service.open({ invitationId, token, turnstileAction: 'staff-invitation' }, httpRequest))
        .rejects.toMatchObject({ status: 429, code: 'STAFF_INVITATION_RATE_LIMITED' });
      expect(sqlCalls('identity.open_staff_invitation')).toHaveLength(0);
      const second = harness();
      await expect(second.service.open({ invitationId, token, turnstileAction: 'staff-invitation' },
        { ...httpRequest, ip: undefined } as unknown as HidRequest))
        .rejects.toMatchObject({ status: 503, code: 'STAFF_INVITATION_UNAVAILABLE' });
      expect(second.calls.filter((call) => call.sql.includes('otp_rate'))).toHaveLength(0);
    });

    it('answers the closed gate 423 before counting anything', async () => {
      const { service, sqlCalls } = harness({ 'platform.control_enabled': () => ({ rows: [
        { invitations: true, provider_portal: true, maintenance: true }] }) });
      await expect(service.open({ invitationId, token, turnstileAction: 'staff-invitation' }, httpRequest))
        .rejects.toMatchObject({ status: 423, code: 'STAFF_INVITATIONS_UNAVAILABLE' });
      expect(sqlCalls('otp_rate')).toHaveLength(0);
    });

    it('answers an unknown control (Identity before the migration) 423, and an unreadable one 503', async () => {
      const unknown = harness({ 'platform.control_enabled': () => { throw Object.assign(new Error('PLATFORM_CONTROL_INVALID'), { code: '22023' }); } });
      await expect(unknown.service.open({ invitationId, token, turnstileAction: 'staff-invitation' }, httpRequest))
        .rejects.toMatchObject({ status: 423, code: 'STAFF_INVITATIONS_UNAVAILABLE' });
      const down = harness({ 'platform.control_enabled': () => { throw new Error('connection refused'); } });
      await expect(down.service.open({ invitationId, token, turnstileAction: 'staff-invitation' }, httpRequest))
        .rejects.toMatchObject({ status: 503, code: 'STAFF_INVITATION_UNAVAILABLE' });
    });
  });

  describe('accept (new or dormant)', () => {
    const acceptRow = { account_id: 'a', membership_id: 'm', organization_id: 'o', facility_id: facilityId,
      facility_name: 'Synthetic Clinic Ltd', role_code: 'nurse', account_case: 'new' };

    it('pre-checks in its own transaction, hashes only after ready, then accepts', async () => {
      const { service, sqlCalls, events } = harness({
        'prepare_staff_invitation_acceptance': () => { events.push('prepare'); return { rows: [{ result: 'ready', account_case: 'new' }] }; },
        'accept_staff_invitation_with_password': () => { events.push('accept'); return { rows: [acceptRow] }; },
      });
      (hashAccountPassword as jest.Mock).mockImplementationOnce(async () => {
        events.push('hash');
        return '$argon2id$v=19$m=65536,t=3,p=1$synthetic$hash';
      });
      await expect(service.accept(token, 'a long new password', 'accept-test'))
        .resolves.toEqual({ accepted: true, facilityName: 'Synthetic Clinic Ltd', roleCode: 'nurse' });
      expect(events).toEqual(['system:begin', 'prepare', 'system:commit', 'hash', 'system:begin', 'accept', 'system:commit']);
      expect(sqlCalls('prepare_staff_invitation_acceptance')[0]?.values).toEqual([hmac('session', token)]);
      expect(sqlCalls('accept_staff_invitation_with_password')[0]?.values).toEqual([hmac('session', token),
        '$argon2id$v=19$m=65536,t=3,p=1$synthetic$hash']);
    });

    it('answers a missing or malformed cookie 401 with no database call and no hash', async () => {
      const { service, calls } = harness();
      for (const cookie of [undefined, '', 'short', `${token}x`]) {
        await expect(service.accept(cookie, 'a long new password', 'accept-test'))
          .rejects.toMatchObject({ status: 401, code: 'STAFF_INVITATION_SESSION_INVALID' });
      }
      expect(calls).toHaveLength(0);
      expect(hashAccountPassword).not.toHaveBeenCalled();
      await expect(service.accept(token, 'short', 'accept-test')).rejects.toMatchObject({ status: 400, code: 'PASSWORD_INVALID' });
    });

    it.each([
      ['invalid', 401, 'STAFF_INVITATION_SESSION_INVALID'], ['expired', 410, 'STAFF_INVITATION_EXPIRED'],
      ['withdrawn', 410, 'STAFF_INVITATION_WITHDRAWN'], ['account_exists', 409, 'STAFF_INVITATION_ACCOUNT_EXISTS'],
      ['account_changed', 409, 'STAFF_INVITATION_ACCOUNT_CHANGED'], ['patient_account', 409, 'STAFF_INVITATION_PATIENT_ACCOUNT'],
      ['unavailable', 409, 'STAFF_INVITATION_ACCOUNT_UNAVAILABLE'], ['other', 503, 'STAFF_INVITATION_UNAVAILABLE'],
    ])('answers the pre-check %s %i %s before any hash', async (result, status, code) => {
      const { service, sqlCalls } = harness({ 'prepare_staff_invitation_acceptance': () => ({ rows: [{ result, account_case: null }] }) });
      await expect(service.accept(token, 'a long new password', 'accept-test')).rejects.toMatchObject({ status, code });
      expect(hashAccountPassword).not.toHaveBeenCalled();
      expect(sqlCalls('accept_staff_invitation_with_password')).toHaveLength(0);
    });

    it.each([
      ['P0001', 'STAFF_INVITATION_ACCOUNT_EXISTS', 409, 'STAFF_INVITATION_ACCOUNT_EXISTS'],
      ['23505', 'duplicate key value violates unique constraint "accounts_email_ci_uq"', 409, 'STAFF_INVITATION_ACCOUNT_EXISTS'],
      ['P0001', 'STAFF_INVITATION_ACCOUNT_CHANGED', 409, 'STAFF_INVITATION_ACCOUNT_CHANGED'],
      ['P0001', 'STAFF_INVITATION_SESSION_INVALID', 401, 'STAFF_INVITATION_SESSION_INVALID'],
      ['P0001', 'STAFF_INVITATION_WITHDRAWN', 410, 'STAFF_INVITATION_WITHDRAWN'],
      ['P0001', 'FACILITY_RELEASED', 410, 'STAFF_INVITATION_WITHDRAWN'],
      ['P0001', 'STAFF_INVITATION_PATIENT_ACCOUNT', 409, 'STAFF_INVITATION_PATIENT_ACCOUNT'],
      ['P0001', 'SOMETHING_NEW', 503, 'STAFF_INVITATION_UNAVAILABLE'],
      ['22023', 'invalid password hash', 503, 'STAFF_INVITATION_UNAVAILABLE'],
      ['42501', 'x', 503, 'STAFF_INVITATION_UNAVAILABLE'],
      ['55000', 'PLATFORM_CONTROL_DISABLED:staff_invitations_enabled', 423, 'STAFF_INVITATIONS_UNAVAILABLE'],
    ])('maps the accept command\'s %s %s to %i %s', async (code, message, status, answer) => {
      const { service } = harness({
        'prepare_staff_invitation_acceptance': () => ({ rows: [{ result: 'ready', account_case: 'new' }] }),
        'accept_staff_invitation_with_password': () => { throw Object.assign(new Error(message), { code }); },
      });
      await expect(service.accept(token, 'a long new password', 'accept-test')).rejects.toMatchObject({ status, code: answer });
    });
  });

  describe('signed in (existing staff)', () => {
    const signedIn = (): DataAccessContext => ({ ...staffContext('reviewed'), facilityId: '', membershipId: '' });

    it('previews by link and accepts by typed code bound to the session\'s own email', async () => {
      const { service, sqlCalls, database } = harness({
        'preview_staff_invitation_for_account': () => ({ rows: [{ result: 'ready', invitation_id: invitationId,
          facility_id: facilityId, facility_name: 'Synthetic Clinic Ltd', role_code: 'lab', inviter_name: 'Ada Obi',
          expires_at: '2026-11-01T13:35:00Z' }] }),
        'accept_staff_invitation_for_account': () => ({ rows: [{ result: 'ready', membership_id: 'membership-2',
          facility_id: facilityId, facility_name: 'Synthetic Clinic Ltd', role_code: 'lab' }] }),
      });
      const context = signedIn();
      await expect(service.previewForAccount(context, { invitationId, token })).resolves.toEqual({ invitationId,
        facilityId, facilityName: 'Synthetic Clinic Ltd', roleCode: 'lab', inviterName: 'Ada Obi',
        expiresAt: '2026-11-01T13:35:00.000Z' });
      expect(sqlCalls('preview_staff_invitation_for_account')[0]).toMatchObject({ transaction: 'staff',
        values: [invitationId, hmac('link', invitationId, token), null] });
      await expect(service.acceptForAccount(context, { code: '048213' })).resolves.toEqual({ accepted: true,
        facilityId, membershipId: 'membership-2', facilityName: 'Synthetic Clinic Ltd', roleCode: 'lab' });
      expect(sqlCalls('accept_staff_invitation_for_account')[0]?.values).toEqual([null, null,
        hmac('email-code', 'admin@example.test', '048213')]);
      expect(database.withTransaction.mock.calls.every(([used]) => used === context)).toBe(true);
    });

    it.each([
      ['email_mismatch', 409, 'STAFF_INVITATION_EMAIL_MISMATCH'], ['already_member', 409, 'STAFF_INVITATION_ALREADY_MEMBER'],
      ['unavailable', 409, 'STAFF_INVITATION_ACCOUNT_UNAVAILABLE'], ['invalid', 401, 'STAFF_INVITATION_CODE_INVALID'],
      ['locked', 429, 'STAFF_INVITATION_LOCKED'], ['superseded', 410, 'STAFF_INVITATION_SUPERSEDED'],
      ['expired', 410, 'STAFF_INVITATION_EXPIRED'], ['withdrawn', 410, 'STAFF_INVITATION_WITHDRAWN'],
      ['accepted', 409, 'STAFF_INVITATION_ALREADY_ACCEPTED'],
    ])('answers %s %i %s on preview and accept', async (result, status, code) => {
      const { service } = harness({
        'preview_staff_invitation_for_account': () => ({ rows: [{ result }] }),
        'accept_staff_invitation_for_account': () => ({ rows: [{ result }] }),
      });
      await expect(service.previewForAccount(signedIn(), { invitationId, token })).rejects.toMatchObject({ status, code });
      await expect(service.acceptForAccount(signedIn(), { invitationId, token })).rejects.toMatchObject({ status, code });
    });

    it('is gated', async () => {
      const { service, sqlCalls } = harness({ 'platform.control_enabled': () => ({ rows: [
        { invitations: true, provider_portal: false, maintenance: false }] }) });
      await expect(service.acceptForAccount(signedIn(), { code: '048213' }))
        .rejects.toMatchObject({ status: 423, code: 'STAFF_INVITATIONS_UNAVAILABLE' });
      expect(sqlCalls('accept_staff_invitation_for_account')).toHaveLength(0);
    });
  });

  describe('secrets', () => {
    it('uses distinct HMAC labels, the staff-invitation domain and the OTP key', () => {
      const { service } = harness();
      const values = [service.hmac(KEY, 'link', 'x'), service.hmac(KEY, 'email-code', 'x'),
        service.hmac(KEY, 'session', 'x'), service.hmac(KEY, 'network', 'x')];
      expect(new Set(values).size).toBe(4);
      expect(values[0]).toBe(hmac('link', 'x'));
      const completion = createHmac('sha256', KEY).update('organization-profile-completion\0').update('session')
        .update('\0').update('x').digest('hex');
      expect(values[2]).not.toBe(completion);
    });

    it('makes a 43-character base64url token from 32 random bytes and a 6-digit code', () => {
      const { service } = harness();
      const tokens = new Set(Array.from({ length: 50 }, () => service.newToken()));
      expect(tokens.size).toBe(50);
      for (const value of tokens) {
        expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(Buffer.from(value, 'base64url')).toHaveLength(32);
      }
      for (let index = 0; index < 50; index += 1) expect(service.newCode()).toMatch(/^\d{6}$/);
    });
  });
});

describe('staff command problems (SPEC 6.4)', () => {
  it.each([
    ['P0001', 'FACILITY_REVIEW_PENDING', 'staff', 409], ['P0001', 'FACILITY_ALREADY_REVIEWED', 'staff', 409],
    ['P0001', 'STAFF_MANAGEMENT_NOT_ADMINISTRATOR', 'staff', 403], ['P0001', 'IDEMPOTENCY_KEY_REUSED', 'create', 409],
    ['P0001', 'STAFF_INVITATION_SELF', 'create', 409], ['P0001', 'STAFF_INVITATION_ALREADY_MEMBER', 'create', 409],
    ['P0001', 'STAFF_INVITATION_ALREADY_PENDING', 'create', 409], ['P0001', 'STAFF_INVITATION_PENDING_LIMIT', 'create', 409],
    ['P0001', 'STAFF_INVITATION_DAILY_LIMIT', 'create', 429], ['P0001', 'STAFF_INVITATION_RECIPIENT_LIMIT', 'create', 429],
    ['P0001', 'STAFF_INVITATION_DELIVERY_PAUSED', 'create', 429], ['P0001', 'FACILITY_STAFF_SELF', 'membership', 409],
    ['P0001', 'FACILITY_STAFF_ADMINISTRATOR', 'membership', 409], ['P0001', 'FACILITY_STAFF_ALREADY_ENDED', 'membership', 409],
    ['P0001', 'FACILITY_STAFF_ROLE_UNCHANGED', 'membership', 409], ['P0001', 'FACILITY_STAFF_PLATFORM_ACCOUNT', 'membership', 409],
    ['22023', 'STAFF_INVITATION_INVALID', 'create', 400], ['22023', 'STAFF_INVITATION_ROLE_NOT_ALLOWED', 'create', 400],
    ['22023', 'ADMINISTRATOR_LICENCE_INVALID', 'staff', 400], ['22023', 'FACILITY_STAFF_REASON_INVALID', 'membership', 400],
  ] as const)('%s %s (%s) answers %i with the same code', (code, message, scope, status) => {
    expect(staffCommandProblem(Object.assign(new Error(message), { code }), scope)).toMatchObject({ status, code: message });
  });

  it.each([
    ['42501', 'STAFF_MANAGEMENT_PERMISSION_DENIED', 'staff', 403, 'PERMISSION_DENIED'],
    ['42501', 'STAFF_MANAGEMENT_NOT_AVAILABLE', 'staff', 403, 'STAFF_MANAGEMENT_NOT_AVAILABLE'],
    ['P0002', 'x', 'membership', 404, 'FACILITY_STAFF_NOT_FOUND'],
    ['P0002', 'x', 'invitation', 404, 'STAFF_INVITATION_NOT_FOUND'],
    ['P0002', 'x', 'staff', 503, 'STAFF_MANAGEMENT_UNAVAILABLE'],
    ['40001', 'Staff invitation version conflict', 'membership', 409, 'VERSION_CONFLICT'],
    ['23505', 'duplicate', 'create', 409, 'STAFF_INVITATION_ALREADY_PENDING'],
    ['23505', 'duplicate', 'membership', 503, 'STAFF_MANAGEMENT_UNAVAILABLE'],
    ['22023', 'something else', 'create', 400, 'STAFF_INVITATION_INVALID'],
    ['22023', 'PLATFORM_CONTROL_INVALID', 'create', 423, 'STAFF_INVITATIONS_UNAVAILABLE'],
    ['55000', 'PLATFORM_CONTROL_UNAVAILABLE', 'membership', 423, 'STAFF_INVITATIONS_UNAVAILABLE'],
    ['55000', 'PLATFORM_CONTROL_DISABLED:provider_self_service_enabled', 'staff', 503, 'STAFF_MANAGEMENT_UNAVAILABLE'],
    ['55000', 'STAFF_INVITATION_IMMUTABLE', 'staff', 503, 'STAFF_MANAGEMENT_UNAVAILABLE'],
    ['P0001', 'UNHEARD_OF', 'staff', 503, 'STAFF_MANAGEMENT_UNAVAILABLE'],
    ['P0001', 'FACILITY_RELEASED', 'membership', 403, 'STAFF_MANAGEMENT_NOT_AVAILABLE'],
    ['XX000', 'internal', 'signed-in', 503, 'STAFF_INVITATION_UNAVAILABLE'],
    ['42501', 'x', 'signed-in', 403, 'PERMISSION_DENIED'],
  ] as const)('%s %s (%s) answers %i %s', (code, message, scope, status, answer) => {
    const problem = staffCommandProblem(Object.assign(new Error(message), { code }), scope);
    expect(problem).toBeInstanceOf(DomainProblem);
    expect(problem).toMatchObject({ status, code: answer });
    // The database's own text is never the answer's detail.
    if (message !== answer) expect(problem.message).not.toBe(message);
  });
});
