import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { type EligibilityQueryable, VOLUNTEER_SIGN_IN_ELIGIBLE_SQL, volunteerSignInEligible } from './outreach-volunteer';

// Fictional test data only.

describe('volunteerSignInEligible (the query and its answer)', () => {
  function client(answer: unknown) {
    const query = jest.fn(async (_sql: string, _values: unknown[]) => ({ rows: answer === undefined ? [] : [{ eligible: answer }] }));
    return { query, client: { query } as EligibilityQueryable };
  }

  it('asks by account id or by email, with the active staff statuses, and is true only for a true answer', async () => {
    const byId = client(true);
    await expect(volunteerSignInEligible(byId.client, { accountId: '42000000-0000-4000-8000-000000000001' })).resolves.toBe(true);
    expect(byId.query).toHaveBeenCalledWith(VOLUNTEER_SIGN_IN_ELIGIBLE_SQL,
      ['42000000-0000-4000-8000-000000000001', null, ['verified', 'approved', 'active']]);
    const byEmail = client(true);
    await expect(volunteerSignInEligible(byEmail.client, { email: '  Helper@Example.test ' })).resolves.toBe(true);
    expect(byEmail.query.mock.calls[0]?.[1]).toEqual([null, 'Helper@Example.test', ['verified', 'approved', 'active']]);
    for (const answer of [false, null, undefined, 'true', 1]) {
      await expect(volunteerSignInEligible(client(answer).client, { accountId: 'a' })).resolves.toBe(false);
    }
  });

  it('answers false for an empty email without asking the database, and lets a database error through', async () => {
    const empty = client(true);
    await expect(volunteerSignInEligible(empty.client, { email: '   ' })).resolves.toBe(false);
    expect(empty.query).not.toHaveBeenCalled();
    const failing = { query: jest.fn(async () => { throw new Error('database unavailable'); }) };
    await expect(volunteerSignInEligible(failing, { accountId: 'a' })).rejects.toThrow('database unavailable');
  });

  it('checks every condition of the plan in the one query, and reads no cached roles', () => {
    const sql = VOLUNTEER_SIGN_IN_ELIGIBLE_SQL.replace(/\s+/g, ' ');
    for (const part of [
      "account.status = 'active'",
      'account.email_verified_at is not null',
      '(account.disabled_until is null or account.disabled_until <= clock_timestamp())',
      "account.subject = 'outreach-volunteer:' || account.id::text",
      'from identity.staff staff where staff.account_id = account.id and staff.active',
      "assignment.scope_type = 'facility' and assignment.role_code = 'outreach_volunteer'",
      "(assignment.scope_type <> 'facility' or assignment.role_code <> 'outreach_volunteer')",
      "membership.membership_role is distinct from 'outreach_volunteer'",
      'identity.sealed_demo_facility(membership.facility_id)',
    ]) expect(sql).toContain(part);
    // identity.patients is under row-level security that shows Identity only some patients.
    expect(sql).not.toContain('identity.patients');
  });
});

/**
 * Against a real, migrated database (ehr-api's db:migrate and db:bootstrap)
 * when HID_IDENTITY_TEST_DATABASE_URL names one, as a superuser: the
 * fixtures are written with triggers and foreign keys off
 * (session_replication_role replica)
 * in a transaction that is rolled back, and the query runs as Identity's
 * runtime role, so its grants are checked too. Skipped otherwise (CI has no
 * database for identity-api's jest).
 */
