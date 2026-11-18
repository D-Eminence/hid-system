#!/usr/bin/env node
// A staff member's chosen facility, kept per sign-in (0129, a port of main
// 0089 / hid-system#73; design note and decisions on hid-system#258), over
// HTTP through Identity's full request pipeline: the middleware, validation,
// problem filter, security guard and audit interceptor main.ts and AppModule
// install, with every query as the deployed runtime role
// hid_identity_api_runtime. It runs against the owned disposable synthetic
// rehearsal or, with HID_FACILITY_SELECTION_RUNTIME_LOCAL_CLUSTER=loopback,
// a loopback test cluster, always in a disposable copy of its database, once
// with STAFF_FACILITY_SELECTION_MODE off, once keep and once ask. Staff sign
// in with a password; there is no other boundary to stub and no network call
// is made (fetch is replaced by one that fails). The site Origins below are
// only request headers. All values are synthetic.
//
// Why it exists: the choice is stored and read in code paths that answer
// 200 whatever happens to the read (a failed read answers 'unavailable', and
// keep mode answers no field when nothing is stored), so a choice silently
// never stored, or a grant missing, would look like today's behaviour. The
// jest specs mock the database and call the controller directly, past the
// audit interceptor; this calls the real table through the real pipeline and
// fails loudly when:
//   1. a new sign-in's answer is not today's (keep) or 'default' (ask);
//   2. a choice is not stored as exactly one row of the sign-in, with its one
//      auth.facility.select audit row;
//   3. a reload (GET /auth/session) does not open at the chosen facility, or
//      a valid X-Facility-ID does not still decide;
//   4. a refresh does not keep it, or its auth.refresh row names another
//      facility;
//   5. another sign-in of the account sees it;
//   6. a sign-in on lab. is not independent of the ehr. one, a choice from a
//      site that does not admit the facility is stored, or a refresh from
//      another site is not 401 before any read;
//   7. a facility that is not the actor's, a sign-in that ended while the
//      choice waited, or the database guard's refusal, is not refused with
//      nothing stored (each answer as it is observed today: see
//      expectedUntilFailureAuditFix);
//   8. a membership ended through the facility's own staff route does not
//      give 'reselect' with the row kept;
//   9. service-session reads the choice or answers differently;
//  10. a failed read (SELECT revoked here, restored in finally) is not 200
//      'unavailable' on GET and on refresh (with the rotated cookies), or a
//      failed store is not 503; the start-up check misses any one grant;
//  11. a signed-out sign-in can still read its choice, or the row goes;
//  12. the PostgreSQL server log, outside the deliberate windows of steps 7
//      and 10, shows any error (permission denied, a missing relation or
//      column, an unexpected SESSION_FACILITY_SELECTION_INVALID).
// Patients get no read and no field in any mode, and with the setting off
// nothing is read or stored.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
const rehearsal = Boolean(socket?.startsWith('/tmp/hid-tuf-migration.')) && process.env.PGDATABASE === 'hid_rehearsal';
const loopback = process.env.HID_FACILITY_SELECTION_RUNTIME_LOCAL_CLUSTER === 'loopback'
  && ['127.0.0.1', '::1', 'localhost'].includes(socket ?? '')
  && /^[a-z][a-z0-9_]{0,40}$/.test(process.env.PGDATABASE ?? '');
assert(process.env.NODE_ENV === 'test' && (rehearsal || loopback),
  'Only the owned synthetic rehearsal or an explicitly named loopback test cluster is supported');
assert(process.env.AUTH_SIGNING_SECRET && process.env.AUTH_LOGIN_PEPPER, 'Synthetic session keys are required');
// Step 12 reads the cluster's server log: the rehearsal starts its cluster with
// pg_ctl -l <socket directory>/postgres.log; a loopback cluster names its own.
const serverLog = rehearsal ? join(socket, 'postgres.log') : process.env.HID_FACILITY_SELECTION_RUNTIME_SERVER_LOG;
assert(serverLog && statSync(serverLog, { throwIfNoEntry: false })?.isFile(),
  'The cluster server log is required (HID_FACILITY_SELECTION_RUNTIME_SERVER_LOG on a loopback cluster)');
const port = Number(process.env.PGPORT ?? 5432);
// A disposable copy, so the synthetic accounts, the opened sign-up control and
// step 10's revoked grant never reach later rehearsal steps.
const isolated = `${rehearsal ? 'hid_rehearsal' : process.env.PGDATABASE}_facsel_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
// Production hosts, as request headers only. Each staff product is its own
// site (Q88): ehr. and lab. here; app. for the patient sign-in.
const appOrigin = 'https://app.healthidentitydirectory.com';
const ehrOrigin = 'https://ehr.healthidentitydirectory.com';
const labOrigin = 'https://lab.healthidentitydirectory.com';
const serviceToken = 'public-synthetic-ehr-workload-token';
const runtimeOptions = `options=${encodeURIComponent('-c role=hid_identity_api_runtime')}`;
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', NIN_PROVIDER_MODE: 'unavailable', TURNSTILE_MODE: 'disabled',
  CORS_ORIGINS: [appOrigin, ehrOrigin, labOrigin].join(','), AUTH_MODE: 'local', DATABASE_SSL: 'false',
  // GET /auth/service-session's caller, as ehr-api calls it on a test cluster.
  IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: serviceToken,
  // Every Identity API connection runs as the deployed runtime role.
  DATABASE_URL: rehearsal
    ? `postgresql://${process.env.PGUSER ?? 'postgres'}@localhost:${port}/${isolated}?host=${encodeURIComponent(socket)}&${runtimeOptions}`
    : `postgresql://${process.env.PGUSER ?? 'postgres'}@${socket === '::1' ? '[::1]' : socket}:${port}/${isolated}?${runtimeOptions}` });
for (const key of ['AUTH_COOKIE_DOMAIN', 'HID_DEPLOYMENT_ENV', 'DATABASE_SSL_ROOT_CERT_BASE64',
  'STAFF_FACILITY_SELECTION_MODE']) delete process.env[key];
