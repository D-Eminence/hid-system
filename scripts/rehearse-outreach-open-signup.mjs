#!/usr/bin/env node
// Launch rehearsal: open sign-up on outreach. (migrations 0115 and 0116, the
// Identity and Outreach services of this commit, and the website routes of
// health#221). Rerun it from the released commit in the hour after release.
//
// It never touches staging or production. It builds a throwaway database on a
// disposable local PostgreSQL 16, in production's shape: every migration of
// this commit applied by a migration login that is neither a superuser nor
// BYPASSRLS, then runtime-grants.sql and the runtime-roles checks run by the
// security administrator, with FORCE row-level security lifted on
// platform.control_settings as it is in production. Then it runs the real
// services against it: Identity
// as hid_identity_api_runtime and Outreach as hid_outreach_api_runtime, under
// the session each service sets. Only the gateways to the outside are mocked:
// emails go to a mailbox in this process (the code and the invitation link are
// read from it), and nothing calls Turnstile, an email or SMS provider, or the
// network. The invitation email is rendered with notification-api's own
// template, to check what it would say. All people, groups and numbers are
// made up.
//
// What it rehearses, each step printed as one PASS or FAIL line:
//   0. the switch outreach_organiser_signup_enabled as the release seeds it
//      (OFF): every sign-up step is refused, nothing is created, no email
//      goes, so no group exists to run a campaign, invite or register;
//   1. operations turns the switch ON with the admin control command (Admin, Controls);
//   2. an organiser signs up, verifies the email with the code and activates;
//   3. a refused group name ("General Hospital", in any case);
//   4. the organiser creates a campaign, opens it and invites a volunteer;
//   5. the volunteer accepts by the link, is added to the campaign and
//      registers two fictional people with consent (an adult, and a child with
//      a guardian);
//   6. support finds a registration by temporary ID and by phone, deletes one
//      person's details at their request, and a second delete is refused;
//   7. operations turns the switch OFF again: a new sign-up, "Start an outreach
//      group", and a sign-up already in progress (verify, resend, activate)
//      are all refused.
//
// Usage (HID_REHEARSAL_ADMIN_URL: a superuser of a disposable local
// PostgreSQL 16 with pgvector, on 127.0.0.1, ::1 or localhost; for example
//   docker run --rm -d -p 127.0.0.1:55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust pgvector/pgvector:pg16):
//   npm ci --prefix services/ehr-api && npm ci --prefix services/identity-api && npm ci --prefix services/outreach-api
//   HID_REHEARSAL_ADMIN_URL=postgresql://postgres@127.0.0.1:55432/postgres node scripts/rehearse-outreach-open-signup.mjs
// The database and the migration login it makes are dropped at the end
// (HID_REHEARSAL_KEEP=1 keeps them). Exit code 0 only when every line is PASS.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '..');
const identityRoot = join(repository, 'services/identity-api');
const outreachRoot = join(repository, 'services/outreach-api');
const ehrRoot = join(repository, 'services/ehr-api');
const notificationRoot = join(repository, 'services/notification-api');
const requireIdentity = createRequire(join(identityRoot, 'package.json'));
const requireOutreach = createRequire(join(outreachRoot, 'package.json'));
const { Pool } = requireIdentity('pg');

const adminUrl = process.env.HID_REHEARSAL_ADMIN_URL ?? '';
const keep = process.env.HID_REHEARSAL_KEEP === '1';
let admin;
try { admin = new URL(adminUrl); } catch { admin = null; }
if (!admin || !['postgres:', 'postgresql:'].includes(admin.protocol)
  || !['127.0.0.1', '[::1]', 'localhost'].includes(admin.hostname)) {
  process.stderr.write('HID_REHEARSAL_ADMIN_URL must name a superuser of a disposable PostgreSQL 16 on this machine '
    + '(127.0.0.1, ::1 or localhost). This rehearsal never connects anywhere else.\n');
  process.exit(2);
}
const runId = randomBytes(6).toString('hex');
const database = `hid_rehearsal_${runId}_signup`;
const migrator = `hid_rehearsal_migrator_${runId}`;
const migratorPassword = randomBytes(24).toString('hex');
const urlFor = (user, password, db, role) => {
  const url = new URL(adminUrl);
  url.username = encodeURIComponent(user);
  url.password = password ? encodeURIComponent(password) : '';
  url.pathname = `/${db}`;
  url.search = role ? `?options=${encodeURIComponent(`-c role=${role}`)}` : '';
  return url.href;
};
const adminUser = decodeURIComponent(admin.username || 'postgres');
const adminPassword = decodeURIComponent(admin.password);
const serviceUrl = (role) => urlFor(adminUser, adminPassword, database, role);

