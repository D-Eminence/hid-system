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
import { AUDIT_ACTION, REQUIRED_PERMISSIONS } from '../common/decorators';
import { requestDigest } from '../common/idempotency';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, DataAccessContext, HidRequest } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { CorrectWrongPatientDto, FindCorrectableDto } from './dto/order-route.dto';
import { correctableLabRoute, correctionAnswer, labOrderRouteProblem, lateCorrectionProblem } from './lab-order-route.mapping';
import { LabOrderRoutesController } from './lab-order-routes.controller';
import { discoveryDay, LabOrderRoutesService } from './lab-order-routes.service';
import { LabOrderRouteCards } from './order-route-cards';

// D17 (SPEC-FINAL §5.1, §8.1, §10.2): the laboratory finds an order it
// accepted by its reference (C30) and withdraws, after the order ended, what
// it recorded on it for someone who was not its patient (C29).
const facilityId = '10000000-0000-4000-8000-000000000001';
const patientId = '50000000-0000-4000-8000-000000000001';
const routeId = 'b0000000-0000-4000-8000-000000000001';
const secondRouteId = 'b0000000-0000-4000-8000-000000000002';
const reportId = 'e0000000-0000-4000-8000-000000000001';
const key = 'late-correction-key-0001';
const note = 'He gave his cousin\'s Health ID at the counter';
const context = { correlationId: 'lab-late-correction-correlation', facilityId,
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care',
  actor: { id: 'actor', subject: 'staff:lab', accountId: '20000000-0000-4000-8000-000000000001', roles: ['lab'],
    permissions: ['lab.order-route.receive'], facilityIds: [facilityId], facilities: [], authenticationMethod: 'local' },
} satisfies DataAccessContext;
const databaseError = (code: string, message: string, detail?: string) =>
  Object.assign(new Error(message), { code, ...(detail === undefined ? {} : { detail }) });

/** C29's row (bigints as text, timestamps as Dates, as node-postgres gives them). */
const corrected = { result: 'corrected', report_id: reportId, route_row_version: '11', route_state: 'completed',
  effective_state: 'completed', ended_kind: 'support', ended_kind_before: 'support', results_voided: 1, result_reports_marked: 1,
  dispensing_reversed: false, state_before: 'completed', correctable_until: new Date('2027-04-18T10:00:00.123Z'),
  patient_id: patientId };

/** C30's row: an order closed by support, still correctable, with the laboratory's own facts. */
const found = { route_id: routeId, reference: 'B0000000', kind: 'lab_request', row_version: '9', effective_state: 'completed',
  ordering_facility_name: 'Ordering Hospital', accepted_at: new Date('2026-10-20T10:00:00Z'),
  completed_at: new Date('2026-10-21T10:00:00Z'), ended_at: new Date('2026-10-22T08:00:00Z'), ended_kind: 'support',
  returned: true, correction_state: 'correctable', correctable_until: new Date('2027-04-18T10:00:00Z'), reported_at: null,
  report_late: null, what_name: 'HbA1c panel', accepted_by_name: 'Remi Lab', accepted_with: 'date_of_birth_with_reference',
  returned_items: [{ at: '2026-10-21T10:00:00.5+00:00', withdrawn: false }] };

