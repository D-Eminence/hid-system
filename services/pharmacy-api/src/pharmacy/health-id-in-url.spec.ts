import 'reflect-metadata';
import {
  type ExecutionContext, type INestApplication, Logger, type MiddlewareConsumer, Module, type NestModule, ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import { CorrelationMiddleware } from '../common/correlation.middleware';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import {
  carriesHealthId, HEALTH_ID_NOT_ACCEPTED_IN_URL, HEALTH_ID_NOT_ACCEPTED_IN_URL_DETAIL, HealthIdInUrlRefusalModule,
} from './health-id-in-url';
import { PharmacyOrderRoutesController } from './pharmacy-order-routes.controller';
import { PharmacyOrderRoutesService } from './pharmacy-order-routes.service';
import { PharmacyOrderRouteCards } from './order-route-cards';
import { PharmacyModule } from './pharmacy.module';

// GET pharmacy/order-routes refuses a Health ID in its URL (CODEX §26), over
// HTTP on loopback with the module wiring, correlation middleware, validation
// and problem filter as main.ts and AppModule set them; the guard, the
// database and the audit store are fakes that record every call.
const facilityId = '10000000-0000-4000-8000-000000000002';
const healthId = 'HID-ABC234';
const assignment = { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000002',
  organizationId: '30000000-0000-4000-8000-000000000002', name: 'Synthetic Pharmacy', roles: ['pharmacist'],
  permissions: ['pharmacy.order-route.receive'], isPrimary: true };
const actor: ActorContext = { id: 'staff:pharmacist', subject: 'staff:pharmacist',
  accountId: '20000000-0000-4000-8000-000000000002', roles: ['pharmacist'], permissions: ['pharmacy.order-route.receive'],
  facilityIds: [facilityId], facilities: [assignment], facility: assignment, authenticationMethod: 'local' };

const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
/** Item 4 (0089): what the database answers to whether this facility receives (no row by default). */
let receivingRows: unknown[] = [];
const RECEIVES = 'select pharmacy.order_route_receives_here() as receives, pharmacy.order_routes_here() as routes_here';
const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
  statements.push({ sql, values });
  return { rows: sql === RECEIVES ? receivingRows : [] };
}) };
/** A list's statements: the list, then the read of whether this facility receives in its savepoint (item 4). */
const listed = (values: readonly unknown[]) => [{ sql: 'select * from pharmacy.list_order_routes($1, $2)', values },
  { sql: 'savepoint pharmacy_order_route_receives', values: [] }, { sql: RECEIVES, values: [] },
  { sql: 'release savepoint pharmacy_order_route_receives', values: [] }];
const lists = () => statements.filter((statement) => statement.sql.includes('pharmacy.list_order_routes'));
const database = {
  withTransaction: jest.fn(async (_context: unknown, work: (c: typeof client) => Promise<unknown>) => work(client)),
  query: jest.fn(async () => ({ rows: [{ orders: true, work: true }] })),
};
const audit = { recordWithClient: jest.fn(async () => undefined) };
const guard = { canActivate: jest.fn((execution: ExecutionContext) => {
  const incoming = execution.switchToHttp().getRequest<HidRequest>();
  incoming.actor = actor;
  incoming.facilityId = facilityId;
  return true;
}) };

/** As AppModule: correlation on every path, the Pharmacy module's refusal imported below it. */
@Module({
  imports: [HealthIdInUrlRefusalModule],
  controllers: [PharmacyOrderRoutesController],
  providers: [PharmacyOrderRoutesService, PharmacyOrderRouteCards,
    { provide: DatabaseService, useValue: database },
    { provide: AuditService, useValue: audit },
    { provide: APP_GUARD, useFactory: () => guard }],
})
class PharmacyOrderRoutesHttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
  }
}

