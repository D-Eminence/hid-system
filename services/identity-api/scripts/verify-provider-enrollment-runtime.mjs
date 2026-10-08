#!/usr/bin/env node
// Accountless provider CAC self-enrollment over HTTP, executed as the exact
// Identity API runtime role against the owned disposable synthetic rehearsal
// only. External boundaries are local stubs (Cloudflare Siteverify, QoreID HTTP,
// notification delivery); no network or cloud call is made. All values are
// synthetic.
//
// Known Phase 2 gap: platform.consume_qoreid_quota('application_cac') accepts
// only an authenticated platform reviewer, so the accountless start cannot yet
// charge QoreID quota and stops before the registry call. Until that quota
// policy is decided, this verifier asserts that refusal and then records the
// verified CAC evidence through the same runtime-role command the service uses
// after a successful QoreID check. Every other step runs unmodified.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
// The provider portal is served from the staging site host, which is the host
// Turnstile accepts the provider-enrollment action for.
const origin = 'https://staging.healthidentitydirectory.com';
const siteHost = new URL(origin).hostname;
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'staging',
  NIN_PROVIDER_MODE: 'deferred', CORS_ORIGINS: origin, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'public-synthetic-ehr-workload-token',
  TURNSTILE_MODE: 'required', TURNSTILE_SECRET_KEY: 'synthetic-turnstile-secret',
  QOREID_ENABLED: 'true', QOREID_CLIENT_ID: 'synthetic-qoreid-client',
  QOREID_CLIENT_SECRET: 'synthetic-qoreid-secret' });
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
const { SecurityGuard } = load('auth/security.guard.ts');
const { WorkloadAuthService } = load('auth/workload-auth.service.ts');
const { TurnstileService } = load('auth/turnstile.service.ts');
const { NotificationOtpClient } = load('auth/notification-otp.client.ts');
const { IntegrationRuntimeService } = load('integrations/integration-runtime.service.ts');
const { ProviderEnrollmentController } = load('identity/provider-enrollment.controller.ts');
const { ProviderEnrollmentService } = load('identity/provider-enrollment.service.ts');
const { OrganizationProfileCompletionService } = load('identity/organization-profile-completion.service.ts');
const { QoreIdVerificationAdapter, QOREID_ADAPTER_CONFIGURATION, QOREID_FETCH } =
  load('identity/qoreid-verification.adapter.ts');
const { ProblemDetailsFilter } = load('common/problem.ts');
const { getEnvironment } = load('config/environment.ts');

// Cloudflare Siteverify stub. A token encodes the outcome the real service
// would return: `ok|<action>|<hostname>` or `replayed`. Any other outbound
// request fails the verifier.
const siteverifyUrl = getEnvironment().TURNSTILE_SITEVERIFY_URL;
const siteverifyRequests = [];
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  assert.equal(url, siteverifyUrl, `Unexpected outbound request to ${url}`);
  const body = JSON.parse(String(init?.body));
  assert.equal(body.secret, 'synthetic-turnstile-secret');
  siteverifyRequests.push(body.response);
  const [kind, action, hostname] = String(body.response).split('|');
  if (kind !== 'ok') return Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] });
  return Response.json({ success: true, action, hostname });
};
const turnstile = (action = 'provider-enrollment', host = siteHost) => `ok|${action}|${host}`;

// QoreID HTTP stub behind the real adapter. NOT_VERIFIED returns a negative
// registry check; every other number returns a complete verified CAC record.
const NOT_VERIFIED = 'RC9900062299';
const companies = new Map();
const qoreidRequests = [];
const qoreidFetch = async (url, init) => {
  qoreidRequests.push(String(url));
  if (String(url).endsWith('/token')) {
    return new Response(JSON.stringify({ accessToken: 'synthetic-qoreid-token', expiresIn: 7200,
      tokenType: 'Bearer' }), { status: 200 });
  }
  const { regNumber } = JSON.parse(String(init.body));
  if (regNumber === NOT_VERIFIED) {
    return new Response(JSON.stringify({ id: 990001, summary: { cac_check: 'not_verified' },
      status: { state: 'complete', status: 'not_verified' }, cac: {} }), { status: 200 });
  }
  return new Response(JSON.stringify({ id: 990000 + companies.size, summary: { cac_check: 'verified' },
    status: { state: 'complete', status: 'verified' },
    cac: { rcNumber: regNumber.replace(/^(RC|BN|IT)/, ''), companyName: companies.get(regNumber),
      companyType: 'Private Company Limited by Shares', registrationDate: '01-Jan-21',
      headOfficeAddress: '1 Synthetic Registry Road, Lagos', status: 'Active' } }), { status: 200 });
};

