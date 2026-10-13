#!/usr/bin/env node
// Patient signup-to-sign-in lifecycle over HTTP, as hid_identity_api_runtime,
// on a disposable copy of the owned synthetic rehearsal database: public NIN
// enrollment (QoreID adapter, contact OTP, activation and its replay budget),
// then password sign-in, session, refresh rotation, self profile, OTP password
// recovery and sign-out, each of which expires the enrollment cookie; then the
// enrollment gate before any registration lookup, the 15-minute HID re-display
// window, the 30-minute contact proof and the QoreID lookup quota (0085); and
// the public availability read, from the same gate, with the
// registration-not-open answer start gives while it is closed (FE-4).
// External services are replaced, never called: QoreID behind the real adapter
// by a local HTTP stub, Cloudflare Siteverify by a stub that encodes the
// outcome in the token, and Notification delivery by a stub that captures the
// code. Every NIN, name, contact and password here is invented.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
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
const { preventResponseCaching } = load('common/response-security.middleware.ts');
const { getEnvironment, resetEnvironmentForTests } = load('config/environment.ts');

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
  // main.ts's no-store default, which the availability read relaxes (FE-4).
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
  // A response that carries the HID expires the enrollment cookie on its path.
  const expiresEnrollmentCookie = (response, label) => {
    const expired = (response.headers['set-cookie'] ?? []).filter(item => item.startsWith('hid_enrollment='));
    assert.equal(expired.length, 1, `${label} must expire the hid_enrollment cookie: ${response.headers['set-cookie']}`);
    assert.match(expired[0], /^hid_enrollment=;/);
    assert.match(expired[0], /; Expires=Thu, 01 Jan 1970 00:00:00 GMT/i);
    assert.match(expired[0], /; Path=\/api\/v1\/identity\/patient-enrollments(;|$)/i);
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
  expiresEnrollmentCookie(activatedA, 'the first activation');
  const replayActivation = await post('/identity/patient-enrollments/activate',
    { password: 'A-Different-Password-02' }, { cookie: cookieA });
  expectProblem(replayActivation, 200); assert.equal(replayActivation.body.hidCode, hidA);
  expiresEnrollmentCookie(replayActivation, 'an activation replay');
  // Activations and replays share one budget per enrollment: every attempt
  // after the cookie and stage checks counts, whatever its outcome, up to
  // OTP_RATE_MAX_REQUESTS * 3 per window (the contact step's enrollment
  // budget). Then 429, without another argon2id run or activation command.
  const activationBudget = getEnvironment().OTP_RATE_MAX_REQUESTS * 3;
  for (let call = 3; call <= activationBudget; call += 1) {
    const withinBudget = await post('/identity/patient-enrollments/activate',
      { password: `A-Different-Password-0${call}` }, { cookie: cookieA });
    assert.equal(withinBudget.status, 200,
      `Activation ${call} of one enrollment is within OTP_RATE_MAX_REQUESTS * 3 and must replay the HID, got ${withinBudget.status} ${JSON.stringify(withinBudget.body)}`);
    assert.equal(withinBudget.body.hidCode, hidA);
  }
  const overBudget = await post('/identity/patient-enrollments/activate',
    { password: 'A-Different-Password-99' }, { cookie: cookieA });
  assert.equal(overBudget.status, 429,
    `Activation ${activationBudget + 1} of one enrollment must be refused 429 ENROLLMENT_RATE_LIMITED, got ${overBudget.status} ${JSON.stringify(overBudget.body)}`);
  expectProblem(overBudget, 429, 'ENROLLMENT_RATE_LIMITED');
  assert(!('hidCode' in overBudget.body), 'a refused activation must not return the HID');
  assert.equal(await count(`select count(*) from identity.public_patient_enrollment_rates
    where scope = 'enrollment' and request_count = $1`, [activationBudget + 1]), 1,
  'the activation budget is one enrollment-scope bucket that counted every activation');
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
  check('activation creates one active account (verified email) and one patient with the QoreID name and date of birth and a new HID, and its response expires the enrollment cookie; a replay returns the same HID, ignores the second password and expires the cookie too; activation attempts of one enrollment beyond OTP_RATE_MAX_REQUESTS * 3 per window are 429 ENROLLMENT_RATE_LIMITED without the HID');

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
  // Signing in on the device that enrolled expires its enrollment cookie, on
  // the path it was set on: the HID is read from the session from now on.
  const retiresEnrollment = (response, label) => {
    const enrollment = (response.headers['set-cookie'] ?? []).filter(value => value.startsWith('hid_enrollment='));
    assert.equal(enrollment.length, 1, `${label} must expire the hid_enrollment cookie: ${response.headers['set-cookie']}`);
    assert.match(enrollment[0], /^hid_enrollment=;/);
    assert.match(enrollment[0], /; Expires=Thu, 01 Jan 1970 00:00:00 GMT/i);
    assert.match(enrollment[0], /; Path=\/api\/v1\/identity\/patient-enrollments(;|$)/i);
  };
  retiresEnrollment(firstA, 'patient sign-in');
  const byHid = await login(hidA.toLowerCase(), passwordA);
  expectProblem(byHid, 200); assert.equal(byHid.body.actor.patientId, patientA);
  const firstB = await login(hidB, 'Synthetic-Patient-Pass-B2');
  expectProblem(firstB, 200); assert.equal(firstB.body.actor.patientId, accountB[0].patient_id);
  check('sign-in refuses a wrong password and an unknown account identically (401), refuses another Turnstile action, and signs the patient in by email (any case) or HID with host-only Secure Strict cookies and no workforce authority, expiring the enrollment cookie on its path');

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
  retiresEnrollment(refreshedA, 'refresh');
  assert.equal(refreshedA.body.actor.patientId, patientA);
  assert.notEqual(refreshedA.body.actor.sessionId, firstA.body.actor.sessionId);
  expectProblem(await http.get('/api/v1/identity/me').set('Cookie', sessionCookies(refreshedA)), 200);
  expectProblem(await http.get('/api/v1/auth/session').set('Cookie', cookieSessionA), 401);
  check('refresh with the CSRF token rotates the session for the same patient and expires the enrollment cookie; the previous session is refused');

  // 11. OTP password recovery: no account disclosure, single-use code, old password and sessions end.
  const resetStart = (identifier, network = '198.51.100.40') => http.post('/api/v1/auth/otp/start')
    .set('Origin', origin).set('X-Forwarded-For', network)
    .send({ identifier, purpose: 'PASSWORD_RESET', turnstileAction: 'patient-reset-start',
      turnstileToken: turnstile('patient-reset-start') });
  const knownStart = await resetStart(emailA);
  const unknownIdentifier = `nobody-${randomUUID().slice(0, 8)}@example.invalid`;
  const unknownStart = await resetStart(unknownIdentifier, '198.51.100.41');
  expectProblem(knownStart, 202); expectProblem(unknownStart, 202);
  assert.deepEqual(Object.keys(knownStart.body).sort(), Object.keys(unknownStart.body).sort(),
    'recovery must answer an unknown account in the same shape');
  // Within the resend cooldown a repeat answers the same challengeId whether or
  // not the account exists, from another network too, and sends nothing; the
  // account's other identifier (its HID) gets an id of its own and no code.
  const resetCodes = () => deliveries.filter(item => item.purpose === 'PASSWORD_RESET').length;
  const resetCodesSent = resetCodes();
  const unknownRepeat = await resetStart(unknownIdentifier, '198.51.100.42');
  const knownRepeat = await resetStart(emailA.toUpperCase(), '198.51.100.43');
  const otherIdentifier = await resetStart(hidA.toLowerCase(), '198.51.100.44');
  for (const response of [unknownRepeat, knownRepeat, otherIdentifier]) {
    expectProblem(response, 202);
    assert.deepEqual(Object.keys(response.body).sort(), Object.keys(knownStart.body).sort());
  }
  assert.equal(unknownRepeat.body.challengeId, unknownStart.body.challengeId,
    'A repeated recovery start for an unknown identifier must answer the same challengeId within the cooldown');
  assert.equal(knownRepeat.body.challengeId, knownStart.body.challengeId,
    'A repeated recovery start for a known identifier must answer the same challengeId within the cooldown');
  assert.notEqual(otherIdentifier.body.challengeId, knownStart.body.challengeId,
    'Another identifier of an account in its cooldown must not be answered with the live challengeId');
  assert.equal(resetCodes(), resetCodesSent, 'A recovery start inside the cooldown must send no code');
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
  check('password recovery answers known and unknown accounts alike, including a repeat within the cooldown (the same challengeId for both, no code sent) and the account\'s other identifier (a new id, no code), uses a single-use code, ends existing sessions and replaces the password');

  // 11b. REC-AUDIENCE (0086): the staff and administrator recovery pages reach
  // no patient account. They answer the patient's email like an unknown
  // identifier and send it no code. As the owner, end the patient page's
  // cooldown first, so that only the page (not the cooldown) withholds a code.
  await owner.query("update auth.otp_start_cooldowns set started_at = started_at - interval '2 minutes'");
  const codesBeforeOtherPages = resetCodes();
  for (const [action, network] of [['staff-reset', '198.51.100.47'], ['admin-reset', '198.51.100.48']]) {
    const otherPage = await http.post('/api/v1/auth/otp/start').set('Origin', origin).set('X-Forwarded-For', network)
      .send({ identifier: emailA, purpose: 'PASSWORD_RESET', turnstileAction: action, turnstileToken: turnstile(action) });
    expectProblem(otherPage, 202);
    assert.deepEqual({ ...otherPage.body, challengeId: typeof otherPage.body.challengeId },
      { ...unknownStart.body, challengeId: typeof unknownStart.body.challengeId },
      `${action} must answer a patient account exactly like an unknown identifier`);
  }
  assert.equal(resetCodes(), codesBeforeOtherPages, 'A staff or administrator recovery page must send a patient no code');
  check('the staff and administrator recovery pages answer a patient\'s email like an unknown identifier (202, same body) and send it no code');

  // 12. Sign-out needs the CSRF token and ends only its own sign-in: the same
  // patient's other sign-in (another device) and the other patient stay signed in.
  const otherDeviceA = await login(emailA, newPassword);
  expectProblem(otherDeviceA, 200); assert.equal(otherDeviceA.body.actor.patientId, patientA);
  expectProblem(await http.post('/api/v1/auth/logout').set('Cookie', sessionCookies(recoveredA)).set('Origin', origin), 403);
  expectProblem(await http.get('/api/v1/auth/session').set('Cookie', sessionCookies(recoveredA)), 200);
  const signedOutA = await http.post('/api/v1/auth/logout').set('Cookie', sessionCookies(recoveredA)).set('Origin', origin)
    .set('x-csrf-token', csrf(recoveredA));
  expectProblem(signedOutA, 204);
  retiresEnrollment(signedOutA, 'sign-out');
  expectProblem(await http.get('/api/v1/auth/session').set('Cookie', sessionCookies(recoveredA)), 401);
  expectProblem(await http.get('/api/v1/identity/me').set('Cookie', sessionCookies(otherDeviceA)), 200);
  expectProblem(await http.get('/api/v1/identity/me').set('Cookie', sessionCookies(firstB)), 200);
  check('sign-out without the CSRF token is refused and ends nothing; with it, it ends only that sign-in and expires the enrollment cookie: the same patient\'s other sign-in and the other patient stay signed in');

  // 12b. SIGNIN-LOCKOUT (0086): one failure budget per account across its
  // identifiers. Five wrong passwords, three by email and two by HID (neither
  // identifier reaches five), lock the account: the correct password is then
  // refused by either identifier with the same 401 until the window ends, and
  // accepted after it.
  const wrongLockout = [];
  for (const identifier of [emailA, emailA.toUpperCase(), emailA, hidA, hidA.toLowerCase()]) {
    const response = await login(identifier, 'Wrong-Lockout-Password-0');
    expectProblem(response, 401); wrongLockout.push(response);
  }
  assert.equal(await count('select count(*) from auth.login_attempts where locked_until > clock_timestamp()'), 1,
    'five wrong passwords across the email and the HID must lock exactly one bucket: the account\'s');
  const genericRefusal = response => ({ ...response.body, instance: undefined, correlationId: undefined });
  for (const identifier of [emailA, hidA]) {
    const refused = await login(identifier, newPassword);
    expectProblem(refused, 401);
    assert.deepEqual(genericRefusal(refused), genericRefusal(wrongLockout[0]),
      'the correct password of a locked account must get the generic 401');
  }
  // As the owner, move every failure window 16 minutes into the past: the lock ends.
  await owner.query(`update auth.login_attempts set window_started_at = window_started_at - interval '16 minutes',
    last_failed_at = last_failed_at - interval '16 minutes',
    locked_until = locked_until - interval '16 minutes'`);
  const afterLockout = await login(emailA, newPassword);
  expectProblem(afterLockout, 200); assert.equal(afterLockout.body.actor.patientId, patientA);
  check('five wrong passwords across the email and the HID lock the account: the correct password is refused by either identifier with the same 401 inside the window and accepted after it');

  // 13. Durable evidence. Every successful start (A, its replay, B) and
  // activation (A and its replays within the budget, B) is audited as a
  // success, refusals as failures, and the database records each new
  // patient's activation once.
  const audited = (action, outcome) => count(`select count(*) from audit.events
    where action = $1 and outcome = $2 and ($2 <> 'success' or details->>'status' = '200')`, [action, outcome]);
  for (const [action, successes] of [['api.identity.patient-enrollment.start', 3],
    ['api.identity.patient-enrollment.activate', activationBudget + 1]]) {
    assert.equal(await audited(action, 'success'), successes, `${action}: every successful call is audited`);
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
  check('every successful enrollment start (three) and activation (one per patient and each replay within the budget) is audited as a success and refusals as failures, each new patient\'s activation is recorded once, and no audit detail contains a NIN, password or code');

  // 14. One contact-code failure budget per recipient, across its challenges
  // and whatever network each guess comes from (in production every client
  // address is the load balancer's). With the default budget the fifth wrong
  // code within 15 minutes refuses every code for that recipient, the correct
  // one too, and the contact step sends it none, for 15 minutes.
  const networkC = '198.51.100.50';
  const startedC = await post('/identity/patient-enrollments', startBody('90000000003'),
    { key: randomUUID(), network: networkC });
  expectProblem(startedC, 200);
  const cookieC = enrollmentCookie(startedC);
  const emailC = `patient-c-${randomUUID().slice(0, 8)}@example.invalid`;
  const contactC = () => post('/identity/patient-enrollments/contact', { channel: 'email', contact: emailC },
    { cookie: cookieC, network: networkC });
  const verifyC = (challengeId, code, network) => post('/identity/patient-enrollments/contact/verify',
    { challengeId, code }, { cookie: cookieC, network });
  // Fixture, as the owner: ends a challenge's resend cooldown (not under test here); its expiry is unchanged.
  const endCooldown = async challengeId => assert.equal((await owner.query(`update identity.public_patient_enrollment_otps
    set created_at = created_at - interval '2 minutes' where id = $1`, [challengeId])).rowCount, 1);
  const otherCode = code => (code === '000000' ? '000001' : '000000');
  const rateRowsBefore = await count('select count(*) from auth.otp_rate_limits');
  const firstC = await contactC();
  expectProblem(firstC, 200);
  const firstCodeC = lastCode('SIGNUP_VERIFY', emailC);
  assert.equal(firstCodeC.challengeId, firstC.body.challengeId);
  for (const host of [51, 52, 53]) {
    expectProblem(await verifyC(firstC.body.challengeId, otherCode(firstCodeC.code), `198.51.100.${host}`),
      422, 'OTP_INVALID');
  }
  await endCooldown(firstC.body.challengeId);
  const secondC = await contactC();
  expectProblem(secondC, 200);
  const secondCodeC = lastCode('SIGNUP_VERIFY', emailC);
  assert.equal(secondCodeC.challengeId, secondC.body.challengeId);
  for (const host of [54, 55]) {
    expectProblem(await verifyC(secondC.body.challengeId, otherCode(secondCodeC.code), `198.51.100.${host}`),
      422, 'OTP_INVALID');
  }
  const refusedCorrect = await verifyC(secondC.body.challengeId, secondCodeC.code, '198.51.100.56');
  assert.equal(refusedCorrect.status, 422,
    `A correct contact code was accepted after its recipient spent the failure budget: ${refusedCorrect.status} ${JSON.stringify(refusedCorrect.body)}`);
  expectProblem(refusedCorrect, 422, 'OTP_INVALID');
  const challengeC = (await owner.query(`select failed_attempts, consumed_at, invalidated_at, recipient_hmac
    from identity.public_patient_enrollment_otps where id = $1`, [secondC.body.challengeId])).rows[0];
  assert.deepEqual({ ...challengeC, recipient_hmac: undefined },
    { failed_attempts: 2, consumed_at: null, invalidated_at: null, recipient_hmac: undefined },
    'A correct contact code refused for the recipient budget must leave its challenge open and uncounted');
  assert.equal((await owner.query("select state from identity.public_patient_enrollments where nin_last4 = '0003'"))
    .rows[0].state, 'verify_contact');
  // The budget is one row, keyed by the recipient's HMAC in its own HMAC
  // domain; six networks' guesses wrote no other row.
  const budgetBucket = createHmac('sha256', Buffer.from(process.env.OTP_HMAC_KEY_B64, 'base64'))
    .update(`patient-enrollment-contact-failure\u001f${challengeC.recipient_hmac}`, 'utf8').digest('hex');
  assert.equal(await count('select count(*) from auth.otp_rate_limits'), rateRowsBefore + 1,
    'The wrong contact codes must write exactly one rate-limit row, the recipient failure budget');
  assert.deepEqual((await owner.query(`select request_count, blocked_until > clock_timestamp() as blocked
    from auth.otp_rate_limits where scope = 'recipient' and bucket_hmac = $1`, [budgetBucket])).rows,
  [{ request_count: 5, blocked: true }], 'The recipient failure budget must have counted five wrong codes and be blocked');
  const deliveriesBefore = deliveries.length;
  await endCooldown(secondC.body.challengeId);
  expectProblem(await contactC(), 429, 'ENROLLMENT_RATE_LIMITED');
  assert.equal(deliveries.length, deliveriesBefore, 'The contact step must send no code to a recipient whose failure budget is spent');
  // As the owner, end the block early: the same open challenge's code now verifies.
  assert.equal((await owner.query(`update auth.otp_rate_limits set blocked_until = null
    where scope = 'recipient' and bucket_hmac = $1 and blocked_until > clock_timestamp()`, [budgetBucket])).rowCount, 1);
  const verifiedC = await verifyC(secondC.body.challengeId, secondCodeC.code, networkC);
  expectProblem(verifiedC, 200); assert.equal(verifiedC.body.stage, 'set_password');
  check('the contact code has one failure budget per recipient across its challenges and networks: after five wrong codes (three on a challenge, two on its resend, each from another network) the correct code is refused 422 OTP_INVALID with its challenge left open, the contact step sends that recipient no code (429 ENROLLMENT_RATE_LIMITED), the budget is one recipient-keyed rate row, and once the block is lifted the same code verifies');
  // 15. The enrollment gate comes before any registration lookup (ENR-4): while
  // QoreID is paused or NIN-only enrollment is switched off, a bound NIN (A), a
  // pending one (C, waiting for its password) and one never seen get the same
  // 503, and nothing is looked up, charged or stored.
  const pendingNin = '90000000003';
  const unseenNin = '90000000004';
  const rateTotal = async () => count('select coalesce(sum(request_count), 0) as count from identity.public_patient_enrollment_rates');
  const comparable = response => ({ status: response.status, ...response.body, instance: undefined, correlationId: undefined });
  const gatedStarts = async () => {
    const answers = [];
    for (const candidate of [ninA, pendingNin, unseenNin]) {
      answers.push(await post('/identity/patient-enrollments', startBody(candidate), { key: randomUUID(), network: '198.51.100.70' }));
    }
    return answers;
  };
  const lookupsBeforeGate = ninLookups.length;
  const ratesBeforeGate = await rateTotal();
  const enrollmentsBeforeGate = await enrollmentRows();
  assert.equal((await owner.query(`select state from identity.public_patient_enrollments where nin_last4 = '0003'`))
    .rows[0].state, 'set_password', 'enrollment C must be pending for the gate check');
  await owner.query("update platform.integration_providers set enabled=false, row_version=row_version+1 where provider='qoreid'");
  const paused = await gatedStarts();
  for (const response of paused) expectProblem(response, 503, 'INTEGRATION_PAUSED');
  assert.deepEqual(comparable(paused[1]), comparable(paused[0]), 'a pending NIN must be answered as a bound one while QoreID is paused');
  assert.deepEqual(comparable(paused[2]), comparable(paused[0]), 'an unseen NIN must be answered as a bound one while QoreID is paused');
  await owner.query("update platform.integration_providers set enabled=true, row_version=row_version+1 where provider='qoreid'");
  process.env.QOREID_NIN_ONLY_ENROLLMENT_ENABLED = 'false'; resetEnvironmentForTests();
  const switchedOff = await gatedStarts();
  process.env.QOREID_NIN_ONLY_ENROLLMENT_ENABLED = 'true'; resetEnvironmentForTests();
  for (const response of switchedOff) expectProblem(response, 503, 'QOREID_NIN_ONLY_DISABLED');
  assert.deepEqual(comparable(switchedOff[1]), comparable(switchedOff[0]));
  assert.deepEqual(comparable(switchedOff[2]), comparable(switchedOff[0]));
  assert.equal(ninLookups.length, lookupsBeforeGate, 'a closed gate must ask QoreID nothing');
  assert.equal(await rateTotal(), ratesBeforeGate, 'a closed gate must charge no enrollment rate bucket');
  assert.equal(await enrollmentRows(), enrollmentsBeforeGate);
  check('while QoreID is paused (503 INTEGRATION_PAUSED) or NIN-only enrollment is switched off (503 QOREID_NIN_ONLY_DISABLED), a bound, a pending and an unseen NIN get the same answer, and nothing is looked up, charged or stored');

  // 16. The HID is shown again for 15 minutes after activation (N2(b)): then
  // GET /current and an activation replay are 404 without it.
  const currentA = await http.get('/api/v1/identity/patient-enrollments/current').set('Cookie', cookieA);
  expectProblem(currentA, 200);
  assert.equal(currentA.body.stage, 'active'); assert.equal(currentA.body.hidCode, hidA);
  assert.equal((await owner.query(`update identity.public_patient_enrollments
    set activated_at = activated_at - interval '16 minutes' where patient_id = $1`, [patientA])).rowCount, 1);
  const lateCurrent = await http.get('/api/v1/identity/patient-enrollments/current').set('Cookie', cookieA);
  expectProblem(lateCurrent, 404, 'ENROLLMENT_NOT_FOUND');
  const lateReplay = await post('/identity/patient-enrollments/activate', { password: passwordA }, { cookie: cookieA });
  expectProblem(lateReplay, 404, 'ENROLLMENT_NOT_FOUND');
  for (const response of [lateCurrent, lateReplay]) {
    assert(!JSON.stringify(response.body).includes(hidA), 'a late re-display must not carry the HID');
  }
  check('GET /current shows the HID within 15 minutes of activation; once activation is more than 15 minutes old, GET /current and an activation replay answer 404 ENROLLMENT_NOT_FOUND without it');

  // 17. A contact proof more than 30 minutes old is verified again (N2(c)).
  assert.equal((await owner.query(`update identity.public_patient_enrollments
    set contact_verified_at = contact_verified_at - interval '31 minutes'
    where nin_last4 = '0003' and state = 'set_password'`)).rowCount, 1);
  const patientsBeforeC = await count('select count(*) from identity.patients where source_system = $1',
    ['hid-public-qoreid-enrollment']);
  const staleC = await post('/identity/patient-enrollments/activate', { password: 'Synthetic-Patient-Pass-C3' },
    { cookie: cookieC, network: networkC });
  expectProblem(staleC, 409, 'ENROLLMENT_CONTACT_REVERIFY_REQUIRED');
  assert.deepEqual((await owner.query(`select state, contact_verified_at, contact_channel, contact_ciphertext,
      verified_challenge_id from identity.public_patient_enrollments where nin_last4 = '0003'`)).rows[0],
  { state: 'verify_contact', contact_verified_at: null, contact_channel: null, contact_ciphertext: null,
    verified_challenge_id: null }, 'a stale contact proof must send the enrollment back to the contact step');
  assert.equal(await count('select count(*) from identity.patients where source_system = $1',
    ['hid-public-qoreid-enrollment']), patientsBeforeC, 'a stale contact proof must not activate');
  const resetC = await http.get('/api/v1/identity/patient-enrollments/current').set('Cookie', cookieC);
  expectProblem(resetC, 200); assert.equal(resetC.body.stage, 'verify_contact');
  const againC = await contactC();
  expectProblem(againC, 200);
  const againCodeC = lastCode('SIGNUP_VERIFY', emailC);
  assert.equal(againCodeC.challengeId, againC.body.challengeId);
  expectProblem(await verifyC(againC.body.challengeId, againCodeC.code, networkC), 200);
  const activatedC = await post('/identity/patient-enrollments/activate', { password: 'Synthetic-Patient-Pass-C3' },
    { cookie: cookieC, network: networkC });
  expectProblem(activatedC, 200);
  assert.match(activatedC.body.hidCode, /^HID-[A-HJ-NP-Z2-9]{6,32}$/);
  expiresEnrollmentCookie(activatedC, 'activation after a new contact proof');
  check('activation with a contact proof more than 30 minutes old answers 409 ENROLLMENT_CONTACT_REVERIFY_REQUIRED, sends the enrollment back to the contact step and creates nothing; proving the contact again activates it');

  // 18. The QoreID lookup quota (0085) is charged only when QoreID is called,
  // per client network (an IPv6 /64) and in one platform-wide daily cap.
  const quotaCount = async (scope, period) => count(`select coalesce(sum(attempt_count), 0) as count
    from platform.public_patient_nin_quota_counters where scope = $1 and bucket_period = $2`, [scope, period]);
  assert.equal(await quotaCount('platform', 'day'), ninLookups.length,
    'the platform quota must count exactly the QoreID lookups: no replay, duplicate or refusal');
  // The hourly network limit is lowered to 2 for this step, so that the three
  // starts from one /64 below stay within any start rate limit of at least
  // three per network, however that limit keys its client (an address or a
  // /64). The quota reads its limits on every lookup.
  const configuredHourly = process.env.PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX;
  process.env.PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX = '2'; resetEnvironmentForTests();
  const environment = getEnvironment();
  assert.equal(environment.PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX, 2);
  const slash64 = host => `2001:db8:85:1::${host}`;
  for (let host = 1; host <= environment.PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX; host += 1) {
    expectProblem(await post('/identity/patient-enrollments', startBody(NOT_VERIFIED), { key: randomUUID(),
      network: slash64(host) }), 422, 'NIN_NOT_VERIFIED');
  }
  const lookupsAtNetworkLimit = ninLookups.length;
  const overNetwork = await post('/identity/patient-enrollments', startBody(NOT_VERIFIED), { key: randomUUID(),
    network: '2001:db8:85:1:ffff:ffff:ffff:fffe' });
  expectProblem(overNetwork, 429, 'VERIFICATION_QUOTA_EXCEEDED');
  assert.equal(ninLookups.length, lookupsAtNetworkLimit, 'a refused lookup must not reach QoreID');
  expectProblem(await post('/identity/patient-enrollments', startBody(NOT_VERIFIED), { key: randomUUID(),
    network: '2001:db8:85:2::1' }), 422, 'NIN_NOT_VERIFIED');
  // Fixture, as the owner: the platform has spent its daily cap.
  const capRow = await owner.query(`update platform.public_patient_nin_quota_counters
    set attempt_count = $1 where scope = 'platform' and bucket_period = 'day'
      and bucket_start = date_trunc('day', statement_timestamp()) returning attempt_count`,
  [environment.PATIENT_ENROLLMENT_QOREID_DAILY_CAP]);
  assert.equal(capRow.rowCount, 1);
  const lookupsAtCap = ninLookups.length;
  const overCap = await post('/identity/patient-enrollments', startBody(NOT_VERIFIED), { key: randomUUID(),
    network: '198.51.100.80' });
  expectProblem(overCap, 429, 'VERIFICATION_QUOTA_EXCEEDED');
  assert.equal(ninLookups.length, lookupsAtCap, 'a lookup above the platform cap must not reach QoreID');
  assert.deepEqual((await owner.query(`select details->>'exhaustedLimit' as limit from audit.events
    where action = 'identity.public-patient-enrollment.nin-lookup-quota' and outcome = 'denied'
    order by sequence_id`)).rows.map(row => row.limit), ['network_hour', 'platform_day'],
  'each quota refusal must be audited with its exhausted limit');
  assert.equal(await count(`select count(*) from audit.events
    where action = 'identity.public-patient-enrollment.nin-lookup-quota' and outcome = 'success'`), lookupsAtCap,
  'each charged lookup must be audited');
  if (configuredHourly === undefined) delete process.env.PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX;
  else process.env.PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX = configuredHourly;
  resetEnvironmentForTests();
  check('the QoreID lookup quota counts exactly the lookups made (none for a replay, duplicate or refusal), refuses the next lookup from an IPv6 /64 over its hourly limit (set to 2 for this check) and any lookup over the platform daily cap with 429 VERIFICATION_QUOTA_EXCEEDED before QoreID is called, and audits every decision');

  // 19. Availability (FE-4): GET /availability answers { open } from the
  // checks start makes before it reads a NIN, to any caller that passes CORS,
  // with no input, audit row or cookie. While QoreID is disabled or NIN-only
  // enrollment is off (the production setting: Identity refuses it on in
  // production until the N1 holder step ships) it is closed and start answers
  // 503 with the registration-not-open copy, which Health-id shows as sent
  // once the gateway passes upstream errors through (ADR-055). A runtime
  // pause closes it too; start keeps the generic 5xx detail for that.
  const NOT_OPEN = 'New Health ID registration is not open yet. If you already have a Health ID, sign in.';
  const availabilityPath = '/api/v1/identity/patient-enrollments/availability';
  const availability = (headers = {}) => {
    let call = http.get(availabilityPath).set('X-Forwarded-For', '198.51.100.90');
    for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
    return call;
  };
  const expectAvailability = async (open, label, headers) => {
    const response = await availability(headers);
    assert.equal(response.status, 200, `${label}: ${response.status} ${JSON.stringify(response.body)}`);
    assert.deepEqual(response.body, { open }, label);
    assert.equal(response.headers['cache-control'], 'public, max-age=30', `${label}: briefly cacheable`);
    for (const name of ['pragma', 'expires', 'surrogate-control', 'set-cookie']) {
      assert.equal(response.headers[name], undefined, `${label}: no ${name}`);
    }
  };
  const availabilityAudit = () => count(`select count(*) from audit.events
    where action like '%availability%' or details->>'route' like '%availability%'`);
  const lookupsBeforeAvailability = ninLookups.length;
  const enrollmentsBeforeAvailability = await enrollmentRows();
  const ratesBeforeAvailability = await rateTotal();
  await expectAvailability(true, 'open gate');
  // The same answer from the allowed Origin and with a signed-in session. The
  // route itself refuses no Origin: this verifier mounts no CORS middleware,
  // so a foreign Origin reaches it here. Deployed, main.ts's CORS middleware
  // answers an Origin outside CORS_ORIGINS before any route (500, no CORS
  // permission; src/config/cors.spec.ts), as on every Identity route.
  await expectAvailability(true, 'allowed Origin', { Origin: origin });
  await expectAvailability(true, 'foreign Origin without CORS middleware', { Origin: 'https://attacker.example' });
  await expectAvailability(true, 'signed-in caller', { Cookie: `${cookieName}=existing-session; ${cookieA}` });
  const closedStart = async (expectedCode, label) => {
    const response = await post('/identity/patient-enrollments', startBody(unseenNin), { key: randomUUID(),
      network: '198.51.100.91' });
    expectProblem(response, 503, expectedCode);
    assert.match(String(response.headers['cache-control']), /no-store/, `${label}: a refusal is not cacheable`);
    return response.body.detail;
  };
  // The production setting.
  process.env.QOREID_NIN_ONLY_ENROLLMENT_ENABLED = 'false'; resetEnvironmentForTests();
  await expectAvailability(false, 'NIN-only enrollment off');
  assert.equal(await closedStart('QOREID_NIN_ONLY_DISABLED', 'NIN-only enrollment off'), NOT_OPEN);
  // QoreID disabled (the infrastructure default).
  process.env.QOREID_ENABLED = 'false'; resetEnvironmentForTests();
  await expectAvailability(false, 'QoreID disabled');
  assert.equal(await closedStart('QOREID_DISABLED', 'QoreID disabled'), NOT_OPEN);
  process.env.QOREID_ENABLED = 'true'; process.env.QOREID_NIN_ONLY_ENROLLMENT_ENABLED = 'true';
  resetEnvironmentForTests();
  // A platform administrator pauses QoreID at runtime: closed, the pause read on every request.
  await owner.query("update platform.integration_providers set enabled=false, row_version=row_version+1 where provider='qoreid'");
  await expectAvailability(false, 'QoreID paused');
  assert.equal(await closedStart('INTEGRATION_PAUSED', 'QoreID paused'), 'The service could not complete the request.');
  await owner.query("update platform.integration_providers set enabled=true, row_version=row_version+1 where provider='qoreid'");
  await expectAvailability(true, 'QoreID resumed');
  assert.equal(ninLookups.length, lookupsBeforeAvailability, 'availability and a closed start must ask QoreID nothing');
  assert.equal(await enrollmentRows(), enrollmentsBeforeAvailability);
  assert.equal(await rateTotal(), ratesBeforeAvailability, 'availability and a closed start must charge no rate bucket');
  assert.equal(await availabilityAudit(), 0, 'an availability read must write no audit row');
  check('GET /identity/patient-enrollments/availability answers 200 { open } to every caller the route sees (no Origin, the allowed Origin, a signed-in caller; the route itself does not refuse a foreign Origin, which the CORS middleware of main.ts, not mounted here, refuses first when deployed) with Cache-Control public, max-age=30, no cookie and no audit row: open with QoreID and NIN-only enrollment on, closed with NIN-only enrollment off (the production setting), QoreID disabled or QoreID paused at runtime; while it is closed by a flag, start answers 503 QOREID_NIN_ONLY_DISABLED or QOREID_DISABLED with the registration-not-open detail, and nothing is looked up, charged or stored');
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
