#!/usr/bin/env node
// Facility self sign-up (accountless provider CAC self-enrollment, P4) over
// HTTP, executed as the exact Identity API runtime role against the owned
// disposable synthetic rehearsal (or, with HID_PROVIDER_RUNTIME_LOCAL_CLUSTER=
// loopback, a disposable copy of a database on a loopback test cluster). The
// real DatabaseService, controllers, services, security guard, audit
// interceptor, Turnstile verifier and QoreID adapter run; only the outbound
// boundaries are local stubs (Cloudflare Siteverify, the QoreID HTTP API,
// notification delivery). No network or cloud call is made. All values are
// synthetic. A Novu rewrite of main's verifier of the same name: the
// activation answers a staff session (P71, owner decision 2: a password, no
// authenticator), the gate (provider_self_service_enabled), the platform
// daily QoreID cap, the 24-hour lapse and support's review are added.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHmac, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
const rehearsal = Boolean(socket?.startsWith('/tmp/hid-tuf-migration.')) && process.env.PGDATABASE === 'hid_rehearsal';
const loopback = process.env.HID_PROVIDER_RUNTIME_LOCAL_CLUSTER === 'loopback'
  && ['127.0.0.1', '::1', 'localhost'].includes(socket ?? '')
  && /^[a-z][a-z0-9_]{0,40}$/.test(process.env.PGDATABASE ?? '');
assert(process.env.NODE_ENV === 'test' && (rehearsal || loopback),
  'Only the owned synthetic rehearsal or an explicitly named loopback test cluster is supported');
assert(process.env.OTP_HMAC_KEY_B64, 'The rehearsal OTP HMAC key is required to check keyed network digests');
assert(process.env.AUTH_SIGNING_SECRET && process.env.AUTH_LOGIN_PEPPER, 'Synthetic session keys are required');
const port = Number(process.env.PGPORT ?? 5432);
// Run in a disposable copy so synthetic organizations, quota counters, the
// opened control and the enabled QoreID provider never leak into later steps.
const isolated = `${rehearsal ? 'hid_rehearsal' : process.env.PGDATABASE}_provider_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
// Production hosts: the portal (app.*) is the only host Turnstile accepts the
// provider-enrollment action on; staff sign in on ehr.*, administrators on admin.*.
const origin = 'https://app.healthidentitydirectory.com';
const ehrOrigin = 'https://ehr.healthidentitydirectory.com';
const adminOrigin = 'https://admin.healthidentitydirectory.com';
const runtimeOptions = `options=${encodeURIComponent('-c role=hid_identity_api_runtime')}`;
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'production',
  NIN_PROVIDER_MODE: 'unavailable', CORS_ORIGINS: [origin, ehrOrigin, adminOrigin].join(','),
  IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'public-synthetic-ehr-workload-token',
  TURNSTILE_MODE: 'required', TURNSTILE_SECRET_KEY: 'example-turnstile-secret',
  QOREID_ENABLED: 'true', QOREID_CLIENT_ID: 'example-qoreid-client',
  QOREID_CLIENT_SECRET: 'example-qoreid-secret', DATABASE_SSL: 'false', AUTH_MODE: 'local',
  // Every Identity API connection runs as the deployed runtime role.
  DATABASE_URL: rehearsal
    ? `postgresql://${process.env.PGUSER ?? 'postgres'}@localhost:${port}/${isolated}?host=${encodeURIComponent(socket)}&${runtimeOptions}`
    : `postgresql://${process.env.PGUSER ?? 'postgres'}@${socket === '::1' ? '[::1]' : socket}:${port}/${isolated}?${runtimeOptions}`,
  // As in main.ts: only the loopback test client is a trusted reverse proxy, so
  // X-Forwarded-For carries the server-observed client address.
  TRUST_PROXY_CIDRS: '127.0.0.1/32,::1/128' });
// The code default applies (200 lookups a day across every self sign-up).
for (const key of ['AUTH_COOKIE_DOMAIN', 'PROVIDER_SELF_SERVICE_QOREID_DAILY_CAP', 'NIN_LOOKUP_HMAC_KEY_B64',
  'NIN_ENCRYPTION_KEY_B64', 'METAMAP_CLIENT_ID', 'METAMAP_CLIENT_SECRET', 'QOREID_API_KEY',
  'DATABASE_SSL_ROOT_CERT_BASE64']) delete process.env[key];
require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const load = path => require(join(service, 'src', path));
const { Pool } = require('pg');
const argon2 = require('argon2');
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
const { AdminSelfServiceFacilitiesController } = load('identity/self-service-facilities.controller.ts');
const { SelfServiceFacilitiesService } = load('identity/self-service-facilities.service.ts');
const { AdminController } = load('admin/admin.controller.ts');
const { AdminService } = load('admin/admin.service.ts');
const { AdminOperationsService } = load('admin/admin-operations.service.ts');
const { PricingService } = load('admin/pricing.service.ts');
const { EmergencyContactProtector } = load('patient-safety/emergency-contact-protector.ts');
const { QoreIdVerificationAdapter, QOREID_ADAPTER_CONFIGURATION, QOREID_FETCH } =
  load('identity/qoreid-verification.adapter.ts');
const { CorrelationMiddleware } = load('common/correlation.middleware.ts');
const { preventResponseCaching } = load('common/response-security.middleware.ts');
const { DomainProblem, ProblemDetailsFilter } = load('common/problem.ts');
const { getEnvironment } = load('config/environment.ts');
assert.equal(getEnvironment().PROVIDER_SELF_SERVICE_QOREID_DAILY_CAP, 200, 'The code default cap must apply');

// Cloudflare Siteverify stub. A token encodes the outcome the real service
// would return: `ok|<action>|<hostname>|<n>` or `replayed`. As at Cloudflare, a
// token verifies once: verifying it again under another idempotency key
// answers timeout-or-duplicate, and a retry under the same key repeats the
// first answer. Any other outbound request fails the verifier.
const siteverifyUrl = getEnvironment().TURNSTILE_SITEVERIFY_URL;
const siteverifyRequests = [];
const verifiedTokens = new Map();
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  assert.equal(url, siteverifyUrl, `Unexpected outbound request to ${url}`);
  const body = JSON.parse(String(init?.body));
  assert.equal(body.secret, 'example-turnstile-secret');
  siteverifyRequests.push(body.response);
  const earlier = verifiedTokens.get(body.response);
  if (earlier) {
    return Response.json(earlier.key === body.idempotency_key
      ? earlier.answer : { success: false, 'error-codes': ['timeout-or-duplicate'] });
  }
  const [kind, action, hostname] = String(body.response).split('|');
  const answer = kind === 'ok' ? { success: true, action, hostname } : { success: false, 'error-codes': ['timeout-or-duplicate'] };
  verifiedTokens.set(body.response, { key: body.idempotency_key, answer });
  return Response.json(answer);
};
let issuedTokens = 0;
const turnstile = (action = 'provider-enrollment', host = new URL(origin).hostname) =>
  `ok|${action}|${host}|${++issuedTokens}`;

// QoreID HTTP stub behind the real adapter. NOT_VERIFIED returns a negative
// registry check; SPARSE returns a verified lookup with the sparse legal
// profile the QoreID sandbox returned for RC and BN numbers
// (QOREID_VERIFICATION_CONTRACT.md); INACTIVE returns a verified lookup with
// every legal field but a registry status that is not active; every other
// number returns a complete verified CAC record.
const NOT_VERIFIED = 'RC9900063299';
const SPARSE = 'RC9900063298';
const INACTIVE = 'RC9900063297';
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
  if (regNumber === SPARSE) {
    return new Response(JSON.stringify({ id: 990000 + qoreidCacLookups.length, summary: { cac_check: 'verified' },
      status: { state: 'complete', status: 'verified' },
      cac: { rcNumber: '', companyName: '', companyType: '', registrationDate: '', status: '',
        address: '2 Synthetic Registry Road, Lagos' },
      metadata: { companyType: 'Private Company Limited by Shares' } }), { status: 200 });
  }
  if (regNumber === INACTIVE) {
    return new Response(JSON.stringify({ id: 990000 + qoreidCacLookups.length, summary: { cac_check: 'verified' },
      status: { state: 'complete', status: 'verified' },
      cac: { rcNumber: regNumber.replace(/^(RC|BN|IT)/, ''), companyName: `Runtime Clinic ${regNumber} Ltd`,
        companyType: 'Private Company Limited by Shares', registrationDate: '01-Jan-21',
        headOfficeAddress: '3 Synthetic Registry Road, Lagos', status: 'Inactive' } }), { status: 200 });
  }
  return new Response(JSON.stringify({ id: 990000 + qoreidCacLookups.length, summary: { cac_check: 'verified' },
    status: { state: 'complete', status: 'verified' },
    cac: { rcNumber: regNumber.replace(/^(RC|BN|IT)/, ''), companyName: `Runtime Clinic ${regNumber} Ltd`,
      companyType: 'Private Company Limited by Shares', registrationDate: '01-Jan-21',
      headOfficeAddress: '1 Synthetic Registry Road, Lagos', status: 'Active' } }), { status: 200 });
};

