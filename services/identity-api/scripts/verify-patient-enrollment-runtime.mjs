#!/usr/bin/env node
// Patient signup-to-sign-in lifecycle over HTTP, as hid_identity_api_runtime,
// on a disposable copy of the owned synthetic rehearsal database: public NIN
// enrollment (QoreID adapter, contact OTP, activation), then password sign-in,
// session, refresh rotation, self profile, OTP password recovery and sign-out.
// External services are replaced, never called: QoreID behind the real adapter
// by a local HTTP stub, Cloudflare Siteverify by a stub that encodes the
// outcome in the token, and Notification delivery by a stub that captures the
// code. Every NIN, name, contact and password here is invented.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
assert(process.env.OTP_HMAC_KEY_B64, 'The rehearsal OTP HMAC key is required');
const isolated = `hid_rehearsal_enrollment_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const origin = 'https://staging.healthidentitydirectory.com';
const siteHost = new URL(origin).hostname;
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'staging',
  NIN_PROVIDER_MODE: 'deferred', CORS_ORIGINS: origin, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'public-synthetic-ehr-workload-token',
  TURNSTILE_MODE: 'required', TURNSTILE_SECRET_KEY: 'example-turnstile-secret',
  QOREID_ENABLED: 'true', QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'true',
  QOREID_CLIENT_ID: 'example-qoreid-client', QOREID_CLIENT_SECRET: 'example-qoreid-secret',
  // Fresh per run, like the deployment's own server-only keys.
  NIN_LOOKUP_HMAC_KEY_B64: randomBytes(32).toString('base64'),
  NIN_ENCRYPTION_KEY_B64: randomBytes(32).toString('base64'),
  CONTACT_LOOKUP_HMAC_KEY_B64: randomBytes(32).toString('base64'),
  DATABASE_URL: `postgresql://${process.env.PGUSER ?? 'postgres'}@localhost/${isolated}?host=${encodeURIComponent(socket)}`
    + `&options=${encodeURIComponent('-c role=hid_identity_api_runtime')}`,
  TRUST_PROXY_CIDRS: '127.0.0.1/32,::1/128' });
delete process.env.AUTH_COOKIE_DOMAIN;
for (const key of ['METAMAP_CLIENT_ID', 'METAMAP_CLIENT_SECRET', 'QOREID_API_KEY']) delete process.env[key];
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
const { OtpController } = load('auth/otp.controller.ts');
const { OtpService } = load('auth/otp.service.ts');
const { PatientSelfController } = load('auth/patient-self.controller.ts');
const { PatientSelfService } = load('auth/patient-self.service.ts');
const { IntegrationRuntimeService } = load('integrations/integration-runtime.service.ts');
const { PatientEnrollmentController } = load('identity/patient-enrollment.controller.ts');
const { PatientEnrollmentService } = load('identity/patient-enrollment.service.ts');
const { PUBLIC_PATIENT_IDENTITY_PROVIDER, QoreIdPublicPatientIdentityProvider } =
  load('identity/patient-enrollment.provider.ts');
const { NinIdentifierProtector } = load('identity/nin-identifier-protector.ts');
const { HidCodeGenerator } = load('identity/hid-code-generator.service.ts');
const { QoreIdVerificationAdapter, QOREID_ADAPTER_CONFIGURATION, QOREID_FETCH } =
  load('identity/qoreid-verification.adapter.ts');
const { DomainProblem, ProblemDetailsFilter } = load('common/problem.ts');
const { getEnvironment } = load('config/environment.ts');

// Cloudflare Siteverify stub: a token is `ok|<action>|<hostname>` or `replayed`.
// Any other outbound request fails the verifier.
const siteverifyUrl = getEnvironment().TURNSTILE_SITEVERIFY_URL;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  assert.equal(url, siteverifyUrl, `Unexpected outbound request to ${url}`);
  const body = JSON.parse(String(init?.body));
  assert.equal(body.secret, 'example-turnstile-secret');
  const [kind, action, hostname] = String(body.response).split('|');
  if (kind !== 'ok') return Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] });
  return Response.json({ success: true, action, hostname });
};
const turnstile = (action, host = siteHost) => `ok|${action}|${host}`;

