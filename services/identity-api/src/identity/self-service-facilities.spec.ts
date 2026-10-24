jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import type { AuditService } from '../audit/audit.service';
import { SecurityGuard } from '../auth/security.guard';
import type { TokenService } from '../auth/token.service';
import { AUDIT_ACTION, AUDIT_FAILURES_ONLY, FACILITY_OPTIONAL, PUBLIC_ROUTE,
  REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { AdminOrganizationApplicationsController } from './organization-applications.controller';
import { AdminSelfServiceFacilitiesController } from './self-service-facilities.controller';
import { SelfServiceFacilitiesService } from './self-service-facilities.service';

const applicationId = 'a0000000-0000-4000-8000-000000000086';
const row = {
  application_id: applicationId, row_version: '5', organization_id: 'b0000000-0000-4000-8000-000000000086',
  organization_name: 'Synthetic Clinic Ltd', facility_id: 'c0000000-0000-4000-8000-000000000086',
  facility_name: 'Synthetic Clinic Ltd', facility_lifecycle_status: 'verified', product_code: 'ehr',
  organization_type: 'hospital', cac_hint: 'RC…4567', administrator_name: 'Synthetic Provider Admin',
  administrator_email: 'provider@example.invalid', administrator_account_id: 'd0000000-0000-4000-8000-000000000086',
  administrator_account_status: 'active', activated_at: new Date('2026-10-24T09:15:00.000Z'),
  reviewed_at: null, reviewed_by_account_id: null, review_note: null,
};
const item = {
  applicationId, version: 5, organizationId: row.organization_id, organizationName: 'Synthetic Clinic Ltd',
  facilityId: row.facility_id, facilityName: 'Synthetic Clinic Ltd', facilityLifecycleStatus: 'verified',
  productCode: 'ehr', organizationType: 'hospital', cacHint: 'RC…4567', administratorName: 'Synthetic Provider Admin',
  administratorEmail: 'provider@example.invalid', administratorAccountId: row.administrator_account_id,
  administratorAccountStatus: 'active', activatedAt: '2026-10-24T09:15:00.000Z', reviewedAt: null,
  reviewedByAccountId: null, reviewNote: null,
};

// A standalone platform administrator: platform authority, no facility membership.
const standaloneAdmin = (platformPermissions: string[]): ActorContext => ({
  kind: 'staff', id: 'standalone:administrator', subject: 'standalone:administrator',
  accountId: 'e0000000-0000-4000-8000-000000000086', roles: [], permissions: [],
  platformRoles: ['platform_super_admin'], platformPermissions, facilityIds: [], facilities: [],
  authenticationMethod: 'local',
});
const allPermissions = ['platform.admin.access', 'platform.identity-review.read', 'platform.facility.manage'];

function serviceWith(query: jest.Mock) {
  const database = { withPlatformTransaction: jest.fn(async (_context, work) => work({ query })) };
  return { database, service: new SelfServiceFacilitiesService(database as unknown as DatabaseService) };
}
const context = { actor: standaloneAdmin(allPermissions), correlationId: 'review-test',
  purposeOfUse: 'healthcare-operations' as const };

describe('self-signed-up facility review: service', () => {
  it('lists through the read-only platform command and answers camelCase', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [row, { ...row, application_id: 'other', row_version: 9,
      reviewed_at: '2026-10-24T12:00:00Z', reviewed_by_account_id: 'reviewer', review_note: 'Checked the email domain' }] });
    const { service, database } = serviceWith(query);
    const answer = await service.list(context, 'all');
    expect(database.withPlatformTransaction).toHaveBeenCalledWith(context, expect.any(Function), { readOnly: true });
    expect(query).toHaveBeenCalledWith('select * from identity.admin_list_self_service_facilities($1)', ['all']);
    expect(answer.items[0]).toEqual(item);
    expect(answer.items[1]).toMatchObject({ applicationId: 'other', version: 9, reviewedAt: '2026-10-24T12:00:00.000Z',
      reviewedByAccountId: 'reviewer', reviewNote: 'Checked the email domain' });
  });

  it('records a review with the expected version and answers the new version', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ application_id: applicationId,
      reviewed_at: new Date('2026-10-24T13:00:00.000Z'), row_version: '6' }] });
    const { service, database } = serviceWith(query);
    await expect(service.review(context, applicationId, 5, 'Email domain matches the company'))
      .resolves.toEqual({ applicationId, reviewedAt: '2026-10-24T13:00:00.000Z', version: 6 });
    expect(database.withPlatformTransaction).toHaveBeenCalledWith(context, expect.any(Function));
    expect(query).toHaveBeenCalledWith('select * from identity.admin_review_self_service_facility($1,$2,$3)',
      [applicationId, 5, 'Email domain matches the company']);
  });

  it.each([
    ['P0002', 404, 'SELF_SERVICE_FACILITY_NOT_FOUND'],
    ['40001', 409, 'VERSION_CONFLICT'],
    ['23505', 409, 'SELF_SERVICE_FACILITY_ALREADY_REVIEWED'],
    ['23514', 503, 'SELF_SERVICE_FACILITY_UNAVAILABLE'],
    ['22023', 400, 'SELF_SERVICE_FACILITY_REQUEST_INVALID'],
    ['42501', 403, 'PERMISSION_DENIED'],
    ['XX000', 503, 'SELF_SERVICE_FACILITY_UNAVAILABLE'],
  ])('maps the review command\'s %s to %i %s without its diagnostics', async (code, status, answer) => {
    const { service } = serviceWith(jest.fn().mockRejectedValue(
      Object.assign(new Error('private SQL diagnostics'), { code })));
    const failure = await service.review(context, applicationId, 5, 'Email domain matches the company')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DomainProblem);
    expect(failure).toMatchObject({ status, code: answer });
    expect((failure as DomainProblem).message).not.toContain('private');
  });

  it('answers a review that returns no row 503, and list faults as list faults', async () => {
    await expect(serviceWith(jest.fn().mockResolvedValue({ rows: [] })).service
      .review(context, applicationId, 5, 'Email domain matches the company'))
      .rejects.toMatchObject({ status: 503, code: 'SELF_SERVICE_FACILITY_REVIEW_UNAVAILABLE' });
    await expect(serviceWith(jest.fn().mockRejectedValue(Object.assign(new Error('x'), { code: '22023' }))).service
      .list(context, 'unreviewed')).rejects.toMatchObject({ status: 400, code: 'SELF_SERVICE_FACILITY_REQUEST_INVALID' });
    await expect(serviceWith(jest.fn().mockRejectedValue(Object.assign(new Error('x'), { code: '42501' }))).service
      .list(context, 'unreviewed')).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
  });
});

