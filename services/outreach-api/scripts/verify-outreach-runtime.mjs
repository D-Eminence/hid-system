#!/usr/bin/env node
// Phase 4 Stage 9: campaign-linked Outreach registration through the real
// Outreach API (guard, runtime controls, controller, service, DatabaseService,
// audit) as hid_outreach_api_runtime, on a disposable copy of the owned
// synthetic rehearsal. Before Stage 9 every campaign-linked registration failed
// with 42501: it share-locked the actor's campaign membership row, which the
// runtime role cannot update. It now share-locks only the campaign, so a
// campaign status change (FOR UPDATE) and a registration still cannot
// interleave. Only the Identity API is replaced, by a local fake; every
// database check (row-level security, the 0077 guards, unique constraints) is real.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { disposableDatabase, expectStatus, fakeService, startService } from '../../../scripts/service-runtime-harness.mjs';

const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const RUNTIME_ROLE = 'hid_outreach_api_runtime';
const IDENTITY_TOKEN = 'public-synthetic-identity-outreach-token-01';
const evidence = { runAs: RUNTIME_ROLE, database: 'disposable copy of hid_rehearsal', checks: [] };
const check = (name) => evidence.checks.push(name);

const actors = new Map();
const identity = await fakeService(({ path, headers, body }) => {
  if (headers['x-hid-internal-caller'] !== 'outreach-api' || headers['x-hid-service-token'] !== IDENTITY_TOKEN) {
    return [401, { code: 'WORKLOAD_AUTHENTICATION_REQUIRED', detail: 'Synthetic Identity refused the workload' }];
  }
  const actor = actors.get(String(headers.authorization ?? '').replace(/^Bearer /, ''));
  if (!actor) return [401, { code: 'AUTHENTICATION_REQUIRED', detail: 'Unknown synthetic session' }];
  if (path === '/api/v1/identity/outreach/authorize') {
    const assignment = actor.facilities.find((item) => item.id === headers['x-facility-id']);
    if (!assignment?.permissions.includes(body.permission)) return [403, { code: 'PERMISSION_DENIED', detail: 'Permission denied' }];
    return [200, { authorized: true, actor }];
  }
  return [404, { code: 'NOT_FOUND' }];
});

const database = await disposableDatabase(require, 'outreach');
for (const key of Object.keys(process.env)) if (/^(OUTREACH|IDENTITY)_/.test(key)) delete process.env[key];
Object.assign(process.env, { DATABASE_URL: database.url(RUNTIME_ROLE), DATABASE_POOL_MAX: '8', IDENTITY_API_URL: identity.url,
  OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: IDENTITY_TOKEN });
