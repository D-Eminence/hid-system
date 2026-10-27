import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ExecutionContext, type INestApplication, Logger, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTION, REQUIRED_PERMISSIONS } from '../common/decorators';
import { requestDigest } from '../common/idempotency';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, DataAccessContext, HidRequest } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { CannotCompleteOrderRouteDto, LAB_CANNOT_COMPLETE_REASONS } from './dto/order-route.dto';
import { cannotCompleteAnswer, cannotCompleteProblem, labOrderRouteProblem } from './lab-order-route.mapping';
import { LabOrderRoutesController } from './lab-order-routes.controller';
import { LabOrderRoutesService } from './lab-order-routes.service';
import { LabOrderRouteCards } from './order-route-cards';

// D18 (SPEC-FINAL §5.1, §8.1, §10.2): "We can't complete this order". The
// laboratory ends an order it accepted and can't complete (C31) with one
// fixed reason, the statement that the person was the order's patient and,
// when a possibly critical value is recorded, that the clinic was told.
const facilityId = '10000000-0000-4000-8000-000000000001';
const patientId = '50000000-0000-4000-8000-000000000001';
const routeId = 'b0000000-0000-4000-8000-000000000001';
const endingId = 'e0000000-0000-4000-8000-000000000001';
const key = 'cannot-complete-key-0001';
const context = { correlationId: 'lab-cannot-complete-correlation', facilityId,
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care',
  actor: { id: 'actor', subject: 'staff:lab', accountId: '20000000-0000-4000-8000-000000000001', roles: ['lab'],
    permissions: ['lab.order-route.receive'], facilityIds: [facilityId], facilities: [], authenticationMethod: 'local' },
} satisfies DataAccessContext;
const databaseError = (code: string, message: string, detail?: string) =>
  Object.assign(new Error(message), { code, ...(detail === undefined ? {} : { detail }) });

/** The reasons of the shared fixture 0091's suite reads (the JSON between the quotes of its \set line). */
function fixtureReasons(): { lab_request: string[]; prescription: string[] } {
  const fixture = readFileSync(join(__dirname, '../../../ehr-api/test/fixtures/order-route-cannot-complete-reasons.sql'), 'utf8');
  const json = /^\\set cannot_complete_reasons '(.+)'$/m.exec(fixture)?.[1];
  if (!json) throw new Error('The shared reasons fixture has no \\set cannot_complete_reasons line');
  return JSON.parse(json) as { lab_request: string[]; prescription: string[] };
}

/** C31's row (bigints as text, timestamps as Dates, as node-postgres gives them): an ending with an accession. */
const ended = { result: 'ended', ending_id: endingId, route_row_version: '5', route_state: 'cancelled',
  effective_state: 'cancelled', ended_kind: 'receiving_unable', reason_code: 'supplies_unavailable',
  access_ends_at: new Date('2026-11-03T10:15:00.123Z'), specimens_collected: 1, results_recorded: 1, critical_candidates: 1,
  patient_id: patientId };

const input = (overrides: Partial<CannotCompleteOrderRouteDto> = {}): CannotCompleteOrderRouteDto =>
  ({ expectedVersion: 4, reason: 'supplies_unavailable', confirmedPatient: true, criticalValueTold: true, ...overrides });

function harness(answer: unknown[] | Error = [ended]) {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
    statements.push({ sql, values });
    if (answer instanceof Error) throw answer;
    return { rows: answer };
  }) };
  const options: unknown[] = [];
  const database = {
    withTransaction: jest.fn(async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>, option?: unknown) => {
      options.push(option);
      return fn(client as unknown as PoolClient);
    }),
    query: jest.fn(async () => ({ rows: [{ orders: true, work: true }] })),
  } as unknown as DatabaseService & { withTransaction: jest.Mock };
  const audits: Array<Record<string, unknown>> = [];
  const audit = { recordWithClient: jest.fn(async (_c: unknown, event: Record<string, unknown>) => { audits.push(event); }) };
  const service = new LabOrderRoutesService(database, audit as unknown as AuditService, new LabOrderRouteCards(database));
  return { service, statements, audits, audit, database, options };
}

