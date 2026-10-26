jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { SecurityGuard } from '../auth/security.guard';
import { TokenService } from '../auth/token.service';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { ConsentController } from './consent.controller';
import { ConsentService, REVOCATION_DETAIL } from './consent.service';

// POST /api/v1/identity/me/consent-grants/:grantId/revoke exactly as the
// website sends it (p4-web apps/patient-web/src/api.ts:429-431): a cookie
// session, Origin and X-CSRF-Token, body { reason }, no purpose, facility or
// idempotency header.
const origin = 'https://app.healthidentitydirectory.com';
const grantId = '60000000-0000-4000-8000-000000000001';
const path = `/api/v1/identity/me/consent-grants/${grantId}/revoke`;
const patient: ActorContext = { kind: 'patient', id: 'synthetic:patient', subject: 'synthetic:patient',
  accountId: '70000000-0000-4000-8000-000000000001', patientId: '50000000-0000-4000-8000-000000000001',
  sessionId: '80000000-0000-4000-8000-000000000001', roles: [], permissions: [], platformRoles: [],
  platformPermissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local' } as ActorContext;
const staff: ActorContext = { kind: 'staff', id: 'staff:doctor', subject: 'staff:doctor',
  accountId: '20000000-0000-4000-8000-000000000001', roles: ['doctor'], permissions: ['identity.consent.write'],
  platformRoles: [], platformPermissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local' };

describe('patient grant revocation over HTTP (0087)', () => {
  const originalEnvironment = { ...process.env };
  let app: INestApplication;
  let revoke: (values: unknown[]) => unknown;
  const calls: { sql: string; values: unknown[] }[] = [];
  const respond = jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes('identity.revoke_my_consent_grant')) return revoke(values);
    if (sql.includes('platform.control_enabled($1)')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }] };
    return { rows: [] };
  });
  const database = {
    query: respond,
    withTransaction: jest.fn(async (_context: unknown, work: (client: unknown) => Promise<unknown>) => work({ query: respond })),
    withSystemTransaction: jest.fn(async (_correlation: unknown, work: (client: unknown) => Promise<unknown>) => work({ query: respond })),
  };
  const tokens = { verify: jest.fn(), verifyCsrf: jest.fn() };
  const audit = { record: jest.fn() };
  const revokeCalls = () => calls.filter((call) => call.sql.includes('identity.revoke_my_consent_grant'));
  const auditedActions = () => audit.record.mock.calls.map(([event]) => (event as { action: string }).action);
  const post = (body: unknown, url = path) => request(app.getHttpServer()).post(url)
    .set('Cookie', 'hid_access=session; hid_access_csrf=token').set('Origin', origin).set('X-CSRF-Token', 'token').send(body as object);

  beforeEach(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid', CORS_ORIGINS: origin,
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456', AUTH_COOKIE_SECURE: 'true',
    });
    resetEnvironmentForTests();
    jest.clearAllMocks();
    calls.length = 0;
    revoke = () => ({ rows: [{ consentGrantId: grantId, status: 'revoked', revokedAt: new Date('2026-10-25T00:00:00Z'), replayed: false }] });
    tokens.verify.mockResolvedValue({ actor: patient, claims: {} });
    tokens.verifyCsrf.mockReturnValue(true);
    audit.record.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [ConsentController],
      providers: [
        ConsentService,
        { provide: DatabaseService, useValue: database },
        { provide: TokenService, useValue: tokens },
        { provide: AuditService, useValue: audit },
        { provide: APP_GUARD, useFactory: (reflector: Reflector) => new SecurityGuard(reflector,
          tokens as unknown as TokenService, audit as unknown as AuditService, database as unknown as DatabaseService),
        inject: [Reflector] },
        { provide: APP_INTERCEPTOR, useFactory: (reflector: Reflector) => new AuditInterceptor(reflector,
          audit as unknown as AuditService), inject: [Reflector] },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.use((incoming: HidRequest, _response: Response, next: NextFunction) => { incoming.correlationId = randomUUID(); next(); });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  it('revokes with the website\'s exact request and answers main\'s body', async () => {
    const answer = await post({ reason: '  No longer needed ' });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ consentGrantId: grantId, status: 'revoked', revokedAt: '2026-10-25T00:00:00.000Z', replayed: false });
    expect(revokeCalls().map((call) => call.values)).toEqual([[patient.subject, patient.sessionId, grantId, 'No longer needed']]);
    expect(calls.some((call) => /otp_challenges|issued_at/.test(call.sql))).toBe(false);
    expect(auditedActions()).toContain('api.identity.consent-grant.patient-revoke.command');
  });

  it('answers a repeat 200 with replayed: true', async () => {
    revoke = () => ({ rows: [{ consentGrantId: grantId, status: 'revoked', revokedAt: new Date(), replayed: true }] });
    const answer = await post({ reason: 'Again' });
    expect([answer.status, answer.body.replayed]).toEqual([200, true]);
  });

  it.each([
    [{}], [{ reason: 'ab' }], [{ reason: 'x'.repeat(501) }], [{ reason: 42 }], [{ reason: 'Fine reason', scope: 'all' }],
  ])('refuses the body %o with 400 VALIDATION_FAILED before the database', async (body) => {
    const answer = await post(body);
    expect([answer.status, answer.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(revokeCalls()).toHaveLength(0);
  });

  it('refuses a grant id that is not a UUID', async () => {
    const answer = await post({ reason: 'Not needed' }, '/api/v1/identity/me/consent-grants/not-a-uuid/revoke');
    expect(answer.status).toBe(400);
    expect(revokeCalls()).toHaveLength(0);
  });

  it('refuses a staff session in the guard, before CSRF and body validation, audited as a denial', async () => {
    tokens.verify.mockResolvedValue({ actor: staff, claims: {} });
    tokens.verifyCsrf.mockReturnValue(false);
    const answer = await post({ unexpected: true });
    expect([answer.status, answer.body.code]).toEqual([403, 'PATIENT_SESSION_REQUIRED']);
    expect(auditedActions()).toContain('auth.authorization.denied');
    expect(revokeCalls()).toHaveLength(0);
  });

  it('needs the Origin and CSRF proof of a cookie session', async () => {
    tokens.verifyCsrf.mockReturnValue(false);
    const noCsrf = await post({ reason: 'Not needed' });
    expect([noCsrf.status, noCsrf.body.code]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    tokens.verifyCsrf.mockReturnValue(true);
    const wrongOrigin = await request(app.getHttpServer()).post(path).set('Cookie', 'hid_access=session; hid_access_csrf=token')
      .set('Origin', 'https://attacker.example').set('X-CSRF-Token', 'token').send({ reason: 'Not needed' });
    expect([wrongOrigin.status, wrongOrigin.body.code]).toEqual([403, 'ORIGIN_DENIED']);
    expect(revokeCalls()).toHaveLength(0);
  });

  it('shows the patient a readable detail for the database refusals', async () => {
    revoke = () => { throw Object.assign(new Error('CONSENT_GRANT_NOT_PATIENT_REVOCABLE'), { code: '55000' }); };
    const notRevocable = await post({ reason: 'Not needed' });
    expect([notRevocable.status, notRevocable.body.code, notRevocable.body.detail])
      .toEqual([409, 'CONSENT_COMMAND_CONFLICT', REVOCATION_DETAIL.notRevocable]);
    revoke = () => { throw Object.assign(new Error('The access grant is unavailable'), { code: 'P0002' }); };
    const missing = await post({ reason: 'Not needed' });
    expect([missing.status, missing.body.code, missing.body.detail])
      .toEqual([404, 'CONSENT_RESOURCE_NOT_FOUND', REVOCATION_DETAIL.notFound]);
    expect(auditedActions().filter((action) => action === 'api.identity.consent-grant.patient-revoke.command')).toHaveLength(2);
  });
});
