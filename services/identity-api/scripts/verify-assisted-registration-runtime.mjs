#!/usr/bin/env node
// Facility-assisted registration (ADR-063, 0094) over HTTP, as
// hid_identity_api_runtime, on a disposable copy of the owned synthetic
// rehearsal database: a platform administrator designates a facility with a
// fresh step-up; a patient whose NIN record lists no phone starts on their own
// device and shows a desk code; staff signed in with an authenticator check an
// original photo ID and the server compares the typed name and date of birth
// with the NIN record blindly (mismatch, match, replay); the patient then
// verifies a contact, sets a password and signs in. Also: who may check
// (attested nurse yes; receptionist, legacy nurse, an undesignated facility
// no), the route switched off, the budgets, a NIN that already has a Health
// ID (409 with a reference and no identity), an in-person proof racing a
// registry-phone proof of the same NIN, and a suspended designation.
// External services are replaced, never called: QoreID behind the real
// adapter by a local stub, Cloudflare Siteverify by a stub, Notification
// delivery by a stub that captures the codes. Every NIN, name, contact and
// password here is invented.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createTotpClock, platformClient } from './platform-session-client.mjs';
import { enrollmentCodeOutbox, staffClient, supertestTransport, SYNTHETIC_STAFF_MFA_KEY_B64 } from './staff-session-client.mjs';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
assert(process.env.OTP_HMAC_KEY_B64, 'The rehearsal OTP HMAC key is required');
const isolated = `hid_rehearsal_assisted_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const origin = 'https://staging.healthidentitydirectory.com';
const siteHost = new URL(origin).hostname;
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'staging',
  NIN_PROVIDER_MODE: 'deferred', CORS_ORIGINS: origin, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'public-synthetic-ehr-workload-token',
  TURNSTILE_MODE: 'required', TURNSTILE_SECRET_KEY: 'example-turnstile-secret',
  // The staging shape of the facility route: no holder SMS, the facility route on.
  QOREID_ENABLED: 'true', QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'true', NIN_HOLDER_SMS_ENABLED: 'false',
  ASSISTED_REGISTRATION_ENABLED: 'true',
  QOREID_CLIENT_ID: 'example-qoreid-client', QOREID_CLIENT_SECRET: 'example-qoreid-secret',
  MFA_SECRET_KEY_B64: SYNTHETIC_STAFF_MFA_KEY_B64, MFA_KEY_VERSION: 'assisted-runtime-v1',
  PATIENT_LIFECYCLE_SWEEP_SECONDS: '0',
  // Fresh per run, like the deployment's own server-only keys.
  NIN_LOOKUP_HMAC_KEY_B64: randomBytes(32).toString('base64'),
  NIN_ENCRYPTION_KEY_B64: randomBytes(32).toString('base64'),
  CONTACT_LOOKUP_HMAC_KEY_B64: randomBytes(32).toString('base64'),
  DATABASE_URL: `postgresql://${process.env.PGUSER ?? 'postgres'}@localhost/${isolated}?host=${encodeURIComponent(socket)}`
    + `&options=${encodeURIComponent('-c role=hid_identity_api_runtime')}`,
  TRUST_PROXY_CIDRS: '127.0.0.1/32,::1/128' });
delete process.env.AUTH_COOKIE_DOMAIN;
for (const key of ['METAMAP_CLIENT_ID', 'METAMAP_CLIENT_SECRET', 'QOREID_API_KEY', 'ASSISTED_VERIFICATION_STAFF_DAILY_MAX',
  'ASSISTED_VERIFICATION_FACILITY_DAILY_MAX']) delete process.env[key];
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
const { PlatformAuthController } = load('auth/platform-auth.controller.ts');
const { GoogleAuthenticationService } = load('auth/google-authentication.service.ts');
const { AuthSessionAuditService } = load('auth/auth-session-audit.service.ts');
const { AuditService } = load('audit/audit.service.ts');
const { AuditInterceptor } = load('audit/audit.interceptor.ts');
const { SecurityGuard } = load('auth/security.guard.ts');
const { WorkloadAuthService } = load('auth/workload-auth.service.ts');
const { TurnstileService } = load('auth/turnstile.service.ts');
const { NotificationOtpClient } = load('auth/notification-otp.client.ts');
const { MfaService, MFA_TOTP_CLOCK } = load('auth/mfa/mfa.service.ts');
const { MfaSecretProtector } = load('auth/mfa/mfa-secret-protector.ts');
const totp = load('auth/mfa/totp.ts');
const { AdminController } = load('admin/admin.controller.ts');
const { AdminService } = load('admin/admin.service.ts');
const { AdminOperationsService } = load('admin/admin-operations.service.ts');
const { PricingService } = load('admin/pricing.service.ts');
const { PlatformSecurityController } = load('admin/platform-security.controller.ts');
const { PlatformSecurityService } = load('admin/platform-security.service.ts');
const { IntegrationRuntimeService } = load('integrations/integration-runtime.service.ts');
const { PatientEnrollmentController } = load('identity/patient-enrollment.controller.ts');
const { PatientEnrollmentService } = load('identity/patient-enrollment.service.ts');
const { AssistedVerificationController } = load('identity/assisted-verification.controller.ts');
const { AssistedVerificationService } = load('identity/assisted-verification.service.ts');
const { PUBLIC_PATIENT_IDENTITY_PROVIDER, QoreIdPublicPatientIdentityProvider } =
  load('identity/patient-enrollment.provider.ts');
const { NinIdentifierProtector } = load('identity/nin-identifier-protector.ts');
const { HidCodeGenerator } = load('identity/hid-code-generator.service.ts');
const { QoreIdVerificationAdapter, QOREID_ADAPTER_CONFIGURATION, QOREID_FETCH } =
  load('identity/qoreid-verification.adapter.ts');
