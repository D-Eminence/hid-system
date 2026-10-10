#!/usr/bin/env node
// Phase 4 Stage 9: governed NIN registration review (approve-new and
// link-existing) through the real Identity controllers, guard, service and
// DatabaseService, with every pooled connection switched to the Identity
// runtime role, on a disposable copy of the owned synthetic rehearsal. Before
// Stage 9 both commands failed for every role: the case lock covered the
// nullable side of a LEFT JOIN (0A000). The NIN provider is the deterministic
// test provider; every key below is synthetic test material.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
const { Pool } = require('pg');
const RUNTIME_ROLE = 'hid_identity_api_runtime';
const isolated = `hid_rehearsal_review_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const maintenance = new Pool({ host: socket, user: process.env.PGUSER, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', NIN_PROVIDER_MODE: 'test', TURNSTILE_MODE: 'disabled',
  IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', PATIENT_LIFECYCLE_SWEEP_SECONDS: '0',
  NIN_ENCRYPTION_KEY_B64: Buffer.alloc(32, 0x5a).toString('base64'),
  NIN_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 0x5b).toString('base64'), NIN_KEY_VERSION: 'rehearsal-v1',
  OTP_HMAC_KEY_B64: process.env.OTP_HMAC_KEY_B64 ?? Buffer.alloc(32, 0x33).toString('base64'),
  // The production DatabaseService, unchanged (pool, isolation levels, session
  // settings, commit and rollback); every connection it opens starts as the
  // runtime role (the libpq startup option role), as a login of that role would.
  DATABASE_URL: `postgresql://${encodeURIComponent(process.env.PGUSER)}@localhost/${isolated}?host=${encodeURIComponent(socket)}`
    + `&options=${encodeURIComponent(`-c role=${RUNTIME_ROLE}`)}` });
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
const { NotificationOtpClient } = load('auth/notification-otp.client.ts');
const { NinRegistrationController } = load('identity/nin-registration.controller.ts');
const { NinRegistrationService } = load('identity/nin-registration.service.ts');
const { NinIdentifierProtector } = load('identity/nin-identifier-protector.ts');
const { HidCodeGenerator } = load('identity/hid-code-generator.service.ts');
const { DeterministicTestNinVerificationProvider } = load('identity/nin-verification.provider.ts');
const { NIN_VERIFICATION_PROVIDER } = load('identity/nin.types.ts');
const { ProblemDetailsFilter } = load('common/problem.ts');

