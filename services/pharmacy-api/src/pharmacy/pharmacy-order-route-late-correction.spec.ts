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
import { CorrectWrongPatientDto, FindCorrectableDto } from './dto/order-route.dto';
import { correctablePrescriptionRoute, lateCorrectionProblem, pharmacyOrderRouteProblem } from './pharmacy-order-route.mapping';
import { PharmacyOrderRoutesController } from './pharmacy-order-routes.controller';
import { discoveryDay, PharmacyOrderRoutesService } from './pharmacy-order-routes.service';
import { PharmacyOrderRouteCards } from './order-route-cards';

// D17 (SPEC-FINAL §5.1, §8.2, §10.2): the pharmacy finds a prescription it
// accepted by its reference (C30) and reverses, after it ended, a dispensing
// it recorded for someone who was not its patient (C29).
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const routeId = '123e4567-e89b-42d3-a456-426614174010';
const reportId = '123e4567-e89b-42d3-a456-426614174011';
const key = 'pharmacy-late-correction-0001';
const note = 'She collected it with another woman\'s date of birth';
const context = { correlationId: 'correlation-123456', facilityId, membershipId: '123e4567-e89b-42d3-a456-426614174004',
  purposeOfUse: 'direct-care', actor: { id: 'a', subject: 'staff:pharmacist', accountId: '123e4567-e89b-42d3-a456-426614174003',
    authenticationMethod: 'local', roles: ['pharmacist'], permissions: ['pharmacy.order-route.receive'], facilityIds: [facilityId],
    facilities: [] } } satisfies DataAccessContext;
const databaseError = (code: string, message: string, detail?: string) =>
  Object.assign(new Error(message), { code, ...(detail === undefined ? {} : { detail }) });

/** C29's row for a dispensed prescription support closed (bigints as text, timestamps as Dates). */
const corrected = { result: 'corrected', report_id: reportId, route_row_version: '7', route_state: 'completed',
  effective_state: 'completed', ended_kind: 'support', ended_kind_before: 'support', results_voided: 0,
  result_reports_marked: 0, dispensing_reversed: true, state_before: 'completed',
  correctable_until: new Date('2027-04-18T10:00:00Z'), patient_id: patientId };

/** C30's row for it: the medicine, who accepted it and how, and the dispensing. */
const found = { route_id: routeId, reference: '123E4567', kind: 'prescription', row_version: '6', effective_state: 'completed',
  ordering_facility_name: 'Ordering Hospital', accepted_at: new Date('2026-10-20T10:00:00Z'),
  completed_at: new Date('2026-10-20T11:00:00Z'), ended_at: new Date('2026-10-22T08:00:00Z'), ended_kind: 'support',
  returned: true, correction_state: 'correctable', correctable_until: new Date('2027-04-18T10:00:00Z'), reported_at: null,
  report_late: null, what_name: 'Metformin 500 mg tablet', accepted_by_name: 'Chioma Eze', accepted_with: 'health_id',
  returned_items: [{ at: '2026-10-20T11:00:00+00:00', withdrawn: true }] };

const input = (overrides: Partial<CorrectWrongPatientDto> = {}): CorrectWrongPatientDto =>
  ({ expectedVersion: 6, reason: 'suspected_misuse', discoveredBy: 'ordering_facility', discoveredOn: '2026-10-24', note,
    ...overrides });

