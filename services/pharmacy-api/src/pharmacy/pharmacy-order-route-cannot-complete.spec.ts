import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ExecutionContext, type INestApplication, Logger, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { REQUIRED_PERMISSIONS } from '../common/decorators';
import { requestDigest } from '../common/idempotency';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, DataAccessContext, HidRequest } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { CannotCompleteOrderRouteDto, PHARMACY_CANNOT_COMPLETE_REASONS } from './dto/order-route.dto';
import { cannotCompleteAnswer, cannotCompleteProblem, pharmacyOrderRouteProblem } from './pharmacy-order-route.mapping';
import { PharmacyOrderRoutesController } from './pharmacy-order-routes.controller';
import { PharmacyOrderRoutesService } from './pharmacy-order-routes.service';
import { PharmacyOrderRouteCards } from './order-route-cards';

// D18 (SPEC-FINAL §5.1, §8.2, §10.2): "We can't complete this order". The
// pharmacy ends a prescription it accepted and can't complete (C31) with one
// fixed reason and the statement that the person was the prescription's
// patient or collecting for them. Five arguments: no critical value.
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const routeId = '123e4567-e89b-42d3-a456-426614174010';
const endingId = '123e4567-e89b-42d3-a456-426614174011';
const key = 'pharmacy-cannot-complete-0001';
const context = { correlationId: 'correlation-123456', facilityId, membershipId: '123e4567-e89b-42d3-a456-426614174004',
  purposeOfUse: 'direct-care', actor: { id: 'a', subject: 'staff:pharmacist', accountId: '123e4567-e89b-42d3-a456-426614174003',
    authenticationMethod: 'local', roles: ['pharmacist'], permissions: ['pharmacy.order-route.receive'], facilityIds: [facilityId],
    facilities: [] } } satisfies DataAccessContext;
const databaseError = (code: string, message: string, detail?: string) =>
  Object.assign(new Error(message), { code, ...(detail === undefined ? {} : { detail }) });

/** The reasons of the shared fixture 0091's suite reads (the JSON between the quotes of its \set line). */
function fixtureReasons(): { lab_request: string[]; prescription: string[] } {
  const fixture = readFileSync(join(__dirname, '../../../ehr-api/test/fixtures/order-route-cannot-complete-reasons.sql'), 'utf8');
  const json = /^\\set cannot_complete_reasons '(.+)'$/m.exec(fixture)?.[1];
  if (!json) throw new Error('The shared reasons fixture has no \\set cannot_complete_reasons line');
  return JSON.parse(json) as { lab_request: string[]; prescription: string[] };
}

/** C31's row for a prescription (bigints as text, timestamps as Dates): reads end at the ending's moment. */
const ended = { result: 'ended', ending_id: endingId, route_row_version: '4', route_state: 'cancelled',
  effective_state: 'cancelled', ended_kind: 'receiving_unable', reason_code: 'out_of_stock',
  access_ends_at: new Date('2026-10-27T10:15:00.250Z'), specimens_collected: 0, results_recorded: 0, critical_candidates: 0,
  patient_id: patientId };

const input = (overrides: Partial<CannotCompleteOrderRouteDto> = {}): CannotCompleteOrderRouteDto =>
  ({ expectedVersion: 3, reason: 'out_of_stock', confirmedPatient: true, ...overrides });

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
      options.push(option); return fn(client as unknown as PoolClient);
    }),
    query: jest.fn(async () => ({ rows: [{ orders: true, work: true }] })),
  };
  const audits: Array<[string, Record<string, unknown>, Record<string, unknown>, string | undefined]> = [];
  const audit = { recordWithClient: jest.fn(async (_c: unknown, _ctx: unknown, action: string, resource: Record<string, unknown>,
    details: Record<string, unknown> = {}, outcome?: string) => { audits.push([action, resource, details, outcome]); }) };
  const service = new PharmacyOrderRoutesService(database as never, audit as never, new PharmacyOrderRouteCards(database as never));
  return { service, statements, audits, audit, options };
}

