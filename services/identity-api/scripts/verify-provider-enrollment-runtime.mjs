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
// daily QoreID cap, the 24-hour lapse and support's review are added, and the
// fixes of the adversarial review: the database's own gate driven through
// Identity (a request parked behind a lock while the control closes), the
// activation pre-check and its attempt budget, the administrator details of
// the code that proved the mailbox, the quota charged per network before the
// submit, support's release of a fraudulent sign-up and its list and
// rejection of open applications, and availability's reason. And the
// website's second contract: the confirmation read before the password
// (GET profile, R13) and start's answer when no code is sent (codeSent
// false, the code in force and the wait, R14). And the second review: a lapse
// refuses no one and a renewal from the same email or network holds nothing,
// support's rejection or release refuses for 7 days unless it lets the
// applicant retry, support's waiver, the registered email closing its
// application (R15); the open list ranked, counted and searched (R16); and
// the governed completion route sending no code for a self-service
// application (R17). And P4b (p4b SPEC §10): the restricted role until
// support's review; the review that grants org_admin and the type's role with
// a licence (or no clinical access) and signs the administrator out; support's
// administrator-role change and the end of the first 30 days; the review gate
// trigger; the first 30 days' emergency cap; staff invitations end to end (the
// invite with password re-entry, the email through a local stub of
// notification-api's staff-invitation route that validates it with that
// route's own DTO and renders it with its own template, open by link and by
// typed code, accept as a new or dormant account, accept signed in as existing
// staff, a patient's email refused), resend, revoke, remove and role change,
// the limits, the release's new effects, support's reads, the audit scan, the
// staff context's timing; and the applicant's withdrawal (R18).
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
// Staff of a laboratory or a pharmacy sign in on their product's host (P4b).
const labOrigin = 'https://lab.healthidentitydirectory.com';
const pharmacyOrigin = 'https://pharmacy.healthidentitydirectory.com';
const adminOrigin = 'https://admin.healthidentitydirectory.com';
// The public site, where the governed completion (organization-completion) runs.
const publicOrigin = 'https://healthidentitydirectory.com';
const runtimeOptions = `options=${encodeURIComponent('-c role=hid_identity_api_runtime')}`;
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'production',
  NIN_PROVIDER_MODE: 'unavailable', CORS_ORIGINS: [origin, ehrOrigin, labOrigin, pharmacyOrigin, adminOrigin, publicOrigin].join(','),
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
  TRUST_PROXY_CIDRS: '127.0.0.1/32,::1/128',
  // P4b: the staff invitation email goes through the real NotificationOtpClient
  // to a local stub of notification-api's route (below); nothing leaves the process.
  NOTIFICATION_API_URL: 'http://notification-api.verifier.invalid:3007',
  NOTIFICATION_SERVICE_IDENTITY_MODE: 'local-secret',
  NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN: 'synthetic-notification-workload-token' });
