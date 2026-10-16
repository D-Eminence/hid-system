import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import {
  COMMANDS, grantVariableConflict, loginFromUrl, masterConnectionUrl, parseCommand, provisionAdministrator,
  provisionRuntimeLogins, revokeVariableConflict, roleNameFromUrl, runtimeLoginPlan, scramVerifier,
  verificationEnvironment,
} from '../../services/ehr-api/scripts/database-login-provisioning.mjs';
import { RUNTIME_CREDENTIALS, credentialVariable } from '../../services/ehr-api/scripts/verify-runtime-logins.mjs';

// Gap 5: a new RDS instance has only its master. The provisioning task
// (hid-<env>-database-provisioning) runs these steps from the secrets mapped
// in its task definition: the master creates the migration administrator and
// grants and revokes SET ON PARAMETER for 0015 (MIGRATION_RUNBOOK.md §6.1),
// and the administrator creates the ten runtime LOGINs with the passwords in
// their secrets and grants each its aggregate (§6.3). Passwords reach
// PostgreSQL only as SCRAM-SHA-256 verifiers computed here, never in a
// statement's text, and no output names a URL or password. Synthetic values.
const password = 'Synthetic-Password-0001';
const host = 'hid-production-postgres.example.invalid';
// Built with URL setters so no credential appears inline (verify-secret-readiness).
const url = (user, secret = password, rest = `${host}:5432/hid`) => {
  const value = new URL(`postgresql://${rest}`);
  value.username = encodeURIComponent(user);
  value.password = encodeURIComponent(secret);
  return value.toString();
};
const adminUrl = url('hid_migration_admin');
const loginNames = Object.fromEntries(Object.keys(RUNTIME_CREDENTIALS)
  .map((credential) => [credential, `hid_${credential.replaceAll('-', '_')}_login`]));
const runtimeEnvironment = () => Object.fromEntries(Object.keys(RUNTIME_CREDENTIALS)
  .map((credential, index) => [credentialVariable(credential),
    url(loginNames[credential], `Synthetic-Runtime-Password-${String(index).padStart(2, '0')}`)]));

test('takes exactly one known command', () => {
  assert.deepEqual(COMMANDS, ['--verify-logins', '--administrator', '--grant-variable-conflict',
    '--revoke-variable-conflict', '--runtime-logins']);
  for (const command of COMMANDS) assert.equal(parseCommand([command]), command);
  for (const argv of [[], ['--administrator', '--runtime-logins'], ['--partial'], ['administrator']]) {
    assert.throws(() => parseCommand(argv), /Usage: provision-database-logins\.mjs/, JSON.stringify(argv));
  }
});

test('reads a login, its password and its database target from a URL', () => {
  assert.deepEqual(loginFromUrl(url('hid_identity_login', 'Synthetic/Pass@word%0001'), 'DATABASE_LOGIN_URL_IDENTITY_API'), {
    user: 'hid_identity_login', password: 'Synthetic/Pass@word%0001', database: 'hid', target: `${host}:5432/hid` });
  assert.deepEqual(loginFromUrl('postgres://hid_admin:example-Synthetic-0001@localhost/hid_x?host=%2Ftmp%2Fsocket&sslmode=disable',
    'DATABASE_ADMIN_URL').target, '/tmp/socket:5432/hid_x');
  assert.equal(roleNameFromUrl(url('hid_migration_admin', 'short'), 'DATABASE_ADMIN_URL'), 'hid_migration_admin');
});

