import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService, isRetryableConflict, SERIALIZABLE_ATTEMPTS } from './database.service';

const context = { actor: { subject: 'synthetic:outreach-enumerator' }, facilityId: 'facility', correlationId: 'correlation',
  membershipId: 'membership', purposeOfUse: 'direct-care' } as unknown as DataAccessContext;

function sqlError(code: string) { return Object.assign(new Error(`synthetic ${code}`), { code }); }

/** A DatabaseService over a fake pool that records each transaction's statements. */
function service(commitFailures: string[] = []) {
  const transactions: string[][] = [];
  let released = 0;
  const pool = {
    connect: async () => {
      const statements: string[] = [];
      transactions.push(statements);
      return {
        query: async (sql: string) => {
          statements.push(sql.trim().split(/\s+/)[0]!);
          if (sql === 'COMMIT' && commitFailures.length > 0) throw sqlError(commitFailures.shift()!);
          return { rows: [], rowCount: 0 };
        },
        release: () => { released += 1; },
      };
    },
  };
  const database = Object.create(DatabaseService.prototype) as DatabaseService;
  Object.assign(database, { pool });
  return { database, transactions, released: () => released };
}

describe('Outreach DatabaseService transaction retry', () => {
  it.each(['40001', '40P01', '23505'])('runs a SERIALIZABLE transaction cancelled with %s again', async (code) => {
    const { database, transactions, released } = service();
    let calls = 0;
    const result = await database.withTransaction(context, async (_client: PoolClient) => {
      calls += 1;
      if (calls === 1) throw sqlError(code);
      return 'replayed';
    }, { isolationLevel: 'SERIALIZABLE' });
    expect(result).toBe('replayed');
    expect(calls).toBe(2);
    expect(transactions).toEqual([['BEGIN', 'SET', 'select', 'ROLLBACK'], ['BEGIN', 'SET', 'select', 'COMMIT']]);
    expect(released()).toBe(2);
  });

  it('runs a transaction again when COMMIT reports a serialization failure', async () => {
    const { database, transactions } = service(['40001']);
    await expect(database.withTransaction(context, async () => 'committed', { isolationLevel: 'SERIALIZABLE' }))
      .resolves.toBe('committed');
    expect(transactions).toHaveLength(2);
  });

  it(`gives up after ${SERIALIZABLE_ATTEMPTS} attempts with the last conflict`, async () => {
    const { database, transactions } = service();
    let calls = 0;
    await expect(database.withTransaction(context, async () => { calls += 1; throw sqlError('40001'); },
      { isolationLevel: 'SERIALIZABLE' })).rejects.toMatchObject({ code: '40001' });
    expect(calls).toBe(SERIALIZABLE_ATTEMPTS);
    expect(transactions.every((statements) => statements.at(-1) === 'ROLLBACK')).toBe(true);
  });

  it('runs other transactions and other failures once', async () => {
    for (const [error, options] of [
      [sqlError('40001'), {}],
      [sqlError('40001'), { isolationLevel: 'READ COMMITTED' as const }],
      [sqlError('42501'), { isolationLevel: 'SERIALIZABLE' as const }],
      [sqlError('23514'), { isolationLevel: 'SERIALIZABLE' as const }],
      [new DomainProblem(409, 'OUTREACH_REGISTRATION_CONFLICT', 'Already received'), { isolationLevel: 'SERIALIZABLE' as const }],
    ] as const) {
      const { database } = service();
      let calls = 0;
      await expect(database.withTransaction(context, async () => { calls += 1; throw error; }, options)).rejects.toBe(error);
      expect(calls).toBe(1);
    }
  });

  it('recognises only the conflicts PostgreSQL resolves by cancelling a transaction', () => {
    expect(['40001', '40P01', '23505'].map((code) => isRetryableConflict({ code }))).toEqual([true, true, true]);
    expect([{ code: '42501' }, { code: '0A000' }, { code: 'OUTREACH_CAMPAIGN_ACCESS_DENIED' }, null, 'error']
      .map(isRetryableConflict)).toEqual([false, false, false, false, false]);
  });
});
