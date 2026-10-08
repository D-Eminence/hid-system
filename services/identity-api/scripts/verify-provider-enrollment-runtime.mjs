#!/usr/bin/env node
// Accountless provider CAC self-enrollment over HTTP, executed as the exact
// Identity API runtime role against the owned disposable synthetic rehearsal
// only. The real DatabaseService, controllers, services, Turnstile verifier and
// QoreID adapter run; only the outbound boundaries are local stubs (Cloudflare
// Siteverify, the QoreID HTTP API, notification delivery). No network or cloud
// call is made. All values are synthetic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHmac, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createTotpClock, platformClient } from './platform-session-client.mjs';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
assert(process.env.OTP_HMAC_KEY_B64, 'The rehearsal OTP HMAC key is required to check keyed network digests');
// Run in a disposable copy so synthetic organizations, quota counters and the
// enabled QoreID control never leak into later rehearsal steps.
const isolated = `hid_rehearsal_provider_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
// The provider portal is served from the staging site host, which is the host
// Turnstile accepts the provider-enrollment action for.
const origin = 'https://staging.healthidentitydirectory.com';
const siteHost = new URL(origin).hostname;
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'staging',
  NIN_PROVIDER_MODE: 'deferred', CORS_ORIGINS: origin, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'public-synthetic-ehr-workload-token',
  TURNSTILE_MODE: 'required', TURNSTILE_SECRET_KEY: 'example-turnstile-secret',
  QOREID_ENABLED: 'true', QOREID_CLIENT_ID: 'example-qoreid-client',
  QOREID_CLIENT_SECRET: 'example-qoreid-secret',
  // Platform administration (the reviewer) requires an MFA platform session.
  MFA_SECRET_KEY_B64: Buffer.alloc(32, 0x50).toString('base64'), MFA_KEY_VERSION: 'provider-runtime-v1',
  // Every Identity API connection runs as the deployed runtime role.
  DATABASE_URL: `postgresql://${process.env.PGUSER ?? 'postgres'}@localhost/${isolated}?host=${encodeURIComponent(socket)}`
    + `&options=${encodeURIComponent('-c role=hid_identity_api_runtime')}`,
  // As in main.ts: only the loopback test client is a trusted reverse proxy, so
  // X-Forwarded-For carries the server-observed client address.
  TRUST_PROXY_CIDRS: '127.0.0.1/32,::1/128' });
delete process.env.AUTH_COOKIE_DOMAIN;
for (const key of ['NIN_LOOKUP_HMAC_KEY_B64', 'NIN_ENCRYPTION_KEY_B64', 'METAMAP_CLIENT_ID',
  'METAMAP_CLIENT_SECRET', 'QOREID_API_KEY']) delete process.env[key];
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
const { IntegrationRuntimeService } = load('integrations/integration-runtime.service.ts');
const { ProviderEnrollmentController } = load('identity/provider-enrollment.controller.ts');
const { ProviderEnrollmentService } = load('identity/provider-enrollment.service.ts');
const { OrganizationProfileCompletionService } = load('identity/organization-profile-completion.service.ts');
const { AdminOrganizationApplicationsController } = load('identity/organization-applications.controller.ts');
const { OrganizationApplicationsService } = load('identity/organization-applications.service.ts');
const { QoreIdVerificationAdapter, QOREID_ADAPTER_CONFIGURATION, QOREID_FETCH } =
  load('identity/qoreid-verification.adapter.ts');
const { DomainProblem, ProblemDetailsFilter } = load('common/problem.ts');
const { getEnvironment } = load('config/environment.ts');
const { PlatformAuthController } = load('auth/platform-auth.controller.ts');
const { MfaService, MFA_TOTP_CLOCK } = load('auth/mfa/mfa.service.ts');
const { MfaSecretProtector } = load('auth/mfa/mfa-secret-protector.ts');
const { PlatformSecurityController } = load('admin/platform-security.controller.ts');
const { PlatformSecurityService } = load('admin/platform-security.service.ts');
const totp = load('auth/mfa/totp.ts');

