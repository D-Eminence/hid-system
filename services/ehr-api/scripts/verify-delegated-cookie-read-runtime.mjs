#!/usr/bin/env node
// A browser cookie session reading patient data through EHR: EHR (real
// AppModule, as hid_ehr_api_runtime) authorizes the read by delegating to
// Identity (real AppModule, as hid_identity_api_runtime, in a child process)
// over HTTP, forwarding the browser's cookie. A same-origin GET carries no
// Origin and no X-CSRF-Token, so Identity must not demand them when EHR,
// authenticated as a workload, reports that the browser request was a GET;
// a browser write must still prove Origin and CSRF. Disposable copy of the
// owned synthetic rehearsal database; synthetic accounts only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';

const ORIGIN = 'https://staging.healthidentitydirectory.com';
// EHR's local-secret workload credential, generated for this run only.
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
  const name = `hid_rehearsal_delegated_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const maintenance = new Client({ host: socket, user: admin, database: 'postgres' });
  await maintenance.connect();
  await maintenance.query(`create database ${name} template hid_rehearsal`);
  const owner = new Pool({ host: socket, user: admin, database: name, max: 4 });
  owner.on('error', () => undefined);
  return {
    owner,
    url: (role) => `postgresql://${encodeURIComponent(admin)}@localhost/${name}?host=${encodeURIComponent(socket)}`
      + `&options=${encodeURIComponent(`-c role=${role}`)}`,
    /** Fixture SQL as the owner in one transaction, triggers and foreign keys off as in the SQL suites. */
    fixture: async (build) => {
      const client = await owner.connect();
      try {
        await client.query('begin');
        await client.query('set local session_replication_role = replica');
        await build(client);
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    },
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
 * browser response headers and are left out.
 */
async function startService({ require, service }) {
  require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
  require('reflect-metadata');
  const load = (path) => require(join(service, 'src', path));
  const { Test } = require('@nestjs/testing');
  const { ValidationPipe } = require('@nestjs/common');
  const { AppModule } = load('app.module.ts');
  const { DatabaseService } = load('database/database.service.ts');
  const { DomainProblem, ProblemDetailsFilter } = load('common/problem.ts');
  const { preventResponseCaching } = load('common/response-security.middleware.ts');
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
  const app = await startService({ require: createRequire(join(identityService, 'package.json')),
    service: identityService });
  process.stdout.write(`${JSON.stringify({ url: (await app.app.getUrl()).replace('[::1]', '127.0.0.1') })}\n`);
  process.stdin.resume();
  process.stdin.on('end', async () => { await app.close(); process.exit(0); });
} else {
  const service = resolve(import.meta.dirname, '..');
  const require = createRequire(join(service, 'package.json'));
  const database = await disposableDatabase(require);
  let identity, ehr;
  try {
    // Fixture: a doctor at one facility, a patient who approved the doctor's
    // read request through Identity, and one encounter of that patient.
    const argon2 = require('argon2');
    const password = 'Synthetic-Delegation-Password-2026';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const ids = { org: randomUUID(), facility: randomUUID(), doctorAccount: randomUUID(), doctor: randomUUID(),
      membership: randomUUID(), patientAccount: randomUUID(), patient: randomUUID(), request: randomUUID(),
      encounter: randomUUID() };
    const doctorEmail = `doctor-${ids.doctorAccount}@example.invalid`;
    const patientEmail = `patient-${ids.patientAccount}@example.invalid`;
    const { owner } = database;
    await owner.query("insert into identity.organizations(id,name,slug) values($1,'Delegation Rehearsal Org',$2)", [ids.org, `delegation-${ids.org}`]);
    await owner.query(`insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
      values($1,$2,'Delegation Rehearsal Hospital',$3,'Africa/Lagos',true,'verified')`, [ids.facility, ids.org, `DLG-${ids.facility.slice(0, 6)}`]);
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
      values($1,$2,'HID-DLGATEAA','Ada','Delegation','Ada Delegation','active')`, [ids.patient, ids.patientAccount]);
    await owner.query("insert into identity.purpose_of_use_codes(code,display,source_system) values('direct-care','Direct patient care','delegation-rehearsal') on conflict(code) do nothing");
    await owner.query(`insert into identity.access_requests(id,patient_id,staff_id,membership_id,facility_id,scope,purpose_of_use,reason,status,requested_duration_minutes)
      values($1,$2,$3,$4,$5,'read_records','direct-care','Follow-up consultation','pending',60)`,
    [ids.request, ids.patient, ids.doctor, ids.membership, ids.facility]);
    await database.fixture((client) => client.query(`insert into ehr.encounters(id,patient_id,facility_id,created_by,
      created_by_membership_id,encounter_type,status,started_at,chief_complaint)
      values($1,$2,$3,$4,$5,'ambulatory','in_progress',clock_timestamp()-interval '1 hour','Synthetic follow-up')`,
    [ids.encounter, ids.patient, ids.facility, ids.doctorAccount, ids.membership]));

    // Identity in its own process, as its runtime role.
    const shared = { NODE_ENV: 'test', PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', LANG: 'C.UTF-8', TZ: 'UTC',
      // database.url() names the socket directory but not the port.
      ...(process.env.PGPORT ? { PGPORT: process.env.PGPORT } : {}),
      CORS_ORIGINS: ORIGIN, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: ehrWorkloadCredential };
    identity = spawn(process.execPath, [import.meta.filename, '--identity-child'], { stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...shared, DATABASE_URL: database.url('hid_identity_api_runtime'), AUTH_MODE: 'local',
        AUTH_SIGNING_SECRET: process.env.AUTH_SIGNING_SECRET, AUTH_LOGIN_PEPPER: process.env.AUTH_LOGIN_PEPPER,
        OTP_HMAC_KEY_B64: process.env.OTP_HMAC_KEY_B64, AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'staging',
        NIN_PROVIDER_MODE: 'deferred', TURNSTILE_MODE: 'disabled' } });
    const started = await new Promise((resolveStart, reject) => {
      createInterface({ input: identity.stdout }).once('line', (line) => resolveStart(JSON.parse(line)));
      identity.once('exit', (code) => reject(new Error(`Identity exited before listening (${code})`)));
    });
    const identityUrl = `${started.url}/api/v1`;

    // EHR in this process, as its runtime role, delegating to that Identity.
    Object.assign(process.env, { ...shared, DATABASE_URL: database.url('hid_ehr_api_runtime'),
      IDENTITY_API_URL: started.url, STORAGE_MODE: 'disabled' });
    ehr = await startService({ require, service });
    const roles = await Promise.all([ehr.database.query('select current_user as role')]);
    assert.equal(roles[0].rows[0].role, 'hid_ehr_api_runtime');

    const call = async (base, method, path, headers = {}, body) => {
      const response = await fetch(`${base}${path}`, { method, headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
    };
    const signIn = async (path, email, action) => {
      const response = await call(identityUrl, 'POST', path, { origin: ORIGIN },
        { email, password, turnstileAction: action });
      assert.equal(response.status, 200, `${action}: ${JSON.stringify(response.body)}`);
      const cookies = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
      return { cookie: cookies, csrf: response.headers.get('x-csrf-token') };
    };
    const checks = [];

    // The patient approves the doctor's request through Identity (a real browser write).
    const patient = await signIn('/auth/patient/login', patientEmail, 'patient-login');
    const approved = await call(identityUrl, 'POST', `/identity/access-requests/${ids.request}/approve`,
      { cookie: patient.cookie, origin: ORIGIN, 'x-csrf-token': patient.csrf }, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const doctor = await signIn('/auth/login', doctorEmail, 'staff-login');
    const clinical = { cookie: doctor.cookie, 'x-facility-id': ids.facility, 'x-purpose-of-use': 'direct-care' };

    // 1. A same-origin browser GET: cookie only, no Origin, no X-CSRF-Token.
    const ehrBase = `${(await ehr.app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
    const read = await call(ehrBase, 'GET', `/ehr/patients/${ids.patient}/encounters`, clinical);
    assert.equal(read.status, 200, `same-origin cookie GET of encounters: ${read.status} ${JSON.stringify(read.body)}`);
    const items = Array.isArray(read.body) ? read.body : read.body?.items;
    assert(items?.some((item) => item.id === ids.encounter), JSON.stringify(read.body));
    checks.push('a same-origin cookie GET of /ehr/patients/:id/encounters (no Origin, no CSRF) is authorized through Identity and returns the encounter');
    const withOrigin = await call(ehrBase, 'GET', `/ehr/patients/${ids.patient}/encounters`, { ...clinical, origin: ORIGIN });
    assert.equal(withOrigin.status, 200, JSON.stringify(withOrigin.body));
    checks.push('the same GET with an allowed Origin and no CSRF token is authorized');

    // 2. A browser write still proves Origin and CSRF.
    const encounter = { encounterType: 'ambulatory', status: 'in_progress', startedAt: new Date().toISOString(),
      chiefComplaint: 'Synthetic delegated write', purpose: 'direct-care' };
    const noCsrf = await call(ehrBase, 'POST', `/ehr/patients/${ids.patient}/encounters`, { ...clinical, origin: ORIGIN,
      'idempotency-key': randomUUID() }, encounter);
    assert.equal(noCsrf.status, 403, `write without CSRF: ${JSON.stringify(noCsrf.body)}`);
    assert.equal(noCsrf.body?.code, 'CSRF_VALIDATION_FAILED');
    const noOrigin = await call(ehrBase, 'POST', `/ehr/patients/${ids.patient}/encounters`, { ...clinical,
      'x-csrf-token': doctor.csrf, 'idempotency-key': randomUUID() }, encounter);
    assert.equal(noOrigin.status, 403, `write without Origin: ${JSON.stringify(noOrigin.body)}`);
    assert.equal(noOrigin.body?.code, 'ORIGIN_DENIED');
    checks.push('a cookie write to EHR without CSRF is 403 CSRF_VALIDATION_FAILED and without Origin 403 ORIGIN_DENIED');

    // 3. Identity trusts the reported method only from an authenticated workload.
    const check = (headers) => call(identityUrl, 'POST', '/identity/service/authorization/check',
      { cookie: doctor.cookie, 'x-facility-id': ids.facility, 'x-purpose-of-use': 'direct-care',
        'x-hid-internal-caller': 'ehr-api', ...headers },
      { patientId: ids.patient, scope: 'read_records', purpose: 'direct-care' });
    const trusted = await check({ 'x-hid-service-token': ehrWorkloadCredential, 'x-hid-original-method': 'GET' });
    // A POST without @HttpCode answers 201, which the delegating clients accept.
    assert.equal(trusted.status, 201, JSON.stringify(trusted.body)); assert.equal(trusted.body.allowed, true);
    const forged = await check({ 'x-hid-service-token': 'not-the-workload-token-000000000000000', 'x-hid-original-method': 'GET' });
    assert.equal(forged.status, 403, JSON.stringify(forged.body)); assert.equal(forged.body.code, 'ORIGIN_DENIED');
    const anonymous = await check({ 'x-hid-original-method': 'GET' });
    assert.equal(anonymous.status, 403, JSON.stringify(anonymous.body)); assert.equal(anonymous.body.code, 'ORIGIN_DENIED');
    const write = await check({ 'x-hid-service-token': ehrWorkloadCredential, 'x-hid-original-method': 'POST', origin: ORIGIN });
    assert.equal(write.status, 403, JSON.stringify(write.body)); assert.equal(write.body.code, 'CSRF_VALIDATION_FAILED');
    const unreported = await check({ 'x-hid-service-token': ehrWorkloadCredential });
    assert.equal(unreported.status, 403, JSON.stringify(unreported.body)); assert.equal(unreported.body.code, 'ORIGIN_DENIED');
    checks.push('Identity skips the cookie-write check only for a workload-authenticated caller reporting GET; a wrong or missing workload token, a reported POST and no reported method are still refused');

    // 4. The patient's own records still read through the self path.
    const own = await call(ehrBase, 'GET', '/ehr/me/records', { cookie: patient.cookie });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    checks.push('the patient\'s own records read through the self-authorization path');

    process.stdout.write(`${JSON.stringify({ status: 'passed', scope: 'local-synthetic-only',
      roles: ['hid_ehr_api_runtime', 'hid_identity_api_runtime'], checks })}\n`);
  } finally {
    await ehr?.close();
    if (identity) {
      identity.stdin.end();
      await new Promise((resolveExit) => identity.exitCode !== null ? resolveExit() : identity.once('exit', resolveExit));
    }
    await database.close();
  }
}
