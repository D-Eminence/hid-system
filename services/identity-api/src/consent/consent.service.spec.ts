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

    expect(result).toMatchObject({
      status: 'pending',
      scope: 'read_records',
      existingRequest: false,
    });
    expect(result).not.toHaveProperty('firstName');
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
      query.mockRejectedValueOnce({ code });
      const expected = { '42501': 'CONSENT_COMMAND_DENIED', P0001: 'EMERGENCY_RATE_LIMITED', '55000': 'CONSENT_COMMAND_CONFLICT' }[code];
      await expect(service.activateBreakGlass({ ...context, purposeOfUse: 'emergency' }, {
        hid: 'HID-ABCDEFGH', reason: 'Emergency care required', durationMinutes: 30,
      })).rejects.toMatchObject({ code: expected });
    },
  );
  it('propagates audit/outbox failure without returning a grant', async () => {
    const outage = new Error('Synthetic durable audit outage');
    query.mockRejectedValueOnce(outage);
    await expect(service.activateBreakGlass({ ...context, purposeOfUse: 'emergency' }, {
      hid: 'HID-ABCDEFGH', reason: 'Emergency care required', durationMinutes: 30,
    })).rejects.toBe(outage);
  });



  it('lists only the exact staff membership access-request lifecycle', async () => {
    query.mockResolvedValueOnce({ rows: [{
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
    }]});
    await expect(service.listMyStaffAccessRequests(context, { status: 'approved' }))
      .resolves.toHaveLength(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('identity.list_my_staff_access_requests($1)'),
      ['approved'],
    );
  });

  it('lists the authenticated patient access request inbox without unrelated identity data', async () =>
    query.mockResolvedValueOnce({ rows: [{
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
    }]});
    await expect(service.listMyAccessRequests(context)).resolves.toHaveLength(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('identity.list_my_access_requests()'));
  });

  it('returns the patient approval result from the governed consent command', async () => {
    query.mockResolvedValueOnce({ rows: [{
      accessRequestId: '40000000-0000-4000-8000-000000000004',
      consentGrantId: '60000000-0000-4000-8000-000000000004',
      patientId: '50000000-0000-4000-8000-000000000004',
      status: 'approved',
      expiresAt: new Date('2026-09-29T13:00:00.000Z'),
      replayed: false,
    }]});
    await expect(service.approveAccessRequest(context, '40000000-0000-4000-8000-000000000004'))
      .resolves.toMatchObject({ status: 'approved', replayed: false });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('identity.approve_access_request'),
      ['40000000-0000-4000-8000-000000000004'],
    );
  });

  it('returns the patient denial result and trims the reason', async () => {
    query.mockResolvedValueOnce({ rows: [{
      accessRequestId: '40000000-0000-4000-8000-000000000005',
      patientId: '50000000-0000-4000-8000-000000000005',
      status: 'denied',
      deniedAt: new Date('2026-09-29T12:30:00.000Z'),
      replayed: false,
    }]});
    await expect(service.denyAccessRequest(
      context, '40000000-0000-4000-8000-000000000005', '  Not authorized  ',
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
      hid: 'HID-ABCDEFGH', pin: '1234', durationMinutes: 15,
    })).resolves.toMatchObject({
      status: 'active',
      patientId: '50000000-0000-4000-8000-000000000002',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('identity.access_patient_with_pin'),
      ['HID-ABCDEFGH', '1234', 15],
    );
  });

  it('turns failed, locked, unknown, or revoked PIN results into one generic denial', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        verified: false, accessRequestId: null, consentGrantId: null, patientId: null,
        status: null, expiresAt: null, existingGrant: false,
      }],
    });
    await expect(service.verifyPatientAccessPin(context, {
      hid: 'HID-ABCDEFGH', pin: '9999', durationMinutes: 15,
    })).rejects.toMatchObject<Partial<DomainProblem>>({
      code: 'PATIENT_PIN_ACCESS_DENIED',
    });
  });

  it.each(['42501', 'P0001', 'P0002', '22023'])(
    'does not leak patient scope or authorization failures from PIN verification (%s)',
    async (code) => {
      query.mockRejectedValueOnce({ code, detail: 'sensitive target state' });
      await expect(service.verifyPatientAccessPin(context, {
        hid: 'HID-ABCDEFGH', pin: '1234', durationMinutes: 15,
      })).rejects.toMatchObject({ code: 'PATIENT_PIN_ACCESS_DENIED' });
    },
  );

});