const input = (overrides: Partial<CorrectWrongPatientDto> = {}): CorrectWrongPatientDto =>
  ({ expectedVersion: 9, reason: 'someone_elses_details', discoveredBy: 'patient', discoveredOn: '2026-10-25', note,
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

describe('the late correction and the lookup: bodies and routes (C29, C30)', () => {
  const errors = async (type: new () => object, body: unknown) =>
    (await validate(plainToInstance(type, body), { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true }))
      .map((error) => error.property).sort();
  const body = { expectedVersion: 1, reason: 'other', discoveredBy: 'own_check', discoveredOn: '2026-10-25', note };

  it('takes a version, a reason, how and when the laboratory found out, and a note, every one required, nothing else', async () => {
    for (const discoveredBy of ['patient', 'ordering_facility', 'own_check', 'support', 'other']) {
      expect(await errors(CorrectWrongPatientDto, { ...body, discoveredBy })).toEqual([]);
    }
    for (const reason of ['wrong_order_chosen', 'someone_elses_details', 'suspected_misuse', 'other']) {
      expect(await errors(CorrectWrongPatientDto, { ...body, reason })).toEqual([]);
    }
    expect(await errors(CorrectWrongPatientDto, { ...body, discoveredBy: 'colleague' })).toEqual(['discoveredBy']);
    expect(await errors(CorrectWrongPatientDto, { ...body, reason: 'cannot_complete' })).toEqual(['reason']);
    for (const field of ['expectedVersion', 'reason', 'discoveredBy', 'discoveredOn', 'note']) {
      const { [field as keyof typeof body]: _left, ...without } = body;
      expect(await errors(CorrectWrongPatientDto, without)).toEqual([field]);
    }
    for (const discoveredOn of ['25/10/2026', '2026-10-25T00:00:00Z', '2026-1-5', '', 20261025]) {
      expect(await errors(CorrectWrongPatientDto, { ...body, discoveredOn })).toEqual(['discoveredOn']);
    }
    expect(await errors(CorrectWrongPatientDto, { ...body, note: 'Not him' })).toEqual(['note']);
    expect(await errors(CorrectWrongPatientDto, { ...body, note: 'x'.repeat(501) })).toEqual(['note']);
    expect(await errors(CorrectWrongPatientDto, { ...body, note: 'x'.repeat(500) })).toEqual([]);
    expect(await errors(CorrectWrongPatientDto, { ...body, expectedVersion: 0 })).toEqual(['expectedVersion']);
    expect(await errors(CorrectWrongPatientDto, { ...body, expectedVersion: '9' })).toEqual(['expectedVersion']);
    // No patient, reference or confirmation flag reaches the command.
    for (const extra of ['patientId', 'reference', 'confirmed']) {
      expect(await errors(CorrectWrongPatientDto, { ...body, [extra]: extra === 'confirmed' ? true : 'x' })).toEqual([extra]);
    }
  });

  it('takes the lookup\'s reference as a string of 1 to 16 characters, nothing else', async () => {
    expect(await errors(FindCorrectableDto, { reference: 'b0000000' })).toEqual([]);
    expect(await errors(FindCorrectableDto, { reference: ' B0000000 ' })).toEqual([]);
    for (const reference of ['', 'x'.repeat(17), 12345678]) {
      expect(await errors(FindCorrectableDto, { reference })).toEqual(['reference']);
    }
    expect(await errors(FindCorrectableDto, {})).toEqual(['reference']);
    expect(await errors(FindCorrectableDto, { reference: 'B0000000', healthId: 'HID-ABC234' })).toEqual(['healthId']);
    expect(await errors(FindCorrectableDto, { reference: 'B0000000', dateOfBirth: '1990-01-01' })).toEqual(['dateOfBirth']);
  });

  it('needs lab.order-route.receive (the command checks the withdrawal permission), and an Idempotency-Key to correct', () => {
    const prototype = LabOrderRoutesController.prototype;
    expect([Reflect.getMetadata(REQUIRED_PERMISSIONS, prototype.correctWrongPatient),
      Reflect.getMetadata(AUDIT_ACTION, prototype.correctWrongPatient)])
      .toEqual([['lab.order-route.receive'], 'lab.order-route.wrong-patient-correction.request']);
    expect([Reflect.getMetadata(REQUIRED_PERMISSIONS, prototype.findCorrectable),
      Reflect.getMetadata(AUDIT_ACTION, prototype.findCorrectable)])
      .toEqual([['lab.order-route.receive'], 'lab.order-route.correctable.request']);
    // `correctable` is declared before the `:routeId` routes.
    const names = Object.getOwnPropertyNames(prototype);
    expect(names.indexOf('findCorrectable')).toBeLessThan(names.indexOf('get'));
    const service = { correctWrongPatient: jest.fn() };
    const controller = new LabOrderRoutesController(service as never);
    for (const missing of [undefined, '', 'short']) {
      expect(() => controller.correctWrongPatient(routeId, input(), missing, {} as never))
        .toThrow(expect.objectContaining({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    }
    expect(service.correctWrongPatient).not.toHaveBeenCalled();
  });

  it('accepts a calendar day the laboratory found out, and refuses one that is not a date 400 ORDER_ROUTE_INVALID', () => {
    expect(discoveryDay('2026-10-25')).toBe('2026-10-25');
    expect(discoveryDay('2028-02-29')).toBe('2028-02-29');
    for (const day of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10']) {
      expect(() => discoveryDay(day)).toThrow(expect.objectContaining({ status: 400, code: 'ORDER_ROUTE_INVALID' }));
    }
  });
});

describe('LabOrderRoutesService.correctWrongPatient (C29)', () => {
  it('calls the command once, READ COMMITTED, with the trimmed note, the date and a stable digest of the request', async () => {
    const h = harness();
    await h.service.correctWrongPatient(context, routeId, input({ note: `  ${note}  ` }), key);
    const digest = requestDigest('lab.order-route.wrong-patient-correction', { routeId, expectedVersion: 9,
      reason: 'someone_elses_details', discoveredBy: 'patient', discoveredOn: '2026-10-25', note });
    expect(h.statements).toEqual([{ sql: 'select * from lab.correct_wrong_patient_order_route($1, $2, $3, $4, $5::date, $6, $7, $8)',
      values: [routeId, 9, 'someone_elses_details', 'patient', '2026-10-25', note, key, digest] }]);
    expect(h.options).toEqual([{ isolationLevel: 'READ COMMITTED' }]);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // The same request's digest whatever the spacing and key order; another request's otherwise, and never item 3's.
    expect(requestDigest('lab.order-route.wrong-patient-correction', { note, discoveredOn: '2026-10-25', discoveredBy: 'patient',
      reason: 'someone_elses_details', expectedVersion: 9, routeId })).toBe(digest);
    for (const other of [{ discoveredBy: 'support' }, { discoveredOn: '2026-10-24' }, { reason: 'other' }, { expectedVersion: 10 }]) {
      expect(requestDigest('lab.order-route.wrong-patient-correction', { routeId, expectedVersion: 9, reason: 'someone_elses_details',
        discoveredBy: 'patient', discoveredOn: '2026-10-25', note, ...other })).not.toBe(digest);
    }
    expect(requestDigest('lab.order-route.wrong-patient', { routeId, expectedVersion: 9, reason: 'someone_elses_details',
      discoveredBy: 'patient', discoveredOn: '2026-10-25', note })).not.toBe(digest);
    expect(requestDigest('pharmacy.order-route.wrong-patient-correction', { routeId, expectedVersion: 9,
      reason: 'someone_elses_details', discoveredBy: 'patient', discoveredOn: '2026-10-25', note })).not.toBe(digest);
  });

  it('answers the route as the correction left it, late, its earlier ending, the counts and the deadline; never the patient', async () => {
    const h = harness();
    const answer = await h.service.correctWrongPatient(context, routeId, input(), key);
    expect(answer).toEqual({ route: { id: routeId, version: 11, effectiveState: 'completed', endedKind: 'support' }, late: true,
      endedKindBefore: 'support', resultsVoided: 1, resultReportsMarked: 1, dispensingReversed: false,
      correctableUntil: '2027-04-18T10:00:00.123Z', replayed: false });
    expect(typeof answer.route.version).toBe('number');
    expect(JSON.stringify(answer)).not.toMatch(new RegExp(`${patientId}|${reportId}`));
  });

  it('answers an order that had only lapsed ended wrong_patient now, with no earlier ending', async () => {
    const h = harness([{ ...corrected, route_state: 'cancelled', effective_state: 'cancelled', ended_kind: 'wrong_patient',
      ended_kind_before: null, results_voided: 0, result_reports_marked: 0, state_before: 'accepted' }]);
    await expect(h.service.correctWrongPatient(context, routeId, input({ discoveredBy: 'own_check' }), key)).resolves
      .toMatchObject({ route: { effectiveState: 'cancelled', endedKind: 'wrong_patient' }, endedKindBefore: null,
        resultsVoided: 0, resultReportsMarked: 0 });
    expect(h.audits[0]).toMatchObject({ details: expect.objectContaining({ stateBefore: 'accepted', endedKindBefore: null,
      state: 'cancelled', discoveredBy: 'own_check' }) });
  });

  it('writes the laboratory\'s own row with the patient from the command, how and when it found out, never the note', async () => {
    const h = harness();
    await h.service.correctWrongPatient(context, routeId, input(), key);
    expect(h.audits).toEqual([{ correlationId: context.correlationId, actorType: 'staff', actorSubject: 'staff:lab',
      actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId, organizationId: undefined, facilityId,
      patientId, action: 'lab.order-route.wrong-patient-correction', resourceType: 'order-route', resourceId: routeId,
      outcome: 'success', purposeOfUse: 'direct-care', sourceSystem: 'lab-api', details: { routeId, kind: 'lab_request', reportId,
        stateBefore: 'completed', endedKindBefore: 'support', state: 'completed', reasonCode: 'someone_elses_details',
        discoveredBy: 'patient', discoveredOn: '2026-10-25', resultsVoided: 1, dispensingReversed: false, replayed: false,
        late: true } }]);
    expect(JSON.stringify(h.audits)).not.toContain('cousin');
  });

  it('answers a replay with replayed true, the first report\'s counts, and audits it as one', async () => {
    const h = harness([{ ...corrected, result: 'replayed', route_row_version: '12' }]);
    const answer = await h.service.correctWrongPatient(context, routeId, input(), key);
    expect(answer).toMatchObject({ route: { version: 12 }, replayed: true, resultsVoided: 1, late: true });
    expect(h.audits[0]).toMatchObject({ details: expect.objectContaining({ replayed: true }) });
  });

  it('refuses a note shorter than 8 once trimmed and a day that is no date with 400 ORDER_ROUTE_INVALID, before the database',
    async () => {
      const h = harness();
      await expect(h.service.correctWrongPatient(context, routeId, input({ note: '   Not him     ' }), key))
        .rejects.toMatchObject({ status: 400, code: 'ORDER_ROUTE_INVALID' });
      await expect(h.service.correctWrongPatient(context, routeId, input({ discoveredOn: '2026-02-30' }), key))
        .rejects.toMatchObject({ status: 400, code: 'ORDER_ROUTE_INVALID' });
      expect(h.statements).toEqual([]);
      expect(h.audits).toEqual([]);
    });

  it.each([
    [{ result: 'ended' }], [{ ...corrected, result: 'perhaps' }], [{ ...corrected, patient_id: null }],
    [{ ...corrected, route_row_version: null }], [{ ...corrected, ended_kind: null }],
  ])('answers 503 and writes nothing for a row it cannot read (%o)', async (row) => {
    const h = harness([row]);
    await expect(h.service.correctWrongPatient(context, routeId, input(), key))
      .rejects.toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
    expect(h.audits).toEqual([]);
  });

  it('answers 503 when the command returns no row, and fails the correction when its audit row fails', async () => {
    await expect(harness([]).service.correctWrongPatient(context, routeId, input(), key))
      .rejects.toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
    const h = harness();
    h.audit.recordWithClient.mockRejectedValueOnce(databaseError('23514', 'audit refused'));
    await expect(h.service.correctWrongPatient(context, routeId, input(), key))
      .rejects.toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
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
    ['40001', 'could not serialize access due to concurrent update', 409, 'ORDER_ROUTE_CHANGED_CONCURRENTLY'],
    ['40P01', 'deadlock detected', 409, 'ORDER_ROUTE_CHANGED_CONCURRENTLY'],
    ['XX000', 'ORDER_ROUTE_CORRECTION_CAPABILITY_LOST', 503, 'ORDER_ROUTE_UNAVAILABLE'],
    ['P0001', 'SOMETHING_ELSE', 503, 'ORDER_ROUTE_UNAVAILABLE'],
    ['23505', 'duplicate key value violates unique constraint', 503, 'ORDER_ROUTE_UNAVAILABLE'],
  ])('answers %s %s as %i %s, writing no audit row', async (state, message, status, code) => {
    const h = harness(databaseError(state, message));
    await expect(h.service.correctWrongPatient(context, routeId, input(), key)).rejects.toMatchObject({ status, code });
    expect(h.audits).toEqual([]);
  });

  it('answers the missing withdrawal permission 403 naming it, whatever else the detail says', async () => {
    const named = await harness(databaseError('P0001', 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED',
      'lab.result.entered-in-error')).service.correctWrongPatient(context, routeId, input(), key).catch((e: unknown) => e);
    expect(named).toMatchObject({ status: 403, code: 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED',
      extensions: { permission: 'lab.result.entered-in-error' } });
  });

  it('answers the limit 429 with retryAfter, the DETAIL kept only when it is an exact UTC time', async () => {
    const limited = await harness(databaseError('P0001', 'ORDER_ROUTE_CORRECTION_LIMIT', '2026-10-27T09:14:03.218Z'))
      .service.correctWrongPatient(context, routeId, input(), key).catch((e: unknown) => e) as DomainProblem;
    expect(limited).toMatchObject({ status: 429, code: 'ORDER_ROUTE_CORRECTION_LIMIT',
      extensions: { retryAfter: '2026-10-27T09:14:03.218Z' } });
    expect(limited.message).toContain('2026-10-27T09:14:03.218Z');
    for (const detail of [undefined, 'soon', '2026-10-27 09:14:03', '2026-02-30T09:14:03.218Z', '2026-10-27T09:14:03Z']) {
      const problem = lateCorrectionProblem(databaseError('P0001', 'ORDER_ROUTE_CORRECTION_LIMIT', detail)) as DomainProblem;
      expect([problem.getStatus(), problem.code, problem.extensions]).toEqual([429, 'ORDER_ROUTE_CORRECTION_LIMIT', undefined]);
    }
  });

  it('maps 40001 and 40P01 to 409 for the two wrong-patient commands only: the lookup answers them 503', () => {
    expect(lateCorrectionProblem(databaseError('40001', 'x'))).toMatchObject({ status: 409, code: 'ORDER_ROUTE_CHANGED_CONCURRENTLY' });
    expect(labOrderRouteProblem(databaseError('40P01', 'x'))).toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
    expect(correctionAnswer(routeId, { ...corrected, results_voided: null, correctable_until: null }))
      .toMatchObject({ resultsVoided: 0, correctableUntil: null });
  });
});

describe('LabOrderRoutesService.findCorrectable (C30)', () => {
  it('reads by the trimmed, upper-cased reference, READ COMMITTED, and answers each order field by field, no patient', async () => {
    const h = harness([{ ...found, patient_id: patientId, patient_full_name: 'Ngozi Eze', work_item_id: 'w', orderer_name: 'Dr' }]);
    const answer = await h.service.findCorrectable(context, { reference: ' b0000000 ' });
    expect(h.statements).toEqual([{ sql: 'select * from lab.find_correctable_order_routes($1)', values: ['B0000000'] }]);
    expect(h.options).toEqual([{ isolationLevel: 'READ COMMITTED' }]);
    expect(answer).toEqual({ items: [{ id: routeId, reference: 'B0000000', kind: 'lab_request', version: 9,
      effectiveState: 'completed', orderingFacilityName: 'Ordering Hospital', acceptedAt: '2026-10-20T10:00:00.000Z',
      completedAt: '2026-10-21T10:00:00.000Z', endedAt: '2026-10-22T08:00:00.000Z', endedKind: 'support', returned: true,
      correction: 'correctable', correctableUntil: '2027-04-18T10:00:00.000Z', wrongPatient: null,
      details: { what: 'HbA1c panel', acceptedBy: 'Remi Lab', acceptedWith: 'date_of_birth_with_reference',
        returned: [{ at: '2026-10-21T10:00:00.500Z', withdrawn: false }] } }], lateCorrection: true });
    expect(JSON.stringify(answer)).not.toMatch(new RegExp(`${patientId}|Ngozi|"w"|Dr"`));
  });

  it('audits each lookup without a patient or the reference, with the routes found and their states', async () => {
    const h = harness([found, { ...found, route_id: secondRouteId, correction_state: 'too_late', what_name: null,
      accepted_by_name: null, accepted_with: null, returned_items: null }]);
    await h.service.findCorrectable(context, { reference: 'B0000000' });
    expect(h.audits).toEqual([{ correlationId: context.correlationId, actorType: 'staff', actorSubject: 'staff:lab',
      actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId, organizationId: undefined, facilityId,
      action: 'lab.order-route.correctable', resourceType: 'order-route-collection', resourceId: facilityId, outcome: 'success',
      purposeOfUse: 'direct-care', sourceSystem: 'lab-api',
      details: { found: 2, states: ['correctable', 'too_late'], routeIds: [routeId, secondRouteId] } }]);
    expect(h.audits[0]).not.toHaveProperty('patientId');
    expect(JSON.stringify(h.audits)).not.toMatch(/B0000000|HbA1c|Remi/);
  });

  it('answers 200 { items: [] } for a reference no order accepted here carries, never 404, and audits the empty lookup', async () => {
    const h = harness([]);
    await expect(h.service.findCorrectable(context, { reference: 'ABCDEF12' })).resolves.toEqual({ items: [],
      lateCorrection: true });
    expect(h.audits).toEqual([expect.objectContaining({ action: 'lab.order-route.correctable',
      details: { found: 0, states: [], routeIds: [] } })]);
  });

  it('gives the details only while the order is open or correctable, and B\'s report as wrongPatient', () => {
    const reported = correctableLabRoute({ ...found, correction_state: 'reported', reported_at: new Date('2026-10-26T08:00:00Z'),
      report_late: true });
    expect(reported).toMatchObject({ correction: 'reported', details: null,
      wrongPatient: { reportedAt: '2026-10-26T08:00:00.000Z', late: true } });
    expect(correctableLabRoute({ ...found, correction_state: 'too_late' })?.details).toBeNull();
    expect(correctableLabRoute({ ...found, correction_state: 'open', returned: false, completed_at: null, returned_items: [] }))
      .toMatchObject({ correction: 'open', returned: false, details: { what: 'HbA1c panel', returned: [] } });
    expect(correctableLabRoute({ ...found, what_name: null })?.details).toBeNull();
    expect(correctableLabRoute({ ...found, reported_at: new Date('2026-10-20T11:00:00Z'), report_late: false })?.wrongPatient)
      .toEqual({ reportedAt: '2026-10-20T11:00:00.000Z', late: false });
    // jsonb as text, at most 20, entries that are not objects dropped.
    const many = Array.from({ length: 25 }, (_, index) => ({ at: `2026-10-21T10:${String(index).padStart(2, '0')}:00Z`,
      withdrawn: index % 2 === 0 }));
    expect(correctableLabRoute({ ...found, returned_items: JSON.stringify([...many.slice(0, 3), 'x', null]) })?.details?.returned)
      .toEqual(many.slice(0, 3).map((item) => ({ at: new Date(item.at).toISOString(), withdrawn: item.withdrawn })));
    expect(correctableLabRoute({ ...found, returned_items: many })?.details?.returned).toHaveLength(20);
    expect(correctableLabRoute({ ...found, route_id: null })).toBeUndefined();
  });

  it.each(['', '   ', 'B000000', 'B00000000', 'G0000000', 'B000-000'])(
    'refuses the reference %p 400 ORDER_ROUTE_INVALID before the database', async (reference) => {
      const h = harness();
      await expect(h.service.findCorrectable(context, { reference })).rejects.toMatchObject({ status: 400,
        code: 'ORDER_ROUTE_INVALID' });
      expect(h.statements).toEqual([]);
      expect(h.audits).toEqual([]);
    });

  it.each([
    ['42501', 'Order route staff context is required', 403, 'PERMISSION_DENIED'],
    ['22023', 'ORDER_ROUTE_INVALID', 400, 'ORDER_ROUTE_INVALID'],
    ['55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE'],
    ['42883', 'function lab.find_correctable_order_routes(unknown) does not exist', 503, 'ORDER_ROUTE_UNAVAILABLE'],
  ])('answers %s %s as %i %s, writing no audit row', async (state, message, status, code) => {
    const h = harness(databaseError(state, message));
    const problem = await h.service.findCorrectable(context, { reference: 'B0000000' }).catch((e: unknown) => e);
    expect(problem).toMatchObject({ status, code });
    expect((problem as DomainProblem).code).not.toBe('ORDER_ROUTE_LOOKUP_INVALID');
    expect(h.audits).toEqual([]);
  });

  it('answers 503 for a row without a route id, writing no audit row', async () => {
    const h = harness([{ ...found, route_id: null }]);
    await expect(h.service.findCorrectable(context, { reference: 'B0000000' })).rejects.toMatchObject({ status: 503 });
    expect(h.audits).toEqual([]);
  });
});

// Over HTTP: the module's controller and service, the validation pipe, the
// interceptor and the problem filter as main.ts and AppModule set them; a
// guard that binds the session as the real one does (and checks the route's
// permissions), a fake database and audit store recording every call.
describe('the late correction and the lookup over HTTP', () => {
  const actor = (permissions: string[]): ActorContext => ({ kind: 'staff', id: 'staff:lab', subject: 'staff:lab',
    accountId: '20000000-0000-4000-8000-000000000001', roles: ['lab'], permissions, facilityIds: [facilityId],
    authenticationMethod: 'local', facilities: [{ id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
      organizationId: '30000000-0000-4000-8000-000000000001', name: 'Synthetic Laboratory', roles: ['lab'], permissions,
      isPrimary: true }] });
  let permissions = ['lab.order-route.receive', 'lab.result.entered-in-error'];
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
  class LateCorrectionHttpModule {}

  let app: INestApplication;
  const logged = (['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const)
    .map((level) => jest.spyOn(Logger.prototype, level));

  beforeEach(async () => {
    jest.clearAllMocks();
    statements.length = 0;
    permissions = ['lab.order-route.receive', 'lab.result.entered-in-error'];
    answer = [corrected];
    const moduleRef = await Test.createTestingModule({ imports: [LateCorrectionHttpModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use((incoming: HidRequest, _response: unknown, next: () => void) => { incoming.correlationId = 'lab-late-http-0001'; next(); });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
    for (const spy of logged) spy.mockClear();
  });

  afterEach(async () => { await app.close(); });

  const body = { expectedVersion: 9, reason: 'someone_elses_details', discoveredBy: 'patient', discoveredOn: '2026-10-25', note };
  const post = (payload: unknown, idempotencyKey: string | null = key) => {
    const call = request(app.getHttpServer()).post(`/api/v1/lab/order-routes/${routeId}/wrong-patient-correction`)
      .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId).set('X-Purpose-Of-Use', 'direct-care');
    return (idempotencyKey ? call.set('Idempotency-Key', idempotencyKey) : call).send(payload as object);
  };
  const find = (payload: unknown) => request(app.getHttpServer()).post('/api/v1/lab/order-routes/correctable')
    .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId).set('X-Purpose-Of-Use', 'direct-care')
    .send(payload as object);
  /** Every audit row and log line of the requests so far, as text. */
  const written = () => JSON.stringify([audit.record.mock.calls, audit.recordWithClient.mock.calls.map(([, event]) => event),
    ...logged.map((spy) => spy.mock.calls)]);

  it('answers 200 with the corrected route; the request row carries no body, the command row no note', async () => {
    const response = await post(body);
    expect([response.status, response.body]).toEqual([200, { route: { id: routeId, version: 11, effectiveState: 'completed',
      endedKind: 'support' }, late: true, endedKindBefore: 'support', resultsVoided: 1, resultReportsMarked: 1,
    dispensingReversed: false, correctableUntil: '2027-04-18T10:00:00.123Z', replayed: false }]);
    expect(statements[0]?.values.slice(0, 7)).toEqual([routeId, 9, 'someone_elses_details', 'patient', '2026-10-25', note, key]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'api.lab.order-route.wrong-patient-correction.request', outcome: 'success', resourceType: 'http-request' }));
    expect(audit.recordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
      action: 'lab.order-route.wrong-patient-correction', patientId }));
    expect(written()).not.toContain('cousin');
  });

  it('refuses a missing key, a bad body and an unknown field with 400 before the database', async () => {
    const missing = await post(body, null);
    expect([missing.status, missing.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    const { discoveredBy: _by, ...withoutDiscoveredBy } = body;
    for (const invalid of [withoutDiscoveredBy, { ...body, discoveredBy: 'colleague' }, { ...body, reason: 'busy' },
      { ...body, discoveredOn: '25/10/2026' }, { ...body, note: 'Not him' }, { ...body, patientId }]) {
      const refused = await post(invalid);
      expect([refused.status, refused.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    const trimmed = await post({ ...body, note: '    Not him     ' });
    expect([trimmed.status, trimmed.body.code]).toEqual([400, 'ORDER_ROUTE_INVALID']);
    const notADay = await post({ ...body, discoveredOn: '2026-02-30' });
    expect([notADay.status, notADay.body.code]).toEqual([400, 'ORDER_ROUTE_INVALID']);
    expect(statements).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'api.lab.order-route.wrong-patient-correction.request', outcome: 'failure' }));
    expect(written()).not.toMatch(/Not him|cousin/);
  });

  it('refuses a member without lab.order-route.receive 403 before the database, on both routes', async () => {
    permissions = ['lab.result.entered-in-error', 'lab.work-item.read'];
    for (const denied of [await post(body), await find({ reference: 'B0000000' })]) {
      expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    }
    expect(statements).toEqual([]);
  });

  it('answers the missing withdrawal permission 403 with the permission as a problem member, logging only the SQLSTATE',
    async () => {
      answer = databaseError('P0001', 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED', 'lab.result.entered-in-error');
      const refused = await post(body);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED',
        permission: 'lab.result.entered-in-error' });
      expect(refused.body).not.toHaveProperty('extensions');
      expect(refused.text).not.toMatch(/P0001|cousin/);
      expect(written()).not.toContain('cousin');
    });

  it('answers the limit 429 with retryAfter as a problem member', async () => {
    answer = databaseError('P0001', 'ORDER_ROUTE_CORRECTION_LIMIT', '2026-10-27T09:14:03.218Z');
    const limited = await post(body);
    expect([limited.status, limited.body.code, limited.body.retryAfter]).toEqual([429, 'ORDER_ROUTE_CORRECTION_LIMIT',
      '2026-10-27T09:14:03.218Z']);
    expect(limited.body).not.toHaveProperty('extensions');
  });

  it.each([
    ['P0001', 'ORDER_ROUTE_STILL_OPEN', 409], ['P0001', 'ORDER_ROUTE_ALREADY_REPORTED', 409],
    ['P0001', 'ORDER_ROUTE_CORRECTION_TOO_LATE', 409], ['P0001', 'ORDER_ROUTE_NOT_ACCEPTED', 409],
    ['P0001', 'ORDER_ROUTE_VERSION_CONFLICT', 412], ['40P01', 'deadlock detected', 409],
    ['XX000', 'ORDER_ROUTE_CORRECTION_CAPABILITY_LOST', 503],
  ])('answers %s %s with %i, the note in no log line or audit row', async (state, message, status) => {
    answer = databaseError(state, message);
    const refused = await post(body);
    expect(refused.status).toBe(status);
    expect(written()).not.toContain('cousin');
  });

  it('finds by the reference in the body: 200 with the items and lateCorrection; no match is 200 with no items', async () => {
    answer = [found];
    const response = await find({ reference: 'b0000000' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ items: [{ id: routeId, correction: 'correctable', details: { what: 'HbA1c panel' } }],
      lateCorrection: true });
    expect(statements[0]?.values).toEqual(['B0000000']);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api.lab.order-route.correctable.request',
      outcome: 'success' }));
    answer = [];
    const none = await find({ reference: 'ABCDEF12' });
    expect([none.status, none.body]).toEqual([200, { items: [], lateCorrection: true }]);
    // The reference is in no audit row: the lookup's row names the routes by id, and a reference is its id's first
    // 8 hex digits, so look with the ids taken out.
    expect(written().split(routeId).join('<route id>')).not.toMatch(/B0000000|b0000000|ABCDEF12/);
  });

  it('refuses a bad lookup body 400 VALIDATION_FAILED and a bad reference 400 ORDER_ROUTE_INVALID, never LOOKUP_INVALID',
    async () => {
      for (const invalid of [{}, { reference: '' }, { reference: 12345678 }, { reference: 'B0000000', healthId: 'HID-ABC234' }]) {
        const refused = await find(invalid);
        expect([refused.status, refused.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
      const short = await find({ reference: 'B000000' });
      expect([short.status, short.body.code]).toEqual([400, 'ORDER_ROUTE_INVALID']);
      expect(statements).toEqual([]);
      answer = databaseError('55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled');
      const paused = await find({ reference: 'B0000000' });
      expect([paused.status, paused.body.code]).toEqual([423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE']);
    });

  it('routes POST correctable to the lookup, not to a route id (a route id is a version-4 UUID)', async () => {
    answer = [];
    const lookup = await find({ reference: 'B0000000' });
    expect(lookup.status).toBe(200);
    const notARoute = await request(app.getHttpServer()).post('/api/v1/lab/order-routes/correctable/wrong-patient-correction')
      .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId).set('X-Purpose-Of-Use', 'direct-care')
      .set('Idempotency-Key', key).send(body);
    expect(notARoute.status).toBe(400);
    expect(statements.filter((call) => call.sql.includes('correct_wrong_patient'))).toEqual([]);
  });
});
