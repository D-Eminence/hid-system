import { randomUUID } from 'node:crypto';
import { Client, type PoolClient } from 'pg';
import { RECOVERY_HOLD_HOURS, RECOVERY_OTP_PURPOSES, requireNoRecentRecoveryHold } from './recent-authentication';

// Fictional test data only.
const accountId = '42000000-0000-4000-8000-000000000001';

describe('requireNoRecentRecoveryHold: only recovery codes hold', () => {
  function client(held: unknown) {
    const query = jest.fn(async (_sql: string, _values: unknown[]) => ({ rows: held === undefined ? [] : [{ held }] }));
    return { query, client: { query } as unknown as PoolClient };
  }

  it('counts consumed codes of the three recovery purposes only, so a sign-in code (LOGIN_STEP_UP) never holds', async () => {
    const { query, client: db } = client(false);
    await expect(requireNoRecentRecoveryHold(db, accountId, 'Invitations')).resolves.toBeUndefined();
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql.replace(/\s+/g, ' ')).toContain(
      "and purpose in ('PASSWORD_RESET','LEGACY_ACCOUNT_RECOVERY','LEGACY_SESSION_FALLBACK')");
    expect(sql).toContain('consumed_at is not null');
    expect(sql).not.toContain('LOGIN_STEP_UP');
    expect(values).toEqual([accountId, RECOVERY_HOLD_HOURS]);
    expect(RECOVERY_OTP_PURPOSES).toEqual(['PASSWORD_RESET', 'LEGACY_ACCOUNT_RECOVERY', 'LEGACY_SESSION_FALLBACK']);
    for (const purpose of RECOVERY_OTP_PURPOSES) expect(sql).toContain(`'${purpose}'`);
  });

  it('still holds after a recovery, and fails closed without an answer', async () => {
    await expect(requireNoRecentRecoveryHold(client(true).client, accountId, 'Invitations', 'STAFF_RECENT_RECOVERY_HOLD'))
      .rejects.toMatchObject({ status: 403, code: 'STAFF_RECENT_RECOVERY_HOLD' });
    await expect(requireNoRecentRecoveryHold(client(undefined).client, accountId, 'Contacts'))
      .rejects.toMatchObject({ status: 403, code: 'PATIENT_RECENT_RECOVERY_HOLD' });
  });
});

/**
 * Against a real, migrated database when HID_IDENTITY_TEST_DATABASE_URL names
 * one (see outreach-volunteer.spec.ts): the rows are written in a transaction
 * that is rolled back, with triggers and foreign keys off.
 */
const databaseUrl = process.env.HID_IDENTITY_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('requireNoRecentRecoveryHold against a migrated database', () => {
  let db: Client;

  beforeEach(async () => {
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    await db.query('begin');
    await db.query("set local session_replication_role = 'replica'");
  });

  afterEach(async () => {
    await db.query('rollback').catch(() => undefined);
    await db.end();
  });

  /** A settled code as the plan's email-code sign-in leaves it, or a consumed one as recovery does. */
  async function challenge(account: string, purpose: string, settled: 'completed' | 'consumed') {
    await db.query(`insert into auth.otp_challenges (id, account_id, recipient_hmac, purpose, channel, verifier_hmac,
        verifier_key_version, expires_at, max_attempts, verified_at, completion_token_hmac, completion_expires_at,
        consumed_at, invalidated_at, invalidation_reason)
      values ($1, $2, repeat('a', 64), $3, 'email', repeat('b', 64), 'local-v1', clock_timestamp() + interval '10 minutes', 5,
        clock_timestamp(), repeat('c', 64), clock_timestamp() + interval '10 minutes',
        case when $4 = 'consumed' then clock_timestamp() end,
        case when $4 = 'completed' then clock_timestamp() end,
        case when $4 = 'completed' then 'completed' end)`, [randomUUID(), account, purpose, settled]);
  }

  async function held(account: string): Promise<boolean> {
    await db.query('savepoint hold');
    await db.query('set local role hid_identity_api_runtime');
    try {
      await requireNoRecentRecoveryHold(db as unknown as PoolClient, account, 'Invitations');
      return false;
    } catch {
      return true;
    } finally {
      await db.query('rollback to savepoint hold');
    }
  }

  it('does not hold for a sign-in code, settled (completed) or even consumed', async () => {
    const settled = randomUUID();
    await challenge(settled, 'LOGIN_STEP_UP', 'completed');
    expect(await held(settled)).toBe(false);
    const consumed = randomUUID();
    await challenge(consumed, 'LOGIN_STEP_UP', 'consumed');
    expect(await held(consumed)).toBe(false);
  });

  it.each([...RECOVERY_OTP_PURPOSES])('still holds after a consumed %s code', async (purpose) => {
    const account = randomUUID();
    await challenge(account, purpose, 'consumed');
    expect(await held(account)).toBe(true);
  });
});
