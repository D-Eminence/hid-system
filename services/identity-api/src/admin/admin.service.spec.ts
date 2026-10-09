import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { PlatformAccessContext } from '../common/request-context';
import { DomainProblem } from '../common/problem';
import type { DatabaseService } from '../database/database.service';
import { assuredClient, platformActor, useTestEnvironment } from '../testing/platform-assurance';
import { AdminService, PRINCIPAL_EXPORT_MAX_ROWS } from './admin.service';

const context: PlatformAccessContext = {
  scope: 'platform',
  correlationId: 'admin-test-correlation',
  facilityId: null,
  membershipId: null,
  purposeOfUse: 'healthcare-operations',
  actor: platformActor({ id: 'staff:admin', subject: 'staff:admin' }),
};

function harness(row: Readonly<Record<string, unknown>>, assurance: { stepUpFresh?: boolean; active?: boolean } = {}) {
  const command = jest.fn().mockResolvedValue({ rows: [row], rowCount: 1 });
  const client = assuredClient(command, assurance);
  const database = { withTransaction: jest.fn(async (_context, operation) =>
    operation(client as unknown as PoolClient)) };
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminService(database as unknown as DatabaseService, audit as unknown as AuditService);
  return { service, client, command, audit };
}

function exportService(rows: Record<string, unknown>[]) {
  const command = jest.fn().mockResolvedValue({ rows, rowCount: rows.length });
  const client = assuredClient(command);
  const options: unknown[] = [];
  const database = { withTransaction: jest.fn(async (_context, operation, transactionOptions) => {
    options.push(transactionOptions);
    return operation(client as unknown as PoolClient);
  }) };
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) };
  return { service: new AdminService(database as unknown as DatabaseService, audit as unknown as AuditService),
    command, audit, options };
}