describe('a Health ID in the URL of GET pharmacy/order-routes (CODEX §26)', () => {
  let app: INestApplication;
  let base: string;
  const logged = (['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const)
    .map((level) => jest.spyOn(Logger.prototype, level));

  beforeEach(async () => {
    jest.clearAllMocks();
    statements.length = 0;
    receivingRows = [];
    const moduleRef = await Test.createTestingModule({ imports: [PharmacyOrderRoutesHttpModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    // Only what a request logs counts, not the boot's own lines.
    for (const spy of logged) spy.mockClear();
  });

  afterEach(async () => { await app.close(); });

  const send = async (method: 'GET' | 'HEAD' | 'POST', path: string, options: { body?: unknown; anonymous?: boolean } = {}) => {
    const headers: Record<string, string> = options.anonymous ? {} : { authorization: 'Bearer synthetic',
      'x-facility-id': facilityId, 'x-purpose-of-use': 'direct-care', 'x-correlation-id': 'pharmacy-url-refusal-0001' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${path}`, { method, headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) as Record<string, unknown> : undefined,
      headers: Object.fromEntries(response.headers.entries()) };
  };
  const nothingRan = () => {
    expect(guard.canActivate).not.toHaveBeenCalled();
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  };

  it('is wired by PharmacyModule, for GET pharmacy/order-routes alone', () => {
    expect(Reflect.getMetadata('imports', PharmacyModule)).toContain(HealthIdInUrlRefusalModule);
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
  ])('answers ?%s 400 HEALTH_ID_NOT_ACCEPTED_IN_URL before the guard, validation, database and audit', async (query) => {
    const answer = await send('GET', `/api/v1/pharmacy/order-routes?${query}`);
    expect(answer.status).toBe(400);
    expect(answer.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(answer.headers['x-correlation-id']).toBe('pharmacy-url-refusal-0001');
    expect(answer.body).toEqual({ type: 'https://healthidentitydirectory.com/problems/health-id-not-accepted-in-url',
      title: 'BAD_REQUEST', status: 400, detail: HEALTH_ID_NOT_ACCEPTED_IN_URL_DETAIL,
      instance: 'urn:hid:request:pharmacy-url-refusal-0001', correlationId: 'pharmacy-url-refusal-0001',
      code: HEALTH_ID_NOT_ACCEPTED_IN_URL });
    expect(HEALTH_ID_NOT_ACCEPTED_IN_URL_DETAIL).toContain('POST /api/v1/pharmacy/order-routes/search');
    // The value is never repeated, in the body or a header.
    expect(`${answer.text}${JSON.stringify(answer.headers)}`).not.toMatch(/ABC234|XYZ789/i);
    nothingRan();
  });

  it('refuses it on HEAD, with a trailing slash and without credentials alike, still before anything runs', async () => {
    const head = await send('HEAD', `/api/v1/pharmacy/order-routes?healthId=${healthId}`);
    expect([head.status, head.text]).toEqual([400, '']);
    const slash = await send('GET', `/api/v1/pharmacy/order-routes/?healthId=${healthId}`);
    expect([slash.status, slash.body?.code]).toEqual([400, HEALTH_ID_NOT_ACCEPTED_IN_URL]);
    const anonymous = await send('GET', `/api/v1/pharmacy/order-routes?healthId=${healthId}`, { anonymous: true });
    expect([anonymous.status, anonymous.body?.code]).toEqual([400, HEALTH_ID_NOT_ACCEPTED_IN_URL]);
    expect(anonymous.body?.correlationId).toEqual(anonymous.headers['x-correlation-id']);
    nothingRan();
  });

  it('leaves the GET without healthId as it was: Incoming or Recent, audited, other unknown keys refused by validation', async () => {
    const recent = await send('GET', '/api/v1/pharmacy/order-routes?view=recent');
    expect([recent.status, recent.body]).toEqual([200, { items: [], crossFacilityOrders: true, crossFacilityWork: true }]);
    expect(statements).toEqual(listed(['recent', null]));
    expect(guard.canActivate).toHaveBeenCalledTimes(1);
    expect(audit.recordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({ facilityId }),
      'pharmacy.order-route.list', { resourceType: 'order-route-collection', resourceId: facilityId },
      { view: 'recent', resultCount: 0, byHealthId: false });
    const incoming = await send('GET', '/api/v1/pharmacy/order-routes');
    expect(incoming.status).toBe(200);
    expect(lists()[1]?.values).toEqual(['incoming', null]);
    for (const query of ['view=incoming&dateOfBirth=1990-01-01', `HealthId=${healthId}`, 'view=all']) {
      const invalid = await send('GET', `/api/v1/pharmacy/order-routes?${query}`);
      expect([invalid.status, invalid.body?.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(lists()).toHaveLength(2);
    expect(statements).toHaveLength(8);
  });

  it('keeps POST pharmacy/order-routes/search, the Health ID in the body', async () => {
    const found = await send('POST', '/api/v1/pharmacy/order-routes/search',
      { body: { view: 'incoming', healthId: ` ${healthId.toLowerCase()} ` } });
    expect([found.status, found.body?.items]).toEqual([200, []]);
    expect(statements).toEqual(listed(['incoming', healthId]));
    expect(audit.recordWithClient).toHaveBeenCalledWith(client, expect.anything(), 'pharmacy.order-route.list',
      expect.anything(), { view: 'incoming', resultCount: 0, byHealthId: true });
  });

  it('answers whether this facility receives and holds orders beside the list (item 4, 0089), the URL rule unchanged', async () => {
    receivingRows = [{ receives: false, routes_here: { held: false, waiting: true } }];
    const incoming = await send('GET', '/api/v1/pharmacy/order-routes');
    expect([incoming.status, incoming.body]).toEqual([200, { items: [], receives: false,
      routesHere: { waiting: true, held: false }, crossFacilityOrders: true, crossFacilityWork: true }]);
    const found = await send('POST', '/api/v1/pharmacy/order-routes/search', { body: { healthId } });
    expect([found.status, found.body?.receives, found.body?.routesHere]).toEqual([200, false, { waiting: true, held: false }]);
    expect(statements).toEqual([...listed(['incoming', null]), ...listed(['incoming', healthId])]);
    const refused = await send('GET', `/api/v1/pharmacy/order-routes?healthId=${healthId}`);
    expect([refused.status, refused.body?.code, refused.body?.receives]).toEqual([400, HEALTH_ID_NOT_ACCEPTED_IN_URL, undefined]);
    expect(statements).toHaveLength(8);
  });
});