// Cloudflare Siteverify stub. A token encodes the outcome the real service
// would return: `ok|<action>|<hostname>` or `replayed`. Any other outbound
// request fails the verifier.
const siteverifyUrl = getEnvironment().TURNSTILE_SITEVERIFY_URL;
const siteverifyRequests = [];
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  assert.equal(url, siteverifyUrl, `Unexpected outbound request to ${url}`);
  const body = JSON.parse(String(init?.body));
  assert.equal(body.secret, 'example-turnstile-secret');
  siteverifyRequests.push(body.response);
  const [kind, action, hostname] = String(body.response).split('|');
  if (kind !== 'ok') return Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] });
  return Response.json({ success: true, action, hostname });
};
const turnstile = (action = 'provider-enrollment', host = siteHost) => `ok|${action}|${host}`;

// QoreID HTTP stub behind the real adapter. NOT_VERIFIED returns a negative
// registry check; every other number returns a complete verified CAC record.
const NOT_VERIFIED = 'RC9900063299';
const qoreidCacLookups = [];
let qoreidTokens = 0;
const qoreidFetch = async (url, init) => {
  const path = new URL(String(url)).pathname;
  if (path === '/token') {
    qoreidTokens += 1;
    return new Response(JSON.stringify({ accessToken: 'synthetic-qoreid-token', expiresIn: 7200,
      tokenType: 'Bearer' }), { status: 200 });
  }
  assert.equal(path, '/v2/ng/identities/cac-basic', `Unexpected QoreID request to ${path}`);
  assert.equal(init.headers.authorization, 'Bearer synthetic-qoreid-token');
  const { regNumber } = JSON.parse(String(init.body));
  qoreidCacLookups.push(regNumber);
  if (regNumber === NOT_VERIFIED) {
    return new Response(JSON.stringify({ id: 990001, summary: { cac_check: 'not_verified' },
      status: { state: 'complete', status: 'not_verified' }, cac: {} }), { status: 200 });
  }
  return new Response(JSON.stringify({ id: 990000 + qoreidCacLookups.length, summary: { cac_check: 'verified' },
    status: { state: 'complete', status: 'verified' },
    cac: { rcNumber: regNumber.replace(/^(RC|BN|IT)/, ''), companyName: `Runtime Clinic ${regNumber} Ltd`,
      companyType: 'Private Company Limited by Shares', registrationDate: '01-Jan-21',
      headOfficeAddress: '1 Synthetic Registry Road, Lagos', status: 'Active' } }), { status: 200 });
};

// The digest the Identity API must store for a client network (IPv4 address
// or IPv6 /64): keyed with the server-only OTP HMAC key, never the address.
const networkKey = Buffer.from(process.env.OTP_HMAC_KEY_B64, 'base64');
const digest = network => createHmac('sha256', networkKey)
  .update('provider-self-service-cac-network\0', 'utf8').update(network, 'utf8').digest('hex');

