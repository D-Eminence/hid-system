import { DatabaseService } from './database.service';

// withCardShareTransaction (0118): the receiver's read sets only the view's
// digest, the correlation id and purpose card-share, transaction-local, and
// blanks every patient, account, session, facility and membership setting,
// so ehr.card_share_read_context can never combine with another context.
function setup() {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  const release = jest.fn();
  const connect = jest.fn().mockResolvedValue({ query, release });
  const service = Object.create(DatabaseService.prototype) as DatabaseService;
  Object.assign(service, { pool: { connect } });
  return { service, connect, query, release };
}
const digest = 'a'.repeat(64);

describe('Card-share read transaction (0118)', () => {
  it('is read only, sets only the three settings transaction-local and blanks the rest', async () => {
    const { service, query, release } = setup();
    await service.withCardShareTransaction(digest, 'card-share-0001', async (client) => {
      await client.query('select 1');
    });
    const calls = query.mock.calls.map(([sql, values]) => [String(sql).replace(/\s+/g, ' ').trim(), values]);
    expect(calls[0]).toEqual(['BEGIN', undefined]);
    expect(calls[1]).toEqual(['SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY', undefined]);
    const settings = String(calls[2]?.[0]);
    expect(settings).toBe("select set_config('app.card_view_digest',$1,true), set_config('app.correlation_id',$2,true), "
      + "set_config('app.purpose_of_use','card-share',true), set_config('app.actor_subject','',true), "
      + "set_config('app.patient_id','',true), set_config('app.account_id','',true), "
      + "set_config('app.session_id','',true), set_config('app.facility_id','',true), "
      + "set_config('app.membership_id','',true), set_config('app.self_authorized_until','',true)");
    expect(calls[2]?.[1]).toEqual([digest, 'card-share-0001']);
    expect(settings).not.toMatch(/,\s*false\)/);
    expect(calls.at(-1)).toEqual(['COMMIT', undefined]);
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