// The digests the Identity API must store, keyed with the server-only OTP HMAC
// key, never the address: the CAC lookup's client network (IPv4 address or
// IPv6 /64) and the public application quota's client address.
const networkKey = Buffer.from(process.env.OTP_HMAC_KEY_B64, 'base64');
const digest = network => createHmac('sha256', networkKey)
  .update('provider-self-service-cac-network\0', 'utf8').update(network, 'utf8').digest('hex');
const applicationDigest = address => createHmac('sha256', networkKey)
  .update('organization-profile-completion\0').update('ip').update('\0').update(address).digest('hex');

const maintenance = new Pool({ host: socket, port, user: process.env.PGUSER, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
// Fixture and assertion connection (database owner), never used by the API.
const owner = new Pool({ host: socket, port, user: process.env.PGUSER, database: isolated, max: 3 });
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
  const module = await Test.createTestingModule({
    controllers: [AuthController, ProviderEnrollmentController, AdminOrganizationApplicationsController,
      AdminSelfServiceFacilitiesController, AdminController],
    providers: [DatabaseService, TokenService, LocalAuthProvider,
      CurrentStaffContextService, CurrentPatientContextService, AuthService, AuthSessionAuditService,
      AuditService, WorkloadAuthService, TurnstileService, IntegrationRuntimeService,
      ProviderEnrollmentService, OrganizationProfileCompletionService, OrganizationApplicationsService,
      SelfServiceFacilitiesService, AdminService, AdminOperationsService, PricingService, EmergencyContactProtector,
      QoreIdVerificationAdapter,
      { provide: QOREID_ADAPTER_CONFIGURATION, useValue: { baseUrl: 'https://api.qoreid.com',
        clientId: 'example-qoreid-client', clientSecret: 'example-qoreid-secret', timeoutMs: 2000 } },
      { provide: QOREID_FETCH, useValue: qoreidFetch },
      { provide: NotificationOtpClient, useValue: notification },
      { provide: GoogleAuthenticationService, useValue: {
        login: async () => { throw new Error('Google exchange is outside the provider-enrollment verifier'); },
      } }] }).compile();
  const runtimeRole = (await module.get(DatabaseService).query('select current_user as role')).rows[0].role;
  assert.equal(runtimeRole, 'hid_identity_api_runtime');
  app = module.createNestApplication({ logger: false, bodyParser: true });
  app.getHttpAdapter().getInstance().set('trust proxy',
    getEnvironment().TRUST_PROXY_CIDRS.split(',').map(cidr => cidr.trim()));
  app.setGlobalPrefix('api/v1');
  // The middleware, validation, filter, guard and interceptor main.ts and AppModule install.
  app.use(preventResponseCaching);
  app.use(require('cookie-parser')());
  const correlation = new CorrelationMiddleware();
  app.use((req, res, next) => correlation.use(req, res, next));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
    exceptionFactory: errors => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
      errors.map(error => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalGuards(new SecurityGuard(module.get(Reflector), module.get(TokenService),
    module.get(AuditService), module.get(DatabaseService), module.get(WorkloadAuthService)));
  app.useGlobalInterceptors(new AuditInterceptor(module.get(Reflector), module.get(AuditService)));
  await app.init();
  const http = request(app.getHttpServer());
  const completion = module.get(OrganizationProfileCompletionService);
  const cookieName = getEnvironment().AUTH_COOKIE_NAME;
  const setCookies = response => response.headers['set-cookie'] ?? [];
  const cookies = response => setCookies(response).map(value => value.split(';')[0]);
  const header = list => list.join('; ');
  const enrollment = input => ({ productCode: 'ehr', organizationType: 'clinic',
    administratorName: 'Synthetic Provider Admin', turnstileAction: 'provider-enrollment',
    turnstileToken: turnstile(), ...input });
  const MAIN = '198.51.100.10';
  const ENROLL = '/api/v1/identity/provider-enrollments';
  const start = (body, network = MAIN, extra = {}) => {
    let call = http.post(ENROLL).set('Origin', origin).set('X-Forwarded-For', network);
    for (const [name, value] of Object.entries(extra)) call = call.set(name, value);
    return call.send(body);
  };
  const verify = (body, extra = {}) => {
    let call = http.post(`${ENROLL}/verify`).set('Origin', origin);
    for (const [name, value] of Object.entries(extra)) call = call.set(name, value);
    return call.send(body);
  };
  const activate = (enrollmentCookie, password, extra = {}) => {
    let call = http.post(`${ENROLL}/activate`).set('Origin', origin);
    if (enrollmentCookie) call = call.set('Cookie', enrollmentCookie);
    for (const [name, value] of Object.entries(extra)) call = call.set(name, value);
    return call.send({ password });
  };
  const availability = async () => {
    const response = await http.get(`${ENROLL}/availability`);
    assert.equal(response.status, 200, `availability: ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const expectProblem = (response, status, code) => {
    assert.equal(response.status, status, `${code}: ${JSON.stringify(response.body)}`);
    if (code) assert.equal(response.body.code, code, JSON.stringify(response.body));
  };
  const codeFor = async challengeId => { await completion.settleDeliveries(); return codes.get(challengeId); };
  const application = async (cac, emailFilter) => (await owner.query(`select id, status, verification_result,
      approval_mode from identity.organization_applications where cac_registration_number=$1
      and ($2::text is null or administrator_email=$2) order by created_at desc limit 1`, [cac, emailFilter ?? null])).rows[0];
  const count = async (sql, values = []) => (await owner.query(sql, values)).rows[0].n;
  // Every charge to the network in this run, whichever hour or day bucket it
  // landed in. The isolated database holds no charges from other runs.
  const networkCounters = async network => Object.fromEntries((await owner.query(
    `select bucket_period, sum(attempt_count)::int as attempt_count
       from platform.self_service_cac_quota_counters
      where network_digest=$1 group by bucket_period`,
    [digest(network)])).rows.map(row => [row.bucket_period, row.attempt_count]));
  const applicationCharges = async address => Object.fromEntries((await owner.query(
    `select bucket_period, sum(attempt_count)::int as attempt_count
       from platform.public_application_quota_counters
      where network_digest=$1 group by bucket_period`,
    [applicationDigest(address)])).rows.map(row => [row.bucket_period, row.attempt_count]));
  const email = label => `provider-${label}-${randomUUID().slice(0, 8)}@example.invalid`;
  const password = 'Synthetic-Provider-Password-2026';
  const gate = {};
  const security = {};
  const quota = {};
  const session = {};
  const lapse = {};
  const review = {};

  // 0. The gate ships closed (0086 seeds provider_self_service_enabled off):
  // availability is false and every route answers 423 after its own request
  // checks. Start checks it after Turnstile; nothing is written or charged.
  assert.deepEqual(await availability(), { open: false });
  const closedCac = 'RC9900063200';
  const startFailures = () => count(`select count(*)::int n from audit.events
    where action='api.identity.provider-enrollment.start' and outcome='failure'`);
  const startFailuresBefore = await startFailures();
  const siteverifyBeforeClosed = siteverifyRequests.length;
  expectProblem(await start(enrollment({ cacRegistrationNumber: closedCac, administratorEmail: email('closed') }),
    '198.51.100.90'), 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
  assert.equal(siteverifyRequests.length, siteverifyBeforeClosed + 1, 'The closed start did not verify Turnstile first');
  expectProblem(await verify({ challengeId: randomUUID(), code: '000000' }), 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
  expectProblem(await activate(undefined, 'xxxxxxxxxxxx'), 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
  expectProblem(await activate('hid_provider_enrollment=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'xxxxxxxxxxxx'),
    423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
  // Request checks still come first while closed (C6): DTO, Origin, signed-in browser.
  expectProblem(await verify({ challengeId: 'not-a-uuid', code: '000000' }), 400, 'VALIDATION_FAILED');
  expectProblem(await http.post(`${ENROLL}/verify`).send({ challengeId: randomUUID(), code: '000000' }), 403, 'ORIGIN_DENIED');
  expectProblem(await activate(undefined, 'xxxxxxxxxxxx', { Cookie: `${cookieName}_csrf=x` }),
    409, 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT');
  assert.equal(qoreidCacLookups.length, 0, 'A closed gate reached QoreID');
  assert.equal(await count('select count(*)::int n from identity.organization_applications'), 0, 'A closed gate wrote an application');
  assert.equal(await count('select count(*)::int n from platform.public_application_quota_counters'), 0, 'A closed gate charged the application quota');
  assert.equal(await startFailures(), startFailuresBefore + 1, 'The closed start was not audited as the request failure (C7)');
  gate.closed = { availability: false, start: 423, verify: 423, activate: 423, turnstileBeforeGate: true,
    writes: 0, qoreidLookups: 0 };

  // A standalone platform administrator: a platform role, no staff record and
  // no facility membership (0064). It opens the control with the audited admin
  // command and later reviews the new facilities.
  const adminPassword = 'Synthetic-Platform-Admin-Password-2026';
  const adminHash = await argon2.hash(adminPassword, { type: argon2.argon2id });
  const standalone = async (label, roles) => {
    const accountId = randomUUID();
    const adminEmail = `platform-${label}-${accountId.slice(0, 8)}@example.invalid`;
    await owner.query(`insert into auth.accounts (id, subject, email, display_name, password_hash, password_algorithm, status)
      values ($1, $2, $3, $4, $5, 'argon2id', 'active')`,
    [accountId, `synthetic:platform-admin:${accountId}`, adminEmail, `Synthetic ${label}`, adminHash]);
    for (const role of roles) {
      await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
        values ($1, $2, $3, 'platform', 'Synthetic standalone platform administrator for the runtime verifier')`,
      [randomUUID(), accountId, role]);
    }
    assert.equal(await count(`select (select count(*) from identity.staff where account_id=$1)
      + (select count(*) from identity.staff_facility_memberships where account_id=$1) as n`, [accountId]), '0');
    const signedIn = await http.post('/api/v1/auth/login').set('Origin', adminOrigin)
      .send({ email: adminEmail, password: adminPassword, turnstileAction: 'admin-login',
        turnstileToken: turnstile('admin-login', new URL(adminOrigin).hostname) });
    assert.equal(signedIn.status, 200, `platform sign-in failed: ${JSON.stringify(signedIn.body)}`);
    assert.deepEqual(signedIn.body.actor.facilities, [], 'The standalone administrator holds a facility');
    return { accountId, email: adminEmail, cookie: header(cookies(signedIn)), csrf: signedIn.headers['x-csrf-token'] };
  };
  const adminGet = (who, path) => http.get(`/api/v1${path}`).set('Cookie', who.cookie);
  const adminPost = (who, path, body, extra = {}) => {
    let call = http.post(`/api/v1${path}`).set('Cookie', who.cookie).set('Origin', adminOrigin)
      .set('x-csrf-token', who.csrf);
    for (const [name, value] of Object.entries(extra)) call = call.set(name, value);
    return call.send(body);
  };
  const superAdmin = await standalone('super', ['platform_super_admin']);
  const controls = await adminGet(superAdmin, '/admin/controls');
  assert.equal(controls.status, 200, `controls: ${JSON.stringify(controls.body)}`);
  const seeded = controls.body.find(control => control.controlKey === 'provider_self_service_enabled');
  assert.deepEqual({ ...seeded, updatedAt: undefined }, { controlKey: 'provider_self_service_enabled', enabled: false,
    reason: 'Facility self sign-up ships closed (P4); enable by audited admin command', version: 1, updatedAt: undefined });
  const openReason = 'Open facility self sign-up (D14) for the runtime verifier';
  expectProblem(await adminPost(superAdmin, '/admin/controls',
    { controlKey: 'provider_self_service_enabled', enabled: true, reason: openReason }, { 'If-Match': '"7"' }),
  409, 'VERSION_CONFLICT');
  const opened = await adminPost(superAdmin, '/admin/controls',
    { controlKey: 'provider_self_service_enabled', enabled: true, reason: openReason }, { 'If-Match': '"1"' });
  assert.equal(opened.status, 201, `opening the control failed: ${JSON.stringify(opened.body)}`);
  assert.deepEqual(opened.body, { controlKey: 'provider_self_service_enabled', enabled: true, version: 2, replayed: false });
  assert.equal(await count(`select count(*)::int n from audit.events where action='admin.platform-control.change'
    and actor_account_id=$1`, [superAdmin.accountId]), 1, 'Opening the control was not audited');
  assert.deepEqual(await availability(), { open: true });
  // A13: the gate also needs the provider portal on and maintenance off, which
  // the security guard does not enforce on these public routes.
  const setControl = async (controlKey, enabled, version) => {
    const changed = await adminPost(superAdmin, '/admin/controls',
      { controlKey, enabled, reason: `Runtime verifier: ${controlKey} ${enabled ? 'on' : 'off'}` },
      { 'If-Match': `"${version}"` });
    assert.equal(changed.status, 201, `${controlKey}: ${JSON.stringify(changed.body)}`);
  };
  for (const [controlKey, closing] of [['maintenance_mode', true], ['provider_portal_enabled', false]]) {
    await setControl(controlKey, closing, 1);
    assert.deepEqual(await availability(), { open: false }, `${controlKey} did not close availability`);
    expectProblem(await verify({ challengeId: randomUUID(), code: '000000' }), 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
    expectProblem(await start(enrollment({ cacRegistrationNumber: closedCac, administratorEmail: email('closed') }),
      '198.51.100.90'), 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
    await setControl(controlKey, !closing, 2);
  }
  assert.deepEqual(await availability(), { open: true });
  assert.equal(await count('select count(*)::int n from identity.organization_applications'), 0, 'A closed gate wrote an application');
  gate.a13 = { maintenance_mode_on: 423, provider_portal_off: 423 };
  gate.opened = { by: 'standalone platform_super_admin', command: 'POST /admin/controls', staleVersion: 409,
    version: 2, availability: true };

  // 2-3, 6, 19-20. Origin, Turnstile and CAC format are refused before any
  // application is written or QoreID is contacted.
  const cacA = 'RC9900063201'; const emailA = email('a');
  expectProblem(await http.post(ENROLL).set('X-Forwarded-For', MAIN)
    .send(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA })), 403, 'ORIGIN_DENIED');
  security.origin = 'ORIGIN_DENIED';
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA,
    turnstileAction: 'staff-login' })), 400, 'VALIDATION_FAILED');
  security.turnstile_action_in_body = 'VALIDATION_FAILED';
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA,
    turnstileToken: turnstile('patient-enrollment') })), 403, 'TURNSTILE_ACTION_MISMATCH');
  security.turnstile_action_mismatch = 'TURNSTILE_ACTION_MISMATCH';
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA,
    turnstileToken: turnstile('provider-enrollment', 'www.healthidentitydirectory.com') })), 403, 'TURNSTILE_HOSTNAME_MISMATCH');
  security.turnstile_hostname_mismatch = 'TURNSTILE_HOSTNAME_MISMATCH';
  expectProblem(await http.post(ENROLL).set('Origin', ehrOrigin).set('X-Forwarded-For', MAIN)
    .send(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA,
      turnstileToken: turnstile('provider-enrollment', 'ehr.healthidentitydirectory.com') })), 403, 'TURNSTILE_CONTEXT_MISMATCH');
  security.product_host = 'TURNSTILE_CONTEXT_MISMATCH';
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA,
    turnstileToken: 'replayed' })), 403, 'TURNSTILE_EXPIRED_OR_REPLAYED');
  security.turnstile_replay = 'TURNSTILE_EXPIRED_OR_REPLAYED';
  for (const malformed of ['XX12', 'RC12', 'RC12345678901234567890123']) {
    expectProblem(await start(enrollment({ cacRegistrationNumber: malformed, administratorEmail: emailA })),
      400, 'VALIDATION_FAILED');
  }
  security.malformed_cac = 'VALIDATION_FAILED';
  assert.equal(qoreidCacLookups.length, 0, 'A refused request reached QoreID');
  assert.equal(await count('select count(*)::int n from identity.organization_applications'), 0,
    'A refused request created an application');
  assert.deepEqual(await applicationCharges(MAIN), {}, 'A refused request charged the application quota');

  // 4, 7. A registry-rejected CAC reaches QoreID through the accountless quota
  // and returns the application error; the application stays unverified.
  const emailRejected = email('rejected');
  expectProblem(await start(enrollment({ cacRegistrationNumber: NOT_VERIFIED, administratorEmail: emailRejected })),
    422, 'CAC_NOT_VERIFIED');
  assert.deepEqual(qoreidCacLookups, [NOT_VERIFIED]);
  assert.deepEqual({ ...(await application(NOT_VERIFIED)), id: undefined }, { id: undefined,
    status: 'pending_verification', verification_result: 'not_verified', approval_mode: 'self_service' });
  security.qoreid_rejected_cac = 'CAC_NOT_VERIFIED';

  // 1, 4-5, 9. A valid CAC reaches QoreID, is recorded as verified, and the
  // emailed code is sent. The lookup is charged to the keyed client network,
  // and each start charges the public application quota once (A7, C8).
  const started = await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA }));
  assert.equal(started.status, 200, `start failed: ${JSON.stringify(started.body)}`);
  assert.equal(started.body.accepted, true);
  assert.equal(started.body.expiresInSeconds, 600);
  assert.equal(started.body.resendAfterSeconds, 60);
  assert.deepEqual(qoreidCacLookups, [NOT_VERIFIED, cacA]);
  assert(qoreidTokens >= 1, 'The QoreID adapter did not authenticate');
  const challengeId = started.body.challengeId;
  assert.match(challengeId, /^[0-9a-f-]{36}$/);
  assert(await codeFor(challengeId), 'The email OTP was not delivered for the started challenge');
  assert.equal(recipients.at(-1), emailA);
  assert.deepEqual({ ...(await application(cacA)), id: undefined }, { id: undefined, status: 'ready_for_review',
    verification_result: 'verified', approval_mode: 'self_service' });
  assert.deepEqual(await networkCounters(MAIN), { hour: 2, day: 2 });
  assert.deepEqual(await applicationCharges(MAIN), { hour: 2, day: 2 }, 'A start must charge the application quota exactly once');
  quota.public_application_quota_per_start = 1;

  // 9-10. Wrong code fails; the emailed code verifies and sets the enrollment cookie.
  const wrongCode = (await codeFor(challengeId)) === '000000' ? '111111' : '000000';
  expectProblem(await verify({ challengeId, code: wrongCode }), 401, 'ORGANIZATION_COMPLETION_CODE_INVALID');
  security.wrong_otp = 'ORGANIZATION_COMPLETION_CODE_INVALID';
  const verified = await verify({ challengeId, code: await codeFor(challengeId) });
  assert.equal(verified.status, 200, `verify failed: ${JSON.stringify(verified.body)}`);
  assert.deepEqual(verified.body, { verified: true });
  const enrollmentSetCookie = setCookies(verified).find(value => value.startsWith('hid_provider_enrollment='));
  assert(enrollmentSetCookie, 'OTP verification did not set the enrollment cookie');
  for (const attribute of [/; Max-Age=3600/i, /; Path=\/api\/v1\/identity\/provider-enrollments/i, /; HttpOnly/i,
    /; Secure/i, /; SameSite=Strict/i]) assert.match(enrollmentSetCookie, attribute);
  assert.doesNotMatch(enrollmentSetCookie, /; Domain=/i);
  const enrollmentCookie = enrollmentSetCookie.split(';')[0];

  // 12-16. Activation creates the organization, facility, EHR product, account
  // and org-admin membership, and signs the administrator in with the
  // password (P71; owner decision 2): the three session cookies, x-csrf-token
  // and the actor. hid_enrollment is left alone; the enrollment cookie is cleared.
  expectProblem(await activate(undefined, password), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  const activated = await activate(`${enrollmentCookie}; hid_enrollment=synthetic-patient-enrollment`, password);
  assert.equal(activated.status, 200, `activation failed: ${JSON.stringify(activated.body)}`);
  assert.deepEqual(Object.keys(activated.body).sort(),
    ['accountId', 'activated', 'actor', 'expiresAt', 'facilityId', 'organizationId']);
  assert.equal(activated.body.activated, true);
  assert.equal(activated.body.status, undefined, 'Activation answered an MFA status');
  const { organizationId, facilityId, accountId } = activated.body;
  assert.equal(activated.body.actor.accountId, accountId);
  assert.notEqual(activated.body.actor.kind, 'patient');
  assert.deepEqual(activated.body.actor.facilityIds, [facilityId]);
  assert(Date.parse(activated.body.expiresAt) > Date.now(), 'Activation answered an expired session');
  assert.match(activated.headers['cache-control'] ?? '', /no-store/);
  const csrfHeader = activated.headers['x-csrf-token'];
  assert.match(csrfHeader ?? '', /.+/, 'Activation returned no CSRF token');
  const activationSetCookies = setCookies(activated);
  const sessionCookie = name => activationSetCookies.find(value => value.startsWith(`${name}=`));
  for (const [name, path, httpOnly] of [[cookieName, '/', true], [`${cookieName}_refresh`, '/api/v1/auth', true],
    [`${cookieName}_csrf`, '/', false]]) {
    const value = sessionCookie(name);
    assert(value, `Activation did not set ${name}`);
    assert.match(value, new RegExp(`; Path=${path.replaceAll('/', '\\/')}(;|$)`, 'i'));
    assert.match(value, /; Secure/i); assert.match(value, /; SameSite=Strict/i); assert.doesNotMatch(value, /; Domain=/i);
    assert.equal(/; HttpOnly/i.test(value), httpOnly, `${name} HttpOnly`);
  }
  assert.match(sessionCookie('hid_provider_enrollment') ?? '', /^hid_provider_enrollment=;.*Expires=Thu, 01 Jan 1970/i,
    'Activation did not clear the enrollment cookie');
  assert(!activationSetCookies.some(value => value.startsWith('hid_enrollment=')), 'Activation touched hid_enrollment');
  assert(!activationSetCookies.some(value => value.startsWith(`${cookieName}_mfa=`)), 'Activation opened an MFA step');
  assert.equal(sessionCookie(`${cookieName}_csrf`).split(';')[0].split('=')[1], csrfHeader);
  const created = (await owner.query(`
    select o.name organization, f.lifecycle_status facility_status, f.active facility_active,
      p.product_code product, a.email, a.status account_status, a.email_verified_at is not null email_verified,
      a.password_changed_at is not null password_set, a.password_algorithm, s.default_role staff_role,
      s.verification_status staff_status, m.membership_role, m.active membership_active, r.role_code,
      app.status application_status, app.reviewed_by_account_id reviewer, app.facility_id = f.id application_facility,
      app.self_service_reviewed_at support_review,
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
    facility_active: true, product: 'ehr', email: emailA, account_status: 'active', email_verified: true,
    password_set: true, password_algorithm: 'argon2id', staff_role: 'org_admin', staff_status: 'verified',
    membership_role: 'org_admin', membership_active: true, role_code: 'org_admin',
    application_status: 'approved', reviewer: null, application_facility: true, support_review: null, cac_bindings: 1 }]);
  assert.equal(await count(`select count(*)::int n from audit.events where action='identity.organization.self-service.activate'
    and organization_id=$1`, [organizationId]), 1);

  // 17. The session works: GET /auth/session, POST /auth/facility, and a fresh
  // POST /auth/login with the password on the EHR host (where staff sign in next time).
  const sessionHeader = header(activationSetCookies.filter(value => value.startsWith(`${cookieName}`)).map(value => value.split(';')[0]));
  const current = await http.get('/api/v1/auth/session').set('Cookie', sessionHeader);
  assert.equal(current.status, 200, `session failed: ${JSON.stringify(current.body)}`);
  assert.equal(current.body.actor.accountId, accountId);
  assert.equal(current.headers['x-csrf-token'], csrfHeader);
  const selected = await http.post('/api/v1/auth/facility').set('Cookie', sessionHeader).set('Origin', origin)
    .set('x-csrf-token', csrfHeader).send({ facilityId });
  assert.equal(selected.status, 200, `facility selection failed: ${JSON.stringify(selected.body)}`);
  assert.equal(selected.body.actor.facility.id, facilityId);
  assert(selected.body.actor.permissions.includes('organization.manage'), 'The administrator lacks org_admin permissions');
  const login = await http.post('/api/v1/auth/login').set('Origin', ehrOrigin)
    .send({ email: emailA.toUpperCase(), password, turnstileAction: 'staff-login',
      turnstileToken: turnstile('staff-login', new URL(ehrOrigin).hostname) });
  assert.equal(login.status, 200, `fresh sign-in failed: ${JSON.stringify(login.body)}`);
  assert.equal(login.body.actor.accountId, accountId);
  expectProblem(await http.post('/api/v1/auth/login').set('Origin', ehrOrigin)
    .send({ email: emailA, password: 'Wrong-Provider-Password-2026', turnstileAction: 'staff-login',
      turnstileToken: turnstile('staff-login', new URL(ehrOrigin).hostname) }), 401);
  session.activation = { cookies: [cookieName, `${cookieName}_refresh`, `${cookieName}_csrf`], csrfHeader: true,
    actor: true, hidEnrollmentCleared: false, enrollmentCookieCleared: true, mfa: false };
  session.after = ['GET /auth/session 200', 'POST /auth/facility 200', 'POST /auth/login (ehr.*, password) 200'];

  // 18. A signed-in caller cannot use the accountless flow.
  const cacB = 'RC9900063202'; const emailB = email('b');
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacB, administratorEmail: emailB }), MAIN,
    { Cookie: sessionHeader }), 409, 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT');
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacB, administratorEmail: emailB }), MAIN,
    { Cookie: `${cookieName}_csrf=${csrfHeader}` }), 409, 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT');
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacB, administratorEmail: emailB }), MAIN,
    { Authorization: 'Bearer synthetic' }), 409, 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT');
  security.signed_in_caller = 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT';

  // The consumed enrollment session cannot activate again.
  expectProblem(await activate(enrollmentCookie, password), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  security.replayed_activation = 'ORGANIZATION_COMPLETION_SESSION_INVALID';

  // 8 (#81). A registered CAC is sent to review, for its own or another
  // administrator email, without a new registry lookup or a quota charge.
  const lookupsBeforeDuplicate = qoreidCacLookups.length;
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA })),
    409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW');
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: email('c') })),
    409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW');
  assert.equal(qoreidCacLookups.length, lookupsBeforeDuplicate, 'A duplicate CAC reached QoreID');
  assert.deepEqual(await applicationCharges(MAIN), { hour: 2, day: 2 }, 'A refused submit charged the application quota');
  security.duplicate_cac = 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW';

  // #81. A verified CAC whose record is too sparse to register automatically
  // is answered 409 PROVIDER_CAC_PROFILE_INCOMPLETE with a detail the browser
  // can show. The one lookup is charged as before; nothing is recorded and no
  // email code is sent. The detail is also true for a complete record whose
  // company is not active, which gets the same answer.
  const profileIncompleteDetail = 'We could not register your organization automatically from its CAC record.'
    + ' The record is missing details we need or does not show the company as active.'
    + ' Contact Health ID support.';
  for (const [cac, network, label] of [[SPARSE, '198.51.100.20', 'sparse'], [INACTIVE, '198.51.100.22', 'inactive']]) {
    const lookupsBefore = qoreidCacLookups.length;
    const deliveriesBefore = recipients.length;
    const refused = await start(enrollment({ cacRegistrationNumber: cac, administratorEmail: email(label) }), network);
    expectProblem(refused, 409, 'PROVIDER_CAC_PROFILE_INCOMPLETE');
    assert.equal(refused.body.detail, profileIncompleteDetail);
    assert.deepEqual(qoreidCacLookups.slice(lookupsBefore), [cac]);
    await completion.settleDeliveries();
    assert.equal(recipients.length, deliveriesBefore, `A ${label} CAC record sent an email code`);
    assert.deepEqual({ ...(await application(cac)), id: undefined }, { id: undefined,
      status: 'pending_verification', verification_result: null, approval_mode: 'self_service' });
    assert.deepEqual(await networkCounters(network), { hour: 1, day: 1 });
    security[`${label}_cac`] = 'PROVIDER_CAC_PROFILE_INCOMPLETE';
  }

  // #81. An administrator email that already belongs to an account is refused
  // at activation, after the emailed code proved the mailbox, with 409
  // PROVIDER_EMAIL_ALREADY_REGISTERED; nothing is created or changed. Start
  // makes no account check, so it cannot be used to test an email.
  const TAKEN_NETWORK = '198.51.100.21';
  const cacTaken = 'RC9900063204';
  const startedTaken = await start(enrollment({ cacRegistrationNumber: cacTaken, administratorEmail: emailA }),
    TAKEN_NETWORK);
  assert.equal(startedTaken.status, 200, `start with a registered email failed: ${JSON.stringify(startedTaken.body)}`);
  const verifiedTaken = await verify({ challengeId: startedTaken.body.challengeId,
    code: await codeFor(startedTaken.body.challengeId) });
  assert.equal(verifiedTaken.status, 200, `verify with a registered email failed: ${JSON.stringify(verifiedTaken.body)}`);
  const takenCookie = cookies(verifiedTaken).find(value => value.startsWith('hid_provider_enrollment='));
  assert(takenCookie, 'OTP verification did not set the enrollment cookie');
  const footprint = async () => (await owner.query(`select
      (select count(*)::int from identity.organizations) organizations,
      (select count(*)::int from identity.facilities) facilities,
      (select count(*)::int from identity.organization_cac_registrations) cac_bindings,
      (select count(*)::int from identity.organization_products) products,
      (select count(*)::int from auth.accounts) accounts,
      (select count(*)::int from identity.staff) staff,
      (select count(*)::int from identity.staff_facility_memberships) memberships,
      (select count(*)::int from auth.account_roles) roles,
      (select count(*)::int from audit.events where action='identity.organization.self-service.activate') activations,
      (select password_hash from auth.accounts where id=$1) admin_password`, [accountId])).rows[0];
  const footprintBefore = await footprint();
  const refusedTaken = await activate(takenCookie, 'Synthetic-Provider-Password-2027');
  expectProblem(refusedTaken, 409, 'PROVIDER_EMAIL_ALREADY_REGISTERED');
  assert.equal(refusedTaken.body.detail, 'The administrator email is already associated with an HID account');
  assert(!cookies(refusedTaken).some(value => value.startsWith(cookieName)), 'A refused activation set a session cookie');
  assert.deepEqual(await footprint(), footprintBefore, 'A refused activation created or changed something');
  assert.deepEqual({ ...(await application(cacTaken)), id: undefined }, { id: undefined,
    status: 'ready_for_review', verification_result: 'verified', approval_mode: 'self_service' });
  security.activation_email_registered = 'PROVIDER_EMAIL_ALREADY_REGISTERED';

  // Owner Q8: a second product for an already registered CAC goes to review.
  // The pharmacy sign-up for cacA is a new application (its own product), is
  // verified and emailed, and its activation is refused 409
  // ORGANIZATION_REVIEW_REQUIRED (the CAC is already bound); nothing is created.
  const SECOND_PRODUCT_NETWORK = '198.51.100.24';
  const secondProduct = await start(enrollment({ productCode: 'pharmacy', organizationType: 'pharmacy',
    cacRegistrationNumber: cacA, administratorEmail: email('second-product') }), SECOND_PRODUCT_NETWORK);
  assert.equal(secondProduct.status, 200, `second product start failed: ${JSON.stringify(secondProduct.body)}`);
  assert.equal(qoreidCacLookups.at(-1), cacA);
  const secondVerified = await verify({ challengeId: secondProduct.body.challengeId,
    code: await codeFor(secondProduct.body.challengeId) });
  assert.equal(secondVerified.status, 200);
  const footprintBeforeSecond = await footprint();
  expectProblem(await activate(cookies(secondVerified).find(value => value.startsWith('hid_provider_enrollment=')),
    password), 409, 'ORGANIZATION_REVIEW_REQUIRED');
  assert.deepEqual(await footprint(), footprintBeforeSecond, 'A second product activation created or changed something');
  security.second_product_same_cac = 'ORGANIZATION_REVIEW_REQUIRED';

  // Start's race with the governed path: a governed organization application
  // for the same CAC and product holds the shared 'org-application:' lock
  // (A11). Start waits for it, then answers 409
  // PROVIDER_ENROLLMENT_REQUIRES_REVIEW, as a retry does, and makes no claim
  // about the email. Nothing reaches QoreID, no code is sent, nothing is charged.
  const cacRace = 'RC9900063205';
  const RACE_NETWORK = '198.51.100.23';
  const lookupsBeforeRace = qoreidCacLookups.length;
  const deliveriesBeforeRace = recipients.length;
  const governed = await owner.connect();
  let raced;
  try {
    await governed.query('begin');
    const governedPid = (await governed.query(`select pg_backend_pid() pid,
        set_config('app.actor_subject', 'system:auth', true), set_config('app.correlation_id', $1, true)`,
    [randomUUID()])).rows[0].pid;
    await governed.query(`select identity.submit_organization_application('ehr', 'clinic', $1,
      'Synthetic Governed Admin', $2)`, [cacRace, email('governed')]);
    raced = start(enrollment({ cacRegistrationNumber: cacRace, administratorEmail: email('race') }),
      RACE_NETWORK).then(response => response);
    const deadline = Date.now() + 10_000;
    while ((await owner.query('select count(*)::int n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
      [governedPid])).rows[0].n === 0) {
      assert(Date.now() < deadline, 'Start did not wait on the governed application');
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
    await governed.query('commit');
  } catch (error) {
    await governed.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    governed.release();
  }
  const racedStart = await raced;
  expectProblem(racedStart, 409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW');
  assert.doesNotMatch(JSON.stringify(racedStart.body), /email|account/i, 'A start conflict made an email claim');
  assert.deepEqual((await owner.query(`select approval_mode, status from identity.organization_applications
    where cac_registration_number=$1`, [cacRace])).rows, [{ approval_mode: 'admin_review', status: 'pending_verification' }]);
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacRace, administratorEmail: email('race') }),
    RACE_NETWORK), 409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW');
  assert.equal(qoreidCacLookups.length, lookupsBeforeRace, 'A start conflict reached QoreID');
  await completion.settleDeliveries();
  assert.equal(recipients.length, deliveriesBeforeRace, 'A start conflict sent an email code');
  assert.deepEqual(await applicationCharges(RACE_NETWORK), {}, 'A start conflict charged the application quota');
  security.start_governed_race = 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW';

  // 11 and the owner's second sitting. The first sitting verifies the email
  // and stops before the password. An expired code cannot verify, even with
  // the right digits. Starting again within the lapse window reuses the
  // verified evidence: no second QoreID lookup and no CAC quota charge, a new
  // code; the new session then activates.
  const startedB = await start(enrollment({ cacRegistrationNumber: cacB, administratorEmail: emailB }));
  assert.equal(startedB.status, 200, `second start failed: ${JSON.stringify(startedB.body)}`);
  assert.deepEqual(await networkCounters(MAIN), { hour: 3, day: 3 });
  const sittingOne = await verify({ challengeId: startedB.body.challengeId, code: await codeFor(startedB.body.challengeId) });
  assert.equal(sittingOne.status, 200, `first sitting verify failed: ${JSON.stringify(sittingOne.body)}`);
  const sittingOneCookie = cookies(sittingOne).find(value => value.startsWith('hid_provider_enrollment='));
  // Identity sends no new code within 60 seconds of the last one (0056); the
  // second sitting is later than that.
  await owner.query(`update identity.organization_profile_completion_challenges
    set created_at = created_at - interval '2 minutes'
    where application_id = (select id from identity.organization_applications where cac_registration_number=$1)`, [cacB]);
  const lookupsBeforeResume = qoreidCacLookups.length;
  const resumed = await start(enrollment({ cacRegistrationNumber: cacB, administratorEmail: emailB }));
  assert.equal(resumed.status, 200, `resume failed: ${JSON.stringify(resumed.body)}`);
  assert.notEqual(resumed.body.challengeId, startedB.body.challengeId);
  assert.equal(qoreidCacLookups.length, lookupsBeforeResume, 'Verified evidence was looked up again');
  assert.deepEqual(await networkCounters(MAIN), { hour: 3, day: 3 }, 'A resume charged the CAC lookup quota');
  assert.equal(recipients.at(-1), emailB);
  await owner.query("update identity.organization_profile_completion_challenges set expires_at=clock_timestamp()-interval '1 second' where id=$1",
    [resumed.body.challengeId]);
  expectProblem(await verify({ challengeId: resumed.body.challengeId, code: await codeFor(resumed.body.challengeId) }),
    401, 'ORGANIZATION_COMPLETION_CODE_INVALID');
  security.expired_otp = 'ORGANIZATION_COMPLETION_CODE_INVALID';
  await owner.query(`update identity.organization_profile_completion_challenges
    set created_at = created_at - interval '2 minutes'
    where application_id = (select id from identity.organization_applications where cac_registration_number=$1)`, [cacB]);
  const resumedAgain = await start(enrollment({ cacRegistrationNumber: cacB, administratorEmail: emailB }));
  assert.equal(resumedAgain.status, 200, `second resume failed: ${JSON.stringify(resumedAgain.body)}`);
  assert.equal(qoreidCacLookups.length, lookupsBeforeResume, 'Verified evidence was looked up again');
  const sittingTwo = await verify({ challengeId: resumedAgain.body.challengeId,
    code: await codeFor(resumedAgain.body.challengeId) });
  assert.equal(sittingTwo.status, 200, `second sitting verify failed: ${JSON.stringify(sittingTwo.body)}`);
  const sittingTwoCookie = cookies(sittingTwo).find(value => value.startsWith('hid_provider_enrollment='));
  const activatedB = await activate(sittingTwoCookie, password);
  assert.equal(activatedB.status, 200, `second sitting activation failed: ${JSON.stringify(activatedB.body)}`);
  assert.equal(activatedB.body.actor.accountId, activatedB.body.accountId);
  expectProblem(await activate(sittingOneCookie, password), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  assert.deepEqual(await applicationCharges(MAIN), { hour: 5, day: 5 }, 'Each start charges the application quota once');
  session.resume = { qoreidLookups: 0, cacQuotaCharged: false, newCode: true, activation: 200,
    firstSittingSessionAfterActivation: 401 };

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
  assert.doesNotMatch(JSON.stringify(networkLimited.body), /network|hour|digest|exhausted|counter|platform|203\.0\.113/i,
    'The public quota refusal exposed internal quota details');
  assert.deepEqual({ ...(await application('RC9900063306')), id: undefined }, { id: undefined,
    status: 'pending_verification', verification_result: null, approval_mode: 'self_service' });
  assert.deepEqual(await networkCounters(IPV4), { hour: 5, day: 5 });
  assert.equal(await count(`select count(*)::int n from audit.events
    where action='api.identity.provider-enrollment.start' and outcome='failure' and source_ip=$1::inet`, [IPV4]), 1,
  'The refused request was not audited with its server-observed address');
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

  // A8 with C9: an unactivated application holds its CAC and product for 24
  // hours. Within them another email is sent to review; after them the next
  // submit lapses it (rejected, reviewed_at, an 8+ character reason,
  // row_version bumped, its codes and sessions invalidated, audited) and opens
  // a new application, which then completes.
  const cacLapse = 'RC9900063601'; const emailSquatter = email('squatter'); const emailOwner = email('owner');
  const squatted = await start(enrollment({ cacRegistrationNumber: cacLapse, administratorEmail: emailSquatter }),
    '198.51.100.30');
  assert.equal(squatted.status, 200, `squatter start failed: ${JSON.stringify(squatted.body)}`);
  const squatterVerified = await verify({ challengeId: squatted.body.challengeId,
    code: await codeFor(squatted.body.challengeId) });
  assert.equal(squatterVerified.status, 200);
  const squatterCookie = cookies(squatterVerified).find(value => value.startsWith('hid_provider_enrollment='));
  const lookupsBeforeHeld = qoreidCacLookups.length;
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacLapse, administratorEmail: emailOwner }),
    '198.51.100.31'), 409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW');
  assert.equal(qoreidCacLookups.length, lookupsBeforeHeld);
  const stale = (await owner.query(`update identity.organization_applications
      set created_at = created_at - interval '25 hours'
    where cac_registration_number=$1 and administrator_email=$2 returning id, row_version`,
  [cacLapse, emailSquatter])).rows[0];
  const freed = await start(enrollment({ cacRegistrationNumber: cacLapse, administratorEmail: emailOwner }), '198.51.100.31');
  assert.equal(freed.status, 200, `start after the lapse failed: ${JSON.stringify(freed.body)}`);
  assert.equal(qoreidCacLookups.at(-1), cacLapse, 'The new application was not verified with QoreID');
  const lapsed = (await owner.query(`select status, reviewed_at is not null reviewed, review_reason, reviewed_by_account_id,
      row_version from identity.organization_applications where id=$1`, [stale.id])).rows[0];
  assert.deepEqual(lapsed, { status: 'rejected', reviewed: true,
    review_reason: 'Self-service application lapsed: not activated within 24 hours of submission',
    reviewed_by_account_id: null, row_version: String(Number(stale.row_version) + 1) });
  assert.equal(await count(`select count(*)::int n from identity.organization_profile_completion_challenges
    where application_id=$1 and invalidated_at is null`, [stale.id]), 0, 'The lapse left a code or session usable');
  const lapseAudit = (await owner.query(`select actor_type, outcome, details from audit.events
    where action='identity.organization.self-service.lapse' and resource_id=$1`, [stale.id])).rows;
  assert.deepEqual(lapseAudit, [{ actor_type: 'system', outcome: 'success',
    details: { productCode: 'ehr', previousStatus: 'ready_for_review', lapseAfterHours: 24 } }]);
  expectProblem(await activate(squatterCookie, password), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  const ownerVerified = await verify({ challengeId: freed.body.challengeId, code: await codeFor(freed.body.challengeId) });
  assert.equal(ownerVerified.status, 200);
  const activatedLapse = await activate(cookies(ownerVerified).find(value => value.startsWith('hid_provider_enrollment=')),
    password);
  assert.equal(activatedLapse.status, 200, `activation after the lapse failed: ${JSON.stringify(activatedLapse.body)}`);
  assert.equal((await owner.query('select name from identity.organizations where id=$1',
    [activatedLapse.body.organizationId])).rows[0].name, `Runtime Clinic ${cacLapse} Ltd`);
  lapse.window_hours = 24;
  lapse.within_window_other_email = 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW';
  lapse.after_window = { previous: 'rejected', challengesInvalidated: true, audited: true,
    previousSession: 401, newApplication: 'activated' };

  // A6 (owner, Q2): 200 accountless CAC lookups a day across every self
  // sign-up, the code default. The day's counter is set to 199: the next lookup
  // is admitted (the 200th) and the one after is refused before QoreID,
  // audited as platform_day, and charges no network.
  await owner.query(`insert into platform.self_service_cac_platform_quota_counters (bucket_start, attempt_count)
    values (date_trunc('day', statement_timestamp()), 199)
    on conflict (bucket_start) do update set attempt_count = 199`);
  const lastAdmitted = await start(enrollment({ cacRegistrationNumber: 'RC9900063701',
    administratorEmail: email('cap-200') }), '198.51.100.40');
  assert.equal(lastAdmitted.status, 200, `the 200th lookup was refused: ${JSON.stringify(lastAdmitted.body)}`);
  assert.equal(qoreidCacLookups.at(-1), 'RC9900063701');
  const lookupsBeforeCap = qoreidCacLookups.length;
  const capped = await start(enrollment({ cacRegistrationNumber: 'RC9900063702',
    administratorEmail: email('cap-201') }), '198.51.100.41');
  expectProblem(capped, 429, 'VERIFICATION_QUOTA_EXCEEDED');
  assert.doesNotMatch(JSON.stringify(capped.body), /platform|day|cap|200/i, 'The cap refusal exposed its limit');
  assert.equal(qoreidCacLookups.length, lookupsBeforeCap, 'A capped lookup reached QoreID');
  assert.deepEqual(await networkCounters('198.51.100.41'), {}, 'A capped lookup was charged to its network');
  assert.equal(await count(`select sum(attempt_count)::int n from platform.self_service_cac_platform_quota_counters
    where bucket_start = date_trunc('day', statement_timestamp())`), 200);
  const capAudit = (await owner.query(`select details from audit.events
    where action='identity.organization.self-service.cac-quota' and outcome='denied'
    order by sequence_id desc limit 1`)).rows[0].details;
  assert.equal(capAudit.exhaustedLimit, 'platform_day');
  assert.equal(capAudit.platformDailyLimit, 200);
  quota.platform_daily_cap = { limit: 200, admittedAt: 200, refusedAt: 201, status: 429, audited: 'platform_day' };

  // Every accountless quota decision is audited, without CAC, email or address.
  const decisions = (await owner.query(`select outcome, details from audit.events
    where action='identity.organization.self-service.cac-quota' order by sequence_id`)).rows;
  assert.equal(decisions.filter(row => row.outcome === 'success').length, qoreidCacLookups.length);
  assert.deepEqual(decisions.filter(row => row.outcome === 'denied').map(row => row.details.exhaustedLimit),
    ['application_day', 'network_hour', 'network_hour', 'platform_day']);
  assert(decisions.every(row => /^[a-f0-9]{64}$/.test(row.details.networkDigest) && row.details.platformDailyLimit === 200
    && !/RC99000|example\.invalid|203\.0\.113|198\.51\.100|2001:db8/.test(JSON.stringify(row.details))));
  quota.audited_decisions = decisions.length;

  // 22. The authenticated reviewer path is unchanged: a platform reviewer's
  // CAC check of a governed application is charged to the 0049 account quota,
  // not to any network or to the platform day. (Novu's governed admin commands
  // need the reviewer's facility membership, which this administrator holds.)
  await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
    values ($1, $2, 'platform_super_admin', 'platform', 'Synthetic platform reviewer for the runtime verifier')`,
  [randomUUID(), accountId]);
  const reviewed = (await owner.query(`insert into identity.organization_applications (product_code,
      organization_name, organization_type, cac_registration_number, administrator_name, administrator_email, status)
    values ('ehr', 'Reviewed Runtime Clinic', 'clinic', 'RC9900063501', 'Reviewed Applicant', $1, 'pending_verification')
    returning id, row_version`, [email('reviewed')])).rows[0];
  const networkRowsBefore = await count('select coalesce(sum(attempt_count),0)::int n from platform.self_service_cac_quota_counters');
  const platformDayBefore = await count('select coalesce(sum(attempt_count),0)::int n from platform.self_service_cac_platform_quota_counters');
  const reviewerLogin = await http.post('/api/v1/auth/login').set('Origin', adminOrigin)
    .send({ email: emailA, password, turnstileAction: 'admin-login',
      turnstileToken: turnstile('admin-login', new URL(adminOrigin).hostname) });
  assert.equal(reviewerLogin.status, 200, `reviewer sign-in failed: ${JSON.stringify(reviewerLogin.body)}`);
  const reviewer = { cookie: header(cookies(reviewerLogin)), csrf: reviewerLogin.headers['x-csrf-token'] };
  const verifiedByReviewer = await adminPost(reviewer, `/admin/organization-applications/${reviewed.id}/verify-cac`, {},
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
  assert.equal(await count('select coalesce(sum(attempt_count),0)::int n from platform.self_service_cac_quota_counters'),
    networkRowsBefore, 'The reviewer path charged a network quota');
  assert.equal(await count('select coalesce(sum(attempt_count),0)::int n from platform.self_service_cac_platform_quota_counters'),
    platformDayBefore, 'The reviewer path charged the platform day');
  quota.reviewer_path = 'account_quota_unchanged';

  // Owner guard (alert + daily review): every activated self-service facility
  // is listed for support, newest first, until a standalone platform
  // administrator (no facility membership) marks it reviewed at its version.
  const facilities = '/admin/self-service-facilities';
  const listed = await adminGet(superAdmin, facilities);
  assert.equal(listed.status, 200, `support list failed: ${JSON.stringify(listed.body)}`);
  assert.deepEqual(listed.body.items.map(item => item.facilityId),
    [activatedLapse.body.facilityId, activatedB.body.facilityId, facilityId], 'Newest activation first');
  const itemA = listed.body.items.at(-1);
  const applicationA = (await owner.query(`select id, row_version, reviewed_at from identity.organization_applications
    where organization_id=$1`, [organizationId])).rows[0];
  assert.deepEqual(itemA, { applicationId: applicationA.id, version: Number(applicationA.row_version),
    organizationId, organizationName: `Runtime Clinic ${cacA} Ltd`, facilityId,
    facilityName: `Runtime Clinic ${cacA} Ltd`, facilityLifecycleStatus: 'verified', productCode: 'ehr',
    organizationType: 'clinic', cacHint: 'RC********01', administratorName: 'Synthetic Provider Admin',
    administratorEmail: emailA, administratorAccountId: accountId, administratorAccountStatus: 'active',
    activatedAt: applicationA.reviewed_at.toISOString(), reviewedAt: null, reviewedByAccountId: null, reviewNote: null });
  assert.deepEqual((await adminGet(superAdmin, `${facilities}?state=unreviewed`)).body, listed.body);
  assert.deepEqual((await adminGet(superAdmin, `${facilities}?state=reviewed`)).body, { items: [] });
  expectProblem(await adminGet(superAdmin, `${facilities}?state=pending`), 400, 'VALIDATION_FAILED');
  const note = 'Checked: the email domain matches the company website';
  const reviewPath = `${facilities}/${applicationA.id}/review`;
  expectProblem(await adminPost(superAdmin, reviewPath, { note }), 428, 'IF_MATCH_REQUIRED');
  expectProblem(await adminPost(superAdmin, reviewPath, { note: ' short ' }, { 'If-Match': `"${itemA.version}"` }),
    400, 'VALIDATION_FAILED');
  expectProblem(await adminPost(superAdmin, reviewPath, { note }, { 'If-Match': `"${itemA.version + 1}"` }),
    409, 'VERSION_CONFLICT');
  expectProblem(await adminPost(superAdmin, `${facilities}/${reviewed.id}/review`, { note },
    { 'If-Match': String(reviewed.row_version) }), 404, 'SELF_SERVICE_FACILITY_NOT_FOUND');
  const marked = await adminPost(superAdmin, reviewPath, { note: `  ${note}  ` }, { 'If-Match': `"${itemA.version}"` });
  assert.equal(marked.status, 200, `review failed: ${JSON.stringify(marked.body)}`);
  assert.deepEqual(Object.keys(marked.body).sort(), ['applicationId', 'reviewedAt', 'version']);
  assert.equal(marked.body.applicationId, applicationA.id);
  assert.equal(marked.body.version, itemA.version + 1);
  assert(!Number.isNaN(Date.parse(marked.body.reviewedAt)));
  expectProblem(await adminPost(superAdmin, reviewPath, { note }, { 'If-Match': `"${marked.body.version}"` }),
    409, 'SELF_SERVICE_FACILITY_ALREADY_REVIEWED');
  const unreviewedAfter = (await adminGet(superAdmin, facilities)).body.items.map(item => item.facilityId);
  assert.deepEqual(unreviewedAfter, [activatedLapse.body.facilityId, activatedB.body.facilityId]);
  const reviewedAfter = (await adminGet(superAdmin, `${facilities}?state=reviewed`)).body.items;
  assert.deepEqual(reviewedAfter.map(item => [item.facilityId, item.reviewNote, item.reviewedByAccountId, item.version,
    item.reviewedAt]), [[facilityId, note, superAdmin.accountId, marked.body.version, marked.body.reviewedAt]]);
  assert.equal((await adminGet(superAdmin, `${facilities}?state=all`)).body.items.length, 3);
  const reviewAudit = (await owner.query(`select actor_type, actor_account_id, facility_id, organization_id,
      outcome, reason, details from audit.events where action='admin.self-service-facility.review'`)).rows;
  assert.deepEqual(reviewAudit, [{ actor_type: 'platform', actor_account_id: superAdmin.accountId, facility_id: null,
    organization_id: null, outcome: 'success', reason: note, details: { productCode: 'ehr', organizationId, facilityId,
      administratorAccountId: accountId, version: marked.body.version } }]);
  assert(await count(`select count(*)::int n from audit.events where action='api.admin.self-service-facility.review'
    and outcome='failure' and actor_account_id=$1`, [superAdmin.accountId]) >= 3, 'Refused reviews were not audited');
  // The permission split of the governed list and reject: an identity reviewer
  // can list but not review; a facility user without platform authority can do neither.
  const identityReviewer = await standalone('identity-review', ['identity_review_admin']);
  assert.equal((await adminGet(identityReviewer, facilities)).status, 200);
  const applicationB = (await owner.query('select id, row_version from identity.organization_applications where organization_id=$1',
    [activatedB.body.organizationId])).rows[0];
  expectProblem(await adminPost(identityReviewer, `${facilities}/${applicationB.id}/review`,
    { note }, { 'If-Match': `"${applicationB.row_version}"` }), 403, 'PERMISSION_DENIED');
  expectProblem(await adminGet({ cookie: header(cookies(activatedB)) }, facilities), 403, 'PERMISSION_DENIED');
  review.list = { unreviewed: 3, newestFirst: true, cacHint: itemA.cacHint };
  review.mark = { by: 'standalone platform_super_admin (no staff record, no membership)', status: 200,
    staleVersion: 409, missingIfMatch: 428, alreadyReviewed: 409, notSelfService: 404, audit: 'platform' };
  review.permissions = { identity_review_admin: 'list only', facility_user: 403 };

  // Rollback: closing the control refuses open applications and sessions at once.
  const heldStart = await start(enrollment({ cacRegistrationNumber: 'RC9900063801', administratorEmail: email('held') }),
    '198.51.100.50');
  // The platform day is spent (the cap above), so this start is refused before
  // QoreID; an already verified application is held instead.
  expectProblem(heldStart, 429, 'VERIFICATION_QUOTA_EXCEEDED');
  await owner.query(`update identity.organization_profile_completion_challenges
    set created_at = created_at - interval '2 minutes'
    where application_id = (select id from identity.organization_applications where cac_registration_number=$1)`, [cacTaken]);
  const heldResume = await start(enrollment({ cacRegistrationNumber: cacTaken, administratorEmail: emailA }), TAKEN_NETWORK);
  assert.equal(heldResume.status, 200, `held resume failed: ${JSON.stringify(heldResume.body)}`);
  const heldVerified = await verify({ challengeId: heldResume.body.challengeId,
    code: await codeFor(heldResume.body.challengeId) });
  assert.equal(heldVerified.status, 200);
  const closedReason = 'Close facility self sign-up after the runtime verifier';
  const closed = await adminPost(superAdmin, '/admin/controls',
    { controlKey: 'provider_self_service_enabled', enabled: false, reason: closedReason }, { 'If-Match': '"2"' });
  assert.equal(closed.status, 201, `closing the control failed: ${JSON.stringify(closed.body)}`);
  assert.deepEqual(await availability(), { open: false });
  expectProblem(await activate(cookies(heldVerified).find(value => value.startsWith('hid_provider_enrollment=')), password),
    423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacTaken, administratorEmail: emailA }), TAKEN_NETWORK),
    423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
  gate.closed_again = { availability: false, heldSessionActivate: 423, start: 423 };

  assert.equal(await count(`select count(*)::int n from audit.events where action='identity.organization.self-service.activate'`), 3);
  process.stdout.write(JSON.stringify({ status: 'passed', runtimeRole, database: rehearsal ? 'rehearsal' : 'loopback',
    flow: ['gate_closed', 'control_opened_by_platform_admin', 'origin', 'turnstile', 'accountless_start',
      'qoreid_cac_lookup', 'verified_cac', 'email_otp', 'otp_verification', 'activation', 'organization', 'facility',
      'org_admin_membership', 'account', 'ehr_product', 'staff_session', 'session_read', 'facility_selection',
      'password_sign_in', 'resume_without_lookup', 'lapse', 'platform_cap', 'support_review', 'control_closed'],
    gate, security, quota, session, lapse, review, qoreidCacLookups: qoreidCacLookups.length,
    siteverifyCalls: siteverifyRequests.length }) + '\n');
} finally {
  await app?.close();
  // owner.end() resolves before its connections finish closing, so the forced
  // drop below can terminate one of them (57P01) once the checks are over.
  // Only that is expected here; any other pool error still fails the run.
  owner.on('error', (error) => { if (error.code !== '57P01') throw error; });
  await owner.end();
  await maintenance.query(`drop database if exists ${isolated} with (force)`);
  await maintenance.end();
}