globalThis.fetch = async (input) => {
  throw new Error(`Unexpected outbound request to ${String(input instanceof Request ? input.url : input)}`);
};
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
const { FacilitySelectionStartupCheck, FACILITY_SELECTION_UNAVAILABLE_EVENT } = load('auth/facility-selection.ts');
const { FacilityStaffController } = load('identity/facility-staff.controller.ts');
const { FacilityStaffService } = load('identity/facility-staff.service.ts');
const { StaffInvitationsService } = load('identity/staff-invitations.service.ts');
const { StaffReauthenticationService } = load('identity/staff-reauthentication.service.ts');
const { CorrelationMiddleware } = load('common/correlation.middleware.ts');
const { preventResponseCaching } = load('common/response-security.middleware.ts');
const { DomainProblem, ProblemDetailsFilter } = load('common/problem.ts');
const { getEnvironment, resetEnvironmentForTests } = load('config/environment.ts');

// Every message Identity logs, kept in memory (stdout carries only the JSON
// result): the facility-selection events and the problem filter's 5xx record.
const logged = [];
const logger = {
  log() {}, debug() {}, verbose() {},
  warn: (message, context) => logged.push({ level: 'warn', message, context }),
  error: (message, ...rest) => logged.push({ level: 'error', message, context: rest.at(-1) }),
  fatal: (message, ...rest) => logged.push({ level: 'fatal', message, context: rest.at(-1) }),
};
const selectionEvents = () => logged.filter(entry => entry.message?.event === FACILITY_SELECTION_UNAVAILABLE_EVENT);
const failureFor = response => logged.find(entry => entry.level === 'error'
  && entry.message?.correlationId === response.body?.correlationId);

