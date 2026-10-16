#!/usr/bin/env node
// The first Super Admin's own password, over HTTP (owner decision 2026-10-16,
// SUPERADMIN-ACCOUNTS: "By email, own password"). admin:bootstrap with
// PLATFORM_ADMIN_EMAILS created the account named by PLATFORM_ADMIN_EMAIL:
// platform-only, pending_reset, no password, granted platform_super_admin.
// Here the real Identity controllers, services and database commands run as
// the Identity runtime LOGIN of the non-superuser database check
// (scripts/verify-non-superuser-database.mjs), which spawns this script on
// its own disposable cluster, as RDS runs them: no superuser connection and no
// SET ROLE. Only TOTP time steps come from a virtual clock, and a stand-in for
// the notification client keeps the codes Identity would deliver. All values
// are synthetic.
//
// 1. The staff and patient recovery pages reach no such account: their starts
//    answer 202 alike and deliver nothing.
// 2. Platform sign-in refuses it before a password is set (401, as a wrong
//    password).
// 3. The admin reset (Turnstile action admin-reset) delivers a code to its
//    address; verify and complete set the person's own password.
// 4. Platform sign-in with that password asks for an authenticator; the
//    enrolment needs no emailed code; activation opens a platform session
//    with platform_super_admin, and /admin/session accepts it.
// 5. Staff sign-in refuses it (401): a platform-only account is not staff.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createTotpClock, expectStatus, mergeCookies, platformClient } from './platform-session-client.mjs';

const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
const login = process.env.IDENTITY_LOGIN;
const email = process.env.PLATFORM_ADMIN_EMAIL;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-non-superuser.')
  && process.env.PGDATABASE === 'hid_non_superuser_email' && login === 'hid_rds_like_identity'
  && /^example-[a-z0-9.-]+@example\.invalid$/.test(email ?? ''),
'Only the non-superuser database check\'s own synthetic cluster is supported');
const origin = 'https://admin.staging.healthidentitydirectory.com';
const databaseUrl = new URL('postgresql://localhost');
databaseUrl.username = login;
databaseUrl.pathname = `/${process.env.PGDATABASE}`;
databaseUrl.searchParams.set('host', socket);
Object.assign(process.env, { AUTH_MODE: 'local', AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'staging',
  NIN_PROVIDER_MODE: 'deferred', CORS_ORIGINS: origin, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'example-synthetic-ehr-workload-token', TURNSTILE_MODE: 'disabled',
  AUTH_SIGNING_SECRET: randomBytes(32).toString('base64url'), AUTH_LOGIN_PEPPER: randomBytes(32).toString('base64url'),
  OTP_HMAC_KEY_B64: randomBytes(32).toString('base64'), MFA_SECRET_KEY_B64: randomBytes(32).toString('base64'),
  MFA_KEY_VERSION: 'example-email-bootstrap-v1', DATABASE_URL: databaseUrl.toString() });
delete process.env.AUTH_COOKIE_DOMAIN;
require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const load = (path) => require(join(service, 'src', path));
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
const { OtpController } = load('auth/otp.controller.ts');
const { OtpService } = load('auth/otp.service.ts');
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
const { AdminController } = load('admin/admin.controller.ts');
const { AdminService } = load('admin/admin.service.ts');
const { AdminOperationsService } = load('admin/admin-operations.service.ts');
const { PricingService } = load('admin/pricing.service.ts');
const { DomainProblem, ProblemDetailsFilter } = load('common/problem.ts');

