#!/usr/bin/env node
// Single sign-on on the product sites (0125, hid-system#142's ADR-070, owner decision Q92 B), run against the owned
// disposable synthetic rehearsal only, as the exact Identity runtime role. The provider on auth. is the in-process fake
// (src/testing/sso-fake-provider.ts), reached through SSO_HTTP: no network, no cloud call, no delivery. Proves with the
// real statements and grants that a hand-off issues today's session (staff through the site's product gate, patients
// as a patient sign-in), stores its provenance, ends by back-channel logout and by product sign-out, and that the
// product gate's refusal opens nothing.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
const ISSUER = 'https://auth.sso-runtime.invalid';
const PORTAL = 'https://app.sso-runtime.invalid';
// Production's product sites, so the product gate of section 53 applies to a staff hand-off there.
const LAB = 'https://lab.healthidentitydirectory.com';
const OUTREACH = 'https://outreach.healthidentitydirectory.com';
const PORTAL_SECRET = 'synthetic-sso-runtime-portal-secret-0001';
const LAB_SECRET = 'synthetic-sso-runtime-lab-secret-000000001';
const OUTREACH_SECRET = 'synthetic-sso-runtime-outreach-secret-0001';
Object.assign(process.env, {
  CORS_ORIGINS: `${PORTAL},${LAB},${OUTREACH}`, AUTH_COOKIE_SECURE: 'true',
  HID_DEPLOYMENT_ENV: 'staging', NIN_PROVIDER_MODE: 'deferred', TURNSTILE_MODE: 'disabled',
  IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'public-synthetic-ehr-workload-token',
  AUTH_SSO_ISSUER: ISSUER,
  AUTH_SSO_CLIENTS: JSON.stringify([
    { client_id: 'web', host: new URL(PORTAL).host, kind: 'patient', token_endpoint_auth_method: 'client_secret_basic' },
    { client_id: 'lab', host: new URL(LAB).host, kind: 'staff', token_endpoint_auth_method: 'client_secret_basic' },
    { client_id: 'outreach', host: new URL(OUTREACH).host, kind: 'staff', token_endpoint_auth_method: 'client_secret_basic' },
  ]),
  AUTH_SSO_CLIENT_CREDENTIALS: JSON.stringify({ web: { client_secret: PORTAL_SECRET }, lab: { client_secret: LAB_SECRET },
    outreach: { client_secret: OUTREACH_SECRET } }),
});
delete process.env.AUTH_SSO_INTERNAL_BASE_URL;
for (const key of ['NIN_LOOKUP_HMAC_KEY_B64', 'NIN_ENCRYPTION_KEY_B64', 'METAMAP_CLIENT_ID', 'METAMAP_CLIENT_SECRET',
  'QOREID_CLIENT_ID', 'QOREID_CLIENT_SECRET', 'QOREID_API_KEY']) delete process.env[key];
