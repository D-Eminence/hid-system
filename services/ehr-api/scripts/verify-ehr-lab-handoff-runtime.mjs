#!/usr/bin/env node
// The EHR to Lab handoff of an active lab request (fix/ehr-lab-handoff-resend),
// through the real EHR API (AppModule, as hid_ehr_api_runtime, in this
// process) and the real Lab API (AppModule, as hid_lab_api_runtime, in a child
// process, so its environment is its own), on a disposable copy of the owned
// synthetic rehearsal database. Only Identity is replaced, by a local fake that
// both services call; it decides for each service separately, so EHR can save
// an order that Lab then refuses. Every database check (row-level security,
// the clinical version trigger, lab.validate_work_item, unique keys) is real.
//
// EHR commits a lab request before it asks Lab to accept it. A Lab refusal
// after that commit used to be reported as the request's own failure, and
// nothing but a same-key replay of the create sent the order again: neither an
// explicit command nor activating a draft or resuming a held request did.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { disposableDatabase, expectStatus, fakeService, startService } from '../../../scripts/service-runtime-harness.mjs';

const labService = resolve(import.meta.dirname, '../../lab-api');

if (process.argv[2] === '--lab-child') {
  // Child: the Lab API alone in its process; the parent passes its environment.
  const lab = await startService({ require: createRequire(join(labService, 'package.json')), service: labService });
  const { role } = (await lab.database.query('select current_user as role')).rows[0];
  process.stdout.write(`${JSON.stringify({ url: (await lab.app.getUrl()).replace('[::1]', '127.0.0.1'), role })}\n`);
  process.stdin.resume();
  process.stdin.on('end', async () => { await lab.close(); process.exit(0); });
} else {
  const service = resolve(import.meta.dirname, '..');
  const require = createRequire(join(service, 'package.json'));
  // Workload credentials for this run only: EHR and Lab to Identity, EHR to Lab.
  const tokens = { 'ehr-api': `ehr-identity-${randomUUID()}`, 'lab-api': `lab-identity-${randomUUID()}` };
  const labToken = `ehr-lab-${randomUUID()}`;
  const evidence = { runAs: ['hid_ehr_api_runtime', 'hid_lab_api_runtime'], database: 'disposable copy of hid_rehearsal',
    checks: [] };
  const check = (name) => evidence.checks.push(name);

  const actors = new Map();
  // Decisions per calling service, patient and scope; anything not set is denied.
  const decisions = new Map();
  const identity = await fakeService(({ path, headers, body }) => {
    const caller = headers['x-hid-internal-caller'];
    if (!Object.hasOwn(tokens, caller) || headers['x-hid-service-token'] !== tokens[caller]) {
      return [401, { code: 'WORKLOAD_AUTHENTICATION_REQUIRED', detail: 'Synthetic Identity refused the workload' }];
    }
    const actor = actors.get(String(headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!actor) return [401, { code: 'AUTHENTICATION_REQUIRED', detail: 'Unknown synthetic session' }];
    if (path === '/api/v1/auth/service-session') return [200, { actor }];
    if (path === '/api/v1/identity/service/authorization/check') {
      const facilityId = headers['x-facility-id'];
      const rule = decisions.get(`${caller}:${body.patientId}:${body.scope}`) ?? { allowed: false, breakGlass: false };
      return [200, { allowed: rule.allowed, patientId: body.patientId, facilityId,
        membershipId: actor.facilities.find((item) => item.id === facilityId)?.membershipId ?? '',
        scope: body.scope, purpose: body.purpose, breakGlass: rule.breakGlass }];
    }
    return [404, { code: 'NOT_FOUND' }];
  });

  const database = await disposableDatabase(require, 'ehrlab');
  let lab, ehr;
  try {
    const id = () => randomUUID();
    const f = { org: id(), facility: id(), patient: id(), encounter: id(),
      doctor: { account: id(), staff: id(), membership: id() } };
    f.doctor.subject = `synthetic:ehr-lab-handoff-doctor:${f.doctor.account}`;
    // A doctor at one clinic with a database consent to write the patient's
    // records there (both services' row-level security require it), and one
    // open encounter. Inserted as the owner with triggers and foreign keys off,
    // as in the SQL suites.
    await database.fixture(async (client) => {
      await client.query('insert into identity.organizations (id,name,slug) values ($1,$2,$3)',
        [f.org, 'EHR Lab Handoff Org', `ehr-lab-handoff-${f.org.slice(0, 8)}`]);
      await client.query(`insert into identity.facilities (id,organization_id,name,code,timezone,active,lifecycle_status)
        values ($1,$2,'EHR Lab Handoff Clinic',$3,'Africa/Lagos',true,'verified')`, [f.facility, f.org, `ELH-${f.facility.slice(0, 8)}`]);
      await client.query(`insert into auth.accounts (id,subject,email,display_name,status) values ($1,$2,$3,'EHR Lab Handoff Doctor','active')`,
        [f.doctor.account, f.doctor.subject, `ehr-lab-handoff-${f.doctor.account}@example.invalid`]);
      await client.query(`insert into identity.staff (id,account_id,full_name,email,verification_status,default_role)
        values ($1,$2,'EHR Lab Handoff Doctor',$3,'verified','doctor')`,
      [f.doctor.staff, f.doctor.account, `ehr-lab-handoff-${f.doctor.account}@example.invalid`]);
      await client.query(`insert into identity.staff_facility_memberships (id,staff_id,account_id,organization_id,facility_id,
        membership_role,app_role,active) values ($1,$2,$3,$4,$5,'doctor','doctor',true)`,
      [f.doctor.membership, f.doctor.staff, f.doctor.account, f.org, f.facility]);
      await client.query(`insert into identity.patients (id,hid_code,first_name,last_name,full_name,status)
        values ($1,'HID-EHRLABHD','Handoff','Patient','Handoff Patient','active')`, [f.patient]);
      await client.query(`insert into identity.purpose_of_use_codes (code,display,source_system)
        values ('direct-care','Direct patient care','ehr-lab-handoff-verifier') on conflict (code) do nothing`);
      await client.query(`insert into identity.consent_grants (id,patient_id,staff_id,account_id,membership_id,facility_id,scope,
        purpose_of_use,status,reason,starts_at,expires_at) values ($1,$2,$3,$4,$5,$6,'write_records','direct-care','active',
        'Synthetic EHR Lab handoff consent',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '30 days')`,
      [id(), f.patient, f.doctor.staff, f.doctor.account, f.doctor.membership, f.facility]);
      await client.query(`insert into ehr.encounters (id,patient_id,facility_id,created_by,created_by_membership_id,encounter_type,
        status,started_at) values ($1,$2,$3,$4,$5,'ambulatory','in_progress',clock_timestamp())`,
      [f.encounter, f.patient, f.facility, f.doctor.account, f.doctor.membership]);
    });
    actors.set('token-doctor', { id: f.doctor.account, subject: f.doctor.subject, accountId: f.doctor.account, sessionId: id(),
      roles: [], permissions: [], facilityIds: [f.facility], authenticationMethod: 'local',
      facilities: [{ id: f.facility, membershipId: f.doctor.membership, organizationId: f.org, name: 'EHR Lab Handoff Clinic',
        roles: ['doctor'], permissions: ['ehr.lab-request.read', 'ehr.lab-request.write', 'lab.work-item.accept'],
        isPrimary: true }] });
    const decide = (caller, scope, allowed) => decisions.set(`${caller}:${f.patient}:${scope}`, { allowed, breakGlass: false });
    for (const scope of ['read_records', 'write_records']) decide('ehr-api', scope, true);

    // Lab in its own process, as its runtime role.
    const shared = { NODE_ENV: 'test', PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', LANG: 'C.UTF-8', TZ: 'UTC',
      // database.url() names the socket directory but not the port.
      ...(process.env.PGPORT ? { PGPORT: process.env.PGPORT } : {}),
      CORS_ORIGINS: 'http://127.0.0.1', IDENTITY_API_URL: identity.url, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
      LAB_SERVICE_IDENTITY_MODE: 'local-secret', LAB_INTERNAL_SERVICE_TOKEN: labToken, DATABASE_POOL_MAX: '8' };
    lab = spawn(process.execPath, [import.meta.filename, '--lab-child'], { stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...shared, DATABASE_URL: database.url('hid_lab_api_runtime'), IDENTITY_LAB_INTERNAL_SERVICE_TOKEN: tokens['lab-api'] } });
    const started = await new Promise((resolveStart, reject) => {
      createInterface({ input: lab.stdout }).once('line', (line) => resolveStart(JSON.parse(line)));
      lab.once('exit', (code) => reject(new Error(`Lab exited before listening (${code})`)));
    });
    assert.equal(started.role, 'hid_lab_api_runtime');

    // EHR in this process, as its runtime role, calling that Lab.
    for (const key of Object.keys(process.env)) if (/^(LAB|IDENTITY|PHARMACY)_/.test(key)) delete process.env[key];
    Object.assign(process.env, { ...shared, DATABASE_URL: database.url('hid_ehr_api_runtime'), STORAGE_MODE: 'disabled',
      IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: tokens['ehr-api'], LAB_API_URL: started.url });
    ehr = await startService({ require, service });
    assert.deepEqual((await ehr.database.query('select current_user as role')).rows[0], { role: 'hid_ehr_api_runtime' });
    check('EHR runs as hid_ehr_api_runtime and Lab as hid_lab_api_runtime, with Identity faked per calling service');

    const base = `/ehr/patients/${f.patient}/encounters/${f.encounter}/lab-requests`;
    const call = (method, path, body, key) => ehr.request(method, `${base}${path}`, { body, headers: {
      authorization: 'Bearer token-doctor', 'x-facility-id': f.facility, 'x-purpose-of-use': 'direct-care',
      ...(key ? { 'idempotency-key': key } : {}) } });
    const key = (label) => `verifier-${label}-${id()}`;
    const order = (status) => ({ testCodeSystem: 'http://loinc.org', testCode: '718-7', testDisplay: 'Haemoglobin',
      priority: 'routine', status, clinicalInformation: 'Synthetic EHR Lab handoff order' });
    const stored = async (requestId) => (await database.owner.query(
      'select status, row_version::int as version from ehr.lab_requests where id = $1', [requestId])).rows[0];
    const workItems = async (requestId) => (await database.owner.query(
      'select id::text, source_ehr_order_version::int as version from lab.work_items where source_ehr_order_id = $1',
      [requestId])).rows;
    const savedActive = async () => (await database.owner.query(`select id::text from ehr.lab_requests
      where encounter_id = $1 and status = 'active' order by created_at`, [f.encounter])).rows.map((row) => row.id);

    // A draft is saved without contacting Lab.
    const draft = expectStatus(await call('POST', '', order('draft'), key('draft')), 201, 'create a draft lab request');
    assert.equal(draft.labWorkItem, null);
    assert.deepEqual(await stored(draft.id), { status: 'draft', version: 1 });
    check('a draft lab request is saved (201) without a Lab work item');

    // Lab refuses (its Identity decision denies) after EHR has saved the active order.
    const refused = [];
    for (const label of ['refused-1', 'refused-2']) {
      const response = await call('POST', '', order('active'), key(label));
      const problem = expectStatus(response, 409, 'create an active lab request that Lab refuses');
      assert.equal(problem.code, 'LAB_HANDOFF_REFUSED', JSON.stringify(problem));
      const [saved] = (await savedActive()).filter((requestId) => !refused.includes(requestId));
      assert.ok(saved, 'the refused order is saved as active');
      assert.match(problem.detail, new RegExp(saved));
      assert.match(problem.detail, /LAB_WORK_ITEM_ACCESS_DENIED/);
      assert.deepEqual([await stored(saved), await workItems(saved)], [{ status: 'active', version: 1 }, []]);
      refused.push(saved);
    }
    const [first, second] = refused;
    check('an active order Lab refuses is saved active at version 1 and answered 409 LAB_HANDOFF_REFUSED, naming the saved order and Lab\'s code (LAB_WORK_ITEM_ACCESS_DENIED); no work item');

    // The explicit send of the saved order, once Lab allows it.
    decide('lab-api', 'write_records', true);
    const send = (requestId, expectedRowVersion) => call('POST', `/${requestId}/lab-work-item`, { expectedRowVersion },
      key('send'));
    const accepted = expectStatus(await send(first, 1), 201, 'send the saved active order to Lab');
    assert.deepEqual([accepted.sourceEhrOrderId, accepted.sourceEhrOrderVersion, accepted.status], [first, 1, 'accepted']);
    assert.equal(expectStatus(await send(first, 1), 201, 'send the same order again').id, accepted.id);
    assert.equal(expectStatus(await send(first, 2), 412, 'send at a version that is not stored').code,
      'LAB_REQUEST_VERSION_CONFLICT');
    assert.deepEqual(await workItems(first), [{ id: accepted.id, version: 1 }]);
    check('POST .../lab-work-item sends a saved active order (201, one work item at version 1); sending again returns the same work item (201); a version that is not stored is 412 LAB_REQUEST_VERSION_CONFLICT');
    assert.equal(expectStatus(await call('POST', `/${draft.id}/lab-work-item`, { expectedRowVersion: 1 }, key('send')), 409,
      'send a draft to Lab').code, 'LAB_REQUEST_NOT_ELIGIBLE');
    assert.deepEqual(await workItems(draft.id), []);
    check('a draft cannot be sent to Lab: 409 LAB_REQUEST_NOT_ELIGIBLE, no work item');

    // Activating a draft and resuming a held order send the current version.
    const patch = (requestId, body) => call('PATCH', `/${requestId}`, { changeReason: 'Synthetic clinical review', ...body });
    const activated = expectStatus(await patch(draft.id, { status: 'active', expectedRowVersion: 1 }), 200, 'activate the draft');
    assert.deepEqual([activated.status, Number(activated.rowVersion), activated.labHandoff?.state,
      activated.labWorkItem?.sourceEhrOrderVersion], ['active', 2, 'accepted', 2], JSON.stringify(activated));
    assert.deepEqual((await workItems(draft.id)).map((item) => item.version), [2]);
    const held = expectStatus(await patch(second, { status: 'on_hold', expectedRowVersion: 1 }), 200, 'hold a refused order');
    assert.deepEqual([held.labHandoff, held.labWorkItem], [null, null]);
    assert.deepEqual(await workItems(second), []);
    const resumed = expectStatus(await patch(second, { status: 'active', expectedRowVersion: 2 }), 200, 'resume the held order');
    assert.deepEqual([Number(resumed.rowVersion), resumed.labHandoff?.state, resumed.labWorkItem?.sourceEhrOrderVersion],
      [3, 'accepted', 3], JSON.stringify(resumed));
    assert.deepEqual((await workItems(second)).map((item) => item.version), [3]);
    check('activating a draft (PATCH, version 2) and resuming a held order (version 3) each send the current version: labHandoff accepted, one work item at that version; holding sends nothing');

    // Lab holds one work item per order: a later edit is reported, not sent as a second one.
    const edited = expectStatus(await patch(draft.id, { priority: 'stat', expectedRowVersion: 2 }), 200,
      'edit an order Lab accepted');
    assert.deepEqual([Number(edited.rowVersion), edited.labHandoff, edited.labWorkItem],
      [3, { state: 'already_accepted', code: 'LAB_ORDER_ALREADY_ACCEPTED' }, null], JSON.stringify(edited));
    assert.deepEqual((await workItems(draft.id)).map((item) => item.version), [2]);
    check('an edit of an accepted order (priority, version 3) commits and reports labHandoff already_accepted (Lab 409 LAB_ORDER_ALREADY_ACCEPTED); Lab keeps its one work item at version 2');

    await ehr.close();
    ehr = undefined;
    lab.stdin.end();
    await new Promise((resolveExit) => lab.exitCode !== null ? resolveExit() : lab.once('exit', resolveExit));
    lab = undefined;
    assert.equal(await database.deadlocks(), 0, 'PostgreSQL detected a deadlock during the run');
    check('no deadlock: pg_stat_database reports none for the run');
    process.stdout.write(`${JSON.stringify({ status: 'passed', ...evidence })}\n`);
  } finally {
    await ehr?.close();
    if (lab) {
      lab.stdin.end();
      await new Promise((resolveExit) => lab.exitCode !== null ? resolveExit() : lab.once('exit', resolveExit));
    }
    await database.close();
    await identity.close();
  }
}
