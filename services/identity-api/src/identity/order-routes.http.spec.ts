jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { createHmac, randomUUID } from 'node:crypto';
import { type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { AdminOrderRouteCommandsController, AdminOrderRouteReadsController } from '../admin/order-routes.controller';
import { AdminModule } from '../admin/admin.module';
import { AdminOrderRoutesService } from '../admin/order-routes.service';
import {
  HEALTH_ID_NOT_ACCEPTED_IN_URL, HEALTH_ID_NOT_ACCEPTED_IN_URL_DETAIL, HealthIdInUrlRefusalModule,
} from '../admin/health-id-in-url';
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

  it('support\'s lookup refuses a Health ID in its URL: AdminModule wires the refusal', () => {
    expect(Reflect.getMetadata('imports', AdminModule)).toContain(HealthIdInUrlRefusalModule);
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
    // Item 3 (C26, C27): the wrong-patient reports and their review.
    expect([meta(REQUIRED_PERMISSIONS, reads.wrongPatientReports), meta(AUDIT_ACTION, reads.wrongPatientReports)])
      .toEqual([['platform.admin.access', 'platform.facility.read'], 'admin.wrong-patient-reports.list']);
    expect([meta(REQUIRED_PERMISSIONS, writes.reviewWrongPatientReport), meta(AUDIT_ACTION, writes.reviewWrongPatientReport)])
      .toEqual([['platform.admin.access', 'platform.facility.manage'], 'admin.wrong-patient-report.review']);
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
      // AdminModule's refusal of a Health ID in the lookup's URL (CODEX §26).
      imports: [HealthIdInUrlRefusalModule],
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
      // This Identity serves the wrong-patient report (item 3): the Close form may send support to the receiver first.
      expect(found.body.wrongPatientReports).toBe(true);
      // The Health ID goes in a POST body (CODEX §26); the GET refuses one in its URL (next test).
      const byHealthId = await request(server()).post('/api/v1/admin/order-routes/search')
        .set('Authorization', 'Bearer synthetic').send({ healthId: ' hid-abc234 ' });
      expect([byHealthId.status, byHealthId.body.items[0]?.routeId]).toEqual([200, routeId]);
      expect(sqlCalls('identity.admin_find_order_routes')[1]?.values).toEqual([null, 'HID-ABC234']);
      const byReference = await request(server()).post('/api/v1/admin/order-routes/search')
        .set('Authorization', 'Bearer synthetic').send({ reference: '7000000a' });
      expect([byReference.status, sqlCalls('identity.admin_find_order_routes')[2]?.values]).toEqual([200, ['7000000A', null]]);
      for (const query of ['', 'reference=', 'reference=7000000', 'reference=GGGGGGGG']) {
        const invalid = await request(server()).get(`/api/v1/admin/order-routes?${query}`).set('Authorization', 'Bearer synthetic');
        expect([invalid.status, invalid.body.code]).toEqual([400, 'ORDER_ROUTE_LOOKUP_INVALID']);
      }
      // Every other unknown key in the GET's query is still refused by validation.
      for (const query of ['reference=7000000A&dateOfBirth=1990-01-01', 'HealthId=HID-ABC234']) {
        const unknown = await request(server()).get(`/api/v1/admin/order-routes?${query}`).set('Authorization', 'Bearer synthetic');
        expect([unknown.status, unknown.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
      for (const body of [{}, { reference: '7000000A', healthId: 'HID-ABC234' }, { healthId: 'ABC234' }]) {
        const invalid = await request(server()).post('/api/v1/admin/order-routes/search')
          .set('Authorization', 'Bearer synthetic').send(body);
        expect([invalid.status, invalid.body.code]).toEqual([400, 'ORDER_ROUTE_LOOKUP_INVALID']);
      }
      const unknownField = await request(server()).post('/api/v1/admin/order-routes/search')
        .set('Authorization', 'Bearer synthetic').send({ healthId: 'HID-ABC234', dateOfBirth: '1990-01-01' });
      expect([unknownField.status, unknownField.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      expect(sqlCalls('identity.admin_find_order_routes')).toHaveLength(3);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api.admin.order-routes.find', outcome: 'failure' }));
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api.admin.order-routes.find', outcome: 'success' }));
      admin(['platform.admin.access']);
      const denied = await request(server()).post('/api/v1/admin/order-routes/search')
        .set('Authorization', 'Bearer synthetic').send({ healthId: 'HID-ABC234' });
      expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    });

    it.each([
      'healthId=HID-ABC234', 'healthId=hid-abc234', 'healthId=', 'healthId', 'reference=7000000A&healthId=HID-ABC234',
      'healthId=ABC234', 'healthId=HID-ABC234&healthId=HID-XYZ789', 'healthId%5B%5D=HID-ABC234', '%68ealthId=HID-ABC234',
      'healthId=HID-ABC234&dateOfBirth=1990-01-01',
    ])('refuses GET admin/order-routes?%s 400 HEALTH_ID_NOT_ACCEPTED_IN_URL before the guard, audit and database', async (query) => {
      admin(all);
      const logged = (['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const)
        .map((level) => jest.spyOn(Logger.prototype, level));
      try {
        const refused = await request(server()).get(`/api/v1/admin/order-routes?${query}`).set('Authorization', 'Bearer synthetic');
        expect(refused.status).toBe(400);
        expect(refused.headers['content-type']).toMatch(/^application\/problem\+json/);
        expect(refused.body).toEqual({ type: 'https://healthidentitydirectory.com/problems/health-id-not-accepted-in-url',
          title: 'BAD_REQUEST', status: 400, detail: HEALTH_ID_NOT_ACCEPTED_IN_URL_DETAIL,
          instance: `urn:hid:request:${refused.body.correlationId as string}`, correlationId: expect.any(String),
          code: HEALTH_ID_NOT_ACCEPTED_IN_URL });
        expect(HEALTH_ID_NOT_ACCEPTED_IN_URL_DETAIL).toContain('POST /api/v1/admin/order-routes/search');
        // Never the value, in the body or a header; no session read, no control read, no query, no audit row, no log.
        expect(`${refused.text}${JSON.stringify(refused.headers)}`).not.toMatch(/ABC234|XYZ789/i);
        expect(tokens.verify).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
        expect(contexts).toEqual([]);
        expect(audit.record).not.toHaveBeenCalled();
        expect(audit.recordWithClient).not.toHaveBeenCalled();
        for (const spy of logged) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of logged) spy.mockRestore();
      }
    });

    it('refuses a Health ID in the lookup\'s URL on HEAD and without credentials alike, and keeps the lookup by reference', async () => {
      const head = await request(server()).head('/api/v1/admin/order-routes?healthId=HID-ABC234').set('Authorization', 'Bearer synthetic');
      expect(head.status).toBe(400);
      const anonymous = await request(server()).get('/api/v1/admin/order-routes?healthId=HID-ABC234');
      expect([anonymous.status, anonymous.body.code]).toEqual([400, HEALTH_ID_NOT_ACCEPTED_IN_URL]);
      expect([tokens.verify.mock.calls.length, calls.length, audit.record.mock.calls.length]).toEqual([0, 0, 0]);
      admin(all);
      handlers['identity.admin_find_order_routes'] = () => ({ rows: [] });
      const byReference = await request(server()).get('/api/v1/admin/order-routes?reference=7000000a')
        .set('Authorization', 'Bearer synthetic');
      expect([byReference.status, byReference.body]).toEqual([200, { items: [], wrongPatientReports: true,
        lateCorrection: true, cannotComplete: true }]);
      expect(sqlCalls('identity.admin_find_order_routes').map((call) => call.values)).toEqual([['7000000A', null]]);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api.admin.order-routes.find', outcome: 'success' }));
    });

    it('passes the summary\'s destination through unchanged (item 4, 0089), and answers without it on an earlier schema',
      async () => {
        admin(all);
        const summary = { listed: { value: false, byDefault: true, reason: null, setAt: null },
          destination: { receivingTypes: ['laboratory', 'pharmacy'], review: 'reviewed' },
          receivedAcceptedLifetime: 0, receivedPatientsLifetime: 0, counterparts: [] };
        handlers['identity.admin_order_route_summary'] = () => ({ rows: [{ summary }] });
        const answer = await request(server()).get(`/api/v1/admin/facilities/${laboratoryId}/order-route-summary`)
          .set('Authorization', 'Bearer synthetic');
        expect([answer.status, answer.body]).toEqual([200, { facilityId: laboratoryId, ...summary }]);
        expect(Object.keys(answer.body)).toEqual(['facilityId', 'listed', 'destination', 'receivedAcceptedLifetime',
          'receivedPatientsLifetime', 'counterparts']);
        const governedHospital = { ...summary, destination: { receivingTypes: [], review: 'governed' } };
        handlers['identity.admin_order_route_summary'] = () => ({ rows: [{ summary: JSON.stringify(governedHospital) }] });
        const hospital = await request(server()).get(`/api/v1/admin/facilities/${facilityId}/order-route-summary`)
          .set('Authorization', 'Bearer synthetic');
        expect([hospital.status, hospital.body.destination]).toEqual([200, { receivingTypes: [], review: 'governed' }]);
        const { destination: _destination, ...earlier } = summary;
        handlers['identity.admin_order_route_summary'] = () => ({ rows: [{ summary: earlier }] });
        const before = await request(server()).get(`/api/v1/admin/facilities/${laboratoryId}/order-route-summary`)
          .set('Authorization', 'Bearer synthetic');
        expect([before.status, before.body]).toEqual([200, { facilityId: laboratoryId, ...earlier }]);
        expect(before.body).not.toHaveProperty('destination');
      });

    it('answers when access ends and whether Close acts now (item 4, 0089), from every column, on either schema', async () => {
      admin(all);
      const base = { route_id: routeId, reference: '70000000', kind: 'lab_request', row_version: '4', effective_state: 'completed',
        ordering_facility_id: facilityId, ordering_facility_name: 'Synthetic Hospital Ltd', receiving_facility_id: laboratoryId,
        receiving_facility_name: 'Synthetic Laboratory', created_at: new Date('2026-10-01T08:00:00Z'),
        accepted_at: new Date('2026-10-01T09:00:00Z'), ended_at: null, ended_kind: null };
      const sent = { ...base, route_id: '70000000-0000-4000-8000-000000000002', reference: '70000002', row_version: '1',
        effective_state: 'sent', accepted_at: null, access_ends_at: null, closable: true };
      handlers['identity.admin_find_order_routes'] = () => ({ rows: [
        { ...base, access_ends_at: new Date('2026-10-19T11:12:00.123Z'), closable: false }, sent] });
      const found = await request(server()).get('/api/v1/admin/order-routes?reference=70000000').set('Authorization', 'Bearer synthetic');
      expect(found.status).toBe(200);
      expect(found.body).toEqual({ items: [{ routeId, reference: '70000000', kind: 'lab_request', version: 4,
        effectiveState: 'completed', orderingFacilityId: facilityId, orderingFacilityName: 'Synthetic Hospital Ltd',
        receivingFacilityId: laboratoryId, receivingFacilityName: 'Synthetic Laboratory', createdAt: '2026-10-01T08:00:00.000Z',
        acceptedAt: '2026-10-01T09:00:00.000Z', endedAt: null, endedKind: null, accessEndsAt: '2026-10-19T11:12:00.123Z',
        closable: false }, expect.objectContaining({ reference: '70000002', effectiveState: 'sent', accessEndsAt: null,
        closable: true })], wrongPatientReports: true, lateCorrection: true, cannotComplete: true });
      expect(Object.keys(found.body.items[0]).slice(-2)).toEqual(['accessEndsAt', 'closable']);
      expect(sqlCalls('identity.admin_find_order_routes').map((call) => call.sql))
        .toEqual(['select * from identity.admin_find_order_routes($1, $2)']);
      // A schema without 0089 (13 columns): neither key, never a made-up closable: false; the lookup still answers.
      handlers['identity.admin_find_order_routes'] = () => ({ rows: [base] });
      const earlier = await request(server()).post('/api/v1/admin/order-routes/search')
        .set('Authorization', 'Bearer synthetic').send({ healthId: 'HID-ABC234' });
      expect(earlier.status).toBe(200);
      expect(earlier.body.items[0]).not.toHaveProperty('accessEndsAt');
      expect(earlier.body.items[0]).not.toHaveProperty('closable');
      expect(Object.keys(earlier.body.items[0])).toHaveLength(13);
      // A closable the database did not answer as a boolean is left out; an unreadable time is null.
      handlers['identity.admin_find_order_routes'] = () => ({ rows: [{ ...base, access_ends_at: 'not a time', closable: null },
        { ...base, access_ends_at: '2026-10-19T11:12:00+00:00', closable: 'false' }] });
      const odd = await request(server()).get('/api/v1/admin/order-routes?reference=70000000').set('Authorization', 'Bearer synthetic');
      expect(odd.body.items.map((item: Record<string, unknown>) => [item.accessEndsAt, 'closable' in item]))
        .toEqual([[null, false], ['2026-10-19T11:12:00.000Z', false]]);
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

  describe('support\'s wrong-patient reports (item 3, C26 and C27)', () => {
    const admin = (permissions: string[]) => tokens.verify.mockResolvedValue({ actor: standaloneAdmin(permissions), claims: {} });
    const reader = ['platform.admin.access', 'platform.facility.read'];
    const manager = ['platform.admin.access', 'platform.facility.read', 'platform.facility.manage'];
    const reportId = '80000000-0000-4000-8000-000000000001';
    const note = 'The person at the counter gave his brother\'s Health ID';
    const row = { report_id: reportId, row_version: '1', route_id: routeId, reference: '70000000', kind: 'lab_request',
      receiving_facility_id: laboratoryId, receiving_facility_name: 'Synthetic Laboratory', ordering_facility_id: facilityId,
      ordering_facility_name: 'Synthetic Hospital Ltd', reported_at: new Date('2026-10-26T08:00:00Z'),
      reported_by_account_id: '20000000-0000-4000-8000-000000000031', reported_by_name: 'Remi Lab',
      accepted_by_account_id: '20000000-0000-4000-8000-000000000031', accepted_by_name: 'Remi Lab', same_member: true,
      accepted_with: 'date_of_birth', accepted_at: new Date('2026-10-25T10:00:00Z'), reason_code: 'someone_elses_details', note,
      note_removed: false, state_before: 'completed', results_voided: 1, result_reports_marked: 1, dispensing_reversed: false,
      specimens_collected: 1, recorded_by: [{ accountId: '20000000-0000-4000-8000-000000000031', name: 'Remi Lab', extra: 'x' }],
      reporter_recorded_work: true, flags: ['something_came_back', 'reporter_recorded_work'], facility_reports_last_30_days: 2,
      member_reports_last_30_days: 1, reviewed_at: null, reviewed_by_account_id: null, reviewed_by_name: null,
      review_actions: null, review_note: null,
      // Never answered, whatever the database returns.
      patient_id: '50000000-0000-4000-8000-000000000001' };
    const list = (query: string) => request(server()).get(`/api/v1/admin/wrong-patient-reports?${query}`)
      .set('Authorization', 'Bearer synthetic');
    const review = (body: unknown, ifMatch?: string) => {
      const call = request(server()).post(`/api/v1/admin/wrong-patient-reports/${reportId}/review`)
        .set('Authorization', 'Bearer synthetic');
      return (ifMatch ? call.set('If-Match', ifMatch) : call).send(body as object);
    };

    it('lists the unreviewed reports field by field, read-only, as a standalone administrator, audited on success', async () => {
      admin(reader);
      handlers['identity.admin_list_wrong_patient_reports'] = () => ({ rows: [row] });
      const answer = await list('status=unreviewed');
      expect([answer.status, answer.body]).toEqual([200, { items: [{ reportId, version: 1, routeId, reference: '70000000',
        kind: 'lab_request', receivingFacility: { id: laboratoryId, name: 'Synthetic Laboratory' },
        orderingFacility: { id: facilityId, name: 'Synthetic Hospital Ltd' }, reportedAt: '2026-10-26T08:00:00.000Z',
        reportedBy: { accountId: '20000000-0000-4000-8000-000000000031', name: 'Remi Lab' },
        acceptedBy: { accountId: '20000000-0000-4000-8000-000000000031', name: 'Remi Lab' }, sameMember: true,
        acceptedWith: 'date_of_birth', acceptedAt: '2026-10-25T10:00:00.000Z', reason: 'someone_elses_details', note,
        noteRemoved: false, stateBefore: 'completed', resultsVoided: 1, resultReportsMarked: 1, dispensingReversed: false,
        specimensCollected: 1, recordedBy: [{ accountId: '20000000-0000-4000-8000-000000000031', name: 'Remi Lab' }],
        reporterRecordedWork: true, flags: ['something_came_back', 'reporter_recorded_work'], facilityReportsLast30Days: 2,
        memberReportsLast30Days: 1, review: null }], lateCorrection: true }]);
      expect(sqlCalls('identity.admin_list_wrong_patient_reports')[0]?.values).toEqual(['unreviewed', null]);
      expect(database.withPlatformTransaction).toHaveBeenCalledWith(expect.objectContaining({
        purposeOfUse: 'healthcare-operations' }), expect.any(Function), { readOnly: true });
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api.admin.wrong-patient-reports.list',
        outcome: 'success', actorType: 'platform' }));
      // The note reaches support's answer only: no audit row carries it.
      expect(JSON.stringify([audit.record.mock.calls, audit.recordWithClient.mock.calls])).not.toContain('brother');
    });

    it('lists the last 90 days of one receiving facility, with a review when there is one', async () => {
      admin(reader);
      handlers['identity.admin_list_wrong_patient_reports'] = () => ({ rows: [{ ...row, row_version: 2,
        note: 'Removed by Health ID support at review.', note_removed: true, reviewed_at: '2026-10-26T09:00:00Z',
        reviewed_by_account_id: 'e0000000-0000-4000-8000-000000000086', reviewed_by_name: 'Synthetic Support',
        review_actions: ['ordering_facility_told', 'referred_to_dpo'], review_note: 'Phoned the hospital and referred it' }] });
      const answer = await list(`status=recent&facilityId=${laboratoryId}`);
      expect(answer.status).toBe(200);
      expect(answer.body.items[0]).toMatchObject({ version: 2, note: 'Removed by Health ID support at review.', noteRemoved: true,
        review: { reviewedAt: '2026-10-26T09:00:00.000Z', reviewedBy: { accountId: 'e0000000-0000-4000-8000-000000000086',
          name: 'Synthetic Support' }, actions: ['ordering_facility_told', 'referred_to_dpo'],
        note: 'Phoned the hospital and referred it' } });
      expect(JSON.stringify(answer.body)).not.toContain('50000000-0000-4000-8000-000000000001');
      expect(sqlCalls('identity.admin_list_wrong_patient_reports')[0]?.values).toEqual(['recent', laboratoryId]);
    });

    it('refuses a bad query 400 before the database, and answers each refusal by code', async () => {
      admin(reader);
      for (const query of ['', 'status=all', 'status=unreviewed&facilityId=not-a-uuid', 'status=recent&patientId=x']) {
        const invalid = await list(query);
        expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
      expect(sqlCalls('identity.admin_list_wrong_patient_reports')).toHaveLength(0);
      for (const [state, message, status, code] of [['P0002', 'ADMIN_FACILITY_NOT_FOUND', 404, 'ADMIN_FACILITY_NOT_FOUND'],
        ['22023', 'WRONG_PATIENT_REPORTS_QUERY_INVALID', 400, 'WRONG_PATIENT_REPORTS_QUERY_INVALID'],
        ['42501', 'ADMIN_PERMISSION_DENIED', 403, 'PERMISSION_DENIED'], ['XX000', 'internal', 503, 'ORDER_ROUTES_ADMIN_UNAVAILABLE'],
      ] as const) {
        handlers['identity.admin_list_wrong_patient_reports'] = () => { throw databaseError(state, message); };
        const refused = await list(`status=recent&facilityId=${laboratoryId}`);
        expect([refused.status, refused.body.code]).toEqual([status, code]);
      }
      admin(['platform.admin.access', 'platform.principal.read']);
      const denied = await list('status=unreviewed');
      expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
      // A staff member at a facility, without platform authority, is refused too.
      tokens.verify.mockResolvedValue({ actor: doctorAt(), claims: {} });
      const staff = await list('status=unreviewed');
      expect(staff.status).toBe(403);
    });

    it('marks a report reviewed with If-Match, the actions, the trimmed note and the note removal', async () => {
      admin(manager);
      handlers['identity.admin_review_wrong_patient_report'] = () => ({ rows: [{ report_id: reportId, row_version: '2',
        reviewed_at: new Date('2026-10-26T09:00:00Z'), review_actions: ['ordering_facility_told', 'referred_to_dpo'],
        note_removed: true }] });
      const reviewed = await review({ actions: ['ordering_facility_told', 'referred_to_dpo'],
        note: '  Phoned the hospital and referred it  ', removeNote: true }, '"1"');
      expect([reviewed.status, reviewed.body]).toEqual([200, { reportId, version: 2, reviewedAt: '2026-10-26T09:00:00.000Z',
        actions: ['ordering_facility_told', 'referred_to_dpo'], noteRemoved: true }]);
      expect(sqlCalls('identity.admin_review_wrong_patient_report')[0]?.values).toEqual([reportId, 1,
        ['ordering_facility_told', 'referred_to_dpo'], 'Phoned the hospital and referred it', true]);
      await review({ actions: ['no_further_action'], note: 'Checked: an honest slip at the counter' }, '2');
      expect(sqlCalls('identity.admin_review_wrong_patient_report')[1]?.values).toEqual([reportId, 2, ['no_further_action'],
        'Checked: an honest slip at the counter', false]);
      // The command writes the platform row; the interceptor writes failures only.
      expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'api.admin.wrong-patient-report.review',
        outcome: 'success' }));
    });

    it('requires If-Match and a valid body before the database, and answers each refusal by code', async () => {
      admin(manager);
      const noVersion = await review({ actions: ['facility_contacted'], note: 'Phoned the laboratory manager' });
      expect([noVersion.status, noVersion.body.code]).toEqual([428, 'IF_MATCH_REQUIRED']);
      for (const body of [{ actions: [], note: 'Phoned the laboratory manager' },
        { actions: ['facility_contacted', 'facility_contacted'], note: 'Phoned the laboratory manager' },
        { actions: ['phoned'], note: 'Phoned the laboratory manager' }, { actions: 'facility_contacted', note: 'Phoned the manager' },
        { actions: ['facility_contacted'], note: '  short  ' }, { actions: ['facility_contacted'], note: 'x'.repeat(501) },
        { actions: ['facility_contacted'], note: 'Phoned the laboratory manager', removeNote: 'yes' },
        { actions: ['facility_contacted'], note: 'Phoned the laboratory manager', reportId }]) {
        const invalid = await review(body, '1');
        expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
      expect(sqlCalls('identity.admin_review_wrong_patient_report')).toHaveLength(0);
      for (const [state, message, status, code] of [
        ['22023', 'WRONG_PATIENT_REVIEW_INVALID', 400, 'WRONG_PATIENT_REVIEW_INVALID'],
        ['P0002', 'WRONG_PATIENT_REPORT_NOT_FOUND', 404, 'WRONG_PATIENT_REPORT_NOT_FOUND'],
        ['23505', 'WRONG_PATIENT_REPORT_ALREADY_REVIEWED', 409, 'WRONG_PATIENT_REPORT_ALREADY_REVIEWED'],
        ['40001', 'Wrong-patient report version conflict', 409, 'VERSION_CONFLICT'],
        ['42501', 'ADMIN_PERMISSION_DENIED', 403, 'PERMISSION_DENIED'],
        ['23505', 'something_else', 503, 'ORDER_ROUTES_ADMIN_UNAVAILABLE'],
        ['XX000', 'internal', 503, 'ORDER_ROUTES_ADMIN_UNAVAILABLE'],
      ] as const) {
        handlers['identity.admin_review_wrong_patient_report'] = () => { throw databaseError(state, message); };
        const refused = await review({ actions: ['facility_contacted', 'no_further_action'],
          note: 'Phoned the laboratory manager' }, '1');
        expect([refused.status, refused.body.code]).toEqual([status, code]);
      }
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api.admin.wrong-patient-report.review',
        outcome: 'failure' }));
      admin(reader);
      const denied = await review({ actions: ['facility_contacted'], note: 'Phoned the laboratory manager' }, '1');
      expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    });
  });

  describe('support and the late correction (D17: C21, C26, C27)', () => {
    const admin = (permissions: string[]) => tokens.verify.mockResolvedValue({ actor: standaloneAdmin(permissions), claims: {} });
    const all = ['platform.admin.access', 'platform.facility.read', 'platform.facility.manage', 'platform.principal.read'];
    const reportId = '80000000-0000-4000-8000-000000000002';
    const found = { route_id: routeId, reference: '70000000', kind: 'lab_request', row_version: '6', effective_state: 'completed',
      ordering_facility_id: facilityId, ordering_facility_name: 'Synthetic Hospital Ltd', receiving_facility_id: laboratoryId,
      receiving_facility_name: 'Synthetic Laboratory', created_at: new Date('2026-10-01T08:00:00Z'),
      accepted_at: new Date('2026-10-01T09:00:00Z'), ended_at: new Date('2026-10-05T09:00:00Z'), ended_kind: 'support',
      access_ends_at: new Date('2026-10-05T09:00:00Z'), closable: false };
    const report = { report_id: reportId, row_version: '1', route_id: routeId, reference: '70000000', kind: 'lab_request',
      receiving_facility_id: laboratoryId, receiving_facility_name: 'Synthetic Laboratory', ordering_facility_id: facilityId,
      ordering_facility_name: 'Synthetic Hospital Ltd', reported_at: new Date('2026-10-26T08:00:00Z'),
      reported_by_account_id: '20000000-0000-4000-8000-000000000031', reported_by_name: 'Remi Lab',
      accepted_by_account_id: '20000000-0000-4000-8000-000000000032', accepted_by_name: 'Tola Lab', same_member: false,
      accepted_with: 'health_id', accepted_at: new Date('2026-10-01T09:00:00Z'), reason_code: 'someone_elses_details',
      note: 'The patient phoned: she never gave a sample there', note_removed: false, state_before: 'completed',
      results_voided: 1, result_reports_marked: 1, dispensing_reversed: false, specimens_collected: 1, recorded_by: [],
      reporter_recorded_work: false, flags: ['something_came_back', 'late_correction', 'patient_prompted'],
      facility_reports_last_30_days: 1, member_reports_last_30_days: 0, reviewed_at: null, reviewed_by_account_id: null,
      reviewed_by_name: null, review_actions: null, review_note: null };
    const late = { late: true, ended_kind_before: 'support', discovered_by: 'patient',
      // node-postgres makes a date column a Date at local midnight.
      discovered_on: new Date(2026, 9, 25), reporter_late_reports_last_30_days: 2, ordering_sender_active: false,
      required_actions: ['ordering_facility_told', 'referred_to_dpo'] };

    it('finds a route with whether it may still be corrected, until when, and the report; lateCorrection: true', async () => {
      admin(all);
      handlers['identity.admin_find_order_routes'] = () => ({ rows: [
        { ...found, correction: 'correctable', correctable_until: new Date('2027-03-30T09:00:00Z'), wrong_patient_reported_at: null,
          wrong_patient_late: null },
        { ...found, route_id: '70000000-0000-4000-8000-000000000003', correction: 'reported', correctable_until: null,
          wrong_patient_reported_at: new Date('2026-10-26T08:00:00.5Z'), wrong_patient_late: true },
        { ...found, route_id: '70000000-0000-4000-8000-000000000004', correction: 'too_late',
          correctable_until: new Date('2026-04-01T09:00:00Z'), wrong_patient_reported_at: null, wrong_patient_late: null },
        { ...found, route_id: '70000000-0000-4000-8000-000000000005', effective_state: 'sent', accepted_at: null,
          correction: 'not_accepted', correctable_until: null, wrong_patient_reported_at: null, wrong_patient_late: null }] });
      const answer = await request(server()).get('/api/v1/admin/order-routes?reference=70000000').set('Authorization', 'Bearer synthetic');
      expect(answer.status).toBe(200);
      expect(answer.body.lateCorrection).toBe(true);
      expect(answer.body.wrongPatientReports).toBe(true);
      expect(answer.body.items.map((item: Record<string, unknown>) => [item.correction, item.correctableUntil, item.wrongPatient]))
        .toEqual([['correctable', '2027-03-30T09:00:00.000Z', null],
          ['reported', null, { reportedAt: '2026-10-26T08:00:00.500Z', late: true }],
          ['too_late', '2026-04-01T09:00:00.000Z', null], ['not_accepted', null, null]]);
      expect(Object.keys(answer.body.items[0]).slice(-5)).toEqual(['accessEndsAt', 'closable', 'correction', 'correctableUntil',
        'wrongPatient']);
      // An earlier schema (0089's 15 columns): none of the three, and the lookup still answers.
      handlers['identity.admin_find_order_routes'] = () => ({ rows: [found] });
      const earlier = await request(server()).post('/api/v1/admin/order-routes/search')
        .set('Authorization', 'Bearer synthetic').send({ healthId: 'HID-ABC234' });
      expect(earlier.status).toBe(200);
      for (const key of ['correction', 'correctableUntil', 'wrongPatient']) expect(earlier.body.items[0]).not.toHaveProperty(key);
      expect(Object.keys(earlier.body.items[0])).toHaveLength(15);
    });

    it('lists a late report with its facts and what the review requires; an in-window one late false; an earlier schema none',
      async () => {
        admin(all);
        handlers['identity.admin_list_wrong_patient_reports'] = () => ({ rows: [
          { ...report, ...late, required_actions: ['ordering_facility_told', 'referred_to_dpo', 'something_unknown'] },
          { ...report, report_id: '80000000-0000-4000-8000-000000000003', flags: ['something_came_back'], late: false,
            ended_kind_before: null, discovered_by: null, discovered_on: null, reporter_late_reports_last_30_days: 0,
            ordering_sender_active: true, required_actions: [] },
          { ...report, report_id: '80000000-0000-4000-8000-000000000004' }] });
        const answer = await request(server()).get('/api/v1/admin/wrong-patient-reports?status=unreviewed')
          .set('Authorization', 'Bearer synthetic');
        expect(answer.status).toBe(200);
        expect(answer.body.lateCorrection).toBe(true);
        const [lateReport, inWindow, earlier] = answer.body.items as Record<string, unknown>[];
        expect(lateReport).toMatchObject({ late: true, endedKindBefore: 'support', discoveredBy: 'patient', discoveredOn: '2026-10-25',
          reporterLateReportsLast30Days: 2, orderingSenderActive: false, requiredActions: ['referred_to_dpo', 'ordering_facility_told'],
          flags: ['something_came_back', 'late_correction', 'patient_prompted'], review: null });
        expect(inWindow).toMatchObject({ late: false, endedKindBefore: null, discoveredBy: null, discoveredOn: null,
          reporterLateReportsLast30Days: 0, orderingSenderActive: true, requiredActions: [] });
        for (const key of ['late', 'endedKindBefore', 'discoveredBy', 'discoveredOn', 'reporterLateReportsLast30Days',
          'orderingSenderActive', 'requiredActions']) expect(earlier).not.toHaveProperty(key);
        expect(JSON.stringify(answer.body)).not.toContain('50000000-0000-4000-8000-000000000001');
      });

    it('refuses to mark a late report reviewed without the referral 400 WRONG_PATIENT_REVIEW_REFERRAL_REQUIRED with required',
      async () => {
        admin(['platform.admin.access', 'platform.facility.read', 'platform.facility.manage']);
        const review = (body: unknown) => request(server()).post(`/api/v1/admin/wrong-patient-reports/${reportId}/review`)
          .set('Authorization', 'Bearer synthetic').set('If-Match', '1').send(body as object);
        const both = 'referred_to_dpo,ordering_facility_told';
        for (const [detail, required] of [[both, both], ['ordering_facility_told', 'ordering_facility_told'],
          ['ordering_facility_told,referred_to_dpo,x', both]]) {
          handlers['identity.admin_review_wrong_patient_report'] = () => {
            throw Object.assign(databaseError('22023', 'WRONG_PATIENT_REVIEW_REFERRAL_REQUIRED'), { detail });
          };
          const refused = await review({ actions: ['no_further_action'], note: 'Checked with the laboratory by phone' });
          expect([refused.status, refused.body.code, refused.body.required]).toEqual([400, 'WRONG_PATIENT_REVIEW_REFERRAL_REQUIRED',
            required]);
          expect(refused.body).not.toHaveProperty('extensions');
          expect(refused.headers['content-type']).toMatch(/^application\/problem\+json/);
        }
        // A DETAIL naming no known action: the refusal still, without the member.
        handlers['identity.admin_review_wrong_patient_report'] = () => {
          throw Object.assign(databaseError('22023', 'WRONG_PATIENT_REVIEW_REFERRAL_REQUIRED'), { detail: 'unknown' });
        };
        const bare = await review({ actions: ['facility_contacted'], note: 'Checked with the laboratory by phone' });
        expect([bare.status, bare.body.code, 'required' in bare.body]).toEqual([400, 'WRONG_PATIENT_REVIEW_REFERRAL_REQUIRED', false]);
        // Any other 22023 of the review is still the generic refusal.
        handlers['identity.admin_review_wrong_patient_report'] = () => { throw databaseError('22023', 'WRONG_PATIENT_REVIEW_INVALID'); };
        const generic = await review({ actions: ['facility_contacted'], note: 'Checked with the laboratory by phone' });
        expect([generic.status, generic.body.code, 'required' in generic.body]).toEqual([400, 'WRONG_PATIENT_REVIEW_INVALID', false]);
        // With the required actions the review goes through as before.
        handlers['identity.admin_review_wrong_patient_report'] = () => ({ rows: [{ report_id: reportId, row_version: '2',
          reviewed_at: new Date('2026-10-26T09:00:00Z'), review_actions: ['ordering_facility_told', 'referred_to_dpo'],
          note_removed: false }] });
        const reviewed = await review({ actions: ['ordering_facility_told', 'referred_to_dpo'],
          note: 'Phoned the hospital and referred it to the DPO' });
        expect([reviewed.status, reviewed.body.version]).toEqual([200, 2]);
      });
  });

  describe('support and "We can\'t complete this order" (D18: C20 with C32, C21, C26)', () => {
    const admin = (permissions: string[]) => tokens.verify.mockResolvedValue({ actor: standaloneAdmin(permissions), claims: {} });
    const all = ['platform.admin.access', 'platform.facility.read', 'platform.facility.manage', 'platform.principal.read'];
    const summary = { listed: { value: true, byDefault: true, reason: null, setAt: null },
      destination: { receivingTypes: ['laboratory'], review: 'reviewed' }, receivedAcceptedLifetime: 9,
      receivedPatientsLifetime: 7, counterparts: [] };
    const counts = { last30Days: 4, soonAfterAcceptance: 1, afterSevenDays: 1, laterReportedWrongPatient: 1,
      byReason: { other: 1, out_of_stock: 1, supplies_unavailable: 2 } };
    const read = (id = laboratoryId) => request(server()).get(`/api/v1/admin/facilities/${id}/order-route-summary`)
      .set('Authorization', 'Bearer synthetic');
    const statements = () => calls.map((call) => call.sql).filter((sql) => !sql.includes('platform.control_enabled'));

    it('merges C32\'s five counts into the facility summary, read in a savepoint of the same read-only transaction', async () => {
      admin(all);
      handlers['identity.admin_order_route_summary'] = () => ({ rows: [{ summary }] });
      handlers['identity.admin_order_route_not_completed'] = () => ({ rows: [{ not_completed: counts }] });
      const answer = await read();
      expect([answer.status, answer.body]).toEqual([200, { facilityId: laboratoryId, ...summary, notCompleted: counts,
        cannotComplete: true }]);
      expect(Object.keys(answer.body)).toEqual(['facilityId', 'listed', 'destination', 'receivedAcceptedLifetime',
        'receivedPatientsLifetime', 'counterparts', 'notCompleted', 'cannotComplete']);
      expect(Object.keys(answer.body.notCompleted)).toEqual(['last30Days', 'soonAfterAcceptance', 'afterSevenDays',
        'laterReportedWrongPatient', 'byReason']);
      expect(statements()).toEqual(['select identity.admin_order_route_summary($1) as summary',
        'savepoint admin_order_route_not_completed', 'select identity.admin_order_route_not_completed($1) as not_completed',
        'release savepoint admin_order_route_not_completed']);
      expect(sqlCalls('identity.admin_order_route_not_completed')[0]?.values).toEqual([laboratoryId]);
      expect(database.withPlatformTransaction).toHaveBeenCalledTimes(1);
      expect(database.withPlatformTransaction).toHaveBeenCalledWith(expect.objectContaining({
        purposeOfUse: 'healthcare-operations' }), expect.any(Function), { readOnly: true });
      // No reason in any audit row: the read is audited as before.
      expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(/supplies_unavailable|notCompleted/);
      // A facility with no such endings: zeros and an empty byReason, still served.
      const none = { last30Days: 0, soonAfterAcceptance: 0, afterSevenDays: 0, laterReportedWrongPatient: 0, byReason: {} };
      handlers['identity.admin_order_route_not_completed'] = () => ({ rows: [{ not_completed: JSON.stringify(none) }] });
      const empty = await read();
      expect([empty.status, empty.body.notCompleted, empty.body.cannotComplete]).toEqual([200, none, true]);
    });

    it('leaves both out when C32 fails (a schema without 0091), rolling back to its savepoint; the summary still answers',
      async () => {
        admin(all);
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        try {
          handlers['identity.admin_order_route_summary'] = () => ({ rows: [{ summary }] });
          handlers['identity.admin_order_route_not_completed'] = () => {
            throw databaseError('42883', 'function identity.admin_order_route_not_completed(unknown) does not exist');
          };
          const answer = await read();
          expect([answer.status, answer.body]).toEqual([200, { facilityId: laboratoryId, ...summary }]);
          expect(statements().slice(-3)).toEqual(['savepoint admin_order_route_not_completed',
            'select identity.admin_order_route_not_completed($1) as not_completed',
            'rollback to savepoint admin_order_route_not_completed']);
          expect(warn).toHaveBeenCalledWith(expect.objectContaining({ sqlState: '42883' }));
          expect(JSON.stringify(warn.mock.calls)).not.toContain('does not exist');
          // A refusal of the actor (42501) after C20 answered: the same.
          handlers['identity.admin_order_route_not_completed'] = () => { throw databaseError('42501', 'denied'); };
          const refused = await read();
          expect([refused.status, refused.body]).toEqual([200, { facilityId: laboratoryId, ...summary }]);
          // An unreadable answer (no row, a missing or negative count, counts as text, a bad byReason): left out.
          for (const notCompleted of [undefined, null, 'not json', { ...counts, afterSevenDays: undefined },
            { ...counts, last30Days: -1 }, { ...counts, soonAfterAcceptance: '1' }, { ...counts, byReason: [] },
            { ...counts, byReason: { other: 1.5 } }, { ...counts, byReason: { 'Not A Code': 1 } }]) {
            handlers['identity.admin_order_route_not_completed'] = () => ({ rows: notCompleted === undefined ? []
              : [{ not_completed: notCompleted }] });
            const odd = await read();
            expect([odd.status, 'notCompleted' in odd.body, 'cannotComplete' in odd.body]).toEqual([200, false, false]);
          }
        } finally {
          warn.mockRestore();
        }
      });

    it('reads no counts when C20 refuses: 404 for an unknown facility, 403 without platform.facility.read', async () => {
      admin(all);
      handlers['identity.admin_order_route_summary'] = () => { throw databaseError('P0002', 'ADMIN_FACILITY_NOT_FOUND'); };
      handlers['identity.admin_order_route_not_completed'] = () => ({ rows: [{ not_completed: counts }] });
      const missing = await read();
      expect([missing.status, missing.body.code]).toEqual([404, 'ADMIN_FACILITY_NOT_FOUND']);
      admin(['platform.admin.access']);
      const denied = await read();
      expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
      expect(sqlCalls('identity.admin_order_route_not_completed')).toEqual([]);
    });

    it('Find answers cannotComplete: true, and an order ended that way as cancelled, receiving_unable, still correctable',
      async () => {
        admin(all);
        handlers['identity.admin_find_order_routes'] = () => ({ rows: [{ route_id: routeId, reference: '70000000',
          kind: 'lab_request', row_version: '3', effective_state: 'cancelled', ordering_facility_id: facilityId,
          ordering_facility_name: 'Synthetic Hospital Ltd', receiving_facility_id: laboratoryId,
          receiving_facility_name: 'Synthetic Laboratory', created_at: new Date('2026-10-20T08:00:00Z'),
          accepted_at: new Date('2026-10-20T09:00:00Z'), ended_at: new Date('2026-10-21T09:00:00Z'),
          ended_kind: 'receiving_unable', access_ends_at: new Date('2026-10-28T09:00:00Z'), closable: false,
          correction: 'correctable', correctable_until: new Date('2027-04-18T09:00:00Z'), wrong_patient_reported_at: null,
          wrong_patient_late: null }] });
        const answer = await request(server()).get('/api/v1/admin/order-routes?reference=70000000')
          .set('Authorization', 'Bearer synthetic');
        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({ items: [{ effectiveState: 'cancelled', endedKind: 'receiving_unable', closable: false,
          correction: 'correctable', correctableUntil: '2027-04-18T09:00:00.000Z', wrongPatient: null }],
        wrongPatientReports: true, lateCorrection: true, cannotComplete: true });
        expect(Object.keys(answer.body)).toEqual(['items', 'wrongPatientReports', 'lateCorrection', 'cannotComplete']);
      });

    it('D18-12: a later report on an order ended that way is listed flagged, first, in C26\'s order, naming the ending',
      async () => {
        admin(all);
        const base = { row_version: '1', route_id: routeId, reference: '70000000', kind: 'lab_request',
          receiving_facility_id: laboratoryId, receiving_facility_name: 'Synthetic Laboratory', ordering_facility_id: facilityId,
          ordering_facility_name: 'Synthetic Hospital Ltd', reported_by_account_id: '20000000-0000-4000-8000-000000000031',
          reported_by_name: 'Remi Lab', accepted_by_account_id: '20000000-0000-4000-8000-000000000031',
          accepted_by_name: 'Remi Lab', same_member: true, accepted_with: 'health_id',
          accepted_at: new Date('2026-10-01T09:00:00Z'), reason_code: 'someone_elses_details',
          note: 'The person was her sister, who used her card', note_removed: false, results_voided: 1, result_reports_marked: 0,
          dispensing_reversed: false, specimens_collected: 1, recorded_by: [], reporter_recorded_work: true,
          facility_reports_last_30_days: 2, member_reports_last_30_days: 2, reviewed_at: null, reviewed_by_account_id: null,
          reviewed_by_name: null, review_actions: null, review_note: null, discovered_by: 'own_check',
          discovered_on: new Date(2026, 9, 25), reporter_late_reports_last_30_days: 1, ordering_sender_active: true };
        // C26's unreviewed order: flagged first (late_correction is a flag), then oldest first.
        handlers['identity.admin_list_wrong_patient_reports'] = () => ({ rows: [
          { ...base, report_id: '80000000-0000-4000-8000-000000000011', reported_at: new Date('2026-10-26T08:00:00Z'),
            state_before: 'cancelled', flags: ['reporter_recorded_work', 'late_correction'], late: true,
            ended_kind_before: 'receiving_unable', required_actions: [] },
          { ...base, report_id: '80000000-0000-4000-8000-000000000012', reported_at: new Date('2026-10-20T08:00:00Z'),
            state_before: 'accepted', flags: [], reporter_recorded_work: false, late: false, ended_kind_before: null,
            discovered_by: null, discovered_on: null, required_actions: [] }] });
        const answer = await request(server()).get('/api/v1/admin/wrong-patient-reports?status=unreviewed')
          .set('Authorization', 'Bearer synthetic');
        expect(answer.status).toBe(200);
        const [after, other] = answer.body.items as Record<string, unknown>[];
        expect(after).toMatchObject({ reportId: '80000000-0000-4000-8000-000000000011', late: true,
          endedKindBefore: 'receiving_unable', stateBefore: 'cancelled', flags: ['reporter_recorded_work', 'late_correction'],
          requiredActions: [], discoveredBy: 'own_check', discoveredOn: '2026-10-25' });
        expect(other).toMatchObject({ reportId: '80000000-0000-4000-8000-000000000012', late: false, flags: [] });
        expect(sqlCalls('identity.admin_list_wrong_patient_reports')[0]?.values).toEqual(['unreviewed', null]);
      });
  });
});
