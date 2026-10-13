#!/usr/bin/env node
// A browser cookie session using Outreach: Outreach (real AppModule, as
// hid_outreach_api_runtime) authorizes every request through Identity (real
// AppModule, as hid_identity_api_runtime, in a child process) over HTTP,
// forwarding the browser's cookie. A same-origin GET carries no Origin and no
// X-CSRF-Token, so neither Outreach nor Identity may demand them for a read
// that Outreach, authenticated as a workload, reports; a browser write must
// still prove Origin and CSRF. Campaign reads are authorized; campaign writes
// stay refused until campaigns have their own governance (ADR-045). Staff
// sign in with the password and then an authenticator (MFA-1, 0088).
// Disposable copy of the owned synthetic rehearsal database; synthetic
// accounts only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { childOutboxLine, enrollmentCodeOutbox, fetchTransport, readChildOutbox, staffClient,
  SYNTHETIC_STAFF_MFA_KEY_B64 } from '../../identity-api/scripts/staff-session-client.mjs';

const ORIGIN = 'https://staging.healthidentitydirectory.com';
// Local-secret workload credentials, generated for this run only.
const outreachWorkloadCredential = `${randomUUID()}${randomUUID()}`;
const ehrWorkloadCredential = `${randomUUID()}${randomUUID()}`;
const identityService = resolve(import.meta.dirname, '../../identity-api');

/**
 * A copy of the owned synthetic rehearsal database, on the rehearsal's private
 * socket-only cluster, dropped by close(). `url(role)` connects as the
 * rehearsal admin and starts every session as `role` (the libpq startup
 * option), as a login of that role would.
 */
async function disposableDatabase(require) {
  const socket = process.env.PGHOST;
  assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
    && process.env.PGDATABASE === 'hid_rehearsal' && process.env.PGUSER,
  'Only the owned synthetic rehearsal is supported');
  const { Client, Pool } = require('pg');
  const admin = process.env.PGUSER;
  const name = `hid_rehearsal_outreach_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const maintenance = new Client({ host: socket, user: admin, database: 'postgres' });
  await maintenance.connect();
  await maintenance.query(`create database ${name} template hid_rehearsal`);
  const owner = new Pool({ host: socket, user: admin, database: name, max: 4 });
  owner.on('error', () => undefined);
  return {
    owner,
    url: (role) => `postgresql://${encodeURIComponent(admin)}@localhost/${name}?host=${encodeURIComponent(socket)}`
      + `&options=${encodeURIComponent(`-c role=${role}`)}`,
    close: async () => {
      await owner.end();
      await maintenance.query(`drop database if exists ${name} with (force)`);
      await maintenance.end();
    },
  };
}

/**
 * The service's real AppModule, loaded with ts-node and served on 127.0.0.1
 * with its main.ts request pipeline (global prefix, cookie and JSON body
 * parsers, validation pipe, problem filter). CORS and helmet only set
 * browser response headers and are left out; in production Outreach's CORS
 * layer also refuses a disallowed Origin before the guard runs.
 */
