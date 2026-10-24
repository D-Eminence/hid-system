import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
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

describe('ConsentService', () => {
  const query = jest.fn();
  const client = { query } as unknown as PoolClient;
  const withTransaction = jest.fn(
    async (_context: DataAccessContext, operation: (transactionClient: PoolClient) => Promise<unknown>) =>
      operation(client),
  );
  const database = { withTransaction } as unknown as DatabaseService;
  const service = new ConsentService(database);

  beforeEach(() => {
    query.mockReset();
    withTransaction.mockClear();
  });

  it('returns the governed access-request result without patient demographics', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        accessRequestId: '40000000-0000-4000-8000-000000000001',
        patientId: '50000000-0000-4000-8000-000000000001',
        status: 'pending',
        scope: 'read_records',
        purpose: 'direct-care',
        durationMinutes: 60,
        requestedAt: new Date('2026-08-06T00:00:00.000Z'),
        existingRequest: false,
      }],
    });

    const result = await service.createAccessRequest(context, {
      hid: 'HID-ABCDEFGH',
      scope: 'read_records',
      reason: 'Direct treatment request',
      durationMinutes: 60,
    });

    // Exactly the request: no patient id before the patient consents, even when the row carries one.
    expect(result).toEqual({
      accessRequestId: '40000000-0000-4000-8000-000000000001', status: 'pending', scope: 'read_records',
      purpose: 'direct-care', durationMinutes: 60, requestedAt: new Date('2026-08-06T00:00:00.000Z'),
      existingRequest: false,
    });
    expect(result).not.toHaveProperty('patientId');
    expect(result).not.toHaveProperty('firstName');
    expect(String(query.mock.calls[0]![0])).not.toContain('subject_patient_id');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('identity.create_access_request'),
      ['HID-ABCDEFGH', 'read_records', 'Direct treatment request', 60],
    );
  });

  it('maps unavailable exact-HID targets to a safe not-found problem', async () => {
    query.mockRejectedValueOnce({ code: 'P0002' });

    await expect(service.createAccessRequest(context, {
      hid: 'HID-ABCDEFGH',
      scope: 'read_records',
      reason: 'Direct treatment request',
      durationMinutes: 60,
    })).rejects.toMatchObject<Partial<DomainProblem>>({
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
      expect(query).toHaveBeenCalledTimes(2);
    },
  );
  it('propagates audit/outbox failure without returning a grant', async () => {
    const outage = new Error('Synthetic durable audit outage');
    query.mockResolvedValueOnce({ rows: [{}] }).mockRejectedValueOnce(outage);
    await expect(service.activateBreakGlass({ ...context, purposeOfUse: 'emergency' }, {
      hid: 'HID-ABCDEFGH', reason: 'Emergency care required', durationMinutes: 30,
    })).rejects.toBe(outage);
  });

  // Break-glass in production (0085; main 0c4de59 and 17abba5 with its 0097).
  const emergency: DataAccessContext = { ...context, purposeOfUse: 'emergency' };
  const activation = { hid: 'HID-ABCDEFGH', reason: 'Emergency care required', durationMinutes: 30 };

  it('activates break-glass when the control is enabled, checking it first inside the same transaction', async () => {
    query.mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({
      rows: [{ accessRequestId: '40000000-0000-4000-8000-000000000011', consentGrantId: '60000000-0000-4000-8000-000000000011',
        patientId: '50000000-0000-4000-8000-000000000011', status: 'active',
        expiresAt: new Date('2026-10-24T01:00:00.000Z'), existingGrant: false }],
    });
    await expect(service.activateBreakGlass(emergency, activation))
      .resolves.toMatchObject({ consentGrantId: '60000000-0000-4000-8000-000000000011', status: 'active', existingGrant: false });
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(withTransaction).toHaveBeenCalledWith(emergency, expect.any(Function));
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(1, 'select platform.require_control_enabled($1)', ['break_glass_enabled']);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('identity.activate_break_glass($1, $2, $3)'),
      ['HID-ABCDEFGH', 'Emergency care required', 30]);
  });

  it('answers 423 BREAK_GLASS_DISABLED when the control is off, without running the activation', async () => {
    query.mockRejectedValueOnce({ code: '55000', message: 'PLATFORM_CONTROL_DISABLED:break_glass_enabled' });
    const refusal = service.activateBreakGlass(emergency, activation);
    await expect(refusal).rejects.toBeInstanceOf(DomainProblem);
    await expect(refusal).rejects.toMatchObject({ code: 'BREAK_GLASS_DISABLED', status: 423 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('select platform.require_control_enabled($1)', ['break_glass_enabled']);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('identity.activate_break_glass'), expect.anything());
  });

  it('answers 503 PLATFORM_CONTROL_UNAVAILABLE when the control row cannot be read', async () => {
    // platform.control_enabled (0040) raises this when the row is missing or
    // row-level security hides it from the function's owner.
    query.mockRejectedValueOnce({ code: '55000', message: 'PLATFORM_CONTROL_UNAVAILABLE' });
    await expect(service.activateBreakGlass(emergency, activation))
      .rejects.toMatchObject({ code: 'PLATFORM_CONTROL_UNAVAILABLE', status: 503 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another control', 'PLATFORM_CONTROL_DISABLED:uploads_enabled'],
    ['a prefix of the control message', 'PLATFORM_CONTROL_DISABLED:break_glass'],
    ['no message', undefined],
  ])('keeps every other 55000 a 409 conflict: %s', async (_case, message) => {
    query.mockRejectedValueOnce({ code: '55000', message });
    await expect(service.activateBreakGlass(emergency, activation))
      .rejects.toMatchObject({ code: 'CONSENT_COMMAND_CONFLICT', status: 409 });
  });

  it('keeps a 55000 conflict from the activation itself a 409', async () => {
    query.mockResolvedValueOnce({ rows: [{}] }).mockRejectedValueOnce({ code: '55000', message: 'Grant state changed' });
    await expect(service.activateBreakGlass(emergency, activation))
      .rejects.toMatchObject({ code: 'CONSENT_COMMAND_CONFLICT', status: 409 });
  });

  it('answers 423 BREAK_GLASS_DISABLED when no active emergency purpose of use exists', async () => {
    // identity.activate_break_glass (0031) refuses with 22023 when the
    // 'emergency' purpose is absent or inactive: before 0085, or after an
    // operator deactivates the code.
    query.mockResolvedValueOnce({ rows: [{}] }).mockRejectedValueOnce({
      code: '22023', message: 'Break-glass requires the emergency purpose of use',
    });
    await expect(service.activateBreakGlass(emergency, activation))
      .rejects.toMatchObject({ code: 'BREAK_GLASS_DISABLED', status: 423 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each(['Invalid break-glass duration', 'An explicit break-glass reason is required', undefined])(
    'keeps every other break-glass 22023 a 400: %s', async (message) => {
      query.mockResolvedValueOnce({ rows: [{}] }).mockRejectedValueOnce({ code: '22023', message });
      await expect(service.activateBreakGlass(emergency, activation))
        .rejects.toMatchObject({ code: 'INVALID_CONSENT_COMMAND', status: 400 });
    },
  );

  it('keeps the emergency-purpose message a 400 outside break-glass activation', async () => {
    query.mockRejectedValueOnce({ code: '22023', message: 'Break-glass requires the emergency purpose of use' });
    await expect(service.closeOwnGrant(context, '60000000-0000-4000-8000-000000000001', 'Treatment relationship ended'))
      .rejects.toMatchObject({ code: 'INVALID_CONSENT_COMMAND', status: 400 });
  });

  it('propagates a failure of the control read itself unchanged', async () => {
    const lost = new Error('Connection terminated unexpectedly');
    query.mockRejectedValueOnce(lost);
    await expect(service.activateBreakGlass(emergency, activation)).rejects.toBe(lost);
    expect(query).toHaveBeenCalledTimes(1);
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
  });

  it('lists the authenticated patient access request inbox without unrelated identity data', async () => {
    query.mockResolvedValueOnce({
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
    await expect(service.listMyAccessRequests(context)).resolves.toHaveLength(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('identity.list_my_access_requests()'));
  });

  it('returns the patient approval result from the governed consent command', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        accessRequestId: '40000000-0000-4000-8000-000000000004',
        consentGrantId: '60000000-0000-4000-8000-000000000004',
        patientId: '50000000-0000-4000-8000-000000000004',
        status: 'approved',
        expiresAt: new Date('2026-09-29T13:00:00.000Z'),
        replayed: false,
      }],
    });
    await expect(service.approveAccessRequest(context, '40000000-0000-4000-8000-000000000004'))
      .resolves.toMatchObject({ status: 'approved', replayed: false });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('identity.approve_access_request'),
      ['40000000-0000-4000-8000-000000000004'],
    );
  });

  it('returns the patient denial result and trims the reason', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        accessRequestId: '40000000-0000-4000-8000-000000000005',
        patientId: '50000000-0000-4000-8000-000000000005',
        status: 'denied',
        deniedAt: new Date('2026-09-29T12:30:00.000Z'),
        replayed: false,
      }],
    });
    await expect(service.denyAccessRequest(
      context,
      '40000000-0000-4000-8000-000000000005',
      '  Not authorized  ',
    )).resolves.toMatchObject({ status: 'denied', replayed: false });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('identity.deny_access_request'),
      ['40000000-0000-4000-8000-000000000005', 'Not authorized'],
    );
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
