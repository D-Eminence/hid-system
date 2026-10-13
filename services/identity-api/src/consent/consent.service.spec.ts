import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { ConsentService } from './consent.service';

const context: DataAccessContext = {
  correlationId: 'consent-service-test-correlation',
  facilityId: '10000000-0000-4000-8000-000000000001',
  membershipId: '20000000-0000-4000-8000-000000000001',
  purposeOfUse: 'direct-care',
  actor: {
    id: '30000000-0000-4000-8000-000000000001',
    subject: 'staff:test',
    accountId: '30000000-0000-4000-8000-000000000001',
    roles: ['doctor'],
    permissions: ['identity.consent.write'],
    facilityIds: ['10000000-0000-4000-8000-000000000001'],
    facilities: [],
    authenticationMethod: 'local',
  },
};

const patientRequest = {
  correlationId: 'consent-patient-test-correlation',
  actor: {
    kind: 'patient',
    id: 'patient:test',
    subject: 'patient:test',
    accountId: '70000000-0000-4000-8000-000000000001',
    patientId: '50000000-0000-4000-8000-000000000004',
    sessionId: '80000000-0000-4000-8000-000000000001',
    roles: [],
    permissions: [],
    facilityIds: [],
    facilities: [],
    authenticationMethod: 'local',
  },
} as unknown as HidRequest;
const patientSession = ['patient:test', '80000000-0000-4000-8000-000000000001'];