globalThis.fetch = async (input) => { throw new Error(`Unexpected outbound request to ${String(input)}`); };
let app;
try {
  const clock = createTotpClock();
  // The codes Identity would deliver, in order.
  const deliveries = [];
  const notification = { deliver: async (input) => { deliveries.push(input); return { outcome: 'accepted', provider: 'synthetic' }; } };
  const google = { login: async () => { throw new Error('Google is outside this verifier'); },
    exchange: async () => { throw new Error('Google is outside this verifier'); } };
  const module = await Test.createTestingModule({
    controllers: [AuthController, PlatformAuthController, OtpController, AdminController],
    providers: [DatabaseService, TokenService, LocalAuthProvider, CurrentStaffContextService, CurrentPatientContextService,
      AuthService, AuthSessionAuditService, AuditService, WorkloadAuthService, TurnstileService, OtpService, MfaService,
      MfaSecretProtector, AdminService, AdminOperationsService, PricingService,
      { provide: MFA_TOTP_CLOCK, useValue: clock.now },
      { provide: NotificationOtpClient, useValue: notification },
      { provide: GoogleAuthenticationService, useValue: google }],
  }).compile();
  // The Identity runtime LOGIN itself, a member of hid_identity_api_runtime, as on RDS.
  const role = (await module.get(DatabaseService).query(`select current_user as login,
      pg_has_role(current_user, 'hid_identity_api_runtime', 'MEMBER') as member,
      (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as privileged`)).rows[0];
  assert.deepEqual(role, { login, member: true, privileged: false });
  app = module.createNestApplication({ logger: false });
  app.use(require('cookie-parser')());
  app.use((req, _res, next) => { req.correlationId = randomUUID(); next(); });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
    exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
      errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalGuards(new SecurityGuard(module.get(Reflector), module.get(TokenService),
    module.get(AuditService), module.get(DatabaseService)));
  app.useGlobalInterceptors(new AuditInterceptor(module.get(Reflector), module.get(AuditService)));
  await app.init();
  const http = request(app.getHttpServer());
  const post = (path, body, cookies = {}) => http.post(`/api/v1${path}`).set('Origin', origin)
    .set('Cookie', Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ')).send(body);
  const settle = () => module.get(OtpService).settleDeliveries();
  const evidence = {};

  // 1. Another page's start reaches no platform administrator.
  const otherPages = {};
  for (const action of ['staff-reset', 'patient-reset-start']) {
    const started = await post('/auth/otp/start', { identifier: email, purpose: 'PASSWORD_RESET', turnstileAction: action });
    expectStatus(started, 202);
    await settle();
    otherPages[action] = { status: started.status, delivered: deliveries.length };
  }
  assert.deepEqual(otherPages, { 'staff-reset': { status: 202, delivered: 0 }, 'patient-reset-start': { status: 202, delivered: 0 } });
  evidence.other_recovery_pages = otherPages;

  // 2. No password yet: platform sign-in answers as a wrong password.
  const early = await post('/auth/admin/login', { email, password: 'example-not-set-password-2026', turnstileAction: 'admin-login' });
  expectStatus(early, 401);
  evidence.sign_in_before_reset = early.status;

  // 3. The admin reset sets the person's own password.
  const started = await post('/auth/otp/start', { identifier: email.toUpperCase(), purpose: 'PASSWORD_RESET',
    turnstileAction: 'admin-reset' });
  expectStatus(started, 202);
  await settle();
  assert.equal(deliveries.length, 1, 'the admin reset delivers one code');
  const [delivery] = deliveries;
  assert.deepEqual([delivery.recipient, delivery.channel, delivery.purpose, delivery.challengeId],
    [email, 'email', 'PASSWORD_RESET', started.body.challengeId]);
  assert.match(delivery.code, /^[0-9]{6}$/);
  const verified = await post('/auth/otp/verify', { challengeId: started.body.challengeId, purpose: 'PASSWORD_RESET',
    code: delivery.code });
  expectStatus(verified, 200);
  const password = `example-own-password-${randomBytes(9).toString('base64url')}`;
  expectStatus(await post('/auth/otp/complete', { challengeId: started.body.challengeId, purpose: 'PASSWORD_RESET',
    verificationToken: verified.body.verificationToken, newPassword: password }), 200);
  evidence.admin_reset = { start: started.status, delivered_to: 'the bootstrapped address', channel: delivery.channel,
    verify: verified.status, complete: 200 };

  // 4. First platform sign-in: password, then an authenticator, no email code.
  const platform = platformClient({ http, origin, totp, clock, password });
  const first = await platform.login(email);
  assert.equal(first.response.body.status, 'mfa_enrollment_required');
  const enrollment = await platform.post('/auth/admin/mfa/enroll/start', first.jar);
  expectStatus(enrollment, 200);
  assert.match(enrollment.body.secret, /^[A-Z2-7]{32}$/);
  const activated = await platform.post('/auth/admin/mfa/enroll/activate', first.jar,
    { code: platform.code(enrollment.body.secret) });
  expectStatus(activated, 200);
  const { actor } = activated.body;
  assert.equal(actor.kind, 'platform');
  assert.equal(actor.email, email);
  assert.deepEqual(actor.platformRoles, ['platform_super_admin']);
  assert.ok(actor.platformPermissions.includes('platform.admin.access'));
  assert.equal(activated.body.recoveryCodes.length, 10);
  const session = await http.get('/api/v1/admin/session')
    .set('Cookie', Object.entries(mergeCookies({}, activated)).map(([name, value]) => `${name}=${value}`).join('; '));
  expectStatus(session, 200);
  evidence.first_platform_sign_in = { password_step: first.response.body.status, enrolment_email_code: 'not required',
    session: actor.kind, platform_roles: actor.platformRoles, admin_session: session.status,
    recovery_codes: activated.body.recoveryCodes.length };

  // 5. Not a staff account.
  const staffSignIn = await post('/auth/login', { email, password, turnstileAction: 'staff-login' });
  expectStatus(staffSignIn, 401);
  evidence.staff_sign_in = staffSignIn.status;
  assert.equal(deliveries.length, 1, 'no other code was delivered');
  process.stdout.write(`${JSON.stringify({ status: 'passed', account_id: actor.accountId, run_as: login, ...evidence })}\n`);
} finally {
  await app?.close();
}
