import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { CurrentStaffContextService } from '../auth/current-staff-context.service';
import type { ActorContext, HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { requireAdminContext } from './admin-context';

const accountId = '20000000-0000-4000-8000-000000000001';
const subject = 'standalone:administrator';
const authority = { roles: ['platform_super_admin'], permissions: ['platform.admin.access', 'platform.integration.read'] };

describe('Standalone platform administrator boundary', () => {
  function resolver(permissions = authority.permissions) {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: accountId, email: 'admin@example.test', display_name: 'Admin' }] })
      .mockResolvedValueOnce({ rows: [{ ...authority, permissions }] });
    return { query, service: new CurrentStaffContextService({ query } as unknown as DatabaseService) };
  }

  it('resolves approved platform authority with no invented staff or clinical assignment', async () => {
    const { service, query } = resolver();
    const actor = await service.resolve(subject, 'local', 'session-id', 'unapproved-facility');
    expect(actor.platformRoles).toEqual(['platform_super_admin']);
    expect(actor.platformPermissions).toEqual(authority.permissions);
    expect(actor.facilities).toEqual([]);
    expect(actor.facilityIds).toEqual([]);
    expect(actor.permissions).toEqual([]);
    expect(actor.roles).toEqual([]);
    expect(actor.facility).toBeUndefined();
    expect(query.mock.calls[1][0]).toContain("status = 'active'");
    expect(query.mock.calls[1][0]).toContain('disabled_until');
    expect(query.mock.calls[2][0]).toContain('role.active');
    expect(query.mock.calls[2][0]).toContain('permission.active');
    expect(query.mock.calls[2][0]).toContain('assignment.revoked_at is null');
  });

  it.each(['ordinary', 'revoked', 'inactive-role'])('denies a %s account with no current approved authority', async () => {
    const { service } = resolver([]);
    await expect(service.resolve(subject, 'local')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechecks platform authority on every session resolution', async () => {
    const query = jest.fn(async (sql: string) => ({ rows: sql.includes('join identity.staff staff') ? []
      : sql.includes('from auth.accounts') ? [{ id: accountId, display_name: 'Admin' }]
      : [authority] }));
    const service = new CurrentStaffContextService({ query } as unknown as DatabaseService);
    await service.resolve(subject, 'local', 'session-id');
    query.mockImplementation(async (sql: string) => ({ rows: !sql.includes('join identity.staff staff') && sql.includes('from auth.accounts')
      ? [{ id: accountId, display_name: 'Admin' }] : [] }));
    await expect(service.resolve(subject, 'local', 'session-id')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('denies suspended accounts before reading platform authority', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await expect(new CurrentStaffContextService({ query } as unknown as DatabaseService).resolve(subject, 'local'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('requires approved administration context and explicitly excludes patient principals', async () => {
    const { service } = resolver();
    const actor = await service.resolve(subject, 'local');
    const request = (principal: ActorContext) => ({ actor: principal, correlationId: 'admin-boundary-test',
      header: () => undefined } as unknown as HidRequest);
    expect(requireAdminContext(request(actor))).toMatchObject({ actor, purposeOfUse: 'healthcare-operations' });
    expect(requireAdminContext(request(actor)).facilityId).toBeUndefined();
    expect(() => requireAdminContext(request({ ...actor, platformPermissions: [] }))).toThrow();
    expect(() => requireAdminContext(request({ ...actor, kind: 'patient' }))).toThrow();
  });

  it('persists the real platform actor, while rejecting clinical and unattributed platform audit', async () => {
    const query = jest.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] }));
    const audit = new AuditService({ query } as unknown as DatabaseService);
    const event = { actorType: 'platform' as const, actorSubject: subject, actorAccountId: accountId,
      correlationId: 'admin-boundary-test', action: 'admin.integration.list', outcome: 'success' as const,
      purposeOfUse: 'healthcare-operations' };
    await audit.record(event);
    expect(query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['platform', subject, accountId]));
    for (const invalid of [{ action: 'ehr.record.read' }, { patientId: accountId },
      { facilityId: accountId }, { actorSubject: undefined }, { actorAccountId: undefined },
      { purposeOfUse: undefined }]) {
      await expect(audit.record({ ...event, ...invalid })).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
    await expect(audit.record({ ...event, actorType: 'staff', action: 'ehr.record.read' }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(query).toHaveBeenCalledTimes(1);
    await audit.recordWithClient({ query } as unknown as PoolClient, event);
  });
});
