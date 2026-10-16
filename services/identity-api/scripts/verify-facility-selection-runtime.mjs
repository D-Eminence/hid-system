#!/usr/bin/env node
// A staff member's chosen working facility, kept per sign-in (0089, ADR-046),
// over HTTP with every query as hid_identity_api_runtime. A staff sign-in is
// the session issued after its second factor (MFA-1, 0088): staff sign in
// through staff-session-client.mjs (password, then enrolment or TOTP), and the
// password step itself reports and stores nothing. Selecting a facility stores
// it for the sign-in family, so a reload (GET /auth/session) or a refresh
// reports it instead of the primary facility; a membership that has since
// ended asks the user again (reselect); another sign-in of the same account is
// not affected; a refused selection writes nothing. A refresh reads the
// selection on its rotation's transaction and records auth.refresh at the
// facility it reports. When the selection cannot be read, a session read
// answers 503 and a refresh, whose failed read is rolled back to its savepoint
// so the rotation still commits, answers 200 with the rotated cookies and
// facilitySelection 'unavailable'. The selection is only the default the
// session reports: X-Facility-ID still authorizes each request. Executes only
// against the owned disposable synthetic rehearsal.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createTotpClock } from './platform-session-client.mjs';
import { enrollmentCodeOutbox, setCookies, staffClient, supertestTransport, SYNTHETIC_STAFF_MFA_KEY_B64 }
  from './staff-session-client.mjs';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'staging',
  NIN_PROVIDER_MODE: 'deferred', TURNSTILE_MODE: 'disabled', MFA_SECRET_KEY_B64: SYNTHETIC_STAFF_MFA_KEY_B64,
  MFA_KEY_VERSION: 'facility-selection-runtime-v1' });
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
const { AuditInterceptor } = load('audit/audit.interceptor.ts');
const { SecurityGuard } = load('auth/security.guard.ts');
const { WorkloadAuthService } = load('auth/workload-auth.service.ts');
const { TurnstileService } = load('auth/turnstile.service.ts');
const { MfaService, MFA_TOTP_CLOCK } = load('auth/mfa/mfa.service.ts');
const { MfaSecretProtector } = load('auth/mfa/mfa-secret-protector.ts');
const { NotificationOtpClient } = load('auth/notification-otp.client.ts');
const { ProblemDetailsFilter } = load('common/problem.ts');
const { getEnvironment } = load('config/environment.ts');
const pool = new Pool({ host: socket, user: process.env.PGUSER, database: process.env.PGDATABASE, max: 6 });
const asRuntime = async (client, operation) => {
  try { await client.query('begin'); await client.query('set local role hid_identity_api_runtime');
    const result = await operation(); await client.query('commit'); return result;
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
};
const database = {
  query: async (sql, values) => { const client = await pool.connect(); return asRuntime(client, () => client.query(sql, values)); },
  withSystemTransaction: async (correlation, operation) => {
    const client = await pool.connect();
    return asRuntime(client, async () => {
      await client.query("select set_config('app.actor_subject','system:auth',true),set_config('app.correlation_id',$1,true)", [correlation]);
      return operation(client);
    });
  },
};
let app;
let selectionReadRevoked = false;
try {
  const clock = createTotpClock();
  const outbox = enrollmentCodeOutbox();
  const module = await Test.createTestingModule({ controllers: [AuthController],
    providers: [{ provide: DatabaseService, useValue: database }, TokenService, LocalAuthProvider,
      CurrentStaffContextService, CurrentPatientContextService, AuthService, AuthSessionAuditService,
      AuditService, WorkloadAuthService, TurnstileService, MfaService, MfaSecretProtector,
      { provide: MFA_TOTP_CLOCK, useValue: clock.now }, { provide: NotificationOtpClient, useValue: outbox.client },
      { provide: GoogleAuthenticationService, useValue: {} }] }).compile();
  app = module.createNestApplication({ logger: false });
  app.use(require('cookie-parser')());
  app.use((req, _res, next) => { req.correlationId = randomUUID(); next(); });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalGuards(new SecurityGuard(module.get(Reflector), module.get(TokenService), module.get(AuditService), module.get(DatabaseService)));
  // As AppModule registers it (APP_INTERCEPTOR): a refused selection is audited
  // as a failed auth.facility.select session event (D-Eminence/hid-system#42).
  app.useGlobalInterceptors(new AuditInterceptor(module.get(Reflector), module.get(AuditService)));
  await app.init();
  const http = request(app.getHttpServer());
  const origin = process.env.CORS_ORIGINS.split(',')[0];
  const name = getEnvironment().AUTH_COOKIE_NAME;

  // Fixture: a doctor working at two facilities (Alpha primary, Beta), another
  // doctor at a third (Gamma), and a patient. Synthetic accounts only.
  const argon2 = require('argon2');
  const password = 'Synthetic-Facility-Selection-2026';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const account = async (label) => {
    const id = randomUUID();
    const email = `${label}-${id}@example.invalid`;
    await pool.query(`insert into auth.accounts(id,subject,email,display_name,status,password_hash,password_algorithm)
      values($1,$2,$3,$4,'active',$5,'argon2id')`, [id, `synthetic:facility-selection:${label}:${id}`, email, `Synthetic ${label}`, passwordHash]);
    return { id, email };
  };
  const org = randomUUID();
  await pool.query("insert into identity.organizations(id,name,slug) values($1,'Selection Rehearsal Org',$2)", [org, `selection-${org}`]);
  const facility = async (label) => {
    const id = randomUUID();
    await pool.query(`insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
      values($1,$2,$3,$4,'Africa/Lagos',true,'verified')`, [id, org, `Selection ${label}`, `SEL-${id.slice(0, 8)}`]);
    return id;
  };
  const alpha = await facility('Alpha'); const beta = await facility('Beta'); const gamma = await facility('Gamma');
  const staffMember = async (label, memberships) => {
    const created = await account(label);
    const staffId = randomUUID();
    await pool.query(`insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
      values($1,$2,$3,$4,'verified','doctor')`, [staffId, created.id, `Synthetic ${label}`, created.email]);
    const ids = {};
    for (const [facilityId, primary, role] of memberships) {
      const membership = randomUUID();
      await pool.query(`insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,app_role,is_primary,active)
        values($1,$2,$3,$4,$5,$6,$6,$7,true)`, [membership, staffId, created.id, org, facilityId, role, primary]);
      await pool.query(`insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
        values($1,$2,$3,'facility',$4,$5,'Synthetic rehearsal role')`, [randomUUID(), created.id, role, membership, facilityId]);
      ids[facilityId] = membership;
    }
    return { ...created, memberships: ids };
  };
  const doctor = await staffMember('doctor', [[alpha, true, 'doctor'], [beta, false, 'nurse']]);
  const colleague = await staffMember('colleague', [[gamma, true, 'doctor']]);
  const patientAccount = await account('patient');
  await pool.query(`insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status)
    values($1,$2,$3,'Selection','Patient','Selection Patient','active')`,
  // HID codes use the unambiguous alphabet (no I, O, 0 or 1).
  [randomUUID(), patientAccount.id, `HID-SEL${Array.from(randomBytes(8), (byte) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[byte % 32]).join('')}`]);

  // The cookies a response sets, without the ones it expires (every sign-in
  // and refresh also expires the public patient enrollment cookie).
  const jar = response => setCookies({ setCookie: response.headers['set-cookie'] ?? [] });
  const cookie = cookies => Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; ');
  const staffSignIns = staffClient({ send: supertestTransport(http), origin, password, outbox, now: clock.next,
    cookieName: name });
  const signIn = async (who, kind = 'staff') => {
    if (kind === 'staff') {
      // Password, then the authenticator (enrolled on the account's first
      // sign-in): the session and its facilitySelection come with that step.
      const signedIn = await staffSignIns.signIn(who.email);
      return { cookies: signedIn.cookies, sessionId: signedIn.sessionId, body: signedIn.response.body };
    }
    const response = await http.post('/api/v1/auth/patient/login')
      .set('Origin', origin).send({ email: who.email, password, turnstileAction: `${kind}-login` });
    assert.equal(response.status, 200, `${kind} sign-in: ${JSON.stringify(response.body)}`);
    return { cookies: jar(response), sessionId: response.body.actor.sessionId, body: response.body };
  };
  const select = (held, facilityId) => http.post('/api/v1/auth/facility').set('Cookie', cookie(held.cookies))
    .set('Origin', origin).set('x-csrf-token', held.cookies[`${name}_csrf`]).send({ facilityId });
  const session = (held) => http.get('/api/v1/auth/session').set('Cookie', cookie(held.cookies));
  const refresh = async (held) => {
    const response = await http.post('/api/v1/auth/refresh').set('Cookie', cookie(held.cookies)).set('Origin', origin)
      .set('x-csrf-token', held.cookies[`${name}_csrf`]);
    return { response, held: response.status === 200 ? { cookies: { ...held.cookies, ...jar(response) },
      sessionId: response.body.actor.sessionId } : held };
  };
  const rows = async (accountId) => (await pool.query(`select family_id::text, facility_id::text, membership_id::text,
      row_version::int from auth.session_facility_selection where account_id = $1 order by selected_at`, [accountId])).rows;
  const selectionAudits = async (sessionId) => (await pool.query(`select facility_id::text, actor_membership_id::text
      from audit.events where action = 'auth.facility.select' and outcome = 'success' and resource_id = $1`, [sessionId])).rows;
  const refreshAudits = async (sessionId) => (await pool.query(`select facility_id::text, actor_membership_id::text
      from audit.events where action = 'auth.refresh' and outcome = 'success' and resource_id = $1`, [sessionId])).rows;
  const refusalAudits = async (sessionId) => (await pool.query(`select actor_type, resource_type, facility_id::text,
      actor_membership_id::text, organization_id::text from audit.events
      where action = 'auth.facility.select' and outcome = 'failure' and resource_id = $1`, [sessionId])).rows;
  const unscopedStaffRefusals = (audits) => audits.every(row => row.actor_type === 'staff' && row.resource_type === 'session'
    && row.facility_id === null && row.actor_membership_id === null && row.organization_id === null);
  const reports = (response, facilityId, state) => {
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.facilitySelection, state, JSON.stringify(response.body));
    assert.equal(response.body.actor.facility.id, facilityId, JSON.stringify(response.body.actor.facility));
  };
  const checks = [];

  // 1. The password step issues no session and reports no selection; the
  // session issued by the first enrolment reports the default (primary) facility.
  const passwordOnly = await staffSignIns.passwordStep(doctor.email);
  assert.equal(passwordOnly.status, 'mfa_enrollment_required');
  assert.equal('facilitySelection' in passwordOnly.response.body, false, JSON.stringify(passwordOnly.response.body));
  assert.equal((await rows(doctor.id)).length, 0);
  const first = await staffSignIns.enroll(doctor.email, passwordOnly.challengeCookie)
    .then(signedIn => ({ cookies: signedIn.cookies, sessionId: signedIn.sessionId, body: signedIn.response.body }));
  assert.equal(first.body.facilitySelection, 'default', JSON.stringify(first.body));
  assert.equal(first.body.actor.facility.id, alpha); assert.equal(first.body.recoveryCodes?.length, 10);
  reports(await session(first), alpha, 'default');
  checks.push('the staff password step answers mfa_enrollment_required with no facilitySelection and no row; the session issued by POST /auth/mfa/enroll/activate and its session read report the primary facility with facilitySelection default');

  // 2. Selecting Beta stores it for the sign-in and audits it once; a reload reports it.
  const selected = await select(first, beta);
  reports(selected, beta, 'selected');
  assert.deepEqual(selected.body.actor.roles, ['nurse']);
  assert.deepEqual(await rows(doctor.id), [{ family_id: first.sessionId, facility_id: beta,
    membership_id: doctor.memberships[beta], row_version: 1 }]);
  assert.deepEqual(await selectionAudits(first.sessionId), [{ facility_id: beta, actor_membership_id: doctor.memberships[beta] }]);
  const reloaded = await session(first);
  reports(reloaded, beta, 'selected');
  assert.deepEqual(reloaded.body.actor.roles, ['nurse']);
  checks.push('POST /auth/facility stores the selection for the sign-in family (one row, the chosen membership) with one auth.facility.select audit, and GET /auth/session then reports the chosen facility, its roles and selected');

  // 3. Refresh rotates the session within the family and keeps the selection.
  const rotated = await refresh(first);
  reports(rotated.response, beta, 'selected');
  assert.notEqual(rotated.held.sessionId, first.sessionId);
  assert.deepEqual(await refreshAudits(rotated.held.sessionId), [{ facility_id: beta, actor_membership_id: doctor.memberships[beta] }],
    'the auth.refresh row names the selected facility the refresh reports');
  reports(await session(rotated.held), beta, 'selected');
  const stale = await session(first);
  assert.equal(stale.status, 401, 'the rotated-away access cookie no longer reads the session');
  assert.deepEqual((await rows(doctor.id)).map(row => [row.family_id, row.facility_id, row.row_version]), [[first.sessionId, beta, 1]]);
  checks.push('refresh reports the selected facility and records its one auth.refresh row at that facility and membership, the rotated session reads it on reload, and the stored row is unchanged (keyed by the family)');

  // 3b. The selection cannot be read (SELECT revoked from the Identity runtime
  // for this step only): the session read is 503 with the cookies untouched,
  // and the refresh, whose failed read in the rotation is rolled back to its
  // savepoint, commits the rotation and answers 200 with the rotated cookies
  // and 'unavailable', never the default as a choice.
  await pool.query('revoke select on auth.session_facility_selection from hid_identity_runtime');
  selectionReadRevoked = true;
  let unreadable;
  let unavailable;
  try {
    unreadable = await session(rotated.held);
    unavailable = await refresh(rotated.held);
  } finally {
    await pool.query('grant select on auth.session_facility_selection to hid_identity_runtime');
    selectionReadRevoked = false;
  }
  assert.equal(unreadable.status, 503, JSON.stringify(unreadable.body));
  assert.equal(unreadable.body.code, 'DEPENDENCY_UNAVAILABLE');
  assert.equal(unreadable.headers['set-cookie'], undefined, 'a failed session read changes no cookie');
  assert.equal(unavailable.response.status, 200, JSON.stringify(unavailable.response.body));
  assert.equal(unavailable.response.body.facilitySelection, 'unavailable');
  assert.equal(unavailable.response.body.actor.facility.id, alpha, 'the default is reported, labelled unavailable');
  const rotatedCookies = (unavailable.response.headers['set-cookie'] ?? [])
    .filter(value => [name, `${name}_refresh`, `${name}_csrf`].includes(value.split('=')[0]));
  assert.equal(rotatedCookies.length, 3, `rotated session cookies: ${unavailable.response.headers['set-cookie']}`);
  assert(rotatedCookies.every(value => !/Expires=Thu, 01 Jan 1970/i.test(value)), 'no session cookie is cleared');
  assert.equal(unavailable.response.headers['x-csrf-token'], unavailable.held.cookies[`${name}_csrf`]);
  assert.notEqual(unavailable.held.sessionId, rotated.held.sessionId);
  assert.equal((await session(rotated.held)).status, 401, 'the rotation committed');
  assert.deepEqual(await refreshAudits(unavailable.held.sessionId), [{ facility_id: alpha, actor_membership_id: doctor.memberships[alpha] }],
    'the rotation committed with its auth.refresh row, at the default facility it reports');
  const current = unavailable.held;
  reports(await session(current), beta, 'selected');
  assert.deepEqual((await rows(doctor.id)).map(row => [row.family_id, row.facility_id, row.row_version]), [[first.sessionId, beta, 1]]);
  checks.push('with the selection unreadable by the runtime, GET /auth/session is 503 DEPENDENCY_UNAVAILABLE with no Set-Cookie, and POST /auth/refresh is 200 with the three rotated session cookies, the rotated X-CSRF-Token and facilitySelection unavailable, its rotation committed with one auth.refresh row at the default facility (the failed read rolled back to its savepoint); once readable, the rotated session reports the stored selection again');

  // 4. A second sign-in of the same account (TOTP this time) is not affected,
  // and its own refresh neither.
  const second = await signIn(doctor);
  assert.equal(second.body.facilitySelection, 'default', JSON.stringify(second.body));
  assert.equal(second.body.actor.facility.id, alpha);
  reports(await session(second), alpha, 'default');
  const secondRotated = await refresh(second);
  reports(secondRotated.response, alpha, 'default');
  assert.equal((await rows(doctor.id)).length, 1);
  checks.push('a second sign-in of the same account, issued by POST /auth/mfa/verify, reports facilitySelection default and its own default facility, before and after its refresh, with no row of its own');

  // 5. An invalid selection is refused and writes nothing, nor does a malformed one.
  const auditsBefore = (await selectionAudits(secondRotated.held.sessionId)).length;
  const refusalsBefore = (await refusalAudits(secondRotated.held.sessionId)).length;
  for (const [label, body, status, code] of [
    ['another account\'s facility', gamma, 403, 'FACILITY_ACCESS_DENIED'],
    ['an unknown facility', randomUUID(), 403, 'FACILITY_ACCESS_DENIED'],
    ['a malformed id', 'not-a-facility', 400, undefined],
  ]) {
    const refused = await select(secondRotated.held, body);
    assert.equal(refused.status, status, `${label}: ${JSON.stringify(refused.body)}`);
    if (code) assert.equal(refused.body.code, code, label);
  }
  assert.equal((await rows(doctor.id)).length, 1, 'a refused selection writes no row');
  assert.equal((await selectionAudits(secondRotated.held.sessionId)).length, auditsBefore, 'nor a selection audit');
  const refusals = await refusalAudits(secondRotated.held.sessionId);
  assert.equal(refusals.length, refusalsBefore + 3, 'each refusal is audited once');
  assert.ok(unscopedStaffRefusals(refusals), `refusal rows carry no facility: ${JSON.stringify(refusals)}`);
  assert.equal((await rows(colleague.id)).length, 0);
  reports(await session(secondRotated.held), alpha, 'default');
  checks.push('selecting another account\'s or an unknown facility is 403 FACILITY_ACCESS_DENIED and a malformed id 400, each writing no row and no selection audit, and each recorded once as a failed auth.facility.select staff session event with no facility, membership or organization');

  // 6. X-Facility-ID still authorizes each request, whatever is selected.
  const header = await session(current).set('X-Facility-ID', alpha);
  assert.equal(header.status, 200); assert.equal(header.body.actor.facility.id, alpha);
  checks.push('a valid X-Facility-ID on GET /auth/session binds the reported facility, as before; the selection is only the default');

  // 7. The selected membership ends: the sign-in is asked to choose again.
  await pool.query('update identity.staff_facility_memberships set active = false, row_version = row_version + 1 where id = $1',
    [doctor.memberships[beta]]);
  const ended = await session(current);
  reports(ended, alpha, 'reselect');
  assert.deepEqual(ended.body.actor.facilityIds, [alpha]);
  const endedRefresh = await refresh(current);
  reports(endedRefresh.response, alpha, 'reselect');
  assert.equal((await rows(doctor.id))[0]?.facility_id, beta, 'the stored selection is left for the user to replace');
  const refusedEnded = await select(endedRefresh.held, beta);
  assert.equal(refusedEnded.status, 403, JSON.stringify(refusedEnded.body));
  assert.equal(refusedEnded.body.code, 'FACILITY_ACCESS_DENIED');
  const reselected = await select(endedRefresh.held, alpha);
  reports(reselected, alpha, 'selected');
  assert.deepEqual((await rows(doctor.id)).map(row => [row.family_id, row.facility_id, row.row_version]), [[first.sessionId, alpha, 2]]);
  reports(await session(endedRefresh.held), alpha, 'selected');
  checks.push('after the selected membership is deactivated in SQL, GET /auth/session and refresh report the default facility with reselect; selecting it again is 403; selecting an active facility replaces the row (row_version 2) and reports selected');

  // 8. The database guard refuses what the API would never write: a selection of
  // an ended membership, another account's sign-in, a patient sign-in, a delete.
  const patient = await signIn(patientAccount, 'patient');
  const guardRefusal = async (label, sql, values, code) => {
    const client = await pool.connect();
    await assert.rejects(asRuntime(client, () => client.query(sql, values)),
      (error) => error.code === code || assert.fail(`${label}: ${error.code} ${error.message}`), label);
  };
  const insertSql = `insert into auth.session_facility_selection (family_id, account_id, facility_id, membership_id)
    values ($1, $2, $3, $4)`;
  await guardRefusal('inactive membership', insertSql, [second.sessionId, doctor.id, beta, doctor.memberships[beta]], '23514');
  await guardRefusal('another account\'s family', insertSql, [second.sessionId, colleague.id, gamma, colleague.memberships[gamma]], '23514');
  await guardRefusal('a patient family', insertSql, [patient.sessionId, patientAccount.id, alpha, doctor.memberships[alpha]], '23514');
  await guardRefusal('delete', 'delete from auth.session_facility_selection where family_id = $1', [first.sessionId], '42501');
  checks.push('as hid_identity_api_runtime the database guard refuses a selection of an ended membership, of another account\'s sign-in and of a patient sign-in (23514), and the runtime cannot delete one (42501)');

  // 9. Patient sessions are unchanged.
  const patientSession = await session(patient);
  assert.equal(patientSession.status, 200); assert.equal('facilitySelection' in patientSession.body, false);
  assert.equal('facilitySelection' in patient.body, false);
  const patientSelect = await select(patient, alpha);
  assert.equal(patientSelect.status, 403); assert.equal(patientSelect.body.code, 'PATIENT_SCOPE_DENIED');
  const patientRefresh = await refresh(patient);
  assert.equal(patientRefresh.response.status, 200); assert.equal('facilitySelection' in patientRefresh.response.body, false);
  assert.equal((await rows(patientAccount.id)).length, 0);
  checks.push('a patient sign-in, session read and refresh carry no facilitySelection, and its POST /auth/facility is 403 PATIENT_SCOPE_DENIED with no row');

  // 10. A sign-out that gets the account lock first ends the sign-in before a
  // selection waiting for the lock is written: the selection is 401 and writes nothing.
  const racing = await signIn(doctor);
  const lockWaiters = async (count) => {
    let most = 0;
    for (const deadline = Date.now() + 10_000; most < count && Date.now() < deadline;) {
      const { rows: waiting } = await pool.query(`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
      most = Math.max(most, waiting[0].n);
      if (most < count) await new Promise(done => setTimeout(done, 20));
    }
    return most;
  };
  const holder = await pool.connect();
  let raced;
  try {
    await holder.query('begin');
    await holder.query('select auth.lock_account_sessions($1)', [doctor.id]);
    const pending = Promise.resolve(select(racing, alpha));
    assert.equal(await lockWaiters(1), 1, 'the selection waited at the account lock');
    // As TokenService.revoke ends a sign-in, under the same lock.
    await holder.query(`update auth.sessions set revoked_at = clock_timestamp(), revocation_reason = 'logout',
      row_version = row_version + 1 where family_id = $1 and revoked_at is null`, [racing.sessionId]);
    await holder.query('commit');
    raced = await pending;
  } finally { holder.release(); }
  assert.equal(raced.status, 401, JSON.stringify(raced.body));
  assert.equal((await rows(doctor.id)).filter(row => row.family_id === racing.sessionId).length, 0);
  assert.equal((await selectionAudits(racing.sessionId)).length, 0);
  const racedRefusals = await refusalAudits(racing.sessionId);
  assert.equal(racedRefusals.length, 1, JSON.stringify(racedRefusals));
  assert.ok(unscopedStaffRefusals(racedRefusals), JSON.stringify(racedRefusals));
  checks.push('a selection waiting at the account lock while a sign-out ends the sign-in answers 401 and writes neither a row nor a selection audit, only its failure row');

  // 11. Sign-out leaves the row; the signed-out sign-in never reads or writes it again.
  const signOut = await http.post('/api/v1/auth/logout').set('Cookie', cookie(endedRefresh.held.cookies)).set('Origin', origin)
    .set('x-csrf-token', endedRefresh.held.cookies[`${name}_csrf`]);
  assert.equal(signOut.status, 204, JSON.stringify(signOut.body));
  assert.equal((await rows(doctor.id)).filter(row => row.family_id === first.sessionId).length, 1, 'sign-out leaves the row');
  assert.equal((await session(endedRefresh.held)).status, 401);
  assert.equal((await select(endedRefresh.held, alpha)).status, 401);
  await guardRefusal('a signed-out family', `update auth.session_facility_selection set selected_at = clock_timestamp(),
    row_version = row_version + 1 where family_id = $1`, [first.sessionId], '23514');
  checks.push('sign-out leaves the row in place; the signed-out sign-in can neither read the session nor select (401), and the guard refuses any change to its row');

  process.stdout.write(`${JSON.stringify({ status: 'passed', scope: 'local-synthetic-only', role: 'hid_identity_api_runtime', checks })}\n`);
} finally {
  // Never leave the Identity runtime without its read grant.
  if (selectionReadRevoked) await pool.query('grant select on auth.session_facility_selection to hid_identity_runtime');
  if (app) await app.close();
  await pool.end();
}