describe('"We can\'t complete this order" at the pharmacy: the body and the route (C31)', () => {
  const errors = async (body: unknown) =>
    (await validate(plainToInstance(CannotCompleteOrderRouteDto, body),
      { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true })).map((error) => error.property).sort();
  const body = { expectedVersion: 1, reason: 'other', confirmedPatient: true };

  it('holds exactly the pharmacy\'s eight reasons of the shared fixture (D18-5), in its order', () => {
    const reasons = fixtureReasons();
    expect([...PHARMACY_CANNOT_COMPLETE_REASONS]).toEqual(reasons.prescription);
    expect(PHARMACY_CANNOT_COMPLETE_REASONS).toHaveLength(8);
    expect(reasons.lab_request.filter((reason) => !(PHARMACY_CANNOT_COMPLETE_REASONS as readonly string[]).includes(reason)))
      .toEqual(['test_not_offered', 'supplies_unavailable', 'equipment_unavailable', 'sample_unusable', 'sample_not_obtained']);
  });

  it('takes every pharmacy reason, and refuses a laboratory\'s, a decline\'s or a made-up one', async () => {
    for (const reason of fixtureReasons().prescription) expect(await errors({ ...body, reason })).toEqual([]);
    for (const reason of ['test_not_offered', 'supplies_unavailable', 'equipment_unavailable', 'sample_unusable',
      'sample_not_obtained', 'patient_not_seen', 'identity_not_confirmed', 'Out of stock', '', 7, null]) {
      expect(await errors({ ...body, reason })).toEqual(['reason']);
    }
  });

  it('requires confirmedPatient to be true, and refuses criticalValueTold as an unknown field', async () => {
    const { confirmedPatient: _confirmed, ...without } = body;
    expect(await errors(without)).toEqual(['confirmedPatient']);
    for (const confirmedPatient of [false, 'true', 1, null]) {
      expect(await errors({ ...body, confirmedPatient })).toEqual(['confirmedPatient']);
    }
    for (const criticalValueTold of [true, false]) {
      expect(await errors({ ...body, criticalValueTold })).toEqual(['criticalValueTold']);
    }
    for (const extra of ['note', 'quantity', 'patientId']) expect(await errors({ ...body, [extra]: 'x' })).toEqual([extra]);
    for (const expectedVersion of [0, '3', 2.5]) expect(await errors({ ...body, expectedVersion })).toEqual(['expectedVersion']);
  });

  it('needs pharmacy.order-route.receive, answers 200, and requires an Idempotency-Key', () => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, PharmacyOrderRoutesController.prototype.cannotComplete))
      .toEqual(['pharmacy.order-route.receive']);
    const service = { cannotComplete: jest.fn() };
    const controller = new PharmacyOrderRoutesController(service as never);
    for (const missing of [undefined, '', 'short']) {
      expect(() => controller.cannotComplete(routeId, input(), missing, {} as never))
        .toThrow(expect.objectContaining({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    }
    expect(service.cannotComplete).not.toHaveBeenCalled();
  });
});

