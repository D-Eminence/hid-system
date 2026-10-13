#!/usr/bin/env node
// Staff MFA over HTTP (launch blocker MFA-1, decision D14, migration 0088),
// executed as the exact Identity API runtime role against a disposable copy of
// the owned synthetic rehearsal. The real DatabaseService, SecurityGuard,
// AuditInterceptor, controllers, MFA, token and OTP services and database
// commands run. Only TOTP time steps come from a virtual clock and the codes
// Identity would deliver are kept by a stand-in for the notification client
// (staff-session-client.mjs); no network call is made. All values are
// synthetic.
//
// 1. The staff password step yields a challenge cookie and no session.
// 2. A first enrolment needs a fresh proof: the code emailed to the account.
// 3. The session comes after the first TOTP code, with its MFA assurance;
//    refresh keeps it; a TOTP code is accepted once; a recovery code works
//    once, audited.
// 4. A staff challenge is accepted by no platform step.
// 5. A staff session without assurance (as every sign-in before 0088) is
//    refused on authorized routes (403 STAFF_MFA_REQUIRED, audited) and on
//    refresh, which ends it; it can still sign out.
// 6. Google exchange with a staff action is refused.
// 7. An OTP password recovery keeps the factor: the next sign-in of an
//    enrolled account still needs the authenticator, so for that account a
//    mailbox alone yields no session. (An account without a factor enrols on a
//    code sent to the same mailbox; see INTERFACE_CONTRACT.md.)
// 8. A two-person MFA reset of a staff account by two Super Admins revokes the
//    factor and the staff sessions; the next sign-in enrols again on a fresh
//    emailed code.
// 9. One factor serves both sign-ins only if it was enrolled with the staff
//    proof: the platform first enrolment of an account that also signs in as
//    staff is refused (enrol at staff sign-in instead), and a factor a
//    platform enrolment created on the password alone never verifies a staff
//    sign-in (403 STAFF_MFA_FACTOR_UNPROVEN) until a governed reset.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { cookieHeader, createTotpClock, expectStatus, mergeCookies, platformClient } from './platform-session-client.mjs';
import { enrollmentCodeOutbox, setCookies, staffClient, supertestTransport, SYNTHETIC_STAFF_MFA_KEY_B64,
  totpAt } from './staff-session-client.mjs';

