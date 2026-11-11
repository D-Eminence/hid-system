jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { randomUUID } from 'node:crypto';
import { type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import request from 'supertest';
import { AuditService } from '../audit/audit.service';
import { SecurityGuard } from '../auth/security.guard';
import { TokenService } from '../auth/token.service';
import { WorkloadAuthService } from '../auth/workload-auth.service';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { SupportHealthIdController } from './support-health-id.controller';
import { SupportHealthIdService } from './support-health-id.service';

// The support chat's server Health ID check (0109) over HTTP, with the real guard, validation and problem filter, on
// a fake database. Fictional Health IDs only.
const SUPPORT_TOKEN = 'support-local-development-secret-0123456789';
const ROUTE = '/api/v1/identity/service/support/health-id-matches';

describe('POST /api/v1/identity/service/support/health-id-matches', () => {
  let app: INestApplication;
  const database = { query: jest.fn() };
  const tokens = { verify: jest.fn(), verifyCsrf: jest.fn() };
  const audit = { record: jest.fn(), recordWithClient: jest.fn() };
  const base = {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid', DATABASE_SSL: 'false',
    CORS_ORIGINS: 'https://healthidentitydirectory.com', AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
    STORAGE_MODE: 'disabled', IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
    IDENTITY_SUPPORT_INTERNAL_SERVICE_TOKEN: SUPPORT_TOKEN,
  };
  const keys = ['IDENTITY_SUPPORT_INTERNAL_SERVICE_TOKEN', 'IDENTITY_SUPPORT_CALLER_SUBJECT', 'WORKLOAD_ISSUER_URL',
    'WORKLOAD_JWKS_URL', 'IDENTITY_SERVICE_IDENTITY_MODE'];

  async function start(environment: Record<string, string | undefined> = {}) {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, base, environment);
    for (const [key, value] of Object.entries(environment)) if (value === undefined) delete process.env[key];
    resetEnvironmentForTests();
    const moduleRef = await Test.createTestingModule({
      controllers: [SupportHealthIdController],
      providers: [
        SupportHealthIdService,
        { provide: WorkloadAuthService, useFactory: () => new WorkloadAuthService(database as never) },
        { provide: DatabaseService, useValue: database },
        { provide: TokenService, useValue: tokens },
        { provide: AuditService, useValue: audit },
        { provide: APP_GUARD, useFactory: (reflector: Reflector) => new SecurityGuard(reflector,
          tokens as unknown as TokenService, audit as unknown as AuditService, database as unknown as DatabaseService),
        inject: [Reflector] },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use((incoming: HidRequest, _response: Response, next: NextFunction) => { incoming.correlationId = randomUUID(); next(); });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  }
  const ask = (body: unknown, headers: Record<string, string> = { 'x-hid-internal-caller': 'support-api', 'x-hid-service-token': SUPPORT_TOKEN }) =>
    request(app.getHttpServer()).post(ROUTE).set(headers).send(body as object);

  beforeEach(() => {
    jest.clearAllMocks();
    database.query.mockResolvedValue({ rows: [{ health_id: 'HID-SUP2A3' }] });
  });
  afterEach(async () => { await app?.close(); });
  afterAll(() => { for (const key of keys) delete process.env[key]; resetEnvironmentForTests(); });

  it('answers the issued ones among the candidates, asking the database once with each candidate once', async () => {
    await start();
    const response = await ask({ candidates: ['HID-SUP2A3', 'HID-ZZ22ZZ', 'HID-SUP2A3'] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ matches: ['HID-SUP2A3'] });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(database.query).toHaveBeenCalledTimes(1);
    expect(database.query).toHaveBeenCalledWith('select health_id from identity.support_health_id_matches($1::text[])',
      [['HID-SUP2A3', 'HID-ZZ22ZZ']]);
    expect(tokens.verify).not.toHaveBeenCalled();
  });

  it('answers an empty list when nothing matches', async () => {
    await start();
    database.query.mockResolvedValue({ rows: [] });
    const response = await ask({ candidates: ['HID-ZZ22ZZ'] });
    expect([response.status, response.body]).toEqual([200, { matches: [] }]);
  });

  it.each([
    ['another caller', { 'x-hid-internal-caller': 'ehr-api', 'x-hid-service-token': SUPPORT_TOKEN }, 401],
    ['no caller', { 'x-hid-service-token': SUPPORT_TOKEN }, 401],
    ['a wrong token', { 'x-hid-internal-caller': 'support-api', 'x-hid-service-token': 'wrong-secret' }, 401],
    ['no token', { 'x-hid-internal-caller': 'support-api' }, 401],
  ])('refuses %s without reading the database', async (_name, headers, status) => {
    await start();
    const response = await ask({ candidates: ['HID-SUP2A3'] }, headers as Record<string, string>);
    expect(response.status).toBe(status);
    expect(database.query).not.toHaveBeenCalled();
  });

  it.each([
    ['no candidates', { candidates: [] }],
    ['201 candidates', { candidates: Array.from({ length: 201 }, () => 'HID-SUP2A3') }],
    ['a lower-case candidate', { candidates: ['hid-sup2a3'] }],
    ['a candidate without its prefix', { candidates: ['SUP2A3'] }],
    ['a letter outside the alphabet', { candidates: ['HID-SUPO2I'] }],
    ['a number', { candidates: [12345678] }],
    ['the message text', { candidates: ['HID-SUP2A3'], text: 'My Health ID is HID-SUP2A3' }],
    ['no body', undefined],
  ])('refuses %s with 400, echoing no candidate and reading nothing', async (_name, body) => {
    await start();
    const response = await ask(body);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toMatch(/SUP2A3|sup2a3|SUPO2I|12345678/);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('answers 503 when the support caller is not configured, so support-api sends nothing to Lex', async () => {
    await start({ IDENTITY_SUPPORT_INTERNAL_SERVICE_TOKEN: undefined });
    expect((await ask({ candidates: ['HID-SUP2A3'] })).status).toBe(503);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('answers 503 if the database names anything that was not asked', async () => {
    await start();
    database.query.mockResolvedValue({ rows: [{ health_id: 'HID-OTHER2' }] });
    const response = await ask({ candidates: ['HID-SUP2A3'] });
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain('HID-OTHER2');
  });

  it('logs counts only: no candidate or match', async () => {
    await start();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await ask({ candidates: ['HID-SUP2A3', 'HID-ZZ22ZZ'] });
    expect(log).toHaveBeenCalledWith({ message: 'Support Health ID check', candidates: 2, matches: 1 });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/HID-/);
    log.mockRestore();
  });

  describe('with JWT workload identity, as deployed', () => {
    const jwt = { IDENTITY_SERVICE_IDENTITY_MODE: 'jwt', IDENTITY_SUPPORT_INTERNAL_SERVICE_TOKEN: undefined,
      WORKLOAD_ISSUER_URL: 'https://issuer.test', WORKLOAD_JWKS_URL: 'https://issuer.test/jwks',
      IDENTITY_SUPPORT_CALLER_SUBJECT: 'hid:staging:support-api' };
    const bearer = { 'x-hid-internal-caller': 'support-api', 'x-hid-service-authorization': 'Bearer signed-token' };
    beforeEach(() => {
      jest.mocked(createRemoteJWKSet).mockReturnValue(jest.fn() as never);
      jest.mocked(jwtVerify).mockReset();
    });

    it('accepts support-api\'s subject for the identity-api audience', async () => {
      await start(jwt);
      jest.mocked(jwtVerify).mockResolvedValue({ payload: { sub: 'hid:staging:support-api' } } as never);
      expect((await ask({ candidates: ['HID-SUP2A3'] }, bearer)).status).toBe(200);
      expect(jwtVerify).toHaveBeenCalledWith('signed-token', expect.any(Function), {
        issuer: 'https://issuer.test', audience: 'hid-identity-api', algorithms: ['RS256', 'ES256'] });
    });

    it('refuses another workload\'s valid token with 403', async () => {
      await start(jwt);
      jest.mocked(jwtVerify).mockResolvedValue({ payload: { sub: 'hid:staging:outreach-api' } } as never);
      expect((await ask({ candidates: ['HID-SUP2A3'] }, bearer)).status).toBe(403);
      expect(database.query).not.toHaveBeenCalled();
    });

    it('refuses an invalid token with 401', async () => {
      await start(jwt);
      jest.mocked(jwtVerify).mockRejectedValue(new Error('signature'));
      expect((await ask({ candidates: ['HID-SUP2A3'] }, bearer)).status).toBe(401);
    });

    it('answers 503 without IDENTITY_SUPPORT_CALLER_SUBJECT, before verifying any token', async () => {
      await start({ ...jwt, IDENTITY_SUPPORT_CALLER_SUBJECT: undefined });
      expect((await ask({ candidates: ['HID-SUP2A3'] }, bearer)).status).toBe(503);
      expect(jwtVerify).not.toHaveBeenCalled();
    });

    it('does not make support-api a caller of the other service routes', async () => {
      await start({ ...jwt, IDENTITY_EHR_CALLER_SUBJECT: 'hid:staging:ehr-api' });
      jest.mocked(jwtVerify).mockResolvedValue({ payload: { sub: 'hid:staging:support-api' } } as never);
      await expect(new WorkloadAuthService(database as never).authenticateService('support-api', 'Bearer signed-token', undefined))
        .rejects.toMatchObject({ status: 401 });
      delete process.env.IDENTITY_EHR_CALLER_SUBJECT;
    });
  });
});
