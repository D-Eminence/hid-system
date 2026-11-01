import type { PoolClient } from 'pg';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from './database.service';

// The review of 0100: an order route send runs SERIALIZABLE so that a Pharmacy acceptance of
// the same prescription that overlaps it fails with 40001 (pharmacy-api retries it and the retry
// answers PRESCRIPTION_ROUTED) instead of leaving a live route and a dispensable work item. A
// SERIALIZABLE transaction PostgreSQL cancels (40001, 40P01) is run again from the start; other
// transactions and other errors are not.
const context = { correlationId: 'correlation-123456', facilityId: 'facility', membershipId: 'membership',
  purposeOfUse: 'direct-care', authorization: 'Bearer user',
  actor: { id: 'account', subject: 'staff:test', accountId: 'account' } } as unknown as DataAccessContext;
const failure = (code: string) => Object.assign(new Error(`database error ${code}`), { code });

function setup() {
  const statements: string[] = [];
  const query = jest.fn(async (sql: string) => { statements.push(sql); return { rows: [] }; });
  const release = jest.fn();
  const connect = jest.fn().mockResolvedValue({ query, release });
  const service = Object.create(DatabaseService.prototype) as DatabaseService;
  Object.assign(service, { pool: { connect } });
  jest.spyOn(service as unknown as { pauseBeforeRetry: (attempt: number) => Promise<void> }, 'pauseBeforeRetry')
    .mockResolvedValue(undefined);
  return { service, connect, release, statements };
}

describe('EHR DatabaseService SERIALIZABLE retry', () => {
  it.each(['40001', '40P01'])('runs a SERIALIZABLE transaction cancelled with %s again, in a new transaction', async (code) => {
    const { service, connect, release, statements } = setup();
    const operation = jest.fn<Promise<string>, [PoolClient]>()
      .mockRejectedValueOnce(failure(code))
      .mockResolvedValueOnce('sent');
    await expect(service.withTransaction(context, operation, { isolationLevel: 'SERIALIZABLE' })).resolves.toBe('sent');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(statements.filter((sql) => sql === 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')).toHaveLength(2);
    expect(statements.filter((sql) => sql === 'ROLLBACK')).toHaveLength(1);
    expect(statements.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
  });

  it('gives up after a bounded number of attempts and passes the last 40001 on', async () => {
    const { service, connect } = setup();
    const error = failure('40001');
    const operation = jest.fn().mockRejectedValue(error);
    await expect(service.withTransaction(context, operation, { isolationLevel: 'SERIALIZABLE' })).rejects.toBe(error);
    expect(operation.mock.calls.length).toBeGreaterThan(1);
    expect(operation.mock.calls.length).toBeLessThanOrEqual(12);
    expect(connect).toHaveBeenCalledTimes(operation.mock.calls.length);
  });

  it('never runs a READ COMMITTED transaction again, and never retries another error', async () => {
    for (const [isolationLevel, error] of [[undefined, failure('40001')], ['READ COMMITTED', failure('40P01')],
      ['SERIALIZABLE', failure('23505')], ['SERIALIZABLE', failure('23514')], ['SERIALIZABLE', new Error('plain')]] as const) {
      const { service, connect } = setup();
      const operation = jest.fn().mockRejectedValue(error);
      await expect(service.withTransaction(context, operation, isolationLevel ? { isolationLevel } : {})).rejects.toBe(error);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(connect).toHaveBeenCalledTimes(1);
    }
  });
});
