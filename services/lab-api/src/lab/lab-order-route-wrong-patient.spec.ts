import 'reflect-metadata';
import { type ExecutionContext, type INestApplication, Logger, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { REQUIRED_PERMISSIONS } from '../common/decorators';
import { requestDigest } from '../common/idempotency';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, DataAccessContext, HidRequest } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { ReportWrongPatientDto } from './dto/order-route.dto';
import { labOrderRouteProblem, wrongPatientAnswer, wrongPatientProblem } from './lab-order-route.mapping';
import { LabOrderRoutesController } from './lab-order-routes.controller';
import { LabOrderRoutesService } from './lab-order-routes.service';
import { LabOrderRouteCards, orderRouteCard } from './order-route-cards';

// Item 3 (SPEC-FINAL §5.1, §7.1, §10.2): the laboratory reports that it
// accepted a lab request for someone who was not its patient (C25).
const facilityId = '10000000-0000-4000-8000-000000000001';
const patientId = '50000000-0000-4000-8000-000000000001';
const routeId = 'b0000000-0000-4000-8000-000000000001';
const reportId = 'e0000000-0000-4000-8000-000000000001';
const key = 'wrong-patient-key-0001';
const note = 'Picked the wrong row at the counter';
const context = { correlationId: 'lab-wrong-patient-correlation', facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
  purposeOfUse: 'direct-care', actor: { id: 'actor', subject: 'staff:lab', accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['lab'], permissions: ['lab.order-route.receive'], facilityIds: [facilityId], facilities: [],
    authenticationMethod: 'local' } } satisfies DataAccessContext;
const databaseError = (code: string, message: string, detail?: string) =>
  Object.assign(new Error(message), { code, ...(detail === undefined ? {} : { detail }) });

/** The command's row as C25 answers it (bigints as text, as node-postgres gives them). */
const ended = { result: 'ended', report_id: reportId, route_row_version: '9', route_state: 'completed',
  effective_state: 'completed', ended_kind: 'wrong_patient', results_voided: 1, result_reports_marked: 2,
  dispensing_reversed: false, state_before: 'completed', patient_id: patientId };

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

const input = (overrides: Partial<ReportWrongPatientDto> = {}): ReportWrongPatientDto =>
  ({ expectedVersion: 8, reason: 'someone_elses_details', note, ...overrides });

describe('the wrong-patient report: body and route (C25)', () => {
  const errors = async (body: unknown) =>
    (await validate(plainToInstance(ReportWrongPatientDto, body), { whitelist: true, forbidNonWhitelisted: true,
      forbidUnknownValues: true })).map((error) => error.property).sort();

  it('takes a version, one of the four reasons and a note of 8 to 500 characters, nothing else', async () => {
    for (const reason of ['wrong_order_chosen', 'someone_elses_details', 'suspected_misuse', 'other']) {
      expect(await errors({ expectedVersion: 1, reason, note })).toEqual([]);
    }
    expect(await errors({ expectedVersion: 1, reason: 'cannot_complete', note })).toEqual(['reason']);
    expect(await errors({ expectedVersion: 1, reason: 'other', note: 'Not him' })).toEqual(['note']);
    expect(await errors({ expectedVersion: 1, reason: 'other', note: 'x'.repeat(501) })).toEqual(['note']);
    expect(await errors({ expectedVersion: 1, reason: 'other', note: 'x'.repeat(500) })).toEqual([]);
    expect(await errors({ expectedVersion: 1, reason: 'other', note: 12345678 })).toEqual(['note']);
    expect(await errors({ expectedVersion: 0, reason: 'other', note })).toEqual(['expectedVersion']);
    expect(await errors({ expectedVersion: '8', reason: 'other', note })).toEqual(['expectedVersion']);
    expect(await errors({ reason: 'other', note })).toEqual(['expectedVersion']);
    // No patient, no confirmation flag and no "can't complete" ending (D18) reach the command.
    expect(await errors({ expectedVersion: 1, reason: 'other', note, patientId })).toEqual(['patientId']);
    expect(await errors({ expectedVersion: 1, reason: 'other', note, confirmed: true })).toEqual(['confirmed']);
  });

  it('needs lab.order-route.receive (the command checks the correction permission) and an Idempotency-Key', () => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, LabOrderRoutesController.prototype.reportWrongPatient))
      .toEqual(['lab.order-route.receive']);
    const service = { reportWrongPatient: jest.fn() };
    const controller = new LabOrderRoutesController(service as never);
    for (const missing of [undefined, '', 'short']) {
      expect(() => controller.reportWrongPatient(routeId, input(), missing, {} as never))
        .toThrow(expect.objectContaining({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    }
    expect(service.reportWrongPatient).not.toHaveBeenCalled();
  });
});

