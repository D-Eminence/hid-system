jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { createHmac, randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { AdminOrderRouteCommandsController, AdminOrderRouteReadsController } from '../admin/order-routes.controller';
import { AdminOrderRoutesService } from '../admin/order-routes.service';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { SecurityGuard } from '../auth/security.guard';
import { TokenService } from '../auth/token.service';
import { AUDIT_ACTION, AUDIT_FAILURES_ONLY, FACILITY_OPTIONAL, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { OrderDestinationsController } from './order-destinations.controller';
import { OrderDestinationsService } from './order-destinations.service';

// P4c (SPEC-FINAL §3.4, §9.4, §10.3, §10.4, §14.1): the clinician's
// directory and support's tools, over HTTP with the real guard, interceptor,
// validation and problem filter, on a fake database.
const facilityId = '10000000-0000-4000-8000-000000000002';
const membershipId = '40000000-0000-4000-8000-000000000001';
const laboratoryId = '10000000-0000-4000-8000-000000000003';
const routeId = '70000000-0000-4000-8000-000000000001';
const hmacKey = Buffer.alloc(32, 3);

function doctorAt(permissions = ['ehr.order-route.send', 'ehr.lab-request.write']): ActorContext {
  const facility: FacilityAssignment = { id: facilityId, membershipId, organizationId: '10000000-0000-4000-8000-000000000001',
    name: 'Synthetic Hospital Ltd', roles: ['doctor'], permissions, isPrimary: true };
  return { kind: 'staff', id: 'staff:doctor', subject: 'staff:doctor', accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['doctor'], permissions, platformRoles: [], platformPermissions: [], facilityIds: [facilityId],
    facilities: [facility], facility, authenticationMethod: 'local' };
}
const standaloneAdmin = (platformPermissions: string[]): ActorContext => ({ kind: 'staff', id: 'standalone:administrator',
  subject: 'standalone:administrator', accountId: 'e0000000-0000-4000-8000-000000000086', roles: [], permissions: [],
  platformRoles: ['platform_super_admin'], platformPermissions, facilityIds: [], facilities: [], authenticationMethod: 'local' });
const meta = (key: symbol, target: object) => Reflect.getMetadata(key, target) as unknown;
const databaseError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('order-route routes in Identity: metadata', () => {
  it('the directory needs ehr.order-route.send at the X-Facility-ID facility and is audited', () => {
    expect(meta(FACILITY_OPTIONAL, OrderDestinationsController)).toBeUndefined();
    expect(meta(REQUIRED_PERMISSIONS, OrderDestinationsController.prototype.search)).toEqual(['ehr.order-route.send']);
    expect(meta(AUDIT_ACTION, OrderDestinationsController.prototype.search)).toBe('identity.order-destinations.search');
  });

  it('support\'s reads are audited on success and failure, its writes on failure only, all facility optional', () => {
    expect(meta(FACILITY_OPTIONAL, AdminOrderRouteReadsController)).toBe(true);
    expect(meta(AUDIT_FAILURES_ONLY, AdminOrderRouteReadsController)).toBeUndefined();
    expect(meta(FACILITY_OPTIONAL, AdminOrderRouteCommandsController)).toBe(true);
    expect(meta(AUDIT_FAILURES_ONLY, AdminOrderRouteCommandsController)).toBe(true);
    const reads = AdminOrderRouteReadsController.prototype;
    const writes = AdminOrderRouteCommandsController.prototype;
    expect([meta(REQUIRED_PERMISSIONS, reads.summary), meta(AUDIT_ACTION, reads.summary)])
      .toEqual([['platform.admin.access', 'platform.facility.read'], 'admin.order-route-summary.read']);
    expect([meta(REQUIRED_PERMISSIONS, reads.find), meta(AUDIT_ACTION, reads.find)])
      .toEqual([['platform.admin.access', 'platform.principal.read'], 'admin.order-routes.find']);
    expect([meta(REQUIRED_PERMISSIONS, reads.search), meta(AUDIT_ACTION, reads.search)])
      .toEqual([['platform.admin.access', 'platform.principal.read'], 'admin.order-routes.find']);
    expect([meta(REQUIRED_PERMISSIONS, writes.setDestination), meta(AUDIT_ACTION, writes.setDestination)])
      .toEqual([['platform.admin.access', 'platform.facility.manage', 'platform.facility.unlock'], 'admin.order-route-destination.set']);
    expect([meta(REQUIRED_PERMISSIONS, writes.close), meta(AUDIT_ACTION, writes.close)])
      .toEqual([['platform.admin.access', 'platform.facility.manage'], 'admin.order-route.close']);
  });
});

describe('order-route routes in Identity over HTTP', () => {
  const originalEnvironment = { ...process.env };
  let app: INestApplication;
  const handlers: Record<string, (values: unknown[]) => unknown> = {};
  const calls: { sql: string; values: unknown[] }[] = [];
  const respond = jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    for (const [needle, handler] of Object.entries(handlers)) if (sql.includes(needle)) return handler(values);
    if (sql.includes('platform.control_enabled($1)')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }] };
    return { rows: [] };
  });
  const contexts: Array<{ purposeOfUse: string; facilityId?: string }> = [];
  const database = {
    query: respond,
    withTransaction: jest.fn(async (context: { purposeOfUse: string }, work: (client: unknown) => Promise<unknown>) => {
      contexts.push(context); return work({ query: respond });
    }),
    withPlatformTransaction: jest.fn(async (context: { purposeOfUse: string }, work: (client: unknown) => Promise<unknown>) => {
      contexts.push(context); return work({ query: respond });
    }),
  };
  const tokens = { verify: jest.fn(), verifyCsrf: jest.fn() };
  const audit = { record: jest.fn(), recordWithClient: jest.fn() };
  const sqlCalls = (needle: string) => calls.filter((call) => call.sql.includes(needle));

  beforeEach(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://ehr.healthidentitydirectory.com,https://admin.healthidentitydirectory.com',
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456', AUTH_COOKIE_SECURE: 'true',
      OTP_HMAC_KEY_B64: hmacKey.toString('base64'),
    });
    resetEnvironmentForTests();
    jest.clearAllMocks();
    calls.length = 0;
    contexts.length = 0;
    for (const key of Object.keys(handlers)) delete handlers[key];
    tokens.verify.mockResolvedValue({ actor: doctorAt(), claims: {} });
    tokens.verifyCsrf.mockReturnValue(true);
    audit.record.mockResolvedValue(undefined);
    audit.recordWithClient.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [OrderDestinationsController, AdminOrderRouteReadsController, AdminOrderRouteCommandsController],
      providers: [
        OrderDestinationsService, AdminOrderRoutesService,
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
    app.use((incoming: HidRequest, _response: Response, next: NextFunction) => {
      incoming.correlationId = randomUUID();
      next();
    });
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
  const search = (query: string) => request(server()).get(`/api/v1/identity/order-destinations?${query}`)
    .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId);
  const destination = { facility_id: laboratoryId, facility_name: 'Synthetic Laboratory', organization_name: 'Synthetic Labs Ltd',
    registered_address: '1 Marina, Lagos', new_on_health_id: true };

  describe('the directory (C19)', () => {
    it('counts the search in the member\'s HMAC bucket, then lists eligible facilities under direct care', async () => {
      handlers['identity.search_order_destinations'] = () => ({ rows: [destination] });
      const answer = await search('kind=laboratory&query=%20Synthetic%20');
      expect([answer.status, answer.body]).toEqual([200, { items: [{ facilityId: laboratoryId,
        facilityName: 'Synthetic Laboratory', organizationName: 'Synthetic Labs Ltd', registeredAddress: '1 Marina, Lagos',
        newOnHealthId: true }] }]);
      const bucket = createHmac('sha256', hmacKey).update('order-destination-search\0').update(membershipId).digest('hex');
      expect(sqlCalls('from auth.otp_rate_limits')[0]?.values).toEqual(['account', bucket]);
      expect(sqlCalls('identity.search_order_destinations')[0]?.values).toEqual(['laboratory', 'Synthetic']);
      // The count commits in its own transaction, before the search's.
      expect(contexts.map((context) => context.purposeOfUse)).toEqual(['direct-care', 'direct-care']);
      expect(calls.findIndex((call) => call.sql.includes('otp_rate_limits')))
        .toBeLessThan(calls.findIndex((call) => call.sql.includes('search_order_destinations')));
    });

    it('audits the kind and the count, never what was searched for', async () => {
      handlers['identity.search_order_destinations'] = () => ({ rows: [destination] });
      await search('kind=pharmacy&query=Zenith%20Pharmacy');
      expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'identity.order-destinations.search', actorType: 'staff', facilityId, details: { kind: 'pharmacy', resultCount: 1 } }));
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api.identity.order-destinations.search',
        outcome: 'success' }));
      const written = JSON.stringify([audit.record.mock.calls, audit.recordWithClient.mock.calls.map(([, event]) => event)]);
      expect(written).not.toContain('Zenith');
      expect(audit.recordWithClient.mock.calls[0]?.[1]).not.toHaveProperty('patientId');
    });

    it('answers the 61st search in an hour 429 ORDER_DESTINATION_SEARCH_LIMITED, without searching', async () => {
      handlers['from auth.otp_rate_limits'] = () => ({ rows: [{ request_count: 60, window_started_at: new Date(),
        blocked_until: null }] });
      const answer = await search('kind=laboratory&query=Synthetic');
      expect([answer.status, answer.body.code]).toEqual([429, 'ORDER_DESTINATION_SEARCH_LIMITED']);
      expect(sqlCalls('search_order_destinations')).toHaveLength(0);
      const counted = sqlCalls('insert into auth.otp_rate_limits')[0]?.values;
      expect(counted?.[0]).toBe('account');
      expect(counted?.[3]).toBe(61);
    });

    it('refuses an unknown kind or a query of fewer than 3 or more than 80 characters with 400, counting nothing', async () => {
      for (const query of ['kind=hospital&query=Synthetic', 'query=Synthetic', 'kind=laboratory&query=ab',
        'kind=laboratory&query=%20%20ab%20', `kind=laboratory&query=${'a'.repeat(81)}`, 'kind=laboratory']) {
        const answer = await search(query);
        expect([answer.status, answer.body.code]).toEqual([400, 'ORDER_DESTINATION_QUERY_INVALID']);
      }
      expect(sqlCalls('otp_rate_limits')).toHaveLength(0);
    });

    it.each([
      ['55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_orders_enabled', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE'],
      ['22023', 'PLATFORM_CONTROL_INVALID', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE'],
      ['22023', 'ORDER_DESTINATION_QUERY_INVALID', 400, 'ORDER_DESTINATION_QUERY_INVALID'],
      ['42501', 'ORDER_ROUTE_PERMISSION_DENIED', 403, 'PERMISSION_DENIED'],
      ['XX000', 'internal', 503, 'ORDER_DESTINATIONS_UNAVAILABLE'],
    ])('answers C19\'s %s %s as %i %s', async (state, message, status, code) => {
      handlers['identity.search_order_destinations'] = () => { throw databaseError(state, message); };
      const answer = await search('kind=laboratory&query=Synthetic');
      expect([answer.status, answer.body.code]).toEqual([status, code]);
    });

    it('refuses a member without ehr.order-route.send 403, and a request without X-Facility-ID 400', async () => {
      tokens.verify.mockResolvedValue({ actor: doctorAt(['ehr.lab-request.write']), claims: {} });
      const denied = await search('kind=laboratory&query=Synthetic');
      expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
      const noFacility = await request(server()).get('/api/v1/identity/order-destinations?kind=laboratory&query=Synthetic')
        .set('Authorization', 'Bearer synthetic');
      expect(noFacility.status).toBeGreaterThanOrEqual(400);
      expect(noFacility.status).toBeLessThan(500);
      expect(sqlCalls('search_order_destinations')).toHaveLength(0);
    });
  });

  describe('support (C20-C23)', () => {
    const admin = (permissions: string[]) => tokens.verify.mockResolvedValue({ actor: standaloneAdmin(permissions), claims: {} });
    const all = ['platform.admin.access', 'platform.facility.read', 'platform.facility.manage', 'platform.facility.unlock',
      'platform.principal.read'];

    it('reads a facility\'s summary as a standalone administrator, audited on success as a platform row', async () => {
      admin(all);
      handlers['identity.admin_order_route_summary'] = () => ({ rows: [{ summary: { listed: { value: true, byDefault: true,
        reason: null, setAt: null }, receivedAcceptedLifetime: 3, receivedPatientsLifetime: 2, counterparts: [] } }] });
      const answer = await request(server()).get(`/api/v1/admin/facilities/${laboratoryId}/order-route-summary`)
        .set('Authorization', 'Bearer synthetic');
      expect([answer.status, answer.body]).toEqual([200, { facilityId: laboratoryId, listed: { value: true, byDefault: true,
        reason: null, setAt: null }, receivedAcceptedLifetime: 3, receivedPatientsLifetime: 2, counterparts: [] }]);
      expect(sqlCalls('identity.admin_order_route_summary')[0]?.values).toEqual([laboratoryId]);
      expect(contexts[0]).toMatchObject({ purposeOfUse: 'healthcare-operations' });
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api.admin.order-route-summary.read',
        outcome: 'success', actorType: 'platform', facilityId: undefined }));
      handlers['identity.admin_order_route_summary'] = () => { throw databaseError('P0002', 'ADMIN_FACILITY_NOT_FOUND'); };
      const missing = await request(server()).get(`/api/v1/admin/facilities/${laboratoryId}/order-route-summary`)
        .set('Authorization', 'Bearer synthetic');
      expect([missing.status, missing.body.code]).toEqual([404, 'ADMIN_FACILITY_NOT_FOUND']);
      admin(['platform.admin.access']);
      const denied = await request(server()).get(`/api/v1/admin/facilities/${laboratoryId}/order-route-summary`)
        .set('Authorization', 'Bearer synthetic');
      expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    });

    it('finds routes by reference (upper-cased) or by Health ID, exactly one of them', async () => {
      admin(all);
      handlers['identity.admin_find_order_routes'] = () => ({ rows: [{ route_id: routeId, reference: '70000000', kind: 'lab_request',
        row_version: '3', effective_state: 'accepted', ordering_facility_id: facilityId, ordering_facility_name: 'Synthetic Hospital Ltd',
        receiving_facility_id: laboratoryId, receiving_facility_name: 'Synthetic Laboratory', created_at: '2026-10-25T09:00:00Z',
        accepted_at: '2026-10-25T10:00:00Z', ended_at: null, ended_kind: null }] });
      const found = await request(server()).get('/api/v1/admin/order-routes?reference=7000000a').set('Authorization', 'Bearer synthetic');
      expect([found.status, found.body.items[0]]).toEqual([200, { routeId, reference: '70000000', kind: 'lab_request', version: 3,
        effectiveState: 'accepted', orderingFacilityId: facilityId, orderingFacilityName: 'Synthetic Hospital Ltd',
        receivingFacilityId: laboratoryId, receivingFacilityName: 'Synthetic Laboratory', createdAt: '2026-10-25T09:00:00.000Z',
        acceptedAt: '2026-10-25T10:00:00.000Z', endedAt: null, endedKind: null }]);
      expect(sqlCalls('identity.admin_find_order_routes')[0]?.values).toEqual(['7000000A', null]);
      // The Health ID goes in a POST body (CODEX §26); the GET's healthId is deprecated but still answered.
      const byHealthId = await request(server()).post('/api/v1/admin/order-routes/search')
        .set('Authorization', 'Bearer synthetic').send({ healthId: ' hid-abc234 ' });
      expect([byHealthId.status, byHealthId.body.items[0]?.routeId]).toEqual([200, routeId]);
      await request(server()).get('/api/v1/admin/order-routes?healthId=hid-abc234').set('Authorization', 'Bearer synthetic');
      expect(sqlCalls('identity.admin_find_order_routes').slice(1).map((call) => call.values))
        .toEqual([[null, 'HID-ABC234'], [null, 'HID-ABC234']]);
      const byReference = await request(server()).post('/api/v1/admin/order-routes/search')
        .set('Authorization', 'Bearer synthetic').send({ reference: '7000000a' });
      expect([byReference.status, sqlCalls('identity.admin_find_order_routes')[3]?.values]).toEqual([200, ['7000000A', null]]);
      for (const query of ['', 'reference=7000000A&healthId=HID-ABC234', 'reference=7000000', 'reference=GGGGGGGG',
        'healthId=ABC234']) {
        const invalid = await request(server()).get(`/api/v1/admin/order-routes?${query}`).set('Authorization', 'Bearer synthetic');
        expect([invalid.status, invalid.body.code]).toEqual([400, 'ORDER_ROUTE_LOOKUP_INVALID']);
      }
      for (const body of [{}, { reference: '7000000A', healthId: 'HID-ABC234' }, { healthId: 'ABC234' }]) {
        const invalid = await request(server()).post('/api/v1/admin/order-routes/search')
          .set('Authorization', 'Bearer synthetic').send(body);
        expect([invalid.status, invalid.body.code]).toEqual([400, 'ORDER_ROUTE_LOOKUP_INVALID']);
      }
      const unknownField = await request(server()).post('/api/v1/admin/order-routes/search')
        .set('Authorization', 'Bearer synthetic').send({ healthId: 'HID-ABC234', dateOfBirth: '1990-01-01' });
      expect([unknownField.status, unknownField.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      expect(sqlCalls('identity.admin_find_order_routes')).toHaveLength(4);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api.admin.order-routes.find', outcome: 'failure' }));
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api.admin.order-routes.find', outcome: 'success' }));
      admin(['platform.admin.access']);
      const denied = await request(server()).post('/api/v1/admin/order-routes/search')
        .set('Authorization', 'Bearer synthetic').send({ healthId: 'HID-ABC234' });
      expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    });

    it('lists or unlists a facility for orders, with a reason; failures audited only', async () => {
      admin(all);
      handlers['identity.admin_set_order_route_destination'] = () => ({ rows: [{ facility_id: laboratoryId, listed: false,
        set_at: '2026-10-25T11:00:00Z' }] });
      const set = await request(server()).post(`/api/v1/admin/facilities/${laboratoryId}/order-destination`)
        .set('Authorization', 'Bearer synthetic').send({ listed: false, reason: '  Checked: not a real laboratory  ' });
      expect([set.status, set.body]).toEqual([200, { facilityId: laboratoryId, listed: false, setAt: '2026-10-25T11:00:00.000Z' }]);
      expect(sqlCalls('identity.admin_set_order_route_destination')[0]?.values)
        .toEqual([laboratoryId, false, 'Checked: not a real laboratory']);
      expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'api.admin.order-route-destination.set',
        outcome: 'success' }));
      handlers['identity.admin_set_order_route_destination'] = () => { throw databaseError('23505', 'ORDER_ROUTE_DESTINATION_UNCHANGED'); };
      const unchanged = await request(server()).post(`/api/v1/admin/facilities/${laboratoryId}/order-destination`)
        .set('Authorization', 'Bearer synthetic').send({ listed: false, reason: 'Checked again today' });
      expect([unchanged.status, unchanged.body.code]).toEqual([409, 'ORDER_ROUTE_DESTINATION_UNCHANGED']);
      const short = await request(server()).post(`/api/v1/admin/facilities/${laboratoryId}/order-destination`)
        .set('Authorization', 'Bearer synthetic').send({ listed: true, reason: 'short' });
      expect([short.status, short.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      admin(['platform.admin.access', 'platform.facility.manage']);
      const denied = await request(server()).post(`/api/v1/admin/facilities/${laboratoryId}/order-destination`)
        .set('Authorization', 'Bearer synthetic').send({ listed: true, reason: 'Checked by phone' });
      expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    });

    it('closes a route with If-Match, answering each refusal by code', async () => {
      admin(all);
      const close = (ifMatch?: string) => {
        const call = request(server()).post(`/api/v1/admin/order-routes/${routeId}/close`).set('Authorization', 'Bearer synthetic');
        return (ifMatch ? call.set('If-Match', ifMatch) : call).send({ reason: 'The patient asked us to stop it' });
      };
      const noVersion = await close();
      expect([noVersion.status, noVersion.body.code]).toEqual([428, 'IF_MATCH_REQUIRED']);
      handlers['identity.admin_close_order_route'] = () => ({ rows: [{ route_id: routeId, row_version: 4, state: 'cancelled' }] });
      const closed = await close('"3"');
      expect([closed.status, closed.body]).toEqual([200, { routeId, version: 4, effectiveState: 'cancelled' }]);
      expect(sqlCalls('identity.admin_close_order_route')[0]?.values).toEqual([routeId, 3, 'The patient asked us to stop it']);
      for (const [state, message, status, code] of [['40001', 'Order route version conflict', 409, 'VERSION_CONFLICT'],
        ['23505', 'ORDER_ROUTE_ALREADY_CLOSED', 409, 'ORDER_ROUTE_ALREADY_CLOSED'], ['P0002', 'not found', 404, 'ORDER_ROUTE_NOT_FOUND'],
        ['42501', 'ADMIN_PERMISSION_DENIED', 403, 'PERMISSION_DENIED'], ['22023', 'reason', 400, 'ORDER_ROUTE_ADMIN_INVALID'],
        ['22023', 'ORDER_ROUTE_CLOSE_INVALID', 400, 'ORDER_ROUTE_CLOSE_INVALID']] as const) {
        handlers['identity.admin_close_order_route'] = () => { throw databaseError(state, message); };
        const refused = await close('3');
        expect([refused.status, refused.body.code]).toEqual([status, code]);
      }
      admin(['platform.admin.access', 'platform.principal.read']);
      const denied = await close('3');
      expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    });
  });
});
