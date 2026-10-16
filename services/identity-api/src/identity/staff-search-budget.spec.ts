import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { resetEnvironmentForTests } from '../config/environment';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { IdentityService } from './identity.service';
import type { IdentityPatient, IdentityProvider } from './identity.types';
import { StaffSearchBudget, staffSearchBucket } from './staff-search-budget';

const context = {
  actor: { subject: 'staff-subject', accountId: 'staff-account' }, facilityId: 'facility-a',
  membershipId: 'membership-a', correlationId: 'budget-correlation', purposeOfUse: 'direct-care',
} as unknown as DataAccessContext;

/**
 * The read-only budget check (FE-10). Called loosely so that this spec also
 * compiles against a budget without it.
 */
const refuseWhileBlocked = (budget: StaffSearchBudget, checked: DataAccessContext) =>
  (budget as unknown as { refuseWhileBlocked(operation: 'patient_lookup', context: DataAccessContext): Promise<void> })
    .refuseWhileBlocked('patient_lookup', checked);

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

  /**
   * An in-memory auth.otp_rate_limits answering consumeRateLimit's and
   * rateLimitBlocked's statements.
   */
  function store() {
    const rows = new Map<string, { request_count: number; window_started_at: Date; blocked_until: Date | null }>();
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const query = jest.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('as blocked') && sql.includes('from auth.otp_rate_limits')) {
        const row = rows.get(`${values[0]}:${values[1]}`);
        return { rows: row ? [{ blocked: row.blocked_until !== null && row.blocked_until.getTime() > Date.now() }] : [] };
      }
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
    const options: unknown[] = [];
    const database = { withTransaction: jest.fn(async (transactionContext: unknown,
      work: (client: PoolClient) => Promise<unknown>, transactionOptions?: unknown) => {
      contexts.push(transactionContext);
      options.push(transactionOptions);
      return work({ query } as unknown as PoolClient);
    }) } as unknown as DatabaseService;
    return { database, calls, rows, contexts, options };
  }
  const count = (s: ReturnType<typeof store>, scope: 'actor' | 'facility', id: string) =>
    s.rows.get(`patient_lookup_${scope}:${staffSearchBucket('patient_lookup', scope, id)}`)?.request_count ?? 0;

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

  // A21: a refused lookup or access request says when to retry, as Retry-After:
  // the operation's whole configured window, the same whichever of its actor and
  // facility buckets refused, and never the time left in the blocked bucket.
  it('carries the whole configured window as Retry-After on every refused lookup and access request (A21)', async () => {
    Object.assign(process.env, { PATIENT_LOOKUP_RATE_WINDOW_SECONDS: '600', ACCESS_REQUEST_ACTOR_MAX_REQUESTS: '1' });
    resetEnvironmentForTests();
    jest.useFakeTimers({ now: new Date('2026-10-14T09:00:00Z') });
    try {
      const s = store();
      const budget = new StaffSearchBudget(s.database);
      const colleague = { ...context, actor: { ...context.actor, accountId: 'colleague-account' } } as unknown as DataAccessContext;
      const lookupLimited = { status: 429, code: 'PATIENT_LOOKUP_RATE_LIMITED', retryAfterSeconds: 600 };
      await budget.consume('patient_lookup', context);
      await budget.consume('patient_lookup', context);
      // The actor's bucket refuses a counted lookup...
      await expect(budget.consume('patient_lookup', context)).rejects.toMatchObject(lookupLimited);
      // ...and the read-only check, 500 seconds later, still states the whole window, not the 100 left.
      jest.setSystemTime(new Date('2026-10-14T09:08:20Z'));
      await expect(refuseWhileBlocked(budget, context)).rejects.toMatchObject(lookupLimited);
      // The facility's bucket (its maximum is 3) refuses a colleague with the same value.
      await budget.consume('patient_lookup', colleague);
      await expect(budget.consume('patient_lookup', colleague)).rejects.toMatchObject(lookupLimited);
      await budget.consume('access_request', context);
      await expect(budget.consume('access_request', context)).rejects.toMatchObject({
        status: 429, code: 'ACCESS_REQUEST_RATE_LIMITED', retryAfterSeconds: 900 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('reads whether the actor or the facility is blocked, in a read-only staff transaction, counting nothing', async () => {
    const s = store();
    const budget = new StaffSearchBudget(s.database);
    const colleague = { ...context, actor: { ...context.actor, accountId: 'colleague-account' } } as unknown as DataAccessContext;
    await refuseWhileBlocked(budget, context);
    expect(s.rows.size).toBe(0);
    expect(s.contexts).toEqual([context]);
    expect(s.options).toEqual([{ readOnly: true }]);
    const reads = s.calls.filter(({ sql }) => sql.includes('as blocked'));
    expect(reads.map(({ values }) => values)).toEqual([
      ['patient_lookup_actor', staffSearchBucket('patient_lookup', 'actor', 'staff-account')],
      ['patient_lookup_facility', staffSearchBucket('patient_lookup', 'facility', 'facility-a')],
    ]);
    expect(s.calls.some(({ sql }) => sql.includes('insert into') || sql.includes('for update'))).toBe(false);

    // At its maximum but not over it, the actor is not blocked.
    await budget.consume('patient_lookup', context);
    await budget.consume('patient_lookup', context);
    await refuseWhileBlocked(budget, context);
    await expect(budget.consume('patient_lookup', context)).rejects.toMatchObject({ code: 'PATIENT_LOOKUP_RATE_LIMITED' });
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(refuseWhileBlocked(budget, context))
        .rejects.toMatchObject({ status: 429, code: 'PATIENT_LOOKUP_RATE_LIMITED' });
    }
    expect(count(s, 'actor', 'staff-account')).toBe(3);
    expect(count(s, 'facility', 'facility-a')).toBe(2);

    // A colleague is refused only once the facility itself is blocked.
    await refuseWhileBlocked(budget, colleague);
    await budget.consume('patient_lookup', colleague);
    await expect(budget.consume('patient_lookup', colleague)).rejects.toMatchObject({ code: 'PATIENT_LOOKUP_RATE_LIMITED' });
    await expect(refuseWhileBlocked(budget, colleague))
      .rejects.toMatchObject({ status: 429, code: 'PATIENT_LOOKUP_RATE_LIMITED' });
    expect(count(s, 'actor', 'colleague-account')).toBe(2);
    expect(JSON.stringify(s.calls)).not.toContain('staff-account');
    expect(JSON.stringify(s.calls)).not.toContain('facility-a');
  });

  it('with the default budgets, lets a granted patient be looked up beyond 60 times, while 60 refusals make the next lookup 429 for granted and unknown alike', async () => {
    for (const name of ['PATIENT_LOOKUP_ACTOR_MAX_REQUESTS', 'PATIENT_LOOKUP_FACILITY_MAX_REQUESTS']) delete process.env[name];
    resetEnvironmentForTests();
    const s = store();
    const granted: IdentityPatient = {
      id: 'patient-1', hidCode: 'HID-ABCDEFGH', firstName: 'Amina', lastName: 'Okafor', fullName: 'Amina Okafor',
      dateOfBirth: '1990-01-01', gender: 'female', rowVersion: 1,
    };
    const lookupExactHid = jest.fn(async (hid: string) => (hid === granted.hidCode ? granted : null));
    const provider = {
      lookupExactHid,
      lookupAuditSubject: jest.fn(async () => null),
      authorize: jest.fn(async () => ({ allowed: true, patientId: granted.id, facilityId: 'facility-a',
        membershipId: 'membership-a', scope: 'read_records', purpose: 'direct-care', consentGrantId: 'grant-1',
        expiresAt: '2026-10-13T12:00:00.000Z', breakGlass: false })),
      consentStatus: jest.fn(),
    } as unknown as IdentityProvider;
    const audit = { record: jest.fn(async () => undefined) } as unknown as AuditService;
    const service = new IdentityService(provider, audit, new StaffSearchBudget(s.database));
    const lookup = (hid: string) => service.lookupPatient(hid, 'direct-care', context);

    // Health-id looks the patient up before each clinical read and write.
    for (let repeat = 0; repeat < 61; repeat++) {
      await expect(lookup('HID-ABCDEFGH')).resolves.toMatchObject({ patient: { patientId: 'patient-1' } });
    }
    expect(count(s, 'actor', 'staff-account')).toBe(0);
    expect(count(s, 'facility', 'facility-a')).toBe(0);

    for (let refusal = 1; refusal <= 60; refusal++) {
      await expect(lookup(`HID-UNKNOWN${refusal}`)).rejects.toMatchObject({ status: 404, code: 'PATIENT_NOT_AVAILABLE' });
    }
    // The 61st refusal crosses the actor's maximum: 429, not 404.
    await expect(lookup('HID-UNKNOWN61')).rejects.toMatchObject({ status: 429, code: 'PATIENT_LOOKUP_RATE_LIMITED' });
    lookupExactHid.mockClear();
    await expect(lookup('HID-ABCDEFGH')).rejects.toMatchObject({ status: 429, code: 'PATIENT_LOOKUP_RATE_LIMITED' });
    await expect(lookup('HID-UNKNOWN62')).rejects.toMatchObject({ status: 429, code: 'PATIENT_LOOKUP_RATE_LIMITED' });
    expect(lookupExactHid).not.toHaveBeenCalled();
    expect(count(s, 'actor', 'staff-account')).toBe(61);
    expect(count(s, 'facility', 'facility-a')).toBe(60);
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
