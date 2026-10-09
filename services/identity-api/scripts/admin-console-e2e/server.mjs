// Admin console end-to-end harness (Phase 4 Stage 5), part 1 of 2: serves this
// checkout's Identity API over real HTTP for the Health-id platform admin console,
// on a disposable copy of a local rehearsal database. Local and staging-rehearsal
// use only: it never connects to anything but the given Unix socket and creates
// synthetic accounts in its own database, which it drops on SIGTERM/SIGINT.
//
// Same module wiring as verify-platform-security-runtime.mjs, plus main.ts's CORS
// (the real corsOptions), cookie and body settings; helmet is not applied. The
// only test seam is the backend's own MFA_TOTP_CLOCK, driven from a control port
// so a TOTP code is single-use without waiting 30 seconds.
//
// Environment (run as the non-root owner of the socket):
//   HID_E2E_SOCKET        Unix socket directory of a cluster whose HID_E2E_TEMPLATE_DB is migrated
//                         and role-bootstrapped (required)
//   HID_E2E_DB_SUPERUSER  cluster superuser (default hid_rehearsal_admin)
//   HID_E2E_TEMPLATE_DB   database to copy (default hid_rehearsal)
//   HID_E2E_WORKDIR       where fixtures.json is written (required)
//   HID_E2E_APP_ORIGIN    console origin allowed by CORS (default http://127.0.0.1:3200)
//   HID_E2E_API_PORT / HID_E2E_CONTROL_PORT (defaults 4010 / 4011)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const service = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(service, 'package.json'));
const required = (name) => process.env[name] || (() => { throw new Error(`${name} is required`); })();
const socket = required('HID_E2E_SOCKET');
// A Unix socket directory only: this harness never connects over TCP.
assert(isAbsolute(socket), 'HID_E2E_SOCKET must be an absolute Unix socket directory');
const workdir = required('HID_E2E_WORKDIR');
const superuser = process.env.HID_E2E_DB_SUPERUSER || 'hid_rehearsal_admin';
const template = process.env.HID_E2E_TEMPLATE_DB || 'hid_rehearsal';
const appOrigin = process.env.HID_E2E_APP_ORIGIN || 'http://127.0.0.1:3200';
const apiPort = Number(process.env.HID_E2E_API_PORT || 4010);
const controlPort = Number(process.env.HID_E2E_CONTROL_PORT || 4011);
assert.match(template, /^[a-z_][a-z0-9_]*$/);
const isolated = `hid_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
Object.assign(process.env, { NODE_ENV: 'test', AUTH_MODE: 'local',
  AUTH_SIGNING_SECRET: Buffer.alloc(32, 0x11).toString('base64url'), AUTH_LOGIN_PEPPER: Buffer.alloc(32, 0x22).toString('base64url'),
  OTP_HMAC_KEY_B64: Buffer.alloc(32, 0x33).toString('base64'), AUTH_COOKIE_SECURE: 'false', HID_DEPLOYMENT_ENV: 'staging',
  NIN_PROVIDER_MODE: 'deferred', CORS_ORIGINS: appOrigin, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'public-synthetic-ehr-workload-token', TURNSTILE_MODE: 'disabled',
  MFA_SECRET_KEY_B64: Buffer.alloc(32, 0x5a).toString('base64'), MFA_KEY_VERSION: 'e2e-v1',
  DATABASE_URL: `postgresql://${superuser}@localhost/${isolated}?host=${encodeURIComponent(socket)}`
    + `&options=${encodeURIComponent('-c role=hid_identity_api_runtime')}` });
delete process.env.AUTH_COOKIE_DOMAIN;
require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const load = path => require(join(service, 'src', path));
const { Pool } = require('pg');
const { Test } = require('@nestjs/testing');
const { Reflector } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
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
const { IntegrationAdminController } = load('integrations/integration-admin.controller.ts');
const { IntegrationAdminService } = load('integrations/integration-admin.service.ts');
const { IntegrationRuntimeService } = load('integrations/integration-runtime.service.ts');
const { AdminOrganizationApplicationsController } = load('identity/organization-applications.controller.ts');
const { OrganizationApplicationsService } = load('identity/organization-applications.service.ts');
const { QoreIdVerificationAdapter } = load('identity/qoreid-verification.adapter.ts');
const { AdminDemoRequestsController } = load('commercial/demo-requests.controller.ts');
const { DemoRequestsService } = load('commercial/demo-requests.service.ts');
const { preventResponseCaching } = load('common/response-security.middleware.ts');
const { corsOptions } = load('config/cors.ts');

