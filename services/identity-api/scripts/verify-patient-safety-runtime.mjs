#!/usr/bin/env node
// Phase 3 patient-safety HTTP workflow against the owned disposable synthetic
// rehearsal only. Notification delivery is a local stub: no provider, network,
// or cloud call is made. All keys below are synthetic test material.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'staging',
  NIN_PROVIDER_MODE: 'deferred', TURNSTILE_MODE: 'disabled', IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  NIN_ENCRYPTION_KEY_B64: Buffer.alloc(32, 0x5a).toString('base64'), NIN_KEY_VERSION: 'rehearsal-v1',
  OTP_HMAC_KEY_B64: process.env.OTP_HMAC_KEY_B64 ?? Buffer.alloc(32, 0x33).toString('base64'),
  EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true', PATIENT_LIFECYCLE_SWEEP_SECONDS: '0' });
delete process.env.AUTH_COOKIE_DOMAIN;
require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const load = path => require(join(service, 'src', path));
const { Pool } = require('pg');
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
const { PatientSelfController } = load('auth/patient-self.controller.ts');
const { PatientSelfService } = load('auth/patient-self.service.ts');
const { ConsentController } = load('consent/consent.controller.ts');
const { ConsentService } = load('consent/consent.service.ts');
const { PatientAccountDeletionController } = load('patient-safety/patient-account-deletion.controller.ts');
const { PatientAccountDeletionService } = load('patient-safety/patient-account-deletion.service.ts');
const { EmergencyContactController } = load('patient-safety/emergency-contact.controller.ts');
const { EmergencyContactService } = load('patient-safety/emergency-contact.service.ts');
const { EmergencyContactProtector } = load('patient-safety/emergency-contact-protector.ts');
const { EmergencyContactNotificationDispatcher } = load('patient-safety/emergency-contact-notification.dispatcher.ts');
const { ProblemDetailsFilter } = load('common/problem.ts');
const { getEnvironment } = load('config/environment.ts');
const pool = new Pool({ host: socket, user: process.env.PGUSER, database: process.env.PGDATABASE, max: 5 });
const asRuntime = async (correlation, operation) => {
  const client = await pool.connect();
  try { await client.query('begin'); await client.query('set local role hid_identity_api_runtime');
    if (correlation) await client.query("select set_config('app.actor_subject','system:auth',true),set_config('app.correlation_id',$1,true)", [correlation]);
    const result = await operation(client); await client.query('commit'); return result;
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
};
const database = {
  query: (sql, values) => asRuntime(null, client => client.query(sql, values)),
  withSystemTransaction: (correlation, operation) => asRuntime(correlation, operation),
};
// Local delivery stub: captures what notification-api would receive.
const delivered = [];
const notification = {
  deliver: async (input) => { delivered.push({ kind: 'verification', ...input }); return { outcome: 'accepted', provider: 'termii' }; },
  deliverEmergencyContactAlert: async (input) => { delivered.push({ kind: 'alert', ...input }); return { outcome: 'accepted', provider: 'termii' }; },
};
let app;
try {
  const module = await Test.createTestingModule({
    controllers: [AuthController, PatientSelfController, ConsentController, PatientAccountDeletionController, EmergencyContactController],
    providers: [{ provide: DatabaseService, useValue: database }, TokenService, LocalAuthProvider,
      CurrentStaffContextService, CurrentPatientContextService, AuthService, AuthSessionAuditService,
      AuditService, WorkloadAuthService, TurnstileService, PatientSelfService, ConsentService,
      PatientAccountDeletionService, EmergencyContactService, EmergencyContactProtector, EmergencyContactNotificationDispatcher,
      { provide: NotificationOtpClient, useValue: notification },
      { provide: GoogleAuthenticationService, useValue: {
        login: async () => { throw new Error('Google exchange is outside the patient-safety verifier'); },
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
  const http = request(app.getHttpServer());
  const origin = process.env.CORS_ORIGINS.split(',')[0];
  const argon2 = require('argon2');
  const password = 'Synthetic-Patient-Password-2026';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  async function patient(hid) {
    const accountId = randomUUID(), patientId = randomUUID();
    const email = `synthetic-safety-${accountId}@example.invalid`;
    await pool.query("insert into auth.accounts(id,subject,email,display_name,status,password_hash,password_algorithm) values($1,$2,$3,'Synthetic safety patient','active',$4,'argon2id')",
      [accountId, `synthetic:patient-safety:${accountId}`, email, passwordHash]);
    await pool.query("insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status) values($1,$2,$3,'Ada','Safety','Ada Safety','active')",
      [patientId, accountId, hid]);
    return { accountId, patientId, email };
  }
  const login = (email) => http.post('/api/v1/auth/patient/login').set('Origin', origin)
    .send({ email, password, turnstileAction: 'patient-login' });
  const cookies = response => response.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  const session = async (email) => { const response = await login(email).expect(200);
    return { cookie: cookies(response), csrf: response.headers['x-csrf-token'] }; };
  const post = (who, path, body = {}) => http.post(`/api/v1${path}`).set('Cookie', who.cookie).set('Origin', origin)
    .set('x-csrf-token', who.csrf).send(body);
  const get = (who, path) => http.get(`/api/v1${path}`).set('Cookie', who.cookie);

  const a = await patient('HID-SAFETYAA'); const b = await patient('HID-SAFETYBB');
  const sa = await session(a.email); const sb = await session(b.email);

  // Account deletion: status, CSRF, single-use token, scheduling, cancellation.
  const initial = await get(sa, '/identity/me/account-deletion').expect(200);
  assert.equal(initial.body.request, null); assert.equal(initial.body.waitingPeriodSeconds, 1209600);
  await http.post('/api/v1/identity/me/account-deletion').set('Cookie', sa.cookie).set('Origin', origin).expect(403);
  await http.post('/api/v1/identity/me/account-deletion').expect(401);
  const requested = await post(sa, '/identity/me/account-deletion').expect(201);
  assert.match(requested.body.confirmationToken, /^[A-Za-z0-9_-]{43}$/);
  const stored = (await pool.query('select confirmation_token_sha256 from identity.patient_account_deletion_requests where id=$1', [requested.body.requestId])).rows[0];
  assert.notEqual(stored.confirmation_token_sha256, requested.body.confirmationToken, 'The raw confirmation token must not be stored');
  const wrong = await post(sa, '/identity/me/account-deletion/confirm', { requestId: requested.body.requestId,
    confirmationToken: 'A'.repeat(43), confirmation: 'DELETE MY ACCOUNT' }).expect(403);
  assert.equal(wrong.body.code, 'ACCOUNT_DELETION_CONFIRMATION_INVALID');
  await post(sb, '/identity/me/account-deletion/confirm', { requestId: requested.body.requestId,
    confirmationToken: requested.body.confirmationToken, confirmation: 'DELETE MY ACCOUNT' }).expect(403);
  const pending = await post(sa, '/identity/me/account-deletion/confirm', { requestId: requested.body.requestId,
    confirmationToken: requested.body.confirmationToken, confirmation: 'DELETE MY ACCOUNT' }).expect(200);
  assert.equal(pending.body.state, 'pending'); assert(Date.parse(pending.body.scheduledFor) > Date.now() + 13 * 86_400_000);
  await post(sa, '/identity/me/account-deletion/confirm', { requestId: requested.body.requestId,
    confirmationToken: requested.body.confirmationToken, confirmation: 'DELETE MY ACCOUNT' }).expect(403);
  await post(sa, '/identity/me/account-deletion').expect(409);
  await post(sa, '/identity/me/account-deletion/cancel', { requestId: requested.body.requestId }).expect(200);
  assert.equal((await get(sa, '/identity/me/account-deletion').expect(200)).body.request.state, 'cancelled');

  // Emergency contacts: encrypted storage, ownership, verification, lifecycle.
  const added = await post(sa, '/identity/me/emergency-contacts', { name: 'Chidi Okafor', relationship: 'sibling',
    channel: 'sms', destination: '0803 123 4567' }).expect(201);
  assert.equal(added.body.status, 'unverified'); assert.equal(added.body.eligibleForEmergencyNotification, false);
  assert.equal(added.body.destinationHint, '+234•••••567');
  const sealed = (await pool.query('select contact_ciphertext from identity.patient_emergency_contacts where id=$1', [added.body.contactId])).rows[0];
  assert(!sealed.contact_ciphertext.toString('latin1').includes('8031234567'), 'Contact destination must be encrypted');
  await post(sa, '/identity/me/emergency-contacts', { name: 'Chidi Again', relationship: 'sibling', channel: 'sms',
    destination: '+2348031234567' }).expect(409);
  await post(sb, `/identity/me/emergency-contacts/${added.body.contactId}/deactivate`).expect(404);
  assert.deepEqual((await get(sb, '/identity/me/emergency-contacts').expect(200)).body, []);
  const sent = await post(sa, `/identity/me/emergency-contacts/${added.body.contactId}/verification`).expect(202);
  const code = delivered.at(-1);
  assert.equal(code.purpose, 'EMERGENCY_CONTACT_VERIFY'); assert.equal(code.recipient, '+2348031234567');
  const wrongCode = String((Number(code.code) + 1) % 1_000_000).padStart(6, '0');
  assert.equal((await post(sa, `/identity/me/emergency-contacts/${added.body.contactId}/verification/confirm`,
    { challengeId: sent.body.challengeId, code: wrongCode }).expect(403)).body.code, 'EMERGENCY_CONTACT_CODE_INVALID');
  await post(sb, `/identity/me/emergency-contacts/${added.body.contactId}/verification/confirm`,
    { challengeId: sent.body.challengeId, code: code.code }).expect(403);
  await post(sa, `/identity/me/emergency-contacts/${added.body.contactId}/verification/confirm`,
    { challengeId: sent.body.challengeId, code: code.code }).expect(200);
  await post(sa, `/identity/me/emergency-contacts/${added.body.contactId}/verification/confirm`,
    { challengeId: sent.body.challengeId, code: code.code }).expect(403);
  const listed = (await get(sa, '/identity/me/emergency-contacts').expect(200)).body;
  assert.equal(listed[0].status, 'verified'); assert.equal(listed[0].eligibleForEmergencyNotification, true);
  const renamed = await post(sa, `/identity/me/emergency-contacts/${added.body.contactId}`,
    { expectedVersion: listed[0].version, name: 'Chidi O.' }).expect(200);
  assert.equal(renamed.body.name, 'Chidi O.'); assert.equal(renamed.body.status, 'verified');
  await post(sa, `/identity/me/emergency-contacts/${added.body.contactId}`, { expectedVersion: listed[0].version, name: 'Stale' }).expect(409);

  // Break-glass (unchanged authorization) creates an alert intent for the verified
  // contact; the leased dispatcher delivers minimum-necessary fields to the stub.
  const ids = { org: randomUUID(), facility: randomUUID(), staffAccount: randomUUID(), staff: randomUUID(),
    membership: randomUUID() };
  await pool.query("insert into identity.organizations(id,name,slug) values($1,'Safety Rehearsal Org',$2)", [ids.org, `safety-${ids.org}`]);
  await pool.query("insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status) values($1,$2,'Safety Rehearsal Hospital',$3,'Africa/Lagos',true,'verified')",
    [ids.facility, ids.org, `SAFE-${ids.facility.slice(0, 6)}`]);
  await pool.query("insert into auth.accounts(id,subject,email,display_name,status) values($1,$2,$3,'Synthetic clinician','active')",
    [ids.staffAccount, `synthetic:clinician:${ids.staffAccount}`, `clinician-${ids.staffAccount}@example.invalid`]);
  await pool.query("insert into identity.staff(id,account_id,full_name,email,verification_status,default_role) values($1,$2,'Synthetic clinician',$3,'verified','doctor')",
    [ids.staff, ids.staffAccount, `clinician-${ids.staffAccount}@example.invalid`]);
  await pool.query("insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,app_role,is_primary,active) values($1,$2,$3,$4,$5,'doctor','doctor',true,true)",
    [ids.membership, ids.staff, ids.staffAccount, ids.org, ids.facility]);
  await pool.query("insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason) values($1,$2,'doctor','facility',$3,$4,'Synthetic rehearsal role')",
    [randomUUID(), ids.staffAccount, ids.membership, ids.facility]);
  await pool.query("insert into identity.purpose_of_use_codes(code,display,source_system) values('emergency','Emergency treatment','patient-safety-rehearsal') on conflict(code) do nothing");
  const grant = await asRuntime(null, async (client) => {
    await client.query(`select set_config('app.actor_subject',$1,true), set_config('app.membership_id',$2,true),
      set_config('app.facility_id',$3,true), set_config('app.purpose_of_use','emergency',true),
      set_config('app.correlation_id',$4,true)`, [`synthetic:clinician:${ids.staffAccount}`, ids.membership, ids.facility, `breakglass-${randomUUID()}`]);
    return (await client.query("select * from identity.activate_break_glass('HID-SAFETYAA','Unconscious patient emergency access',15)")).rows[0];
  });
  assert.equal(grant.grant_status, 'active');
  const intents = (await pool.query('select status from identity.emergency_contact_notifications where consent_grant_id=$1', [grant.consent_grant_id])).rows;
  assert.deepEqual(intents, [{ status: 'pending' }]);
  const summary = await module.get(EmergencyContactNotificationDispatcher).dispatch(`patient-safety-${randomUUID()}`);
  assert.equal(summary.delivered, 1);
  const alert = delivered.at(-1);
  assert.equal(alert.kind, 'alert'); assert.equal(alert.patientFirstName, 'Ada');
  assert.equal(alert.facilityName, 'Safety Rehearsal Hospital'); assert.equal(alert.recipient, '+2348031234567');
  assert.deepEqual(Object.keys(alert).sort(), ['channel', 'correlationId', 'facilityName', 'kind', 'notificationId', 'occurredAt', 'patientFirstName', 'recipient']);
  assert.equal((await module.get(EmergencyContactNotificationDispatcher).dispatch(`patient-safety-${randomUUID()}`)).claimed, 0,
    'A delivered alert must not be sent twice');
  assert.equal((await pool.query('select status from identity.consent_grants where id=$1', [grant.consent_grant_id])).rows[0].status, 'active');
  await post(sa, `/identity/me/emergency-contacts/${added.body.contactId}/deactivate`).expect(200);
  assert.deepEqual((await get(sa, '/identity/me/emergency-contacts').expect(200)).body, []);

  // Patient inbox and access-request decisions under the least-privilege runtime role.
  await get(sa, '/identity/me/notifications').expect(200);
  await pool.query("insert into identity.purpose_of_use_codes(code,display,source_system) values('direct-care','Direct patient care','patient-safety-rehearsal') on conflict(code) do nothing");
  const accessRequestId = randomUUID();
  await pool.query(`insert into identity.access_requests(id,patient_id,staff_id,membership_id,facility_id,scope,purpose_of_use,reason,status,requested_duration_minutes)
    values($1,$2,$3,$4,$5,'read_records','direct-care','Follow-up consultation','pending',60)`,
    [accessRequestId, a.patientId, ids.staff, ids.membership, ids.facility]);
  const requests = (await get(sa, '/identity/me/access-requests').expect(200)).body;
  assert(requests.some((item) => item.accessRequestId === accessRequestId && item.status === 'pending'));
  assert((await get(sa, '/identity/me/notifications').expect(200)).body.some((item) => item.resourceId === accessRequestId));
  await post(sb, `/identity/access-requests/${accessRequestId}/approve`).expect(404);
  const approved = await post(sa, `/identity/access-requests/${accessRequestId}/approve`).expect(200);
  assert.equal(approved.body.status, 'approved');
  const history = (await get(sa, '/identity/me/access-history').expect(200)).body;
  const approvedGrant = history.items.find((item) => item.consentGrantId === approved.body.consentGrantId);
  const emergencyGrant = history.items.find((item) => item.consentGrantId === grant.consent_grant_id);
  assert.equal(approvedGrant.patientRevocable, true);
  assert.deepEqual([emergencyGrant.breakGlass, emergencyGrant.patientRevocable], [true, false]);
  await post(sa, `/identity/me/consent-grants/${grant.consent_grant_id}/revoke`, { reason: 'Not wanted' }).expect(409);
  await post(sb, `/identity/me/consent-grants/${approved.body.consentGrantId}/revoke`, { reason: 'Not mine' }).expect(404);
  assert.equal((await post(sa, `/identity/me/consent-grants/${approved.body.consentGrantId}/revoke`, { reason: 'No longer needed' })
    .expect(200)).body.status, 'revoked');
  // Staff-only grant close is not reachable with a patient session.
  await post(sa, `/identity/consent-grants/${approved.body.consentGrantId}/close`, { reason: 'Patient attempt' }).expect(403);

  // Zero waiting period completes deletion; the login is then unusable.
  await pool.query("update platform.patient_account_deletion_settings set waiting_period=interval '0'");
  const sb2 = await session(b.email);
  const bRequest = await post(sb2, '/identity/me/account-deletion').expect(201);
  const completed = await post(sb2, '/identity/me/account-deletion/confirm', { requestId: bRequest.body.requestId,
    confirmationToken: bRequest.body.confirmationToken, confirmation: 'delete my account' }).expect(200);
  assert.equal(completed.body.state, 'completed');
  await pool.query("update platform.patient_account_deletion_settings set waiting_period=interval '14 days'");
  await get(sb2, '/identity/me').expect(401);
  await get(sb, '/identity/me').expect(401);
  await login(b.email).expect(401);
  const retained = (await pool.query("select p.status, a.status as account_status, a.password_hash from identity.patients p join auth.accounts a on a.id=p.account_id where p.id=$1", [b.patientId])).rows[0];
  assert.deepEqual(retained, { status: 'active', account_status: 'deleted', password_hash: null });
  const sources = (await pool.query("select count(*) filter (where source_system='identity-api')::integer ok, count(*) filter (where source_system='ehr-api')::integer wrong from audit.events where actor_account_id=any($1)", [[a.accountId, b.accountId]])).rows[0];
  assert(sources.ok > 0 && sources.wrong === 0, 'Identity audit rows must be attributed to identity-api');
  process.stdout.write(JSON.stringify({ status: 'passed', scope: 'local-synthetic-only', role: 'hid_identity_api_runtime',
    delivery: 'local-stub-only', account_deletion: 'request-confirm-replay-cancel-complete', csrf_required: true,
    deleted_login_unusable: true, patient_identity_retained: true, emergency_contacts: 'encrypted-owned-verified-deactivated',
    break_glass_contact_alert: 'intent-created-stub-delivered-once', patient_inbox_runtime: true,
    patient_access_requests_runtime: 'list-approve-revoke', staff_close_route_denied_to_patient: true, audit_source_identity_api: true,
    emergency_contact_delivery_enabled_for_this_rehearsal_only: getEnvironment().EMERGENCY_CONTACT_DELIVERY_ENABLED }) + '\n');
} finally { if (app) await app.close(); await pool.end(); }
