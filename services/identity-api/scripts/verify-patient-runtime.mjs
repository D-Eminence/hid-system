#!/usr/bin/env node
// Executes only against the owned disposable synthetic rehearsal. No delivery or cloud calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
Object.assign(process.env, { AUTH_COOKIE_SECURE: 'true', AUTH_COOKIE_DOMAIN: '.example.invalid',
  HID_DEPLOYMENT_ENV: 'staging', NIN_PROVIDER_MODE: 'deferred',
  TURNSTILE_MODE: 'disabled', IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: 'public-synthetic-ehr-workload-token' });
// Exercise patient sessions without NIN material in this disposable local test only.
for (const key of ['NIN_LOOKUP_HMAC_KEY_B64', 'NIN_ENCRYPTION_KEY_B64',
  'METAMAP_CLIENT_ID', 'METAMAP_CLIENT_SECRET']) delete process.env[key];
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
const { AuthSessionAuditService } = load('auth/auth-session-audit.service.ts');
const { AuditService } = load('audit/audit.service.ts');
const { SecurityGuard } = load('auth/security.guard.ts');
const { WorkloadAuthService } = load('auth/workload-auth.service.ts');
const { TurnstileService } = load('auth/turnstile.service.ts');
const { PatientSelfController } = load('auth/patient-self.controller.ts');
const { PatientSelfService } = load('auth/patient-self.service.ts');
const { ProblemDetailsFilter } = load('common/problem.ts');
const { getEnvironment } = load('config/environment.ts');
const pool = new Pool({ host: socket, user: process.env.PGUSER, database: process.env.PGDATABASE, max: 5 });
const database = {
  query: async (sql, values) => {
    const client = await pool.connect();
    try { await client.query('begin'); await client.query('set local role hid_identity_api_runtime');
      const result = await client.query(sql, values); await client.query('commit'); return result;
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  },
  withSystemTransaction: async (correlation, operation) => {
    const client = await pool.connect();
    try { await client.query('begin'); await client.query('set local role hid_identity_api_runtime');
      await client.query("select set_config('app.actor_subject','system:auth',true),set_config('app.correlation_id',$1,true)", [correlation]);
      const result = await operation(client); await client.query('commit'); return result;
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  },
};
let app;
try {
  const module = await Test.createTestingModule({ controllers: [AuthController, PatientSelfController],
    providers: [{ provide: DatabaseService, useValue: database }, TokenService, LocalAuthProvider,
      CurrentStaffContextService, CurrentPatientContextService, AuthService, AuthSessionAuditService,
      AuditService, WorkloadAuthService, TurnstileService, PatientSelfService] }).compile();
  app = module.createNestApplication({ logger: false });
  app.use(require('cookie-parser')());
  app.use((req, _res, next) => { req.correlationId = randomUUID(); next(); });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalGuards(new SecurityGuard(module.get(Reflector), module.get(TokenService), module.get(AuditService)));
  await app.init();
  const http = request(app.getHttpServer());
  const accountId = randomUUID(), patientId = randomUUID();
  const email = `synthetic-patient-${accountId}@example.invalid`;
  const password = 'Synthetic-Patient-Password-2026';
  const passwordHash = await require('argon2').hash(password, { type: require('argon2').argon2id });
  await pool.query("insert into auth.accounts(id,subject,email,display_name,status,password_hash,password_algorithm) values($1,$2,$3,'Synthetic patient','active',$4,'argon2id')",
    [accountId, `synthetic:patient-runtime:${accountId}`, email, passwordHash]);
  await pool.query("insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status) values($1,$2,'HID-RUNTMESELF','Runtime','Patient','Runtime Patient','active')", [patientId, accountId]);
  const origin = process.env.CORS_ORIGINS.split(',')[0];
  const input = { email, password, turnstileAction: 'patient-login' };
  const login = () => http.post('/api/v1/auth/patient/login').set('Origin', origin).send(input);
  const cookieName = getEnvironment().AUTH_COOKIE_NAME;
  const cookieHeader = response => response.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  const csrf = response => response.headers['x-csrf-token'];
  await http.post('/api/v1/auth/patient/login').send(input).expect(403);
  await http.post('/api/v1/auth/patient/login').set('Origin', origin).send({ ...input, turnstileAction: 'staff-login' }).expect(400);
  await http.post('/api/v1/auth/patient/login').set('Origin', origin).send({ ...input, password: 'wrong-password-000000' }).expect(401);
  const first = await login().expect(200);
  assert.equal(first.body.actor.kind, 'patient'); assert.equal(first.body.actor.patientId, patientId);
  assert.equal(first.body.actor.accountId, accountId); assert.notEqual(accountId, patientId);
  for (const property of ['roles', 'permissions', 'platformRoles', 'platformPermissions', 'facilities', 'facilityIds']) assert.deepEqual(first.body.actor[property], []);
  for (const value of first.headers['set-cookie']) {
    assert(!/;\s*Domain=/i.test(value), 'All authentication cookies must be host-only');
    assert.match(value, /; Secure/i); assert.match(value, /; SameSite=Strict/i);
    if (!value.startsWith(`${cookieName}_csrf=`)) assert.match(value, /; HttpOnly/i);
  }
  assert(!first.body.accessToken && !first.body.refreshToken, 'Tokens must not be serialized into browser JSON');
  const firstCookie = cookieHeader(first);
  await http.get('/api/v1/auth/session').set('Cookie', firstCookie).expect(200);
  const profile = await http.get('/api/v1/identity/me').set('Cookie', firstCookie).expect(200);
  assert.equal(profile.body.patientId, patientId); assert.equal(profile.body.hid, 'HID-RUNTMESELF');
  assert(!('accountId' in profile.body) && !('nin' in profile.body));
  const history = await http.get('/api/v1/identity/me/access-history').set('Cookie', firstCookie).expect(200);
  assert.deepEqual(history.body, { items: [] });
  await http.get('/api/v1/identity/service/patient-self-authorization').set('Cookie', firstCookie).expect(403);
  const authorized = await http.get('/api/v1/identity/service/patient-self-authorization').set('Cookie', firstCookie)
    .set('x-hid-internal-caller', 'ehr-api').set('x-hid-service-token', process.env.IDENTITY_EHR_INTERNAL_SERVICE_TOKEN).expect(200);
  assert.equal(authorized.body.patientId, patientId); assert.equal(authorized.body.sessionId, first.body.actor.sessionId);
  assert(Date.parse(authorized.body.expiresAt) > Date.now());
  await http.post('/api/v1/auth/facility').set('Cookie', firstCookie).set('Origin', origin).set('x-csrf-token', csrf(first))
    .send({ facilityId: randomUUID() }).expect(403);
  await http.post('/api/v1/auth/refresh').set('Cookie', firstCookie).set('Origin', origin).set('x-csrf-token', 'forged').expect(403);
  const refreshed = await http.post('/api/v1/auth/refresh').set('Cookie', firstCookie).set('Origin', origin)
    .set('x-csrf-token', csrf(first)).expect(200);
  assert.notEqual(refreshed.body.actor.sessionId, first.body.actor.sessionId);
  assert.equal(refreshed.body.actor.patientId, patientId);
  await http.get('/api/v1/auth/session').set('Cookie', firstCookie).expect(401);
  await http.post('/api/v1/auth/refresh').set('Cookie', firstCookie).set('Origin', origin).set('x-csrf-token', csrf(first)).expect(401);
  await http.get('/api/v1/auth/session').set('Cookie', cookieHeader(refreshed)).expect(401);
  const second = await login().expect(200);
  await http.post('/api/v1/auth/logout').set('Cookie', cookieHeader(second)).set('Origin', origin).expect(403);
  await http.post('/api/v1/auth/logout').set('Cookie', cookieHeader(second)).set('Origin', origin).set('x-csrf-token', csrf(second)).expect(204);
  await http.get('/api/v1/auth/session').set('Cookie', cookieHeader(second)).expect(401);
  const third = await login().expect(200);
  await pool.query('update auth.accounts set token_version=token_version+1,row_version=row_version+1 where id=$1', [accountId]);
  await http.get('/api/v1/identity/me').set('Cookie', cookieHeader(third)).expect(401);
  await pool.query("update auth.accounts set status='pending_reset',row_version=row_version+1 where id=$1", [accountId]);
  await login().expect(401);
  const auditCount = (await pool.query("select count(*)::integer n from audit.events where actor_type='patient' and actor_account_id=$1", [accountId])).rows[0].n;
  assert(auditCount >= 10, 'Patient activity and denied workforce access must be durably audited');
  const sessionCount = (await pool.query("select count(*)::integer n from auth.sessions where account_id=$1 and session_kind='patient' and patient_id=$2", [accountId, patientId])).rows[0].n;
  assert.equal(sessionCount, 4);
  process.stdout.write(JSON.stringify({ status: 'passed', scope: 'local-synthetic-only', role: 'hid_identity_api_runtime',
    nin_provider_mode: getEnvironment().NIN_PROVIDER_MODE, nin_credentials_present: false,
    nin_verification_required: false,
    http_login_profile_history: 'passed', host_only_secure_cookies: true, empty_workforce_authority: true,
    csrf_denials: true, refresh_rotation_reuse_family_revocation: true, logout_revocation: true,
    current_account_token_version_enforced: true, pending_reset_login_denied: true,
    internal_self_authorization_workload_protected: true, patient_audit_count: auditCount,
    turnstile: 'disabled-only-in-local-test-no-external-call' }) + '\n');
} finally { if (app) await app.close(); await pool.end(); }