const maintenance = new Pool({ host: socket, user: superuser, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${template}`);
const owner = new Pool({ host: socket, user: superuser, database: isolated, max: 2 });
owner.on('error', () => undefined);

const argon2 = require('argon2');
const password = 'Synthetic-E2E-Password-2026';
const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
async function account(label, { platformRole, displayName } = {}) {
  const id = randomUUID();
  const email = `e2e-${label}-${id.slice(0, 8)}@example.invalid`;
  await owner.query(`insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm)
    values ($1, $2, $3, $4, 'active', $5, 'argon2id')`, [id, `synthetic:e2e:${label}`, email, displayName ?? `E2E ${label}`, passwordHash]);
  if (platformRole) {
    await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
      values ($1, $2, $3, 'platform', 'Synthetic Stage 5 end-to-end check')`, [randomUUID(), id, platformRole]);
  }
  return { id, email };
}
const fixtures = {
  password,
  superA: await account('super-a', { platformRole: 'platform_super_admin', displayName: 'Ada SuperA' }),
  superB: await account('super-b', { platformRole: 'platform_super_admin', displayName: 'Bola SuperB' }),
  support: await account('support', { platformRole: 'support_admin', displayName: 'Chidi Support' }),
  target: await account('target', { displayName: 'Dayo Target' }),
};
for (let index = 1; index <= 28; index += 1) {
  await account(`paging-${String(index).padStart(2, '0')}`, { displayName: `E2E Paging ${String(index).padStart(2, '0')}` });
}

// Synthetic organizations, facilities, applications and demo requests.
const orgA = randomUUID(); const orgB = randomUUID();
await owner.query(`insert into identity.organizations (id, name, slug) values ($1, 'Lagos Synthetic Health', 'lagos-synthetic-health'),
  ($2, 'Abuja Synthetic Care', 'abuja-synthetic-care')`, [orgA, orgB]);
async function facility(org, name, code, status, reason = null) {
  const id = randomUUID();
  await owner.query(`insert into identity.facilities (id, organization_id, name, code, active, timezone, lifecycle_status, status_reason, status_changed_at)
    values ($1, $2, $3, $4, $5, 'Africa/Lagos', $6, $7, $8)`, [id, org, name, code, status === 'verified', status, reason, reason ? new Date() : null]);
  return id;
}
fixtures.facilities = {
  ikeja: await facility(orgA, 'Synthetic Ikeja Clinic', 'SYN-IKJ', 'verified'),
  lekki: await facility(orgA, 'Synthetic Lekki Clinic', 'SYN-LKK', 'pending'),
  wuse: await facility(orgB, 'Synthetic Wuse Hospital', 'SYN-WSE', 'suspended', 'Synthetic suspension for review'),
};
for (let index = 1; index <= 26; index += 1) {
  await facility(orgB, `Synthetic Paging Facility ${String(index).padStart(2, '0')}`, `SYN-P${String(index).padStart(2, '0')}`, 'pending');
}
async function application(name, cac, status) {
  const ready = status === 'ready_for_review';
  const result = await owner.query(`insert into identity.organization_applications (product_code, organization_name, organization_type,
      cac_registration_number, administrator_name, administrator_email, status, verification_result, verified_at, provider_reference,
      provider_verified_registration_number, profile_state, verified_organization_name, verified_entity_type, verified_registration_date,
      verified_address, verified_registry_status, qoreid_organization_name, qoreid_entity_type, qoreid_registration_date, qoreid_address,
      qoreid_registry_status, organization_name_source, entity_type_source, registration_date_source, address_source, registry_status_source)
    values ('ehr', $1, 'clinic', $2, 'Synthetic Administrator', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $10, $11, $12, $13, $14,
      $15, $15, $15, $15, $15) returning id`,
    [name, cac, `admin-${cac.toLowerCase()}@example.invalid`, status, ready ? 'verified' : null, ready ? new Date() : null,
      ready ? '1001' : null, ready ? cac : null, ready ? 'complete' : null, ready ? name : null, ready ? 'Limited company' : null,
      ready ? '2015-04-01' : null, ready ? '1 Synthetic Way, Lagos' : null, ready ? 'active' : null, ready ? 'qoreid' : null]);
  return result.rows[0].id;
}
fixtures.applications = {
  approve: await application('Synthetic Approve Clinic Ltd', 'RC100001', 'ready_for_review'),
  reject: await application('Synthetic Reject Clinic Ltd', 'RC100002', 'ready_for_review'),
  pending: await application('Synthetic Pending Clinic Ltd', 'RC100003', 'pending_verification'),
};
async function demo(name, product, status, secondsAgo) {
  await owner.query(`insert into identity.demo_requests (id, idempotency_key_sha256, contact_name, contact_email, organization_name, product_code, status, created_at)
    values ($1, $7, $2, $3, $4, $5, $6, now() - $8 * interval '1 second')`,
    [randomUUID(), name, `${name.toLowerCase().replaceAll(' ', '.')}@example.invalid`, `${name} Org`, product, status,
      createHash('sha256').update(name).digest('hex'), secondsAgo]);
}
// 55 new demo requests (more than one 50-row page), the newest first, plus one contacted.
for (let index = 1; index <= 55; index += 1) {
  await demo(`Synthetic Demo ${String(index).padStart(2, '0')}`, ['ehr', 'laboratory', 'pharmacy'][index % 3], 'new', index * 60);
}
await demo('Synthetic Demo Contacted', 'pharmacy', 'contacted', 4000);