function harness(answer: unknown[] | Error = [corrected]) {
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

describe('the pharmacy late correction and lookup: bodies and routes (C29, C30)', () => {
  const errors = async (type: new () => object, body: unknown) =>
    (await validate(plainToInstance(type, body), { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true }))
      .map((error) => error.property).sort();
  const body = { expectedVersion: 1, reason: 'other', discoveredBy: 'patient', discoveredOn: '2026-10-25', note };

  it('takes a version, a reason, how and when the pharmacy found out, and a note, every one required, nothing else', async () => {
    for (const discoveredBy of ['patient', 'ordering_facility', 'own_check', 'support', 'other']) {
      expect(await errors(CorrectWrongPatientDto, { ...body, discoveredBy })).toEqual([]);
    }
    expect(await errors(CorrectWrongPatientDto, { ...body, discoveredBy: 'pharmacist' })).toEqual(['discoveredBy']);
    for (const field of ['expectedVersion', 'reason', 'discoveredBy', 'discoveredOn', 'note']) {
      const { [field as keyof typeof body]: _left, ...without } = body;
      expect(await errors(CorrectWrongPatientDto, without)).toEqual([field]);
    }
    expect(await errors(CorrectWrongPatientDto, { ...body, discoveredOn: '2026/10/25' })).toEqual(['discoveredOn']);
    expect(await errors(CorrectWrongPatientDto, { ...body, note: 'Not her' })).toEqual(['note']);
    expect(await errors(CorrectWrongPatientDto, { ...body, quantity: 1 })).toEqual(['quantity']);
    expect(await errors(FindCorrectableDto, { reference: '123e4567' })).toEqual([]);
    expect(await errors(FindCorrectableDto, { reference: '' })).toEqual(['reference']);
    expect(await errors(FindCorrectableDto, { reference: 'x'.repeat(17) })).toEqual(['reference']);
    expect(await errors(FindCorrectableDto, { reference: '123E4567', healthId: 'HID-ABC234' })).toEqual(['healthId']);
  });

  it('needs pharmacy.order-route.receive on both (the command checks the reversal permission), and a key to correct', () => {
    const prototype = PharmacyOrderRoutesController.prototype;
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, prototype.correctWrongPatient)).toEqual(['pharmacy.order-route.receive']);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, prototype.findCorrectable)).toEqual(['pharmacy.order-route.receive']);
    const names = Object.getOwnPropertyNames(prototype);
    expect(names.indexOf('findCorrectable')).toBeLessThan(names.indexOf('get'));
    const service = { correctWrongPatient: jest.fn() };
    const controller = new PharmacyOrderRoutesController(service as never);
    for (const missing of [undefined, '', 'short']) {
      expect(() => controller.correctWrongPatient(routeId, input(), missing, {} as never))
        .toThrow(expect.objectContaining({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    }
    expect(service.correctWrongPatient).not.toHaveBeenCalled();
    expect(() => discoveryDay('2026-02-30')).toThrow(expect.objectContaining({ status: 400, code: 'ORDER_ROUTE_INVALID' }));
    expect(discoveryDay('2026-10-24')).toBe('2026-10-24');
  });
});

