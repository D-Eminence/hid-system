#!/usr/bin/env node
// Phase 4 Stage 2A platform security over HTTP, executed as the exact Identity
// API runtime role against a disposable copy of the owned synthetic rehearsal.
// The real DatabaseService, SecurityGuard, AuditInterceptor, controllers,
// services, TOTP verification and database commands run. Only TOTP time steps
// come from a virtual clock (see platform-session-client.mjs); no notification
// or network call is made. All values are synthetic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { cookieHeader, createTotpClock, expectStatus, mergeCookies, platformClient } from './platform-session-client.mjs';

const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
const isolated = `hid_rehearsal_security_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const origin = 'https://admin.staging.healthidentitydirectory.com';
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'staging',
  NIN_PROVIDER_MODE: 'deferred', CORS_ORIGINS: origin, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'public-synthetic-ehr-workload-token', TURNSTILE_MODE: 'disabled',
  MFA_SECRET_KEY_B64: Buffer.alloc(32, 0x4d).toString('base64'), MFA_KEY_VERSION: 'security-runtime-v1',
  DATABASE_URL: `postgresql://${process.env.PGUSER ?? 'postgres'}@localhost/${isolated}?host=${encodeURIComponent(socket)}`
    + `&options=${encodeURIComponent('-c role=hid_identity_api_runtime')}` });
delete process.env.AUTH_COOKIE_DOMAIN;
require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const load = path => require(join(service, 'src', path));
const { Pool } = require('pg');
const { Test } = require('@nestjs/testing');
const { Reflector } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { validate } = require('class-validator');
const { plainToInstance } = require('class-transformer');
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
const { StartOtpDto } = load('auth/dto/otp.dto.ts');
const totp = load('auth/mfa/totp.ts');
const { AuditService } = load('audit/audit.service.ts');
const { AuditController } = load('audit/audit.controller.ts');
const { AuditInterceptor } = load('audit/audit.interceptor.ts');
const { SecurityGuard } = load('auth/security.guard.ts');
const { WorkloadAuthService } = load('auth/workload-auth.service.ts');
const { TurnstileService } = load('auth/turnstile.service.ts');
const { NotificationOtpClient } = load('auth/notification-otp.client.ts');
const { AdminController } = load('admin/admin.controller.ts');
const { AdminService } = load('admin/admin.service.ts');
const { AdminOperationsService } = load('admin/admin-operations.service.ts');
const { PricingService } = load('admin/pricing.service.ts');
const { PlatformSecurityController } = load('admin/platform-security.controller.ts');
const { PlatformSecurityService } = load('admin/platform-security.service.ts');
const { DomainProblem, ProblemDetailsFilter } = load('common/problem.ts');
const { corsOptions } = load('config/cors.ts');

