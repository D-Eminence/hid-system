#!/usr/bin/env node
// Phase 4 Stage 2A platform security over HTTP, executed as the exact Identity
// API runtime role against a disposable copy of the owned synthetic rehearsal.
// The real DatabaseService, SecurityGuard, AuditInterceptor, controllers,
// services, TOTP verification and database commands run. Only TOTP time steps
// come from a virtual clock (see platform-session-client.mjs); no notification
// or network call is made. All values are synthetic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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
  expectStatus(crossRefresh, 401);
  expectStatus(await get(sessionA1, '/admin/session'), 200);
  evidence.session_kinds = { staff_on_platform: 'PLATFORM_SESSION_REQUIRED', platform_on_staff: 'PLATFORM_SESSION_SCOPE_DENIED',
    platform_refresh_on_staff_endpoint: 401 };

  // 4. A TOTP code is accepted once: a replay of the last accepted step fails.
  const secondLogin = await platform.login(superA.email);
  assert.equal(secondLogin.response.body.status, 'mfa_required');
  const replayed = totp.totp(totp.base32Decode(secretA), clock.now());
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
  // Super Admin is never granted in one step.
  expectStatus(await roleChange(sessionA2, { roleCode: 'platform_super_admin', action: 'grant', reason: 'One-step elevation' },
    { 'If-Match': String(await accountVersion(target.id)), 'Idempotency-Key': key('role-6') }), 403, 'TWO_PERSON_APPROVAL_REQUIRED');
  evidence.step_up = { without: 'STEP_UP_REQUIRED', if_match: 428, reason: 'REASON_REQUIRED', per_session_family: true,
    direct_super_admin_grant: 'TWO_PERSON_APPROVAL_REQUIRED' };

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
  expectStatus(await get(supportAdmin, '/admin/session'), 401);
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
  expectStatus(await get(sessionA1, '/admin/session'), 401);
  const targetStaff = mergeCookies({}, await http.post('/api/v1/auth/login').set('Origin', origin)
    .send({ email: target.email, password, turnstileAction: 'staff-login' }));
  const targetSessions = await get(superBAdmin, `/admin/principals/${target.id}/sessions`);
  expectStatus(targetSessions, 200);
  const targetSession = targetSessions.body.items.find(item => item.kind === 'staff');
  expectStatus(await command(superBAdmin, `/admin/principals/${target.id}/sessions/${targetSession.sessionId}/revoke`,
    { reason: 'Reported lost laptop', compromised: true }, { 'Idempotency-Key': key('compromised') }), 200);
  expectStatus(await http.get('/api/v1/auth/session').set('Cookie', cookieHeader(targetStaff)), 401);
  const revokedEvent = (await owner.query(`select details from auth.session_events where account_id = $1
    and event_type = 'revoked' and details->>'compromised' = 'true'`, [target.id])).rows;
  assert.equal(revokedEvent.length, 1);
  evidence.sessions = { list_safe_metadata: true, own_revoke: 401, compromised_revoke: 'recorded' };

  // 11. Idle timeout, refresh rotation and the absolute lifetime cap.
  const refresh = (admin) => http.post('/api/v1/auth/admin/refresh').set('Origin', origin)
    .set('Cookie', cookieHeader(admin.jar)).set('x-csrf-token', admin.jar.hid_access_admin_csrf);
  const rotated = await refresh(superBAdmin);
  expectStatus(rotated, 200);
  assert(new Date(rotated.body.idleExpiresAt).getTime() <= Date.now() + 901_000, 'idle window is at most 15 minutes');
  const superBRotated = { ...superBAdmin, jar: mergeCookies(superBAdmin.jar, rotated), csrf: rotated.headers['x-csrf-token'] };
  // Step-up is recorded on the session family, so it survives rotation.
  const exportPath = `/admin/principals/export?query=security-runtime&reason=${encodeURIComponent('Quarterly access review')}`;
  expectStatus(await get(superBRotated, exportPath), 200);
  // Reusing the rotated refresh token revokes the whole family.
  expectStatus(await refresh(superBAdmin), 401);
  expectStatus(await get(superBRotated, '/admin/session'), 401);
  // Idle: a platform session not refreshed within its window ends.
  await owner.query(`update auth.sessions set issued_at = now() - interval '16 minutes',
    expires_at = now() - interval '1 minute', absolute_expires_at = now() - interval '16 minutes' + interval '8 hours'
    where id = $1`, [sessionA3.sessionId]);
  expectStatus(await get(sessionA3, '/admin/session'), 401);
  expectStatus(await refresh(sessionA3), 401);
  // Absolute: a refresh never extends past the end of the sign-in.
  await owner.query(`update auth.sessions set issued_at = now() - interval '5 minutes',
    expires_at = now() + interval '1 minute', absolute_expires_at = now() + interval '2 minutes' where id = $1`,
  [sessionA2.sessionId]);
  const capped = await refresh(sessionA2);
  expectStatus(capped, 200);
  const absolute = (await owner.query('select absolute_expires_at from auth.sessions where id = $1', [sessionA2.sessionId]))
    .rows[0].absolute_expires_at;
  assert.equal(new Date(capped.body.idleExpiresAt).getTime(), absolute.getTime());
  evidence.session_policy = { idle: 401, refresh_reuse: 'family revoked', absolute_cap: 'refresh capped at sign-in + 8h' };

  // 12. Principal export: restricted permission, step-up, reason, RFC 4180 CSV.
  const exporter = await platform.signIn(superBAdmin);
  expectStatus(await get(exporter, exportPath), 403, 'STEP_UP_REQUIRED');
  await platform.stepUp(exporter);
  expectStatus(await get(exporter, '/admin/principals/export?query=security-runtime'), 400, 'REASON_REQUIRED');
  const exported = await get(exporter, exportPath);
  expectStatus(exported, 200);
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
    formula_neutralized: true, rows: Number(exported.headers['x-hid-export-row-count']) };

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