const { DomainProblem, ProblemDetailsFilter } = load('common/problem.ts');
const { preventResponseCaching } = load('common/response-security.middleware.ts');
const { getEnvironment, resetEnvironmentForTests } = load('config/environment.ts');

// Cloudflare Siteverify stub: a token is `ok|<action>|<hostname>|<n>` and
// verifies once. Any other outbound request fails the verifier.
const siteverifyUrl = getEnvironment().TURNSTILE_SITEVERIFY_URL;
const verifiedTokens = new Map();
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  assert.equal(url, siteverifyUrl, `Unexpected outbound request to ${url}`);
  const body = JSON.parse(String(init?.body));
  assert.equal(body.secret, 'example-turnstile-secret');
  const earlier = verifiedTokens.get(body.response);
  if (earlier) return Response.json(earlier.key === body.idempotency_key ? earlier.answer
    : { success: false, 'error-codes': ['timeout-or-duplicate'] });
  const [kind, action, hostname] = String(body.response).split('|');
  const answer = kind === 'ok' ? { success: true, action, hostname } : { success: false, 'error-codes': ['timeout-or-duplicate'] };
  verifiedTokens.set(body.response, { key: body.idempotency_key, answer });
  return Response.json(answer);
};
let issuedTokens = 0;
const turnstile = (action) => `ok|${action}|${siteHost}|${++issuedTokens}`;

// QoreID stub behind the real adapter. FACILITY_ONLY has no phone on its
// record (the person the facility route is for); RACING has one; SPARSE has
// only the name.
const FACILITY_ONLY = '90000000101';
const RACING = '90000000102';
const SPARSE = '90000000103';
const people = new Map([
  [FACILITY_ONLY, { firstname: 'Adaeze', lastname: 'Synthetic-Okafor', birthdate: '01-02-1990', gender: 'F', phone: null }],
  [RACING, { firstname: 'Bolaji', lastname: 'Synthetic', birthdate: '03-04-1985', gender: 'M', phone: '08031110102' }],
  [SPARSE, { firstname: 'Chiamaka', lastname: 'Synthetic' }],
]);
const ninLookups = [];
const qoreidFetch = async (url, init) => {
  const path = new URL(String(url)).pathname;
  if (path === '/token') {
    return new Response(JSON.stringify({ accessToken: 'synthetic-qoreid-token', expiresIn: 7200, tokenType: 'Bearer' }),
      { status: 200 });
  }
  const match = /^\/v1\/ng\/identities\/nin\/(\d{11})$/.exec(path);
  assert(match, `Unexpected QoreID request to ${path}`);
  assert.equal(init.headers.authorization, 'Bearer synthetic-qoreid-token');
  const person = people.get(match[1]);
  assert(person, `QoreID stub has no record for ${match[1]}`);
  ninLookups.push(match[1]);
  return new Response(JSON.stringify({ id: 800000 + ninLookups.length, summary: { nin_check: 'verified' },
    status: { state: 'complete', status: 'verified' }, nin: { nin: match[1], ...person } }), { status: 200 });
};

// Notification stub: staff enrolment codes go to the staff outbox; every
// other code is captured exactly as notification-api would receive it.
const deliveries = [];
const staffEnrollmentCodes = enrollmentCodeOutbox(async (input) => {
  deliveries.push({ purpose: input.purpose, channel: input.channel, recipient: input.recipient,
    challengeId: input.challengeId, code: input.code });
  return { outcome: 'accepted', provider: input.channel === 'sms' ? 'termii' : 'ses' };
});
const lastCode = (purpose, recipient) => {
  const delivery = deliveries.filter(item => item.purpose === purpose && item.recipient === recipient).at(-1);
  assert(delivery, `No ${purpose} code was delivered to the synthetic recipient`);
  return delivery;
};

