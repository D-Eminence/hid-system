import type { PoolClient } from 'pg';
import type { DatabaseService } from '../database/database.service';
import { AuditService } from './audit.service';

describe('AuditService source attribution', () => {
  const event = {
    correlationId: 'audit-source-test-0001', actorType: 'patient' as const, actorSubject: 'patient:audit',
    actorAccountId: '70000000-0000-4000-8000-000000000001', patientId: '50000000-0000-4000-8000-000000000001',
    action: 'identity.patient.self.profile', resourceType: 'patient-self', outcome: 'success' as const,
  };

  function sourceSystem(query: jest.Mock): unknown {
    const parameters = query.mock.calls[0]?.[1] as unknown[] | undefined;
    return parameters?.[18];
  }

  it('records Identity API audit rows as identity-api, not ehr-api', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await new AuditService({ query } as unknown as DatabaseService).record(event);
    expect(sourceSystem(query)).toBe('identity-api');

    const clientQuery = jest.fn().mockResolvedValue({ rows: [] });
    await new AuditService({} as DatabaseService).recordWithClient({ query: clientQuery } as unknown as PoolClient, event);
    expect(sourceSystem(clientQuery)).toBe('identity-api');
  });

  it('preserves an explicit source system and the remaining audit semantics', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await new AuditService({ query } as unknown as DatabaseService).record({ ...event, sourceSystem: 'legacy-import' });
    const parameters = query.mock.calls[0]?.[1] as unknown[];
    expect(parameters[18]).toBe('legacy-import');
    expect(parameters.slice(0, 4)).toEqual([event.correlationId, 'patient', 'patient:audit', event.actorAccountId]);
    expect(parameters[17]).toBe('application');
  });

  it('still fails closed when audit persistence is unavailable', async () => {
    const query = jest.fn().mockRejectedValue(new Error('database unavailable'));
    await expect(new AuditService({ query } as unknown as DatabaseService).record(event))
      .rejects.toThrow('Audit persistence is unavailable; request was denied');
  });
});