// 55 pending Super Admin elevation requests made by Super Admin B, one per target account.
fixtures.approvalTargets = [];
for (let index = 1; index <= 55; index += 1) {
  const target = await account(`approval-${String(index).padStart(2, '0')}`, { displayName: `E2E Approval Target ${String(index).padStart(2, '0')}` });
  fixtures.approvalTargets.push(target.id);
  await owner.query(`insert into auth.admin_approval_requests (id, action, target_account_id, role_code, reason, status,
      requested_by, requested_at, expires_at, correlation_id)
    values ($1, 'platform_role.grant', $2, 'platform_super_admin', $3, 'pending', $4,
      now() - $5 * interval '1 minute', now() - $5 * interval '1 minute' + interval '20 hours', $6)`,
  [randomUUID(), target.id, `Synthetic paging request ${String(index).padStart(2, '0')}`, fixtures.superB.id, index,
    `e2e-stage5-approval-${String(index).padStart(2, '0')}`]);
}

let virtualOffset = 0;
const clock = () => Date.now() + virtualOffset;
const module = await Test.createTestingModule({
  controllers: [AuthController, PlatformAuthController, AdminController, PlatformSecurityController, AuditController,
    IntegrationAdminController, AdminOrganizationApplicationsController, AdminDemoRequestsController],
  providers: [DatabaseService, TokenService, LocalAuthProvider, CurrentStaffContextService, CurrentPatientContextService,
    AuthService, AuthSessionAuditService, AuditService, WorkloadAuthService, TurnstileService, AdminService,
    AdminOperationsService, PricingService, MfaService, MfaSecretProtector, PlatformSecurityService,
    IntegrationAdminService, IntegrationRuntimeService, OrganizationApplicationsService, DemoRequestsService,
    // QoreID is disabled in this database; the adapter is never reached.
    { provide: QoreIdVerificationAdapter, useValue: { verifyCac: async () => { throw new Error('No QoreID in e2e'); } } },
    { provide: MFA_TOTP_CLOCK, useValue: clock },
    { provide: NotificationOtpClient, useValue: { deliver: async () => { throw new Error('No notifications in e2e'); } } },
    { provide: GoogleAuthenticationService, useValue: { login: async () => { throw new Error('No Google in e2e'); } } }],
}).compile();
assert.equal((await module.get(DatabaseService).query('select current_user as role')).rows[0].role, 'hid_identity_api_runtime');
const app = module.createNestApplication({ logger: ['error'], bodyParser: false });
app.setGlobalPrefix('api/v1');
app.use(preventResponseCaching);
app.use(require('cookie-parser')());
app.useBodyParser('json', { limit: 256 * 1024, strict: true, type: ['application/json', 'application/*+json'] });
app.use((req, _res, next) => { req.correlationId = randomUUID(); next(); });
// main.ts's CORS configuration, from the code under test.
app.enableCors(corsOptions(appOrigin));
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
  transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
  exceptionFactory: errors => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
    errors.map(error => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
app.useGlobalFilters(new ProblemDetailsFilter());
app.useGlobalGuards(new SecurityGuard(module.get(Reflector), module.get(TokenService), module.get(AuditService), module.get(DatabaseService)));
app.useGlobalInterceptors(new AuditInterceptor(module.get(Reflector), module.get(AuditService)));
await app.listen(apiPort, '127.0.0.1');

// Control port: advance the virtual TOTP clock one step and return its code.
createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${controlPort}`);
  if (url.pathname === '/code') {
    virtualOffset += 30_000;
    const secret = url.searchParams.get('secret').replace(/\s+/g, '');
    res.end(totp.totp(totp.base32Decode(secret), clock()));
    return;
  }
  res.statusCode = 404; res.end();
}).listen(controlPort, '127.0.0.1');

writeFileSync(join(workdir, 'fixtures.json'), JSON.stringify({ ...fixtures, database: isolated }, null, 2));
console.log(`admin console e2e api ready on 127.0.0.1:${apiPort} database ${isolated}`);
const stop = async () => { await app.close(); await owner.end(); await maintenance.query(`drop database if exists ${isolated} with (force)`); await maintenance.end(); process.exit(0); };
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
