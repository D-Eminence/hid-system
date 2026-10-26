import 'reflect-metadata';
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
import { ReportWrongPatientDto } from './dto/order-route.dto';
import { pharmacyOrderRouteProblem, wrongPatientProblem } from './pharmacy-order-route.mapping';
import { PharmacyOrderRoutesController } from './pharmacy-order-routes.controller';
import { PharmacyOrderRoutesService } from './pharmacy-order-routes.service';
import { orderRouteCard, PharmacyOrderRouteCards } from './order-route-cards';

// Item 3 (SPEC-FINAL §5.1, §7.2, §10.2): the pharmacy reports that it
// accepted a prescription for someone who was not its patient (C25).
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const routeId = '123e4567-e89b-42d3-a456-426614174010';
const reportId = '123e4567-e89b-42d3-a456-426614174011';
const key = 'pharmacy-wrong-patient-0001';
const note = 'Handed over to the wrong person at the counter';
const context = { correlationId: 'correlation-123456', facilityId, membershipId: '123e4567-e89b-42d3-a456-426614174004',
  purposeOfUse: 'direct-care', actor: { id: 'a', subject: 'staff:pharmacist', accountId: '123e4567-e89b-42d3-a456-426614174003',
    authenticationMethod: 'local', roles: ['pharmacist'], permissions: ['pharmacy.order-route.receive'], facilityIds: [facilityId],
    facilities: [] } } satisfies DataAccessContext;
const databaseError = (code: string, message: string, detail?: string) =>
  Object.assign(new Error(message), { code, ...(detail === undefined ? {} : { detail }) });

/** C25's row for a dispensed prescription (bigints as text, as node-postgres gives them). */
const ended = { result: 'ended', report_id: reportId, route_row_version: '6', route_state: 'completed',
  effective_state: 'completed', ended_kind: 'wrong_patient', results_voided: 0, result_reports_marked: 0,
  dispensing_reversed: true, state_before: 'completed', patient_id: patientId };

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

const input = (overrides: Partial<ReportWrongPatientDto> = {}): ReportWrongPatientDto =>
  ({ expectedVersion: 5, reason: 'suspected_misuse', note, ...overrides });

describe('the pharmacy wrong-patient report: body and route (C25)', () => {
  const errors = async (body: unknown) =>
    (await validate(plainToInstance(ReportWrongPatientDto, body), { whitelist: true, forbidNonWhitelisted: true,
      forbidUnknownValues: true })).map((error) => error.property).sort();

  it('takes a version, one of the four reasons and a note of 8 to 500 characters, nothing else', async () => {
    for (const reason of ['wrong_order_chosen', 'someone_elses_details', 'suspected_misuse', 'other']) {
      expect(await errors({ expectedVersion: 1, reason, note })).toEqual([]);
    }
    expect(await errors({ expectedVersion: 1, reason: 'medicine_unavailable', note })).toEqual(['reason']);
    expect(await errors({ expectedVersion: 1, reason: 'other', note: 'Not her' })).toEqual(['note']);
    expect(await errors({ expectedVersion: 1, reason: 'other', note: 'x'.repeat(501) })).toEqual(['note']);
    expect(await errors({ expectedVersion: 0, reason: 'other', note })).toEqual(['expectedVersion']);
    expect(await errors({ expectedVersion: 1, reason: 'other', note, dispensingId: reportId })).toEqual(['dispensingId']);
  });

  it('needs pharmacy.order-route.receive (the command checks the reversal permission) and an Idempotency-Key', () => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, PharmacyOrderRoutesController.prototype.reportWrongPatient))
      .toEqual(['pharmacy.order-route.receive']);
    const service = { reportWrongPatient: jest.fn() };
    const controller = new PharmacyOrderRoutesController(service as never);
    for (const missing of [undefined, '', 'short']) {
      expect(() => controller.reportWrongPatient(routeId, input(), missing, {} as never))
        .toThrow(expect.objectContaining({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    }
    expect(service.reportWrongPatient).not.toHaveBeenCalled();
  });
});

