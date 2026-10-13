#!/usr/bin/env node
// Launch blocker PSEARCH-1 (0086): staff patient search by HID and access-
// request creation, through the real Identity controllers, guard, services
// and DatabaseService, with every pooled connection switched to the Identity
// runtime role, on a disposable copy of the owned synthetic rehearsal.
//
// * Lookup answers one 404 PATIENT_NOT_AVAILABLE for an unknown HID, a
//   patient without a grant and a grant held at another facility; a grant at
//   this facility answers 200; a wrong purpose 400; the audit keeps the true
//   outcome. Lookups are counted per actor and per facility (429).
// * Access-request creation never names the patient and answers an unknown
//   HID in the same shape, persisting nothing; it has budgets of its own (429).
// * Searching or requesting never grants access by itself.
// Every key below is synthetic test material.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createTotpClock } from './platform-session-client.mjs';
import { enrollmentCodeOutbox, staffClient, supertestTransport, SYNTHETIC_STAFF_MFA_KEY_B64 } from './staff-session-client.mjs';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
const { Pool } = require('pg');
const RUNTIME_ROLE = 'hid_identity_api_runtime';
const isolated = `hid_rehearsal_search_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const SERVICE_APPLICATION = 'hid-patient-search-verifier';
const maintenance = new Pool({ host: socket, user: process.env.PGUSER, database: 'postgres', max: 1 });
// Small budgets so that the rate limits are reached within this run.
const LIMITS = { lookupActor: 6, lookupFacility: 8, requestActor: 3 };
Object.assign(process.env, { MFA_SECRET_KEY_B64: SYNTHETIC_STAFF_MFA_KEY_B64, MFA_KEY_VERSION: 'patient-search-runtime-v1',
  AUTH_COOKIE_SECURE: 'true', NIN_PROVIDER_MODE: 'unavailable', TURNSTILE_MODE: 'disabled',
  IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', PATIENT_LIFECYCLE_SWEEP_SECONDS: '0',
  PATIENT_LOOKUP_ACTOR_MAX_REQUESTS: String(LIMITS.lookupActor),
  PATIENT_LOOKUP_FACILITY_MAX_REQUESTS: String(LIMITS.lookupFacility),
  ACCESS_REQUEST_ACTOR_MAX_REQUESTS: String(LIMITS.requestActor),
  // The production DatabaseService, unchanged; every connection it opens
  // starts as the runtime role (the libpq startup option role).
  DATABASE_URL: `postgresql://${encodeURIComponent(process.env.PGUSER)}@localhost/${isolated}?host=${encodeURIComponent(socket)}`
    + `&application_name=${SERVICE_APPLICATION}&options=${encodeURIComponent(`-c role=${RUNTIME_ROLE}`)}` });
delete process.env.HID_DEPLOYMENT_ENV;
delete process.env.AUTH_COOKIE_DOMAIN;
require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const load = path => require(join(service, 'src', path));
const { Test } = require('@nestjs/testing');
const { Reflector } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const request = require('supertest');
const { DatabaseService } = load('database/database.service.ts');
const { TokenService } = load('auth/token.service.ts');
const { LocalAuthProvider } = load('auth/local-auth.provider.ts');
const { CurrentStaffContextService } = load('auth/current-staff-context.service.ts');
const { CurrentPatientContextService } = load('auth/current-patient-context.service.ts');
const { AuthService } = load('auth/auth.service.ts');
const { AuthController } = load('auth/auth.controller.ts');
const { GoogleAuthenticationService } = load('auth/google-authentication.service.ts');
const { AuthSessionAuditService } = load('auth/auth-session-audit.service.ts');
const { AuditService } = load('audit/audit.service.ts');
const { AuditInterceptor } = load('audit/audit.interceptor.ts');
const { SecurityGuard } = load('auth/security.guard.ts');
const { WorkloadAuthService } = load('auth/workload-auth.service.ts');
const { TurnstileService } = load('auth/turnstile.service.ts');
const { MfaService, MFA_TOTP_CLOCK } = load('auth/mfa/mfa.service.ts');
const { MfaSecretProtector } = load('auth/mfa/mfa-secret-protector.ts');
const { NotificationOtpClient } = load('auth/notification-otp.client.ts');
const { IdentityController } = load('identity/identity.controller.ts');
const { IdentityService } = load('identity/identity.service.ts');
const { PostgresIdentityProvider } = load('identity/postgres-identity.provider.ts');
const { IDENTITY_PROVIDER } = load('identity/identity.types.ts');
const { StaffSearchBudget } = load('identity/staff-search-budget.ts');
const { ConsentController } = load('consent/consent.controller.ts');
const { ConsentService } = load('consent/consent.service.ts');
const { ProblemDetailsFilter } = load('common/problem.ts');

