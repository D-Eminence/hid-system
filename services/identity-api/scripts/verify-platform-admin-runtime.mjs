#!/usr/bin/env node
// Platform Admin HTTP boundaries, executed as the exact Identity API runtime
// role against the owned disposable synthetic rehearsal only. The real
// DatabaseService, SecurityGuard, AuditInterceptor, controllers, services and
// database authorization run; nothing is mocked except that no notification is
// ever sent. No network or cloud call is made. All values are synthetic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createTotpClock, platformClient } from './platform-session-client.mjs';
import { enrollmentCodeOutbox, staffClient, supertestTransport } from './staff-session-client.mjs';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
// Run in a disposable copy so synthetic accounts and audit rows never leak into
// later rehearsal steps.
const isolated = `hid_rehearsal_admin_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const origin = 'https://admin.staging.healthidentitydirectory.com';
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'staging',
  NIN_PROVIDER_MODE: 'deferred', CORS_ORIGINS: origin, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'public-synthetic-ehr-workload-token', TURNSTILE_MODE: 'disabled',
  MFA_SECRET_KEY_B64: Buffer.alloc(32, 0x6d).toString('base64'), MFA_KEY_VERSION: 'admin-runtime-v1',
  // Every Identity API connection runs as the deployed runtime role.
  DATABASE_URL: `postgresql://${process.env.PGUSER ?? 'postgres'}@localhost/${isolated}?host=${encodeURIComponent(socket)}`
    + `&options=${encodeURIComponent('-c role=hid_identity_api_runtime')}` });
delete process.env.AUTH_COOKIE_DOMAIN;
for (const key of ['ADMIN_IDENTITY_STATUS_URL', 'ADMIN_EHR_STATUS_URL', 'ADMIN_LAB_STATUS_URL',
  'ADMIN_PHARMACY_STATUS_URL', 'ADMIN_OCR_STATUS_URL', 'ADMIN_OUTREACH_STATUS_URL',
  'ADMIN_EVENT_DISPATCHER_STATUS_URL']) delete process.env[key];
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
const { PlatformAuthController } = load('auth/platform-auth.controller.ts');
const { MfaService, MFA_TOTP_CLOCK } = load('auth/mfa/mfa.service.ts');
const { MfaSecretProtector } = load('auth/mfa/mfa-secret-protector.ts');
const totp = load('auth/mfa/totp.ts');
const { PlatformSecurityController } = load('admin/platform-security.controller.ts');
const { PlatformSecurityService } = load('admin/platform-security.service.ts');
const { AdminDemoRequestsController } = load('commercial/demo-requests.controller.ts');
const { DemoRequestsService } = load('commercial/demo-requests.service.ts');
const { WorkforceAdminController } = load('admin/workforce-admin.controller.ts');
const { WorkforceAdminService } = load('admin/workforce-admin.service.ts');
const { ConsentController } = load('consent/consent.controller.ts');
const { ConsentService } = load('consent/consent.service.ts');
const { IdentityController } = load('identity/identity.controller.ts');
const { IdentityService } = load('identity/identity.service.ts');
const { PostgresIdentityProvider } = load('identity/postgres-identity.provider.ts');
const { IDENTITY_PROVIDER } = load('identity/identity.types.ts');
// The staff search budget (0086) is a dependency of ConsentService and
// IdentityService once it exists; provide it whenever the source has it, so
// this verifier builds the same services on either side of that change.
const optionalProviders = existsSync(join(service, 'src', 'identity', 'staff-search-budget.ts'))
  ? [load('identity/staff-search-budget.ts').StaffSearchBudget] : [];
// The status the lookup route declares (201 by default for a POST; 0086
// declares 200), read from the route rather than assumed.
const { HTTP_CODE_METADATA } = require('@nestjs/common/constants');
const lookupStatus = Reflect.getMetadata(HTTP_CODE_METADATA, IdentityController.prototype.lookup) ?? 201;
const { encodeCursor } = load('common/cursor.ts');
const { DomainProblem, ProblemDetailsFilter } = load('common/problem.ts');