describe('LabOrderRoutesService.reportWrongPatient (C25)', () => {
  it('calls the command once, READ COMMITTED, with the trimmed note and a stable digest of the request', async () => {
    const h = harness();
    await h.service.reportWrongPatient(context, routeId, input({ note: `  ${note}  ` }), key);
    const digest = requestDigest('lab.order-route.wrong-patient', { routeId, expectedVersion: 8, reason: 'someone_elses_details',
      note });
    expect(h.statements).toEqual([{ sql: 'select * from lab.report_wrong_patient_order_route($1, $2, $3, $4, $5, $6)',
      values: [routeId, 8, 'someone_elses_details', note, key, digest] }]);
    expect(h.options).toEqual([{ isolationLevel: 'READ COMMITTED' }]);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // The digest is the same request's whatever the spacing around the note, and another request's otherwise.
    expect(requestDigest('lab.order-route.wrong-patient', { note, reason: 'someone_elses_details', expectedVersion: 8, routeId }))
      .toBe(digest);
    expect(requestDigest('lab.order-route.wrong-patient', { routeId, expectedVersion: 8, reason: 'other', note })).not.toBe(digest);
    expect(requestDigest('pharmacy.order-route.wrong-patient', { routeId, expectedVersion: 8, reason: 'someone_elses_details',
      note })).not.toBe(digest);
  });

  it('answers the route as the report left it, its version a number, never the patient or the report id', async () => {
    const h = harness();
    const answer = await h.service.reportWrongPatient(context, routeId, input(), key);
    expect(answer).toEqual({ route: { id: routeId, version: 9, effectiveState: 'completed', endedKind: 'wrong_patient' },
      resultsVoided: 1, resultReportsMarked: 2, dispensingReversed: false, replayed: false });
    expect(typeof answer.route.version).toBe('number');
    expect(JSON.stringify(answer)).not.toMatch(new RegExp(`${patientId}|${reportId}`));
  });

  it('writes the laboratory\'s own row with the patient from the command and the counts, never the note', async () => {
    const h = harness();
    await h.service.reportWrongPatient(context, routeId, input(), key);
    expect(h.audits).toEqual([{ correlationId: context.correlationId, actorType: 'staff', actorSubject: 'staff:lab',
      actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId, organizationId: undefined, facilityId,
      patientId, action: 'lab.order-route.wrong-patient', resourceType: 'order-route', resourceId: routeId, outcome: 'success',
      purposeOfUse: 'direct-care', sourceSystem: 'lab-api', details: { routeId, kind: 'lab_request', reportId,
        stateBefore: 'completed', state: 'completed', reasonCode: 'someone_elses_details', resultsVoided: 1,
        dispensingReversed: false, replayed: false } }]);
    expect(JSON.stringify(h.audits)).not.toContain('wrong row');
  });

  it('answers a replay with replayed true and audits it as one', async () => {
    const h = harness([{ ...ended, result: 'replayed', route_row_version: '10' }]);
    const answer = await h.service.reportWrongPatient(context, routeId, input(), key);
    expect(answer).toMatchObject({ route: { version: 10 }, replayed: true });
    expect(h.audits[0]).toMatchObject({ details: expect.objectContaining({ replayed: true }) });
  });

  it('answers an accepted route ended with nothing returned: cancelled, nothing withdrawn', async () => {
    const h = harness([{ ...ended, route_row_version: 3, route_state: 'cancelled', effective_state: 'cancelled',
      results_voided: 0, result_reports_marked: 0, state_before: 'accepted' }]);
    await expect(h.service.reportWrongPatient(context, routeId, input({ reason: 'other' }), key)).resolves.toEqual({
      route: { id: routeId, version: 3, effectiveState: 'cancelled', endedKind: 'wrong_patient' }, resultsVoided: 0,
      resultReportsMarked: 0, dispensingReversed: false, replayed: false });
    expect(h.audits[0]).toMatchObject({ details: expect.objectContaining({ stateBefore: 'accepted', state: 'cancelled',
      reasonCode: 'other' }) });
  });

  it('refuses a note shorter than 8 characters once trimmed with 400 ORDER_ROUTE_INVALID, before the database', async () => {
    const h = harness();
    await expect(h.service.reportWrongPatient(context, routeId, input({ note: '   Not him     ' }), key))
      .rejects.toMatchObject({ status: 400, code: 'ORDER_ROUTE_INVALID' });
    expect(h.statements).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it.each([
    [{ result: 'perhaps' }],
    [{ ...ended, patient_id: null }],
    [{ ...ended, route_row_version: null }],
    [{ ...ended, ended_kind: null }],
  ])('answers 503 and writes nothing for a row it cannot read (%o)', async (row) => {
    const h = harness([row]);
    await expect(h.service.reportWrongPatient(context, routeId, input(), key))
      .rejects.toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
    expect(h.audits).toEqual([]);
  });

  it('answers 503 when the command returns no row, and fails the report when its audit row fails', async () => {
    await expect(harness([]).service.reportWrongPatient(context, routeId, input(), key))
      .rejects.toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
    const h = harness();
    h.audit.recordWithClient.mockRejectedValueOnce(databaseError('23514', 'audit refused'));
    await expect(h.service.reportWrongPatient(context, routeId, input(), key))
      .rejects.toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
  });

  it.each([
    ['42501', 'Order route staff context is required', 403, 'PERMISSION_DENIED'],
    ['42501', 'ORDER_ROUTE_PERMISSION_DENIED', 403, 'PERMISSION_DENIED'],
    ['22023', 'ORDER_ROUTE_INVALID', 400, 'ORDER_ROUTE_INVALID'],
    ['55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE'],
    ['P0002', 'ORDER_ROUTE_NOT_FOUND', 404, 'ORDER_ROUTE_NOT_FOUND'],
    ['P0001', 'ORDER_ROUTE_NOT_ACCEPTED', 409, 'ORDER_ROUTE_NOT_ACCEPTED'],
    ['P0001', 'ORDER_ROUTE_ALREADY_ENDED', 409, 'ORDER_ROUTE_ALREADY_ENDED'],
    ['P0001', 'IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['P0001', 'ORDER_ROUTE_VERSION_CONFLICT', 412, 'VERSION_CONFLICT'],
    ['40001', 'could not serialize access due to concurrent update', 409, 'ORDER_ROUTE_CHANGED_CONCURRENTLY'],
    ['40P01', 'deadlock detected', 409, 'ORDER_ROUTE_CHANGED_CONCURRENTLY'],
    ['P0001', 'SOMETHING_ELSE', 503, 'ORDER_ROUTE_UNAVAILABLE'],
    ['23514', 'ORDER_ROUTE_CLOSED', 503, 'ORDER_ROUTE_UNAVAILABLE'],
    ['XX000', 'internal', 503, 'ORDER_ROUTE_UNAVAILABLE'],
  ])('answers %s %s as %i %s, writing no audit row', async (state, message, status, code) => {
    const h = harness(databaseError(state, message));
    await expect(h.service.reportWrongPatient(context, routeId, input(), key)).rejects.toMatchObject({ status, code });
    expect(h.audits).toEqual([]);
  });

  it('answers the missing correction permission 403 naming it, whatever else the detail says', async () => {
    const named = await harness(databaseError('P0001', 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED',
      'lab.result.entered-in-error')).service.reportWrongPatient(context, routeId, input(), key).catch((e: unknown) => e);
    expect(named).toMatchObject({ status: 403, code: 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED',
      extensions: { permission: 'lab.result.entered-in-error' } });
    const other = await harness(databaseError('P0001', 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED', 'something else'))
      .service.reportWrongPatient(context, routeId, input(), key).catch((e: unknown) => e);
    expect(other).toMatchObject({ extensions: { permission: 'lab.result.entered-in-error' } });
  });

  it('maps 40001 and 40P01 to 409 for this command only: accept still answers them 503', () => {
    expect(wrongPatientProblem(databaseError('40001', 'x'))).toMatchObject({ status: 409, code: 'ORDER_ROUTE_CHANGED_CONCURRENTLY' });
    expect(labOrderRouteProblem(databaseError('40001', 'x'))).toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
    expect(labOrderRouteProblem(databaseError('40P01', 'x'))).toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
    const problem = new DomainProblem(400, 'ORDER_ROUTE_INVALID', 'x');
    expect(wrongPatientProblem(problem)).toBe(problem);
    expect(wrongPatientAnswer(routeId, { ...ended, result: 'ended', results_voided: null })).toMatchObject({ resultsVoided: 0 });
  });
});

describe('the work list\'s route card gains version and endedKind (C12, B9)', () => {
  const card = { work_item_id: '60000000-0000-4000-8000-000000000001', route_id: routeId, reference: 'B0000000',
    effective_state: 'accepted', access: 'work', ordering_facility_name: 'Ordering Hospital', orderer_name: 'Dr Ada Obi',
    orderer_licence_body: 'MDCN', orderer_licence_number: 'MDCN/12345', patient_full_name: 'Ngozi Eze', patient_sex: 'female',
    patient_date_of_birth: '1990-01-01', patient_health_id_last4: '2345', row_version: '12', ended_kind: null };

  it('answers the version as a number (node-postgres gives a bigint as text) and endedKind null while live', () => {
    const { orderRoute } = orderRouteCard(card);
    expect(orderRoute).toMatchObject({ version: 12, endedKind: null, access: 'work' });
    expect(typeof orderRoute.version).toBe('number');
    expect(orderRouteCard({ ...card, row_version: 7 }).orderRoute.version).toBe(7);
  });

  it('shows a consent holder\'s card of a route ended wrong_patient with access none, its kind, and no patient', () => {
    const shown = orderRouteCard({ ...card, access: 'none', ended_kind: 'wrong_patient', effective_state: 'completed',
      patient_full_name: null, orderer_licence_number: null });
    expect(shown.orderRoute).toMatchObject({ access: 'none', endedKind: 'wrong_patient', version: 12 });
    expect(shown).not.toHaveProperty('patient');
  });

  it('selects the two new columns from lab.order_route_cards', async () => {
    const statements: string[] = [];
    const client = { query: jest.fn(async (sql: string) => { statements.push(sql); return { rows: [card] }; }) };
    const cards = await new LabOrderRouteCards({} as DatabaseService).cards(client as unknown as PoolClient,
      [card.work_item_id], 'correlation');
    expect(statements.find((sql) => sql.includes('lab.order_route_cards'))).toMatch(/patient_health_id_last4, row_version, ended_kind\s+from lab\.order_route_cards/);
    expect(cards.get(card.work_item_id)?.orderRoute).toMatchObject({ version: 12, endedKind: null });
  });
});

// Over HTTP: the module's controller and service, the validation pipe, the
// interceptor and the problem filter as main.ts and AppModule set them; a
// guard that binds the session as the real one does (and checks the route's
// permissions), a fake database and audit store recording every call.
describe('POST lab/order-routes/:routeId/wrong-patient over HTTP', () => {
  const actor = (permissions: string[]): ActorContext => ({ kind: 'staff', id: 'staff:lab', subject: 'staff:lab',
    accountId: '20000000-0000-4000-8000-000000000001', roles: ['lab'], permissions, facilityIds: [facilityId],
    authenticationMethod: 'local', facilities: [{ id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
      organizationId: '30000000-0000-4000-8000-000000000001', name: 'Synthetic Laboratory', roles: ['lab'], permissions,
      isPrimary: true }] });
  let permissions = ['lab.order-route.receive', 'lab.result.entered-in-error'];
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
  class WrongPatientHttpModule {}

  let app: INestApplication;
  const logged = (['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const)
    .map((level) => jest.spyOn(Logger.prototype, level));

  beforeEach(async () => {
    jest.clearAllMocks();
    statements.length = 0;
    permissions = ['lab.order-route.receive', 'lab.result.entered-in-error'];
    answer = [ended];
    const moduleRef = await Test.createTestingModule({ imports: [WrongPatientHttpModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use((incoming: HidRequest, _response: unknown, next: () => void) => { incoming.correlationId = 'lab-wp-http-0001'; next(); });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
    for (const spy of logged) spy.mockClear();
  });

  afterEach(async () => { await app.close(); });

  const post = (body: unknown, idempotencyKey: string | null = key) => {
    const call = request(app.getHttpServer()).post(`/api/v1/lab/order-routes/${routeId}/wrong-patient`)
      .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId).set('X-Purpose-Of-Use', 'direct-care');
    return (idempotencyKey ? call.set('Idempotency-Key', idempotencyKey) : call).send(body as object);
  };
  /** Every audit row and log line of the requests so far, as text. */
  const written = () => JSON.stringify([audit.record.mock.calls, audit.recordWithClient.mock.calls.map(([, event]) => event),
    ...logged.map((spy) => spy.mock.calls)]);

  it('answers 200 with the route and the counts; the request row carries no body, the command row no note', async () => {
    const response = await post({ expectedVersion: 8, reason: 'someone_elses_details', note });
    expect([response.status, response.body]).toEqual([200, { route: { id: routeId, version: 9, effectiveState: 'completed',
      endedKind: 'wrong_patient' }, resultsVoided: 1, resultReportsMarked: 2, dispensingReversed: false, replayed: false }]);
    expect(statements[0]?.values.slice(0, 5)).toEqual([routeId, 8, 'someone_elses_details', note, key]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api.lab.order-route.wrong-patient.request',
      outcome: 'success', resourceType: 'http-request' }));
    expect(audit.recordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
      action: 'lab.order-route.wrong-patient', patientId }));
    expect(written()).not.toContain('wrong row');
  });

  it('refuses a missing Idempotency-Key, a bad body and an unknown field with 400 before the database', async () => {
    const missing = await post({ expectedVersion: 8, reason: 'other', note }, null);
    expect([missing.status, missing.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    for (const body of [{ expectedVersion: 8, reason: 'other', note: 'Not him' }, { expectedVersion: 8, reason: 'busy', note },
      { expectedVersion: 8, reason: 'other', note, patientId }, { reason: 'other', note }]) {
      const invalid = await post(body);
      expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    const trimmed = await post({ expectedVersion: 8, reason: 'other', note: '    Not him     ' });
    expect([trimmed.status, trimmed.body.code]).toEqual([400, 'ORDER_ROUTE_INVALID']);
    expect(statements).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api.lab.order-route.wrong-patient.request',
      outcome: 'failure' }));
    expect(written()).not.toMatch(/Not him/);
  });

  it('refuses a member without lab.order-route.receive 403 before the database', async () => {
    permissions = ['lab.result.entered-in-error', 'lab.work-item.read'];
    const denied = await post({ expectedVersion: 8, reason: 'other', note });
    expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect(statements).toEqual([]);
  });

  it('answers the missing correction permission 403 with the permission as a problem member, logging only the SQLSTATE', async () => {
    answer = databaseError('P0001', 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED', 'lab.result.entered-in-error');
    const refused = await post({ expectedVersion: 8, reason: 'other', note });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED',
      permission: 'lab.result.entered-in-error' });
    expect(refused.text).not.toMatch(/P0001|wrong row/);
    expect(logged[2]).toHaveBeenCalledWith(expect.objectContaining({ sqlState: 'P0001', status: 403,
      code: 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED' }));
    expect(written()).not.toContain('wrong row');
  });

  it.each([
    ['P0001', 'ORDER_ROUTE_ALREADY_ENDED', 409], ['P0001', 'ORDER_ROUTE_NOT_ACCEPTED', 409],
    ['P0001', 'ORDER_ROUTE_VERSION_CONFLICT', 412], ['40P01', 'deadlock detected', 409],
  ])('answers %s %s with %i, the note in no log line or audit row', async (state, message, status) => {
    answer = databaseError(state, message);
    const refused = await post({ expectedVersion: 8, reason: 'other', note });
    expect(refused.status).toBe(status);
    expect(written()).not.toContain('wrong row');
  });
});