// Run in a disposable copy so synthetic organizations and the enabled QoreID
// control never leak into later rehearsal steps.
const isolated = `hid_rehearsal_provider_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const maintenance = new Pool({ host: socket, user: process.env.PGUSER, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
const pool = new Pool({ host: socket, user: process.env.PGUSER, database: isolated, max: 5 });
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
  await pool.query("update platform.integration_providers set enabled=true, row_version=row_version+1 where provider='qoreid'");
  const module = await Test.createTestingModule({ controllers: [AuthController, ProviderEnrollmentController],
    providers: [{ provide: DatabaseService, useValue: database }, TokenService, LocalAuthProvider,
      CurrentStaffContextService, CurrentPatientContextService, AuthService, AuthSessionAuditService,
      AuditService, WorkloadAuthService, TurnstileService, IntegrationRuntimeService,
      ProviderEnrollmentService, OrganizationProfileCompletionService, QoreIdVerificationAdapter,
      { provide: QOREID_ADAPTER_CONFIGURATION, useValue: { baseUrl: 'https://api.qoreid.com',
        clientId: 'synthetic-qoreid-client', clientSecret: 'synthetic-qoreid-secret', timeoutMs: 2000 } },
      { provide: QOREID_FETCH, useValue: qoreidFetch },
      { provide: NotificationOtpClient, useValue: notification },
      { provide: GoogleAuthenticationService, useValue: {
        login: async () => { throw new Error('Google exchange is outside the provider-enrollment verifier'); },
      } }] }).compile();
  app = module.createNestApplication({ logger: false });
  app.use(require('cookie-parser')());
  app.use((req, _res, next) => { req.correlationId = randomUUID(); next(); });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalGuards(new SecurityGuard(module.get(Reflector), module.get(TokenService),
    module.get(AuditService), module.get(DatabaseService)));
  await app.init();
  const http = request(app.getHttpServer());
  const cookieName = getEnvironment().AUTH_COOKIE_NAME;
  const cookies = response => (response.headers['set-cookie'] ?? []).map(value => value.split(';')[0]);
  const enrollment = input => ({ productCode: 'ehr', organizationType: 'clinic',
    administratorName: 'Synthetic Provider Admin', turnstileAction: 'provider-enrollment',
    turnstileToken: turnstile(), ...input });
  const start = (body, extra = {}) => {
    let call = http.post('/api/v1/identity/provider-enrollments').set('Origin', origin);
    for (const [name, value] of Object.entries(extra)) call = call.set(name, value);
    return call.send(body);
  };
  const expectProblem = (response, status, code) => {
    assert.equal(response.status, status, `${code}: ${JSON.stringify(response.body)}`);
    if (code) assert.equal(response.body.code, code, JSON.stringify(response.body));
  };
  const failures = {};

  // Request context: Origin, Turnstile action and token, CAC format and registry result.
  const cacA = 'RC9900062201'; companies.set(cacA, 'Runtime Enrollment Clinic Ltd');
  const emailA = `provider-a-${randomUUID().slice(0, 8)}@example.invalid`;
  expectProblem(await http.post('/api/v1/identity/provider-enrollments')
    .send(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA })), 403, 'ORIGIN_DENIED');
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA,
    turnstileAction: 'staff-login' })), 400);
  failures.invalid_turnstile_action_in_body = 400;
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA,
    turnstileToken: turnstile('patient-enrollment') })), 403, 'TURNSTILE_ACTION_MISMATCH');
  failures.turnstile_token_for_another_action = 'TURNSTILE_ACTION_MISMATCH';
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA,
    turnstileToken: 'replayed' })), 403, 'TURNSTILE_EXPIRED_OR_REPLAYED');
  expectProblem(await start(enrollment({ cacRegistrationNumber: 'XX12', administratorEmail: emailA })), 400);
  failures.invalid_cac_format = 400;

  // Known gap (see header): the accountless start is refused at the QoreID
  // quota before any registry call, and the application stays unverified.
  const quotaRefused = await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA }));
  expectProblem(quotaRefused, 403, 'PERMISSION_DENIED');
  assert.equal(qoreidRequests.length, 0, 'QoreID must not be called before quota is charged');
  const pending = await pool.query(
    'select status, verification_result from identity.organization_applications where cac_registration_number=$1', [cacA]);
  assert.deepEqual(pending.rows[0], { status: 'pending_verification', verification_result: null });
  const knownGaps = { accountless_qoreid_quota: 'PERMISSION_DENIED before the registry call' };
  // Record verified evidence exactly as the service does after a successful
  // QoreID check, as the runtime role in the system enrollment context.
  const recordVerifiedCac = (cac, email) => asRuntime(`provider-runtime-cac-${cac}`, async client => {
    const current = (await client.query('select * from identity.public_get_organization_application($1,$2,$3)',
      [cac, email, 'ehr'])).rows[0];
    assert(current, `No submitted application for ${cac}`);
    await client.query('select * from identity.public_record_organization_cac_result($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [current.application_id, Number(current.row_version), 'verified', cac.replace(/^RC/, ''), cac,
        companies.get(cac), 'Private Company Limited by Shares', '2021-01-01',
        '1 Synthetic Registry Road, Lagos', 'active']);
  });
  await recordVerifiedCac(cacA, emailA);

  // 1-4. Accountless start, verified CAC, emailed OTP, OTP verification.
  const started = await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA }));
  assert.equal(started.status, 200, `start failed: ${JSON.stringify(started.body)}`);
  assert.equal(started.body.accepted, true);
  const challengeId = started.body.challengeId;
  assert.match(challengeId, /^[0-9a-f-]{36}$/);
  assert(codes.has(challengeId), 'The email OTP was not delivered for the started challenge');
  assert.equal(recipients.at(-1), emailA);
  const recorded = await pool.query(
    'select status, verification_result, approval_mode from identity.organization_applications where cac_registration_number=$1', [cacA]);
  assert.deepEqual(recorded.rows[0], { status: 'ready_for_review', verification_result: 'verified',
    approval_mode: 'self_service' });
  const wrongCode = codes.get(challengeId) === '000000' ? '111111' : '000000';
  expectProblem(await http.post('/api/v1/identity/provider-enrollments/verify').set('Origin', origin)
    .send({ challengeId, code: wrongCode }), 401, 'ORGANIZATION_COMPLETION_CODE_INVALID');
  failures.invalid_otp = 'ORGANIZATION_COMPLETION_CODE_INVALID';
  const verified = await http.post('/api/v1/identity/provider-enrollments/verify').set('Origin', origin)
    .send({ challengeId, code: codes.get(challengeId) });
  assert.equal(verified.status, 200, `verify failed: ${JSON.stringify(verified.body)}`);
  assert.deepEqual(verified.body, { verified: true });
  const enrollmentCookie = cookies(verified).find(value => value.startsWith('hid_provider_enrollment='));
  assert(enrollmentCookie, 'OTP verification did not set the enrollment cookie');
  assert.match(verified.headers['set-cookie'].join(';'), /HttpOnly/i);

  // 5-10. Activation creates the organization, facility, product, account and
  // org-admin membership, and signs the administrator in, all as the runtime role.
  expectProblem(await http.post('/api/v1/identity/provider-enrollments/activate').set('Origin', origin)
    .send({ password: 'Synthetic-Provider-Password-2026' }), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  const password = 'Synthetic-Provider-Password-2026';
  const activated = await http.post('/api/v1/identity/provider-enrollments/activate').set('Origin', origin)
    .set('Cookie', enrollmentCookie).send({ password });
  assert.equal(activated.status, 200, `activation failed: ${JSON.stringify(activated.body)}`);
  assert.equal(activated.body.activated, true);
  const { organizationId, facilityId, accountId } = activated.body;
  assert.equal(activated.body.actor.accountId, accountId);
  assert(activated.headers['x-csrf-token'], 'Activation did not return a CSRF token for the new session');
  const sessionCookies = cookies(activated).filter(value => value.startsWith(cookieName));
  assert(sessionCookies.some(value => value.startsWith(`${cookieName}=`)), 'Activation did not sign the provider in');
  const created = (await pool.query(`
    select o.name organization, f.lifecycle_status facility_status, p.product_code product,
      a.email, a.status account_status, s.default_role staff_role, m.membership_role, m.active membership_active,
      r.role_code, app.status application_status, app.reviewed_by_account_id reviewer,
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
  assert.deepEqual(created, [{ organization: 'Runtime Enrollment Clinic Ltd', facility_status: 'verified',
    product: 'ehr', email: emailA, account_status: 'active', staff_role: 'org_admin',
    membership_role: 'org_admin', membership_active: true, role_code: 'org_admin',
    application_status: 'approved', reviewer: null, cac_bindings: 1 }]);

  // 11. The new provider is authenticated: the activation session works, the
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

  // An authenticated caller cannot use the accountless flow.
  const cacB = 'RC9900062202'; companies.set(cacB, 'Runtime Expiry Clinic Ltd');
  const emailB = `provider-b-${randomUUID().slice(0, 8)}@example.invalid`;
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacB, administratorEmail: emailB }),
    { Cookie: sessionHeader }), 409, 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT');
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacB, administratorEmail: emailB }),
    { Authorization: 'Bearer synthetic' }), 409, 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT');
  failures.authenticated_caller = 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT';

  // The consumed enrollment session cannot activate again, and the CAC is now taken.
  expectProblem(await http.post('/api/v1/identity/provider-enrollments/activate').set('Origin', origin)
    .set('Cookie', enrollmentCookie).send({ password }), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  failures.replayed_activation = 'ORGANIZATION_COMPLETION_SESSION_INVALID';
  const duplicate = await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA }));
  assert.equal(duplicate.status, 409, `duplicate CAC: ${JSON.stringify(duplicate.body)}`);
  const duplicateOther = await start(enrollment({ cacRegistrationNumber: cacA,
    administratorEmail: `provider-c-${randomUUID().slice(0, 8)}@example.invalid` }));
  assert.equal(duplicateOther.status, 409, `duplicate CAC, other admin: ${JSON.stringify(duplicateOther.body)}`);
  failures.duplicate_cac = [duplicate.body.code, duplicateOther.body.code];

  // An expired OTP cannot verify even with the correct code.
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacB, administratorEmail: emailB })),
    403, 'PERMISSION_DENIED');
  await recordVerifiedCac(cacB, emailB);
  const startedB = await start(enrollment({ cacRegistrationNumber: cacB, administratorEmail: emailB }));
  assert.equal(startedB.status, 200, `second start failed: ${JSON.stringify(startedB.body)}`);
  await pool.query("update identity.organization_profile_completion_challenges set expires_at=clock_timestamp()-interval '1 second' where id=$1",
    [startedB.body.challengeId]);
  expectProblem(await http.post('/api/v1/identity/provider-enrollments/verify').set('Origin', origin)
    .send({ challengeId: startedB.body.challengeId, code: codes.get(startedB.body.challengeId) }),
  401, 'ORGANIZATION_COMPLETION_CODE_INVALID');
  failures.expired_otp = 'ORGANIZATION_COMPLETION_CODE_INVALID';

  const audits = (await pool.query(
    "select count(*)::int n from audit.events where action='identity.organization.self-service.activate' and organization_id=$1",
    [organizationId])).rows[0].n;
  assert.equal(audits, 1);
  process.stdout.write(JSON.stringify({ status: 'passed', runtimeRole: 'hid_identity_api_runtime',
    flow: ['start', 'verified_cac_evidence_via_runtime_command', 'email_otp', 'otp_verification', 'activation', 'organization',
      'facility', 'org_admin_membership', 'account', 'product', 'authenticated_session',
      'facility_selection', 'staff_login'],
    failures, knownGaps, siteverifyCalls: siteverifyRequests.length }) + '\n');
} finally {
  await app?.close();
  await pool.end();
  await maintenance.query(`drop database if exists ${isolated} with (force)`);
  await maintenance.end();
}