describe('PharmacyOrderRoutesService.cannotComplete (C31)', () => {
  it('calls the five-argument command once, READ COMMITTED, with a stable digest without criticalValueTold', async () => {
    const h = harness();
    await h.service.cannotComplete(context, routeId, input(), key);
    const digest = requestDigest('pharmacy.order-route.cannot-complete', { routeId, expectedVersion: 3, reason: 'out_of_stock' });
    expect(h.statements).toEqual([{ sql: 'select * from pharmacy.cannot_complete_order_route($1, $2, $3, $4, $5)',
      values: [routeId, 3, 'out_of_stock', key, digest] }]);
    expect(h.options).toEqual([{ isolationLevel: 'READ COMMITTED' }]);
    expect(requestDigest('pharmacy.order-route.cannot-complete', { reason: 'out_of_stock', expectedVersion: 3, routeId }))
      .toBe(digest);
    for (const other of [{ reason: 'other' }, { expectedVersion: 4 }, { criticalValueTold: false }]) {
      expect(requestDigest('pharmacy.order-route.cannot-complete', { routeId, expectedVersion: 3, reason: 'out_of_stock',
        ...other })).not.toBe(digest);
    }
    expect(requestDigest('lab.order-route.cannot-complete', { routeId, expectedVersion: 3, reason: 'out_of_stock' }))
      .not.toBe(digest);
  });

  it('answers the ended prescription, readUntil at the ending\'s moment and zero counts; never the patient or ending id',
    async () => {
      const answer = await harness().service.cannotComplete(context, routeId, input(), key);
      expect(answer).toEqual({ route: { id: routeId, version: 4, effectiveState: 'cancelled', endedKind: 'receiving_unable' },
        reason: 'out_of_stock', readUntil: '2026-10-27T10:15:00.250Z', specimensCollected: 0, resultsRecorded: 0,
        criticalCandidates: 0, replayed: false });
      expect(typeof answer.route.version).toBe('number');
      expect(JSON.stringify(answer)).not.toMatch(new RegExp(`${patientId}|${endingId}`));
    });

  it('writes the pharmacy\'s own row with the patient from the command, the reason and the statement', async () => {
    const h = harness();
    await h.service.cannotComplete(context, routeId, input(), key);
    expect(h.audits).toEqual([['pharmacy.order-route.cannot-complete',
      { resourceType: 'order-route', resourceId: routeId, patientId },
      { routeId, kind: 'prescription', endingId, state: 'cancelled', reasonCode: 'out_of_stock', specimensCollected: 0,
        resultsRecorded: 0, criticalCandidates: 0, criticalValueTold: false, confirmedPatient: true, replayed: false },
      undefined]]);
  });

  it('answers a replay with replayed true and the first ending\'s reason', async () => {
    const h = harness([{ ...ended, result: 'replayed', route_row_version: '6' }]);
    await expect(h.service.cannotComplete(context, routeId, input(), key)).resolves
      .toMatchObject({ route: { version: 6 }, reason: 'out_of_stock', replayed: true });
    expect(h.audits[0]?.[2]).toMatchObject({ replayed: true });
  });

  it.each([
    [{ result: 'ended' }], [{ ...ended, result: 'reported' }], [{ ...ended, patient_id: null }],
    [{ ...ended, route_row_version: 'x' }], [{ ...ended, ended_kind: null }], [{ ...ended, reason_code: null }],
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
    ['P0001', 'ORDER_ROUTE_VERSION_CONFLICT', 412, 'VERSION_CONFLICT'],
    ['40001', 'could not serialize access due to concurrent update', 409, 'ORDER_ROUTE_CHANGED_CONCURRENTLY'],
    ['40P01', 'deadlock detected', 409, 'ORDER_ROUTE_CHANGED_CONCURRENTLY'],
    ['23514', 'ORDER_ROUTE_CLOSED', 503, 'ORDER_ROUTE_UNAVAILABLE'],
    ['42883', 'function pharmacy.cannot_complete_order_route(uuid, integer, unknown, unknown, unknown) does not exist', 503,
      'ORDER_ROUTE_UNAVAILABLE'],
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
    for (const detail of [undefined, 'later', '2026-10-28T09:14:03Z', '2026-13-28T09:14:03.219Z']) {
      const problem = cannotCompleteProblem(databaseError('P0001', 'ORDER_ROUTE_CANNOT_COMPLETE_LIMIT', detail)) as DomainProblem;
      expect([problem.getStatus(), problem.code, problem.extensions]).toEqual([429, 'ORDER_ROUTE_CANNOT_COMPLETE_LIMIT', undefined]);
    }
  });

  it('maps 40001 and 40P01 to 409 for this command only; the other route commands answer them 503', () => {
    expect(cannotCompleteProblem(databaseError('40P01', 'x'))).toMatchObject({ status: 409, code: 'ORDER_ROUTE_CHANGED_CONCURRENTLY' });
    expect(pharmacyOrderRouteProblem(databaseError('40P01', 'x'))).toMatchObject({ status: 503 });
    expect(cannotCompleteAnswer(routeId, { ...ended, critical_candidates: null, access_ends_at: 'soon' }))
      .toMatchObject({ criticalCandidates: 0, readUntil: null });
  });
});

