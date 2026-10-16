import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bootstrapInput, bootstrapPlatformAdmins,
} from '../../services/ehr-api/scripts/platform-admin-bootstrap.mjs';

// P6, P35(2): a clinician application is approved by a second Super Admin
// (0096), and a Super Admin grant needs a second Super Admin's decision
// (0070). The one-time bootstrap therefore seeds the initial governance set,
// two or three distinct accounts, in one audited transaction. Synthetic IDs.
const a = '7a1c2f30-0000-4000-8000-0000000000a1';
const b = '7a1c2f30-0000-4000-8000-0000000000b2';
const c = '7a1c2f30-0000-4000-8000-0000000000c3';
const d = '7a1c2f30-0000-4000-8000-0000000000d4';
const reason = 'Initial platform governance set for launch';

test('seeds two or three distinct accounts named in PLATFORM_ADMIN_ACCOUNT_IDS', () => {
  assert.deepEqual(bootstrapInput({ PLATFORM_ADMIN_ACCOUNT_IDS: `${a},${b}`, PLATFORM_ADMIN_BOOTSTRAP_REASON: reason }),
    { accountIds: [a, b], reason });
  assert.deepEqual(bootstrapInput({ PLATFORM_ADMIN_ACCOUNT_IDS: ` ${a} , ${b.toUpperCase()} ,${c} `,
    PLATFORM_ADMIN_BOOTSTRAP_REASON: ` ${reason} ` }), { accountIds: [a, b, c], reason });
});

test('keeps the one-account form outside production', () => {
  assert.deepEqual(bootstrapInput({ PLATFORM_ADMIN_ACCOUNT_ID: a, PLATFORM_ADMIN_BOOTSTRAP_REASON: reason }),
    { accountIds: [a], reason });
  for (const NODE_ENV of ['development', 'test']) {
    assert.deepEqual(bootstrapInput({ NODE_ENV, PLATFORM_ADMIN_ACCOUNT_ID: a, PLATFORM_ADMIN_BOOTSTRAP_REASON: reason }),
      { accountIds: [a], reason }, NODE_ENV);
  }
});

// One Super Admin alone can never add a second (0070 refuses a one-step
// platform_super_admin grant, and a two-person request needs another Super
// Admin's decision) nor approve a clinician application (0096), and the
// bootstrap refuses to run again once one is active. The migration task runs
// with NODE_ENV=production in every AWS environment, so there the one-account
// form is refused before any connection.
test('refuses the one-account form in production and names PLATFORM_ADMIN_ACCOUNT_IDS', () => {
  assert.throws(() => bootstrapInput({ NODE_ENV: 'production', PLATFORM_ADMIN_ACCOUNT_ID: a,
    PLATFORM_ADMIN_BOOTSTRAP_REASON: reason }),
  /In production name two or three accounts in PLATFORM_ADMIN_ACCOUNT_IDS; PLATFORM_ADMIN_ACCOUNT_ID is for development only/);
  assert.throws(() => bootstrapInput({ NODE_ENV: 'production', PLATFORM_ADMIN_ACCOUNT_IDS: a,
    PLATFORM_ADMIN_BOOTSTRAP_REASON: reason }), /PLATFORM_ADMIN_ACCOUNT_IDS must name two or three distinct accounts/);
  assert.deepEqual(bootstrapInput({ NODE_ENV: 'production', PLATFORM_ADMIN_ACCOUNT_IDS: `${a},${b}`,
    PLATFORM_ADMIN_BOOTSTRAP_REASON: reason }), { accountIds: [a, b], reason });
});

test('refuses a repeated, missing, malformed or fourth account, and both forms at once', () => {
  const refuse = (environment, message) => assert.throws(
    () => bootstrapInput({ PLATFORM_ADMIN_BOOTSTRAP_REASON: reason, ...environment }), message, JSON.stringify(environment));
  refuse({ PLATFORM_ADMIN_ACCOUNT_IDS: `${a},${a}` }, /two or three distinct accounts/);
  refuse({ PLATFORM_ADMIN_ACCOUNT_IDS: `${a},${a.toUpperCase()}` }, /two or three distinct accounts/);
  refuse({ PLATFORM_ADMIN_ACCOUNT_IDS: `${a},${b},${a}` }, /two or three distinct accounts/);
  refuse({ PLATFORM_ADMIN_ACCOUNT_IDS: a }, /two or three/);
  refuse({ PLATFORM_ADMIN_ACCOUNT_IDS: `${a},${b},${c},${d}` }, /two or three/);
  refuse({ PLATFORM_ADMIN_ACCOUNT_IDS: `${a},,${b}` }, /version-4 account UUIDs/);
  refuse({ PLATFORM_ADMIN_ACCOUNT_IDS: `${a};${b}` }, /version-4 account UUIDs/);
  refuse({ PLATFORM_ADMIN_ACCOUNT_IDS: `${a},7a1c2f30-0000-1000-8000-0000000000b2` }, /version-4 account UUIDs/);
  refuse({ PLATFORM_ADMIN_ACCOUNT_ID: 'not-a-uuid' }, /one exact version-4 account UUID/);
  refuse({ PLATFORM_ADMIN_ACCOUNT_ID: a, PLATFORM_ADMIN_ACCOUNT_IDS: `${b},${c}` }, /not both/);
  refuse({}, /PLATFORM_ADMIN_ACCOUNT_IDS/);
  refuse({ PLATFORM_ADMIN_ACCOUNT_IDS: `${a},${b}`, PLATFORM_ADMIN_BOOTSTRAP_REASON: 'short' }, /8 to 500 characters/);
});

