#!/usr/bin/env node
// Emergency-contact HTTP workflow against the owned disposable synthetic
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
  EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true', EMERGENCY_CONTACT_CHANNELS: 'email',
  PATIENT_LIFECYCLE_SWEEP_SECONDS: '0' });
for (const key of ['AUTH_COOKIE_DOMAIN', 'EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS', 'NIN_LOOKUP_HMAC_KEY_B64',
  'METAMAP_CLIENT_ID', 'METAMAP_CLIENT_SECRET', 'QOREID_CLIENT_ID', 'QOREID_CLIENT_SECRET', 'QOREID_API_KEY']) {
  delete process.env[key];
}
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
const { ConsentController } = load('consent/consent.controller.ts');
const { ConsentService } = load('consent/consent.service.ts');
const { EmergencyContactController } = load('patient-safety/emergency-contact.controller.ts');
// 0087: the access history (PatientSelfController) serves the revocation's labels.
const { PatientSelfController } = load('auth/patient-self.controller.ts');
const { PatientSelfService } = load('auth/patient-self.service.ts');
const { EmergencyContactService } = load('patient-safety/emergency-contact.service.ts');
const { EmergencyContactProtector } = load('patient-safety/emergency-contact-protector.ts');
const { EmergencyContactNotificationDispatcher } = load('patient-safety/emergency-contact-notification.dispatcher.ts');
const { AdminService } = load('admin/admin.service.ts');
const { ProblemDetailsFilter } = load('common/problem.ts');
const { getEnvironment } = load('config/environment.ts');
// Run in a disposable copy of the rehearsal database so the synthetic patients,
// facility and purpose rows below never leak into later rehearsal steps.
const isolated = `hid_rehearsal_contacts_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const maintenance = new Pool({ host: socket, user: process.env.PGUSER, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
const pool = new Pool({ host: socket, user: process.env.PGUSER, database: isolated, max: 5 });
const asRuntime = async (prepare, operation) => {
  const client = await pool.connect();
  try { await client.query('begin'); await client.query('set local role hid_identity_api_runtime');
    await prepare(client);
    const result = await operation(client); await client.query('commit'); return result;
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
};
const database = {
  query: (sql, values) => asRuntime(async () => undefined, client => client.query(sql, values)),
  withSystemTransaction: (correlation, operation) => asRuntime(client => client.query(
    "select set_config('app.actor_subject','system:auth',true),set_config('app.correlation_id',$1,true)", [correlation]), operation),
  // A staff or platform request's transaction, with the context DatabaseService sets.
  withTransaction: (context, operation) => asRuntime(client => requestContext(client, context), operation),
  withPlatformTransaction: (context, operation) => asRuntime(client => requestContext(client, context), operation),
};
function requestContext(client, context) {
  return client.query(`select
      set_config('app.actor_subject',$1,true), set_config('app.facility_id',$2,true),
      set_config('app.correlation_id',$3,true), set_config('app.membership_id',$4,true),
      set_config('app.purpose_of_use',$5,true)`,
  [context.actor.subject, context.facilityId ?? '', context.correlationId, context.membershipId ?? '',
    context.purposeOfUse]);
}
// Local delivery stub: captures what notification-api would receive.
const delivered = [];
const notification = {
  deliver: async (input) => { delivered.push({ kind: 'verification', ...input }); return { outcome: 'accepted', provider: 'brevo' }; },
  deliverEmergencyContactAlert: async (input) => { delivered.push({ kind: 'alert', ...input }); return { outcome: 'accepted', provider: 'brevo' }; },
  // 0095's (B4) and 0096's (B5) emails: no service this verifier builds calls them; stubbed so a wiring change cannot reach the network.
  deliverPatientShareInvitation: async () => ({ outcome: 'accepted', provider: 'brevo' }),
  deliverShareReceived: async () => ({ outcome: 'accepted', provider: 'brevo' }),
  deliverRecordAccessAlert: async () => ({ outcome: 'accepted', provider: 'brevo' }),
  deliverAccountDeletionNotice: async () => ({ outcome: 'accepted', provider: 'brevo' }),
};
let app;
try {
  const module = await Test.createTestingModule({
    controllers: [AuthController, ConsentController, EmergencyContactController, PatientSelfController],
    providers: [{ provide: DatabaseService, useValue: database }, TokenService, LocalAuthProvider,
      CurrentStaffContextService, CurrentPatientContextService, AuthService, AuthSessionAuditService,
      AuditService, WorkloadAuthService, TurnstileService, ConsentService, PatientSelfService,
      EmergencyContactService, EmergencyContactProtector, EmergencyContactNotificationDispatcher,
      { provide: NotificationOtpClient, useValue: notification },
      { provide: GoogleAuthenticationService, useValue: {
        login: async () => { throw new Error('Google exchange is outside the emergency-contact verifier'); },
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
  async function patient(hid, fullName) {
    const accountId = randomUUID(), patientId = randomUUID();
    const email = `synthetic-contacts-${accountId}@example.invalid`;
    await pool.query("insert into auth.accounts(id,subject,email,display_name,status,password_hash,password_algorithm) values($1,$2,$3,'Synthetic contacts patient','active',$4,'argon2id')",
      [accountId, `synthetic:emergency-contacts:${accountId}`, email, passwordHash]);
    const [firstName, lastName] = fullName.split(' ');
    await pool.query("insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status) values($1,$2,$3,$4,$5,$6,'active')",
      [patientId, accountId, hid, firstName, lastName, fullName]);
    return { accountId, patientId, email };
  }
  const cookies = response => response.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  const signIn = async (path, email, turnstileAction) => {
    const response = await http.post(`/api/v1${path}`).set('Origin', origin).send({ email, password, turnstileAction });
    assert.equal(response.status, 200, `sign-in failed: ${JSON.stringify(response.body)}`);
    return { cookie: cookies(response), csrf: response.headers['x-csrf-token'] };
  };
  const post = (who, path, body = {}) => http.post(`/api/v1${path}`).set('Cookie', who.cookie).set('Origin', origin)
    .set('x-csrf-token', who.csrf).send(body);
  const get = (who, path) => http.get(`/api/v1${path}`).set('Cookie', who.cookie);
  const problem = (response, status, code, label) => {
    assert.equal(response.status, status, `${label}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, code, label);
  };

  const a = await patient('HID-CNTCTAAA', 'Amina Okafor'); const b = await patient('HID-CNTCTBBB', 'Bisi Okafor');
  const sa = await signIn('/auth/patient/login', a.email, 'patient-login');
  const sb = await signIn('/auth/patient/login', b.email, 'patient-login');
  const contacts = '/identity/me/emergency-contacts';

  // Availability and channels: email only here, as production's email-brevo profile.
  assert.deepEqual((await get(sa, `${contacts}/availability`).expect(200)).body, { delivery: true, channels: ['email'] });
  await http.get(`/api/v1${contacts}`).expect(401);
  problem(await post(sa, contacts, { name: 'Chidi Okafor', relationship: 'sibling', channel: 'sms',
    destination: '0803 123 4567' }), 400, 'EMERGENCY_CONTACT_CHANNEL_UNAVAILABLE', 'an SMS contact while only email is enabled');

  // Encrypted storage, ownership, verification, lifecycle.
  const added = await post(sa, contacts, { name: 'Chidi Okafor', relationship: 'sibling', channel: 'email',
    destination: ' Chidi.Okafor@Example.INVALID ' }).expect(201);
  assert.equal(added.body.status, 'unverified'); assert.equal(added.body.eligibleForEmergencyNotification, false);
  assert.equal(added.body.destinationHint, 'c•••@example.invalid');
  const protector = module.get(EmergencyContactProtector);
  const stored = (await pool.query(`select contact_ciphertext, contact_key_version, destination_hmac
    from identity.patient_emergency_contacts where id=$1`, [added.body.contactId])).rows[0];
  assert(!stored.contact_ciphertext.toString('latin1').includes('chidi.okafor'), 'Contact destination must be encrypted');
  assert.equal(stored.destination_hmac, protector.destinationHmac('email', 'chidi.okafor@example.invalid'));
  problem(await post(sa, contacts, { name: 'Chidi Again', relationship: 'sibling', channel: 'email',
    destination: 'chidi.okafor@example.invalid' }), 409, 'EMERGENCY_CONTACT_DUPLICATE', 'a duplicate destination');
  await post(sb, `${contacts}/${added.body.contactId}/deactivate`).expect(404);
  assert.deepEqual((await get(sb, contacts).expect(200)).body, []);
  const sent = await post(sa, `${contacts}/${added.body.contactId}/verification`).expect(202);
  const code = delivered.at(-1);
  assert.equal(code.purpose, 'EMERGENCY_CONTACT_VERIFY'); assert.equal(code.recipient, 'chidi.okafor@example.invalid');
  assert.equal(code.channel, 'email');
  const wrongCode = String((Number(code.code) + 1) % 1_000_000).padStart(6, '0');
  problem(await post(sa, `${contacts}/${added.body.contactId}/verification/confirm`,
    { challengeId: sent.body.challengeId, code: wrongCode }), 403, 'EMERGENCY_CONTACT_CODE_INVALID', 'a wrong code');
  await post(sb, `${contacts}/${added.body.contactId}/verification/confirm`,
    { challengeId: sent.body.challengeId, code: code.code }).expect(403);
  await post(sa, `${contacts}/${added.body.contactId}/verification/confirm`,
    { challengeId: sent.body.challengeId, code: code.code }).expect(200);
  await post(sa, `${contacts}/${added.body.contactId}/verification/confirm`,
    { challengeId: sent.body.challengeId, code: code.code }).expect(403);
  const listed = (await get(sa, contacts).expect(200)).body;
  assert.equal(listed[0].status, 'verified'); assert.equal(listed[0].eligibleForEmergencyNotification, true);
  const renamed = await post(sa, `${contacts}/${added.body.contactId}`,
    { expectedVersion: listed[0].version, name: 'Chidi O.' }).expect(200);
  assert.equal(renamed.body.name, 'Chidi O.'); assert.equal(renamed.body.status, 'verified');
  problem(await post(sa, `${contacts}/${added.body.contactId}`, { expectedVersion: listed[0].version, name: 'Stale' }),
    409, 'EMERGENCY_CONTACT_VERSION_CONFLICT', 'a stale version');

  // A facility with an alert phone, and a doctor who uses break-glass there.
  const ids = { org: randomUUID(), facility: randomUUID(), staffAccount: randomUUID(), staff: randomUUID(),
    membership: randomUUID() };
  const staffEmail = `clinician-${ids.staffAccount}@example.invalid`;
  await pool.query("insert into identity.organizations(id,name,slug) values($1,'Contacts Rehearsal Org',$2)", [ids.org, `contacts-${ids.org}`]);
  await pool.query("insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status) values($1,$2,'Lagos General',$3,'Africa/Lagos',true,'verified')",
    [ids.facility, ids.org, `CONT-${ids.facility.slice(0, 6)}`]);
  await pool.query("insert into identity.facility_alert_phones(facility_id,phone_e164,reason,updated_by_account_id) values($1,'+2348030000000','Synthetic rehearsal phone',$2)",
    [ids.facility, a.accountId]);
  await pool.query("insert into auth.accounts(id,subject,email,display_name,status,password_hash,password_algorithm) values($1,$2,$3,'Synthetic clinician','active',$4,'argon2id')",
    [ids.staffAccount, `synthetic:clinician:${ids.staffAccount}`, staffEmail, passwordHash]);
  await pool.query("insert into identity.staff(id,account_id,full_name,email,verification_status,default_role) values($1,$2,'Dr Bola Adeyemi',$3,'verified','doctor')",
    [ids.staff, ids.staffAccount, staffEmail]);
  await pool.query("insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,app_role,is_primary,active) values($1,$2,$3,$4,$5,'doctor','doctor',true,true)",
    [ids.membership, ids.staff, ids.staffAccount, ids.org, ids.facility]);
  await pool.query("insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason) values($1,$2,'doctor','facility',$3,$4,'Synthetic rehearsal role')",
    [randomUUID(), ids.staffAccount, ids.membership, ids.facility]);
  // Novu seeds only direct-care; break-glass needs an active emergency purpose (SPEC 1.3).
  await pool.query(`insert into identity.purpose_of_use_codes(code,display,source_system)
    values('emergency','Emergency treatment','emergency-contacts-rehearsal') on conflict (code) do update set active=true`);
  const clinician = await signIn('/auth/login', staffEmail, 'staff-login');
  // A staff session is refused on every patient-only route, before the handler.
  problem(await get(clinician, contacts), 403, 'PATIENT_SESSION_REQUIRED', 'a staff session listing contacts');
  problem(await get(clinician, `${contacts}/availability`), 403, 'PATIENT_SESSION_REQUIRED', 'a staff session reading availability');
  const breakGlassReason = 'Unconscious patient emergency access';
  const activated = await http.post('/api/v1/identity/break-glass').set('Cookie', clinician.cookie).set('Origin', origin)
    .set('x-csrf-token', clinician.csrf).set('X-Facility-ID', ids.facility).set('X-Purpose-Of-Use', 'emergency')
    .send({ hid: 'HID-CNTCTAAA', reason: breakGlassReason, durationMinutes: 15 });
  assert.equal(activated.status, 201, `break-glass failed: ${JSON.stringify(activated.body)}`);
  const intents = (await pool.query('select status from identity.emergency_contact_notifications where consent_grant_id=$1',
    [activated.body.consentGrantId])).rows;
  assert.deepEqual(intents, [{ status: 'pending' }], 'break-glass creates one intent for the verified contact');

  // 0087 (main 0066 items 2-3): the access history's labels and the patient's
  // revocation, as the website calls them. sa signed in moments ago, so the
  // approval below has its recent sign-in, and no recovery hold exists yet.
  const historyItem = async (who, grantId) => (await get(who, '/identity/me/access-history').expect(200)).body.items
    .find((item) => item.consentGrantId === grantId);
  const revokeGrant = (who, grantId, reason = 'No longer needed') =>
    post(who, `/identity/me/consent-grants/${grantId}/revoke`, { reason });
  const emergencyItem = await historyItem(sa, activated.body.consentGrantId);
  assert.deepEqual([emergencyItem.breakGlass, emergencyItem.patientRevocable, 'revocableByPatient' in emergencyItem],
    [true, false, false], 'break-glass is labelled and never revocable; the database key is not published');
  problem(await revokeGrant(sa, activated.body.consentGrantId), 409, 'CONSENT_COMMAND_CONFLICT', 'revoking break-glass');
  problem(await revokeGrant(clinician, activated.body.consentGrantId), 403, 'PATIENT_SESSION_REQUIRED', 'a staff session revoking');
  const asked = await http.post('/api/v1/identity/access-requests').set('Cookie', clinician.cookie).set('Origin', origin)
    .set('x-csrf-token', clinician.csrf).set('X-Facility-ID', ids.facility).set('X-Purpose-Of-Use', 'direct-care')
    .send({ hid: 'HID-CNTCTAAA', scope: 'read_records', reason: 'Follow-up review visit', durationMinutes: 60 });
  assert.equal(asked.status, 201, `access request failed: ${JSON.stringify(asked.body)}`);
  const approval = await post(sa, `/identity/access-requests/${asked.body.accessRequestId}/approve`);
  assert.equal(approval.status, 200, `approval failed: ${JSON.stringify(approval.body)}`);
  const approvedGrantId = approval.body.consentGrantId;
  const approvedItem = await historyItem(sa, approvedGrantId);
  assert.deepEqual([approvedItem.breakGlass, approvedItem.patientRevocable], [false, true]);
  problem(await revokeGrant(sb, approvedGrantId), 404, 'CONSENT_RESOURCE_NOT_FOUND', "another patient's grant");
  const revoked = await revokeGrant(sa, approvedGrantId, '  No longer needed  ');
  assert.equal(revoked.status, 200, `revocation failed: ${JSON.stringify(revoked.body)}`);
  assert.deepEqual([revoked.body.consentGrantId, revoked.body.status, revoked.body.replayed], [approvedGrantId, 'revoked', false]);
  const again = await revokeGrant(sa, approvedGrantId);
  assert.deepEqual([again.status, again.body.replayed], [200, true]);
  const revokedItem = await historyItem(sa, approvedGrantId);
  assert.deepEqual([revokedItem.status, revokedItem.patientRevocable], ['revoked', false]);
  // The facility's audit sees that the patient revoked, never the patient's words (kept on the grant).
  assert.deepEqual((await pool.query(`select actor_type, facility_id, reason from audit.events
    where action = 'identity.consent-grant.patient-revoke' and resource_id = $1`, [approvedGrantId])).rows,
    [{ actor_type: 'patient', facility_id: ids.facility, reason: 'Revoked by the patient' }]);
  assert.equal((await pool.query('select revoked_reason from identity.consent_grants where id = $1', [approvedGrantId]))
    .rows[0].revoked_reason, 'No longer needed');

  // The leased dispatcher sends the owner's field set, masked, and never the typed reason.
  const dispatcher = module.get(EmergencyContactNotificationDispatcher);
  const summary = await dispatcher.dispatch(`emergency-contacts-${randomUUID()}`);
  assert.deepEqual(summary, { claimed: 1, delivered: 1, retried: 0, failed: 0 });
  const alert = delivered.at(-1);
  assert.deepEqual(Object.keys(alert).sort(), ['channel', 'clinicianName', 'correlationId', 'facilityName', 'facilityPhone',
    'kind', 'notificationId', 'occurredAt', 'patientFullName', 'patientHidSuffix', 'recipient']);
  assert.deepEqual([alert.kind, alert.channel, alert.recipient, alert.patientFullName, alert.patientHidSuffix,
    alert.clinicianName, alert.facilityName, alert.facilityPhone],
  ['alert', 'email', 'chidi.okafor@example.invalid', 'Amina Okafor', 'TAAA', 'Dr Bola Adeyemi', 'Lagos General', '+2348030000000']);
  const alertText = JSON.stringify(alert);
  assert(!alertText.includes('HID-CNTCTAAA') && !alertText.includes(breakGlassReason), 'no full HID and no typed reason');
  assert.equal((await dispatcher.dispatch(`emergency-contacts-${randomUUID()}`)).claimed, 0,
    'A delivered alert must not be sent twice');
  const contactAudit = (await pool.query(`select action, facility_id, details::text from audit.events
    where action like 'identity.emergency-contact.notification.%' and patient_id=$1`, [a.patientId])).rows;
  assert(contactAudit.length > 0 && contactAudit.every((row) => row.facility_id === null
    && !row.details.includes('chidi') && !row.details.includes('Amina')), 'contact alert audit rows carry no facility or contact details');

  // Removal erases the name and destination; the row only records that a contact existed.
  await post(sa, `${contacts}/${added.body.contactId}/deactivate`).expect(200);
  assert.deepEqual((await get(sa, contacts).expect(200)).body, []);
  assert.deepEqual((await pool.query(`select status, contact_ciphertext, contact_key_version, destination_hmac
    from identity.patient_emergency_contacts where id=$1`, [added.body.contactId])).rows,
  [{ status: 'deactivated', contact_ciphertext: null, contact_key_version: null, destination_hmac: null }]);
  problem(await post(sa, `${contacts}/${added.body.contactId}/verification`), 404, 'EMERGENCY_CONTACT_NOT_FOUND',
    'a removed contact cannot be verified again');

  // REC-NOTIFY: for 24 hours after an OTP account recovery, adding a contact is refused.
  const recoveryId = randomUUID();
  await pool.query(`insert into auth.otp_challenges(id,account_id,recipient_hmac,purpose,channel,verifier_hmac,verifier_key_version,
      expires_at,max_attempts,verified_at,completion_token_hmac,completion_expires_at,consumed_at)
    values($1,$2,repeat('a',64),'PASSWORD_RESET','email',repeat('b',64),'rehearsal',clock_timestamp()+interval '5 minutes',5,
      clock_timestamp(),repeat('c',64),clock_timestamp()+interval '5 minutes',clock_timestamp())`, [recoveryId, a.accountId]);
  const another = { name: 'Ngozi Okafor', relationship: 'sibling', channel: 'email', destination: 'ngozi-hold@example.invalid' };
  problem(await post(sa, contacts, another), 403, 'PATIENT_RECENT_RECOVERY_HOLD', 'adding a contact during the hold');
  await pool.query("update auth.otp_challenges set consumed_at=consumed_at-interval '25 hours' where id=$1", [recoveryId]);
  await post(sa, contacts, another).expect(201);

  // Platform administration, called as the service the admin routes use: the
  // facility alert phone and support's opt-out, under exact platform authority.
  const admin = new AdminService(database, module.get(AuditService), protector);
  async function platformActor(roleCode) {
    const accountId = randomUUID(), subject = `synthetic:platform:${accountId}`;
    await pool.query("insert into auth.accounts(id,subject,email,display_name,status) values($1,$2,$3,'Synthetic platform admin','active')",
      [accountId, subject, `platform-${accountId}@example.invalid`]);
    await pool.query("insert into auth.account_roles(id,account_id,role_code,scope_type,grant_reason) values($1,$2,$3,'platform','Synthetic rehearsal role')",
      [randomUUID(), accountId, roleCode]);
    const platformPermissions = (await pool.query(`select array_agg(distinct permission_code order by permission_code) as codes
      from auth.role_permissions where role_code=$1`, [roleCode])).rows[0].codes;
    return { correlationId: `emergency-contacts-admin-${randomUUID()}`, purposeOfUse: 'healthcare-operations',
      actor: { id: subject, subject, accountId, roles: [], permissions: [], platformRoles: [roleCode], platformPermissions,
        facilityIds: [], facilities: [], authenticationMethod: 'local' } };
  }
  const refusedWith = async (promise, status, code, label) => {
    const error = await promise.then(() => undefined, (failure) => failure);
    assert.equal(error?.getStatus?.(), status, `${label}: ${error?.message}`); assert.equal(error.code, code, label);
  };
  const superAdmin = await platformActor('platform_super_admin');
  const facilityRead = await admin.facility(superAdmin, ids.facility);
  assert.equal(facilityRead.alertPhoneE164, '+2348030000000'); assert(facilityRead.alertPhoneUpdatedAt instanceof Date);
  const phoneChange = await admin.setFacilityAlertPhone(superAdmin, ids.facility, facilityRead.version,
    { phone: '0803 111 2222', reason: 'Facility front desk line' }, `admin-alert-phone-${randomUUID()}`);
  assert.deepEqual(phoneChange, { facilityId: ids.facility, alertPhoneE164: '+2348031112222',
    version: facilityRead.version + 1, replayed: false });
  assert.equal((await admin.facility(superAdmin, ids.facility)).alertPhoneE164, '+2348031112222');
  await refusedWith(admin.setFacilityAlertPhone(superAdmin, ids.facility, phoneChange.version,
    { phone: '12345', reason: 'Facility front desk line' }, `admin-alert-phone-${randomUUID()}`),
  400, 'ADMIN_INVALID_FACILITY_PHONE', 'a bad facility phone');
  await refusedWith(admin.setFacilityAlertPhone(superAdmin, ids.facility, facilityRead.version,
    { phone: null, reason: 'Facility front desk line' }, `admin-alert-phone-${randomUUID()}`),
  409, 'VERSION_CONFLICT', 'a stale facility version');
  const phoneAudit = (await pool.query(`select details from audit.events where action='admin.facility.alert-phone.change'
    and resource_id=$1`, [ids.facility])).rows;
  assert.deepEqual(phoneAudit, [{ details: { version: phoneChange.version, cleared: false } }]);

  // Support opt-out: one destination, contacts of two patients, both erased and told.
  const shared = { name: 'Shared Contact', relationship: 'friend', channel: 'email', destination: 'shared-contact@example.invalid' };
  const sharedA = (await post(sa, contacts, shared).expect(201)).body.contactId;
  const sharedB = (await post(sb, contacts, { ...shared, destination: 'Shared-Contact@Example.INVALID' }).expect(201)).body.contactId;
  // The patient's existing inbox, which notification-worker does not need to deliver.
  const inbox = async () => (await pool.query(`select patient_id, count(*)::integer as notices from notification.inbox_items
    where patient_id = any($1) and notification_code='EMERGENCY_CONTACT_OPTED_OUT' group by patient_id order by patient_id`,
  [[a.patientId, b.patientId]])).rows;
  assert.deepEqual(await inbox(), []);
  const support = await platformActor('support_admin');
  const optOut = { channel: 'email', destination: ' SHARED-contact@example.invalid ', reason: 'Contact called support to stop alerts' };
  const optOutKey = `admin-opt-out-${randomUUID()}`;
  assert.deepEqual(await admin.optOutEmergencyContact(support, optOut, optOutKey), { contacts: 2, patients: 2, replayed: false });
  assert.deepEqual(await admin.optOutEmergencyContact(support, optOut, optOutKey), { contacts: 2, patients: 2, replayed: true });
  assert.deepEqual((await pool.query(`select count(*)::integer as erased from identity.patient_emergency_contacts
    where id = any($1) and status='deactivated' and deactivation_reason='contact_opted_out'
      and contact_ciphertext is null and contact_key_version is null and destination_hmac is null`,
  [[sharedA, sharedB]])).rows[0].erased, 2, 'support opt-out erases both contacts');
  assert.deepEqual((await get(sb, contacts).expect(200)).body, []);
  assert.deepEqual((await inbox()).map((row) => row.notices), [1, 1], 'each affected patient is told once, replay included');
  const optOutAudit = (await pool.query(`select details, reason from audit.events where action='admin.emergency-contact.opt-out'`)).rows;
  assert.deepEqual(optOutAudit.map((row) => row.details), [{ channel: 'email', contacts: 2, patients: 2 }]);
  const leaked = (await pool.query(`select count(*)::integer as n from audit.events
    where details::text ilike '%shared-contact%' or coalesce(reason, '') ilike '%shared-contact%'`)).rows[0].n;
  assert.equal(leaked, 0, 'no audit row carries the opted-out destination');
  const auditor = await platformActor('security_auditor');
  await refusedWith(admin.optOutEmergencyContact(auditor, optOut, `admin-opt-out-${randomUUID()}`),
    403, 'PERMISSION_DENIED', 'opt-out without platform.emergency-contact.manage');

  const sources = (await pool.query("select count(*) filter (where source_system='identity-api')::integer ok, count(*) filter (where source_system='ehr-api')::integer wrong from audit.events where actor_account_id=any($1) and action like 'identity.emergency-contact.%'", [[a.accountId, b.accountId]])).rows[0];
  process.stdout.write(JSON.stringify({ status: 'passed', scope: 'local-synthetic-only', role: 'hid_identity_api_runtime',
    delivery: 'local-stub-only', availability: 'delivery-on-email-only', sms_contact_refused: true,
    emergency_contacts: 'encrypted-owned-verified-renamed-deactivated', staff_session_refused: true,
    patient_grant_revocation: 'labels-break-glass-409-staff-403-other-patient-404-revoked-replayed-audited-without-patient-words',
    break_glass_contact_alert: 'intent-created-stub-delivered-once', alert_fields: 'full-name-hid-suffix-clinician-facility-phone',
    alert_has_no_full_hid_or_reason: true, alert_audit_without_facility_or_contact_details: true,
    removed_contact_erased: true, recovery_hold: 'add-refused-lifted-after-24h', identity_audit_rows: sources,
    facility_alert_phone: 'read-set-normalized-bad-phone-400-stale-409-audited-without-digits',
    support_opt_out: 'two-patients-erased-told-once-replayed-audited-counts-only-permission-403',
    emergency_contact_delivery_enabled_for_this_rehearsal_only: getEnvironment().EMERGENCY_CONTACT_DELIVERY_ENABLED,
    isolated_database_dropped: true }) + '\n');
} finally {
  if (app) await app.close();
  await pool.end();
  await maintenance.query(`drop database if exists ${isolated}`);
  await maintenance.end();
}