// Created only once every module has loaded, right before the try whose
// finally drops it, so a load failure leaves no database behind.
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
const pool = new Pool({ host: socket, user: process.env.PGUSER, database: isolated, max: 3 });
const evidence = { database: 'disposable copy of hid_rehearsal', runAs: RUNTIME_ROLE, limits: LIMITS, checks: [] };
const check = (name) => evidence.checks.push(name);
let app;
try {
  // Staff sign-in (MFA-1): an emailed enrolment code, then the authenticator on a virtual clock.
  const clock = createTotpClock();
  const staffEnrollmentCodes = enrollmentCodeOutbox();
  const module = await Test.createTestingModule({
    controllers: [AuthController, IdentityController, ConsentController],
    providers: [DatabaseService, TokenService, LocalAuthProvider, CurrentStaffContextService,
      CurrentPatientContextService, AuthService, AuthSessionAuditService, AuditService, WorkloadAuthService,
      TurnstileService, IdentityService, StaffSearchBudget, ConsentService, MfaService, MfaSecretProtector,
      { provide: MFA_TOTP_CLOCK, useValue: clock.now },
      { provide: NotificationOtpClient, useValue: staffEnrollmentCodes.client },
      { provide: IDENTITY_PROVIDER, useClass: PostgresIdentityProvider },
      { provide: GoogleAuthenticationService, useValue: {
        login: async () => { throw new Error('Google exchange is outside the patient search verifier'); },
      } }] }).compile();
  app = module.createNestApplication({ logger: false });
  app.use(require('cookie-parser')());
  app.use((req, _res, next) => { req.correlationId = randomUUID(); next(); });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalGuards(new SecurityGuard(module.get(Reflector), module.get(TokenService), module.get(AuditService), module.get(DatabaseService)));
  app.useGlobalInterceptors(new AuditInterceptor(module.get(Reflector), module.get(AuditService)));
  await app.init();
  const database = module.get(DatabaseService);
  assert.equal(await database.withTransaction({ actor: { subject: 'system:auth' }, correlationId: randomUUID(),
    purposeOfUse: 'direct-care' }, async (client) => (await client.query('select current_user')).rows[0].current_user),
  RUNTIME_ROLE, 'The service transactions must run as the Identity runtime role');
  check('service transactions run as hid_identity_api_runtime');

  const http = request(app.getHttpServer());
  const origin = process.env.CORS_ORIGINS.split(',')[0];
  const argon2 = require('argon2');
  const password = 'Synthetic-Search-Password-2026';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const ids = { org: randomUUID(), facility: randomUUID(), otherFacility: randomUUID() };
  await pool.query("insert into identity.organizations(id,name,slug) values($1,'Search Rehearsal Org',$2)", [ids.org, `search-${ids.org}`]);
  for (const [facility, name] of [[ids.facility, 'Search Rehearsal Hospital'], [ids.otherFacility, 'Search Rehearsal Annex']]) {
    await pool.query(`insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
      values($1,$2,$3,$4,'Africa/Lagos',true,'verified')`, [facility, ids.org, name, `SRCH-${facility.slice(0, 6)}`]);
  }
  await pool.query(`insert into identity.purpose_of_use_codes(code,display,source_system)
    values('direct-care','Direct patient care','patient-search-rehearsal') on conflict(code) do nothing`);
  const cookies = response => response.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  /** A doctor with a membership at each given facility, signed in once. */
  async function doctor(facilities) {
    const account = randomUUID(), staffId = randomUUID();
    const email = `search-doctor-${account}@example.invalid`;
    await pool.query(`insert into auth.accounts(id,subject,email,display_name,status,password_hash,password_algorithm)
      values($1,$2,$3,'Synthetic doctor','active',$4,'argon2id')`, [account, `synthetic:search-doctor:${account}`, email, passwordHash]);
    await pool.query(`insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
      values($1,$2,'Synthetic doctor',$3,'verified','doctor')`, [staffId, account, email]);
    const memberships = {};
    for (const [index, facility] of facilities.entries()) {
      const membership = randomUUID();
      await pool.query(`insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,
        membership_role,app_role,is_primary,active) values($1,$2,$3,$4,$5,'doctor','doctor',$6,true)`,
      [membership, staffId, account, ids.org, facility, index === 0]);
      await pool.query(`insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
        values($1,$2,'doctor','facility',$3,$4,'Synthetic rehearsal role')`, [randomUUID(), account, membership, facility]);
      memberships[facility] = membership;
    }
    const signedIn = await staffClient({ send: supertestTransport(http), origin, password, outbox: staffEnrollmentCodes,
      now: clock.next }).signIn(email);
    return { account, staffId, memberships, cookie: signedIn.cookie, csrf: signedIn.csrf };
  }
  const patient = async (hid) => {
    const id = randomUUID();
    await pool.query(`insert into identity.patients(id,hid_code,first_name,last_name,full_name,dob,status)
      values($1,$2,'Search','Patient','Search Patient','1990-01-01','active')`, [id, hid]);
    return id;
  };
  const first = await doctor([ids.facility, ids.otherFacility]);
  const second = await doctor([ids.facility]);
  const granted = await patient('HID-SRCHRTGRANTED');
  const ungranted = await patient('HID-SRCHRTNGRNT');
  const unknownHid = 'HID-SRCHRTUNKNWN';
  // The first doctor holds an approved direct-care grant at the main facility only.
  const grantRequest = randomUUID();
  await pool.query(`insert into identity.access_requests(id,patient_id,staff_id,membership_id,facility_id,scope,purpose_of_use,
      reason,status,requested_duration_minutes,approved_at)
    values($1,$2,$3,$4,$5,'read_records','direct-care','Synthetic search approval','approved',60,clock_timestamp())`,
  [grantRequest, granted, first.staffId, first.memberships[ids.facility], ids.facility]);
  await pool.query(`insert into identity.consent_grants(id,request_id,patient_id,staff_id,account_id,membership_id,facility_id,
      scope,purpose_of_use,status,granted_by_patient_id,reason,starts_at,expires_at,break_glass)
    values($1,$2,$3,$4,$5,$6,$7,'read_records','direct-care','active',$3,'Synthetic search grant',
      clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour',false)`,
  [randomUUID(), grantRequest, granted, first.staffId, first.account, first.memberships[ids.facility], ids.facility]);

  const lookup = (who, hid, facility = ids.facility, purpose = 'direct-care') => http.post('/api/v1/identity/patient-lookup')
    .set('Cookie', who.cookie).set('Origin', origin).set('x-csrf-token', who.csrf)
    .set('X-Facility-ID', facility).set('X-Purpose-Of-Use', purpose).send({ hid, purpose });
  const requestAccess = (who, hid) => http.post('/api/v1/identity/access-requests')
    .set('Cookie', who.cookie).set('Origin', origin).set('x-csrf-token', who.csrf)
    .set('X-Facility-ID', ids.facility).set('X-Purpose-Of-Use', 'direct-care')
    .send({ hid, scope: 'read_records', reason: 'Synthetic follow-up consultation', durationMinutes: 60 });
  const answer = (response) => ({ status: response.status, ...response.body, instance: undefined, correlationId: undefined });
  const expectStatus = (response, status, code) => {
    assert.equal(response.status, status, JSON.stringify(response.body));
    if (code) assert.equal(response.body.code, code, JSON.stringify(response.body));
  };

  // 1. Lookup: a grant at this facility is 200; every refusal is one 404.
  const allowed = await lookup(first, 'hid-srchrtgranted');
  expectStatus(allowed, 200);
  assert.equal(allowed.body.patient.patientId, granted);
  assert.equal(allowed.body.authorization.decision, 'allow');
  check('lookup with a grant at this facility and purpose: 200 with the patient and its authorization');
  const noGrant = await lookup(first, 'HID-SRCHRTNGRNT');
  const unknown = await lookup(first, unknownHid);
  const otherFacility = await lookup(first, 'HID-SRCHRTGRANTED', ids.otherFacility);
  for (const response of [noGrant, unknown, otherFacility]) expectStatus(response, 404, 'PATIENT_NOT_AVAILABLE');
  assert.deepEqual(answer(noGrant), answer(unknown), 'a patient without a grant must be answered like an unknown HID');
  assert.deepEqual(answer(otherFacility), answer(unknown), 'a grant at another facility must be answered like an unknown HID');
  for (const response of [noGrant, unknown, otherFacility]) {
    assert(!JSON.stringify(response.body).includes(ungranted) && !JSON.stringify(response.body).includes(granted),
      'a refused lookup must name no patient');
  }
  check('lookup without a grant, of an unknown HID, and with a grant held at another facility: one identical 404 PATIENT_NOT_AVAILABLE naming no patient');
  const wrongPurpose = await http.post('/api/v1/identity/patient-lookup').set('Cookie', first.cookie).set('Origin', origin)
    .set('x-csrf-token', first.csrf).set('X-Facility-ID', ids.facility).set('X-Purpose-Of-Use', 'direct-care')
    .send({ hid: 'HID-SRCHRTGRANTED', purpose: 'marketing' });
  expectStatus(wrongPurpose, 400);
  check('lookup with a purpose of use outside the vocabulary: 400');
  const lookupAudit = (await pool.query(`select coalesce(patient_id::text,'') as patient, facility_id::text as facility,
      outcome, coalesce(details->>'reason','') as reason
    from audit.events where action='identity.patient.lookup' and actor_account_id=$1 order by sequence_id`, [first.account])).rows;
  assert.deepEqual(lookupAudit, [
    { patient: granted, facility: ids.facility, outcome: 'success', reason: '' },
    { patient: ungranted, facility: ids.facility, outcome: 'denied', reason: 'not_authorized' },
    { patient: '', facility: ids.facility, outcome: 'denied', reason: 'not_found' },
    { patient: granted, facility: ids.otherFacility, outcome: 'denied', reason: 'not_authorized' },
  ], 'the audit must keep the true outcome of each lookup');
  check('the audit keeps the true outcome: success, not authorized (with the patient it named) and not found');

  // 2. Access requests never name the patient; an unknown HID gets the same answer.
  const recorded = await requestAccess(first, 'HID-SRCHRTNGRNT');
  const refused = await requestAccess(first, unknownHid);
  expectStatus(recorded, 201); expectStatus(refused, 201);
  const shape = (body) => Object.entries(body).map(([key, value]) => [key, typeof value]).sort();
  assert.deepEqual(shape(refused.body), shape(recorded.body), 'an unknown HID must be answered in the shape of a recorded request');
  for (const body of [recorded.body, refused.body]) {
    assert(!('patientId' in body), 'an access request answer must not name the patient');
    assert.deepEqual([body.status, body.scope, body.purpose, body.durationMinutes, body.existingRequest],
      ['pending', 'read_records', 'direct-care', 60, false]);
  }
  assert.equal(Number((await pool.query('select count(*) from identity.access_requests where id=$1', [recorded.body.accessRequestId])).rows[0].count), 1);
  assert.equal(Number((await pool.query('select count(*) from identity.access_requests where id=$1', [refused.body.accessRequestId])).rows[0].count), 0);
  assert.deepEqual((await pool.query(`select outcome, patient_id, details->>'reason' as reason from audit.events
    where action='identity.access-request.refused' and resource_id=$1`, [refused.body.accessRequestId])).rows,
  [{ outcome: 'denied', patient_id: null, reason: 'patient_not_available' }]);
  check('access-request creation answers a known and an unknown HID in one shape (201) without the patient id; only the known one is persisted, the unknown one is audited as refused');
  // A pending request grants nothing: the lookup is still refused.
  expectStatus(await lookup(first, 'HID-SRCHRTNGRNT'), 404, 'PATIENT_NOT_AVAILABLE');
  check('a pending access request grants no access: the lookup stays 404');

  // 3. Access-request budget per actor.
  expectStatus(await requestAccess(first, 'HID-SRCHRTUNKNWB'), 201);
  expectStatus(await requestAccess(first, 'HID-SRCHRTUNKNWC'), 429, 'ACCESS_REQUEST_RATE_LIMITED');
  check(`access-request creation: the request after ${LIMITS.requestActor} per actor in the window is 429 ACCESS_REQUEST_RATE_LIMITED`);

  // 4. Lookup budgets: per actor (across facilities), then per facility.
  // The first doctor has made 5 counted lookups (the 400 was refused before counting).
  expectStatus(await lookup(first, unknownHid), 404, 'PATIENT_NOT_AVAILABLE');
  expectStatus(await lookup(first, unknownHid), 429, 'PATIENT_LOOKUP_RATE_LIMITED');
  expectStatus(await lookup(first, 'hid-srchrtgranted'), 429, 'PATIENT_LOOKUP_RATE_LIMITED');
  check(`lookup: the lookup after ${LIMITS.lookupActor} per actor (at any facility) in the window is 429 PATIENT_LOOKUP_RATE_LIMITED, even for a granted patient`);
  // The main facility has counted the first doctor's 5 lookups at it; the two
  // refused once its own budget was spent cost the facility nothing.
  for (let allowedLookup = 6; allowedLookup <= LIMITS.lookupFacility; allowedLookup++) {
    expectStatus(await lookup(second, unknownHid), 404, 'PATIENT_NOT_AVAILABLE');
  }
  expectStatus(await lookup(second, unknownHid), 429, 'PATIENT_LOOKUP_RATE_LIMITED');
  check(`lookup: once a facility has counted ${LIMITS.lookupFacility} lookups in the window, another member of it is refused 429 although its own budget is unspent; lookups refused for the actor's own budget do not count for the facility`);
  const buckets = (await pool.query(`select scope, count(*)::int as n from auth.otp_rate_limits
    where scope like 'patient_lookup_%' or scope like 'access_request_%' group by scope order by scope`)).rows;
  assert.deepEqual(buckets, [
    { scope: 'access_request_actor', n: 1 }, { scope: 'access_request_facility', n: 1 },
    { scope: 'patient_lookup_actor', n: 2 }, { scope: 'patient_lookup_facility', n: 2 },
  ]);
  check('the budgets are keyed rows of auth.otp_rate_limits: one per actor and one per facility for each command');

  // Each connection flushes its statistics as it exits; count deadlocks once the API's have closed.
  await app.close();
  app = undefined;
  for (let waited = 0; ; waited += 100) {
    const open = await pool.query(`select count(*)::int as count from pg_stat_activity
      where datname = current_database() and application_name = $1`, [SERVICE_APPLICATION]);
    if (open.rows[0].count === 0) break;
    assert(waited < 10_000, 'the API connections did not close');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write(`${JSON.stringify({ status: 'passed', ...evidence })}\n`);
} finally {
  await app?.close();
  // pool.end() resolves before its connections finish closing, so the forced
  // drop below can terminate one of them (57P01) once the checks are over.
  pool.on('error', (error) => { if (error.code !== '57P01') throw error; });
  await pool.end();
  await maintenance.query(`drop database if exists ${isolated} with (force)`);
  await maintenance.end();
}