const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
const isolated = `hid_rehearsal_staff_mfa_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const origin = 'https://staging.healthidentitydirectory.com';
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'staging',
  NIN_PROVIDER_MODE: 'deferred', CORS_ORIGINS: origin, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'public-synthetic-ehr-workload-token', TURNSTILE_MODE: 'disabled',
  MFA_SECRET_KEY_B64: SYNTHETIC_STAFF_MFA_KEY_B64, MFA_KEY_VERSION: 'staff-mfa-runtime-v1',
  OTP_HMAC_KEY_B64: process.env.OTP_HMAC_KEY_B64 ?? Buffer.alloc(32, 0x33).toString('base64'),
  GOOGLE_OIDC_CLIENT_IDS: 'synthetic-google-client.apps.googleusercontent.com',
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
const { PlatformSecurityController } = load('admin/platform-security.controller.ts');
const { PlatformSecurityService } = load('admin/platform-security.service.ts');
const { DomainProblem, ProblemDetailsFilter } = load('common/problem.ts');

globalThis.fetch = async (input) => { throw new Error(`Unexpected outbound request to ${String(input)}`); };
const maintenance = new Pool({ host: socket, user: process.env.PGUSER, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
const owner = new Pool({ host: socket, user: process.env.PGUSER, database: isolated, max: 3 });
// Dropping the disposable database terminates any connection still closing.
owner.on('error', () => undefined);
let app;
try {
  const argon2 = require('argon2');
  const password = 'Synthetic-Staff-Mfa-Password-2026';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const ids = { org: randomUUID(), facility: randomUUID() };
  await owner.query("insert into identity.organizations (id, name, slug) values ($1, 'Staff MFA Runtime Organization', $2)",
    [ids.org, `staff-mfa-runtime-${ids.org.slice(0, 8)}`]);
  await owner.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
    values ($1, $2, 'Staff MFA Runtime Hospital', $3, 'Africa/Lagos', true, 'verified')`,
  [ids.facility, ids.org, `SMR-${ids.facility.slice(0, 6)}`]);
  async function account(label, { platformRole, membershipRole, patient } = {}) {
    const id = randomUUID();
    const email = `staff-mfa-${label}-${id.slice(0, 8)}@example.invalid`;
    const subject = `synthetic:staff-mfa-runtime:${label}`;
    await owner.query(`insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm)
      values ($1, $2, $3, $4, 'active', $5, 'argon2id')`, [id, subject, email, `Staff MFA ${label}`, passwordHash]);
    if (platformRole) {
      await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
        values ($1, $2, $3, 'platform', 'Synthetic staff MFA verifier')`, [randomUUID(), id, platformRole]);
    }
    if (membershipRole) await addMembership({ id, email, label }, membershipRole);
    if (patient) {
      await owner.query(`insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status)
        values ($1, $2, $3, 'Ada', 'Staff', 'Ada Staff', 'active')`, [randomUUID(), id, patient]);
    }
    return { id, email, subject, label };
  }
  async function addMembership({ id, email, label }, membershipRole) {
    const staffId = randomUUID(); const membershipId = randomUUID();
    await owner.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
      values ($1, $2, $3, $4, 'verified', $5)`, [staffId, id, `Staff MFA ${label}`, email, membershipRole]);
    await owner.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id,
        facility_id, membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, $6, $6, true, true)`,
    [membershipId, staffId, id, ids.org, ids.facility, membershipRole]);
  }
  const doctor = await account('doctor', { membershipRole: 'doctor' });
  const nurse = await account('nurse', { membershipRole: 'nurse' });
  const patientOnly = await account('patient', { patient: 'HID-SMFARUNTM' });
  const superA = await account('super-a', { platformRole: 'platform_super_admin' });
  const superB = await account('super-b', { platformRole: 'platform_super_admin' });

  const clock = createTotpClock();
  // Codes Identity would deliver: staff enrolment codes by recipient, recovery codes in order.
  const recoveryDeliveries = [];
  const outbox = enrollmentCodeOutbox(async (input) => {
    assert.equal(input.purpose, 'PASSWORD_RESET');
    recoveryDeliveries.push(input);
    return { outcome: 'accepted', provider: 'synthetic' };
  });
  const google = { calls: 0, login: async () => { google.calls += 1; throw new Error('Google is outside this verifier'); },
    exchange: async () => { google.calls += 1; throw new Error('Google is outside this verifier'); } };
  const module = await Test.createTestingModule({
    controllers: [AuthController, PlatformAuthController, OtpController, PlatformSecurityController],
    providers: [DatabaseService, TokenService, LocalAuthProvider, CurrentStaffContextService, CurrentPatientContextService,
      AuthService, AuthSessionAuditService, AuditService, WorkloadAuthService, TurnstileService, OtpService, MfaService,
      MfaSecretProtector, PlatformSecurityService,
      { provide: MFA_TOTP_CLOCK, useValue: clock.now },
      { provide: NotificationOtpClient, useValue: outbox.client },
      { provide: GoogleAuthenticationService, useValue: google }],
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
  const send = supertestTransport(http);
  const staff = staffClient({ send, origin, password, outbox, now: clock.next });
  const post = (path, cookies = {}, body = {}, headers = {}) => send(path, { origin, cookie: cookieHeader(cookies), body, headers });
  const session = (cookie) => http.get('/api/v1/auth/session').set('Cookie', cookie);
  const checks = [];
  const one = async (sql, values) => (await owner.query(sql, values)).rows[0];

  // 1. The password step: a challenge cookie only.
  const wrongPassword = await post('/auth/login', {}, { email: doctor.email, password: 'Wrong-Password-2026-x',
    turnstileAction: 'staff-login' });
  const notStaff = await post('/auth/login', {}, { email: patientOnly.email, password, turnstileAction: 'staff-login' });
  expectStatus(wrongPassword, 401);
  expectStatus(notStaff, 401);
  assert.deepEqual([wrongPassword.body.code, wrongPassword.body.detail], [notStaff.body.code, notStaff.body.detail],
    'an account without a staff membership is answered as a wrong password');
  const first = await staff.passwordStep(doctor.email);
  assert.equal(first.status, 'mfa_enrollment_required');
  assert.deepEqual(Object.keys(setCookies(first.response)), ['hid_access_mfa']);
  assert.equal((await one('select count(*)::int as n from auth.sessions where account_id = $1', [doctor.id])).n, 0,
    'the password step created a session');
  assert.deepEqual(await one(`select session_kind, purpose, proof_method from auth.mfa_login_challenges
    where account_id = $1 and consumed_at is null and invalidated_at is null`, [doctor.id]),
  { session_kind: 'staff', purpose: 'enroll', proof_method: null });
  expectStatus(await session(first.challengeCookie), 401, 'AUTHENTICATION_REQUIRED');
  checks.push('the staff password step answers mfa_enrollment_required with only an httpOnly challenge cookie (path /api/v1/auth/mfa); no session row or cookie exists; a wrong password and an account without a staff membership get the same 401');

  // 2. A first enrolment needs the emailed code, never the password alone.
  const challenge = { hid_access_mfa: first.challengeCookie.split('=')[1] };
  expectStatus(await post('/auth/mfa/enroll/start', challenge), 403, 'MFA_ENROLLMENT_PROOF_REQUIRED');
  expectStatus(await post('/auth/mfa/enroll/activate', challenge, { code: '123456' }), 403, 'MFA_ENROLLMENT_PROOF_REQUIRED');
  assert.equal((await one('select count(*)::int as n from auth.mfa_factors where account_id = $1', [doctor.id])).n, 0);
  expectStatus(await post('/auth/mfa/enroll/email-code', {}), 401, 'MFA_CHALLENGE_INVALID');
  const sent = await post('/auth/mfa/enroll/email-code', challenge);
  expectStatus(sent, 200);
  assert.equal(sent.header('cache-control'), 'no-store');
  assert.deepEqual([sent.body.accepted, sent.body.channel], [true, 'email']);
  const emailCode = outbox.take(doctor.email);
  assert.match(emailCode, /^[0-9]{6}$/);
  const proof = await one(`select proof_method, proof_verifier_hmac::text, proof_sent_at, proof_verified_at
    from auth.mfa_login_challenges where account_id = $1 and consumed_at is null and invalidated_at is null`, [doctor.id]);
  assert.equal(proof.proof_method, 'email_code');
  assert(proof.proof_sent_at && !proof.proof_verified_at && !proof.proof_verifier_hmac.includes(emailCode));
  const wrongEmailCode = emailCode === '000000' ? '111111' : '000000';
  expectStatus(await post('/auth/mfa/enroll/start', challenge, { emailCode: wrongEmailCode }), 401, 'MFA_INVALID_CODE');
  const started = await post('/auth/mfa/enroll/start', challenge, { emailCode });
  expectStatus(started, 200);
  const secret = started.body.secret;
  assert.match(started.body.otpauthUri, /^otpauth:\/\/totp\/Health%20ID:/);
  expectStatus(await post('/auth/mfa/enroll/activate', challenge, { code: '000000' }), 401, 'MFA_INVALID_CODE');
  const activationAt = clock.next();
  const activated = await post('/auth/mfa/enroll/activate', challenge, { code: totpAt(secret, activationAt) });
  expectStatus(activated, 200);
  assert.equal(activated.body.recoveryCodes.length, 10);
  const recoveryCodes = [...activated.body.recoveryCodes];
  const doctorJar = setCookies(activated);
  assert(doctorJar.hid_access && doctorJar.hid_access_refresh && doctorJar.hid_access_csrf);
  checks.push('a first enrolment is refused without the emailed code (403 MFA_ENROLLMENT_PROOF_REQUIRED, no factor), counts a wrong code (401), stores only a keyed digest of the code, and with the code returns the secret once; a wrong first TOTP code is 401');

  // 3. The session, its assurance, refresh, TOTP replay and recovery codes.
  const sessionId = activated.body.actor.sessionId;
  assert.deepEqual(await one(`select session.session_kind, assurance.mfa_method, factor.status
    from auth.sessions session join auth.session_assurance assurance on assurance.family_id = session.family_id
    join auth.mfa_factors factor on factor.id = assurance.mfa_factor_id where session.id = $1`, [sessionId]),
  { session_kind: 'staff', mfa_method: 'totp', status: 'active' });
  const doctorCookie = cookieHeader({ hid_access: doctorJar.hid_access });
  const current = await session(doctorCookie);
  expectStatus(current, 200);
  assert.equal(current.body.actor.facility.id, ids.facility);
  const audits = async (accountId) => (await owner.query(`select action from audit.events where actor_account_id = $1
    and action like 'auth.%' order by sequence_id`, [accountId])).rows.map(row => row.action);
  assert.deepEqual((await audits(doctor.id)).filter(action => action !== 'auth.session.read'),
    ['auth.staff.mfa.failed', 'auth.staff.mfa.failed', 'auth.staff.mfa.enrolled', 'auth.login']);
  const refreshed = await post('/auth/refresh', doctorJar, {}, { 'x-csrf-token': doctorJar.hid_access_csrf });
  expectStatus(refreshed, 200);
  assert.equal((await one(`select count(*)::int as n from auth.sessions where id = $1
    and family_id = (select family_id from auth.sessions where id = $2)`, [refreshed.body.actor.sessionId, sessionId])).n, 1,
  'refresh keeps the MFA-verified family');
  expectStatus(await session(cookieHeader({ hid_access: setCookies(refreshed).hid_access })), 200);
  const second = await staff.passwordStep(doctor.email);
  assert.equal(second.status, 'mfa_required');
  const secondChallenge = { hid_access_mfa: second.challengeCookie.split('=')[1] };
  expectStatus(await post('/auth/mfa/verify', secondChallenge, { code: totpAt(secret, activationAt) }), 401,
    'MFA_INVALID_CODE');
  const byRecovery = await post('/auth/mfa/verify', secondChallenge, { recoveryCode: recoveryCodes[0] });
  expectStatus(byRecovery, 200);
  assert.deepEqual(await one(`select mfa_method from auth.session_assurance where family_id = $1`,
    [byRecovery.body.actor.sessionId]), { mfa_method: 'recovery_code' });
  const recoveryAudit = await one(`select details from audit.events where actor_account_id = $1
    and action = 'auth.staff.mfa.recovery-code.used'`, [doctor.id]);
  assert.deepEqual(recoveryAudit.details, { recoveryCodesRemaining: 9 });
  const third = await staff.passwordStep(doctor.email);
  expectStatus(await post('/auth/mfa/verify', { hid_access_mfa: third.challengeCookie.split('=')[1] },
    { recoveryCode: recoveryCodes[0] }), 401, 'MFA_INVALID_CODE');
  checks.push('the session is issued at the first TOTP code with a staff session_assurance row (totp) and audited as auth.staff.mfa.enrolled and auth.login; refresh renews it in the same family; an already used TOTP step is refused; a recovery code signs in once (assurance recovery_code, audited with 9 left) and never again');

  // 4. A staff challenge is accepted by no platform step.
  const crossed = await staff.passwordStep(doctor.email);
  const crossedToken = crossed.challengeCookie.split('=')[1];
  expectStatus(await post('/auth/admin/mfa/verify', { hid_access_admin_mfa: crossedToken },
    { code: totpAt(secret, clock.next()) }), 401, 'MFA_CHALLENGE_INVALID');
  expectStatus(await post('/auth/admin/mfa/enroll/start', { hid_access_admin_mfa: crossedToken }), 401, 'MFA_CHALLENGE_INVALID');
  checks.push('a staff challenge presented to the platform MFA steps is 401 MFA_CHALLENGE_INVALID');

  // 5. A staff session without assurance, as every sign-in before 0088: issued
  //    exactly as the earlier build did (TokenService's own token, session row
  //    and refresh token), with no assurance row.
  const tokens = module.get(TokenService);
  async function legacyStaffSession(who) {
    const id = randomUUID(); const jti = randomUUID();
    const refreshToken = tokens.newRefreshToken(id, 'local');
    const csrf = tokens.deriveRefreshCsrf(refreshToken);
    const version = Number((await one('select token_version from auth.accounts where id = $1', [who.id])).token_version);
    const actor = { ...(await module.get(CurrentStaffContextService).resolve(who.subject, 'local')), sessionId: id };
    const access = await tokens.signAccessToken(actor, id, jti, version, csrf, new Date(Date.now() + 600_000));
    await owner.query(`insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti,
        account_token_version, authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
      values ($1, $2, $1, $3, $4, $5, 'password', now(), now() + interval '8 hours', now() + interval '24 hours', 'staff')`,
    [id, who.id, createHash('sha256').update(refreshToken).digest('hex'), jti, version]);
    return { id, jar: { hid_access: access, hid_access_refresh: refreshToken, hid_access_csrf: csrf } };
  }
  const legacy = await legacyStaffSession(nurse);
  const refused = await session(cookieHeader({ hid_access: legacy.jar.hid_access }));
  expectStatus(refused, 403, 'STAFF_MFA_REQUIRED');
  expectStatus(await http.get('/api/v1/auth/session').set('Authorization', `Bearer ${legacy.jar.hid_access}`),
    403, 'STAFF_MFA_REQUIRED');
  expectStatus(await post('/auth/facility', legacy.jar, { facilityId: ids.facility },
    { 'x-csrf-token': legacy.jar.hid_access_csrf }), 403, 'STAFF_MFA_REQUIRED');
  assert.equal((await one(`select count(*)::int as n from audit.events where actor_account_id = $1
    and action = 'auth.authorization.denied' and outcome = 'denied'`, [nurse.id])).n, 3, 'each refusal is audited');
  const legacyRefresh = await post('/auth/refresh', legacy.jar, {}, { 'x-csrf-token': legacy.jar.hid_access_csrf });
  expectStatus(legacyRefresh, 403, 'STAFF_MFA_REQUIRED');
  assert(legacyRefresh.setCookie.some(value => value.startsWith('hid_access_refresh=;')), 'a refused refresh clears the cookies');
  assert.deepEqual(await one('select revocation_reason from auth.sessions where id = $1', [legacy.id]),
    { revocation_reason: 'staff_mfa_required' });
  assert.equal((await one(`select count(*)::int as n from auth.session_events where session_id = $1
    and event_type = 'refresh' and outcome = 'denied' and details->>'reason' = 'staff_mfa_required'`, [legacy.id])).n, 1);
  const leaving = await legacyStaffSession(nurse);
  const signedOut = await post('/auth/logout', leaving.jar, {}, { 'x-csrf-token': leaving.jar.hid_access_csrf });
  expectStatus(signedOut, 204);
  assert.deepEqual(await one('select revocation_reason from auth.sessions where id = $1', [leaving.id]),
    { revocation_reason: 'logout' });
  checks.push('a staff session without MFA assurance (as issued before 0088) is 403 STAFF_MFA_REQUIRED by cookie and by bearer, audited as auth.authorization.denied; its refresh is 403 STAFF_MFA_REQUIRED, clears the cookies and ends the sign-in (staff_mfa_required, a denied refresh event); it can still sign out');

  // 6. Google exchange with a staff action.
  const nonce = await http.get('/api/v1/auth/google/nonce').set('Origin', origin);
  expectStatus(nonce, 200);
  const googleRefused = await post('/auth/oidc/exchange', mergeCookies({}, nonce),
    { idToken: 'g'.repeat(64), turnstileAction: 'staff-login' });
  expectStatus(googleRefused, 403, 'GOOGLE_STAFF_SIGN_IN_DISABLED');
  assert.equal(google.calls, 0, 'the Google token was exchanged');
  checks.push('POST /auth/oidc/exchange with a staff action is 403 GOOGLE_STAFF_SIGN_IN_DISABLED and never exchanges the token');

  // 7. OTP password recovery keeps the factor: for an enrolled account, a
  //    mailbox alone yields no session.
  const factorBefore = await one(`select id::text, status, row_version::text from auth.mfa_factors
    where account_id = $1 and status = 'active'`, [doctor.id]);
  const startedRecovery = await post('/auth/otp/start', {}, { identifier: doctor.email, purpose: 'PASSWORD_RESET',
    turnstileAction: 'staff-reset' });
  expectStatus(startedRecovery, 202);
  await module.get(OtpService).settleDeliveries();
  const recoveryCode = recoveryDeliveries.at(-1);
  assert.equal(recoveryCode.recipient, doctor.email.toLowerCase());
  const verifiedRecovery = await post('/auth/otp/verify', {}, { challengeId: startedRecovery.body.challengeId,
    purpose: 'PASSWORD_RESET', code: recoveryCode.code });
  expectStatus(verifiedRecovery, 200);
  const newPassword = 'Synthetic-Staff-Mfa-Recovered-2026';
  expectStatus(await post('/auth/otp/complete', {}, { challengeId: startedRecovery.body.challengeId,
    purpose: 'PASSWORD_RESET', verificationToken: verifiedRecovery.body.verificationToken, newPassword }), 200);
  assert.deepEqual(await one(`select id::text, status, row_version::text from auth.mfa_factors
    where account_id = $1 and status = 'active'`, [doctor.id]), factorBefore, 'recovery changed the factor');
  assert.equal((await one(`select count(*)::int as n from auth.sessions where account_id = $1 and revoked_at is null`,
    [doctor.id])).n, 0, 'recovery ended every session');
  const afterRecovery = await staff.passwordStep(doctor.email, { password: newPassword });
  assert.equal(afterRecovery.status, 'mfa_required', 'a recovered account must still verify its authenticator');
  const afterRecoveryChallenge = { hid_access_mfa: afterRecovery.challengeCookie.split('=')[1] };
  expectStatus(await post('/auth/mfa/enroll/email-code', afterRecoveryChallenge), 401, 'MFA_CHALLENGE_INVALID');
  expectStatus(await post('/auth/mfa/verify', afterRecoveryChallenge, { code: totpAt(secret, clock.next()) }), 200);
  checks.push('an OTP password recovery (staff-reset) ends every session and leaves the factor unchanged; the next sign-in is mfa_required (no enrolment, no email code accepted) and is issued only with the authenticator');

  // 8. Two-person MFA reset of a staff account (0070), then re-enrolment on a fresh emailed code.
  const platform = platformClient({ http, origin, totp, clock, password });
  const adminA = await platform.enroll(superA.email);
  const adminB = await platform.enroll(superB.email);
  await platform.stepUp(adminA);
  await platform.stepUp(adminB);
  const resetRequest = await platform.command(adminA, `/admin/principals/${doctor.id}/mfa-reset-requests`,
    { reason: 'Doctor lost their authenticator phone' }, { 'Idempotency-Key': `staff-mfa-reset-${randomUUID()}` });
  expectStatus(resetRequest, 201);
  const decided = await platform.command(adminB, `/admin/approvals/${resetRequest.body.requestId}/approve`,
    { reason: 'Identity confirmed in person at the facility' },
    { 'If-Match': String(resetRequest.body.version), 'Idempotency-Key': `staff-mfa-decide-${randomUUID()}` });
  expectStatus(decided, 200);
  assert.equal(decided.body.executed, true);
  assert.deepEqual(await one(`select count(*) filter (where status = 'active')::int as active,
      count(*) filter (where revocation_reason = 'admin_reset')::int as reset
    from auth.mfa_factors where account_id = $1`, [doctor.id]), { active: 0, reset: 1 });
  assert.equal((await one(`select count(*)::int as n from auth.sessions where account_id = $1 and revoked_at is null`,
    [doctor.id])).n, 0, 'the reset ended every staff session');
  assert.equal((await one(`select count(*)::int as n from audit.events where action = 'admin.mfa.reset'
    and outcome = 'success' and actor_account_id = $1 and resource_id = $2`, [superB.id, doctor.id])).n, 1);
  staff.forget(doctor.email);
  const reenrolled = await staff.signIn(doctor.email, { password: newPassword });
  assert.equal(reenrolled.accountId, doctor.id);
  expectStatus(await session(cookieHeader({ hid_access: reenrolled.cookies.hid_access })), 200);
  checks.push('a staff MFA reset requested by one Super Admin and approved by another revokes the factor and every staff session and is audited; the next sign-in enrols again on a fresh emailed code');

  // 9. The staff proof belongs to the factor. A platform administrator who is
  //    also a doctor cannot enrol at platform sign-in; enrolled at staff
  //    sign-in, the same factor then verifies platform sign-in.
  const factorOf = async (who) => one(`select enrollment_proof, enrollment_challenge_id is not null as bound
    from auth.mfa_factors where account_id = $1 and status = 'active'`, [who.id]);
  const dual = await account('dual', { platformRole: 'security_auditor', membershipRole: 'doctor' });
  const dualPlatform = await platform.login(dual.email);
  assert.equal(dualPlatform.response.body.status, 'mfa_enrollment_required');
  expectStatus(await platform.post('/auth/admin/mfa/enroll/start', dualPlatform.jar), 409,
    'MFA_ENROLLMENT_STAFF_SIGN_IN_REQUIRED');
  assert.equal((await one('select count(*)::int as n from auth.mfa_factors where account_id = $1', [dual.id])).n, 0,
    'a refused platform enrolment created a factor');
  const dualStaff = await staff.signIn(dual.email);
  assert.equal(dualStaff.accountId, dual.id);
  assert.deepEqual(await factorOf(dual), { enrollment_proof: 'email_code', bound: true });
  const dualAdmin = await platform.signIn({ email: dual.email, secret: staff.secretOf(dual.email) });
  assert.equal(dualAdmin.accountId, dual.id);
  checks.push('the platform first enrolment of an account that also holds a staff membership is 409 MFA_ENROLLMENT_STAFF_SIGN_IN_REQUIRED and creates no factor; enrolled at staff sign-in with the emailed code, the factor records its proof and verifies the platform sign-in too');

  //    A platform administrator enrolled by platform sign-in (the password
  //    alone) and later given a staff membership: the factor verifies the
  //    platform sign-in only. Staff sign-in is refused at the password step,
  //    the database refuses staff assurance on that factor, and after a
  //    governed reset the account enrols at staff sign-in with the proof.
  const promoted = await account('promoted', { platformRole: 'security_auditor' });
  const promotedAdmin = await platform.enroll(promoted.email);
  assert.deepEqual(await factorOf(promoted), { enrollment_proof: null, bound: false });
  await addMembership(promoted, 'doctor');
  const unproven = await post('/auth/login', {}, { email: promoted.email, password, turnstileAction: 'staff-login' });
  expectStatus(unproven, 403, 'STAFF_MFA_FACTOR_UNPROVEN');
  assert(!unproven.setCookie.some(value => value.startsWith('hid_access')), 'a refused staff sign-in set a cookie');
  assert.equal((await one(`select count(*)::int as n from auth.mfa_login_challenges where account_id = $1
    and session_kind = 'staff'`, [promoted.id])).n, 0, 'a refused staff sign-in opened a challenge');
  assert.equal((await one(`select count(*)::int as n from auth.session_events where account_id = $1
    and event_type = 'login_failed' and outcome = 'denied' and details->>'reason' = 'staff_mfa_factor_unproven'`,
  [promoted.id])).n, 1);
  const promotedSession = await legacyStaffSession(promoted);
  const runtime = await module.get(DatabaseService).withSystemTransaction(randomUUID(), async (client) => client.query(
    `insert into auth.session_assurance (family_id, account_id, mfa_factor_id, mfa_method, mfa_verified_at)
     select $1, $2, factor.id, 'totp', clock_timestamp() from auth.mfa_factors factor
      where factor.account_id = $2 and factor.status = 'active'`, [promotedSession.id, promoted.id]))
    .then(() => 'accepted', (error) => error.message);
  assert.equal(runtime, 'STAFF_MFA_FACTOR_UNPROVEN', 'the database gave a staff session assurance on an unproven factor');
  await platform.signIn(promotedAdmin);
  const promotedReset = await platform.command(adminA, `/admin/principals/${promoted.id}/mfa-reset-requests`,
    { reason: 'Authenticator enrolled before the staff membership' }, { 'Idempotency-Key': `staff-mfa-reset-${randomUUID()}` });
  expectStatus(promotedReset, 201);
  const promotedDecided = await platform.command(adminB, `/admin/approvals/${promotedReset.body.requestId}/approve`,
    { reason: 'Identity confirmed in person at the facility' },
    { 'If-Match': String(promotedReset.body.version), 'Idempotency-Key': `staff-mfa-decide-${randomUUID()}` });
  expectStatus(promotedDecided, 200);
  const promotedStaff = await staff.signIn(promoted.email);
  assert.equal(promotedStaff.accountId, promoted.id);
  assert.deepEqual(await factorOf(promoted), { enrollment_proof: 'email_code', bound: true });
  checks.push('a factor enrolled at platform sign-in on the password alone never verifies a staff sign-in: once the account holds a staff membership, POST /auth/login is 403 STAFF_MFA_FACTOR_UNPROVEN with no challenge or cookie (a denied login_failed event), the database refuses staff assurance on that factor (STAFF_MFA_FACTOR_UNPROVEN, as the runtime role), and after a governed two-person reset the account enrols at staff sign-in with the emailed code');

  process.stdout.write(`${JSON.stringify({ status: 'passed', scope: 'local-synthetic-only', role: runtimeRole, checks })}\n`);
} finally {
  await app?.close();
  await owner.end();
  await maintenance.query(`drop database if exists ${isolated} with (force)`);
  await maintenance.end();
}