describe('"We can\'t complete this order" at the pharmacy over HTTP', () => {
  let permissions = ['pharmacy.order-route.receive'];
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
  const audit = { recordWithClient: jest.fn(async (..._args: unknown[]) => undefined) };
  const guard = { canActivate: jest.fn((execution: ExecutionContext) => {
    const incoming = execution.switchToHttp().getRequest<HidRequest>();
    const assignment = { id: facilityId, membershipId: context.membershipId, organizationId: facilityId,
      name: 'Synthetic Pharmacy', roles: ['pharmacist'], permissions, isPrimary: true };
    incoming.actor = { id: 'staff:pharmacist', subject: 'staff:pharmacist', accountId: context.actor.accountId,
      roles: ['pharmacist'], permissions, facilityIds: [facilityId], facilities: [assignment], facility: assignment,
      authenticationMethod: 'local' } satisfies ActorContext;
    incoming.facilityId = facilityId;
    incoming.correlationId = 'pharmacy-unable-http-0001';
    const required = new Reflector().getAllAndOverride<string[]>(REQUIRED_PERMISSIONS,
      [execution.getHandler(), execution.getClass()]) ?? [];
    if (required.some((permission) => !permissions.includes(permission))) {
      throw new DomainProblem(403, 'PERMISSION_DENIED', 'Required permission is missing');
    }
    return true;
  }) };

  @Module({
    controllers: [PharmacyOrderRoutesController],
    providers: [PharmacyOrderRoutesService, PharmacyOrderRouteCards,
      { provide: DatabaseService, useValue: database },
      { provide: AuditService, useValue: audit },
      { provide: APP_GUARD, useFactory: () => guard }],
  })
  class CannotCompleteHttpModule {}

  let app: INestApplication;
  let base: string;
  const logged = (['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const)
    .map((level) => jest.spyOn(Logger.prototype, level));

  beforeEach(async () => {
    jest.clearAllMocks();
    statements.length = 0;
    permissions = ['pharmacy.order-route.receive'];
    answer = [ended];
    const moduleRef = await Test.createTestingModule({ imports: [CannotCompleteHttpModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    for (const spy of logged) spy.mockClear();
  });

  afterEach(async () => { await app.close(); });

  const body = { expectedVersion: 3, reason: 'out_of_stock', confirmedPatient: true };
  const post = async (payload: unknown, idempotencyKey: string | null = key) => {
    const headers: Record<string, string> = { authorization: 'Bearer synthetic', 'x-facility-id': facilityId,
      'x-purpose-of-use': 'direct-care', 'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) };
    const response = await fetch(`${base}/api/v1/pharmacy/order-routes/${routeId}/cannot-complete`, { method: 'POST', headers,
      body: JSON.stringify(payload) });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) as Record<string, unknown> : undefined };
  };

  it('answers 200 with the ended prescription and writes the pharmacy\'s row with the patient', async () => {
    const response = await post(body);
    expect([response.status, response.body]).toEqual([200, { route: { id: routeId, version: 4, effectiveState: 'cancelled',
      endedKind: 'receiving_unable' }, reason: 'out_of_stock', readUntil: '2026-10-27T10:15:00.250Z', specimensCollected: 0,
    resultsRecorded: 0, criticalCandidates: 0, replayed: false }]);
    expect(statements[0]?.values.slice(0, 4)).toEqual([routeId, 3, 'out_of_stock', key]);
    expect(audit.recordWithClient).toHaveBeenCalledWith(client, expect.anything(), 'pharmacy.order-route.cannot-complete',
      { resourceType: 'order-route', resourceId: routeId, patientId }, expect.objectContaining({ confirmedPatient: true }));
    expect(response.text).not.toMatch(new RegExp(`${patientId}|${endingId}`));
  });

  it('refuses a missing key, a bad body, criticalValueTold and a member without the receive permission, before the database',
    async () => {
      const missing = await post(body, null);
      expect([missing.status, missing.body?.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
      const { confirmedPatient: _confirmed, ...unconfirmed } = body;
      for (const invalid of [unconfirmed, { ...body, confirmedPatient: false }, { ...body, reason: 'test_not_offered' },
        { ...body, criticalValueTold: true }, { ...body, criticalValueTold: false }, { ...body, note: 'No stock until May' }]) {
        const refused = await post(invalid);
        expect([refused.status, refused.body?.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
      permissions = ['pharmacy.work-item.read'];
      const denied = await post(body);
      expect([denied.status, denied.body?.code]).toEqual([403, 'PERMISSION_DENIED']);
      expect(statements).toEqual([]);
      expect(audit.recordWithClient).not.toHaveBeenCalled();
    });

  it('answers the limit 429 with retryAfter as a problem member', async () => {
    answer = databaseError('P0001', 'ORDER_ROUTE_CANNOT_COMPLETE_LIMIT', '2026-10-28T09:14:03.219Z');
    const limited = await post(body);
    expect([limited.status, limited.body?.code, limited.body?.retryAfter]).toEqual([429, 'ORDER_ROUTE_CANNOT_COMPLETE_LIMIT',
      '2026-10-28T09:14:03.219Z']);
    expect(limited.body).not.toHaveProperty('extensions');
  });

  it.each([
    ['P0001', 'ORDER_ROUTE_ALREADY_RETURNED', 409], ['P0001', 'ORDER_ROUTE_ALREADY_ENDED', 409],
    ['P0001', 'ORDER_ROUTE_NOT_ACCEPTED', 409], ['P0001', 'ORDER_ROUTE_VERSION_CONFLICT', 412],
    ['40001', 'could not serialize access', 409], ['25000', 'ORDER_ROUTE_CANNOT_COMPLETE_READ_COMMITTED_REQUIRED', 503],
  ])('answers %s %s with %i, never the database\'s text', async (state, message, status) => {
    answer = databaseError(state, message);
    const refused = await post(body);
    expect(refused.status).toBe(status);
    expect(refused.text).not.toMatch(/P0001|serialize|READ_COMMITTED/);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });
});