describe('PharmacyOrderRoutesService.reportWrongPatient (C25)', () => {
  it('calls the command once, READ COMMITTED, with the trimmed note and a stable digest', async () => {
    const h = harness();
    await h.service.reportWrongPatient(context, routeId, input({ note: `\n${note} ` }), key);
    const digest = requestDigest('pharmacy.order-route.wrong-patient', { routeId, expectedVersion: 5,
      reason: 'suspected_misuse', note });
    expect(h.statements).toEqual([{ sql: 'select * from pharmacy.report_wrong_patient_order_route($1, $2, $3, $4, $5, $6)',
      values: [routeId, 5, 'suspected_misuse', note, key, digest] }]);
    expect(h.options).toEqual([{ isolationLevel: 'READ COMMITTED' }]);
    expect(requestDigest('lab.order-route.wrong-patient', { routeId, expectedVersion: 5, reason: 'suspected_misuse', note }))
      .not.toBe(digest);
  });

  it('answers the route and that a dispensing was reversed; its own row names the patient, never the note', async () => {
    const h = harness();
    const answer = await h.service.reportWrongPatient(context, routeId, input(), key);
    expect(answer).toEqual({ route: { id: routeId, version: 6, effectiveState: 'completed', endedKind: 'wrong_patient' },
      resultsVoided: 0, resultReportsMarked: 0, dispensingReversed: true, replayed: false });
    expect(typeof answer.route.version).toBe('number');
    expect(JSON.stringify(answer)).not.toMatch(new RegExp(`${patientId}|${reportId}`));
    expect(h.audits).toEqual([['pharmacy.order-route.wrong-patient', { resourceType: 'order-route', resourceId: routeId, patientId },
      { routeId, kind: 'prescription', reportId, stateBefore: 'completed', state: 'completed', reasonCode: 'suspected_misuse',
        resultsVoided: 0, dispensingReversed: true, replayed: false }, undefined]]);
    expect(JSON.stringify(h.audits)).not.toContain('wrong person');
  });

  it('answers a replay with replayed true; an accepted prescription ends cancelled with nothing reversed', async () => {
    const replay = harness([{ ...ended, result: 'replayed' }]);
    await expect(replay.service.reportWrongPatient(context, routeId, input(), key)).resolves.toMatchObject({ replayed: true });
    expect(replay.audits[0]?.[2]).toMatchObject({ replayed: true });
    const accepted = harness([{ ...ended, route_row_version: 3, route_state: 'cancelled', effective_state: 'cancelled',
      dispensing_reversed: false, state_before: 'accepted' }]);
    await expect(accepted.service.reportWrongPatient(context, routeId, input(), key)).resolves.toEqual({
      route: { id: routeId, version: 3, effectiveState: 'cancelled', endedKind: 'wrong_patient' }, resultsVoided: 0,
      resultReportsMarked: 0, dispensingReversed: false, replayed: false });
  });

  it('refuses a note shorter than 8 characters once trimmed with 400 ORDER_ROUTE_INVALID, before the database', async () => {
    const h = harness();
    await expect(h.service.reportWrongPatient(context, routeId, input({ note: '  Not her    ' }), key))
      .rejects.toMatchObject({ status: 400, code: 'ORDER_ROUTE_INVALID' });
    expect(h.statements).toEqual([]);
  });

  it.each([[[]], [[{ result: 'perhaps' }]], [[{ ...ended, patient_id: null }]], [[{ ...ended, effective_state: null }]]])(
    'answers 503 and writes nothing for an answer it cannot read (%o)', async (rows) => {
      const h = harness(rows);
      await expect(h.service.reportWrongPatient(context, routeId, input(), key))
        .rejects.toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
      expect(h.audits).toEqual([]);
    });

  it.each([
    ['42501', 'ORDER_ROUTE_PERMISSION_DENIED', 403, 'PERMISSION_DENIED'],
    ['22023', 'ORDER_ROUTE_INVALID', 400, 'ORDER_ROUTE_INVALID'],
    ['55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE'],
    ['P0002', 'ORDER_ROUTE_NOT_FOUND', 404, 'ORDER_ROUTE_NOT_FOUND'],
    ['P0001', 'ORDER_ROUTE_NOT_ACCEPTED', 409, 'ORDER_ROUTE_NOT_ACCEPTED'],
    ['P0001', 'ORDER_ROUTE_ALREADY_ENDED', 409, 'ORDER_ROUTE_ALREADY_ENDED'],
    ['P0001', 'IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['P0001', 'ORDER_ROUTE_VERSION_CONFLICT', 412, 'VERSION_CONFLICT'],
    ['40001', 'could not serialize access', 409, 'ORDER_ROUTE_CHANGED_CONCURRENTLY'],
    ['40P01', 'deadlock detected', 409, 'ORDER_ROUTE_CHANGED_CONCURRENTLY'],
    ['P0001', 'SOMETHING_ELSE', 503, 'ORDER_ROUTE_UNAVAILABLE'],
    ['XX000', 'internal', 503, 'ORDER_ROUTE_UNAVAILABLE'],
  ])('answers %s %s as %i %s', async (state, message, status, code) => {
    const h = harness(databaseError(state, message));
    await expect(h.service.reportWrongPatient(context, routeId, input(), key)).rejects.toMatchObject({ status, code });
    expect(h.audits).toEqual([]);
  });

  it('answers the missing reversal permission 403 naming pharmacy.dispensing.reverse', async () => {
    for (const detail of ['pharmacy.dispensing.reverse', 'lab.result.entered-in-error', undefined]) {
      const refused = await harness(databaseError('P0001', 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED', detail))
        .service.reportWrongPatient(context, routeId, input(), key).catch((e: unknown) => e);
      expect(refused).toMatchObject({ status: 403, code: 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED',
        extensions: { permission: 'pharmacy.dispensing.reverse' } });
    }
  });

  it('maps 40001 and 40P01 to 409 for this command only', () => {
    expect(wrongPatientProblem(databaseError('40P01', 'x'))).toMatchObject({ status: 409 });
    expect(pharmacyOrderRouteProblem(databaseError('40P01', 'x'))).toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
  });
});

describe('the pharmacy work list\'s route card gains version and endedKind (C18, B9)', () => {
  const card = { work_item_id: '123e4567-e89b-42d3-a456-426614174007', route_id: routeId, reference: '123E4567',
    effective_state: 'accepted', access: 'work', ordering_facility_name: 'Ordering Hospital', orderer_name: 'Dr Ada Obi',
    orderer_licence_body: 'MDCN', orderer_licence_number: 'MDCN/1', patient_full_name: 'Ngozi Eze', patient_sex: 'female',
    patient_date_of_birth: '1990-01-01', patient_health_id_last4: '2345', row_version: '4', ended_kind: null };

  it('answers the version as a number and endedKind, with no patient on an ended route\'s card', async () => {
    expect(orderRouteCard(card).orderRoute).toMatchObject({ version: 4, endedKind: null });
    expect(typeof orderRouteCard(card).orderRoute.version).toBe('number');
    const ended = orderRouteCard({ ...card, access: 'none', ended_kind: 'wrong_patient', patient_full_name: null });
    expect(ended.orderRoute).toMatchObject({ access: 'none', endedKind: 'wrong_patient' });
    expect(ended).not.toHaveProperty('patient');
    const statements: string[] = [];
    const client = { query: jest.fn(async (sql: string) => { statements.push(sql); return { rows: [card] }; }) };
    await new PharmacyOrderRouteCards({} as never).cards(client as unknown as PoolClient, [card.work_item_id], 'correlation');
    expect(statements.find((sql) => sql.includes('pharmacy.order_route_cards')))
      .toMatch(/patient_health_id_last4, row_version, ended_kind\s+from pharmacy\.order_route_cards/);
  });
});

// Over HTTP on loopback: the controller, service, validation pipe and problem
// filter as main.ts sets them; a guard that binds the session and checks the
// route's permissions; a fake database and audit store.
describe('POST pharmacy/order-routes/:routeId/wrong-patient over HTTP', () => {
  let permissions = ['pharmacy.order-route.receive', 'pharmacy.dispensing.reverse'];
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
    incoming.correlationId = 'pharmacy-wp-http-0001';
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
  class WrongPatientHttpModule {}

  let app: INestApplication;
  let base: string;
  const logged = (['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const)
    .map((level) => jest.spyOn(Logger.prototype, level));

  beforeEach(async () => {
    jest.clearAllMocks();
    statements.length = 0;
    permissions = ['pharmacy.order-route.receive', 'pharmacy.dispensing.reverse'];
    answer = [ended];
    const moduleRef = await Test.createTestingModule({ imports: [WrongPatientHttpModule] }).compile();
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

  const post = async (body: unknown, idempotencyKey: string | null = key) => {
    const headers: Record<string, string> = { authorization: 'Bearer synthetic', 'x-facility-id': facilityId,
      'x-purpose-of-use': 'direct-care', 'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) };
    const response = await fetch(`${base}/api/v1/pharmacy/order-routes/${routeId}/wrong-patient`, { method: 'POST', headers,
      body: JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) as Record<string, unknown> : undefined };
  };
  const written = () => JSON.stringify([audit.recordWithClient.mock.calls.map((call) => call.slice(2)),
    ...logged.map((spy) => spy.mock.calls)]);

  it('answers 200 with the route and that a dispensing was reversed, the note nowhere in a row or log', async () => {
    const response = await post({ expectedVersion: 5, reason: 'suspected_misuse', note });
    expect([response.status, response.body]).toEqual([200, { route: { id: routeId, version: 6, effectiveState: 'completed',
      endedKind: 'wrong_patient' }, resultsVoided: 0, resultReportsMarked: 0, dispensingReversed: true, replayed: false }]);
    expect(written()).not.toContain('wrong person');
  });

  it('refuses a missing key, a bad body, a short trimmed note and a member without the receive permission', async () => {
    const missing = await post({ expectedVersion: 5, reason: 'other', note }, null);
    expect([missing.status, missing.body?.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    for (const body of [{ expectedVersion: 5, reason: 'other', note: 'Not her' }, { expectedVersion: 5, reason: 'other', note,
      quantity: 1 }]) {
      const invalid = await post(body);
      expect([invalid.status, invalid.body?.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    const trimmed = await post({ expectedVersion: 5, reason: 'other', note: '   Not her     ' });
    expect([trimmed.status, trimmed.body?.code]).toEqual([400, 'ORDER_ROUTE_INVALID']);
    permissions = ['pharmacy.dispensing.reverse'];
    const denied = await post({ expectedVersion: 5, reason: 'other', note });
    expect([denied.status, denied.body?.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect(statements).toEqual([]);
  });

  it('answers the missing reversal permission 403 with the permission as a problem member', async () => {
    answer = databaseError('P0001', 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED', 'pharmacy.dispensing.reverse');
    const refused = await post({ expectedVersion: 5, reason: 'other', note });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED',
      permission: 'pharmacy.dispensing.reverse' });
    expect(refused.text).not.toContain('wrong person');
    expect(written()).not.toContain('wrong person');
  });
});
