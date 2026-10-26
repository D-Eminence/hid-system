import 'reflect-metadata';
import {
  type ExecutionContext, type INestApplication, Logger, type MiddlewareConsumer, Module, type NestModule, ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { CorrelationMiddleware } from '../common/correlation.middleware';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import {
  carriesHealthId, HEALTH_ID_NOT_ACCEPTED_IN_URL, HEALTH_ID_NOT_ACCEPTED_IN_URL_DETAIL, HealthIdInUrlRefusalModule,
} from './health-id-in-url';
import { LabOrderRoutesController } from './lab-order-routes.controller';
import { LabOrderRoutesService } from './lab-order-routes.service';
import { LabOrderRouteCards } from './order-route-cards';
import { LabModule } from './lab.module';

// GET lab/order-routes refuses a Health ID in its URL (CODEX §26), over HTTP
// with the module wiring, correlation middleware, validation, interceptor and
// problem filter as main.ts and AppModule set them; the guard, the database
// and the audit store are fakes that record every call.
const facilityId = '10000000-0000-4000-8000-000000000001';
const healthId = 'HID-ABC234';
const actor: ActorContext = { kind: 'staff', id: 'staff:lab', subject: 'staff:lab', accountId: '20000000-0000-4000-8000-000000000001',
  roles: ['lab'], permissions: ['lab.order-route.receive'], facilityIds: [facilityId], authenticationMethod: 'local',
  facilities: [{ id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
    organizationId: '30000000-0000-4000-8000-000000000001', name: 'Synthetic Laboratory', roles: ['lab'],
    permissions: ['lab.order-route.receive'], isPrimary: true }] };

const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
  statements.push({ sql, values });
  return { rows: [] };
}) };
const database = {
  withTransaction: jest.fn(async (_context: unknown, work: (c: typeof client) => Promise<unknown>) => work(client)),
  query: jest.fn(async () => ({ rows: [{ orders: true, work: true }] })),
};
const audit = { record: jest.fn(async () => undefined), recordWithClient: jest.fn(async () => undefined) };
const guard = { canActivate: jest.fn((execution: ExecutionContext) => {
  const incoming = execution.switchToHttp().getRequest<HidRequest>();
  incoming.actor = { ...actor, facility: actor.facilities[0], permissions: actor.facilities[0]!.permissions };
  incoming.facilityId = facilityId;
  return true;
}) };