describe('self-signed-up facility review: route metadata', () => {
  const meta = (key: symbol, target: object) => Reflect.getMetadata(key, target) as unknown;
  const review = AdminSelfServiceFacilitiesController.prototype;
  const applications = AdminOrganizationApplicationsController.prototype;

  it('uses the admin organization-application guards and audit', () => {
    for (const key of [FACILITY_OPTIONAL, AUDIT_FAILURES_ONLY]) {
      expect(meta(key, AdminSelfServiceFacilitiesController)).toBe(true);
      expect(meta(key, AdminOrganizationApplicationsController)).toBe(true);
    }
    expect(meta(PUBLIC_ROUTE, AdminSelfServiceFacilitiesController)).toBeUndefined();
    expect(meta(REQUIRED_PERMISSIONS, review.list)).toEqual(meta(REQUIRED_PERMISSIONS, applications.list));
    expect(meta(REQUIRED_PERMISSIONS, review.review)).toEqual(meta(REQUIRED_PERMISSIONS, applications.reject));
    expect(meta(REQUIRED_PERMISSIONS, review.list)).toEqual(['platform.identity-review.read']);
    expect(meta(REQUIRED_PERMISSIONS, review.review)).toEqual(['platform.facility.manage']);
    // A standalone administrator's audit row is a platform row only for admin.* actions.
    expect(meta(AUDIT_ACTION, review.list)).toBe('admin.self-service-facilities.list');
    expect(meta(AUDIT_ACTION, review.review)).toBe('admin.self-service-facility.review');
  });
});

