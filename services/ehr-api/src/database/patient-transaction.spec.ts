import type { PoolClient } from 'pg';
import { DatabaseService } from './database.service';

const fresh = () => ({ subject: 'patient-subject', accountId: 'account', sessionId: 'session',
  patientId: 'patient', expiresAt: new Date(Date.now() + 30_000).toISOString() });
function setup() {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  const release = jest.fn();
  const connect = jest.fn().mockResolvedValue({ query, release });
  const service = Object.create(DatabaseService.prototype) as DatabaseService;
  Object.assign(service, { pool: { connect } });
  return { service, connect, query, release };
}
describe('Patient read transaction boundary', () => {
  it.each([-1_000, 120_000])('refuses expired or overly long authorization (%d ms) before database access', async (offset) => {
    const { service, connect } = setup();
    await expect(service.withPatientTransaction({ ...fresh(), expiresAt: new Date(Date.now() + offset).toISOString() },
      'patient-transaction-test', jest.fn())).rejects.toThrow('Patient authorization is stale');
    expect(connect).not.toHaveBeenCalled();
  });
  it('rolls back and releases the clinical read when durable audit fails before serialization', async () => {
    const { service, query, release } = setup();
    await expect(service.withPatientTransaction(fresh(), 'patient-transaction-test', async (client: PoolClient) => {
      await client.query('select released_clinical_content');
      throw new Error('audit persistence unavailable');
    })).rejects.toThrow('audit persistence unavailable');
    expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