test('refuses a URL it cannot provision safely, without echoing the URL or password', () => {
  const secret = 'Secret-Never-Printed-0001';
  const cases = [
    [`mysql://hid_login:${secret}@${host}/hid`, /must be a postgres:\/\/ or postgresql:\/\/ URL/],
    [url('Hid_Login', secret), /must name a lowercase role/],
    [url('hid-login', secret), /must name a lowercase role/],
    [url('hid_login', 'Short-0001'), /16 to 1024 printable ASCII characters without spaces/],
    [url('hid_login', 'Synthetic Password 0001'), /16 to 1024 printable ASCII characters without spaces/],
    [url('hid_login', 'Synthetic-Pässword-0001'), /16 to 1024 printable ASCII characters without spaces/],
    [url('hid_login', secret, `${host}:5432/`), /must name its database/],
    ...['user', 'password', 'database', 'dbname', 'port', 'options'].map((key) =>
      [`${url('hid_login', secret)}?${key}=other`, new RegExp(`must not set ${key} as a query parameter`)]),
    ['not a url', /is not a valid database URL/],
  ];
  for (const [value, message] of cases) {
    assert.throws(() => loginFromUrl(value, 'DATABASE_LOGIN_URL_LAB_API'), (error) => {
      assert.match(error.message, message, value);
      assert.match(error.message, /^DATABASE_LOGIN_URL_LAB_API /);
      assert.ok(!error.message.includes(secret) && !error.message.includes(host), error.message);
      return true;
    });
  }
  assert.throws(() => loginFromUrl(undefined, 'DATABASE_ADMIN_URL'), /DATABASE_ADMIN_URL is required/);
});

