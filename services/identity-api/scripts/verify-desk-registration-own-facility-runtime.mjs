#!/usr/bin/env node
// 0130 (ID-2) and 0131 (ID-4), Release A of the Akos EHR plan (owner decisions of 18 November 2026): the front desk
// registers patients without a NIN, and a doctor, nurse or clinician opens this facility's own patient without a PIN.
// Identity's own NinRegistrationController and ConsentController, its services, the real security guard, validation
// pipe, problem filter and audit interceptor, over HTTP, with every statement run as hid_identity_api_runtime in the
// context Identity's transactions set. The token check alone is replaced: each request names a fictional member whose
// facility permissions are read from auth.role_permissions. Executes only against the owned disposable synthetic
// rehearsal. No delivery, NIN provider or cloud calls; fictional people, places and identifiers only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
// Synthetic keys for this disposable run only (the contact lookup HMAC and the desk contact encryption).
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', AUTH_COOKIE_DOMAIN: '.example.invalid',
  HID_DEPLOYMENT_ENV: 'staging', NIN_PROVIDER_MODE: 'deferred', TURNSTILE_MODE: 'disabled',
  IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'public-synthetic-ehr-workload-token',
  CONTACT_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 0x41).toString('base64'),
  NIN_ENCRYPTION_KEY_B64: Buffer.alloc(32, 0x42).toString('base64'), NIN_KEY_VERSION: 'synthetic-runtime-v1' });
for (const key of ['NIN_LOOKUP_HMAC_KEY_B64', 'METAMAP_CLIENT_ID', 'METAMAP_CLIENT_SECRET', 'QOREID_CLIENT_ID',
  'QOREID_CLIENT_SECRET', 'QOREID_API_KEY']) delete process.env[key];
require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const load = path => require(join(service, 'src', path));
const { Pool } = require('pg');
const { Test } = require('@nestjs/testing');
const { APP_GUARD, APP_INTERCEPTOR, Reflector } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const request = require('supertest');
const { DatabaseService } = load('database/database.service.ts');
const { TokenService } = load('auth/token.service.ts');
const { AuditService } = load('audit/audit.service.ts');
const { AuditInterceptor } = load('audit/audit.interceptor.ts');
const { SecurityGuard } = load('auth/security.guard.ts');
const { DomainProblem, ProblemDetailsFilter } = load('common/problem.ts');
const { NinRegistrationController } = load('identity/nin-registration.controller.ts');
const { NinRegistrationService } = load('identity/nin-registration.service.ts');
const { RegistrationWithoutNinService } = load('identity/registration-without-nin.service.ts');
const { NinProviderBreaker } = load('identity/nin-provider-breaker.ts');
const { NinIdentifierProtector } = load('identity/nin-identifier-protector.ts');
const { HidCodeGenerator } = load('identity/hid-code-generator.service.ts');
const { NIN_VERIFICATION_PROVIDER } = load('identity/nin.types.ts');
const { ConsentController } = load('consent/consent.controller.ts');
const { ConsentService } = load('consent/consent.service.ts');

const pool = new Pool({ host: socket, user: process.env.PGUSER, database: process.env.PGDATABASE, max: 5 });
async function asRuntime(context, operation) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role hid_identity_api_runtime');
    if (context) {
      await client.query(`select set_config('app.actor_subject', $1, true), set_config('app.facility_id', $2, true),
        set_config('app.correlation_id', $3, true), set_config('app.membership_id', $4, true),
        set_config('app.purpose_of_use', $5, true)`,
        [context.actor.subject, context.facilityId ?? '', context.correlationId, context.membershipId ?? '', context.purposeOfUse]);
    }
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}
const database = {
  query: (sql, values) => asRuntime(null, client => client.query(sql, values)),
  withTransaction: (context, operation, options = {}) => asRuntime(context, async client => {
    if (options.readOnly) await client.query('set transaction read only');
    return operation(client);
  }),
};

