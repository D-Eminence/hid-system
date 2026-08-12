import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { DataAccessContext } from '../common/request-context';
import { DomainProblem } from '../common/problem';
import type { DatabaseService } from '../database/database.service';
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

function harness(row: Readonly<Record<string, unknown>>) {
  const client = { query: jest.fn().mockResolvedValue({ rows: [row], rowCount: 1 }) };
  const database = { withTransaction: jest.fn(async (_context, operation) =>
    operation(client as unknown as PoolClient)) };
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminService(database as unknown as DatabaseService, audit as unknown as AuditService);
  return { service, client, audit };
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
