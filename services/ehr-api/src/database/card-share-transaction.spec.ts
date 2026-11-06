import { DatabaseService } from './database.service';

// withCardShareTransaction (0118): the receiver's read sets only the view's
// digest, the correlation id and purpose card-share, transaction-local, and
// blanks every patient, account, session, facility and membership setting,
// so ehr.card_share_read_context can never combine with another context. The
// view context (which audits the read) runs first; then the transaction turns
// read only for the reads. card-share-transaction.pg.spec.ts runs it on PostgreSQL.
const context = { patient_id: 'e8b10000-0000-4000-8000-000000000001', share_id: '5e100000-0000-4000-8000-000000000001',
  view_id: '7e300000-0000-4000-8000-000000000001', scope: 'card_and_records' };
function setup() {
  const query = jest.fn(async (sql: string, _values?: unknown[]) => ({
    rows: String(sql).includes('ehr.card_share_view_context') ? [context] : [] }));
  const release = jest.fn();
  const connect = jest.fn().mockResolvedValue({ query, release });
  const service = Object.create(DatabaseService.prototype) as DatabaseService;
  Object.assign(service, { pool: { connect } });
  return { service, connect, query, release };
}
const digest = 'a'.repeat(64);

describe('Card-share read transaction (0118)', () => {
  it('sets only the three settings transaction-local, audits the view, then turns read only before the reads', async () => {
    const { service, query, release } = setup();
    const seen: unknown[] = [];
    await service.withCardShareTransaction(digest, 'card-share-0001', async (client, view) => {
      seen.push(view);
      await client.query('select 1');
    });
    const calls = query.mock.calls.map(([sql, values]) => [String(sql).replace(/\s+/g, ' ').trim(), values]);
    expect(calls[0]).toEqual(['BEGIN', undefined]);
    expect(calls[1]).toEqual(['SET TRANSACTION ISOLATION LEVEL READ COMMITTED', undefined]);
    const settings = String(calls[2]?.[0]);
    expect(settings).toBe("select set_config('app.card_view_digest',$1,true), set_config('app.correlation_id',$2,true), "
      + "set_config('app.purpose_of_use','card-share',true), set_config('app.actor_subject','',true), "
      + "set_config('app.patient_id','',true), set_config('app.account_id','',true), "
      + "set_config('app.session_id','',true), set_config('app.facility_id','',true), "
      + "set_config('app.membership_id','',true), set_config('app.self_authorized_until','',true)");
    expect(calls[2]?.[1]).toEqual([digest, 'card-share-0001']);
    expect(settings).not.toMatch(/,\s*false\)/);
    // ehr.card_share_view_context writes its audit row, so it runs before the transaction turns read only (F1).
    expect(calls[3]).toEqual(['select patient_id::text, share_id::text, view_id::text, scope from ehr.card_share_view_context()',
      undefined]);
    expect(calls[4]).toEqual(['SET TRANSACTION READ ONLY', undefined]);
    expect(calls[5]).toEqual(['select 1', undefined]);
    expect(seen).toEqual([context]);
    expect(calls.at(-1)).toEqual(['COMMIT', undefined]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('never runs the reads without a live view (55000), and rolls back', async () => {
    const { service, query, release } = setup();
    query.mockImplementation(async () => ({ rows: [] }));
    const operation = jest.fn();
    await expect(service.withCardShareTransaction(digest, 'card-share-0001', operation)).rejects.toMatchObject({ code: '55000' });
    expect(operation).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}'`])(
    'refuses a digest that is not 64 lower-case hex characters (%s) before connecting', async (value) => {
      const { service, connect } = setup();
      await expect(service.withCardShareTransaction(value, 'card-share-0001', jest.fn())).rejects.toThrow();
      expect(connect).not.toHaveBeenCalled();
    });

  it('rolls back and releases on failure', async () => {
    const { service, query, release } = setup();
    await expect(service.withCardShareTransaction(digest, 'card-share-0001', async () => { throw new Error('read failed'); }))
      .rejects.toThrow('read failed');
    expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