// Fixtures, as the database's owner: two facilities; at A a desk, an approver, a doctor, a nurse, a lab member and a
// pharmacist; at B a doctor. One existing patient for the duplicate check; one with a visit at A started under the
// patient's PIN 30 days ago.
const run = randomUUID().slice(0, 8);
const ids = { orgA: randomUUID(), orgB: randomUUID(), facA: randomUUID(), facB: randomUUID() };
const members = {
  desk: { role: 'receptionist', facility: ids.facA, org: ids.orgA },
  approver: { role: 'admin', facility: ids.facA, org: ids.orgA },
  doctor: { role: 'doctor', facility: ids.facA, org: ids.orgA },
  nurse: { role: 'nurse', facility: ids.facA, org: ids.orgA },
  lab: { role: 'lab', facility: ids.facA, org: ids.orgA },
  pharmacist: { role: 'pharmacist', facility: ids.facA, org: ids.orgA },
  doctorB: { role: 'doctor', facility: ids.facB, org: ids.orgB },
};
const existingPatient = randomUUID(), visitPatient = randomUUID();
const hid = (prefix) => `HID-${prefix}${Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('')}`;
const existingHid = hid('RA'), visitHid = hid('RB');
await pool.query(`insert into identity.organizations (id, name, slug) values ($1, 'Runtime Desk Group A', $3),
  ($2, 'Runtime Desk Group B', $4)`, [ids.orgA, ids.orgB, `runtime-desk-a-${run}`, `runtime-desk-b-${run}`]);
await pool.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
  values ($1, $2, 'Runtime Desk Clinic A', $5, 'Africa/Lagos', true, 'verified'),
         ($3, $4, 'Runtime Desk Clinic B', $6, 'Africa/Lagos', true, 'verified')`,
  [ids.facA, ids.orgA, ids.facB, ids.orgB, `RT-DESK-A-${run}`, `RT-DESK-B-${run}`]);
const actors = {};
for (const [name, member] of Object.entries(members)) {
  Object.assign(member, { account: randomUUID(), staff: randomUUID(), membership: randomUUID() });
  await pool.query(`insert into auth.accounts (id, subject, email, display_name, status) values ($1, $2, $3, $4, 'active')`,
    [member.account, `synthetic:runtime-desk-${name}-${run}`, `runtime-desk-${name}-${run}@example.invalid`, `Runtime ${name}`]);
  await pool.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
    values ($1, $2, $3, $4, 'verified', $5)`, [member.staff, member.account, `Runtime ${name}`,
    `runtime-desk-${name}-${run}@example.invalid`, member.role]);
  await pool.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, $6, $6, true, true)`,
    [member.membership, member.staff, member.account, member.org, member.facility, member.role]);
  await pool.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
    values ($1, $2, $3, 'facility', $4, $5, 'Synthetic runtime desk and own-facility role')`,
    [randomUUID(), member.account, member.role, member.membership, member.facility]);
  const permissions = (await pool.query('select permission_code from auth.role_permissions where role_code = $1 order by 1',
    [member.role])).rows.map(row => row.permission_code);
  const facility = { id: member.facility, membershipId: member.membership, organizationId: member.org, name: 'Runtime clinic',
    roles: [member.role], permissions, isPrimary: true };
  actors[name] = { kind: 'staff', id: `staff:${name}`, subject: `synthetic:runtime-desk-${name}-${run}`, accountId: member.account,
    roles: [member.role], permissions, platformRoles: [], platformPermissions: [], facilityIds: [member.facility],
    facilities: [facility], facility, authenticationMethod: 'local' };
}
await pool.query(`insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, status, source_system)
  values ($1, $2, 'Adaora', 'Runtimeduplicate', 'Adaora Runtimeduplicate', '1981-02-03', 'active', 'hid'),
         ($3, $4, 'Bisi', 'Runtimevisit', 'Bisi Runtimevisit', '1982-03-04', 'active', 'hid')`,
  [existingPatient, existingHid, visitPatient, visitHid]);
