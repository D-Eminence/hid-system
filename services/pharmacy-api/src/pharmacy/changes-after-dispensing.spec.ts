import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CHANGES_AFTER_DISPENSING, CHANGES_AFTER_DISPENSING_OFF, CHANGES_AFTER_DISPENSING_QUERY, changeOf,
  PharmacyChangesAfterDispensing } from './changes-after-dispensing';

/*
 * Q132 A (owner decision of 19 November 2026; coordinator decision 1 of 20
 * November 2026; SPEC decision 19): the reader of 0148's notices,
 * pharmacy.work_item_changes_after_dispensing, on its own, against a fake
 * client that records every statement. The database labels the changes; these
 * tests pin what pharmacy-api does with its answer: no statement when off or
 * with nothing to ask, 200 ids a statement in one savepoint, all or nothing
 * across batches, which failures are passed on, which are silent and which
 * warn, and that a row that does not read cleanly never becomes a guessed
 * notice. Fictional ids only.
 */

const id = (n: number) => `14800000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 9, minute));
const correlationId = 'q132-reader-correlation-0001';
const SAVEPOINT = 'savepoint pharmacy_changes_after_dispensing';
const RELEASE = 'release savepoint pharmacy_changes_after_dispensing';
const ROLLBACK = 'rollback to savepoint pharmacy_changes_after_dispensing';
const COULD_NOT_READ = 'Changes after dispensing could not be read';
const ROW_UNREADABLE = 'A change after dispensing could not be read';

const sqlError = (code: string) => Object.assign(new Error(`synthetic ${code}`), { code });
const row = (n: number, extra: Record<string, unknown> = {}) => ({ work_item_id: id(n), change: 'cancelled',
  changed_at: at(n), change_count: 1, ...extra });

/** A client that records each statement and answers the reader's from `answer` (by call, 0-based). */
const fake = (answer: (values: unknown[], call: number) => unknown[] | Error = () => []) => {
  const statements: { sql: string; values: unknown[] }[] = [];
  let calls = 0;
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql !== CHANGES_AFTER_DISPENSING_QUERY) return { rows: [] };
    const rows = answer(values, calls);
    calls += 1;
    if (rows instanceof Error) throw rows;
    return { rows };
  }) } as unknown as PoolClient;
  /** The statements in order, the reader's with the number of ids it carried. */
  const shape = () => statements.map((statement) => (statement.sql === CHANGES_AFTER_DISPENSING_QUERY
    ? `reader(${(statement.values[0] as string[]).length})` : statement.sql));
  return { client, statements, shape };
};
const reader = () => new PharmacyChangesAfterDispensing(true);

beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

describe('PharmacyChangesAfterDispensing (Q132 A, 0148): when it asks', () => {
  it('S1 off: no statement, an empty map', async () => {
    const { client, statements } = fake(() => [row(1)]);
    expect(CHANGES_AFTER_DISPENSING_OFF.enabled).toBe(false);
    await expect(CHANGES_AFTER_DISPENSING_OFF.changes(client, [id(1), id(2)], correlationId)).resolves.toEqual(new Map());
    await expect(new PharmacyChangesAfterDispensing(false).changes(client, [id(1)], correlationId))
      .resolves.toEqual(new Map());
    expect(statements).toEqual([]);
  });

  it('S2 no ids: no statement, an empty map, not even a savepoint', async () => {
    const { client, statements } = fake(() => [row(1)]);
    await expect(reader().changes(client, [], correlationId)).resolves.toEqual(new Map());
    expect(statements).toEqual([]);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it('S3 401 ids: three statements of 200, 200 and 1, in one savepoint, each with its own ids in order', async () => {
    const ids = Array.from({ length: 401 }, (_, n) => id(n + 1));
    const { client, statements, shape } = fake((values) => (values[0] as string[]).filter((_, index) => index === 0)
      .map((workItemId) => ({ ...row(1), work_item_id: workItemId })));
    const found = await reader().changes(client, ids, correlationId);
    expect(shape()).toEqual([SAVEPOINT, 'reader(200)', 'reader(200)', 'reader(1)', RELEASE]);
    const asked = statements.filter((statement) => statement.sql === CHANGES_AFTER_DISPENSING_QUERY)
      .map((statement) => statement.values[0] as string[]);
    expect(asked.flat()).toEqual(ids);
    // Each batch's answer is kept: the first id of each batch had a notice.
    expect([...found.keys()]).toEqual([id(1), id(201), id(401)]);
  });

  it('asks the reader for exactly the SPEC\'s columns, with the ids as one uuid[] parameter', () => {
    expect(CHANGES_AFTER_DISPENSING_QUERY.replace(/\s+/g, ' ').trim()).toBe('select work_item_id::text as work_item_id, '
      + 'change, changed_at, change_count from pharmacy.work_item_changes_after_dispensing($1::uuid[])');
  });

  it('knows exactly the five codes 0148\'s reader answers', () => {
    expect([...CHANGES_AFTER_DISPENSING].sort()).toEqual(['cancelled', 'edited', 'entered_in_error', 'on_hold', 'resumed']);
  });
});

describe('PharmacyChangesAfterDispensing (Q132 A, 0148): what it answers', () => {
  it('answers each row as a notice: the code, the time and the count, keyed by work item', async () => {
    const { client, shape } = fake(() => [
      row(1, { change: 'entered_in_error', change_count: 1 }),
      row(2, { change: 'cancelled', change_count: 3 }),
      row(3, { change: 'on_hold' }),
      row(4, { change: 'edited', change_count: 2 }),
      // node-postgres makes a Date of a timestamptz; an ISO time with its zone reads the same.
      row(5, { change: 'resumed', change_count: 2, changed_at: '2026-11-20T09:05:00.000Z' }),
      row(6, { changed_at: '2026-11-20T10:06:00+01:00' })]);
    const found = await reader().changes(client, [1, 2, 3, 4, 5, 6, 7].map(id), correlationId);
    expect([...found.entries()]).toEqual([
      [id(1), { change: 'entered_in_error', changedAt: at(1), changeCount: 1 }],
      [id(2), { change: 'cancelled', changedAt: at(2), changeCount: 3 }],
      [id(3), { change: 'on_hold', changedAt: at(3), changeCount: 1 }],
      [id(4), { change: 'edited', changedAt: at(4), changeCount: 2 }],
      [id(5), { change: 'resumed', changedAt: at(5), changeCount: 2 }],
      [id(6), { change: 'cancelled', changedAt: at(6), changeCount: 1 }]]);
    // An item the reader did not answer (no shown change, or not readable by this session) has no notice.
    expect(found.has(id(7))).toBe(false);
    expect(shape()).toEqual([SAVEPOINT, 'reader(7)', RELEASE]);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it('S9 an unknown change keeps the notice without change, with one warning for the whole call', async () => {
    const { client } = fake(() => [
      row(1, { change: 'stopped_at_the_counter' }),
      row(2, { change: 'ON_HOLD', change_count: 2 }),
      row(3, { change: null }),
      row(4, { change: 'cancelled' })]);
    const found = await reader().changes(client, [1, 2, 3, 4].map(id), correlationId);
    expect([...found.entries()]).toEqual([
      [id(1), { changedAt: at(1), changeCount: 1 }],
      [id(2), { changedAt: at(2), changeCount: 2 }],
      [id(3), { changedAt: at(3), changeCount: 1 }],
      [id(4), { change: 'cancelled', changedAt: at(4), changeCount: 1 }]]);
    for (const n of [1, 2, 3]) expect(found.get(id(n))).not.toHaveProperty('change');
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.warn).toHaveBeenCalledWith({ message: 'A change after dispensing has a code this '
      + 'pharmacy-api does not know; the notice is answered without it', correlationId });
  });

  it('S10 a count of 0, -1, 1.5 or null, or a time that does not read: no notice for that item, a warning naming '
    + 'its id only', async () => {
    const broken: Record<number, Record<string, unknown>> = {
      1: { change_count: 0 },
      2: { change_count: -1 },
      3: { change_count: 1.5 },
      4: { change_count: null },
      // The reader casts its count to integer, which node-postgres answers as a number; text is not one.
      5: { change_count: '2' },
      6: { changed_at: 'not a time' },
      7: { changed_at: new Date(Number.NaN) },
      8: { changed_at: null },
      // A number, or a time without its zone, would be a guess at the moment it was changed.
      9: { changed_at: at(9).getTime() },
      10: { changed_at: '2026-11-20 09:10' },
      11: { changed_at: '2026-11-20T09:11:00' },
    };
    const { client } = fake(() => [...Object.entries(broken).map(([n, extra]) => row(Number(n), extra)),
      // A sound row next to them keeps its notice.
      row(12, { change: 'on_hold' })]);
    const found = await reader().changes(client, Array.from({ length: 12 }, (_, n) => id(n + 1)), correlationId);
    expect([...found.entries()]).toEqual([[id(12), { change: 'on_hold', changedAt: at(12), changeCount: 1 }]]);
    // One warning per item, naming the work item's id and nothing of the row (no time, count or code).
    expect((Logger.prototype.warn as jest.Mock).mock.calls).toEqual(Object.keys(broken).map((n) => [{
      message: ROW_UNREADABLE, workItemId: id(Number(n)), correlationId }]));
  });

  it('drops a row whose work item id is not text, with the same warning and no id to name', async () => {
    const { client } = fake(() => [row(1, { work_item_id: null }), row(2, { work_item_id: '' }), row(3)]);
    const found = await reader().changes(client, [id(1), id(2), id(3)], correlationId);
    expect([...found.keys()]).toEqual([id(3)]);
    expect((Logger.prototype.warn as jest.Mock).mock.calls).toEqual([
      [{ message: ROW_UNREADABLE, workItemId: null, correlationId }],
      [{ message: ROW_UNREADABLE, workItemId: null, correlationId }]]);
  });

  it('changeOf: a notice only for a sound time and a whole count of 1 or more; never a guessed code', () => {
    expect(changeOf({ change: 'edited', changed_at: at(1), change_count: 4 }))
      .toEqual({ change: 'edited', changedAt: at(1), changeCount: 4 });
    expect(changeOf({ change: 'held', changed_at: at(1), change_count: 1 })).toEqual({ changedAt: at(1), changeCount: 1 });
    expect(changeOf({ change: 'edited', changed_at: at(1), change_count: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();
    expect(changeOf({ change: 'edited', changed_at: at(1), change_count: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(changeOf({ change: 'edited', changed_at: undefined, change_count: 1 })).toBeUndefined();
  });
});

describe('PharmacyChangesAfterDispensing (Q132 A, 0148): when it cannot read', () => {
  it('S4 42883 (a database without 0148): an empty map, the savepoint rolled back, no warning', async () => {
    const { client, shape } = fake(() => sqlError('42883'));
    await expect(reader().changes(client, [id(1)], correlationId)).resolves.toEqual(new Map());
    expect(shape()).toEqual([SAVEPOINT, 'reader(1)', ROLLBACK]);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it('S5 42P01 (an undo stopped part way: the table gone under the reader): the same', async () => {
    const { client, shape } = fake(() => sqlError('42P01'));
    await expect(reader().changes(client, [id(1)], correlationId)).resolves.toEqual(new Map());
    expect(shape()).toEqual([SAVEPOINT, 'reader(1)', ROLLBACK]);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it('S6 40001 and 40P01: passed on as they are, the savepoint not rolled back, nothing logged', async () => {
    for (const code of ['40001', '40P01']) {
      const error = sqlError(code);
      const { client, shape } = fake(() => error);
      await expect(reader().changes(client, [id(1)], correlationId)).rejects.toBe(error);
      expect(shape()).toEqual([SAVEPOINT, 'reader(1)']);
    }
    // In a later batch too: the whole transaction is run again, so nothing is answered from the first.
    const late = sqlError('40001');
    const { client, shape } = fake((_, call) => (call === 1 ? late : [row(1)]));
    await expect(reader().changes(client, Array.from({ length: 201 }, (_, n) => id(n + 1)), correlationId))
      .rejects.toBe(late);
    expect(shape()).toEqual([SAVEPOINT, 'reader(200)', 'reader(1)']);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it('S7 another failure (57014, 42501): an empty map, rolled back, one warning with its SQL state and the '
    + 'correlation id', async () => {
    for (const code of ['57014', '42501']) {
      (Logger.prototype.warn as jest.Mock).mockClear();
      const { client, shape } = fake(() => sqlError(code));
      await expect(reader().changes(client, [id(1)], correlationId)).resolves.toEqual(new Map());
      expect(shape()).toEqual([SAVEPOINT, 'reader(1)', ROLLBACK]);
      expect((Logger.prototype.warn as jest.Mock).mock.calls).toEqual([[{ message: COULD_NOT_READ, sqlState: code,
        correlationId }]]);
    }
    // An error without an SQL state (a dropped connection) warns as 'unknown'.
    (Logger.prototype.warn as jest.Mock).mockClear();
    const { client } = fake(() => new Error('Connection terminated unexpectedly'));
    await expect(reader().changes(client, [id(1)], correlationId)).resolves.toEqual(new Map());
    expect((Logger.prototype.warn as jest.Mock).mock.calls).toEqual([[{ message: COULD_NOT_READ, sqlState: 'unknown',
      correlationId }]]);
  });

  it('S8 a second batch failing: no partial map, the one savepoint rolled back, and only the failure logged', async () => {
    const ids = Array.from({ length: 201 }, (_, n) => id(n + 1));
    // The first batch reads cleanly but for one unknown code and one broken row; nothing of it is answered.
    const { client, shape } = fake((_, call) => (call === 0
      ? [row(1), row(2, { change: 'stopped_at_the_counter' }), row(3, { change_count: 0 })] : sqlError('57014')));
    await expect(reader().changes(client, ids, correlationId)).resolves.toEqual(new Map());
    expect(shape()).toEqual([SAVEPOINT, 'reader(200)', 'reader(1)', ROLLBACK]);
    expect((Logger.prototype.warn as jest.Mock).mock.calls).toEqual([[{ message: COULD_NOT_READ, sqlState: '57014',
      correlationId }]]);
    // 42883 on a later batch (the reader dropped between two statements) is still all or nothing, and silent.
    (Logger.prototype.warn as jest.Mock).mockClear();
    const gone = fake((_, call) => (call === 0 ? [row(1)] : sqlError('42883')));
    await expect(reader().changes(gone.client, ids, correlationId)).resolves.toEqual(new Map());
    expect(gone.shape()).toEqual([SAVEPOINT, 'reader(200)', 'reader(1)', ROLLBACK]);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });
});