describe('self-signed-up facility review over HTTP, as a standalone platform administrator', () => {
  const originalEnvironment = { ...process.env };
  let app: INestApplication;
  const query = jest.fn();
  const database = { withPlatformTransaction: jest.fn(), query: jest.fn() };
  const tokens = { verify: jest.fn() };
  const audit = { record: jest.fn() };
  const base = '/api/v1/admin/self-service-facilities';

  beforeEach(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://admin.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
    });
    resetEnvironmentForTests();
    jest.resetAllMocks();
    database.withPlatformTransaction.mockImplementation(async (_context, work) => work({ query }));
    tokens.verify.mockResolvedValue({ actor: standaloneAdmin(allPermissions), claims: {} });
    audit.record.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminSelfServiceFacilitiesController],
      providers: [SelfServiceFacilitiesService, { provide: DatabaseService, useValue: database }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use((incoming: HidRequest, _response: Response, next: NextFunction) => {
      incoming.correlationId = randomUUID();
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false },
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    app.useGlobalGuards(new SecurityGuard(new Reflector(), tokens as unknown as TokenService,
      audit as unknown as AuditService, database as unknown as DatabaseService));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  it('lists unreviewed sign-ups by default, with no facility in the platform context', async () => {
    query.mockResolvedValue({ rows: [row] });
    const answer = await request(app.getHttpServer()).get(base).set('Authorization', 'Bearer synthetic');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ items: [item] });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('admin_list_self_service_facilities'), ['unreviewed']);
    const platformContext = database.withPlatformTransaction.mock.calls[0]?.[0];
    expect(platformContext).toMatchObject({ purposeOfUse: 'healthcare-operations',
      actor: expect.objectContaining({ subject: 'standalone:administrator' }) });
    expect(platformContext.facilityId).toBeUndefined();
    expect(platformContext.membershipId).toBeUndefined();
    for (const state of ['reviewed', 'all']) {
      await request(app.getHttpServer()).get(`${base}?state=${state}`).set('Authorization', 'Bearer synthetic')
        .expect(200);
      expect(query).toHaveBeenLastCalledWith(expect.any(String), [state]);
    }
  });

  it('refuses an unknown state 400 before the database', async () => {
    const answer = await request(app.getHttpServer()).get(`${base}?state=pending`).set('Authorization', 'Bearer synthetic');
    expect([answer.status, answer.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(database.withPlatformTransaction).not.toHaveBeenCalled();
  });

  it('marks a sign-up reviewed with If-Match and a trimmed note', async () => {
    query.mockResolvedValue({ rows: [{ application_id: applicationId,
      reviewed_at: new Date('2026-10-24T13:00:00.000Z'), row_version: '6' }] });
    const answer = await request(app.getHttpServer()).post(`${base}/${applicationId}/review`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '"5"')
      .send({ note: '  Email domain matches the company  ' });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ applicationId, reviewedAt: '2026-10-24T13:00:00.000Z', version: 6 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('admin_review_self_service_facility($1,$2,$3)'),
      [applicationId, 5, 'Email domain matches the company']);
  });

  it('refuses a review without a version 428, a short or long note 400 and a malformed id 400', async () => {
    const post = (path: string, body: object, ifMatch?: string) => {
      const call = request(app.getHttpServer()).post(path).set('Authorization', 'Bearer synthetic');
      return (ifMatch ? call.set('If-Match', ifMatch) : call).send(body);
    };
    const noVersion = await post(`${base}/${applicationId}/review`, { note: 'Email domain matches' });
    expect([noVersion.status, noVersion.body.code]).toEqual([428, 'IF_MATCH_REQUIRED']);
    for (const note of ['  short  ', 'x'.repeat(501), 42]) {
      const invalid = await post(`${base}/${applicationId}/review`, { note }, '"5"');
      expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    const extra = await post(`${base}/${applicationId}/review`, { note: 'Email domain matches', suspend: true }, '"5"');
    expect(extra.status).toBe(400);
    const badId = await post(`${base}/not-a-uuid/review`, { note: 'Email domain matches' }, '"5"');
    expect(badId.status).toBe(400);
    expect(database.withPlatformTransaction).not.toHaveBeenCalled();
  });

  it('answers the database\'s conflicts with their codes', async () => {
    for (const [code, status, answer] of [['P0002', 404, 'SELF_SERVICE_FACILITY_NOT_FOUND'],
      ['40001', 409, 'VERSION_CONFLICT'], ['23505', 409, 'SELF_SERVICE_FACILITY_ALREADY_REVIEWED']] as const) {
      query.mockRejectedValueOnce(Object.assign(new Error('private'), { code }));
      const refused = await request(app.getHttpServer()).post(`${base}/${applicationId}/review`)
        .set('Authorization', 'Bearer synthetic').set('If-Match', '5').send({ note: 'Email domain matches' });
      expect([refused.status, refused.body.code]).toEqual([status, answer]);
    }
  });

  it('refuses an administrator without the list or review permission 403 before the database', async () => {
    tokens.verify.mockResolvedValue({ actor: standaloneAdmin(['platform.admin.access']), claims: {} });
    const list = await request(app.getHttpServer()).get(base).set('Authorization', 'Bearer synthetic');
    const review = await request(app.getHttpServer()).post(`${base}/${applicationId}/review`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '5').send({ note: 'Email domain matches' });
    for (const answer of [list, review]) expect([answer.status, answer.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect(database.withPlatformTransaction).not.toHaveBeenCalled();
  });

  it('refuses a facility user who holds the permissions but no platform administration', async () => {
    const facility = { id: 'f0000000-0000-4000-8000-000000000086', membershipId: randomUUID(), organizationId: randomUUID(),
      name: 'Synthetic', roles: ['org_admin'], permissions: ['platform.identity-review.read'], isPrimary: true };
    tokens.verify.mockResolvedValue({ actor: { ...standaloneAdmin([]), facilityIds: [facility.id],
      facilities: [facility] }, claims: {} });
    database.query.mockResolvedValue({ rows: [{ enabled: true }] });
    database.query.mockResolvedValueOnce({ rows: [{ enabled: false }] });
    const answer = await request(app.getHttpServer()).get(base).set('Authorization', 'Bearer synthetic')
      .set('X-Facility-ID', facility.id);
    expect([answer.status, answer.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect(database.withPlatformTransaction).not.toHaveBeenCalled();
  });
});
