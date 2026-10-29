import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { DataAccessContext, PlatformAdminContext } from '../common/request-context';
import { DomainProblem } from '../common/problem';
import type { DatabaseService } from '../database/database.service';
import { EmergencyContactProtector } from '../patient-safety/emergency-contact-protector';
import { usePatientSafetyTestEnvironment } from '../../test/patient-safety.fixtures';
import { AdminService } from './admin.service';

const context: DataAccessContext = {
  correlationId: 'admin-test-correlation',
  facilityId: '10000000-0000-4000-8000-000000000002',
  membershipId: '40000000-0000-4000-8000-000000000001',
  purposeOfUse: 'healthcare-operations',
  actor: {
    id: 'staff:admin', subject: 'staff:admin',
    accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['support'], permissions: [], platformRoles: ['platform_super_admin'],
    platformPermissions: ['platform.admin.access', 'platform.facility.manage'],
    facilityIds: ['10000000-0000-4000-8000-000000000002'], facilities: [],
    authenticationMethod: 'local',
  },
};

function harness(row: Readonly<Record<string, unknown>>, protector = {} as EmergencyContactProtector) {
  const client = { query: jest.fn().mockResolvedValue({ rows: [row], rowCount: 1 }) };
  const database = { withPlatformTransaction: jest.fn(async (_context, operation) =>
    operation(client as unknown as PoolClient)) };
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminService(database as unknown as DatabaseService, audit as unknown as AuditService, protector);
  return { service, client, audit, database };
}

