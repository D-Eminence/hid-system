#!/usr/bin/env node
// Open sign-up on outreach. (migrations 0125 and 0126, owner decisions of
// 11 November 2026) run through the real Identity and Outreach services
// against a disposable Postgres 16 with the migrations applied. Every
// Identity call runs as hid_identity_api_runtime and every Outreach call as
// hid_outreach_api_runtime, under the session each service sets; only the
// email delivery is a local stub that keeps the code and the link. It proves
// that each function the services call exists with the arguments and
// answers they use:
//   public sign-up (start, wrong code, resend wait, verify, activate), an
//   email that already has a login refused, "Start an outreach group" for a
//   signed-in hospital doctor (owner decision 5) and its repeat, outreach
//   invitations (create, already invited, team list, preview, accept with a
//   password, accept signed in by the hospital doctor), support's queue with
//   versions, the one-click review (owner decision 1), a stale version
//   refused, suspension, a campaign that cannot go Active before the check,
//   a registration with consent at a checked group, the governance read,
//   support's close and appoint, and the retention sweep (owner decision 3)
//   redacting a registration kept past its year.
//
// Usage (a loopback test cluster only; the database is copied first):
//   NODE_ENV=test HID_OUTREACH_RUNTIME_LOCAL_CLUSTER=loopback PGHOST=127.0.0.1 PGPORT=55461 \
//     PGUSER=postgres PGDATABASE=hid node services/identity-api/scripts/verify-outreach-organisers-runtime.mjs
// All values are synthetic. No network call is made.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHmac, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const identityRoot = resolve(import.meta.dirname, '..');
const outreachRoot = resolve(identityRoot, '../outreach-api');
const requireIdentity = createRequire(join(identityRoot, 'package.json'));
const requireOutreach = createRequire(join(outreachRoot, 'package.json'));
const host = process.env.PGHOST ?? '';
assert(process.env.NODE_ENV === 'test' && process.env.HID_OUTREACH_RUNTIME_LOCAL_CLUSTER === 'loopback'
  && ['127.0.0.1', '::1', 'localhost'].includes(host) && /^[a-z][a-z0-9_]{0,40}$/.test(process.env.PGDATABASE ?? ''),
  'Only an explicitly named loopback test cluster is supported');
const port = Number(process.env.PGPORT ?? 5432);
const admin = process.env.PGUSER ?? 'postgres';
const source = process.env.PGDATABASE;
const isolated = `${source}_outreach_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const url = (database, role) => `postgresql://${admin}@${host === '::1' ? '[::1]' : host}:${port}/${database}`
  + (role ? `?options=${encodeURIComponent(`-c role=${role}`)}` : '');