let outreach;
try {
  const id = () => randomUUID();
  const f = { org: id(), facility: id(), campaign: id(), closedCampaign: id(),
    a: { account: id(), staff: id(), membership: id() }, b: { account: id(), staff: id(), membership: id() } };
  f.a.subject = `synthetic:outreach-verifier-a:${f.a.account}`;
  f.b.subject = `synthetic:outreach-verifier-b:${f.b.account}`;
  await database.fixture(async (client) => {
    await client.query('insert into identity.organizations (id,name,slug) values ($1,$2,$3)',
      [f.org, 'Outreach Verifier Org', `outreach-verifier-${f.org.slice(0, 8)}`]);
    await client.query(`insert into identity.facilities (id,organization_id,name,code,timezone,active,lifecycle_status)
      values ($1,$2,'Outreach Verifier Clinic',$3,'Africa/Lagos',true,'verified')`, [f.facility, f.org, `OR-${f.facility.slice(0, 8)}`]);
    // A and B are doctors of the clinic (the doctor role carries the Outreach
    // registration and campaign permissions); only A is a campaign member.
    for (const [name, member] of [['a', f.a], ['b', f.b]]) {
      await client.query(`insert into auth.accounts (id,subject,email,display_name,status) values ($1,$2,$3,$4,'active')`,
        [member.account, member.subject, `outreach-verifier-${name}-${member.account}@example.invalid`, `Outreach Verifier ${name}`]);
      await client.query(`insert into identity.staff (id,account_id,full_name,email,verification_status,default_role)
        values ($1,$2,$3,$4,'verified','doctor')`, [member.staff, member.account, `Outreach Verifier ${name}`,
        `outreach-verifier-${name}-${member.account}@example.invalid`]);
      await client.query(`insert into identity.staff_facility_memberships (id,staff_id,account_id,organization_id,facility_id,
        membership_role,app_role) values ($1,$2,$3,$4,$5,'doctor','doctor')`, [member.membership, member.staff, member.account, f.org, f.facility]);
      await client.query(`insert into auth.account_roles (id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
        values ($1,$2,'doctor','facility',$3,$4,'Synthetic Outreach verifier role')`, [id(), member.account, member.membership, f.facility]);
    }
    for (const [campaign, status] of [[f.campaign, 'active'], [f.closedCampaign, 'closed']]) {
      await client.query(`insert into outreach.campaigns (id,facility_id,created_by_account_id,created_by_membership_id,name,services,
        starts_at,status) values ($1,$2,$3,$4,$5,array['registration']::text[],clock_timestamp()-interval '1 day',$6)`,
      [campaign, f.facility, f.a.account, f.a.membership, `Outreach Verifier ${status} campaign`, status]);
      await client.query(`insert into outreach.campaign_members (campaign_id,facility_id,membership_id,role,added_by_account_id,
        added_by_membership_id) values ($1,$2,$3,'enumerator',$4,$3)`, [campaign, f.facility, f.a.membership, f.a.account]);
    }
  });
  const permissions = ['outreach.registration.write', 'outreach.registration.read', 'outreach.campaign.write', 'outreach.campaign.read'];
  const actor = (member, granted) => ({ id: member.account, subject: member.subject, accountId: member.account,
    sessionId: id(), roles: [], permissions: [], facilityIds: [f.facility], authenticationMethod: 'local',
    facilities: [{ id: f.facility, membershipId: member.membership, organizationId: f.org, name: 'Outreach Verifier Clinic',
      roles: ['doctor'], permissions: granted, isPrimary: true }] });
  actors.set('token-a', actor(f.a, permissions));
  actors.set('token-b', actor(f.b, permissions));
  actors.set('token-a-read-only', actor(f.a, ['outreach.registration.read', 'outreach.campaign.read']));

  outreach = await startService({ require, service, bodyLimit: 256 * 1024 });
  assert.deepEqual((await outreach.database.query('select current_user as role')).rows[0], { role: RUNTIME_ROLE });
  check('the API runs as hid_outreach_api_runtime');
  const send = (path, body, { token = 'token-a', key, headers = {}, correlationId } = {}) => outreach.request('POST',
    `/outreach/registration-cases${path}`, { body, correlationId, headers: { authorization: `Bearer ${token}`,
      'x-facility-id': f.facility, 'x-purpose-of-use': 'direct-care', ...(key ? { 'idempotency-key': key } : {}), ...headers } });
  const key = (label) => `verifier-${label}-${id()}`;
  const registration = (campaignId = f.campaign, overrides = {}) => {
    const local = id();
    return { localCommandId: local, campaignId, temporaryPatientId: `tmp_${local}`, fullName: 'Synthetic Outreach Person',
      sex: 'unknown', ageYears: 34, ...overrides };
  };
  const casesOf = (campaignId) => database.count('select count(*) from outreach.registration_cases where campaign_id=$1', [campaignId]);
  const together = (size, request) => Promise.all(Array.from({ length: size }, request));

  // Denials and wrong state: nothing is written.
  expectStatus(await send('', registration(), { token: 'token-a-read-only', key: key('register') }), 403, 'register without the permission');
  assert.equal(expectStatus(await send('', registration(), { token: 'token-b', key: key('register') }), 403,
    'register as a non-member').code, 'OUTREACH_CAMPAIGN_ACCESS_DENIED');
  assert.equal(expectStatus(await send('', registration(id()), { key: key('register') }), 403, 'register for an unknown campaign').code,
    'OUTREACH_CAMPAIGN_ACCESS_DENIED');
  assert.equal(expectStatus(await send('', registration(f.closedCampaign), { key: key('register') }), 409,
    'register for a closed campaign').code, 'OUTREACH_CAMPAIGN_NOT_ACCEPTING_REGISTRATIONS');
  assert.deepEqual([await casesOf(f.campaign), await casesOf(f.closedCampaign)], [0, 0]);
  check('register: missing permission 403, non-member 403, unknown campaign 403, closed campaign 409, nothing written');

  // Authorized success, replay, key reuse, concurrent identical requests.
  const body = registration();
  const registerKey = key('register');
  const created = expectStatus(await send('', body, { key: registerKey }), 201, 'campaign-linked registration');
  assert.equal((await database.owner.query('select campaign_id::text from outreach.registration_cases where id=$1', [created.id])).rows[0]
    .campaign_id, f.campaign);
  assert.equal(expectStatus(await send('', body, { key: registerKey }), 201, 'registration replay').id, created.id);
  assert.equal(expectStatus(await send('', { ...body, ageYears: 35 }, { key: registerKey }), 409, 'registration key reuse').code,
    'IDEMPOTENCY_CONFLICT');
  const concurrentBody = registration();
  const concurrentKey = key('register');
  const concurrent = await together(4, () => send('', concurrentBody, { key: concurrentKey }));
  for (const response of concurrent) expectStatus(response, 201, 'four concurrent identical registrations');
  assert.equal(new Set(concurrent.map((response) => response.body.id)).size, 1);
  assert.equal(await database.count('select count(*) from outreach.registration_cases where local_command_id=$1',
    [concurrentBody.localCommandId]), 1);
  check('register: 201 linked to the campaign; replay 201; key reuse 409; four concurrent identical registrations create one case and all return it');

  // A status change holds the campaign lock: the registration waits for it.
  const waitForLock = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await database.count(`select count(*) from pg_stat_activity where datname=current_database()
        and wait_event_type='Lock' and query like '%for share of campaign%'`);
      if (waiting > 0) return;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error('The registration never waited for the campaign lock');
  };
  const holder = await database.owner.connect();
  try {
    await holder.query('begin');
    await holder.query('select id from outreach.campaigns where id=$1 for update', [f.campaign]);
    const pending = send('', registration(), { key: key('register') });
    await waitForLock();
    await holder.query('rollback');
    expectStatus(await pending, 201, 'registration after a lock holder that changed nothing');
    await holder.query('begin');
    await holder.query('select id from outreach.campaigns where id=$1 for update', [f.campaign]);
    const blocked = send('', registration(), { key: key('register') });
    await waitForLock();
    await holder.query('set local session_replication_role = replica');
    await holder.query("update outreach.campaigns set status='closed', row_version=row_version+1 where id=$1", [f.campaign]);
    await holder.query('commit');
    const refused = await blocked;
    assert.equal(expectStatus(refused, 409, 'registration that waited for the campaign to close').code,
      'OUTREACH_CAMPAIGN_NOT_ACCEPTING_REGISTRATIONS');
  } finally { holder.release(); }
  assert.equal(await casesOf(f.campaign), 3);
  check('register: a registration waits for a concurrent campaign status change; after a rollback it registers (201), after the campaign closes it is refused (409)');

  // Rollback: the outbox insert of one registration fails after its case,
  // event and idempotency rows.
  await database.fixture((client) => client.query("update outreach.campaigns set status='active', row_version=row_version+1 where id=$1",
    [f.campaign]));
  await database.owner.query(`create function public.verifier_fail_outreach_outbox() returns trigger language plpgsql security definer as $f$
    begin if new.correlation_id = 'verifier-rollback-outreach-0001' then
      raise exception using errcode = 'P0001', message = 'Synthetic outbox failure'; end if; return new; end $f$`);
  await database.owner.query(`create trigger verifier_fail_outreach_outbox before insert on outreach.outbox_events
    for each row execute function public.verifier_fail_outreach_outbox()`);
  const rollbackBody = registration();
  const rollbackKey = key('rollback');
  const failed = await send('', rollbackBody, { key: rollbackKey, correlationId: 'verifier-rollback-outreach-0001' });
  expectStatus(failed, 500, 'registration with a failing outbox insert');
  assert.equal(failed.sqlstate, 'P0001');
  assert.deepEqual(await Promise.all([
    database.count('select count(*) from outreach.registration_cases where local_command_id=$1', [rollbackBody.localCommandId]),
    database.count('select count(*) from outreach.command_idempotency where idempotency_key=$1', [rollbackKey])]), [0, 0]);
  expectStatus(await send('', rollbackBody, { key: rollbackKey }), 201, 'registration after the failure');
  check('register: a failure after the case insert rolls back the case, event and idempotency record; the same key then succeeds');
  process.stdout.write(`${JSON.stringify({ status: 'passed', ...evidence })}\n`);
} finally {
  await outreach?.close();
  await database.close();
  await identity.close();
}