// The code default applies (200 lookups a day across every self sign-up).
for (const key of ['AUTH_COOKIE_DOMAIN', 'PROVIDER_SELF_SERVICE_QOREID_DAILY_CAP', 'NIN_LOOKUP_HMAC_KEY_B64',
  'NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE', 'OTP_HMAC_KEY_VERSION',
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
const { AdminOrganizationApplicationsController, PublicOrganizationProfileCompletionController } =
  load('identity/organization-applications.controller.ts');
const { OrganizationApplicationsService } = load('identity/organization-applications.service.ts');
const { AdminSelfServiceFacilitiesController, AdminSelfServiceApplicationsController } =
  load('identity/self-service-facilities.controller.ts');
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
// P4b.
const { FacilityStaffController } = load('identity/facility-staff.controller.ts');
const { StaffInvitationsPublicController } = load('identity/staff-invitations-public.controller.ts');
const { StaffInvitationsSignedInController } = load('identity/staff-invitations-signed-in.controller.ts');
const { AdminFacilityStaffController } = load('identity/admin-facility-staff.controller.ts');
const { StaffInvitationsService } = load('identity/staff-invitations.service.ts');
const { FacilityStaffService } = load('identity/facility-staff.service.ts');
const { StaffReauthenticationService } = load('identity/staff-reauthentication.service.ts');
const { ConsentController } = load('consent/consent.controller.ts');
const { ConsentService } = load('consent/consent.service.ts');
const { IdentityController } = load('identity/identity.controller.ts');
const { IdentityService } = load('identity/identity.service.ts');
const { NinRegistrationController } = load('identity/nin-registration.controller.ts');
const { NinRegistrationService } = load('identity/nin-registration.service.ts');
const { STAFF_CONTEXT_SQL, STAFF_MEMBERSHIPS_SQL } = load('auth/current-staff-context.service.ts');
// notification-api's own staff-invitation route contract (P4b, SPEC §7): its
// DTO, recipient check and template, loaded from that service with its own
// class-validator, so the local stub refuses what the route would refuse.
const notificationService = resolve(service, '../notification-api');
const notificationRequire = createRequire(join(notificationService, 'package.json'));
const { DeliverStaffInvitationDto } = notificationRequire(join(notificationService,
  'src/notification/dto/deliver-staff-invitation.dto.ts'));
const { validateRecipient } = notificationRequire(join(notificationService, 'src/notification/dto/deliver-otp.dto.ts'));
const { staffInvitationContent, staffInvitationLinkOrigin } = notificationRequire(join(notificationService,
  'src/providers/provider.types.ts'));
const notificationValidator = notificationRequire('class-validator');
const notificationTransformer = notificationRequire('class-transformer');
assert.equal(getEnvironment().PROVIDER_SELF_SERVICE_QOREID_DAILY_CAP, 200, 'The code default cap must apply');

// Cloudflare Siteverify stub. A token encodes the outcome the real service
// would return: `ok|<action>|<hostname>|<n>` or `replayed`. As at Cloudflare, a
// token verifies once: verifying it again under another idempotency key
// answers timeout-or-duplicate, and a retry under the same key repeats the
// first answer. Any other outbound request fails the verifier, except the
// staff invitation email (P4b), which goes to the local stub of
// notification-api's route below.
const siteverifyUrl = getEnvironment().TURNSTILE_SITEVERIFY_URL;
const siteverifyRequests = [];
const verifiedTokens = new Map();
// Local stub of notification-api's POST /api/v1/notifications/staff-invitation
// (P4b, SPEC §7). It checks what the real route checks before delivery, in its
// order: the internal caller and workload token, the idempotency key's
// pattern, the body against the route's own DTO (whitelist, no unknown
// field) and recipient check; it then renders the email with the route's own
// template for the production deployment and answers 202 with the outcome
// set in invitationOutcome (as Novu answers), keeping each email.
const staffInvitationUrl = `${getEnvironment().NOTIFICATION_API_URL.replace(/\/+$/, '')}/api/v1/notifications/staff-invitation`;
const invitationEmails = [];
let invitationOutcome = 'accepted';
const staffInvitationRoute = async (init) => {
  assert.equal(init?.method, 'POST');
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  assert.equal(headers['x-hid-internal-caller'], 'identity-api');
  assert.equal(headers['x-hid-service-token'], 'synthetic-notification-workload-token');
  assert.match(headers['idempotency-key'] ?? '', /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/);
  assert.match(headers['idempotency-key'], /^staff-invitation:[0-9a-f-]{36}$/);
  assert.equal(headers['content-type'], 'application/json');
  const body = JSON.parse(String(init.body));
  const dto = notificationTransformer.plainToInstance(DeliverStaffInvitationDto, body);
  const errors = await notificationValidator.validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  assert.deepEqual(errors.map(error => [error.property, Object.keys(error.constraints ?? {})]), [],
    'notification-api would refuse the staff invitation body');
  assert.equal(body.channel, 'email');
  assert(validateRecipient('email', body.recipient), 'notification-api would refuse the recipient');
  const content = staffInvitationContent({ facilityName: body.facilityName ?? null, roleCode: body.roleCode,
    invitationId: body.invitationId, token: body.token, code: body.code, expiresAt: new Date(body.expiresAt),
    origin: staffInvitationLinkOrigin('production'), supportEmail: 'support@verifier.invalid' });
  invitationEmails.push({ headers, body, subject: content.subject, text: content.text });
  return Response.json({ requestId: randomUUID(), outcome: invitationOutcome,
    primary: { provider: 'ses', outcome: invitationOutcome } }, { status: 202 });
};
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === staffInvitationUrl) return staffInvitationRoute(init);
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
// IPv6 /64), which the application also keeps, and the public application
// quota's client network (the same IPv4 address or IPv6 /64, review fix R5).
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
  // P4b: set once the module is built. The real NotificationOtpClient (its
  // delivery plan, path, idempotency key, headers and body) sends each staff
  // invitation to the local route stub above; what Identity hands it is kept.
  deliverStaffInvitation: undefined,
  // 0095's (B4) and 0096's (B5) emails: no service this verifier builds calls them; stubbed so a wiring change cannot reach the network.
  deliverPatientShareInvitation: async () => ({ outcome: 'accepted', provider: 'brevo' }),
  deliverShareReceived: async () => ({ outcome: 'accepted', provider: 'brevo' }),
  deliverRecordAccessAlert: async () => ({ outcome: 'accepted', provider: 'brevo' }),
  deliverAccountDeletionNotice: async () => ({ outcome: 'accepted', provider: 'brevo' }),
  // 0097's (B6) web push: no service this verifier builds sends one; stubbed for the same reason.
  deliverWebPush: async () => ({ outcome: 'accepted' }),
};
const staffInvitationInputs = [];
// identity/patient-lookup's service is outside this verifier: a stub that
// answers only once the permission check has passed (P4b's before/after).
const patientLookupStub = { lookupPatient: async () => ({ verifierStub: 'patient lookup reached the service' }) };
let app;
try {
  // Fixture: the platform has enabled QoreID CAC verification (an admin action).
  await owner.query("update platform.integration_providers set enabled=true, row_version=row_version+1 where provider='qoreid'");
  const module = await Test.createTestingModule({
    controllers: [AuthController, ProviderEnrollmentController, AdminOrganizationApplicationsController,
      PublicOrganizationProfileCompletionController,
      AdminSelfServiceFacilitiesController, AdminSelfServiceApplicationsController, AdminController,
      FacilityStaffController, StaffInvitationsPublicController, StaffInvitationsSignedInController,
      AdminFacilityStaffController, ConsentController, IdentityController, NinRegistrationController],
    providers: [DatabaseService, TokenService, LocalAuthProvider,
      CurrentStaffContextService, CurrentPatientContextService, AuthService, AuthSessionAuditService,
      AuditService, WorkloadAuthService, TurnstileService, IntegrationRuntimeService,
      ProviderEnrollmentService, OrganizationProfileCompletionService, OrganizationApplicationsService,
      SelfServiceFacilitiesService, AdminService, AdminOperationsService, PricingService, EmergencyContactProtector,
      QoreIdVerificationAdapter,
      StaffInvitationsService, FacilityStaffService, StaffReauthenticationService, ConsentService,
      { provide: IdentityService, useValue: patientLookupStub },
      { provide: NinRegistrationService, useValue: {} },
      { provide: QOREID_ADAPTER_CONFIGURATION, useValue: { baseUrl: 'https://api.qoreid.com',
        clientId: 'example-qoreid-client', clientSecret: 'example-qoreid-secret', timeoutMs: 2000 } },
      { provide: QOREID_FETCH, useValue: qoreidFetch },
      { provide: NotificationOtpClient, useValue: notification },
      { provide: GoogleAuthenticationService, useValue: {
        login: async () => { throw new Error('Google exchange is outside the provider-enrollment verifier'); },
      } }] }).compile();
  const runtimeRole = (await module.get(DatabaseService).query('select current_user as role')).rows[0].role;
  assert.equal(runtimeRole, 'hid_identity_api_runtime');
  const notificationClient = new NotificationOtpClient(module.get(IntegrationRuntimeService));
  notification.deliverStaffInvitation = async (input) => {
    staffInvitationInputs.push(input);
    return notificationClient.deliverStaffInvitation(input);
  };
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
  // The confirmation read is a GET: browsers send no Origin on a same-origin
  // GET, so the verifier sends none.
  const profile = (enrollmentCookie, extra = {}) => {
    let call = http.get(`${ENROLL}/profile`);
    if (enrollmentCookie) call = call.set('Cookie', enrollmentCookie);
    for (const [name, value] of Object.entries(extra)) call = call.set(name, value);
    return call;
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
  const confirmation = {};
  const noCode = {};

  // 0. The gate ships closed (0086 seeds provider_self_service_enabled off):
  // availability is false and every route answers 423 after its own request
  // checks. Start checks it after Turnstile; nothing is written or charged.
  // Availability says why it is closed (R10).
  assert.deepEqual(await availability(), { open: false, reason: 'closed' });
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
  expectProblem(await profile(), 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
  expectProblem(await profile('hid_provider_enrollment=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
  // Request checks still come first while closed (C6): DTO, Origin, signed-in browser.
  expectProblem(await verify({ challengeId: 'not-a-uuid', code: '000000' }), 400, 'VALIDATION_FAILED');
  expectProblem(await http.post(`${ENROLL}/verify`).send({ challengeId: randomUUID(), code: '000000' }), 403, 'ORIGIN_DENIED');
  expectProblem(await activate(undefined, 'xxxxxxxxxxxx', { Cookie: `${cookieName}_csrf=x` }),
    409, 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT');
  expectProblem(await profile(`${cookieName}_csrf=x`), 409, 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT');
  assert.equal(qoreidCacLookups.length, 0, 'A closed gate reached QoreID');
  assert.equal(await count('select count(*)::int n from identity.organization_applications'), 0, 'A closed gate wrote an application');
  assert.equal(await count('select count(*)::int n from platform.public_application_quota_counters'), 0, 'A closed gate charged the application quota');
  assert.equal(await startFailures(), startFailuresBefore + 1, 'The closed start was not audited as the request failure (C7)');
  gate.closed = { availability: false, start: 423, verify: 423, activate: 423, profile: 423, turnstileBeforeGate: true,
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
  // Open, with P4c's orders between facilities still off (0086 seeds cross_facility_orders_enabled off).
  assert.deepEqual(await availability(), { open: true, crossFacilityOrders: false });
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
    assert.deepEqual(await availability(), { open: false, reason: 'closed' }, `${controlKey} did not close availability`);
    expectProblem(await verify({ challengeId: randomUUID(), code: '000000' }), 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
    expectProblem(await profile(), 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
    expectProblem(await start(enrollment({ cacRegistrationNumber: closedCac, administratorEmail: email('closed') }),
      '198.51.100.90'), 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
    await setControl(controlKey, !closing, 2);
  }
  assert.deepEqual(await availability(), { open: true, crossFacilityOrders: false });
  assert.equal(await count('select count(*)::int n from identity.organization_applications'), 0, 'A closed gate wrote an application');
  gate.a13 = { maintenance_mode_on: 423, provider_portal_off: 423 };
  // R10: a fault reading the controls is not "closed" (the page says "try
  // again shortly"): the runtime briefly loses EXECUTE on control_enabled.
  await owner.query('revoke execute on function platform.control_enabled(text) from public');
  try {
    assert.deepEqual(await availability(), { open: false, reason: 'unavailable' });
  } finally {
    await owner.query('grant execute on function platform.control_enabled(text) to public');
  }
  assert.deepEqual(await availability(), { open: true, crossFacilityOrders: false });
  gate.availability = { closed: 'closed', fault: 'unavailable', open: true };
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
  assert.deepEqual({ ...started.body, challengeId: undefined }, { accepted: true, codeSent: true, challengeId: undefined,
    expiresInSeconds: 600, resendAfterSeconds: 60 });
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

  // R14: the same sign-up started again within 60 seconds of its code (another
  // tab, or a reload, on another network here so MAIN's counters stay as they
  // are) sends no new code and says so: codeSent false, the code in force (the
  // one just sent, which the next step verifies) and the wait. No QoreID lookup.
  const NO_CODE_NETWORK = '198.51.100.60';
  const deliveriesBeforeNoCode = recipients.length;
  const lookupsBeforeNoCode = qoreidCacLookups.length;
  const startedAgain = await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA }),
    NO_CODE_NETWORK);
  assert.equal(startedAgain.status, 200, `start again failed: ${JSON.stringify(startedAgain.body)}`);
  assert.deepEqual(Object.keys(startedAgain.body).sort(),
    ['accepted', 'challengeId', 'codeSent', 'expiresInSeconds', 'resendAfterSeconds']);
  assert.equal(startedAgain.body.accepted, true);
  assert.equal(startedAgain.body.codeSent, false, 'A start within 60 seconds answered as if it sent a code');
  assert.equal(startedAgain.body.challengeId, challengeId, 'The code in force is not the one just sent');
  assert(startedAgain.body.expiresInSeconds > 0 && startedAgain.body.expiresInSeconds <= 600);
  assert(startedAgain.body.resendAfterSeconds >= 1 && startedAgain.body.resendAfterSeconds <= 60,
    `resendAfterSeconds ${startedAgain.body.resendAfterSeconds}`);
  await completion.settleDeliveries();
  assert.equal(recipients.length, deliveriesBeforeNoCode, 'A start that sent no code delivered one');
  assert.equal(qoreidCacLookups.length, lookupsBeforeNoCode, 'A start that sent no code reached QoreID');
  assert.deepEqual(await applicationCharges(NO_CODE_NETWORK), { hour: 1, day: 1 }, 'A start that sent no code was not charged');
  noCode.cooldown = { status: 200, codeSent: false, challengeId: 'the code in force', delivered: 0,
    resendAfterSeconds: startedAgain.body.resendAfterSeconds };

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

  // R13: before the password, the applicant reads what the activation will
  // register: the verified legal name, the CAC number as entered, the product,
  // the organization type and the administrator. A GET with no Origin and the
  // enrollment cookie only. It is never cached, sets no cookie and changes
  // nothing: no attempt charged, the session still live.
  const sessionState = async challenge => (await owner.query(`select activation_attempts,
      invalidated_at is not null as ended from identity.organization_profile_completion_challenges where id=$1`,
  [challenge])).rows[0];
  expectProblem(await profile(), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  expectProblem(await profile('hid_provider_enrollment=not-a-session'), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  expectProblem(await profile(`hid_provider_enrollment=${'A'.repeat(43)}`), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  const confirmed = await profile(enrollmentCookie);
  assert.equal(confirmed.status, 200, `confirmation read failed: ${JSON.stringify(confirmed.body)}`);
  assert.deepEqual(confirmed.body, { organizationName: `Runtime Clinic ${cacA} Ltd`, registrationNumber: cacA,
    productCode: 'ehr', organizationType: 'clinic', administratorName: 'Synthetic Provider Admin',
    administratorEmail: emailA });
  assert.match(confirmed.headers['cache-control'] ?? '', /no-store/);
  assert.equal(confirmed.headers['set-cookie'], undefined, 'The confirmation read set a cookie');
  assert.deepEqual(await sessionState(challengeId), { activation_attempts: 0, ended: false });
  expectProblem(await profile(`${enrollmentCookie}; ${cookieName}_csrf=x`), 409, 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT');
  // A start after the code was used, within its 60 seconds, sends none and
  // has no code in force to name.
  const afterVerify = await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA }), NO_CODE_NETWORK);
  assert.equal(afterVerify.status, 200, `start after verify failed: ${JSON.stringify(afterVerify.body)}`);
  assert.equal(afterVerify.body.codeSent, false);
  assert.equal(afterVerify.body.challengeId, undefined, 'A used code was named as the code in force');
  assert.equal(afterVerify.body.expiresInSeconds, undefined);
  assert(afterVerify.body.resendAfterSeconds >= 1 && afterVerify.body.resendAfterSeconds <= 60);
  assert.deepEqual(await sessionState(challengeId), { activation_attempts: 0, ended: false });
  noCode.after_verify = { codeSent: false, challengeId: 'absent', sessionKept: true };
  confirmation.read = { status: 200, origin: 'none', noCookie: 401, malformed: 401, unknownSession: 401,
    signedIn: 409, cached: false, attemptsCharged: 0, sessionEnded: false };

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
    membership_role: 'org_admin', membership_active: true, role_code: 'org_admin_awaiting_review',
    application_status: 'approved', reviewer: null, application_facility: true, support_review: null, cac_bindings: 1 }]);
  // P4b: until support's review the administrator holds only the restricted
  // role, granted by no one.
  assert.deepEqual((await owner.query(`select role_code, granted_by, revoked_at from auth.account_roles
     where account_id=$1`, [accountId])).rows, [{ role_code: 'org_admin_awaiting_review', granted_by: null, revoked_at: null }]);
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
  // P4b: before support's review, exactly the restricted role's six permissions
  // and the facility's self sign-up state.
  const restrictedPermissions = ['audit.read', 'outreach.campaign.read', 'outreach.campaign.write',
    'outreach.registration.read', 'outreach.registration.write', 'workforce.manage'];
  assert.deepEqual([...selected.body.actor.permissions].sort(), restrictedPermissions,
    'The pending administrator holds more than the restricted role');
  assert.deepEqual(selected.body.actor.facility.selfService, { review: 'pending', organizationType: 'clinic' });
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

  // The consumed enrollment session cannot activate again, nor be read.
  expectProblem(await activate(enrollmentCookie, password), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  expectProblem(await profile(enrollmentCookie), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  confirmation.after_activation = 401;
  security.replayed_activation = 'ORGANIZATION_COMPLETION_SESSION_INVALID';

  // 8 (#81). A registered CAC is sent to review, for its own or another
  // administrator email, without a new registry lookup or a quota charge.
  const lookupsBeforeDuplicate = qoreidCacLookups.length;
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: emailA })),
    409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW');
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacA, administratorEmail: email('c') })),
    409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW');
  assert.equal(qoreidCacLookups.length, lookupsBeforeDuplicate, 'A duplicate CAC reached QoreID');
  // R4: the quota is charged before the submit, so a refused start costs one too.
  assert.deepEqual(await applicationCharges(MAIN), { hour: 4, day: 4 }, 'A refused submit was not charged the application quota');
  security.duplicate_cac = 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW';
  quota.refused_start_charged = true;

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
  // R15: that email can never activate it, so the application is closed
  // (no reviewer, no refusal), audited.
  const takenApplication = await application(cacTaken);
  assert.deepEqual({ ...takenApplication, id: undefined }, { id: undefined,
    status: 'rejected', verification_result: 'verified', approval_mode: 'self_service' });
  assert.deepEqual((await owner.query(`select reviewed_by_account_id, review_reason, self_service_refusal_ends_at
      from identity.organization_applications where id=$1`, [takenApplication.id])).rows,
  [{ reviewed_by_account_id: null, self_service_refusal_ends_at: null,
    review_reason: 'Self-service application closed: its administrator email already belongs to an account' }]);
  assert.deepEqual((await owner.query(`select actor_type, details from audit.events
    where action='identity.organization.self-service.close' and resource_id=$1`, [takenApplication.id])).rows,
  [{ actor_type: 'system', details: { productCode: 'ehr', closeReason: 'administrator_email_registered' } }]);
  // R1: the pre-check answered it before any hash (no attempt charged) and
  // ended the session, so retrying costs nothing either.
  assert.deepEqual(await sessionState(startedTaken.body.challengeId), { activation_attempts: 0, ended: true });
  expectProblem(await activate(takenCookie, 'Synthetic-Provider-Password-2027'), 401,
    'ORGANIZATION_COMPLETION_SESSION_INVALID');
  // The applicant starts again at once, from the same network, with another
  // email: a new application, without a hold (that network just had one).
  const emailTakenWork = email('taken-work');
  const restartedTaken = await start(enrollment({ cacRegistrationNumber: cacTaken, administratorEmail: emailTakenWork }),
    TAKEN_NETWORK);
  assert.equal(restartedTaken.status, 200, `restart after the registered email failed: ${JSON.stringify(restartedTaken.body)}`);
  assert.equal(restartedTaken.body.codeSent, true);
  assert.equal(qoreidCacLookups.at(-1), cacTaken, 'The new application was not verified with QoreID');
  const restartedApplication = await application(cacTaken, emailTakenWork);
  assert.notEqual(restartedApplication.id, takenApplication.id);
  assert.deepEqual((await owner.query(`select status, self_service_without_hold from identity.organization_applications
    where id=$1`, [restartedApplication.id])).rows, [{ status: 'ready_for_review', self_service_without_hold: true }]);
  security.activation_email_registered = 'PROVIDER_EMAIL_ALREADY_REGISTERED';
  session.precheck_email_registered = { attempts: 0, sessionEnded: true, retry: 401, applicationClosed: true,
    restartSameNetworkOtherEmail: 200, restartHold: false };

  // R17: the governed completion route (the public site's) sends no code for
  // a self-service application: its answer stays uniform, nothing is
  // delivered and no challenge is stored. The restart's code is past its 60
  // seconds, so only the approval mode stops it.
  await owner.query(`update identity.organization_profile_completion_challenges
    set created_at = created_at - interval '2 minutes' where application_id=$1`, [restartedApplication.id]);
  await completion.settleDeliveries();
  const deliveriesBeforeGoverned = recipients.length;
  const governedStart = await http.post('/api/v1/identity/organization-applications/completion/start')
    .set('Origin', publicOrigin).set('X-Forwarded-For', '198.51.100.70')
    .send({ productCode: 'ehr', cacRegistrationNumber: cacTaken, administratorEmail: emailTakenWork,
      turnstileAction: 'organization-completion',
      turnstileToken: turnstile('organization-completion', new URL(publicOrigin).hostname) });
  assert.equal(governedStart.status, 200, `governed completion start: ${JSON.stringify(governedStart.body)}`);
  assert.deepEqual(Object.keys(governedStart.body).sort(),
    ['accepted', 'challengeId', 'expiresInSeconds', 'resendAfterSeconds']);
  await completion.settleDeliveries();
  assert.equal(recipients.length, deliveriesBeforeGoverned, 'The governed route delivered a self-service code');
  assert.equal(await count('select count(*)::int n from identity.organization_profile_completion_challenges where id=$1',
    [governedStart.body.challengeId]), 0, 'The governed route stored a challenge for a self-service application');
  security.governed_completion_self_service = { status: 200, delivered: 0, stored: 0 };

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
  const secondCookie = cookies(secondVerified).find(value => value.startsWith('hid_provider_enrollment='));
  const secondConfirmed = await profile(secondCookie);
  assert.equal(secondConfirmed.status, 200);
  assert.deepEqual([secondConfirmed.body.organizationName, secondConfirmed.body.productCode,
    secondConfirmed.body.organizationType], [`Runtime Clinic ${cacA} Ltd`, 'pharmacy', 'pharmacy']);
  expectProblem(await activate(secondCookie, password), 409, 'ORGANIZATION_REVIEW_REQUIRED');
  assert.deepEqual(await footprint(), footprintBeforeSecond, 'A second product activation created or changed something');
  assert.deepEqual(await sessionState(secondProduct.body.challengeId), { activation_attempts: 0, ended: true });
  expectProblem(await activate(secondCookie, password), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
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
  assert.deepEqual(await applicationCharges(RACE_NETWORK), { hour: 2, day: 2 },
    'A start conflict was not charged the application quota (R4)');
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
  // R6: the sitting that proves the mailbox sends another name and type.
  const resumedAgain = await start(enrollment({ cacRegistrationNumber: cacB, administratorEmail: emailB,
    administratorName: 'Dr Ada Obi', organizationType: 'hospital' }));
  assert.equal(resumedAgain.status, 200, `second resume failed: ${JSON.stringify(resumedAgain.body)}`);
  assert.equal(qoreidCacLookups.length, lookupsBeforeResume, 'Verified evidence was looked up again');
  const sittingTwo = await verify({ challengeId: resumedAgain.body.challengeId,
    code: await codeFor(resumedAgain.body.challengeId) });
  assert.equal(sittingTwo.status, 200, `second sitting verify failed: ${JSON.stringify(sittingTwo.body)}`);
  const sittingTwoCookie = cookies(sittingTwo).find(value => value.startsWith('hid_provider_enrollment='));
  // The confirmation shows the details the account will keep: those of the
  // code that proved the mailbox (R6), not the first sitting's.
  const sittingTwoConfirmed = await profile(sittingTwoCookie);
  assert.equal(sittingTwoConfirmed.status, 200);
  assert.deepEqual(sittingTwoConfirmed.body, { organizationName: `Runtime Clinic ${cacB} Ltd`, registrationNumber: cacB,
    productCode: 'ehr', organizationType: 'hospital', administratorName: 'Dr Ada Obi', administratorEmail: emailB });
  const sittingOneConfirmed = await profile(sittingOneCookie);
  assert.deepEqual([sittingOneConfirmed.body.administratorName, sittingOneConfirmed.body.organizationType],
    ['Synthetic Provider Admin', 'clinic']);
  confirmation.details_of_proving_code = { administratorName: 'Dr Ada Obi', organizationType: 'hospital' };
  const activatedB = await activate(sittingTwoCookie, password);
  assert.equal(activatedB.status, 200, `second sitting activation failed: ${JSON.stringify(activatedB.body)}`);
  assert.equal(activatedB.body.actor.accountId, activatedB.body.accountId);
  assert.deepEqual((await owner.query(`select a.display_name, s.full_name, app.administrator_name, app.organization_type
      from auth.accounts a join identity.staff s on s.account_id = a.id
      join identity.organization_applications app on app.first_admin_account_id = a.id where a.id=$1`,
  [activatedB.body.accountId])).rows, [{ display_name: 'Dr Ada Obi', full_name: 'Dr Ada Obi',
    administrator_name: 'Dr Ada Obi', organization_type: 'hospital' }],
  'The account did not keep the details sent with the code that proved the mailbox');
  session.details_from_proving_code = { administratorName: 'Dr Ada Obi', organizationType: 'hospital' };
  expectProblem(await activate(sittingOneCookie, password), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  assert.deepEqual(await applicationCharges(MAIN), { hour: 7, day: 7 }, 'Each start charges the application quota once');
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
  // R5: the public application quota is charged to the /64 too, never to the address.
  assert.deepEqual(await applicationCharges('2001:db8:aa:bb::/64'), { hour: 6, day: 6 });
  assert.deepEqual(await applicationCharges('2001:db8:aa:bb::1'), {});
  assert.deepEqual(await applicationCharges('2001:db8:aa:bc::/64'), { hour: 1, day: 1 });
  quota.ipv6_application_quota = { key: '/64', charges: 6 };

  // R14: at a limit no code is sent, and start says so. One sign-up gets 5
  // codes in an hour (each past the 60 seconds); the 6th start sends none and
  // names the 5th code, still in force and still verifiable, with the wait
  // until the first is an hour old (0056).
  const LIMIT_NETWORK = '198.51.100.61';
  const cacLimit = 'RC9900063221'; const emailLimit = email('limit');
  const ageCodes = (cac, seconds) => owner.query(`update identity.organization_profile_completion_challenges
      set created_at = created_at - make_interval(secs => $2)
    where application_id = (select id from identity.organization_applications where cac_registration_number=$1)`,
  [cac, seconds]);
  const waitFor = async (cac, offset, interval) => Number((await owner.query(`select ceil(extract(epoch from
      challenge.created_at + $3::interval - clock_timestamp()))::int as wait
    from identity.organization_profile_completion_challenges challenge
    join identity.organization_applications application on application.id = challenge.application_id
    where application.cac_registration_number = $1
    order by challenge.created_at desc offset $2 limit 1`, [cac, offset, interval])).rows[0].wait);
  const limitCodes = [];
  for (let index = 1; index <= 5; index += 1) {
    if (index > 1) await ageCodes(cacLimit, 61);
    const sent = await start(enrollment({ cacRegistrationNumber: cacLimit, administratorEmail: emailLimit }), LIMIT_NETWORK);
    assert.equal(sent.status, 200, `limit code ${index}: ${JSON.stringify(sent.body)}`);
    assert.equal(sent.body.codeSent, true, `Code ${index} of the hour was not sent`);
    limitCodes.push(sent.body.challengeId);
    if (index === 5) {
      // The 5th code's own answer already gives the hour's wait, not 60 seconds.
      assert(sent.body.resendAfterSeconds > 3000, `after the 5th code resendAfterSeconds ${sent.body.resendAfterSeconds}`);
    }
  }
  await ageCodes(cacLimit, 61);
  await completion.settleDeliveries();
  const deliveriesBeforeLimit = recipients.length;
  const limited = await start(enrollment({ cacRegistrationNumber: cacLimit, administratorEmail: emailLimit }), LIMIT_NETWORK);
  assert.equal(limited.status, 200, `the 6th start failed: ${JSON.stringify(limited.body)}`);
  assert.equal(limited.body.codeSent, false, 'A 6th code in an hour was reported as sent');
  assert.equal(limited.body.challengeId, limitCodes[4], 'The code in force is not the 5th');
  assert(limited.body.expiresInSeconds > 0 && limited.body.expiresInSeconds <= 600);
  const hourWait = await waitFor(cacLimit, 4, '1 hour');
  assert(Math.abs(limited.body.resendAfterSeconds - hourWait) <= 2 && hourWait > 3000,
    `resendAfterSeconds ${limited.body.resendAfterSeconds}, expected about ${hourWait}`);
  await completion.settleDeliveries();
  assert.equal(recipients.length, deliveriesBeforeLimit, 'A start at the hourly limit delivered a code');
  const limitVerified = await verify({ challengeId: limited.body.challengeId, code: await codeFor(limitCodes[4]) });
  assert.equal(limitVerified.status, 200, 'The code in force could not be verified');
  noCode.hourly_limit = { codesSent: 5, sixth: { codeSent: false, challengeId: 'the 5th code', verifies: true },
    resendAfterSeconds: limited.body.resendAfterSeconds };
  // R5: ten codes reached the administrator email in the last day (none in
  // force); the next start sends none, names no code, and gives the wait
  // until the 10th newest is a day old.
  const RECIPIENT_NETWORK = '198.51.100.62';
  const cacRecipient = 'RC9900063222'; const emailRecipient = email('recipient');
  const firstRecipient = await start(enrollment({ cacRegistrationNumber: cacRecipient, administratorEmail: emailRecipient }),
    RECIPIENT_NETWORK);
  assert.equal(firstRecipient.body.codeSent, true);
  // Its code is two hours old, so expired too.
  await owner.query(`update identity.organization_profile_completion_challenges
      set created_at = created_at - interval '2 hours', expires_at = created_at - interval '2 hours' + interval '10 minutes'
    where application_id = (select id from identity.organization_applications where cac_registration_number=$1)`,
  [cacRecipient]);
  await owner.query(`insert into identity.organization_profile_completion_challenges
      (id, application_id, code_hmac, created_at, expires_at)
    select gen_random_uuid(), application.id, encode(sha256(('verifier-recipient-' || n)::bytea), 'hex'),
      clock_timestamp() - make_interval(hours => 2, mins => n), clock_timestamp() - make_interval(hours => 2, mins => n)
        + interval '10 minutes'
      from identity.organization_applications application, generate_series(1, 9) n
     where application.cac_registration_number = $1`, [cacRecipient]);
  await completion.settleDeliveries();
  const deliveriesBeforeRecipient = recipients.length;
  const recipientLimited = await start(enrollment({ cacRegistrationNumber: cacRecipient,
    administratorEmail: emailRecipient }), RECIPIENT_NETWORK);
  assert.equal(recipientLimited.status, 200, `recipient start failed: ${JSON.stringify(recipientLimited.body)}`);
  assert.deepEqual(Object.keys(recipientLimited.body).sort(), ['accepted', 'codeSent', 'resendAfterSeconds']);
  assert.equal(recipientLimited.body.codeSent, false);
  const dayWait = await waitFor(cacRecipient, 9, '1 day');
  assert(Math.abs(recipientLimited.body.resendAfterSeconds - dayWait) <= 2 && dayWait > 70_000,
    `resendAfterSeconds ${recipientLimited.body.resendAfterSeconds}, expected about ${dayWait}`);
  await completion.settleDeliveries();
  assert.equal(recipients.length, deliveriesBeforeRecipient, 'A start at the recipient limit delivered a code');
  noCode.recipient_limit = { codeSent: false, challengeId: 'absent', resendAfterSeconds: recipientLimited.body.resendAfterSeconds };
  // R14: an application closed while its start was on the way (support
  // rejects it while the start waits on the code's recipient lock) answers
  // 409 PROVIDER_ENROLLMENT_REQUIRES_REVIEW, as a retry would, not codeSent
  // false; nothing is delivered. The code's 60 seconds have passed, so only
  // the closure stops it.
  const RACE_CLOSE_NETWORK = '198.51.100.63';
  const cacClosing = 'RC9900063223'; const emailClosing = email('closing');
  const closingFirst = await start(enrollment({ cacRegistrationNumber: cacClosing, administratorEmail: emailClosing }),
    RACE_CLOSE_NETWORK);
  assert.equal(closingFirst.body.codeSent, true);
  await ageCodes(cacClosing, 61);
  await completion.settleDeliveries();
  const deliveriesBeforeClosing = recipients.length;
  const recipientLock = await owner.connect();
  let closingStart;
  try {
    await recipientLock.query('begin');
    const lockPid = (await recipientLock.query('select pg_backend_pid() pid')).rows[0].pid;
    await recipientLock.query("select pg_advisory_xact_lock(hashtextextended('org-completion-recipient:' || $1, 0))",
      [emailClosing]);
    closingStart = start(enrollment({ cacRegistrationNumber: cacClosing, administratorEmail: emailClosing }),
      RACE_CLOSE_NETWORK).then(response => response);
    const deadline = Date.now() + 10_000;
    while ((await owner.query('select count(*)::int n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
      [lockPid])).rows[0].n === 0) {
      assert(Date.now() < deadline, 'The start did not wait on the recipient lock');
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
    const closing = (await owner.query(`select id, row_version from identity.organization_applications
      where cac_registration_number=$1`, [cacClosing])).rows[0];
    const rejectedMeanwhile = await adminPost(superAdmin, `/admin/self-service-applications/${closing.id}/reject`,
      { reason: 'Runtime verifier closes it while its start waits' }, { 'If-Match': `"${closing.row_version}"` });
    assert.equal(rejectedMeanwhile.status, 200, `reject while waiting: ${JSON.stringify(rejectedMeanwhile.body)}`);
    await recipientLock.query('commit');
  } catch (error) {
    await recipientLock.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    recipientLock.release();
  }
  expectProblem(await closingStart, 409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW');
  await completion.settleDeliveries();
  assert.equal(recipients.length, deliveriesBeforeClosing, 'A start for a closed application delivered a code');
  noCode.closed_meanwhile = 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW';

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
  // R3: the squatter's own email resumes its stale application without
  // renewing it. R15: its network taking the CAC over with another email
  // lapses it, but the new application holds nothing, so the real company's
  // next submit lapses that one at once and gets the hold.
  const lookupsBeforeSquatterResume = qoreidCacLookups.length;
  const squatterResumed = await start(enrollment({ cacRegistrationNumber: cacLapse, administratorEmail: emailSquatter }),
    '198.51.100.30');
  assert.equal(squatterResumed.status, 200, `squatter resume failed: ${JSON.stringify(squatterResumed.body)}`);
  assert.equal(qoreidCacLookups.length, lookupsBeforeSquatterResume, 'A squatter resume reached QoreID');
  assert.deepEqual((await owner.query(`select status, row_version, created_at < clock_timestamp() - interval '24 hours' stale
      from identity.organization_applications where id=$1`, [stale.id])).rows[0],
  { status: 'ready_for_review', row_version: stale.row_version, stale: true }, 'The squatter renewed its hold');
  const emailSquatterTwo = email('squatter-two');
  const renewed = await start(enrollment({ cacRegistrationNumber: cacLapse, administratorEmail: emailSquatterTwo }),
    '198.51.100.30');
  assert.equal(renewed.status, 200, `the squatter's renewal failed: ${JSON.stringify(renewed.body)}`);
  const renewal = await application(cacLapse, emailSquatterTwo);
  assert.deepEqual((await owner.query('select self_service_without_hold from identity.organization_applications where id=$1',
    [renewal.id])).rows, [{ self_service_without_hold: true }], 'The squatter\'s renewal holds the CAC');
  lapse.own_email_resumes_without_renewal = true;
  lapse.own_network_new_email = { status: 200, hold: false };
  const freed = await start(enrollment({ cacRegistrationNumber: cacLapse, administratorEmail: emailOwner }), '198.51.100.31');
  assert.equal(freed.status, 200, `start after the lapse failed: ${JSON.stringify(freed.body)}`);
  assert.equal(qoreidCacLookups.at(-1), cacLapse, 'The new application was not verified with QoreID');
  assert.deepEqual((await owner.query(`select status, self_service_without_hold from identity.organization_applications
    where cac_registration_number=$1 and administrator_email=$2`, [cacLapse, emailOwner])).rows,
  [{ status: 'ready_for_review', self_service_without_hold: false }], 'The real company was not given the hold');
  const lapsed = (await owner.query(`select status, reviewed_at is not null reviewed, review_reason, reviewed_by_account_id,
      row_version, self_service_refusal_ends_at from identity.organization_applications where id=$1`, [stale.id])).rows[0];
  assert.deepEqual(lapsed, { status: 'rejected', reviewed: true,
    review_reason: 'Self-service application lapsed: not activated within 24 hours of submission',
    reviewed_by_account_id: null, row_version: String(Number(stale.row_version) + 1), self_service_refusal_ends_at: null });
  assert.deepEqual((await owner.query(`select status, review_reason from identity.organization_applications where id=$1`,
    [renewal.id])).rows, [{ status: 'rejected',
    review_reason: 'Self-service application lapsed: opened without a hold and replaced by another sign-up' }]);
  assert.equal(await count(`select count(*)::int n from identity.organization_profile_completion_challenges
    where application_id=$1 and invalidated_at is null`, [stale.id]), 0, 'The lapse left a code or session usable');
  const lapseAudit = (await owner.query(`select actor_type, outcome, details from audit.events
    where action='identity.organization.self-service.lapse' and resource_id = any($1::text[]) order by sequence_id`,
  [[stale.id, renewal.id]])).rows;
  assert.deepEqual(lapseAudit, [{ actor_type: 'system', outcome: 'success',
    details: { productCode: 'ehr', previousStatus: 'ready_for_review', lapseAfterHours: 24, withoutHold: false } },
  { actor_type: 'system', outcome: 'success',
    details: { productCode: 'ehr', previousStatus: 'ready_for_review', lapseAfterHours: 24, withoutHold: true } }]);
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
    previousSession: 401, renewalWithoutHold: 'lapsed at once', newApplication: 'activated', refusal: 'none' };

  // R2: support releases a fraudulent self sign-up. Say the owner's sign-up
  // above was an impostor's: support suspends the facility and disables the
  // account with the existing commands, then releases it, and the real
  // company signs up the same CAC and product.
  const identityReviewer = await standalone('identity-review', ['identity_review_admin']);
  const facilitiesPath = '/admin/self-service-facilities';
  const impostor = (await owner.query(`select id, row_version from identity.organization_applications
    where organization_id=$1`, [activatedLapse.body.organizationId])).rows[0];
  const releasePath = `${facilitiesPath}/${impostor.id}/release`;
  const releaseReason = 'Impostor confirmed: the administrator email is not the company';
  expectProblem(await adminPost(superAdmin, releasePath, { reason: releaseReason },
    { 'If-Match': `"${impostor.row_version}"` }), 409, 'SELF_SERVICE_FACILITY_RELEASE_REQUIRES_SUSPENSION');
  expectProblem(await adminPost(identityReviewer, releasePath, { reason: releaseReason },
    { 'If-Match': `"${impostor.row_version}"` }), 403, 'PERMISSION_DENIED');
  const facilityVersion = (await owner.query('select row_version from identity.facilities where id=$1',
    [activatedLapse.body.facilityId])).rows[0].row_version;
  const suspended = await adminPost(superAdmin, `/admin/facilities/${activatedLapse.body.facilityId}/status`,
    { status: 'suspended', reason: releaseReason },
    { 'If-Match': `"${facilityVersion}"`, 'Idempotency-Key': `verifier-suspend-${randomUUID()}` });
  assert([200, 201].includes(suspended.status), `suspending failed: ${JSON.stringify(suspended.body)}`);
  const accountVersion = (await owner.query('select row_version from auth.accounts where id=$1',
    [activatedLapse.body.accountId])).rows[0].row_version;
  const disabled = await adminPost(superAdmin, `/admin/principals/${activatedLapse.body.accountId}/status`,
    { status: 'disabled', reason: releaseReason },
    { 'If-Match': `"${accountVersion}"`, 'Idempotency-Key': `verifier-disable-${randomUUID()}` });
  assert([200, 201].includes(disabled.status), `disabling failed: ${JSON.stringify(disabled.body)}`);
  expectProblem(await adminPost(superAdmin, releasePath, { reason: releaseReason },
    { 'If-Match': `"${Number(impostor.row_version) + 1}"` }), 409, 'VERSION_CONFLICT');
  const released = await adminPost(superAdmin, releasePath, { reason: `  ${releaseReason}  ` },
    { 'If-Match': `"${impostor.row_version}"` });
  assert.equal(released.status, 200, `release failed: ${JSON.stringify(released.body)}`);
  assert.deepEqual(Object.keys(released.body).sort(), ['applicationId', 'releasedAt', 'version']);
  assert.equal(released.body.version, Number(impostor.row_version) + 1);
  expectProblem(await adminPost(superAdmin, releasePath, { reason: releaseReason },
    { 'If-Match': `"${released.body.version}"` }), 409, 'SELF_SERVICE_FACILITY_ALREADY_RELEASED');
  assert.deepEqual((await owner.query(`select app.status, app.self_service_release_reason reason,
      app.self_service_released_by_account_id releaser, o.active organization_active,
      o.name = 'Released self sign-up ' || replace(o.id::text, '-', '') organization_renamed,
      (select count(*)::int from identity.organization_cac_registrations c where c.cac_registration_number=$2) bindings,
      (select string_agg(p.status, ',') from identity.organization_products p where p.organization_id=o.id) products,
      (select count(*)::int from auth.account_roles r where r.account_id=app.first_admin_account_id
        and r.revoked_at is null) live_roles
    from identity.organization_applications app join identity.organizations o on o.id=app.organization_id
    where app.id=$1`, [impostor.id, cacLapse])).rows,
  [{ status: 'rejected', reason: releaseReason, releaser: superAdmin.accountId, organization_active: false,
    organization_renamed: true, bindings: 0, products: 'suspended', live_roles: 0 }]);
  assert.deepEqual((await owner.query(`select actor_type, actor_account_id, facility_id, organization_id, reason
    from audit.events where action='admin.self-service-facility.release'`)).rows,
  [{ actor_type: 'platform', actor_account_id: superAdmin.accountId, facility_id: null, organization_id: null,
    reason: releaseReason }]);
  // The released email, or its network, cannot reopen the CAC and product for 7 days.
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacLapse, administratorEmail: emailOwner }),
    '198.51.100.33'), 409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW');
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacLapse, administratorEmail: email('owner-two') }),
    '198.51.100.31'), 409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW');
  // The real company signs up the same CAC and product, with its legal name.
  const emailReal = email('real-company');
  const lookupsBeforeReal = qoreidCacLookups.length;
  const realStarted = await start(enrollment({ cacRegistrationNumber: cacLapse, administratorEmail: emailReal,
    administratorName: 'Real Company Administrator', organizationType: 'hospital' }), '198.51.100.34');
  assert.equal(realStarted.status, 200, `the real company's start failed: ${JSON.stringify(realStarted.body)}`);
  assert.deepEqual(qoreidCacLookups.slice(lookupsBeforeReal), [cacLapse]);
  const realVerified = await verify({ challengeId: realStarted.body.challengeId,
    code: await codeFor(realStarted.body.challengeId) });
  assert.equal(realVerified.status, 200);
  const activatedReal = await activate(cookies(realVerified).find(value => value.startsWith('hid_provider_enrollment=')),
    password);
  assert.equal(activatedReal.status, 200, `the real company's activation failed: ${JSON.stringify(activatedReal.body)}`);
  assert.deepEqual((await owner.query(`select o.name, o.active, c.organization_id = o.id bound
      from identity.organizations o join identity.organization_cac_registrations c on c.cac_registration_number=$2
    where o.id=$1`, [activatedReal.body.organizationId, cacLapse])).rows,
  [{ name: `Runtime Clinic ${cacLapse} Ltd`, active: true, bound: true }]);
  review.release = { requiresSuspension: 409, identityReviewer: 403, staleVersion: 409, status: 200, again: 409,
    bindingRemoved: true, organizationRenamed: true, releasedEmailOrNetwork: 409, realCompanyActivated: 200 };

  // R3: support sees the open self-service applications and closes one that
  // holds a company's CAC; its email and network then cannot reopen it for 7
  // days, while the real company can. R16: those holding a CAC now come
  // first, with the total, and support finds one by CAC number. R15: support
  // waives a refusal, or rejects letting the applicant retry.
  const openPath = '/admin/self-service-applications';
  const cacSquat = 'RC9900063602'; const emailSquat = email('squat'); const SQUAT_NETWORK = '198.51.100.35';
  const squatStarted = await start(enrollment({ cacRegistrationNumber: cacSquat, administratorEmail: emailSquat }),
    SQUAT_NETWORK);
  assert.equal(squatStarted.status, 200, `squat start failed: ${JSON.stringify(squatStarted.body)}`);
  const squatApplication = (await owner.query(`select id, row_version, created_at from identity.organization_applications
    where cac_registration_number=$1`, [cacSquat])).rows[0];
  const openListed = await adminGet(identityReviewer, openPath);
  assert.equal(openListed.status, 200, `open list failed: ${JSON.stringify(openListed.body)}`);
  assert.deepEqual(Object.keys(openListed.body).sort(), ['items', 'total']);
  assert.equal(openListed.body.total, await count(`select count(*)::int n from identity.organization_applications
    where approval_mode='self_service' and status in ('pending_verification', 'ready_for_review')`));
  const rank = item => [item.holdsCac ? 0 : 1, item.status === 'ready_for_review' ? 0 : 1, -Date.parse(item.submittedAt)];
  const ranked = [...openListed.body.items].sort((left, right) => {
    const [a, b] = [rank(left), rank(right)];
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });
  assert.deepEqual(openListed.body.items.map(item => item.applicationId), ranked.map(item => item.applicationId),
    'The open list is not holding first, verified first, newest first');
  assert.deepEqual(openListed.body.items.find(item => item.applicationId === squatApplication.id), {
    applicationId: squatApplication.id, version: Number(squatApplication.row_version), productCode: 'ehr',
    organizationType: 'clinic', cacHint: 'RC********02', organizationName: `Runtime Clinic ${cacSquat} Ltd`,
    administratorName: 'Synthetic Provider Admin', administratorEmail: emailSquat, status: 'ready_for_review',
    verificationResult: 'verified', emailVerified: false, submittedAt: squatApplication.created_at.toISOString(),
    lapsesAt: new Date(squatApplication.created_at.getTime() + 24 * 3600 * 1000).toISOString(), holdsCac: true });
  const searched = await adminPost(identityReviewer, `${openPath}/search`,
    { cacRegistrationNumber: ` ${cacSquat.toLowerCase()} ` });
  assert.equal(searched.status, 200, `open search failed: ${JSON.stringify(searched.body)}`);
  assert.deepEqual([searched.body.total, searched.body.items.map(item => item.applicationId)], [1, [squatApplication.id]]);
  expectProblem(await adminPost(identityReviewer, `${openPath}/search`, { cacRegistrationNumber: 'RC12' }),
    400, 'VALIDATION_FAILED');
  assert(!openListed.body.items.some(item => item.applicationId === impostor.id), 'A released application is listed as open');
  const rejectPath = `${openPath}/${squatApplication.id}/reject`;
  const rejectReason = 'Holds a company CAC with an unrelated email';
  expectProblem(await adminPost(superAdmin, rejectPath, { reason: rejectReason }), 428, 'IF_MATCH_REQUIRED');
  expectProblem(await adminPost(identityReviewer, rejectPath, { reason: rejectReason },
    { 'If-Match': `"${squatApplication.row_version}"` }), 403, 'PERMISSION_DENIED');
  expectProblem(await adminPost(superAdmin, rejectPath, { reason: rejectReason },
    { 'If-Match': `"${Number(squatApplication.row_version) + 1}"` }), 409, 'VERSION_CONFLICT');
  const rejected = await adminPost(superAdmin, rejectPath, { reason: rejectReason },
    { 'If-Match': `"${squatApplication.row_version}"` });
  assert.equal(rejected.status, 200, `reject failed: ${JSON.stringify(rejected.body)}`);
  assert.deepEqual(Object.keys(rejected.body).sort(), ['applicationId', 'rejectedAt', 'version']);
  expectProblem(await adminPost(superAdmin, rejectPath, { reason: rejectReason },
    { 'If-Match': `"${rejected.body.version}"` }), 404, 'SELF_SERVICE_APPLICATION_NOT_FOUND');
  assert(!(await adminGet(superAdmin, openPath)).body.items.some(item => item.applicationId === squatApplication.id));
  assert.equal(await count(`select count(*)::int n from identity.organization_profile_completion_challenges
    where application_id=$1 and invalidated_at is null`, [squatApplication.id]), 0, 'The rejected application kept a code');
  assert.deepEqual((await owner.query(`select actor_type, actor_account_id, reason from audit.events
    where action='admin.self-service-application.reject' and resource_id=$1`, [squatApplication.id])).rows,
  [{ actor_type: 'platform', actor_account_id: superAdmin.accountId, reason: rejectReason }]);
  assert.deepEqual((await owner.query(`select self_service_refusal_ends_at = reviewed_at + interval '7 days' refusal
    from identity.organization_applications where id=$1`, [squatApplication.id])).rows, [{ refusal: true }],
  'The rejection did not refuse its email and network for 7 days');
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacSquat, administratorEmail: emailSquat }),
    '198.51.100.36'), 409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW');
  const emailSquatTwo = email('squat-two');
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacSquat, administratorEmail: emailSquatTwo }),
    SQUAT_NETWORK), 409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW');
  // Say the rejected sign-up was an employee's, from the company's office:
  // support waives the refusal for the CAC number and product, and the
  // office signs up at once (without a hold, as its network just had one).
  const waivePath = `${openPath}/waive-refusal`;
  const waiveBody = { cacRegistrationNumber: cacSquat.toLowerCase(), productCode: 'ehr',
    reason: 'The company confirmed its office network' };
  expectProblem(await adminPost(identityReviewer, waivePath, waiveBody), 403, 'PERMISSION_DENIED');
  expectProblem(await adminPost(superAdmin, waivePath, { ...waiveBody, productCode: 'dental' }), 400, 'VALIDATION_FAILED');
  const waived = await adminPost(superAdmin, waivePath, waiveBody);
  assert.equal(waived.status, 200, `waiver failed: ${JSON.stringify(waived.body)}`);
  assert.deepEqual(waived.body.waived.map(item => [item.applicationId, item.version]),
    [[squatApplication.id, rejected.body.version + 1]]);
  expectProblem(await adminPost(superAdmin, waivePath, waiveBody), 404, 'SELF_SERVICE_REFUSAL_NOT_FOUND');
  assert.deepEqual((await owner.query(`select actor_type, actor_account_id, reason from audit.events
    where action='admin.self-service-application.refusal-waive' and resource_id=$1`, [squatApplication.id])).rows,
  [{ actor_type: 'platform', actor_account_id: superAdmin.accountId, reason: 'The company confirmed its office network' }]);
  const officeAfterWaiver = await start(enrollment({ cacRegistrationNumber: cacSquat, administratorEmail: emailSquatTwo }),
    SQUAT_NETWORK);
  assert.equal(officeAfterWaiver.status, 200, `start after the waiver failed: ${JSON.stringify(officeAfterWaiver.body)}`);
  assert.deepEqual((await owner.query(`select self_service_without_hold from identity.organization_applications
    where cac_registration_number=$1 and administrator_email=$2`, [cacSquat, emailSquatTwo])).rows,
  [{ self_service_without_hold: true }]);
  const squatFreed = await start(enrollment({ cacRegistrationNumber: cacSquat, administratorEmail: email('squat-real') }),
    '198.51.100.37');
  assert.equal(squatFreed.status, 200, `the real company could not start: ${JSON.stringify(squatFreed.body)}`);
  // A rejection that lets the applicant retry (a mistyped email) refuses no
  // one: the same network starts again at once with the right email.
  const cacRetry = 'RC9900063603'; const RETRY_NETWORK = '198.51.100.71';
  const typoStarted = await start(enrollment({ cacRegistrationNumber: cacRetry, administratorEmail: email('typo') }),
    RETRY_NETWORK);
  assert.equal(typoStarted.status, 200);
  const typoApplication = (await owner.query(`select id, row_version from identity.organization_applications
    where cac_registration_number=$1`, [cacRetry])).rows[0];
  expectProblem(await adminPost(superAdmin, `${openPath}/${typoApplication.id}/reject`,
    { reason: 'The applicant mistyped the email', allowRetry: 'yes' },
    { 'If-Match': `"${typoApplication.row_version}"` }), 400, 'VALIDATION_FAILED');
  const retried = await adminPost(superAdmin, `${openPath}/${typoApplication.id}/reject`,
    { reason: 'The applicant mistyped the email', allowRetry: true }, { 'If-Match': `"${typoApplication.row_version}"` });
  assert.equal(retried.status, 200, `retry rejection failed: ${JSON.stringify(retried.body)}`);
  assert.deepEqual((await owner.query(`select self_service_refusal_ends_at from identity.organization_applications
    where id=$1`, [typoApplication.id])).rows, [{ self_service_refusal_ends_at: null }]);
  const corrected = await start(enrollment({ cacRegistrationNumber: cacRetry, administratorEmail: email('corrected') }),
    RETRY_NETWORK);
  assert.equal(corrected.status, 200, `the corrected start failed: ${JSON.stringify(corrected.body)}`);
  review.open_applications = { list: 'holding first, verified first, newest first', total: openListed.body.total,
    search: 200, identityReviewer: 'list only', reject: 200, missingIfMatch: 428, staleVersion: 409, again: 404,
    rejectedEmailOrNetwork: 409, waiver: 200, waivedAgain: 404, afterWaiver: 200, realCompany: 200,
    retryRejection: 200, correctedFromSameNetwork: 200 };

  // The database's own gate, driven through Identity (R11). A request passes
  // Identity's gate, then waits behind a lock the verifier holds; the control
  // is closed meanwhile with the admin command; once released, the
  // database's own platform.require_control_enabled refuses it: 423, nothing
  // written. For start, the wait is on the public application quota (its
  // charge commits first, then the submit refuses); for activation, on the
  // session's row, which the pre-check locks before it reads the control.
  const controlVersion = async () => (await adminGet(superAdmin, '/admin/controls')).body
    .find(control => control.controlKey === 'provider_self_service_enabled').version;
  const setSelfService = async (enabled, reason) => {
    const changed = await adminPost(superAdmin, '/admin/controls',
      { controlKey: 'provider_self_service_enabled', enabled, reason }, { 'If-Match': `"${await controlVersion()}"` });
    assert.equal(changed.status, 201, `control change failed: ${JSON.stringify(changed.body)}`);
  };
  const parked = async (lockSql, lockValues, send) => {
    const holder = await owner.connect();
    let pending;
    try {
      await holder.query('begin');
      const holderPid = (await holder.query('select pg_backend_pid() pid')).rows[0].pid;
      await holder.query(lockSql, lockValues);
      pending = send().then(response => response);
      const deadline = Date.now() + 10_000;
      while ((await owner.query('select count(*)::int n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
        [holderPid])).rows[0].n === 0) {
        assert(Date.now() < deadline, 'The request did not wait behind the lock');
        await new Promise(resolveWait => setTimeout(resolveWait, 25));
      }
      await setSelfService(false, 'Runtime verifier closes sign-up while a request waits');
      await holder.query('commit');
    } catch (error) {
      await holder.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }
    return pending;
  };
  const cacGate = 'RC9900063211';
  const lookupsBeforeGate = qoreidCacLookups.length;
  const gateStart = await parked('lock table platform.public_application_quota_counters in share mode', [],
    () => start(enrollment({ cacRegistrationNumber: cacGate, administratorEmail: email('gate') }), '198.51.100.38'));
  expectProblem(gateStart, 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
  assert.equal(await count('select count(*)::int n from identity.organization_applications where cac_registration_number=$1',
    [cacGate]), 0, 'The database gate let a submit through');
  assert.equal(qoreidCacLookups.length, lookupsBeforeGate);
  assert.deepEqual(await applicationCharges('198.51.100.38'), { hour: 1, day: 1 }, 'The charge before the submit did not commit');
  await setSelfService(true, 'Runtime verifier reopens sign-up');
  gate.database_gate_start = 423;
  // A verified session, then its activation parked on the session's row.
  const cacBudget = 'RC9900063212';
  const budgetStarted = await start(enrollment({ cacRegistrationNumber: cacBudget, administratorEmail: email('budget') }),
    '198.51.100.39');
  assert.equal(budgetStarted.status, 200);
  const budgetVerified = await verify({ challengeId: budgetStarted.body.challengeId,
    code: await codeFor(budgetStarted.body.challengeId) });
  assert.equal(budgetVerified.status, 200);
  const budgetCookie = cookies(budgetVerified).find(value => value.startsWith('hid_provider_enrollment='));
  const accountsBeforeGate = await count('select count(*)::int n from auth.accounts');
  const gateActivation = await parked(
    'select id from identity.organization_profile_completion_challenges where id=$1 for update',
    [budgetStarted.body.challengeId], () => activate(budgetCookie, password));
  expectProblem(gateActivation, 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
  assert.deepEqual(await sessionState(budgetStarted.body.challengeId), { activation_attempts: 0, ended: false });
  assert.equal(await count('select count(*)::int n from auth.accounts'), accountsBeforeGate);
  await setSelfService(true, 'Runtime verifier reopens sign-up');
  gate.database_gate_activate = 423;
  // R1: a session whose 5 attempts are spent is ended without a hash: 401.
  await owner.query('update identity.organization_profile_completion_challenges set activation_attempts=5 where id=$1',
    [budgetStarted.body.challengeId]);
  expectProblem(await activate(budgetCookie, password), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  assert.deepEqual(await sessionState(budgetStarted.body.challengeId), { activation_attempts: 5, ended: true });
  assert.equal(await count('select count(*)::int n from auth.accounts'), accountsBeforeGate);
  session.activation_budget = { attempts: 5, sixth: 401, sessionEnded: true };

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
  // The request's own identifiers (instance, correlationId) are random UUIDs, which contain "200" about once in 200
  // runs; they say nothing of the limit, so the rest of the problem is what is searched.
  const cappedProblem = Object.fromEntries(Object.entries(capped.body)
    .filter(([key]) => key !== 'instance' && key !== 'correlationId'));
  assert.ok(Object.keys(cappedProblem).length >= 3, 'The cap refusal has no problem fields left to check');
  assert.doesNotMatch(JSON.stringify(cappedProblem), /platform|day|cap|200/i, 'The cap refusal exposed its limit');
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
  // is listed for support until a standalone platform administrator (no
  // facility membership) marks it reviewed at its version; the unreviewed
  // list is oldest activation first (R12), the reviewed and all lists newest
  // first, and a released sign-up is listed as handled.
  const facilities = facilitiesPath;
  const listed = await adminGet(superAdmin, facilities);
  assert.equal(listed.status, 200, `support list failed: ${JSON.stringify(listed.body)}`);
  assert.deepEqual(listed.body.items.map(item => item.facilityId),
    [facilityId, activatedB.body.facilityId, activatedReal.body.facilityId], 'Oldest unreviewed activation first');
  const itemA = listed.body.items[0];
  const applicationA = (await owner.query(`select id, row_version, reviewed_at from identity.organization_applications
    where organization_id=$1`, [organizationId])).rows[0];
  assert.deepEqual(itemA, { applicationId: applicationA.id, version: Number(applicationA.row_version),
    organizationId, organizationName: `Runtime Clinic ${cacA} Ltd`, facilityId,
    facilityName: `Runtime Clinic ${cacA} Ltd`, facilityLifecycleStatus: 'verified', productCode: 'ehr',
    organizationType: 'clinic', cacHint: 'RC********01', administratorName: 'Synthetic Provider Admin',
    administratorEmail: emailA, administratorAccountId: accountId, administratorAccountStatus: 'active',
    activatedAt: applicationA.reviewed_at.toISOString(), reviewedAt: null, reviewedByAccountId: null, reviewNote: null,
    releasedAt: null, releasedByAccountId: null, releaseReason: null,
    // P4b (SPEC §3.5): the role support preselects for a clinic, the roles it
    // may grant, the review's choices (none yet), the administrator's own
    // licence (none entered), and the facility since review.
    reviewGrantsRole: 'doctor', reviewableRoles: ['doctor', 'nurse'], grantedRole: null, verificationMethod: null,
    administratorLicenceBody: null, administratorLicenceNumber: null, administratorLicenceRecordedAt: null,
    memberCount: 1, pendingInvitationCount: 0, probationEndsAt: null, breakGlassLast7d: 0, deliveryFailuresLastDay: 0 });
  assert.deepEqual((await adminGet(superAdmin, `${facilities}?state=unreviewed`)).body, listed.body);
  const handled = (await adminGet(superAdmin, `${facilities}?state=reviewed`)).body.items;
  assert.deepEqual(handled.map(item => [item.facilityId, item.releasedAt, item.releaseReason, item.facilityLifecycleStatus,
    item.administratorAccountStatus]), [[activatedLapse.body.facilityId, released.body.releasedAt, releaseReason,
    'suspended', 'disabled']]);
  expectProblem(await adminGet(superAdmin, `${facilities}?state=pending`), 400, 'VALIDATION_FAILED');
  const note = 'Checked: the email domain matches the company website';
  // P4b: the review confirms the administrator's own access; here support
  // gives none ("no clinical access": org_admin only) and says how it checked.
  const reviewNone = { note, grantedRole: 'none', verificationMethod: 'cac_registered_contact' };
  const reviewPath = `${facilities}/${applicationA.id}/review`;
  expectProblem(await adminPost(superAdmin, reviewPath, reviewNone), 428, 'IF_MATCH_REQUIRED');
  expectProblem(await adminPost(superAdmin, reviewPath, { ...reviewNone, note: ' short ' }, { 'If-Match': `"${itemA.version}"` }),
    400, 'VALIDATION_FAILED');
  expectProblem(await adminPost(superAdmin, reviewPath, { note }, { 'If-Match': `"${itemA.version}"` }),
    400, 'VALIDATION_FAILED');
  expectProblem(await adminPost(superAdmin, reviewPath, reviewNone, { 'If-Match': `"${itemA.version + 1}"` }),
    409, 'VERSION_CONFLICT');
  expectProblem(await adminPost(superAdmin, `${facilities}/${reviewed.id}/review`, reviewNone,
    { 'If-Match': String(reviewed.row_version) }), 404, 'SELF_SERVICE_FACILITY_NOT_FOUND');
  const marked = await adminPost(superAdmin, reviewPath, { ...reviewNone, note: `  ${note}  ` }, { 'If-Match': `"${itemA.version}"` });
  assert.equal(marked.status, 200, `review failed: ${JSON.stringify(marked.body)}`);
  assert.deepEqual(Object.keys(marked.body).sort(), ['applicationId', 'grantedRole', 'reviewedAt', 'sessionsRevoked', 'version']);
  assert.equal(marked.body.applicationId, applicationA.id);
  assert.equal(marked.body.version, itemA.version + 1);
  assert.equal(marked.body.grantedRole, 'none');
  assert(marked.body.sessionsRevoked >= 1, 'The review did not sign the administrator out');
  assert(!Number.isNaN(Date.parse(marked.body.reviewedAt)));
  // No clinical access: org_admin alone, granted by support; the restricted role revoked by support.
  assert.deepEqual((await owner.query(`select role_code, granted_by, revoked_by, revoked_at is not null revoked
      from auth.account_roles where account_id=$1 and scope_type='facility' order by role_code`, [accountId])).rows,
  [{ role_code: 'org_admin', granted_by: superAdmin.accountId, revoked_by: null, revoked: false },
    { role_code: 'org_admin_awaiting_review', granted_by: null, revoked_by: superAdmin.accountId, revoked: true }]);
  assert.equal(await count('select count(*)::int n from identity.staff_licence_attestations where account_id=$1', [accountId]), 0);
  expectProblem(await adminPost(superAdmin, reviewPath, reviewNone, { 'If-Match': `"${marked.body.version}"` }),
    409, 'SELF_SERVICE_FACILITY_ALREADY_REVIEWED');
  const unreviewedAfter = (await adminGet(superAdmin, facilities)).body.items.map(item => item.facilityId);
  assert.deepEqual(unreviewedAfter, [activatedB.body.facilityId, activatedReal.body.facilityId]);
  const reviewedAfter = (await adminGet(superAdmin, `${facilities}?state=reviewed`)).body.items;
  assert.deepEqual(reviewedAfter.map(item => item.facilityId), [activatedLapse.body.facilityId, facilityId],
    'The reviewed list is not newest activation first');
  assert.deepEqual(reviewedAfter.filter(item => item.facilityId === facilityId).map(item => [item.reviewNote,
    item.reviewedByAccountId, item.version, item.reviewedAt]),
  [[note, superAdmin.accountId, marked.body.version, marked.body.reviewedAt]]);
  assert.equal((await adminGet(superAdmin, `${facilities}?state=all`)).body.items.length, 4);
  const reviewAudit = (await owner.query(`select actor_type, actor_account_id, facility_id, organization_id,
      outcome, reason, details from audit.events where action='admin.self-service-facility.review'`)).rows;
  const membershipA = (await owner.query('select id from identity.staff_facility_memberships where account_id=$1',
    [accountId])).rows[0].id;
  assert.deepEqual(reviewAudit, [{ actor_type: 'platform', actor_account_id: superAdmin.accountId, facility_id: null,
    organization_id: null, outcome: 'success', reason: note, details: { productCode: 'ehr', organizationId, facilityId,
      administratorAccountId: accountId, version: marked.body.version, grantedRole: 'none',
      verificationMethod: 'cac_registered_contact', licenceBody: null, membershipId: membershipA,
      sessionsRevoked: marked.body.sessionsRevoked } }]);
  assert.deepEqual((await owner.query(`select actor_type, organization_id, facility_id, details from audit.events
    where action='identity.facility-access.unlock'`)).rows, [{ actor_type: 'system', organization_id: organizationId,
    facility_id: facilityId, details: { applicationId: applicationA.id, grantedRoles: ['org_admin'] } }]);
  assert(await count(`select count(*)::int n from audit.events where action='api.admin.self-service-facility.review'
    and outcome='failure' and actor_account_id=$1`, [superAdmin.accountId]) >= 3, 'Refused reviews were not audited');
  // The permission split of the governed list and reject: an identity reviewer
  // can list but not review; a facility user without platform authority can do neither.
  assert.equal((await adminGet(identityReviewer, facilities)).status, 200);
  const applicationB = (await owner.query('select id, row_version from identity.organization_applications where organization_id=$1',
    [activatedB.body.organizationId])).rows[0];
  expectProblem(await adminPost(identityReviewer, `${facilities}/${applicationB.id}/review`,
    reviewNone, { 'If-Match': `"${applicationB.row_version}"` }), 403, 'PERMISSION_DENIED');
  expectProblem(await adminGet({ cookie: header(cookies(activatedB)) }, facilities), 403, 'PERMISSION_DENIED');
  review.list = { unreviewed: 3, unreviewedOldestFirst: true, reviewedNewestFirst: true, cacHint: itemA.cacHint };
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
    where application_id in (select id from identity.organization_applications where cac_registration_number=$1)`, [cacTaken]);
  const heldResume = await start(enrollment({ cacRegistrationNumber: cacTaken, administratorEmail: emailTakenWork }),
    TAKEN_NETWORK);
  assert.equal(heldResume.status, 200, `held resume failed: ${JSON.stringify(heldResume.body)}`);
  const heldVerified = await verify({ challengeId: heldResume.body.challengeId,
    code: await codeFor(heldResume.body.challengeId) });
  assert.equal(heldVerified.status, 200);
  const closedReason = 'Close facility self sign-up after the runtime verifier';
  const closed = await adminPost(superAdmin, '/admin/controls',
    { controlKey: 'provider_self_service_enabled', enabled: false, reason: closedReason },
    { 'If-Match': `"${await controlVersion()}"` });
  assert.equal(closed.status, 201, `closing the control failed: ${JSON.stringify(closed.body)}`);
  assert.deepEqual(await availability(), { open: false, reason: 'closed' });
  expectProblem(await profile(cookies(heldVerified).find(value => value.startsWith('hid_provider_enrollment='))),
    423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
  expectProblem(await activate(cookies(heldVerified).find(value => value.startsWith('hid_provider_enrollment=')), password),
    423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
  expectProblem(await start(enrollment({ cacRegistrationNumber: cacTaken, administratorEmail: emailA }), TAKEN_NETWORK),
    423, 'PROVIDER_ENROLLMENT_UNAVAILABLE');
  gate.closed_again = { availability: false, heldSessionProfile: 423, heldSessionActivate: 423, start: 423 };

  assert.equal(await count(`select count(*)::int n from audit.events where action='identity.organization.self-service.activate'`), 4);

  // ─── P4b (p4b SPEC §10): full access after support's review, and facility staff invitations ───
  // Every step runs as the Identity API runtime over HTTP; owner SQL only seeds
  // what a step needs (patients, earlier grants or sends, clock moves) and reads
  // the result. Each answer is recorded in `p4b` and printed with the evidence.
  const p4b = { withdrawal: {}, pending: {}, trigger: {}, review: {}, roles: {}, probation: {}, invitations: {},
    open: {}, accept: {}, existingStaff: {}, patientEmail: {}, dormant: {}, roleChange: {}, expiry: {}, limits: {},
    governed: {}, release: {}, adminReads: {}, audit: {}, timing: {} };
  const p4bAuditStart = Number((await owner.query('select coalesce(max(sequence_id), 0)::bigint as n from audit.events'))
    .rows[0].n);
  const invitationPassword = 'Synthetic-Invitee-Password-2026';
  const sensitive = new Set();
  const permissionsOf = async (...roles) => (await owner.query(`select coalesce(array_agg(distinct grant_row.permission_code
      order by grant_row.permission_code), array[]::text[]) as codes
    from auth.role_permissions grant_row
    join auth.permissions permission on permission.code = grant_row.permission_code and permission.active
    where grant_row.role_code = any($1::text[])`, [roles])).rows[0].codes;
  const applicationVersion = async id => Number((await owner.query(
    'select row_version from identity.organization_applications where id=$1', [id])).rows[0].row_version);
  const activeFacilityRoles = async (account, facility) => (await owner.query(`select coalesce(array_agg(role_code
      order by role_code), array[]::text[]) as roles from auth.account_roles
    where account_id=$1 and facility_id=$2 and scope_type='facility' and revoked_at is null`, [account, facility])).rows[0].roles;
  const membershipOf = async (account, facility) => (await owner.query(`select id, row_version, active, membership_role,
      app_role, is_primary from identity.staff_facility_memberships where account_id=$1 and facility_id=$2`,
  [account, facility])).rows[0];
  // A step that must be refused by the database: run inside a transaction that
  // is always rolled back, answering the refusal's SQLSTATE and message.
  const refused = async (statements) => {
    const client = await owner.connect();
    try {
      await client.query('begin');
      await statements(client);
      return { code: 'none', message: 'the statement succeeded' };
    } catch (error) {
      return { code: error.code, message: error.message };
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  };
  const roleRow = `insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id,
      grant_reason) select gen_random_uuid(), membership.account_id, $3, 'facility', membership.id, membership.facility_id,
      'Runtime verifier probes the review gate' from identity.staff_facility_memberships membership
     where membership.account_id=$1 and membership.facility_id=$2`;
  // The review gate (G2) against every writer: the runtime role directly (it
  // holds no table privilege), the database owner directly, and a definer
  // function called as the runtime role (any future definer writer).
  const reviewGate = async (account, facility, role) => ({
    runtimeDirect: await refused(async client => {
      await client.query('set local role hid_identity_api_runtime');
      await client.query(roleRow, [account, facility, role]);
    }),
    ownerDirect: await refused(client => client.query(roleRow, [account, facility, role])),
    runtimeThroughDefiner: await refused(async client => {
      await client.query(`create function pg_temp.p4b_role_writer(target_account uuid, target_facility uuid, target_role text)
        returns void language plpgsql security definer set search_path = pg_catalog, auth, identity, pg_temp as $writer$
        begin
          insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
          select gen_random_uuid(), membership.account_id, target_role, 'facility', membership.id, membership.facility_id,
            'Runtime verifier: a definer writer probes the review gate'
            from identity.staff_facility_memberships membership
           where membership.account_id = target_account and membership.facility_id = target_facility;
        end $writer$`);
      await client.query('grant execute on function pg_temp.p4b_role_writer(uuid,uuid,text) to hid_identity_api_runtime');
      await client.query('set local role hid_identity_api_runtime');
      await client.query('select pg_temp.p4b_role_writer($1,$2,$3)', [account, facility, role]);
    }),
  });

  // Hosts: staff sign in on their role's product host (ehr.*, lab.*,
  // pharmacy.*); accountless invitation pages run on the portal (app.*).
  const SIGN_IN = { ehr: [ehrOrigin, 'staff-login'], lab: [labOrigin, 'lab-login'],
    pharmacy: [pharmacyOrigin, 'pharmacy-login'] };
  let signIns = 0;
  const signIn = (address, secret, host = 'ehr') => {
    const [hostOrigin, action] = SIGN_IN[host];
    signIns += 1;
    return http.post('/api/v1/auth/login').set('Origin', hostOrigin)
      .set('X-Forwarded-For', `198.51.120.${(signIns % 250) + 1}`)
      .send({ email: address, password: secret, turnstileAction: action,
        turnstileToken: turnstile(action, new URL(hostOrigin).hostname) });
  };
  const signedIn = async (address, secret, host = 'ehr', facility) => {
    const response = await signIn(address, secret, host);
    assert.equal(response.status, 200, `sign-in of ${address} on ${host}: ${JSON.stringify(response.body)}`);
    return { email: address, password: secret, accountId: response.body.actor.accountId, origin: SIGN_IN[host][0],
      facilityId: facility, actor: response.body.actor, csrf: response.headers['x-csrf-token'],
      cookie: header(cookies(response).filter(value => value.startsWith(cookieName))) };
  };
  const staffCall = (who, method, path, body, options = {}) => {
    const facility = options.facility === undefined ? who.facilityId : options.facility;
    let call = http[method](`/api/v1${path}`).set('Cookie', who.cookie);
    if (facility) call = call.set('X-Facility-ID', facility);
    if (method !== 'get') call = call.set('Origin', options.origin ?? who.origin).set('x-csrf-token', who.csrf);
    for (const [name, value] of Object.entries(options.headers ?? {})) call = call.set(name, value);
    return method === 'get' ? call : call.send(body ?? {});
  };
  const sessionRead = who => http.get('/api/v1/auth/session').set('Cookie', who.cookie);
  const facilityPermissions = async (who, facility) => {
    const selectedFacility = await http.post('/api/v1/auth/facility').set('Cookie', who.cookie).set('Origin', who.origin)
      .set('x-csrf-token', who.csrf).send({ facilityId: facility });
    assert.equal(selectedFacility.status, 200, `facility selection: ${JSON.stringify(selectedFacility.body)}`);
    assert.equal(selectedFacility.body.actor.facility.id, facility);
    return { permissions: [...selectedFacility.body.actor.permissions].sort(),
      selfService: selectedFacility.body.actor.facility.selfService,
      facilities: selectedFacility.body.actor.facilities.map(item => ({ id: item.id, isPrimary: item.isPrimary,
        selfService: item.selfService })) };
  };

  // Self sign-up of a new facility of a given type and product (P4's flow).
  let signUps = 0;
  const signUp = async ({ cac, organizationType, productCode, administratorName }) => {
    signUps += 1;
    const address = email(`p4b-admin-${signUps}`);
    const started = await start(enrollment({ cacRegistrationNumber: cac, administratorEmail: address, organizationType,
      productCode, ...(administratorName ? { administratorName } : {}) }), `198.51.121.${signUps}`);
    assert.equal(started.status, 200, `P4b sign-up start ${cac}: ${JSON.stringify(started.body)}`);
    const verifiedSignUp = await verify({ challengeId: started.body.challengeId, code: await codeFor(started.body.challengeId) });
    assert.equal(verifiedSignUp.status, 200, `P4b sign-up verify ${cac}`);
    const activatedSignUp = await activate(cookies(verifiedSignUp).find(value => value.startsWith('hid_provider_enrollment=')),
      password);
    assert.equal(activatedSignUp.status, 200, `P4b sign-up activation ${cac}: ${JSON.stringify(activatedSignUp.body)}`);
    const applicationRow = (await owner.query('select id from identity.organization_applications where organization_id=$1',
      [activatedSignUp.body.organizationId])).rows[0];
    return { email: address, password, organizationType, productCode, cac, origin,
      organizationId: activatedSignUp.body.organizationId, facilityId: activatedSignUp.body.facilityId,
      accountId: activatedSignUp.body.accountId, applicationId: applicationRow.id,
      facilityName: `Runtime Clinic ${cac} Ltd`, csrf: activatedSignUp.headers['x-csrf-token'],
      cookie: header(cookies(activatedSignUp).filter(value => value.startsWith(cookieName))) };
  };
  const reviewBody = (grantedRole, licence, verificationMethod = 'regulator_register') => ({
    note: 'Checked the administrator against the company record and the register', grantedRole, verificationMethod,
    ...(licence ? { administratorLicence: licence } : {}) });
  const reviewFacility = async (who, target, body) => adminPost(who, `${facilitiesPath}/${target.applicationId}/review`,
    body, { 'If-Match': `"${await applicationVersion(target.applicationId)}"` });
  const listedFacility = async (target, state = 'all') => (await adminGet(superAdmin, `${facilitiesPath}?state=${state}`))
    .body.items.find(item => item.applicationId === target.applicationId);

  // Synthetic patients for emergency access and consent grants.
  let patientCount = 0;
  const syntheticPatient = async () => {
    patientCount += 1;
    const patientId = randomUUID();
    const hid = `HID-P4BV${String(patientCount).padStart(4, '0').replace(/[0-9]/g, digit => 'ABCDEFGHJK'[digit])}`;
    await owner.query(`insert into identity.patients (id, hid_code, first_name, last_name, full_name, status)
      values ($1, $2, 'Verifier', 'Patient', 'Verifier Patient', 'active')`, [patientId, hid]);
    return { id: patientId, hid };
  };
  const seedGrant = async (membershipId, patient, breakGlass) => (await owner.query(`insert into identity.consent_grants
      (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status, reason, starts_at, expires_at,
       break_glass, purpose_of_use)
    select gen_random_uuid(), $2, membership.staff_id, membership.account_id, membership.id, membership.facility_id,
      case when $3 then 'break_glass' else 'read_records' end, 'active', 'Seeded by the runtime verifier',
      clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', $3,
      case when $3 then 'emergency' else 'direct-care' end
      from identity.staff_facility_memberships membership where membership.id = $1 returning id`,
  [membershipId, patient.id, breakGlass])).rows[0].id;
  const breakGlass = (who, patient) => staffCall(who, 'post', '/identity/break-glass',
    { hid: patient.hid, reason: 'Runtime verifier emergency access', durationMinutes: 30 },
    { headers: { 'X-Purpose-Of-Use': 'emergency' } });

  // Invitations: the administrator's request (password re-entry, one
  // Idempotency-Key per form) and what the local notification route received.
  const invite = (who, body, key = `verifier-invite-${randomUUID()}`, secret = who.password) =>
    staffCall(who, 'post', '/identity/staff-invitations', { attested: true, currentPassword: secret, ...body },
      { headers: { 'Idempotency-Key': key } });
  const invited = async (who, body) => {
    const before = invitationEmails.length;
    const response = await invite(who, body);
    assert.equal(response.status, 201, `invite ${body.email}: ${JSON.stringify(response.body)}`);
    const sent = invitationEmails.slice(before);
    assert.equal(sent.length, response.body.deliveryOutcome === 'unknown' ? 0 : 1, 'One invitation, one email');
    if (sent[0]) { sensitive.add(sent[0].body.token); sensitive.add(sent[0].body.code); }
    sensitive.add(body.email); sensitive.add(body.name);
    if (body.licenceNumber) sensitive.add(body.licenceNumber.toUpperCase());
    return { ...response.body, sent: sent[0] };
  };
  let opens = 0;
  const openNetwork = () => { opens += 1; return `198.51.${130 + Math.floor(opens / 250)}.${(opens % 250) + 1}`; };
  const openInvitation = (body, options = {}) => {
    const hostOrigin = options.origin === undefined ? origin : options.origin;
    let call = http.post('/api/v1/identity/staff-invitations/open').set('X-Forwarded-For', options.network ?? openNetwork());
    if (hostOrigin) call = call.set('Origin', hostOrigin);
    if (options.cookie) call = call.set('Cookie', options.cookie);
    return call.send({ turnstileAction: 'staff-invitation',
      turnstileToken: turnstile('staff-invitation', options.turnstileHost ?? new URL(hostOrigin ?? origin).hostname), ...body });
  };
  const byLink = sent => ({ invitationId: sent.body.invitationId, token: sent.body.token });
  const byCode = sent => ({ email: sent.body.recipient, code: sent.body.code });
  const invitationCookie = response => cookies(response).find(value => value.startsWith('hid_staff_invitation='));
  const acceptInvitation = (cookie, secret) => {
    let call = http.post('/api/v1/identity/staff-invitations/accept').set('Origin', origin);
    if (cookie) call = call.set('Cookie', cookie);
    return call.send({ password: secret });
  };
  const openedAs = async (body, expectedCase, options = {}) => {
    const response = await openInvitation(body, options);
    assert.equal(response.status, 200, `open: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.accountCase, expectedCase, `open: ${JSON.stringify(response.body)}`);
    return response;
  };
  const randomToken = () => randomUUID().replaceAll('-', '').padEnd(43, 'A').slice(0, 43);
  const wrongTypedCode = sent => (sent.body.code === '000000' ? '111111' : '000000');
  const invitationRow = async id => (await owner.query(`select status, row_version, failed_link_attempts,
      failed_typed_attempts, send_count, delivery_outcome, session_hmac is not null as has_session, accept_attempts,
      revoke_kind, accepted_account_case, accepted_membership_id, last_send_id, key_version
    from identity.staff_invitations where id=$1`, [id])).rows[0];
  const ageInvitation = id => owner.query(`update identity.staff_invitations
    set last_sent_at = last_sent_at - interval '2 minutes' where id=$1`, [id]);
  const newAccountOf = async address => (await owner.query(`select id from auth.accounts where lower(email)=lower($1)`,
    [address])).rows[0]?.id;

  // ── R18: the applicant's withdrawal ("This isn't my organization") ──
  // P4's run ended with sign-up closed: the withdrawal answers 423 after its
  // request checks, as every public route does.
  const WITHDRAW = `${ENROLL}/withdraw`;
  const withdraw = (cookie, extra = {}) => {
    let call = http.post(WITHDRAW).set('Origin', origin);
    if (cookie) call = call.set('Cookie', cookie);
    for (const [name, value] of Object.entries(extra)) call = call.set(name, value);
    return call.send();
  };
  expectProblem(await http.post(WITHDRAW).send(), 403, 'ORIGIN_DENIED');
  expectProblem(await withdraw(undefined, { Cookie: `${cookieName}_csrf=x` }), 409, 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT');
  expectProblem(await withdraw('hid_provider_enrollment=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 423,
    'PROVIDER_ENROLLMENT_UNAVAILABLE');
  // Sign-up opens again for P4b's facilities; the platform day spent by P4's
  // cap check is reset (owner SQL), as the next day would.
  await owner.query('delete from platform.self_service_cac_platform_quota_counters');
  await setSelfService(true, 'Runtime verifier reopens sign-up for P4b');
  expectProblem(await withdraw(), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  expectProblem(await withdraw(`hid_provider_enrollment=${'A'.repeat(43)}`), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  const cacWithdrawn = 'RC9900064901'; const emailWithdrawn = email('withdrawn'); const WITHDRAW_NETWORK = '198.51.122.1';
  const startedWithdrawn = await start(enrollment({ cacRegistrationNumber: cacWithdrawn, administratorEmail: emailWithdrawn }),
    WITHDRAW_NETWORK);
  assert.equal(startedWithdrawn.status, 200);
  const verifiedWithdrawn = await verify({ challengeId: startedWithdrawn.body.challengeId,
    code: await codeFor(startedWithdrawn.body.challengeId) });
  const withdrawCookie = cookies(verifiedWithdrawn).find(value => value.startsWith('hid_provider_enrollment='));
  const withdrawnApplication = await application(cacWithdrawn);
  const withdrawnVersion = (await owner.query('select row_version from identity.organization_applications where id=$1',
    [withdrawnApplication.id])).rows[0].row_version;
  const withdrawn = await withdraw(withdrawCookie);
  assert.equal(withdrawn.status, 200, `withdraw: ${JSON.stringify(withdrawn.body)}`);
  assert.deepEqual(withdrawn.body, { withdrawn: true });
  assert.match(setCookies(withdrawn).find(value => value.startsWith('hid_provider_enrollment=')) ?? '',
    /^hid_provider_enrollment=;.*Expires=Thu, 01 Jan 1970/i, 'The withdrawal did not clear the enrollment cookie');
  assert.deepEqual((await owner.query(`select status, reviewed_by_account_id, review_reason, reviewed_at is not null reviewed,
      self_service_refusal_ends_at, row_version from identity.organization_applications where id=$1`,
  [withdrawnApplication.id])).rows, [{ status: 'rejected', reviewed_by_account_id: null,
    review_reason: 'Self-service application withdrawn by its applicant', reviewed: true,
    self_service_refusal_ends_at: null, row_version: String(Number(withdrawnVersion) + 1) }]);
  assert.equal(await count(`select count(*)::int n from identity.organization_profile_completion_challenges
    where application_id=$1 and invalidated_at is null`, [withdrawnApplication.id]), 0, 'The withdrawal left a code or session');
  assert.deepEqual((await owner.query(`select actor_type, details from audit.events
    where action='identity.organization.self-service.withdraw' and resource_id=$1`, [withdrawnApplication.id])).rows,
  [{ actor_type: 'system', details: { productCode: 'ehr', previousStatus: 'ready_for_review' } }]);
  expectProblem(await withdraw(withdrawCookie), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  expectProblem(await profile(withdrawCookie), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  expectProblem(await activate(withdrawCookie, password), 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID');
  // No 7-day refusal: the same email and network start again at once (the
  // new application opens without a hold, as after any closure, R15).
  await owner.query(`update identity.organization_profile_completion_challenges set created_at = created_at - interval '2 minutes'
    where application_id=$1`, [withdrawnApplication.id]);
  const restartedWithdrawn = await start(enrollment({ cacRegistrationNumber: cacWithdrawn, administratorEmail: emailWithdrawn }),
    WITHDRAW_NETWORK);
  assert.equal(restartedWithdrawn.status, 200, `restart after the withdrawal: ${JSON.stringify(restartedWithdrawn.body)}`);
  assert.equal(restartedWithdrawn.body.codeSent, true);
  assert.deepEqual((await owner.query(`select status, self_service_without_hold from identity.organization_applications
    where cac_registration_number=$1 and id<>$2`, [cacWithdrawn, withdrawnApplication.id])).rows,
  [{ status: 'ready_for_review', self_service_without_hold: true }]);
  p4b.withdrawal = { closedGate: 423, origin: 403, signedIn: 409, noSession: 401, withdrawn: 200, cookieCleared: true,
    application: 'rejected, no reviewer, no refusal', codesEnded: true, audited: 'system', again: 401,
    restartSameEmailAndNetwork: 200 };

  // ── 1. Before review: the restricted role, and nothing that reaches patient data ──
  const hospital = await signUp({ cac: 'RC9900064001', organizationType: 'hospital', productCode: 'ehr',
    administratorName: 'Ngozi Adeyemi' });
  hospital.facilityName = `Runtime Clinic ${hospital.cac} Ltd`;
  assert.deepEqual(await permissionsOf('org_admin_awaiting_review'), restrictedPermissions);
  const clinicalPermissions = await permissionsOf('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist');
  assert.deepEqual(restrictedPermissions.filter(code => clinicalPermissions.includes(code) && !code.startsWith('outreach.')), [],
    'The restricted role holds a clinical permission');
  const pendingSession = await sessionRead(hospital);
  assert.equal(pendingSession.status, 200, `pending session: ${JSON.stringify(pendingSession.body)}`);
  const pendingView = await facilityPermissions(hospital, hospital.facilityId);
  assert.deepEqual(pendingView.permissions, restrictedPermissions);
  assert.deepEqual(pendingView.selfService, { review: 'pending', organizationType: 'hospital' });
  for (const permission of ['identity.patient.read', 'identity.consent.write', 'identity.consent.read',
    'identity.break-glass.write', 'identity.registration.write', 'identity.authorization.check', 'ehr.encounter.read']) {
    assert.equal((await owner.query(`select auth.membership_has_permission(a.subject, m.id, m.facility_id, $3) ok
        from auth.accounts a join identity.staff_facility_memberships m on m.account_id = a.id
       where a.id=$1 and m.facility_id=$2`, [hospital.accountId, hospital.facilityId, permission])).rows[0].ok, false,
    `The pending administrator holds ${permission}`);
  }
  const pendingStaff = await staffCall(hospital, 'get', '/identity/facility-staff');
  assert.equal(pendingStaff.status, 200, `pending staff page: ${JSON.stringify(pendingStaff.body)}`);
  assert.deepEqual(Object.keys(pendingStaff.body).sort(), ['administratorLicence', 'administratorLicenceBodies', 'canInvite',
    'facility', 'inviteOptions', 'invitations', 'limits', 'members'].sort());
  assert.deepEqual({ ...pendingStaff.body.facility, firstThirtyDaysEndAt: undefined }, { id: hospital.facilityId,
    name: hospital.facilityName, organizationType: 'hospital', reviewState: 'pending', firstThirtyDaysEndAt: undefined,
    invitationsOpen: false, deliveryPaused: false });
  assert.equal(pendingStaff.body.canInvite, false);
  assert.equal(pendingStaff.body.administratorLicence, null);
  assert.deepEqual(pendingStaff.body.administratorLicenceBodies, ['MDCN', 'NMCN']);
  assert.deepEqual(pendingStaff.body.inviteOptions.roles, [{ code: 'doctor', licenceBody: 'MDCN' },
    { code: 'nurse', licenceBody: 'NMCN' }, { code: 'lab', licenceBody: 'MLSCN' },
    { code: 'pharmacist', licenceBody: 'PCN' }, { code: 'receptionist', licenceBody: null }]);
  assert.equal(pendingStaff.body.inviteOptions.attestation.version, 'facility-staff-attestation-v1');
  assert.deepEqual(pendingStaff.body.members.map(member => [member.accountId, member.isAdministrator, member.isSelf,
    member.roles]), [[hospital.accountId, true, true, ['org_admin_awaiting_review']]]);
  assert.deepEqual(pendingStaff.body.invitations, []);
  const pendingPatient = await syntheticPatient();
  expectProblem(await invite(hospital, { name: 'Chidi Okafor', email: email('invitee-early'), role: 'doctor',
    licenceBody: 'MDCN', licenceNumber: 'MDCN/10001' }), 409, 'FACILITY_REVIEW_PENDING');
  expectProblem(await staffCall(hospital, 'post', '/identity/patient-lookup', { hid: pendingPatient.hid,
    purpose: 'direct-care' }), 403, 'PERMISSION_DENIED');
  expectProblem(await staffCall(hospital, 'get', '/identity/registration-capabilities'), 403, 'PERMISSION_DENIED');
  expectProblem(await breakGlass(hospital, pendingPatient), 403, 'PERMISSION_DENIED');
  expectProblem(await staffCall(hospital, 'get', '/identity/access-requests?status=pending',
    undefined), 403, 'PERMISSION_DENIED');
  assert.equal(await count('select count(*)::int n from identity.consent_grants where facility_id=$1',
    [hospital.facilityId]), 0);
  p4b.pending = { permissions: restrictedPermissions, selfService: pendingView.selfService, staffPage: 200,
    canInvite: false, invite: 'FACILITY_REVIEW_PENDING', patientLookup: 403, registrationCapabilities: 403,
    breakGlass: 403, accessRequests: 403, clinicalPermissions: 'none' };

  // The review gate refuses a clinical role at a pending facility, whoever writes it.
  const triggers = (await owner.query(`select tgname, tgenabled from pg_trigger
    where tgname in ('account_roles_review_gate', 'consent_grants_self_service_probation') order by tgname`)).rows;
  assert.deepEqual(triggers, [{ tgname: 'account_roles_review_gate', tgenabled: 'O' },
    { tgname: 'consent_grants_self_service_probation', tgenabled: 'O' }]);
  const pendingGate = await reviewGate(hospital.accountId, hospital.facilityId, 'doctor');
  assert.equal(pendingGate.runtimeDirect.code, '42501', JSON.stringify(pendingGate));
  assert.deepEqual(pendingGate.ownerDirect, { code: 'P0001', message: 'FACILITY_REVIEW_PENDING' });
  assert.deepEqual(pendingGate.runtimeThroughDefiner, { code: 'P0001', message: 'FACILITY_REVIEW_PENDING' });
  const pendingGateOrgAdmin = await reviewGate(hospital.accountId, hospital.facilityId, 'org_admin');
  assert.deepEqual(pendingGateOrgAdmin.ownerDirect, { code: 'P0001', message: 'FACILITY_REVIEW_PENDING' });
  p4b.trigger.pending = { tgenabled: 'O', runtimeDirect: `${pendingGate.runtimeDirect.code} (no table privilege)`,
    ownerDirect: pendingGate.ownerDirect.message, runtimeThroughDefiner: pendingGate.runtimeThroughDefiner.message,
    orgAdminByOwner: pendingGateOrgAdmin.ownerDirect.message };

  // The pending administrator records their own licence for support (SPEC §3.4).
  const licencePath = '/identity/facility-staff/administrator-licence';
  const firstLicence = await staffCall(hospital, 'post', licencePath, { licenceBody: 'MDCN', licenceNumber: ' mdcn/12345 ' });
  assert.equal(firstLicence.status, 200, `own licence: ${JSON.stringify(firstLicence.body)}`);
  assert.deepEqual({ ...firstLicence.body, recordedAt: undefined }, { licenceBody: 'MDCN', numberHint: '2345',
    recordedAt: undefined });
  expectProblem(await staffCall(hospital, 'post', licencePath, { licenceBody: 'PCN', licenceNumber: 'PCN/12345' }),
    400, 'ADMINISTRATOR_LICENCE_INVALID');
  const ownLicence = await staffCall(hospital, 'post', licencePath, { licenceBody: 'MDCN', licenceNumber: 'MDCN/67890' });
  assert.equal(ownLicence.status, 200);
  assert.equal(ownLicence.body.numberHint, '7890');
  sensitive.add('MDCN/12345'); sensitive.add('MDCN/67890');
  assert.deepEqual((await owner.query(`select self_service_admin_licence_body body, self_service_admin_licence_number num
    from identity.organization_applications where id=$1`, [hospital.applicationId])).rows, [{ body: 'MDCN', num: 'MDCN/67890' }]);
  assert.deepEqual((await owner.query(`select actor_type, facility_id, details from audit.events
    where action='identity.facility-administrator-licence.record' and facility_id=$1 order by sequence_id`,
  [hospital.facilityId])).rows.map(row => [row.actor_type, row.details]), [['staff', { licenceBody: 'MDCN' }],
    ['staff', { licenceBody: 'MDCN' }]]);
  const pendingListed = await listedFacility(hospital, 'unreviewed');
  assert.deepEqual([pendingListed.reviewGrantsRole, pendingListed.reviewableRoles, pendingListed.administratorLicenceBody,
    pendingListed.administratorLicenceNumber], ['doctor', ['doctor', 'nurse'], 'MDCN', 'MDCN/67890']);
  p4b.pending.ownLicence = { saved: 200, hint: '7890', replaced: true, wrongBody: 'ADMINISTRATOR_LICENCE_INVALID',
    supportSees: 'MDCN/67890', audited: 'identity.facility-administrator-licence.record {licenceBody}' };

  // ── 2. Support's review ──
  const supportAdmin = await standalone('support', ['support_admin']);
  const reviewerPair = await standalone('review-pair', ['facility_review_admin', 'identity_review_admin']);
  const hospitalLicence = { body: 'MDCN', number: 'mdcn/67890' };
  expectProblem(await reviewFacility(supportAdmin, hospital, reviewBody('doctor', hospitalLicence)), 403, 'PERMISSION_DENIED');
  expectProblem(await reviewFacility(superAdmin, hospital, reviewBody('doctor')), 400, 'SELF_SERVICE_REVIEW_LICENCE_REQUIRED');
  expectProblem(await reviewFacility(superAdmin, hospital, reviewBody('lab', { body: 'MLSCN', number: 'MLSCN/1234' })),
    400, 'SELF_SERVICE_REVIEW_ROLE_INVALID');
  expectProblem(await reviewFacility(superAdmin, hospital, reviewBody('doctor', { body: 'NMCN', number: 'NMCN/1234' })),
    400, 'SELF_SERVICE_REVIEW_LICENCE_INVALID');
  expectProblem(await reviewFacility(superAdmin, hospital, reviewBody('none', hospitalLicence)),
    400, 'SELF_SERVICE_REVIEW_LICENCE_INVALID');
  expectProblem(await reviewFacility(superAdmin, hospital, { ...reviewBody('doctor', hospitalLicence),
    verificationMethod: 'phone_call' }), 400, 'VALIDATION_FAILED');
  assert.deepEqual(await activeFacilityRoles(hospital.accountId, hospital.facilityId), ['org_admin_awaiting_review'],
    'A refused review granted something');
  assert.equal((await sessionRead(hospital)).status, 200, 'The pending administrator was signed out by a refused review');
  const hospitalVersion = await applicationVersion(hospital.applicationId);
  const hospitalReviewed = await reviewFacility(superAdmin, hospital, reviewBody('doctor', hospitalLicence));
  assert.equal(hospitalReviewed.status, 200, `hospital review: ${JSON.stringify(hospitalReviewed.body)}`);
  assert.deepEqual(Object.keys(hospitalReviewed.body).sort(), ['applicationId', 'grantedRole', 'reviewedAt',
    'sessionsRevoked', 'version']);
  assert.deepEqual([hospitalReviewed.body.applicationId, hospitalReviewed.body.version, hospitalReviewed.body.grantedRole],
    [hospital.applicationId, hospitalVersion + 1, 'doctor']);
  assert(hospitalReviewed.body.sessionsRevoked >= 1, 'The review did not sign the administrator out');
  expectProblem(await sessionRead(hospital), 401);
  assert.deepEqual(await activeFacilityRoles(hospital.accountId, hospital.facilityId), ['doctor', 'org_admin']);
  assert.deepEqual((await owner.query(`select role_code, granted_by, revoked_by, revocation_reason from auth.account_roles
    where account_id=$1 and facility_id=$2 order by role_code`, [hospital.accountId, hospital.facilityId])).rows,
  [{ role_code: 'doctor', granted_by: superAdmin.accountId, revoked_by: null, revocation_reason: null },
    { role_code: 'org_admin', granted_by: superAdmin.accountId, revoked_by: null, revocation_reason: null },
    { role_code: 'org_admin_awaiting_review', granted_by: null, revoked_by: superAdmin.accountId,
      revocation_reason: 'Facility reviewed by platform support' }]);
  assert.deepEqual((await owner.query(`select role_code, licence_body, licence_number, verification_method,
      attested_by_account_id, attested_by_membership_id, attestation_version, attested_person_name, review_application_id
    from identity.staff_licence_attestations where account_id=$1`, [hospital.accountId])).rows,
  [{ role_code: 'doctor', licence_body: 'MDCN', licence_number: 'MDCN/67890', verification_method: 'platform_review',
    attested_by_account_id: superAdmin.accountId, attested_by_membership_id: null, attestation_version: 'platform-review-v1',
    attested_person_name: 'Ngozi Adeyemi', review_application_id: hospital.applicationId }]);
  assert.deepEqual((await owner.query(`select count(*) filter (where revoked_at is null)::int live,
      count(*) filter (where revocation_reason = 'facility_reviewed')::int reviewed
    from auth.sessions where account_id=$1`, [hospital.accountId])).rows, [{ live: 0,
    reviewed: hospitalReviewed.body.sessionsRevoked }]);
  const hospitalMembership = await membershipOf(hospital.accountId, hospital.facilityId);
  assert.deepEqual((await owner.query(`select actor_type, actor_account_id, facility_id, details
    from audit.events where action='admin.self-service-facility.review' and resource_id=$1`, [hospital.applicationId])).rows,
  [{ actor_type: 'platform', actor_account_id: superAdmin.accountId, facility_id: null, details: { productCode: 'ehr',
    organizationId: hospital.organizationId, facilityId: hospital.facilityId, administratorAccountId: hospital.accountId,
    version: hospitalReviewed.body.version, grantedRole: 'doctor', verificationMethod: 'regulator_register',
    licenceBody: 'MDCN', membershipId: hospitalMembership.id, sessionsRevoked: hospitalReviewed.body.sessionsRevoked } }]);
  assert.deepEqual((await owner.query(`select actor_type, organization_id, facility_id, details from audit.events
    where action='identity.facility-access.unlock' and facility_id=$1`, [hospital.facilityId])).rows,
  [{ actor_type: 'system', organization_id: hospital.organizationId, facility_id: hospital.facilityId,
    details: { applicationId: hospital.applicationId, grantedRoles: ['org_admin', 'doctor'] } }]);
  expectProblem(await reviewFacility(superAdmin, hospital, reviewBody('doctor', hospitalLicence)), 409,
    'SELF_SERVICE_FACILITY_ALREADY_REVIEWED');
  // The administrator signs in again on the EHR host, as a doctor.
  const hospitalAdmin = await signedIn(hospital.email, password, 'ehr', hospital.facilityId);
  hospitalAdmin.facilityName = hospital.facilityName;
  const hospitalAdminView = await facilityPermissions(hospitalAdmin, hospital.facilityId);
  assert.deepEqual(hospitalAdminView.permissions, await permissionsOf('org_admin', 'doctor'));
  assert.deepEqual(hospitalAdminView.selfService, { review: 'reviewed', organizationType: 'hospital' });
  assert.equal((await staffCall(hospitalAdmin, 'get', '/identity/registration-capabilities')).status, 200);
  const lookedUp = await staffCall(hospitalAdmin, 'post', '/identity/patient-lookup', { hid: pendingPatient.hid,
    purpose: 'direct-care' });
  assert.deepEqual([lookedUp.status, lookedUp.body], [201, { verifierStub: 'patient lookup reached the service' }]);
  const reviewedListed = await listedFacility(hospital, 'reviewed');
  assert.deepEqual({ ...reviewedListed, probationEndsAt: undefined, reviewedAt: undefined, activatedAt: undefined,
    administratorLicenceRecordedAt: undefined }, { ...reviewedListed, probationEndsAt: undefined, reviewedAt: undefined,
    activatedAt: undefined, administratorLicenceRecordedAt: undefined, grantedRole: 'doctor',
    verificationMethod: 'regulator_register', administratorLicenceBody: 'MDCN', administratorLicenceNumber: 'MDCN/67890',
    memberCount: 1, pendingInvitationCount: 0, breakGlassLast7d: 0, deliveryFailuresLastDay: 0 });
  assert.equal(Date.parse(reviewedListed.probationEndsAt) - Date.parse(reviewedListed.reviewedAt), 30 * 24 * 3600 * 1000);
  p4b.review.hospital = { supportAdmin: 403, noLicence: 'SELF_SERVICE_REVIEW_LICENCE_REQUIRED',
    roleNotForType: 'SELF_SERVICE_REVIEW_ROLE_INVALID', wrongBody: 'SELF_SERVICE_REVIEW_LICENCE_INVALID',
    licenceWithNone: 'SELF_SERVICE_REVIEW_LICENCE_INVALID', refusedWroteNothing: true, status: 200,
    grantedRoles: ['org_admin', 'doctor'], restrictedRevoked: true, attestation: 'platform_review',
    sessionsRevoked: hospitalReviewed.body.sessionsRevoked, oldSession: 401, again: 409,
    signInOnEhr: { permissions: 'org_admin + doctor', selfService: hospitalAdminView.selfService },
    registrationCapabilities: 200, patientLookup: 'reached the service', audit: ['platform', 'system at the facility'] };

  // A suspended facility cannot be reviewed; nothing is granted.
  const applicationOfB = (await owner.query('select id from identity.organization_applications where organization_id=$1',
    [activatedB.body.organizationId])).rows[0].id;
  const facilityBVersion = (await owner.query('select row_version from identity.facilities where id=$1',
    [activatedB.body.facilityId])).rows[0].row_version;
  const suspendedB = await adminPost(superAdmin, `/admin/facilities/${activatedB.body.facilityId}/status`,
    { status: 'suspended', reason: 'Runtime verifier suspends a facility before review' },
    { 'If-Match': `"${facilityBVersion}"`, 'Idempotency-Key': `verifier-suspend-${randomUUID()}` });
  assert([200, 201].includes(suspendedB.status), `suspending B: ${JSON.stringify(suspendedB.body)}`);
  expectProblem(await reviewFacility(superAdmin, { applicationId: applicationOfB }, reviewBody('none')), 409,
    'SELF_SERVICE_FACILITY_REVIEW_REQUIRES_ACTIVE');
  assert.deepEqual(await activeFacilityRoles(activatedB.body.accountId, activatedB.body.facilityId),
    ['org_admin_awaiting_review']);
  assert.equal((await owner.query('select self_service_reviewed_at from identity.organization_applications where id=$1',
    [applicationOfB])).rows[0].self_service_reviewed_at, null);
  // A least-privilege reviewer (facility_review_admin + identity_review_admin) reviews a third.
  const real = { applicationId: (await owner.query('select id from identity.organization_applications where organization_id=$1',
    [activatedReal.body.organizationId])).rows[0].id, accountId: activatedReal.body.accountId,
  facilityId: activatedReal.body.facilityId, organizationId: activatedReal.body.organizationId,
  email: (await owner.query('select email from auth.accounts where id=$1', [activatedReal.body.accountId])).rows[0].email,
  facilityName: `Runtime Clinic ${cacLapse} Ltd` };
  const realReviewed = await reviewFacility(reviewerPair, real, reviewBody('nurse', { body: 'NMCN', number: 'NMCN/24680' },
    'officer_match'));
  assert.equal(realReviewed.status, 200, `pair review: ${JSON.stringify(realReviewed.body)}`);
  sensitive.add('NMCN/24680');
  assert.deepEqual(await activeFacilityRoles(real.accountId, real.facilityId), ['nurse', 'org_admin']);
  p4b.review.suspendedFacility = 'SELF_SERVICE_FACILITY_REVIEW_REQUIRES_ACTIVE, nothing granted';
  p4b.review.leastPrivilegeReviewer = { roles: ['facility_review_admin', 'identity_review_admin'], status: 200,
    grantedRole: 'nurse' };

  // ── 3. Roles by type: laboratory → lab, pharmacy → pharmacist, other → none, then doctor ──
  const laboratory = await signUp({ cac: 'RC9900064002', organizationType: 'laboratory', productCode: 'laboratory',
    administratorName: 'Kunle Bakare' });
  const pharmacy = await signUp({ cac: 'RC9900064003', organizationType: 'pharmacy', productCode: 'pharmacy',
    administratorName: 'Halima Sani' });
  const otherProvider = await signUp({ cac: 'RC9900064004', organizationType: 'other', productCode: 'ehr',
    administratorName: 'Uche Nwosu' });
  for (const [target, preselected, reviewable] of [[laboratory, 'lab', ['lab']], [pharmacy, 'pharmacist', ['pharmacist']],
    [otherProvider, null, ['doctor', 'nurse']]]) {
    const item = await listedFacility(target, 'unreviewed');
    assert.deepEqual([item.reviewGrantsRole, item.reviewableRoles], [preselected, reviewable], target.organizationType);
  }
  expectProblem(await reviewFacility(superAdmin, laboratory, reviewBody('doctor', hospitalLicence)), 400,
    'SELF_SERVICE_REVIEW_ROLE_INVALID');
  const labReviewed = await reviewFacility(superAdmin, laboratory, reviewBody('lab', { body: 'MLSCN', number: 'MLSCN/11223' }));
  assert.equal(labReviewed.status, 200, `lab review: ${JSON.stringify(labReviewed.body)}`);
  const pharmacyReviewed = await reviewFacility(superAdmin, pharmacy,
    reviewBody('pharmacist', { body: 'PCN', number: 'PCN/33445' }));
  assert.equal(pharmacyReviewed.status, 200, `pharmacy review: ${JSON.stringify(pharmacyReviewed.body)}`);
  sensitive.add('MLSCN/11223'); sensitive.add('PCN/33445');
  const labAdmin = await signedIn(laboratory.email, password, 'lab', laboratory.facilityId);
  assert.deepEqual((await facilityPermissions(labAdmin, laboratory.facilityId)).permissions,
    await permissionsOf('org_admin', 'lab'));
  const pharmacyAdmin = await signedIn(pharmacy.email, password, 'pharmacy', pharmacy.facilityId);
  assert.deepEqual((await facilityPermissions(pharmacyAdmin, pharmacy.facilityId)).permissions,
    await permissionsOf('org_admin', 'pharmacist'));
  // "Other": no clinical access at review (org_admin only), then support gives it a doctor's.
  const otherReviewed = await reviewFacility(superAdmin, otherProvider, reviewBody('none', undefined, 'in_person'));
  assert.equal(otherReviewed.status, 200, `other review: ${JSON.stringify(otherReviewed.body)}`);
  assert.equal(otherReviewed.body.grantedRole, 'none');
  assert.deepEqual(await activeFacilityRoles(otherProvider.accountId, otherProvider.facilityId), ['org_admin']);
  let otherAdmin = await signedIn(otherProvider.email, password, 'ehr', otherProvider.facilityId);
  assert.deepEqual((await facilityPermissions(otherAdmin, otherProvider.facilityId)).permissions,
    await permissionsOf('org_admin'));
  expectProblem(await breakGlass(otherAdmin, pendingPatient), 403, 'PERMISSION_DENIED');
  const rolePath = `${facilitiesPath}/${otherProvider.applicationId}/administrator-role`;
  const roleChangeBody = { grantedRole: 'doctor', verificationMethod: 'regulator_register',
    administratorLicence: { body: 'MDCN', number: 'MDCN/55555' }, reason: 'The administrator is a registered doctor' };
  sensitive.add('MDCN/55555');
  expectProblem(await adminPost(supportAdmin, rolePath, roleChangeBody,
    { 'If-Match': `"${await applicationVersion(otherProvider.applicationId)}"` }), 403, 'PERMISSION_DENIED');
  expectProblem(await adminPost(superAdmin, rolePath, { ...roleChangeBody, administratorLicence: undefined },
    { 'If-Match': `"${await applicationVersion(otherProvider.applicationId)}"` }), 400, 'SELF_SERVICE_REVIEW_LICENCE_REQUIRED');
  expectProblem(await adminPost(superAdmin, rolePath, roleChangeBody), 428, 'IF_MATCH_REQUIRED');
  const otherVersion = await applicationVersion(otherProvider.applicationId);
  const otherChanged = await adminPost(superAdmin, rolePath, roleChangeBody, { 'If-Match': `"${otherVersion}"` });
  assert.equal(otherChanged.status, 200, `administrator role: ${JSON.stringify(otherChanged.body)}`);
  assert.deepEqual({ ...otherChanged.body, sessionsRevoked: undefined }, { applicationId: otherProvider.applicationId,
    version: otherVersion + 1, grantedRole: 'doctor', sessionsRevoked: undefined });
  assert(otherChanged.body.sessionsRevoked >= 1);
  expectProblem(await sessionRead(otherAdmin), 401);
  expectProblem(await adminPost(superAdmin, rolePath, roleChangeBody, { 'If-Match': `"${otherVersion + 1}"` }), 409,
    'SELF_SERVICE_ADMINISTRATOR_ROLE_UNCHANGED');
  expectProblem(await adminPost(superAdmin, rolePath, roleChangeBody, { 'If-Match': `"${otherVersion}"` }), 409,
    'VERSION_CONFLICT');
  otherAdmin = await signedIn(otherProvider.email, password, 'ehr', otherProvider.facilityId);
  assert.deepEqual((await facilityPermissions(otherAdmin, otherProvider.facilityId)).permissions,
    await permissionsOf('org_admin', 'doctor'));
  assert.equal(await count(`select count(*)::int n from audit.events where action in
    ('admin.self-service-facility.administrator-role', 'identity.facility-access.change') and resource_id=$1`,
  [otherProvider.applicationId]), 2);
  p4b.roles = { laboratory: { preselected: 'lab', granted: 'lab', signIn: 'lab.* (lab-login)', permissions: 'org_admin + lab',
    doctorRefused: 'SELF_SERVICE_REVIEW_ROLE_INVALID' },
  pharmacy: { preselected: 'pharmacist', granted: 'pharmacist', signIn: 'pharmacy.* (pharmacy-login)',
    permissions: 'org_admin + pharmacist' },
  other: { preselected: null, reviewedAs: 'none', permissions: 'org_admin only', breakGlass: 403,
    administratorRole: { supportAdmin: 403, noLicence: 'SELF_SERVICE_REVIEW_LICENCE_REQUIRED', missingIfMatch: 428,
      status: 200, grantedRole: 'doctor', oldSession: 401, unchanged: 'SELF_SERVICE_ADMINISTRATOR_ROLE_UNCHANGED',
      staleVersion: 409, permissionsAfter: 'org_admin + doctor', audit: 2 } } };

  // ── 4. The first 30 days: 5 emergency activations a day per facility ──
  const emergencyPatients = [];
  for (let index = 0; index < 7; index += 1) emergencyPatients.push(await syntheticPatient());
  for (const patient of emergencyPatients.slice(0, 5)) await seedGrant(hospitalMembership.id, patient, true);
  expectProblem(await breakGlass(hospitalAdmin, emergencyPatients[5]), 429, 'EMERGENCY_PROBATION_LIMITED');
  // A replay of an active grant reuses it and is never refused.
  const replayedEmergency = await breakGlass(hospitalAdmin, emergencyPatients[0]);
  assert.equal(replayedEmergency.status, 201, `replayed break-glass: ${JSON.stringify(replayedEmergency.body)}`);
  assert.equal(replayedEmergency.body.existingGrant, true);
  assert.equal((await listedFacility(hospital, 'reviewed')).breakGlassLast7d, 5);
  const probationPath = `${facilitiesPath}/${hospital.applicationId}/end-probation`;
  expectProblem(await adminPost(superAdmin, probationPath, { reason: 'short' },
    { 'If-Match': `"${await applicationVersion(hospital.applicationId)}"` }), 400, 'VALIDATION_FAILED');
  const probationVersion = await applicationVersion(hospital.applicationId);
  const probationEnded = await adminPost(superAdmin, probationPath,
    { reason: 'Support confirmed the facility with the regulator' }, { 'If-Match': `"${probationVersion}"` });
  assert.equal(probationEnded.status, 200, `end probation: ${JSON.stringify(probationEnded.body)}`);
  assert.deepEqual({ ...probationEnded.body, probationEndedAt: undefined }, { applicationId: hospital.applicationId,
    version: probationVersion + 1, probationEndedAt: undefined });
  expectProblem(await adminPost(superAdmin, probationPath, { reason: 'Support confirmed the facility again' },
    { 'If-Match': `"${probationVersion + 1}"` }), 409, 'SELF_SERVICE_PROBATION_ALREADY_ENDED');
  assert.equal((await listedFacility(hospital, 'reviewed')).probationEndsAt, null);
  const sixthEmergency = await breakGlass(hospitalAdmin, emergencyPatients[5]);
  assert.equal(sixthEmergency.status, 201, `sixth break-glass after the 30 days ended: ${JSON.stringify(sixthEmergency.body)}`);
  assert.equal(sixthEmergency.body.existingGrant, false);
  p4b.probation = { seededGrants: 5, sixth: 'EMERGENCY_PROBATION_LIMITED (429)', replay: 201, listCount: 5,
    endEarly: 200, endAgain: 'SELF_SERVICE_PROBATION_ALREADY_ENDED', sixthAfterEnd: 201 };

  // ── 5. Invitations: closed, then open ──
  const chidiEmail = email('invitee-chidi');
  expectProblem(await invite(hospitalAdmin, { name: 'Chidi Okafor', email: chidiEmail, role: 'doctor', licenceBody: 'MDCN',
    licenceNumber: 'MDCN/10001' }), 423, 'STAFF_INVITATIONS_UNAVAILABLE');
  expectProblem(await openInvitation({ invitationId: randomUUID(), token: randomToken() }), 423, 'STAFF_INVITATIONS_UNAVAILABLE');
  expectProblem(await acceptInvitation(`hid_staff_invitation=${'A'.repeat(43)}`, invitationPassword), 423,
    'STAFF_INVITATIONS_UNAVAILABLE');
  const invitationsControl = (await adminGet(superAdmin, '/admin/controls')).body
    .find(control => control.controlKey === 'staff_invitations_enabled');
  assert.deepEqual({ ...invitationsControl, updatedAt: undefined }, { controlKey: 'staff_invitations_enabled', enabled: false,
    reason: 'Facility staff invitations ship closed (P4b); enable by audited admin command', version: 1, updatedAt: undefined });
  const invitationsOpened = await adminPost(superAdmin, '/admin/controls', { controlKey: 'staff_invitations_enabled',
    enabled: true, reason: 'Open staff invitations for the runtime verifier' }, { 'If-Match': '"1"' });
  assert.equal(invitationsOpened.status, 201, `opening invitations: ${JSON.stringify(invitationsOpened.body)}`);
  // Invite a doctor: 201, one email with exactly the fixed fields and no person's name.
  const deliveriesBefore = staffInvitationInputs.length;
  const chidi = await invited(hospitalAdmin, { name: 'Chidi Okafor', email: chidiEmail, role: 'doctor', licenceBody: 'MDCN',
    licenceNumber: 'mdcn/10001' });
  assert.deepEqual(Object.keys(chidi).filter(key => key !== 'sent').sort(), ['deliveryOutcome', 'expiresAt', 'invitationId',
    'replayed', 'version']);
  assert.deepEqual([chidi.version, chidi.deliveryOutcome, chidi.replayed], [1, 'accepted', false]);
  const chidiRow = await invitationRow(chidi.invitationId);
  assert.deepEqual([chidiRow.status, chidiRow.row_version, chidiRow.delivery_outcome, chidiRow.key_version],
    ['pending', '1', 'accepted', 'local-v1'], 'The delivery outcome bumped the version or was not recorded');
  assert.equal(staffInvitationInputs.length, deliveriesBefore + 1);
  assert.deepEqual(Object.keys(staffInvitationInputs.at(-1)).sort(), ['code', 'correlationId', 'expiresAt', 'facilityName',
    'invitationId', 'recipient', 'roleCode', 'sendId', 'token']);
  assert.equal(staffInvitationInputs.at(-1).sendId, chidiRow.last_send_id);
  assert.equal(chidi.sent.headers['idempotency-key'], `staff-invitation:${chidiRow.last_send_id}`);
  assert.deepEqual(Object.keys(chidi.sent.body).sort(), ['channel', 'code', 'expiresAt', 'facilityName', 'invitationId',
    'plan', 'recipient', 'roleCode', 'token']);
  assert.deepEqual({ ...chidi.sent.body, plan: undefined, token: undefined, code: undefined }, { channel: 'email',
    recipient: chidiEmail, facilityName: hospital.facilityName, roleCode: 'doctor', invitationId: chidi.invitationId,
    expiresAt: chidi.expiresAt, plan: undefined, token: undefined, code: undefined });
  assert.match(chidi.sent.body.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(chidi.sent.body.code, /^\d{6}$/);
  assert(Math.abs(Date.parse(chidi.expiresAt) - Date.now() - 7 * 24 * 3600 * 1000) < 120_000, 'An invitation is not valid 7 days');
  for (const word of ['Chidi', 'Okafor', 'Ngozi', 'Adeyemi', 'MDCN/10001']) {
    assert(!JSON.stringify(chidi.sent.body).includes(word) && !chidi.sent.text.includes(word),
      `The invitation email carries ${word}`);
  }
  const reference = chidi.invitationId.replaceAll('-', '').slice(0, 8).toUpperCase();
  assert.equal(chidi.sent.subject, `Invitation to join ${hospital.facilityName} on Health ID`);
  assert(chidi.sent.text.includes(`as a doctor.`));
  assert(chidi.sent.text.includes(`https://app.healthidentitydirectory.com/provider/invitation#${chidi.invitationId}.${chidi.sent.body.token}`));
  // The typed fallback: the page opened without a link shows the code form at once.
  assert(chidi.sent.text.includes('If the link does not open, go to https://app.healthidentitydirectory.com/provider/invitation'
    + ` and enter this email address and the code ${chidi.sent.body.code}.`));
  assert(chidi.sent.text.includes(`quote reference ${reference}.`));
  // Replay (same key, same request): 200 with the stored values, no second email.
  const replayKey = `verifier-invite-replay-${randomUUID()}`;
  const bisiEmail = email('invitee-bisi');
  const bisiBody = { name: 'Bisi Lawal', email: bisiEmail, role: 'nurse', licenceBody: 'NMCN', licenceNumber: 'NMCN/31415' };
  const bisiFirst = await invite(hospitalAdmin, bisiBody, replayKey);
  assert.equal(bisiFirst.status, 201, `invite Bisi: ${JSON.stringify(bisiFirst.body)}`);
  const bisiSent = invitationEmails.at(-1);
  sensitive.add(bisiSent.body.token); sensitive.add(bisiSent.body.code); sensitive.add(bisiEmail); sensitive.add('Bisi Lawal');
  sensitive.add('NMCN/31415');
  const emailsBeforeReplay = invitationEmails.length;
  const bisiReplay = await invite(hospitalAdmin, bisiBody, replayKey);
  assert.equal(bisiReplay.status, 200, `replay: ${JSON.stringify(bisiReplay.body)}`);
  assert.deepEqual(bisiReplay.body, { invitationId: bisiFirst.body.invitationId, version: 1, expiresAt: bisiFirst.body.expiresAt,
    deliveryOutcome: 'unknown', replayed: true });
  assert.equal(invitationEmails.length, emailsBeforeReplay, 'A replay sent a second email');
  expectProblem(await invite(hospitalAdmin, { ...bisiBody, email: email('invitee-other') }, replayKey), 409,
    'IDEMPOTENCY_KEY_REUSED');
  expectProblem(await invite(hospitalAdmin, { name: 'Ngozi Adeyemi', email: hospital.email, role: 'receptionist' }), 409,
    'STAFF_INVITATION_SELF');
  expectProblem(await invite(hospitalAdmin, bisiBody), 409, 'STAFF_INVITATION_ALREADY_PENDING');
  const failuresBefore = await count('select count(*)::int n from auth.session_events where event_type=\'login_failed\'');
  expectProblem(await invite(hospitalAdmin, { name: 'Wrong Password', email: email('invitee-wrong'), role: 'receptionist' },
    undefined, 'Not-The-Administrator-Password'), 403, 'STAFF_REAUTHENTICATION_FAILED');
  assert.equal(await count('select count(*)::int n from auth.session_events where event_type=\'login_failed\''),
    failuresBefore + 1, 'A wrong password was not counted as a failed sign-in');
  expectProblem(await invite(hospitalAdmin, { name: 'Ada Licence', email: email('invitee-nolicence'), role: 'doctor' }), 400,
    'VALIDATION_FAILED');
  expectProblem(await invite(hospitalAdmin, { name: 'Ada Desk', email: email('invitee-desk'), role: 'receptionist',
    licenceBody: 'MDCN', licenceNumber: 'MDCN/1' }), 400, 'VALIDATION_FAILED');
  expectProblem(await invite(hospitalAdmin, { name: 'Health Support', email: email('invitee-reserved'), role: 'receptionist' }),
    400, 'VALIDATION_FAILED');
  expectProblem(await staffCall(hospitalAdmin, 'post', '/identity/staff-invitations', { name: 'No Key', email: email('nokey'),
    role: 'receptionist', attested: true, currentPassword: password }), 400, 'IDEMPOTENCY_KEY_REQUIRED');
  expectProblem(await invite(labAdmin, { name: 'Dayo Ade', email: email('invitee-labdoctor'), role: 'doctor',
    licenceBody: 'MDCN', licenceNumber: 'MDCN/20002' }), 400, 'STAFF_INVITATION_ROLE_NOT_ALLOWED');
  p4b.invitations = { closed: { invite: 423, open: 423, accept: 423 }, control: 'staff_invitations_enabled seeded off, opened by support',
    invite: { status: 201, version: 1, deliveryOutcome: 'accepted', versionAfterDelivery: 1 },
    email: { route: 'POST /api/v1/notifications/staff-invitation', idempotencyKey: 'staff-invitation:<sendId>',
      fields: Object.keys(chidi.sent.body).sort(), validatedBy: 'notification-api DeliverStaffInvitationDto',
      noPersonName: true, subject: chidi.sent.subject, link: 'https://app.healthidentitydirectory.com/provider/invitation#<id>.<token>',
      reference },
    replay: { status: 200, replayed: true, emails: 0 }, reusedKey: 'IDEMPOTENCY_KEY_REUSED', self: 'STAFF_INVITATION_SELF',
    duplicate: 'STAFF_INVITATION_ALREADY_PENDING', wrongPassword: 'STAFF_REAUTHENTICATION_FAILED (counted)',
    doctorWithoutLicence: 400, receptionistWithLicence: 400, reservedName: 400, noKey: 'IDEMPOTENCY_KEY_REQUIRED',
    doctorAtLaboratory: 'STAFF_INVITATION_ROLE_NOT_ALLOWED' };

  // ── 6. Open ──
  // Chidi's link: nine wrong tokens, then a tenth, then the right one is locked.
  const lockNetwork = '198.51.140.1';
  for (let index = 1; index <= 10; index += 1) {
    expectProblem(await openInvitation({ invitationId: chidi.invitationId, token: randomToken() },
      { network: index <= 5 ? lockNetwork : '198.51.140.2' }), 401, 'STAFF_INVITATION_CODE_INVALID');
  }
  assert.equal((await invitationRow(chidi.invitationId)).failed_link_attempts, 10);
  expectProblem(await openInvitation(byLink(chidi.sent)), 429, 'STAFF_INVITATION_LOCKED');
  // Amaka's: five wrong typed codes stop typed mode, and the link still works.
  const amakaEmail = email('invitee-amaka');
  const amaka = await invited(hospitalAdmin, { name: 'Amaka Eze', email: amakaEmail, role: 'doctor', licenceBody: 'MDCN',
    licenceNumber: 'MDCN/55555' });
  for (let index = 1; index <= 5; index += 1) {
    expectProblem(await openInvitation({ email: amakaEmail, code: wrongTypedCode(amaka.sent) }), 401, 'STAFF_INVITATION_CODE_INVALID');
  }
  expectProblem(await openInvitation(byCode(amaka.sent)), 401, 'STAFF_INVITATION_CODE_INVALID');
  assert.equal((await invitationRow(amaka.invitationId)).failed_typed_attempts, 5);
  const amakaOpened = await openedAs(byLink(amaka.sent), 'new');
  assert.deepEqual({ ...amakaOpened.body, expiresAt: undefined }, { invitationId: amaka.invitationId,
    facilityName: hospital.facilityName, roleCode: 'doctor', inviterName: 'Ngozi Adeyemi', inviteeName: 'Amaka Eze',
    email: amakaEmail, expiresAt: undefined, accountCase: 'new', linkRequired: false });
  const openCookie = setCookies(amakaOpened).find(value => value.startsWith('hid_staff_invitation='));
  for (const attribute of [/; Max-Age=3600/i, /; Path=\/api\/v1\/identity\/staff-invitations/i, /; HttpOnly/i, /; Secure/i,
    /; SameSite=Strict/i]) assert.match(openCookie, attribute);
  assert.doesNotMatch(openCookie, /; Domain=/i);
  assert.equal((await invitationRow(amaka.invitationId)).row_version, '1', 'Opening bumped the facility\'s version');
  assert.equal(await count(`select count(*)::int n from audit.events where action='identity.staff-invitation.open'
    and resource_id=$1 and actor_type='system' and facility_id=$2 and details = jsonb_build_object('invitationId', $1::text)`,
  [amaka.invitationId, hospital.facilityId]), 1);
  // Resend: too soon, then after a minute; the old link and code are superseded.
  expectProblem(await staffCall(hospitalAdmin, 'post', `/identity/staff-invitations/${amaka.invitationId}/resend`,
    { expectedVersion: 1 }), 409, 'STAFF_INVITATION_RESEND_TOO_SOON');
  await ageInvitation(amaka.invitationId);
  const emailsBeforeResend = invitationEmails.length;
  const resent = await staffCall(hospitalAdmin, 'post', `/identity/staff-invitations/${amaka.invitationId}/resend`,
    { expectedVersion: 1 });
  assert.equal(resent.status, 200, `resend: ${JSON.stringify(resent.body)}`);
  assert.deepEqual({ ...resent.body, expiresAt: undefined }, { version: 2, expiresAt: undefined, deliveryOutcome: 'accepted' });
  assert.equal(invitationEmails.length, emailsBeforeResend + 1);
  const amakaResent = invitationEmails.at(-1);
  sensitive.add(amakaResent.body.token); sensitive.add(amakaResent.body.code);
  assert.notEqual(amakaResent.body.token, amaka.sent.body.token);
  const amakaAfterResend = await invitationRow(amaka.invitationId);
  assert.deepEqual([amakaAfterResend.failed_typed_attempts, amakaAfterResend.failed_link_attempts,
    amakaAfterResend.send_count, amakaAfterResend.has_session], [0, 0, 2, false],
  'The resend did not reset the typed counter or end the open session');
  expectProblem(await staffCall(hospitalAdmin, 'post', `/identity/staff-invitations/${amaka.invitationId}/resend`,
    { expectedVersion: 1 }), 409, 'VERSION_CONFLICT');
  expectProblem(await openInvitation(byLink(amaka.sent)), 410, 'STAFF_INVITATION_SUPERSEDED');
  expectProblem(await openInvitation(byCode(amaka.sent)), 410, 'STAFF_INVITATION_SUPERSEDED');
  assert.equal((await invitationRow(amaka.invitationId)).failed_link_attempts, 0, 'A superseded token was counted');
  // Typed mode works for a new account (a session too), and the link.
  const amakaTyped = await openedAs(byCode(amakaResent), 'new');
  assert(invitationCookie(amakaTyped), 'Typed mode opened no session for a new account');
  // A signed-in browser, a wrong Origin, the action on the EHR host, both modes, neither.
  expectProblem(await openInvitation(byLink(amakaResent), { cookie: `${cookieName}_csrf=x` }), 409,
    'STAFF_INVITATION_REQUIRES_SIGN_OUT');
  expectProblem(await openInvitation(byLink(amakaResent), { origin: null }), 403, 'ORIGIN_DENIED');
  expectProblem(await openInvitation(byLink(amakaResent), { origin: ehrOrigin }), 403, 'TURNSTILE_CONTEXT_MISMATCH');
  expectProblem(await openInvitation({ ...byLink(amakaResent), ...byCode(amakaResent) }), 400, 'VALIDATION_FAILED');
  expectProblem(await openInvitation({}), 400, 'VALIDATION_FAILED');
  // 20 opens an hour per network; the 21st is refused before any lookup.
  const busyNetwork = '198.51.141.1';
  for (let index = 1; index <= 20; index += 1) {
    expectProblem(await openInvitation({ invitationId: randomUUID(), token: randomToken() }, { network: busyNetwork }), 401,
      'STAFF_INVITATION_CODE_INVALID');
  }
  expectProblem(await openInvitation(byLink(amakaResent), { network: busyNetwork }), 429, 'STAFF_INVITATION_RATE_LIMITED');
  const amakaLink = await openedAs(byLink(amakaResent), 'new');
  p4b.open = { link: { wrongTokens: 10, thenRightToken: 'STAFF_INVITATION_LOCKED' },
    typed: { wrongCodes: 5, thenRightCode: 401, linkStillWorks: 200 },
    answer: Object.keys(amakaOpened.body).sort(), inviterName: 'Ngozi Adeyemi',
    cookie: 'hid_staff_invitation HttpOnly Secure SameSite=Strict Path=/api/v1/identity/staff-invitations Max-Age=3600, host-only',
    versionUnchanged: true, audit: 'identity.staff-invitation.open {invitationId}',
    resend: { tooSoon: 'STAFF_INVITATION_RESEND_TOO_SOON', status: 200, version: 2, staleVersion: 409,
      oldLink: 'STAFF_INVITATION_SUPERSEDED', oldCode: 'STAFF_INVITATION_SUPERSEDED', countersReset: true },
    typedNew: 200, signedIn: 'STAFF_INVITATION_REQUIRES_SIGN_OUT', noOrigin: 'ORIGIN_DENIED',
    ehrHost: 'TURNSTILE_CONTEXT_MISMATCH', bothModes: 400, neither: 400, networkLimit: { perHour: 20, refused: 429 } };

  // ── 7. Accept as a new account; sign in on the role's host ──
  expectProblem(await acceptInvitation(invitationCookie(amakaLink), 'Too-short-1'), 400, 'VALIDATION_FAILED');
  expectProblem(await acceptInvitation(undefined, invitationPassword), 401, 'STAFF_INVITATION_SESSION_INVALID');
  // The pre-check's budget: a spent session ends before any hash.
  await owner.query('update identity.staff_invitations set accept_attempts = 5 where id=$1', [amaka.invitationId]);
  expectProblem(await acceptInvitation(invitationCookie(amakaLink), invitationPassword), 401, 'STAFF_INVITATION_SESSION_INVALID');
  assert.equal((await invitationRow(amaka.invitationId)).has_session, false);
  assert.equal(await newAccountOf(amakaEmail), undefined);
  const amakaReopened = await openedAs(byLink(amakaResent), 'new');
  const amakaAccepted = await acceptInvitation(invitationCookie(amakaReopened), invitationPassword);
  assert.equal(amakaAccepted.status, 200, `accept: ${JSON.stringify(amakaAccepted.body)}`);
  assert.deepEqual(amakaAccepted.body, { accepted: true, facilityName: hospital.facilityName, roleCode: 'doctor' });
  assert.match(setCookies(amakaAccepted).find(value => value.startsWith('hid_staff_invitation=')) ?? '',
    /^hid_staff_invitation=;.*Expires=Thu, 01 Jan 1970/i);
  assert(!setCookies(amakaAccepted).some(value => value.startsWith(cookieName)), 'Accepting issued a session');
  assert.equal(amakaAccepted.headers['x-csrf-token'], undefined);
  expectProblem(await acceptInvitation(invitationCookie(amakaReopened), invitationPassword), 401,
    'STAFF_INVITATION_SESSION_INVALID');
  const amakaAccount = await newAccountOf(amakaEmail);
  const amakaRows = (await owner.query(`select a.subject, a.status, a.email_verified_at is not null verified,
      a.password_algorithm, s.full_name, s.verification_status, s.default_role, s.license_number, m.membership_role,
      m.app_role, m.is_primary, m.active, r.role_code, r.granted_by, t.verification_method, t.licence_number,
      t.attested_person_name, t.attested_by_account_id, t.invitation_id
    from auth.accounts a join identity.staff s on s.account_id = a.id
    join identity.staff_facility_memberships m on m.account_id = a.id
    join auth.account_roles r on r.membership_id = m.id and r.revoked_at is null
    join identity.staff_licence_attestations t on t.role_grant_id = r.id
    where a.id=$1`, [amakaAccount])).rows;
  assert.deepEqual(amakaRows, [{ subject: `staff-invitation:${amakaAccount}`, status: 'active', verified: true,
    password_algorithm: 'argon2id', full_name: 'Amaka Eze', verification_status: 'verified', default_role: 'doctor',
    license_number: null, membership_role: 'doctor', app_role: 'doctor', is_primary: true, active: true, role_code: 'doctor',
    granted_by: hospital.accountId, verification_method: 'facility_attestation', licence_number: 'MDCN/55555',
    attested_person_name: 'Amaka Eze', attested_by_account_id: hospital.accountId, invitation_id: amaka.invitationId }]);
  assert.deepEqual((await invitationRow(amaka.invitationId)).accepted_account_case, 'new');
  assert.deepEqual((await owner.query(`select actor_type, facility_id, details from audit.events
    where action='identity.staff-invitation.accept' and resource_id=$1`, [amaka.invitationId])).rows,
  [{ actor_type: 'system', facility_id: hospital.facilityId,
    details: { invitationId: amaka.invitationId, roleCode: 'doctor', licenceBody: 'MDCN' } }]);
  let amakaSession = await signedIn(amakaEmail, invitationPassword, 'ehr', hospital.facilityId);
  const amakaView = await facilityPermissions(amakaSession, hospital.facilityId);
  assert.deepEqual(amakaView.permissions, await permissionsOf('doctor'));
  assert.deepEqual(amakaView.selfService, { review: 'reviewed', organizationType: 'hospital' });
  p4b.accept = { weakPassword: 400, noCookie: 401, spentBudget: '401 before any hash, session ended', status: 200,
    answer: Object.keys(amakaAccepted.body).sort(), cookieCleared: true, sessionIssued: false, again: 401,
    account: 'staff-invitation:<id>, email verified, active', staff: 'verified, license_number not written',
    membership: 'doctor, primary', attestation: 'facility_attestation by the administrator',
    audit: 'system {invitationId, roleCode, licenceBody}', signIn: { host: 'ehr.* (staff-login)', permissions: 'doctor' } };

  // ── 8 and 14. A governed facility: no staff page; its administrator joins as existing staff ──
  const governedHash = await argon2.hash(invitationPassword, { type: argon2.argon2id });
  const governedFixture = { organizationId: randomUUID(), facilityId: randomUUID(), accountId: randomUUID(), staffId: randomUUID(),
    membershipId: randomUUID(), email: email('governed-admin') };
  sensitive.add(governedFixture.email);
  await owner.query(`insert into identity.organizations (id, name, slug) values ($1, 'Governed Runtime Hospital', $2)`,
    [governedFixture.organizationId, `governed-runtime-${governedFixture.organizationId.slice(0, 8)}`]);
  await owner.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
    values ($1, $2, 'Governed Runtime Hospital', $3, 'Africa/Lagos', true, 'verified')`,
  [governedFixture.facilityId, governedFixture.organizationId, `GOV-${governedFixture.facilityId.slice(0, 8)}`]);
  await owner.query(`insert into auth.accounts (id, subject, email, display_name, password_hash, password_algorithm, status)
    values ($1, $2, $3, 'Governed Administrator', $4, 'argon2id', 'active')`,
  [governedFixture.accountId, `synthetic:governed:${governedFixture.accountId}`, governedFixture.email, governedHash]);
  await owner.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
    values ($1, $2, 'Governed Administrator', $3, 'verified', 'org_admin')`, [governedFixture.staffId, governedFixture.accountId, governedFixture.email]);
  await owner.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, 'org_admin', 'org_admin', true, true)`,
  [governedFixture.membershipId, governedFixture.staffId, governedFixture.accountId, governedFixture.organizationId, governedFixture.facilityId]);
  await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id,
      grant_reason) values ($1, $2, 'org_admin', 'facility', $3, $4, 'Synthetic governed administrator')`,
  [randomUUID(), governedFixture.accountId, governedFixture.membershipId, governedFixture.facilityId]);
  const governedAdmin = await signedIn(governedFixture.email, invitationPassword, 'ehr', governedFixture.facilityId);
  const governedView = await facilityPermissions(governedAdmin, governedFixture.facilityId);
  assert.deepEqual(governedView.permissions, await permissionsOf('org_admin'));
  assert.equal(governedView.permissions.length, 9);
  assert.equal(governedView.selfService, undefined, 'A governed facility carries selfService');
  expectProblem(await staffCall(governedAdmin, 'get', '/identity/facility-staff'), 403, 'STAFF_MANAGEMENT_NOT_AVAILABLE');
  expectProblem(await invite(governedAdmin, { name: 'Gov Desk', email: email('gov-desk'), role: 'receptionist' }), 403,
    'STAFF_MANAGEMENT_NOT_AVAILABLE');
  p4b.governed = { staffPage: 'STAFF_MANAGEMENT_NOT_AVAILABLE', invite: 'STAFF_MANAGEMENT_NOT_AVAILABLE',
    selfService: 'absent', permissions: 'org_admin\'s nine' };
  // The hospital invites the governed administrator's email as a nurse.
  const governedInvite = await invited(hospitalAdmin, { name: 'Gabriel Okon', email: governedFixture.email, role: 'nurse',
    licenceBody: 'NMCN', licenceNumber: 'NMCN/27182' });
  const governedOpened = await openedAs(byLink(governedInvite.sent), 'existing_staff');
  assert.equal(invitationCookie(governedOpened), undefined, 'An existing staff member got an accountless session');
  const signedInPath = '/identity/staff-invitations/signed-in';
  const governedAuditBefore = await count('select count(*)::int n from audit.events where facility_id=$1', [governedFixture.facilityId]);
  const signedInMarker = Number((await owner.query('select max(sequence_id)::bigint n from audit.events')).rows[0].n);
  // Another person's invitation: email mismatch (link mode).
  expectProblem(await staffCall(governedAdmin, 'post', `${signedInPath}/preview`, byLink(bisiSent), { facility: null }), 409,
    'STAFF_INVITATION_EMAIL_MISMATCH');
  expectProblem(await staffCall(governedAdmin, 'post', `${signedInPath}/preview`, byLink(governedInvite.sent),
    { facility: null, origin: 'https://evil.example' }), 403);
  const governedPreview = await staffCall(governedAdmin, 'post', `${signedInPath}/preview`, byLink(governedInvite.sent),
    { facility: null });
  assert.equal(governedPreview.status, 200, `signed-in preview: ${JSON.stringify(governedPreview.body)}`);
  assert.deepEqual({ ...governedPreview.body, expiresAt: undefined }, { invitationId: governedInvite.invitationId,
    facilityId: hospital.facilityId, facilityName: hospital.facilityName, roleCode: 'nurse', inviterName: 'Ngozi Adeyemi',
    expiresAt: undefined });
  const governedAccepted = await staffCall(governedAdmin, 'post', `${signedInPath}/accept`, byLink(governedInvite.sent),
    { facility: null });
  assert.equal(governedAccepted.status, 200, `signed-in accept: ${JSON.stringify(governedAccepted.body)}`);
  assert.deepEqual({ ...governedAccepted.body, membershipId: undefined }, { accepted: true, facilityId: hospital.facilityId,
    membershipId: undefined, facilityName: hospital.facilityName, roleCode: 'nurse' });
  assert.equal(await count('select count(*)::int n from audit.events where facility_id=$1', [governedFixture.facilityId]),
    governedAuditBefore, 'The signed-in routes wrote an audit row at the governed facility');
  assert.deepEqual((await owner.query(`select actor_type, actor_account_id, actor_membership_id, facility_id, details
    from audit.events where action='identity.staff-invitation.accept' and resource_id=$1`, [governedInvite.invitationId])).rows,
  [{ actor_type: 'staff', actor_account_id: governedFixture.accountId, actor_membership_id: governedAccepted.body.membershipId,
    facility_id: hospital.facilityId, details: { invitationId: governedInvite.invitationId, roleCode: 'nurse',
      licenceBody: 'NMCN' } }]);
  // What the signed-in calls wrote: the email mismatch and the preview none;
  // the foreign Origin only the guard's facility-less authorization denial
  // (every route's); the accept one row, its command's, at the inviting facility.
  assert.deepEqual((await owner.query(`select action, outcome, facility_id from audit.events
    where actor_account_id=$1 and sequence_id > $2 order by sequence_id`, [governedFixture.accountId, signedInMarker])).rows,
  [{ action: 'auth.authorization.denied', outcome: 'denied', facility_id: null },
    { action: 'identity.staff-invitation.accept', outcome: 'success', facility_id: hospital.facilityId }]);
  const governedBoth = await facilityPermissions(governedAdmin, hospital.facilityId);
  assert.deepEqual(governedBoth.facilities, [{ id: governedFixture.facilityId, isPrimary: true, selfService: undefined },
    { id: hospital.facilityId, isPrimary: false, selfService: { review: 'reviewed', organizationType: 'hospital' } }]);
  assert.deepEqual(governedBoth.permissions, await permissionsOf('nurse'));
  expectProblem(await staffCall(governedAdmin, 'post', `${signedInPath}/accept`, byLink(governedInvite.sent),
    { facility: null }), 409, 'STAFF_INVITATION_ALREADY_ACCEPTED');
  p4b.existingStaff = { open: 'existing_staff, no cookie', emailMismatch: 'STAFF_INVITATION_EMAIL_MISMATCH',
    preview: 200, accept: 200, noFacilityHeader: true, noAuditAtOwnFacility: true,
    acceptAudit: 'staff, the new membership, at the inviting facility', interceptorRows: 0,
    facilities: 'governed primary, hospital non-primary', selectedPermissions: 'nurse', again: 'STAFF_INVITATION_ALREADY_ACCEPTED' };
  // A member is not invited again; another facility's invitation is accepted
  // signed in by its typed code (bound to the session's own email).
  expectProblem(await invite(hospitalAdmin, { name: 'Gabriel Okon', email: governedFixture.email, role: 'nurse',
    licenceBody: 'NMCN', licenceNumber: 'NMCN/27182' }), 409, 'STAFF_INVITATION_ALREADY_MEMBER');
  const governedAtLab = await invited(labAdmin, { name: 'Gabriel Okon', email: governedFixture.email, role: 'receptionist' });
  expectProblem(await staffCall(governedAdmin, 'post', `${signedInPath}/preview`, { code: wrongTypedCode(governedAtLab.sent) },
    { facility: null }), 401, 'STAFF_INVITATION_CODE_INVALID');
  const typedPreview = await staffCall(governedAdmin, 'post', `${signedInPath}/preview`, { code: governedAtLab.sent.body.code },
    { facility: null });
  assert.equal(typedPreview.status, 200, `typed signed-in preview: ${JSON.stringify(typedPreview.body)}`);
  assert.deepEqual([typedPreview.body.invitationId, typedPreview.body.facilityId, typedPreview.body.roleCode,
    typedPreview.body.inviterName], [governedAtLab.invitationId, laboratory.facilityId, 'receptionist', 'Kunle Bakare']);
  const typedAccepted = await staffCall(governedAdmin, 'post', `${signedInPath}/accept`, { code: governedAtLab.sent.body.code },
    { facility: null });
  assert.equal(typedAccepted.status, 200, `typed signed-in accept: ${JSON.stringify(typedAccepted.body)}`);
  assert.deepEqual([typedAccepted.body.facilityId, typedAccepted.body.roleCode], [laboratory.facilityId, 'receptionist']);
  // An account holding a platform role cannot join a facility: Facility A's
  // administrator also holds platform_super_admin (P4's reviewer path above).
  const clinicAdmin = await signedIn(emailA, password, 'ehr', facilityId);
  sensitive.add(emailA);
  const platformInvite = await invited(hospitalAdmin, { name: 'Clinic Owner', email: emailA, role: 'receptionist' });
  const platformOpened = await openedAs(byLink(platformInvite.sent), 'unavailable');
  assert.equal(invitationCookie(platformOpened), undefined);
  expectProblem(await staffCall(clinicAdmin, 'post', `${signedInPath}/preview`, byLink(platformInvite.sent), { facility: null }),
    409, 'STAFF_INVITATION_ACCOUNT_UNAVAILABLE');
  p4b.existingStaff.alreadyMember = 'STAFF_INVITATION_ALREADY_MEMBER';
  p4b.existingStaff.typedMode = { wrongCode: 401, preview: 200, accept: 200, facility: 'laboratory' };
  p4b.existingStaff.platformAccount = { open: 'unavailable (no session)', signedIn: 'STAFF_INVITATION_ACCOUNT_UNAVAILABLE' };

  // ── 9. A patient's email: refused with guidance; a patient account appearing meanwhile ──
  const patientEmail = email('invitee-patient');
  const patientAccount = randomUUID();
  await owner.query(`insert into auth.accounts (id, subject, email, display_name, status) values ($1, $2, $3, 'Patient Person',
    'active')`, [patientAccount, `synthetic:patient:${patientAccount}`, patientEmail]);
  await owner.query(`insert into identity.patients (id, hid_code, first_name, last_name, full_name, status, account_id)
    values ($1, 'HID-P4BVPATNT', 'Patient', 'Person', 'Patient Person', 'active', $2)`, [randomUUID(), patientAccount]);
  const patientInvite = await invited(hospitalAdmin, { name: 'Patient Person', email: patientEmail, role: 'receptionist' });
  assert.equal(patientInvite.deliveryOutcome, 'accepted', 'An invitation answered differently for a patient email');
  const patientOpened = await openedAs(byLink(patientInvite.sent), 'patient_account');
  assert.equal(invitationCookie(patientOpened), undefined);
  assert.equal(patientOpened.body.linkRequired, false);
  expectProblem(await acceptInvitation(undefined, invitationPassword), 401, 'STAFF_INVITATION_SESSION_INVALID');
  const raceEmail = email('invitee-race');
  const raceInvite = await invited(hospitalAdmin, { name: 'Race Person', email: raceEmail, role: 'receptionist' });
  const raceOpened = await openedAs(byLink(raceInvite.sent), 'new');
  const raceAccount = randomUUID();
  await owner.query(`insert into auth.accounts (id, subject, email, display_name, status) values ($1, $2, $3, 'Race Person',
    'active')`, [raceAccount, `synthetic:patient:${raceAccount}`, raceEmail]);
  await owner.query(`insert into identity.patients (id, hid_code, first_name, last_name, full_name, status, account_id)
    values ($1, 'HID-P4BVRACEP', 'Race', 'Person', 'Race Person', 'active', $2)`, [randomUUID(), raceAccount]);
  expectProblem(await acceptInvitation(invitationCookie(raceOpened), invitationPassword), 409, 'STAFF_INVITATION_PATIENT_ACCOUNT');
  assert.equal(await count('select count(*)::int n from identity.staff where lower(email)=lower($1)', [raceEmail]), 0);
  // A new email that gains a Health ID staff account between open and accept.
  const existsEmail = email('invitee-exists');
  const existsInvite = await invited(hospitalAdmin, { name: 'Exists Person', email: existsEmail, role: 'receptionist' });
  const existsOpened = await openedAs(byLink(existsInvite.sent), 'new');
  const existsAccount = randomUUID();
  await owner.query(`insert into auth.accounts (id, subject, email, display_name, status) values ($1, $2, $3, 'Exists Person',
    'active')`, [existsAccount, `synthetic:exists:${existsAccount}`, existsEmail]);
  await owner.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
    values ($1, $2, 'Exists Person', $3, 'verified', 'receptionist')`, [randomUUID(), existsAccount, existsEmail]);
  expectProblem(await acceptInvitation(invitationCookie(existsOpened), invitationPassword), 409,
    'STAFF_INVITATION_ACCOUNT_EXISTS');
  p4b.patientEmail = { invite: 201, open: 'patient_account (no session)', becomesPatientBeforeAccept: 'STAFF_INVITATION_PATIENT_ACCOUNT',
    converted: false, gainsStaffAccountBeforeAccept: 'STAFF_INVITATION_ACCOUNT_EXISTS' };

  // ── 10. Remove a member; they come back as dormant staff ──
  const consentPatient = await syntheticPatient();
  const amakaMembership = await membershipOf(amakaAccount, hospital.facilityId);
  const amakaGrant = await seedGrant(amakaMembership.id, consentPatient, false);
  const endPath = `/identity/facility-staff/${amakaMembership.id}/end`;
  const endBody = { expectedVersion: Number(amakaMembership.row_version), reason: 'Left the facility at the end of her contract',
    currentPassword: password };
  expectProblem(await staffCall(hospitalAdmin, 'post', endPath, { ...endBody, currentPassword: 'Not-The-Password-2026' }), 403,
    'STAFF_REAUTHENTICATION_FAILED');
  expectProblem(await staffCall(hospitalAdmin, 'post', `/identity/facility-staff/${hospitalMembership.id}/end`,
    { ...endBody, expectedVersion: Number((await membershipOf(hospital.accountId, hospital.facilityId)).row_version) }),
  409, 'FACILITY_STAFF_SELF');
  const ended = await staffCall(hospitalAdmin, 'post', endPath, endBody);
  assert.equal(ended.status, 200, `end: ${JSON.stringify(ended.body)}`);
  assert.deepEqual({ ...ended.body, endedAt: undefined }, { version: endBody.expectedVersion + 1, endedAt: undefined,
    grantsRevoked: 1 });
  expectProblem(await sessionRead(amakaSession), 401);
  assert.deepEqual((await owner.query('select status, revoked_reason from identity.consent_grants where id=$1', [amakaGrant])).rows,
    [{ status: 'revoked', revoked_reason: 'Staff member removed from the facility' }]);
  assert.deepEqual((await owner.query(`select actor_type, patient_id, facility_id from audit.events
    where action='identity.consent-grant.close' and resource_id=$1`, [amakaGrant])).rows,
  [{ actor_type: 'staff', patient_id: consentPatient.id, facility_id: hospital.facilityId }]);
  assert.deepEqual(await activeFacilityRoles(amakaAccount, hospital.facilityId), []);
  expectProblem(await staffCall(hospitalAdmin, 'post', endPath, { ...endBody, expectedVersion: ended.body.version }), 409,
    'FACILITY_STAFF_ALREADY_ENDED');
  // Re-invited: typed mode needs the link; the link sets a new password.
  const amakaAgain = await invited(hospitalAdmin, { name: 'Amaka Eze', email: amakaEmail, role: 'doctor', licenceBody: 'MDCN',
    licenceNumber: 'MDCN/55555' });
  const dormantTyped = await openedAs(byCode(amakaAgain.sent), 'dormant_staff');
  assert.equal(dormantTyped.body.linkRequired, true);
  assert.equal(invitationCookie(dormantTyped), undefined, 'Typed mode opened a session for a dormant account');
  const dormantOpened = await openedAs(byLink(amakaAgain.sent), 'dormant_staff');
  assert.equal(dormantOpened.body.linkRequired, false);
  const newDormantPassword = 'Synthetic-Dormant-Password-2027';
  // The session is bound to the account's versions: a change meanwhile refuses it.
  await owner.query('update auth.accounts set row_version = row_version + 1 where id=$1', [amakaAccount]);
  expectProblem(await acceptInvitation(invitationCookie(dormantOpened), newDormantPassword), 409,
    'STAFF_INVITATION_ACCOUNT_CHANGED');
  const dormantReopened = await openedAs(byLink(amakaAgain.sent), 'dormant_staff');
  const amakaBefore = (await owner.query('select token_version, row_version from auth.accounts where id=$1', [amakaAccount])).rows[0];
  expectProblem(await signIn(amakaEmail, invitationPassword), 401);
  assert(await count('select count(*)::int n from auth.sessions where account_id=$1 and revoked_at is null', [amakaAccount]) >= 1,
    'The ended member has no session left for the dormant acceptance to end');
  const dormantAccepted = await acceptInvitation(invitationCookie(dormantReopened), newDormantPassword);
  assert.equal(dormantAccepted.status, 200, `dormant accept: ${JSON.stringify(dormantAccepted.body)}`);
  const amakaAfter = (await owner.query('select token_version, row_version from auth.accounts where id=$1', [amakaAccount])).rows[0];
  assert.equal(Number(amakaAfter.token_version), Number(amakaBefore.token_version) + 1);
  assert.equal(await count(`select count(*)::int n from auth.sessions where account_id=$1 and revoked_at is null`,
    [amakaAccount]), 0, 'A dormant password set left a session live');
  const reusedMembership = await membershipOf(amakaAccount, hospital.facilityId);
  assert.deepEqual([reusedMembership.id, reusedMembership.active, reusedMembership.membership_role],
    [amakaMembership.id, true, 'doctor'], 'The dormant acceptance did not reuse the ended membership');
  assert.equal((await invitationRow(amakaAgain.invitationId)).accepted_account_case, 'dormant_staff');
  expectProblem(await signIn(amakaEmail, invitationPassword), 401);
  amakaSession = await signedIn(amakaEmail, newDormantPassword, 'ehr', hospital.facilityId);
  assert.deepEqual((await facilityPermissions(amakaSession, hospital.facilityId)).permissions, await permissionsOf('doctor'));
  p4b.dormant = { wrongPassword: 'STAFF_REAUTHENTICATION_FAILED', self: 'FACILITY_STAFF_SELF', end: 200, grantsRevoked: 1,
    consentCloseAudit: 'staff, with the patient', nextRequest: 401, endedAgain: 'FACILITY_STAFF_ALREADY_ENDED',
    typed: 'dormant_staff, linkRequired, no session', link: 'dormant_staff with a session', accept: 200,
    tokenVersionBumped: true, sessionsRevoked: true, membershipReused: true, oldPassword: 401, newPassword: 200 };

  // ── 11. Change a member's role: nurse to doctor ──
  const bisiOpened = await openedAs(byLink(bisiSent), 'new');
  const bisiAccepted = await acceptInvitation(invitationCookie(bisiOpened), invitationPassword);
  assert.equal(bisiAccepted.status, 200, `Bisi accept: ${JSON.stringify(bisiAccepted.body)}`);
  const bisiAccount = await newAccountOf(bisiEmail);
  const bisiSession = await signedIn(bisiEmail, invitationPassword, 'ehr', hospital.facilityId);
  assert.deepEqual((await facilityPermissions(bisiSession, hospital.facilityId)).permissions, await permissionsOf('nurse'));
  const bisiMembership = await membershipOf(bisiAccount, hospital.facilityId);
  const rolePathOf = id => `/identity/facility-staff/${id}/role`;
  const roleBody = { expectedVersion: Number(bisiMembership.row_version), role: 'doctor', licenceBody: 'MDCN',
    licenceNumber: 'MDCN/77777', attested: true, reason: 'Qualified as a doctor this month', currentPassword: password };
  sensitive.add('MDCN/77777');
  expectProblem(await staffCall(hospitalAdmin, 'post', rolePathOf(bisiMembership.id), { ...roleBody,
    currentPassword: 'Not-The-Password-2026' }), 403, 'STAFF_REAUTHENTICATION_FAILED');
  expectProblem(await staffCall(hospitalAdmin, 'post', rolePathOf(bisiMembership.id), { ...roleBody, licenceBody: undefined,
    licenceNumber: undefined }), 400, 'VALIDATION_FAILED');
  const changedRole = await staffCall(hospitalAdmin, 'post', rolePathOf(bisiMembership.id), roleBody);
  assert.equal(changedRole.status, 200, `role change: ${JSON.stringify(changedRole.body)}`);
  assert.deepEqual(changedRole.body, { version: roleBody.expectedVersion + 1, roleCode: 'doctor' });
  const bisiNow = await sessionRead(bisiSession);
  assert.equal(bisiNow.status, 200);
  assert.deepEqual([...bisiNow.body.actor.permissions].sort(), await permissionsOf('doctor'),
    'The role change did not apply at the next request');
  expectProblem(await staffCall(hospitalAdmin, 'post', rolePathOf(bisiMembership.id), { ...roleBody,
    expectedVersion: changedRole.body.version }), 409, 'FACILITY_STAFF_ROLE_UNCHANGED');
  const relicensed = await staffCall(hospitalAdmin, 'post', rolePathOf(bisiMembership.id), { ...roleBody,
    expectedVersion: changedRole.body.version, licenceNumber: 'MDCN/77778' });
  assert.equal(relicensed.status, 200, `licence-only change: ${JSON.stringify(relicensed.body)}`);
  sensitive.add('MDCN/77778');
  assert.equal(await count('select count(*)::int n from identity.staff_licence_attestations where account_id=$1', [bisiAccount]), 3);
  expectProblem(await staffCall(hospitalAdmin, 'post', rolePathOf(bisiMembership.id), { ...roleBody, role: 'nurse',
    licenceBody: 'NMCN', licenceNumber: 'NMCN/31415' }), 409, 'VERSION_CONFLICT');
  expectProblem(await staffCall(hospitalAdmin, 'post', rolePathOf(hospitalMembership.id), { ...roleBody,
    expectedVersion: Number((await membershipOf(hospital.accountId, hospital.facilityId)).row_version) }), 409,
  'FACILITY_STAFF_SELF');
  p4b.roleChange = { wrongPassword: 'STAFF_REAUTHENTICATION_FAILED', noLicence: 400, status: 200,
    permissionsAtNextRequest: 'doctor', unchanged: 'FACILITY_STAFF_ROLE_UNCHANGED', licenceOnly: 200,
    attestations: 3, staleVersion: 409, administratorRow: 'FACILITY_STAFF_SELF' };

  // ── 12. Expiry and revocation ──
  const expiringEmail = email('invitee-expiring');
  const expiring = await invited(hospitalAdmin, { name: 'Ebuka Obi', email: expiringEmail, role: 'receptionist' });
  await owner.query('update identity.staff_invitations set expires_at = clock_timestamp() - interval \'1 minute\' where id=$1',
    [expiring.invitationId]);
  expectProblem(await openInvitation(byLink(expiring.sent)), 410, 'STAFF_INVITATION_EXPIRED');
  assert.equal((await invitationRow(expiring.invitationId)).status, 'expired');
  await ageInvitation(expiring.invitationId);
  const expiredResent = await staffCall(hospitalAdmin, 'post', `/identity/staff-invitations/${expiring.invitationId}/resend`,
    { expectedVersion: Number((await invitationRow(expiring.invitationId)).row_version) });
  assert.equal(expiredResent.status, 200, `resend expired: ${JSON.stringify(expiredResent.body)}`);
  sensitive.add(invitationEmails.at(-1).body.token); sensitive.add(invitationEmails.at(-1).body.code);
  await openedAs(byLink(invitationEmails.at(-1)), 'new');
  const revokedEmail = email('invitee-revoked');
  const revoking = await invited(hospitalAdmin, { name: 'Sola Ojo', email: revokedEmail, role: 'receptionist' });
  const revokePath = `/identity/staff-invitations/${revoking.invitationId}/revoke`;
  expectProblem(await staffCall(hospitalAdmin, 'post', revokePath, { expectedVersion: 2 }), 409, 'VERSION_CONFLICT');
  const revokedNow = await staffCall(hospitalAdmin, 'post', revokePath, { expectedVersion: 1 });
  assert.equal(revokedNow.status, 200, `revoke: ${JSON.stringify(revokedNow.body)}`);
  assert.deepEqual({ ...revokedNow.body, revokedAt: undefined }, { version: 2, revokedAt: undefined });
  expectProblem(await openInvitation(byLink(revoking.sent)), 410, 'STAFF_INVITATION_WITHDRAWN');
  expectProblem(await staffCall(hospitalAdmin, 'post', revokePath, { expectedVersion: 2 }), 409, 'STAFF_INVITATION_NOT_PENDING');
  await ageInvitation(revoking.invitationId);
  expectProblem(await staffCall(hospitalAdmin, 'post', `/identity/staff-invitations/${revoking.invitationId}/resend`,
    { expectedVersion: 2 }), 409, 'STAFF_INVITATION_NOT_PENDING');
  expectProblem(await staffCall(hospitalAdmin, 'post', `/identity/staff-invitations/${randomUUID()}/revoke`,
    { expectedVersion: 1 }), 404, 'STAFF_INVITATION_NOT_FOUND');
  p4b.expiry = { open: 'STAFF_INVITATION_EXPIRED', status: 'expired', resendAfterExpiry: 200, reopened: 'new' };
  p4b.revoke = { staleVersion: 409, status: 200, version: 2, open: 'STAFF_INVITATION_WITHDRAWN',
    again: 'STAFF_INVITATION_NOT_PENDING', resendRevoked: 'STAFF_INVITATION_NOT_PENDING', unknown: 'STAFF_INVITATION_NOT_FOUND' };

  // ── 13. Limits ──
  // Per facility and recipient: 3 invitations in 30 days.
  const repeatEmail = email('invitee-repeat');
  for (let index = 1; index <= 3; index += 1) {
    const repeated = await invited(hospitalAdmin, { name: 'Repeat Person', email: repeatEmail, role: 'receptionist' });
    const revokedRepeat = await staffCall(hospitalAdmin, 'post', `/identity/staff-invitations/${repeated.invitationId}/revoke`,
      { expectedVersion: 1 });
    assert.equal(revokedRepeat.status, 200);
  }
  expectProblem(await invite(hospitalAdmin, { name: 'Repeat Person', email: repeatEmail, role: 'receptionist' }), 429,
    'STAFF_INVITATION_RECIPIENT_LIMIT');
  // Across facilities: 5 emails a day to one person; the sixth is not sent and reads "unknown".
  const realAdmin = await signedIn(real.email, password, 'ehr', real.facilityId);
  const crossEmail = email('invitee-cross');
  const crossInvites = [];
  for (const who of [labAdmin, pharmacyAdmin, otherAdmin, realAdmin, clinicAdmin]) {
    const crossInvite = await invited(who, { name: 'Cross Person', email: crossEmail, role: 'receptionist' });
    assert.equal(crossInvite.deliveryOutcome, 'accepted');
    crossInvites.push(crossInvite);
  }
  const clinicOpened = await openedAs(byLink(crossInvites[4].sent), 'new');
  assert.equal(clinicOpened.body.inviterName, null, 'A display name with a reserved word was shown');
  const emailsBeforeSixth = invitationEmails.length;
  const inputsBeforeSixth = staffInvitationInputs.length;
  const sixthCross = await invite(hospitalAdmin, { name: 'Cross Person', email: crossEmail, role: 'receptionist' });
  assert.equal(sixthCross.status, 201, `sixth cross-facility invite: ${JSON.stringify(sixthCross.body)}`);
  assert.equal(sixthCross.body.deliveryOutcome, 'unknown');
  assert.equal(invitationEmails.length, emailsBeforeSixth, 'The sixth email of the day was sent');
  assert.equal(staffInvitationInputs.length, inputsBeforeSixth, 'Identity called notification-api for a held-back email');
  assert.deepEqual((await owner.query(`select dispatched, outcome from identity.staff_invitation_sends where invitation_id=$1`,
    [sixthCross.body.invitationId])).rows, [{ dispatched: false, outcome: 'suppressed' }]);
  const hospitalPage = await staffCall(hospitalAdmin, 'get', '/identity/facility-staff');
  assert.equal(hospitalPage.body.invitations.find(item => item.invitationId === sixthCross.body.invitationId).deliveryOutcome,
    'unknown');
  // An administrator whose account was recovered by code in the last 24 hours
  // cannot invite or resend; revoking stays available.
  await owner.query(`insert into auth.otp_challenges (account_id, recipient_hmac, purpose, channel, verifier_hmac,
      verifier_key_version, expires_at, max_attempts, consumed_at, verified_at, completion_token_hmac, completion_expires_at)
    values ($1, repeat('c', 64), 'PASSWORD_RESET', 'email', repeat('d', 64), 'local-v1',
      clock_timestamp() + interval '10 minutes', 5, clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 hour',
      repeat('e', 64), clock_timestamp() - interval '50 minutes')`,
  [otherProvider.accountId]);
  expectProblem(await invite(otherAdmin, { name: 'Held Person', email: email('invitee-held'), role: 'receptionist' }), 403,
    'STAFF_RECENT_RECOVERY_HOLD');
  await ageInvitation(crossInvites[2].invitationId);
  expectProblem(await staffCall(otherAdmin, 'post', `/identity/staff-invitations/${crossInvites[2].invitationId}/resend`,
    { expectedVersion: 1 }), 403, 'STAFF_RECENT_RECOVERY_HOLD');
  const revokedWhileHeld = await staffCall(otherAdmin, 'post', `/identity/staff-invitations/${crossInvites[2].invitationId}/revoke`,
    { expectedVersion: 1 });
  assert.equal(revokedWhileHeld.status, 200, `revoke while held: ${JSON.stringify(revokedWhileHeld.body)}`);
  // The first 30 days at the laboratory: 10 invitations a day.
  const kemiEmail = email('invitee-kemi');
  const kemi = await invited(labAdmin, { name: 'Kemi Lawal', email: kemiEmail, role: 'lab', licenceBody: 'MLSCN',
    licenceNumber: 'MLSCN/99881' });
  for (let index = 1; index <= 7; index += 1) {
    await invited(labAdmin, { name: 'Desk Person', email: email(`lab-desk-${index}`), role: 'receptionist' });
  }
  expectProblem(await invite(labAdmin, { name: 'Desk Person', email: email('lab-desk-11'), role: 'receptionist' }), 429,
    'STAFF_INVITATION_DAILY_LIMIT');
  const labPage = await staffCall(labAdmin, 'get', '/identity/facility-staff');
  assert.deepEqual([labPage.body.limits.invitationsToday, labPage.body.limits.invitationsPerDay, labPage.body.limits.emailsPerDay,
    labPage.body.canInvite, labPage.body.facility.firstThirtyDaysEndAt !== null], [10, 10, 20, false, true]);
  const kemiOpened = await openedAs(byLink(kemi.sent), 'new');
  assert.equal((await acceptInvitation(invitationCookie(kemiOpened), invitationPassword)).status, 200);
  const kemiSession = await signedIn(kemiEmail, invitationPassword, 'lab', laboratory.facilityId);
  assert.deepEqual((await facilityPermissions(kemiSession, laboratory.facilityId)).permissions, await permissionsOf('lab'));
  // Delivery pause at the pharmacy: a definitive failure recorded, nine more seeded, then paused.
  invitationOutcome = 'definitive_failure';
  const femiEmail = email('invitee-femi');
  const femi = await invited(pharmacyAdmin, { name: 'Femi Ojo', email: femiEmail, role: 'pharmacist', licenceBody: 'PCN',
    licenceNumber: 'PCN/80808' });
  invitationOutcome = 'accepted';
  assert.equal(femi.deliveryOutcome, 'definitive_failure');
  assert.equal((await invitationRow(femi.invitationId)).delivery_outcome, 'definitive_failure');
  await owner.query(`insert into identity.staff_invitation_sends (id, invitation_id, facility_id, invitee_email,
      sent_by_account_id, kind, link_token_hmac, email_code_hmac, dispatched, outcome, sent_at, outcome_at)
    select gen_random_uuid(), $1, $2, 'bounce-' || n || '@verifier.invalid', $3, 'resend', repeat('a', 64), repeat('b', 64),
      true, 'definitive_failure', clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 hour'
      from generate_series(1, 9) n`, [femi.invitationId, pharmacy.facilityId, pharmacy.accountId]);
  expectProblem(await invite(pharmacyAdmin, { name: 'Desk Person', email: email('pharmacy-desk'), role: 'receptionist' }), 429,
    'STAFF_INVITATION_DELIVERY_PAUSED');
  const pharmacyPage = await staffCall(pharmacyAdmin, 'get', '/identity/facility-staff');
  assert.deepEqual([pharmacyPage.body.facility.deliveryPaused, pharmacyPage.body.canInvite], [true, false]);
  assert.equal((await listedFacility(pharmacy, 'reviewed')).deliveryFailuresLastDay, 10);
  const femiOpened = await openedAs(byLink(femi.sent), 'new');
  assert.equal((await acceptInvitation(invitationCookie(femiOpened), invitationPassword)).status, 200);
  const femiSession = await signedIn(femiEmail, invitationPassword, 'pharmacy', pharmacy.facilityId);
  assert.deepEqual((await facilityPermissions(femiSession, pharmacy.facilityId)).permissions, await permissionsOf('pharmacist'));
  p4b.limits = { recipient: { perFacilityIn30Days: 3, fourth: 'STAFF_INVITATION_RECIPIENT_LIMIT' },
    recoveryHold: { invite: 'STAFF_RECENT_RECOVERY_HOLD', resend: 'STAFF_RECENT_RECOVERY_HOLD', revoke: 200 },
    crossFacility: { dispatchedToday: 5, sixth: 'deliveryOutcome unknown, not sent, send suppressed, listed unknown' },
    inviterNameWithReservedWord: null,
    firstThirtyDays: { invitationsPerDay: 10, eleventh: 'STAFF_INVITATION_DAILY_LIMIT', emailsPerDay: 20, canInvite: false },
    deliveryPause: { definitiveFailureRecorded: true, failuresIn24h: 10, next: 'STAFF_INVITATION_DELIVERY_PAUSED',
      deliveryPaused: true, supportCount: 10 },
    roleHosts: { lab: 'lab.* (lab-login) → lab', pharmacist: 'pharmacy.* (pharmacy-login) → pharmacist' } };

  // ── 15. Release ends the facility's invitations, members, consents and sessions ──
  const tundeEmail = email('invitee-tunde');
  const tunde = await invited(realAdmin, { name: 'Tunde Bello', email: tundeEmail, role: 'receptionist' });
  const tundeOpened = await openedAs(byLink(tunde.sent), 'new');
  assert.equal((await acceptInvitation(invitationCookie(tundeOpened), invitationPassword)).status, 200);
  const tundeSession = await signedIn(tundeEmail, invitationPassword, 'ehr', real.facilityId);
  const tundeAccount = await newAccountOf(tundeEmail);
  const tundeMembership = await membershipOf(tundeAccount, real.facilityId);
  const tundeGrant = await seedGrant(tundeMembership.id, await syntheticPatient(), false);
  const musa = await invited(realAdmin, { name: 'Musa Garba', email: email('invitee-musa'), role: 'receptionist' });
  const realFacilityVersion = (await owner.query('select row_version from identity.facilities where id=$1',
    [real.facilityId])).rows[0].row_version;
  assert([200, 201].includes((await adminPost(superAdmin, `/admin/facilities/${real.facilityId}/status`,
    { status: 'suspended', reason: 'Impostor reported after review' },
    { 'If-Match': `"${realFacilityVersion}"`, 'Idempotency-Key': `verifier-suspend-${randomUUID()}` })).status));
  const realAccountVersion = (await owner.query('select row_version from auth.accounts where id=$1', [real.accountId]))
    .rows[0].row_version;
  assert([200, 201].includes((await adminPost(superAdmin, `/admin/principals/${real.accountId}/status`,
    { status: 'disabled', reason: 'Impostor reported after review' },
    { 'If-Match': `"${realAccountVersion}"`, 'Idempotency-Key': `verifier-disable-${randomUUID()}` })).status));
  const realReleaseVersion = await applicationVersion(real.applicationId);
  const realReleased = await adminPost(superAdmin, `${facilitiesPath}/${real.applicationId}/release`,
    { reason: 'Impostor reported after review' }, { 'If-Match': `"${realReleaseVersion}"` });
  assert.equal(realReleased.status, 200, `release after review: ${JSON.stringify(realReleased.body)}`);
  assert.deepEqual((await owner.query(`select status, revoke_kind from identity.staff_invitations where id = any($1::uuid[])
    order by status`, [[musa.invitationId, crossInvites[3].invitationId]])).rows,
  [{ status: 'revoked', revoke_kind: 'release' }, { status: 'revoked', revoke_kind: 'release' }]);
  expectProblem(await openInvitation(byLink(musa.sent)), 410, 'STAFF_INVITATION_WITHDRAWN');
  assert.deepEqual((await owner.query(`select active from identity.staff_facility_memberships where facility_id=$1`,
    [real.facilityId])).rows.map(row => row.active), [false, false]);
  assert.equal((await owner.query(`select count(*)::int n from auth.account_roles where facility_id=$1 and revoked_at is null`,
    [real.facilityId])).rows[0].n, 0);
  assert.deepEqual((await owner.query('select status, revoked_reason from identity.consent_grants where id=$1', [tundeGrant])).rows,
    [{ status: 'revoked', revoked_reason: 'Facility sign-up released by platform support' }]);
  assert.deepEqual((await owner.query(`select actor_type, facility_id, patient_id is not null with_patient from audit.events
    where action='identity.consent-grant.close' and resource_id=$1`, [tundeGrant])).rows,
  [{ actor_type: 'system', facility_id: real.facilityId, with_patient: true }]);
  assert.deepEqual((await owner.query(`select revocation_reason from auth.sessions where account_id=$1`, [tundeAccount])).rows
    .map(row => row.revocation_reason), ['facility_sign_up_released']);
  expectProblem(await sessionRead(tundeSession), 401);
  const releaseDetails = (await owner.query(`select details from audit.events where action='admin.self-service-facility.release'
    and resource_id=$1`, [real.applicationId])).rows[0].details;
  assert.deepEqual([releaseDetails.revokedInvitations, releaseDetails.endedMemberships, releaseDetails.revokedGrants,
    releaseDetails.expiredRequests], [2, 2, 1, 0]);
  assert(releaseDetails.revokedSessions >= 1);
  const releasedGate = await reviewGate(tundeAccount, real.facilityId, 'receptionist');
  assert.deepEqual(releasedGate.ownerDirect, { code: 'P0001', message: 'FACILITY_RELEASED' });
  assert.deepEqual(releasedGate.runtimeThroughDefiner, { code: 'P0001', message: 'FACILITY_RELEASED' });
  assert.equal(releasedGate.runtimeDirect.code, '42501');
  p4b.trigger.released = { ownerDirect: 'FACILITY_RELEASED', runtimeThroughDefiner: 'FACILITY_RELEASED',
    runtimeDirect: '42501 (no table privilege)' };
  p4b.release = { status: 200, invitations: 'revoked (release)', invitationLink: 'STAFF_INVITATION_WITHDRAWN',
    memberships: 'ended', roles: 'revoked', consentGrant: 'revoked, system audit with the patient',
    memberSession: 'revoked facility_sign_up_released, next request 401',
    auditCounts: { revokedInvitations: 2, endedMemberships: 2, revokedGrants: 1, expiredRequests: 0,
      revokedSessions: releaseDetails.revokedSessions } };

  // ── 16. Support's reads ──
  const staffPanelPath = `/admin/facilities/${hospital.facilityId}/staff`;
  const panel = await adminGet(superAdmin, staffPanelPath);
  assert.equal(panel.status, 200, `staff panel: ${JSON.stringify(panel.body)}`);
  assert.deepEqual(panel.body.facility, { id: hospital.facilityId, name: hospital.facilityName,
    selfService: { review: 'reviewed', organizationType: 'hospital', productCode: 'ehr' } });
  const panelAmaka = panel.body.members.find(member => member.accountId === amakaAccount);
  assert.deepEqual([panelAmaka.licenceBody, panelAmaka.licenceNumber, panelAmaka.verificationMethod,
    panelAmaka.sameLicenceElsewhere >= 1, panelAmaka.nameMismatch, panelAmaka.attestedByName],
  ['MDCN', 'MDCN/55555', 'facility_attestation', true, false, 'Ngozi Adeyemi']);
  const panelAdmin = panel.body.members.find(member => member.accountId === hospital.accountId);
  assert.deepEqual([panelAdmin.licenceNumber, panelAdmin.verificationMethod], ['MDCN/67890', 'platform_review']);
  assert(panel.body.invitations.some(item => item.invitationId === chidi.invitationId && item.reference === reference));
  assert.equal((await adminGet(supportAdmin, staffPanelPath)).status, 200);
  expectProblem(await adminGet(identityReviewer, staffPanelPath), 403, 'PERMISSION_DENIED');
  expectProblem(await adminGet(superAdmin, `/admin/facilities/${randomUUID()}/staff`), 404, 'ADMIN_FACILITY_NOT_FOUND');
  assert(await count(`select count(*)::int n from audit.events where action='api.admin.facility-staff.read'
    and outcome='success' and actor_account_id=$1`, [superAdmin.accountId]) >= 1, 'Support\'s staff read was not audited');
  const found = await adminGet(superAdmin, `/admin/staff-invitations?reference=${reference.toLowerCase()}`);
  assert.equal(found.status, 200, `find: ${JSON.stringify(found.body)}`);
  assert.deepEqual(found.body.items.map(item => [item.invitationId, item.reference, item.facilityId, item.status]),
    [[chidi.invitationId, reference, hospital.facilityId, 'pending']]);
  expectProblem(await adminGet(superAdmin, '/admin/staff-invitations?reference=ZZZ'), 400, 'VALIDATION_FAILED');
  p4b.adminReads = { staffPanel: 200, facilityHeader: panel.body.facility.selfService, fullLicence: true,
    sameLicenceElsewhere: panelAmaka.sameLicenceElsewhere, supportAdmin: 200, identityReviewer: 403, unknownFacility: 404,
    audited: true, findByReference: 200, badReference: 400 };

  // ── 17. Audit: no secret, email, name or licence number; no account case at a facility ──
  const p4bRows = (await owner.query(`select action, facility_id, coalesce(details::text, '') || ' ' || coalesce(reason, '')
      || ' ' || coalesce(resource_id, '') as text from audit.events where sequence_id > $1`, [p4bAuditStart])).rows;
  for (const value of sensitive) {
    if (!value) continue;
    const leaked = p4bRows.find(row => row.text.includes(value));
    assert(!leaked, `An audit row (${leaked?.action}) carries a synthetic secret or personal value`);
  }
  assert(!p4bRows.some(row => row.facility_id && /accountCase|account_case/.test(row.text)),
    'A facility audit row carries the account case');
  p4b.audit = { rowsScanned: p4bRows.length, valuesChecked: sensitive.size, leaks: 0, accountCaseAtFacility: 0 };

  // ── 18. The staff context's cost: with and without the lateral state read ──
  const busyAccount = randomUUID(); const busyStaff = randomUUID();
  await owner.query(`insert into auth.accounts (id, subject, email, display_name, status) values ($1, $2, $3,
    'Busy Staff', 'active')`, [busyAccount, `synthetic:busy:${busyAccount}`, email('busy')]);
  await owner.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
    select $1, $2, 'Busy Staff', email, 'verified', 'doctor' from auth.accounts where id=$2`, [busyStaff, busyAccount]);
  await owner.query(`with orgs as (
      insert into identity.organizations (id, name, slug)
      select gen_random_uuid(), 'Busy Org ' || n, 'busy-org-' || n || '-' || left(md5(random()::text), 6)
        from generate_series(1, 1000) n returning id),
    facilities as (
      insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
      select gen_random_uuid(), orgs.id, 'Busy Facility', 'BUSY-' || left(replace(orgs.id::text, '-', ''), 12),
        'Africa/Lagos', true, 'verified' from orgs returning id, organization_id)
    insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active)
    select gen_random_uuid(), $1, $2, facilities.organization_id, facilities.id, 'receptionist', 'receptionist', false, true
      from facilities`, [busyStaff, busyAccount]);
  const runtime = module.get(DatabaseService);
  const previousSql = `${STAFF_MEMBERSHIPS_SQL}\n        order by membership.is_primary desc, facility.name, membership.facility_id`;
  const busySubject = `synthetic:busy:${busyAccount}`;
  const hospitalSubject = (await owner.query('select subject from auth.accounts where id=$1', [hospital.accountId])).rows[0].subject;
  // The two queries alternate (after a warm-up), so a cache or plan warmed by
  // one does not favour the other; p95 of 100 runs each.
  const p95 = samples => Number([...samples].sort((left, right) => left - right)[Math.ceil(samples.length * 0.95) - 1]
    .toFixed(2));
  const compare = async subject => {
    const runs = { withLateral: [], previous: [] };
    const once = async sql => {
      const begun = process.hrtime.bigint();
      await runtime.query(sql, [subject, ['verified', 'approved', 'active']]);
      return Number(process.hrtime.bigint() - begun) / 1e6;
    };
    for (let index = 0; index < 5; index += 1) { await once(STAFF_CONTEXT_SQL); await once(previousSql); }
    for (let index = 0; index < 100; index += 1) {
      runs.withLateral.push(await once(STAFF_CONTEXT_SQL));
      runs.previous.push(await once(previousSql));
    }
    return { withLateral: p95(runs.withLateral), previous: p95(runs.previous) };
  };
  const busyRows = (await runtime.query(STAFF_CONTEXT_SQL, [busySubject, ['verified', 'approved', 'active']])).rows.length;
  assert.equal(busyRows, 1000);
  // The wrapped query answers exactly the previous query's rows and order, plus the two state columns.
  const previousRows = (await runtime.query(previousSql, [busySubject, ['verified', 'approved', 'active']])).rows;
  const wrappedRows = (await runtime.query(STAFF_CONTEXT_SQL, [busySubject, ['verified', 'approved', 'active']])).rows;
  assert.deepEqual(wrappedRows.map(({ review_state: _state, organization_type: _type, ...row }) => row), previousRows);
  p4b.timing = { memberships: busyRows, sameRowsAsPrevious: true, p95Ms: { memberships1000: await compare(busySubject),
    memberships1: await compare(hospitalSubject) } };
  const sessionSamples = [];
  for (let index = 0; index < 40; index += 1) {
    const begun = process.hrtime.bigint();
    assert.equal((await sessionRead(hospitalAdmin)).status, 200);
    sessionSamples.push(Number(process.hrtime.bigint() - begun) / 1e6);
  }
  p4b.timing.p95Ms.httpSessionRead = p95(sessionSamples);

  // Both controls closed again: the public route answers 423.
  const closeInvitations = await adminPost(superAdmin, '/admin/controls', { controlKey: 'staff_invitations_enabled',
    enabled: false, reason: 'Close staff invitations after the runtime verifier' }, { 'If-Match': '"2"' });
  assert.equal(closeInvitations.status, 201, `closing invitations: ${JSON.stringify(closeInvitations.body)}`);
  await setSelfService(false, 'Close facility self sign-up after the P4b verifier');
  expectProblem(await openInvitation(byLink(amakaResent)), 423, 'STAFF_INVITATIONS_UNAVAILABLE');
  p4b.closedAgain = { open: 423, controls: ['provider_self_service_enabled off', 'staff_invitations_enabled off'] };
  p4b.emailsCaptured = invitationEmails.length;
  process.stdout.write(JSON.stringify({ status: 'passed', runtimeRole, database: rehearsal ? 'rehearsal' : 'loopback',
    flow: ['gate_closed', 'control_opened_by_platform_admin', 'origin', 'turnstile', 'accountless_start',
      'qoreid_cac_lookup', 'verified_cac', 'email_otp', 'otp_verification', 'activation', 'organization', 'facility',
      'org_admin_membership', 'account', 'ehr_product', 'staff_session', 'session_read', 'facility_selection',
      'password_sign_in', 'resume_without_lookup', 'details_from_proving_code', 'activation_precheck', 'lapse',
      'support_release', 'real_company_after_release', 'open_applications', 'database_gate', 'activation_budget',
      'platform_cap', 'support_review', 'control_closed', 'confirmation_read', 'no_code_answer',
      'registered_email_closes', 'governed_route_sends_no_self_service_code', 'renewal_without_hold',
      'open_list_ranked_searched', 'refusal_waiver', 'retry_rejection',
      'p4b_applicant_withdrawal', 'p4b_restricted_until_review', 'p4b_review_gate_trigger', 'p4b_own_licence',
      'p4b_review_unlock_and_sign_out', 'p4b_roles_by_type', 'p4b_administrator_role', 'p4b_first_30_days',
      'p4b_invitation_email', 'p4b_open_link_and_code', 'p4b_accept_new', 'p4b_existing_staff_signed_in',
      'p4b_patient_email_refused', 'p4b_remove_and_dormant', 'p4b_role_change', 'p4b_expiry_and_revoke', 'p4b_limits',
      'p4b_governed_unaffected', 'p4b_release', 'p4b_support_reads', 'p4b_audit_scan', 'p4b_staff_context_timing'],
    gate, security, quota, session, lapse, review, confirmation, noCode, p4b, qoreidCacLookups: qoreidCacLookups.length,
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
