// Database provisioning for a new RDS instance (MIGRATION_RUNBOOK.md §6.1 and
// §6.3), as a module so its rules and statements can be tested without a
// database. provision-database-logins.mjs runs it in the one-shot
// provisioning task, which maps only the RDS master's username and password,
// the migration administrator's URL and the ten runtime credentials' URLs.
//
// - The RDS master creates the migration administrator (LOGIN NOSUPERUSER
//   NOBYPASSRLS CREATEROLE NOCREATEDB NOREPLICATION INHERIT) with the password
//   in its URL and grants it CREATE on the database, and grants and revokes
//   SET ON PARAMETER plpgsql.variable_conflict around the run that applies
//   0015.
// - The migration administrator, which alone holds ADMIN OPTION on the HID
//   roles, creates one LOGIN per runtime credential with the password in its
//   URL (LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION
//   INHERIT) and grants it its aggregate role; db:verify-logins then checks
//   each over its own connection.
//
// A password reaches PostgreSQL only as a SCRAM-SHA-256 verifier computed
// here, never in a statement's text, so a statement log or pg_stat_activity
// shows no password. An existing role keeps its attributes: if they differ,
// or an existing runtime LOGIN is a member of any role but its aggregate, the
// run refuses and changes nothing. Neither the administrator nor a runtime
// LOGIN may carry the name of a HID group role. Every message names roles and
// variables only, never a URL or password.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { RUNTIME_CREDENTIALS, credentialVariable } from './verify-runtime-logins.mjs';

export const COMMANDS = Object.freeze(['--verify-logins', '--administrator', '--grant-variable-conflict',
  '--revoke-variable-conflict', '--runtime-logins']);

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const PASSWORD = /^[\x21-\x7e]{16,1024}$/;
// Query parameters that would make node-postgres connect as another role, to
// another database or with other session options than the URL's own parts.
const OVERRIDING_PARAMETERS = ['user', 'password', 'database', 'dbname', 'port', 'options'];
// The NOLOGIN group roles the role bootstrap (database/runtime-grants.sql)
// creates; a test keeps this list equal to its `create role` statements. The
// bootstrap skips a role that already exists and then requires ADMIN OPTION
// on it, which in PostgreSQL 16 no role holds on itself, so a LOGIN of one of
// these names, above all the migration administrator, would stop it after the
// whole chain had been migrated.
export const HID_GROUP_ROLES = Object.freeze([
  'hid_identity_runtime', 'hid_ehr_runtime', 'hid_api_runtime', 'hid_identity_api_runtime', 'hid_ehr_api_runtime',
  'hid_ocr_api_runtime', 'hid_audit_writer', 'hid_document_scanner', 'hid_ocr_runtime', 'hid_ocr_worker',
  'hid_lab_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_runtime', 'hid_pharmacy_api_runtime', 'hid_outreach_runtime',
  'hid_outreach_api_runtime', 'hid_migration_admin', 'hid_schema_test_runtime', 'hid_event_delivery_commands',
  'hid_ocr_queue_metrics', 'hid_platform_control_reader', 'hid_event_dispatcher', 'hid_notification_runtime',
  'hid_notification_api_runtime', 'hid_notification_worker',
]);
const GROUP_ROLES = new Set(HID_GROUP_ROLES);
const ADMINISTRATOR_ATTRIBUTES = Object.freeze({ rolcanlogin: true, rolsuper: false, rolbypassrls: false,
  rolcreaterole: true, rolcreatedb: false, rolreplication: false, rolinherit: true });
const RUNTIME_ATTRIBUTES = Object.freeze({ ...ADMINISTRATOR_ATTRIBUTES, rolcreaterole: false });

/** The one command of a run. */
export function parseCommand(argv) {
  if (argv.length !== 1 || !COMMANDS.includes(argv[0])) {
    throw new Error(`Usage: provision-database-logins.mjs ${COMMANDS.join(' | ')}`);
  }
  return argv[0];
}