const pinGrant = randomUUID(), pinRequest = randomUUID();
await pool.query(`insert into identity.access_requests (id, patient_id, staff_id, membership_id, facility_id, scope, purpose_of_use,
    reason, status, requested_duration_minutes, approved_at, authorization_method, created_at)
  values ($1, $2, $3, $4, $5, 'write_records', 'direct-care', 'Patient access PIN verification', 'approved', 1440,
    clock_timestamp() - interval '30 days', 'patient_access_pin', clock_timestamp() - interval '30 days')`,
  [pinRequest, visitPatient, members.doctor.staff, members.doctor.membership, ids.facA]);
await pool.query(`insert into identity.consent_grants (id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
    scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, authorization_method, created_at)
  values ($1, $2, $3, $4, $5, $6, $7, 'write_records', 'direct-care', 'expired', 'Patient access PIN verification',
    clock_timestamp() - interval '30 days', clock_timestamp() - interval '29 days', false, 'patient_access_pin',
    clock_timestamp() - interval '30 days')`,
  [pinGrant, pinRequest, visitPatient, members.doctor.staff, members.doctor.account, members.doctor.membership, ids.facA]);
{
  // The visit, as the fixture's own row (no grant is live now, so the runtime could not write it).
  const fixture = await pool.connect();
  try {
    await fixture.query('begin');
    await fixture.query('set local session_replication_role = replica');
    await fixture.query(
`insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
    status, started_at, ended_at, chief_complaint, created_at)
  values ($1, $2, $3, $4, $5, 'ambulatory', 'completed', clock_timestamp() - interval '30 days' + interval '1 hour',
    clock_timestamp() - interval '30 days' + interval '2 hours', 'Synthetic runtime visit',
    clock_timestamp() - interval '30 days' + interval '1 hour')`,
  [randomUUID(), visitPatient, ids.facA, members.doctor.account, members.doctor.membership]);
    await fixture.query('commit');
  } finally { fixture.release(); }
}

const tokens = { verify: async (token) => {
  const actor = actors[token];
  if (!actor) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
  return { actor, claims: {} };
}, verifyCsrf: () => true };
const unusedNinProvider = { name: 'deferred', verify: async () => { throw new Error('No NIN check in this verifier'); } };

