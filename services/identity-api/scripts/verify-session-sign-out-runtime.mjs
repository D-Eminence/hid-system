#!/usr/bin/env node
// Sign-out and refresh of browser cookie sessions over HTTP, every query as
// hid_identity_api_runtime. A browser whose access cookie has expired still
// holds its refresh cookie, so sign-out must end that sign-in by its refresh
// token, and only that one. The staff and patient apps share the cookies, so
// a client that names itself must not refresh, and so rotate, or sign out the
// other's sign-in. Executes only against the owned disposable synthetic rehearsal.
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

  const jar = response => Object.fromEntries(response.headers['set-cookie'].map(value => value.split(';')[0].split('=')));
  const cookie = cookies => Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; ');
  const signIn = async (who, kind) => {
    const response = await http.post(kind === 'patient' ? '/api/v1/auth/patient/login' : '/api/v1/auth/login')
      .set('Origin', origin).send({ email: who.email, password, turnstileAction: `${kind}-login` });
    assert.equal(response.status, 200, `${kind} sign-in: ${JSON.stringify(response.body)}`);
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
    assert.deepEqual(cleared, [name, `${name}_csrf`, `${name}_refresh`], `cookies cleared: ${response.headers['set-cookie']}`);
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
  checks.push('a sign-out carrying only the refresh cookie and its CSRF token ends that sign-in (logout, presented: refresh_token, audited) and clears all three cookies; the refresh cookie no longer refreshes, and replaying it records no second sign-out');

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
  checks.push('patient-web refreshing a staff sign-in and staff-web refreshing a patient sign-in are 403 SESSION_CLIENT_MISMATCH with no cookie set and the sign-in unrotated; each app then refreshes its own; a client that does not name itself refreshes as before; an ended sign-in sent with the other app\'s name is refused by refresh as 401 with its cookies cleared; a staff sign-in signs out by its refresh cookie');

  // 7. X-HID-Client on sign-out: each app ends only its own kind of sign-in, on
  // either path; the other app's is refused, nothing ends and its cookies stay.
  const logoutAs = (cookies, client) => logout(cookies, cookies[`${name}_csrf`], { Origin: origin, 'x-hid-client': client });
  const logoutEvents = async (id) => Number((await pool.query(`select count(*) from auth.session_events
    where session_id = $1 and event_type = 'logout'`, [id])).rows[0].count);
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
  }
  const ownStaff = await logoutAs(heldStaff.cookies, 'staff-web');
  assert.equal(ownStaff.status, 204, JSON.stringify(ownStaff.body)); clearsAll(ownStaff);
  assert.equal(await live(heldStaff.sessionId), false);
  const ownPatient = await logoutAs(refreshOnly(heldPatient.cookies), 'patient-web');
  assert.equal(ownPatient.status, 204, JSON.stringify(ownPatient.body)); clearsAll(ownPatient);
  assert.equal(await live(heldPatient.sessionId), false);
  checks.push('a cookie sign-out naming the other app (patient-web with a staff sign-in, staff-web with a patient one), by refresh cookie or by live access cookie, is 403 SESSION_CLIENT_MISMATCH with no cookie set, the sign-in live and no sign-out recorded; naming its own app, each ends its sign-in and clears the cookies');

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

  process.stdout.write(`${JSON.stringify({ status: 'passed', scope: 'local-synthetic-only', role: 'hid_identity_api_runtime', checks })}\n`);
} finally { if (app) await app.close(); await pool.end(); }