test('computes the SCRAM-SHA-256 verifier PostgreSQL stores (RFC 7677 example)', () => {
  const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
  const verifier = scramVerifier('pencil', { salt, iterations: 4096 });
  const match = /^SCRAM-SHA-256\$4096:W22ZaJ0SNY7soEsUEjb6gQ==\$([A-Za-z0-9+/]{43}=):([A-Za-z0-9+/]{43}=)$/.exec(verifier);
  assert.ok(match, verifier);
  const [storedKey, serverKey] = [Buffer.from(match[1], 'base64'), Buffer.from(match[2], 'base64')];
  const nonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
  const authMessage = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=${nonce}`;
  // The server's signature and the client's proof of RFC 7677 §3.
  assert.equal(createHmac('sha256', serverKey).update(authMessage).digest('base64'),
    '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
  const signature = createHmac('sha256', storedKey).update(authMessage).digest();
  const clientKey = Buffer.from(Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64')
    .map((byte, index) => byte ^ signature[index]));
  assert.deepEqual(createHash('sha256').update(clientKey).digest(), storedKey);
  assert.notEqual(scramVerifier(password), scramVerifier(password), 'each verifier has its own random salt');
  assert.match(scramVerifier(password), /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$/);
  assert.throws(() => scramVerifier('pässword-not-ascii'), /printable ASCII/);
});

test('connects as the RDS master to the administrator\'s database', () => {
  const master = masterConnectionUrl(`${adminUrl}?sslmode=verify-full`,
    { DATABASE_MASTER_USERNAME: 'hid_platform_bootstrap', DATABASE_MASTER_PASSWORD: 'p@ss/w%rd' });
  assert.equal(master.user, 'hid_platform_bootstrap');
  const parsed = new URL(master.url);
  assert.deepEqual([decodeURIComponent(parsed.username), decodeURIComponent(parsed.password), parsed.host,
    parsed.pathname, parsed.search], ['hid_platform_bootstrap', 'p@ss/w%rd', `${host}:5432`, '/hid', '?sslmode=verify-full']);
  assert.throws(() => masterConnectionUrl(adminUrl, { DATABASE_MASTER_PASSWORD: 'x' }), /DATABASE_MASTER_USERNAME/);
  assert.throws(() => masterConnectionUrl(adminUrl, { DATABASE_MASTER_USERNAME: 'Bad Name', DATABASE_MASTER_PASSWORD: 'x' }),
    /DATABASE_MASTER_USERNAME/);
  assert.throws(() => masterConnectionUrl(adminUrl, { DATABASE_MASTER_USERNAME: 'hid_platform_bootstrap' }),
    /DATABASE_MASTER_PASSWORD is required/);
});

test('plans exactly one distinct LOGIN per runtime credential on the administrator\'s database', () => {
  const administrator = loginFromUrl(adminUrl, 'DATABASE_ADMIN_URL');
  const plan = runtimeLoginPlan(runtimeEnvironment(), administrator, 'hid_platform_bootstrap');
  assert.deepEqual(plan.map(({ credential, role, user }) => [credential, role, user]),
    Object.entries(RUNTIME_CREDENTIALS).map(([credential, role]) => [credential, role, loginNames[credential]]));
  const refuse = (change, message) => {
    const environment = runtimeEnvironment();
    change(environment);
    assert.throws(() => runtimeLoginPlan(environment, administrator, 'hid_platform_bootstrap'), message);
  };
  refuse((environment) => { delete environment.DATABASE_LOGIN_URL_OCR_WORKER; },
    /Runtime credential URLs are missing: DATABASE_LOGIN_URL_OCR_WORKER/);
  refuse((environment) => { environment.DATABASE_LOGIN_URL_LAB_API = url(loginNames['identity-api']); },
    /DATABASE_LOGIN_URL_LAB_API and DATABASE_LOGIN_URL_IDENTITY_API share the LOGIN hid_identity_api_login/);
  refuse((environment) => { environment.DATABASE_LOGIN_URL_EHR_API = url('hid_migration_admin'); },
    /DATABASE_LOGIN_URL_EHR_API names the migration administrator or the RDS master/);
  refuse((environment) => { environment.DATABASE_LOGIN_URL_EHR_API = url('hid_platform_bootstrap'); },
    /DATABASE_LOGIN_URL_EHR_API names the migration administrator or the RDS master/);
  refuse((environment) => { environment.DATABASE_LOGIN_URL_EHR_API = url('hid_ehr_api_runtime'); },
    /DATABASE_LOGIN_URL_EHR_API names a HID group role/);
  for (const rest of [`${host}:5432/other`, `other.example.invalid:5432/hid`, `${host}:5433/hid`]) {
    refuse((environment) => { environment.DATABASE_LOGIN_URL_PHARMACY_API = url(loginNames['pharmacy-api'], password, rest); },
      /DATABASE_LOGIN_URL_PHARMACY_API must point to the migration administrator's database/);
  }
});

test('verification forbids the RDS master and the migration administrator', () => {
  const environment = verificationEnvironment({ DATABASE_LOGIN_URL_LAB_API: 'x', DATABASE_FORBIDDEN_LOGINS: 'other' },
    'hid_platform_bootstrap', 'hid_migration_admin');
  assert.equal(environment.DATABASE_FORBIDDEN_LOGINS, 'hid_platform_bootstrap,hid_migration_admin');
  assert.equal(environment.DATABASE_LOGIN_URL_LAB_API, 'x');
});

// A client that answers the provisioning statements from a role catalogue.
function fakeClient({ roles = {}, memberships = {}, ledger = null, parameterPrivilege = [false], createPrivilege = true } = {}) {
  const statements = [];
  const privileges = [...parameterPrivilege];
  return {
    statements,
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      statements.push({ sql: text, params });
      if (text.startsWith('select rolcanlogin')) {
        const row = roles[params[0]];
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (text.includes('has_database_privilege')) return { rowCount: 1, rows: [{ allowed: createPrivilege }] };
      if (text.includes('has_parameter_privilege')) return { rowCount: 1, rows: [{ allowed: privileges.shift() ?? false }] };
      if (text.includes('to_regclass')) return { rowCount: 1, rows: [{ present: ledger !== null }] };
      if (text.includes('from migration.schema_migrations')) return { rowCount: 1, rows: [ledger] };
      if (text.includes('pg_auth_members') && text.includes('$1')) {
        const granted = (memberships[params[0]] ?? []).map((role) => ({ role }));
        return { rowCount: granted.length, rows: granted };
      }
      if (text.includes('pg_auth_members')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
  };
}

const runtimeAttributes = { rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreaterole: false,
  rolcreatedb: false, rolreplication: false, rolinherit: true };
const adminAttributes = { ...runtimeAttributes, rolcreaterole: true };
const sqlOf = (client) => client.statements.map((statement) => statement.sql);
const noPlaintext = (client, secrets) => {
  for (const { sql, params } of client.statements) {
    for (const secret of secrets) {
      assert.ok(!sql.includes(secret) && !JSON.stringify(params).includes(secret), 'a password reached a statement');
    }
  }
};

test('the master creates the migration administrator with a SCRAM verifier and CREATE on its database', async () => {
  const administrator = loginFromUrl(adminUrl, 'DATABASE_ADMIN_URL');
  const client = fakeClient();
  const result = await provisionAdministrator(client, administrator, 'hid_platform_bootstrap');
  assert.equal(result.administrator, 'hid_migration_admin');
  assert.equal(result.created, true);
  const sql = sqlOf(client);
  assert.equal(sql[0], 'begin');
  assert.equal(sql.at(-1), 'commit');
  assert.ok(sql.some((text) => text.includes('pg_advisory_xact_lock')));
  const create = sql.find((text) => text.startsWith('create role'));
  assert.match(create, /^create role "hid_migration_admin" login nosuperuser nobypassrls createrole nocreatedb noreplication inherit password 'SCRAM-SHA-256\$4096:[^']+'$/);
  assert.ok(sql.includes('grant create on database "hid" to "hid_migration_admin"'));
  assert.ok(sql.findIndex((text) => text.includes('has_database_privilege')) > sql.indexOf('grant create on database "hid" to "hid_migration_admin"'));
  noPlaintext(client, [password]);
});

test('an existing administrator keeps its attributes and gets the secret\'s password; other attributes are refused', async () => {
  const administrator = loginFromUrl(adminUrl, 'DATABASE_ADMIN_URL');
  const existing = fakeClient({ roles: { hid_migration_admin: adminAttributes } });
  assert.equal((await provisionAdministrator(existing, administrator, 'hid_platform_bootstrap')).created, false);
  assert.ok(sqlOf(existing).some((text) => /^alter role "hid_migration_admin" with password 'SCRAM-SHA-256\$/.test(text)));
  assert.ok(!sqlOf(existing).some((text) => text.startsWith('create role')));
  for (const attribute of ['rolbypassrls', 'rolsuper', 'rolreplication', 'rolcreatedb']) {
    const wrong = fakeClient({ roles: { hid_migration_admin: { ...adminAttributes, [attribute]: true } } });
    await assert.rejects(provisionAdministrator(wrong, administrator, 'hid_platform_bootstrap'),
      /Role hid_migration_admin exists with other attributes/);
    assert.equal(sqlOf(wrong).at(-1), 'rollback');
    assert.ok(!sqlOf(wrong).some((text) => /^(create|alter|grant) /.test(text)), attribute);
  }
  const unmet = fakeClient({ createPrivilege: false });
  await assert.rejects(provisionAdministrator(unmet, administrator, 'hid_platform_bootstrap'), /CREATE on database hid/);
  assert.equal(sqlOf(unmet).at(-1), 'rollback');
  await assert.rejects(provisionAdministrator(fakeClient(), administrator, 'hid_migration_admin'),
    /The migration administrator must not be the RDS master/);
});

test('the 0015 parameter grant is made only before 0015 and checked; its revoke is checked', async () => {
  const administrator = loginFromUrl(adminUrl, 'DATABASE_ADMIN_URL');
  const fresh = { master: fakeClient({ parameterPrivilege: [true] }), admin: fakeClient() };
  const granted = await grantVariableConflict(fresh.master, fresh.admin, administrator);
  assert.equal(granted.granted, true);
  assert.ok(sqlOf(fresh.master).includes('grant set on parameter plpgsql.variable_conflict to "hid_migration_admin"'));
  const applied = { master: fakeClient(), admin: fakeClient({ ledger: { applied: 96, latest: '0096_x.sql',
    applied_0015: true, applied_0083: true } }) };
  const skipped = await grantVariableConflict(applied.master, applied.admin, administrator);
  assert.equal(skipped.granted, false);
  assert.match(skipped.reason, /0015 is applied/);
  assert.ok(!sqlOf(applied.master).some((text) => text.startsWith('grant')));
  await assert.rejects(grantVariableConflict(fakeClient({ parameterPrivilege: [false] }), fakeClient(), administrator),
    /still lacks SET on plpgsql\.variable_conflict/);

  const revoke = fakeClient({ parameterPrivilege: [false] });
  assert.equal((await revokeVariableConflict(revoke, fakeClient(), administrator)).revoked, true);
  assert.ok(sqlOf(revoke).includes('revoke set on parameter plpgsql.variable_conflict from "hid_migration_admin"'));
  await assert.rejects(revokeVariableConflict(fakeClient({ parameterPrivilege: [true] }), fakeClient(), administrator),
    /still holds SET on plpgsql\.variable_conflict/);
});

test('the administrator creates or updates each runtime LOGIN and grants exactly its aggregate, all or none', async () => {
  const administrator = loginFromUrl(adminUrl, 'DATABASE_ADMIN_URL');
  const environment = runtimeEnvironment();
  const plan = runtimeLoginPlan(environment, administrator, 'hid_platform_bootstrap');
  const client = fakeClient({ roles: { [loginNames['lab-api']]: runtimeAttributes } });
  const results = await provisionRuntimeLogins(client, plan);
  assert.deepEqual(results.map(({ credential, login, role, created }) => [credential, login, role, created]),
    plan.map(({ credential, user, role }) => [credential, user, role, credential !== 'lab-api']));
  const sql = sqlOf(client);
  assert.equal(sql[0], 'begin');
  assert.equal(sql.at(-1), 'commit');
  for (const { credential, user, role } of plan) {
    const statement = credential === 'lab-api'
      ? new RegExp(`^alter role "${user}" with password 'SCRAM-SHA-256\\$4096:[^']+'$`)
      : new RegExp(`^create role "${user}" login nosuperuser nobypassrls nocreatedb nocreaterole noreplication inherit password 'SCRAM-SHA-256\\$4096:[^']+'$`);
    assert.ok(sql.some((text) => statement.test(text)), credential);
    assert.ok(sql.includes(`grant "${role}" to "${user}"`), credential);
  }
  assert.equal(sql.filter((text) => text.startsWith('grant ')).length, 10);
  noPlaintext(client, plan.map((login) => login.password));

  for (const attributes of [{ ...runtimeAttributes, rolcanlogin: false }, { ...runtimeAttributes, rolbypassrls: true },
    { ...runtimeAttributes, rolcreaterole: true }, { ...runtimeAttributes, rolinherit: false }]) {
    const refused = fakeClient({ roles: { [loginNames['outreach-api']]: attributes } });
    await assert.rejects(provisionRuntimeLogins(refused, plan),
      /DATABASE_LOGIN_URL_OUTREACH_API: role hid_outreach_api_login exists with other attributes/);
    assert.equal(sqlOf(refused).at(-1), 'rollback');
    assert.ok(!sqlOf(refused).includes('commit'));
  }
});