globalThis.fetch = async (input) => { throw new Error(`Unexpected outbound request to ${String(input)}`); };
const maintenance = new Pool({ host: socket, user: process.env.PGUSER, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
// Fixture and assertion connection (database owner), never used by the API.
const owner = new Pool({ host: socket, user: process.env.PGUSER, database: isolated, max: 2 });
// Dropping the disposable database terminates any connection still closing;
// that expected 57P01 must not crash the verifier after its checks passed.
owner.on('error', () => undefined);
let app;
try {
  const argon2 = require('argon2');
  const password = 'Synthetic-Admin-Password-2026';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const organizationId = randomUUID();
  const facilityA = randomUUID();
  const facilityB = randomUUID();
  await owner.query("insert into identity.organizations (id, name, slug) values ($1, 'Admin Runtime Organization', $2)",
    [organizationId, `admin-runtime-${organizationId.slice(0, 8)}`]);
  await owner.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
    values ($1, $3, 'Admin Runtime Facility A', $4, 'Africa/Lagos', true, 'verified'),
           ($2, $3, 'Admin Runtime Facility B', $5, 'Africa/Lagos', true, 'verified')`,
  [facilityA, facilityB, organizationId, `ADMIN-A-${facilityA.slice(0, 6)}`, `ADMIN-B-${facilityB.slice(0, 6)}`]);

  // Accounts: a Super Admin who also works at facility A as a doctor, a
  // Security Auditor and a Support Admin who work at facility B, a facility
  // administrator at A with no platform role, and a recovery target. Staff
  // sign-in still requires an active membership (see SUPER_ADMIN_FOUNDATION.md);
  // platform routes never bind or borrow it.
  async function account(label, { status = 'active', platformRole, membershipRole, facility = facilityA } = {}) {
    const id = randomUUID();
    const email = `admin-runtime-${label}-${id.slice(0, 8)}@example.invalid`;
    await owner.query(`insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm)
      values ($1, $2, $3, $4, $5, $6, 'argon2id')`,
    [id, `synthetic:admin-runtime:${label}`, email, `Admin Runtime ${label}`, status, passwordHash]);
    if (platformRole) {
      await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
        values ($1, $2, $3, 'platform', 'Synthetic platform admin runtime verifier')`, [randomUUID(), id, platformRole]);
    }
    if (membershipRole) {
      const staffId = randomUUID(); const membershipId = randomUUID();
      await owner.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
        values ($1, $2, $3, $4, 'verified', $5)`, [staffId, id, `Admin Runtime ${label}`, email, membershipRole]);
      await owner.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id,
          facility_id, membership_role, app_role, is_primary, active)
        values ($1, $2, $3, $4, $5, $6, $6, true, true)`, [membershipId, staffId, id, organizationId, facility, membershipRole]);
      await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
        values ($1, $2, $3, 'facility', $4, $5, 'Synthetic facility role')`, [randomUUID(), id, membershipRole, membershipId, facility]);
    }
    return { id, email };
  }
  const superAdmin = await account('super', { platformRole: 'platform_super_admin', membershipRole: 'doctor' });
  const auditor = await account('auditor', { platformRole: 'security_auditor', membershipRole: 'doctor', facility: facilityB });
  const support = await account('support', { platformRole: 'support_admin', membershipRole: 'doctor', facility: facilityB });
  const facilityAdmin = await account('facility-admin', { membershipRole: 'admin' });
  const pendingReset = await account('pending-reset', { status: 'pending_reset' });

  const clock = createTotpClock();
  const staffEnrollmentCodes = enrollmentCodeOutbox();
  const module = await Test.createTestingModule({
    controllers: [AuthController, PlatformAuthController, AdminController, PlatformSecurityController, AuditController,
      AdminDemoRequestsController, WorkforceAdminController, ConsentController, IdentityController],
    providers: [DatabaseService, TokenService, LocalAuthProvider,
      CurrentStaffContextService, CurrentPatientContextService, AuthService, AuthSessionAuditService,
      AuditService, WorkloadAuthService, TurnstileService, AdminService, AdminOperationsService, PricingService,
      MfaService, MfaSecretProtector, PlatformSecurityService, DemoRequestsService, WorkforceAdminService,
      ConsentService, IdentityService, ...optionalProviders,
      { provide: IDENTITY_PROVIDER, useClass: PostgresIdentityProvider },
      { provide: MFA_TOTP_CLOCK, useValue: clock.now },
      // Staff sign-ins (MFA-1) enrol with an emailed code; no other delivery is expected.
      { provide: NotificationOtpClient, useValue: staffEnrollmentCodes.client },
      { provide: GoogleAuthenticationService, useValue: {
        login: async () => { throw new Error('Google exchange is outside the platform admin verifier'); },
      } }] }).compile();
  const runtimeRole = (await module.get(DatabaseService).query('select current_user as role')).rows[0].role;
  assert.equal(runtimeRole, 'hid_identity_api_runtime');
  app = module.createNestApplication({ logger: false });
  app.use(require('cookie-parser')());
  app.use((req, _res, next) => { req.correlationId = randomUUID(); next(); });
  app.setGlobalPrefix('api/v1');
  // The same request validation, guard and request audit AppModule installs.
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

  const expectStatus = (response, status, code) => {
    assert.equal(response.status, status, `${code ?? status}: ${JSON.stringify(response.body)}`);
    if (code) assert.equal(response.body.code, code, JSON.stringify(response.body));
  };
  // Staff sign-in (MFA-1): the password, then the account's authenticator, on the shared virtual clock.
  const staff = staffClient({ send: supertestTransport(http), origin, password, outbox: staffEnrollmentCodes,
    now: clock.next });
  async function signIn(who) {
    const signedIn = await staff.signIn(who.email);
    assert.equal(signedIn.accountId, who.id);
    return { cookie: signedIn.cookie, csrf: signedIn.csrf, account: who, bearer: `Bearer ${signedIn.cookies.hid_access}` };
  }
  const get = (who, path, headers = {}) => {
    let call = http.get(`/api/v1${path}`);
    if (who) call = call.set('Cookie', who.cookie);
    for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
    return call;
  };
  const command = (who, path, body, headers = {}) => {
    let call = http.post(`/api/v1${path}`).set('Cookie', who.cookie).set('Origin', origin).set('x-csrf-token', who.csrf);
    for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
    return call.send(body);
  };
  // Stage 2A: platform routes require an MFA-verified platform session.
  const platform = platformClient({ http, origin, totp, clock, password });
  const asPlatform = (admin) => ({ ...admin, cookie: Object.entries(admin.jar).map(([n, v]) => `${n}=${v}`).join('; '),
    bearer: `Bearer ${admin.jar.hid_access_admin}` });
  const adminRoutes = ['/admin/session', '/admin/overview', '/admin/principals?query=admin-runtime',
    '/admin/audit/events?limit=5'];
  const boundaries = {};

  // 1. Missing authentication is refused on every admin route.
  for (const route of adminRoutes) expectStatus(await get(null, route), 401, 'AUTHENTICATION_REQUIRED');
  boundaries.unauthenticated = 401;

  // Staff sessions (facility work) and separate platform sessions (password + TOTP).
  const superStaff = await signIn(superAdmin);
  const facilitySession = await signIn(facilityAdmin);
  // The Super Admin enrolled the account's one authenticator at their staff sign-in.
  const superSession = asPlatform(await platform.signIn({ email: superAdmin.email,
    secret: staff.secretOf(superAdmin.email) }));
  // The auditor and the support administrator hold staff memberships too, so
  // each enrols the account's one authenticator at staff sign-in, with the
  // emailed proof (a platform first enrolment of such an account is refused,
  // MFA-1), and then uses it for platform sign-in.
  await signIn(auditor);
  await signIn(support);
  const auditorSession = asPlatform(await platform.signIn({ email: auditor.email,
    secret: staff.secretOf(auditor.email) }));
  const supportSession = asPlatform(await platform.signIn({ email: support.email,
    secret: staff.secretOf(support.email) }));

  // 2-3. An ordinary facility administrator is refused, with or without the
  // facility context of their own membership; the denial is platform-scoped.
  // Stage 2A: any staff session is refused before permissions are considered.
  // Platform routes read only the platform cookie, so a staff cookie alone is
  // unauthenticated there (401); a staff token presented directly is refused
  // as the wrong session kind (403) with platform-scoped evidence.
  for (const route of adminRoutes) {
    expectStatus(await get(facilitySession, route), 401, 'AUTHENTICATION_REQUIRED');
    expectStatus(await get(null, route, { Authorization: facilitySession.bearer }), 403, 'PLATFORM_SESSION_REQUIRED');
    expectStatus(await get(null, route, { Authorization: facilitySession.bearer, 'X-Facility-ID': facilityA }),
      403, 'PLATFORM_SESSION_REQUIRED');
  }
  // The Super Admin's own staff session does not satisfy platform routes either.
  expectStatus(await get(superStaff, '/admin/session'), 401, 'AUTHENTICATION_REQUIRED');
  expectStatus(await get(null, '/admin/session', { Authorization: superStaff.bearer }), 403, 'PLATFORM_SESSION_REQUIRED');
  const facilityDenials = (await owner.query(`select access_scope, facility_id, actor_membership_id from audit.events
    where actor_account_id = $1 and action = 'security.authorization' and outcome = 'denied'`, [facilityAdmin.id])).rows;
  assert.equal(facilityDenials.length, adminRoutes.length * 2);
  assert(facilityDenials.every(row => row.access_scope === 'platform' && row.facility_id === null
    && row.actor_membership_id === null), 'Admin route denials must be platform-scoped evidence');
  boundaries.facility_staff = 'PLATFORM_SESSION_REQUIRED';
  boundaries.platform_admin_staff_session = 'PLATFORM_SESSION_REQUIRED';

  // 4. A platform role without the route permission is refused: the Support
  // Admin reaches the session but not the audit log; the Security Auditor
  // reaches the audit log but not principals.
  expectStatus(await get(supportSession, '/admin/session'), 200);
  expectStatus(await get(supportSession, '/admin/audit/events?limit=5'), 403, 'PERMISSION_DENIED');
  expectStatus(await get(auditorSession, '/admin/principals?query=admin-runtime'), 403, 'PERMISSION_DENIED');
  boundaries.platform_role_without_permission = 'PERMISSION_DENIED';

  // 5. Valid platform administrators succeed without X-Facility-ID.
  const session = await get(auditorSession, '/admin/session');
  expectStatus(session, 200);
  assert.equal(session.body.actor.accountId, auditor.id);
  assert(session.body.actor.platformPermissions.includes('platform.audit.read'));
  const overview = await get(superSession, '/admin/overview');
  expectStatus(overview, 200);
  for (const key of ['registeredPatients', 'facilities', 'verifiedFacilities', 'suspendedFacilities',
    'activeStaffMemberships', 'pendingIdentityReviews']) assert.equal(typeof overview.body[key], 'number', key);
  const principals = await get(superSession, '/admin/principals?query=admin-runtime&pageSize=10');
  expectStatus(principals, 200);
  assert(principals.body.items.some(item => item.id === auditor.id));
  assert.equal(principals.body.page, 1);
  // A supplied facility header is ignored on platform routes: same result, no facility bound.
  expectStatus(await get(superSession, '/admin/overview', { 'X-Facility-ID': facilityA }), 200);
  boundaries.platform_admin_without_facility = 200;

  // 6. GET /admin/audit/events: structure, keyset pagination, no patient data.
  const seen = [];
  let before = null;
  for (let page = 0; page < 3; page += 1) {
    const response = await get(auditorSession,
      `/admin/audit/events?limit=2&actor=${encodeURIComponent('synthetic:admin-runtime:facility-admin')}`
      + (before ? `&beforeSequenceId=${before}` : ''));
    expectStatus(response, 200);
    assert(Array.isArray(response.body.items));
    for (const item of response.body.items) {
      for (const key of ['sequenceId', 'eventId', 'occurredAt', 'correlationId', 'actorType', 'actorSubject',
        'facilityId', 'action', 'outcome', 'resourceType', 'resourceId', 'purposeOfUse', 'reason', 'sourceSystem']) {
        assert(key in item, `audit item is missing ${key}`);
      }
      assert(!('patientId' in item), 'The admin audit response must not expose patient identifiers');
      assert.equal(item.actorSubject, 'synthetic:admin-runtime:facility-admin');
      seen.push(BigInt(item.sequenceId));
    }
    assert.equal(response.body.items.length, 2);
    assert.match(String(response.body.nextBeforeSequenceId), /^[1-9][0-9]*$/);
    before = response.body.nextBeforeSequenceId;
  }
  for (let index = 1; index < seen.length; index += 1) {
    assert(seen[index] < seen[index - 1], 'Audit pages must be strictly descending without overlap');
  }
  const lastPage = await get(auditorSession, `/admin/audit/events?limit=200&beforeSequenceId=${before}`
    + `&actor=${encodeURIComponent('synthetic:admin-runtime:facility-admin')}`);
  expectStatus(lastPage, 200);
  assert.equal(lastPage.body.nextBeforeSequenceId, null);
  // Besides the denials: the facility administrator's first staff sign-in,
  // which records its authenticator enrolment and the sign-in (MFA-1).
  assert.equal(seen.length + lastPage.body.items.length, facilityDenials.length + 2,
    'Pagination must return each matching event exactly once');
  expectStatus(await get(auditorSession, '/admin/audit/events?limit=0'), 400, 'VALIDATION_FAILED');
  boundaries.audit_pagination = { pages: 4, events: seen.length + lastPage.body.items.length };

  // Successful platform requests and the semantic audit review are recorded
  // as platform scope with no facility or membership, even when a header was sent.
  const platformRows = (await owner.query(`select action, outcome, access_scope, facility_id, actor_membership_id
    from audit.events where actor_account_id = any($1::uuid[]) and outcome = 'success'
      and (action like 'api.%' or action like 'admin.%')`, [[superAdmin.id, auditor.id, support.id]])).rows;
  assert(platformRows.some(row => row.action === 'admin.audit.list'), 'The audit review was not itself audited');
  assert(platformRows.length >= 8);
  assert(platformRows.every(row => row.access_scope === 'platform' && row.facility_id === null
    && row.actor_membership_id === null), 'Platform requests must be recorded with platform scope only');
  boundaries.platform_audit_rows = platformRows.length;

  // 7. Facility-scoped routes still require facility context and the bound
  // membership's own permissions.
  const facilityAudit = (who, headers) => get(who, '/audit/events?limit=5',
    { 'X-Purpose-Of-Use': 'healthcare-operations', ...headers });
  expectStatus(await facilityAudit(facilitySession, {}), 400, 'FACILITY_REQUIRED');
  const facilityOk = await facilityAudit(facilitySession, { 'X-Facility-ID': facilityA });
  expectStatus(facilityOk, 200);
  expectStatus(await facilityAudit(facilitySession, { 'X-Facility-ID': facilityB }), 403, 'FACILITY_ACCESS_DENIED');
  // A platform Super Admin gains no facility permission: their doctor
  // membership lacks audit.read, platform.audit.read does not substitute, and
  // they have no access at a facility they do not work at.
  expectStatus(await facilityAudit(superStaff, {}), 400, 'FACILITY_REQUIRED');
  expectStatus(await facilityAudit(superStaff, { 'X-Facility-ID': facilityA }), 403, 'PERMISSION_DENIED');
  expectStatus(await facilityAudit(superStaff, { 'X-Facility-ID': facilityB }), 403, 'FACILITY_ACCESS_DENIED');
  // A platform session is valid only on platform routes: its cookie is not
  // read there, and its token is refused as the wrong session kind.
  expectStatus(await facilityAudit(superSession, { 'X-Facility-ID': facilityA }), 401, 'AUTHENTICATION_REQUIRED');
  for (const admin of [superSession, auditorSession]) {
    expectStatus(await facilityAudit(null, { Authorization: admin.bearer, 'X-Facility-ID': facilityA }),
      403, 'PLATFORM_SESSION_SCOPE_DENIED');
  }
  const facilityRows = (await owner.query(`select facility_id, actor_membership_id, access_scope from audit.events
    where actor_account_id = $1 and action = 'api.audit.events.list.request' and outcome = 'success'`,
  [facilityAdmin.id])).rows;
  assert.equal(facilityRows.length, 1);
  assert.equal(facilityRows[0].facility_id, facilityA);
  assert.notEqual(facilityRows[0].actor_membership_id, null);
  assert.equal(facilityRows[0].access_scope, null);
  boundaries.facility_routes = { missing_header: 'FACILITY_REQUIRED', cross_facility: 'FACILITY_ACCESS_DENIED',
    platform_grants_on_facility_route: 'PERMISSION_DENIED', platform_session_on_facility_route: 'PLATFORM_SESSION_SCOPE_DENIED' };

  // 8. Account status safety over HTTP.
  const version = async id => (await owner.query('select row_version from auth.accounts where id = $1', [id])).rows[0].row_version;
  const statusCommand = async (who, target, status) => command(who, `/admin/principals/${target.id}/status`,
    { status, reason: 'Platform admin runtime verifier' },
    { 'If-Match': String(await version(target.id)), 'Idempotency-Key': `admin-runtime-${randomUUID()}` });
  // Account status is a critical command: it needs a fresh TOTP step-up.
  expectStatus(await statusCommand(superSession, pendingReset, 'disabled'), 403, 'STEP_UP_REQUIRED');
  await platform.stepUp(superSession);
  expectStatus(await statusCommand(superSession, pendingReset, 'active'), 409, 'ACCOUNT_RECOVERY_REQUIRED');
  expectStatus(await statusCommand(superSession, superAdmin, 'disabled'), 403, 'ADMIN_SELF_CHANGE_DENIED');
  const disabled = await statusCommand(superSession, pendingReset, 'disabled');
  expectStatus(disabled, 201);
  assert.equal(disabled.body.status, 'disabled');
  const restored = await statusCommand(superSession, pendingReset, 'active');
  expectStatus(restored, 201);
  assert.equal(restored.body.status, 'pending_reset', 'disable/enable must not bypass account recovery');
  const commandRows = (await owner.query(`select access_scope, facility_id from audit.events
    where actor_account_id = $1 and action in ('admin.account.disabled', 'admin.account.active')`, [superAdmin.id])).rows;
  assert.equal(commandRows.length, 2);
  assert(commandRows.every(row => row.access_scope === 'platform' && row.facility_id === null));
  boundaries.account_status = { without_step_up: 'STEP_UP_REQUIRED', pending_reset_activation: 'ACCOUNT_RECOVERY_REQUIRED',
    self_change: 'ADMIN_SELF_CHANGE_DENIED', disable_enable_restores: 'pending_reset' };

  // 9. Stage 4A: facility suspension reachability, the audit target filter,
  // per-principal MFA enrolment and demo-request cursors.
  // The Super Admin works only at facility A and no other Super Admin works at
  // another verified facility. They still open platform sessions without a
  // membership (0069), so suspending facility A is accepted (0072); 0027
  // refused it with LAST_SUPER_ADMIN.
  const facilityVersion = async id => (await owner.query('select row_version from identity.facilities where id = $1', [id]))
    .rows[0].row_version;
  const facilityStatus = async (who, id, status) => command(who, `/admin/facilities/${id}/status`,
    { status, reason: 'Stage 4A facility reachability check' },
    { 'If-Match': String(await facilityVersion(id)), 'Idempotency-Key': `admin-runtime-${randomUUID()}` });
  const suspended = await facilityStatus(superSession, facilityA, 'suspended');
  expectStatus(suspended, 201);
  assert.equal(suspended.body.status, 'suspended');
  const reverified = await facilityStatus(superSession, facilityA, 'verified');
  expectStatus(reverified, 201);
  assert.equal(reverified.body.status, 'verified');

  // Platform changes to one facility, by target: platform rows carry no
  // facility_id, so the facility filter alone never finds them.
  const targetPath = id => `/admin/audit/events?resourceType=facility&resourceId=${id}`;
  const facilityHistory = await get(auditorSession, targetPath(facilityA));
  expectStatus(facilityHistory, 200);
  assert.deepEqual(facilityHistory.body.items.map(item => item.action), ['admin.facility.verified', 'admin.facility.suspended']);
  assert(facilityHistory.body.items.every(item => item.resourceType === 'facility' && item.resourceId === facilityA
    && !('patientId' in item)));
  const upperCase = await get(auditorSession, targetPath(facilityA.toUpperCase()));
  expectStatus(upperCase, 200);
  assert.deepEqual(upperCase.body.items.map(item => item.sequenceId), facilityHistory.body.items.map(item => item.sequenceId));
  const firstOfTarget = await get(auditorSession, `${targetPath(facilityA)}&limit=1`);
  expectStatus(firstOfTarget, 200);
  const secondOfTarget = await get(auditorSession,
    `${targetPath(facilityA)}&limit=1&beforeSequenceId=${firstOfTarget.body.nextBeforeSequenceId}`);
  expectStatus(secondOfTarget, 200);
  assert.deepEqual([...firstOfTarget.body.items, ...secondOfTarget.body.items].map(item => item.sequenceId),
    facilityHistory.body.items.map(item => item.sequenceId));
  const byFacilityColumn = await get(auditorSession, `/admin/audit/events?facilityId=${facilityA}&action=admin.facility.suspended`);
  expectStatus(byFacilityColumn, 200);
  assert.equal(byFacilityColumn.body.items.length, 0, 'platform rows carry no facility_id; the target filter is needed');
  expectStatus(await get(auditorSession, targetPath(facilityB)), 200);
  assert.equal((await get(auditorSession, targetPath(facilityB))).body.items.length, 0);
  for (const invalid of [`/admin/audit/events?resourceId=${facilityA}`, '/admin/audit/events?resourceType=Facility',
    '/admin/audit/events?resourceType=facility&resourceId=a%20b', `/admin/audit/events?resourceType=facility&resourceId=${'a'.repeat(256)}`]) {
    expectStatus(await get(auditorSession, invalid), 400, 'VALIDATION_FAILED');
  }
  expectStatus(await get(supportSession, targetPath(facilityA)), 403, 'PERMISSION_DENIED');
  boundaries.facility_reachability = { only_super_admin_works_there: 'suspended and restored' };
  boundaries.audit_target_filter = { events: facilityHistory.body.items.length, case_insensitive_uuid: true,
    keyset_pages: 2, facility_column_finds: 0, invalid: 'VALIDATION_FAILED', support: 'PERMISSION_DENIED' };

  // Per-principal MFA enrolment: true only with an active authenticator; no factor detail.
  // The facility administrator enrolled at their first staff sign-in (MFA-1).
  const listed = await get(superSession, '/admin/principals?query=admin-runtime&pageSize=100');
  expectStatus(listed, 200);
  const enrolment = Object.fromEntries(listed.body.items.map(item => [item.id, item.mfaEnrolled]));
  assert.deepEqual([enrolment[superAdmin.id], enrolment[auditor.id], enrolment[support.id],
    enrolment[facilityAdmin.id], enrolment[pendingReset.id]], [true, true, true, true, false]);
  for (const item of listed.body.items) {
    assert.equal(typeof item.mfaEnrolled, 'boolean');
    for (const key of Object.keys(item)) assert(!/secret|factor|recovery|totp/i.test(key), `principal row exposes ${key}`);
  }
  boundaries.principal_mfa_state = { enrolled: 4, not_enrolled: 1, factor_detail: 'none' };

  // Demo requests: newest first by (created_at, id), in pages joined by an
  // opaque cursor. Microsecond-distinct and equal timestamps sit at page edges.
  const demoBase = new Date(Date.now() - 3_600_000);
  const demoAt = (minutes, micros = 0) => {
    const at = new Date(demoBase.getTime() + minutes * 60_000);
    return `${at.toISOString().slice(0, 19)}.${String(micros).padStart(6, '0')}Z`;
  };
  const demoRows = [['d1', demoAt(1)], ['d2', demoAt(2)], ['tieA', demoAt(3)], ['tieB', demoAt(3)],
    ['d6', demoAt(4, 100)], ['d7', demoAt(4, 900)], ['d5', demoAt(5, 123456)]];
  const demoIds = {};
  for (const [label, createdAt] of demoRows) {
    demoIds[label] = randomUUID();
    await owner.query(`insert into identity.demo_requests (id, idempotency_key_sha256, contact_name, contact_email,
        product_code, status, created_at, updated_at) values ($1, $2, $3, $4, 'migrate', 'qualified', $5, $5)`,
    [demoIds[label], randomUUID().replaceAll('-', '').padEnd(64, '0'), `Demo ${label}`, `${label}@example.invalid`, createdAt]);
  }
  const demoPath = (extra = '') => `/admin/demo-requests?status=qualified&productCode=migrate${extra}`;
  const everyDemo = await get(superSession, demoPath('&limit=100'));
  expectStatus(everyDemo, 200);
  assert.equal(everyDemo.body.nextCursor, null);
  const [tieHigh, tieLow] = [demoIds.tieA, demoIds.tieB].sort().reverse();
  assert.deepEqual(everyDemo.body.items.map(item => item.id),
    [demoIds.d5, demoIds.d7, demoIds.d6, tieHigh, tieLow, demoIds.d2, demoIds.d1]);
  const pagedDemo = [];
  let demoCursor = null;
  let demoPages = 0;
  do {
    const page = await get(superSession, demoPath(`&limit=2${demoCursor ? `&cursor=${demoCursor}` : ''}`));
    expectStatus(page, 200);
    assert(page.body.items.length <= 2);
    for (const item of page.body.items) assert(!('cursorAt' in item));
    pagedDemo.push(...page.body.items.map(item => item.id));
    demoCursor = page.body.nextCursor;
    demoPages += 1;
  } while (demoCursor && demoPages < 10);
  assert.deepEqual(pagedDemo, everyDemo.body.items.map(item => item.id), 'cursor pages must return every row once, in order');
  assert.equal(demoPages, 4);
  const demoFirst = await get(superSession, demoPath('&limit=2'));
  const issued = demoFirst.body.nextCursor;
  const flipped = `${issued.slice(0, 12)}${issued[12] === 'A' ? 'B' : 'A'}${issued.slice(13)}`;
  for (const cursor of [flipped, issued.slice(0, -3), `${issued}x`, 'not-a-cursor!',
    encodeCursor('admin.approvals', { status: null }, { at: demoAt(1), id: demoIds.d1 })]) {
    expectStatus(await get(superSession, demoPath(`&limit=2&cursor=${encodeURIComponent(cursor)}`)), 400, 'ADMIN_INVALID_CURSOR');
  }
  expectStatus(await get(superSession, `/admin/demo-requests?status=new&productCode=migrate&limit=2&cursor=${issued}`),
    400, 'ADMIN_INVALID_CURSOR');
  expectStatus(await get(superSession, demoPath(`&cursor=${'A'.repeat(513)}`)), 400, 'VALIDATION_FAILED');
  expectStatus(await get(supportSession, demoPath(`&limit=2&cursor=${issued}`)), 403, 'PERMISSION_DENIED');
  boundaries.demo_request_cursor = { rows: pagedDemo.length, pages: demoPages, microsecond_boundary: true,
    tampered: 'ADMIN_INVALID_CURSOR', other_filter: 'ADMIN_INVALID_CURSOR', other_list: 'ADMIN_INVALID_CURSOR',
    without_permission: 'PERMISSION_DENIED' };

  // 10. Launch D14 workforce provisioning (0087), end to end through the real
  // routes: an onboarded facility (0061's shape: one org_admin, no clinician),
  // attach, credential attestation by one administrator, role grant by a
  // second, the clinician's sign-in, HID lookup and access request, then the
  // end of the membership. The Super Admin works at facility A, never at C.
  const facilityC = randomUUID();
  await owner.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
    values ($1, $2, 'Admin Runtime Facility C', $3, 'Africa/Lagos', true, 'verified')`,
  [facilityC, organizationId, `ADMIN-C-${facilityC.slice(0, 6)}`]);
  const orgAdmin = await account('workforce-org-admin', { membershipRole: 'org_admin', facility: facilityC });
  const reviewer = await account('workforce-reviewer', { platformRole: 'platform_super_admin' });
  const reviewerSession = asPlatform(await platform.enroll(reviewer.email));
  const orgAdminStaff = await signIn(orgAdmin);
  const clinicianEmail = `admin-runtime-clinician-${randomUUID().slice(0, 8)}@example.invalid`;
  const workforceKey = () => `workforce-runtime-${randomUUID()}`;
  const attach = (who, key) => command(who, '/admin/workforce/memberships',
    { facilityId: facilityC, email: clinicianEmail, fullName: 'Runtime Clinician', reason: 'Clinician joins facility C' },
    { 'Idempotency-Key': key });

  // An org_admin is not a platform administrator; a Support Admin lacks the permission;
  // an administrator without a fresh step-up is refused.
  expectStatus(await http.post('/api/v1/admin/workforce/memberships').set('Authorization', orgAdminStaff.bearer)
    .send({ facilityId: facilityC, email: clinicianEmail, fullName: 'Runtime Clinician', reason: 'Self-service attempt' }),
  403, 'PLATFORM_SESSION_REQUIRED');
  expectStatus(await attach(supportSession, workforceKey()), 403, 'PERMISSION_DENIED');
  expectStatus(await attach(reviewerSession, workforceKey()), 403, 'STEP_UP_REQUIRED');
  await platform.stepUp(reviewerSession);
  const attachKey = workforceKey();
  const attached = await attach(reviewerSession, attachKey);
  expectStatus(attached, 201);
  assert.equal(attached.body.state, 'pending');
  assert.equal(attached.body.accountCreated, true);
  assert.equal(attached.body.accountStatus, 'pending_reset');
  const replayedAttach = await attach(reviewerSession, attachKey);
  expectStatus(replayedAttach, 201);
  assert.equal(replayedAttach.body.replayed, true);
  assert.equal(replayedAttach.body.membershipId, attached.body.membershipId);
  const clinician = { id: attached.body.accountId, email: clinicianEmail };
  const clinicianLogin = () => http.post('/api/v1/auth/login').set('Origin', origin)
    .send({ email: clinicianEmail, password, turnstileAction: 'staff-login' });
  // Pending: no password was ever set or shared, and the membership grants nothing.
  expectStatus(await clinicianLogin(), 401);

  const profile = await get(reviewerSession, `/admin/workforce/accounts/${clinician.id}`);
  expectStatus(profile, 200);
  assert.equal(profile.body.staff.verificationStatus, 'pending');
  assert.deepEqual(profile.body.memberships.map(item => [item.id, item.state]), [[attached.body.membershipId, 'pending']]);
  const attest = await command(reviewerSession, `/admin/workforce/accounts/${clinician.id}/attestations`, {
    attestedRoles: ['doctor'], credentialReference: 'MDCN/R/RUNTIME-1', issuingAuthority: 'Medical and Dental Council of Nigeria',
    verificationMethod: 'manual_review', evidenceReference: 'Synthetic credential review WF-RUNTIME-1',
    validUntil: new Date(Date.now() + 180 * 86_400_000).toISOString(), reason: 'Reviewed the practising licence',
  }, { 'If-Match': String(profile.body.staff.version), 'Idempotency-Key': workforceKey() });
  expectStatus(attest, 201);
  assert.equal(attest.body.verificationStatus, 'verified');

  const grant = (who, version) => command(who, `/admin/workforce/memberships/${attached.body.membershipId}/roles`,
    { facilityId: facilityC, roleCode: 'doctor', action: 'grant', reason: 'Attested doctor for facility C' },
    { 'If-Match': String(version), 'Idempotency-Key': workforceKey() });
  // The reviewer cannot also grant: a clinical role takes two administrators.
  expectStatus(await grant(reviewerSession, 1), 403, 'WORKFORCE_SECOND_PERSON_REQUIRED');
  await platform.stepUp(superSession);
  expectStatus(await command(superSession, `/admin/workforce/memberships/${attached.body.membershipId}/roles`,
    { facilityId: facilityA, roleCode: 'doctor', action: 'grant', reason: 'Attested doctor for facility C' },
    { 'If-Match': '1', 'Idempotency-Key': workforceKey() }), 409, 'WORKFORCE_FACILITY_MISMATCH');
  expectStatus(await grant(superSession, 1), 201);
  const granted = await get(superSession, `/admin/workforce/accounts/${clinician.id}`);
  expectStatus(granted, 200);
  const activeMembership = granted.body.memberships[0];
  assert.equal(activeMembership.state, 'active');
  assert.deepEqual(activeMembership.roles.map(role => [role.roleCode, role.effective]), [['doctor', true]]);
  // A Super Admin who works at facility A cannot provision facility A.
  expectStatus(await command(superSession, '/admin/workforce/memberships',
    { facilityId: facilityA, accountId: auditor.id, reason: 'Insider attach attempt' }, { 'Idempotency-Key': workforceKey() }),
  403, 'WORKFORCE_FACILITY_CONFLICT');

  // Activation: the clinician sets a password through account recovery, as
  // auth.complete_recovery_otp does (verify-otp-recovery-runtime covers that
  // flow); nobody else ever knew a password for the account.
  await owner.query(`update auth.accounts set password_hash = $2, password_algorithm = 'argon2id', status = 'active',
    password_changed_at = clock_timestamp() where id = $1 and status = 'pending_reset' and password_hash is null`,
  [clinician.id, passwordHash]);
  // Staff MFA (0088): the first sign-in enrols an authenticator with the code
  // emailed to the provisioned address.
  const clinicianSignedIn = await staff.signIn(clinicianEmail);
  assert.equal(clinicianSignedIn.accountId, clinician.id);
  const clinicianFacility = clinicianSignedIn.actor.facilities.find(facility => facility.id === facilityC);
  assert.deepEqual(clinicianFacility.roles, ['doctor']);
  assert(clinicianFacility.permissions.includes('identity.patient.read'));
  const clinicianSession = { cookie: clinicianSignedIn.cookie, csrf: clinicianSignedIn.csrf };

  // HID lookup and access requests at facility C; the patient approves
  // through the governed approval command; then the lookup is authorized.
  async function patientFixture(hid) {
    const accountId = randomUUID(); const patientId = randomUUID();
    await owner.query(`insert into auth.accounts (id, subject, email, status) values ($1, $2, $3, 'active')`,
      [accountId, `synthetic:admin-runtime:patient:${hid}`, `admin-runtime-patient-${hid.toLowerCase()}@example.invalid`]);
    await owner.query(`insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name)
      values ($1, $2, $3, 'Runtime', 'Patient', 'Runtime Patient')`, [patientId, accountId, hid]);
    return { accountId, patientId, hid, subject: `synthetic:admin-runtime:patient:${hid}` };
  }
  const hidSuffix = () => Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
  const patientA = await patientFixture(`HID-${hidSuffix()}`);
  const patientB = await patientFixture(`HID-${hidSuffix()}`);
  const patientC = await patientFixture(`HID-${hidSuffix()}`);
  const clinical = (who, path, body) => http.post(`/api/v1${path}`).set('Cookie', who.cookie).set('Origin', origin)
    .set('x-csrf-token', who.csrf).set('X-Facility-ID', facilityC).set('X-Purpose-Of-Use', 'direct-care').send(body);
  const lookup = who => clinical(who, '/identity/patient-lookup', { hid: patientA.hid, purpose: 'direct-care' });
  const beforeConsent = await lookup(clinicianSession);
  assert([403, 404].includes(beforeConsent.status), `lookup before consent answered ${beforeConsent.status}`);
  for (const patient of [patientA, patientB, patientC]) {
    expectStatus(await clinical(clinicianSession, '/identity/access-requests',
      { hid: patient.hid, scope: 'read_records', reason: 'Clinic visit at facility C', durationMinutes: 60 }), 201);
  }
  const pendingRequest = async patient => (await owner.query(`select id::text from identity.access_requests
    where patient_id = $1 and status = 'pending'`, [patient.patientId])).rows[0].id;
  const approveAs = async (client, patient, requestId) => {
    await client.query(`select set_config('app.actor_subject', $1, true), set_config('app.correlation_id', $2, true)`,
      [patient.subject, `workforce-runtime-approve-${randomUUID().slice(0, 8)}`]);
    await client.query('select * from identity.approve_access_request($1)', [requestId]);
  };
  const approver = await owner.connect();
  try {
    await approver.query('begin');
    await approveAs(approver, patientA, await pendingRequest(patientA));
    await approver.query('commit');
  } catch (error) { await approver.query('rollback'); throw error; } finally { approver.release(); }
  const afterConsent = await lookup(clinicianSession);
  expectStatus(afterConsent, lookupStatus);
  assert.equal(afterConsent.body.patient.hid, patientA.hid);
  // The facility's org_admin stays non-clinical.
  expectStatus(await lookup(orgAdminStaff), 403, 'PERMISSION_DENIED');

  // A revoked role leaves the membership bound with no role and no permission:
  // the actor's roles are the effective role assignments, never the stored
  // membership labels. A new grant on the current attestation restores both.
  const membershipVersion = async () => Number((await owner.query(
    'select row_version from identity.staff_facility_memberships where id = $1', [attached.body.membershipId])).rows[0].row_version);
  const changeRole = async action => command(superSession, `/admin/workforce/memberships/${attached.body.membershipId}/roles`,
    { facilityId: facilityC, roleCode: 'doctor', action, reason: `Runtime doctor ${action} at facility C` },
    { 'If-Match': String(await membershipVersion()), 'Idempotency-Key': workforceKey() });
  const clinicianFacilityNow = async () => {
    const current = await get(clinicianSession, '/auth/session');
    expectStatus(current, 200);
    return current.body.actor.facilities.find(facility => facility.id === facilityC);
  };
  const revoked = await changeRole('revoke');
  expectStatus(revoked, 201);
  assert.equal(revoked.body.roleActive, false);
  assert.equal(revoked.body.renewed, false);
  const afterRevoke = await clinicianFacilityNow();
  assert.deepEqual([afterRevoke.roles, afterRevoke.permissions], [[], []]);
  expectStatus(await lookup(clinicianSession), 403, 'PERMISSION_DENIED');
  const regranted = await changeRole('grant');
  expectStatus(regranted, 201);
  assert.equal(regranted.body.renewed, false);
  const afterRegrant = await clinicianFacilityNow();
  assert.deepEqual(afterRegrant.roles, ['doctor']);
  assert(afterRegrant.permissions.includes('identity.patient.read'));

  // Ending the membership while two transactions hold row locks on it. The
  // patient (P) holds B's request FOR UPDATE and approves it 1.5 s later; a
  // staff transaction (S) holds the membership's KEY SHARE, as any insert that
  // references it does, and 0.7 s later asks for KEY SHARE on the clinician's
  // account row, which the end holds FOR UPDATE. The end locks the accounts,
  // then the membership FOR NO KEY UPDATE (which S's KEY SHARE does not block),
  // and waits on B's request until P commits. Nobody deadlocks; B's new grant
  // is revoked with A's, and C's pending request expires.
  const requestB = await pendingRequest(patientB);
  const deadlocks = async () => Number((await owner.query(`select deadlocks from pg_stat_database
    where datname = current_database()`)).rows[0].deadlocks);
  const deadlocksBefore = await deadlocks();
  const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
  await platform.stepUp(superSession);
  const endVersion = await membershipVersion();
  // The fixture pool's two connections; nothing else may use it until both are released.
  const patientTransaction = await owner.connect();
  const staffTransaction = await owner.connect();
  let ended;
  let endElapsed;
  let staffAccountWait;
  try {
    await patientTransaction.query('begin');
    await patientTransaction.query('select id from identity.access_requests where id = $1 for update', [requestB]);
    await staffTransaction.query('begin');
    await staffTransaction.query('select id from identity.staff_facility_memberships where id = $1 for key share',
      [attached.body.membershipId]);
    const approval = (async () => {
      await patientTransaction.query('select pg_sleep(1.5)');
      await approveAs(patientTransaction, patientB, requestB);
      await patientTransaction.query('commit');
    })();
    const staffWork = (async () => {
      await pause(700);
      const asked = performance.now();
      await staffTransaction.query('select id from auth.accounts where id = $1 for key share', [clinician.id]);
      staffAccountWait = Math.round(performance.now() - asked);
      await staffTransaction.query('rollback');
    })();
    const endStarted = performance.now();
    const ending = command(superSession, `/admin/workforce/memberships/${attached.body.membershipId}/end`,
      { facilityId: facilityC, reason: 'Clinician left facility C' },
      { 'If-Match': String(endVersion), 'Idempotency-Key': workforceKey() })
      .then(response => { endElapsed = Math.round(performance.now() - endStarted); return response; });
    const [approvalOutcome, staffOutcome, endOutcome] = await Promise.allSettled([approval, staffWork, ending]);
    assert.equal(approvalOutcome.status, 'fulfilled', `the racing approval failed: ${approvalOutcome.reason?.message}`);
    assert.equal(staffOutcome.status, 'fulfilled', `the racing staff transaction failed: ${staffOutcome.reason?.message}`);
    assert.equal(endOutcome.status, 'fulfilled', `the end failed: ${endOutcome.reason?.message}`);
    ended = endOutcome.value;
  } finally {
    await patientTransaction.query('rollback').catch(() => undefined);
    await staffTransaction.query('rollback').catch(() => undefined);
    patientTransaction.release(); staffTransaction.release();
  }
  expectStatus(ended, 201);
  // The end really waited on the approval's request lock (the approval commits after 1.5 s).
  assert(endElapsed >= 1000, `the end did not wait on the approval's lock (${endElapsed} ms)`);
  assert.equal(ended.body.state, 'ended');
  assert.equal(ended.body.revokedRoles, 1);
  assert.equal(ended.body.revokedGrants, 2);
  assert.equal(ended.body.expiredRequests, 1);
  assert(ended.body.revokedSessions >= 1);
  // pg_stat_database is flushed when a backend's transaction ends; allow it a moment.
  await pause(1200);
  const raceDeadlocks = (await deadlocks()) - deadlocksBefore;
  assert.equal(raceDeadlocks, 0, 'ending the membership deadlocked with the racing transactions');
  const left = (await owner.query(`select
      (select count(*)::integer from identity.consent_grants where membership_id = $1 and status = 'active') as active_grants,
      (select count(*)::integer from identity.access_requests where membership_id = $1 and status = 'pending') as pending_requests,
      (select status from identity.access_requests where id = $2) as request_b`,
  [attached.body.membershipId, requestB])).rows[0];
  assert.deepEqual(left, { active_grants: 0, pending_requests: 0, request_b: 'approved' });
  expectStatus(await lookup(clinicianSession), 401);
  expectStatus(await clinicianLogin(), 401);
  const workforceAudit = (await owner.query(`select action, access_scope, facility_id from audit.events
    where action like 'admin.workforce.%' and outcome = 'success' and actor_account_id = any($1::uuid[])
    order by sequence_id`, [[reviewer.id, superAdmin.id]])).rows;
  assert.deepEqual(workforceAudit.map(row => row.action).filter(action => !action.endsWith('.request')),
    ['admin.workforce.membership.attached', 'admin.workforce.credential.attested', 'admin.workforce.role.granted',
      'admin.workforce.role.revoked', 'admin.workforce.role.granted', 'admin.workforce.membership.ended']);
  assert(workforceAudit.every(row => row.access_scope === 'platform' && row.facility_id === null));
  boundaries.workforce_provisioning = { org_admin_route: 'PLATFORM_SESSION_REQUIRED', without_permission: 'PERMISSION_DENIED',
    without_step_up: 'STEP_UP_REQUIRED', attach: 'pending', reviewer_grants: 'WORKFORCE_SECOND_PERSON_REQUIRED',
    other_facility: 'WORKFORCE_FACILITY_MISMATCH', insider: 'WORKFORCE_FACILITY_CONFLICT', clinician_sign_in: 200,
    lookup_before_consent: beforeConsent.status, access_request: 201, lookup_after_approval: lookupStatus,
    org_admin_lookup: 'PERMISSION_DENIED', after_revoke: { roles: [], lookup: 'PERMISSION_DENIED' },
    after_regrant: { roles: ['doctor'] },
    end_during_approval_and_key_share: { deadlocks: raceDeadlocks, end_waited_ms: endElapsed,
      staff_account_lock_waited_ms: staffAccountWait, revokedGrants: 2, expiredRequests: 1,
      approved_request_grant: 'revoked', signed_out: 401 } };

  process.stdout.write(JSON.stringify({ status: 'passed', runtimeRole,
    routes: ['/admin/session', '/admin/overview', '/admin/principals', '/admin/audit/events', '/admin/facilities/:id/status',
      '/admin/demo-requests', '/admin/workforce/memberships', '/admin/workforce/accounts/:id/attestations',
      '/admin/workforce/memberships/:id/roles', '/admin/workforce/memberships/:id/end'], boundaries }) + '\n');
} finally {
  await app?.close();
  await owner.end();
  await maintenance.query(`drop database if exists ${isolated} with (force)`);
  await maintenance.end();
}