const pool = new Pool({ host: socket, user: process.env.PGUSER, database: isolated, max: 3 });
const evidence = { database: 'disposable copy of hid_rehearsal', runAs: RUNTIME_ROLE, checks: [] };
const check = (name) => evidence.checks.push(name);
let app;
try {
  const module = await Test.createTestingModule({
    controllers: [AuthController, NinRegistrationController],
    providers: [DatabaseService, TokenService, LocalAuthProvider,
      CurrentStaffContextService, CurrentPatientContextService, AuthService, AuthSessionAuditService,
      AuditService, WorkloadAuthService, TurnstileService, NinRegistrationService, NinIdentifierProtector,
      HidCodeGenerator, { provide: NIN_VERIFICATION_PROVIDER, useClass: DeterministicTestNinVerificationProvider },
      { provide: NotificationOtpClient, useValue: { deliver: async () => ({ outcome: 'accepted', provider: 'termii' }) } },
      { provide: GoogleAuthenticationService, useValue: {
        login: async () => { throw new Error('Google exchange is outside the registration review verifier'); },
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
    purposeOfUse: 'healthcare-operations' }, async (client) => (await client.query('select current_user')).rows[0].current_user),
  RUNTIME_ROLE, 'The service transactions must run as the Identity runtime role');
  check('service transactions run as hid_identity_api_runtime');

  const http = request(app.getHttpServer());
  const origin = process.env.CORS_ORIGINS.split(',')[0];
  const argon2 = require('argon2');
  const password = 'Synthetic-Registrar-Password-2026';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const ids = { org: randomUUID(), facility: randomUUID(), otherFacility: randomUUID() };
  await pool.query("insert into identity.organizations(id,name,slug) values($1,'Review Rehearsal Org',$2)", [ids.org, `review-${ids.org}`]);
  for (const [facility, name] of [[ids.facility, 'Review Rehearsal Hospital'], [ids.otherFacility, 'Review Rehearsal Annex']]) {
    await pool.query(`insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
      values($1,$2,$3,$4,'Africa/Lagos',true,'verified')`, [facility, ids.org, name, `REV-${facility.slice(0, 6)}`]);
  }
  await pool.query(`insert into identity.purpose_of_use_codes(code,display,source_system)
    values('healthcare-operations','Healthcare operations','registration-review-rehearsal') on conflict(code) do nothing`);
  const cookies = response => response.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  async function staff(role, facility) {
    const account = randomUUID(), staffId = randomUUID(), membership = randomUUID();
    const email = `review-${role}-${account}@example.invalid`;
    await pool.query(`insert into auth.accounts(id,subject,email,display_name,status,password_hash,password_algorithm)
      values($1,$2,$3,'Synthetic reviewer','active',$4,'argon2id')`, [account, `synthetic:${role}:${account}`, email, passwordHash]);
    await pool.query(`insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
      values($1,$2,'Synthetic reviewer',$3,'verified',$4)`, [staffId, account, email, role]);
    await pool.query(`insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,
      membership_role,app_role,is_primary,active) values($1,$2,$3,$4,$5,$6,$6,true,true)`, [membership, staffId, account, ids.org, facility, role]);
    await pool.query(`insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
      values($1,$2,$3,'facility',$4,$5,'Synthetic rehearsal role')`, [randomUUID(), account, role, membership, facility]);
    const login = await http.post('/api/v1/auth/login').set('Origin', origin)
      .send({ email, password, turnstileAction: 'staff-login' }).expect(200);
    return { account, membership, facility, cookie: cookies(login), csrf: login.headers['x-csrf-token'] };
  }
  const registrar = await staff('org_admin', ids.facility);
  const secondRegistrar = await staff('org_admin', ids.facility);
  const receptionist = await staff('receptionist', ids.facility);
  const annexAdmin = await staff('org_admin', ids.otherFacility);
  const send = (who, path, body, key, facility = who.facility) => {
    const call = http.post(`/api/v1/identity${path}`).set('Cookie', who.cookie).set('Origin', origin)
      .set('x-csrf-token', who.csrf).set('X-Facility-ID', facility).set('X-Purpose-Of-Use', 'healthcare-operations');
    return (key ? call.set('Idempotency-Key', key) : call).send(body);
  };
  const read = (who, path) => http.get(`/api/v1/identity${path}`).set('Cookie', who.cookie)
    .set('X-Facility-ID', who.facility).set('X-Purpose-Of-Use', 'healthcare-operations');
  const key = (label) => `review-${label}-${randomUUID()}`;
  const resolveNin = async (nin, firstName, lastName, dateOfBirth) => (await send(registrar, '/nin/resolve',
    { nin, firstName, lastName, dateOfBirth, gender: 'female', purpose: 'healthcare-operations' }, key('resolve')).expect(201)).body;
  const caseRow = async (caseId) => (await pool.query(`select status, row_version::int as version, resolved_patient_id::text,
    review_idempotency_key from identity.registration_cases where id=$1`, [caseId])).rows[0];
  const events = async (caseId, type) => Number((await pool.query(
    'select count(*) from identity.registration_case_events where case_id=$1 and event_type=$2', [caseId, type])).rows[0].count);
  const reviewBody = (expectedVersion, reason = 'Synthetic governed review approved') =>
    ({ expectedVersion, reason, purpose: 'healthcare-operations' });

  // Approve a new identity: denials, stale version, concurrent identical
  // requests, replay and key reuse.
  const pending = await resolveNin('90000000001', 'Chiamaka', 'Obiora', '1991-02-03');
  assert.deepEqual([pending.status, pending.version, pending.candidateCount], ['pending_new_identity_approval', 1, 0]);
  assert.equal((await send(receptionist, `/registration-cases/${pending.caseId}/approve-new`, reviewBody(1), key('denied')).expect(403)).body.code,
    'PERMISSION_DENIED');
  assert.equal((await send(annexAdmin, `/registration-cases/${pending.caseId}/approve-new`, reviewBody(1), key('annex')).expect(404)).body.code,
    'REGISTRATION_CASE_NOT_FOUND');
  await send(annexAdmin, `/registration-cases/${pending.caseId}/approve-new`, reviewBody(1), key('foreign'), ids.facility).expect(403);
  assert.equal((await send(registrar, `/registration-cases/${pending.caseId}/approve-new`, reviewBody(2), key('stale')).expect(412)).body.code,
    'VERSION_CONFLICT');
  assert.deepEqual(await caseRow(pending.caseId), { status: 'pending_new_identity_approval', version: 1,
    resolved_patient_id: null, review_idempotency_key: null });
  check('approve-new: missing permission 403, other facility 404, non-member facility 403, stale version 412, nothing written');
  const approveKey = key('approve');
  const approvals = await Promise.all([1, 2].map(() =>
    send(registrar, `/registration-cases/${pending.caseId}/approve-new`, reviewBody(1), approveKey)));
  for (const response of approvals) {
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.status, 'approved_new_identity');
    assert.equal(response.body.version, 2);
    assert.match(response.body.patient?.hid ?? '', /^HID-[A-HJ-NP-Z2-9]{16}$/, 'every response names the new patient');
  }
  assert.deepEqual(approvals[0].body.patient, approvals[1].body.patient, 'concurrent identical approvals return one patient');
  const approved = await caseRow(pending.caseId);
  assert.deepEqual([approved.status, approved.version, approved.resolved_patient_id],
    ['approved_new_identity', 2, approvals[0].body.patient.patientId]);
  assert.equal(Number((await pool.query(`select count(*) from identity.patient_identifiers
    where registration_case_id=$1`, [pending.caseId])).rows[0].count), 1);
  assert.equal(await events(pending.caseId, 'approved_new_identity'), 1);
  check('approve-new: two concurrent identical requests create one patient, one identifier and one event; both return it');
  const replay = await send(registrar, `/registration-cases/${pending.caseId}/approve-new`, reviewBody(1), approveKey).expect(201);
  assert.deepEqual(replay.body.patient, approvals[0].body.patient);
  assert.equal(Number((await pool.query(`select count(*) from audit.events where resource_id=$1
    and action='identity.registration-case.approve-new.replay'`, [pending.caseId])).rows[0].count) >= 2, true);
  assert.equal((await send(registrar, `/registration-cases/${pending.caseId}/approve-new`,
    reviewBody(1, 'A different synthetic review reason'), approveKey).expect(409)).body.code, 'IDEMPOTENCY_KEY_REUSED');
  await send(secondRegistrar, `/registration-cases/${pending.caseId}/approve-new`, reviewBody(2), key('late')).expect(409);
  await send(registrar, `/registration-cases/${pending.caseId}/link-existing`,
    { ...reviewBody(2), patientId: approvals[0].body.patient.patientId }, key('other-transition')).expect(409);
  assert.equal((await caseRow(pending.caseId)).version, 2);
  check('approve-new: replay returns the stored patient; key reuse 409; second reviewer and other transition 409');

  // A failure after the patient insert rolls the whole review back: a revoked
  // identifier of the same NIN passes the pre-check (which skips revoked
  // identifiers) but not the unique index, so the identifier insert fails
  // after the patient insert.
  const collides = await resolveNin('90000000003', 'Ifeoma', 'Collins', '1979-11-30');
  const holder = randomUUID();
  await pool.query(`insert into identity.patients(id,hid_code,first_name,last_name,full_name,status)
    values($1,'HID-REVHLDR2','Holder','Patient','Holder Patient','active')`, [holder]);
  await pool.query(`insert into identity.patient_identifiers(id,patient_id,identifier_type,value_ciphertext,lookup_hmac,
      encryption_key_version,display_hint,verified,verified_at,verification_provider,verification_reference,
      registration_case_id,revoked_at,revocation_reason)
    select $1,$2,'nin',nin_ciphertext,nin_lookup_hmac,nin_key_version,'****0003',true,verified_at,verification_provider,
      verification_reference,$4,clock_timestamp(),'Synthetic revoked identifier'
      from identity.registration_cases where id=$3`, [randomUUID(), holder, collides.caseId, pending.caseId]);
  assert.equal((await send(registrar, `/registration-cases/${collides.caseId}/approve-new`, reviewBody(1), key('collide')).expect(409)).body.code,
    'NIN_ALREADY_LINKED');
  assert.equal(Number((await pool.query(`select count(*) from identity.patients where full_name='Ifeoma Collins'`)).rows[0].count), 0,
    'the patient inserted before the failure is rolled back');
  assert.deepEqual(await caseRow(collides.caseId), { status: 'pending_new_identity_approval', version: 1,
    resolved_patient_id: null, review_idempotency_key: null });
  assert.equal(await events(collides.caseId, 'approved_new_identity'), 0);
  check('approve-new: a unique violation after the patient insert rolls back the patient, case and event');

  // Link to an existing patient: candidate check, stale version, concurrent
  // conflicting reviews, replay.
  const existing = randomUUID();
  await pool.query(`insert into identity.patients(id,hid_code,first_name,last_name,full_name,dob,status)
    values($1,'HID-REVEXT22','Emeka','Nwosu','Emeka Nwosu','1980-06-15','active')`, [existing]);
  const review = await resolveNin('90000000002', 'Emeka', 'Nwosu', '1980-06-15');
  assert.equal(review.status, 'review_required');
  const candidates = (await read(registrar, `/registration-cases/${review.caseId}`).expect(200)).body.candidates;
  assert(candidates.some((candidate) => candidate.patientId === existing), 'the existing patient is a review candidate');
  const linkBody = (expectedVersion, patientId = existing, reason = 'Synthetic duplicate review confirmed') =>
    ({ ...reviewBody(expectedVersion, reason), patientId });
  assert.equal((await send(registrar, `/registration-cases/${review.caseId}/link-existing`, linkBody(1, holder), key('not-candidate')).expect(409)).body.code,
    'PATIENT_NOT_A_REVIEW_CANDIDATE');
  await send(receptionist, `/registration-cases/${review.caseId}/link-existing`, linkBody(1), key('denied')).expect(403);
  await send(annexAdmin, `/registration-cases/${review.caseId}/link-existing`, linkBody(1), key('annex')).expect(404);
  await send(registrar, `/registration-cases/${review.caseId}/link-existing`, linkBody(3), key('stale')).expect(412);
  assert.deepEqual(await caseRow(review.caseId), { status: 'review_required', version: 1,
    resolved_patient_id: null, review_idempotency_key: null });
  check('link-existing: non-candidate 409, missing permission 403, other facility 404, stale version 412, nothing written');
  const linkKeys = [key('link-a'), key('link-b')];
  const links = await Promise.all([[registrar, linkKeys[0], 'First synthetic duplicate review'],
    [secondRegistrar, linkKeys[1], 'Second synthetic duplicate review']].map(([who, linkKey, reason]) =>
    send(who, `/registration-cases/${review.caseId}/link-existing`, linkBody(1, existing, reason), linkKey)));
  assert.deepEqual(links.map((response) => response.status).sort(), [201, 409], JSON.stringify(links.map((r) => r.body)));
  const winner = links.findIndex((response) => response.status === 201);
  assert.deepEqual(links[winner].body.patient, { patientId: existing, hid: 'HID-REVEXT22' });
  const linked = await caseRow(review.caseId);
  assert.deepEqual([linked.status, linked.version, linked.resolved_patient_id, linked.review_idempotency_key],
    ['linked_existing', 2, existing, linkKeys[winner]]);
  assert.equal(await events(review.caseId, 'linked_existing'), 1);
  const linkReplay = await send([registrar, secondRegistrar][winner], `/registration-cases/${review.caseId}/link-existing`,
    linkBody(1, existing, ['First synthetic duplicate review', 'Second synthetic duplicate review'][winner]), linkKeys[winner]).expect(201);
  assert.deepEqual(linkReplay.body.patient, { patientId: existing, hid: 'HID-REVEXT22' });
  await send(registrar, `/registration-cases/${review.caseId}/approve-new`, reviewBody(2), key('after-link')).expect(409);
  check('link-existing: two concurrent reviews with different keys commit once (201) and refuse the other (409); replay 201');

  // Concurrent identical link requests both return the linked patient.
  await pool.query(`insert into identity.patients(id,hid_code,first_name,last_name,full_name,dob,status)
    values($1,'HID-REVTWN22','Ngozi','Adeyemi','Ngozi Adeyemi','1985-04-12','active')`, [randomUUID()]);
  const twin = await resolveNin('90000000004', 'Ngozi', 'Adeyemi', '1985-04-12');
  const twinPatient = (await read(registrar, `/registration-cases/${twin.caseId}`).expect(200)).body.candidates[0].patientId;
  const twinKey = key('twin');
  const twins = await Promise.all([1, 2].map(() =>
    send(registrar, `/registration-cases/${twin.caseId}/link-existing`, linkBody(1, twinPatient), twinKey)));
  assert.deepEqual(twins.map((response) => response.status), [201, 201], JSON.stringify(twins.map((r) => r.body)));
  assert.deepEqual(twins[0].body, twins[1].body);
  assert.equal(twins[0].body.patient.hid, 'HID-REVTWN22');
  assert.equal(await events(twin.caseId, 'linked_existing'), 1);
  check('link-existing: two concurrent identical requests link once and both return the patient');
  process.stdout.write(`${JSON.stringify({ status: 'passed', ...evidence })}\n`);
} finally {
  await app?.close();
  await pool.end();
  await maintenance.query(`drop database if exists ${isolated} with (force)`);
  await maintenance.end();
}
