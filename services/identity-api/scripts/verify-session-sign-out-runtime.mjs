#!/usr/bin/env node
// Sign-out and refresh of browser cookie sessions over HTTP, every query as
// hid_identity_api_runtime. A browser whose access cookie has expired still
// holds its refresh cookie, so sign-out must end that sign-in by its refresh
// token, and only that one. The staff and patient apps share the cookies, so
// a client that names itself must not refresh, and so rotate, or sign out the
// other's sign-in while refresh could renew it; any other sign-in a sign-out
// ends without naming its kind. A sign-in, a refresh and a sign-out also
// expire the public patient enrollment cookie. Executes only against the owned
// disposable synthetic rehearsal.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'staging',
  NIN_PROVIDER_MODE: 'deferred', TURNSTILE_MODE: 'disabled' });
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
const { ProblemDetailsFilter } = load('common/problem.ts');
const { getEnvironment } = load('config/environment.ts');
const pool = new Pool({ host: socket, user: process.env.PGUSER, database: process.env.PGDATABASE, max: 5 });
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
try {
  const module = await Test.createTestingModule({ controllers: [AuthController],
    providers: [{ provide: DatabaseService, useValue: database }, TokenService, LocalAuthProvider,
      CurrentStaffContextService, CurrentPatientContextService, AuthService, AuthSessionAuditService,
      AuditService, WorkloadAuthService, TurnstileService,
      { provide: GoogleAuthenticationService, useValue: {} }] }).compile();
  app = module.createNestApplication({ logger: false });
  app.use(require('cookie-parser')());
  app.use((req, _res, next) => { req.correlationId = randomUUID(); next(); });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalGuards(new SecurityGuard(module.get(Reflector), module.get(TokenService), module.get(AuditService), module.get(DatabaseService)));
  // As AppModule registers it (APP_INTERCEPTOR): every refusal is audited, and a
  // failed audit write answers 503. Without it a refusal's audit is never tried.
  app.useGlobalInterceptors(new AuditInterceptor(module.get(Reflector), module.get(AuditService)));
  await app.init();
  const http = request(app.getHttpServer());
  const origin = process.env.CORS_ORIGINS.split(',')[0];
  const name = getEnvironment().AUTH_COOKIE_NAME;

  // Fixture: two patients and one doctor, synthetic accounts only.
  const argon2 = require('argon2');
  const password = 'Synthetic-Sign-Out-Password-2026';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const account = async (label) => {
    const id = randomUUID();
    const email = `${label}-${id}@example.invalid`;
    await pool.query(`insert into auth.accounts(id,subject,email,display_name,status,password_hash,password_algorithm)
      values($1,$2,$3,$4,'active',$5,'argon2id')`, [id, `synthetic:sign-out:${label}:${id}`, email, `Synthetic ${label}`, passwordHash]);
    return { id, email };
  };
  const patient = async (label, hid) => {
    const created = await account(label);
    await pool.query(`insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status)
      values($1,$2,$3,'Sign','Out','Sign Out','active')`, [randomUUID(), created.id, hid]);
    return created;
  };
  // HID codes use the unambiguous alphabet (no I, O, 0 or 1).
  const hidCode = () => `HID-SGN${Array.from(randomBytes(8), (byte) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[byte % 32]).join('')}`;
  const ada = await patient('patient-ada', hidCode());
  const bola = await patient('patient-bola', hidCode());
  const doctor = await account('doctor');
  const ids = { org: randomUUID(), facility: randomUUID(), staff: randomUUID(), membership: randomUUID() };
  await pool.query("insert into identity.organizations(id,name,slug) values($1,'Sign-out Rehearsal Org',$2)", [ids.org, `sign-out-${ids.org}`]);
  await pool.query(`insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
    values($1,$2,'Sign-out Rehearsal Hospital',$3,'Africa/Lagos',true,'verified')`, [ids.facility, ids.org, `SGN-${ids.facility.slice(0, 6)}`]);
  await pool.query(`insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
    values($1,$2,'Synthetic doctor',$3,'verified','doctor')`, [ids.staff, doctor.id, doctor.email]);
  await pool.query(`insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,app_role,is_primary,active)
    values($1,$2,$3,$4,$5,'doctor','doctor',true,true)`, [ids.membership, ids.staff, doctor.id, ids.org, ids.facility]);
  await pool.query(`insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
    values($1,$2,'doctor','facility',$3,$4,'Synthetic rehearsal role')`, [randomUUID(), doctor.id, ids.membership, ids.facility]);

  // A browser drops a cookie whose Set-Cookie has expired it, and sends the rest.
  const expired = value => /Expires=Thu, 01 Jan 1970/i.test(value);
  const jar = response => Object.fromEntries(response.headers['set-cookie'].filter(value => !expired(value))
    .map(value => value.split(';')[0].split('=')));
  const cookie = cookies => Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; ');
  // The public patient enrollment cookie, expired on the path its controller sets it on.
  const retiresEnrollment = (response, label) => {
    const enrollment = (response.headers['set-cookie'] ?? []).filter(value => value.startsWith('hid_enrollment='));
    assert.equal(enrollment.length, 1, `${label} must expire the enrollment cookie: ${response.headers['set-cookie']}`);
    assert(expired(enrollment[0]) && /; Path=\/api\/v1\/identity\/patient-enrollments(;|$)/i.test(enrollment[0])
      && /; HttpOnly/i.test(enrollment[0]) && /; Secure/i.test(enrollment[0]) && /; SameSite=Strict/i.test(enrollment[0]),
    `${label} enrollment cookie: ${enrollment[0]}`);
  };
  const signIn = async (who, kind) => {
    const response = await http.post(kind === 'patient' ? '/api/v1/auth/patient/login' : '/api/v1/auth/login')
      .set('Origin', origin).send({ email: who.email, password, turnstileAction: `${kind}-login` });
    assert.equal(response.status, 200, `${kind} sign-in: ${JSON.stringify(response.body)}`);
    retiresEnrollment(response, `${kind} sign-in`);
    return { cookies: jar(response), sessionId: response.body.actor.sessionId };
  };
  const session = async (id) => (await pool.query(`select id::text, revoked_at, revocation_reason from auth.sessions
    where id = $1`, [id])).rows[0];
  const live = async (id) => { const row = await session(id); assert(row, `session ${id} exists`); return row.revoked_at === null; };
  const refreshOnly = ({ [name]: _access, ...rest }) => rest;
  const logout = (cookies, csrf, headers = { Origin: origin }) => {
    const call = http.post('/api/v1/auth/logout').set('Cookie', cookie(cookies));
    for (const [key, value] of Object.entries(headers)) call.set(key, value);
    return csrf === undefined ? call : call.set('x-csrf-token', csrf);
  };
  const clearsAll = (response) => {
    const cleared = (response.headers['set-cookie'] ?? []).filter(value => /Expires=Thu, 01 Jan 1970/i.test(value))
      .map(value => value.split('=')[0]).sort();
    assert.deepEqual(cleared, [name, `${name}_csrf`, `${name}_refresh`, 'hid_enrollment'].sort(),
      `cookies cleared: ${response.headers['set-cookie']}`);
    retiresEnrollment(response, 'clearing the session cookies');
  };
  const checks = [];

  // 1. The access cookie has expired (the browser dropped it): the refresh cookie signs out.
  const first = await signIn(ada, 'patient');
  const loggedOut = await logout(refreshOnly(first.cookies), first.cookies[`${name}_csrf`]);
  assert.equal(loggedOut.status, 204, JSON.stringify(loggedOut.body)); clearsAll(loggedOut);
  const ended = await session(first.sessionId);
  assert(ended.revoked_at && ended.revocation_reason === 'logout', JSON.stringify(ended));
  const event = (await pool.query(`select details from auth.session_events where session_id = $1 and event_type = 'logout'`,
    [first.sessionId])).rows[0];
  assert.equal(event?.details?.presented, 'refresh_token', JSON.stringify(event));
  assert.equal(Number((await pool.query(`select count(*) from audit.events where action = 'auth.logout'
    and actor_account_id = $1 and resource_id = $2`, [ada.id, first.sessionId])).rows[0].count), 1);
  const reuse = await http.post('/api/v1/auth/refresh').set('Cookie', cookie(refreshOnly(first.cookies))).set('Origin', origin)
    .set('x-csrf-token', first.cookies[`${name}_csrf`]);
  assert.equal(reuse.status, 401, JSON.stringify(reuse.body));
  const replayed = await logout(refreshOnly(first.cookies), first.cookies[`${name}_csrf`]);
  assert.equal(replayed.status, 204); clearsAll(replayed);
  assert.equal(Number((await pool.query(`select count(*) from auth.session_events where session_id = $1 and event_type = 'logout'`,
    [first.sessionId])).rows[0].count), 1, 'a replayed sign-out cookie records no second sign-out');
  checks.push('a sign-out carrying only the refresh cookie and its CSRF token ends that sign-in (logout, presented: refresh_token, audited) and clears all three cookies and the enrollment cookie; the refresh cookie no longer refreshes, and replaying it records no second sign-out');

  // 2. An access cookie that is no longer live (the sign-in rotated in another tab) falls back to the refresh cookie.
  const rotating = await signIn(ada, 'patient');
  const rotated = await http.post('/api/v1/auth/refresh').set('Cookie', cookie(rotating.cookies)).set('Origin', origin)
    .set('x-csrf-token', rotating.cookies[`${name}_csrf`]);
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  const mixedTabs = { ...jar(rotated), [name]: rotating.cookies[name] };
  const staleLogout = await logout(mixedTabs, mixedTabs[`${name}_csrf`]);
  assert.equal(staleLogout.status, 204, JSON.stringify(staleLogout.body));
  assert.equal(await live(rotated.body.actor.sessionId), false);
  checks.push('a sign-out whose access cookie is no longer live ends the sign-in of its refresh cookie');

  // 3. One account's live access cookie with another account's refresh cookie ends only the first.
  const a = await signIn(ada, 'patient');
  const b = await signIn(bola, 'patient');
  const mixed = await logout({ [name]: a.cookies[name], [`${name}_refresh`]: b.cookies[`${name}_refresh`],
    [`${name}_csrf`]: a.cookies[`${name}_csrf`] }, a.cookies[`${name}_csrf`]);
  assert.equal(mixed.status, 204, JSON.stringify(mixed.body));
  assert.equal(await live(a.sessionId), false); assert.equal(await live(b.sessionId), true);
  checks.push('a live access cookie decides: with another account\'s refresh cookie alongside, only the access cookie\'s sign-in ends');

  // 4. Another account's refresh cookie cannot be ended with this session's CSRF token.
  const c = await signIn(ada, 'patient');
  for (const [label, cookies, header] of [
    ['this session\'s CSRF cookie and header', { [`${name}_refresh`]: b.cookies[`${name}_refresh`], [`${name}_csrf`]: c.cookies[`${name}_csrf`] }, c.cookies[`${name}_csrf`]],
    ['its own CSRF cookie and this session\'s header', { [`${name}_refresh`]: b.cookies[`${name}_refresh`], [`${name}_csrf`]: b.cookies[`${name}_csrf`] }, c.cookies[`${name}_csrf`]],
    ['no CSRF header', { [`${name}_refresh`]: b.cookies[`${name}_refresh`], [`${name}_csrf`]: b.cookies[`${name}_csrf`] }, undefined],
  ]) {
    const refused = await logout(cookies, header);
    assert.equal(refused.status, 403, `${label}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, 'CSRF_VALIDATION_FAILED', label); clearsAll(refused);
    assert.equal(await live(b.sessionId), true, label);
  }
  const bStill = await http.post('/api/v1/auth/refresh').set('Cookie', cookie(b.cookies)).set('Origin', origin)
    .set('x-csrf-token', b.cookies[`${name}_csrf`]);
  assert.equal(bStill.status, 200, JSON.stringify(bStill.body));
  checks.push('another account\'s refresh cookie with this session\'s CSRF token, a mismatched header or none is 403 CSRF_VALIDATION_FAILED and that sign-in stays live and refreshable');

  // 5. A cookie sign-out from no or an unapproved Origin changes nothing, cookies included.
  for (const headers of [{}, { Origin: 'https://attacker.example' }]) {
    const refused = await logout(refreshOnly(c.cookies), c.cookies[`${name}_csrf`], headers);
    assert.equal(refused.status, 403, JSON.stringify(refused.body)); assert.equal(refused.body.code, 'ORIGIN_DENIED');
    assert.equal(refused.headers['set-cookie'], undefined); assert.equal(await live(c.sessionId), true);
  }
  const nothing = await logout({}, undefined);
  assert.equal(nothing.status, 204); clearsAll(nothing);
  checks.push('a cookie sign-out without an approved Origin is 403 ORIGIN_DENIED and sets no cookie; with no sign-in left it is 204 and clears the cookies');

  // 6. X-HID-Client: each app refreshes only its own kind of sign-in, refused without rotating.
  const refresh = (cookies, client) => {
    const call = http.post('/api/v1/auth/refresh').set('Cookie', cookie(cookies)).set('Origin', origin)
      .set('x-csrf-token', cookies[`${name}_csrf`]);
    return client ? call.set('x-hid-client', client) : call;
  };
  const staff = await signIn(doctor, 'staff');
  const patientSession = await signIn(ada, 'patient');
  for (const [label, held, client, kind] of [['patient-web', staff, 'patient-web', 'staff'],
    ['staff-web', patientSession, 'staff-web', 'patient']]) {
    const refused = await refresh(held.cookies, client);
    assert.equal(refused.status, 403, `${label}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, 'SESSION_CLIENT_MISMATCH'); assert.match(refused.body.detail, new RegExp(kind));
    assert.equal(refused.headers['set-cookie'], undefined, `${label} must keep the other app's cookies`);
    assert.equal(await live(held.sessionId), true, `${label} must not rotate the other app's sign-in`);
  }
  const kindOf = async (id) => (await pool.query('select session_kind from auth.sessions where id = $1', [id])).rows[0]?.session_kind;
  const staffRotated = await refresh(staff.cookies, 'staff-web');
  assert.equal(staffRotated.status, 200, JSON.stringify(staffRotated.body));
  retiresEnrollment(staffRotated, 'a refresh');
  assert.equal(await kindOf(staffRotated.body.actor.sessionId), 'staff');
  assert.equal(await live(staff.sessionId), false, 'the staff sign-in rotated');
  const patientRotated = await refresh(patientSession.cookies, 'patient-web');
  assert.equal(patientRotated.status, 200, JSON.stringify(patientRotated.body));
  assert.equal(await kindOf(patientRotated.body.actor.sessionId), 'patient');
  const unnamed = await refresh(jar(staffRotated), undefined);
  assert.equal(unnamed.status, 200, JSON.stringify(unnamed.body));
  // A dead sign-in has no kind to protect: refresh() refuses it and clears its cookies.
  const signedOut = await signIn(ada, 'patient');
  assert.equal((await logout(signedOut.cookies, signedOut.cookies[`${name}_csrf`])).status, 204);
  const dead = await refresh(signedOut.cookies, 'staff-web');
  assert.equal(dead.status, 401, JSON.stringify(dead.body)); clearsAll(dead);
  // A staff sign-in signs out by its refresh cookie too.
  const staffJar = jar(unnamed);
  const staffOut = await logout(refreshOnly(staffJar), staffJar[`${name}_csrf`]);
  assert.equal(staffOut.status, 204, JSON.stringify(staffOut.body)); clearsAll(staffOut);
  assert.equal(await live(unnamed.body.actor.sessionId), false);
  checks.push('patient-web refreshing a staff sign-in and staff-web refreshing a patient sign-in are 403 SESSION_CLIENT_MISMATCH with no cookie set and the sign-in unrotated; each app then refreshes its own; a client that does not name itself refreshes as before; an ended sign-in sent with the other app\'s name is refused by refresh as 401 with its cookies cleared; a staff sign-in signs out by its refresh cookie; every sign-in and refresh expires the enrollment cookie');

  // 7. X-HID-Client on sign-out: each app ends only its own kind of sign-in, on
  // either path; the other app's is refused, nothing ends and its cookies stay.
  const logoutAs = (cookies, client) => logout(cookies, cookies[`${name}_csrf`], { Origin: origin, 'x-hid-client': client });
  const logoutEvents = async (id) => Number((await pool.query(`select count(*) from auth.session_events
    where session_id = $1 and event_type = 'logout'`, [id])).rows[0].count);
  // The refusal of a live access cookie's sign-out, audited against its actor as an
  // auth.logout session event with no facility (none is bound to sign-out).
  const refusedSignOuts = async (id, actorType) => Number((await pool.query(`select count(*) from audit.events
    where action = 'auth.logout' and outcome = 'failure' and resource_type = 'session' and resource_id = $1
      and actor_type = $2 and facility_id is null and actor_membership_id is null`, [id, actorType])).rows[0].count);
  const heldStaff = await signIn(doctor, 'staff');
  const heldPatient = await signIn(bola, 'patient');
  for (const [label, held, cookies, client, kind] of [
    ['patient-web with a staff refresh cookie', heldStaff, refreshOnly(heldStaff.cookies), 'patient-web', 'staff'],
    ['staff-web with a patient refresh cookie', heldPatient, refreshOnly(heldPatient.cookies), 'staff-web', 'patient'],
    // A staff actor from CurrentStaffContextService carries no kind.
    ['patient-web with a live staff access cookie', heldStaff, heldStaff.cookies, 'patient-web', 'staff'],
    ['staff-web with a live patient access cookie', heldPatient, heldPatient.cookies, 'staff-web', 'patient'],
  ]) {
    const refused = await logoutAs(cookies, client);
    assert.equal(refused.status, 403, `${label}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, 'SESSION_CLIENT_MISMATCH', label); assert.match(refused.body.detail, new RegExp(kind));
    assert.equal(refused.headers['set-cookie'], undefined, `${label} must keep the other app's cookies`);
    assert.equal(await live(held.sessionId), true, `${label} must not end the other app's sign-in`);
    assert.equal(await logoutEvents(held.sessionId), 0, `${label} records no sign-out`);
    if (cookies[name]) assert.equal(await refusedSignOuts(held.sessionId, kind), 1, `${label} records its refusal`);
  }
  // A live staff access cookie with the wrong CSRF token is refused as such, audited, and ends nothing.
  const csrfRefused = await logout(heldStaff.cookies, 'not-the-csrf-token', { Origin: origin, 'x-hid-client': 'staff-web' });
  assert.equal(csrfRefused.status, 403, JSON.stringify(csrfRefused.body));
  assert.equal(csrfRefused.body.code, 'CSRF_VALIDATION_FAILED');
  assert.equal(await live(heldStaff.sessionId), true, 'a CSRF refusal ends nothing');
  assert.equal(await refusedSignOuts(heldStaff.sessionId, 'staff'), 2, 'the CSRF refusal is audited');
  const ownStaff = await logoutAs(heldStaff.cookies, 'staff-web');
  assert.equal(ownStaff.status, 204, JSON.stringify(ownStaff.body)); clearsAll(ownStaff);
  assert.equal(await live(heldStaff.sessionId), false);
  const ownPatient = await logoutAs(refreshOnly(heldPatient.cookies), 'patient-web');
  assert.equal(ownPatient.status, 204, JSON.stringify(ownPatient.body)); clearsAll(ownPatient);
  assert.equal(await live(heldPatient.sessionId), false);
  checks.push('a cookie sign-out naming the other app (patient-web with a staff sign-in, staff-web with a patient one), by refresh cookie or by live access cookie, is 403 SESSION_CLIENT_MISMATCH with no cookie set, the sign-in live and no sign-out recorded; naming its own app, each ends its sign-in and clears the cookies');
  checks.push('with the audit interceptor registered as in AppModule, a refused sign-out of a live staff or patient access cookie (mismatch, or a wrong CSRF token) answers its 403, not 503, and is audited as an auth.logout failure of that session with no facility or membership');

  // 8. A rotated cookie whose sign-in has ended finds nothing more to end.
  const before = await signIn(ada, 'patient');
  const after = await refresh(before.cookies, 'patient-web');
  assert.equal(after.status, 200, JSON.stringify(after.body));
  const byOldCookie = await logout(refreshOnly(before.cookies), before.cookies[`${name}_csrf`]);
  assert.equal(byOldCookie.status, 204, JSON.stringify(byOldCookie.body)); clearsAll(byOldCookie);
  assert.equal(await live(after.body.actor.sessionId), false, 'a sign-out by the just-rotated cookie ends the sign-in it rotated into');
  const replayedOld = await logout(refreshOnly(before.cookies), before.cookies[`${name}_csrf`]);
  assert.equal(replayedOld.status, 204); clearsAll(replayedOld);
  assert.equal(await logoutEvents(before.sessionId), 1, 'a replayed rotated cookie records no second sign-out');
  assert.equal(Number((await pool.query(`select count(*) from audit.events where action = 'auth.logout'
    and outcome = 'success' and resource_id = $1`, [before.sessionId])).rows[0].count), 1, 'nor a second sign-out audit');
  checks.push('a sign-out by a just-rotated refresh cookie ends the sign-in it rotated into; replaying that cookie once the sign-in has ended records no second sign-out event or audit');

  // 9. A rotated token tells its kind only moments after rotation (the other
  // app's tab refreshed first). Older, it is reuse, which refresh() answers
  // by ending the whole sign-in.
  const racing = await signIn(doctor, 'staff');
  const raced = await refresh(racing.cookies, 'staff-web');
  assert.equal(raced.status, 200, JSON.stringify(raced.body));
  const justRotated = await refresh(racing.cookies, 'patient-web');
  assert.equal(justRotated.status, 403, JSON.stringify(justRotated.body));
  assert.equal(justRotated.body.code, 'SESSION_CLIENT_MISMATCH');
  assert.equal(justRotated.headers['set-cookie'], undefined);
  assert.equal(await live(raced.body.actor.sessionId), true, 'a refresh that raced the other app leaves its sign-in live');
  // Age the rotation past the grace window (owner write to the disposable rehearsal only).
  await pool.query(`update auth.sessions set revoked_at = revoked_at - interval '2 minutes' where id = $1`, [racing.sessionId]);
  const staleRotated = await refresh(racing.cookies, 'patient-web');
  assert.equal(staleRotated.status, 401, JSON.stringify(staleRotated.body)); clearsAll(staleRotated);
  assert.equal(await live(raced.body.actor.sessionId), false, 'an older rotated token is reuse: the whole sign-in ends');
  checks.push('a refresh token rotated moments ago, sent with the other app\'s name, is 403 SESSION_CLIENT_MISMATCH and its sign-in stays live; rotated more than a minute ago it is refresh-token reuse: 401, cookies cleared and the whole sign-in ended');

  // 10. The kind lookup answers only for a sign-in refresh() could renew: a
  // temporarily disabled account gets refresh()'s refusal, not the kind.
  const locked = await account('doctor-locked');
  const lockedStaff = randomUUID(); const lockedMembership = randomUUID();
  await pool.query(`insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
    values($1,$2,'Synthetic locked doctor',$3,'verified','doctor')`, [lockedStaff, locked.id, locked.email]);
  await pool.query(`insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,app_role,is_primary,active)
    values($1,$2,$3,$4,$5,'doctor','doctor',true,true)`, [lockedMembership, lockedStaff, locked.id, ids.org, ids.facility]);
  await pool.query(`insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
    values($1,$2,'doctor','facility',$3,$4,'Synthetic rehearsal role')`, [randomUUID(), locked.id, lockedMembership, ids.facility]);
  const lockedSignIn = await signIn(locked, 'staff');
  await pool.query(`update auth.accounts set disabled_until = clock_timestamp() + interval '1 hour' where id = $1`, [locked.id]);
  const lockedRefresh = await refresh(lockedSignIn.cookies, 'patient-web');
  assert.equal(lockedRefresh.status, 401, JSON.stringify(lockedRefresh.body)); clearsAll(lockedRefresh);
  checks.push('a refresh of a temporarily disabled account\'s sign-in sent with the other app\'s name gets refresh\'s 401 with its cookies cleared, not SESSION_CLIENT_MISMATCH');

  // 11. Sign-out names the other app only where refresh would: moments after
  // rotation. An older rotated token is reuse, so the sign-in ends whichever
  // app sends it, and the answer does not say whose it was or that it was live.
  const probed = await signIn(doctor, 'staff');
  const probedNext = await refresh(probed.cookies, 'staff-web');
  assert.equal(probedNext.status, 200, JSON.stringify(probedNext.body));
  const inGrace = await logoutAs(refreshOnly(probed.cookies), 'patient-web');
  assert.equal(inGrace.status, 403, JSON.stringify(inGrace.body));
  assert.equal(inGrace.body.code, 'SESSION_CLIENT_MISMATCH'); assert.equal(inGrace.headers['set-cookie'], undefined);
  assert.equal(await live(probedNext.body.actor.sessionId), true, 'a sign-out that raced the other app leaves its sign-in live');
  await pool.query(`update auth.sessions set revoked_at = revoked_at - interval '2 minutes' where id = $1`, [probed.sessionId]);
  const pastGrace = await logoutAs(refreshOnly(probed.cookies), 'patient-web');
  assert.equal(pastGrace.status, 204, JSON.stringify(pastGrace.body)); clearsAll(pastGrace);
  assert.equal(await live(probedNext.body.actor.sessionId), false, 'an older rotated token ends the sign-in it rotated into');
  assert.equal(await logoutEvents(probed.sessionId), 1);
  checks.push('a sign-out by a refresh token rotated moments ago, sent with the other app\'s name, is 403 SESSION_CLIENT_MISMATCH and its sign-in stays live; rotated more than a minute ago it is 204 with the cookies cleared and the whole sign-in ended, whichever app sends it');

  // 12. A sign-in refresh() cannot renew now is ended all the same: once the
  // account's timed suspension (section 10) lapses, nothing is left to renew.
  assert.equal(await live(lockedSignIn.sessionId), true, 'refresh() refused the suspended sign-in without ending it');
  const lockedOut = await logoutAs(refreshOnly(lockedSignIn.cookies), 'patient-web');
  assert.equal(lockedOut.status, 204, JSON.stringify(lockedOut.body)); clearsAll(lockedOut);
  assert.equal(await live(lockedSignIn.sessionId), false, 'a sign-out during a timed suspension ends the sign-in');
  await pool.query('update auth.accounts set disabled_until = null where id = $1', [locked.id]);
  const unlocked = await refresh(lockedSignIn.cookies, 'staff-web');
  assert.equal(unlocked.status, 401, JSON.stringify(unlocked.body)); clearsAll(unlocked);
  checks.push('a sign-out by refresh cookie while the account is suspended for a time, sent with the other app\'s name, is 204 and ends the sign-in; once the suspension lapses its refresh token is refused (401)');

  // 13. Two sign-outs at once with one browser's cookies (two tabs) end the
  // sign-in once, on either path. The account row is held locked until both
  // requests wait for it, so both have passed every check made before the
  // lock; the second then finds the sign-in ended and records nothing.
  const lockWaiters = async (count) => {
    let most = 0;
    for (const deadline = Date.now() + 10_000; most < count && Date.now() < deadline;) {
      const { rows } = await pool.query(`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
      most = Math.max(most, rows[0].n);
      if (most < count) await new Promise(done => setTimeout(done, 20));
    }
    return most;
  };
  const whileAccountLocked = async (accountId, requests) => {
    const holder = await pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select auth.lock_account_sessions($1)', [accountId]);
      const pending = requests.map(send => Promise.resolve(send()));
      const waiting = await lockWaiters(requests.length);
      await holder.query('commit');
      return { waiting, responses: await Promise.all(pending) };
    } finally { holder.release(); }
  };
  const signOutAudits = async (id) => Number((await pool.query(`select count(*) from audit.events where action = 'auth.logout'
    and outcome = 'success' and resource_id = $1`, [id])).rows[0].count);
  for (const [label, cookiesOf] of [['by refresh cookie', refreshOnly], ['by live access cookie', cookies => cookies]]) {
    const twoTabs = await signIn(bola, 'patient');
    const raced = await whileAccountLocked(bola.id, [0, 1].map(() => () =>
      logout(cookiesOf(twoTabs.cookies), twoTabs.cookies[`${name}_csrf`])));
    assert.equal(raced.waiting, 2, `${label}: both sign-outs waited at the account lock`);
    for (const response of raced.responses) { assert.equal(response.status, 204, `${label}: ${JSON.stringify(response.body)}`); clearsAll(response); }
    assert.equal(await live(twoTabs.sessionId), false, label);
    assert.equal(await logoutEvents(twoTabs.sessionId), 1, `${label}: concurrent sign-outs record one sign-out`);
    assert.equal(await signOutAudits(twoTabs.sessionId), 1, `${label}: and one sign-out audit`);
  }
  checks.push('two sign-outs at once with one browser\'s cookies, held at the account lock until both wait there, by refresh cookie and by live access cookie: both answer 204 and clear the cookies; the sign-in ends once, with one sign-out event and one audit');

  // 14. Facility selection is a session route: a refusal answers as such and is
  // audited as an auth.facility.select session event, though no facility is bound.
  const selecting = await signIn(doctor, 'staff');
  const select = (facilityId) => http.post('/api/v1/auth/facility').set('Cookie', cookie(selecting.cookies)).set('Origin', origin)
    .set('x-csrf-token', selecting.cookies[`${name}_csrf`]).send({ facilityId });
  const foreign = await select(randomUUID());
  assert.equal(foreign.status, 403, JSON.stringify(foreign.body)); assert.equal(foreign.body.code, 'FACILITY_ACCESS_DENIED');
  const malformed = await select('not-a-uuid');
  assert.equal(malformed.status, 400, JSON.stringify(malformed.body));
  assert.equal(Number((await pool.query(`select count(*) from audit.events where action = 'auth.facility.select'
    and outcome = 'failure' and resource_type = 'session' and resource_id = $1 and actor_type = 'staff'
    and facility_id is null and actor_membership_id is null`, [selecting.sessionId])).rows[0].count), 2,
  'both refused selections are audited');
  const own = await select(ids.facility);
  assert.equal(own.status, 200, JSON.stringify(own.body)); assert.equal(own.body.actor.facility.id, ids.facility);
  checks.push('a facility selection refused for a facility the staff member has no membership at (403 FACILITY_ACCESS_DENIED) or for a malformed id (400) answers its refusal, not 503, and is audited as an auth.facility.select failure of that session with no facility; selecting their own facility still succeeds');

  // 15. A sign-in whose actor refresh() can no longer resolve is not one refresh
  // could renew (SES-4): a staff sign-in whose facility membership was
  // deactivated, a patient sign-in whose patient is inactive. The app that
  // names the other kind gets refresh's own answer (401, cookies cleared) and
  // a sign-out that ends it (204), not SESSION_CLIENT_MISMATCH with the
  // cookies kept. The Origin and CSRF checks still come first.
  const lapsing = await account('doctor-lapsing');
  const lapsingStaff = randomUUID(); const lapsingMembership = randomUUID();
  await pool.query(`insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
    values($1,$2,'Synthetic lapsing doctor',$3,'verified','doctor')`, [lapsingStaff, lapsing.id, lapsing.email]);
  await pool.query(`insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,app_role,is_primary,active)
    values($1,$2,$3,$4,$5,'doctor','doctor',true,true)`, [lapsingMembership, lapsingStaff, lapsing.id, ids.org, ids.facility]);
  await pool.query(`insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
    values($1,$2,'doctor','facility',$3,$4,'Synthetic rehearsal role')`, [randomUUID(), lapsing.id, lapsingMembership, ids.facility]);
  const kept = await signIn(lapsing, 'staff');
  const endedByOtherApp = await signIn(lapsing, 'staff');
  // The membership lapses (owner write to the disposable rehearsal only).
  await pool.query('update identity.staff_facility_memberships set active = false where id = $1', [lapsingMembership]);
  const forgedLapsed = await http.post('/api/v1/auth/refresh').set('Cookie', cookie(kept.cookies)).set('Origin', origin)
    .set('x-csrf-token', 'forged').set('x-hid-client', 'patient-web');
  assert.equal(forgedLapsed.status, 403, JSON.stringify(forgedLapsed.body));
  assert.equal(forgedLapsed.body.code, 'CSRF_VALIDATION_FAILED'); assert.equal(forgedLapsed.headers['set-cookie'], undefined);
  const lapsedRefresh = await refresh(kept.cookies, 'patient-web');
  assert.equal(lapsedRefresh.status, 401,
    `An unrenewable staff sign-in refreshed by patient-web must get refresh's 401, not ${lapsedRefresh.status} ${JSON.stringify(lapsedRefresh.body)}`);
  clearsAll(lapsedRefresh);
  assert.equal(await live(kept.sessionId), true, 'refresh() refuses a sign-in whose membership lapsed without ending it');
  const lapsedOut = await logoutAs(refreshOnly(endedByOtherApp.cookies), 'patient-web');
  assert.equal(lapsedOut.status, 204,
    `An unrenewable staff sign-in signed out by patient-web must be ended (204), not ${lapsedOut.status} ${JSON.stringify(lapsedOut.body)}`);
  clearsAll(lapsedOut);
  assert.equal(await live(endedByOtherApp.sessionId), false, 'a sign-out by patient-web ends the unrenewable staff sign-in');
  assert.equal(await logoutEvents(endedByOtherApp.sessionId), 1);
  assert.equal(await signOutAudits(endedByOtherApp.sessionId), 1);
  // A patient whose patient record is no longer active.
  const lapsingPatient = await patient('patient-lapsing', hidCode());
  const patientKept = await signIn(lapsingPatient, 'patient');
  await pool.query("update identity.patients set status = 'inactive' where account_id = $1", [lapsingPatient.id]);
  const lapsedPatientRefresh = await refresh(patientKept.cookies, 'staff-web');
  assert.equal(lapsedPatientRefresh.status, 401,
    `An unrenewable patient sign-in refreshed by staff-web must get refresh's 401, not ${lapsedPatientRefresh.status} ${JSON.stringify(lapsedPatientRefresh.body)}`);
  clearsAll(lapsedPatientRefresh);
  // The membership is restored: the sign-in refresh() refused is renewable again.
  await pool.query('update identity.staff_facility_memberships set active = true where id = $1', [lapsingMembership]);
  const mismatchAgain = await refresh(kept.cookies, 'patient-web');
  assert.equal(mismatchAgain.status, 403, JSON.stringify(mismatchAgain.body));
  assert.equal(mismatchAgain.body.code, 'SESSION_CLIENT_MISMATCH'); assert.equal(mismatchAgain.headers['set-cookie'], undefined);
  const renewed = await refresh(kept.cookies, 'staff-web');
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  assert.equal(await kindOf(renewed.body.actor.sessionId), 'staff');
  checks.push('a staff sign-in whose facility membership lapsed, refreshed with patient-web, gets refresh\'s 401 with every cookie cleared (after the CSRF check, which still answers 403 first) and stays unended; signed out with patient-web it is ended (204, one sign-out event and audit); a patient sign-in whose patient is inactive, refreshed with staff-web, gets 401; once the membership is restored, patient-web is refused SESSION_CLIENT_MISMATCH again and staff-web renews it');

  process.stdout.write(`${JSON.stringify({ status: 'passed', scope: 'local-synthetic-only', role: 'hid_identity_api_runtime', checks })}\n`);
} finally { if (app) await app.close(); await pool.end(); }