const databaseUrl = process.env.HID_IDENTITY_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('volunteerSignInEligible against a migrated database', () => {
  let db: Client;
  const outreachOrganisation = randomUUID();
  const outreachFacility = randomUUID();
  const hospitalOrganisation = randomUUID();
  const hospitalFacility = randomUUID();
  const demoFacility = randomUUID();
  const accounts: Record<string, string> = {};

  async function account(name: string, options: { subject?: string; verified?: boolean; disabledUntil?: string;
    status?: string; staff?: boolean; staffStatus?: string } = {}) {
    const id = randomUUID();
    accounts[name] = id;
    await db.query(`insert into auth.accounts (id, subject, email, display_name, status, email_verified_at, disabled_until)
      values ($1, $2, $3, $4, $5, case when $6 then clock_timestamp() end, $7::timestamptz)`,
    [id, options.subject ?? `outreach-volunteer:${id}`, `${name}@example.test`, `Fictional ${name}`,
      options.status ?? 'active', options.verified ?? true, options.disabledUntil ?? null]);
    if (options.staff !== false) {
      await db.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active)
        values ($1, $2, $3, $4, $5, 'outreach_volunteer', true)`,
      [randomUUID(), id, `Fictional ${name}`, `${name}@example.test`, options.staffStatus ?? 'verified']);
    }
    return id;
  }

  async function member(accountId: string, role: string, facility = outreachFacility,
    organisation = outreachOrganisation, options: { active?: boolean; revoked?: boolean } = {}) {
    const staff = (await db.query<{ id: string }>('select id from identity.staff where account_id = $1', [accountId])).rows[0]?.id
      ?? randomUUID();
    const membership = randomUUID();
    await db.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, $6, $6, false, $7)`,
    [membership, staff, accountId, organisation, facility, role, options.active ?? true]);
    await db.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id,
      grant_reason, revoked_at, revoked_by, revocation_reason)
      values ($1, $2, $3, 'facility', $4, $5, 'Fictional test grant', case when $6 then clock_timestamp() end,
        case when $6 then $2::uuid end, case when $6 then 'Fictional removal from the group' end)`,
    [randomUUID(), accountId, role, membership, facility, options.revoked ?? false]);
  }

  async function eligible(lookup: { accountId: string } | { email: string }) {
    await db.query('set local role hid_identity_api_runtime');
    try {
      return await volunteerSignInEligible(db as unknown as EligibilityQueryable, lookup);
    } finally {
      await db.query('reset role');
    }
  }

  beforeAll(async () => {
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    await db.query('begin');
    await db.query("set local session_replication_role = 'replica'");
    await db.query("select set_config('app.actor_subject', 'system:auth', true)");
    // The query reads no organisation or facility row, and foreign keys are off, so none is written.
    await db.query(`insert into identity.sealed_demo_members (member_kind, member_id) values ('facility', $1)`, [demoFacility]);

    await member(await account('volunteer'), 'outreach_volunteer');
    await member(await account('organiser'), 'outreach_organiser');
    const promoted = await account('promoted');
    await member(promoted, 'outreach_volunteer');
    await member(promoted, 'outreach_organiser');
    const mixed = await account('mixed');
    await member(mixed, 'outreach_volunteer');
    await member(mixed, 'doctor', hospitalFacility, hospitalOrganisation);
    const platform = await account('platform');
    await member(platform, 'outreach_volunteer');
    await db.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
      values ($1, $2, 'support_admin', 'platform', 'Fictional test grant')`,
      [randomUUID(), platform]);
    await member(await account('unverified', { verified: false }), 'outreach_volunteer');
    await member(await account('disabled', { disabledUntil: '2999-01-01T00:00:00Z' }), 'outreach_volunteer');
    await member(await account('pendingreset', { status: 'pending_reset' }), 'outreach_volunteer');
    await member(await account('removed'), 'outreach_volunteer', outreachFacility, outreachOrganisation,
      { active: false, revoked: true });
    await member(await account('hospitalsubject', { subject: `staff:${randomUUID()}` }), 'outreach_volunteer');
    await member(await account('nostaff', { staff: false }), 'outreach_volunteer');
    await member(await account('unverifiedstaff', { staffStatus: 'pending' }), 'outreach_volunteer');
    await member(await account('demo'), 'outreach_volunteer', demoFacility);
    const twoGroups = await account('twogroups');
    await member(twoGroups, 'outreach_volunteer');
    await member(twoGroups, 'outreach_volunteer', hospitalFacility, hospitalOrganisation);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('rollback').catch(() => undefined);
    await db.end();
  });

  it('is true for a volunteer-only login, by account id and by email in any case', async () => {
    await expect(eligible({ accountId: accounts.volunteer as string })).resolves.toBe(true);
    await expect(eligible({ email: 'VOLUNTEER@example.test' })).resolves.toBe(true);
    await expect(eligible({ accountId: accounts.twogroups as string })).resolves.toBe(true);
  });

  it.each(['organiser', 'promoted', 'mixed', 'platform', 'unverified', 'disabled', 'pendingreset', 'removed',
    'hospitalsubject', 'nostaff', 'unverifiedstaff', 'demo'])('is false for the %s login', async (name) => {
    await expect(eligible({ accountId: accounts[name] as string })).resolves.toBe(false);
    await expect(eligible({ email: `${name}@example.test` })).resolves.toBe(false);
  });

  it('is false for an unknown email or account', async () => {
    await expect(eligible({ email: 'nobody@example.test' })).resolves.toBe(false);
    await expect(eligible({ accountId: randomUUID() })).resolves.toBe(false);
  });
});