globalThis.fetch = async (input) => { throw new Error(`Unexpected outbound request to ${String(input)}`); };
const maintenance = new Pool({ host: socket, user: process.env.PGUSER, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
const owner = new Pool({ host: socket, user: process.env.PGUSER, database: isolated, max: 2 });
// Dropping the disposable database terminates any connection still closing;
// that expected 57P01 must not crash the verifier after its checks passed.
owner.on('error', () => undefined);
let app;
try {
  const argon2 = require('argon2');
  const password = 'Synthetic-Security-Password-2026';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const organizationId = randomUUID();
  const facilityId = randomUUID();
  await owner.query("insert into identity.organizations (id, name, slug) values ($1, 'Security Runtime Organization', $2)",
    [organizationId, `security-runtime-${organizationId.slice(0, 8)}`]);
  await owner.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
    values ($1, $2, 'Security Runtime Facility', $3, 'Africa/Lagos', true, 'verified')`,
  [facilityId, organizationId, `SEC-${facilityId.slice(0, 6)}`]);

  async function account(label, { platformRole, membershipRole, displayName } = {}) {
    const id = randomUUID();
    const email = `security-runtime-${label}-${id.slice(0, 8)}@example.invalid`;
    await owner.query(`insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm)
      values ($1, $2, $3, $4, 'active', $5, 'argon2id')`,
    [id, `synthetic:security-runtime:${label}`, email, displayName ?? `Security Runtime ${label}`, passwordHash]);
    if (platformRole) {
      await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
        values ($1, $2, $3, 'platform', 'Synthetic platform security verifier')`, [randomUUID(), id, platformRole]);
    }
    if (membershipRole) {
      const staffId = randomUUID(); const membershipId = randomUUID();
      await owner.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
        values ($1, $2, $3, $4, 'verified', $5)`, [staffId, id, `Security Runtime ${label}`, email, membershipRole]);
      await owner.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id,
          facility_id, membership_role, app_role, is_primary, active)
        values ($1, $2, $3, $4, $5, $6, $6, true, true)`, [membershipId, staffId, id, organizationId, facilityId, membershipRole]);
    }
    return { id, email };
  }
  // superA has no staff record or facility membership at all (Stage 1 finding S1).
  const superA = await account('super-a', { platformRole: 'platform_super_admin' });
  const superB = await account('super-b', { platformRole: 'platform_super_admin', membershipRole: 'doctor' });
  const support = await account('support', { platformRole: 'support_admin' });
  const limited = await account('limited', { platformRole: 'security_auditor' });
  const target = await account('target', { membershipRole: 'doctor', displayName: '=HYPERLINK("https://example.invalid")' });
  const plain = await account('plain');

  const clock = createTotpClock();
  const module = await Test.createTestingModule({
    controllers: [AuthController, PlatformAuthController, AdminController, PlatformSecurityController, AuditController],
    providers: [DatabaseService, TokenService, LocalAuthProvider, CurrentStaffContextService, CurrentPatientContextService,
      AuthService, AuthSessionAuditService, AuditService, WorkloadAuthService, TurnstileService, AdminService,
      AdminOperationsService, PricingService, MfaService, MfaSecretProtector, PlatformSecurityService,
      { provide: MFA_TOTP_CLOCK, useValue: clock.now },
      { provide: NotificationOtpClient, useValue: {
        deliver: async () => { throw new Error('Notification delivery is outside the platform security verifier'); } } },
      { provide: GoogleAuthenticationService, useValue: {
        login: async () => { throw new Error('Google exchange is outside the platform security verifier'); } } }],
  }).compile();
  const runtimeRole = (await module.get(DatabaseService).query('select current_user as role')).rows[0].role;
  assert.equal(runtimeRole, 'hid_identity_api_runtime');
  app = module.createNestApplication({ logger: false });
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
  // The production CORS policy (main.ts), so the export headers it exposes are checked over HTTP.
  app.enableCors(corsOptions(origin));
  await app.init();
  const http = request(app.getHttpServer());
  const platform = platformClient({ http, origin, totp, clock, password });
  const { get, command, post } = platform;
  const evidence = {};
  const key = (label) => `security-runtime-${label}-${randomUUID()}`;
  const accountVersion = async (id) => (await owner.query('select row_version from auth.accounts where id = $1', [id])).rows[0].row_version;

  // 1. Sign-in: a password alone never yields a platform session.
  expectStatus(await get(null, '/admin/session'), 401, 'AUTHENTICATION_REQUIRED');
  const wrongPassword = await post('/auth/admin/login', {}, { email: superA.email, password: 'Wrong-Password-2026',
    turnstileAction: 'admin-login' });
  const notAdmin = await post('/auth/admin/login', {}, { email: plain.email, password, turnstileAction: 'admin-login' });
  expectStatus(wrongPassword, 401);
  expectStatus(notAdmin, 401);
  assert.deepEqual([wrongPassword.body.code, wrongPassword.body.detail], [notAdmin.body.code, notAdmin.body.detail],
    'a non-administrator is indistinguishable from a wrong password');
  const firstLogin = await platform.login(superA.email);
  assert.equal(firstLogin.response.body.status, 'mfa_enrollment_required');
  const challengeCookie = firstLogin.response.headers['set-cookie'].find(value => value.startsWith('hid_access_admin_mfa='));
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/v1/auth/admin']) {
    assert(challengeCookie.includes(attribute), `challenge cookie lacks ${attribute}`);
  }
  assert.deepEqual(Object.keys(firstLogin.jar), ['hid_access_admin_mfa'], 'password sign-in sets only the challenge cookie');
  expectStatus(await http.get('/api/v1/admin/session').set('Cookie', cookieHeader(firstLogin.jar)), 401);
  evidence.sign_in = { password_only: 'mfa_challenge', non_admin: 401, challenge_cookie: 'HttpOnly; Secure; SameSite=Strict' };

  // 2. Enrollment (RFC 6238 TOTP): the secret is returned once and stored encrypted.
  const started = await post('/auth/admin/mfa/enroll/start', firstLogin.jar);
  expectStatus(started, 200);
  assert.equal(started.headers['cache-control'], 'no-store');
  const secretA = started.body.secret;
  assert.match(started.body.otpauthUri, /^otpauth:\/\/totp\/HID%20Platform%20Admin:.*algorithm=SHA1&digits=6&period=30$/);
  const stored = (await owner.query(`select status, secret_ciphertext, secret_key_version from auth.mfa_factors
    where account_id = $1`, [superA.id])).rows;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'pending');
  assert(!stored[0].secret_ciphertext.includes(totp.base32Decode(secretA)), 'the TOTP secret is stored only as ciphertext');
  expectStatus(await post('/auth/admin/mfa/enroll/activate', firstLogin.jar, { code: '000000' }), 401, 'MFA_INVALID_CODE');
  const activated = await post('/auth/admin/mfa/enroll/activate', firstLogin.jar, { code: platform.code(secretA) });
  expectStatus(activated, 200);
  const recoveryA = activated.body.recoveryCodes;
  assert.equal(recoveryA.length, 10);
  assert.equal(new Set(recoveryA).size, 10);
  const sessionA1 = { jar: mergeCookies({}, activated), csrf: activated.headers['x-csrf-token'], email: superA.email,
    secret: secretA, accountId: superA.id, sessionId: activated.body.actor.sessionId };
  assert.equal(activated.body.actor.kind, 'platform');
  // The consumed challenge cannot start another enrollment.
  expectStatus(await post('/auth/admin/mfa/enroll/start', firstLogin.jar), 401, 'MFA_CHALLENGE_INVALID');
  const adminSession = await get(sessionA1, '/admin/session');
  expectStatus(adminSession, 200);
  assert.equal((await owner.query('select count(*)::int as n from identity.staff where account_id = $1', [superA.id])).rows[0].n, 0);
  const status = await get(sessionA1, '/admin/mfa');
  expectStatus(status, 200);
  assert.equal(status.body.enrolled, true);
  assert.equal(status.body.recoveryCodesRemaining, 10);
  assert(!JSON.stringify(status.body).includes(secretA) && !('secret' in status.body), 'the secret is never returned again');
  evidence.enrollment = { recovery_codes: 10, platform_only_account: true, secret_returned_after_enrollment: false };

  // 3. Session kinds are separate in both directions.
  const staffLogin = await http.post('/api/v1/auth/login').set('Origin', origin)
    .send({ email: superB.email, password, turnstileAction: 'staff-login' });
  expectStatus(staffLogin, 200);
  const staffJar = mergeCookies({}, staffLogin);
  expectStatus(await http.get('/api/v1/admin/session').set('Authorization', `Bearer ${staffJar.hid_access}`),
    403, 'PLATFORM_SESSION_REQUIRED');
  expectStatus(await http.get('/api/v1/auth/session').set('Authorization', `Bearer ${sessionA1.jar.hid_access_admin}`),
    403, 'PLATFORM_SESSION_SCOPE_DENIED');
  // The guard itself refuses the wrong session kind, with platform-scoped evidence.
  const kindDenial = (await owner.query(`select access_scope from audit.events where actor_account_id = $1
    and action = 'security.authorization' and outcome = 'denied' and details->>'code' = 'PLATFORM_SESSION_REQUIRED'`,
  [superB.id])).rows;
  assert.deepEqual(kindDenial, [{ access_scope: 'platform' }]);
  // A platform refresh token presented to the staff refresh endpoint is refused and left intact.
  const crossRefresh = await http.post('/api/v1/auth/refresh').set('Origin', origin)
    .set('Cookie', `hid_access_refresh=${sessionA1.jar.hid_access_admin_refresh}; hid_access_csrf=${sessionA1.jar.hid_access_admin_csrf}`)
    .set('x-csrf-token', sessionA1.jar.hid_access_admin_csrf);
  expectStatus(crossRefresh, 401, 'AUTHENTICATION_REQUIRED');
  expectStatus(await get(sessionA1, '/admin/session'), 200);
  evidence.session_kinds = { staff_on_platform: 'PLATFORM_SESSION_REQUIRED', platform_on_staff: 'PLATFORM_SESSION_SCOPE_DENIED',
    platform_refresh_on_staff_endpoint: 401 };

  // 4. A TOTP code is accepted once: a replay of the last accepted step fails.
  const secondLogin = await platform.login(superA.email);
  assert.equal(secondLogin.response.body.status, 'mfa_required');
  // Resend the exact code accepted at activation. (A code regenerated now could
  // belong to a later, unused step if real time crossed a 30-second boundary.)
  const replayed = platform.lastCode(secretA);
  assert.match(replayed, /^[0-9]{6}$/);
  expectStatus(await post('/auth/admin/mfa/verify', secondLogin.jar, { code: replayed }), 401, 'MFA_INVALID_CODE');
  expectStatus(await post('/auth/admin/mfa/verify', secondLogin.jar, { code: '123456', recoveryCode: recoveryA[0] }),
    400, 'MFA_CODE_REQUIRED');
  const verifiedA2 = await post('/auth/admin/mfa/verify', secondLogin.jar, { code: platform.code(secretA) });
  expectStatus(verifiedA2, 200);
  const sessionA2 = { ...sessionA1, jar: mergeCookies({}, verifiedA2), csrf: verifiedA2.headers['x-csrf-token'],
    sessionId: verifiedA2.body.actor.sessionId };
  evidence.totp_replay = 'MFA_INVALID_CODE';

  // 5. Rate limiting: the fifth failed code blocks the account, even for a correct code.
  const limitedAdmin = await platform.enroll(limited.email);
  const limitedLogin = await platform.login(limited.email);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    expectStatus(await post('/auth/admin/mfa/verify', limitedLogin.jar, { code: '000000' }), 401, 'MFA_INVALID_CODE');
  }
  const afterFailures = await platform.login(limited.email);
  expectStatus(await post('/auth/admin/mfa/verify', afterFailures.jar, { code: platform.code(limitedAdmin.secret) }),
    429, 'MFA_RATE_LIMITED');
  const blocked = (await owner.query(`select count(*)::int as n from auth.otp_rate_limits
    where scope = 'mfa_failure_account' and blocked_until > clock_timestamp()`)).rows[0].n;
  assert.equal(blocked, 1);
  const exhausted = (await owner.query(`select invalidation_reason from auth.mfa_login_challenges
    where id = (select id from auth.mfa_login_challenges where account_id = $1 order by created_at limit 1 offset 1)`,
  [limited.id])).rows[0];
  assert.equal(exhausted.invalidation_reason, 'attempts_exhausted');
  evidence.rate_limit = { failures_before_block: 5, then: 'MFA_RATE_LIMITED', challenge: 'attempts_exhausted' };

  // 6. Step-up and the central policy on a critical command.
  const roleChange = (admin, body, headers) => command(admin, `/admin/principals/${target.id}/platform-roles`, body, headers);
  const roleBody = { roleCode: 'security_auditor', action: 'grant', reason: 'Grant auditor role for review' };
  expectStatus(await roleChange(sessionA2, roleBody,
    { 'If-Match': String(await accountVersion(target.id)), 'Idempotency-Key': key('role-1') }), 403, 'STEP_UP_REQUIRED');
  expectStatus(await command(sessionA2, '/admin/mfa/step-up', { code: recoveryA[0] }), 400, 'VALIDATION_FAILED');
  const stepUp = await platform.stepUp(sessionA2);
  assert(new Date(stepUp.body.stepUpExpiresAt).getTime() <= Date.now() + 301_000);
  expectStatus(await roleChange(sessionA2, roleBody, { 'Idempotency-Key': key('role-2') }), 428, 'IF_MATCH_REQUIRED');
  expectStatus(await roleChange(sessionA2, { ...roleBody, reason: undefined },
    { 'If-Match': String(await accountVersion(target.id)), 'Idempotency-Key': key('role-3') }), 400, 'REASON_REQUIRED');
  expectStatus(await roleChange(sessionA2, roleBody,
    { 'If-Match': String(await accountVersion(target.id)), 'Idempotency-Key': key('role-4') }), 201);
  // Step-up belongs to one session family: the earlier session still has none.
  expectStatus(await roleChange(sessionA1, { ...roleBody, action: 'revoke' },
    { 'If-Match': String(await accountVersion(target.id)), 'Idempotency-Key': key('role-5') }), 403, 'STEP_UP_REQUIRED');
  // Stage 4A: a step-up older than the five-minute window is reported as
  // expired, not missing. The assurance row refuses to move backwards
  // (0069), so time is simulated with its trigger disabled for one statement.
  const ageStepUp = async (admin) => {
    const client = await owner.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(`update auth.session_assurance set mfa_verified_at = mfa_verified_at - interval '6 minutes',
          step_up_at = step_up_at - interval '6 minutes'
        where family_id = (select family_id from auth.sessions where id = $1)`, [admin.sessionId]);
    } finally {
      await client.query('reset session_replication_role');
      client.release();
    }
  };
  await ageStepUp(sessionA2);
  expectStatus(await roleChange(sessionA2, { ...roleBody, action: 'revoke' },
    { 'If-Match': String(await accountVersion(target.id)), 'Idempotency-Key': key('role-expired') }), 403, 'STEP_UP_EXPIRED');
  await platform.stepUp(sessionA2);
  // Super Admin is never granted in one step.
  expectStatus(await roleChange(sessionA2, { roleCode: 'platform_super_admin', action: 'grant', reason: 'One-step elevation' },
    { 'If-Match': String(await accountVersion(target.id)), 'Idempotency-Key': key('role-6') }), 403, 'TWO_PERSON_APPROVAL_REQUIRED');
  evidence.step_up = { without: 'STEP_UP_REQUIRED', expired: 'STEP_UP_EXPIRED', if_match: 428, reason: 'REASON_REQUIRED',
    per_session_family: true, direct_super_admin_grant: 'TWO_PERSON_APPROVAL_REQUIRED' };

  // 6a. Platform controls through the exact Identity runtime role. runtime-grants.sql once
  // omitted EXECUTE on platform.admin_list_controls and platform.admin_set_control.
  const controlEvents = async () => (await owner.query(
    "select count(*)::int as count from platform.control_events where control_key = 'outreach_portal_enabled'")).rows[0].count;
  const eventsBefore = await controlEvents();
  const controls = await get(sessionA2, '/admin/controls');
  expectStatus(controls, 200);
  const outreach = controls.body.find(item => item.controlKey === 'outreach_portal_enabled');
  assert(outreach, 'The outreach portal control is listed');
  const setOutreach = (enabled, version, reason) => command(sessionA2, '/admin/controls',
    { controlKey: 'outreach_portal_enabled', enabled, reason }, { 'If-Match': String(version) });
  const changed = await setOutreach(!outreach.enabled, outreach.version, 'Verifier changes the outreach portal control');
  expectStatus(changed, 201);
  assert.deepEqual([changed.body.enabled, changed.body.replayed], [!outreach.enabled, false]);
  const restored = await setOutreach(outreach.enabled, changed.body.version, 'Verifier restores the outreach portal control');
  expectStatus(restored, 201);
  assert.equal(restored.body.enabled, outreach.enabled);
  assert.equal(await controlEvents(), eventsBefore + 2);
  evidence.platform_controls = { listed: controls.body.length, changed_and_restored: 'outreach_portal_enabled',
    control_events_added: 2 };

  // 7. Two-person Super Admin elevation.
  const elevationKey = key('elevation');
  const requestBody = { reason: 'Second operator for incident response' };
  const elevation = await command(sessionA2, `/admin/principals/${target.id}/super-admin-requests`, requestBody,
    { 'Idempotency-Key': elevationKey });
  expectStatus(elevation, 201);
  assert.equal(elevation.body.status, 'pending');
  const window = new Date(elevation.body.expiresAt).getTime() - Date.now();
  assert(window > 23.9 * 3_600_000 && window <= 24 * 3_600_000, 'approval window is 24 hours');
  const elevationReplay = await command(sessionA2, `/admin/principals/${target.id}/super-admin-requests`, requestBody,
    { 'Idempotency-Key': elevationKey });
  expectStatus(elevationReplay, 201);
  assert.deepEqual([elevationReplay.body.requestId, elevationReplay.body.replayed], [elevation.body.requestId, true]);
  const decide = (admin, requestId, decision, version, label) => command(admin, `/admin/approvals/${requestId}/${decision}`,
    { reason: `Decision ${label} for verifier` }, { 'If-Match': String(version), 'Idempotency-Key': key(label) });
  expectStatus(await decide(sessionA2, elevation.body.requestId, 'approve', elevation.body.version, 'self'),
    403, 'SELF_APPROVAL_DENIED');
  const supportAdmin = await platform.enroll(support.email);
  await platform.stepUp(supportAdmin);
  expectStatus(await decide(supportAdmin, elevation.body.requestId, 'approve', elevation.body.version, 'support'),
    403, 'APPROVER_INELIGIBLE');
  const superBAdmin = await platform.enroll(superB.email);
  expectStatus(await decide(superBAdmin, elevation.body.requestId, 'approve', elevation.body.version, 'no-step-up'),
    403, 'STEP_UP_REQUIRED');
  expectStatus(await command(superBAdmin, '/admin/mfa/step-up', { code: '000000' }), 401, 'MFA_INVALID_CODE');
  await platform.stepUp(superBAdmin);
  // Two concurrent approvals: exactly one grants the role.
  const decisions = await Promise.all([
    decide(superBAdmin, elevation.body.requestId, 'approve', elevation.body.version, 'race-1'),
    decide(superBAdmin, elevation.body.requestId, 'approve', elevation.body.version, 'race-2'),
  ]);
  const statuses = decisions.map(response => response.status).sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify(decisions.map(response => response.body)));
  const winner = decisions.find(response => response.status === 200).body;
  assert.deepEqual([winner.status, winner.executed], ['approved', true]);
  const grants = (await owner.query(`select granted_by from auth.account_roles where account_id = $1
    and role_code = 'platform_super_admin' and scope_type = 'platform' and revoked_at is null`, [target.id])).rows;
  assert.deepEqual(grants, [{ granted_by: superB.id }]);
  expectStatus(await decide(superBAdmin, elevation.body.requestId, 'approve', winner.version, 'again'),
    409, 'APPROVAL_NOT_PENDING');
  const approvalAudit = (await owner.query(`select action from audit.events where resource_id = $1 or
    (action = 'admin.platform-role.grant' and resource_id = $2) order by sequence_id`,
  [elevation.body.requestId, target.id])).rows.map(row => row.action);
  for (const action of ['admin.approval.requested', 'admin.approval.approved', 'admin.platform-role.grant']) {
    assert(approvalAudit.includes(action), `missing audit ${action}`);
  }
  // An expired request is closed, never executed.
  const expiredId = randomUUID();
  await owner.query(`insert into auth.admin_approval_requests (id, action, target_account_id, role_code, reason,
      requested_by, requested_at, expires_at, correlation_id)
    values ($1, 'platform_role.grant', $2, 'platform_super_admin', 'Synthetic expired request', $3,
      now() - interval '25 hours', now() - interval '1 hour', 'security-runtime-expired')`, [expiredId, plain.id, superA.id]);
  expectStatus(await decide(superBAdmin, expiredId, 'approve', 1, 'expired'), 409, 'APPROVAL_EXPIRED');
  assert.equal((await owner.query('select status from auth.admin_approval_requests where id = $1', [expiredId])).rows[0].status,
    'expired');
  expectStatus(await get(supportAdmin, '/admin/approvals'), 403, 'PERMISSION_DENIED');
  const listed = await get(superBAdmin, '/admin/approvals?status=approved');
  expectStatus(listed, 200);
  assert(listed.body.items.some(item => item.id === elevation.body.requestId));
  evidence.two_person = { self_approval: 'SELF_APPROVAL_DENIED', non_super_admin: 'APPROVER_INELIGIBLE',
    without_step_up: 'STEP_UP_REQUIRED', concurrent_approvals: statuses, grants: grants.length, expired: 'APPROVAL_EXPIRED' };

  // 7a. Stage 4A: approvals page newest first (requested_at desc, id) through an
  // opaque cursor, with no 200-row cap. Five decided requests share edges: two
  // in one millisecond and two at the same instant.
  const approvalBase = new Date(Date.now() - 7_200_000);
  const approvalAt = (seconds, micros = 0) => {
    const at = new Date(approvalBase.getTime() + seconds * 1_000);
    return `${at.toISOString().slice(0, 19)}.${String(micros).padStart(6, '0')}Z`;
  };
  const rejectedRows = [['r1', approvalAt(1)], ['tieA', approvalAt(2)], ['tieB', approvalAt(2)],
    ['r4', approvalAt(3, 100)], ['r5', approvalAt(3, 900)]];
  const rejectedIds = {};
  for (const [label, requestedAt] of rejectedRows) {
    rejectedIds[label] = randomUUID();
    await owner.query(`insert into auth.admin_approval_requests (id, action, target_account_id, role_code, reason,
        status, requested_by, requested_at, expires_at, decided_by, decided_at, decision_reason, correlation_id)
      values ($1, 'mfa.reset', $2, null, 'Synthetic paging fixture', 'rejected', $3, $4::timestamptz,
        $4::timestamptz + interval '1 hour', $5, $4::timestamptz + interval '1 minute', 'Synthetic paging decision',
        'security-runtime-paging')`, [rejectedIds[label], plain.id, superA.id, requestedAt, superB.id]);
  }
  const [tieLow, tieHigh] = [rejectedIds.tieA, rejectedIds.tieB].sort();
  const everyRejected = await get(superBAdmin, '/admin/approvals?status=rejected&limit=100');
  expectStatus(everyRejected, 200);
  assert.equal(everyRejected.body.nextCursor, null);
  assert.deepEqual(everyRejected.body.items.map(item => item.id),
    [rejectedIds.r5, rejectedIds.r4, tieLow, tieHigh, rejectedIds.r1]);
  const pagedApprovals = [];
  let approvalCursor = null;
  let approvalPages = 0;
  do {
    const page = await get(superBAdmin, `/admin/approvals?status=rejected&limit=2${approvalCursor ? `&cursor=${approvalCursor}` : ''}`);
    expectStatus(page, 200);
    for (const item of page.body.items) assert(!('cursorAt' in item));
    pagedApprovals.push(...page.body.items.map(item => item.id));
    approvalCursor = page.body.nextCursor;
    approvalPages += 1;
  } while (approvalCursor && approvalPages < 10);
  assert.deepEqual(pagedApprovals, everyRejected.body.items.map(item => item.id), 'approval pages must return every row once, in order');
  assert.equal(approvalPages, 3);
  const firstApprovals = await get(superBAdmin, '/admin/approvals?status=rejected&limit=2');
  const approvalsCursor = firstApprovals.body.nextCursor;
  const tamperedApprovals = `${approvalsCursor.slice(0, 15)}${approvalsCursor[15] === 'A' ? 'B' : 'A'}${approvalsCursor.slice(16)}`;
  for (const cursor of [tamperedApprovals, approvalsCursor.slice(0, -2), `${approvalsCursor}=`, 'bm90LWpzb24']) {
    expectStatus(await get(superBAdmin, `/admin/approvals?status=rejected&limit=2&cursor=${encodeURIComponent(cursor)}`),
      400, 'ADMIN_INVALID_CURSOR');
  }
  expectStatus(await get(superBAdmin, `/admin/approvals?status=approved&limit=2&cursor=${approvalsCursor}`), 400, 'ADMIN_INVALID_CURSOR');
  expectStatus(await get(superBAdmin, '/admin/approvals?limit=101'), 400, 'VALIDATION_FAILED');
  expectStatus(await get(supportAdmin, `/admin/approvals?status=rejected&limit=2&cursor=${approvalsCursor}`), 403, 'PERMISSION_DENIED');
  evidence.approvals_cursor = { rows: pagedApprovals.length, pages: approvalPages, microsecond_boundary: true,
    equal_timestamps: 'id order', tampered: 'ADMIN_INVALID_CURSOR', other_filter: 'ADMIN_INVALID_CURSOR',
    without_permission: 'PERMISSION_DENIED' };

  // 8. Governed MFA reset (lost authenticator): request + second Super Admin approval.
  expectStatus(await command(supportAdmin, `/admin/principals/${support.id}/mfa-reset-requests`,
    { reason: 'Reset my own authenticator' }, { 'Idempotency-Key': key('self-reset') }), 403, 'PERMISSION_DENIED');
  expectStatus(await command(sessionA2, `/admin/principals/${superA.id}/mfa-reset-requests`,
    { reason: 'Reset my own authenticator' }, { 'Idempotency-Key': key('own-reset') }), 403, 'ADMIN_SELF_CHANGE_DENIED');
  const reset = await command(sessionA2, `/admin/principals/${support.id}/mfa-reset-requests`,
    { reason: 'Support administrator lost their phone' }, { 'Idempotency-Key': key('reset') });
  expectStatus(reset, 201);
  const resetDecision = await decide(superBAdmin, reset.body.requestId, 'approve', reset.body.version, 'reset');
  expectStatus(resetDecision, 200);
  assert.equal(resetDecision.body.executed, true);
  expectStatus(await get(supportAdmin, '/admin/session'), 401, 'PLATFORM_SESSION_REVOKED');
  const supportFactors = (await owner.query(`select status, revocation_reason from auth.mfa_factors where account_id = $1`,
    [support.id])).rows;
  assert.deepEqual(supportFactors, [{ status: 'revoked', revocation_reason: 'admin_reset' }]);
  assert.equal((await owner.query(`select count(*)::int as n from auth.mfa_recovery_codes where account_id = $1
    and used_at is null and invalidated_at is null`, [support.id])).rows[0].n, 0);
  assert.equal((await platform.login(support.email)).response.body.status, 'mfa_enrollment_required');
  evidence.mfa_reset = { self: 'denied', approval: 'two-person', factor: 'revoked', sessions: 'revoked', next_sign_in: 'enrollment' };

  // 9. Recovery codes: one-time use, regeneration needs step-up and invalidates the old set.
  const recoveryLogin = await platform.login(superA.email);
  const recovered = await post('/auth/admin/mfa/verify', recoveryLogin.jar, { recoveryCode: recoveryA[0].toLowerCase() });
  expectStatus(recovered, 200);
  const sessionA3 = { ...sessionA1, jar: mergeCookies({}, recovered), csrf: recovered.headers['x-csrf-token'],
    sessionId: recovered.body.actor.sessionId };
  assert.equal((await get(sessionA3, '/admin/mfa')).body.session.mfaMethod, 'recovery_code');
  const reuse = await platform.login(superA.email);
  expectStatus(await post('/auth/admin/mfa/verify', reuse.jar, { recoveryCode: recoveryA[0] }), 401, 'MFA_INVALID_CODE');
  expectStatus(await command(sessionA3, '/admin/mfa/recovery-codes/regenerate'), 403, 'STEP_UP_REQUIRED');
  await platform.stepUp(sessionA3);
  const regenerated = await command(sessionA3, '/admin/mfa/recovery-codes/regenerate');
  expectStatus(regenerated, 200);
  assert.equal(regenerated.body.recoveryCodes.length, 10);
  const oldCode = await platform.login(superA.email);
  expectStatus(await post('/auth/admin/mfa/verify', oldCode.jar, { recoveryCode: recoveryA[1] }), 401, 'MFA_INVALID_CODE');
  expectStatus(await post('/auth/admin/mfa/verify', oldCode.jar, { recoveryCode: regenerated.body.recoveryCodes[0] }), 200);
  // Email OTP is not an administrator second factor: no admin purpose is accepted.
  const otpErrors = await validate(plainToInstance(StartOtpDto, { identifier: superA.email, purpose: 'ADMIN_STEP_UP',
    turnstileAction: 'admin-reset' }));
  assert(otpErrors.some(error => error.property === 'purpose'), 'email OTP must not accept an admin step-up purpose');
  evidence.recovery_codes = { reuse: 'MFA_INVALID_CODE', regenerate_without_step_up: 'STEP_UP_REQUIRED',
    old_code_after_regeneration: 'MFA_INVALID_CODE', email_otp_admin_purpose: 'rejected' };

  // 10. Session visibility and revocation.
  const sessions = await get(sessionA2, '/admin/sessions');
  expectStatus(sessions, 200);
  assert(sessions.body.items.some(item => item.current && item.kind === 'platform'));
  for (const item of sessions.body.items) {
    for (const forbidden of ['refreshToken', 'refresh_token_sha256', 'accessJti', 'access_jti', 'token', 'csrf']) {
      assert(!(forbidden in item), `session list exposes ${forbidden}`);
    }
  }
  expectStatus(await command(sessionA2, `/admin/sessions/${sessionA1.sessionId}/revoke`), 200);
  // Stage 4A: the holder of the revoked session's own token learns it was revoked.
  expectStatus(await get(sessionA1, '/admin/session'), 401, 'PLATFORM_SESSION_REVOKED');
  // The same session id with a forged signature, or the token outside platform
  // routes, gets only the generic answer: nothing to probe.
  const [header, payload, signature] = sessionA1.jar.hid_access_admin.split('.');
  const forged = `${header}.${payload}.${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BB' : 'AA'}`;
  expectStatus(await get({ jar: { ...sessionA1.jar, hid_access_admin: forged } }, '/admin/session'), 401, 'AUTHENTICATION_REQUIRED');
  expectStatus(await http.get('/api/v1/auth/session').set('Authorization', `Bearer ${sessionA1.jar.hid_access_admin}`),
    401, 'AUTHENTICATION_REQUIRED');
  const targetStaff = mergeCookies({}, await http.post('/api/v1/auth/login').set('Origin', origin)
    .send({ email: target.email, password, turnstileAction: 'staff-login' }));
  const targetSessions = await get(superBAdmin, `/admin/principals/${target.id}/sessions`);
  expectStatus(targetSessions, 200);
  const targetSession = targetSessions.body.items.find(item => item.kind === 'staff');
  expectStatus(await command(superBAdmin, `/admin/principals/${target.id}/sessions/${targetSession.sessionId}/revoke`,
    { reason: 'Reported lost laptop', compromised: true }, { 'Idempotency-Key': key('compromised') }), 200);
  // Staff sessions keep the generic answer.
  expectStatus(await http.get('/api/v1/auth/session').set('Cookie', cookieHeader(targetStaff)), 401, 'AUTHENTICATION_REQUIRED');
  const revokedEvent = (await owner.query(`select details from auth.session_events where account_id = $1
    and event_type = 'revoked' and details->>'compromised' = 'true'`, [target.id])).rows;
  assert.equal(revokedEvent.length, 1);
  evidence.sessions = { list_safe_metadata: true, own_revoke: 'PLATFORM_SESSION_REVOKED', forged_signature: 'AUTHENTICATION_REQUIRED',
    platform_token_on_staff_route: 'AUTHENTICATION_REQUIRED', staff_session_revoked: 'AUTHENTICATION_REQUIRED',
    compromised_revoke: 'recorded' };

  // 11. Idle timeout, refresh rotation and the absolute lifetime cap.
  const refresh = (admin) => http.post('/api/v1/auth/admin/refresh').set('Origin', origin)
    .set('Cookie', cookieHeader(admin.jar)).set('x-csrf-token', admin.jar.hid_access_admin_csrf);
  const rotated = await refresh(superBAdmin);
  expectStatus(rotated, 200);
  assert(new Date(rotated.body.idleExpiresAt).getTime() <= Date.now() + 901_000, 'idle window is at most 15 minutes');
  // Stage 4A: the refresh and CSRF cookies last until one idle window after
  // the end of the sign-in, so a refresh after an idle timeout or the 8-hour
  // limit reaches the server and is told why.
  const cookieExpiry = (response, name) => {
    const header = response.headers['set-cookie'].find(value => value.startsWith(`${name}=`));
    return new Date(/;\s*Expires=([^;]+)/i.exec(header)[1]).getTime();
  };
  const familyEnd = (await owner.query('select absolute_expires_at from auth.sessions where id = $1',
    [rotated.body.actor.sessionId])).rows[0].absolute_expires_at.getTime();
  for (const name of ['hid_access_admin_refresh', 'hid_access_admin_csrf']) {
    assert(Math.abs(cookieExpiry(rotated, name) - (familyEnd + 900_000)) < 1_000,
      `${name} must expire one idle window after the sign-in ends`);
  }
  assert(cookieExpiry(rotated, 'hid_access_admin') <= Date.now() + 301_000, 'the access cookie keeps the access-token lifetime');
  const superBRotated = { ...superBAdmin, jar: mergeCookies(superBAdmin.jar, rotated), csrf: rotated.headers['x-csrf-token'] };
  // Step-up is recorded on the session family, so it survives rotation.
  const exportPath = `/admin/principals/export?query=security-runtime&reason=${encodeURIComponent('Quarterly access review')}`;
  expectStatus(await get(superBRotated, exportPath), 200);
  // Reusing the rotated refresh token revokes the whole family.
  expectStatus(await refresh(superBAdmin), 401, 'PLATFORM_SESSION_REVOKED');
  expectStatus(await get(superBRotated, '/admin/session'), 401, 'PLATFORM_SESSION_REVOKED');
  const sessionEvents = async (sessionId, eventType) => (await owner.query(`select details from auth.session_events
    where session_id = $1 and event_type = $2`, [sessionId, eventType])).rows;
  assert.equal((await sessionEvents(superBAdmin.sessionId, 'reuse_detected')).length, 1, 'rotated-token reuse is recorded');
  // Stage 5: a refresh token whose session was signed out is refused with the
  // revoked code, recorded as a denied refresh, and not treated as reuse.
  const signedOut = await platform.signIn(superBAdmin);
  expectStatus(await platform.command(signedOut, '/auth/admin/logout'), 204);
  expectStatus(await refresh(signedOut), 401, 'PLATFORM_SESSION_REVOKED');
  expectStatus(await refresh(signedOut), 401, 'PLATFORM_SESSION_REVOKED');
  assert.equal((await sessionEvents(signedOut.sessionId, 'reuse_detected')).length, 0, 'a signed-out refresh token is not reuse');
  const deniedAfterLogout = await sessionEvents(signedOut.sessionId, 'refresh');
  assert.equal(deniedAfterLogout.length, 2);
  for (const { details } of deniedAfterLogout) {
    assert.deepEqual(details, { reason: 'session_ended', revocation_reason: 'logout', session_kind: 'platform' });
  }
  assert.equal((await owner.query(`select count(*)::int as n from auth.sessions where family_id = (
    select family_id from auth.sessions where id = $1) and revocation_reason = 'refresh_token_reuse'`,
  [signedOut.sessionId])).rows[0].n, 0, 'a signed-out family is not marked as reused');
  // Idle: a platform session not refreshed within its window ends.
  await owner.query(`update auth.sessions set issued_at = now() - interval '16 minutes',
    expires_at = now() - interval '1 minute', absolute_expires_at = now() - interval '16 minutes' + interval '8 hours'
    where id = $1`, [sessionA3.sessionId]);
  expectStatus(await get(sessionA3, '/admin/session'), 401, 'PLATFORM_SESSION_EXPIRED');
  expectStatus(await refresh(sessionA3), 401, 'PLATFORM_SESSION_EXPIRED');
  // A second tab presenting the same expired refresh token is told the same,
  // and it is not recorded as refresh-token reuse.
  expectStatus(await refresh(sessionA3), 401, 'PLATFORM_SESSION_EXPIRED');
  assert.equal((await sessionEvents(sessionA3.sessionId, 'reuse_detected')).length, 0);
  assert.deepEqual((await sessionEvents(sessionA3.sessionId, 'refresh')).map(row => row.details),
    [{ reason: 'session_ended', revocation_reason: 'expired', session_kind: 'platform' }]);
  // No refresh credential is a missing sign-in (401), a wrong CSRF token stays
  // 403, and an unknown refresh token is generic even with a matching CSRF value.
  expectStatus(await http.post('/api/v1/auth/admin/refresh').set('Origin', origin), 401, 'AUTHENTICATION_REQUIRED');
  expectStatus(await http.post('/api/v1/auth/admin/refresh').set('Origin', origin)
    .set('Cookie', `hid_access_admin_refresh=${sessionA3.jar.hid_access_admin_refresh}; hid_access_admin_csrf=wrong`)
    .set('x-csrf-token', 'wrong'), 403, 'CSRF_VALIDATION_FAILED');
  const unknownRefresh = `${randomUUID()}.${randomBytes(48).toString('base64url')}.local`;
  const unknownCsrf = createHmac('sha256', process.env.AUTH_SIGNING_SECRET).update(`csrf:${unknownRefresh}`, 'utf8')
    .digest('base64url');
  expectStatus(await http.post('/api/v1/auth/admin/refresh').set('Origin', origin)
    .set('Cookie', `hid_access_admin_refresh=${unknownRefresh}; hid_access_admin_csrf=${unknownCsrf}`)
    .set('x-csrf-token', unknownCsrf), 401, 'AUTHENTICATION_REQUIRED');
  // Absolute: a refresh never extends past the end of the sign-in.
  await owner.query(`update auth.sessions set issued_at = now() - interval '5 minutes',
    expires_at = now() + interval '1 minute', absolute_expires_at = now() + interval '2 minutes' where id = $1`,
  [sessionA2.sessionId]);
  const capped = await refresh(sessionA2);
  expectStatus(capped, 200);
  const absolute = (await owner.query('select absolute_expires_at from auth.sessions where id = $1', [sessionA2.sessionId]))
    .rows[0].absolute_expires_at;
  assert.equal(new Date(capped.body.idleExpiresAt).getTime(), absolute.getTime());
  // The refresh cookie still reaches the server after the 8-hour limit, which then answers why.
  assert(Math.abs(cookieExpiry(capped, 'hid_access_admin_refresh') - (absolute.getTime() + 900_000)) < 1_000);
  const cappedJar = mergeCookies(sessionA2.jar, capped);
  await owner.query(`update auth.sessions set issued_at = now() - interval '10 minutes',
    expires_at = now() - interval '1 second', absolute_expires_at = now() - interval '1 second' where id = $1`,
  [capped.body.actor.sessionId]);
  expectStatus(await http.post('/api/v1/auth/admin/refresh').set('Origin', origin).set('Cookie', cookieHeader(cappedJar))
    .set('x-csrf-token', cappedJar.hid_access_admin_csrf), 401, 'PLATFORM_SESSION_EXPIRED');
  evidence.session_policy = { idle: 'PLATFORM_SESSION_EXPIRED', refresh_reuse: 'PLATFORM_SESSION_REVOKED (family revoked)',
    absolute_cap: 'refresh capped at sign-in + 8h', refresh_cookie_lifetime: 'sign-in end + idle window',
    absolute_end: 'PLATFORM_SESSION_EXPIRED',
    repeated_expired_refresh: 'not reuse', signed_out_refresh: 'PLATFORM_SESSION_REVOKED, denied refresh, not reuse',
    missing_refresh_cookie: 'AUTHENTICATION_REQUIRED', unknown_refresh_token: 'AUTHENTICATION_REQUIRED' };

  // Stage 5: browser preflights for the Identity routes that use PATCH and DELETE.
  const preflight = (path, method, from = origin) => http.options(path).set('Origin', from)
    .set('Access-Control-Request-Method', method).set('Access-Control-Request-Headers', 'content-type,x-csrf-token');
  for (const [method, path] of [['DELETE', '/api/v1/identity/me/access-pin'],
    ['PATCH', '/api/v1/identity/organization-applications/completion/profile']]) {
    const allowed = await preflight(path, method);
    expectStatus(allowed, 204);
    assert.equal(allowed.headers['access-control-allow-origin'], origin);
    assert(String(allowed.headers['access-control-allow-methods']).split(',').includes(method), `CORS does not allow ${method}`);
    assert(String(allowed.headers['access-control-allow-headers']).split(',').includes('x-csrf-token'));
    const denied = await preflight(path, method, 'https://attacker.example.invalid');
    assert.equal(denied.headers['access-control-allow-origin'], undefined, 'an unlisted origin gets no CORS permission');
  }
  evidence.cors_preflight = { delete_access_pin: 204, patch_completion_profile: 204, unlisted_origin: 'no CORS headers' };

  // Stage 5B (0073): revocations racing a refresh rotation. A second connection
  // holds a rotation open exactly as TokenService.refresh makes it (new session
  // inserted, old one marked rotated, not yet committed) while a revocation runs
  // over HTTP. The revocation must wait for the rotation and then revoke the
  // session it created; before 0073 that session stayed live.
  const { Client } = require('pg');
  async function rotationInFlight(sessionId) {
    const client = new Client({ host: socket, user: process.env.PGUSER, database: isolated });
    client.on('error', () => undefined);
    await client.connect();
    const next = randomUUID();
    try {
      await client.query('begin');
      await client.query(`insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti,
          account_token_version, authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
        select $2, account_id, family_id, $3, gen_random_uuid(), account_token_version, authentication_method,
          issued_at, expires_at, absolute_expires_at, session_kind, patient_id
        from auth.sessions where id = $1`, [sessionId, next, randomBytes(32).toString('hex')]);
      const marked = await client.query(`update auth.sessions set revoked_at = clock_timestamp(),
          revocation_reason = 'rotated', replaced_by_session_id = $2, row_version = row_version + 1
        where id = $1 and revoked_at is null`, [sessionId, next]);
      assert.equal(marked.rowCount, 1, 'the simulated rotation marks the old session rotated');
    } catch (error) {
      await client.end();
      throw error;
    }
    return { sessionId: next, commit: async () => { try { await client.query('commit'); } finally { await client.end(); } } };
  }
  /** True once another backend of this database waits on a lock; false if `settled()` first or after 10 s. */
  async function lockWaitSeen(settled) {
    for (const deadline = Date.now() + 10_000; !settled() && Date.now() < deadline;) {
      const { rows } = await owner.query(`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
      if (rows[0].n > 0) return true;
      await new Promise(done => setTimeout(done, 20));
    }
    return false;
  }
  /** Starts `revocation` while a rotation of `sessionId` is open, commits the rotation once the revocation waits on it. */
  async function revokeDuringRotation(sessionId, revocation) {
    const rotation = await rotationInFlight(sessionId);
    let settled = false;
    const pending = Promise.resolve(revocation()).finally(() => { settled = true; });
    const waited = await lockWaitSeen(() => settled);
    await rotation.commit();
    const response = await pending;
    assert(waited, 'the revocation must reach the database while the rotation is still open');
    const created = (await owner.query('select revoked_at, revocation_reason from auth.sessions where id = $1',
      [rotation.sessionId])).rows[0];
    return { response, created };
  }
  const newestSession = async (accountId) => (await owner.query(`select id::text from auth.sessions
    where account_id = $1 and revoked_at is null order by issued_at desc, id limit 1`, [accountId])).rows[0].id;
  const staffSignIn = async () => {
    expectStatus(await http.post('/api/v1/auth/login').set('Origin', origin)
      .send({ email: target.email, password, turnstileAction: 'staff-login' }), 200);
    return newestSession(target.id);
  };
  const raceAdmin = await platform.signIn(superBAdmin);
  await platform.stepUp(raceAdmin);

  const familyRaceSession = await staffSignIn();
  const familyRace = await revokeDuringRotation(familyRaceSession, () => command(raceAdmin,
    `/admin/principals/${target.id}/sessions/${familyRaceSession}/revoke`,
    { reason: 'Reported stolen phone', compromised: true }, { 'Idempotency-Key': key('race-family') }));
  expectStatus(familyRace.response, 200);
  assert.equal(familyRace.response.body.revokedCount, 1, 'the compromised-family revocation revokes the rotated-in session');
  assert(familyRace.created.revoked_at, 'a session created during a compromised-family revocation must not stay live');
  assert.equal(familyRace.created.revocation_reason, 'platform_admin_compromised_session');

  const allRace = await revokeDuringRotation(await staffSignIn(), () => command(raceAdmin,
    `/admin/principals/${target.id}/sessions/revoke`, { reason: 'Account may be compromised' },
    { 'Idempotency-Key': key('race-all') }));
  expectStatus(allRace.response, 201);
  assert(allRace.created.revoked_at, 'a session created during a revoke-all must not stay live');
  assert.equal(allRace.created.revocation_reason, 'platform_admin_revocation');

  const ownOther = await platform.signIn(superBAdmin);
  const ownRace = await revokeDuringRotation(ownOther.sessionId, () => command(raceAdmin,
    `/admin/sessions/${ownOther.sessionId}/revoke`));
  expectStatus(ownRace.response, 200);
  assert(ownRace.created.revoked_at, 'a session created while an administrator revokes their own session must not stay live');
  assert.equal(ownRace.created.revocation_reason, 'self_revoked');

  // Refresh-token reuse: the first token of a family is presented again while
  // the family's current session is being rotated by its legitimate holder.
  const reusedFamily = await platform.signIn(superBAdmin);
  const reusedOnce = await refresh(reusedFamily);
  expectStatus(reusedOnce, 200);
  const reuseRace = await revokeDuringRotation(reusedOnce.body.actor.sessionId, () => refresh(reusedFamily));
  expectStatus(reuseRace.response, 401, 'PLATFORM_SESSION_REVOKED');
  assert(reuseRace.created.revoked_at, 'a session created during a reuse revocation must not stay live');
  assert.equal(reuseRace.created.revocation_reason, 'refresh_token_reuse');
  // A sign-out or an expiry during an administrator's revocation of the same
  // account: both lock the account row before the session, as every revocation
  // does (0073), so neither deadlocks. A second connection holds the
  // revocation the way the 0073 commands make it (account row locked, then the
  // UPDATE) and revokes only once the request waits on it.
  async function revocationWhile(accountId, request) {
    const revoker = new Client({ host: socket, user: process.env.PGUSER, database: isolated });
    revoker.on('error', () => undefined);
    await revoker.connect();
    let failure = null;
    try {
      await revoker.query('begin');
      await revoker.query('select auth.lock_account_sessions($1)', [accountId]);
      let settled = false;
      const pending = Promise.resolve(request()).finally(() => { settled = true; });
      const waited = await lockWaitSeen(() => settled);
      try {
        await revoker.query(`update auth.sessions set revoked_at = clock_timestamp(),
            revocation_reason = 'platform_admin_revocation', row_version = row_version + 1
          where account_id = $1 and revoked_at is null`, [accountId]);
        await revoker.query('commit');
      } catch (error) {
        failure = error.code ?? String(error);
        await revoker.query('rollback').catch(() => undefined);
      }
      const response = await pending;
      assert(waited, 'the request must reach the database while the revocation is still open');
      assert.equal(failure, null, `the revocation failed while the request waited (${failure})`);
      return response;
    } finally {
      await revoker.end();
    }
  }
  const targetLogin = async () => {
    const response = await http.post('/api/v1/auth/login').set('Origin', origin)
      .send({ email: target.email, password, turnstileAction: 'staff-login' });
    expectStatus(response, 200);
    return { jar: mergeCookies({}, response), csrf: response.headers['x-csrf-token'], sessionId: await newestSession(target.id) };
  };
  const leaving = await targetLogin();
  expectStatus(await revocationWhile(target.id, () => http.post('/api/v1/auth/logout').set('Origin', origin)
    .set('Cookie', cookieHeader(leaving.jar)).set('x-csrf-token', leaving.csrf)), 204);
  const expiring = await targetLogin();
  await owner.query(`update auth.sessions set issued_at = now() - interval '2 hours',
    expires_at = now() - interval '1 minute' where id = $1`, [expiring.sessionId]);
  expectStatus(await revocationWhile(target.id, () => http.post('/api/v1/auth/refresh').set('Origin', origin)
    .set('Cookie', cookieHeader(expiring.jar)).set('x-csrf-token', expiring.jar.hid_access_csrf)), 401, 'AUTHENTICATION_REQUIRED');
  assert.deepEqual((await owner.query(`select id::text, revocation_reason from auth.sessions where id = any($1::uuid[])
    order by id`, [[leaving.sessionId, expiring.sessionId]])).rows.map(row => row.revocation_reason),
  ['platform_admin_revocation', 'platform_admin_revocation'], 'the revocation that committed first keeps its reason');
  // A sign-out while a refresh of the same sign-in is in flight (another tab)
  // ends the session that refresh creates too.
  const racingSignOut = await targetLogin();
  const signOutRace = await revokeDuringRotation(racingSignOut.sessionId, () => http.post('/api/v1/auth/logout')
    .set('Origin', origin).set('Cookie', cookieHeader(racingSignOut.jar)).set('x-csrf-token', racingSignOut.csrf));
  expectStatus(signOutRace.response, 204);
  assert(signOutRace.created.revoked_at, 'a session created during a sign-out of its sign-in must not stay live');
  assert.equal(signOutRace.created.revocation_reason, 'logout');
  evidence.revocation_races = { waited_for_rotation: true, compromised_family: 'new session revoked',
    all_sessions: 'new session revoked', own_session: 'new session revoked', refresh_reuse: 'new session revoked',
    sign_out: 'new session revoked', sign_out_during_revocation: 'no deadlock', expiry_during_revocation: 'no deadlock' };

  // Stage 7A: an approved MFA reset racing an MFA transaction of its target.
  // auth.admin_decide_approval (0070) locks the target account row, then
  // revokes the target's factors, recovery codes and sessions. A second
  // connection makes that approval: it locks the target account as 0070 does,
  // waits until the MFA request reaches the database, notes which
  // authenticator rows the request holds while it waits, then runs the
  // approval command itself in the same transaction. Every MFA transaction
  // now locks the account first, so it waits holding no authenticator row and
  // the approval completes. Before, it waited holding the challenge and the
  // factor (or a recovery code), the approval then waited for the factor, and
  // PostgreSQL aborted one of the two with a deadlock.
  const AUTHENTICATOR_PROBES = [
    ['mfa_login_challenges', 'select 1 from auth.mfa_login_challenges where account_id = $1 for update nowait'],
    ['mfa_factors', 'select 1 from auth.mfa_factors where account_id = $1 for update nowait'],
    ['mfa_recovery_codes', 'select 1 from auth.mfa_recovery_codes where account_id = $1 for update nowait'],
    ['session_assurance', 'select 1 from auth.session_assurance where account_id = $1 for update nowait'],
  ];
  /** Authenticator tables in which another transaction holds a row of `accountId` (NOWAIT refused with 55P03). */
  async function heldAuthenticatorRows(accountId) {
    const held = [];
    const probe = await owner.connect();
    try {
      for (const [table, sql] of AUTHENTICATOR_PROBES) {
        await probe.query('begin');
        try {
          await probe.query(sql, [accountId]);
        } catch (error) {
          if (error.code !== '55P03') throw error;
          held.push(table);
        } finally {
          await probe.query('rollback');
        }
      }
    } finally {
      probe.release();
    }
    return held;
  }
  const deadlocks = async () => Number((await owner.query(`select deadlocks from pg_stat_database
    where datname = current_database()`)).rows[0].deadlocks);
  async function approvalWhile(approver, reset, targetId, request) {
    const approval = new Client({ host: socket, user: process.env.PGUSER, database: isolated });
    approval.on('error', () => undefined);
    await approval.connect();
    try {
      await approval.query('begin');
      // The approver's request context, as DatabaseService.withTransaction sets it.
      await approval.query(`select set_config('app.actor_subject', $1, true), set_config('app.session_id', $2, true),
          set_config('app.correlation_id', $3, true), set_config('app.access_scope', 'platform', true),
          set_config('app.facility_id', '', true), set_config('app.membership_id', '', true),
          set_config('app.purpose_of_use', 'healthcare-operations', true)`,
      [approver.subject, approver.sessionId, randomUUID()]);
      // 0070: the approval locks the target account row before it revokes the factor.
      await approval.query('select 1 from auth.accounts where id = $1 for update', [targetId]);
      let settled = false;
      const pending = Promise.resolve(request()).finally(() => { settled = true; });
      const waited = await lockWaitSeen(() => settled);
      const held = waited ? await heldAuthenticatorRows(targetId) : null;
      let outcome;
      try {
        const decided = (await approval.query('select executed from auth.admin_decide_approval($1, $2, $3, $4, $5, $6)',
          [reset.requestId, reset.version, 'approve', 'Second Super Admin approves the lost authenticator reset',
            key('race-decide'), createHmac('sha256', 'race').update(reset.requestId).digest('hex')])).rows[0];
        await approval.query('commit');
        outcome = decided?.executed === true ? 'committed' : 'not executed';
      } catch (error) {
        outcome = error.code ?? String(error);
        await approval.query('rollback').catch(() => undefined);
      }
      const response = await pending;
      return { waited, held, approval: outcome, status: response.status, code: response.body?.code ?? null };
    } finally {
      await approval.end();
    }
  }
  const requester = await platform.signIn({ email: superA.email, secret: secretA });
  await platform.stepUp(requester);
  const approver = { ...await platform.signIn(superBAdmin), subject: 'synthetic:security-runtime:super-b' };
  await platform.stepUp(approver);
  /** A platform account with an enrolled TOTP factor and a pending, approvable MFA reset request. */
  async function resetTarget(label, { enroll = true } = {}) {
    const target = await account(label, { platformRole: 'security_auditor' });
    const enrolled = enroll ? await platform.enroll(target.email) : null;
    return { ...target, enrolled };
  }
  async function requestReset(targetId) {
    const created = await command(requester, `/admin/principals/${targetId}/mfa-reset-requests`,
      { reason: 'Target administrator reported a lost authenticator' }, { 'Idempotency-Key': key('race-reset') });
    expectStatus(created, 201);
    return created.body;
  }
  const expectRace = (race, status, code) => assert.deepEqual(race,
    { waited: true, held: [], approval: 'committed', status, code },
    `an approved MFA reset racing its target's MFA transaction: ${JSON.stringify(race)}`);
  const liveSessions = async (accountId) => (await owner.query(`select count(*)::int as n from auth.sessions
    where account_id = $1 and revoked_at is null`, [accountId])).rows[0].n;
  const deadlocksBefore = await deadlocks();

  // Sign-in with a TOTP code: the challenge is refused once the reset changed the token version.
  const totpTarget = await resetTarget('race-totp');
  const totpReset = await requestReset(totpTarget.id);
  const totpLogin = await platform.login(totpTarget.email);
  const totpRace = await approvalWhile(approver, totpReset, totpTarget.id,
    () => post('/auth/admin/mfa/verify', totpLogin.jar, { code: platform.code(totpTarget.enrolled.secret) }));
  expectRace(totpRace, 401, 'MFA_CHALLENGE_INVALID');
  assert.equal(await liveSessions(totpTarget.id), 0, 'no session survives a reset that raced the sign-in');

  // Sign-in with a recovery code: refused, and the code is invalidated by the reset, never spent.
  const recoveryTarget = await resetTarget('race-recovery');
  const recoveryReset = await requestReset(recoveryTarget.id);
  const recoveryRaceLogin = await platform.login(recoveryTarget.email);
  const recoveryRace = await approvalWhile(approver, recoveryReset, recoveryTarget.id,
    () => post('/auth/admin/mfa/verify', recoveryRaceLogin.jar, { recoveryCode: recoveryTarget.enrolled.recoveryCodes[0] }));
  expectRace(recoveryRace, 401, 'MFA_CHALLENGE_INVALID');
  assert.deepEqual((await owner.query(`select count(*) filter (where used_at is not null)::int as used,
      count(*) filter (where invalidated_at is null)::int as open
    from auth.mfa_recovery_codes where account_id = $1`, [recoveryTarget.id])).rows[0], { used: 0, open: 0 });
  assert.equal(await liveSessions(recoveryTarget.id), 0);

  // Step-up: the session the reset revoked can no longer step up.
  const stepUpTarget = await resetTarget('race-step-up');
  const stepUpReset = await requestReset(stepUpTarget.id);
  const stepUpRace = await approvalWhile(approver, stepUpReset, stepUpTarget.id,
    () => command(stepUpTarget.enrolled, '/admin/mfa/step-up', { code: platform.code(stepUpTarget.enrolled.secret) }));
  expectRace(stepUpRace, 403, 'PLATFORM_SESSION_REQUIRED');
  assert.equal((await owner.query(`select count(*)::int as n from auth.session_assurance
    where account_id = $1 and step_up_at is not null`, [stepUpTarget.id])).rows[0].n, 0, 'no step-up is recorded');

  // Recovery-code regeneration: refused; the reset leaves no open code.
  const regenerateTarget = await resetTarget('race-regenerate');
  await platform.stepUp(regenerateTarget.enrolled);
  const regenerateReset = await requestReset(regenerateTarget.id);
  const regenerateRace = await approvalWhile(approver, regenerateReset, regenerateTarget.id,
    () => command(regenerateTarget.enrolled, '/admin/mfa/recovery-codes/regenerate'));
  expectRace(regenerateRace, 403, 'PLATFORM_SESSION_REQUIRED');
  assert.equal((await owner.query(`select count(*)::int as n from auth.mfa_recovery_codes
    where account_id = $1 and invalidated_at is null`, [regenerateTarget.id])).rows[0].n, 0);

  // Enrolment: activating a pending factor, and starting enrolment again over a pending factor.
  const activateTarget = await resetTarget('race-activate', { enroll: false });
  const activating = await platform.login(activateTarget.email);
  const pendingFactor = await post('/auth/admin/mfa/enroll/start', activating.jar);
  expectStatus(pendingFactor, 200);
  const activateReset = await requestReset(activateTarget.id);
  const activateRace = await approvalWhile(approver, activateReset, activateTarget.id,
    () => post('/auth/admin/mfa/enroll/activate', activating.jar, { code: platform.code(pendingFactor.body.secret) }));
  expectRace(activateRace, 401, 'MFA_CHALLENGE_INVALID');
  const restartTarget = await resetTarget('race-restart', { enroll: false });
  const restarting = await platform.login(restartTarget.email);
  expectStatus(await post('/auth/admin/mfa/enroll/start', restarting.jar), 200);
  const restartReset = await requestReset(restartTarget.id);
  const restartRace = await approvalWhile(approver, restartReset, restartTarget.id,
    () => post('/auth/admin/mfa/enroll/start', restarting.jar));
  expectRace(restartRace, 401, 'MFA_CHALLENGE_INVALID');
  for (const target of [activateTarget, restartTarget]) {
    assert.deepEqual((await owner.query(`select status, revocation_reason from auth.mfa_factors where account_id = $1`,
      [target.id])).rows, [{ status: 'revoked', revocation_reason: 'admin_reset' }], 'the reset revoked the pending factor');
  }
  // Every reset target signs in to enrolment afterwards, and the races recorded no deadlock.
  for (const target of [totpTarget, recoveryTarget, stepUpTarget, regenerateTarget, activateTarget, restartTarget]) {
    assert.equal((await platform.login(target.email)).response.body.status, 'mfa_enrollment_required');
  }
  const raceDeadlocks = (await deadlocks()) - deadlocksBefore;
  assert.equal(raceDeadlocks, 0, 'the MFA reset races recorded a deadlock');
  evidence.mfa_reset_races = { approval: 'committed', authenticator_rows_held_while_waiting: 'none',
    totp_sign_in: 'MFA_CHALLENGE_INVALID', recovery_code_sign_in: 'MFA_CHALLENGE_INVALID (code not spent)',
    step_up: 'PLATFORM_SESSION_REQUIRED', recovery_code_regeneration: 'PLATFORM_SESSION_REQUIRED',
    enrollment_activation: 'MFA_CHALLENGE_INVALID', enrollment_restart: 'MFA_CHALLENGE_INVALID',
    deadlocks: raceDeadlocks };

  // 12. Principal export: restricted permission, step-up, reason, RFC 4180 CSV.
  const exporter = await platform.signIn(superBAdmin);
  expectStatus(await get(exporter, exportPath), 403, 'STEP_UP_REQUIRED');
  await platform.stepUp(exporter);
  expectStatus(await get(exporter, '/admin/principals/export?query=security-runtime'), 400, 'REASON_REQUIRED');
  const exported = await get(exporter, exportPath, { Origin: origin });
  expectStatus(exported, 200);
  // Stage 4A: an allowed cross-origin console may read the export metadata.
  assert.equal(exported.headers['access-control-allow-origin'], origin);
  const exposedHeaders = String(exported.headers['access-control-expose-headers']).toLowerCase().split(',').map(value => value.trim());
  for (const name of ['x-hid-export-row-count', 'x-hid-export-row-limit', 'x-hid-export-truncated']) {
    assert(exposedHeaders.includes(name), `CORS does not expose ${name}`);
  }
  assert.equal(exported.headers['content-type'], 'text/csv; charset=utf-8; header=present');
  assert.equal(exported.headers['cache-control'], 'no-store');
  assert.equal(exported.headers['x-hid-export-row-limit'], '5000');
  assert.equal(exported.headers['x-hid-export-truncated'], 'false');
  assert(exported.text.endsWith('\r\n') && !/[^\r]\n/.test(exported.text), 'every record ends with CRLF');
  const lines = exported.text.split('\r\n');
  assert.equal(lines[0], 'account_id,email,display_name,status,created_at,platform_roles');
  assert(lines.some(line => line.includes(`"'=HYPERLINK(""https://example.invalid"")"`)), 'formula injection is neutralized');
  assert(!exported.text.includes('synthetic:security-runtime'), 'the export carries no subjects');
  const supportAgain = await platform.enroll(support.email);
  expectStatus(await get(supportAgain, exportPath), 403, 'PERMISSION_DENIED');
  const exportAudit = (await owner.query(`select reason, details from audit.events where action = 'admin.principals.export'
    order by sequence_id desc limit 1`)).rows[0];
  assert.equal(exportAudit.reason, 'Quarterly access review');
  evidence.export = { permission: 'platform.principal.export', step_up: true, reason: true, crlf: true,
    formula_neutralized: true, rows: Number(exported.headers['x-hid-export-row-count']),
    cors_exposed: ['x-hid-export-row-count', 'x-hid-export-row-limit', 'x-hid-export-truncated'] };

  // 13. No secret, code or token is written to audit or session evidence.
  const secrets = [secretA, limitedAdmin.secret, superBAdmin.secret, ...recoveryA, ...regenerated.body.recoveryCodes,
    sessionA2.jar.hid_access_admin_refresh];
  const evidenceRows = (await owner.query(`select coalesce(details::text, '') || coalesce(reason, '') as text from audit.events
    union all select details::text from auth.session_events`)).rows.map(row => row.text).join('\n');
  for (const secret of secrets) assert(!evidenceRows.includes(secret), 'a secret appeared in audit or session evidence');
  const eventTypes = (await owner.query(`select distinct event_type from auth.session_events
    where account_id = any($1::uuid[])`, [[superA.id, superB.id, support.id, limited.id]])).rows.map(row => row.event_type);
  for (const type of ['mfa_challenge_issued', 'mfa_enrollment_started', 'mfa_enrolled', 'mfa_verified', 'mfa_failed',
    'mfa_recovery_code_used', 'mfa_recovery_codes_regenerated', 'step_up_verified', 'step_up_failed', 'mfa_reset',
    'mfa_rate_limited']) {
    assert(eventTypes.includes(type), `missing session event ${type}`);
  }
  evidence.no_secrets_in_evidence = true;

  process.stdout.write(JSON.stringify({ status: 'passed', runtimeRole, evidence }) + '\n');
} finally {
  await app?.close();
  await owner.end();
  await maintenance.query(`drop database if exists ${isolated} with (force)`);
  await maintenance.end();
}