// QoreID stub behind the real adapter, in the shape of the entitled NIN-only
// sandbox response. NOT_VERIFIED is a negative registry check; every NIN in
// `people` is a complete verified record; any other request fails the run.
const NOT_VERIFIED = '90000000009';
const people = new Map([
  ['90000000001', { firstname: 'Ada', lastname: 'Synthetic', birthdate: '01-02-1990', gender: 'F' }],
  ['90000000002', { firstname: 'Bayo', lastname: 'Synthetic', birthdate: '15-07-1985', gender: 'M' }],
  ['90000000003', { firstname: 'Chidi', lastname: 'Synthetic', birthdate: '30-11-2001', gender: 'M' }],
]);
const ninLookups = [];
const qoreidFetch = async (url, init) => {
  const path = new URL(String(url)).pathname;
  if (path === '/token') {
    return new Response(JSON.stringify({ accessToken: 'synthetic-qoreid-token', expiresIn: 7200,
      tokenType: 'Bearer' }), { status: 200 });
  }
  const match = /^\/v1\/ng\/identities\/nin\/(\d{11})$/.exec(path);
  assert(match, `Unexpected QoreID request to ${path}`);
  assert.equal(init.headers.authorization, 'Bearer synthetic-qoreid-token');
  const nin = match[1];
  ninLookups.push(nin);
  if (nin === NOT_VERIFIED) {
    return new Response(JSON.stringify({ id: 700000 + ninLookups.length, summary: { nin_check: 'not_verified' },
      status: { state: 'complete', status: 'not_verified' }, nin: {} }), { status: 200 });
  }
  const person = people.get(nin);
  assert(person, `QoreID stub has no record for ${nin}`);
  return new Response(JSON.stringify({ id: 700000 + ninLookups.length, summary: { nin_check: 'verified' },
    status: { state: 'complete', status: 'verified' }, nin: { nin, ...person } }), { status: 200 });
};

// Notification stub: captures each code exactly as notification-api would receive it.
const deliveries = [];
const notification = {
  deliver: async (input) => {
    deliveries.push({ purpose: input.purpose, channel: input.channel, recipient: input.recipient,
      challengeId: input.challengeId, code: input.code });
    return { outcome: 'accepted', provider: input.channel === 'sms' ? 'termii' : 'ses' };
  },
};
const lastCode = (purpose, recipient) => {
  const delivery = deliveries.filter(item => item.purpose === purpose && item.recipient === recipient).at(-1);
  assert(delivery, `No ${purpose} code was delivered to the synthetic recipient`);
  return delivery;
};