const maintenance = new Pool({ host: socket, user: process.env.PGUSER, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
// Fixture and assertion connection (database owner), never used by the API.
const owner = new Pool({ host: socket, user: process.env.PGUSER, database: isolated, max: 2 });
owner.on('error', (error) => { if (error.code !== '57P01') throw error; });
let app;
try {
  const clock = createTotpClock();
  const module = await Test.createTestingModule({
    controllers: [AuthController, PlatformAuthController, AdminController, PlatformSecurityController,
      PatientEnrollmentController, AssistedVerificationController],
    providers: [DatabaseService, TokenService, LocalAuthProvider, CurrentStaffContextService,
      CurrentPatientContextService, AuthService, AuthSessionAuditService, AuditService, WorkloadAuthService,
      TurnstileService, IntegrationRuntimeService, AdminService, AdminOperationsService, PricingService,
      PlatformSecurityService, MfaService, MfaSecretProtector, { provide: MFA_TOTP_CLOCK, useValue: clock.now },
      PatientEnrollmentService, AssistedVerificationService, NinIdentifierProtector, HidCodeGenerator,
      GoogleAuthenticationService, QoreIdVerificationAdapter, QoreIdPublicPatientIdentityProvider,
      { provide: PUBLIC_PATIENT_IDENTITY_PROVIDER, useExisting: QoreIdPublicPatientIdentityProvider },
      { provide: QOREID_ADAPTER_CONFIGURATION, useValue: { baseUrl: 'https://api.qoreid.com',
        clientId: 'example-qoreid-client', clientSecret: 'example-qoreid-secret', timeoutMs: 2000,
        ninOnlyEnrollmentEnabled: true } },
      { provide: QOREID_FETCH, useValue: qoreidFetch },
      { provide: NotificationOtpClient, useValue: staffEnrollmentCodes.client }] }).compile();
  const runtimeRole = (await module.get(DatabaseService).query('select current_user as role')).rows[0].role;
  assert.equal(runtimeRole, 'hid_identity_api_runtime');
  app = module.createNestApplication({ logger: false });
  app.getHttpAdapter().getInstance().set('trust proxy', getEnvironment().TRUST_PROXY_CIDRS.split(',').map(cidr => cidr.trim()));
  app.use(preventResponseCaching);
  app.use(require('cookie-parser')());
  app.use((req, _res, next) => { req.correlationId = randomUUID(); next(); });
  app.setGlobalPrefix('api/v1');
  // The same request validation, problem filter, global guard and audit interceptor as AppModule and main.ts.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
    exceptionFactory: errors => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
      errors.map(error => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalGuards(new SecurityGuard(module.get(Reflector), module.get(TokenService),
    module.get(AuditService), module.get(DatabaseService)));
  app.useGlobalInterceptors(new AuditInterceptor(module.get(Reflector), module.get(AuditService)));
  await app.init();
  const http = request(app.getHttpServer());
  const checks = [];
  const check = name => checks.push(name);
  const expectProblem = (response, status, code) => {
    assert.equal(response.status, status, `${code ?? status}: ${response.status} ${JSON.stringify(response.body)}`);
    if (code) assert.equal(response.body.code, code, JSON.stringify(response.body));
  };
  const count = async (sql, values = []) => Number((await owner.query(sql, values)).rows[0].count);
  const setEnvironment = (values) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    resetEnvironmentForTests();
  };

  // Fixtures, as the owner: one organization, clinic A (designated below) and
  // clinic B (never designated), a platform Super Admin, and staff. A
  // clinical role is attested (0087) unless `attested` is false, as a legacy
  // promotion leaves it.
  const argon2 = require('argon2');
  const password = 'Synthetic-Assisted-Password-2026';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const organization = randomUUID();
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  await owner.query("insert into identity.organizations (id, name, slug) values ($1, 'Assisted Runtime Organization', $2)",
    [organization, `assisted-runtime-${organization.slice(0, 8)}`]);
  await owner.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
    values ($1, $3, 'Assisted Runtime Clinic A', $4, 'Africa/Lagos', true, 'verified'),
           ($2, $3, 'Assisted Runtime Clinic B', $5, 'Africa/Lagos', true, 'verified')`,
  [clinicA, clinicB, organization, `ASSIST-A-${clinicA.slice(0, 6)}`, `ASSIST-B-${clinicB.slice(0, 6)}`]);
  const superAdmin = { id: randomUUID(), email: `assisted-super-${randomUUID().slice(0, 8)}@example.invalid` };
  await owner.query(`insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm)
    values ($1, $2, $3, 'Assisted Runtime Super Admin', 'active', $4, 'argon2id')`,
  [superAdmin.id, `synthetic:assisted:super:${superAdmin.id}`, superAdmin.email, passwordHash]);
  await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
    values ($1, $2, 'platform_super_admin', 'platform', 'Synthetic assisted registration verifier')`, [randomUUID(), superAdmin.id]);
  async function staffAccount(label, role, facility, { attested = true } = {}) {
    const account = randomUUID(), staffId = randomUUID(), membership = randomUUID(), assignment = randomUUID();
    const email = `assisted-${label}-${account.slice(0, 8)}@example.invalid`;
    await owner.query(`insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm)
      values ($1, $2, $3, $4, 'active', $5, 'argon2id')`, [account, `synthetic:assisted:${label}:${account}`, email,
      `Assisted Runtime ${label}`, passwordHash]);
    await owner.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
      values ($1, $2, $3, $4, 'verified', $5)`, [staffId, account, `Assisted Runtime ${label}`, email, role]);
    await owner.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, $6, $6, true, true)`,
    [membership, staffId, account, organization, facility, role]);
    await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id,
      grant_reason) values ($1, $2, $3, 'facility', $4, $5, 'Synthetic assisted registration verifier')`,
    [assignment, account, role, membership, facility]);
    if (attested) {
      const attestation = randomUUID();
      await owner.query(`insert into identity.staff_credential_attestations (id, staff_id, account_id, attested_roles,
        credential_reference, issuing_authority, verification_method, evidence_reference, valid_until, reviewer_account_id,
        reason, correlation_id) values ($1, $2, $3, $4, $5, 'Synthetic Council', 'manual_review', 'Synthetic evidence file',
        clock_timestamp() + interval '1 year', $6, 'Synthetic attestation for the verifier', 'assisted-runtime-attest')`,
      [attestation, staffId, account, [role], `LIC-${label}`, superAdmin.id]);
      await owner.query(`insert into identity.workforce_role_grants (account_role_id, attestation_id, account_id,
        membership_id, facility_id, role_code, granted_by, correlation_id)
        values ($1, $2, $3, $4, $5, $6, $7, 'assisted-runtime-grant')`,
      [assignment, attestation, account, membership, facility, role, superAdmin.id]);
    }
    return { account, membership, facility, email };
  }
  const nurse = await staffAccount('nurse', 'nurse', clinicA);
  const legacyNurse = await staffAccount('legacy-nurse', 'nurse', clinicA, { attested: false });
  const receptionist = await staffAccount('receptionist', 'receptionist', clinicA, { attested: false });
  const nurseB = await staffAccount('nurse-b', 'nurse', clinicB);
  // Fixture: a platform administrator has enabled QoreID (an admin action outside this verifier).
  await owner.query("update platform.integration_providers set enabled=true, row_version=row_version+1 where provider='qoreid'");

  // Patient helpers.
  const post = (path, body, { network = '198.51.100.120', cookie, key } = {}) => {
    let call = http.post(`/api/v1${path}`).set('X-Forwarded-For', network).set('Origin', origin);
    if (cookie) call = call.set('Cookie', cookie);
    if (key) call = call.set('Idempotency-Key', key);
    return call.send(body);
  };
  const startEnrollment = async (nin, network = '198.51.100.120') => {
    const started = await post('/identity/patient-enrollments', { nin, turnstileAction: 'patient-enrollment',
      turnstileToken: turnstile('patient-enrollment') }, { key: randomUUID(), network });
    expectProblem(started, 200);
    const value = (started.headers['set-cookie'] ?? []).find(item => item.startsWith('hid_enrollment='));
    assert(value, 'enrollment start must set the hid_enrollment cookie');
    return { body: started.body, cookie: value.split(';')[0] };
  };
  const current = (cookie) => http.get('/api/v1/identity/patient-enrollments/current').set('Cookie', cookie);
  const enrollmentRow = async (cookie) => (await owner.query(`select id::text, state, holder_method,
    holder_verification_id::text, desk_code_hmac from identity.public_patient_enrollments where id = $1`,
  [cookie.split('=')[1].split('.')[0]])).rows[0];

  // Staff helpers: sign-in with an authenticator (MFA-1), then the check.
  const staff = staffClient({ send: supertestTransport(http), origin, password, outbox: staffEnrollmentCodes,
    now: clock.next, turnstileToken: (action) => turnstile(action) });
  async function signIn(who) {
    const signedIn = await staff.signIn(who.email);
    assert.equal(signedIn.accountId, who.account);
    return { ...who, cookie: signedIn.cookie, csrf: signedIn.csrf };
  }
  const attestations = { patientPresent: true, originalDocumentSeen: true, photoMatchesPerson: true,
    codeShownOnPatientsOwnDevice: true, patientConsents: true };
  const checkBody = (deskCode, document, documentType = 'national_id_card') => ({ deskCode,
    method: 'government_photo_id_in_person', documentType, document, attestations });
  const verifyAtDesk = (who, body, { key = `assisted-${randomUUID()}`, facility = who.facility, csrf = true } = {}) => {
    let call = http.post('/api/v1/identity/assisted-verifications').set('Cookie', who.cookie).set('Origin', origin)
      .set('X-Facility-ID', facility);
    if (csrf) call = call.set('x-csrf-token', who.csrf);
    if (key) call = call.set('Idempotency-Key', key);
    return call.send(body);
  };
  const checkRows = (account) => count(`select count(*) from identity.assisted_registration_verifications
    where staff_account_id = $1`, [account]);

  // 1. The facility route is closed until a facility is designated: the flag
  // alone opens nothing, the list is empty and a start is refused before QoreID.
  const availability = () => http.get('/api/v1/identity/patient-enrollments/availability')
    .set('X-Forwarded-For', '198.51.100.121');
  expectProblem(await availability(), 200);
  assert.deepEqual((await availability()).body, { open: false, online: false, facility: false });
  const emptyList = await http.get('/api/v1/identity/patient-enrollments/participating-facilities');
  expectProblem(emptyList, 200);
  assert.deepEqual(emptyList.body.facilities, []);
  assert.equal(emptyList.body.whatToBring.length, 3);
  expectProblem(await post('/identity/patient-enrollments', { nin: FACILITY_ONLY, turnstileAction: 'patient-enrollment',
    turnstileToken: turnstile('patient-enrollment') }, { key: randomUUID() }), 503, 'PATIENT_REGISTRATION_NOT_OPEN');
  assert.equal(ninLookups.length, 0);
  check('with ASSISTED_REGISTRATION_ENABLED and no designated facility the route is closed: availability { open: false, online: false, facility: false }, an empty facility list with what to bring, and start answers 503 PATIENT_REGISTRATION_NOT_OPEN before QoreID');

  // 2. A platform Super Admin designates clinic A over HTTP: an MFA-verified
  // platform session, a fresh step-up, a reason, If-Match 0 for a first
  // designation and an idempotency key.
  const platform = platformClient({ http, origin, totp, clock, password, turnstileToken: () => turnstile('admin-login') });
  const admin = await platform.enroll(superAdmin.email);
  const designationPath = `/admin/facilities/${clinicA}/assisted-registration`;
  const unread = await platform.get(admin, designationPath);
  expectProblem(unread, 200);
  assert.deepEqual([unread.body.designated, unread.body.version], [false, 0]);
  const designation = { status: 'active', addressLine: '1 Synthetic Clinic Road', town: 'Ikeja', lga: 'Ikeja',
    state: 'Lagos', hours: 'Mon-Fri 08:00-16:00', reason: 'Synthetic designation of clinic A for the verifier' };
  const designationKey = `assisted-designation-${randomUUID()}`;
  expectProblem(await platform.command(admin, designationPath, designation,
    { 'if-match': '0', 'idempotency-key': designationKey }), 403, 'STEP_UP_REQUIRED');
  await platform.stepUp(admin);
  expectProblem(await platform.command(admin, designationPath, designation, { 'idempotency-key': designationKey }),
    428, 'IF_MATCH_REQUIRED');
  const designated = await platform.command(admin, designationPath, designation,
    { 'if-match': '0', 'idempotency-key': designationKey });
  expectProblem(designated, 201);
  assert.deepEqual(designated.body, { facilityId: clinicA, status: 'active', version: 1, replayed: false });
  const replayedDesignation = await platform.command(admin, designationPath, designation,
    { 'if-match': '0', 'idempotency-key': designationKey });
  expectProblem(replayedDesignation, 201);
  assert.equal(replayedDesignation.body.replayed, true);
  expectProblem(await platform.command(admin, designationPath, { ...designation, hours: 'Daily 08:00-20:00' },
    { 'if-match': '0', 'idempotency-key': `assisted-designation-${randomUUID()}` }), 409, 'VERSION_CONFLICT');
  assert.equal(await count(`select count(*) from identity.facility_assisted_registration_events where facility_id = $1`,
    [clinicA]), 1);
  assert.equal(await count(`select count(*) from audit.events where action = 'admin.facility.assisted-registration.active'
    and resource_id = $1 and access_scope = 'platform'`, [clinicA]), 1);
  check('a platform Super Admin designates a facility over HTTP: 403 STEP_UP_REQUIRED without a fresh step-up, 428 without If-Match, If-Match 0 creates version 1, the same key replays, a stale version is 409 VERSION_CONFLICT; one designation event and one platform audit row');

  // 3. Now open: availability, the list (name and location, no ids, cacheable
  // for five minutes) and a start of a person with no registry phone.
  assert.deepEqual((await availability()).body, { open: true, online: false, facility: true });
  const list = await http.get('/api/v1/identity/patient-enrollments/participating-facilities');
  expectProblem(list, 200);
  assert.deepEqual(list.body, { facilities: [{ name: 'Assisted Runtime Clinic A', addressLine: '1 Synthetic Clinic Road',
    town: 'Ikeja', lga: 'Ikeja', state: 'Lagos', hours: 'Mon-Fri 08:00-16:00' }],
  whatToBring: ['Your own phone with this registration open',
    'One original photo ID: national ID card, international passport, driver\'s licence or voter\'s card',
    'A phone number or email that can receive codes now'] });
  assert.equal(list.headers['cache-control'], 'public, max-age=300');
  assert.doesNotMatch(JSON.stringify(list.body), /[0-9a-f]{8}-[0-9a-f]{4}-/, 'the facility list carries no id');
  assert.equal(await count(`select count(*) from audit.events where details->>'route' like '%participating-facilities%'`), 0);
  const patient = await startEnrollment(FACILITY_ONLY);
  assert.deepEqual({ ...patient.body, expiresAt: undefined }, { stage: 'verify_holder', expiresAt: undefined,
    googleOnboardingRequired: false, online: { available: false }, facility: { available: true } });
  check('designated, the route opens: availability { open: true, online: false, facility: true }, the facility list by name and location with what to bring, no ids, Cache-Control public, max-age=300 and no audit row; a NIN record without a phone starts at verify_holder with only the facility route');

  // 4. The desk code: on the patient's own device, shown again to the cookie
  // holder, replaced by a new one.
  const firstCode = await post('/identity/patient-enrollments/facility-code', {}, { cookie: patient.cookie });
  expectProblem(firstCode, 200);
  assert.match(firstCode.body.facility.deskCode, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
  assert.equal(firstCode.body.facility.deskCodeExpiresAt, firstCode.body.expiresAt);
  const shown = await current(patient.cookie);
  expectProblem(shown, 200);
  assert.equal(shown.body.facility.deskCode, firstCode.body.facility.deskCode);
  assert.equal(await count(`select count(*) from identity.public_patient_enrollments
    where desk_code_hmac is not null and position($1 in desk_code_hmac) = 0`, [firstCode.body.facility.deskCode]), 1);
  const secondCode = await post('/identity/patient-enrollments/facility-code', {}, { cookie: patient.cookie });
  expectProblem(secondCode, 200);
  assert.notEqual(secondCode.body.facility.deskCode, firstCode.body.facility.deskCode);
  expectProblem(await http.post('/api/v1/identity/patient-enrollments/facility-code').set('Cookie', patient.cookie)
    .set('Origin', 'https://attacker.example').send({}), 403, 'ORIGIN_DENIED');
  check('POST facility-code issues a 10-character Crockford desk code that GET current shows again to the cookie holder, stored only as its keyed digest; a new code replaces the old one; a foreign Origin is refused');

  // 5. Staff sign in with an authenticator. Who may check, and the order:
  // guard, the route switch, then the body.
  const nurseSession = await signIn(nurse);
  const legacySession = await signIn(legacyNurse);
  const receptionistSession = await signIn(receptionist);
  const nurseBSession = await signIn(nurseB);
  const document = { firstName: 'Adaeze', lastName: 'Synthetic-Okafor', dateOfBirth: '1990-02-01' };
  const deskCode = secondCode.body.facility.deskCode;
  expectProblem(await verifyAtDesk(receptionistSession, checkBody(deskCode, document)), 403, 'PERMISSION_DENIED');
  expectProblem(await verifyAtDesk(legacySession, checkBody(deskCode, document)), 403, 'ASSISTED_REGISTRATION_NOT_AUTHORIZED');
  expectProblem(await verifyAtDesk(nurseBSession, checkBody(deskCode, document)), 403, 'ASSISTED_REGISTRATION_NOT_AUTHORIZED');
  expectProblem(await verifyAtDesk(nurseSession, checkBody(deskCode, document), { facility: clinicB }), 403,
    'FACILITY_ACCESS_DENIED');
  expectProblem(await verifyAtDesk(nurseSession, checkBody(deskCode, document), { csrf: false }), 403);
  // NIN-only enrollment needs a holder route, so it is switched off with the facility route.
  setEnvironment({ ASSISTED_REGISTRATION_ENABLED: 'false', QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'false' });
  const disabled = await verifyAtDesk(nurseSession, { deskCode, method: 'nin_slip' });
  expectProblem(disabled, 503, 'ASSISTED_REGISTRATION_DISABLED');
  assert.equal(disabled.body.detail, 'Registration at a facility is not available.');
  setEnvironment({ ASSISTED_REGISTRATION_ENABLED: 'true', QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'true' });
  expectProblem(await verifyAtDesk(nurseSession, { ...checkBody(deskCode, document), documentType: 'nin_slip' }), 400,
    'VALIDATION_FAILED');
  expectProblem(await verifyAtDesk(nurseSession, { ...checkBody(deskCode, document),
    attestations: { ...attestations, codeShownOnPatientsOwnDevice: false } }), 400, 'VALIDATION_FAILED');
  expectProblem(await verifyAtDesk(nurseSession, checkBody(deskCode, document), { key: null }), 400,
    'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(await count('select count(*) from identity.assisted_registration_verifications'), 0,
    'a refused check recorded something');
  check('staff signed in with an authenticator: a receptionist is 403 PERMISSION_DENIED (guard), a legacy-promoted nurse without an attested grant and an attested nurse of an undesignated facility are 403 ASSISTED_REGISTRATION_NOT_AUTHORIZED (SQL), another facility is 403 FACILITY_ACCESS_DENIED, a missing CSRF token is 403, the route switched off is 503 ASSISTED_REGISTRATION_DISABLED before the body is read, a NIN slip, an attestation not given and a missing key are 400; none records a check');

  // 6. The check: an unknown code, the earlier code, a mismatch (with its
  // replay), then the match (with its replay).
  const unknownCode = await verifyAtDesk(nurseSession, checkBody('0000000000', document));
  expectProblem(unknownCode, 404, 'DESK_CODE_NOT_FOUND');
  expectProblem(await verifyAtDesk(nurseSession, checkBody(firstCode.body.facility.deskCode, document)), 404,
    'DESK_CODE_NOT_FOUND');
  const mismatchKey = `assisted-${randomUUID()}`;
  const mismatch = await verifyAtDesk(nurseSession, checkBody(deskCode.toLowerCase().replace(/(.{5})/, '$1-'),
    { ...document, lastName: 'Okafor' }), { key: mismatchKey });
  expectProblem(mismatch, 422, 'ASSISTED_VERIFICATION_NOT_MATCHED');
  assert.deepEqual(mismatch.body.fields, { firstName: 'match', lastName: 'no_match', dateOfBirth: 'match' });
  for (const value of ['Synthetic-Okafor', '1990-02-01', FACILITY_ONLY, 'Adaeze']) {
    assert(!JSON.stringify(mismatch.body).includes(value), 'a mismatch must show no registry value');
  }
  const mismatchReplay = await verifyAtDesk(nurseSession, checkBody(deskCode.toLowerCase().replace(/(.{5})/, '$1-'),
    { ...document, lastName: 'Okafor' }), { key: mismatchKey });
  expectProblem(mismatchReplay, 422, 'ASSISTED_VERIFICATION_NOT_MATCHED');
  expectProblem(await verifyAtDesk(nurseSession, checkBody(deskCode, document), { key: mismatchKey }), 409,
    'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await checkRows(nurse.account), 3, 'two codes not found and one mismatch, the replay not counted');
  const matchKey = `assisted-${randomUUID()}`;
  const matched = await verifyAtDesk(nurseSession, checkBody(deskCode, { ...document, firstName: 'synthetic-okafor',
    lastName: 'ADAEZE' }), { key: matchKey });
  expectProblem(matched, 200);
  assert.deepEqual(matched.body, { outcome: 'verified' });
  const matchedReplay = await verifyAtDesk(nurseSession, checkBody(deskCode, { ...document, firstName: 'synthetic-okafor',
    lastName: 'ADAEZE' }), { key: matchKey });
  expectProblem(matchedReplay, 200);
  assert.deepEqual(matchedReplay.body, { outcome: 'verified' });
  assert.equal(await checkRows(nurse.account), 4);
  const proved = await enrollmentRow(patient.cookie);
  assert.deepEqual([proved.state, proved.holder_method, proved.desk_code_hmac], ['verify_contact', 'facility_in_person', null]);
  const outcomes = (await owner.query(`select outcome, proof_outcome, nin_digest is not null as has_digest
    from identity.assisted_registration_verifications where staff_account_id = $1 order by verified_at`,
  [nurse.account])).rows;
  assert.deepEqual(outcomes.map(row => `${row.outcome}:${row.proof_outcome}:${row.has_digest}`), ['code_not_found:null:false',
    'code_not_found:null:false', 'not_matched:null:true', 'matched:verified:true']);
  const staffAudit = (await owner.query(`select details from audit.events where action = 'identity.assisted-verification.record'
    and actor_account_id = $1 and facility_id = $2 and actor_membership_id = $3`,
  [nurse.account, clinicA, nurse.membership])).rows;
  assert.equal(staffAudit.length, 4);
  for (const { details } of staffAudit) {
    assert.deepEqual(Object.keys(details).sort(), ['documentType', 'method', 'ninDigest', 'outcome']);
  }
  assert.equal(await count(`select count(*) from audit.events where action like 'identity.assisted-verification.%'
    and details::text ~* '(adaeze|okafor|1990|${FACILITY_ONLY})'`), 0, 'a staff audit row carries a name, date or NIN');
  check('the check: an unknown and an earlier desk code are 404 DESK_CODE_NOT_FOUND; a different last name is 422 ASSISTED_VERIFICATION_NOT_MATCHED with fields { firstName: match, lastName: no_match, dateOfBirth: match } and no registry value, replayed under its key and 409 IDEMPOTENCY_KEY_REUSED for another request under it; the names in either order, any case and the code typed with a hyphen match: 200 { outcome: verified }, replayed under its key; the enrollment moves to verify_contact proved facility_in_person with its desk code cleared; every outcome is one row and one staff audit row of method, document type, outcome and NIN digest only');

  // 7. The patient finishes on their own device: contact, password, sign-in.
  const finished = await current(patient.cookie);
  expectProblem(finished, 200);
  assert.deepEqual([finished.body.stage, finished.body.requiredProfileFields], ['verify_contact', []]);
  expectProblem(await post('/identity/patient-enrollments/facility-code', {}, { cookie: patient.cookie }), 409,
    'ENROLLMENT_STAGE_INVALID');
  const email = `assisted-patient-${randomUUID().slice(0, 8)}@example.invalid`;
  const contact = await post('/identity/patient-enrollments/contact', { channel: 'email', contact: email },
    { cookie: patient.cookie });
  expectProblem(contact, 200);
  const contactCode = lastCode('SIGNUP_VERIFY', email);
  expectProblem(await post('/identity/patient-enrollments/contact/verify', { challengeId: contact.body.challengeId,
    code: contactCode.code }, { cookie: patient.cookie }), 200);
  const patientPassword = 'Synthetic-Assisted-Patient-01';
  const activated = await post('/identity/patient-enrollments/activate', { password: patientPassword },
    { cookie: patient.cookie });
  expectProblem(activated, 200);
  assert.match(activated.body.hidCode, /^HID-/);
  const assurance = (await owner.query(`select assurance.nin_verified_at = verification.verified_at as at_check,
      enrollment.holder_method
    from identity.patients patient
    join identity.patient_assurance_states assurance on assurance.patient_id = patient.id
    join identity.public_patient_enrollments enrollment on enrollment.patient_id = patient.id
    join identity.assisted_registration_verifications verification on verification.id = enrollment.holder_verification_id
    where patient.hid_code = $1`, [activated.body.hidCode])).rows;
  assert.deepEqual(assurance, [{ at_check: true, holder_method: 'facility_in_person' }]);
  assert.equal(await count(`select count(*) from audit.events where action = 'identity.public-patient-enrollment.activated'
    and details->>'holderMethod' = 'facility_in_person'`), 1);
  const signedIn = await http.post('/api/v1/auth/patient/login').set('Origin', origin).set('X-Forwarded-For', '198.51.100.122')
    .send({ email, password: patientPassword, turnstileAction: 'patient-login', turnstileToken: turnstile('patient-login') });
  expectProblem(signedIn, 200);
  assert.equal(signedIn.body.actor.kind, 'patient');
  check('the patient finishes on their own device: verify_contact with no profile field, no new desk code, an email contact code, activation with a new HID whose assurance records the NIN as verified at the in-person check and whose audit names facility_in_person, then password sign-in');

  // 8. A NIN that already has a Health ID: answered to staff only after the
  // match, with a reference and nothing about the identity; the enrollment
  // and its cookie are gone.
  const again = await startEnrollment(FACILITY_ONLY, '198.51.100.123');
  const againCode = await post('/identity/patient-enrollments/facility-code', {}, { cookie: again.cookie,
    network: '198.51.100.123' });
  expectProblem(againCode, 200);
  const bound = await verifyAtDesk(nurseSession, checkBody(againCode.body.facility.deskCode, document));
  expectProblem(bound, 409, 'NIN_ALREADY_REGISTERED');
  const reference = (await owner.query(`select correlation_id from identity.assisted_registration_verifications
    where proof_outcome = 'existing_identity'`)).rows[0].correlation_id;
  assert.equal(bound.body.detail, 'This person already has a Health ID. Direct them to account recovery. If they say they '
    + `never registered, ask Health ID support to review, quoting reference ${reference}.`);
  for (const value of [activated.body.hidCode, email, FACILITY_ONLY, 'Adaeze']) {
    assert(!JSON.stringify(bound.body).includes(value), 'the existing-identity answer names no Health ID, contact or person');
  }
  expectProblem(await current(again.cookie), 404, 'ENROLLMENT_NOT_FOUND');
  assert.deepEqual((await owner.query(`select details->>'method' as method, details->>'existingBinding' as binding
    from audit.events where action = 'identity.public-patient-enrollment.existing-identity'`)).rows,
  [{ method: 'facility_in_person', binding: 'facility_in_person' }]);
  check('a NIN that already has a Health ID is answered to staff only after the match: 409 NIN_ALREADY_REGISTERED with the staff text and the check reference, no HID, contact or patient; the enrollment is deleted and audited existing-identity with the in-person method');

  // 9. A NIN record without a date of birth: the document date is not compared.
  const sparse = await startEnrollment(SPARSE, '198.51.100.124');
  const sparseCode = await post('/identity/patient-enrollments/facility-code', {}, { cookie: sparse.cookie,
    network: '198.51.100.124' });
  const sparseCheck = await verifyAtDesk(nurseSession, checkBody(sparseCode.body.facility.deskCode,
    { firstName: 'Chiamaka', lastName: 'Synthetic', dateOfBirth: '1999-09-09' }, 'voters_card'));
  expectProblem(sparseCheck, 200);
  const sparseProgress = await current(sparse.cookie);
  assert.deepEqual([sparseProgress.body.stage, sparseProgress.body.requiredProfileFields], ['verify_contact',
    ['dateOfBirth', 'gender']]);
  assert.equal((await owner.query(`select date_of_birth_result from identity.assisted_registration_verifications
    where document_type = 'voters_card'`)).rows[0].date_of_birth_result, 'not_in_record');
  check('a NIN record without a date of birth matches on the names alone (dateOfBirth not_in_record, the typed date never stored), and the patient still enters the missing fields at activation');

  // 10. An in-person check races a registry-phone proof of the same NIN.
  // Both take the NIN lock; whichever proof is recorded first removes the
  // other, still unproven, enrollment (ADR-062). One proven enrollment remains.
  setEnvironment({ NIN_HOLDER_SMS_ENABLED: 'true' });
  const byPhone = await startEnrollment(RACING, '198.51.100.125');
  const atDesk = await startEnrollment(RACING, '198.51.100.126');
  const [byPhoneId, atDeskId] = [(await enrollmentRow(byPhone.cookie)).id, (await enrollmentRow(atDesk.cookie)).id];
  const sentPhone = await post('/identity/patient-enrollments/holder', {}, { cookie: byPhone.cookie, network: '198.51.100.125' });
  expectProblem(sentPhone, 200);
  const phoneCode = lastCode('NIN_HOLDER_VERIFY', '+2348031110102');
  const raceCode = await post('/identity/patient-enrollments/facility-code', {}, { cookie: atDesk.cookie,
    network: '198.51.100.126' });
  const [phoneAnswer, deskAnswer] = await Promise.all([
    post('/identity/patient-enrollments/holder/verify', { challengeId: sentPhone.body.challengeId, code: phoneCode.code },
      { cookie: byPhone.cookie, network: '198.51.100.125' }),
    verifyAtDesk(nurseSession, checkBody(raceCode.body.facility.deskCode,
      { firstName: 'Bolaji', lastName: 'Synthetic', dateOfBirth: '1985-04-03' }, 'international_passport')),
  ]);
  const superseded = await count(`select count(*) from audit.events
    where action = 'identity.public-patient-enrollment.superseded' and details->>'ninDigest' is not null
      and resource_id = any($1::text[])`, [[byPhoneId, atDeskId]]);
  let raceWinner;
  if (deskAnswer.status === 200) {
    // The in-person proof came first: the phone enrollment is gone.
    expectProblem(phoneAnswer, 404, 'ENROLLMENT_NOT_FOUND');
    raceWinner = { id: atDeskId, holder_method: 'facility_in_person' };
  } else {
    // The phone proof came first: the desk code names no enrollment, or the
    // check found it just before it was removed and its proof is stale.
    expectProblem(phoneAnswer, 200);
    assert.equal(phoneAnswer.body.stage, 'verify_contact');
    assert(['404:DESK_CODE_NOT_FOUND', '409:ASSISTED_VERIFICATION_STALE'].includes(
      `${deskAnswer.status}:${deskAnswer.body.code}`), `desk answer ${deskAnswer.status} ${deskAnswer.body.code}`);
    raceWinner = { id: byPhoneId, holder_method: 'registry_phone_otp' };
  }
  assert.equal(superseded, 1, 'the losing enrollment was not removed and audited superseded once');
  assert.deepEqual((await owner.query(`select id::text, holder_method from identity.public_patient_enrollments
    where nin_last4 = '0102' and state <> 'active'`)).rows, [raceWinner]);
  setEnvironment({ NIN_HOLDER_SMS_ENABLED: 'false' });
  check(`an in-person check racing a registry-phone proof of the same NIN serializes on the NIN lock: the first proof recorded (here ${raceWinner.holder_method}) removes the other enrollment, audited superseded, and one proven enrollment remains`);

  // 11. Budgets over 24 hours, per staff member and per facility; every
  // outcome counts. A second nurse at clinic A has made no check.
  const made = await checkRows(nurse.account);
  setEnvironment({ ASSISTED_VERIFICATION_STAFF_DAILY_MAX: String(made), ASSISTED_VERIFICATION_FACILITY_DAILY_MAX: '100' });
  expectProblem(await verifyAtDesk(nurseSession, checkBody('0000000001', document)), 429, 'ASSISTED_VERIFICATION_LIMITED');
  assert.equal(await checkRows(nurse.account), made);
  const secondNurse = await signIn(await staffAccount('second-nurse', 'nurse', clinicA));
  const atClinicA = await count(`select count(*) from identity.assisted_registration_verifications where facility_id = $1`,
    [clinicA]);
  setEnvironment({ ASSISTED_VERIFICATION_STAFF_DAILY_MAX: '1', ASSISTED_VERIFICATION_FACILITY_DAILY_MAX: String(atClinicA) });
  expectProblem(await verifyAtDesk(secondNurse, checkBody('0000000001', document)), 429, 'ASSISTED_VERIFICATION_LIMITED');
  assert.equal(await checkRows(secondNurse.account), 0);
  setEnvironment({ ASSISTED_VERIFICATION_STAFF_DAILY_MAX: undefined, ASSISTED_VERIFICATION_FACILITY_DAILY_MAX: undefined });
  check(`the per-staff budget (set to the ${made} checks made) and the per-facility budget (set to the ${atClinicA} checks at the clinic, for a nurse who made none) are 429 ASSISTED_VERIFICATION_LIMITED, recording nothing`);

  // 12. A suspended designation closes the route at once.
  const suspendKey = `assisted-designation-${randomUUID()}`;
  await platform.stepUp(admin);
  const suspended = await platform.command(admin, designationPath, { ...designation, status: 'suspended',
    reason: 'Synthetic suspension of clinic A' }, { 'if-match': '1', 'idempotency-key': suspendKey });
  expectProblem(suspended, 201);
  assert.deepEqual([suspended.body.status, suspended.body.version], ['suspended', 2]);
  assert.deepEqual((await availability()).body, { open: false, online: false, facility: false });
  expectProblem(await post('/identity/patient-enrollments', { nin: SPARSE, turnstileAction: 'patient-enrollment',
    turnstileToken: turnstile('patient-enrollment') }, { key: randomUUID(), network: '198.51.100.127' }), 503,
  'PATIENT_REGISTRATION_NOT_OPEN');
  expectProblem(await verifyAtDesk(nurseSession, checkBody('0000000002', document)), 403,
    'ASSISTED_REGISTRATION_NOT_AUTHORIZED');
  check('a suspended designation (If-Match 1, version 2) closes the route at once: availability closed, start refused, and the staff check 403 ASSISTED_REGISTRATION_NOT_AUTHORIZED');

  process.stdout.write(JSON.stringify({ status: 'passed', scope: 'local-synthetic-only', role: runtimeRole,
    qoreid: 'local stub behind the real adapter; no QoreID call', turnstile: 'local Siteverify stub',
    notification: 'local stub; no delivery', nin_lookups: ninLookups.length, deliveries: deliveries.length,
    checks }) + '\n');
} finally {
  await app?.close();
  await owner.end();
  await maintenance.query(`drop database if exists ${isolated} with (force)`);
  await maintenance.end();
}