describe('AdminService governed commands', () => {
  it('persists a reasoned semantic audit event for a new facility transition', async () => {
    const { service, client, audit } = harness({ facility_id: '10000000-0000-4000-8000-000000000002',
      lifecycle_status: 'suspended', row_version: '3', replayed: false });

    await expect(service.transitionFacility(context, '10000000-0000-4000-8000-000000000002', 2,
      { status: 'suspended', reason: 'Confirmed governance suspension' },
      'admin-command-key-0001')).resolves.toEqual({
        facilityId: '10000000-0000-4000-8000-000000000002', status: 'suspended', version: 3, replayed: false,
      });

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('identity.admin_transition_facility'),
      expect.arrayContaining([2, 'suspended', 'Confirmed governance suspension', 'admin-command-key-0001']));
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.facility.suspended', reason: 'Confirmed governance suspension', outcome: 'success',
    }));
  });

  it('does not duplicate semantic audit evidence on an idempotent replay', async () => {
    const { service, audit } = harness({ facility_id: '10000000-0000-4000-8000-000000000002',
      lifecycle_status: 'suspended', row_version: '3', replayed: true });
    await service.transitionFacility(context, '10000000-0000-4000-8000-000000000002', 2,
      { status: 'suspended', reason: 'Confirmed governance suspension' }, 'admin-command-key-0001');
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('maps optimistic concurrency failures to a safe conflict', async () => {
    const { service, client } = harness({});
    client.query.mockRejectedValue(new Error('ADMIN_VERSION_CONFLICT internal detail'));
    const promise = service.transitionFacility(context, '10000000-0000-4000-8000-000000000002', 2,
      { status: 'suspended', reason: 'Confirmed governance suspension' }, 'admin-command-key-0001');
    const error = await promise.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DomainProblem);
    expect((error as DomainProblem).getStatus()).toBe(409);
    expect((error as DomainProblem).code).toBe('VERSION_CONFLICT');
  });

  it('changes a platform control and audits it once', async () => {
    const { service, client, audit } = harness({ control_key: 'uploads_enabled', enabled: false,
      row_version: '4', replayed: false });
    await expect(service.setPlatformControl(context,
      { controlKey: 'uploads_enabled', enabled: false, reason: '  Pause uploads for review  ' }, 3))
      .resolves.toEqual({ controlKey: 'uploads_enabled', enabled: false, version: 4, replayed: false });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('platform.admin_set_control'),
      ['uploads_enabled', false, 3, 'Pause uploads for review']);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.platform-control.change', resourceId: 'uploads_enabled',
    }));
  });

  // The control command raises ADMIN_* errors (0078); the page needs the same
  // safe answers as every other governed command, not an unhandled 500.
  it.each([
    ['ADMIN_VERSION_CONFLICT', 409, 'VERSION_CONFLICT'],
    ['ADMIN_PERMISSION_DENIED', 403, 'PERMISSION_DENIED'],
    ['ADMIN_INVALID_CONTROL', 400, 'ADMIN_COMMAND_INVALID'],
  ] as const)('maps a control command %s to %i', async (message, status, code) => {
    const { service, client, audit } = harness({});
    client.query.mockRejectedValue(new Error(message));
    const error = await service.setPlatformControl(context,
      { controlKey: 'uploads_enabled', enabled: false, reason: 'Pause uploads for review' }, 3)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DomainProblem);
    expect((error as DomainProblem).getStatus()).toBe(status);
    expect((error as DomainProblem).code).toBe(code);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it.each([
    ['grant', true],
    ['revoke', false],
  ] as const)('audits a platform role %s exactly once', async (action, active) => {
    const { service, audit } = harness({ account_id: '20000000-0000-4000-8000-000000000002',
      role_code: 'support_admin', active, account_version: '5', replayed: false });
    await service.changePlatformRole(context, '20000000-0000-4000-8000-000000000002', 4,
      { roleCode: 'support_admin', action, reason: `Governed role ${action} test` },
      `admin-role-${action}-command-0001`);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: `admin.platform-role.${action}`, reason: `Governed role ${action} test`,
    }));
  });


  it('exports principals with audited writable transaction semantics and CSV escaping', async () => {
    const client = { query: jest.fn().mockResolvedValue({
      rows: [{
        id: '20000000-0000-4000-8000-000000000003',
        subject: 'staff:export-test',
        email: 'admin@example.com',
        displayName: 'Admin, Test',
        status: 'active',
        version: '7',
        createdAt: new Date('2026-09-29T12:00:00.000Z'),
        activeSessionCount: '2',
        memberships: [{ facilityId: '10000000-0000-4000-8000-000000000002', facilityName: 'Main, Facility',
          role: 'admin', appRole: 'facility_admin', active: true, version: 3 }],
        platformRoles: ['platform_admin', 'support'],
      }],
    }) };
    const calls: unknown[] = [];
    const database = { withPlatformTransaction: jest.fn(async (_context, operation, options) => {
      calls.push(options);
      return operation(client as unknown as PoolClient);
    }) };
    const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) };
    const service = new AdminService(database as unknown as DatabaseService, audit as unknown as AuditService,
      {} as EmergencyContactProtector);

    await expect(service.exportPrincipals(context, {} as never)).resolves.toContain(
      '"Admin, Test"'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeUndefined();
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.principals.export',
      outcome: 'success',
    }));
  });

  it('audits authoritative account suspension and session revocation commands', async () => {
    const suspended = harness({ account_id: '20000000-0000-4000-8000-000000000002',
      account_status: 'disabled', row_version: '3', replayed: false });
    await suspended.service.transitionAccount(context, '20000000-0000-4000-8000-000000000002', 2,
      { status: 'disabled', reason: 'Governed account suspension' }, 'admin-account-command-0001');
    expect(suspended.audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.account.disabled', reason: 'Governed account suspension',
    }));

    const revoked = harness({ account_id: '20000000-0000-4000-8000-000000000002',
      revoked_count: 2, replayed: false });
    await revoked.service.revokeSessions(context, '20000000-0000-4000-8000-000000000002',
      { reason: 'Governed session revocation' }, 'admin-session-command-0001');
    expect(revoked.audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.account.sessions-revoked', reason: 'Governed session revocation',
    }));
  });
});

const platformContext: PlatformAdminContext = {
  correlationId: 'admin-test-correlation', purposeOfUse: 'healthcare-operations',
  actor: { ...context.actor, id: 'staff:support', subject: 'staff:support', facilityIds: [], roles: [],
    platformRoles: ['support_admin'],
    platformPermissions: ['platform.admin.access', 'platform.facility.manage', 'platform.emergency-contact.manage'] },
};
const facilityId = '10000000-0000-4000-8000-000000000002';

