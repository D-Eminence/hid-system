import type { PoolClient } from 'pg';
import { resetEnvironmentForTests } from '../config/environment';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { StaffSearchBudget, staffSearchBucket } from './staff-search-budget';

const context = {
  actor: { subject: 'staff-subject', accountId: 'staff-account' }, facilityId: 'facility-a',
  membershipId: 'membership-a', correlationId: 'budget-correlation', purposeOfUse: 'direct-care',
} as unknown as DataAccessContext;

/** Staff patient search budgets per actor and per facility (PSEARCH-1, 0086). */
describe('StaffSearchBudget', () => {
  const original = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      PATIENT_LOOKUP_ACTOR_MAX_REQUESTS: '2', PATIENT_LOOKUP_FACILITY_MAX_REQUESTS: '3',
    });
    resetEnvironmentForTests();
  });

  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  /** An in-memory auth.otp_rate_limits answering consumeRateLimit's statements. */
  function store() {
    const rows = new Map<string, { request_count: number; window_started_at: Date; blocked_until: Date | null }>();
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const query = jest.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('from auth.otp_rate_limits')) {
        const row = rows.get(`${values[0]}:${values[1]}`);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (sql.includes('insert into auth.otp_rate_limits')) {
        const [scope, bucket, windowExpired, nextCount, blocked, windowSeconds] =
          values as [string, string, boolean, number, boolean, number];
        const row = rows.get(`${scope}:${bucket}`);
        rows.set(`${scope}:${bucket}`, { request_count: nextCount,
          window_started_at: windowExpired || !row ? new Date() : row.window_started_at,
          blocked_until: blocked ? new Date(Date.now() + windowSeconds * 1000) : null });
        return { rows: [] };
      }
      throw new Error(`Unexpected statement: ${sql}`);
    });
    const contexts: unknown[] = [];
    const database = { withTransaction: jest.fn(async (transactionContext: unknown,
      work: (client: PoolClient) => Promise<unknown>) => {
      contexts.push(transactionContext);
      return work({ query } as unknown as PoolClient);
    }) } as unknown as DatabaseService;
    return { database, calls, rows, contexts };
  }

  it('counts each lookup per actor and per facility in the staff context and refuses the third with 429', async () => {
    const s = store();
    const budget = new StaffSearchBudget(s.database);
    await budget.consume('patient_lookup', context);
    await budget.consume('patient_lookup', context);
    await expect(budget.consume('patient_lookup', context))
      .rejects.toMatchObject({ status: 429, code: 'PATIENT_LOOKUP_RATE_LIMITED' });
    expect(s.contexts).toEqual([context, context, context]);
    const inserts = s.calls.filter(({ sql }) => sql.includes('insert into auth.otp_rate_limits'));
    expect(inserts.slice(0, 2).map(({ values }) => [values[0], values[1]])).toEqual([
      ['patient_lookup_actor', staffSearchBucket('patient_lookup', 'actor', 'staff-account')],
      ['patient_lookup_facility', staffSearchBucket('patient_lookup', 'facility', 'facility-a')],
    ]);
    expect(JSON.stringify(s.calls)).not.toContain('staff-account');
    expect(JSON.stringify(s.calls)).not.toContain('facility-a');
  });

  it('spends nothing more of the facility budget once the actor is blocked, and refuses a whole facility at its limit', async () => {
    const s = store();
    const budget = new StaffSearchBudget(s.database);
    const colleague = { ...context, actor: { ...context.actor, accountId: 'colleague-account' } } as unknown as DataAccessContext;
    await budget.consume('patient_lookup', context);
    await budget.consume('patient_lookup', context);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(budget.consume('patient_lookup', context)).rejects.toMatchObject({ code: 'PATIENT_LOOKUP_RATE_LIMITED' });
    }
    const facility = s.rows.get(`patient_lookup_facility:${staffSearchBucket('patient_lookup', 'facility', 'facility-a')}`);
    expect(facility?.request_count).toBe(2);
    await budget.consume('patient_lookup', colleague);
    await expect(budget.consume('patient_lookup', colleague)).rejects.toMatchObject({ code: 'PATIENT_LOOKUP_RATE_LIMITED' });
  });

  it('keeps access-request creation in budgets of its own, refused as ACCESS_REQUEST_RATE_LIMITED', async () => {
    process.env.ACCESS_REQUEST_ACTOR_MAX_REQUESTS = '1';
    resetEnvironmentForTests();
    const s = store();
    const budget = new StaffSearchBudget(s.database);
    await budget.consume('patient_lookup', context);
    await budget.consume('access_request', context);
    await expect(budget.consume('access_request', context))
      .rejects.toMatchObject({ status: 429, code: 'ACCESS_REQUEST_RATE_LIMITED' });
    expect([...s.rows.keys()].map((key) => key.split(':')[0]).sort()).toEqual([
      'access_request_actor', 'access_request_facility', 'patient_lookup_actor', 'patient_lookup_facility',
    ]);
  });

  it('defaults to 60 lookups per actor and 600 per facility in 5 minutes, 20 and 200 requests in 15 minutes', () => {
    for (const name of ['PATIENT_LOOKUP_ACTOR_MAX_REQUESTS', 'PATIENT_LOOKUP_FACILITY_MAX_REQUESTS']) delete process.env[name];
    resetEnvironmentForTests();
    const { getEnvironment } = jest.requireActual<typeof import('../config/environment')>('../config/environment');
    expect(getEnvironment()).toMatchObject({
      PATIENT_LOOKUP_RATE_WINDOW_SECONDS: 300, PATIENT_LOOKUP_ACTOR_MAX_REQUESTS: 60,
      PATIENT_LOOKUP_FACILITY_MAX_REQUESTS: 600, ACCESS_REQUEST_RATE_WINDOW_SECONDS: 900,
      ACCESS_REQUEST_ACTOR_MAX_REQUESTS: 20, ACCESS_REQUEST_FACILITY_MAX_REQUESTS: 200,
    });
  });
});