let app;
try {
  const module = await Test.createTestingModule({
    controllers: [NinRegistrationController, ConsentController],
    providers: [NinRegistrationService, RegistrationWithoutNinService, NinProviderBreaker, NinIdentifierProtector,
      HidCodeGenerator, ConsentService, AuditService,
      { provide: DatabaseService, useValue: database },
      { provide: TokenService, useValue: tokens },
      { provide: NIN_VERIFICATION_PROVIDER, useValue: unusedNinProvider },
      { provide: APP_GUARD, useFactory: (reflector, audit) => new SecurityGuard(reflector, tokens, audit, database),
        inject: [Reflector, AuditService] },
      { provide: APP_INTERCEPTOR, useFactory: (reflector, audit) => new AuditInterceptor(reflector, audit),
        inject: [Reflector, AuditService] }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.use((req, _res, next) => { req.correlationId = `runtime-desk-${randomUUID()}`; next(); });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
    exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
      errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();
  const http = request(app.getHttpServer());
  const as = (name, method, path, purpose = 'healthcare-operations') => http[method](`/api/v1/identity/${path}`)
    .set('Authorization', `Bearer ${name}`).set('X-Facility-ID', members[name].facility).set('X-Purpose-Of-Use', purpose);
  const answers = [];
  const record = (response) => { answers.push(JSON.stringify(response.body)); return response; };
  const deskBody = (overrides = {}) => ({ firstName: 'Chiamaka', lastName: `Runtimenew${run.replace(/\d/g, '')}`,
    dateOfBirth: '1990-05-06', noNinReason: 'not_carried', purpose: 'healthcare-operations', phone: '08030000001',
    addressLine: '1 Synthetic Close, Yaba', city: 'Lagos', stateCode: 'LA', lga: 'Lagos Mainland',
    hasExistingHealthId: false, ...overrides });

  // Capabilities.
  const capabilities = record(await as('desk', 'get', 'registration-capabilities').expect(200));
  assert.equal(capabilities.body.withoutNin.enabled, true);
  assert.equal(capabilities.body.newPatientRegistrationRequiresNin, false);

  // 0130: no possible duplicate, so the desk's request creates the patient.
  const created = record(await as('desk', 'post', 'registration-cases/without-nin')
    .set('Idempotency-Key', `runtime-desk-${run}-0001`).send(deskBody()));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.outcome, 'registered'); assert.equal(created.body.ninStatus, 'not_verified');
  assert.match(created.body.patient.hid, /^HID-/);
  const createdPatient = created.body.patient.patientId;
  const replay = record(await as('desk', 'post', 'registration-cases/without-nin')
    .set('Idempotency-Key', `runtime-desk-${run}-0001`).send(deskBody()).expect(201));
  assert.equal(replay.body.replayed, true); assert.equal(replay.body.caseId, created.body.caseId);
  const stored = (await pool.query(`select patient.source_system, registration.identity_evidence,
      (select count(*)::integer from identity.patient_identifiers where patient_id = patient.id) as identifiers,
      (select count(*)::integer from identity.patient_facility_contacts where patient_id = patient.id) as contacts
    from identity.registration_cases registration join identity.patients patient on patient.id = registration.resolved_patient_id
   where registration.id = $1`, [created.body.caseId])).rows[0];
  assert.deepEqual(stored, { source_system: 'hid-desk-registration', identity_evidence: 'none', identifiers: 0, contacts: 1 });

  // An adult without a phone is refused before anything is sent.
  const noPhone = record(await as('desk', 'post', 'registration-cases/without-nin')
    .set('Idempotency-Key', `runtime-desk-${run}-0002`).send(deskBody({ phone: undefined })));
  assert.equal(noPhone.status, 400);

  // A possible duplicate (the same last name and date of birth as an existing patient) is sent for review, and the
  // desk is told nothing about who it might be.
  const review = record(await as('desk', 'post', 'registration-cases/without-nin')
    .set('Idempotency-Key', `runtime-desk-${run}-0003`)
    .send(deskBody({ firstName: 'Ada', lastName: 'Runtimeduplicate', dateOfBirth: '1981-02-03', phone: '08030000002' })));
  assert.equal(review.status, 201, JSON.stringify(review.body));
  assert.equal(review.body.outcome, 'sent_for_review'); assert.equal(review.body.patient, undefined);
  assert(!JSON.stringify(review.body).includes(existingPatient) && !JSON.stringify(review.body).includes('Adaora'));
  const deskView = record(await as('desk', 'get', `registration-cases/${review.body.caseId}`).expect(200));
  assert.deepEqual(deskView.body.candidates, []);
  const approverView = record(await as('approver', 'get', `registration-cases/${review.body.caseId}`).expect(200));
  assert.deepEqual(approverView.body.candidates.map(card => card.patientId), [existingPatient]);
  assert.deepEqual(Object.keys(approverView.body.candidates[0]).sort(), ['dateOfBirth', 'fullName', 'patientId']);
  // Link-existing is always an approver's.
  record(await as('desk', 'post', `registration-cases/${review.body.caseId}/link-existing`)
    .set('Idempotency-Key', `runtime-desk-${run}-0004`).send({ patientId: existingPatient, expectedVersion: 1,
      reason: 'Same person, checked the card', purpose: 'healthcare-operations' }).expect(403));
  const linked = record(await as('approver', 'post', `registration-cases/${review.body.caseId}/link-existing`)
    .set('Idempotency-Key', `runtime-desk-${run}-0005`).send({ patientId: existingPatient, expectedVersion: 1,
      reason: 'Same person, checked the card', purpose: 'healthcare-operations' }));
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  assert.equal(linked.body.status, 'linked_existing');

  // 0131: the doctor opens the patient registered at this desk without a PIN.
  const opened = record(await as('doctor', 'post', 'own-facility-access', 'direct-care').send({ hid: created.body.patient.hid }));
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.deepEqual(opened.body.authorization, { basis: 'own-facility', scope: 'write_records', purpose: 'direct-care' });
  assert.equal(opened.body.patientId, createdPatient); assert.equal(opened.body.existingGrant, false);
  const again = record(await as('doctor', 'post', 'own-facility-access', 'direct-care').send({ patientId: createdPatient }).expect(200));
  assert.equal(again.body.existingGrant, true); assert.equal(again.body.consentGrantId, opened.body.consentGrantId);
  // The nurse opens the patient with a consented visit here 30 days ago.
  record(await as('nurse', 'post', 'own-facility-access', 'direct-care').send({ hid: visitHid }).expect(200));
  // The front desk, lab and pharmacy never can.
  for (const name of ['desk', 'lab', 'pharmacist']) {
    record(await as(name, 'post', 'own-facility-access', 'direct-care').send({ hid: visitHid }).expect(403));
  }
  // Another facility's doctor is refused; the patient linked without a NIN and never confirmed is not this facility's.
  const otherFacility = record(await as('doctorB', 'post', 'own-facility-access', 'direct-care').send({ hid: visitHid }).expect(403));
  assert.equal(otherFacility.body.code, 'OWN_FACILITY_ACCESS_REFUSED');
  record(await as('doctor', 'post', 'own-facility-access', 'direct-care').send({ hid: existingHid }).expect(403));
  // A Health ID that does not exist: "No such patient" (owner Q100 B).
  const unknown = record(await as('doctor', 'post', 'own-facility-access', 'direct-care').send({ hid: 'HID-ZZ9ZZ9' }).expect(404));
  assert.equal(unknown.body.code, 'PATIENT_NOT_FOUND'); assert.match(unknown.body.detail, /^No such patient/);
  // Emergency purpose is not this route's.
  record(await as('doctor', 'post', 'own-facility-access', 'emergency').send({ hid: visitHid }).expect(400));

  const grant = (await pool.query(`select scope, purpose_of_use, authorization_method, request_id is null as no_request,
      extract(epoch from expires_at - starts_at)::integer / 60 as minutes from identity.consent_grants where id = $1`,
    [opened.body.consentGrantId])).rows[0];
  assert.deepEqual(grant, { scope: 'write_records', purpose_of_use: 'direct-care', authorization_method: 'own_facility',
    no_request: true, minutes: 1440 });
  const audits = (await pool.query(`select outcome, count(*)::integer as n from audit.events
     where action = 'identity.patient.open-own-facility' and facility_id = any($1::uuid[]) group by outcome order by outcome`,
    [[ids.facA, ids.facB]])).rows;
  assert.deepEqual(audits, [{ outcome: 'denied', n: 3 }, { outcome: 'success', n: 3 }]);
  const guardDenials = (await pool.query(`select count(*)::integer as n from audit.events
     where action = 'security.authorization' and outcome = 'denied' and actor_account_id = any($1::uuid[])`,
    [[members.desk.account, members.lab.account, members.pharmacist.account]])).rows[0].n;
  assert(guardDenials >= 4, 'Every refused member is audited');
  const registrationAudits = (await pool.query(`select count(*)::integer as n from audit.events
     where action in ('identity.registration.without-nin', 'identity.registration.without-nin.review')
       and facility_id = $1 and outcome = 'success'`, [ids.facA])).rows[0].n;
  assert.equal(registrationAudits, 3);
  assert(!answers.some(answer => /unverified/i.test(answer)), 'No answer says "unverified"');

  process.stdout.write(JSON.stringify({ status: 'passed', scope: 'local-synthetic-only', role: 'hid_identity_api_runtime',
    registration_without_nin: { created_at_desk: true, replay: true, phone_required: true, sent_for_review: true,
      desk_sees_no_candidates: true, approver_minimal_cards: true, link_existing_approver_only: true },
    own_facility: { registered_here: true, visit_here: true, reused_grant: true, desk_lab_pharmacy_refused: true,
      other_facility_refused: true, unconfirmed_link_refused: true, unknown_health_id: 'No such patient',
      grant: '24h write, direct care, own_facility, no access request', audit_rows: audits },
    no_unverified_word: true }) + '\n');
} finally { if (app) await app.close(); await pool.end(); }
