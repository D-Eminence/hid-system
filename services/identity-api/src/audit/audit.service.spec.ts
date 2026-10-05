import { AuditService } from './audit.service';
import type { DatabaseService } from '../database/database.service';

function service() {
  const database = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  return { database, audit: new AuditService(database as unknown as DatabaseService) };
}

describe('AuditService platform administrator attribution', () => {
  it('records a facility-free platform administration event against the account', async () => {
    const { database, audit } = service();

    await expect(audit.record({
      correlationId: 'platform-admin-audit-0001',
      actorType: 'staff',
      actorSubject: 'staff:platform-admin',
      actorAccountId: '20000000-0000-4000-8000-000000000001',
      action: 'api.admin.overview.read.request',
      resourceType: 'http-request',
      outcome: 'success',
    })).resolves.toBeUndefined();

    expect(database.query).toHaveBeenCalledWith(expect.stringContaining('insert into audit.events'), expect.arrayContaining([
      'staff:platform-admin', '20000000-0000-4000-8000-000000000001', 'api.admin.overview.read.request',
    ]));
  });

  it('continues to reject a non-administrative staff event without a facility membership', async () => {
    const { audit } = service();

    await expect(audit.record({
      correlationId: 'unassigned-staff-audit-0001',
      actorType: 'staff',
      actorSubject: 'staff:unassigned',
      actorAccountId: '20000000-0000-4000-8000-000000000002',
      action: 'ehr.encounter.read',
      resourceType: 'clinical-record',
      outcome: 'success',
    })).rejects.toThrow('Staff audit events require a resolved facility context');
  });
});