async function problem(promise: Promise<unknown>): Promise<DomainProblem> {
  const error = await promise.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

describe('AdminService facility alert phone', () => {
  it.each([
    ['0803 000 0000', '+2348030000000'],
    ['+234 803 000 0000', '+2348030000000'],
    ['(0803) 000-0000', '+2348030000000'],
    ['+447700900123', '+447700900123'],
  ])('normalizes %p, stores it and audits whether it was cleared, never its digits', async (phone, stored) => {
    const { service, client, audit } = harness({ facility_id: facilityId, phone_e164: stored,
      facility_version: '4', replayed: false });
    await expect(service.setFacilityAlertPhone(platformContext, facilityId, 3,
      { phone, reason: '  Facility front desk line  ' }, 'admin-alert-phone-0001'))
      .resolves.toEqual({ facilityId, alertPhoneE164: stored, version: 4, replayed: false });
    const [sql, parameters] = client.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('identity.admin_set_facility_alert_phone($1, $2, $3, $4, $5, $6)');
    expect(parameters.slice(0, 5)).toEqual([facilityId, 3, stored, 'Facility front desk line', 'admin-alert-phone-0001']);
    expect(parameters[5]).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    const event = audit.recordWithClient.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(event).toMatchObject({ action: 'admin.facility.alert-phone.change', actorType: 'platform',
      resourceType: 'facility', resourceId: facilityId, reason: 'Facility front desk line',
      details: { version: 4, cleared: false } });
    expect(JSON.stringify(event)).not.toMatch(/803|7700900/);
  });

  it('clears the phone with null', async () => {
    const { service, client, audit } = harness({ facility_id: facilityId, phone_e164: null, facility_version: '5', replayed: false });
    await expect(service.setFacilityAlertPhone(platformContext, facilityId, 4,
      { phone: null, reason: 'Number no longer staffed' }, 'admin-alert-phone-0002'))
      .resolves.toEqual({ facilityId, alertPhoneE164: null, version: 5, replayed: false });
    expect((client.query.mock.calls[0] as [string, unknown[]])[1][2]).toBeNull();
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: { version: 5, cleared: true } }));
  });

  it('does not audit an idempotent replay twice', async () => {
    const { service, audit } = harness({ facility_id: facilityId, phone_e164: '+2348030000000', facility_version: '4', replayed: true });
    await expect(service.setFacilityAlertPhone(platformContext, facilityId, 3,
      { phone: '08030000000', reason: 'Facility front desk line' }, 'admin-alert-phone-0001'))
      .resolves.toMatchObject({ replayed: true });
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it.each(['not a phone', '12345', '+0803000000', '0803000000', ''])(
    'refuses %p as 400 ADMIN_INVALID_FACILITY_PHONE before any database work', async (phone) => {
      const { service, database } = harness({});
      const refused = await problem(service.setFacilityAlertPhone(platformContext, facilityId, 3,
        { phone, reason: 'Facility front desk line' }, 'admin-alert-phone-0003'));
      expect([refused.getStatus(), refused.code]).toEqual([400, 'ADMIN_INVALID_FACILITY_PHONE']);
      expect(database.withPlatformTransaction).not.toHaveBeenCalled();
    });

  it.each([
    ['ADMIN_INVALID_FACILITY_PHONE', 400, 'ADMIN_INVALID_FACILITY_PHONE'],
    ['ADMIN_PERMISSION_DENIED', 403, 'PERMISSION_DENIED'],
    ['ADMIN_VERSION_CONFLICT', 409, 'VERSION_CONFLICT'],
    ['ADMIN_IDEMPOTENCY_CONFLICT', 409, 'IDEMPOTENCY_CONFLICT'],
    ['ADMIN_FACILITY_NOT_FOUND', 404, 'ADMIN_RESOURCE_NOT_FOUND'],
    ['ADMIN_NO_STATE_CHANGE', 409, 'ADMIN_STATE_CONFLICT'],
  ] as const)('maps the command error %s to %i %s', async (message, status, code) => {
    const { service, client, audit } = harness({});
    client.query.mockRejectedValue(Object.assign(new Error(message), { code: '22023' }));
    const refused = await problem(service.setFacilityAlertPhone(platformContext, facilityId, 3,
      { phone: '08030000000', reason: 'Facility front desk line' }, 'admin-alert-phone-0004'));
    expect([refused.getStatus(), refused.code]).toEqual([status, code]);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('returns the facility alert phone with the admin facility read', async () => {
    const updatedAt = new Date('2026-10-23T10:00:00Z');
    const { service, client } = harness({ id: facilityId, organizationId: 'organization', organizationName: 'Org',
      name: 'Lagos General', code: 'LGH', status: 'verified', version: '4', statusReason: null, statusChangedAt: null,
      createdAt: updatedAt, membershipCount: '3', alertPhoneE164: '+2348030000000', alertPhoneUpdatedAt: updatedAt });
    await expect(service.facility(platformContext, facilityId)).resolves.toMatchObject({
      version: 4, membershipCount: 3, alertPhoneE164: '+2348030000000', alertPhoneUpdatedAt: updatedAt });
    expect(String(client.query.mock.calls[0]?.[0])).toContain('left join identity.facility_alert_phones');
  });

  it('answers null for a facility that never had an alert phone', async () => {
    const { service } = harness({ id: facilityId, version: '1', membershipCount: '0', alertPhoneE164: null,
      alertPhoneUpdatedAt: null });
    await expect(service.facility(platformContext, facilityId))
      .resolves.toMatchObject({ alertPhoneE164: null, alertPhoneUpdatedAt: null });
  });
});

describe('AdminService sealed demo facilities (0098)', () => {
  const platformAdmin = platformContext;
  const facilityRow = { id: '10000000-0000-4000-8000-000000000009', organizationId: 'organization',
    organizationName: 'Demo Hospital', name: 'Demo Hospital', code: 'DEMO-HOSPITAL', status: 'verified', version: '1',
    statusReason: null, statusChangedAt: null, createdAt: new Date('2026-10-29T10:00:00Z'), membershipCount: '1' };

  it.each([[true, true], [false, false], [null, false], [undefined, false]] as const)(
    'marks the facility detail demo: %s -> %s, from the database helper', async (answer, demo) => {
      const { service, client } = harness({ ...facilityRow, demo: answer });
      await expect(service.facility(platformAdmin, facilityRow.id)).resolves.toMatchObject({ demo, version: 1 });
      expect(String(client.query.mock.calls[0]?.[0])).toContain('identity.sealed_demo_facility(facility.id) as demo');
    });

  it('marks each listed facility and leaves the count query as it was', async () => {
    const { service, client } = harness({ ...facilityRow, demo: true, count: '1' });
    const listed = await service.listFacilities(platformAdmin, { page: 1, pageSize: 20 } as never);
    expect(listed.items.map((item) => item.demo)).toEqual([true]);
    expect(String(client.query.mock.calls[0]?.[0])).toContain('identity.sealed_demo_facility(facility.id) as demo');
    expect(String(client.query.mock.calls[1]?.[0])).not.toContain('sealed_demo');
  });

  const principalRow = { id: '98d00003-0000-4000-8000-000000000001', subject: 'sealed-demo:98d00003',
    email: 'operations@healthidentitydirectory.com', displayName: 'Demo Operations', status: 'pending_reset',
    version: '1', createdAt: new Date('2026-10-29T10:00:00Z'), activeSessionCount: '0', memberships: [],
    platformRoles: [] };
  const demoColumn = "(account.id = any((select identity.sealed_demo_ids('account'))::uuid[])) as demo";

  it.each([[true, true], [false, false], [null, false], [undefined, false]] as const)(
    'marks each listed or searched principal demo: %s -> %s, and leaves the count query as it was',
    async (answer, demo) => {
      const { service, client } = harness({ ...principalRow, demo: answer, count: '1' });
      const listed = await service.listPrincipals(platformAdmin,
        { page: 1, pageSize: 20, query: 'operations' } as never);
      expect(listed.items).toEqual([expect.objectContaining({ id: principalRow.id, demo, version: 1 })]);
      expect(String(client.query.mock.calls[0]?.[0])).toContain(demoColumn);
      expect(String(client.query.mock.calls[1]?.[0])).not.toContain('sealed_demo');
    });

  it('marks an identity review at a demo facility', async () => {
    const { service, client } = harness({ id: 'review', facilityId: '98d00002-0000-4000-8000-000000000001',
      facilityName: 'Demo Hospital', status: 'review_required', maskedNin: 'NIN-****1234', provider: 'qoreid',
      candidateCount: '0', version: '1', createdAt: new Date(), updatedAt: new Date(), demo: true, count: '1' });
    const listed = await service.listIdentityReviews(platformAdmin, { page: 1, pageSize: 20 } as never);
    expect(listed.items.map((item) => item.demo)).toEqual([true]);
    expect(String(client.query.mock.calls[0]?.[0])).toContain('identity.sealed_demo_facility(registration.facility_id) as demo');
    expect(String(client.query.mock.calls[1]?.[0])).not.toContain('sealed_demo');
  });

  it('marks platform audit events at a demo facility or by a demo login, from one read per page', async () => {
    const events = [
      { sequenceId: '3', facilityId: '98d00002-0000-4000-8000-000000000002', actorSubject: 'staff:real' },
      { sequenceId: '2', facilityId: null, actorSubject: 'patient:98d00008-0000-4000-8000-000000000001' },
      { sequenceId: '1', facilityId: '10000000-0000-4000-8000-000000000002', actorSubject: 'staff:real' },
    ];
    const client = { query: jest.fn(async (sql: string) => sql.includes('audit.list_platform_events')
      ? { rows: events }
      : { rows: [{ facilities: ['98d00002-0000-4000-8000-000000000002'],
          subjects: ['patient:98d00008-0000-4000-8000-000000000001'] }] }) };
    const database = { withPlatformTransaction: jest.fn(async (_context, operation) =>
      operation(client as unknown as PoolClient)) };
    const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) };
    const service = new AdminService(database as unknown as DatabaseService, audit as unknown as AuditService,
      {} as EmergencyContactProtector);
    const listed = await service.listAudit(platformAdmin, { limit: 3 } as never);
    expect(listed.items.map((item) => [item.sequenceId, item.demo])).toEqual([['3', true], ['2', true], ['1', false]]);
    expect(listed.nextBeforeSequenceId).toBe('1');
    expect(client.query.mock.calls.filter(([sql]) => String(sql).includes("identity.sealed_demo_ids('account')")))
      .toHaveLength(1);
  });

  it('adds a demo column to the principal export', async () => {
    const { service, client } = harness({ ...principalRow, demo: true });
    // The export's own row and cell separators and quoting (this.csv) are unchanged; the last cell is the flag.
    const lastCells = (csv: string) => csv.split('\\n').slice(0, 2).map((line) => line.split(',').at(-1)?.replace(/"/g, ''));
    expect(lastCells(await service.exportPrincipals(platformAdmin, {} as never))).toEqual(['demo', 'true']);
    expect(String(client.query.mock.calls[0]?.[0])).toContain(demoColumn);
    const real = harness({ ...principalRow, id: '20000000-0000-4000-8000-000000000009', demo: false });
    expect(lastCells(await real.service.exportPrincipals(platformAdmin, {} as never))).toEqual(['demo', 'false']);
  });
});

describe('AdminService emergency-contact opt-out', () => {
  usePatientSafetyTestEnvironment();

  it.each([
    ['email', ' Chidi@Example.TEST ', 'chidi@example.test'],
    ['sms', '0803 123 4567', '+2348031234567'],
  ] as const)('normalizes and keys a %s destination, and never sends, logs or audits it', async (channel, destination, normalized) => {
    const protector = new EmergencyContactProtector();
    const { service, client, audit } = harness({ contact_count: 2, patient_count: 2, replayed: false }, protector);
    const logged = (['log', 'warn', 'error', 'debug', 'verbose'] as const)
      .map((level) => jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
    const written = jest.spyOn(process.stdout, 'write');
    try {
      await expect(service.optOutEmergencyContact(platformContext, { channel, destination,
        reason: 'Contact called support to stop alerts' }, 'admin-opt-out-key-0001'))
        .resolves.toEqual({ contacts: 2, patients: 2, replayed: false });
      for (const spy of [...logged, written]) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(normalized);
      }
    } finally {
      for (const spy of [...logged, written]) spy.mockRestore();
    }
    const [sql, parameters] = client.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('identity.admin_opt_out_emergency_contact($1, $2, $3, $4, $5)');
    expect(parameters.slice(0, 4)).toEqual([channel, protector.destinationHmac(channel, normalized),
      'Contact called support to stop alerts', 'admin-opt-out-key-0001']);
    expect(parameters[4]).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    const event = audit.recordWithClient.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(event).toMatchObject({ action: 'admin.emergency-contact.opt-out', actorType: 'platform',
      resourceType: 'emergency-contact', details: { channel, contacts: 2, patients: 2 } });
    expect(Object.keys(event.details as object).sort()).toEqual(['channel', 'contacts', 'patients']);
    expect(event.reason).toBe("Emergency-access alerts stopped at the recipient's request");
    const everything = JSON.stringify([client.query.mock.calls, audit.recordWithClient.mock.calls]);
    for (const value of [destination.trim(), normalized, normalized.slice(1), '8031234567']) {
      expect(everything).not.toContain(value);
    }
  });

  it('never audits the typed reason, which may quote the destination', async () => {
    const { service, audit } = harness({ contact_count: 1, patient_count: 1, replayed: false }, new EmergencyContactProtector());
    await service.optOutEmergencyContact(platformContext, { channel: 'email', destination: 'chidi@example.test',
      reason: 'chidi@example.test asked us to stop the alerts' }, 'admin-opt-out-key-0009');
    expect(JSON.stringify(audit.recordWithClient.mock.calls)).not.toContain('chidi@example.test');
  });

  it('keys the same destination to the same request digest however it is typed', async () => {
    const protector = new EmergencyContactProtector();
    const first = harness({ contact_count: 1, patient_count: 1, replayed: false }, protector);
    const second = harness({ contact_count: 1, patient_count: 1, replayed: true }, protector);
    await first.service.optOutEmergencyContact(platformContext, { channel: 'sms', destination: '08031234567',
      reason: 'Contact called support to stop alerts' }, 'admin-opt-out-key-0002');
    await expect(second.service.optOutEmergencyContact(platformContext, { channel: 'sms', destination: '+234 803 123 4567',
      reason: 'Contact called support to stop alerts' }, 'admin-opt-out-key-0002')).resolves.toMatchObject({ replayed: true });
    expect((first.client.query.mock.calls[0] as [string, unknown[]])[1])
      .toEqual((second.client.query.mock.calls[0] as [string, unknown[]])[1]);
    expect(second.audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('answers zero counts when no contact matches', async () => {
    const { service } = harness({ contact_count: 0, patient_count: 0, replayed: false }, new EmergencyContactProtector());
    await expect(service.optOutEmergencyContact(platformContext, { channel: 'email', destination: 'nobody@example.test',
      reason: 'Contact called support to stop alerts' }, 'admin-opt-out-key-0003'))
      .resolves.toEqual({ contacts: 0, patients: 0, replayed: false });
  });

  it('refuses an invalid destination before any database work', async () => {
    const { service, database } = harness({}, new EmergencyContactProtector());
    const refused = await problem(service.optOutEmergencyContact(platformContext, { channel: 'sms', destination: 'not a phone',
      reason: 'Contact called support to stop alerts' }, 'admin-opt-out-key-0004'));
    expect([refused.getStatus(), refused.code]).toEqual([400, 'EMERGENCY_CONTACT_DESTINATION_INVALID']);
    expect(database.withPlatformTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['ADMIN_PERMISSION_DENIED', 403, 'PERMISSION_DENIED'],
    ['ADMIN_INVALID_REASON', 400, 'ADMIN_COMMAND_INVALID'],
    ['ADMIN_IDEMPOTENCY_CONFLICT', 409, 'IDEMPOTENCY_CONFLICT'],
  ] as const)('maps the command error %s to %i %s, without an audit row', async (message, status, code) => {
    const { service, client, audit } = harness({}, new EmergencyContactProtector());
    client.query.mockRejectedValue(Object.assign(new Error(message), { code: '42501' }));
    const refused = await problem(service.optOutEmergencyContact(platformContext, { channel: 'email',
      destination: 'chidi@example.test', reason: 'Contact called support to stop alerts' }, 'admin-opt-out-key-0005'));
    expect([refused.getStatus(), refused.code]).toEqual([status, code]);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });
});

describe('AdminService emergency-contact opt-out without contact keys', () => {
  usePatientSafetyTestEnvironment({ OTP_HMAC_KEY_B64: '' });

  it('answers 503 and runs no command', async () => {
    const { service, database } = harness({}, new EmergencyContactProtector());
    const refused = await problem(service.optOutEmergencyContact(platformContext, { channel: 'email',
      destination: 'chidi@example.test', reason: 'Contact called support to stop alerts' }, 'admin-opt-out-key-0006'));
    expect([refused.getStatus(), refused.code]).toEqual([503, 'EMERGENCY_CONTACTS_UNAVAILABLE']);
    expect(database.withPlatformTransaction).not.toHaveBeenCalled();
  });
});
