#!/usr/bin/env node
// Clinician self sign-up with two-admin approval (ADR-064, migration 0096)
// over HTTP, executed as the exact Identity API runtime role against a
// disposable copy of the owned synthetic rehearsal. The real DatabaseService,
// SecurityGuard, AuditInterceptor, controllers, Turnstile verifier, MFA,
// token, clinician application and workforce services and database commands
// run. Only the outbound boundaries are local stand-ins (Cloudflare
// Siteverify, notification delivery) and TOTP time steps come from a virtual
// clock shared with the server. No network call is made. All values are
// synthetic.
//
//  1. Closed by default: availability is false, the sign-up start is 503
//     CLINICIAN_SIGNUP_CLOSED with its fixed sentence; the status start is not
//     gated; the provider portal off or maintenance on closes intake again.
//  2. A Super Admin opens it through POST /admin/controls.
//  3. Turnstile and the signed-out rule stop a request before the service.
//  4. The starts answer every address alike; a code for an address in use
//     proves nothing until it is correct, and then says so (409); a code is
//     spent after five wrong tries.
//  5. The draft capability cookie; the facility search and its budget.
//  6. Submit: an account, a pending staff record and an application awaiting
//     the authenticator; the capability rotates; no session cookie; replay.
//  7. The applicant cannot sign in (403 NO_ACTIVE_FACILITY_MEMBERSHIP).
//  8. The authenticator before review, with no session; nothing the browser
//     holds works at /auth/mfa/*.
//  9. The status page: only an applicant gets a code; the authenticator
//     gates the list; withdraw and apply again.
// 10. The queue: permission, step-up, the applicant's live code, two
//     different Super Admins, an insider refused; the audit trail.
// 11. The first staff sign-in after approval.
// 12. The grant rests on its own application's step-1 attestation; a
//     rejection revokes nothing; identity_not_confirmed blocks applying again.
// 13. A reserved attestation supports no other grant until approval, even
//     overdue and unswept.
// 14. Expiry before and after the sweep.
// 15. Races: a double-clicked submit, concurrent starts, concurrent
//     approvals, a double-submitted step 1, the platform's last daily slot
//     and a facility's last open slot taken twice at once, withdraw against
//     approve, approve against sign-in, the sweeper against a locked row.
// 16. Faults are never a 401: a missing grant and a missing function are 503.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { cookieHeader, createTotpClock, expectStatus, platformClient } from './platform-session-client.mjs';
import { enrollmentCodeOutbox, staffClient, supertestTransport, SYNTHETIC_STAFF_MFA_KEY_B64,
  totpAt } from './staff-session-client.mjs';

const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
assert(process.env.OTP_HMAC_KEY_B64, 'The rehearsal OTP HMAC key is required');
const isolated = `hid_rehearsal_clinician_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
// The main site serves the sign-up; the admin host never presents its actions.
const siteHost = 'staging.healthidentitydirectory.com';
const origin = `https://${siteHost}`;
const adminOrigin = 'https://admin.staging.healthidentitydirectory.com';
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'staging',
  NIN_PROVIDER_MODE: 'deferred', CORS_ORIGINS: `${origin},${adminOrigin}`, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'public-synthetic-ehr-workload-token',
  TURNSTILE_MODE: 'required', TURNSTILE_SECRET_KEY: 'example-turnstile-secret',
  MFA_SECRET_KEY_B64: SYNTHETIC_STAFF_MFA_KEY_B64, MFA_KEY_VERSION: 'clinician-runtime-v1',
  DATABASE_URL: `postgresql://${process.env.PGUSER ?? 'postgres'}@localhost/${isolated}?host=${encodeURIComponent(socket)}`
    + `&options=${encodeURIComponent('-c role=hid_identity_api_runtime')}`,
  // As in main.ts: only the loopback test client is a trusted reverse proxy, so
  // X-Forwarded-For carries the client address each limit is charged to.
  TRUST_PROXY_CIDRS: '127.0.0.1/32,::1/128' });
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
const { PlatformAuthController } = load('auth/platform-auth.controller.ts');
const { GoogleAuthenticationService } = load('auth/google-authentication.service.ts');
const { AuthSessionAuditService } = load('auth/auth-session-audit.service.ts');
const { MfaService, MFA_TOTP_CLOCK } = load('auth/mfa/mfa.service.ts');
const { MfaSecretProtector } = load('auth/mfa/mfa-secret-protector.ts');
const totp = load('auth/mfa/totp.ts');
const { AuditService } = load('audit/audit.service.ts');
const { AuditInterceptor } = load('audit/audit.interceptor.ts');
const { SecurityGuard } = load('auth/security.guard.ts');
const { WorkloadAuthService } = load('auth/workload-auth.service.ts');
const { TurnstileService } = load('auth/turnstile.service.ts');
const { NotificationOtpClient } = load('auth/notification-otp.client.ts');
const { PlatformSecurityController } = load('admin/platform-security.controller.ts');
const { PlatformSecurityService } = load('admin/platform-security.service.ts');
const { AdminController } = load('admin/admin.controller.ts');
const { AdminService } = load('admin/admin.service.ts');
const { AdminOperationsService } = load('admin/admin-operations.service.ts');
const { PricingService } = load('admin/pricing.service.ts');
const { WorkforceAdminController } = load('admin/workforce-admin.controller.ts');
const { WorkforceAdminService } = load('admin/workforce-admin.service.ts');
const { AdminClinicianApplicationsController } = load('admin/clinician-application-admin.controller.ts');
const { ClinicianApplicationAdminService } = load('admin/clinician-application-admin.service.ts');
const { ClinicianApplicationController } = load('identity/clinician-application.controller.ts');
const { ClinicianApplicationService } = load('identity/clinician-application.service.ts');
const { ClinicianApplicationSweeper } = load('identity/clinician-application.sweeper.ts');
const { getEnvironment } = load('config/environment.ts');
const { DomainProblem, ProblemDetailsFilter } = load('common/problem.ts');

// Cloudflare Siteverify stand-in: a token `ok|<action>|<hostname>|<n>`
// verifies once for that action and host; any other outbound request fails.
const siteverifyUrl = getEnvironment().TURNSTILE_SITEVERIFY_URL;
let siteverifyCalls = 0;
const verifiedTokens = new Set();
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  assert.equal(url, siteverifyUrl, `Unexpected outbound request to ${url}`);
  siteverifyCalls += 1;
  const body = JSON.parse(String(init?.body));
  const [kind, action, hostname] = String(body.response).split('|');
  if (kind !== 'ok' || verifiedTokens.has(body.response)) {
    return Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] });
  }
  verifiedTokens.add(body.response);
  return Response.json({ success: true, action, hostname });
};
let issued = 0;
const turnstile = (action, host = siteHost) => `ok|${action}|${host}|${++issued}`;