const maintenance = new Pool({ host: socket, port, user: process.env.PGUSER, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
// Fixture and assertion connection (the cluster administrator), never used by the API.
const owner = new Pool({ host: socket, port, user: process.env.PGUSER, database: isolated, max: 4 });
const logStart = statSync(serverLog).size;
const logWindows = [];
let readRevoked = false;
let revokedPrivilege;
let app;

// Boots Identity with one setting: AuthController and the start-up check read
// STAFF_FACILITY_SELECTION_MODE through getEnvironment(), parsed again here.
const boot = async (mode) => {
  process.env.STAFF_FACILITY_SELECTION_MODE = mode;
  resetEnvironmentForTests();
  assert.equal(getEnvironment().STAFF_FACILITY_SELECTION_MODE, mode);
  const module = await Test.createTestingModule({
    controllers: [AuthController, FacilityStaffController],
    providers: [DatabaseService, TokenService, LocalAuthProvider, CurrentStaffContextService,
      CurrentPatientContextService, AuthService, AuthSessionAuditService, AuditService, WorkloadAuthService,
      TurnstileService, FacilitySelectionStartupCheck, FacilityStaffService, StaffInvitationsService,
      StaffReauthenticationService,
      // Only staff invitations send email; ending a membership sends none.
      { provide: NotificationOtpClient, useValue: {} },
      { provide: GoogleAuthenticationService, useValue: {} }] }).compile();
  const runtimeRole = (await module.get(DatabaseService).query('select current_user as role')).rows[0].role;
  assert.equal(runtimeRole, 'hid_identity_api_runtime');
  const nest = module.createNestApplication({ logger, bodyParser: true });
  // Closed in finally, even when init() refuses to start.
  app = nest;
  nest.setGlobalPrefix('api/v1');
  // The middleware, validation, filter, guard and interceptor main.ts and AppModule install.
  nest.use(preventResponseCaching);
  nest.use(require('cookie-parser')());
  const correlation = new CorrelationMiddleware();
  nest.use((req, res, next) => correlation.use(req, res, next));
  nest.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
    exceptionFactory: errors => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
      errors.map(error => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
  nest.useGlobalFilters(new ProblemDetailsFilter());
  nest.useGlobalGuards(new SecurityGuard(module.get(Reflector), module.get(TokenService),
    module.get(AuditService), module.get(DatabaseService), module.get(WorkloadAuthService)));
  nest.useGlobalInterceptors(new AuditInterceptor(module.get(Reflector), module.get(AuditService)));
  // init() runs FacilitySelectionStartupCheck (keep and ask read the table's grants).
  await nest.init();
  // Counts the choice reads (TokenService.selectedFacilityId), changing nothing they do.
  const tokens = module.get(TokenService);
  const realRead = tokens.selectedFacilityId.bind(tokens);
  const counters = { reads: 0 };
  tokens.selectedFacilityId = async (...args) => { counters.reads += 1; return realRead(...args); };
  return { tokens, counters, http: request(nest.getHttpServer()), database: module.get(DatabaseService) };
};

try {
  const count = async (sql, values = []) => Number((await owner.query(sql, values)).rows[0].n);
  const password = 'Synthetic-Facility-Selection-2026';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  const suffix = () => randomUUID().slice(0, 8);
  const account = async (label) => {
    const id = randomUUID();
    const email = `${label}-${id.slice(0, 8)}@facility-selection.invalid`;
    await owner.query(`insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm)
      values ($1, $2, $3, $4, 'active', $5, 'argon2id')`,
    [id, `synthetic:facility-selection:${label}:${id}`, email, `Synthetic ${label}`, passwordHash]);
    return { id, email };
  };
  const organization = async (label) => {
    const id = randomUUID();
    await owner.query('insert into identity.organizations (id, name, slug) values ($1, $2, $3)',
      [id, `Selection ${label} Org`, `selection-${label.toLowerCase()}-${id.slice(0, 8)}`]);
    return id;
  };
  const facility = async (organizationId, label) => {
    const id = randomUUID();
    await owner.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
      values ($1, $2, $3, $4, 'Africa/Lagos', true, 'verified')`,
    [id, organizationId, `Selection ${label}`, `SEL-${id.slice(0, 8)}`]);
    return { id, organizationId };
  };

  // Fixture. A governed organisation G with Alpha, Delta and a laboratory
  // (Lab); another organisation H with Gamma, which no test staff member
  // works at; and a self-signed-up, reviewed hospital S (P4, P4b), whose own
  // facility is Beta and whose administrator ends a membership in step 8.
  const governed = await organization('Governed');
  const alpha = await facility(governed, 'Alpha');
  const delta = await facility(governed, 'Delta');
  const laboratory = await facility(governed, 'Lab');
  const gamma = await facility(await organization('Other'), 'Gamma');
  // S signs itself up and support reviews it, through 0086's own commands as
  // the Identity runtime (as the concurrency suite does), not by hand.
  const signedUp = await (async () => {
    const client = await owner.connect();
    try {
      await client.query('begin');
      const superAccount = await (async () => {
        const id = randomUUID();
        const subject = `synthetic:facility-selection:super:${id}`;
        await client.query(`insert into auth.accounts (id, subject, email, display_name, status)
          values ($1, $2, $3, 'Synthetic Selection Super Admin', 'active')`,
        [id, subject, `super-${id.slice(0, 8)}@facility-selection.invalid`]);
        await client.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
          values ($1, $2, 'platform_super_admin', 'platform', 'Synthetic platform administrator for the facility selection verifier')`,
        [randomUUID(), id]);
        return { id, subject };
      })();
      await client.query('set local role hid_identity_api_runtime');
      const as = (subject, correlation, purpose) => client.query(`select set_config('app.actor_subject', $1, true),
        set_config('app.correlation_id', $2, true), set_config('app.purpose_of_use', $3, true),
        set_config('app.facility_id', '', true), set_config('app.membership_id', '', true)`, [subject, correlation, purpose]);
      await as(superAccount.subject, 'facility-selection-open-signup', 'healthcare-operations');
      await client.query(`select platform.admin_set_control('provider_self_service_enabled', true,
        (select control.row_version from platform.admin_list_controls() control
          where control.control_key = 'provider_self_service_enabled'),
        'Facility selection verifier opens facility sign-up')`);
      await as('system:auth', 'facility-selection-signup', '');
      const cac = `RC99129${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
      const email = `admin-${suffix()}@facility-selection.invalid`;
      const applicationId = (await client.query(`select identity.submit_self_service_organization_application('ehr',
        'hospital', $1, 'Synthetic Selection Admin', $2) as id`, [cac, email])).rows[0].id;
      const current = (await client.query('select * from identity.public_get_organization_application($1, $2, $3)',
        [cac, email, 'ehr'])).rows[0];
      await client.query(`select identity.public_record_organization_cac_result($1, $2, 'verified', $3, $4,
        'Synthetic Selection Hospital Ltd', 'Private Company Limited by Shares', '2015-01-01', '1 Synthetic Road, Lagos', 'active')`,
      [applicationId, current.row_version, String(randomInt(1_000_000, 10_000_000)), cac]);
      const challengeId = randomUUID();
      await client.query(`select identity.begin_self_service_provider_enrollment($1, $2, 'ehr', $3, $4,
        'Synthetic Selection Admin', 'hospital')`, [cac, email, challengeId, sha256(`otp-${challengeId}`)]);
      await client.query('select identity.verify_organization_profile_completion_challenge($1, $2, $3)',
        [challengeId, sha256(`otp-${challengeId}`), sha256(`session-${challengeId}`)]);
      const activated = (await client.query('select * from identity.activate_self_service_provider_enrollment($1, $2)',
        [sha256(`session-${challengeId}`), passwordHash])).rows[0];
      await as(superAccount.subject, 'facility-selection-review', 'healthcare-operations');
      const listed = (await client.query(`select * from identity.admin_list_self_service_facilities('unreviewed') item
        where item.application_id = $1`, [applicationId])).rows[0];
      await client.query(`select identity.admin_review_self_service_facility($1, $2,
        'Checked the company and its administrator', 'none', 'cac_registered_contact', null, null)`,
      [applicationId, listed.row_version]);
      await client.query('commit');
      return { organizationId: activated.organization_id, facilityId: activated.facility_id,
        admin: { id: activated.account_id, email } };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  })();
  const beta = { id: signedUp.facilityId, organizationId: signedUp.organizationId };
  // A staff member: one verified staff record and an active membership (with
  // its role) at each [facility, primary, role].
  const staffMember = async (label, memberships) => {
    const created = await account(label);
    const staffId = randomUUID();
    await owner.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
      values ($1, $2, $3, $4, 'verified', 'doctor')`, [staffId, created.id, `Synthetic ${label}`, created.email]);
    const ids = {};
    for (const [where, primary, role] of memberships) {
      const membership = randomUUID();
      await owner.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id,
          facility_id, membership_role, app_role, is_primary, active)
        values ($1, $2, $3, $4, $5, $6, $6, $7, true)`,
      [membership, staffId, created.id, where.organizationId, where.id, role, primary]);
      await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id,
          grant_reason) values ($1, $2, $3, 'facility', $4, $5, 'Synthetic facility selection role')`,
      [randomUUID(), created.id, role, membership, where.id]);
      ids[where.id] = membership;
    }
    return { ...created, memberships: ids };
  };
  const patientAccount = await account('patient');
  await owner.query(`insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status)
    values ($1, $2, $3, 'Selection', 'Patient', 'Selection Patient', 'active')`,
  [randomUUID(), patientAccount.id,
    `HID-FS${Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(0, 32)]).join('')}`]);

  const rows = async accountId => (await owner.query(`select family_id::text, facility_id::text, membership_id::text,
      row_version::int from auth.session_facility_selection where account_id = $1 order by selected_at`, [accountId])).rows;
  const audits = async (action, sessionId) => (await owner.query(`select facility_id::text, actor_membership_id::text
      from audit.events where action = $1 and outcome = 'success' and resource_id = $2 order by sequence_id`,
  [action, sessionId])).rows;
  const latestSessionRead = async sessionId => (await audits('auth.session.read', sessionId)).at(-1);
  const logSize = () => statSync(serverLog).size;
  // A deliberate database error window for step 12: what it may log, and how often.
  const inLogWindow = async (label, pattern, expected, action) => {
    const from = logSize();
    try { return await action(); } finally { logWindows.push({ label, from, to: logSize(), pattern, expected }); }
  };
  // Polls until a request of the API waits on a row lock in the copy (step 7's races).
  const lockWaiter = async () => {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
      const waiting = await count(`select count(*)::int as n from pg_stat_activity where datname = current_database()
        and wait_event_type = 'Lock' and usename is not null and query ilike '%for share%'`);
      if (waiting > 0) return waiting;
      await new Promise(done => setTimeout(done, 20));
    }
    assert.fail('No API request waited at the presented session lock');
  };

  // TODO(hid-system#258, question 3: the failure-audit fix). Expected until
  // that fix lands: a refusal POST /auth/facility raises when the request
  // names no X-Facility-ID (the website sends none) reaches the browser as
  // 503 DEPENDENCY_UNAVAILABLE, not its own 401 or 403. AuditInterceptor
  // writes the failure row with no facility, and AuditService
  // .assertActorFacility refuses a staff row without one, so its
  // ServiceUnavailableException replaces the handler's answer (the problem
  // filter logs it as that exception type, checked here). Each such case is
  // listed in the result with the answer it gets after the fix, and is also
  // checked with a valid X-Facility-ID, where the failure row has a facility
  // and the handler's own answer comes through. When the fix lands, this
  // assertion fails: change it to assert `afterFix`.
  const expectedUntilFailureAuditFix = [];
  const refusedWithoutFacilityHeader = (response, label, afterFix) => {
    assert.equal(response.status, 503,
      `${label}: expected 503 until the failure-audit fix (hid-system#258 question 3): ${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, 'DEPENDENCY_UNAVAILABLE', label);
    assert.equal(failureFor(response)?.message?.exceptionType, 'ServiceUnavailableException',
      `${label}: the 503 did not come from the failure audit row`);
    expectedUntilFailureAuditFix.push({ case: label, observed: '503 DEPENDENCY_UNAVAILABLE', afterFix });
  };
  const problem = (response, status, code, label) => {
    assert.equal(response.status, status, `${label}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, code, `${label}: ${JSON.stringify(response.body)}`);
  };

  const results = {};
  for (const mode of ['off', 'keep', 'ask']) {
    const { http, counters, tokens, database } = await boot(mode);
    const name = getEnvironment().AUTH_COOKIE_NAME;
    // The session cookies a response sets; cleared ones (empty value) are dropped.
    const jar = response => Object.fromEntries((response.headers['set-cookie'] ?? []).map(value => value.split(';')[0])
      .map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]).filter(([, value]) => value));
    const cookie = held => Object.entries(held.cookies).map(([key, value]) => `${key}=${value}`).join('; ');
    const signIn = async (who, origin = ehrOrigin, action = 'ehr-login') => {
      const response = await http.post('/api/v1/auth/login').set('Origin', origin)
        .send({ email: who.email, password, turnstileAction: action });
      assert.equal(response.status, 200, `sign-in on ${origin}: ${JSON.stringify(response.body)}`);
      return { response, held: { cookies: jar(response), sessionId: response.body.actor.sessionId, origin } };
    };
    // A cookie mutation: Origin and CSRF, as the website sends it.
    const post = (held, path, body, { origin = held.origin, facility } = {}) => {
      let call = http.post(`/api/v1${path}`).set('Cookie', cookie(held)).set('Origin', origin)
        .set('x-csrf-token', held.cookies[`${name}_csrf`]);
      if (facility) call = call.set('X-Facility-ID', facility);
      return call.send(body);
    };
    const choose = (held, facilityId, options) => post(held, '/auth/facility', { facilityId }, options);
    // A reload: a same-origin GET, so no Origin; the website sends no X-Facility-ID on it.
    const read = (held, facility) => {
      const call = http.get('/api/v1/auth/session').set('Cookie', cookie(held));
      return facility ? call.set('X-Facility-ID', facility) : call;
    };
    const refresh = async (held, origin = held.origin) => {
      const response = await post(held, '/auth/refresh', {}, { origin });
      return { response, held: response.status === 200
        ? { ...held, cookies: { ...held.cookies, ...jar(response) }, sessionId: response.body.actor.sessionId } : held };
    };
    const serviceSession = held => http.get('/api/v1/auth/service-session').set('Cookie', cookie(held))
      .set('x-hid-internal-caller', 'ehr-api').set('x-hid-service-token', serviceToken);
    // The answer at a facility, with the field ('none' when it must be absent).
    const reports = (response, facilityId, state, label) => {
      assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.body)}`);
      if (state === 'none') assert.equal('facilitySelection' in response.body, false, `${label}: ${JSON.stringify(response.body)}`);
      else assert.equal(response.body.facilitySelection, state, `${label}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.actor.facility.id, facilityId, `${label}: at ${response.body.actor.facility?.id}`);
    };
    const reads = async (expected, label, action) => {
      const before = counters.reads;
      const result = await action();
      assert.equal(counters.reads - before, expected, `${label}: ${counters.reads - before} choice reads`);
      return result;
    };
    // No choice yet: today's answer in keep (and off), 'default' in ask.
    const unchosen = mode === 'ask' ? 'default' : 'none';
    const steps = [];
    const doctor = await staffMember(`doctor-${mode}`, [[alpha, true, 'doctor'], [beta, false, 'nurse'],
      [delta, false, 'doctor'], [laboratory, false, 'lab']]);

    if (mode === 'off') {
      // Off: every answer is today's, and nothing is read or stored.
      const first = await signIn(doctor);
      reports(first.response, alpha.id, 'none', 'off: sign-in');
      const serviceBefore = await serviceSession(first.held);
      assert.equal(serviceBefore.status, 200, JSON.stringify(serviceBefore.body));
      const chosen = await choose(first.held, beta.id);
      reports(chosen, beta.id, 'none', 'off: POST /auth/facility');
      assert.deepEqual(Object.keys(chosen.body), ['actor']);
      assert.deepEqual(await rows(doctor.id), [], 'off: a choice was stored');
      assert.deepEqual(await audits('auth.facility.select', first.held.sessionId),
        [{ facility_id: beta.id, actor_membership_id: doctor.memberships[beta.id] }], 'off: the choice is audited as today');
      reports(await read(first.held), alpha.id, 'none', 'off: reload');
      reports(await read(first.held, beta.id), beta.id, 'none', 'off: reload with X-Facility-ID');
      assert.deepEqual((await serviceSession(first.held)).body, serviceBefore.body, 'off: service-session changed');
      const rotated = await refresh(first.held);
      reports(rotated.response, alpha.id, 'none', 'off: refresh');
      // The start-up check reads nothing with the setting off.
      await new FacilitySelectionStartupCheck({ query: async () => { throw new Error('read with the setting off'); } })
        .onModuleInit();
      assert.equal(counters.reads, 0, 'off: a choice was read');
      assert.equal(await count('select count(*)::int as n from auth.session_facility_selection'), 0);
      steps.push('off: the sign-in, POST /auth/facility ({actor} only, audited as today), GET /auth/session (the primary facility again: today\'s reload), its X-Facility-ID binding, service-session and refresh answer as today with no facilitySelection; no row is stored, no choice is read, and the start-up check reads nothing');
      results[mode] = { steps, reads: counters.reads };
      await app.close();
      app = undefined;
      continue;
    }

    // 1. A new sign-in: today's answer (keep) or 'default' (ask), at the primary facility; nothing stored yet.
    const first = await signIn(doctor);
    reports(first.response, alpha.id, unchosen, `${mode}: sign-in`);
    assert.deepEqual([...first.response.body.actor.facilityIds].sort(), [alpha.id, beta.id, delta.id].sort(),
      'the ehr. sign-in holds Alpha, Beta and Delta, not the laboratory');
    assert.deepEqual(await rows(doctor.id), []);
    reports(await reads(1, 'first reload', () => read(first.held)), alpha.id, unchosen, `${mode}: first reload`);
    const serviceBefore = await reads(0, 'service-session', () => serviceSession(first.held));
    assert.equal(serviceBefore.status, 200, JSON.stringify(serviceBefore.body));
    assert.deepEqual(Object.keys(serviceBefore.body), ['actor']);
    assert.equal(serviceBefore.body.actor.facility.id, alpha.id);
    steps.push(`1. a new ehr. sign-in answers ${unchosen === 'none' ? 'no facilitySelection (today\'s answer)' : 'facilitySelection default'} at the primary facility, as does its first reload; no row`);

    // 2. A choice: one row for the sign-in, with the chosen membership, and one auth.facility.select row.
    const chosen = await reads(0, 'choice', () => choose(first.held, beta.id));
    reports(chosen, beta.id, 'selected', `${mode}: POST /auth/facility`);
    assert.deepEqual(Object.keys(chosen.body).sort(), ['actor', 'facilitySelection']);
    assert.deepEqual(chosen.body.actor.roles, ['nurse']);
    assert.deepEqual(await rows(doctor.id), [{ family_id: first.held.sessionId, facility_id: beta.id,
      membership_id: doctor.memberships[beta.id], row_version: 1 }], 'the choice was not stored as exactly one row');
    assert.deepEqual(await audits('auth.facility.select', first.held.sessionId),
      [{ facility_id: beta.id, actor_membership_id: doctor.memberships[beta.id] }]);
    steps.push('2. POST /auth/facility answers selected at the chosen facility with its roles, stores exactly one row (the sign-in\'s family, the facility, its membership, row_version 1) and one auth.facility.select row');

    // 9. Service-session answers exactly as before the choice, reading nothing.
    const serviceAfter = await reads(0, 'service-session after the choice', () => serviceSession(first.held));
    assert.deepEqual(serviceAfter.body, serviceBefore.body, 'service-session changed with the choice');
    assert.deepEqual(await latestSessionRead(first.held.sessionId),
      { facility_id: alpha.id, actor_membership_id: doctor.memberships[alpha.id] });
    steps.push('9. GET /auth/service-session after the choice answers exactly as before it ({actor} at the primary facility, no facilitySelection), reads no choice, and audits auth.session.read at the primary facility');

    // 3. A reload opens at the chosen facility; a valid X-Facility-ID still decides.
    const reloaded = await reads(1, 'reload', () => read(first.held));
    reports(reloaded, beta.id, 'selected', `${mode}: reload`);
    assert.deepEqual(reloaded.body.actor.roles, ['nurse']);
    assert.deepEqual(await latestSessionRead(first.held.sessionId),
      { facility_id: beta.id, actor_membership_id: doctor.memberships[beta.id] });
    const bound = await read(first.held, alpha.id);
    reports(bound, alpha.id, 'selected', `${mode}: reload with X-Facility-ID`);
    assert.deepEqual(bound.body.actor.roles, ['doctor']);
    steps.push('3. GET /auth/session answers selected at the chosen facility with its roles and audits auth.session.read there; with a valid X-Facility-ID it answers at that facility');

    // 4. A refresh keeps it (the row is the family's), and audits auth.refresh at it.
    const rotated = await reads(1, 'refresh', () => refresh(first.held));
    reports(rotated.response, beta.id, 'selected', `${mode}: refresh`);
    assert.notEqual(rotated.held.sessionId, first.held.sessionId);
    assert.deepEqual(await audits('auth.refresh', rotated.held.sessionId),
      [{ facility_id: beta.id, actor_membership_id: doctor.memberships[beta.id] }]);
    reports(await read(rotated.held), beta.id, 'selected', `${mode}: reload after the refresh`);
    assert.equal((await read(first.held)).status, 401, 'the rotated-away access cookie still reads');
    assert.deepEqual(await rows(doctor.id), [{ family_id: first.held.sessionId, facility_id: beta.id,
      membership_id: doctor.memberships[beta.id], row_version: 1 }]);
    let current = rotated.held;
    steps.push('4. POST /auth/refresh answers selected at the chosen facility, its auth.refresh row names that facility and membership, the rotated session reads it, and the row is unchanged');

    // 5. Another sign-in of the account has no choice.
    const second = await signIn(doctor);
    reports(second.response, alpha.id, unchosen, `${mode}: second sign-in`);
    reports(await read(second.held), alpha.id, unchosen, `${mode}: second sign-in's reload`);
    reports(await read(current), beta.id, 'selected', `${mode}: the first sign-in after the second`);
    assert.equal((await rows(doctor.id)).length, 1);
    steps.push(`5. a second ehr. sign-in of the account answers ${unchosen === 'none' ? 'no facilitySelection' : 'facilitySelection default'} at the primary facility, before and after a reload, and reads none of the first's choice; the first still reads its own`);

    // 6. Each site is its own sign-in (Q88), and each site is for its own job
    // (Q97): the laboratory is admitted on lab., not ehr., and the doctor's
    // and nurse's hospital memberships on ehr., not lab. (they hold lab.'s
    // reading codes for their hospital work only), so the lab. sign-in holds
    // the laboratory alone and a site refuses a choice of a facility it does
    // not admit.
    const lab = await signIn(doctor, labOrigin, 'lab-login');
    reports(lab.response, laboratory.id, unchosen, `${mode}: lab. sign-in`);
    assert.deepEqual(lab.response.body.actor.facilityIds, [laboratory.id], 'the lab. sign-in holds the laboratory alone (Q97)');
    const labChosen = await choose(lab.held, laboratory.id);
    reports(labChosen, laboratory.id, 'selected', `${mode}: lab. choice`);
    reports(await read(lab.held), laboratory.id, 'selected', `${mode}: lab. reload`);
    reports(await read(current), beta.id, 'selected', `${mode}: ehr. reload beside the lab. choice`);
    const labRow = { family_id: lab.held.sessionId, facility_id: laboratory.id,
      membership_id: doctor.memberships[laboratory.id], row_version: 1 };
    const ehrRow = { family_id: first.held.sessionId, facility_id: beta.id,
      membership_id: doctor.memberships[beta.id], row_version: 1 };
    const sameRows = async label => assert.deepEqual(
      (await rows(doctor.id)).sort((a, b) => a.family_id.localeCompare(b.family_id)),
      [labRow, ehrRow].sort((a, b) => a.family_id.localeCompare(b.family_id)), `${label}: the stored choices changed`);
    await sameRows('lab. choice');
    // 6a. On the ehr. sign-in, a choice of the laboratory sent with lab.'s Origin:
    // it is not one of the ehr. sign-in's facilities.
    refusedWithoutFacilityHeader(await choose(current, laboratory.id, { origin: labOrigin }),
      `${mode}: a choice of a facility the ehr. sign-in does not hold, sent with lab.'s Origin`, '403 FACILITY_ACCESS_DENIED');
    problem(await choose(current, laboratory.id, { origin: labOrigin, facility: alpha.id }), 403, 'FACILITY_ACCESS_DENIED',
      `${mode}: the same with X-Facility-ID`);
    // 6b. On the lab. sign-in, the laboratory sent with ehr.'s Origin: ehr. does not admit it.
    refusedWithoutFacilityHeader(await choose(lab.held, laboratory.id, { origin: ehrOrigin }),
      `${mode}: a choice sent with ehr.'s Origin of a facility ehr. does not admit, on the lab. sign-in`,
      '403 FACILITY_ACCESS_DENIED');
    problem(await choose(lab.held, laboratory.id, { origin: ehrOrigin, facility: laboratory.id }), 403,
      'FACILITY_ACCESS_DENIED', `${mode}: the same with X-Facility-ID`);
    await sameRows('refused cross-site choices');
    assert.equal((await audits('auth.facility.select', current.sessionId)).length, 0);
    assert.equal((await audits('auth.facility.select', lab.held.sessionId)).length, 1);
    // 6c. A refresh of the ehr. sign-in from lab. ends with 401, cookies cleared, before any read.
    const crossRefresh = await reads(0, 'refresh from another site', () => refresh(current, labOrigin));
    problem(crossRefresh.response, 401, 'AUTHENTICATION_REQUIRED', `${mode}: refresh from lab.`);
    const cleared = (crossRefresh.response.headers['set-cookie'] ?? []).filter(value => /Expires=Thu, 01 Jan 1970/i.test(value))
      .map(value => value.split('=')[0]).sort();
    assert.deepEqual(cleared, [name, `${name}_csrf`, `${name}_refresh`].sort(), 'the cross-site refresh did not clear the cookies');
    reports(await read(current), beta.id, 'selected', `${mode}: ehr. reload after the refused refresh`);
    steps.push('6. a lab. sign-in of the same account is its own: it answers as a new sign-in, stores its own choice (the laboratory) and reads only that, while the ehr. sign-in keeps its own; a choice of a facility the site does not admit (the laboratory from the ehr. sign-in with lab.\'s Origin, and from the lab. sign-in with ehr.\'s Origin) stores nothing and writes no auth.facility.select row; a refresh of the ehr. sign-in from lab. is 401 with the three cookies cleared and reads nothing');

    // 7. Refusals store nothing. A facility that is not the actor's:
    refusedWithoutFacilityHeader(await choose(current, gamma.id), `${mode}: another organisation's facility`,
      '403 FACILITY_ACCESS_DENIED');
    problem(await choose(current, gamma.id, { facility: alpha.id }), 403, 'FACILITY_ACCESS_DENIED',
      `${mode}: another organisation's facility with X-Facility-ID`);
    problem(await choose(current, randomUUID(), { facility: alpha.id }), 403, 'FACILITY_ACCESS_DENIED',
      `${mode}: an unknown facility with X-Facility-ID`);
    refusedWithoutFacilityHeader(await choose(current, 'not-a-facility'), `${mode}: a malformed facility id`,
      '400 VALIDATION_FAILED');
    problem(await choose(current, 'not-a-facility', { facility: alpha.id }), 400, 'VALIDATION_FAILED',
      `${mode}: a malformed facility id with X-Facility-ID`);
    await sameRows('refused choices');
    // A sign-in that ends while its choice waits at the presented session's lock
    // (a sign-out, rotation or revocation gets there first): nothing is stored.
    const race = async (held, facilityId, facilityHeader, meanwhile) => {
      const holder = await owner.connect();
      try {
        await holder.query('begin');
        await holder.query('select id from auth.sessions where id = $1 for update', [held.sessionId]);
        const pending = Promise.resolve(choose(held, facilityId, { facility: facilityHeader }));
        await lockWaiter();
        await meanwhile(holder);
        await holder.query('commit');
        return await pending;
      } catch (error) {
        await holder.query('rollback').catch(() => {});
        throw error;
      } finally {
        holder.release();
      }
    };
    const signOut = holder => async client => client.query(`update auth.sessions set revoked_at = clock_timestamp(),
        revocation_reason = 'logout', row_version = row_version + 1 where id = $1`, [holder.sessionId]);
    const endedA = (await signIn(doctor)).held;
    refusedWithoutFacilityHeader(await race(endedA, delta.id, undefined, signOut(endedA)),
      `${mode}: a sign-in that ended while its choice waited`, '401 AUTHENTICATION_REQUIRED');
    const endedB = (await signIn(doctor)).held;
    problem(await race(endedB, delta.id, alpha.id, signOut(endedB)), 401, 'AUTHENTICATION_REQUIRED',
      `${mode}: a sign-in that ended while its choice waited, with X-Facility-ID`);
    // The membership ends while the choice waits: the database guard refuses
    // the row (23514 SESSION_FACILITY_SELECTION_INVALID), answered 403.
    const refusing = (await signIn(doctor)).held;
    const endDelta = async client => client.query(`update identity.staff_facility_memberships set active = false,
        row_version = row_version + 1 where id = $1`, [doctor.memberships[delta.id]]);
    const restoreDelta = () => owner.query(`update identity.staff_facility_memberships set active = true,
        row_version = row_version + 1 where id = $1`, [doctor.memberships[delta.id]]);
    const guardRefusal = /ERROR:\s+SESSION_FACILITY_SELECTION_INVALID/g;
    refusedWithoutFacilityHeader(await inLogWindow(`${mode}: guard refusal`, guardRefusal, 1,
      () => race(refusing, delta.id, undefined, endDelta)), `${mode}: a membership that ended while its choice waited`,
    '403 FACILITY_ACCESS_DENIED');
    await restoreDelta();
    problem(await inLogWindow(`${mode}: guard refusal with X-Facility-ID`, guardRefusal, 1,
      () => race(refusing, delta.id, alpha.id, endDelta)), 403, 'FACILITY_ACCESS_DENIED',
    `${mode}: a membership that ended while its choice waited, with X-Facility-ID`);
    await restoreDelta();
    for (const family of [endedA, endedB, refusing]) {
      assert.equal((await audits('auth.facility.select', family.sessionId)).length, 0);
    }
    await sameRows('refusals while the choice waited');
    steps.push('7. refused choices store nothing and write no auth.facility.select row: another organisation\'s facility and an unknown one (403 FACILITY_ACCESS_DENIED with X-Facility-ID), a malformed id (400 VALIDATION_FAILED with X-Facility-ID), a sign-in that ended while its choice waited at the presented session\'s FOR SHARE lock (401 AUTHENTICATION_REQUIRED with X-Facility-ID), and a membership that ended meanwhile, which the database guard refuses (403 FACILITY_ACCESS_DENIED with X-Facility-ID); without X-Facility-ID each is 503 today (expectedUntilFailureAuditFix)');

    // 10. The choice cannot be read or written (SELECT revoked from the Identity
    // runtime for this window only): 200 'unavailable' at the default on GET and
    // on refresh, which still rotates; a choice is 503 with nothing stored. One
    // log event each, with no identifier.
    const eventsBefore = selectionEvents().length;
    const permissionDenied = /ERROR:\s+permission denied for table session_facility_selection/g;
    const unreadable = await inLogWindow(`${mode}: SELECT revoked`, permissionDenied, 4, async () => {
      await owner.query('revoke select on auth.session_facility_selection from hid_identity_runtime');
      readRevoked = true;
      try {
        const reload = await reads(1, 'unreadable reload', () => read(current));
        const bound = await reads(1, 'unreadable reload with X-Facility-ID', () => read(current, beta.id));
        const refreshed = await reads(1, 'unreadable refresh', () => refresh(current));
        const stored = await choose(refreshed.held, delta.id, { facility: alpha.id });
        return { reload, bound, refreshed, stored };
      } finally {
        await owner.query('grant select on auth.session_facility_selection to hid_identity_runtime');
        readRevoked = false;
      }
    });
    reports(unreadable.reload, alpha.id, 'unavailable', `${mode}: unreadable reload`);
    assert.equal(unreadable.reload.headers['set-cookie'], undefined, 'a reload changed a cookie');
    reports(unreadable.bound, beta.id, 'unavailable', `${mode}: unreadable reload with X-Facility-ID`);
    reports(unreadable.refreshed.response, alpha.id, 'unavailable', `${mode}: unreadable refresh`);
    const rotatedCookies = (unreadable.refreshed.response.headers['set-cookie'] ?? [])
      .filter(value => [name, `${name}_refresh`, `${name}_csrf`].includes(value.split('=')[0]));
    assert.equal(rotatedCookies.length, 3, `rotated cookies: ${unreadable.refreshed.response.headers['set-cookie']}`);
    assert(rotatedCookies.every(value => !/Expires=Thu, 01 Jan 1970/i.test(value)), 'a session cookie was cleared');
    assert.equal(unreadable.refreshed.response.headers['x-csrf-token'], unreadable.refreshed.held.cookies[`${name}_csrf`]);
    assert.deepEqual(await audits('auth.refresh', unreadable.refreshed.held.sessionId),
      [{ facility_id: alpha.id, actor_membership_id: doctor.memberships[alpha.id] }]);
    assert.equal((await read(current)).status, 401, 'the refresh did not rotate');
    current = unreadable.refreshed.held;
    problem(unreadable.stored, 503, 'DEPENDENCY_UNAVAILABLE', `${mode}: a choice while the table cannot be read`);
    assert.equal(failureFor(unreadable.stored)?.message?.exceptionType, 'DomainProblem',
      'the 503 was not the handler\'s own DEPENDENCY_UNAVAILABLE');
    const events = selectionEvents().slice(eventsBefore);
    assert.deepEqual(events.map(entry => entry.message.operation), ['read', 'read', 'read', 'store'],
      `${mode}: facility-selection log events ${JSON.stringify(events)}`);
    assert(events.every(entry => JSON.stringify(Object.keys(entry.message)) === '["event","operation"]'),
      'a facility-selection log event carries more than the event and the operation');
    reports(await read(current), beta.id, 'selected', `${mode}: reload once readable`);
    await sameRows('the unreadable window');
    // The start-up check refuses for each single missing grant, and passes with all three.
    const startupCheck = new FacilitySelectionStartupCheck(database);
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
      await owner.query(`revoke ${privilege} on auth.session_facility_selection from hid_identity_runtime`);
      revokedPrivilege = privilege;
      try {
        await assert.rejects(startupCheck.onModuleInit(),
          new RegExp(`lacks ${privilege} on auth\\.session_facility_selection`), `start-up check without ${privilege}`);
      } finally {
        await owner.query(`grant ${privilege} on auth.session_facility_selection to hid_identity_runtime`);
        revokedPrivilege = undefined;
      }
    }
    await startupCheck.onModuleInit();
    steps.push('10. with SELECT revoked, GET /auth/session answers 200 unavailable at the primary facility (at the X-Facility-ID facility when one is sent) with no Set-Cookie, POST /auth/refresh answers 200 unavailable with the three rotated cookies and X-CSRF-Token and audits auth.refresh at the primary facility, and a choice is 503 DEPENDENCY_UNAVAILABLE with nothing stored; each logs one auth.facility_selection.unavailable event carrying only the operation; once readable the stored choice is read again; the start-up check refuses without SELECT, without INSERT and without UPDATE, each named, and passes with all three');

    // 8. The facility's administrator ends the membership through the staff
    // route (password re-entered): the next reload and refresh ask again
    // (reselect, at the primary facility) and the row is kept until replaced.
    const admin = (await signIn(signedUp.admin)).held;
    const membership = (await owner.query('select row_version from identity.staff_facility_memberships where id = $1',
      [doctor.memberships[beta.id]])).rows[0];
    const ended = await post(admin, `/identity/facility-staff/${doctor.memberships[beta.id]}/end`,
      { expectedVersion: Number(membership.row_version), reason: 'Moved to another clinic at the end of the month',
        currentPassword: password }, { facility: beta.id });
    assert.equal(ended.status, 200, `ending the membership: ${JSON.stringify(ended.body)}`);
    const reselect = await reads(1, 'reload after the membership ended', () => read(current));
    reports(reselect, alpha.id, 'reselect', `${mode}: reload after the membership ended`);
    assert(!reselect.body.actor.facilityIds.includes(beta.id));
    const reselectRefresh = await refresh(current);
    reports(reselectRefresh.response, alpha.id, 'reselect', `${mode}: refresh after the membership ended`);
    current = reselectRefresh.held;
    await sameRows('the ended membership');
    problem(await choose(current, beta.id, { facility: alpha.id }), 403, 'FACILITY_ACCESS_DENIED',
      `${mode}: choosing the ended membership's facility`);
    reports(await choose(current, alpha.id), alpha.id, 'selected', `${mode}: choosing again`);
    assert.deepEqual((await rows(doctor.id)).find(row => row.family_id === first.held.sessionId),
      { family_id: first.held.sessionId, facility_id: alpha.id, membership_id: doctor.memberships[alpha.id], row_version: 2 });
    reports(await read(current), alpha.id, 'selected', `${mode}: reload after choosing again`);
    steps.push('8. the self-signed-up facility\'s administrator ends the chosen membership with POST /identity/facility-staff/:membershipId/end; GET /auth/session and refresh then answer reselect at the primary facility, the row is kept, choosing that facility again is 403, and a new choice replaces the row (row_version 2) and answers selected');

    // 11. Sign-out: the row stays, and the signed-out sign-in reads nothing.
    const signedOut = await post(current, '/auth/logout', {});
    assert.equal(signedOut.status, 204, JSON.stringify(signedOut.body));
    assert.equal((await reads(0, 'reload after sign-out', () => read(current))).status, 401);
    assert.equal(await tokens.selectedFacilityId(current.sessionId, doctor.id), undefined,
      'a signed-out sign-in still reads its choice');
    assert.equal((await rows(doctor.id)).filter(row => row.family_id === first.held.sessionId).length, 1, 'sign-out removed the row');
    steps.push('11. after sign-out GET /auth/session is 401 before any read, TokenService.selectedFacilityId through the signed-out session reads nothing, and the row stays');

    // Patients: no read and no field.
    const patient = await reads(0, 'patient sign-in and reload', async () => {
      const response = await http.post('/api/v1/auth/patient/login').set('Origin', appOrigin)
        .send({ email: patientAccount.email, password, turnstileAction: 'patient-login' });
      assert.equal(response.status, 200, `patient sign-in: ${JSON.stringify(response.body)}`);
      assert.equal('facilitySelection' in response.body, false);
      const held = { cookies: jar(response), origin: appOrigin };
      const reloadedPatient = await read(held);
      assert.equal(reloadedPatient.status, 200);
      assert.equal('facilitySelection' in reloadedPatient.body, false);
      const refreshed = await refresh(held);
      assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.response.body));
      assert.equal('facilitySelection' in refreshed.response.body, false);
      problem(await choose(refreshed.held, alpha.id), 403, 'PATIENT_SCOPE_DENIED', `${mode}: a patient's choice`);
      return held;
    });
    assert(patient);
    assert.deepEqual(await rows(patientAccount.id), []);
    steps.push('patients: the sign-in, reload and refresh carry no facilitySelection and read nothing; a choice is 403 PATIENT_SCOPE_DENIED with no row');
    results[mode] = { steps, reads: counters.reads,
      rows: Number(await count('select count(*)::int as n from auth.session_facility_selection where account_id = $1',
        [doctor.id])) };
    await app.close();
    app = undefined;
  }

  // 12. The server log from this run's start: every error inside a deliberate
  // window is that window's, as often as expected; outside them, none at all.
  const log = readFileSync(serverLog);
  const errorLines = /^.*\b(ERROR|FATAL|PANIC):.*$/gm;
  const outsideParts = [];
  let position = logStart;
  for (const window of [...logWindows].sort((a, b) => a.from - b.from)) {
    const segment = log.subarray(window.from, window.to).toString('utf8');
    const errors = segment.match(errorLines) ?? [];
    const expected = segment.match(window.pattern) ?? [];
    assert.equal(expected.length, window.expected, `${window.label}: ${expected.length} expected errors in ${JSON.stringify(errors)}`);
    assert.equal(errors.length, window.expected, `${window.label}: other errors ${JSON.stringify(errors)}`);
    outsideParts.push(log.subarray(position, window.from).toString('utf8'));
    position = window.to;
  }
  outsideParts.push(log.subarray(position).toString('utf8'));
  const outside = outsideParts.join('\n');
  const unexpected = outside.match(errorLines) ?? [];
  assert.deepEqual(unexpected, [], 'the server log shows errors outside the deliberate windows');
  for (const pattern of [/permission denied/i, /does not exist/i, /SESSION_FACILITY_SELECTION_INVALID/]) {
    assert(!pattern.test(outside), `the server log shows ${pattern} outside the deliberate windows`);
  }

  process.stdout.write(JSON.stringify({ status: 'passed', runtimeRole: 'hid_identity_api_runtime',
    database: rehearsal ? 'rehearsal' : 'loopback', setting: 'STAFF_FACILITY_SELECTION_MODE',
    modes: results, expectedUntilFailureAuditFix,
    serverLog: { windows: logWindows.map(window => ({ label: window.label, errors: window.expected })),
      errorsOutsideWindows: 0 } }) + '\n');
} finally {
  // Never leave the Identity runtime without its grants (the copy is dropped anyway).
  if (readRevoked) await owner.query('grant select on auth.session_facility_selection to hid_identity_runtime');
  if (revokedPrivilege) await owner.query(`grant ${revokedPrivilege} on auth.session_facility_selection to hid_identity_runtime`);
  await app?.close();
  // owner.end() resolves before its connections finish closing, so the forced
  // drop below can terminate one of them (57P01) once the checks are over.
  owner.on('error', (error) => { if (error.code !== '57P01') throw error; });
  await owner.end();
  await maintenance.query(`drop database if exists ${isolated} with (force)`);
  await maintenance.end();
}
