jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { patientRequest, usePatientSafetyTestEnvironment } from '../../test/patient-safety.fixtures';
import { normalizeShareEmail, PatientSharesService, SHARE_DETAIL, SHARE_SEARCH_WINDOW, shownClinicianName }
  from './patient-shares.service';

const membershipId = '61000000-0000-4000-8000-000000000001';
const grantId = '62000000-0000-4000-8000-000000000001';
const invitationId = '63000000-0000-4000-8000-000000000001';
const key = 'share-key-0000000000000001';

type Answer = { rows: unknown[] } | Error;

/** A fake database: each SQL text is answered by the first matching rule; every call is kept. */
function harness(rules: Array<[RegExp, Answer | ((values: unknown[]) => Answer)]> = []) {
  const calls: Array<{ sql: string; values: unknown[]; system: boolean }> = [];
  let system = false;
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values, system });
    for (const [pattern, answer] of rules) {
      if (pattern.test(sql)) {
        const value = typeof answer === 'function' ? answer(values) : answer;
        if (value instanceof Error) throw value;
        return value;
      }
    }
    if (/sessions current_session/.test(sql)) return { rows: [{ recent: true }] };
    if (/otp_challenges/.test(sql)) return { rows: [{ held: false }] };
    return { rows: [] };
  });
  const client = { query } as unknown as PoolClient;
  const database = {
    withSystemTransaction: jest.fn(async (_id: string, work: (c: PoolClient) => Promise<unknown>) => {
      system = true; try { return await work(client); } finally { system = false; } }),
    withTransaction: jest.fn(async (_context: DataAccessContext, work: (c: PoolClient) => Promise<unknown>) => work(client)),
  } as unknown as DatabaseService;
  const notification = {
    deliverPatientShareInvitation: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'brevo' }),
    deliverShareReceived: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'brevo' }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new PatientSharesService(database, notification as unknown as NotificationOtpClient,
    audit as unknown as AuditService);
  return { service, calls, notification, audit, database };
}

const dbError = (code: string, message = 'x') => Object.assign(new Error(message), { code });
const shareRow = (overrides: Record<string, unknown> = {}) => ({
  consent_grant_id: grantId, membership_id: membershipId, scope: 'write_records', level: 'clinical_collaboration',
  duration_preset: 'until_revoked', starts_at: new Date('2026-10-28T10:00:00Z'), expires_at: new Date('2027-10-28T10:00:00Z'),
  clinician_name: 'Adaeze Okafor', facility_name: 'Lagos General Hospital', replaced_consent_grant_id: null,
  replayed: false, notify_email: 'dr@example.test', ...overrides,
});
const staffContext = { actor: { kind: 'staff', subject: 'staff:doctor' }, facilityId: 'f', membershipId: 'm',
  correlationId: 'staff-correlation-01', purposeOfUse: 'direct-care' } as unknown as DataAccessContext;