require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const load = path => require(join(service, 'src', path));
const { Pool } = require('pg');
const { Test } = require('@nestjs/testing');
const { Reflector } = require('@nestjs/core');
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
const { SsoController } = load('auth/sso/sso.controller.ts');
const { SsoService } = load('auth/sso/sso.service.ts');
const { SsoProviderClient, SSO_HTTP } = load('auth/sso/sso-provider.client.ts');
const { createFakeProvider } = load('testing/sso-fake-provider.ts');
const { requireRecentPatientAuthentication } = load('auth/recent-authentication.ts');
const pool = new Pool({ host: socket, user: process.env.PGUSER, database: process.env.PGDATABASE, max: 5 });
const asRuntime = async (client) => {
  await client.query('begin');
  await client.query('set local role hid_identity_api_runtime');
};
const database = {
  query: async (sql, values) => {
    const client = await pool.connect();
    try { await asRuntime(client); const result = await client.query(sql, values); await client.query('commit'); return result;
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  },
  withSystemTransaction: async (correlation, operation) => {
    const client = await pool.connect();
    try { await asRuntime(client);
      await client.query("select set_config('app.actor_subject','system:auth',true),set_config('app.correlation_id',$1,true)", [correlation]);
      const result = await operation(client); await client.query('commit'); return result;
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  },
};
const provider = await createFakeProvider(ISSUER, {
  web: { kind: 'patient', redirectUri: `${PORTAL}/api/v1/auth/sso/callback`, secret: PORTAL_SECRET },
  lab: { kind: 'staff', redirectUri: `${LAB}/api/v1/auth/sso/callback`, secret: LAB_SECRET },
  outreach: { kind: 'staff', redirectUri: `${OUTREACH}/api/v1/auth/sso/callback`, secret: OUTREACH_SECRET },
});
let app;
try {
  const module = await Test.createTestingModule({ controllers: [AuthController, SsoController],
    providers: [{ provide: DatabaseService, useValue: database }, TokenService, LocalAuthProvider,
      CurrentStaffContextService, CurrentPatientContextService, AuthService, AuthSessionAuditService,
      AuditService, WorkloadAuthService, TurnstileService, SsoService, SsoProviderClient,
      { provide: SSO_HTTP, useValue: provider.http },
      { provide: GoogleAuthenticationService, useValue: {} }] }).compile();
  app = module.createNestApplication({ logger: false });
  app.use(require('cookie-parser')());
  app.use((req, _res, next) => { req.correlationId = randomUUID(); next(); });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalGuards(new SecurityGuard(module.get(Reflector), module.get(TokenService), module.get(AuditService),
    module.get(DatabaseService)));
  await app.init();
  const http = () => request(app.getHttpServer());
  const cookies = response => [].concat(response.headers['set-cookie'] ?? []);
  const cookie = (response, name) => cookies(response).find(value => value.startsWith(`${name}=`))?.split(';')[0];
  const value = (response, name) => cookie(response, name)?.split('=').slice(1).join('=');
  /** start -> the fake provider's sign-in -> the callback, all on `origin`. */
  async function handOff(origin, claims, returnTo = '/') {
    const started = await http().get(`/api/v1/auth/sso/start?return_to=${encodeURIComponent(returnTo)}`)
      .set('X-HID-Edge-Origin', origin).expect(303);
    const location = new URL(started.headers.location);
    assert.equal(location.origin, ISSUER);
    const transaction = cookies(started).find(each => each.startsWith('__Host-hid_sso_tx_')).split(';')[0];
    const code = provider.authorize(location.href, claims);
    return http().get(`/api/v1/auth/sso/callback?code=${encodeURIComponent(code)}&state=${location.searchParams.get('state')}`)
      .set('X-HID-Edge-Origin', origin).set('Cookie', transaction).expect(303);
  }
  const rows = async (sql, values) => (await pool.query(sql, values)).rows;

  // A. A patient on the patients' site: today's patient session, with its provenance on the family.
  const patientAccount = randomUUID(), patientId = randomUUID();
  await pool.query("insert into auth.accounts(id,subject,email,display_name,status) values($1,$2,$3,'Synthetic patient','active')",
    [patientAccount, `synthetic:sso-runtime:patient:${patientAccount}`, `synthetic-sso-patient-${patientAccount}@example.invalid`]);
  await pool.query("insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status) values($1,$2,'HID-SSRUNTMEPT','Runtime','Patient','Runtime Patient','active')",
    [patientId, patientAccount]);
  const patient = await handOff(PORTAL, { sub: patientAccount, sid: 'sso-runtime-patient-sid', hid_kind: 'patient' });
  assert.equal(patient.headers.location, '/');
  const patientAccess = value(patient, 'hid_access');
  assert(patientAccess, 'The patient hand-off must set the session cookies');
  const patientSession = await http().get('/api/v1/auth/session').set('X-HID-Edge-Origin', PORTAL)
    .set('Cookie', `hid_access=${patientAccess}`).expect(200);
  assert.equal(patientSession.body.actor.kind, 'patient');
  assert.equal(patientSession.body.actor.patientId, patientId);
  const patientLinks = await rows(
    `select link.client_id, link.provider_sid, session.session_kind from auth.session_single_sign_on link
       join auth.sessions session on session.id = link.family_id where link.account_id = $1`, [patientAccount]);
  assert.deepEqual(patientLinks, [{ client_id: 'web', provider_sid: 'sso-runtime-patient-sid', session_kind: 'patient' }]);
  const patientEvent = await rows(
    "select details from auth.session_events where account_id = $1 and event_type = 'login_succeeded'", [patientAccount]);
  assert.equal(patientEvent[0].details.sso_client, 'web');

  // B. A verified staff account with no facility yet, on lab.: the product gate refuses it, as a password sign-in
  // there (NO_ACTIVE_FACILITY_MEMBERSHIP): no session, one auth.login.refused row, no failed sign-in.
  const staffAccount = randomUUID(), staffId = randomUUID();
  const staffSubject = `synthetic:sso-runtime:staff:${staffAccount}`;
  const staffEmail = `synthetic-sso-staff-${staffAccount}@example.invalid`;
  await pool.query("insert into auth.accounts(id,subject,email,display_name,status) values($1,$2,$3,'Synthetic staff','active')",
    [staffAccount, staffSubject, staffEmail]);
  await pool.query(`insert into identity.staff(id,account_id,full_name,email,verification_status,default_role,active)
    values($1,$2,'Synthetic Staff',$3,'verified','doctor',true)`, [staffId, staffAccount, staffEmail]);
  const staffClaims = { sub: staffAccount, sid: 'sso-runtime-staff-sid', hid_kind: 'staff', amr: ['pwd'] };
  const refused = await handOff(LAB, staffClaims, '/provider');
  assert.equal(refused.headers.location, '/provider/sign-in');
  assert(!cookies(refused).some(each => each.startsWith('hid_access')), 'A refused hand-off sets no session cookie');
  assert.deepEqual(await rows('select id from auth.sessions where account_id = $1', [staffAccount]), []);
  const refusal = await rows("select details from audit.events where action = 'auth.login.refused' and actor_subject = $1",
    [staffSubject]);
  assert.deepEqual(refusal.map(row => row.details), [{ reason: 'no_active_facility_membership', product: 'lab', singleSignOn: 'lab' }]);
  assert.deepEqual(await rows("select 1 from auth.session_events where account_id = $1 and event_type = 'login_failed'",
    [staffAccount]), []);

  // C. The same account on outreach.: its account-only session (Q88-2), bound to the outreach product.
  const outreach = await handOff(OUTREACH, staffClaims, '/provider');
  assert.equal(outreach.headers.location, '/provider');
  assert.match(value(outreach, 'hid_access_refresh'), /\.outreach\.local$/);
  const outreachAccess = value(outreach, 'hid_access');
  const outreachCsrf = value(outreach, 'hid_access_csrf');
  const outreachSession = await http().get('/api/v1/auth/session').set('X-HID-Edge-Origin', OUTREACH)
    .set('Cookie', `hid_access=${outreachAccess}`).expect(200);
  assert.equal(outreachSession.body.actor.accountOnly, true);
  assert.deepEqual(await rows('select client_id, provider_sid from auth.session_single_sign_on where account_id = $1', [staffAccount]),
    [{ client_id: 'outreach', provider_sid: 'sso-runtime-staff-sid' }]);

  // D. Back-channel logout of the patient's provider session ends that sign-in, once; the same token again is refused.
  const logoutToken = await provider.signLogoutToken({ aud: 'web', sid: 'sso-runtime-patient-sid' });
  await http().post('/api/v1/auth/sso/backchannel-logout').set('X-HID-Edge-Origin', PORTAL).type('form')
    .send(`logout_token=${logoutToken}`).expect(200);
  await http().post('/api/v1/auth/sso/backchannel-logout').set('X-HID-Edge-Origin', PORTAL).type('form')
    .send(`logout_token=${logoutToken}`).expect(400);
  assert.deepEqual(await rows("select revocation_reason from auth.sessions where account_id = $1", [patientAccount]),
    [{ revocation_reason: 'sso_logout' }]);
  await http().get('/api/v1/auth/session').set('X-HID-Edge-Origin', PORTAL).set('Cookie', `hid_access=${patientAccess}`).expect(401);
  assert.equal((await rows("select count(*)::integer n from auth.sso_spent_tokens where purpose = 'logout_token'"))[0].n, 1);

  // D2. The portal tab that sign-in ended still holds its refresh cookie: its next refresh is an ended sign-in,
  // refused and recorded as a denied refresh, never as refresh-token reuse; its family is left as it was.
  const patientRefresh = value(patient, 'hid_access_refresh');
  const patientCsrf = value(patient, 'hid_access_csrf');
  await http().post('/api/v1/auth/refresh').set('X-HID-Edge-Origin', PORTAL).set('Origin', PORTAL)
    .set('X-CSRF-Token', patientCsrf).set('Cookie', `hid_access_refresh=${patientRefresh}; hid_access_csrf=${patientCsrf}`)
    .expect(401);
  assert.deepEqual(await rows(`select event_type, outcome, details->>'revocation_reason' as reason from auth.session_events
    where account_id = $1 and event_type in ('refresh', 'reuse_detected')`, [patientAccount]),
  [{ event_type: 'refresh', outcome: 'denied', reason: 'sso_logout' }]);
  assert.deepEqual(await rows("select revocation_reason from auth.sessions where account_id = $1", [patientAccount]),
    [{ revocation_reason: 'sso_logout' }]);

  // D3. Product sign-out from that browser, with no sign-in left: the provider's end-session address all the same.
  const noSignIn = await http().post('/api/v1/auth/sso/logout').set('X-HID-Edge-Origin', PORTAL).set('Origin', PORTAL)
    .set('X-CSRF-Token', patientCsrf)
    .set('Cookie', `hid_access=${patientAccess}; hid_access_refresh=${patientRefresh}; hid_access_csrf=${patientCsrf}`).expect(200);
  assert.deepEqual(Object.fromEntries(new URL(noSignIn.body.endSessionUrl).searchParams),
    { client_id: 'web', post_logout_redirect_uri: `${PORTAL}/` });

  // D4. The patient recent-sign-in check reads 0125's row whether or not single sign-on is configured now: a
  // hand-off counts from the provider sign-in, so one from an hour ago is not recent even after the switch-off.
  const recentAt = async (sid) => {
    const [{ family_id: sessionId }] = await rows('select family_id from auth.session_single_sign_on where provider_sid = $1', [sid]);
    const ssoIssuer = process.env.AUTH_SSO_ISSUER;
    delete process.env.AUTH_SSO_ISSUER;
    try {
      await database.withSystemTransaction(randomUUID(), client => requireRecentPatientAuthentication(client,
        { sessionId, accountId: patientAccount, patientId }, 'A recent sign-in is required'));
      return true;
    } catch (error) {
      if (error?.code !== 'PATIENT_RECENT_AUTH_REQUIRED') throw error;
      return false;
    } finally {
      process.env.AUTH_SSO_ISSUER = ssoIssuer;
    }
  };
  await handOff(PORTAL, { sub: patientAccount, sid: 'sso-runtime-patient-sid-fresh', hid_kind: 'patient' });
  assert.equal(await recentAt('sso-runtime-patient-sid-fresh'), true, 'A hand-off just after the provider sign-in is recent');
  const earlier = await handOff(PORTAL, { sub: patientAccount, sid: 'sso-runtime-patient-sid-earlier', hid_kind: 'patient',
    auth_time: Math.floor(Date.now() / 1_000) - 3_600 });
  assert.equal(await recentAt('sso-runtime-patient-sid-earlier'), false,
    'A hand-off of a provider sign-in an hour old is not recent, with single sign-on switched off');

  // D5. Product sign-out by the refresh cookie alone (the access token gone): today's sign-out of that sign-in,
  // audited auth.logout, then every other patient sign-in of the account, and the end-session address.
  const earlierRefresh = value(earlier, 'hid_access_refresh');
  const earlierCsrf = value(earlier, 'hid_access_csrf');
  const byRefresh = await http().post('/api/v1/auth/sso/logout').set('X-HID-Edge-Origin', PORTAL).set('Origin', PORTAL)
    .set('X-CSRF-Token', earlierCsrf).set('Cookie', `hid_access_refresh=${earlierRefresh}; hid_access_csrf=${earlierCsrf}`)
    .expect(200);
  assert.deepEqual(Object.fromEntries(new URL(byRefresh.body.endSessionUrl).searchParams),
    { client_id: 'web', post_logout_redirect_uri: `${PORTAL}/` });
  assert.deepEqual(await rows(`select link.provider_sid, session.revocation_reason from auth.sessions session
      join auth.session_single_sign_on link on link.family_id = session.family_id
     where session.account_id = $1 order by link.provider_sid`, [patientAccount]),
  [{ provider_sid: 'sso-runtime-patient-sid', revocation_reason: 'sso_logout' },
    { provider_sid: 'sso-runtime-patient-sid-earlier', revocation_reason: 'logout' },
    { provider_sid: 'sso-runtime-patient-sid-fresh', revocation_reason: 'sso_logout' }]);
  assert.deepEqual(await rows(`select actor_type, action from audit.events where actor_account_id = $1
    and action in ('auth.logout', 'auth.sso.logout') order by action`, [patientAccount]),
  [{ actor_type: 'patient', action: 'auth.logout' }, { actor_type: 'patient', action: 'auth.sso.logout' }]);

  // E. Product sign-out on outreach.: today's sign-out, then the provider's end-session address, with no token in it.
  const signOut = await http().post('/api/v1/auth/sso/logout').set('X-HID-Edge-Origin', OUTREACH).set('Origin', OUTREACH)
    .set('X-CSRF-Token', outreachCsrf).set('Cookie', `hid_access=${outreachAccess}; hid_access_csrf=${outreachCsrf}`).expect(200);
  const endSession = new URL(signOut.body.endSessionUrl);
  assert.deepEqual(Object.fromEntries(endSession.searchParams), { client_id: 'outreach', post_logout_redirect_uri: `${OUTREACH}/` });
  assert.deepEqual(await rows("select count(*)::integer n from auth.sessions where account_id = $1 and revoked_at is null",
    [staffAccount]), [{ n: 0 }]);
  assert.deepEqual(await rows("select actor_type, details from audit.events where action = 'auth.sso.logout' and actor_subject = $1",
    [staffSubject]), [{ actor_type: 'staff', details: { client: 'outreach', endedSignIns: 0 } }]);

  // The provenance is never changed or removed, even by the schema owner's runtime.
  await assert.rejects(pool.query("update auth.session_single_sign_on set provider_sid = 'moved' where account_id = $1", [staffAccount]),
    /SESSION_SINGLE_SIGN_ON_IMMUTABLE/);
  process.stdout.write(`${JSON.stringify({ status: 'passed', patientHandOff: true, staffGateRefusal: 'no_active_facility_membership',
    outreachAccountOnly: true, backchannelLogout: 'sso_logout', endedRefresh: 'refresh_denied_not_reuse',
    signedOutProductSignOut: true, recentSignInWithSsoOff: 'counts_from_provider', productSignOutByRefreshCookie: true,
    productSignOut: true, provenanceImmutable: true })}\n`);
} finally {
  await app?.close();
  await pool.end();
}