const { Pool } = requireIdentity('pg');
const adminPool = new Pool({ connectionString: url(source) });
await adminPool.query(`create database ${isolated} template ${source}`);
const db = new Pool({ connectionString: url(isolated) });
let failures = 0;
let passed = 0;
async function step(name, work) {
  try {
    await work();
    passed += 1;
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL ${name}\n     ${error?.code ?? ''} ${error?.message ?? error}\n`);
  }
}
async function refuses(promise, expected) {
  await assert.rejects(promise, (error) => {
    for (const [key, value] of Object.entries(expected)) assert.equal(error?.[key], value, `${key}: ${error?.code} ${error?.message}`);
    return true;
  });
}

try {
  // Fixtures (superuser, triggers off): hospital H with doctor D; support S
  // with platform_admin. The sign-up control and the Outreach portal on.
  const ids = { org: randomUUID(), hospital: randomUUID(), doctor: randomUUID(), doctorStaff: randomUUID(),
    doctorMembership: randomUUID(), support: randomUUID() };
  const fixture = await db.connect();
  try {
    await fixture.query('begin');
    await fixture.query('set local session_replication_role = replica');
    await fixture.query(`insert into identity.organizations (id, name, slug) values ($1, 'Verifier Hospital Group', 'verifier-hospital-group')`, [ids.org]);
    await fixture.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
      values ($1, $2, 'Verifier Hospital', 'VERIFIER-H', 'Africa/Lagos', true, 'verified')`, [ids.hospital, ids.org]);
    await fixture.query(`insert into auth.accounts (id, subject, email, display_name, status) values
      ($1, 'synthetic:verifier-doctor', 'verifier-doctor@example.test', 'Ada Doctor', 'active'),
      ($2, 'synthetic:verifier-support', 'verifier-support@example.test', 'Chidi Support', 'active')`, [ids.doctor, ids.support]);
    await fixture.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active)
      values ($1, $2, 'Ada Doctor', 'verifier-doctor@example.test', 'verified', 'doctor', true)`, [ids.doctorStaff, ids.doctor]);
    await fixture.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, 'doctor', 'doctor', true, true)`,
    [ids.doctorMembership, ids.doctorStaff, ids.doctor, ids.org, ids.hospital]);
    await fixture.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
      (gen_random_uuid(), $1, 'doctor', 'facility', $2, $3, 'Verifier role'),
      (gen_random_uuid(), $4, 'platform_admin', 'platform', null, null, 'Verifier support role')`,
    [ids.doctor, ids.doctorMembership, ids.hospital, ids.support]);
    await fixture.query(`update platform.control_settings set enabled = (control_key <> 'maintenance_mode')
      where control_key in ('outreach_organiser_signup_enabled', 'outreach_portal_enabled', 'maintenance_mode')`);
    await fixture.query('commit');
  } finally { fixture.release(); }

  // Identity, as its runtime role.
  Object.assign(process.env, { DATABASE_URL: url(isolated, 'hid_identity_api_runtime'), DATABASE_SSL: 'false',
    CORS_ORIGINS: 'https://outreach.healthidentitydirectory.com', AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: 'verifier-signing-secret-0123456789abcdef', AUTH_LOGIN_PEPPER: 'verifier-login-pepper-0123456789abcdef',
    OTP_HMAC_KEY_B64: Buffer.alloc(32, 7).toString('base64'), CONTACT_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 9).toString('base64'),
    IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'public-synthetic-ehr-workload-token' });
  requireIdentity('ts-node').register({ project: join(identityRoot, 'tsconfig.json'), transpileOnly: true });
  requireIdentity('reflect-metadata');
  const loadIdentity = (path) => requireIdentity(join(identityRoot, 'src', path));
  const { DatabaseService } = loadIdentity('database/database.service.ts');
  const { OutreachOrganiserService } = loadIdentity('outreach-organisers/outreach-organiser.service.ts');
  const { OutreachInvitationsService } = loadIdentity('outreach-organisers/outreach-invitations.service.ts');
  const { OutreachOrganisersAdminService } = loadIdentity('outreach-organisers/outreach-organisers-admin.ts');
  const { OutreachRetentionSweeper } = loadIdentity('outreach-organisers/outreach-retention.sweeper.ts');
  const identityDatabase = new DatabaseService();
  const sent = { codes: [], invitations: [] };
  const notification = {
    deliver: async (input) => { sent.codes.push(input); return { outcome: 'accepted' }; },
    deliverStaffInvitation: async (input) => { sent.invitations.push(input); return { outcome: 'accepted' }; },
  };
  const completion = { publicApplicationNetworkDigest: (network) =>
    createHmac('sha256', 'verifier-network').update(network).digest('hex') };
  const organisers = new OutreachOrganiserService(identityDatabase, notification, completion);
  const invitations = new OutreachInvitationsService(identityDatabase, notification);
  const support = new OutreachOrganisersAdminService(identityDatabase);
  const sweeper = new OutreachRetentionSweeper(identityDatabase);
  const correlationId = () => `outreach-verifier-${randomUUID()}`;
  const staffContext = (subject, accountId, facility, roles) => ({ correlationId: correlationId(),
    facilityId: facility?.facilityId ?? '', membershipId: facility?.membershipId ?? '', purposeOfUse: 'healthcare-operations',
    actor: { kind: 'staff', id: subject, subject, accountId, roles, permissions: [], facilityIds: [], facilities: [],
      authenticationMethod: 'local', ...(facility ? { facility: { id: facility.facilityId, membershipId: facility.membershipId,
        organizationId: facility.organizationId, name: facility.name, roles, permissions: [], isPrimary: true } } : {}) } });
  const supportContext = () => ({ correlationId: correlationId(), purposeOfUse: 'healthcare-operations',
    actor: { kind: 'staff', id: 'synthetic:verifier-support', subject: 'synthetic:verifier-support', accountId: ids.support,
      roles: [], permissions: [], platformPermissions: ['platform.admin.access', 'platform.facility.read',
        'platform.facility.manage', 'platform.facility.unlock'], facilityIds: [], facilities: [], authenticationMethod: 'local' } });
  const details = { phone: '0801 234 5678', kind: 'group', termsVersion: '2026-11-01', acceptTerms: true };

  await step('Identity runs as hid_identity_api_runtime', async () => {
    assert.equal(await identityDatabase.withSystemTransaction(correlationId(), async (client) =>
      (await client.query('select current_user as role')).rows[0].role), 'hid_identity_api_runtime');
  });

  // 1. Public sign-up.
  let cookie;
  let organiser;
  await step('start: 12 arguments, text answer, code emailed', async () => {
    const started = await organisers.start({ ...details, organiserName: 'Bola Organiser', email: 'bola.organiser@example.test',
      groupName: 'Verifier Community Volunteers', turnstileAction: 'outreach-organiser-signup' }, '203.0.113.10', correlationId());
    cookie = started.cookie;
    assert.equal(started.body.accepted, true);
    assert.equal(sent.codes.length, 1);
  });
  await step('verify: a wrong code is counted and refused plainly', () =>
    refuses(organisers.verify(cookie, sent.codes[0].code === '000000' ? '111111' : '000000', correlationId()), { code: 'OTP_INVALID' }));
  await step('resend: too soon after the first code', () =>
    refuses(organisers.resend(cookie, correlationId()), { status: 429, code: 'OTP_RESEND_COOLDOWN' }));
  await step('verify: the right code (3 arguments)', async () => {
    assert.deepEqual(await organisers.verify(cookie, sent.codes[0].code, correlationId()), { verified: true });
  });
  await step('activate: account, group and the login\'s email', async () => {
    organiser = await organisers.activate(cookie, { termsVersion: '2026-11-01', acceptTerms: true,
      password: 'a-long-fictional-password' }, correlationId());
    assert.equal(organiser.email, 'bola.organiser@example.test');
    assert.equal(organiser.replayed, false);
  });
  await step('start: an email that already has a login is told to sign in and use "Start an outreach group"', () =>
    refuses(organisers.start({ ...details, organiserName: 'Ada Doctor', email: 'verifier-doctor@example.test',
      groupName: 'Another Group', turnstileAction: 'outreach-organiser-signup' }, '203.0.113.11', correlationId()),
    { status: 409, code: 'OUTREACH_ORGANISER_EMAIL_REGISTERED' }));

  // 2. "Start an outreach group" for the signed-in hospital doctor (owner decision 5).
  const doctorAccount = staffContext('synthetic:verifier-doctor', ids.doctor, null, []);
  let doctorGroup;
  await step('for-my-account: 7 arguments, started, hospital role kept', async () => {
    doctorGroup = await organisers.startForAccount(doctorAccount, { ...details, kind: 'individual', groupName: 'Ada Street Health' });
    assert.equal(doctorGroup.started, true);
    const roles = await db.query(`select role_code, facility_id from auth.account_roles where account_id = $1 and revoked_at is null
      order by role_code`, [ids.doctor]);
    assert.deepEqual(roles.rows.map((row) => [row.role_code, row.facility_id]),
      [['doctor', ids.hospital], ['outreach_organiser', doctorGroup.facilityId]]);
  });
  await step('for-my-account: a second group is refused (already_organiser is not a success)', () =>
    refuses(organisers.startForAccount(doctorAccount, { ...details, groupName: 'Ada Second Group' }),
      { status: 409, code: 'OUTREACH_ORGANISER_ALREADY_RUNNING' }));

  // 3. Invitations.
  const organiserFacility = { facilityId: organiser.facilityId, membershipId: organiser.membershipId,
    organizationId: organiser.organizationId, name: 'Verifier Community Volunteers' };
  const organiserContext = () => staffContext(`outreach-organiser:${organiser.accountId}`, organiser.accountId,
    organiserFacility, ['outreach_organiser']);
  let helperInvitation;
  await step('invite: 4 arguments, created, link emailed', async () => {
    helperInvitation = await invitations.create(organiserContext(), { name: 'Chika Helper', email: 'chika.helper@example.test' });
    assert.equal(helperInvitation.deliveryOutcome, 'accepted');
    assert.equal(sent.invitations.at(-1).invitationId, helperInvitation.invitationId);
  });
  await step('invite: the same person again is "already invited" (409)', () =>
    refuses(invitations.create(organiserContext(), { name: 'Chika Helper', email: 'chika.helper@example.test' }),
      { status: 409, code: 'OUTREACH_INVITATION_ALREADY_SENT' }));
  await step('team: list_outreach_team answers members and invitations', async () => {
    const team = await invitations.list(organiserContext());
    assert.equal(team.members.length, 1);
    assert.equal(team.members[0].roleCode, 'outreach_organiser');
    assert.deepEqual(team.invitations.map((row) => row.email), ['chika.helper@example.test']);
  });
  await step('preview: the link shows the group and "new"', async () => {
    const preview = await invitations.preview({ invitationId: helperInvitation.invitationId, token: sent.invitations.at(-1).token },
      '203.0.113.20', correlationId());
    assert.equal(preview.groupName, 'Verifier Community Volunteers');
    assert.equal(preview.accountCase, 'new');
  });
  await step('accept with a password: 3 arguments, the new login\'s email', async () => {
    const accepted = await invitations.acceptWithPassword({ invitationId: helperInvitation.invitationId,
      token: sent.invitations.at(-1).token, password: 'another-long-fictional-password', turnstileAction: 'outreach-invitation' },
    '203.0.113.20', correlationId());
    assert.equal(accepted.email, 'chika.helper@example.test');
    assert.equal(accepted.facilityId, organiser.facilityId);
  });
  await step('accept signed in: the hospital doctor helps the group with the same login', async () => {
    const invited = await invitations.create(organiserContext(), { name: 'Ada Doctor', email: 'verifier-doctor@example.test' });
    const link = sent.invitations.at(-1);
    const accepted = await invitations.acceptForAccount(doctorAccount, { invitationId: invited.invitationId, token: link.token });
    assert.equal(accepted.facilityId, organiser.facilityId);
  });

  // 4. Support: the queue with versions, the one-click check, a stale version, suspension.
  let queue;
  await step('queue: pending groups with their versions (not a read-only transaction)', async () => {
    queue = (await support.list(supportContext(), 'pending')).organisers;
    const names = queue.map((row) => row.displayName).sort();
    assert.deepEqual(names, ['Ada Street Health', 'Verifier Community Volunteers']);
    for (const row of queue) assert(Number.isSafeInteger(row.version) && row.version >= 1);
    assert.equal(queue.find((row) => row.organizationId === organiser.organizationId)?.phone, '+2348012345678');
  });
  const organiserCampaign = { id: null, version: null };
  // Outreach, as its runtime role.
  Object.assign(process.env, { DATABASE_URL: url(isolated, 'hid_outreach_api_runtime'),
    OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: 'a-fictional-local-secret-of-32-chars!!' });
  const loadOutreach = (path) => requireOutreach(join(outreachRoot, 'src', path));
  const { DatabaseService: OutreachDatabase } = loadOutreach('database/database.service.ts');
  const { AuditService } = loadOutreach('audit/audit.service.ts');
  const { OutreachService } = loadOutreach('outreach/outreach.service.ts');
  const outreachDatabase = new OutreachDatabase();
  const outreach = new OutreachService(outreachDatabase, new AuditService(), {
    authorizeExistingPatient: async () => { throw new Error('not used'); } });
  await step('Outreach runs as hid_outreach_api_runtime', async () => {
    const context = { correlationId: correlationId(), facilityId: organiser.facilityId, membershipId: organiser.membershipId,
      purposeOfUse: 'direct-care', actor: { subject: `outreach-organiser:${organiser.accountId}` } };
    assert.equal(await outreachDatabase.withTransaction(context, async (client) =>
      (await client.query('select current_user as role')).rows[0].role), 'hid_outreach_api_runtime');
  });
  const outreachContext = (subject, accountId, facility, roles) => ({ correlationId: correlationId(),
    facilityId: facility.facilityId, membershipId: facility.membershipId, purposeOfUse: 'direct-care',
    actor: { id: subject, subject, accountId, roles, permissions: [], facilityIds: [facility.facilityId], facilities: [],
      authenticationMethod: 'local', facility: { id: facility.facilityId, membershipId: facility.membershipId,
        organizationId: facility.organizationId, name: facility.name, roles, permissions: [], isPrimary: true } } });
  const atOrganiserGroup = () => outreachContext(`outreach-organiser:${organiser.accountId}`, organiser.accountId,
    organiserFacility, ['outreach_organiser']);
  const doctorFacility = { facilityId: doctorGroup.facilityId, membershipId: doctorGroup.membershipId,
    organizationId: doctorGroup.organizationId, name: 'Ada Street Health' };

  await step('campaign: cannot go Active before Health ID\'s check (OUTREACH_ORGANISER_AWAITING_REVIEW)', async () => {
    const context = () => outreachContext('synthetic:verifier-doctor', ids.doctor, doctorFacility, ['outreach_organiser']);
    const campaign = await outreach.createCampaign({ name: 'Ada Street Day', services: ['registration'],
      startsAt: new Date(Date.now() - 60_000).toISOString() }, context());
    await refuses(outreach.updateCampaignStatus(campaign.id, { status: 'active', reason: 'Starting the street day' },
      campaign.rowVersion, context()), { status: 409, code: 'OUTREACH_ORGANISER_AWAITING_REVIEW' });
  });
  await step('governance: an unchecked group reads "unverified"', async () => {
    assert.equal((await outreach.campaignGovernance(atOrganiserGroup())).organiserStatus, 'unverified');
  });
  await step('review: one click with the version (owner decision 1)', async () => {
    const row = queue.find((entry) => entry.organizationId === organiser.organizationId);
    const reviewed = await support.review(supportContext(), organiser.organizationId, row.version, {});
    assert.equal(reviewed.reviewState, 'reviewed');
    assert.equal(reviewed.version, row.version + 1);
  });
  await step('review: again answers "already checked" (409), a stale version on suspend answers 409', async () => {
    const row = queue.find((entry) => entry.organizationId === organiser.organizationId);
    await refuses(support.review(supportContext(), organiser.organizationId, row.version + 1, {}),
      { status: 409, code: 'OUTREACH_ORGANISER_NOT_PENDING' });
    await refuses(support.suspend(supportContext(), organiser.organizationId, row.version, 'Stale version on purpose'),
      { status: 409, code: 'OUTREACH_ORGANISER_VERSION_CONFLICT' });
  });
  await step('governance: a checked group reads "reviewed" (scalar organiser_status)', async () => {
    assert.equal((await outreach.campaignGovernance(atOrganiserGroup())).organiserStatus, 'reviewed');
  });
  let registrationId;
  await step('registration with consent at a checked group (0125\'s consent columns)', async () => {
    const campaign = await outreach.createCampaign({ name: 'Verifier Health Day', services: ['registration'],
      startsAt: new Date(Date.now() - 60_000).toISOString() }, atOrganiserGroup());
    const active = await outreach.updateCampaignStatus(campaign.id, { status: 'active', reason: 'Starting the health day' },
      campaign.rowVersion, atOrganiserGroup());
    organiserCampaign.id = campaign.id;
    organiserCampaign.version = active.rowVersion;
    const registration = await outreach.create({ localCommandId: randomUUID(), temporaryPatientId: `tmp_${randomUUID()}`,
      fullName: 'Dayo Fictional', sex: 'female', ageYears: 12, phone: '+2348098765432', campaignId: campaign.id,
      consent: { textVersion: 'outreach-notice-2026-11-01', language: 'yo', method: 'guardian', guardianName: 'Efe Fictional' } },
    `verifier-${randomUUID()}`, atOrganiserGroup());
    registrationId = registration.id;
    const consent = await db.query(`select facility_id, captured_by_account_id, captured_by_membership_id, guardian_name
      from outreach.registration_consents where registration_case_id = $1`, [registrationId]);
    assert.deepEqual(consent.rows[0], { facility_id: organiser.facilityId, captured_by_account_id: organiser.accountId,
      captured_by_membership_id: organiser.membershipId, guardian_name: 'Efe Fictional' });
  });
  await step('support: appoint and close a campaign (identity.admin_* answering text)', async () => {
    const helper = await db.query(`select membership.id from identity.staff_facility_memberships membership
      join auth.accounts account on account.id = membership.account_id
      where account.email = 'chika.helper@example.test' and membership.facility_id = $1`, [organiser.facilityId]);
    const appointed = await support.appointCampaignAdmin(supportContext(), organiserCampaign.id,
      { membershipId: helper.rows[0].id, reason: 'The only admin cannot come' });
    assert.equal(appointed.alreadyAdmin, false);
    const version = Number((await db.query('select row_version from outreach.campaigns where id = $1', [organiserCampaign.id]))
      .rows[0].row_version);
    const closed = await support.closeCampaign(supportContext(), organiserCampaign.id, version, 'The health day has ended');
    assert.equal(closed.alreadyClosed, false);
  });
  await step('retention: a registration kept past its year is redacted by the identity-api sweeper', async () => {
    const backdate = await db.connect();
    try {
      await backdate.query('begin');
      await backdate.query('set local session_replication_role = replica');
      await backdate.query(`update outreach.campaigns set closed_at = clock_timestamp() - interval '366 days' where id = $1`,
        [organiserCampaign.id]);
      await backdate.query('commit');
    } finally { backdate.release(); }
    assert.equal(await sweeper.runOnce(), 1);
    const row = (await db.query('select full_name, phone from outreach.registration_cases where id = $1', [registrationId])).rows[0];
    assert.deepEqual(row, { full_name: '[redacted]', phone: null });
    assert.equal(await sweeper.runOnce(), 0);
  });
  await step('suspend: the doctor\'s group with its version; its outreach role ends, the hospital role stays', async () => {
    const row = (await support.list(supportContext(), 'pending')).organisers.find((entry) => entry.organizationId === doctorGroup.organizationId);
    const suspended = await support.suspend(supportContext(), doctorGroup.organizationId, row.version, 'Reported for a fictional reason');
    assert.equal(suspended.reviewState, 'suspended');
    const roles = await db.query(`select role_code from auth.account_roles where account_id = $1 and revoked_at is null
      order by role_code`, [ids.doctor]);
    assert.deepEqual(roles.rows.map((entry) => entry.role_code), ['doctor', 'outreach_volunteer']);
  });
  await identityDatabase.onApplicationShutdown?.();
  await outreachDatabase.onApplicationShutdown?.();
} finally {
  await db.end();
  await adminPool.query(`drop database if exists ${isolated} with (force)`).catch(() => undefined);
  await adminPool.end();
}
process.stdout.write(`\n${passed} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
