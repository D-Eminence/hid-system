import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import test from 'node:test';
import * as platformAdminBootstrap from '../../services/ehr-api/scripts/platform-admin-bootstrap.mjs';

const { bootstrapInput, bootstrapPlatformAdmins } = platformAdminBootstrap;
// Read at call time, so each test that needs the email form fails on its own
// where the module does not provide it.
const bootstrapPlatformAdminsByEmail = (...args) => platformAdminBootstrap.bootstrapPlatformAdminsByEmail(...args);

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

test('refuses, rolls back and grants nothing while a Super Admin exists or an account is ineligible', async () => {
  const active = fakeClient({ existing: 1 });
  await assert.rejects(bootstrapPlatformAdmins(active, { accountIds: [a, b], reason }),
    /Bootstrap refused: a platform Super Admin already exists, in any status but deleted/);
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

// Owner decision 2026-10-16 (SUPERADMIN-ACCOUNTS): "By email, own password".
// A new database has no account for admin:bootstrap to name, so the one-time
// run may instead take two or three email addresses: it creates a
// platform-only account for each, with no password, pending_reset, and grants
// each Super Admin in the same audited transaction. Each person then sets
// their own password with the admin password reset (Turnstile action
// admin-reset, an emailed code; recovery reaches an administrator still
// setting a password, 0086) and enrols an authenticator at the first platform
// sign-in. Nobody else ever knows the password. Synthetic addresses.
const one = 'example-admin-one@example.invalid';
const two = 'example-admin-two@example.invalid';
const three = 'example-admin-three@example.invalid';
const four = 'example-admin-four@example.invalid';
// The address rules every later step applies: 0087 (staff email), the
// recovery start (StartOtpDto) and platform sign-in (PlatformLoginDto, IsEmail).
const workforceEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const recoveryIdentifier = /^(?:[^\s@]+@[^\s@]+\.[^\s@]+|HID-[A-HJ-NP-Z2-9]{6,32})$/i;
const { isEmail } = createRequire(join(resolve(import.meta.dirname, '../../services/ehr-api'), 'package.json'))('validator');

test('PLATFORM_ADMIN_EMAILS names two or three addresses, separated by commas or spaces, normalized as staff email is', () => {
  for (const NODE_ENV of [undefined, 'development', 'production']) {
    assert.deepEqual(bootstrapInput({ NODE_ENV, PLATFORM_ADMIN_EMAILS: `${one},${two}`, PLATFORM_ADMIN_BOOTSTRAP_REASON: reason }),
      { emails: [one, two], reason, replacePending: false }, String(NODE_ENV));
  }
  assert.deepEqual(bootstrapInput({ PLATFORM_ADMIN_EMAILS: ` ${one.toUpperCase()} , ${two}\n${three} `,
    PLATFORM_ADMIN_BOOTSTRAP_REASON: reason }), { emails: [one, two, three], reason, replacePending: false });
  assert.deepEqual(bootstrapInput({ PLATFORM_ADMIN_EMAILS: `${one} ${two}`, PLATFORM_ADMIN_BOOTSTRAP_REASON: reason }).emails,
    [one, two]);
  // Every accepted address passes each later step's own check.
  for (const address of [one, 'first.last+hid@mail.example-host.org', 'o_k-1@sub.example.ng']) {
    const [accepted] = bootstrapInput({ PLATFORM_ADMIN_EMAILS: `${address},${two}`, PLATFORM_ADMIN_BOOTSTRAP_REASON: reason }).emails;
    assert.equal(accepted, address.trim().toLowerCase());
    assert.ok(workforceEmail.test(accepted) && recoveryIdentifier.test(accepted) && isEmail(accepted)
      && accepted.length <= 254, accepted);
  }
});

test('PLATFORM_ADMIN_EMAILS refuses a repeated, missing, fourth or unplain address without echoing it', () => {
  const refuse = (value, message) => {
    let error;
    try { bootstrapInput({ PLATFORM_ADMIN_EMAILS: value, PLATFORM_ADMIN_BOOTSTRAP_REASON: reason }); } catch (caught) { error = caught; }
    assert.ok(error, `accepted ${JSON.stringify(value)}`);
    assert.match(error.message, message, JSON.stringify(value));
    assert.match(error.message, /PLATFORM_ADMIN_EMAILS/);
    for (const entry of value.split(/[\s,;<>]+/).filter((part) => part.includes('@'))) {
      assert.ok(!error.message.toLowerCase().includes(entry.toLowerCase()), `echoed ${entry}`);
    }
  };
  refuse(one, /two or three/);
  refuse(`${one},${two},${three},${four}`, /two or three/);
  refuse(`${one},${one}`, /two or three distinct addresses/);
  refuse(`${one},${one.toUpperCase()}`, /two or three distinct addresses/);
  refuse(`${one} ${two} ${one}`, /two or three distinct addresses/);
  refuse(`${one},,${two}`, /separated by commas or spaces/);
  refuse(`${one},${two},`, /separated by commas or spaces/);
  refuse(`${one};${two}`, /entry 1 is not a single plain email address/);
  refuse(`Example Admin <${one}>,${two}`, /entry \d is not a single plain email address/);
  refuse(`<${one}>,${two}`, /entry 1 is not a single plain email address/);
  refuse(`"example"@example.invalid,${two}`, /entry 1 is not a single plain email address/);
  refuse(`${two},example-admin@localhost`, /entry 2 is not a single plain email address/);
  refuse(`${two},example-admin@[192.0.2.1]`, /entry 2 is not a single plain email address/);
  refuse(`${two},example..admin@example.invalid`, /entry 2 is not a single plain email address/);
  refuse(`${two},example-admin@example.invalid.`, /entry 2 is not a single plain email address/);
  refuse(`${two},exämple-admin@example.invalid`, /entry 2 is not a single plain email address/);
  refuse(`${two},${'x'.repeat(65)}@example.invalid`, /entry 2 is not a single plain email address/);
  refuse(`${two},example-admin@${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.invalid`,
    /entry 2 is not a single plain email address \(no display name, at most 254 characters\)/);
});

test('exactly one of PLATFORM_ADMIN_ACCOUNT_IDS, PLATFORM_ADMIN_EMAILS and PLATFORM_ADMIN_ACCOUNT_ID', () => {
  const refuse = (environment, message) => assert.throws(
    () => bootstrapInput({ PLATFORM_ADMIN_BOOTSTRAP_REASON: reason, ...environment }), message, JSON.stringify(environment));
  refuse({ PLATFORM_ADMIN_EMAILS: `${one},${two}`, PLATFORM_ADMIN_ACCOUNT_IDS: `${a},${b}` },
    /^Error: Set PLATFORM_ADMIN_ACCOUNT_IDS or PLATFORM_ADMIN_EMAILS, not both$/);
  refuse({ PLATFORM_ADMIN_EMAILS: `${one},${two}`, PLATFORM_ADMIN_ACCOUNT_ID: a },
    /^Error: Set PLATFORM_ADMIN_EMAILS or PLATFORM_ADMIN_ACCOUNT_ID, not both$/);
  refuse({ PLATFORM_ADMIN_EMAILS: `${one},${two}`, PLATFORM_ADMIN_ACCOUNT_IDS: `${a},${b}`, PLATFORM_ADMIN_ACCOUNT_ID: c },
    /Set only one of PLATFORM_ADMIN_ACCOUNT_IDS, PLATFORM_ADMIN_EMAILS and PLATFORM_ADMIN_ACCOUNT_ID/);
  refuse({}, /PLATFORM_ADMIN_EMAILS \(two or three email addresses\)/);
  refuse({ PLATFORM_ADMIN_EMAILS: '  ' }, /is required/);
  refuse({ PLATFORM_ADMIN_EMAILS: `${one},${two}`, PLATFORM_ADMIN_BOOTSTRAP_REASON: 'short' }, /8 to 500 characters/);
});

// A mistyped address can be replaced only while nobody has used any of the
// accounts the email bootstrap created: an explicit opt-in, for the email form
// alone, and the transaction proves that state before it changes anything.
test('PLATFORM_ADMIN_REPLACE_PENDING=1 is an explicit opt-in of the email form only', () => {
  assert.deepEqual(bootstrapInput({ PLATFORM_ADMIN_EMAILS: `${one},${two}`, PLATFORM_ADMIN_REPLACE_PENDING: '1',
    PLATFORM_ADMIN_BOOTSTRAP_REASON: reason }), { emails: [one, two], reason, replacePending: true });
  assert.deepEqual(bootstrapInput({ PLATFORM_ADMIN_EMAILS: `${one},${two}`, PLATFORM_ADMIN_REPLACE_PENDING: '',
    PLATFORM_ADMIN_BOOTSTRAP_REASON: reason }), { emails: [one, two], reason, replacePending: false });
  for (const value of ['true', 'yes', '0', '2', 'on']) {
    assert.throws(() => bootstrapInput({ PLATFORM_ADMIN_EMAILS: `${one},${two}`, PLATFORM_ADMIN_REPLACE_PENDING: value,
      PLATFORM_ADMIN_BOOTSTRAP_REASON: reason }), /^Error: PLATFORM_ADMIN_REPLACE_PENDING must be 1 or unset$/, value);
  }
  assert.throws(() => bootstrapInput({ PLATFORM_ADMIN_ACCOUNT_IDS: `${a},${b}`, PLATFORM_ADMIN_REPLACE_PENDING: '1',
    PLATFORM_ADMIN_BOOTSTRAP_REASON: reason }), /PLATFORM_ADMIN_REPLACE_PENDING applies only with PLATFORM_ADMIN_EMAILS/);
  assert.throws(() => bootstrapInput({ PLATFORM_ADMIN_ACCOUNT_ID: a, PLATFORM_ADMIN_REPLACE_PENDING: '1',
    PLATFORM_ADMIN_BOOTSTRAP_REASON: reason }), /PLATFORM_ADMIN_REPLACE_PENDING applies only with PLATFORM_ADMIN_EMAILS/);
});

// The check for an existing Super Admin counts every non-deleted account that
// holds an unrevoked platform Super Admin or legacy platform admin assignment,
// whatever its status: an account seeded by email stays pending_reset until
// its owner sets a password, and a rerun must not add more beside it.
test('both forms refuse while any non-deleted account holds a Super Admin assignment, whatever its status', async () => {
  for (const run of [
    (client) => bootstrapPlatformAdmins(client, { accountIds: [a, b], reason }),
    (client) => bootstrapPlatformAdminsByEmail(client, { emails: [one, two], reason, replacePending: false }),
  ]) {
    const client = emailClient({ existing: 0 });
    await run(client);
    const check = client.statements.find((statement) => statement.sql.includes('count(distinct account.id)'));
    assert.ok(check, 'the existing Super Admin check');
    assert.doesNotMatch(check.sql, /account\.status = 'active'/);
    assert.doesNotMatch(check.sql, /disabled_until/);
    assert.match(check.sql, /account\.status <> 'deleted'/);
    assert.match(check.sql, /assignment\.role_code in \('platform_super_admin', 'platform_admin'\)/);
    assert.match(check.sql, /assignment\.scope_type = 'platform' and assignment\.revoked_at is null/);
    const refused = emailClient({ existing: 2 });
    await assert.rejects(run(refused), /Bootstrap refused: a platform Super Admin already exists, in any status but deleted/);
    const sql = refused.statements.map((statement) => statement.sql);
    assert.equal(sql.at(-1), 'rollback');
    assert.ok(!sql.some((text) => text.startsWith('insert ') || text.startsWith('update ')));
  }
});

// A client that answers the email bootstrap's statements and records them.
function emailClient({ existing = 0, inUse = [], replaceable = null } = {}) {
  const statements = [];
  let created = 0;
  return {
    statements,
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      statements.push({ sql: text, params });
      if (/schema_migrations/.test(text)) return { rowCount: 1, rows: [{}] };
      if (/count\(distinct account\.id\)/.test(text)) return { rowCount: 1, rows: [{ count: existing }] };
      if (/from auth\.accounts account where account\.id = any\(\$1::uuid\[\]\)/.test(text)) {
        return { rowCount: params[0].length, rows: params[0].map((id) => ({ id })) };
      }
      if (/as replaceable/.test(text)) {
        const rows = (replaceable ?? []).map(([id, ok]) => ({ id, replaceable: ok }));
        return { rowCount: rows.length, rows };
      }
      if (/as email_in_use/.test(text)) {
        const rows = params[0].filter((email) => inUse.includes(email)).map((email) => ({ email_in_use: email }));
        return { rowCount: rows.length, rows };
      }
      if (text.startsWith('insert into auth.accounts')) {
        created += 1;
        return { rowCount: 1, rows: [{ id: `7a1c2f30-0000-4000-8000-00000000e00${created}` }] };
      }
      if (text.startsWith('update auth.account_roles')) {
        const rows = params[0].map((id) => ({ account_id: id }));
        return { rowCount: rows.length, rows };
      }
      if (text.startsWith("update auth.accounts set status = 'deleted'")) {
        return { rowCount: params[0].length, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
}
const createdId = (n) => `7a1c2f30-0000-4000-8000-00000000e00${n}`;

test('the email form creates platform-only accounts with no password and grants each Super Admin in one transaction', async () => {
  const client = emailClient();
  assert.deepEqual(await bootstrapPlatformAdminsByEmail(client, { emails: [one, two, three], reason, replacePending: false }),
    { accountIds: [createdId(1), createdId(2), createdId(3)], replacedAccountIds: [] });
  const sql = client.statements.map((statement) => statement.sql);
  assert.equal(sql[0], 'begin');
  assert.equal(sql.at(-1), 'commit');
  assert.equal(sql.filter((text) => text === 'begin' || text === 'commit').length, 2);
  const lock = sql.findIndex((text) => text.includes("pg_advisory_xact_lock(hashtextextended('hid-platform-admin-bootstrap', 0))"));
  const existing = sql.findIndex((text) => text.includes('count(distinct account.id)'));
  const inUse = sql.findIndex((text) => text.includes('as email_in_use'));
  const firstAccount = sql.findIndex((text) => text.startsWith('insert into auth.accounts'));
  assert.ok(lock > 0 && lock < existing && existing < inUse && inUse < firstAccount, 'lock, then the checks, then the inserts');
  // 0086: platform recovery (admin reset), the only way these accounts get a password.
  assert.ok(sql.some((text) => text.includes("version = '0086_recovery_and_patient_search_hardening.sql'")));
  const emailCheck = client.statements[inUse];
  assert.deepEqual(emailCheck.params, [[one, two, three]]);
  assert.match(emailCheck.sql, /lower\(account\.email\) = any\(\$1::text\[\]\) and account\.status <> 'deleted'/);
  assert.match(emailCheck.sql, /from identity\.staff staff_row where lower\(staff_row\.email\) = any\(\$1::text\[\]\)/);

  const accounts = client.statements.filter((statement) => statement.sql.startsWith('insert into auth.accounts'));
  assert.deepEqual(accounts.map((statement) => statement.params), [[one], [two], [three]]);
  for (const { sql: text } of accounts) {
    assert.match(text, /^insert into auth\.accounts \(id, subject, email, display_name, status, source_system\) select generated\.id, 'platform:' \|\| generated\.id::text, \$1, null, 'pending_reset', 'hid' from \(select gen_random_uuid\(\) as id\) generated returning id::text$/);
  }
  assert.ok(!sql.some((text) => /password_hash|email_verified_at/.test(text) && text.startsWith('insert')),
    'no password or verified-email claim is written');
  assert.ok(!sql.some((text) => /insert into identity\.(staff|patients|staff_facility_memberships)/.test(text)),
    'no staff, membership or patient record');

  const grants = client.statements.filter((statement) => statement.sql.startsWith('insert into auth.account_roles'));
  assert.deepEqual(grants.map((statement) => statement.params), [createdId(1), createdId(2), createdId(3)].map((id) => [id, reason]));
  for (const grant of grants) assert.match(grant.sql, /'platform_super_admin', 'platform', null, \$2/);
  const audits = client.statements.filter((statement) => statement.sql.startsWith('insert into audit.events'));
  assert.equal(audits.length, 3);
  for (const [index, audit] of audits.entries()) {
    assert.match(audit.sql, /'admin\.platform-role\.bootstrap', 'success'/);
    assert.match(audit.sql, /'method', 'email'/);
    assert.match(audit.sql, /'accountCreated', true/);
    assert.deepEqual(audit.params, [createdId(index + 1), reason, [createdId(1), createdId(2), createdId(3)], []]);
  }
  // No statement text or parameter outside the account checks and inserts carries an address.
  for (const statement of client.statements) {
    if (statement === emailCheck || accounts.includes(statement)) continue;
    assert.ok(![one, two, three].some((email) => JSON.stringify(statement).includes(email)), statement.sql.slice(0, 60));
  }
});

test('the email form refuses an address that already belongs to an account, naming its entry, not its value', async () => {
  const client = emailClient({ inUse: [two] });
  await assert.rejects(bootstrapPlatformAdminsByEmail(client, { emails: [one, two, three], reason, replacePending: false }),
    (error) => {
      assert.match(error.message, /^Bootstrap refused: PLATFORM_ADMIN_EMAILS entry 2 already belongs to an account; name existing accounts in PLATFORM_ADMIN_ACCOUNT_IDS$/);
      assert.ok(!error.message.includes(two));
      return true;
    });
  const sql = client.statements.map((statement) => statement.sql);
  assert.equal(sql.at(-1), 'rollback');
  assert.ok(!sql.some((text) => text.startsWith('insert ') || text.startsWith('update ')));
  const both = emailClient({ inUse: [one, three] });
  await assert.rejects(bootstrapPlatformAdminsByEmail(both, { emails: [one, two, three], reason, replacePending: false }),
    /PLATFORM_ADMIN_EMAILS entries 1, 3 already belong to an account/);
});

test('the email form refuses while a Super Admin exists and says how to replace a pending set', async () => {
  const client = emailClient({ existing: 3 });
  await assert.rejects(bootstrapPlatformAdminsByEmail(client, { emails: [one, two], reason, replacePending: false }),
    /a platform Super Admin already exists, in any status but deleted[^]*PLATFORM_ADMIN_REPLACE_PENDING=1/);
  assert.ok(!client.statements.some((statement) => /as replaceable/.test(statement.sql)));
});

const p1 = '7a1c2f30-0000-4000-8000-0000000000f1';
const p2 = '7a1c2f30-0000-4000-8000-0000000000f2';
const p3 = '7a1c2f30-0000-4000-8000-0000000000f3';

test('replace-pending revokes and deletes an unused email-seeded set, then seeds the new list, all in one transaction', async () => {
  const client = emailClient({ existing: 3, replaceable: [[p1, true], [p2, true], [p3, true]] });
  assert.deepEqual(await bootstrapPlatformAdminsByEmail(client, { emails: [one, two, three], reason, replacePending: true }),
    { accountIds: [createdId(1), createdId(2), createdId(3)], replacedAccountIds: [p1, p2, p3] });
  const sql = client.statements.map((statement) => statement.sql);
  assert.equal(sql[0], 'begin');
  assert.equal(sql.at(-1), 'commit');
  const lock = sql.findIndex((text) => text.includes('pg_advisory_xact_lock'));
  const holders = sql.findIndex((text) => text.includes('as replaceable'));
  const revoke = sql.findIndex((text) => text.startsWith('update auth.account_roles'));
  const remove = sql.findIndex((text) => text.startsWith("update auth.accounts set status = 'deleted'"));
  const inUse = sql.findIndex((text) => text.includes('as email_in_use'));
  const firstAccount = sql.findIndex((text) => text.startsWith('insert into auth.accounts'));
  assert.ok(lock < holders && holders < revoke && revoke < remove && remove < inUse && inUse < firstAccount,
    'lock, prove the pending state, revoke, delete, then the address check and the new accounts');

  // The holders are locked and proven unused and email-seeded in one statement.
  const proof = client.statements[holders].sql;
  for (const condition of [
    /for update of account$/,
    /account\.status <> 'deleted'/,
    /account\.status = 'pending_reset'/,
    /account\.password_hash is null and account\.password_algorithm is null and account\.password_changed_at is null/,
    /account\.subject = 'platform:' \|\| account\.id::text/,
    /not exists \(select 1 from auth\.sessions session_row where session_row\.account_id = account\.id\)/,
    /not exists \(select 1 from auth\.mfa_factors factor where factor\.account_id = account\.id\)/,
    /not exists \(select 1 from auth\.external_identities external_row where external_row\.account_id = account\.id\)/,
    /not exists \(select 1 from identity\.staff staff_row where staff_row\.account_id = account\.id\)/,
    /not exists \(select 1 from identity\.patients patient_row where patient_row\.account_id = account\.id\)/,
    /event\.action = 'admin\.platform-role\.bootstrap' and event\.outcome = 'success'/,
    /event\.source_system = 'platform-admin-bootstrap'/,
    /event\.resource_id = account\.id::text/,
    /event\.details->>'method' = 'email' and event\.details->>'accountCreated' = 'true'/,
  ]) assert.match(proof, condition);

  const revoked = client.statements[revoke];
  assert.match(revoked.sql, /set revoked_at = clock_timestamp\(\), revoked_by = coalesce\(assignment\.granted_by, assignment\.account_id\), revocation_reason = \$2/);
  assert.match(revoked.sql, /where assignment\.account_id = any\(\$1::uuid\[\]\) and assignment\.revoked_at is null/);
  assert.deepEqual(revoked.params, [[p1, p2, p3], reason]);
  const deleted = client.statements[remove];
  assert.match(deleted.sql, /token_version = token_version \+ 1/);
  assert.match(deleted.sql, /and status = 'pending_reset' and password_hash is null/);
  assert.deepEqual(deleted.params, [[p1, p2, p3]]);

  const replacedAudits = client.statements.filter((statement) => statement.sql.startsWith('insert into audit.events')
    && statement.sql.includes("'admin.platform-role.bootstrap.replaced'"));
  assert.deepEqual(replacedAudits.map((statement) => statement.params[0]), [p1, p2, p3]);
  for (const audit of replacedAudits) {
    assert.match(audit.sql, /'accountStatus', 'deleted'/);
    assert.deepEqual(audit.params.slice(1), [reason, [createdId(1), createdId(2), createdId(3)]]);
  }
  const seededAudits = client.statements.filter((statement) => statement.sql.includes("'admin.platform-role.bootstrap', 'success'"));
  for (const audit of seededAudits) assert.deepEqual(audit.params.at(-1), [p1, p2, p3]);
});

test('replace-pending refuses, changing nothing, once any holder is not an unused email-seeded account, or with none', async () => {
  const used = emailClient({ existing: 3, replaceable: [[p1, true], [p2, false], [p3, true]] });
  await assert.rejects(bootstrapPlatformAdminsByEmail(used, { emails: [one, two], reason, replacePending: true }),
    /^Error: Bootstrap refused: PLATFORM_ADMIN_REPLACE_PENDING=1 replaces only Super Admins the email bootstrap created that nobody has used yet \(pending_reset, no password, session, authenticator, staff or patient record\); 1 of 3 is not$/);
  const none = emailClient({ existing: 0 });
  await assert.rejects(bootstrapPlatformAdminsByEmail(none, { emails: [one, two], reason, replacePending: true }),
    /Bootstrap refused: PLATFORM_ADMIN_REPLACE_PENDING=1 but no Super Admin exists to replace/);
  for (const client of [used, none]) {
    const sql = client.statements.map((statement) => statement.sql);
    assert.equal(sql.at(-1), 'rollback');
    assert.ok(!sql.some((text) => text.startsWith('insert ') || text.startsWith('update ')));
  }
});