/** As AppModule: correlation on every path, the Lab module's refusal imported below it. */
@Module({
  imports: [HealthIdInUrlRefusalModule],
  controllers: [LabOrderRoutesController],
  providers: [LabOrderRoutesService, LabOrderRouteCards,
    { provide: DatabaseService, useValue: database },
    { provide: AuditService, useValue: audit },
    { provide: APP_GUARD, useFactory: () => guard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
class LabOrderRoutesHttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
  }
}

describe('a Health ID in the URL of GET lab/order-routes (CODEX §26)', () => {
  let app: INestApplication;
  const logged = (['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const)
    .map((level) => jest.spyOn(Logger.prototype, level));

  beforeEach(async () => {
    jest.clearAllMocks();
    statements.length = 0;
    const moduleRef = await Test.createTestingModule({ imports: [LabOrderRoutesHttpModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
    // Only what a request logs counts, not the boot's own lines.
    for (const spy of logged) spy.mockClear();
  });

  afterEach(async () => { await app.close(); });

  const get = (path: string, correlationId = 'lab-url-refusal-0001') => request(app.getHttpServer()).get(path)
    .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId).set('X-Purpose-Of-Use', 'direct-care')
    .set('X-Correlation-ID', correlationId);
  const nothingRan = () => {
    expect(guard.canActivate).not.toHaveBeenCalled();
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  };

  it('is wired by LabModule, for GET lab/order-routes alone', () => {
    expect(Reflect.getMetadata('imports', LabModule)).toContain(HealthIdInUrlRefusalModule);
  });

  it('knows the parameter in every form a query parser gives it, and no other key', () => {
    for (const query of [{ healthId }, { healthId: '' }, { healthId: [healthId, 'HID-XYZ789'] }, { 'healthId[]': healthId },
      { healthId: { a: healthId } }, { view: 'incoming', healthId }]) expect(carriesHealthId(query)).toBe(true);
    for (const query of [{}, { view: 'recent' }, { HealthId: healthId }, { healthIdLast4: '2345' }, null, undefined, 'healthId'])
      expect(carriesHealthId(query)).toBe(false);
  });

  it.each([
    `healthId=${healthId}`, `view=recent&healthId=${healthId.toLowerCase()}`, 'healthId=', 'healthId',
    `healthId=${healthId}&healthId=HID-XYZ789`, `healthId%5B%5D=${healthId}`, `%68ealthId=${healthId}`,
    `healthId=${healthId}&dateOfBirth=1990-01-01`, `view=all&healthId=${healthId}`,
  ])('answers ?%s 400 HEALTH_ID_NOT_ACCEPTED_IN_URL before the guard, audit, validation and database', async (query) => {
    const answer = await get(`/api/v1/lab/order-routes?${query}`);
    expect(answer.status).toBe(400);
    expect(answer.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(answer.headers['x-correlation-id']).toBe('lab-url-refusal-0001');
    expect(answer.body).toEqual({ type: 'https://healthidentitydirectory.com/problems/health-id-not-accepted-in-url',
      title: 'BAD_REQUEST', status: 400, detail: HEALTH_ID_NOT_ACCEPTED_IN_URL_DETAIL,
      instance: 'urn:hid:request:lab-url-refusal-0001', correlationId: 'lab-url-refusal-0001', code: HEALTH_ID_NOT_ACCEPTED_IN_URL });
    expect(HEALTH_ID_NOT_ACCEPTED_IN_URL_DETAIL).toContain('POST /api/v1/lab/order-routes/search');
    // The value is never repeated, in the body or a header.
    expect(`${answer.text}${JSON.stringify(answer.headers)}`).not.toMatch(/ABC234|XYZ789/i);
    nothingRan();
  });

  it('refuses it on HEAD, with a trailing slash and without credentials alike, still before anything runs', async () => {
    const head = await request(app.getHttpServer()).head(`/api/v1/lab/order-routes?healthId=${healthId}`)
      .set('Authorization', 'Bearer synthetic');
    expect(head.status).toBe(400);
    const slash = await get(`/api/v1/lab/order-routes/?healthId=${healthId}`);
    expect([slash.status, slash.body.code]).toEqual([400, HEALTH_ID_NOT_ACCEPTED_IN_URL]);
    const anonymous = await request(app.getHttpServer()).get(`/api/v1/lab/order-routes?healthId=${healthId}`);
    expect([anonymous.status, anonymous.body.code]).toEqual([400, HEALTH_ID_NOT_ACCEPTED_IN_URL]);
    expect(anonymous.body.correlationId).toEqual(anonymous.headers['x-correlation-id']);
    nothingRan();
  });

  it('leaves the GET without healthId as it was: Incoming or Recent, audited, other unknown keys refused by validation', async () => {
    const recent = await get('/api/v1/lab/order-routes?view=recent');
    expect([recent.status, recent.body]).toEqual([200, { items: [], crossFacilityOrders: true, crossFacilityWork: true }]);
    expect(statements).toEqual([{ sql: 'select * from lab.list_order_routes($1, $2)', values: ['recent', null] }]);
    expect(guard.canActivate).toHaveBeenCalledTimes(1);
    expect(audit.recordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({ action: 'lab.order-route.list',
      details: { view: 'recent', resultCount: 0, byHealthId: false } }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api.lab.order-route.list.request',
      outcome: 'success' }));
    const incoming = await get('/api/v1/lab/order-routes');
    expect(incoming.status).toBe(200);
    expect(statements[1]?.values).toEqual(['incoming', null]);
    for (const query of ['view=incoming&dateOfBirth=1990-01-01', `HealthId=${healthId}`, 'view=all']) {
      const invalid = await get(`/api/v1/lab/order-routes?${query}`);
      expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(statements).toHaveLength(2);
  });

  it('keeps POST lab/order-routes/search, the Health ID in the body', async () => {
    const found = await request(app.getHttpServer()).post('/api/v1/lab/order-routes/search')
      .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId).set('X-Purpose-Of-Use', 'direct-care')
      .send({ view: 'incoming', healthId: ` ${healthId.toLowerCase()} ` });
    expect([found.status, found.body.items]).toEqual([200, []]);
    expect(statements).toEqual([{ sql: 'select * from lab.list_order_routes($1, $2)', values: ['incoming', healthId] }]);
    expect(audit.recordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
      details: { view: 'incoming', resultCount: 0, byHealthId: true } }));
  });
});