// ------------------------------------------------------------------ output --
let passed = 0;
let failed = 0;
const say = (line) => process.stdout.write(`${line}\n`);
async function step(name, work) {
  try {
    await work();
    passed += 1;
    say(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    const detail = [error?.status, error?.code, error?.message ?? String(error)].filter((part) => part !== undefined && part !== '')
      .join(' ').replace(/\s+/g, ' ').slice(0, 300);
    say(`FAIL  ${name}\n      ${detail}`);
  }
}
/** The promise must be refused with each of the expected fields (status, code). */
async function refused(promise, expected) {
  let outcome;
  try { outcome = await promise; } catch (error) {
    for (const [key, value] of Object.entries(expected)) {
      if (error?.[key] !== value) {
        throw Object.assign(new Error(`refused, but with ${error?.status ?? ''} ${error?.code ?? ''}: ${error?.message ?? error}`),
          { code: 'UNEXPECTED_REFUSAL' });
      }
    }
    return;
  }
  throw Object.assign(new Error(`it was allowed: ${JSON.stringify(outcome)?.slice(0, 200)}`), { code: 'NOT_REFUSED' });
}
const CLOSED = { status: 423, code: 'OUTREACH_ORGANISER_SIGNUP_UNAVAILABLE' };
/**
 * A request body as the service's route receives it: the route's DTO, transformed and validated with the options of
 * the service's global ValidationPipe (main.ts), so phone numbers, names and emails are normalised as on the live route.
 */
function requestBodies(requireService, root) {
  const { plainToInstance } = requireService('class-transformer');
  const { validateSync } = requireService('class-validator');
  return (file, name, plain) => {
    const Dto = requireService(join(root, 'src', file))[name];
    assert.equal(typeof Dto, 'function', `${name} is not exported by ${file}`);
    const body = plainToInstance(Dto, plain, { enableImplicitConversion: false });
    const errors = validateSync(body, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
    if (errors.length) {
      throw Object.assign(new Error(`One or more request fields are invalid: ${errors.map((error) => error.property).join(', ')}`),
        { status: 400, code: 'VALIDATION_FAILED' });
    }
    return body;
  };
}

// -------------------------------------------------------- the throwaway db --
const adminPool = new Pool({ connectionString: urlFor(adminUser, adminPassword, admin.pathname.slice(1) || 'postgres') });
let created = false;
let db;
let services = [];
say(`Open sign-up launch rehearsal, run ${runId}, ${new Date().toISOString()}`);
try {
  await step('throwaway database: a disposable local PostgreSQL 16, as a superuser', async () => {
    const row = (await adminPool.query(`select rolsuper, current_setting('server_version_num')::int as version
      from pg_roles where rolname = current_user`)).rows[0];
    assert.equal(row?.rolsuper, true, 'HID_REHEARSAL_ADMIN_URL is not a superuser');
    assert(row.version >= 160000 && row.version < 170000, `PostgreSQL ${row.version} is not 16`);
  });
  if (failed) throw new Error('stopped: no disposable PostgreSQL 16 superuser');
  await adminPool.query(`create role ${migrator} login nosuperuser nobypassrls createrole password '${migratorPassword}'`);
  await adminPool.query(`create database ${database} owner ${migrator}`);
  created = true;
  db = new Pool({ connectionString: urlFor(adminUser, adminPassword, database) });
  await db.query('create extension vector with schema public');
  await db.query('create extension pgcrypto with schema public');
  await db.query('create extension "uuid-ossp" with schema public');

  await step('throwaway database: every migration applied by a login without SUPERUSER or BYPASSRLS (production\'s shape)', async () => {
    const env = { ...process.env, NODE_ENV: 'test', MIGRATION_TARGET: 'rds', DATABASE_SSL: 'false',
      DATABASE_URL: urlFor(migrator, migratorPassword, database) };
    delete env.DATABASE_SSL_ROOT_CERT_BASE64;
    delete env.HID_TEST_MIGRATION_DIRECTORY;
    delete env.HID_REHEARSAL_ADMIN_URL;
    execFileSync(process.execPath, [join(ehrRoot, 'scripts/apply-migrations.mjs')],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
    const versions = (await db.query('select version from migration.schema_migrations order by version')).rows
      .map((row) => String(row.version));
    assert(versions.some((version) => version.startsWith('0115')) && versions.some((version) => version.startsWith('0116')),
      `0115 and 0116 are not applied (last: ${versions.at(-1)})`);
    say(`      ${versions.length} migrations, ${versions[0]} to ${versions.at(-1)}`);
  });
  await step('throwaway database: runtime-grants.sql and the runtime-roles checks, as the security administrator', async () => {
    const strip = (sql) => sql.replace(/^\\set ON_ERROR_STOP on\r?\n/m, '');
    await db.query(strip(await readFile(join(ehrRoot, 'database/runtime-grants.sql'), 'utf8')));
    await db.query(strip(await readFile(join(ehrRoot, 'database/tests/runtime-roles.integration.sql'), 'utf8')));
  });
  await step('throwaway database: as in production, platform.control_settings does not force row-level security, '
    + 'so Identity\'s accountless switch reads work', async () => {
    // A fresh install forces it; production's table does not (otherwise no accountless control read could work there:
    // docs/MAIN_TO_NOVU_PORT.md, 0086 preflight; test-staging-schema-upgrade.mjs rehearses the same state).
    await db.query('alter table platform.control_settings no force row level security');
    const reader = await db.connect();
    try {
      await reader.query('begin');
      await reader.query('set local role hid_identity_api_runtime');
      const row = (await reader.query(`select platform.control_enabled('outreach_organiser_signup_enabled') as signup,
        platform.control_enabled('outreach_portal_enabled') as portal`)).rows[0];
      assert.equal(typeof row.signup, 'boolean');
      assert.equal(typeof row.portal, 'boolean');
    } finally { await reader.query('rollback').catch(() => undefined); reader.release(); }
  });
  if (failed) throw new Error('stopped: the throwaway database could not be built');

  // Fixtures (superuser, triggers off): a hospital with a doctor who already has
  // a login (for "Start an outreach group"), a support login (platform_admin:
  // groups and registrations) and an operations login
  // (platform_operations_admin: the platform's switches). The Outreach portal
  // on and maintenance off, as live.
  const ids = { org: randomUUID(), hospital: randomUUID(), doctor: randomUUID(), doctorStaff: randomUUID(),
    doctorMembership: randomUUID(), support: randomUUID(), operations: randomUUID() };
  const fixture = await db.connect();
  try {
    await fixture.query('begin');
    await fixture.query('set local session_replication_role = replica');
    await fixture.query(`insert into identity.organizations (id, name, slug) values ($1, 'Rehearsal Hospital Group', $2)`,
      [ids.org, `rehearsal-hospital-group-${runId}`]);
    await fixture.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
      values ($1, $2, 'Rehearsal Hospital', $3, 'Africa/Lagos', true, 'verified')`, [ids.hospital, ids.org, `REHEARSAL-${runId}`]);
    await fixture.query(`insert into auth.accounts (id, subject, email, display_name, status) values
      ($1, 'synthetic:rehearsal-doctor', 'rehearsal-doctor@example.test', 'Ada Doctor', 'active'),
      ($2, 'synthetic:rehearsal-support', 'rehearsal-support@example.test', 'Chidi Support', 'active'),
      ($3, 'synthetic:rehearsal-operations', 'rehearsal-operations@example.test', 'Efe Operations', 'active')`,
    [ids.doctor, ids.support, ids.operations]);
    await fixture.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active)
      values ($1, $2, 'Ada Doctor', 'rehearsal-doctor@example.test', 'verified', 'doctor', true)`, [ids.doctorStaff, ids.doctor]);
    await fixture.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, 'doctor', 'doctor', true, true)`,
    [ids.doctorMembership, ids.doctorStaff, ids.doctor, ids.org, ids.hospital]);
    await fixture.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
      (gen_random_uuid(), $1, 'doctor', 'facility', $2, $3, 'Rehearsal role'),
      (gen_random_uuid(), $4, 'platform_admin', 'platform', null, null, 'Rehearsal support role'),
      (gen_random_uuid(), $5, 'platform_operations_admin', 'platform', null, null, 'Rehearsal operations role')`,
    [ids.doctor, ids.doctorMembership, ids.hospital, ids.support, ids.operations]);
    await fixture.query(`update platform.control_settings set enabled = (control_key = 'outreach_portal_enabled')
      where control_key in ('outreach_portal_enabled', 'maintenance_mode')`);
    await fixture.query('commit');
  } finally { fixture.release(); }

  // ---------------------------------------------------------- the services --
  // Identity, as its runtime role, with synthetic keys. The mock gateway: the
  // mailbox below stands in for the notification service.
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: serviceUrl('hid_identity_api_runtime'), DATABASE_SSL: 'false',
    CORS_ORIGINS: 'https://outreach.healthidentitydirectory.com', AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: randomBytes(32).toString('base64url'), AUTH_LOGIN_PEPPER: randomBytes(32).toString('base64url'),
    OTP_HMAC_KEY_B64: randomBytes(32).toString('base64'), CONTACT_LOOKUP_HMAC_KEY_B64: randomBytes(32).toString('base64'),
    IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: randomBytes(32).toString('base64url') });
  delete process.env.DATABASE_SSL_ROOT_CERT_BASE64;
  requireIdentity('ts-node').register({ project: join(identityRoot, 'tsconfig.json'), transpileOnly: true });
  requireIdentity('reflect-metadata');
  const loadIdentity = (path) => requireIdentity(join(identityRoot, 'src', path));
  const { DatabaseService } = loadIdentity('database/database.service.ts');
  const { AuditService: IdentityAudit } = loadIdentity('audit/audit.service.ts');
  const { AdminService } = loadIdentity('admin/admin.service.ts');
  const { OutreachOrganiserService } = loadIdentity('outreach-organisers/outreach-organiser.service.ts');
  const { OutreachInvitationsService } = loadIdentity('outreach-organisers/outreach-invitations.service.ts');
  const { OutreachOrganisersAdminService } = loadIdentity('outreach-organisers/outreach-organisers-admin.ts');
  const identityDatabase = new DatabaseService();
  services.push(identityDatabase);
  const identityBody = requestBodies(requireIdentity, identityRoot);
  const signupDto = (name, plain) => identityBody('outreach-organisers/dto/outreach-organiser.dto.ts', name, plain);
  const supportDto = (name, plain) => identityBody('outreach-organisers/outreach-organisers-admin.ts', name, plain);
  // The invitation email is rendered with notification-api's own template (the text it would send); nothing is sent.
  const { staffInvitationContent } = requireIdentity(join(notificationRoot, 'src/providers/provider.types.ts'));
  const mailbox = { codes: [], invitations: [] };
  const mockGateway = {
    deliver: async (input) => { mailbox.codes.push(input); return { outcome: 'accepted' }; },
    deliverStaffInvitation: async (input) => {
      const email = staffInvitationContent({ ...input, origin: 'https://outreach.healthidentitydirectory.com',
        supportEmail: 'support@example.test' });
      mailbox.invitations.push({ ...input, email });
      return { outcome: 'accepted' };
    },
  };
  const completion = { publicApplicationNetworkDigest: (network) =>
    createHmac('sha256', `rehearsal-network-${runId}`).update(network).digest('hex') };
  const organisers = new OutreachOrganiserService(identityDatabase, mockGateway, completion);
  const invitations = new OutreachInvitationsService(identityDatabase, mockGateway);
  const support = new OutreachOrganisersAdminService(identityDatabase);
  const platform = new AdminService(identityDatabase, new IdentityAudit(identityDatabase), {});
  const correlationId = () => `outreach-rehearsal-${randomUUID()}`;
  const accountContext = (subject, accountId, facility, roles) => ({ correlationId: correlationId(),
    facilityId: facility?.facilityId ?? '', membershipId: facility?.membershipId ?? '', purposeOfUse: 'healthcare-operations',
    actor: { kind: 'staff', id: subject, subject, accountId, roles, permissions: [], facilityIds: [], facilities: [],
      authenticationMethod: 'local', ...(facility ? { facility: { id: facility.facilityId, membershipId: facility.membershipId,
        organizationId: facility.organizationId, name: facility.name, roles, permissions: [], isPrimary: true } } : {}) } });
  const supportContext = () => ({ correlationId: correlationId(), purposeOfUse: 'healthcare-operations',
    actor: { kind: 'staff', id: 'synthetic:rehearsal-support', subject: 'synthetic:rehearsal-support', accountId: ids.support,
      roles: [], permissions: [], platformPermissions: ['platform.admin.access', 'platform.facility.read',
        'platform.facility.manage', 'platform.facility.unlock'], facilityIds: [], facilities: [], authenticationMethod: 'local' } });
  const operationsContext = () => ({ correlationId: correlationId(), purposeOfUse: 'healthcare-operations',
    actor: { kind: 'staff', id: 'synthetic:rehearsal-operations', subject: 'synthetic:rehearsal-operations', accountId: ids.operations,
      roles: [], permissions: [], platformPermissions: ['platform.admin.access', 'platform.control.read', 'platform.control.manage'],
      facilityIds: [], facilities: [], authenticationMethod: 'local' } });
  const doctorAccount = () => accountContext('synthetic:rehearsal-doctor', ids.doctor, null, []);
  const signupDetails = { phone: '0801 234 5678', kind: 'group', turnstileAction: 'outreach-organiser-signup' };
  const groupDetails = { phone: '0801 234 5678', kind: 'group', termsVersion: '2026-11-01', acceptTerms: true };
  const counts = async () => (await db.query(`select
      (select count(*)::int from identity.outreach_organiser_signups) as signups,
      (select count(*)::int from identity.outreach_organisations) as groups,
      (select count(*)::int from identity.outreach_invitations) as invitations,
      (select count(*)::int from outreach.campaigns) as campaigns,
      (select count(*)::int from outreach.registration_cases) as registrations`)).rows[0];
  const switchIs = async () => (await db.query(`select enabled from platform.control_settings
    where control_key = 'outreach_organiser_signup_enabled'`)).rows[0]?.enabled;
  async function setSwitch(enabled, reason) {
    const version = Number((await db.query(`select row_version from platform.control_settings
      where control_key = 'outreach_organiser_signup_enabled'`)).rows[0].row_version);
    const answer = await platform.setPlatformControl(operationsContext(), identityBody('admin/dto/admin-command.dto.ts',
      'PlatformControlCommandDto', { controlKey: 'outreach_organiser_signup_enabled', enabled, reason }), version);
    assert.equal(answer.enabled, enabled);
    assert.equal(await switchIs(), enabled);
  }

  // Outreach, as its runtime role.
  Object.assign(process.env, { DATABASE_URL: serviceUrl('hid_outreach_api_runtime'),
    OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: randomBytes(32).toString('base64url') });
  const loadOutreach = (path) => requireOutreach(join(outreachRoot, 'src', path));
  const { DatabaseService: OutreachDatabase } = loadOutreach('database/database.service.ts');
  const { AuditService: OutreachAudit } = loadOutreach('audit/audit.service.ts');
  const { OutreachService } = loadOutreach('outreach/outreach.service.ts');
  const outreachDatabase = new OutreachDatabase();
  services.push(outreachDatabase);
  const outreachBody = requestBodies(requireOutreach, outreachRoot);
  const outreachDto = (file, name, plain) => outreachBody(`outreach/dto/${file}`, name, plain);
  const outreach = new OutreachService(outreachDatabase, new OutreachAudit(), {
    authorizeExistingPatient: async () => { throw new Error('not used in this rehearsal'); } });
  const outreachContext = (subject, accountId, facility, roles) => ({ correlationId: correlationId(),
    facilityId: facility.facilityId, membershipId: facility.membershipId, purposeOfUse: 'direct-care',
    actor: { id: subject, subject, accountId, roles, permissions: [], facilityIds: [facility.facilityId], facilities: [],
      authenticationMethod: 'local', facility: { id: facility.facilityId, membershipId: facility.membershipId,
        organizationId: facility.organizationId, name: facility.name, roles, permissions: [], isPrimary: true } } });

  await step('services: Identity runs as hid_identity_api_runtime and Outreach as hid_outreach_api_runtime', async () => {
    assert.equal(await identityDatabase.withSystemTransaction(correlationId(), async (client) =>
      (await client.query('select current_user as role')).rows[0].role), 'hid_identity_api_runtime');
    const probe = { correlationId: correlationId(), facilityId: ids.hospital, membershipId: ids.doctorMembership,
      purposeOfUse: 'direct-care', actor: { subject: 'synthetic:rehearsal-doctor' } };
    assert.equal(await outreachDatabase.withTransaction(probe, async (client) =>
      (await client.query('select current_user as role')).rows[0].role), 'hid_outreach_api_runtime');
  });

  // ------------------------------------------- 0. the switch OFF, as seeded --
  say('-- 0. The switch outreach_organiser_signup_enabled OFF, as the release seeds it');
  await step('off: the switch is seeded OFF', async () => assert.equal(await switchIs(), false));
  await step('off: the sign-up page is told sign-up is closed (availability open: false)', async () =>
    assert.equal((await organisers.availability()).open, false));
  await step('off: an organiser starting a sign-up is refused (423)', () =>
    refused(organisers.start(signupDto('StartOutreachOrganiserSignupDto', { ...signupDetails, organiserName: 'Bisi Organiser', email: 'bisi.organiser@example.test',
      groupName: 'Ajegunle Health Volunteers' }), '203.0.113.10', correlationId()), CLOSED));
  await step('off: verifying an email code is refused (423)', () => refused(organisers.verify('none.none', '123456', correlationId()), CLOSED));
  await step('off: asking for a new code is refused (423)', () => refused(organisers.resend('none.none', correlationId()), CLOSED));
  await step('off: activating is refused (423)', () => refused(organisers.activate('none.none', signupDto('ActivateOutreachOrganiserDto',
    { termsVersion: '2026-11-01', acceptTerms: true, password: 'a-long-fictional-password' }), correlationId()), CLOSED));
  await step('off: a signed-in doctor\'s "Start an outreach group" is refused (423)', () =>
    refused(organisers.startForAccount(doctorAccount(), signupDto('StartOutreachGroupForAccountDto', { ...groupDetails, kind: 'individual', groupName: 'Ada Street Health' })), CLOSED));
  await step('off: nothing was created and no email went, so no group exists to run a campaign, invite or register', async () => {
    assert.deepEqual(await counts(), { signups: 0, groups: 0, invitations: 0, campaigns: 0, registrations: 0 });
    assert.equal(mailbox.codes.length + mailbox.invitations.length, 0);
  });

  // ---------------------------------------------- 1. operations turns it ON --
  say('-- 1. Operations turns the switch ON');
  await step('on: operations turns the switch ON with the admin control command (Admin, Controls)', () =>
    setSwitch(true, 'Launch rehearsal: open sign-up on outreach'));
  await step('on: the sign-up page is told sign-up is open (terms 2026-11-01)', async () =>
    assert.deepEqual(await organisers.availability(), { open: true, termsVersion: '2026-11-01' }));

  // --------------------------------------------- 2. an organiser signs up --
  say('-- 2. An organiser signs up, verifies the email and activates');
  let cookie;
  let organiser;
  await step('sign-up: Bisi starts with the group "Ajegunle Health Volunteers" and a code is emailed', async () => {
    const started = await organisers.start(signupDto('StartOutreachOrganiserSignupDto', { ...signupDetails, organiserName: 'Bisi Organiser', email: 'bisi.organiser@example.test',
      groupName: 'Ajegunle Health Volunteers' }), '203.0.113.11', correlationId());
    cookie = started.cookie;
    assert.equal(started.body.accepted, true);
    assert.equal(mailbox.codes.length, 1);
    assert.equal(mailbox.codes[0].recipient, 'bisi.organiser@example.test');
    assert.match(String(mailbox.codes[0].code), /^\d{6}$/);
  });
  await step('sign-up: a wrong code is refused', () =>
    refused(organisers.verify(cookie, mailbox.codes[0].code === '000000' ? '111111' : '000000', correlationId()), { code: 'OTP_INVALID' }));
  await step('sign-up: the emailed code verifies the email', async () =>
    assert.deepEqual(await organisers.verify(cookie, mailbox.codes.at(-1).code, correlationId()), { verified: true }));
  await step('sign-up: activating accepts the terms, sets the password and signs Bisi in as the group\'s organiser', async () => {
    organiser = await organisers.activate(cookie, signupDto('ActivateOutreachOrganiserDto', { termsVersion: '2026-11-01',
      acceptTerms: true, password: 'a-long-fictional-password' }), correlationId());
    assert.equal(organiser.email, 'bisi.organiser@example.test');
    assert.equal(organiser.replayed, false);
    const roles = (await db.query(`select role_code from auth.account_roles where account_id = $1 and facility_id = $2
      and revoked_at is null`, [organiser.accountId, organiser.facilityId])).rows.map((row) => row.role_code);
    assert.deepEqual(roles, ['outreach_organiser']);
  });
  await step('sign-up: support sees the new group as "Unverified organiser" with its phone in E.164', async () => {
    const row = (await support.list(supportContext(), 'active')).organisers
      .find((entry) => entry.organizationId === organiser?.organizationId);
    assert.equal(row?.label, 'Unverified organiser');
    assert.equal(row?.phone, '+2348012345678');
  });

  // ---------------------------------------------- 3. a refused group name --
  say('-- 3. A refused group name');
  for (const groupName of ['General Hospital', 'general hospital', 'Makoko General Hospital Volunteers']) {
    await step(`name: "${groupName}" is refused (422 OUTREACH_ORGANISER_NAME_NOT_ALLOWED) and no code is emailed`, async () => {
      const before = mailbox.codes.length;
      const signups = (await counts()).signups;
      await refused(organisers.start(signupDto('StartOutreachOrganiserSignupDto', { ...signupDetails, organiserName: 'Tobi Organiser', email: 'tobi.organiser@example.test',
        groupName }), '203.0.113.12', correlationId()), { status: 422, code: 'OUTREACH_ORGANISER_NAME_NOT_ALLOWED' });
      assert.equal(mailbox.codes.length, before);
      assert.equal((await counts()).signups, signups);
    });
  }
  await step('name: the database refuses it too, if a caller skips the service\'s check (name_not_allowed)', async () => {
    const answer = await identityDatabase.withSystemTransaction(correlationId(), async (client) => (await client.query(
      'select identity.start_outreach_organiser_signup($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as outcome',
      [randomUUID(), 'a'.repeat(64), 'tobi.organiser@example.test', 'Tobi Organiser', 'General Hospital', 'group', null,
        'b'.repeat(64), randomBytes(48), 'rehearsal-v1', 'c'.repeat(64), 'd'.repeat(64)])).rows[0].outcome);
    assert.equal(answer, 'name_not_allowed');
  });

  // -------------------------------- 4. a campaign, and a volunteer invited --
  say('-- 4. The organiser creates a campaign and invites a volunteer');
  const subjectOf = async (accountId) => (await db.query('select subject from auth.accounts where id = $1', [accountId])).rows[0]?.subject;
  const group = organiser ? { facilityId: organiser.facilityId, membershipId: organiser.membershipId,
    organizationId: organiser.organizationId, name: 'Ajegunle Health Volunteers' } : null;
  const organiserSubject = organiser ? await subjectOf(organiser.accountId) : null;
  const atGroup = () => outreachContext(organiserSubject, organiser.accountId, group, ['outreach_organiser']);
  const asOrganiser = () => accountContext(organiserSubject, organiser.accountId, group, ['outreach_organiser']);
  let campaign;
  await step('campaign: Bisi creates "Ajegunle market health day" and opens it at once (no Health ID check first, Q38)', async () => {
    const made = await outreach.createCampaign(outreachDto('create-campaign.dto.ts', 'CreateCampaignDto',
      { name: 'Ajegunle market health day', services: ['registration'], startsAt: new Date(Date.now() - 60_000).toISOString() }),
    atGroup());
    campaign = await outreach.updateCampaignStatus(made.id, outreachDto('update-campaign-status.dto.ts', 'UpdateCampaignStatusDto',
      { status: 'active', reason: 'The market health day has started' }), made.rowVersion, atGroup());
    assert.equal(campaign.status, 'active');
  });
  await step('campaign: Outreach reads the group as "unverified" (not paused)', async () =>
    assert.equal((await outreach.campaignGovernance(atGroup())).organiserStatus, 'unverified'));
  let invitation;
  await step('invite: Bisi invites Chika by email; the email names the group and has the outreach link, and no code', async () => {
    invitation = await invitations.create(asOrganiser(), signupDto('CreateOutreachInvitationDto',
      { name: 'Chika Volunteer', email: 'Chika.Volunteer@example.test ' }));
    assert.equal(invitation.deliveryOutcome, 'accepted');
    const sent = mailbox.invitations.at(-1);
    assert.equal(sent?.invitationId, invitation.invitationId);
    assert.equal(sent.recipient, 'chika.volunteer@example.test');
    assert.equal(sent.email.subject, 'Invitation to help Ajegunle Health Volunteers on Health ID Outreach');
    assert(sent.email.text.includes(
      `https://outreach.healthidentitydirectory.com/provider/outreach-invitation#${sent.invitationId}.${sent.token}`));
    assert.equal(sent.email.text.includes(sent.code), false, 'the email shows a code');
  });
  await step('invite: the same person again is refused (409 OUTREACH_INVITATION_ALREADY_SENT)', () =>
    refused(invitations.create(asOrganiser(), signupDto('CreateOutreachInvitationDto',
      { name: 'Chika Volunteer', email: 'chika.volunteer@example.test' })),
      { status: 409, code: 'OUTREACH_INVITATION_ALREADY_SENT' }));

  // ------------------------- 5. the volunteer accepts and registers people --
  say('-- 5. The volunteer accepts and registers two fictional people with consent');
  let volunteer;
  await step('accept: the link shows the group and that Chika is new', async () => {
    const preview = await invitations.preview(signupDto('OutreachInvitationProofDto',
      { invitationId: invitation.invitationId, token: mailbox.invitations.at(-1).token }), '203.0.113.20', correlationId());
    assert.equal(preview.groupName, 'Ajegunle Health Volunteers');
    assert.equal(preview.accountCase, 'new');
  });
  await step('accept: Chika sets a password and joins the group as a volunteer', async () => {
    volunteer = await invitations.acceptWithPassword(signupDto('AcceptOutreachInvitationDto', { invitationId: invitation.invitationId,
      token: mailbox.invitations.at(-1).token, password: 'another-long-fictional-password', turnstileAction: 'outreach-invitation' }),
    '203.0.113.20', correlationId());
    assert.equal(volunteer.email, 'chika.volunteer@example.test');
    assert.equal(volunteer.facilityId, organiser.facilityId);
    assert.equal(volunteer.roleCode, 'outreach_volunteer');
  });
  const volunteerAccount = volunteer
    ? (await db.query('select id, subject from auth.accounts where email = $1', [volunteer.email])).rows[0] : null;
  const volunteerFacility = volunteer ? { ...group, membershipId: volunteer.membershipId } : null;
  const asVolunteer = () => outreachContext(volunteerAccount.subject, volunteerAccount.id, volunteerFacility, ['outreach_volunteer']);
  await step('team: Bisi adds Chika to the campaign as an enumerator', async () => {
    const member = await outreach.addCampaignMember(campaign.id, outreachDto('add-campaign-member.dto.ts', 'AddCampaignMemberDto',
      { membershipId: volunteer.membershipId, role: 'enumerator' }), atGroup());
    assert.equal(member.role, 'enumerator');
  });
  const people = [
    { label: 'an adult, consent ticked by herself', fullName: 'Ngozi Fictional', sex: 'female', ageYears: 34, phone: '0803 555 0101',
      consent: { textVersion: 'outreach-notice-2026-11-01', language: 'en', method: 'self_ticked' } },
    { label: 'a child, consent from his guardian', fullName: 'Tunde Fictional', sex: 'male', ageYears: 9, phone: null,
      consent: { textVersion: 'outreach-notice-2026-11-01', language: 'yo', method: 'guardian', guardianName: 'Ngozi Fictional' } },
  ];
  const registered = [];
  for (const person of people) {
    await step(`register: Chika registers ${person.label} into the campaign`, async () => {
      const temporaryPatientId = `tmp_${randomUUID()}`;
      const made = await outreach.create(outreachDto('create-registration-case.dto.ts', 'CreateRegistrationCaseDto',
        { localCommandId: randomUUID(), temporaryPatientId, fullName: person.fullName, sex: person.sex, ageYears: person.ageYears,
          ...(person.phone ? { phone: person.phone } : {}), campaignId: campaign.id, consent: person.consent }),
      `rehearsal-${randomUUID()}`, asVolunteer());
      assert.equal(made.campaignId, campaign.id);
      assert.equal(made.possibleDuplicate, false);
      const consent = (await db.query(`select method, language, guardian_name, captured_by_membership_id
        from outreach.registration_consents where registration_case_id = $1`, [made.id])).rows[0];
      assert.deepEqual(consent, { method: person.consent.method, language: person.consent.language,
        guardian_name: person.consent.guardianName ?? null, captured_by_membership_id: volunteer.membershipId });
      registered.push({ ...person, id: made.id, temporaryPatientId, phone: made.phone });
    });
  }
  await step('register: a child without a guardian\'s name is refused (422 OUTREACH_CONSENT_GUARDIAN_REQUIRED)', () =>
    refused((async () => outreach.create(outreachDto('create-registration-case.dto.ts', 'CreateRegistrationCaseDto',
      { localCommandId: randomUUID(), temporaryPatientId: `tmp_${randomUUID()}`, fullName: 'Kemi Fictional', sex: 'female',
        ageYears: 7, campaignId: campaign.id,
        consent: { textVersion: 'outreach-notice-2026-11-01', language: 'en', method: 'verbal_read_aloud' } }),
    `rehearsal-${randomUUID()}`, asVolunteer()))(), { status: 422, code: 'OUTREACH_CONSENT_GUARDIAN_REQUIRED' }));
  await step('register: the phone is stored in E.164 (+2348035550101)', async () =>
    assert.equal(registered[0]?.phone, '+2348035550101'));

  // ------------------------------------------ 6. support search and delete --
  say('-- 6. Support finds a registration and deletes a person\'s details at their request');
  await step('search: by the child\'s temporary ID, one match, with no name or phone in the answer', async () => {
    const found = await support.findRegistrations(supportContext(), supportDto('FindOutreachRegistrationsDto',
      { organizationId: organiser.organizationId, temporaryPatientId: registered[1].temporaryPatientId }));
    assert.equal(found.registrations.length, 1);
    assert.deepEqual(Object.keys(found.registrations[0]).sort(),
      ['campaignName', 'caseId', 'createdAt', 'groupName', 'redacted', 'temporaryPatientId']);
    assert.equal(found.registrations[0].campaignName, 'Ajegunle market health day');
    assert.equal(found.registrations[0].redacted, false);
  });
  await step('search: by phone as the person says it (0803 555 0101), the adult\'s registration', async () => {
    const found = await support.findRegistrations(supportContext(), supportDto('FindOutreachRegistrationsDto',
      { organizationId: organiser.organizationId, phone: '0803 555 0101' }));
    assert.deepEqual(found.registrations.map((row) => row.caseId), [registered[0].id]);
  });
  await step('search: both a temporary ID and a phone at once is refused (400 OUTREACH_REGISTRATION_LOOKUP_INVALID)', () =>
    refused((async () => support.findRegistrations(supportContext(), supportDto('FindOutreachRegistrationsDto',
      { organizationId: organiser.organizationId, temporaryPatientId: registered[1].temporaryPatientId, phone: '0803 555 0101' })))(),
    { status: 400, code: 'OUTREACH_REGISTRATION_LOOKUP_INVALID' }));
  await step('delete: support deletes the adult\'s details at her request; the name is "[redacted]" and the phone gone', async () => {
    const { reason } = supportDto('RedactOutreachRegistrationDto', { reason: 'She asked for her details to be deleted' });
    const answer = await support.redactRegistration(supportContext(), registered[0].id, reason);
    assert.deepEqual(answer, { caseId: registered[0].id, outcome: 'redacted' });
    const row = (await db.query('select full_name, phone from outreach.registration_cases where id = $1', [registered[0].id])).rows[0];
    assert.deepEqual(row, { full_name: '[redacted]', phone: null });
    const found = await support.findRegistrations(supportContext(), supportDto('FindOutreachRegistrationsDto',
      { organizationId: organiser.organizationId, temporaryPatientId: registered[0].temporaryPatientId }));
    assert.equal(found.registrations[0]?.redacted, true);
  });
  await step('delete: a second delete is refused (409 OUTREACH_REGISTRATION_NOT_REDACTABLE)', () =>
    refused(support.redactRegistration(supportContext(), registered[0].id, 'She asked again by phone'),
      { status: 409, code: 'OUTREACH_REGISTRATION_NOT_REDACTABLE' }));
  await step('delete: the child\'s registration is untouched', async () => {
    const row = (await db.query('select full_name from outreach.registration_cases where id = $1', [registered[1].id])).rows[0];
    assert.equal(row?.full_name, 'Tunde Fictional');
  });

  // -------------------------------------- 7. operations turns it OFF again --
  say('-- 7. Operations turns the switch OFF again');
  let pending;
  await step('off again: (Kemi starts a sign-up while it is still on)', async () => {
    pending = await organisers.start(signupDto('StartOutreachOrganiserSignupDto', { ...signupDetails, phone: '0805 111 2222', organiserName: 'Kemi Organiser',
      email: 'kemi.organiser@example.test', groupName: 'Makoko Youth Health Club' }), '203.0.113.13', correlationId());
    assert.equal(pending.body.accepted, true);
  });
  const kemiCode = mailbox.codes.at(-1)?.code;
  await step('off again: operations turns the switch OFF with the admin control command', () =>
    setSwitch(false, 'Launch rehearsal: closing open sign-up again'));
  const before = await counts();
  const sentBefore = mailbox.codes.length;
  await step('off again: the sign-up page is told sign-up is closed', async () =>
    assert.equal((await organisers.availability()).open, false));
  await step('off again: a new sign-up is refused (423)', () =>
    refused(organisers.start(signupDto('StartOutreachOrganiserSignupDto', { ...signupDetails, phone: '0806 333 4444', organiserName: 'Femi Organiser',
      email: 'femi.organiser@example.test', groupName: 'Oshodi Health Friends' }), '203.0.113.14', correlationId()), CLOSED));
  await step('off again: Kemi\'s sign-up in progress cannot verify its code (423)', () =>
    refused(organisers.verify(pending.cookie, kemiCode, correlationId()), CLOSED));
  await step('off again: nor ask for a new code (423)', () => refused(organisers.resend(pending.cookie, correlationId()), CLOSED));
  await step('off again: nor activate (423)', () => refused(organisers.activate(pending.cookie, signupDto('ActivateOutreachOrganiserDto',
    { termsVersion: '2026-11-01', acceptTerms: true, password: 'a-third-long-fictional-password' }), correlationId()), CLOSED));
  await step('off again: a signed-in doctor\'s "Start an outreach group" is refused (423)', () =>
    refused(organisers.startForAccount(doctorAccount(), signupDto('StartOutreachGroupForAccountDto', { ...groupDetails, kind: 'individual', groupName: 'Ada Street Health' })), CLOSED));
  await step('off again: no group, sign-up or email was added while it was off', async () => {
    assert.deepEqual(await counts(), before);
    assert.equal(mailbox.codes.length, sentBefore);
  });
} catch (error) {
  failed += 1;
  say(`FAIL  the rehearsal stopped: ${error?.message ?? error}`);
} finally {
  for (const service of services) await service.onApplicationShutdown?.().catch(() => undefined);
  await db?.end().catch(() => undefined);
  if (created && !keep) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const open = await adminPool.query('select count(*)::int as count from pg_stat_activity where datname = $1', [database]);
      if (open.rows[0].count === 0) break;
      await new Promise((settle) => { setTimeout(settle, 100); });
    }
    await adminPool.query(`drop database if exists ${database} with (force)`).catch(() => undefined);
    await adminPool.query(`drop role if exists ${migrator}`).catch(() => undefined);
  } else if (created) {
    say(`(kept: database ${database}, migration login ${migrator})`);
  }
  await adminPool.end().catch(() => undefined);
}
say(`\n${passed} passed, ${failed} failed: ${failed === 0 ? 'READY' : 'NOT READY'}`);
process.exit(failed === 0 ? 0 : 1);