// An existing LOGIN that already reaches another role (the administrator, an
// owner, another aggregate) is refused before its password is set, so the
// service's secret never signs in to a role with more than its aggregate.
test('an existing runtime LOGIN that is a member of another role is refused before any change', async () => {
  const administrator = loginFromUrl(adminUrl, 'DATABASE_ADMIN_URL');
  const plan = runtimeLoginPlan(runtimeEnvironment(), administrator, 'hid_platform_bootstrap');
  const login = loginNames['event-dispatcher'];
  const own = fakeClient({ roles: { [login]: runtimeAttributes }, memberships: { [login]: ['hid_event_dispatcher'] } });
  await provisionRuntimeLogins(own, plan);
  assert.equal(sqlOf(own).at(-1), 'commit');
  for (const other of [['hid_migration_admin'], ['hid_event_dispatcher', 'hid_ocr_worker']]) {
    const refused = fakeClient({ roles: { [login]: runtimeAttributes }, memberships: { [login]: other } });
    await assert.rejects(provisionRuntimeLogins(refused, plan),
      /DATABASE_LOGIN_URL_EVENT_DISPATCHER: role hid_event_dispatcher_login is already a member of hid_/);
    assert.equal(sqlOf(refused).at(-1), 'rollback');
    assert.ok(!sqlOf(refused).some((text) => text.startsWith(`alter role "${login}"`)));
  }
});