function parseUrl(value, label) {
  if (!value) throw new Error(`${label} is required`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid database URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`${label} must be a postgres:// or postgresql:// URL`);
  }
  for (const key of url.searchParams.keys()) {
    if (OVERRIDING_PARAMETERS.includes(key)) throw new Error(`${label} must not set ${key} as a query parameter`);
  }
  try {
    return { url, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.replace(/^\//, '')) };
  } catch {
    throw new Error(`${label} is not a valid database URL`);
  }
}

/** The role a URL signs in as, without the password rules (verification only). */
export function roleNameFromUrl(value, label) {
  const { user } = parseUrl(value, label);
  if (!ROLE_NAME.test(user)) throw new Error(`${label} must name a lowercase role (letters, digits and _, at most 63)`);
  return user;
}

/** A LOGIN to provision: its name, password and database target. */
export function loginFromUrl(value, label) {
  const { url, user, password, database } = parseUrl(value, label);
  if (!ROLE_NAME.test(user)) throw new Error(`${label} must name a lowercase role (letters, digits and _, at most 63)`);
  if (!PASSWORD.test(password)) {
    throw new Error(`${label} must carry a password of 16 to 1024 printable ASCII characters without spaces`);
  }
  if (!DATABASE_NAME.test(database)) throw new Error(`${label} must name its database`);
  const host = (url.searchParams.get('host') ?? url.hostname).toLowerCase();
  return { user, password, database, target: `${host}:${url.port || '5432'}/${database}` };
}

function refuseGroupRoleAdministrator(user) {
  if (GROUP_ROLES.has(user)) {
    throw new Error(`DATABASE_ADMIN_URL names the HID group role ${user}; the role bootstrap creates that role and `
      + 'cannot run as it, so name the migration administrator otherwise');
  }
}

/** The migration administrator of DATABASE_ADMIN_URL: a LOGIN to provision, never a HID group role. */
export function administratorFromUrl(value) {
  const administrator = loginFromUrl(value, 'DATABASE_ADMIN_URL');
  refuseGroupRoleAdministrator(administrator.user);
  return administrator;
}

/**
 * The SCRAM-SHA-256 verifier PostgreSQL stores for a password (RFC 5802,
 * RFC 7677). PostgreSQL applies SASLprep first, which leaves a printable
 * ASCII password unchanged; any other password is refused.
 */
export function scramVerifier(password, { salt = randomBytes(16), iterations = 4096 } = {}) {
  if (typeof password !== 'string' || !PRINTABLE_ASCII.test(password)) {
    throw new Error('A provisioned password must be printable ASCII');
  }
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:`
    + serverKey.toString('base64');
}

/** The RDS master's connection: the administrator's URL with the master's credentials. */
export function masterConnectionUrl(adminUrl, environment) {
  const user = environment.DATABASE_MASTER_USERNAME?.trim();
  if (!user || !ROLE_NAME.test(user)) throw new Error('DATABASE_MASTER_USERNAME must name the RDS master role');
  if (!environment.DATABASE_MASTER_PASSWORD) throw new Error('DATABASE_MASTER_PASSWORD is required');
  const { url } = parseUrl(adminUrl, 'DATABASE_ADMIN_URL');
  url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(environment.DATABASE_MASTER_PASSWORD);
  return { url: url.toString(), user };
}

/** The ten runtime LOGINs, in db:verify-logins order, each distinct and on the administrator's database. */
export function runtimeLoginPlan(environment, administrator, masterUser) {
  const plan = [];
  const missing = [];
  for (const [credential, role] of Object.entries(RUNTIME_CREDENTIALS)) {
    const variable = credentialVariable(credential);
    if (!environment[variable]) missing.push(variable);
    else plan.push({ credential, role, variable, ...loginFromUrl(environment[variable], variable) });
  }
  if (missing.length > 0) throw new Error(`Runtime credential URLs are missing: ${missing.join(', ')}`);
  const users = new Map();
  for (const login of plan) {
    if (login.target !== administrator.target) {
      throw new Error(`${login.variable} must point to the migration administrator's database`);
    }
    if (login.user === administrator.user || login.user === masterUser) {
      throw new Error(`${login.variable} names the migration administrator or the RDS master`);
    }
    if (GROUP_ROLES.has(login.user)) throw new Error(`${login.variable} names a HID group role`);
    if (users.has(login.user)) {
      throw new Error(`${login.variable} and ${users.get(login.user)} share the LOGIN ${login.user}`);
    }
    users.set(login.user, login.variable);
  }
  return plan;
}

/** db:verify-logins' environment: the master and the administrator are forbidden logins. */
export function verificationEnvironment(environment, masterUser, administratorUser) {
  return { ...environment, DATABASE_FORBIDDEN_LOGINS: [masterUser, administratorUser].join(',') };
}

const identifier = (name) => {
  if (!ROLE_NAME.test(name) && !DATABASE_NAME.test(name)) throw new Error('Refusing an unexpected identifier');
  return `"${name}"`;
};
const literal = (value) => `'${value.replaceAll("'", "''")}'`;

async function roleAttributes(client, name) {
  const { rows } = await client.query(`select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
      rolreplication, rolinherit from pg_roles where rolname = $1`, [name]);
  return rows[0] ?? null;
}

const matches = (row, expected) => Object.entries(expected).every(([key, value]) => row[key] === value);