const maintenance = new Pool({ host: socket, user: process.env.PGUSER, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
// Fixture and assertion connection (database owner), never used by the API.
const owner = new Pool({ host: socket, user: process.env.PGUSER, database: isolated, max: 2 });
// Local delivery stub: captures the emailed code exactly as notification-api would receive it.
const codes = new Map();
const recipients = [];
const notification = {
  deliver: async (input) => {
    assert.equal(input.purpose, 'EMAIL_VERIFY'); assert.equal(input.channel, 'email');
    codes.set(input.challengeId, input.code); recipients.push(input.recipient);
    return { outcome: 'accepted', provider: 'brevo' };
  },
};
let app;
try {
  // Fixture: the platform has enabled QoreID CAC verification (an admin action).
  await owner.query("update platform.integration_providers set enabled=true, row_version=row_version+1 where provider='qoreid'");
  const clock = createTotpClock();
  const module = await Test.createTestingModule({
    controllers: [AuthController, ProviderEnrollmentController, AdminOrganizationApplicationsController,
      PlatformAuthController, PlatformSecurityController],
    providers: [DatabaseService, TokenService, LocalAuthProvider,
      CurrentStaffContextService, CurrentPatientContextService, AuthService, AuthSessionAuditService,
      AuditService, WorkloadAuthService, TurnstileService, IntegrationRuntimeService,
      ProviderEnrollmentService, OrganizationProfileCompletionService, OrganizationApplicationsService,
      QoreIdVerificationAdapter, MfaService, MfaSecretProtector, PlatformSecurityService,
      { provide: MFA_TOTP_CLOCK, useValue: clock.now },
      { provide: QOREID_ADAPTER_CONFIGURATION, useValue: { baseUrl: 'https://api.qoreid.com',
        clientId: 'example-qoreid-client', clientSecret: 'example-qoreid-secret', timeoutMs: 2000 } },
      { provide: QOREID_FETCH, useValue: qoreidFetch },
      { provide: NotificationOtpClient, useValue: notification },
      { provide: GoogleAuthenticationService, useValue: {
        login: async () => { throw new Error('Google exchange is outside the provider-enrollment verifier'); },
      } }] }).compile();
  const runtimeRole = (await module.get(DatabaseService).query('select current_user as role')).rows[0].role;
  assert.equal(runtimeRole, 'hid_identity_api_runtime');
  app = module.createNestApplication({ logger: false });
  app.getHttpAdapter().getInstance().set('trust proxy',
    getEnvironment().TRUST_PROXY_CIDRS.split(',').map(cidr => cidr.trim()));
  app.use(require('cookie-parser')());
  app.use((req, _res, next) => { req.correlationId = randomUUID(); next(); });
  app.setGlobalPrefix('api/v1');
  // The same request validation main.ts installs.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
    exceptionFactory: errors => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
      errors.map(error => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  // The same global guard and request audit interceptor AppModule installs.
  app.useGlobalGuards(new SecurityGuard(module.get(Reflector), module.get(TokenService),
    module.get(AuditService), module.get(DatabaseService)));
  app.useGlobalInterceptors(new AuditInterceptor(module.get(Reflector), module.get(AuditService)));
  await app.init();
  const http = request(app.getHttpServer());
  const cookieName = getEnvironment().AUTH_COOKIE_NAME;
  const cookies = response => (response.headers['set-cookie'] ?? []).map(value => value.split(';')[0]);
  const enrollment = input => ({ productCode: 'ehr', organizationType: 'clinic',
    administratorName: 'Synthetic Provider Admin', turnstileAction: 'provider-enrollment',
    turnstileToken: turnstile(), ...input });
  const MAIN = '198.51.100.10';
  const start = (body, network = MAIN, extra = {}) => {
    let call = http.post('/api/v1/identity/provider-enrollments').set('Origin', origin)
      .set('X-Forwarded-For', network);
    for (const [name, value] of Object.entries(extra)) call = call.set(name, value);
    return call.send(body);
  };
  const expectProblem = (response, status, code) => {
    assert.equal(response.status, status, `${code}: ${JSON.stringify(response.body)}`);
    if (code) assert.equal(response.body.code, code, JSON.stringify(response.body));
  };
  const application = async cac => (await owner.query(`select id, status, verification_result,
      approval_mode from identity.organization_applications where cac_registration_number=$1`, [cac])).rows[0];
  const networkCounters = async network => Object.fromEntries((await owner.query(
    `select bucket_period, attempt_count from platform.self_service_cac_quota_counters
      where network_digest=$1 and bucket_start >= date_trunc('day', statement_timestamp())
        and (bucket_period='day' or bucket_start=date_trunc('hour', statement_timestamp()))`,
    [digest(network)])).rows.map(row => [row.bucket_period, row.attempt_count]));
  const email = label => `provider-${label}-${randomUUID().slice(0, 8)}@example.invalid`;
  const security = {};
  const quota = {};

  // 2-3, 6, 19-20. Origin, Turnstile and CAC format are refused before any
  // application is written or QoreID is contacted.
  const cacA = 'RC9900063201'; const emailA = email('a');
  expectProblem(await http.post('/api/v1/identity/provider-enrollments').set('X-Forwarded-For', MAIN)
    .send(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA })), 403, 'ORIGIN_DENIED');
  expectProblem(await http.post('/api/v1/identity/provider-enrollments').set('Origin', 'https://attacker.example')
    .set('X-Forwarded-For', MAIN).send(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA })),
  403, 'ORIGIN_DENIED');
  security.origin = 'ORIGIN_DENIED';
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA,
    turnstileAction: 'staff-login' })), 400, 'VALIDATION_FAILED');
  security.turnstile_action_in_body = 'VALIDATION_FAILED';
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA,
    turnstileToken: turnstile('patient-enrollment') })), 403, 'TURNSTILE_ACTION_MISMATCH');
  security.turnstile_action_mismatch = 'TURNSTILE_ACTION_MISMATCH';
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA,
    turnstileToken: 'replayed' })), 403, 'TURNSTILE_EXPIRED_OR_REPLAYED');
  security.turnstile_replay = 'TURNSTILE_EXPIRED_OR_REPLAYED';
  for (const malformed of ['XX12', 'RC12', 'RC12345678901234567890123']) {
    expectProblem(await start(enrollment({ cacRegistrationNumber: malformed, administratorEmail: emailA })),
      400, 'VALIDATION_FAILED');
  }
  security.malformed_cac = 'VALIDATION_FAILED';
  assert.equal(qoreidCacLookups.length, 0, 'A refused request reached QoreID');
  assert.equal((await owner.query('select count(*)::int n from identity.organization_applications')).rows[0].n, 0,
    'A refused request created an application');

  // 4, 7. A registry-rejected CAC reaches QoreID through the accountless quota
  // and returns the application error; the application stays unverified.
  const emailRejected = email('rejected');
  expectProblem(await start(enrollment({ cacRegistrationNumber: NOT_VERIFIED, administratorEmail: emailRejected })),
    422, 'CAC_NOT_VERIFIED');
  assert.deepEqual(qoreidCacLookups, [NOT_VERIFIED]);
  assert.deepEqual(await application(NOT_VERIFIED), { id: (await application(NOT_VERIFIED)).id,
    status: 'pending_verification', verification_result: 'not_verified', approval_mode: 'self_service' });
  security.qoreid_rejected_cac = 'CAC_NOT_VERIFIED';

  // 1, 4-5, 9. A valid CAC reaches QoreID, is recorded as verified, and the
  // emailed code is sent. The lookup is charged to the keyed client network.
  const started = await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA }));
  assert.equal(started.status, 200, `start failed: ${JSON.stringify(started.body)}`);
  assert.equal(started.body.accepted, true);
  assert.deepEqual(qoreidCacLookups, [NOT_VERIFIED, cacA]);
  assert(qoreidTokens >= 1, 'The QoreID adapter did not authenticate');
  const challengeId = started.body.challengeId;
  assert.match(challengeId, /^[0-9a-f-]{36}$/);
  assert(codes.has(challengeId), 'The email OTP was not delivered for the started challenge');
  assert.equal(recipients.at(-1), emailA);
  const recordedA = await application(cacA);
  assert.deepEqual({ ...recordedA, id: undefined }, { id: undefined, status: 'ready_for_review',
    verification_result: 'verified', approval_mode: 'self_service' });
  assert.deepEqual(await networkCounters(MAIN), { hour: 2, day: 2 });

  // 9-10. Wrong code fails; the emailed code verifies and sets the enrollment cookie.
  const wrongCode = codes.get(challengeId) === '000000' ? '111111' : '000000';
  expectProblem(await http.post('/api/v1/identity/provider-enrollments/verify').set('Origin', origin)
    .send({ challengeId, code: wrongCode }), 401, 'ORGANIZATION_COMPLETION_CODE_INVALID');
  security.wrong_otp = 'ORGANIZATION_COMPLETION_CODE_INVALID';
  const verified = await http.post('/api/v1/identity/provider-enrollments/verify').set('Origin', origin)
    .send({ challengeId, code: codes.get(challengeId) });
  assert.equal(verified.status, 200, `verify failed: ${JSON.stringify(verified.body)}`);
  assert.deepEqual(verified.body, { verified: true });
  const enrollmentCookie = cookies(verified).find(value => value.startsWith('hid_provider_enrollment='));
  assert(enrollmentCookie, 'OTP verification did not set the enrollment cookie');
  assert.match(verified.headers['set-cookie'].join(';'), /HttpOnly/i);

  // 12-16. Activation creates the organization, facility, EHR product, account
  // and org-admin membership, and signs the administrator in.
  const password = 'Synthetic-Provider-Password-2026';
  expectProblem(await http.post('/api/v1/identity/provider-enrollments/activate').set('Origin', origin)
    .send({ password }), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  const activated = await http.post('/api/v1/identity/provider-enrollments/activate').set('Origin', origin)
    .set('Cookie', enrollmentCookie).send({ password });
  assert.equal(activated.status, 200, `activation failed: ${JSON.stringify(activated.body)}`);
  assert.equal(activated.body.activated, true);
  const { organizationId, facilityId, accountId } = activated.body;
  assert.equal(activated.body.actor.accountId, accountId);
  assert(activated.headers['x-csrf-token'], 'Activation did not return a CSRF token for the new session');
  const sessionCookies = cookies(activated).filter(value => value.startsWith(cookieName));
  assert(sessionCookies.some(value => value.startsWith(`${cookieName}=`)), 'Activation did not sign the provider in');
  const created = (await owner.query(`
    select o.name organization, f.lifecycle_status facility_status, f.active facility_active,
      p.product_code product, a.email, a.status account_status, s.default_role staff_role,
      m.membership_role, m.active membership_active, r.role_code, app.status application_status,
      app.reviewed_by_account_id reviewer, app.facility_id = f.id application_facility,
      (select count(*)::int from identity.organization_cac_registrations c where c.organization_id=o.id) cac_bindings
    from identity.organizations o
    join identity.facilities f on f.organization_id=o.id and f.id=$2
    join identity.organization_products p on p.organization_id=o.id and p.facility_id=f.id
    join auth.accounts a on a.id=$3
    join identity.staff s on s.account_id=a.id
    join identity.staff_facility_memberships m on m.staff_id=s.id and m.facility_id=f.id
    join auth.account_roles r on r.account_id=a.id and r.facility_id=f.id
    join identity.organization_applications app on app.organization_id=o.id
    where o.id=$1`, [organizationId, facilityId, accountId])).rows;
  assert.deepEqual(created, [{ organization: `Runtime Clinic ${cacA} Ltd`, facility_status: 'verified',
    facility_active: true, product: 'ehr', email: emailA, account_status: 'active', staff_role: 'org_admin',
    membership_role: 'org_admin', membership_active: true, role_code: 'org_admin',
    application_status: 'approved', reviewer: null, application_facility: true, cac_bindings: 1 }]);

  // 17. The new provider is authenticated: the activation session works, the
  // facility can be selected, and a fresh staff login succeeds.
  const sessionHeader = sessionCookies.join('; ');
  const session = await http.get('/api/v1/auth/session').set('Cookie', sessionHeader);
  assert.equal(session.status, 200, `session failed: ${JSON.stringify(session.body)}`);
  assert.equal(session.body.actor.accountId, accountId);
  const selected = await http.post('/api/v1/auth/facility').set('Cookie', sessionHeader).set('Origin', origin)
    .set('x-csrf-token', activated.headers['x-csrf-token']).send({ facilityId });
  assert.equal(selected.status, 200, `facility selection failed: ${JSON.stringify(selected.body)}`);
  const login = await http.post('/api/v1/auth/login').set('Origin', origin)
    .send({ email: emailA, password, turnstileAction: 'staff-login', turnstileToken: turnstile('staff-login') });
  assert.equal(login.status, 200, `provider login failed: ${JSON.stringify(login.body)}`);
  assert.equal(login.body.actor.accountId, accountId);

  // 18. A signed-in caller cannot use the accountless flow.
  const cacB = 'RC9900063202'; const emailB = email('b');
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacB, administratorEmail: emailB }), MAIN,
    { Cookie: sessionHeader }), 409, 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT');
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacB, administratorEmail: emailB }), MAIN,
    { Authorization: 'Bearer synthetic' }), 409, 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT');
  security.signed_in_caller = 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT';

  // The consumed enrollment session cannot activate again.
  expectProblem(await http.post('/api/v1/identity/provider-enrollments/activate').set('Origin', origin)
    .set('Cookie', enrollmentCookie).send({ password }), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  security.replayed_activation = 'ORGANIZATION_COMPLETION_SESSION_INVALID';

  // 8. A registered CAC is sent to review, for its own or another
  // administrator email, without a new registry lookup.
  const lookupsBeforeDuplicate = qoreidCacLookups.length;
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA })),
    409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW');
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: email('c') })),
    409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW');
  assert.equal(qoreidCacLookups.length, lookupsBeforeDuplicate, 'A duplicate CAC reached QoreID');
  security.duplicate_cac = 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW';

  // 11. An expired code cannot verify, even with the right digits. Starting
  // again reuses the verified evidence: no second lookup and no quota charge.
  const startedB = await start(enrollment({ cacRegistrationNumber: cacB, administratorEmail: emailB }));
  assert.equal(startedB.status, 200, `second start failed: ${JSON.stringify(startedB.body)}`);
  assert.deepEqual(await networkCounters(MAIN), { hour: 3, day: 3 });
  await owner.query("update identity.organization_profile_completion_challenges set expires_at=clock_timestamp()-interval '1 second' where id=$1",
    [startedB.body.challengeId]);
  expectProblem(await http.post('/api/v1/identity/provider-enrollments/verify').set('Origin', origin)
    .send({ challengeId: startedB.body.challengeId, code: codes.get(startedB.body.challengeId) }),
  401, 'ORGANIZATION_COMPLETION_CODE_INVALID');
  security.expired_otp = 'ORGANIZATION_COMPLETION_CODE_INVALID';
  const lookupsBeforeRestart = qoreidCacLookups.length;
  const restartedB = await start(enrollment({ cacRegistrationNumber: cacB, administratorEmail: emailB }));
  assert.equal(restartedB.status, 200, `restart failed: ${JSON.stringify(restartedB.body)}`);
  assert.notEqual(restartedB.body.challengeId, startedB.body.challengeId);
  assert.equal(qoreidCacLookups.length, lookupsBeforeRestart, 'Verified evidence was looked up again');
  assert.deepEqual(await networkCounters(MAIN), { hour: 3, day: 3 });

  // 21. One application gets three lookups a day, whichever network asks.
  for (const network of ['198.51.100.11', '198.51.100.12']) {
    expectProblem(await start(enrollment({ cacRegistrationNumber: NOT_VERIFIED, administratorEmail: emailRejected }),
      network), 422, 'CAC_NOT_VERIFIED');
  }
  const lookupsBeforeApplicationLimit = qoreidCacLookups.length;
  const applicationLimited = await start(enrollment({ cacRegistrationNumber: NOT_VERIFIED,
    administratorEmail: emailRejected }), '198.51.100.13');
  expectProblem(applicationLimited, 429, 'VERIFICATION_QUOTA_EXCEEDED');
  assert.equal(qoreidCacLookups.length, lookupsBeforeApplicationLimit, 'A refused lookup reached QoreID');
  assert.deepEqual(await networkCounters('198.51.100.13'), {}, 'A refused lookup was charged to its network');
  quota.application_daily_limit = { limit: 3, refusedOnAttempt: 4, status: 429 };

  // 21. Five lookups an hour per IPv4 client; new CACs and emails do not reset it.
  const IPV4 = '203.0.113.50';
  for (let index = 1; index <= 5; index += 1) {
    const response = await start(enrollment({ cacRegistrationNumber: `RC99000633${String(index).padStart(2, '0')}`,
      administratorEmail: email(`v4-${index}`) }), IPV4);
    assert.equal(response.status, 200, `IPv4 lookup ${index}: ${JSON.stringify(response.body)}`);
  }
  const lookupsBeforeNetworkLimit = qoreidCacLookups.length;
  const networkLimited = await start(enrollment({ cacRegistrationNumber: 'RC9900063306',
    administratorEmail: email('v4-6') }), IPV4);
  expectProblem(networkLimited, 429, 'VERIFICATION_QUOTA_EXCEEDED');
  assert.equal(qoreidCacLookups.length, lookupsBeforeNetworkLimit, 'A refused lookup reached QoreID');
  assert.doesNotMatch(JSON.stringify(networkLimited.body), /network|hour|digest|exhausted|counter|203\.0\.113/i,
    'The public quota refusal exposed internal quota details');
  assert.deepEqual({ ...(await application('RC9900063306')), id: undefined }, { id: undefined,
    status: 'pending_verification', verification_result: null, approval_mode: 'self_service' });
  assert.deepEqual(await networkCounters(IPV4), { hour: 5, day: 5 });
  const requestAudit = (await owner.query(`select count(*)::int n from audit.events
    where action='api.identity.provider-enrollment.start' and outcome='failure' and source_ip=$1::inet`, [IPV4])).rows[0].n;
  assert.equal(requestAudit, 1, 'The refused request was not audited with its server-observed address');
  quota.ipv4_hourly_limit = { limit: 5, refusedOnAttempt: 6, status: 429 };

  // 21. IPv6 clients are limited per /64, so rotating the interface ID does
  // not reset the quota; another /64 is a different client network.
  for (let index = 1; index <= 5; index += 1) {
    const response = await start(enrollment({ cacRegistrationNumber: `RC99000634${String(index).padStart(2, '0')}`,
      administratorEmail: email(`v6-${index}`) }), `2001:db8:aa:bb::${index.toString(16)}`);
    assert.equal(response.status, 200, `IPv6 lookup ${index}: ${JSON.stringify(response.body)}`);
  }
  expectProblem(await start(enrollment({ cacRegistrationNumber: 'RC9900063406',
    administratorEmail: email('v6-6') }), '2001:db8:aa:bb:ffff:ffff:ffff:fffe'), 429, 'VERIFICATION_QUOTA_EXCEEDED');
  assert.deepEqual(await networkCounters('2001:db8:aa:bb::/64'), { hour: 5, day: 5 });
  const otherPrefix = await start(enrollment({ cacRegistrationNumber: 'RC9900063407',
    administratorEmail: email('v6-7') }), '2001:db8:aa:bc::1');
  assert.equal(otherPrefix.status, 200, `another /64: ${JSON.stringify(otherPrefix.body)}`);
  quota.ipv6_prefix_hourly_limit = { prefix: 64, limit: 5, refusedOnAttempt: 6, status: 429 };

  // Every accountless quota decision is audited, without CAC, email or address.
  const decisions = (await owner.query(`select outcome, details from audit.events
    where action='identity.organization.self-service.cac-quota' order by sequence_id`)).rows;
  assert.equal(decisions.filter(row => row.outcome === 'success').length, qoreidCacLookups.length);
  assert.deepEqual(decisions.filter(row => row.outcome === 'denied').map(row => row.details.exhaustedLimit),
    ['application_day', 'network_hour', 'network_hour']);
  assert(decisions.every(row => /^[a-f0-9]{64}$/.test(row.details.networkDigest)
    && !/RC99000|example\.invalid|203\.0\.113|198\.51\.100|2001:db8/.test(JSON.stringify(row.details))));
  quota.audited_decisions = decisions.length;

  // 22. The authenticated reviewer path is unchanged: a platform reviewer's
  // CAC check is charged to the 0049 account quota, not to any network.
  await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
    values ($1, $2, 'platform_super_admin', 'platform', 'Synthetic platform reviewer for the runtime verifier')`,
  [randomUUID(), accountId]);
  const reviewed = (await owner.query(`insert into identity.organization_applications (product_code,
      organization_name, organization_type, cac_registration_number, administrator_name, administrator_email, status)
    values ('ehr', 'Reviewed Runtime Clinic', 'clinic', 'RC9900063501', 'Reviewed Applicant', $1, 'pending_verification')
    returning id, row_version`, [email('reviewed')])).rows[0];
  const networkRowsBefore = (await owner.query('select coalesce(sum(attempt_count),0)::int n from platform.self_service_cac_quota_counters')).rows[0].n;
  // Stage 2A: the reviewer signs in to platform administration (password +
  // TOTP enrollment) and steps up, since verify-CAC is a high-tier action.
  const platform = platformClient({ http, origin, totp, clock, password,
    turnstileToken: () => turnstile('admin-login') });
  const reviewer = await platform.enroll(emailA);
  await platform.stepUp(reviewer);
  const verifiedByReviewer = await platform.command(reviewer,
    `/admin/organization-applications/${reviewed.id}/verify-cac`, {},
    { 'x-facility-id': facilityId, 'If-Match': String(reviewed.row_version) });
  assert.equal(verifiedByReviewer.status, 200, `reviewer CAC check failed: ${JSON.stringify(verifiedByReviewer.body)}`);
  assert.equal(qoreidCacLookups.at(-1), 'RC9900063501');
  const reviewerCounters = (await owner.query(`select scope_type, bucket_period, attempt_count
    from platform.qoreid_quota_counters where operation='application_cac'
      and ((scope_type='account' and scope_id=$1) or (scope_type='target' and scope_id=$2))
    order by scope_type, bucket_period`, [accountId, reviewed.id])).rows;
  assert.deepEqual(reviewerCounters, [{ scope_type: 'account', bucket_period: 'day', attempt_count: 1 },
    { scope_type: 'account', bucket_period: 'hour', attempt_count: 1 },
    { scope_type: 'target', bucket_period: 'day', attempt_count: 1 }]);
  assert.equal((await owner.query('select coalesce(sum(attempt_count),0)::int n from platform.self_service_cac_quota_counters')).rows[0].n,
    networkRowsBefore, 'The reviewer path charged a network quota');
  assert.equal((await owner.query(`select count(*)::int n from audit.events
    where action='identity.organization.self-service.cac-quota' and resource_id=$1`, [reviewed.id])).rows[0].n, 0);

  const audits = (await owner.query(
    "select count(*)::int n from audit.events where action='identity.organization.self-service.activate' and organization_id=$1",
    [organizationId])).rows[0].n;
  assert.equal(audits, 1);
  process.stdout.write(JSON.stringify({ status: 'passed', runtimeRole,
    flow: ['origin', 'turnstile', 'accountless_start', 'qoreid_cac_lookup', 'verified_cac', 'email_otp',
      'otp_verification', 'activation', 'organization', 'facility', 'org_admin_membership', 'account',
      'ehr_product', 'authenticated_session', 'facility_selection', 'staff_login'],
    security, quota, qoreidCacLookups: qoreidCacLookups.length,
    reviewerPath: 'account_quota_unchanged', siteverifyCalls: siteverifyRequests.length }) + '\n');
} finally {
  await app?.close();
  await owner.end();
  await maintenance.query(`drop database if exists ${isolated} with (force)`);
  await maintenance.end();
}