useTestEnvironment();

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

  it('records platform-scoped semantic audit without a borrowed facility or membership', async () => {
    const { service, audit } = harness({ facility_id: '10000000-0000-4000-8000-000000000002',
      lifecycle_status: 'suspended', row_version: '3', replayed: false });
    await service.transitionFacility(context, '10000000-0000-4000-8000-000000000002', 2,
      { status: 'suspended', reason: 'Confirmed governance suspension' }, 'admin-command-key-0001');
    const event = audit.recordWithClient.mock.calls[0][1] as Record<string, unknown>;
    expect(event).toMatchObject({ actorType: 'staff', actorSubject: 'staff:admin',
      actorAccountId: '20000000-0000-4000-8000-000000000001', accessScope: 'platform' });
    expect(event.facilityId).toBeUndefined();
    expect(event.actorMembershipId).toBeUndefined();
    expect(event.organizationId).toBeUndefined();
  });

  it.each([
    ['ADMIN_SELF_CHANGE_DENIED', 403, 'ADMIN_SELF_CHANGE_DENIED'],
    ['ADMIN_ACCOUNT_RECOVERY_REQUIRED', 409, 'ACCOUNT_RECOVERY_REQUIRED'],
    ['ADMIN_NO_STATE_CHANGE', 409, 'ADMIN_STATE_CONFLICT'],
  ] as const)('maps %s account command refusals to a safe problem', async (databaseMessage, status, code) => {
    const { service, command, audit } = harness({});
    command.mockRejectedValue(new Error(databaseMessage));
    const error = await service.transitionAccount(context, '20000000-0000-4000-8000-000000000002', 2,
      { status: 'active', reason: 'Governed account activation' }, 'admin-account-command-0002')
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DomainProblem);
    expect((error as DomainProblem).getStatus()).toBe(status);
    expect((error as DomainProblem).code).toBe(code);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('does not duplicate semantic audit evidence on an idempotent replay', async () => {
    const { service, audit } = harness({ facility_id: '10000000-0000-4000-8000-000000000002',
      lifecycle_status: 'suspended', row_version: '3', replayed: true });
    await service.transitionFacility(context, '10000000-0000-4000-8000-000000000002', 2,
      { status: 'suspended', reason: 'Confirmed governance suspension' }, 'admin-command-key-0001');
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('maps optimistic concurrency failures to a safe conflict', async () => {
    const { service, command } = harness({});
    command.mockRejectedValue(new Error('ADMIN_VERSION_CONFLICT internal detail'));
    const promise = service.transitionFacility(context, '10000000-0000-4000-8000-000000000002', 2,
      { status: 'suspended', reason: 'Confirmed governance suspension' }, 'admin-command-key-0001');
    const error = await promise.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DomainProblem);
    expect((error as DomainProblem).getStatus()).toBe(409);
    expect((error as DomainProblem).code).toBe('VERSION_CONFLICT');
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


  it('exports a narrow, RFC 4180 principal CSV with formula neutralization and an audited reason', async () => {
    const { service, command, audit, options } = exportService([
      { id: '20000000-0000-4000-8000-000000000003', email: 'admin@example.com', displayName: 'Admin, "Test"',
        status: 'active', createdAt: new Date('2026-09-29T12:00:00.000Z'),
        platformRoles: ['security_auditor', 'support_admin'] },
      { id: '20000000-0000-4000-8000-000000000004', email: '=HYPERLINK("https://example.invalid")',
        displayName: '+SUM(A1:A9)\nnext line', status: 'disabled', createdAt: new Date('2026-09-30T12:00:00.000Z'),
        platformRoles: [] },
    ]);
    const exported = await service.exportPrincipals(context, { reason: 'Quarterly access review' } as never);
    expect(exported.csv).toBe([
      'account_id,email,display_name,status,created_at,platform_roles',
      '20000000-0000-4000-8000-000000000003,admin@example.com,"Admin, ""Test""",active,2026-09-29T12:00:00.000Z,security_auditor|support_admin',
      `20000000-0000-4000-8000-000000000004,"'=HYPERLINK(""https://example.invalid"")","'+SUM(A1:A9)\nnext line",disabled,2026-09-30T12:00:00.000Z,`,
    ].join('\r\n') + '\r\n');
    expect(exported).toMatchObject({ rowCount: 2, truncated: false });
    const [sql, parameters] = command.mock.calls[0] as [string, unknown[]];
    // No credential, session, token, subject or membership data is selected.
    for (const column of ['password', 'subject', 'token', 'sessions', 'memberships', 'row_version']) {
      expect(sql).not.toContain(column);
    }
    expect(parameters.at(-1)).toBe(PRINCIPAL_EXPORT_MAX_ROWS + 1);
    expect(options).toEqual([undefined]);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.principals.export', outcome: 'success', reason: 'Quarterly access review',
      details: expect.objectContaining({ returnedCount: 2, truncated: false }),
    }));
  });

  it('caps a principal export at 5,000 rows and reports the truncation', async () => {
    const rows = Array.from({ length: PRINCIPAL_EXPORT_MAX_ROWS + 1 }, (_, index) => ({
      id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`, email: null, displayName: null,
      status: 'active', createdAt: new Date('2026-09-29T12:00:00.000Z'), platformRoles: [] }));
    const { service, audit } = exportService(rows);
    const exported = await service.exportPrincipals(context, { reason: 'Full directory review' } as never);
    expect(exported).toMatchObject({ rowCount: PRINCIPAL_EXPORT_MAX_ROWS, truncated: true });
    expect(exported.csv.split('\r\n').filter(Boolean)).toHaveLength(PRINCIPAL_EXPORT_MAX_ROWS + 1);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ returnedCount: PRINCIPAL_EXPORT_MAX_ROWS, truncated: true }) }));
  });

  it.each([
    ['without a platform session', { active: false }, 'PLATFORM_SESSION_REQUIRED'],
    ['without a fresh step-up', { stepUpFresh: false }, 'STEP_UP_REQUIRED'],
  ] as const)('refuses every governed command called directly %s', async (_label, assurance, code) => {
    const { service, command, audit } = harness({ replayed: false }, assurance);
    const calls: [string, () => Promise<unknown>][] = [
      ['facility', () => service.transitionFacility(context, '10000000-0000-4000-8000-000000000002', 2,
        { status: 'suspended', reason: 'Direct service call' }, 'admin-command-key-0002')],
      ['account', () => service.transitionAccount(context, '20000000-0000-4000-8000-000000000002', 2,
        { status: 'disabled', reason: 'Direct service call' }, 'admin-command-key-0003')],
      ['role', () => service.changePlatformRole(context, '20000000-0000-4000-8000-000000000002', 2,
        { roleCode: 'support_admin', action: 'grant', reason: 'Direct service call' }, 'admin-command-key-0004')],
      ['sessions', () => service.revokeSessions(context, '20000000-0000-4000-8000-000000000002',
        { reason: 'Direct service call' }, 'admin-command-key-0005')],
      ['control', () => service.setPlatformControl(context,
        { controlKey: 'maintenance_mode', enabled: true, reason: 'Direct service call' } as never, 2)],
      ['export', () => service.exportPrincipals(context, { reason: 'Direct service call' } as never)],
    ];
    for (const [label, call] of calls) {
      const error = await call().catch((failure: unknown) => failure);
      expect([label, (error as DomainProblem).code]).toEqual([label, code]);
    }
    expect(command).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('refuses a direct service call from a staff session even with platform permissions', async () => {
    const { service, command } = harness({ replayed: false }, { active: false });
    const staffContext = { ...context, actor: { ...context.actor, kind: 'staff' as const } };
    const error = await service.transitionAccount(staffContext, '20000000-0000-4000-8000-000000000002', 2,
      { status: 'disabled', reason: 'Direct service call' }, 'admin-command-key-0006').catch((failure: unknown) => failure);
    expect((error as DomainProblem).code).toBe('PLATFORM_SESSION_REQUIRED');
    expect(command).not.toHaveBeenCalled();
  });

  it('refuses a one-step Super Admin grant before any database command', async () => {
    const { service, client } = harness({ replayed: false });
    const error = await service.changePlatformRole(context, '20000000-0000-4000-8000-000000000002', 2,
      { roleCode: 'platform_super_admin', action: 'grant', reason: 'One-step elevation attempt' },
      'admin-command-key-0007').catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DomainProblem);
    expect((error as DomainProblem).getStatus()).toBe(403);
    expect((error as DomainProblem).code).toBe('TWO_PERSON_APPROVAL_REQUIRED');
    expect(client.query).not.toHaveBeenCalled();
  });

  it.each([
    ['ADMIN_APPROVAL_REQUIRED', 403, 'TWO_PERSON_APPROVAL_REQUIRED'],
    ['ADMIN_STEP_UP_REQUIRED', 403, 'STEP_UP_REQUIRED'],
    ['ADMIN_LAST_SUPER_ADMIN', 409, 'LAST_SUPER_ADMIN'],
  ] as const)('maps the SQL refusal %s', async (databaseMessage, status, code) => {
    const { service, command } = harness({});
    command.mockRejectedValue(new Error(databaseMessage));
    const error = await service.changePlatformRole(context, '20000000-0000-4000-8000-000000000002', 2,
      { roleCode: 'platform_super_admin', action: 'revoke', reason: 'Governed role revoke' }, 'admin-command-key-0008')
      .catch((failure: unknown) => failure);
    expect((error as DomainProblem).getStatus()).toBe(status);
    expect((error as DomainProblem).code).toBe(code);
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