async function inTransaction(client, work) {
  await client.query('begin');
  try {
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '60s'");
    await client.query("select pg_advisory_xact_lock(hashtextextended('hid-database-login-provisioning', 0))");
    const result = await work();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

/** The migration ledger as the administrator reads it; empty before 0001. */
export async function ledgerState(admin) {
  const { rows: [presence] } = await admin.query(
    "select to_regclass('migration.schema_migrations') is not null as present");
  if (!presence?.present) return { applied: 0, latest: null, applied_0015: false, applied_0083: false };
  const { rows: [row] } = await admin.query(`select count(*)::integer as applied, max(version) as latest,
      coalesce(bool_or(left(version, 5) = '0015_'), false) as applied_0015,
      coalesce(bool_or(left(version, 5) = '0083_'), false) as applied_0083
    from migration.schema_migrations`);
  return row;
}

/**
 * As the RDS master: creates the migration administrator, or sets the
 * password of an existing one whose attributes match, and grants it CREATE
 * on the database. Records the I3 probe (the master's and the
 * administrator's attributes and the master's memberships).
 */
export async function provisionAdministrator(master, administrator, masterUser) {
  refuseGroupRoleAdministrator(administrator.user);
  if (administrator.user === masterUser) throw new Error('The migration administrator must not be the RDS master');
  return inTransaction(master, async () => {
    const existing = await roleAttributes(master, administrator.user);
    const verifier = literal(scramVerifier(administrator.password));
    if (!existing) {
      await master.query(`create role ${identifier(administrator.user)} login nosuperuser nobypassrls createrole `
        + `nocreatedb noreplication inherit password ${verifier}`);
    } else if (!matches(existing, ADMINISTRATOR_ATTRIBUTES)) {
      throw new Error(`Role ${administrator.user} exists with other attributes than LOGIN NOSUPERUSER NOBYPASSRLS `
        + 'CREATEROLE NOCREATEDB NOREPLICATION INHERIT; correct it by hand');
    } else {
      await master.query(`alter role ${identifier(administrator.user)} with password ${verifier}`);
    }
    await master.query(`grant create on database ${identifier(administrator.database)} to ${identifier(administrator.user)}`);
    const { rows: [privilege] } = await master.query(
      "select has_database_privilege($1, $2, 'CREATE') as allowed", [administrator.user, administrator.database]);
    if (!privilege?.allowed) throw new Error(`${administrator.user} still lacks CREATE on database ${administrator.database}`);
    const { rows: probe } = await master.query(`select rolname as role, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
      from pg_roles where rolname in (current_user, $1) order by rolname`, [administrator.user]);
    const { rows: memberships } = await master.query(`select granted.rolname as role, membership.admin_option,
        membership.inherit_option, membership.set_option
      from pg_auth_members membership join pg_roles granted on granted.oid = membership.roleid
      where membership.member = (select oid from pg_roles where rolname = current_user) order by 1`);
    return { administrator: administrator.user, created: !existing, password: 'set from DATABASE_ADMIN_URL',
      create_on_database: administrator.database, i3_probe: { roles: probe, master_memberships: memberships } };
  });
}

async function parameterPrivilege(master, user) {
  const { rows: [row] } = await master.query(
    "select has_parameter_privilege($1, 'plpgsql.variable_conflict', 'SET') as allowed", [user]);
  return row?.allowed === true;
}

/** As the RDS master, before a run that applies 0015: the temporary grant (§6.1). */
export async function grantVariableConflict(master, admin, administrator) {
  const ledger = await ledgerState(admin);
  if (ledger.applied_0015) {
    return { granted: false, reason: '0015 is applied; no grant is needed', ledger };
  }
  await master.query(`grant set on parameter plpgsql.variable_conflict to ${identifier(administrator.user)}`);
  if (!await parameterPrivilege(master, administrator.user)) {
    throw new Error(`${administrator.user} still lacks SET on plpgsql.variable_conflict`);
  }
  return { granted: true, ledger };
}

/** As the RDS master, once 0083 is applied: the revoke and its check (§6.1). */
export async function revokeVariableConflict(master, admin, administrator) {
  await master.query(`revoke set on parameter plpgsql.variable_conflict from ${identifier(administrator.user)}`);
  if (await parameterPrivilege(master, administrator.user)) {
    throw new Error(`${administrator.user} still holds SET on plpgsql.variable_conflict`);
  }
  return { revoked: true, ledger: await ledgerState(admin) };
}

/**
 * As the migration administrator: one LOGIN per runtime credential with the
 * password in its URL, granted its aggregate role, all or none (§6.3).
 */
export async function provisionRuntimeLogins(admin, plan) {
  return inTransaction(admin, async () => {
    const results = [];
    for (const login of plan) {
      const existing = await roleAttributes(admin, login.user);
      if (existing && !matches(existing, RUNTIME_ATTRIBUTES)) {
        throw new Error(`${login.variable}: role ${login.user} exists with other attributes than LOGIN NOSUPERUSER `
          + 'NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT');
      }
      if (existing) {
        // Its password is set only while it reaches nothing but its aggregate.
        const { rows } = await admin.query(`select granted.rolname as role from pg_auth_members membership
          join pg_roles granted on granted.oid = membership.roleid
          where membership.member = (select oid from pg_roles where rolname = $1) order by 1`, [login.user]);
        const other = rows.map((row) => row.role).filter((role) => role !== login.role);
        if (other.length > 0) {
          throw new Error(`${login.variable}: role ${login.user} is already a member of ${other.join(', ')}; `
            + 'revoke that membership by hand');
        }
      }
      const verifier = literal(scramVerifier(login.password));
      if (existing) {
        await admin.query(`alter role ${identifier(login.user)} with password ${verifier}`);
      } else {
        await admin.query(`create role ${identifier(login.user)} login nosuperuser nobypassrls nocreatedb nocreaterole `
          + `noreplication inherit password ${verifier}`);
      }
      await admin.query(`grant ${identifier(login.role)} to ${identifier(login.user)}`);
      results.push({ credential: login.credential, login: login.user, role: login.role, created: !existing });
    }
    return results;
  });
}