const maintenance = new Pool({ host: socket, user: process.env.PGUSER, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
// Fixture and assertion connection (database owner), never used by the API.
const owner = new Pool({ host: socket, user: process.env.PGUSER, database: isolated, max: 2 });
let app;
try {
  const module = await Test.createTestingModule({
    controllers: [AuthController, PatientEnrollmentController, PatientSelfController, OtpController],
    providers: [DatabaseService, TokenService, LocalAuthProvider,
      CurrentStaffContextService, CurrentPatientContextService, AuthService, AuthSessionAuditService,
      AuditService, WorkloadAuthService, TurnstileService, IntegrationRuntimeService,
      PatientEnrollmentService, NinIdentifierProtector, HidCodeGenerator, PatientSelfService, OtpService,
      GoogleAuthenticationService, QoreIdVerificationAdapter, QoreIdPublicPatientIdentityProvider,
      { provide: PUBLIC_PATIENT_IDENTITY_PROVIDER, useExisting: QoreIdPublicPatientIdentityProvider },
      { provide: QOREID_ADAPTER_CONFIGURATION, useValue: { baseUrl: 'https://api.qoreid.com',
        clientId: 'example-qoreid-client', clientSecret: 'example-qoreid-secret', timeoutMs: 2000,
        ninOnlyEnrollmentEnabled: true } },
      { provide: QOREID_FETCH, useValue: qoreidFetch },
      { provide: NotificationOtpClient, useValue: notification }] }).compile();
  const runtimeRole = (await module.get(DatabaseService).query('select current_user as role')).rows[0].role;
  assert.equal(runtimeRole, 'hid_identity_api_runtime');
  app = module.createNestApplication({ logger: false });
  app.getHttpAdapter().getInstance().set('trust proxy',
    getEnvironment().TRUST_PROXY_CIDRS.split(',').map(cidr => cidr.trim()));
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
  const cookieName = getEnvironment().AUTH_COOKIE_NAME;
  const pairs = response => (response.headers['set-cookie'] ?? []).map(value => value.split(';')[0]);
  const sessionCookies = response => pairs(response).filter(pair => pair.startsWith(`${cookieName}`)).join('; ');
  const csrf = response => response.headers['x-csrf-token'];
  const expectProblem = (response, status, code) => {
    assert.equal(response.status, status, `${code}: ${response.status} ${JSON.stringify(response.body)}`);
    if (code) assert.equal(response.body.code, code, JSON.stringify(response.body));
  };
  const count = async (sql, values = []) => Number((await owner.query(sql, values)).rows[0].count);
  const enrollmentRows = () => count('select count(*) from identity.public_patient_enrollments');
  const checks = [];
  const check = name => checks.push(name);

  // Enrollment requests from a fixed synthetic network unless a test needs another.
  const post = (path, body, { network = '198.51.100.20', cookie, key, originHeader = origin } = {}) => {
    let call = http.post(`/api/v1${path}`).set('X-Forwarded-For', network);
    if (originHeader) call = call.set('Origin', originHeader);
    if (cookie) call = call.set('Cookie', cookie);
    if (key) call = call.set('Idempotency-Key', key);
    return call.send(body);
  };
  const startBody = (nin, action = 'patient-enrollment') => ({ nin, turnstileAction: 'patient-enrollment',
    turnstileToken: turnstile(action) });
  const enrollmentCookie = response => {
    const value = (response.headers['set-cookie'] ?? []).find(item => item.startsWith('hid_enrollment='));
    assert(value, 'enrollment start must set the hid_enrollment cookie');
    assert.match(value, /; HttpOnly/i); assert.match(value, /; Secure/i); assert.match(value, /; SameSite=Strict/i);
    assert.match(value, /; Path=\/api\/v1\/identity\/patient-enrollments/i);
    assert(!/;\s*Domain=/i.test(value), 'the enrollment cookie must be host-only');
    return value.split(';')[0];
  };

  // 1. Refusals before QoreID is asked or anything is stored.
  const ninA = '90000000001';
  expectProblem(await post('/identity/patient-enrollments', startBody(ninA), { key: randomUUID(), originHeader: null }),
    403, 'ORIGIN_DENIED');
  expectProblem(await post('/identity/patient-enrollments', startBody(ninA), { key: randomUUID(),
    originHeader: 'https://attacker.example' }), 403, 'ORIGIN_DENIED');
  expectProblem(await post('/identity/patient-enrollments', { ...startBody(ninA), turnstileAction: 'patient-login' },
    { key: randomUUID() }), 400, 'VALIDATION_FAILED');
  expectProblem(await post('/identity/patient-enrollments', startBody(ninA, 'patient-login'), { key: randomUUID() }),
    403, 'TURNSTILE_ACTION_MISMATCH');
  expectProblem(await post('/identity/patient-enrollments', { ...startBody(ninA), turnstileToken: 'replayed' },
    { key: randomUUID() }), 403, 'TURNSTILE_EXPIRED_OR_REPLAYED');
  expectProblem(await post('/identity/patient-enrollments', startBody(ninA)), 400, 'IDEMPOTENCY_KEY_INVALID');
  for (const nin of ['1234567890', '123456789012', 'ABCDEFGHIJK']) {
    expectProblem(await post('/identity/patient-enrollments', startBody(nin), { key: randomUUID() }), 400, 'VALIDATION_FAILED');
  }
  assert.equal(ninLookups.length, 0, 'A refused enrollment reached QoreID');
  assert.equal(await enrollmentRows(), 0, 'A refused enrollment was stored');
  check('enrollment start refuses a missing or foreign Origin, a wrong or replayed Turnstile action, a missing Idempotency-Key and a malformed NIN before QoreID or storage');

  // 2. QoreID switched off by the platform (the default) fails closed without a lookup.
  assert.equal((await owner.query("select enabled from platform.integration_providers where provider='qoreid'")).rows[0].enabled, false);
  expectProblem(await post('/identity/patient-enrollments', startBody(ninA), { key: randomUUID() }), 503, 'INTEGRATION_PAUSED');
  assert.equal(ninLookups.length, 0);
  // Fixture: a platform administrator has enabled QoreID (an admin action outside this verifier).
  await owner.query("update platform.integration_providers set enabled=true, row_version=row_version+1 where provider='qoreid'");
  expectProblem(await post('/identity/patient-enrollments', startBody(NOT_VERIFIED), { key: randomUUID(),
    network: '198.51.100.21' }), 422, 'NIN_NOT_VERIFIED');
  assert.deepEqual(ninLookups, [NOT_VERIFIED]);
  assert.equal(await enrollmentRows(), 0, 'An unverified NIN was stored');
  check('enrollment is 503 INTEGRATION_PAUSED while QoreID is disabled and 422 NIN_NOT_VERIFIED for a negative check, storing nothing');

  // 3. Start, replay and duplicates.
  const keyA = randomUUID();
  const startedA = await post('/identity/patient-enrollments', startBody(ninA), { key: keyA });
  expectProblem(startedA, 200);
  assert.equal(startedA.body.stage, 'verify_contact'); assert.equal(startedA.body.googleOnboardingRequired, false);
  assert(Date.parse(startedA.body.expiresAt) > Date.now());
  for (const field of ['nin', 'firstName', 'lastName', 'dateOfBirth', 'patientId', 'hidCode']) {
    assert(!(field in startedA.body), `enrollment start must not return ${field}`);
  }
  const cookieA = enrollmentCookie(startedA);
  assert.equal(ninLookups.filter(nin => nin === ninA).length, 1);
  const replayA = await post('/identity/patient-enrollments', startBody(ninA), { key: keyA });
  expectProblem(replayA, 200);
  assert.equal(replayA.body.stage, 'verify_contact'); assert.equal(enrollmentCookie(replayA), cookieA);
  expectProblem(await post('/identity/patient-enrollments', startBody(ninA), { key: randomUUID() }), 409, 'NIN_ALREADY_REGISTERED');
  expectProblem(await post('/identity/patient-enrollments', startBody('90000000002'), { key: keyA }), 409, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(ninLookups.filter(nin => nin === ninA).length, 1, 'A replay or duplicate asked QoreID again');
  assert.equal(await enrollmentRows(), 1);
  const stored = (await owner.query(`select nin_last4, length(nin_ciphertext) as cipher_length, state
    from identity.public_patient_enrollments`)).rows[0];
  assert.deepEqual([stored.nin_last4, stored.state], [ninA.slice(-4), 'verify_contact']);
  assert(stored.cipher_length > 11, 'the NIN must be stored encrypted');
  assert.equal(await count(`select count(*) from identity.public_patient_enrollments
    where position(convert_to($1, 'UTF8') in nin_ciphertext) > 0
       or position(convert_to($1, 'UTF8') in profile_ciphertext) > 0`, [ninA]), 0, 'the NIN is stored in clear');
  const current = await http.get('/api/v1/identity/patient-enrollments/current').set('Cookie', cookieA);
  expectProblem(current, 200); assert.equal(current.body.stage, 'verify_contact');
  expectProblem(await http.get('/api/v1/identity/patient-enrollments/current'), 404, 'ENROLLMENT_NOT_FOUND');
  expectProblem(await http.get('/api/v1/identity/patient-enrollments/current')
    .set('Cookie', cookieA.replace(/.$/, c => (c === 'A' ? 'B' : 'A'))), 404, 'ENROLLMENT_NOT_FOUND');
  check('enrollment start verifies the NIN once, stores it encrypted, returns only the stage and a host-only HttpOnly Strict cookie; a same-key replay asks QoreID nothing; another key for the same NIN is 409 NIN_ALREADY_REGISTERED; the same key for another NIN is 409 IDEMPOTENCY_KEY_REUSED; a forged cookie is 404');

  // 4. Contact verification.
  const emailA = `patient-a-${randomUUID().slice(0, 8)}@example.invalid`;
  expectProblem(await post('/identity/patient-enrollments/contact', { channel: 'email', contact: 'not-an-email' },
    { cookie: cookieA }), 400, 'ENROLLMENT_CONTACT_INVALID');
  const contactA = await post('/identity/patient-enrollments/contact',
    { channel: 'email', contact: `  ${emailA.toUpperCase()} ` }, { cookie: cookieA });
  expectProblem(contactA, 200);
  assert(contactA.body.challengeId && contactA.body.expiresInSeconds > 0 && contactA.body.resendAfterSeconds > 0);
  const deliveredA = lastCode('SIGNUP_VERIFY', emailA);
  assert.equal(deliveredA.channel, 'email'); assert.equal(deliveredA.challengeId, contactA.body.challengeId);
  expectProblem(await post('/identity/patient-enrollments/contact', { channel: 'email', contact: emailA },
    { cookie: cookieA }), 429, 'OTP_RESEND_COOLDOWN');
  const progress = await http.get('/api/v1/identity/patient-enrollments/current').set('Cookie', cookieA);
  assert.equal(progress.body.challengeId, contactA.body.challengeId);
  assert.match(progress.body.maskedContact, /^p•••@example\.invalid$/);
  const wrong = deliveredA.code === '000000' ? '000001' : '000000';
  expectProblem(await post('/identity/patient-enrollments/contact/verify',
    { challengeId: contactA.body.challengeId, code: wrong }, { cookie: cookieA }), 422, 'OTP_INVALID');
  expectProblem(await post('/identity/patient-enrollments/activate', { password: 'Synthetic-Patient-Pass-01' },
    { cookie: cookieA }), 409, 'ENROLLMENT_STAGE_INVALID');
  const verifiedA = await post('/identity/patient-enrollments/contact/verify',
    { challengeId: contactA.body.challengeId, code: deliveredA.code }, { cookie: cookieA });
  expectProblem(verifiedA, 200); assert.equal(verifiedA.body.stage, 'set_password');
  expectProblem(await post('/identity/patient-enrollments/contact/verify',
    { challengeId: contactA.body.challengeId, code: deliveredA.code }, { cookie: cookieA }), 422, 'OTP_INVALID');
  check('contact verification normalizes the email, delivers one SIGNUP_VERIFY code, enforces the resend cooldown, masks the contact, refuses a wrong code and activation before verification, and accepts the code once');

  // 5. Activation creates exactly one account, patient and HID; a replay returns the same HID.
  const passwordA = 'Synthetic-Patient-Pass-01';
  expectProblem(await post('/identity/patient-enrollments/activate', { password: 'short' }, { cookie: cookieA }),
    400, 'VALIDATION_FAILED');
  const activatedA = await post('/identity/patient-enrollments/activate', { password: passwordA }, { cookie: cookieA });
  expectProblem(activatedA, 200);
  assert.equal(activatedA.body.stage, 'active'); assert.match(activatedA.body.hidCode, /^HID-[A-HJ-NP-Z2-9]{6,32}$/);
  const hidA = activatedA.body.hidCode;
  const replayActivation = await post('/identity/patient-enrollments/activate',
    { password: 'A-Different-Password-02' }, { cookie: cookieA });
  expectProblem(replayActivation, 200); assert.equal(replayActivation.body.hidCode, hidA);
  const accountA = (await owner.query(`select account.id, account.status, account.email,
      account.email_verified_at is not null as email_verified, patient.id as patient_id, patient.hid_code,
      patient.first_name, patient.last_name, patient.dob::text as dob, patient.source_system
    from auth.accounts account join identity.patients patient on patient.account_id = account.id
    where account.email = $1`, [emailA])).rows;
  assert.equal(accountA.length, 1, 'activation must create exactly one account and patient');
  assert.deepEqual({ ...accountA[0], id: undefined, patient_id: undefined }, { id: undefined, patient_id: undefined,
    status: 'active', email: emailA, email_verified: true, hid_code: hidA, first_name: 'Ada', last_name: 'Synthetic',
    dob: '1990-02-01', source_system: 'hid-public-qoreid-enrollment' });
  const patientA = accountA[0].patient_id;
  assert.equal(await count(`select count(*) from identity.patients where hid_code = $1`, [hidA]), 1);
  assert.equal((await owner.query('select state, patient_id from identity.public_patient_enrollments')).rows[0].patient_id, patientA);
  check('activation creates one active account (verified email) and one patient with the QoreID name and date of birth and a new HID; a replay returns the same HID and ignores the second password');

  // 6. The same identity or contact cannot enroll twice.
  expectProblem(await post('/identity/patient-enrollments', startBody(ninA), { key: randomUUID(),
    network: '198.51.100.22' }), 409, 'NIN_ALREADY_REGISTERED');
  const keyB = randomUUID();
  const startedB = await post('/identity/patient-enrollments', startBody('90000000002'),
    { key: keyB, network: '198.51.100.23' });
  expectProblem(startedB, 200);
  const cookieB = enrollmentCookie(startedB);
  expectProblem(await post('/identity/patient-enrollments/contact', { channel: 'email', contact: emailA },
    { cookie: cookieB, network: '198.51.100.23' }), 409, 'CONTACT_ALREADY_REGISTERED');
  check('an enrolled NIN is 409 NIN_ALREADY_REGISTERED and an enrolled email is 409 CONTACT_ALREADY_REGISTERED for another enrollment');

  // 7. A phone-only patient: the HID is the sign-in identifier.
  const phoneB = '08030000002';
  const contactB = await post('/identity/patient-enrollments/contact', { channel: 'phone', contact: phoneB },
    { cookie: cookieB, network: '198.51.100.23' });
  expectProblem(contactB, 200);
  const deliveredB = lastCode('SIGNUP_VERIFY', '+2348030000002');
  assert.equal(deliveredB.channel, 'sms');
  expectProblem(await post('/identity/patient-enrollments/contact/verify',
    { challengeId: contactB.body.challengeId, code: deliveredB.code }, { cookie: cookieB }), 200);
  const activatedB = await post('/identity/patient-enrollments/activate', { password: 'Synthetic-Patient-Pass-B2' },
    { cookie: cookieB });
  expectProblem(activatedB, 200);
  const hidB = activatedB.body.hidCode;
  assert.notEqual(hidB, hidA);
  const accountB = (await owner.query(`select account.email, patient.id as patient_id from auth.accounts account
    join identity.patients patient on patient.account_id = account.id where patient.hid_code = $1`, [hidB])).rows;
  assert.equal(accountB.length, 1); assert.equal(accountB[0].email, null);
  check('a phone-only enrollment normalizes 0803... to +234..., delivers by SMS and activates an account without an email and with its own HID');

  // 8. Sign-in: identical refusal for a wrong password and an unknown account.
  const login = (identifier, password, action = 'patient-login') => http.post('/api/v1/auth/patient/login')
    .set('Origin', origin).set('X-Forwarded-For', '198.51.100.30')
    .send({ email: identifier, password, turnstileAction: 'patient-login', turnstileToken: turnstile(action) });
  const wrongPassword = await login(emailA, 'Wrong-Password-000000');
  const unknownAccount = await login(`unknown-${randomUUID().slice(0, 8)}@example.invalid`, 'Wrong-Password-000000');
  expectProblem(wrongPassword, 401); expectProblem(unknownAccount, 401);
  assert.deepEqual({ ...wrongPassword.body, instance: undefined, correlationId: undefined },
    { ...unknownAccount.body, instance: undefined, correlationId: undefined },
    'A wrong password and an unknown account must be indistinguishable');
  expectProblem(await login(emailA, passwordA, 'staff-login'), 403, 'TURNSTILE_ACTION_MISMATCH');
  const firstA = await login(emailA.toUpperCase(), passwordA);
  expectProblem(firstA, 200);
  assert.equal(firstA.body.actor.kind, 'patient'); assert.equal(firstA.body.actor.patientId, patientA);
  for (const property of ['roles', 'permissions', 'platformRoles', 'platformPermissions', 'facilities', 'facilityIds']) {
    assert.deepEqual(firstA.body.actor[property], []);
  }
  assert(!firstA.body.accessToken && !firstA.body.refreshToken, 'tokens must not be serialized into browser JSON');
  for (const value of firstA.headers['set-cookie']) {
    assert(!/;\s*Domain=/i.test(value)); assert.match(value, /; Secure/i); assert.match(value, /; SameSite=Strict/i);
    if (!value.startsWith(`${cookieName}_csrf=`)) assert.match(value, /; HttpOnly/i);
  }
  const byHid = await login(hidA.toLowerCase(), passwordA);
  expectProblem(byHid, 200); assert.equal(byHid.body.actor.patientId, patientA);
  const firstB = await login(hidB, 'Synthetic-Patient-Pass-B2');
  expectProblem(firstB, 200); assert.equal(firstB.body.actor.patientId, accountB[0].patient_id);
  check('sign-in refuses a wrong password and an unknown account identically (401), refuses another Turnstile action, and signs the patient in by email (any case) or HID with host-only Secure Strict cookies and no workforce authority');

  // 9. Session, self profile and isolation between the two new patients.
  const cookieSessionA = sessionCookies(firstA);
  expectProblem(await http.get('/api/v1/auth/session').set('Cookie', cookieSessionA), 200);
  const profileA = await http.get('/api/v1/identity/me').set('Cookie', cookieSessionA);
  expectProblem(profileA, 200);
  assert.equal(profileA.body.patientId, patientA); assert.equal(profileA.body.hid, hidA);
  assert(!('nin' in profileA.body) && !('accountId' in profileA.body));
  const profileB = await http.get('/api/v1/identity/me').set('Cookie', sessionCookies(firstB));
  expectProblem(profileB, 200); assert.equal(profileB.body.patientId, accountB[0].patient_id);
  assert.notEqual(profileB.body.hid, hidA);
  for (const [response, patient] of [[firstA, patientA], [firstB, accountB[0].patient_id]]) {
    const authorized = await http.get('/api/v1/identity/service/patient-self-authorization')
      .set('Cookie', sessionCookies(response)).set('x-hid-internal-caller', 'ehr-api')
      .set('x-hid-service-token', process.env.IDENTITY_EHR_INTERNAL_SERVICE_TOKEN);
    expectProblem(authorized, 200); assert.equal(authorized.body.patientId, patient);
  }
  expectProblem(await http.get('/api/v1/identity/me'), 401, 'AUTHENTICATION_REQUIRED');
  check('each new patient\'s session reads only its own profile and HID (no NIN, no account id), and the EHR self-authorization names only that session\'s patient');

  // 10. Refresh rotation keeps the patient signed in; the old session ends.
  const refreshedA = await http.post('/api/v1/auth/refresh').set('Cookie', cookieSessionA).set('Origin', origin)
    .set('x-csrf-token', csrf(firstA));
  expectProblem(refreshedA, 200);
  assert.equal(refreshedA.body.actor.patientId, patientA);
  assert.notEqual(refreshedA.body.actor.sessionId, firstA.body.actor.sessionId);
  expectProblem(await http.get('/api/v1/identity/me').set('Cookie', sessionCookies(refreshedA)), 200);
  expectProblem(await http.get('/api/v1/auth/session').set('Cookie', cookieSessionA), 401);
  check('refresh with the CSRF token rotates the session for the same patient; the previous session is refused');

  // 11. OTP password recovery: no account disclosure, single-use code, old password and sessions end.
  const resetStart = (identifier, network = '198.51.100.40') => http.post('/api/v1/auth/otp/start')
    .set('Origin', origin).set('X-Forwarded-For', network)
    .send({ identifier, purpose: 'PASSWORD_RESET', turnstileAction: 'patient-reset-start',
      turnstileToken: turnstile('patient-reset-start') });
  const knownStart = await resetStart(emailA);
  const unknownStart = await resetStart(`nobody-${randomUUID().slice(0, 8)}@example.invalid`, '198.51.100.41');
  expectProblem(knownStart, 202); expectProblem(unknownStart, 202);
  assert.deepEqual(Object.keys(knownStart.body).sort(), Object.keys(unknownStart.body).sort(),
    'recovery must answer an unknown account in the same shape');
  const resetCode = lastCode('PASSWORD_RESET', emailA);
  assert.equal(resetCode.challengeId, knownStart.body.challengeId);
  const verified = await http.post('/api/v1/auth/otp/verify').set('Origin', origin)
    .send({ challengeId: resetCode.challengeId, purpose: 'PASSWORD_RESET', code: resetCode.code });
  expectProblem(verified, 200);
  assert(verified.body.verificationToken);
  const newPassword = 'Synthetic-Recovered-Pass-03';
  expectProblem(await http.post('/api/v1/auth/otp/complete').set('Origin', origin)
    .send({ challengeId: resetCode.challengeId, purpose: 'PASSWORD_RESET',
      verificationToken: verified.body.verificationToken, newPassword }), 200);
  expectProblem(await http.post('/api/v1/auth/otp/complete').set('Origin', origin)
    .send({ challengeId: resetCode.challengeId, purpose: 'PASSWORD_RESET',
      verificationToken: verified.body.verificationToken, newPassword: 'Another-Recovered-Pass-04' }),
  403, 'OTP_INVALID_OR_EXPIRED');
  expectProblem(await http.get('/api/v1/identity/me').set('Cookie', sessionCookies(refreshedA)), 401);
  expectProblem(await login(emailA, passwordA), 401);
  const recoveredA = await login(emailA, newPassword);
  expectProblem(recoveredA, 200); assert.equal(recoveredA.body.actor.patientId, patientA);
  check('password recovery answers known and unknown accounts alike, uses a single-use code, ends existing sessions and replaces the password');

  // 12. Sign-out needs the CSRF token and ends only its own sign-in: the same
  // patient's other sign-in (another device) and the other patient stay signed in.
  const otherDeviceA = await login(emailA, newPassword);
  expectProblem(otherDeviceA, 200); assert.equal(otherDeviceA.body.actor.patientId, patientA);
  expectProblem(await http.post('/api/v1/auth/logout').set('Cookie', sessionCookies(recoveredA)).set('Origin', origin), 403);
  expectProblem(await http.get('/api/v1/auth/session').set('Cookie', sessionCookies(recoveredA)), 200);
  expectProblem(await http.post('/api/v1/auth/logout').set('Cookie', sessionCookies(recoveredA)).set('Origin', origin)
    .set('x-csrf-token', csrf(recoveredA)), 204);
  expectProblem(await http.get('/api/v1/auth/session').set('Cookie', sessionCookies(recoveredA)), 401);
  expectProblem(await http.get('/api/v1/identity/me').set('Cookie', sessionCookies(otherDeviceA)), 200);
  expectProblem(await http.get('/api/v1/identity/me').set('Cookie', sessionCookies(firstB)), 200);
  check('sign-out without the CSRF token is refused and ends nothing; with it, it ends only that sign-in: the same patient\'s other sign-in and the other patient stay signed in');

  // 13. Durable evidence. Every successful start (A, its replay, B) and
  // activation (A, its replay, B) is audited as a success, refusals as
  // failures, and the database records each new patient's activation once.
  const audited = (action, outcome) => count(`select count(*) from audit.events
    where action = $1 and outcome = $2 and ($2 <> 'success' or details->>'status' = '200')`, [action, outcome]);
  for (const action of ['api.identity.patient-enrollment.start', 'api.identity.patient-enrollment.activate']) {
    assert.equal(await audited(action, 'success'), 3, `${action}: every successful call is audited`);
    assert(await audited(action, 'failure') >= 1, `${action}: refusals are audited`);
  }
  assert.equal(await count(`select count(*) from audit.events
    where action = 'identity.public-patient-enrollment.activated' and outcome = 'success'`), 2);
  const auditText = (await owner.query(`select coalesce(string_agg(details::text, ' '), '') as text from audit.events`)).rows[0].text;
  for (const secret of [ninA, '90000000002', passwordA, newPassword, deliveredA.code]) {
    assert(!auditText.includes(secret), 'audit details must not contain a NIN, password or code');
  }
  assert.equal(await count('select count(*) from identity.patients where source_system = $1',
    ['hid-public-qoreid-enrollment']), 2);
  check('every successful enrollment start and activation is audited as a success (three each, replays included) and refusals as failures, each new patient\'s activation is recorded once, and no audit detail contains a NIN, password or code');

  process.stdout.write(JSON.stringify({ status: 'passed', scope: 'local-synthetic-only', role: runtimeRole,
    qoreid: 'local stub behind the real adapter; no QoreID call', turnstile: 'local Siteverify stub',
    notification: 'local stub; no delivery', nin_lookups: ninLookups.length, deliveries: deliveries.length,
    checks }) + '\n');
} finally {
  await app?.close();
  // owner.end() resolves before its connections finish closing, so the forced
  // drop below can terminate one of them (57P01) once the checks are over.
  owner.on('error', (error) => { if (error.code !== '57P01') throw error; });
  await owner.end();
  await maintenance.query(`drop database if exists ${isolated} with (force)`);
  await maintenance.end();
}