describe('PharmacyOrderRoutesService.correctWrongPatient (C29)', () => {
  it('calls the command once, READ COMMITTED, with the trimmed note, the date and the pharmacy\'s own digest', async () => {
    const h = harness();
    await h.service.correctWrongPatient(context, routeId, input({ note: `  ${note}  ` }), key);
    const digest = requestDigest('pharmacy.order-route.wrong-patient-correction', { routeId, expectedVersion: 6,
      reason: 'suspected_misuse', discoveredBy: 'ordering_facility', discoveredOn: '2026-10-24', note });
    expect(h.statements).toEqual([{
      sql: 'select * from pharmacy.correct_wrong_patient_order_route($1, $2, $3, $4, $5::date, $6, $7, $8)',
      values: [routeId, 6, 'suspected_misuse', 'ordering_facility', '2026-10-24', note, key, digest] }]);
    expect(h.options).toEqual([{ isolationLevel: 'READ COMMITTED' }]);
    expect(requestDigest('lab.order-route.wrong-patient-correction', { routeId, expectedVersion: 6, reason: 'suspected_misuse',
      discoveredBy: 'ordering_facility', discoveredOn: '2026-10-24', note })).not.toBe(digest);
  });

  it('answers the dispensing reversed late, the earlier ending kept, never the patient; audits without the note', async () => {
    const h = harness();
    const answer = await h.service.correctWrongPatient(context, routeId, input(), key);
    expect(answer).toEqual({ route: { id: routeId, version: 7, effectiveState: 'completed', endedKind: 'support' }, late: true,
      endedKindBefore: 'support', resultsVoided: 0, resultReportsMarked: 0, dispensingReversed: true,
      correctableUntil: '2027-04-18T10:00:00.000Z', replayed: false });
    expect(JSON.stringify(answer)).not.toMatch(new RegExp(`${patientId}|${reportId}`));
    expect(h.audits).toEqual([['pharmacy.order-route.wrong-patient-correction',
      { resourceType: 'order-route', resourceId: routeId, patientId },
      { routeId, kind: 'prescription', reportId, stateBefore: 'completed', endedKindBefore: 'support', state: 'completed',
        reasonCode: 'suspected_misuse', discoveredBy: 'ordering_facility', discoveredOn: '2026-10-24', resultsVoided: 0,
        dispensingReversed: true, replayed: false, late: true }, undefined]]);
    expect(JSON.stringify(h.audits)).not.toContain('another woman');
  });

  it('answers a replay and a prescription that had only lapsed (cancelled, ended wrong_patient now)', async () => {
    const replay = harness([{ ...corrected, result: 'replayed' }]);
    await expect(replay.service.correctWrongPatient(context, routeId, input(), key)).resolves.toMatchObject({ replayed: true });
    const lapsed = harness([{ ...corrected, route_state: 'cancelled', effective_state: 'cancelled', ended_kind: 'wrong_patient',
      ended_kind_before: null, dispensing_reversed: false, state_before: 'accepted' }]);
    await expect(lapsed.service.correctWrongPatient(context, routeId, input(), key)).resolves.toMatchObject({
      route: { effectiveState: 'cancelled', endedKind: 'wrong_patient' }, endedKindBefore: null, dispensingReversed: false });
  });

  it('refuses a short trimmed note and a day that is no date 400 ORDER_ROUTE_INVALID before the database', async () => {
    const h = harness();
    for (const bad of [input({ note: '   Not her      ' }), input({ discoveredOn: '2026-13-01' })]) {
      await expect(h.service.correctWrongPatient(context, routeId, bad, key)).rejects.toMatchObject({ status: 400,
        code: 'ORDER_ROUTE_INVALID' });
    }
    expect(h.statements).toEqual([]);
  });

  it.each([
    ['42501', 'Order route staff context is required', 403, 'PERMISSION_DENIED'],
    ['22023', 'ORDER_ROUTE_INVALID', 400, 'ORDER_ROUTE_INVALID'],
    ['55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE'],
    ['P0002', 'ORDER_ROUTE_NOT_FOUND', 404, 'ORDER_ROUTE_NOT_FOUND'],
    ['P0001', 'ORDER_ROUTE_NOT_ACCEPTED', 409, 'ORDER_ROUTE_NOT_ACCEPTED'],
    ['P0001', 'ORDER_ROUTE_STILL_OPEN', 409, 'ORDER_ROUTE_STILL_OPEN'],
    ['P0001', 'ORDER_ROUTE_ALREADY_REPORTED', 409, 'ORDER_ROUTE_ALREADY_REPORTED'],
    ['P0001', 'ORDER_ROUTE_CORRECTION_TOO_LATE', 409, 'ORDER_ROUTE_CORRECTION_TOO_LATE'],
    ['P0001', 'IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['P0001', 'ORDER_ROUTE_VERSION_CONFLICT', 412, 'VERSION_CONFLICT'],
    ['40001', 'could not serialize access', 409, 'ORDER_ROUTE_CHANGED_CONCURRENTLY'],
    ['40P01', 'deadlock detected', 409, 'ORDER_ROUTE_CHANGED_CONCURRENTLY'],
    ['XX000', 'ORDER_ROUTE_CORRECTION_CAPABILITY_LOST', 503, 'ORDER_ROUTE_UNAVAILABLE'],
  ])('answers %s %s as %i %s, writing no audit row', async (state, message, status, code) => {
    const h = harness(databaseError(state, message));
    await expect(h.service.correctWrongPatient(context, routeId, input(), key)).rejects.toMatchObject({ status, code });
    expect(h.audits).toEqual([]);
  });

  it('answers the reversal permission 403 naming it, and the limit 429 with retryAfter', async () => {
    const permission = await harness(databaseError('P0001', 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED',
      'pharmacy.dispensing.reverse')).service.correctWrongPatient(context, routeId, input(), key).catch((e: unknown) => e);
    expect(permission).toMatchObject({ status: 403, extensions: { permission: 'pharmacy.dispensing.reverse' } });
    const limited = lateCorrectionProblem(databaseError('P0001', 'ORDER_ROUTE_CORRECTION_LIMIT', '2026-10-27T09:14:03.218Z'));
    expect(limited).toMatchObject({ status: 429, code: 'ORDER_ROUTE_CORRECTION_LIMIT',
      extensions: { retryAfter: '2026-10-27T09:14:03.218Z' } });
    expect(lateCorrectionProblem(databaseError('P0001', 'ORDER_ROUTE_CORRECTION_LIMIT', 'later'))).toMatchObject({ status: 429,
      extensions: undefined });
    expect(pharmacyOrderRouteProblem(databaseError('40001', 'x'))).toMatchObject({ status: 503 });
  });
});

describe('PharmacyOrderRoutesService.findCorrectable (C30)', () => {
  it('reads by the upper-cased reference and answers field by field with the dispensing, never the patient', async () => {
    const h = harness([{ ...found, patient_id: patientId, patient_full_name: 'Ngozi Eze', instructions: 'Take with food' }]);
    const answer = await h.service.findCorrectable(context, { reference: '123e4567' });
    expect(h.statements).toEqual([{ sql: 'select * from pharmacy.find_correctable_order_routes($1)', values: ['123E4567'] }]);
    expect(answer).toEqual({ items: [{ id: routeId, reference: '123E4567', kind: 'prescription', version: 6,
      effectiveState: 'completed', orderingFacilityName: 'Ordering Hospital', acceptedAt: '2026-10-20T10:00:00.000Z',
      completedAt: '2026-10-20T11:00:00.000Z', endedAt: '2026-10-22T08:00:00.000Z', endedKind: 'support', returned: true,
      correction: 'correctable', correctableUntil: '2027-04-18T10:00:00.000Z', wrongPatient: null,
      details: { what: 'Metformin 500 mg tablet', acceptedBy: 'Chioma Eze', acceptedWith: 'health_id',
        returned: [{ at: '2026-10-20T11:00:00.000Z', withdrawn: true }] } }], lateCorrection: true });
    expect(JSON.stringify(answer)).not.toMatch(/Ngozi|food|426614174001/);
    expect(h.audits).toEqual([['pharmacy.order-route.correctable',
      { resourceType: 'order-route-collection', resourceId: facilityId },
      { found: 1, states: ['correctable'], routeIds: [routeId] }, undefined]]);
  });

  it('answers 200 { items: [] } for no match, details only while open or correctable, and refuses a bad reference 400', async () => {
    await expect(harness([]).service.findCorrectable(context, { reference: 'ABCDEF12' })).resolves.toEqual({ items: [],
      lateCorrection: true });
    expect(correctablePrescriptionRoute({ ...found, correction_state: 'reported', reported_at: '2026-10-26T08:00:00Z',
      report_late: true })).toMatchObject({ details: null, wrongPatient: { reportedAt: '2026-10-26T08:00:00.000Z', late: true } });
    expect(correctablePrescriptionRoute({ ...found, correction_state: 'too_late' })?.details).toBeNull();
    const h = harness();
    await expect(h.service.findCorrectable(context, { reference: 'XYZ' })).rejects.toMatchObject({ status: 400,
      code: 'ORDER_ROUTE_INVALID' });
    expect(h.statements).toEqual([]);
    const paused = harness(databaseError('55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled'));
    await expect(paused.service.findCorrectable(context, { reference: '123E4567' })).rejects.toMatchObject({ status: 423 });
    expect(paused.audits).toEqual([]);
  });
});

describe('the pharmacy late correction and lookup over HTTP', () => {
  let permissions = ['pharmacy.order-route.receive', 'pharmacy.dispensing.reverse'];
  let answer: unknown[] | Error = [corrected];
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
    incoming.correlationId = 'pharmacy-late-http-0001';
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
  class LateCorrectionHttpModule {}

  let app: INestApplication;
  let base: string;
  const logged = (['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const)
    .map((level) => jest.spyOn(Logger.prototype, level));

  beforeEach(async () => {
    jest.clearAllMocks();
    statements.length = 0;
    permissions = ['pharmacy.order-route.receive', 'pharmacy.dispensing.reverse'];
    answer = [corrected];
    const moduleRef = await Test.createTestingModule({ imports: [LateCorrectionHttpModule] }).compile();
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

  const call = async (path: string, payload: unknown, idempotencyKey: string | null = key) => {
    const headers: Record<string, string> = { authorization: 'Bearer synthetic', 'x-facility-id': facilityId,
      'x-purpose-of-use': 'direct-care', 'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) };
    const response = await fetch(`${base}/api/v1/pharmacy/order-routes/${path}`, { method: 'POST', headers,
      body: JSON.stringify(payload) });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) as Record<string, unknown> : undefined };
  };
  const body = { expectedVersion: 6, reason: 'suspected_misuse', discoveredBy: 'ordering_facility', discoveredOn: '2026-10-24',
    note };
  const correct = (payload: unknown, idempotencyKey?: string | null) => call(`${routeId}/wrong-patient-correction`, payload,
    idempotencyKey);
  const written = () => JSON.stringify([audit.recordWithClient.mock.calls.map((call) => call.slice(2)),
    ...logged.map((spy) => spy.mock.calls)]);

  it('answers 200 with the reversal, the note nowhere in a row or log', async () => {
    const response = await correct(body);
    expect([response.status, response.body]).toEqual([200, { route: { id: routeId, version: 7, effectiveState: 'completed',
      endedKind: 'support' }, late: true, endedKindBefore: 'support', resultsVoided: 0, resultReportsMarked: 0,
    dispensingReversed: true, correctableUntil: '2027-04-18T10:00:00.000Z', replayed: false }]);
    expect(written()).not.toContain('another woman');
  });

  it('refuses a missing key, a bad body, a short trimmed note and a member without the receive permission', async () => {
    const missing = await correct(body, null);
    expect([missing.status, missing.body?.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    const { discoveredOn: _on, ...withoutDay } = body;
    for (const invalid of [withoutDay, { ...body, discoveredBy: 'nurse' }, { ...body, quantity: 1 }]) {
      const refused = await correct(invalid);
      expect([refused.status, refused.body?.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    const trimmed = await correct({ ...body, note: '   Not her      ' });
    expect([trimmed.status, trimmed.body?.code]).toEqual([400, 'ORDER_ROUTE_INVALID']);
    permissions = ['pharmacy.dispensing.reverse'];
    for (const denied of [await correct(body), await call('correctable', { reference: '123E4567' })]) {
      expect([denied.status, denied.body?.code]).toEqual([403, 'PERMISSION_DENIED']);
    }
    expect(statements).toEqual([]);
  });

  it('answers the reversal permission and the limit with their problem members, at the top level', async () => {
    answer = databaseError('P0001', 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED', 'pharmacy.dispensing.reverse');
    const permission = await correct(body);
    expect([permission.status, permission.body?.code, permission.body?.permission]).toEqual([403,
      'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED', 'pharmacy.dispensing.reverse']);
    answer = databaseError('P0001', 'ORDER_ROUTE_CORRECTION_LIMIT', '2026-10-27T09:14:03.218Z');
    const limited = await correct(body);
    expect([limited.status, limited.body?.code, limited.body?.retryAfter]).toEqual([429, 'ORDER_ROUTE_CORRECTION_LIMIT',
      '2026-10-27T09:14:03.218Z']);
    expect(written()).not.toContain('another woman');
  });

  it('finds by the reference in the body; no match is 200 with no items; a bad reference 400 ORDER_ROUTE_INVALID', async () => {
    answer = [found];
    const hit = await call('correctable', { reference: '123e4567' });
    expect([hit.status, hit.body?.lateCorrection, (hit.body?.items as unknown[]).length]).toEqual([200, true, 1]);
    answer = [];
    const none = await call('correctable', { reference: 'ABCDEF12' });
    expect([none.status, none.body]).toEqual([200, { items: [], lateCorrection: true }]);
    const short = await call('correctable', { reference: '123E456' });
    expect([short.status, short.body?.code]).toEqual([400, 'ORDER_ROUTE_INVALID']);
    const unknown = await call('correctable', { reference: '123E4567', dateOfBirth: '1990-01-01' });
    expect([unknown.status, unknown.body?.code]).toEqual([400, 'VALIDATION_FAILED']);
  });
});