describe('"We can\'t complete this order": the body and the route (C31)', () => {
  const errors = async (body: unknown) =>
    (await validate(plainToInstance(CannotCompleteOrderRouteDto, body),
      { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true })).map((error) => error.property).sort();
  const body = { expectedVersion: 1, reason: 'other', confirmedPatient: true };

  it('holds exactly the laboratory\'s nine reasons of the shared fixture (D18-5), in its order', () => {
    const reasons = fixtureReasons();
    expect([...LAB_CANNOT_COMPLETE_REASONS]).toEqual(reasons.lab_request);
    expect(LAB_CANNOT_COMPLETE_REASONS).toHaveLength(9);
    // The fixture's other list is the pharmacy's: its own codes are not the laboratory's.
    expect(reasons.prescription.filter((reason) => !(LAB_CANNOT_COMPLETE_REASONS as readonly string[]).includes(reason)))
      .toEqual(['out_of_stock', 'medicine_unavailable', 'needs_prescriber_review', 'controlled_requirements']);
  });

  it('takes every laboratory reason, and refuses a pharmacy\'s, a decline\'s or a made-up one', async () => {
    for (const reason of fixtureReasons().lab_request) expect(await errors({ ...body, reason })).toEqual([]);
    for (const reason of ['out_of_stock', 'medicine_unavailable', 'needs_prescriber_review', 'controlled_requirements',
      'patient_not_seen', 'wrong_order_chosen', 'identity_not_confirmed', 'Reagents ran out', '', 7, null]) {
      expect(await errors({ ...body, reason })).toEqual(['reason']);
    }
  });

  it('requires confirmedPatient to be true: missing, false, "true" or 1 are refused', async () => {
    const { confirmedPatient: _confirmed, ...without } = body;
    expect(await errors(without)).toEqual(['confirmedPatient']);
    for (const confirmedPatient of [false, 'true', 1, null]) {
      expect(await errors({ ...body, confirmedPatient })).toEqual(['confirmedPatient']);
    }
  });

  it('takes criticalValueTold as an optional boolean, nothing else', async () => {
    for (const criticalValueTold of [true, false, undefined, null]) {
      expect(await errors({ ...body, criticalValueTold })).toEqual([]);
    }
    for (const criticalValueTold of ['true', 1, 'yes']) {
      expect(await errors({ ...body, criticalValueTold })).toEqual(['criticalValueTold']);
    }
  });

  it('requires an integer version of at least 1 and refuses every other field (no free text, D18-6)', async () => {
    for (const expectedVersion of [0, -1, 1.5, '4', null]) expect(await errors({ ...body, expectedVersion })).toEqual(['expectedVersion']);
    const { expectedVersion: _version, ...without } = body;
    expect(await errors(without)).toEqual(['expectedVersion']);
    for (const extra of ['note', 'patientId', 'reasonText', 'readUntil']) {
      expect(await errors({ ...body, [extra]: 'x' })).toEqual([extra]);
    }
  });

  it('needs lab.order-route.receive, is audited as a request, answers 200, and requires an Idempotency-Key', () => {
    const prototype = LabOrderRoutesController.prototype;
    expect([Reflect.getMetadata(REQUIRED_PERMISSIONS, prototype.cannotComplete),
      Reflect.getMetadata(AUDIT_ACTION, prototype.cannotComplete)])
      .toEqual([['lab.order-route.receive'], 'lab.order-route.cannot-complete.request']);
    const service = { cannotComplete: jest.fn() };
    const controller = new LabOrderRoutesController(service as never);
    for (const missing of [undefined, '', 'short', 'has spaces in the key 0001']) {
      expect(() => controller.cannotComplete(routeId, input(), missing, {} as never))
        .toThrow(expect.objectContaining({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    }
    expect(service.cannotComplete).not.toHaveBeenCalled();
  });
});

describe('LabOrderRoutesService.cannotComplete (C31)', () => {
  it('calls the six-argument command once, READ COMMITTED, with the tick as true or false and a stable digest', async () => {
    const h = harness();
    await h.service.cannotComplete(context, routeId, input(), key);
    const digest = requestDigest('lab.order-route.cannot-complete', { routeId, expectedVersion: 4,
      reason: 'supplies_unavailable', criticalValueTold: true });
    expect(h.statements).toEqual([{ sql: 'select * from lab.cannot_complete_order_route($1, $2, $3, $4, $5, $6)',
      values: [routeId, 4, 'supplies_unavailable', true, key, digest] }]);
    expect(h.options).toEqual([{ isolationLevel: 'READ COMMITTED' }]);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // Unticked, absent or null: sent as false, and digested as false (the same request).
    for (const criticalValueTold of [false, undefined, null]) {
      const unticked = harness();
      await unticked.service.cannotComplete(context, routeId, input({ criticalValueTold: criticalValueTold as boolean }), key);
      expect(unticked.statements[0]?.values).toEqual([routeId, 4, 'supplies_unavailable', false, key,
        requestDigest('lab.order-route.cannot-complete', { routeId, expectedVersion: 4, reason: 'supplies_unavailable',
          criticalValueTold: false })]);
    }
  });

  it('digests the route, version, reason and tick, whatever the key order; another request digests otherwise', () => {
    const digest = requestDigest('lab.order-route.cannot-complete', { routeId, expectedVersion: 4,
      reason: 'supplies_unavailable', criticalValueTold: true });
    expect(requestDigest('lab.order-route.cannot-complete', { criticalValueTold: true, reason: 'supplies_unavailable',
      expectedVersion: 4, routeId })).toBe(digest);
    for (const other of [{ criticalValueTold: false }, { reason: 'other' }, { expectedVersion: 5 },
      { routeId: 'b0000000-0000-4000-8000-000000000002' }]) {
      expect(requestDigest('lab.order-route.cannot-complete', { routeId, expectedVersion: 4, reason: 'supplies_unavailable',
        criticalValueTold: true, ...other })).not.toBe(digest);
    }
    // Never the pharmacy's, item 3's or D17's digest of the same values.
    for (const operation of ['pharmacy.order-route.cannot-complete', 'lab.order-route.wrong-patient',
      'lab.order-route.wrong-patient-correction']) {
      expect(requestDigest(operation, { routeId, expectedVersion: 4, reason: 'supplies_unavailable', criticalValueTold: true }))
        .not.toBe(digest);
    }
  });

  it('answers the ended route, the reason, readUntil and the counts as numbers; never the patient or the ending id', async () => {
    const h = harness();
    const answer = await h.service.cannotComplete(context, routeId, input(), key);
    expect(answer).toEqual({ route: { id: routeId, version: 5, effectiveState: 'cancelled', endedKind: 'receiving_unable' },
      reason: 'supplies_unavailable', readUntil: '2026-11-03T10:15:00.123Z', specimensCollected: 1, resultsRecorded: 1,
      criticalCandidates: 1, replayed: false });
    expect(typeof answer.route.version).toBe('number');
    expect(JSON.stringify(answer)).not.toMatch(new RegExp(`${patientId}|${endingId}`));
  });

  it('answers an ending with nothing recorded with readUntil at the ending\'s moment and zero counts', async () => {
    const h = harness([{ ...ended, reason_code: 'test_not_offered', access_ends_at: '2026-10-27T10:15:00.5+00:00',
      specimens_collected: 0, results_recorded: 0, critical_candidates: 0, route_row_version: 3 }]);
    await expect(h.service.cannotComplete(context, routeId, input({ reason: 'test_not_offered', expectedVersion: 2,
      criticalValueTold: undefined }), key)).resolves.toEqual({ route: { id: routeId, version: 3, effectiveState: 'cancelled',
      endedKind: 'receiving_unable' }, reason: 'test_not_offered', readUntil: '2026-10-27T10:15:00.500Z', specimensCollected: 0,
    resultsRecorded: 0, criticalCandidates: 0, replayed: false });
  });

  it('writes the laboratory\'s own row with the patient from the command, the reason, counts and statements', async () => {
    const h = harness();
    await h.service.cannotComplete(context, routeId, input(), key);
    expect(h.audits).toEqual([{ correlationId: context.correlationId, actorType: 'staff', actorSubject: 'staff:lab',
      actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId, organizationId: undefined, facilityId,
      patientId, action: 'lab.order-route.cannot-complete', resourceType: 'order-route', resourceId: routeId,
      outcome: 'success', purposeOfUse: 'direct-care', sourceSystem: 'lab-api', details: { routeId, kind: 'lab_request',
        endingId, state: 'cancelled', reasonCode: 'supplies_unavailable', specimensCollected: 1, resultsRecorded: 1,
        criticalCandidates: 1, criticalValueTold: true, confirmedPatient: true, replayed: false } }]);
  });

  it('answers a replay with replayed true, the route as it is now and the first ending\'s reason and counts', async () => {
    const h = harness([{ ...ended, result: 'replayed', route_row_version: '7', ended_kind: 'receiving_unable' }]);
    const answer = await h.service.cannotComplete(context, routeId, input(), key);
    expect(answer).toMatchObject({ route: { version: 7, endedKind: 'receiving_unable' }, reason: 'supplies_unavailable',
      replayed: true, criticalCandidates: 1 });
    expect(h.audits[0]).toMatchObject({ details: expect.objectContaining({ replayed: true }) });
  });

  it.each([
    [{ result: 'ended' }], [{ ...ended, result: 'corrected' }], [{ ...ended, patient_id: null }],
    [{ ...ended, route_row_version: null }], [{ ...ended, ended_kind: null }], [{ ...ended, reason_code: null }],
    [{ ...ended, effective_state: null }],
  ])('answers 503 and writes nothing for a row it cannot read (%o)', async (row) => {
    const h = harness([row]);
    await expect(h.service.cannotComplete(context, routeId, input(), key))
      .rejects.toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
    expect(h.audits).toEqual([]);
  });

  it('answers 503 when the command returns no row, and fails the ending when its audit row fails', async () => {
    await expect(harness([]).service.cannotComplete(context, routeId, input(), key))
      .rejects.toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
    const h = harness();
    h.audit.recordWithClient.mockRejectedValueOnce(databaseError('23514', 'audit refused'));
    await expect(h.service.cannotComplete(context, routeId, input(), key))
      .rejects.toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
  });

  it.each([
    ['25000', 'ORDER_ROUTE_CANNOT_COMPLETE_READ_COMMITTED_REQUIRED', 503, 'ORDER_ROUTE_UNAVAILABLE'],
    ['42501', 'Order route staff context is required', 403, 'PERMISSION_DENIED'],
    ['22023', 'ORDER_ROUTE_INVALID', 400, 'ORDER_ROUTE_INVALID'],
    ['55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE'],
    ['P0001', 'IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['P0002', 'ORDER_ROUTE_NOT_FOUND', 404, 'ORDER_ROUTE_NOT_FOUND'],
    ['P0001', 'ORDER_ROUTE_NOT_ACCEPTED', 409, 'ORDER_ROUTE_NOT_ACCEPTED'],
    ['P0001', 'ORDER_ROUTE_ALREADY_ENDED', 409, 'ORDER_ROUTE_ALREADY_ENDED'],
    ['P0001', 'ORDER_ROUTE_ALREADY_RETURNED', 409, 'ORDER_ROUTE_ALREADY_RETURNED'],
    ['P0001', 'ORDER_ROUTE_RESULT_READY', 409, 'ORDER_ROUTE_RESULT_READY'],
    ['P0001', 'ORDER_ROUTE_VERSION_CONFLICT', 412, 'VERSION_CONFLICT'],
    ['P0001', 'ORDER_ROUTE_CRITICAL_VALUE_NOT_TOLD', 409, 'ORDER_ROUTE_CRITICAL_VALUE_NOT_TOLD'],
    ['40001', 'could not serialize access due to concurrent update', 409, 'ORDER_ROUTE_CHANGED_CONCURRENTLY'],
    ['40P01', 'deadlock detected', 409, 'ORDER_ROUTE_CHANGED_CONCURRENTLY'],
    ['23514', 'ORDER_ROUTE_UNABLE_ENDING_IMMUTABLE', 503, 'ORDER_ROUTE_UNAVAILABLE'],
    ['23505', 'duplicate key value violates unique constraint', 503, 'ORDER_ROUTE_UNAVAILABLE'],
    ['42883', 'function lab.cannot_complete_order_route(uuid, integer, unknown, boolean, unknown, unknown) does not exist',
      503, 'ORDER_ROUTE_UNAVAILABLE'],
    ['P0001', 'SOMETHING_ELSE', 503, 'ORDER_ROUTE_UNAVAILABLE'],
  ])('answers %s %s as %i %s, writing no audit row', async (state, message, status, code) => {
    const h = harness(databaseError(state, message));
    await expect(h.service.cannotComplete(context, routeId, input(), key)).rejects.toMatchObject({ status, code });
    expect(h.audits).toEqual([]);
  });

  it('answers the limit 429 with retryAfter, the DETAIL kept only when it is an exact UTC time', async () => {
    const limited = await harness(databaseError('P0001', 'ORDER_ROUTE_CANNOT_COMPLETE_LIMIT', '2026-10-28T09:14:03.219Z'))
      .service.cannotComplete(context, routeId, input(), key).catch((e: unknown) => e) as DomainProblem;
    expect(limited).toMatchObject({ status: 429, code: 'ORDER_ROUTE_CANNOT_COMPLETE_LIMIT',
      extensions: { retryAfter: '2026-10-28T09:14:03.219Z' } });
    expect(limited.message).toContain('2026-10-28T09:14:03.219Z');
    expect(limited.message).toMatch(/cancel this order, or Health ID support to close it/);
    for (const detail of [undefined, 'soon', '2026-10-28 09:14:03', '2026-02-30T09:14:03.219Z', '2026-10-28T09:14:03Z']) {
      const problem = cannotCompleteProblem(databaseError('P0001', 'ORDER_ROUTE_CANNOT_COMPLETE_LIMIT', detail)) as DomainProblem;
      expect([problem.getStatus(), problem.code, problem.extensions]).toEqual([429, 'ORDER_ROUTE_CANNOT_COMPLETE_LIMIT', undefined]);
    }
  });

  it('maps 40001 and 40P01 to 409 for this command only; the other route commands answer them 503', () => {
    expect(cannotCompleteProblem(databaseError('40001', 'x'))).toMatchObject({ status: 409, code: 'ORDER_ROUTE_CHANGED_CONCURRENTLY' });
    expect(labOrderRouteProblem(databaseError('40001', 'x'))).toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
    expect(cannotCompleteAnswer(routeId, { ...ended, specimens_collected: null, access_ends_at: null }))
      .toMatchObject({ specimensCollected: 0, readUntil: null });
  });
});

// Over HTTP: the module's controller and service, the validation pipe, the
// interceptor and the problem filter as main.ts and AppModule set them; a
// guard that binds the session as the real one does (and checks the route's
// permissions), a fake database and audit store recording every call.
describe('"We can\'t complete this order" over HTTP', () => {
  const actor = (permissions: string[]): ActorContext => ({ kind: 'staff', id: 'staff:lab', subject: 'staff:lab',
    accountId: '20000000-0000-4000-8000-000000000001', roles: ['lab'], permissions, facilityIds: [facilityId],
    authenticationMethod: 'local', facilities: [{ id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
      organizationId: '30000000-0000-4000-8000-000000000001', name: 'Synthetic Laboratory', roles: ['lab'], permissions,
      isPrimary: true }] });
  let permissions = ['lab.order-route.receive'];
  let answer: unknown[] | Error = [ended];
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
    statements.push({ sql, values });
    if (answer instanceof Error) throw answer;
    return { rows: answer };
  }) };
  const database = {
    withTransaction: jest.fn(async (_context: unknown, work: (c: typeof client) => Promise<unknown>) => work(client)),
    query: jest.fn(async () => ({ rows: [{ orders: true, work: true }] })),
  };
  const audit = { record: jest.fn(async (_event: unknown) => undefined),
    recordWithClient: jest.fn(async (_client: unknown, _event: unknown) => undefined) };
  const guard = { canActivate: jest.fn((execution: ExecutionContext) => {
    const incoming = execution.switchToHttp().getRequest<HidRequest>();
    const session = actor(permissions);
    incoming.actor = { ...session, facility: session.facilities[0], permissions };
    incoming.facilityId = facilityId;
    const required = new Reflector().getAllAndOverride<string[]>(REQUIRED_PERMISSIONS,
      [execution.getHandler(), execution.getClass()]) ?? [];
    if (required.some((permission) => !permissions.includes(permission))) {
      throw new DomainProblem(403, 'PERMISSION_DENIED', 'Required permission is missing');
    }
    return true;
  }) };

  @Module({
    controllers: [LabOrderRoutesController],
    providers: [LabOrderRoutesService, LabOrderRouteCards,
      { provide: DatabaseService, useValue: database },
      { provide: AuditService, useValue: audit },
      { provide: APP_GUARD, useFactory: () => guard },
      { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
  })
  class CannotCompleteHttpModule {}

  let app: INestApplication;
  const logged = (['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const)
    .map((level) => jest.spyOn(Logger.prototype, level));

  beforeEach(async () => {
    jest.clearAllMocks();
    statements.length = 0;
    permissions = ['lab.order-route.receive'];
    answer = [ended];
    const moduleRef = await Test.createTestingModule({ imports: [CannotCompleteHttpModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use((incoming: HidRequest, _response: unknown, next: () => void) => { incoming.correlationId = 'lab-unable-http-0001'; next(); });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
    for (const spy of logged) spy.mockClear();
  });

  afterEach(async () => { await app.close(); });

  const body = { expectedVersion: 4, reason: 'supplies_unavailable', confirmedPatient: true, criticalValueTold: true };
  const post = (payload: unknown, idempotencyKey: string | null = key, id = routeId) => {
    const call = request(app.getHttpServer()).post(`/api/v1/lab/order-routes/${id}/cannot-complete`)
      .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId).set('X-Purpose-Of-Use', 'direct-care');
    return (idempotencyKey ? call.set('Idempotency-Key', idempotencyKey) : call).send(payload as object);
  };

  it('answers 200 with the ended route; the request row carries no body, the command row the patient', async () => {
    const response = await post(body);
    expect([response.status, response.body]).toEqual([200, { route: { id: routeId, version: 5, effectiveState: 'cancelled',
      endedKind: 'receiving_unable' }, reason: 'supplies_unavailable', readUntil: '2026-11-03T10:15:00.123Z',
    specimensCollected: 1, resultsRecorded: 1, criticalCandidates: 1, replayed: false }]);
    expect(statements[0]?.values.slice(0, 5)).toEqual([routeId, 4, 'supplies_unavailable', true, key]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'api.lab.order-route.cannot-complete.request', outcome: 'success', resourceType: 'http-request' }));
    expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(/supplies_unavailable|confirmedPatient/);
    expect(audit.recordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
      action: 'lab.order-route.cannot-complete', patientId }));
    expect(response.text).not.toMatch(new RegExp(`${patientId}|${endingId}`));
  });

  it('sends an unticked or absent criticalValueTold as false', async () => {
    const { criticalValueTold: _told, ...unticked } = body;
    expect((await post(unticked)).status).toBe(200);
    expect((await post({ ...body, criticalValueTold: false })).status).toBe(200);
    expect(statements.map((statement) => statement.values[3])).toEqual([false, false]);
  });

  it('refuses a missing key, a bad body and an unknown field with 400 before the database', async () => {
    const missing = await post(body, null);
    expect([missing.status, missing.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    const { confirmedPatient: _confirmed, ...unconfirmed } = body;
    for (const invalid of [unconfirmed, { ...body, confirmedPatient: false }, { ...body, reason: 'out_of_stock' },
      { ...body, reason: 'busy' }, { ...body, expectedVersion: 0 }, { ...body, criticalValueTold: 'yes' },
      { ...body, note: 'The analyser is down until Friday' }, { ...body, patientId }]) {
      const refused = await post(invalid);
      expect([refused.status, refused.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(statements).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'api.lab.order-route.cannot-complete.request', outcome: 'failure' }));
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('refuses a route id that is not a version-4 UUID 400, and a member without lab.order-route.receive 403', async () => {
    const notAnId = await post(body, key, 'correctable');
    expect(notAnId.status).toBe(400);
    permissions = ['lab.work-item.read', 'lab.result.entered-in-error'];
    const denied = await post(body);
    expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect(statements).toEqual([]);
  });

  it('answers the limit 429 with retryAfter as a problem member', async () => {
    answer = databaseError('P0001', 'ORDER_ROUTE_CANNOT_COMPLETE_LIMIT', '2026-10-28T09:14:03.219Z');
    const limited = await post(body);
    expect([limited.status, limited.body.code, limited.body.retryAfter]).toEqual([429, 'ORDER_ROUTE_CANNOT_COMPLETE_LIMIT',
      '2026-10-28T09:14:03.219Z']);
    expect(limited.body).not.toHaveProperty('extensions');
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it.each([
    ['P0001', 'ORDER_ROUTE_ALREADY_RETURNED', 409], ['P0001', 'ORDER_ROUTE_RESULT_READY', 409],
    ['P0001', 'ORDER_ROUTE_CRITICAL_VALUE_NOT_TOLD', 409], ['P0001', 'ORDER_ROUTE_ALREADY_ENDED', 409],
    ['P0001', 'ORDER_ROUTE_NOT_ACCEPTED', 409], ['P0001', 'IDEMPOTENCY_KEY_REUSED', 409],
    ['P0001', 'ORDER_ROUTE_VERSION_CONFLICT', 412], ['P0002', 'ORDER_ROUTE_NOT_FOUND', 404],
    ['55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled', 423], ['42501', 'denied', 403],
    ['40P01', 'deadlock detected', 409], ['25000', 'ORDER_ROUTE_CANNOT_COMPLETE_READ_COMMITTED_REQUIRED', 503],
    ['23514', 'new row for relation violates check constraint', 503],
  ])('answers %s %s with %i, never the database\'s text', async (state, message, status) => {
    answer = databaseError(state, message);
    const refused = await post(body);
    expect(refused.status).toBe(status);
    if (status < 500) expect(refused.text).not.toMatch(/P0001|P0002|deadlock|check constraint/);
    else expect(refused.body).toMatchObject({ code: 'ORDER_ROUTE_UNAVAILABLE', detail: 'The service could not complete the request.' });
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });
});