async function startService({ require, service, override }) {
  require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
  require('reflect-metadata');
  const load = (path) => require(join(service, 'src', path));
  const { Test } = require('@nestjs/testing');
  const { ValidationPipe } = require('@nestjs/common');
  const { AppModule } = load('app.module.ts');
  const { DatabaseService } = load('database/database.service.ts');
  const { DomainProblem, ProblemDetailsFilter } = load('common/problem.ts');
  const { preventResponseCaching } = load('common/response-security.middleware.ts');
  const builder = Test.createTestingModule({ imports: [AppModule] });
  const module = await (override ? override(builder, load) : builder).compile();
  const app = module.createNestApplication({ bodyParser: false, logger: false });
  app.setGlobalPrefix('api/v1');
  app.use(preventResponseCaching);
  app.use(require('cookie-parser')());
  app.useBodyParser('json', { limit: 256 * 1024, strict: true, type: ['application/json', 'application/*+json'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
    exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
      errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.listen(0, '127.0.0.1');
  return { app, database: module.get(DatabaseService), close: () => app.close() };
}

if (process.argv[2] === '--identity-child') {
  // Child: the Identity API, alone in its process so its environment is its own.
  // A staff enrolment code (MFA-1) is reported on stdout instead of being sent.
  const app = await startService({ require: createRequire(join(identityService, 'package.json')),
    service: identityService, override: (builder, load) => builder
      .overrideProvider(load('auth/notification-otp.client.ts').NotificationOtpClient).useValue({
        deliver: async (input) => {
          if (input.purpose !== 'LOGIN_STEP_UP') throw new Error(`Unexpected ${input.purpose} delivery`);
          process.stdout.write(childOutboxLine(input));
          return { outcome: 'accepted', provider: 'synthetic' };
        } }) });
  process.stdout.write(`${JSON.stringify({ url: (await app.app.getUrl()).replace('[::1]', '127.0.0.1') })}\n`);
  process.stdin.resume();
  process.stdin.on('end', async () => { await app.close(); process.exit(0); });
} else {
  const service = resolve(import.meta.dirname, '..');
  const require = createRequire(join(service, 'package.json'));
  const database = await disposableDatabase(require);
  let identity, outreach;
  try {
    // Fixture: a doctor at one facility and a patient account. Outreach is off
    // at launch (D17): 0091 withdraws every Outreach permission from every
    // role and starts outreach_portal_enabled off. This copy opts in as
    // Outreach's re-enabling migration would (ADR-058): it grants the doctor
    // role the Outreach permissions it held before 0091 (0024, 0038) and turns
    // the portal on.
    // Outreach has no password hashing of its own; hash the synthetic password with Identity's argon2.
    const argon2 = createRequire(join(identityService, 'package.json'))('argon2');
    const password = 'Synthetic-Outreach-Password-2026';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const ids = { org: randomUUID(), facility: randomUUID(), doctorAccount: randomUUID(), doctor: randomUUID(),
      membership: randomUUID(), patientAccount: randomUUID(), patient: randomUUID() };
    const doctorEmail = `doctor-${ids.doctorAccount}@example.invalid`;
    const patientEmail = `patient-${ids.patientAccount}@example.invalid`;
    const { owner } = database;
    await owner.query(`insert into auth.role_permissions(role_code,permission_code)
      select 'doctor',code from unnest($1::text[]) code on conflict do nothing`,
    [['outreach.registration.read', 'outreach.registration.write', 'outreach.campaign.read', 'outreach.campaign.write']]);
    await owner.query(`update platform.control_settings set enabled=true, reason='Outreach cookie verifier opt-in',
      row_version=row_version+1, updated_at=clock_timestamp() where control_key='outreach_portal_enabled' and not enabled`);
    await owner.query("insert into identity.organizations(id,name,slug) values($1,'Outreach Rehearsal Org',$2)", [ids.org, `outreach-${ids.org}`]);
    await owner.query(`insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
      values($1,$2,'Outreach Rehearsal Hospital',$3,'Africa/Lagos',true,'verified')`, [ids.facility, ids.org, `OUT-${ids.facility.slice(0, 6)}`]);
    await owner.query(`insert into auth.accounts(id,subject,email,display_name,status,password_hash,password_algorithm)
      values($1,$2,$3,'Synthetic doctor','active',$4,'argon2id')`, [ids.doctorAccount, `synthetic:doctor:${ids.doctorAccount}`, doctorEmail, passwordHash]);
    await owner.query(`insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
      values($1,$2,'Synthetic doctor',$3,'verified','doctor')`, [ids.doctor, ids.doctorAccount, doctorEmail]);
    await owner.query(`insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,app_role,is_primary,active)
      values($1,$2,$3,$4,$5,'doctor','doctor',true,true)`, [ids.membership, ids.doctor, ids.doctorAccount, ids.org, ids.facility]);
    await owner.query(`insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
      values($1,$2,'doctor','facility',$3,$4,'Synthetic rehearsal role')`, [randomUUID(), ids.doctorAccount, ids.membership, ids.facility]);
    await owner.query(`insert into auth.accounts(id,subject,email,display_name,status,password_hash,password_algorithm)
      values($1,$2,$3,'Synthetic patient','active',$4,'argon2id')`, [ids.patientAccount, `synthetic:patient:${ids.patientAccount}`, patientEmail, passwordHash]);
    await owner.query(`insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status)
      values($1,$2,'HID-RTRCHAA2','Ada','Outreach','Ada Outreach','active')`, [ids.patient, ids.patientAccount]);

    // Identity in its own process, as its runtime role.
    const shared = { NODE_ENV: 'test', PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', LANG: 'C.UTF-8', TZ: 'UTC',
      // database.url() names the socket directory but not the port.
      ...(process.env.PGPORT ? { PGPORT: process.env.PGPORT } : {}), CORS_ORIGINS: ORIGIN };
    identity = spawn(process.execPath, [import.meta.filename, '--identity-child'], { stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...shared, DATABASE_URL: database.url('hid_identity_api_runtime'), AUTH_MODE: 'local',
        IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: outreachWorkloadCredential,
        IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: ehrWorkloadCredential,
        AUTH_SIGNING_SECRET: process.env.AUTH_SIGNING_SECRET, AUTH_LOGIN_PEPPER: process.env.AUTH_LOGIN_PEPPER,
        OTP_HMAC_KEY_B64: process.env.OTP_HMAC_KEY_B64, AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'staging',
        NIN_PROVIDER_MODE: 'deferred', TURNSTILE_MODE: 'disabled',
        MFA_SECRET_KEY_B64: SYNTHETIC_STAFF_MFA_KEY_B64, MFA_KEY_VERSION: 'outreach-cookie-runtime-v1' } });
    const identityLines = createInterface({ input: identity.stdout });
    const staffEnrollmentCodes = enrollmentCodeOutbox();
    const started = await new Promise((resolveStart, reject) => {
      identityLines.once('line', (line) => resolveStart(JSON.parse(line)));
      identity.once('exit', (code) => reject(new Error(`Identity exited before listening (${code})`)));
    });
    readChildOutbox(identityLines, staffEnrollmentCodes);
    const identityUrl = `${started.url}/api/v1`;

    // Outreach in this process, as its runtime role, authorizing through that Identity.
    delete process.env.OUTREACH_DATABASE_URL;
    Object.assign(process.env, { ...shared, DATABASE_URL: database.url('hid_outreach_api_runtime'),
      IDENTITY_API_URL: started.url, OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
      OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: outreachWorkloadCredential });
    outreach = await startService({ require, service });
    const roles = await outreach.database.query('select current_user as role');
    assert.equal(roles.rows[0].role, 'hid_outreach_api_runtime');

    const call = async (base, method, path, headers = {}, body) => {
      const response = await fetch(`${base}${path}`, { method, headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
    };
    // Staff: the password, then the authenticator, enrolled with an emailed code on the first sign-in (MFA-1).
    const staff = staffClient({ send: fetchTransport(identityUrl), origin: ORIGIN, password, outbox: staffEnrollmentCodes });
    const signIn = async (path, email, action) => {
      if (path === '/auth/login') {
        const signedIn = await staff.signIn(email, { action });
        return { cookie: signedIn.cookie, csrf: signedIn.csrf, access: signedIn.cookies.hid_access };
      }
      const response = await call(identityUrl, 'POST', path, { origin: ORIGIN },
        { email, password, turnstileAction: action });
      assert.equal(response.status, 200, `${action}: ${JSON.stringify(response.body)}`);
      const cookies = response.headers.getSetCookie().map((value) => value.split(';')[0]);
      return { cookie: cookies.join('; '), csrf: response.headers.get('x-csrf-token'),
        access: cookies.find((value) => value.startsWith('hid_access='))?.slice('hid_access='.length) };
    };
    const checks = [];
    const doctor = await signIn('/auth/login', doctorEmail, 'staff-login');
    const patient = await signIn('/auth/patient/login', patientEmail, 'patient-login');
    const base = `${(await outreach.app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1/outreach/registration-cases`;
    const browser = { cookie: doctor.cookie, 'x-facility-id': ids.facility };

    // 1. Same-origin browser reads: cookie only, no Origin, no X-CSRF-Token.
    const firstList = await call(base, 'GET', '', browser);
    assert.equal(firstList.status, 200, `same-origin cookie GET of registration cases: ${firstList.status} ${JSON.stringify(firstList.body)}`);
    assert(Array.isArray(firstList.body), JSON.stringify(firstList.body));
    const firstCampaigns = await call(base, 'GET', '/campaigns', browser);
    assert.equal(firstCampaigns.status, 200, `same-origin cookie GET of campaigns: ${firstCampaigns.status} ${JSON.stringify(firstCampaigns.body)}`);
    checks.push('same-origin cookie GETs of registration cases and campaigns (no Origin, no CSRF) are authorized through Identity');

    // 2. Browser writes with Origin and the session's CSRF token, then the
    //    written case and campaign read back with the cookie alone.
    const write = { ...browser, origin: ORIGIN, 'x-csrf-token': doctor.csrf };
    const caseInput = { localCommandId: randomUUID(), temporaryPatientId: `tmp_${randomUUID()}`,
      fullName: 'Synthetic Outreach Person', sex: 'unknown', ageYears: 30 };
    const created = await call(base, 'POST', '', { ...write, 'idempotency-key': randomUUID() }, caseInput);
    assert.equal(created.status, 201, `cookie write with Origin and CSRF: ${JSON.stringify(created.body)}`);
    const listed = await call(base, 'GET', '', browser);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert(listed.body.some((item) => item.id === created.body.id), JSON.stringify(listed.body));
    const fetched = await call(base, 'GET', `/${created.body.id}`, browser);
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.temporaryPatientId, caseInput.temporaryPatientId);
    const withOrigin = await call(base, 'GET', '', { ...browser, origin: ORIGIN });
    assert.equal(withOrigin.status, 200, JSON.stringify(withOrigin.body));
    checks.push('a cookie write with Origin and CSRF creates a registration case, which the cookie alone then lists and reads');

    // 3. Campaigns. No campaign route can write one, so the doctor's campaign
    //    is seeded in the doctor's own database context, as createCampaign
    //    writes it: the campaign, with its creator as its admin member.
    const seeded = await owner.connect();
    let campaignId;
    try {
      await seeded.query('begin');
      await seeded.query(`select set_config('app.actor_subject',$1,true),set_config('app.facility_id',$2,true),
        set_config('app.correlation_id',$3,true),set_config('app.membership_id',$4,true),
        set_config('app.purpose_of_use','direct-care',true)`,
      [`synthetic:doctor:${ids.doctorAccount}`, ids.facility, `outreach-${randomUUID()}`, ids.membership]);
      campaignId = (await seeded.query(`insert into outreach.campaigns
        (facility_id,created_by_account_id,created_by_membership_id,name,services,starts_at)
        values ($1,$2,$3,'Synthetic outreach campaign',array['registration'],clock_timestamp()) returning id`,
      [ids.facility, ids.doctorAccount, ids.membership])).rows[0].id;
      await seeded.query(`insert into outreach.campaign_members
        (campaign_id,facility_id,membership_id,role,added_by_account_id,added_by_membership_id)
        values ($1,$2,$3,'admin',$4,$3)`, [campaignId, ids.facility, ids.membership, ids.doctorAccount]);
      await seeded.query('commit');
    } catch (error) {
      await seeded.query('rollback');
      throw error;
    } finally { seeded.release(); }
    const campaigns = await call(base, 'GET', '/campaigns', browser);
    assert.equal(campaigns.status, 200, JSON.stringify(campaigns.body));
    assert(campaigns.body.some((item) => item.id === campaignId), JSON.stringify(campaigns.body));
    const members = await call(base, 'GET', `/campaigns/${campaignId}/members`, browser);
    assert.equal(members.status, 200, JSON.stringify(members.body));
    assert.deepEqual(members.body.map((item) => [item.membershipId, item.role]), [[ids.membership, 'admin']]);
    const bearer = await call(base, 'GET', '/campaigns', { authorization: `Bearer ${doctor.access}`, 'x-facility-id': ids.facility });
    assert.equal(bearer.status, 200, `bearer GET of campaigns: ${JSON.stringify(bearer.body)}`);
    // Every campaign write is refused, even with Origin and the session's CSRF
    // token: Identity does not authorize outreach.campaign.write.
    const closedWrite = async (path, body, headers = {}) => {
      const response = await call(base, 'POST', path, { ...write, ...headers }, body);
      assert.equal(response.status, 400, `${path}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.code, 'VALIDATION_FAILED', path);
    };
    await closedWrite('/campaigns', { name: 'Synthetic outreach campaign 2', services: ['registration'],
      startsAt: new Date().toISOString() });
    await closedWrite(`/campaigns/${campaignId}/status`, { status: 'closed', reason: 'Synthetic campaign closure' },
      { 'if-match': '"1"' });
    await closedWrite(`/campaigns/${campaignId}/members`, { membershipId: ids.membership, role: 'admin' });
    const unchanged = await call(base, 'GET', '/campaigns', browser);
    assert.deepEqual(unchanged.body.map((item) => [item.id, item.status, item.rowVersion]), [[campaignId, 'planned', 1]]);
    checks.push('the cookie alone lists a campaign and its members, and a bearer read of campaigns is authorized; a campaign create, status change or member add is refused with Origin and CSRF (400 VALIDATION_FAILED) and changes nothing');

    // 4. Refusals: a disallowed Origin, and writes without their evidence.
    const crossOrigin = await call(base, 'GET', '', { ...browser, origin: 'https://attacker.example' });
    assert.equal(crossOrigin.status, 403, JSON.stringify(crossOrigin.body)); assert.equal(crossOrigin.body.code, 'ORIGIN_DENIED');
    const refusedWrite = async (headers, label) => {
      const response = await call(base, 'POST', '', { ...browser, ...headers, 'idempotency-key': randomUUID() },
        { ...caseInput, localCommandId: randomUUID(), temporaryPatientId: `tmp_${randomUUID()}` });
      assert.equal(response.status, 403, `${label}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.code, 'CSRF_VALIDATION_FAILED', label);
    };
    await refusedWrite({ origin: ORIGIN }, 'write without CSRF');
    await refusedWrite({ 'x-csrf-token': doctor.csrf }, 'write without Origin');
    await refusedWrite({ origin: ORIGIN, 'x-csrf-token': 'not-the-session-csrf-token' }, 'write with a wrong CSRF token (refused by Identity)');
    checks.push('a cookie read naming a disallowed Origin is 403 ORIGIN_DENIED; a cookie write without CSRF, without Origin, or with a wrong CSRF token is 403 CSRF_VALIDATION_FAILED');

    // 5. Authentication and scope are unchanged.
    const anonymous = await call(base, 'GET', '', { 'x-facility-id': ids.facility });
    assert.equal(anonymous.status, 401, JSON.stringify(anonymous.body)); assert.equal(anonymous.body.code, 'AUTHENTICATION_REQUIRED');
    const forged = await call(base, 'GET', '', { cookie: 'hid_access=forged-session-token', 'x-facility-id': ids.facility });
    assert.equal(forged.status, 401, JSON.stringify(forged.body));
    const asPatient = await call(base, 'GET', '', { cookie: patient.cookie, 'x-facility-id': ids.facility });
    assert.equal(asPatient.status, 403, JSON.stringify(asPatient.body)); assert.equal(asPatient.body.code, 'PATIENT_SCOPE_DENIED');
    checks.push('a read with no session is 401, with a forged cookie 401 from Identity, and with a patient session 403 PATIENT_SCOPE_DENIED');

    // 6. Identity trusts a reported read only from the authenticated Outreach
    //    workload, and then authorizes only a read permission.
    const authorize = (headers, permission = 'outreach.registration.read') => call(identityUrl, 'POST',
      '/identity/outreach/authorize', { cookie: doctor.cookie, 'x-facility-id': ids.facility,
        'x-purpose-of-use': 'direct-care', 'x-hid-internal-caller': 'outreach-api', ...headers }, { permission });
    const trusted = await authorize({ 'x-hid-service-token': outreachWorkloadCredential, 'x-hid-original-method': 'GET' });
    assert.equal(trusted.status, 201, JSON.stringify(trusted.body)); assert.equal(trusted.body.authorized, true);
    const forgedWorkload = await authorize({ 'x-hid-service-token': 'not-the-workload-token-000000000000000', 'x-hid-original-method': 'GET' });
    assert.equal(forgedWorkload.status, 403, JSON.stringify(forgedWorkload.body)); assert.equal(forgedWorkload.body.code, 'ORIGIN_DENIED');
    const unreported = await authorize({ 'x-hid-service-token': outreachWorkloadCredential });
    assert.equal(unreported.status, 403, JSON.stringify(unreported.body)); assert.equal(unreported.body.code, 'ORIGIN_DENIED');
    const readForWrite = await authorize({ 'x-hid-service-token': outreachWorkloadCredential, 'x-hid-original-method': 'GET' },
      'outreach.registration.write');
    assert.equal(readForWrite.status, 403, JSON.stringify(readForWrite.body)); assert.equal(readForWrite.body.code, 'CSRF_VALIDATION_FAILED');
    const otherWorkload = await authorize({ 'x-hid-internal-caller': 'ehr-api', 'x-hid-service-token': ehrWorkloadCredential,
      'x-hid-original-method': 'GET' });
    assert.equal(otherWorkload.status, 401, JSON.stringify(otherWorkload.body));
    // A5: a workload refusal has its own code, which a calling service tells apart from a user refusal.
    assert.equal(otherWorkload.body.code, 'WORKLOAD_AUTHENTICATION_FAILED');
    checks.push('Identity skips the cookie-write check on /identity/outreach/authorize only for the authenticated Outreach workload reporting a read, and then authorizes only read permissions; a forged token, no reported method, a write permission and another workload are refused');

    process.stdout.write(`${JSON.stringify({ status: 'passed', scope: 'local-synthetic-only',
      roles: ['hid_outreach_api_runtime', 'hid_identity_api_runtime'], checks })}\n`);
  } finally {
    await outreach?.close();
    if (identity) {
      identity.stdin.end();
      await new Promise((resolveExit) => identity.exitCode !== null ? resolveExit() : identity.once('exit', resolveExit));
    }
    await database.close();
  }
}