describe('PatientSharesService (0095)', () => {
  usePatientSafetyTestEnvironment();

  it('names: a person\'s name is shown, anything else is null; addresses are trimmed, lower case, one @', () => {
    expect(shownClinicianName(' Adaeze Okafor ')).toBe('Adaeze Okafor');
    expect(shownClinicianName('hid-payroll.com')).toBeNull();
    expect(shownClinicianName(null)).toBeNull();
    expect(normalizeShareEmail('  Dr.Bello@Example.TEST ')).toBe('dr.bello@example.test');
    for (const bad of ['', 'a@', '@b', 'a@@b', 'a b@c.d', 'a\u0000@b.c', `${'a'.repeat(250)}@b.cd`]) {
      expect(normalizeShareEmail(bad)).toBeNull();
    }
  });

  describe('P1 search', () => {
    it('refuses a short, long or non-string query before counting it', async () => {
      const { service, calls } = harness();
      for (const query of ['ab', '  ab  ', 'x'.repeat(81), 42, undefined, ['abc']]) {
        await expect(service.search(patientRequest, query)).rejects.toMatchObject(
          { status: 400, code: 'SHARE_SEARCH_QUERY_INVALID', message: SHARE_DETAIL.queryInvalid });
      }
      expect(calls).toHaveLength(0);
    });

    it('counts the search in an account bucket (30 an hour), then keeps 10 rows with a person\'s name', async () => {
      const rows = Array.from({ length: 25 }, (_, index) => ({ membership_id: `m${index}`,
        clinician_name: index === 0 ? 'hid-payroll.com' : `Doctor Name ${String.fromCharCode(65 + index)}`,
        role_code: 'doctor', facility_name: 'Lagos General', organization_name: 'Lagos Health', new_on_health_id: index === 1 }));
      const { service, calls } = harness([[/search_share_providers/, { rows }]]);
      const answer = await service.search(patientRequest, '  Lagos ');
      expect(answer.items).toHaveLength(10);
      expect(answer.items[0]).toEqual({ membershipId: 'm1', clinicianName: 'Doctor Name B', role: 'doctor',
        facilityName: 'Lagos General', organizationName: 'Lagos Health', newOnHealthId: true });
      expect(Object.keys(answer.items[0]!).sort()).toEqual(
        ['clinicianName', 'facilityName', 'membershipId', 'newOnHealthId', 'organizationName', 'role']);
      const bucket = calls.find((call) => /otp_rate_limits/.test(call.sql) && /insert/.test(call.sql));
      expect(bucket?.values.slice(0, 2)).toEqual(['account', service.searchBucket(patientRequest.actor!.accountId)]);
      expect(SHARE_SEARCH_WINDOW).toEqual({ windowSeconds: 3600, maxRequests: 30 });
      const search = calls.find((call) => /search_share_providers/.test(call.sql));
      expect(search?.values).toEqual(['patient:safety', '80000000-0000-4000-8000-000000000001', 'Lagos']);
      expect(calls.some((call) => /set_config\('app.actor_subject'/.test(call.sql)
        && call.values[0] === 'patient:safety')).toBe(true);
    });

    it('answers 429 once the bucket is blocked, 503 when the count fails, 403 without a live session', async () => {
      const blocked = harness([[/select request_count/, { rows: [{ request_count: 30, window_started_at: new Date(),
        blocked_until: new Date(Date.now() + 60_000) }] }]]);
      await expect(blocked.service.search(patientRequest, 'Lagos')).rejects.toMatchObject({ status: 429, code: 'SHARE_SEARCH_LIMITED' });
      expect(blocked.calls.some((call) => /search_share_providers/.test(call.sql))).toBe(false);
      const failing = harness([[/advisory/, dbError('57P01')]]);
      await expect(failing.service.search(patientRequest, 'Lagos')).rejects.toMatchObject({ status: 503, code: 'SHARE_UNAVAILABLE' });
      const session = harness([[/search_share_providers/, dbError('42501')]]);
      await expect(session.service.search(patientRequest, 'Lagos')).rejects.toMatchObject({ status: 403, code: 'PATIENT_SESSION_REQUIRED' });
    });
  });

  describe('P2 share', () => {
    const input = { membershipId: membershipId.toUpperCase(), level: 'clinical_collaboration', duration: 'until_revoked' } as const;

    it('checks the recovery hold then a recent sign-in, writes with the digest, and emails the clinician after the answer', async () => {
      const { service, calls, notification } = harness([[/create_my_consent_share/, { rows: [shareRow()] }]]);
      const answer = await service.create(patientRequest, input, key);
      expect(answer).toEqual({ consentGrantId: grantId, membershipId, scope: 'write_records', level: 'clinical_collaboration',
        duration: 'until_revoked', startsAt: new Date('2026-10-28T10:00:00Z'), expiresAt: new Date('2027-10-28T10:00:00Z'),
        clinicianName: 'Adaeze Okafor', facilityName: 'Lagos General Hospital', replacedConsentGrantId: null, replayed: false });
      const order = calls.map((call) => (/otp_challenges/.test(call.sql) ? 'hold' : /sessions current_session/.test(call.sql)
        ? 'recent' : /create_my_consent_share/.test(call.sql) ? 'share' : null)).filter(Boolean);
      expect(order).toEqual(['hold', 'recent', 'share']);
      const share = calls.find((call) => /create_my_consent_share/.test(call.sql))!;
      expect(share.values).toEqual(['patient:safety', '80000000-0000-4000-8000-000000000001', membershipId,
        'clinical_collaboration', 'until_revoked', key,
        requestDigest('identity.share.create', { membershipId, level: 'clinical_collaboration', duration: 'until_revoked' })]);
      await service.settleEmails();
      expect(notification.deliverShareReceived).toHaveBeenCalledWith({ consentGrantId: grantId, recipient: 'dr@example.test',
        facilityName: 'Lagos General Hospital', correlationId: patientRequest.correlationId });
    });

    it('sends nothing on a replay, or without a verified clinician email', async () => {
      for (const row of [shareRow({ replayed: true, notify_email: null }), shareRow({ notify_email: null })]) {
        const { service, notification } = harness([[/create_my_consent_share/, { rows: [row] }]]);
        await service.create(patientRequest, input, key);
        await service.settleEmails();
        expect(notification.deliverShareReceived).not.toHaveBeenCalled();
      }
    });

    it('answers the re-authentication, recovery, eligibility, limit and key refusals the contract names', async () => {
      const notRecent = harness([[/sessions current_session/, { rows: [{ recent: false }] }]]);
      await expect(notRecent.service.create(patientRequest, input, key)).rejects.toMatchObject(
        { status: 403, code: 'PATIENT_RECENT_AUTH_REQUIRED', message: SHARE_DETAIL.recentAuth });
      const held = harness([[/otp_challenges/, { rows: [{ held: true }] }]]);
      await expect(held.service.create(patientRequest, input, key)).rejects.toMatchObject(
        { status: 403, code: 'PATIENT_RECENT_RECOVERY_HOLD' });
      for (const [error, expected] of [
        [dbError('P0002', 'SHARE_PROVIDER_UNAVAILABLE'), { status: 404, code: 'SHARE_PROVIDER_UNAVAILABLE' }],
        [dbError('P0001', 'SHARE_CREATE_LIMITED'), { status: 429, code: 'SHARE_CREATE_LIMITED' }],
        [dbError('55000', 'IDEMPOTENCY_KEY_REUSED'), { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' }],
        [dbError('42501'), { status: 403, code: 'PATIENT_SESSION_REQUIRED' }],
        [dbError('22023'), { status: 400, code: 'VALIDATION_FAILED' }],
        [dbError('XX000'), { status: 503, code: 'SHARE_UNAVAILABLE' }],
      ] as const) {
        const { service, audit } = harness([[/create_my_consent_share/, error]]);
        await expect(service.create(patientRequest, input, key)).rejects.toMatchObject(expected);
        if (error.code === 'P0002' || error.code === 'P0001') {
          expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', actorType: 'patient',
            details: { reason: error.code === 'P0002' ? 'provider_unavailable' : 'rate_limited' } }));
        } else {
          expect(audit.record).not.toHaveBeenCalled();
        }
      }
    });
  });

  describe('P4-P7 invitations', () => {
    const input = { email: '  Dr.Bello@Example.TEST ', name: 'Dr Bello', level: 'clinical_review', duration: '7d' } as const;
    const created = { invitation_id: invitationId, reference: 'K7M2Q9XZ', status: 'pending',
      expires_at: new Date('2026-11-27T10:00:00Z'), send_email: true, replayed: false };

    it('creates, sends E1 within the request and records its outcome; the answer names the outcome only', async () => {
      const { service, calls, notification } = harness([[/create_my_share_invitation/, { rows: [created] }]]);
      const answer = await service.invite(patientRequest, input, key);
      expect(answer).toEqual({ invitationId, reference: 'K7M2Q9XZ', status: 'pending',
        expiresAt: new Date('2026-11-27T10:00:00Z'), deliveryOutcome: 'sent', replayed: false });
      const create = calls.find((call) => /create_my_share_invitation/.test(call.sql))!;
      expect(create.values).toEqual(['patient:safety', '80000000-0000-4000-8000-000000000001', 'dr.bello@example.test',
        'Dr Bello', 'clinical_review', '7d', key, requestDigest('identity.share-invitation.create',
          { email: 'dr.bello@example.test', name: 'Dr Bello', level: 'clinical_review', duration: '7d' })]);
      expect(calls.some((call) => /sessions current_session/.test(call.sql))).toBe(false);
      expect(notification.deliverPatientShareInvitation).toHaveBeenCalledWith({ invitationId,
        recipient: 'dr.bello@example.test', reference: 'K7M2Q9XZ', level: 'clinical_review', duration: '7d',
        expiresAt: new Date('2026-11-27T10:00:00Z'), correlationId: patientRequest.correlationId });
      const recorded = calls.find((call) => /record_my_share_invitation_delivery/.test(call.sql))!;
      expect(recorded.values).toEqual(['patient:safety', '80000000-0000-4000-8000-000000000001', invitationId,
        'accepted', 'brevo', null]);
    });

    it('past the per-address cap, or on a replay, sends nothing and answers not_confirmed (or the stored outcome)', async () => {
      const capped = harness([[/create_my_share_invitation/, { rows: [{ ...created, send_email: false }] }]]);
      await expect(capped.service.invite(patientRequest, input, key)).resolves.toMatchObject(
        { deliveryOutcome: 'not_confirmed', replayed: false });
      expect(capped.notification.deliverPatientShareInvitation).not.toHaveBeenCalled();
      const replay = harness([[/create_my_share_invitation/, { rows: [{ ...created, send_email: false, replayed: true }] }],
        [/list_my_share_invitations/, { rows: [{ listed: { items: [{ invitationId, deliveryOutcome: 'sent' }] } }] }]]);
      await expect(replay.service.invite(patientRequest, input, key)).resolves.toMatchObject(
        { deliveryOutcome: 'sent', replayed: true });
      expect(replay.notification.deliverPatientShareInvitation).not.toHaveBeenCalled();
      const failed = harness([[/create_my_share_invitation/, { rows: [created] }]]);
      failed.notification.deliverPatientShareInvitation.mockResolvedValue({ outcome: 'definitive_failure', safeCode: 'http_404' });
      await expect(failed.service.invite(patientRequest, input, key)).resolves.toMatchObject({ deliveryOutcome: 'not_confirmed' });
    });

    it('maps the invitation refusals; an invalid address is refused before the database', async () => {
      const early = harness();
      await expect(early.service.invite(patientRequest, { ...input, email: 'not an address' }, key)).rejects.toMatchObject(
        { status: 400, code: 'SHARE_INVITATION_EMAIL_INVALID', message: SHARE_DETAIL.emailInvalid });
      expect(early.calls).toHaveLength(0);
      for (const [error, expected] of [
        [dbError('55000', 'SHARE_INVITATION_ALREADY_OPEN'), { status: 409, code: 'SHARE_INVITATION_ALREADY_OPEN' }],
        [dbError('55000', 'SHARE_INVITATION_TOO_MANY_OPEN'), { status: 409, code: 'SHARE_INVITATION_TOO_MANY_OPEN' }],
        [dbError('55000', 'IDEMPOTENCY_KEY_REUSED'), { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' }],
        [dbError('23505'), { status: 409, code: 'SHARE_INVITATION_ALREADY_OPEN' }],
        [dbError('P0001', 'SHARE_INVITATION_LIMITED'), { status: 429, code: 'SHARE_INVITATION_LIMITED' }],
        [dbError('22023', 'SHARE_INVITATION_EMAIL_INVALID'), { status: 400, code: 'SHARE_INVITATION_EMAIL_INVALID' }],
      ] as const) {
        const { service } = harness([[/create_my_share_invitation/, error]]);
        await expect(service.invite(patientRequest, input, key)).rejects.toMatchObject(expected);
      }
      const held = harness([[/otp_challenges/, { rows: [{ held: true }] }]]);
      await expect(held.service.invite(patientRequest, input, key)).rejects.toMatchObject({ code: 'PATIENT_RECENT_RECOVERY_HOLD' });
    });

    it('lists, hiding an offer\'s name that is not a person\'s; a dead session is 403', async () => {
      const listed = { items: [{ invitationId, offer: { clinicianName: 'evil.example.com', facilityName: 'X' } },
        { invitationId: 'other', offer: null }], limits: { maxOpen: 20, maxNewPerDay: 5, remainingToday: 4 } };
      const { service } = harness([[/list_my_share_invitations/, { rows: [{ listed }] }]]);
      await expect(service.invitations(patientRequest)).resolves.toEqual({ ...listed, items: [
        { invitationId, offer: { clinicianName: null, facilityName: 'X' } }, { invitationId: 'other', offer: null }] });
      const dead = harness([[/list_my_share_invitations/, { rows: [{ listed: null }] }]]);
      await expect(dead.service.invitations(patientRequest)).rejects.toMatchObject({ status: 403, code: 'PATIENT_ACCESS_DENIED' });
    });

    it('cancel and confirm answer their codes; confirm re-authenticates and emails the clinician', async () => {
      const cancel = harness([[/cancel_my_share_invitation/, dbError('55000')]]);
      await expect(cancel.service.cancel(patientRequest, invitationId)).rejects.toMatchObject(
        { status: 409, code: 'SHARE_INVITATION_NOT_CANCELLABLE', message: SHARE_DETAIL.notCancellable });
      const missing = harness([[/cancel_my_share_invitation/, dbError('P0002')]]);
      await expect(missing.service.cancel(patientRequest, invitationId)).rejects.toMatchObject({ status: 404, code: 'SHARE_INVITATION_NOT_FOUND' });
      for (const [message, code] of [['SHARE_INVITATION_NOT_ACCEPTED', 'SHARE_INVITATION_NOT_ACCEPTED'],
        ['SHARE_PROVIDER_UNAVAILABLE', 'SHARE_PROVIDER_UNAVAILABLE']] as const) {
        const { service } = harness([[/confirm_my_share_invitation/, dbError('55000', message)]]);
        await expect(service.confirm(patientRequest, invitationId)).rejects.toMatchObject({ status: 409, code });
      }
      const confirm = harness([[/confirm_my_share_invitation/, { rows: [{ ...shareRow({ level: 'clinical_review',
        scope: 'read_records', duration_preset: '7d' }), membership_id: null, invitation_id: invitationId }] }]]);
      const answer = await confirm.service.confirm(patientRequest, invitationId);
      expect(answer).toMatchObject({ invitationId, status: 'confirmed', consentGrantId: grantId, scope: 'read_records',
        level: 'clinical_review', duration: '7d', replayed: false });
      expect(answer).not.toHaveProperty('membershipId');
      expect(confirm.calls.some((call) => /sessions current_session/.test(call.sql))).toBe(true);
      await confirm.service.settleEmails();
      expect(confirm.notification.deliverShareReceived).toHaveBeenCalledTimes(1);
    });
  });

  describe('S1-S3 staff', () => {
    it('maps the staff refusals and passes the lists through in the staff context', async () => {
      const list = harness([[/list_shared_with_me/, { rows: [{ consent_grant_id: grantId, patient_id: 'p', hid: 'HID-ABC234',
        full_name: 'Ada Obi', level: 'view_only', duration_preset: '24h', scope: 'read_records', starts_at: 's', expires_at: 'e' }] }]]);
      await expect(list.service.sharedWithMe(staffContext)).resolves.toEqual({ items: [{ consentGrantId: grantId,
        patientId: 'p', hid: 'HID-ABC234', fullName: 'Ada Obi', level: 'view_only', duration: '24h', scope: 'read_records',
        startsAt: 's', expiresAt: 'e' }] });
      expect(list.database.withTransaction).toHaveBeenCalledWith(staffContext, expect.any(Function));
      const notEligible = harness([[/list_share_invitations_for_me/, { rows: [{ listed: { eligible: false, items: [{ x: 1 }] } }] }]]);
      await expect(notEligible.service.staffInvitations(staffContext)).resolves.toEqual({ eligible: false, items: [] });
      for (const [error, expected] of [
        [dbError('P0002'), { status: 404, code: 'SHARE_INVITATION_NOT_FOUND' }],
        [dbError('42501', 'SHARE_PROVIDER_NOT_ELIGIBLE'), { status: 403, code: 'SHARE_PROVIDER_NOT_ELIGIBLE' }],
        [dbError('42501', 'SHARE_PERMISSION_DENIED'), { status: 403, code: 'SHARE_PERMISSION_DENIED' }],
        [dbError('55000'), { status: 409, code: 'SHARE_INVITATION_NOT_PENDING' }],
      ] as const) {
        const { service } = harness([[/accept_share_invitation/, error]]);
        await expect(service.accept(staffContext, invitationId)).rejects.toMatchObject(expected);
      }
    });
  });

  describe('switched off (PATIENT_SHARES_ENABLED=false)', () => {
    usePatientSafetyTestEnvironment({ PATIENT_SHARES_ENABLED: 'false' });

    it('answers 404 on every route, as an older Identity, and touches nothing', async () => {
      const { service, calls } = harness();
      const attempts: Array<() => Promise<unknown>> = [
        () => service.search(patientRequest, 'Lagos'), () => service.create(patientRequest,
          { membershipId, level: 'view_only', duration: '24h' }, key), () => service.invitations(patientRequest),
        () => service.invite(patientRequest, { email: 'a@b.test', level: 'view_only', duration: '24h' }, key),
        () => service.cancel(patientRequest, invitationId), () => service.confirm(patientRequest, invitationId),
        () => service.sharedWithMe(staffContext), () => service.staffInvitations(staffContext),
        () => service.accept(staffContext, invitationId)];
      for (const attempt of attempts) await expect(attempt()).rejects.toBeInstanceOf(NotFoundException);
      expect(calls).toHaveLength(0);
      expect(new DomainProblem(404, 'X', 'y')).toBeInstanceOf(DomainProblem);
    });
  });
});