describe('ConsentService', () => {
  const query = jest.fn();
  const client = { query } as unknown as PoolClient;
  const withTransaction = jest.fn(
    async (_context: DataAccessContext, operation: (transactionClient: PoolClient) => Promise<unknown>) =>
      operation(client),
  );
  const withSystemTransaction = jest.fn(
    async (_correlationId: string, operation: (transactionClient: PoolClient) => Promise<unknown>) =>
      operation(client),
  );
  const database = { withTransaction, withSystemTransaction } as unknown as DatabaseService;
  const consume = jest.fn(async () => undefined);
  const budget = { consume };
  // The staff search budget is a second dependency since 0086; constructed
  // loosely so that these specs also compile against a service without it.
  const service = new (ConsentService as unknown as new (...dependencies: unknown[]) => ConsentService)(database, budget);

  beforeEach(() => {
    query.mockReset();
    consume.mockReset();
    consume.mockImplementation(async () => undefined);
    withTransaction.mockClear();
    withSystemTransaction.mockClear();
  });

  /**
   * Answers the patient-decision transaction by statement: the recovery hold
   * read, the recent-authentication read and the decision command.
   */
  function patientDecision(options: { held?: boolean; recent?: boolean; result: Record<string, unknown> }) {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('from auth.otp_challenges')) return { rows: [{ held: options.held ?? false }] };
      if (sql.includes('as recent')) return { rows: [{ recent: options.recent ?? true }] };
      if (sql.includes('identity.approve_my_access_request') || sql.includes('identity.deny_my_access_request')
        || sql.includes('identity.revoke_my_consent_grant')) return { rows: [options.result] };
      return { rows: [] };
    });
  }
  const approvalResult = {
    accessRequestId: '40000000-0000-4000-8000-000000000004',
    consentGrantId: '60000000-0000-4000-8000-000000000004',
    patientId: '50000000-0000-4000-8000-000000000004',
    status: 'approved',
    expiresAt: new Date('2026-09-29T13:00:00.000Z'),
    replayed: false,
  };
  const statements = () => query.mock.calls.map(([sql]) => String(sql));

  const requestInput = {
    hid: 'HID-ABCDEFGH',
    scope: 'read_records' as const,
    reason: 'Direct treatment request',
    durationMinutes: 60,
  };
  /** What the database command returns: a recorded request names its patient; an unknown HID none (0086). */
  const commandRow = (patientId: string | null) => ({
    accessRequestId: '40000000-0000-4000-8000-000000000001',
    patientId,
    status: 'pending',
    scope: 'read_records',
    purpose: 'direct-care',
    durationMinutes: 60,
    requestedAt: new Date('2026-08-06T00:00:00.000Z'),
    existingRequest: false,
  });

  it('returns the governed access-request result without patient demographics or the patient id', async () => {
    query.mockResolvedValueOnce({ rows: [commandRow('50000000-0000-4000-8000-000000000001')] });

    const result = await service.createAccessRequest(context, requestInput);

    expect(result).toMatchObject({
      status: 'pending',
      scope: 'read_records',
      existingRequest: false,
    });
    expect(result).not.toHaveProperty('firstName');
    expect(result).not.toHaveProperty('patientId');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('identity.create_access_request'),
      ['HID-ABCDEFGH', 'read_records', 'Direct treatment request', 60],
    );
    expect(query.mock.calls[0]?.[0]).not.toContain('subject_patient_id');
  });

  it('answers an unknown HID in the same shape as a recorded request (PSEARCH-1)', async () => {
    query.mockResolvedValueOnce({ rows: [commandRow('50000000-0000-4000-8000-000000000001')] })
      .mockResolvedValueOnce({ rows: [commandRow(null)] });

    const recorded = await service.createAccessRequest(context, requestInput);
    const unknown = await service.createAccessRequest(context, { ...requestInput, hid: 'HID-NOBODYXY' });

    expect(Object.keys(unknown).sort()).toEqual(Object.keys(recorded).sort());
    expect(unknown).toEqual(recorded);
  });

  it('counts each access request against the budget before the command, and stops at 429', async () => {
    query.mockResolvedValueOnce({ rows: [commandRow('50000000-0000-4000-8000-000000000001')] });
    await service.createAccessRequest(context, requestInput);
    expect(consume).toHaveBeenCalledWith('access_request', context);

    query.mockReset();
    consume.mockImplementation(async () => {
      throw new DomainProblem(429, 'ACCESS_REQUEST_RATE_LIMITED', 'Too many access requests; wait and try again');
    });
    await expect(service.createAccessRequest(context, requestInput))
      .rejects.toMatchObject({ status: 429, code: 'ACCESS_REQUEST_RATE_LIMITED' });
    expect(query).not.toHaveBeenCalled();
  });

  it('maps unavailable exact-HID targets to a safe not-found problem', async () => {
    query.mockRejectedValueOnce({ code: 'P0002' });

    await expect(service.createAccessRequest(context, requestInput)).rejects.toMatchObject<Partial<DomainProblem>>({
      code: 'CONSENT_RESOURCE_NOT_FOUND',
    });
  });

  it('maps invalid state transitions to a conflict without leaking database details', async () => {
    query.mockRejectedValueOnce({ code: '55000', detail: 'sensitive database detail' });

    await expect(service.closeOwnGrant(
      context,
      '60000000-0000-4000-8000-000000000001',
      'Treatment relationship ended',
    )).rejects.toMatchObject<Partial<DomainProblem>>({
      code: 'CONSENT_COMMAND_CONFLICT',
    });
  });
  it.each(['42501', 'P0001', '55000'])(
    'fails emergency activation closed for database denial %s', async (code) => {
      query.mockResolvedValueOnce({ rows: [{}] }).mockRejectedValueOnce({ code });
      const expected = { '42501': 'CONSENT_COMMAND_DENIED', 'P0001': 'EMERGENCY_RATE_LIMITED', '55000': 'CONSENT_COMMAND_CONFLICT' }[code];
      await expect(service.activateBreakGlass({ ...context, purposeOfUse: 'emergency' }, {
        hid: 'HID-ABCDEFGH', reason: 'Emergency care required', durationMinutes: 30,
      })).rejects.toMatchObject({ code: expected });
    },
  );
  it('propagates audit/outbox failure without returning a grant', async () => {
    const outage = new Error('Synthetic durable audit outage');
    query.mockResolvedValueOnce({ rows: [{}] }).mockRejectedValueOnce(outage);
    await expect(service.activateBreakGlass({ ...context, purposeOfUse: 'emergency' }, {
      hid: 'HID-ABCDEFGH', reason: 'Emergency care required', durationMinutes: 30,
    })).rejects.toBe(outage);
  });

  it('rejects break-glass when the authoritative administrative control is disabled', async () => {
    query.mockRejectedValueOnce({ code: '55000', message: 'PLATFORM_CONTROL_DISABLED:break_glass_enabled' });
    await expect(service.activateBreakGlass({ ...context, purposeOfUse: 'emergency' }, {
      hid: 'HID-ABCDEFGH', reason: 'Emergency care required', durationMinutes: 30,
    })).rejects.toMatchObject({ code: 'BREAK_GLASS_DISABLED', status: 423 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('select platform.require_control_enabled($1)', ['break_glass_enabled']);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('identity.activate_break_glass'), expect.anything());
  });

  it('activates break-glass normally when the control is enabled, inside the same transaction', async () => {
    query.mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({
      rows: [{ accessRequestId: '40000000-0000-4000-8000-000000000011', consentGrantId: '60000000-0000-4000-8000-000000000011',
        patientId: '50000000-0000-4000-8000-000000000011', status: 'active',
        expiresAt: new Date('2026-10-08T01:00:00.000Z'), existingGrant: false }],
    });
    await expect(service.activateBreakGlass({ ...context, purposeOfUse: 'emergency' }, {
      hid: 'HID-ABCDEFGH', reason: 'Emergency care required', durationMinutes: 30,
    })).resolves.toMatchObject({ status: 'active', existingGrant: false });
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(1, 'select platform.require_control_enabled($1)', ['break_glass_enabled']);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('identity.activate_break_glass($1, $2, $3)'),
      ['HID-ABCDEFGH', 'Emergency care required', 30]);
  });

  it('fails closed when platform controls are unavailable', async () => {
    query.mockRejectedValueOnce({ code: '55000', message: 'PLATFORM_CONTROL_UNAVAILABLE' });
    await expect(service.activateBreakGlass({ ...context, purposeOfUse: 'emergency' }, {
      hid: 'HID-ABCDEFGH', reason: 'Emergency care required', durationMinutes: 30,
    })).rejects.toMatchObject({ code: 'PLATFORM_CONTROL_UNAVAILABLE', status: 503 });
  });



  it('lists only the exact staff membership access-request lifecycle', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        accessRequestId: '40000000-0000-4000-8000-000000000007',
        patientId: '50000000-0000-4000-8000-000000000007',
        scope: 'read_records',
        purposeOfUse: 'direct-care',
        reason: 'Continuity of care',
        status: 'approved',
        requestedDurationMinutes: 60,
        requestedAt: new Date('2026-09-29T12:00:00.000Z'),
        approvedAt: new Date('2026-09-29T12:01:00.000Z'),
        deniedAt: null,
        deniedReason: null,
      }],
    });
    await expect(service.listMyStaffAccessRequests(context, { status: 'approved' })).resolves.toHaveLength(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('identity.list_my_staff_access_requests($1)'),
      ['approved'],
    );
    // 0074: each approval's outcome (grant, expiry, effective status, method).
    const [sql] = query.mock.calls.find(([text]) => String(text).includes('list_my_staff_access_requests')) as [string];
    for (const column of ['consent_grant_id as "consentGrantId"', 'grant_expires_at as "grantExpiresAt"',
      'effective_status as "effectiveStatus"', 'authorization_method as "authorizationMethod"']) {
      expect(sql).toContain(column);
    }
  });

  it('lists the authenticated patient access request inbox without unrelated identity data', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{
        accessRequestId: '40000000-0000-4000-8000-000000000006',
        facilityId: '10000000-0000-4000-8000-000000000006',
        facilityName: 'Example Facility',
        scope: 'read_records',
        reason: 'Continuity of care',
        status: 'pending',
        requestedDurationMinutes: 60,
        requestedAt: new Date('2026-09-29T12:00:00.000Z'),
        approvedAt: null,
        deniedAt: null,
        deniedReason: null,
      }],
    });
    await expect(service.listMyAccessRequests(patientRequest)).resolves.toHaveLength(1);
    // Bound to the patient session, never to a staff facility context.
    expect(withTransaction).not.toHaveBeenCalled();
    expect(query).toHaveBeenNthCalledWith(1, "select set_config('app.actor_subject', $1, true)", ['patient:test']);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('identity.list_my_patient_access_requests($1, $2)'), patientSession);
  });

  it('returns the patient approval result from the governed consent command', async () => {
    patientDecision({ result: approvalResult });
    await expect(service.approveAccessRequest(patientRequest, '40000000-0000-4000-8000-000000000004'))
      .resolves.toMatchObject({ status: 'approved', replayed: false });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('identity.approve_my_access_request($1, $2, $3)'),
      [...patientSession, '40000000-0000-4000-8000-000000000004'],
    );
  });

  it('requires a recent sign-in to approve, checked in the decision transaction before the command (REC-NOTIFY)', async () => {
    patientDecision({ recent: false, result: approvalResult });
    await expect(service.approveAccessRequest(patientRequest, '40000000-0000-4000-8000-000000000004'))
      .rejects.toMatchObject({ status: 403, code: 'PATIENT_RECENT_AUTH_REQUIRED' });
    expect(statements().some((sql) => sql.includes('identity.approve_my_access_request'))).toBe(false);
    const recent = query.mock.calls.find(([sql]) => String(sql).includes('as recent'));
    expect(recent?.[1]).toEqual(['80000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000004']);
  });

  it('refuses a new approval for 24 hours after an OTP account recovery, even right after sign-in', async () => {
    patientDecision({ held: true, recent: true, result: approvalResult });
    await expect(service.approveAccessRequest(patientRequest, '40000000-0000-4000-8000-000000000004'))
      .rejects.toMatchObject({ status: 403, code: 'PATIENT_RECENT_RECOVERY_HOLD' });
    expect(statements().some((sql) => sql.includes('identity.approve_my_access_request'))).toBe(false);
    const hold = query.mock.calls.find(([sql]) => String(sql).includes('from auth.otp_challenges'));
    expect(hold?.[1]).toEqual(['70000000-0000-4000-8000-000000000001', 24]);
    expect(String(hold?.[0])).toContain('consumed_at');
  });

  it('keeps denial and revocation available during the recovery hold', async () => {
    patientDecision({ held: true, recent: false, result: { accessRequestId: '40000000-0000-4000-8000-000000000005',
      status: 'denied', replayed: false } });
    await expect(service.denyAccessRequest(patientRequest, '40000000-0000-4000-8000-000000000005', 'Not now'))
      .resolves.toMatchObject({ status: 'denied' });
    patientDecision({ held: true, recent: false, result: { consentGrantId: '60000000-0000-4000-8000-000000000006',
      status: 'revoked', replayed: false } });
    await expect(service.revokeMyConsentGrant(patientRequest, '60000000-0000-4000-8000-000000000006', 'No longer needed'))
      .resolves.toMatchObject({ status: 'revoked' });
    expect(statements().some((sql) => sql.includes('from auth.otp_challenges'))).toBe(false);
  });

  it('returns the patient denial result and trims the reason', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{
        accessRequestId: '40000000-0000-4000-8000-000000000005',
        patientId: '50000000-0000-4000-8000-000000000005',
        status: 'denied',
        deniedAt: new Date('2026-09-29T12:30:00.000Z'),
        replayed: false,
      }],
    });
    await expect(service.denyAccessRequest(
      patientRequest,
      '40000000-0000-4000-8000-000000000005',
      '  Not authorized  ',
    )).resolves.toMatchObject({ status: 'denied', replayed: false });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('identity.deny_my_access_request($1, $2, $3, $4)'),
      [...patientSession, '40000000-0000-4000-8000-000000000005', 'Not authorized'],
    );
  });

  it('rejects patient access-request decisions without a patient session', async () => {
    const staffRequest = { correlationId: 'consent-staff-correlation', actor: context.actor } as unknown as HidRequest;
    await expect(service.approveAccessRequest(staffRequest, '40000000-0000-4000-8000-000000000004'))
      .rejects.toMatchObject({ code: 'PATIENT_SESSION_REQUIRED' });
    await expect(service.listMyAccessRequests({ correlationId: 'consent-anonymous-correlation' } as HidRequest))
      .rejects.toMatchObject({ code: 'PATIENT_SESSION_REQUIRED' });
    expect(query).not.toHaveBeenCalled();
  });

  it('revokes a patient-granted access grant through the session-bound command', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ consentGrantId: '60000000-0000-4000-8000-000000000009', status: 'revoked',
        revokedAt: new Date('2026-10-08T00:00:00.000Z'), replayed: false }],
    });
    await expect(service.revokeMyConsentGrant(patientRequest, '60000000-0000-4000-8000-000000000009', '  No longer needed '))
      .resolves.toMatchObject({ status: 'revoked', replayed: false });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('identity.revoke_my_consent_grant($1, $2, $3, $4)'),
      [...patientSession, '60000000-0000-4000-8000-000000000009', 'No longer needed'],
    );
  });

  it('refuses patient revocation of break-glass or workforce grants as a conflict', async () => {
    query.mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce({ code: '55000', message: 'CONSENT_GRANT_NOT_PATIENT_REVOCABLE' });
    await expect(service.revokeMyConsentGrant(patientRequest, '60000000-0000-4000-8000-000000000010', 'Revoke'))
      .rejects.toMatchObject({ code: 'CONSENT_COMMAND_CONFLICT' });
  });

  it('returns a narrow governed grant only when the database command verifies the PIN', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        verified: true,
        accessRequestId: '40000000-0000-4000-8000-000000000002',
        consentGrantId: '40000000-0000-4000-8000-000000000003',
        patientId: '50000000-0000-4000-8000-000000000002',
        status: 'active',
        expiresAt: new Date('2026-09-28T00:15:00.000Z'),
        existingGrant: false,
      }],
    });
    await expect(service.verifyPatientAccessPin(context, {
      hid: 'HID-ABCDEFGH',
      pin: '1234',
      durationMinutes: 15,
    })).resolves.toMatchObject({
      status: 'active',
      patientId: '50000000-0000-4000-8000-000000000002',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('identity.access_patient_with_pin'),
      ['HID-ABCDEFGH', '1234', 15],
    );
  });

  it('denies an invalid patient access PIN without leaking scope', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        verified: false,
        accessRequestId: null,
        consentGrantId: null,
        patientId: null,
        status: null,
        expiresAt: null,
        existingGrant: false,
      }],
    });
    await expect(service.verifyPatientAccessPin(context, {
      hid: 'HID-ABCDEFGH',
      pin: '9999',
      durationMinutes: 15,
    })).rejects.toMatchObject<Partial<DomainProblem>>({
      code: 'PATIENT_PIN_ACCESS_DENIED',
    });
  });

  it('maps PIN authorization and target-state failures to one generic denial', async () => {
    for (const code of ['42501', 'P0001', 'P0002', '22023']) {
      query.mockRejectedValueOnce({ code, detail: 'sensitive target state' });
      await expect(service.verifyPatientAccessPin(context, {
        hid: 'HID-ABCDEFGH',
        pin: '1234',
        durationMinutes: 15,
      })).rejects.toMatchObject({ code: 'PATIENT_PIN_ACCESS_DENIED' });
    }
  });
});
