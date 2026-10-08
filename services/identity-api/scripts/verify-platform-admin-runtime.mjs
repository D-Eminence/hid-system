#!/usr/bin/env node
// Platform Admin HTTP boundaries, executed as the exact Identity API runtime
// role against the owned disposable synthetic rehearsal only. The real
// DatabaseService, SecurityGuard, AuditInterceptor, controllers, services and
// database authorization run; nothing is mocked except that no notification is
// ever sent. No network or cloud call is made. All values are synthetic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
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
const { DomainProblem, ProblemDetailsFilter } = load('common/problem.ts');

globalThis.fetch = async (input) => { throw new Error(`Unexpected outbound request to ${String(input)}`); };
const maintenance = new Pool({ host: socket, user: process.env.PGUSER, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
// Fixture and assertion connection (database owner), never used by the API.
const owner = new Pool({ host: socket, user: process.env.PGUSER, database: isolated, max: 2 });
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

  const module = await Test.createTestingModule({
    controllers: [AuthController, AdminController, AuditController],
    providers: [DatabaseService, TokenService, LocalAuthProvider,
      CurrentStaffContextService, CurrentPatientContextService, AuthService, AuthSessionAuditService,
      AuditService, WorkloadAuthService, TurnstileService, AdminService, AdminOperationsService, PricingService,
      { provide: NotificationOtpClient, useValue: {
        deliver: async () => { throw new Error('Notification delivery is outside the platform admin verifier'); },
      } },
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
  async function signIn(who) {
    const response = await http.post('/api/v1/auth/login').set('Origin', origin)
      .send({ email: who.email, password, turnstileAction: 'staff-login' });
    expectStatus(response, 200);
    assert.equal(response.body.actor.accountId, who.id);
    return { cookie: (response.headers['set-cookie'] ?? []).map(value => value.split(';')[0]).join('; '),
      csrf: response.headers['x-csrf-token'], account: who };
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
  const adminRoutes = ['/admin/session', '/admin/overview', '/admin/principals?query=admin-runtime',
    '/admin/audit/events?limit=5'];
  const boundaries = {};

  // 1. Missing authentication is refused on every admin route.
  for (const route of adminRoutes) expectStatus(await get(null, route), 401, 'AUTHENTICATION_REQUIRED');
  boundaries.unauthenticated = 401;

  const superSession = await signIn(superAdmin);
  const auditorSession = await signIn(auditor);
  const supportSession = await signIn(support);
  const facilitySession = await signIn(facilityAdmin);

  // 2-3. An ordinary facility administrator is refused, with or without the
  // facility context of their own membership; the denial is platform-scoped.
  for (const route of adminRoutes) {
    expectStatus(await get(facilitySession, route), 403, 'PERMISSION_DENIED');
    expectStatus(await get(facilitySession, route, { 'X-Facility-ID': facilityA }), 403, 'PERMISSION_DENIED');
  }
  const facilityDenials = (await owner.query(`select access_scope, facility_id, actor_membership_id from audit.events
    where actor_account_id = $1 and action = 'security.authorization' and outcome = 'denied'`, [facilityAdmin.id])).rows;
  assert.equal(facilityDenials.length, adminRoutes.length * 2);
  assert(facilityDenials.every(row => row.access_scope === 'platform' && row.facility_id === null
    && row.actor_membership_id === null), 'Admin route denials must be platform-scoped evidence');
  boundaries.facility_staff = 'PERMISSION_DENIED';

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
  assert.equal(seen.length + lastPage.body.items.length, facilityDenials.length + 1,
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
  expectStatus(await facilityAudit(superSession, {}), 400, 'FACILITY_REQUIRED');
  expectStatus(await facilityAudit(superSession, { 'X-Facility-ID': facilityA }), 403, 'PERMISSION_DENIED');
  expectStatus(await facilityAudit(superSession, { 'X-Facility-ID': facilityB }), 403, 'FACILITY_ACCESS_DENIED');
  expectStatus(await facilityAudit(auditorSession, { 'X-Facility-ID': facilityA }), 403, 'FACILITY_ACCESS_DENIED');
  const facilityRows = (await owner.query(`select facility_id, actor_membership_id, access_scope from audit.events
    where actor_account_id = $1 and action = 'api.audit.events.list.request' and outcome = 'success'`,
  [facilityAdmin.id])).rows;
  assert.equal(facilityRows.length, 1);
  assert.equal(facilityRows[0].facility_id, facilityA);
  assert.notEqual(facilityRows[0].actor_membership_id, null);
  assert.equal(facilityRows[0].access_scope, null);
  boundaries.facility_routes = { missing_header: 'FACILITY_REQUIRED', cross_facility: 'FACILITY_ACCESS_DENIED',
    platform_grants_on_facility_route: 'PERMISSION_DENIED' };

  // 8. Account status safety over HTTP.
  const version = async id => (await owner.query('select row_version from auth.accounts where id = $1', [id])).rows[0].row_version;
  const statusCommand = async (who, target, status) => command(who, `/admin/principals/${target.id}/status`,
    { status, reason: 'Platform admin runtime verifier' },
    { 'If-Match': String(await version(target.id)), 'Idempotency-Key': `admin-runtime-${randomUUID()}` });
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
  boundaries.account_status = { pending_reset_activation: 'ACCOUNT_RECOVERY_REQUIRED',
    self_change: 'ADMIN_SELF_CHANGE_DENIED', disable_enable_restores: 'pending_reset' };

  process.stdout.write(JSON.stringify({ status: 'passed', runtimeRole,
    routes: ['/admin/session', '/admin/overview', '/admin/principals', '/admin/audit/events'], boundaries }) + '\n');
} finally {
  await app?.close();
  await owner.end();
  await maintenance.query(`drop database if exists ${isolated} with (force)`);
  await maintenance.end();
}