// A client that answers the bootstrap's statements and records them.
function fakeClient({ existing = 0, eligible = (ids) => ids } = {}) {
  const statements = [];
  return {
    statements,
    async query(sql, params = []) {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/schema_migrations/.test(sql)) return { rowCount: 1, rows: [{}] };
      if (/count\(distinct account\.id\)/.test(sql)) return { rowCount: 1, rows: [{ count: existing }] };
      if (/from auth\.accounts account where account\.id = any/.test(sql.replace(/\s+/g, ' '))) {
        const rows = eligible(params[0]).map((id) => ({ id }));
        return { rowCount: rows.length, rows };
      }
      return { rowCount: 1, rows: [] };
    },
  };
}

test('grants every account in one transaction, after the lock and checks, with one audit event each', async () => {
  const client = fakeClient();
  assert.deepEqual(await bootstrapPlatformAdmins(client, { accountIds: [a, b, c], reason }), [a, b, c]);
  const sql = client.statements.map((statement) => statement.sql);
  assert.equal(sql[0], 'begin');
  assert.equal(sql.at(-1), 'commit');
  assert.equal(sql.filter((text) => text === 'begin' || text === 'commit').length, 2);
  const lock = sql.findIndex((text) => text.includes('pg_advisory_xact_lock'));
  const firstGrant = sql.findIndex((text) => text.startsWith('insert into auth.account_roles'));
  assert.ok(lock > 0 && lock < sql.findIndex((text) => text.includes('count(distinct account.id)')));
  assert.ok(sql.findIndex((text) => text.includes('for update')) < firstGrant);
  const grants = client.statements.filter((statement) => statement.sql.startsWith('insert into auth.account_roles'));
  assert.deepEqual(grants.map((statement) => statement.params[0]), [a, b, c]);
  for (const grant of grants) assert.match(grant.sql, /'platform_super_admin', 'platform', null, \$2/);
  const audits = client.statements.filter((statement) => statement.sql.startsWith('insert into audit.events'));
  assert.deepEqual(audits.map((statement) => statement.params[0]), [a, b, c]);
  for (const audit of audits) {
    assert.match(audit.sql, /'admin\.platform-role\.bootstrap', 'success'/);
    assert.deepEqual(audit.params.slice(1), [reason, [a, b, c]]);
  }
});

test('refuses, rolls back and grants nothing while a Super Admin is active or an account is ineligible', async () => {
  const active = fakeClient({ existing: 1 });
  await assert.rejects(bootstrapPlatformAdmins(active, { accountIds: [a, b], reason }),
    /Bootstrap refused: an active platform Super Admin already exists/);
  const ineligible = fakeClient({ eligible: (ids) => ids.filter((id) => id !== b) });
  await assert.rejects(bootstrapPlatformAdmins(ineligible, { accountIds: [a, b], reason }),
    new RegExp(`Bootstrap refused: account ${b} is not active or has no email address and password credential`));
  for (const client of [active, ineligible]) {
    const sql = client.statements.map((statement) => statement.sql);
    assert.equal(sql.at(-1), 'rollback');
    assert.ok(!sql.includes('commit'));
    assert.ok(!sql.some((text) => text.startsWith('insert ') || text.startsWith('update ')));
  }
});

// Platform sign-in (POST /api/v1/auth/admin/login) takes an email and finds
// the account by that email alone (LocalAuthProvider, 'staff'). A phone-only
// patient account has a password and no email, so a Super Admin seeded on it
// could never sign in or enrol MFA, while the bootstrap's own check would
// count it and refuse every later run: one usable Super Admin could then
// neither approve a second (0070) nor a clinician application (0096).
test('an account is eligible only with an email address and a password: platform sign-in is by email', async () => {
  const client = fakeClient();
  await bootstrapPlatformAdmins(client, { accountIds: [a, b], reason });
  const eligibility = client.statements.find((statement) => statement.sql.includes('for update'));
  assert.ok(eligibility, 'the eligibility query');
  assert.match(eligibility.sql, /account\.status = 'active'/);
  assert.match(eligibility.sql, /account\.password_hash is not null/);
  assert.match(eligibility.sql, /account\.email is not null and btrim\(account\.email\) <> ''/);
  const emailless = fakeClient({ eligible: (ids) => ids.filter((id) => id !== c) });
  await assert.rejects(bootstrapPlatformAdmins(emailless, { accountIds: [a, b, c], reason }),
    new RegExp(`^Error: Bootstrap refused: account ${c} is not active or has no email address and password credential; `
      + 'platform sign-in is by email and password$'));
  const sql = emailless.statements.map((statement) => statement.sql);
  assert.equal(sql.at(-1), 'rollback');
  assert.ok(!sql.some((text) => text.startsWith('insert ') || text.startsWith('update ')));
});
