import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService, isRetryableConflict, retryDelayMs, SERIALIZABLE_ATTEMPTS } from './database.service';

const context = { actor: { subject: 'synthetic:pharmacist' }, facilityId: 'facility', correlationId: 'correlation',
  membershipId: 'membership', purposeOfUse: 'direct-care' } as unknown as DataAccessContext;

function sqlError(code: string) { return Object.assign(new Error(`synthetic ${code}`), { code }); }

/** A DatabaseService over a fake pool that records each transaction's statements. */
function service(commitFailures: string[] = []) {
  const transactions: string[][] = [];
  let released = 0;
  const pauses: number[] = [];
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
  // The pause between attempts is recorded instead of waited for.
  Object.assign(database, { pool, pauseBeforeRetry: async (attempt: number) => { pauses.push(attempt); } });
  return { database, transactions, pauses, released: () => released };
}

describe('Pharmacy DatabaseService transaction retry', () => {
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

  it(`gives up after ${SERIALIZABLE_ATTEMPTS} attempts with the last conflict, pausing in between`, async () => {
    const { database, transactions, pauses } = service();
    let calls = 0;
    await expect(database.withTransaction(context, async () => { calls += 1; throw sqlError('40001'); },
      { isolationLevel: 'SERIALIZABLE' })).rejects.toMatchObject({ code: '40001' });
    expect(calls).toBe(SERIALIZABLE_ATTEMPTS);
    expect(transactions.every((statements) => statements.at(-1) === 'ROLLBACK')).toBe(true);
    expect(pauses).toEqual(Array.from({ length: SERIALIZABLE_ATTEMPTS - 1 }, (_, index) => index + 1));
  });

  it('pauses for a random time within a window that doubles from 20 ms up to 1000 ms', () => {
    const longest = Array.from({ length: SERIALIZABLE_ATTEMPTS },
      (_, index) => retryDelayMs(index + 1, () => 0.999999));
    expect(longest[0]).toBe(19);
    expect(longest[1]).toBe(39);
    expect(Math.max(...longest)).toBe(999);
    expect(longest).toEqual([...longest].sort((left, right) => left - right));
    expect(retryDelayMs(SERIALIZABLE_ATTEMPTS, () => 0)).toBe(0);
  });

  it('runs a transaction again after a unique violation only once: a second one is a conflict', async () => {
    for (const [codes, outcome, attempts] of [
      [['23505', '23505'], '23505', 2],
      [['40001', '23505', '23505'], '23505', 3],
      [['23505', '40001', '40001'], 'committed', 4],
    ] as const) {
      const { database } = service();
      let calls = 0;
      const run = database.withTransaction(context, async () => {
        calls += 1;
        if (calls <= codes.length) throw sqlError(codes[calls - 1]!);
        return 'committed';
      }, { isolationLevel: 'SERIALIZABLE' });
      if (outcome === 'committed') await expect(run).resolves.toBe('committed');
      else await expect(run).rejects.toMatchObject({ code: outcome });
      expect(calls).toBe(attempts);
    }
  });

  it('runs other transactions and other failures once', async () => {
    for (const [error, options] of [
      [sqlError('40001'), {}],
      [sqlError('40001'), { isolationLevel: 'READ COMMITTED' as const }],
      [sqlError('42501'), { isolationLevel: 'SERIALIZABLE' as const }],
      [sqlError('23514'), { isolationLevel: 'SERIALIZABLE' as const }],
      [new DomainProblem(409, 'PHARMACY_WORK_ITEM_ALREADY_DISPENSED', 'Already dispensed'), { isolationLevel: 'SERIALIZABLE' as const }],
    ] as const) {
      const { database } = service();
      let calls = 0;
      await expect(database.withTransaction(context, async () => { calls += 1; throw error; }, options)).rejects.toBe(error);
      expect(calls).toBe(1);
    }
  });

  it('recognises only the conflicts PostgreSQL resolves by cancelling a transaction', () => {
    expect(['40001', '40P01', '23505'].map((code) => isRetryableConflict({ code }))).toEqual([true, true, true]);
    expect([{ code: '42501' }, { code: '0A000' }, { code: 'PHARMACY_ACCESS_DENIED' }, null, 'error']
      .map(isRetryableConflict)).toEqual([false, false, false, false, false]);
  });
});
