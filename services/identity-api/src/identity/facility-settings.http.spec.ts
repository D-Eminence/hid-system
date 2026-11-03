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
import { AUDIT_ACTION, FACILITY_OPTIONAL, PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { FacilitySettingsController } from './facility-settings.controller';
import { FacilitySettingsService } from './facility-settings.service';

const origin = 'https://app.healthidentitydirectory.com';
const facilityId = '10000000-0000-4000-8000-000000000002';

function assignment(permissions: string[], roles = ['org_admin']): FacilityAssignment {
  return { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
    organizationId: '10000000-0000-4000-8000-000000000001', name: 'Synthetic Lab Ltd', roles, permissions, isPrimary: true };
}
function staff(facility: FacilityAssignment): ActorContext {
  return { kind: 'staff', id: 'staff:administrator', subject: 'staff:administrator',
    accountId: '20000000-0000-4000-8000-000000000001', email: 'admin@example.test', displayName: 'Ada Obi',
    roles: facility.roles, permissions: facility.permissions, platformRoles: [], platformPermissions: [],
    facilityIds: [facility.id], facilities: [facility], facility, authenticationMethod: 'local' };
}
const meta = (key: symbol, target: object) => Reflect.getMetadata(key, target) as unknown;

describe('facility settings routes: metadata', () => {
  it('need organization.manage at the X-Facility-ID facility and are audited at it', () => {
    expect(meta(FACILITY_OPTIONAL, FacilitySettingsController)).toBeUndefined();
    expect(meta(PUBLIC_ROUTE, FacilitySettingsController)).toBeUndefined();
    const routes = FacilitySettingsController.prototype as unknown as Record<string, object>;
    for (const [handler, action] of Object.entries({ read: 'identity.facility-settings.read',
      setOnePersonLab: 'identity.facility.one-person-lab.change' })) {
      expect(meta(REQUIRED_PERMISSIONS, routes[handler] as object)).toEqual(['organization.manage']);
      expect(meta(AUDIT_ACTION, routes[handler] as object)).toBe(action);
    }
  });
});

describe('facility settings routes over HTTP', () => {
  const originalEnvironment = { ...process.env };
  let app: INestApplication;
  let answer: (sql: string, values: unknown[]) => unknown = () => ({ rows: [] });
  const calls: { sql: string; values: unknown[] }[] = [];
  const respond = jest.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('platform.control_enabled($1)')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }] };
    if (sql.includes('platform.control_enabled')) return { rows: [{ invitations: true, provider_portal: true, maintenance: false }] };
    calls.push({ sql, values });
    return answer(sql, values);
  });
  const database = {
    query: respond,
    withTransaction: jest.fn(async (_context: unknown, work: (client: unknown) => Promise<unknown>) => work({ query: respond })),
    withSystemTransaction: jest.fn(async (_correlation: unknown, work: (client: unknown) => Promise<unknown>) => work({ query: respond })),
    withPlatformTransaction: jest.fn(async (_context: unknown, work: (client: unknown) => Promise<unknown>) => work({ query: respond })),
  };
  const tokens = { verify: jest.fn(), verifyCsrf: jest.fn() };
  const audit = { record: jest.fn() };

  beforeEach(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: `${origin},https://ehr.healthidentitydirectory.com`, AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      AUTH_COOKIE_SECURE: 'true', OTP_HMAC_KEY_B64: Buffer.alloc(32, 3).toString('base64'),
    });
    resetEnvironmentForTests();
    jest.clearAllMocks();
    calls.length = 0;
    answer = () => ({ rows: [] });
    tokens.verify.mockResolvedValue({ actor: staff(assignment(['organization.manage', 'workforce.manage'])), claims: {} });
    tokens.verifyCsrf.mockReturnValue(true);
    audit.record.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [FacilitySettingsController],
      providers: [
        FacilitySettingsService,
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

  const server = () => app.getHttpServer();
  const post = (body: unknown) => request(server()).post('/api/v1/identity/facility-settings/one-person-lab')
    .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId).send(body as object);
  const auditedActions = () => audit.record.mock.calls.map(([event]) => (event as { action: string }).action);

  it('reads the settings', async () => {
    answer = () => ({ rows: [{ enabled: false, changed_at: null, changed_by_name: null, reason: null }] });
    const read = await request(server()).get('/api/v1/identity/facility-settings')
      .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId);
    expect([read.status, read.body]).toEqual([200, { onePersonLab: { enabled: false, changedAt: null, changedByName: null,
      reason: null } }]);
    expect(auditedActions()).toContain('api.identity.facility-settings.read');
  });

  it('switches One-person lab with a trimmed reason and answers 200', async () => {
    answer = () => ({ rows: [{ enabled: true, changed_at: '2026-11-03T10:00:00Z', setting_id: '50000000-0000-4000-8000-000000000001' }] });
    const changed = await post({ enabled: true, reason: '  Only one scientist works here  ' });
    expect([changed.status, changed.body]).toEqual([200, { enabled: true, changedAt: '2026-11-03T10:00:00.000Z',
      settingId: '50000000-0000-4000-8000-000000000001' }]);
    expect(calls.map((call) => call.values)).toEqual([[true, 'Only one scientist works here']]);
    expect(auditedActions()).toContain('api.identity.facility.one-person-lab.change');
  });

  it.each([
    [{ enabled: true, reason: 'too short' }],
    [{ enabled: true, reason: '    nine char     ' }],
    [{ enabled: true, reason: 'x'.repeat(501) }],
    [{ enabled: 'true', reason: 'Only one scientist works here' }],
    [{ reason: 'Only one scientist works here' }],
    [{ enabled: true }],
    [{ enabled: true, reason: 'Only one scientist works here', facilityId }],
  ])('refuses an invalid body %j before the database', async (body) => {
    const refused = await post(body);
    expect([refused.status, refused.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(calls).toEqual([]);
  });

  it('needs organization.manage: lab staff and an administrator awaiting review are refused', async () => {
    for (const facility of [assignment(['lab.result.verify'], ['lab']), assignment(['workforce.manage'], ['org_admin_awaiting_review'])]) {
      tokens.verify.mockResolvedValue({ actor: staff(facility), claims: {} });
      const refused = await post({ enabled: true, reason: 'Only one scientist works here' });
      expect([refused.status, refused.body.code]).toEqual([403, 'PERMISSION_DENIED']);
      const read = await request(server()).get('/api/v1/identity/facility-settings')
        .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId);
      expect(read.status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it('answers the database refusals with plain codes', async () => {
    for (const [code, message, status, problem] of [['P0001', 'FACILITY_SETTING_UNCHANGED', 409, 'FACILITY_SETTING_UNCHANGED'],
      ['42501', 'FACILITY_SETTING_PERMISSION_DENIED', 403, 'FACILITY_SETTING_PERMISSION_DENIED'],
      ['22023', 'FACILITY_SETTING_REASON_INVALID', 400, 'FACILITY_SETTING_REASON_INVALID'],
      ['XX000', 'internal', 503, 'FACILITY_SETTINGS_UNAVAILABLE']] as const) {
      answer = () => { throw Object.assign(new Error(message), { code }); };
      const refused = await post({ enabled: false, reason: 'A second scientist has joined' });
      expect([refused.status, refused.body.code]).toEqual([status, problem]);
      expect(JSON.stringify(refused.body)).not.toContain('A second scientist');
    }
  });
});