const maintenance = new Pool({ host: socket, user: process.env.PGUSER, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
// Fixture and assertion connections (database owner), never used by the API.
const owner = new Pool({ host: socket, user: process.env.PGUSER, database: isolated, max: 4 });
owner.on('error', () => undefined);
let app;
try {
  const argon2 = require('argon2');
  const password = 'Synthetic-Clinician-Runtime-Password-2026';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  // Counts the argon2id hashes P4 runs of the applicants' password: it hashes
  // only a submission the database may create, never a refusal or a replay.
  const passwordHashing = load('auth/password-hash.ts');
  const hashAccountPassword = passwordHashing.hashAccountPassword;
  let passwordHashes = 0;
  passwordHashing.hashAccountPassword = (value) => {
    if (value === password) passwordHashes += 1;
    return hashAccountPassword(value);
  };
  const ids = { org: randomUUID(), x: randomUUID(), y: randomUUID(), pending: randomUUID() };
  await owner.query("insert into identity.organizations (id, name, slug) values ($1, 'Clinician Runtime Health', $2)",
    [ids.org, `clinician-runtime-${ids.org.slice(0, 8)}`]);
  await owner.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
    values ($1, $4, 'Clinician Runtime Hospital X', $5, 'Africa/Lagos', true, 'verified'),
           ($2, $4, 'Clinician Runtime Hospital Y', $6, 'Africa/Lagos', true, 'verified'),
           ($3, $4, 'Clinician Runtime Hospital Pending', $7, 'Africa/Lagos', false, 'pending')`,
  [ids.x, ids.y, ids.pending, ids.org, `CRX-${ids.x.slice(0, 6)}`, `CRY-${ids.y.slice(0, 6)}`,
    `CRP-${ids.pending.slice(0, 6)}`]);
  async function account(label, { platformRole, membershipRole, patient, staffOnly } = {}) {
    const id = randomUUID();
    const email = `clinician-runtime-${label}-${id.slice(0, 8)}@example.invalid`;
    await owner.query(`insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm)
      values ($1, $2, $3, $4, 'active', $5, 'argon2id')`,
    [id, `synthetic:clinician-runtime:${label}`, email, `Clinician Runtime ${label}`, passwordHash]);
    if (platformRole) {
      await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
        values ($1, $2, $3, 'platform', 'Synthetic clinician runtime verifier')`, [randomUUID(), id, platformRole]);
    }
    if (membershipRole || staffOnly) {
      const staffId = randomUUID();
      await owner.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
        values ($1, $2, $3, $4, 'verified', $5)`, [staffId, id, `Clinician Runtime ${label}`, email, membershipRole ?? 'staff']);
      if (membershipRole) {
        const membershipId = randomUUID();
        await owner.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id,
            facility_id, membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, $6, $6, true, true)`,
        [membershipId, staffId, id, ids.org, ids.x, membershipRole]);
        await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id,
            grant_reason) values ($1, $2, $3, 'facility', $4, $5, 'Synthetic facility role')`,
        [randomUUID(), id, membershipRole, membershipId, ids.x]);
      }
    }
    if (patient) {
      await owner.query(`insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status)
        values ($1, $2, $3, 'Ada', 'Patient', 'Ada Patient', 'active')`, [randomUUID(), id, patient]);
    }
    return { id, email, label };
  }
  const superA = await account('super-a', { platformRole: 'platform_super_admin' });
  const superB = await account('super-b', { platformRole: 'platform_super_admin' });
  const superC = await account('super-c', { platformRole: 'platform_super_admin' });
  const insider = await account('insider', { platformRole: 'platform_super_admin', membershipRole: 'doctor' });
  const support = await account('support', { platformRole: 'support_admin' });
  const patientHolder = await account('patient', { patient: 'HID-CLRUNTPA' });
  const staffHolder = await account('staff-held', { staffOnly: true });
  const orgAdmin = await account('org-admin', { membershipRole: 'org_admin' });

  const clock = createTotpClock();
  // Codes Identity would deliver: sign-up and status codes by challenge, and
  // the 0088 enrolment codes by recipient (LOGIN_STEP_UP).
  const signupCodes = new Map();
  const signupRecipients = [];
  const outbox = enrollmentCodeOutbox(async (input) => {
    assert.equal(input.purpose, 'SIGNUP_VERIFY');
    assert.equal(input.channel, 'email');
    signupCodes.set(input.challengeId, { recipient: input.recipient, code: input.code });
    signupRecipients.push(input.recipient);
    return { outcome: 'accepted', provider: 'synthetic' };
  });
  const module = await Test.createTestingModule({
    controllers: [AuthController, PlatformAuthController, PlatformSecurityController, AdminController,
      WorkforceAdminController, AdminClinicianApplicationsController, ClinicianApplicationController],
    providers: [DatabaseService, TokenService, LocalAuthProvider, CurrentStaffContextService, CurrentPatientContextService,
      AuthService, AuthSessionAuditService, AuditService, WorkloadAuthService, TurnstileService, MfaService,
      MfaSecretProtector, PlatformSecurityService, AdminService, AdminOperationsService, PricingService,
      WorkforceAdminService, ClinicianApplicationAdminService, ClinicianApplicationService, ClinicianApplicationSweeper,
      { provide: MFA_TOTP_CLOCK, useValue: clock.now },
      { provide: NotificationOtpClient, useValue: outbox.client },
      { provide: GoogleAuthenticationService, useValue: {
        login: async () => { throw new Error('Google is outside the clinician application verifier'); } } }],
  }).compile();
  const runtimeRole = (await module.get(DatabaseService).query('select current_user as role')).rows[0].role;
  assert.equal(runtimeRole, 'hid_identity_api_runtime');
  app = module.createNestApplication({ logger: false });
  app.getHttpAdapter().getInstance().set('trust proxy',
    getEnvironment().TRUST_PROXY_CIDRS.split(',').map(cidr => cidr.trim()));
  app.use(require('cookie-parser')());
  app.use((req, _res, next) => { req.correlationId = randomUUID(); next(); });
  app.setGlobalPrefix('api/v1');
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
  const applications = module.get(ClinicianApplicationService);
  const sweeper = module.get(ClinicianApplicationSweeper);
  const checks = [];
  const one = async (sql, values) => (await owner.query(sql, values)).rows[0];
  const count = async (sql, values) => (await one(sql, values)).n;

  // --- HTTP helpers --------------------------------------------------------
  const BASE = '/api/v1/identity/clinician-applications';
  function call(method, path, { cookie, body, headers = {}, network = '198.51.100.10', from = origin } = {}) {
    let pending = http[method](`${BASE}${path}`).set('X-Forwarded-For', network);
    if (from) pending = pending.set('Origin', from);
    if (cookie) pending = pending.set('Cookie', cookie);
    for (const [name, value] of Object.entries(headers)) pending = pending.set(name, value);
    return method === 'get' ? pending : pending.send(body ?? {});
  }
  const setCookieValues = response => response.headers['set-cookie'] ?? [];
  function capabilityOf(response, maxAge) {
    const cookies = setCookieValues(response);
    assert.equal(cookies.length, 1, `exactly one cookie: ${JSON.stringify(cookies)}`);
    const [cookie] = cookies;
    assert.match(cookie, /^hid_clinician_application=[A-Za-z0-9_-]{43}; /);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/v1/identity/clinician-applications',
      `Max-Age=${maxAge}`]) assert(cookie.includes(attribute), `${attribute} missing from ${cookie}`);
    assert(!/;\s*domain=/i.test(cookie), 'the capability cookie is host-only');
    return `hid_clinician_application=${cookie.split(';')[0].split('=')[1]}`;
  }
  const lagosDate = (days) => new Date(Date.now() + days * 86_400_000 + 3_600_000).toISOString().slice(0, 10);
  const details = (facilityId, extra = {}) => ({ profession: 'doctor', regulator: 'MDCN', licenceValidUntil: lagosDate(730),
    facilityId, declarations: { accurate: true, verificationConsent: true }, ...extra });
  let networks = 20;
  const newNetwork = () => `198.51.100.${++networks}`;
  const key = (label) => `clinician-runtime-${label}-${randomUUID()}`;

  async function startCode(path, email, action, network) {
    const response = await call('post', path, { body: { email, turnstileAction: action, turnstileToken: turnstile(action) },
      network });
    await applications.settleDeliveries();
    return response;
  }
  /** A fresh applicant's draft: the sign-up code, verified. */
  async function draftFor(email, network) {
    const started = await startCode('/email-code', email, 'clinician-application', network);
    expectStatus(started, 202);
    const delivered = signupCodes.get(started.body.challengeId);
    assert.equal(delivered?.recipient, email.toLowerCase());
    const verified = await call('post', '/email-code/verify', { network,
      body: { challengeId: started.body.challengeId, email, code: delivered.code } });
    expectStatus(verified, 200);
    return { cookie: capabilityOf(verified, 3600), verified };
  }
  /** Sign-up to submit, then the authenticator: returns the ready capability and the applicant's factor. */
  async function applicant(label, facilityId, licence) {
    const email = `clinician-${label}-${randomUUID().slice(0, 8)}@example.invalid`;
    const network = newNetwork();
    const draft = await draftFor(email, network);
    const submitted = await call('post', '', { cookie: draft.cookie, network, headers: { 'Idempotency-Key': key(label) },
      body: { ...details(facilityId, { licenceNumber: licence }), email, fullName: `Runtime ${label} Clinician`, password } });
    expectStatus(submitted, 201);
    const cookie = capabilityOf(submitted, 1800);
    const factor = await enrol(cookie, email);
    const accountId = (await one('select id::text from auth.accounts where email = $1', [email])).id;
    return { email, network, cookie, accountId, applicationId: submitted.body.applicationId, ...factor };
  }
  /** P5-P7: the emailed proof, the secret, the first code; no session. */
  async function enrol(cookie, email, network) {
    const sent = await call('post', '/authenticator/email-code', { cookie, network });
    expectStatus(sent, 200);
    const emailCode = outbox.take(email);
    assert.match(emailCode ?? '', /^[0-9]{6}$/);
    const started = await call('post', '/authenticator/start', { cookie, network, body: { emailCode } });
    expectStatus(started, 200);
    const activated = await call('post', '/authenticator/activate', { cookie, network,
      body: { code: totpAt(started.body.secret, clock.next()) } });
    expectStatus(activated, 200);
    assert.equal(activated.body.recoveryCodes.length, 10);
    assert.equal(activated.body.stage, 'ready');
    assert.deepEqual(setCookieValues(activated), [], 'activation sets no cookie');
    return { secret: started.body.secret, recoveryCodes: activated.body.recoveryCodes, activated };
  }
  const code = (who) => totpAt(who.secret, clock.next());

  // Platform administrators: password then authenticator, on the shared clock.
  const platform = platformClient({ http, origin, totp, clock, password, turnstileToken: () => turnstile('admin-login') });
  const staff = staffClient({ send: supertestTransport(http), origin, password, outbox, now: clock.next,
    turnstileToken: (action) => turnstile(action) });
  const adminA = await platform.enroll(superA.email);
  const adminB = await platform.enroll(superB.email);
  const adminC = await platform.enroll(superC.email);
  const adminSupport = await platform.enroll(support.email);
  await staff.signIn(insider.email);
  const adminInsider = await platform.signIn({ email: insider.email, secret: staff.secretOf(insider.email) });
  const ADMIN = '/admin/clinician-applications';
  const detail = async (admin, id) => {
    const response = await platform.get(admin, `${ADMIN}/${id}`);
    expectStatus(response, 200);
    return response.body;
  };
  const attestBody = (applicantCode, validDays = 365) => ({
    validUntil: new Date(Date.now() + validDays * 86_400_000).toISOString(),
    evidenceReference: 'Verification ticket CLIN-RUNTIME', checklist: { registerChecked: true,
      licenceCurrentUntilRecorded: true, identityMethod: 'video_call_photo_id', identityConfirmed: true,
      employmentChannel: 'facility_public_phone', employmentConfirmed: true },
    authenticatorCode: applicantCode, reason: 'Licence, identity and employment verified' });
  const attest = async (admin, id, applicantCode, { validDays = 365, version } = {}) => platform.command(admin,
    `${ADMIN}/${id}/attest`, attestBody(applicantCode, validDays),
    { 'If-Match': String(version ?? (await detail(admin, id)).version), 'Idempotency-Key': key('attest') });
  const factorFailures = async (accountId) => count(`select count(*)::int as n from auth.session_events
    where account_id = $1 and event_type = 'mfa_failed'`, [accountId]);
  const approve = async (admin, id, version) => platform.command(admin, `${ADMIN}/${id}/approve`,
    { reason: 'Second Super Admin review complete' },
    { 'If-Match': String(version ?? (await detail(admin, id)).version), 'Idempotency-Key': key('approve') });
  const reject = async (admin, id, decisionCode) => platform.command(admin, `${ADMIN}/${id}/reject`,
    { decisionCode, reason: 'Internal rejection reason for the verifier' },
    { 'If-Match': String((await detail(admin, id)).version), 'Idempotency-Key': key('reject') });
  async function setControl(controlKey, enabled) {
    await platform.stepUp(adminA);
    const listed = await platform.get(adminA, '/admin/controls');
    expectStatus(listed, 200);
    const control = listed.body.find(item => item.controlKey === controlKey);
    assert(control, `${controlKey} is listed`);
    const changed = await platform.command(adminA, '/admin/controls', { controlKey, enabled,
      reason: `Verifier sets ${controlKey}` }, { 'If-Match': String(control.version) });
    expectStatus(changed, 201);
    assert.equal(changed.body.enabled, enabled);
  }
  const availability = async () => {
    const response = await call('get', '/availability', { from: null });
    expectStatus(response, 200);
    assert.equal(response.headers['cache-control'], 'public, max-age=30');
    return response.body.open;
  };

  // 1. Closed by default.
  const SIGNUP_CLOSED = 'Clinician sign-up is not open yet. If you already have a Health ID provider account, sign in.';
  assert.deepEqual(await one(`select enabled, row_version::int as version from platform.control_settings
    where control_key = 'clinician_signup_enabled'`), { enabled: false, version: 1 });
  assert.equal(await availability(), false);
  const closed = await startCode('/email-code', 'closed@example.invalid', 'clinician-application', newNetwork());
  expectStatus(closed, 503, 'CLINICIAN_SIGNUP_CLOSED');
  assert.equal(closed.body.detail, SIGNUP_CLOSED);
  expectStatus(await startCode('/status/email-code', 'closed@example.invalid', 'clinician-application-status',
    newNetwork()), 202);
  assert.equal(await count(`select count(*)::int as n from identity.clinician_application_challenges
    where purpose = 'signup'`), 0, 'a closed sign-up started a challenge');
  checks.push('closed by default: clinician_signup_enabled is seeded off (version 1), availability is {open:false} (public, max-age=30), the sign-up start is 503 CLINICIAN_SIGNUP_CLOSED with its fixed sentence and starts nothing; the status start is not gated (202)');

  // 2. A Super Admin opens it; the provider portal and maintenance still close it.
  await setControl('clinician_signup_enabled', true);
  assert.equal(await availability(), true);
  await setControl('provider_portal_enabled', false);
  assert.equal(await availability(), false);
  expectStatus(await startCode('/email-code', 'portal@example.invalid', 'clinician-application', newNetwork()), 503,
    'CLINICIAN_SIGNUP_CLOSED');
  // The intake routes answer a closed intake before the capability: with no
  // cookie (one that expired in the browser) search, submit and apply again
  // are 503 CLINICIAN_SIGNUP_CLOSED, not 401.
  const closedDetails = details(ids.x, { licenceNumber: 'MDCN/R/CLOSED' });
  expectStatus(await call('post', '/facility-search', { body: { query: 'Clinician Runtime' } }), 503,
    'CLINICIAN_SIGNUP_CLOSED');
  expectStatus(await call('post', '', { headers: { 'Idempotency-Key': key('closed') }, body: { ...closedDetails,
    email: 'portal@example.invalid', fullName: 'Runtime Closed Clinician', password } }), 503, 'CLINICIAN_SIGNUP_CLOSED');
  expectStatus(await call('post', '/current/applications', { headers: { 'Idempotency-Key': key('closed-apply') },
    body: closedDetails }), 503, 'CLINICIAN_SIGNUP_CLOSED');
  await setControl('provider_portal_enabled', true);
  await setControl('maintenance_mode', true);
  assert.equal(await availability(), false);
  expectStatus(await startCode('/email-code', 'maintenance@example.invalid', 'clinician-application', newNetwork()), 503,
    'PLATFORM_MAINTENANCE');
  expectStatus(await startCode('/status/email-code', 'maintenance@example.invalid', 'clinician-application-status',
    newNetwork()), 503, 'PLATFORM_MAINTENANCE');
  await setControl('maintenance_mode', false);
  assert.equal(await availability(), true);
  assert.equal(await count(`select count(*)::int as n from platform.control_events
    where control_key = 'clinician_signup_enabled'`), 1);
  checks.push('a Super Admin opens intake through POST /admin/controls (step-up, If-Match; one control event); with the provider portal off it is closed again (503 CLINICIAN_SIGNUP_CLOSED, also for search, submit and apply-again with no capability cookie) and in maintenance both starts are 503 PLATFORM_MAINTENANCE');

  // 3. Turnstile and the signed-out rule, before the service.
  const challengesBefore = await count('select count(*)::int as n from identity.clinician_application_challenges');
  const callsBefore = siteverifyCalls;
  expectStatus(await call('post', '/email-code', { from: adminOrigin, body: { email: 'turnstile@example.invalid',
    turnstileAction: 'clinician-application', turnstileToken: turnstile('clinician-application', 'admin.staging.healthidentitydirectory.com') } }),
  403, 'TURNSTILE_CONTEXT_MISMATCH');
  expectStatus(await call('post', '/email-code', { body: { email: 'turnstile@example.invalid',
    turnstileAction: 'clinician-application', turnstileToken: turnstile('provider-enrollment') } }), 403,
  'TURNSTILE_ACTION_MISMATCH');
  expectStatus(await call('post', '/email-code', { body: { email: 'turnstile@example.invalid',
    turnstileAction: 'staff-login', turnstileToken: turnstile('staff-login') } }), 400, 'VALIDATION_FAILED');
  expectStatus(await call('post', '/email-code', { cookie: 'hid_access=signed-in', body: { email: 'turnstile@example.invalid',
    turnstileAction: 'clinician-application', turnstileToken: turnstile('clinician-application') } }), 409,
  'CLINICIAN_APPLICATION_REQUIRES_SIGN_OUT');
  expectStatus(await call('post', '/email-code', { from: 'https://attacker.example', body: { email: 'turnstile@example.invalid',
    turnstileAction: 'clinician-application', turnstileToken: turnstile('clinician-application') } }), 403, 'ORIGIN_DENIED');
  assert.equal(siteverifyCalls - callsBefore, 1, 'only the action mismatch reached Siteverify');
  assert.equal(await count('select count(*)::int as n from identity.clinician_application_challenges'), challengesBefore);
  checks.push('a sign-up start from the admin host is 403 TURNSTILE_CONTEXT_MISMATCH before Siteverify, a token for another action is 403 TURNSTILE_ACTION_MISMATCH, another action in the body is 400, a signed-in browser is 409 CLINICIAN_APPLICATION_REQUIRES_SIGN_OUT and a foreign Origin 403; none starts a challenge');

  // 4. Every address is answered alike; in-use is told only after a correct code.
  const fresh = `clinician-fresh-${randomUUID().slice(0, 8)}@example.invalid`;
  const enumeration = newNetwork();
  const starts = [];
  for (const email of [fresh, staffHolder.email, patientHolder.email]) {
    starts.push(await startCode('/email-code', email, 'clinician-application', enumeration));
  }
  const headerNames = response => Object.keys(response.headers).filter(name => !['date', 'etag', 'content-length']
    .includes(name)).sort();
  for (const response of starts) {
    expectStatus(response, 202);
    assert.deepEqual(Object.keys(response.body).sort(), ['accepted', 'challengeId', 'expiresInSeconds', 'resendAfterSeconds']);
    assert.deepEqual([response.body.expiresInSeconds, response.body.resendAfterSeconds], [600, 60]);
    assert.deepEqual(headerNames(response), headerNames(starts[0]));
    assert.deepEqual(setCookieValues(response), []);
    assert(signupCodes.has(response.body.challengeId), 'every sign-up start delivers a code');
  }
  const inUse = signupCodes.get(starts[1].body.challengeId);
  const inUseAnswer = await call('post', '/email-code/verify', { network: enumeration,
    body: { challengeId: starts[1].body.challengeId, email: staffHolder.email, code: inUse.code } });
  expectStatus(inUseAnswer, 409, 'CLINICIAN_EMAIL_IN_USE');
  assert.deepEqual(setCookieValues(inUseAnswer), [], 'an in-use address gets no draft');
  const patientChallenge = starts[2].body.challengeId;
  const patientCode = signupCodes.get(patientChallenge).code;
  const wrong = patientCode === '000000' ? '111111' : '000000';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    expectStatus(await call('post', '/email-code/verify', { network: enumeration,
      body: { challengeId: patientChallenge, email: patientHolder.email, code: wrong } }), 401,
    'CLINICIAN_APPLICATION_CODE_INVALID');
  }
  expectStatus(await call('post', '/email-code/verify', { network: enumeration,
    body: { challengeId: patientChallenge, email: patientHolder.email, code: patientCode } }), 401,
  'CLINICIAN_APPLICATION_CODE_INVALID');
  checks.push('sign-up starts for a fresh, a staff-held and a patient-held address are identical 202s (body keys, header names, no cookie) and each gets a code; a correct code for an address in use is 409 CLINICIAN_EMAIL_IN_USE with no draft; after five wrong codes the right one is 401');

  // 5. The draft, the facility search and its budget.
  const freshCode = signupCodes.get(starts[0].body.challengeId);
  const freshVerified = await call('post', '/email-code/verify', { network: enumeration,
    body: { challengeId: starts[0].body.challengeId, email: fresh, code: freshCode.code } });
  expectStatus(freshVerified, 200);
  assert.deepEqual(Object.keys(freshVerified.body).sort(), ['expiresAt', 'verified']);
  const draft = capabilityOf(freshVerified, 3600);
  assert(!JSON.stringify(freshVerified.body).includes(draft.split('=')[1]), 'the token is in the body');
  const searched = await call('post', '/facility-search', { cookie: draft, network: enumeration,
    body: { query: 'Clinician Runtime' } });
  expectStatus(searched, 200);
  assert.deepEqual(searched.body.facilities.map(item => item.facilityId).sort(), [ids.x, ids.y].sort(),
    'only verified facilities of active organizations are found');
  expectStatus(await call('post', '/facility-search', { cookie: `${draft}; hid_access=signed-in`, network: enumeration,
    body: { query: 'Clinician Runtime' } }), 409, 'CLINICIAN_APPLICATION_REQUIRES_SIGN_OUT');
  for (let search = 2; search <= 30; search += 1) {
    expectStatus(await call('post', '/facility-search', { cookie: draft, network: enumeration, body: { query: '100%_x' } }), 200);
  }
  const budget = await call('post', '/facility-search', { cookie: draft, network: enumeration, body: { query: 'Runtime' } });
  expectStatus(budget, 429, 'CLINICIAN_APPLICATION_RATE_LIMITED');
  assert.equal(budget.headers['retry-after'], '3600');
  checks.push('a correct code opens a 60-minute draft (HttpOnly, Secure, SameSite=Strict, host-only, scoped to the routes) and never returns its token; the search finds only verified facilities, refuses a signed-in browser for a draft (409), and the 31st search of a capability is 429 with Retry-After 3600');

  // 6. Submit, the rotating capability, no session, replay.
  const submitKey = key('submit');
  const signup = { ...details(ids.x, { licenceNumber: 'MDCN/R/40001' }), email: fresh, fullName: 'Runtime Fresh Clinician',
    password };
  // A forged capability (well-formed, unknown) on submit or apply-again is
  // refused before the submit quota is charged (and before the password is
  // hashed): no counter moves.
  const submitCharges = async () => (await one(`select coalesce(sum(attempt_count), 0)::int as n
    from platform.clinician_application_quota_counters where operation = 'submit' and scope = 'network'`)).n;
  const platformCreated = async () => (await one(`select coalesce(sum(attempt_count), 0)::int as n
    from platform.clinician_application_quota_counters where operation = 'submit' and scope = 'platform'`)).n;
  const forged = `hid_clinician_application=${'A'.repeat(43)}`;
  const chargesBefore = await submitCharges();
  const createdBefore = await platformCreated();
  expectStatus(await call('post', '', { cookie: forged, network: enumeration, headers: { 'Idempotency-Key': key('forged') },
    body: signup }), 401, 'CLINICIAN_APPLICATION_SESSION_INVALID');
  expectStatus(await call('post', '/current/applications', { cookie: forged, network: enumeration,
    headers: { 'Idempotency-Key': key('forged-apply') }, body: details(ids.y, { licenceNumber: 'MDCN/R/40001' }) }), 401,
  'CLINICIAN_APPLICATION_SESSION_INVALID');
  assert.deepEqual([await submitCharges(), await platformCreated()], [chargesBefore, createdBefore],
    'a forged capability charged the submit quota');
  // C8's refusals that need no password are answered before argon2id runs
  // and leave the draft usable: a licence date out of range, an unknown facility.
  const hashesBefore = passwordHashes;
  expectStatus(await call('post', '', { cookie: draft, network: enumeration, headers: { 'Idempotency-Key': key('far') },
    body: { ...signup, licenceValidUntil: '2099-12-31' } }), 400, 'CLINICIAN_APPLICATION_INVALID');
  expectStatus(await call('post', '', { cookie: draft, network: enumeration, headers: { 'Idempotency-Key': key('nowhere') },
    body: { ...signup, facilityId: randomUUID() } }), 409, 'CLINICIAN_APPLICATION_FACILITY_UNAVAILABLE');
  assert.equal(passwordHashes, hashesBefore, 'a submission refused without its password was hashed');
  const submitted = await call('post', '', { cookie: draft, network: enumeration, headers: { 'Idempotency-Key': submitKey },
    body: signup });
  expectStatus(submitted, 201);
  assert.equal(passwordHashes, hashesBefore + 1, 'the created submission was not hashed once');
  assert.equal(await platformCreated(), createdBefore + 1, 'the platform did not count the created application');
  assert.equal(submitted.body.state, 'awaiting_authenticator');
  assert.deepEqual([submitted.body.next, submitted.body.authenticator.purpose, submitted.body.replayed],
    ['authenticator', 'enroll', false]);
  const firstCapability = capabilityOf(submitted, 1800);
  assert.notEqual(firstCapability, draft, 'the capability rotates at submit');
  const freshAccount = await one(`select account.id::text, account.status, account.subject, account.email_verified_at is not null
      as verified, account.password_hash like '$argon2id$v=19$m=65536,t=3,p=1$%' as argon2id, staff.verification_status,
      staff.license_number
    from auth.accounts account join identity.staff staff on staff.account_id = account.id where account.email = $1`, [fresh]);
  assert.deepEqual({ ...freshAccount, id: undefined }, { id: undefined, status: 'active',
    subject: `workforce:${freshAccount.id}`, verified: true, argon2id: true, verification_status: 'pending',
    license_number: 'MDCN/R/40001' });
  assert.equal(await count(`select count(*)::int as n from identity.staff_facility_memberships
    where account_id = $1`, [freshAccount.id]), 0, 'a membership exists before review');
  assert.equal(await count('select count(*)::int as n from auth.sessions where account_id = $1', [freshAccount.id]), 0);
  const replay = await call('post', '', { cookie: draft, network: enumeration, headers: { 'Idempotency-Key': submitKey },
    body: signup });
  expectStatus(replay, 201);
  assert.deepEqual([replay.body.applicationId, replay.body.replayed], [submitted.body.applicationId, true]);
  assert.equal(passwordHashes, hashesBefore + 1, 'a replay hashed the password again');
  assert.equal(await platformCreated(), createdBefore + 1, 'a replay counted against the platform\'s daily cap');
  const capability = capabilityOf(replay, 1800);
  expectStatus(await call('post', '', { cookie: draft, network: enumeration, headers: { 'Idempotency-Key': key('other') },
    body: signup }), 401, 'CLINICIAN_APPLICATION_SESSION_INVALID');
  // The replay re-opened the enrolment: the first capability's challenge was superseded.
  expectStatus(await call('post', '/authenticator/email-code', { cookie: firstCapability, network: enumeration }), 401,
    'MFA_CHALLENGE_INVALID');
  checks.push('a forged capability on submit or apply-again is 401 before the submit quota is charged (no counter moves); the platform\'s daily cap counts the created application once, not its replay');
  checks.push('a submission with a licence date out of range (400 CLINICIAN_APPLICATION_INVALID) or an unknown facility (409 CLINICIAN_APPLICATION_FACILITY_UNAVAILABLE) is refused without hashing the password and leaves the draft usable; the created submission hashes it once and its replay not again');
  checks.push('submit (Idempotency-Key) creates an active account (subject workforce:<id>, verified email, argon2id 64 MiB/3/1), a pending staff record with the licence, no membership and no session, and answers awaiting_authenticator with the enrolment next; the capability rotates (30 minutes); the same key replays the same application with a fresh capability (the earlier challenge is superseded); another key on a spent draft is 401');

  // 7. No sign-in before approval.
  const early = await http.post('/api/v1/auth/login').set('Origin', origin).send({ email: fresh, password,
    turnstileAction: 'staff-login', turnstileToken: turnstile('staff-login') });
  expectStatus(early, 403, 'NO_ACTIVE_FACILITY_MEMBERSHIP');
  assert.deepEqual(setCookieValues(early), []);
  checks.push('the applicant\'s password step is 403 NO_ACTIVE_FACILITY_MEMBERSHIP with no cookie');

  // 8. The authenticator before review, without a session.
  const current = await call('get', '/current', { cookie: capability, network: enumeration });
  expectStatus(current, 200);
  assert.deepEqual([current.body.stage, current.body.applications.map(item => item.state)],
    ['enrolment_required', ['awaiting_authenticator']]);
  const freshFactor = await enrol(capability, fresh, enumeration);
  assert.deepEqual(freshFactor.activated.body.applications.map(item => item.state), ['submitted']);
  assert.equal(await count('select count(*)::int as n from auth.sessions where account_id = $1', [freshAccount.id]), 0,
    'the enrolment issued a session');
  assert.deepEqual(await one(`select enrollment_proof, status from auth.mfa_factors where account_id = $1`,
    [freshAccount.id]), { enrollment_proof: 'email_code', status: 'active' });
  const token = capability.split('=')[1];
  for (const path of ['/auth/mfa/verify', '/auth/mfa/enroll/email-code', '/auth/mfa/enroll/start']) {
    for (const value of [token, draft.split('=')[1]]) {
      const presented = await http.post(`/api/v1${path}`).set('Origin', origin).set('Cookie', `hid_access_mfa=${value}`)
        .send(path === '/auth/mfa/verify' ? { code: code(freshFactor) } : {});
      expectStatus(presented, 401, 'MFA_CHALLENGE_INVALID');
    }
  }
  assert.equal(await count(`select count(*)::int as n from auth.mfa_login_challenges where account_id = $1
    and token_sha256 = $2`, [freshAccount.id, createHash('sha256').update(token).digest('hex')]), 0,
  'a challenge token equals the capability');
  expectStatus(await http.post('/api/v1/auth/login').set('Origin', origin).send({ email: fresh, password,
    turnstileAction: 'staff-login', turnstileToken: turnstile('staff-login') }), 403, 'NO_ACTIVE_FACILITY_MEMBERSHIP');
  const scanned = await count(`select count(*)::int as n from audit.events where details::text ilike any($1)`,
    [[`%${fresh}%`, '%Runtime Fresh Clinician%', '%MDCN/R/40001%']]);
  assert.equal(scanned, 0, 'an audit row carries the applicant\'s email, name or licence');
  checks.push('the authenticator is set up before review through the capability (emailed proof, secret, first code): 10 recovery codes, a staff-proven factor, the application moves to submitted, and no session or session cookie; neither the capability nor the draft works as a challenge at /auth/mfa/verify or /auth/mfa/enroll/* (401), no challenge token equals the capability, sign-in is still 403, and no audit row carries the email, name or licence');

  // 9. The status page.
  const statusNetwork = newNetwork();
  const statusStarts = [];
  for (const email of [fresh, patientHolder.email, superC.email, orgAdmin.email, 'nobody-here@example.invalid']) {
    statusStarts.push(await startCode('/status/email-code', email, 'clinician-application-status', statusNetwork));
  }
  for (const response of statusStarts) {
    expectStatus(response, 202);
    assert.deepEqual(Object.keys(response.body).sort(), ['accepted', 'challengeId', 'expiresInSeconds', 'resendAfterSeconds']);
    assert.deepEqual(headerNames(response), headerNames(statusStarts[0]));
  }
  assert.deepEqual(statusStarts.map(response => signupCodes.has(response.body.challengeId)),
    [true, false, false, false, false], 'only the applicant gets a status code');
  expectStatus(await call('post', '/status/email-code/verify', { network: statusNetwork,
    body: { challengeId: statusStarts[1].body.challengeId, email: patientHolder.email, code: '123456' } }), 401,
  'CLINICIAN_APPLICATION_CODE_INVALID');
  const statusCode = signupCodes.get(statusStarts[0].body.challengeId).code;
  const statusOpened = await call('post', '/status/email-code/verify', { cookie: 'hid_access=other-session',
    network: statusNetwork, body: { challengeId: statusStarts[0].body.challengeId, email: fresh, code: statusCode } });
  expectStatus(statusOpened, 200);
  assert.equal(statusOpened.body.next, 'authenticator_verify');
  const status = capabilityOf(statusOpened, 1800);
  expectStatus(await call('get', '/current', { cookie: status }), 403, 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED');
  const failuresBefore = await count(`select count(*)::int as n from auth.session_events where account_id = $1
    and event_type = 'mfa_failed'`, [freshAccount.id]);
  expectStatus(await call('post', '/authenticator/verify', { cookie: status, body: { code: '000000' } }), 401,
    'MFA_INVALID_CODE');
  assert.equal(await count(`select count(*)::int as n from auth.session_events where account_id = $1
    and event_type = 'mfa_failed'`, [freshAccount.id]), failuresBefore + 1, 'a wrong code is counted');
  const statusVerified = await call('post', '/authenticator/verify', { cookie: status, body: { code: code(freshFactor) } });
  expectStatus(statusVerified, 200);
  assert.equal(statusVerified.body.stage, 'ready');
  assert.equal(await count('select count(*)::int as n from auth.sessions where account_id = $1', [freshAccount.id]), 0);
  const listed = await call('get', '/current', { cookie: status });
  expectStatus(listed, 200);
  assert.equal(listed.body.applications[0].licenceNumberHint, '0001');
  // A ready capability searches facilities (to apply again), also beside a
  // session cookie: only a draft is held to a signed-out browser.
  const readySearch = await call('post', '/facility-search', { cookie: `${status}; hid_access=other-session`,
    network: statusNetwork, body: { query: 'Clinician Runtime' } });
  expectStatus(readySearch, 200);
  assert.deepEqual(readySearch.body.facilities.map(item => item.facilityId).sort(), [ids.x, ids.y].sort());
  const applyKey = key('apply');
  const applyBody = details(ids.y, { licenceNumber: 'MDCN/R/40001' });
  const appliedY = await call('post', '/current/applications', { cookie: status, network: statusNetwork,
    headers: { 'Idempotency-Key': applyKey }, body: applyBody });
  expectStatus(appliedY, 201);
  assert.deepEqual([appliedY.body.state, appliedY.body.replayed], ['submitted', false]);
  const appliedReplay = await call('post', '/current/applications', { cookie: status, network: statusNetwork,
    headers: { 'Idempotency-Key': applyKey }, body: applyBody });
  assert.deepEqual([appliedReplay.status, appliedReplay.body.applicationId, appliedReplay.body.replayed],
    [201, appliedY.body.applicationId, true]);
  expectStatus(await call('post', '/current/applications', { cookie: status, network: statusNetwork,
    headers: { 'Idempotency-Key': key('apply-again') }, body: applyBody }), 409, 'CLINICIAN_APPLICATION_ALREADY_OPEN');
  expectStatus(await call('post', `/${appliedY.body.applicationId}/withdraw`, { cookie: status }), 428, 'IF_MATCH_REQUIRED');
  const withdrawn = await call('post', `/${appliedY.body.applicationId}/withdraw`, { cookie: status,
    headers: { 'If-Match': `"${appliedY.body.version}"` } });
  expectStatus(withdrawn, 200);
  assert.equal(withdrawn.body.state, 'withdrawn');
  expectStatus(await call('post', `/${appliedY.body.applicationId}/withdraw`, { cookie: status,
    headers: { 'If-Match': `"${appliedY.body.version}"` } }), 200);
  checks.push('the status start is an identical 202 for an applicant, a patient, a Super Admin, an org admin and an unknown address, and only the applicant gets a code (a guessed decoy code is 401); a correct code (even beside another session cookie) asks for the authenticator: the list is 403 until then, a wrong TOTP is 401 MFA_INVALID_CODE and counted, the right one makes the capability ready with no session; the ready capability searches facilities beside a session cookie (200); applying again (Idempotency-Key) is submitted at once and replays, a duplicate is 409 ALREADY_OPEN, withdraw needs If-Match and is idempotent');

  // 10. The queue and the two Super Admins.
  expectStatus(await platform.get(adminSupport, `${ADMIN}?state=open`), 403, 'PERMISSION_DENIED');
  const queue = await platform.get(adminA, `${ADMIN}?state=open&limit=50`);
  expectStatus(queue, 200);
  const queued = queue.body.items.find(item => item.applicationId === submitted.body.applicationId);
  assert.deepEqual([queued?.state, queued?.authenticatorReady, queued?.step1], ['submitted', true, null]);
  const freshApplication = submitted.body.applicationId;
  // Super Admin C has not stepped up in this sign-in yet (A has, to change the controls).
  expectStatus(await attest(adminC, freshApplication, code(freshFactor)), 403, 'STEP_UP_REQUIRED');
  await platform.stepUp(adminA);
  // Whatever step 1 would refuse is refused before the applicant's code is
  // checked, so it never counts against the applicant's failure budget: an
  // insider at the facility, and a stale version.
  await platform.stepUp(adminInsider);
  const failuresBeforeRefusals = await factorFailures(freshAccount.id);
  expectStatus(await attest(adminInsider, freshApplication, '000000'), 403, 'WORKFORCE_FACILITY_CONFLICT');
  expectStatus(await attest(adminA, freshApplication, '000000', { version: 1 }), 409, 'VERSION_CONFLICT');
  // Also what step 1 refused only after the code: a validity past the end of
  // the licence's expiry date (the licence ends in 730 days) and an applicant
  // account 0087's attestation refuses (disabled for now). A blank reason
  // never gets that far: the security guard refuses it (400 REASON_REQUIRED).
  expectStatus(await attest(adminA, freshApplication, '000000', { validDays: 1000 }), 400,
    'CLINICIAN_APPLICATION_COMMAND_INVALID');
  expectStatus(await platform.command(adminA, `${ADMIN}/${freshApplication}/attest`,
    { ...attestBody('000000'), reason: '          ' },
    { 'If-Match': String((await detail(adminA, freshApplication)).version), 'Idempotency-Key': key('attest-blank') }),
  400, 'REASON_REQUIRED');
  await owner.query(`update auth.accounts set disabled_until = now() + interval '1 hour' where id = $1`, [freshAccount.id]);
  try {
    expectStatus(await attest(adminA, freshApplication, '000000'), 409, 'WORKFORCE_ACCOUNT_INELIGIBLE');
  } finally {
    await owner.query('update auth.accounts set disabled_until = null where id = $1', [freshAccount.id]);
  }
  assert.equal(await factorFailures(freshAccount.id), failuresBeforeRefusals,
    'a step 1 refused anyway counted a failure against the applicant');
  const failuresBeforeReview = await count(`select count(*)::int as n from auth.session_events where account_id = $1
    and event_type = 'mfa_failed'`, [freshAccount.id]);
  expectStatus(await attest(adminA, freshApplication, '000000'), 403, 'CLINICIAN_APPLICATION_AUTHENTICATOR_CODE_INVALID');
  assert.equal(await count(`select count(*)::int as n from auth.session_events where account_id = $1
    and event_type = 'mfa_failed'`, [freshAccount.id]), failuresBeforeReview + 1, 'the refused code was not counted');
  const attested = await attest(adminA, freshApplication, code(freshFactor));
  expectStatus(attested, 201);
  assert.deepEqual([attested.body.state, attested.body.attestedRoles, attested.body.replayed],
    ['under_review', ['doctor'], false]);
  expectStatus(await approve(adminA, freshApplication), 403, 'CLINICIAN_APPLICATION_SECOND_ADMIN_REQUIRED');
  await platform.stepUp(adminInsider);
  expectStatus(await approve(adminInsider, freshApplication), 403, 'WORKFORCE_FACILITY_CONFLICT');
  await platform.stepUp(adminB);
  const approved = await approve(adminB, freshApplication);
  expectStatus(approved, 201);
  assert.deepEqual([approved.body.state, approved.body.roleCode, approved.body.attestationId],
    ['approved', 'doctor', attested.body.attestationId]);
  // Step 1 on the approved application: its own refusal, no failure counted
  // (no Super Admin can spend an approved clinician's failure budget).
  const failuresAfterApproval = await factorFailures(freshAccount.id);
  expectStatus(await attest(adminA, freshApplication, '000000'), 409, 'CLINICIAN_APPLICATION_STATE_INVALID');
  assert.equal(await factorFailures(freshAccount.id), failuresAfterApproval,
    'step 1 on an approved application counted a failure against the clinician');
  const trail = (await owner.query(`select action, access_scope from audit.events
    where action in ('admin.clinician-application.attested', 'admin.workforce.credential.attested',
      'admin.clinician-application.approved', 'admin.workforce.membership.attached', 'admin.workforce.role.granted')
      and (resource_id in ($1, $2, $3)) order by sequence_id`,
  [freshApplication, attested.body.attestationId, approved.body.membershipId])).rows;
  assert.deepEqual(trail.map(row => row.action), ['admin.clinician-application.attested',
    'admin.workforce.credential.attested', 'admin.clinician-application.approved', 'admin.workforce.membership.attached',
    'admin.workforce.role.granted']);
  assert(trail.every(row => row.access_scope === 'platform'));
  checks.push('the queue needs platform.workforce.manage (a support admin is 403) and lists the application with its authenticator ready; step 1 needs a fresh step-up, refuses an insider (403 WORKFORCE_FACILITY_CONFLICT), a stale version (409), a validity past the licence\'s end (400 COMMAND_INVALID), a blank reason (400 REASON_REQUIRED, the guard), a disabled applicant account (409 WORKFORCE_ACCOUNT_INELIGIBLE) and an approved application (409 STATE_INVALID) before the applicant\'s code is checked, so none counts a failure, refuses a wrong applicant code (403, counted against the applicant) and records the attestation on the applicant\'s live code; the same Super Admin cannot approve (403 SECOND_ADMIN_REQUIRED), an insider is 403 WORKFORCE_FACILITY_CONFLICT, a second Super Admin approves on step 1\'s attestation; five platform-scoped audit events');

  // 11. The first staff sign-in after approval.
  const firstStep = await staff.passwordStep(fresh);
  assert.equal(firstStep.status, 'mfa_required', 'an approved applicant verifies the authenticator set up before review');
  const signedIn = await http.post('/api/v1/auth/mfa/verify').set('Origin', origin).set('Cookie', firstStep.challengeCookie)
    .send({ code: code(freshFactor) });
  expectStatus(signedIn, 200);
  const sessionCookie = (signedIn.headers['set-cookie'] ?? []).find(value => value.startsWith('hid_access='));
  const session = await http.get('/api/v1/auth/session').set('Cookie', sessionCookie.split(';')[0]);
  expectStatus(session, 200);
  assert.equal(session.body.actor.facility.id, ids.x);
  assert(session.body.actor.roles.includes('doctor'), JSON.stringify(session.body.actor.roles));
  checks.push('after approval the password step is mfa_required (no second enrolment) and the authenticator code opens a staff session at the facility with the requested role');

  // 12. The grant rests on its own attestation; a rejection revokes nothing.
  const pinned = await applicant('pinned', ids.x, 'MDCN/R/40002');
  const pinnedY = await call('post', '/current/applications', { cookie: pinned.cookie, network: pinned.network,
    headers: { 'Idempotency-Key': key('pinned-y') }, body: details(ids.y, { licenceNumber: 'MDCN/R/40002' }) });
  expectStatus(pinnedY, 201);
  await platform.stepUp(adminA);
  await platform.stepUp(adminC);
  const attestedX = await attest(adminA, pinned.applicationId, code(pinned), { validDays: 700 });
  expectStatus(attestedX, 201);
  const attestedY = await attest(adminC, pinnedY.body.applicationId, code(pinned), { validDays: 365 });
  expectStatus(attestedY, 201);
  await platform.stepUp(adminB);
  const approvedY = await approve(adminB, pinnedY.body.applicationId);
  expectStatus(approvedY, 201);
  assert.equal((await one(`select attestation_id::text from identity.workforce_role_grants where membership_id = $1`,
    [approvedY.body.membershipId])).attestation_id, attestedY.body.attestationId,
  'the grant rests on the longer-lived attestation of the other application');
  const rejectedX = await reject(adminB, pinned.applicationId, 'identity_not_confirmed');
  expectStatus(rejectedX, 201);
  assert.deepEqual(await one(`select count(*)::int as n from auth.account_roles where membership_id = $1
    and role_code = 'doctor' and revoked_at is null`, [approvedY.body.membershipId]), { n: 1 });
  const pinnedSignIn = await staff.passwordStep(pinned.email);
  assert.equal(pinnedSignIn.status, 'mfa_required');
  const pinnedSession = await http.post('/api/v1/auth/mfa/verify').set('Origin', origin)
    .set('Cookie', pinnedSignIn.challengeCookie).send({ code: code(pinned) });
  expectStatus(pinnedSession, 200);
  assert.equal(pinnedSession.body.actor.facility.id, ids.y);
  expectStatus(await call('post', '/current/applications', { cookie: pinned.cookie, network: pinned.network,
    headers: { 'Idempotency-Key': key('blocked') }, body: details(ids.x, { licenceNumber: 'MDCN/R/40002' }) }), 403,
  'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE');
  // After a reset of the approved clinician's authenticator (as the
  // two-person MFA reset leaves it), the status page refuses to set one up
  // with the mailbox alone: re-enrolment goes through staff sign-in.
  await owner.query(`update auth.mfa_factors set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = $2,
    revocation_reason = 'admin_reset', row_version = row_version + 1 where account_id = $1 and status = 'active'`,
  [pinned.accountId, superB.id]);
  const resetStart = await startCode('/status/email-code', pinned.email, 'clinician-application-status', newNetwork());
  expectStatus(resetStart, 202);
  const resetVerified = await call('post', '/status/email-code/verify', { body: { challengeId: resetStart.body.challengeId,
    email: pinned.email, code: signupCodes.get(resetStart.body.challengeId)?.code ?? '123456' } });
  expectStatus(resetVerified, 403, 'CLINICIAN_APPLICATION_STAFF_SIGN_IN_REQUIRED');
  assert.deepEqual(setCookieValues(resetVerified), [], 'a refused status code set a capability');
  checks.push('with two applications attested by different Super Admins (X for 700 days, Y for 365), approving Y grants on Y\'s own attestation; rejecting X (identity_not_confirmed) leaves Y\'s role effective (staff sign-in at Y) and the account can no longer apply (403 ACCOUNT_INELIGIBLE); after its authenticator is reset, a correct status code is 403 CLINICIAN_APPLICATION_STAFF_SIGN_IN_REQUIRED with no capability');

  // 13. A reserved attestation supports no other grant until approval.
  const reserved = await applicant('reserved', ids.x, 'MDCN/R/40003');
  await platform.stepUp(adminA);
  expectStatus(await attest(adminA, reserved.applicationId, code(reserved)), 201);
  await platform.stepUp(adminB);
  const attached = await platform.command(adminB, '/admin/workforce/memberships', { facilityId: ids.y,
    accountId: reserved.accountId, reason: 'Generic attach while under review' }, { 'Idempotency-Key': key('attach') });
  expectStatus(attached, 201);
  const genericGrant = (version) => platform.command(adminB, `/admin/workforce/memberships/${attached.body.membershipId}/roles`,
    { facilityId: ids.y, roleCode: 'doctor', action: 'grant', reason: 'Generic grant on the reserved attestation' },
    { 'If-Match': String(version), 'Idempotency-Key': key('grant') });
  expectStatus(await genericGrant(attached.body.membershipVersion), 409, 'WORKFORCE_ATTESTATION_REQUIRED');
  const age = async (applicationId, interval) => {
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('alter table identity.clinician_applications disable trigger clinician_applications_guard');
      await client.query(`update identity.clinician_applications set submitted_at = submitted_at - $2::interval,
        expires_at = expires_at - $2::interval where id = $1`, [applicationId, interval]);
      await client.query('alter table identity.clinician_applications enable trigger clinician_applications_guard');
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  };
  await age(reserved.applicationId, '31 days');
  expectStatus(await genericGrant(attached.body.membershipVersion), 409, 'WORKFORCE_ATTESTATION_REQUIRED');
  assert.equal((await one('select state from identity.clinician_applications where id = $1', [reserved.applicationId])).state,
    'under_review', 'the overdue application was swept');
  await age(reserved.applicationId, '-31 days');
  await platform.stepUp(adminC);
  expectStatus(await approve(adminC, reserved.applicationId), 201);
  await platform.stepUp(adminB);
  expectStatus(await genericGrant(attached.body.membershipVersion), 201);
  checks.push('while an application is under review its attestation supports no generic 0087 grant (409 WORKFORCE_ATTESTATION_REQUIRED), also when it is overdue and unswept; after approval the same grant succeeds');

  // 14. Expiry before and after the sweep.
  const expiring = await call('post', '/current/applications', { cookie: status, network: statusNetwork,
    headers: { 'Idempotency-Key': key('expiring') }, body: details(ids.y, { licenceNumber: 'MDCN/R/40001' }) });
  expectStatus(expiring, 201);
  await age(expiring.body.applicationId, '31 days');
  const overdue = await call('get', '/current', { cookie: status });
  assert.equal(overdue.body.applications.find(item => item.applicationId === expiring.body.applicationId).state, 'expired');
  assert.equal((await one('select state from identity.clinician_applications where id = $1',
    [expiring.body.applicationId])).state, 'submitted');
  const locker = await owner.connect();
  try {
    await locker.query('begin');
    await locker.query('select 1 from auth.accounts where id = $1 for update', [freshAccount.id]);
    await sweeper.runOnce();
    assert.equal((await one('select state from identity.clinician_applications where id = $1',
      [expiring.body.applicationId])).state, 'submitted', 'the sweep waited for or took a locked row');
  } finally { await locker.query('rollback'); locker.release(); }
  await sweeper.runOnce();
  assert.equal((await one('select state from identity.clinician_applications where id = $1',
    [expiring.body.applicationId])).state, 'expired');
  assert.deepEqual((await one(`select details from audit.events where action = 'identity.clinician-application.expired'
    and resource_id = $1`, [expiring.body.applicationId])).details.fromState, 'submitted');
  checks.push('an overdue application reads as expired before any sweep; the sweeper skips an application whose account another transaction holds and records it as expired (audited with its previous state) on the next run');

  // 15. Races.
  //   A double-clicked submit: one application, one replay.
  const doubleEmail = `clinician-double-${randomUUID().slice(0, 8)}@example.invalid`;
  const doubleNetwork = newNetwork();
  const doubleDraft = await draftFor(doubleEmail, doubleNetwork);
  const doubleKey = key('double');
  const doubleBody = { ...details(ids.x, { licenceNumber: 'MDCN/R/40004' }), email: doubleEmail,
    fullName: 'Runtime Double Clinician', password };
  const doubled = await Promise.all([0, 1].map(() => call('post', '', { cookie: doubleDraft.cookie, network: doubleNetwork,
    headers: { 'Idempotency-Key': doubleKey }, body: doubleBody })));
  assert.deepEqual(doubled.map(response => response.status), [201, 201]);
  assert.deepEqual(doubled.map(response => response.body.replayed).sort(), [false, true]);
  assert.equal(doubled[0].body.applicationId, doubled[1].body.applicationId);
  assert.equal(await count('select count(*)::int as n from auth.accounts where email = $1', [doubleEmail]), 1);
  //   Concurrent starts for one address: one code (the 60-second cooldown under the advisory lock).
  const raced = `clinician-raced-${randomUUID().slice(0, 8)}@example.invalid`;
  const racedNetwork = newNetwork();
  const racedStarts = await Promise.all([0, 1].map(() => call('post', '/email-code', { network: racedNetwork,
    body: { email: raced, turnstileAction: 'clinician-application', turnstileToken: turnstile('clinician-application') } })));
  await applications.settleDeliveries();
  assert.deepEqual(racedStarts.map(response => response.status), [202, 202]);
  assert.equal(signupRecipients.filter(recipient => recipient === raced).length, 1, 'concurrent starts sent two codes');
  //   Concurrent approvals by two Super Admins, beside the applicant's sign-in.
  const contested = await applicant('contested', ids.x, 'MDCN/R/40005');
  await platform.stepUp(adminA);
  expectStatus(await attest(adminA, contested.applicationId, code(contested)), 201);
  await platform.stepUp(adminB);
  await platform.stepUp(adminC);
  const contestedVersion = (await detail(adminB, contested.applicationId)).version;
  const [approvalB, approvalC, racedLogin] = await Promise.all([approve(adminB, contested.applicationId, contestedVersion),
    approve(adminC, contested.applicationId, contestedVersion),
    http.post('/api/v1/auth/login').set('Origin', origin).send({ email: contested.email, password,
      turnstileAction: 'staff-login', turnstileToken: turnstile('staff-login') })]);
  assert.deepEqual([approvalB.status, approvalC.status].sort(), [201, 409]);
  assert(['VERSION_CONFLICT', 'CLINICIAN_APPLICATION_STATE_INVALID']
    .includes([approvalB, approvalC].find(response => response.status === 409).body.code));
  assert([200, 403].includes(racedLogin.status), `sign-in beside an approval: ${racedLogin.status}`);
  assert.equal(await count(`select count(*)::int as n from identity.staff_facility_memberships
    where account_id = $1 and facility_id = $2`, [contested.accountId, ids.x]), 1);
  //   A double-submitted step 1 (one Idempotency-Key, one code) while the
  //   first is still running: both requests wait for the applicant's account
  //   row, which another transaction holds; then one attests and the other
  //   answers the first answer (replayed), and no failure is counted.
  const doubleAttest = await applicant('double-attest', ids.y, 'MDCN/R/40007');
  await platform.stepUp(adminA);
  const doubleAttestVersion = (await detail(adminA, doubleAttest.applicationId)).version;
  const doubleAttestBody = attestBody(code(doubleAttest));
  const doubleAttestKey = key('attest-double');
  const failuresBeforeDouble = await factorFailures(doubleAttest.accountId);
  const accountHolder = await owner.connect();
  let doubleAttests;
  try {
    await accountHolder.query('begin');
    await accountHolder.query('select 1 from auth.accounts where id = $1 for update', [doubleAttest.accountId]);
    const pending = Promise.all([0, 1].map(() => platform.command(adminA, `${ADMIN}/${doubleAttest.applicationId}/attest`,
      doubleAttestBody, { 'If-Match': String(doubleAttestVersion), 'Idempotency-Key': doubleAttestKey })));
    for (let waited = 0; ; waited += 1) {
      const waiting = await count(`select count(*)::int as n from pg_stat_activity where datname = current_database()
        and backend_type = 'client backend' and wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
      if (waiting >= 2) break;
      assert(waited < 400, 'the two step-1 requests did not both wait for the account lock');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await accountHolder.query('commit');
    doubleAttests = await pending;
  } finally {
    await accountHolder.query('rollback').catch(() => undefined);
    accountHolder.release();
  }
  assert.deepEqual(doubleAttests.map((response) => response.status), [201, 201],
    `a double-submitted step 1: ${JSON.stringify(doubleAttests.map((response) => response.body))}`);
  assert.deepEqual(doubleAttests.map((response) => response.body.replayed).sort(), [false, true]);
  assert.equal(doubleAttests[0].body.attestationId, doubleAttests[1].body.attestationId);
  assert.equal(await factorFailures(doubleAttest.accountId), failuresBeforeDouble,
    'a replayed step 1 counted a failure against the applicant');
  //   Two creations held before they count, at the platform's last daily
  //   slot and at a facility's last open slot. The owner holds the platform's
  //   submit counter row, so both requests pass their quota checks and reach
  //   the creation before either commits; then it is released.
  const environment = getEnvironment();
  const platformCounter = async () => one(`select attempt_count::int as n, bucket_start
    from platform.clinician_application_quota_counters where scope = 'platform' and operation = 'submit'
    order by bucket_start desc limit 1`);
  async function heldAtTheCounter(requests) {
    const holder = await owner.connect();
    try {
      await holder.query('begin');
      await holder.query(`select 1 from platform.clinician_application_quota_counters
        where scope = 'platform' and operation = 'submit' order by bucket_start desc limit 1 for update`);
      const pending = Promise.all(requests.map((send) => send()));
      for (let waited = 0; ; waited += 1) {
        const waiting = await count(`select count(*)::int as n from pg_stat_activity where datname = current_database()
          and backend_type = 'client backend' and wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
        if (waiting >= requests.length) break;
        assert(waited < 800, 'the creations did not both wait before committing');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await holder.query('commit');
      return await pending;
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
  }
  //   The platform's last slot: one sign-up is created, the other is 429 and
  //   creates nothing; the count ends at the cap.
  const platformLimit = environment.CLINICIAN_APPLICATION_SUBMIT_PLATFORM_DAILY_LIMIT;
  const counterBefore = await platformCounter();
  await owner.query(`update platform.clinician_application_quota_counters set attempt_count = $1
    where scope = 'platform' and operation = 'submit' and bucket_start = $2`, [platformLimit - 1, counterBefore.bucket_start]);
  const lastSlot = [];
  for (const [label, facilityId] of [['last-a', ids.x], ['last-b', ids.y]]) {
    const email = `clinician-${label}-${randomUUID().slice(0, 8)}@example.invalid`;
    const network = newNetwork();
    const { cookie } = await draftFor(email, network);
    lastSlot.push({ email, send: () => call('post', '', { cookie, network, headers: { 'Idempotency-Key': key(label) },
      body: { ...details(facilityId, { licenceNumber: `MDCN/R/${label.toUpperCase()}` }), email,
        fullName: `Runtime ${label} Clinician`, password } }) });
  }
  const atTheCap = await heldAtTheCounter(lastSlot.map((entry) => entry.send));
  assert.deepEqual(atTheCap.map((response) => response.status).sort(), [201, 429],
    `two submissions at the platform's last slot: ${JSON.stringify(atTheCap.map((response) => response.body))}`);
  const capRefusal = atTheCap.find((response) => response.status === 429);
  assert.deepEqual([capRefusal.body.code, capRefusal.headers['retry-after']], ['CLINICIAN_APPLICATION_RATE_LIMITED', '86400']);
  assert.equal(await count('select count(*)::int as n from auth.accounts where email = any($1)',
    [lastSlot.map((entry) => entry.email)]), 1, 'the refused submission created an account');
  assert.equal((await platformCounter()).n, platformLimit, 'the platform counted past its daily cap');
  await owner.query(`update platform.clinician_application_quota_counters set attempt_count = $1
    where scope = 'platform' and operation = 'submit' and bucket_start = $2`, [counterBefore.n + 1, counterBefore.bucket_start]);
  //   A facility's last open slot: a sign-up (C8) and an apply-again (C13) to
  //   one facility; the one that counts second sees the first and is 409
  //   CLINICIAN_APPLICATION_FACILITY_BUSY.
  const openLimit = environment.CLINICIAN_APPLICATION_FACILITY_OPEN_LIMIT;
  const crowded = randomUUID();
  await owner.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
    values ($1, $2, 'Crowded Race Facility', $3, 'Africa/Lagos', true, 'verified')`,
  [crowded, ids.org, `CRC-${crowded.slice(0, 6)}`]);
  for (let filled = 1; filled < openLimit; filled += 1) {
    const filler = await account(`filler-${filled}`, { staffOnly: true });
    await owner.query(`insert into identity.clinician_applications (id, account_id, staff_id, facility_id, requested_role,
        regulator_code, issuing_authority, licence_number, licence_valid_until, applicant_full_name, state, submitted_at,
        expires_at, correlation_id, updated_at)
      select gen_random_uuid(), staff.account_id, staff.id, $2, 'doctor', 'MDCN', 'Medical and Dental Council of Nigeria',
        $3, current_date + 400, staff.full_name, 'awaiting_authenticator', now(), now() + interval '30 days',
        'clinician-runtime-filler', now()
      from identity.staff staff where staff.account_id = $1`, [filler.id, crowded, `MDCN/FILL/${filled}`]);
  }
  const crowdedOpen = async () => count(`select count(*)::int as n from identity.clinician_applications
    where facility_id = $1 and state in ('awaiting_authenticator', 'submitted', 'under_review') and expires_at > now()`,
  [crowded]);
  assert.equal(await crowdedOpen(), openLimit - 1);
  const crowdedEmail = `clinician-crowded-${randomUUID().slice(0, 8)}@example.invalid`;
  const crowdedNetwork = newNetwork();
  const crowdedDraft = await draftFor(crowdedEmail, crowdedNetwork);
  const lastOpen = await heldAtTheCounter([
    () => call('post', '', { cookie: crowdedDraft.cookie, network: crowdedNetwork,
      headers: { 'Idempotency-Key': key('crowded') }, body: { ...details(crowded, { licenceNumber: 'MDCN/R/40008' }),
        email: crowdedEmail, fullName: 'Runtime Crowded Clinician', password } }),
    () => call('post', '/current/applications', { cookie: doubleAttest.cookie, network: doubleAttest.network,
      headers: { 'Idempotency-Key': key('crowded-apply') }, body: details(crowded, { licenceNumber: 'MDCN/R/40007' }) })]);
  assert.deepEqual(lastOpen.map((response) => response.status).sort(), [201, 409],
    `a sign-up and an apply-again at a facility's last slot: ${JSON.stringify(lastOpen.map((response) => response.body))}`);
  assert.equal(lastOpen.find((response) => response.status === 409).body.code, 'CLINICIAN_APPLICATION_FACILITY_BUSY');
  assert.equal(await crowdedOpen(), openLimit, 'a facility holds more open applications than its cap');
  //   A draft hashes at most five submissions: six submissions of one draft
  //   (other keys, other networks), held at the draft row so that all pass
  //   the probe together; five hash, the sixth is 401 before hashing, and
  //   one application is created.
  const budgetEmail = `clinician-budget-${randomUUID().slice(0, 8)}@example.invalid`;
  const budgetDraft = await draftFor(budgetEmail, newNetwork());
  const budgetDigest = applications.hmac('session', budgetDraft.cookie.split('=')[1]);
  const hashesBeforeBudget = passwordHashes;
  const draftHolder = await owner.connect();
  let budgeted;
  try {
    await draftHolder.query('begin');
    await draftHolder.query('select 1 from identity.clinician_application_sessions where token_hmac = $1 for update',
      [budgetDigest]);
    const pending = Promise.all([1, 2, 3, 4, 5, 6].map((attempt) => call('post', '', { cookie: budgetDraft.cookie,
      network: newNetwork(), headers: { 'Idempotency-Key': key(`budget-${attempt}`) },
      body: { ...details(ids.y, { licenceNumber: 'MDCN/R/40009' }), email: budgetEmail,
        fullName: 'Runtime Budget Clinician', password } })));
    for (let waited = 0; ; waited += 1) {
      const waiting = await count(`select count(*)::int as n from pg_stat_activity where datname = current_database()
        and backend_type = 'client backend' and wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
      if (waiting >= 6) break;
      assert(waited < 800, 'the six submissions did not all wait at the draft');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await draftHolder.query('commit');
    budgeted = await pending;
  } finally {
    await draftHolder.query('rollback').catch(() => undefined);
    draftHolder.release();
  }
  assert.deepEqual(budgeted.map((response) => response.status).sort(), [201, 401, 401, 401, 401, 401],
    `six submissions of one draft: ${JSON.stringify(budgeted.map((response) => response.body))}`);
  assert(budgeted.filter((response) => response.status === 401)
    .every((response) => response.body.code === 'CLINICIAN_APPLICATION_SESSION_INVALID'));
  assert.equal(passwordHashes - hashesBeforeBudget, 5, 'a draft hashed more than five submissions');
  //   Withdraw against approve: one wins, and the result is consistent.
  const torn = await applicant('torn', ids.x, 'MDCN/R/40006');
  await platform.stepUp(adminA);
  expectStatus(await attest(adminA, torn.applicationId, code(torn)), 201);
  await platform.stepUp(adminB);
  const tornVersion = (await detail(adminB, torn.applicationId)).version;
  const [withdrawRace, approveRace] = await Promise.all([
    call('post', `/${torn.applicationId}/withdraw`, { cookie: torn.cookie, headers: { 'If-Match': `"${tornVersion}"` } }),
    approve(adminB, torn.applicationId, tornVersion)]);
  const tornState = (await one('select state from identity.clinician_applications where id = $1', [torn.applicationId])).state;
  const tornMemberships = await count(`select count(*)::int as n from identity.staff_facility_memberships
    where account_id = $1`, [torn.accountId]);
  if (withdrawRace.status === 200) {
    assert.deepEqual([approveRace.status, tornState, tornMemberships], [409, 'withdrawn', 0]);
  } else {
    assert.deepEqual([withdrawRace.status, approveRace.status, tornState, tornMemberships], [409, 201, 'approved', 1]);
  }
  checks.push('races: a double-clicked submit yields one account and application (201 and 201 replayed); two concurrent starts for one address send one code; two Super Admins approving at once yield one 201 and one 409, beside the applicant\'s sign-in, with no deadlock; a double-submitted step 1 that waits for the applicant\'s account yields one attestation and its replay (201 and 201 replayed), with no failure counted; two sign-ups held before they count at the platform\'s last daily slot yield one 201 and one 429 (nothing created, the count ends at the cap); a sign-up and an apply-again held before they count at a facility\'s last open slot yield one 201 and one 409 CLINICIAN_APPLICATION_FACILITY_BUSY (the facility ends at its cap); six submissions of one draft held together hash the password five times, one is created and five are 401; withdraw against approve leaves either a withdrawn application and no membership or an approved one with its membership');

  // 16. Faults are 503, never 401.
  await owner.query('revoke execute on function identity.current_clinician_applications(character) from hid_identity_runtime');
  try {
    const revoked = await call('get', '/current', { cookie: status });
    expectStatus(revoked, 503, 'CLINICIAN_APPLICATION_UNAVAILABLE');
  } finally {
    await owner.query('grant execute on function identity.current_clinician_applications(character) to hid_identity_runtime');
  }
  expectStatus(await call('get', '/current', { cookie: status }), 200);
  await owner.query(`alter function identity.verify_clinician_application_status_code(uuid, character, character, character)
    rename to verify_clinician_application_status_code_hidden`);
  try {
    const started = await startCode('/status/email-code', fresh, 'clinician-application-status', newNetwork());
    expectStatus(started, 202);
    expectStatus(await call('post', '/status/email-code/verify', { body: { challengeId: started.body.challengeId,
      email: fresh, code: signupCodes.get(started.body.challengeId)?.code ?? '123456' } }), 503,
    'CLINICIAN_APPLICATION_UNAVAILABLE');
  } finally {
    await owner.query(`alter function identity.verify_clinician_application_status_code_hidden(uuid, character, character,
      character) rename to verify_clinician_application_status_code`);
  }
  await owner.query('alter function identity.clinician_signup_open() rename to clinician_signup_open_hidden');
  try {
    expectStatus(await call('get', '/availability', { from: null }), 503, 'PLATFORM_CONTROL_UNAVAILABLE');
  } finally {
    await owner.query('alter function identity.clinician_signup_open_hidden() rename to clinician_signup_open');
  }
  const ended = await call('post', '/session/end', { cookie: status });
  expectStatus(ended, 204);
  expectStatus(await call('get', '/current', { cookie: status }), 401, 'CLINICIAN_APPLICATION_SESSION_INVALID');
  checks.push('a missing EXECUTE grant on the list command is 503 CLINICIAN_APPLICATION_UNAVAILABLE (never 401), as is a missing status-verify function; a missing availability function is 503 PLATFORM_CONTROL_UNAVAILABLE; ending the capability makes it 401');

  process.stdout.write(`${JSON.stringify({ status: 'passed', scope: 'local-synthetic-only', role: runtimeRole,
    siteverifyCalls, checks })}\n`);
} finally {
  await app?.close();
  await owner.end();
  await maintenance.query(`drop database if exists ${isolated} with (force)`);
  await maintenance.end();
}
