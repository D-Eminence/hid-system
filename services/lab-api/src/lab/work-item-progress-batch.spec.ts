import 'reflect-metadata';
import { ForbiddenException, HttpException, Logger, RequestMethod } from '@nestjs/common';
import { HEADERS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AUDIT_ACTION, INTERNAL_CALLER, READ_ONLY_POST, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { IdentityService } from '../identity/identity.service';
import type { AuthorizationDecision, AuthorizationRequest } from '../identity/identity.types';
import { LabWorkItemProgressBatchDto, WORK_ITEM_PROGRESS_BATCH_MAX_PATIENTS, WORK_ITEM_PROGRESS_MAX_IDS,
  progressBatchProblems } from './dto/work-item-progress.dto';
import { LabWorkItemProgressController } from './work-item-progress.controller';
import { LAB_WORK_ITEM_PROGRESS_QUERY, LabWorkItemProgressService, PROGRESS_BATCH_CHECK_BUDGET_MS,
  PROGRESS_BATCH_CHECK_CONCURRENCY } from './work-item-progress.service';

// Fictional ids only. Patients, lab requests and work items each have their own range.
const patient = (n: number) => `8b2d1e3f-0000-4000-8000-1${String(n).padStart(11, '0')}`;
const order = (n: number) => `8b2d1e3f-0000-4000-8000-2${String(n).padStart(11, '0')}`;
const work = (n: number) => `8b2d1e3f-0000-4000-8000-3${String(n).padStart(11, '0')}`;
const facility = '8b2d1e3f-0000-4000-8000-000000000002';
const account = '8b2d1e3f-0000-4000-8000-000000000003';
const membership = '8b2d1e3f-0000-4000-8000-000000000004';

const context = { correlationId: 'lab-progress-batch-correlation', facilityId: facility, membershipId: membership,
  purposeOfUse: 'direct-care', authorization: 'Bearer doctor', actor: { id: account, subject: 'staff:doctor',
    accountId: account, roles: ['doctor'], permissions: ['ehr.lab-request.read'], facilityIds: [facility],
    facilities: [], authenticationMethod: 'local' } } satisfies DataAccessContext;
const allowedFor = (patientId: string): AuthorizationDecision => ({ allowed: true, patientId, facilityId: facility,
  membershipId: membership, scope: 'read_records', purpose: 'direct-care', breakGlass: false });

interface Row {
  work_item_id: string; source_ehr_order_id: string; accepted_at: Date; collected_at: Date | null;
  test_count: number; released_count: number; released_at: Date | null;
}
const at = (time: string) => new Date(`2026-11-18T${time}:00Z`);
const row = (workItem: string, sourceOrder: string, fields: Partial<Row> = {}): Row => ({ work_item_id: workItem,
  source_ehr_order_id: sourceOrder, accepted_at: at('09:00'), collected_at: null, test_count: 1, released_count: 0,
  released_at: null, ...fields });

type Decide = (patientId: string, signal: AbortSignal) => unknown;

/**
 * The service with a fake database that answers, like the statement, only the
 * rows of the patient in $1 whose lab request is in $3 (letter case ignored,
 * as Postgres reads a uuid), and a fake Identity decided per patient. Each
 * transaction gets its own client, so a test can tell which one wrote a row.
 */
function harness(rowsByPatient: Record<string, Row[]>, decide: Decide = (patientId) => allowedFor(patientId)) {
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    if (sql !== LAB_WORK_ITEM_PROGRESS_QUERY) return { rows: [] };
    const [patientId, , ids] = params as [string, string, string[]];
    const asked = new Set(ids.map((id) => id.toLowerCase()));
    return { rows: (rowsByPatient[patientId.toLowerCase()] ?? [])
      .filter((candidate) => asked.has(candidate.source_ehr_order_id.toLowerCase())) };
  });
  const clients: Array<{ transaction: number; query: typeof query }> = [];
  const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => unknown) => {
    const client = { transaction: clients.length + 1, query };
    clients.push(client);
    return operation(client);
  }) };
  const identity = { authorize: jest.fn(async (patientId: string, _scope: string, _purpose: string,
    _context: DataAccessContext, options?: { signal?: AbortSignal }) =>
    decide(patientId, options?.signal as AbortSignal)) };
  const audit = { recordWithClient: jest.fn() };
  const service = new LabWorkItemProgressService(database as never, identity as never, audit as never);
  return { service, query, database, identity, audit };
}

type AuditCall = [{ transaction: number }, { patientId: string; outcome: string; details: Record<string, unknown> }];
const auditCalls = (audit: { recordWithClient: jest.Mock }) => audit.recordWithClient.mock.calls as AuditCall[];
const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => jest.restoreAllMocks());

describe('POST lab/work-items/progress/batch (ORD-3, decision 4): route', () => {
  it('B1: is for ehr-api only, read-only, with the EHR read permission and an audit action of its own', () => {
    const handler = LabWorkItemProgressController.prototype.readBatch;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('progress/batch');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(INTERNAL_CALLER, handler)).toBe('ehr-api');
    expect(Reflect.getMetadata(READ_ONLY_POST, handler)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['ehr.lab-request.read']);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
    expect(Reflect.getMetadata(AUDIT_ACTION, handler)).toBe('lab.work-item.progress.batch.request');
    expect(Reflect.getMetadata(PATH_METADATA, LabWorkItemProgressController)).toBe('lab/work-items');
    expect(Reflect.getMetadata(PATH_METADATA, LabWorkItemProgressController.prototype.read)).toBe('progress');
    expect(Reflect.getMetadata(AUDIT_ACTION, LabWorkItemProgressController.prototype.read))
      .toBe('lab.work-item.progress.request');
  });

  it('B1: hands the service the request context and the body', async () => {
    const progress = { readBatch: jest.fn().mockResolvedValue({ patients: [] }) };
    const controller = new LabWorkItemProgressController(progress as never);
    const headers: Record<string, string> = { cookie: 'hid_access=opaque', 'x-purpose-of-use': 'direct-care' };
    const request = { method: 'POST', correlationId: context.correlationId, facilityId: facility, actor: context.actor,
      header: (name: string) => headers[name.toLowerCase()] };
    const input = { patients: [{ patientId: patient(1), sourceEhrOrderIds: [order(1)] }] };
    await controller.readBatch(input, request as unknown as HidRequest);
    expect(progress.readBatch).toHaveBeenCalledWith(expect.objectContaining({ correlationId: context.correlationId,
      facilityId: facility, purposeOfUse: 'direct-care' }), input);
  });
});

describe('POST lab/work-items/progress/batch: body', () => {
  const check = (body: unknown) => validate(plainToInstance(LabWorkItemProgressBatchDto, body),
    { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
  const ids = (from: number, count: number) => Array.from({ length: count }, (_, index) => order(from + index));
  const entry = (n: number, sourceEhrOrderIds: string[]) => ({ patientId: patient(n), sourceEhrOrderIds });
  const batch = (...patients: unknown[]) => ({ patients });
  const on = async (body: unknown) => (await check(body)).map((error) => error.property);
  const problems = async (body: unknown) => (await check(body))
    .flatMap((error) => (error.constraints?.workItemProgressBatch ? [error.constraints.workItemProgressBatch] : []));

  it('B2: takes 50 patients of 2 ids (100 in all), and one patient of 100 ids', async () => {
    expect(WORK_ITEM_PROGRESS_BATCH_MAX_PATIENTS).toBe(50);
    expect(await check(batch(...Array.from({ length: 50 }, (_, index) => entry(index, ids(index * 2, 2))))))
      .toEqual([]);
    expect(await check(batch(entry(1, ids(0, WORK_ITEM_PROGRESS_MAX_IDS))))).toEqual([]);
  });

  it('B3: refuses an empty or too long list, and more than 100 ids in all', async () => {
    expect(await on(batch())).toEqual(['patients']);
    expect(await on(batch(...Array.from({ length: 51 }, (_, index) => entry(index, ids(index, 1))))))
      .toEqual(['patients']);
    expect(await on(batch(entry(1, ids(0, 51)), entry(2, ids(51, 50))))).toEqual(['patients']);
    expect(await problems(batch(entry(1, ids(0, 51)), entry(2, ids(51, 50)))))
      .toEqual(['patients must hold at most 100 ids in all']);
  });

  it('B3: holds every entry to the one-patient rules', async () => {
    expect(await on(batch(entry(1, [])))).toEqual(['patients']);
    expect(await on(batch(entry(1, ids(0, 101))))).toEqual(['patients']);
    expect(await on(batch({ patientId: 'HID-ABC123', sourceEhrOrderIds: [order(1)] }))).toEqual(['patients']);
    expect(await on(batch(entry(1, ['not-a-uuid'])))).toEqual(['patients']);
    expect(await on(batch({ ...entry(1, [order(1)]), healthId: 'HID-ABC123' }))).toEqual(['patients']);
  });

  it('B3: refuses a patient twice and an id twice, whatever the letter case', async () => {
    expect(await problems(batch(entry(1, [order(1)]), { patientId: patient(1).toUpperCase(),
      sourceEhrOrderIds: [order(2)] }))).toEqual(['patients must name each patient once']);
    expect(await problems(batch(entry(1, [order(1)]), entry(2, [order(1).toUpperCase()]))))
      .toEqual(['patients must name each id once']);
    expect(await problems(batch(entry(1, [order(1), order(1).toUpperCase()]))))
      .toEqual(['patients must name each id once']);
  });

  it('B3: refuses another field at either level, a list that is not one, and an entry not an object', async () => {
    expect(await on({ ...batch(entry(1, [order(1)])), healthId: 'HID-ABC123' })).toEqual(['healthId']);
    expect(await on({ patients: entry(1, [order(1)]) })).toEqual(['patients']);
    expect(await on(batch('8b2d1e3f-0000-4000-8000-100000000001'))).toEqual(['patients']);
    // An entry that is itself an array of valid bodies, which ValidateNested alone would take body by body, past the
    // rules across the body (order 1 twice here): refused as not an object, and by that rule alone.
    expect((await check(batch([entry(1, [order(1)]), entry(2, [order(1)])]))).map((error) => [error.property,
      error.constraints])).toEqual([['patients', { isObject: 'each value in patients must be an object' }]]);
  });

  it('B4: names every rule that fails, in order, in one message', async () => {
    expect(progressBatchProblems([entry(1, [order(1)]), entry(2, [order(2)])], 'sourceEhrOrderIds')).toEqual([]);
    const everything = [entry(1, ids(0, 60)), { patientId: patient(1).toUpperCase(), sourceEhrOrderIds: ids(59, 42) }];
    expect(progressBatchProblems(everything, 'sourceEhrOrderIds')).toEqual(['patients must hold at most 100 ids in all',
      'patients must name each patient once', 'patients must name each id once']);
    expect(await problems(batch(...everything))).toEqual(['patients must hold at most 100 ids in all; '
      + 'patients must name each patient once; patients must name each id once']);
    expect(progressBatchProblems({ patients: [] }, 'sourceEhrOrderIds')).toEqual([]);
    expect(progressBatchProblems(undefined, 'sourceEhrOrderIds')).toEqual([]);
    expect(progressBatchProblems(['a', 1, null, [order(1)], entry(1, [order(1)])], 'sourceEhrOrderIds')).toEqual([]);
    // Another field's ids are not this service's ids.
    expect(progressBatchProblems([{ patientId: patient(1), sourceEhrPrescriptionIds: ids(0, 101) }],
      'sourceEhrOrderIds')).toEqual([]);
  });
});

describe('POST lab/work-items/progress/batch: checks', () => {
  it('B5: refuses any purpose but direct care before any check or transaction', async () => {
    for (const purposeOfUse of ['emergency', 'healthcare-operations'] as const) {
      const { service, identity, database } = harness({});
      await expect(service.readBatch({ ...context, purposeOfUse },
        { patients: [{ patientId: patient(1), sourceEhrOrderIds: [order(1)] }] }))
        .rejects.toMatchObject({ status: 400, code: 'PURPOSE_OF_USE_REQUIRED',
          message: 'X-Purpose-Of-Use must be direct-care for this route' });
      expect(identity.authorize).not.toHaveBeenCalled();
      expect(database.withTransaction).not.toHaveBeenCalled();
    }
  });

  it('B6: checks each patient once, in the order asked, as a GET read with the budget\'s signal', async () => {
    const { service, identity } = harness({});
    const internal: DataAccessContext = { ...context, requestMethod: 'POST' };
    await service.readBatch(internal, { patients: [3, 1, 2].map((n) => ({ patientId: patient(n),
      sourceEhrOrderIds: [order(n)] })) });
    expect(identity.authorize.mock.calls.map((call) => call[0])).toEqual([patient(3), patient(1), patient(2)]);
    for (const n of [3, 1, 2]) {
      expect(identity.authorize).toHaveBeenCalledWith(patient(n), 'read_records', 'direct-care',
        { ...internal, requestMethod: 'GET' }, { signal: expect.any(AbortSignal) });
    }
    expect(internal.requestMethod).toBe('POST');
  });

  it('B7: never has more than 4 checks in flight, and checks every patient', async () => {
    expect(PROGRESS_BATCH_CHECK_CONCURRENCY).toBe(4);
    expect(PROGRESS_BATCH_CHECK_BUDGET_MS).toBe(2_000);
    let inFlight = 0;
    let most = 0;
    const waiting: Array<() => void> = [];
    const { service, identity } = harness({}, (patientId) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      return new Promise((resolve) => waiting.push(() => { inFlight -= 1; resolve(allowedFor(patientId)); }));
    });
    const patients = Array.from({ length: 9 }, (_, index) => ({ patientId: patient(index),
      sourceEhrOrderIds: [order(index)] }));
    const answer = service.readBatch(context, { patients });
    while (identity.authorize.mock.calls.length < 9 || waiting.length > 0) {
      await flush();
      expect(inFlight).toBeLessThanOrEqual(4);
      waiting.shift()?.();
    }
    expect((await answer).patients.map((entry) => entry.outcome)).toEqual(Array(9).fill('answered'));
    expect(identity.authorize).toHaveBeenCalledTimes(9);
    expect(most).toBe(4);
  });
});

describe('POST lab/work-items/progress/batch: answers', () => {
  it('B8: answers each patient by its own check; one refused or failed patient never refuses the call', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const [a, b, c, d, e, f, g] = [1, 2, 3, 4, 5, 6, 7].map(patient) as [string, string, string, string, string,
      string, string];
    const decisions: Record<string, () => unknown> = {
      [a]: () => allowedFor(a),
      [b]: () => ({ ...allowedFor(b), allowed: false }),
      [c]: () => { throw new DomainProblem(403, 'CONSENT_REQUIRED', 'Consent is required'); },
      [d]: () => { throw new DomainProblem(503, 'IDENTITY_SERVICE_UNAVAILABLE', 'Unavailable'); },
      [e]: () => { throw new DomainProblem(502, 'INVALID_IDENTITY_RESPONSE', 'Invalid'); },
      [f]: () => ({ ...allowedFor(f), breakGlass: true }),
      [g]: () => { throw new Error(`failed for ${g}`); },
    };
    const { service, query, database, audit } = harness({
      [a]: [row(work(1), order(1))], [b]: [row(work(2), order(2))], [c]: [row(work(3), order(3))],
      [f]: [row(work(6), order(6))] }, (patientId) => decisions[patientId]!());
    const patients = [a, b, c, d, e, f, g].map((patientId, index) => ({ patientId,
      sourceEhrOrderIds: [order(index + 1), order(index + 11)] }));
    const answer = await service.readBatch(context, { patients });

    expect(answer).toEqual({ patients: [
      { patientId: a, outcome: 'answered', items: [
        { sourceEhrOrderId: order(1), status: 'received', receivedAt: '2026-11-18T09:00:00.000Z', collectedAt: null,
          lastResultAt: null },
        { sourceEhrOrderId: order(11), status: 'not_received', receivedAt: null, collectedAt: null,
          lastResultAt: null }] },
      { patientId: b, outcome: 'denied', code: 'LAB_WORK_ITEM_ACCESS_DENIED' },
      { patientId: c, outcome: 'denied', code: 'CONSENT_REQUIRED' },
      { patientId: d, outcome: 'unavailable', code: 'IDENTITY_SERVICE_UNAVAILABLE' },
      { patientId: e, outcome: 'unavailable', code: 'INVALID_IDENTITY_RESPONSE' },
      { patientId: f, outcome: 'unavailable', code: 'INVALID_IDENTITY_RESPONSE' },
      { patientId: g, outcome: 'unavailable', code: 'PROGRESS_CHECK_FAILED' }] });
    expect(answer.patients.filter((entry) => 'items' in entry).map((entry) => entry.patientId)).toEqual([a]);
    expect(answer.patients.map((entry) => Object.keys(entry))).toEqual([['patientId', 'outcome', 'items'],
      ...Array(6).fill(['patientId', 'outcome', 'code'])]);

    // The denials first, in their own transaction; then the one read.
    expect(database.withTransaction).toHaveBeenCalledTimes(2);
    expect(auditCalls(audit).map(([client, event]) => [client.transaction, event.patientId, event.outcome,
      event.details])).toEqual([
      [1, b, 'denied', { requestedCount: 2, reason: 'identity_authorization', via: 'batch' }],
      [1, c, 'denied', { requestedCount: 2, reason: 'identity_refusal', via: 'batch' }],
      [2, a, 'success', { requestedCount: 2, foundCount: 1, workItemIds: [work(1)], breakGlass: false,
        via: 'batch' }]]);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'lab.work-item.progress.read', resourceType: 'lab-work-item-collection', resourceId: facility }));

    // Only the allowed patient's statement runs, and no other patient's ids reach any statement.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(LAB_WORK_ITEM_PROGRESS_QUERY, [a, facility, [order(1), order(11)]]);
    const parameters = JSON.stringify(query.mock.calls.map((call) => call[1]));
    for (const other of patients.slice(1)) {
      expect(parameters).not.toContain(other.patientId);
      for (const id of other.sourceEhrOrderIds) expect(parameters).not.toContain(id);
    }

    // The unexpected failure is logged by its name only, never an id.
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith({ message: 'Own progress check failed',
      correlationId: context.correlationId, errorName: 'Error' });
    const logged = JSON.stringify([error.mock.calls, warn.mock.calls, log.mock.calls]);
    for (const asked of patients) {
      expect(logged).not.toContain(asked.patientId);
      for (const id of asked.sourceEhrOrderIds) expect(logged).not.toContain(id);
    }
  });

  it('B8: Identity\'s 403 without a code is ACCESS_DENIED, and another HttpException is a failed check', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, audit, database } = harness({}, (patientId) => {
      if (patientId === patient(1)) throw new ForbiddenException('Forbidden');
      throw new HttpException('Bad gateway', 502);
    });
    const answer = await service.readBatch(context, { patients: [
      { patientId: patient(1), sourceEhrOrderIds: [order(1)] },
      { patientId: patient(2), sourceEhrOrderIds: [order(2)] }] });
    expect(answer.patients).toEqual([{ patientId: patient(1), outcome: 'denied', code: 'ACCESS_DENIED' },
      { patientId: patient(2), outcome: 'unavailable', code: 'PROGRESS_CHECK_FAILED' }]);
    expect(database.withTransaction).toHaveBeenCalledTimes(1);
    expect(auditCalls(audit).map(([, event]) => [event.patientId, event.outcome, event.details])).toEqual([
      [patient(1), 'denied', { requestedCount: 1, reason: 'identity_refusal', via: 'batch' }]]);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ errorName: 'HttpException' }));
  });

  it('B9: each answered entry is exactly the one-patient answer, audited the same way plus via', async () => {
    const rows: Record<string, Row[]> = {
      [patient(1)]: [
        row(work(1), order(1)),
        row(work(2), order(2), { accepted_at: at('09:01'), collected_at: at('09:30'), test_count: 2 }),
        row(work(3), order(3), { accepted_at: at('09:02'), collected_at: at('09:31'), test_count: 2,
          released_count: 1, released_at: at('10:15') })],
      [patient(2)]: [
        row(work(4), order(4), { accepted_at: at('09:03'), collected_at: at('09:32'), released_count: 1,
          released_at: at('11:05') }),
        row(work(5), order(5), { test_count: 0 })],
    };
    const patients = [
      { patientId: patient(1), sourceEhrOrderIds: [order(9), order(3), order(2), order(1)] },
      { patientId: patient(2), sourceEhrOrderIds: [order(5), order(4), order(8)] }];
    const batch = harness(rows);
    const answer = await batch.service.readBatch(context, { patients });
    const statuses = answer.patients.flatMap((entry) => ('items' in entry
      ? entry.items.map((item) => item.status) : []));
    expect(new Set(statuses)).toEqual(new Set(['not_received', 'received', 'sample_collected', 'some_results_ready',
      'results_ready']));
    const successRows = auditCalls(batch.audit).map(([, event]) => event);
    for (const [index, entry] of patients.entries()) {
      const single = harness(rows);
      const alone = await single.service.read(context, entry);
      expect(answer.patients[index]).toEqual({ patientId: entry.patientId, outcome: 'answered', items: alone.items });
      const [, readEvent] = auditCalls(single.audit)[0]!;
      expect(successRows[index]).toEqual({ ...readEvent, details: { ...readEvent.details, via: 'batch' } });
      expect(Object.keys(successRows[index]!.details)).toEqual(['requestedCount', 'foundCount', 'workItemIds',
        'breakGlass', 'via']);
    }
  });

  it('B10: reads each patient with its own statement, so a lab request sent under another patient is not received',
    async () => {
      const [a, b] = [patient(1), patient(2)];
      const { service, query, audit } = harness({ [a]: [row(work(1), order(1))],
        [b]: [row(work(2), order(2)), row(work(3), order(3), { collected_at: at('09:30') })] });
      // B's lab request order(2) asked under A.
      const answer = await service.readBatch(context, { patients: [
        { patientId: a, sourceEhrOrderIds: [order(2)] },
        { patientId: b, sourceEhrOrderIds: [order(3)] }] });
      expect(answer.patients).toEqual([
        { patientId: a, outcome: 'answered', items: [{ sourceEhrOrderId: order(2), status: 'not_received',
          receivedAt: null, collectedAt: null, lastResultAt: null }] },
        { patientId: b, outcome: 'answered', items: [{ sourceEhrOrderId: order(3), status: 'sample_collected',
          receivedAt: '2026-11-18T09:00:00.000Z', collectedAt: '2026-11-18T09:30:00.000Z', lastResultAt: null }] }]);
      expect(query.mock.calls.map((call) => call[1])).toEqual([[a, facility, [order(2)]], [b, facility, [order(3)]]]);
      expect(auditCalls(audit).map(([, event]) => [event.patientId, event.details.workItemIds])).toEqual([
        [a, []], [b, [work(3)]]]);
    });

  it('B12: opens a transaction only for denials to write and patients to read', async () => {
    const nobodyAllowed = harness({}, (patientId) => ({ ...allowedFor(patientId), allowed: false }));
    await nobodyAllowed.service.readBatch(context, { patients: [{ patientId: patient(1),
      sourceEhrOrderIds: [order(1)] }] });
    expect(nobodyAllowed.database.withTransaction).toHaveBeenCalledTimes(1);
    expect(nobodyAllowed.query).not.toHaveBeenCalled();
    expect(auditCalls(nobodyAllowed.audit).map(([, event]) => event.outcome)).toEqual(['denied']);

    const nobodyDenied = harness({});
    await nobodyDenied.service.readBatch(context, { patients: [{ patientId: patient(1),
      sourceEhrOrderIds: [order(1)] }] });
    expect(nobodyDenied.database.withTransaction).toHaveBeenCalledTimes(1);
    expect(auditCalls(nobodyDenied.audit).map(([, event]) => event.outcome)).toEqual(['success']);

    const allUnavailable = harness({}, () => {
      throw new DomainProblem(503, 'IDENTITY_SERVICE_UNAVAILABLE', 'Unavailable');
    });
    const answer = await allUnavailable.service.readBatch(context, { patients: [1, 2].map((n) => ({
      patientId: patient(n), sourceEhrOrderIds: [order(n)] })) });
    expect(answer.patients.map((entry) => entry.outcome)).toEqual(['unavailable', 'unavailable']);
    expect(allUnavailable.database.withTransaction).not.toHaveBeenCalled();
    expect(allUnavailable.audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('B13: answers within the budget; a check still running is aborted and one not started is never made', async () => {
    const signals: AbortSignal[] = [];
    const { service, identity, query } = harness({ [patient(1)]: [row(work(1), order(1))] }, (patientId, signal) => {
      if (patientId === patient(1)) return allowedFor(patientId);
      signals.push(signal);
      // As the Identity client answers an aborted fetch.
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(
        new DomainProblem(503, 'IDENTITY_SERVICE_UNAVAILABLE', 'Identity authorization service is unavailable')),
      { once: true }));
    });
    service.batchCheckBudgetMs = 50;
    const started = Date.now();
    const answer = await service.readBatch(context, { patients: [1, 2, 3, 4, 5, 6].map((n) => ({
      patientId: patient(n), sourceEhrOrderIds: [order(n)] })) });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(answer.patients).toEqual([
      { patientId: patient(1), outcome: 'answered', items: [{ sourceEhrOrderId: order(1), status: 'received',
        receivedAt: '2026-11-18T09:00:00.000Z', collectedAt: null, lastResultAt: null }] },
      ...[2, 3, 4, 5, 6].map((n) => ({ patientId: patient(n), outcome: 'unavailable',
        code: 'PROGRESS_CHECK_TIME_LIMIT' }))]);
    expect(identity.authorize.mock.calls.map((call) => call[0])).toEqual([1, 2, 3, 4, 5].map(patient));
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(query).toHaveBeenCalledWith(LAB_WORK_ITEM_PROGRESS_QUERY, [patient(1), facility, [order(1)]]);
  });

  it('B13: stops waiting at the budget for a check that never ends (Identity\'s answer stalling after its headers)',
    async () => {
      // Past the headers the Identity client reads the body with no time limit and no abort, so the signal goes
      // unheard.
      const { service, query } = harness({ [patient(1)]: [row(work(1), order(1))] }, (patientId) =>
        (patientId === patient(1) ? allowedFor(patientId) : new Promise(() => undefined)));
      service.batchCheckBudgetMs = 50;
      const started = Date.now();
      const answer = await service.readBatch(context, { patients: [1, 2, 3].map((n) => ({
        patientId: patient(n), sourceEhrOrderIds: [order(n)] })) });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(answer.patients.map((entry) => ('code' in entry ? entry.code : entry.outcome))).toEqual(['answered',
        'PROGRESS_CHECK_TIME_LIMIT', 'PROGRESS_CHECK_TIME_LIMIT']);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith(LAB_WORK_ITEM_PROGRESS_QUERY, [patient(1), facility, [order(1)]]);
    });

  it('B13: reads a 403 that settles with the budget\'s abort as a denial, audited, not as the time limit',
    async () => {
      const { service, identity, database, audit } = harness({});
      service.batchCheckBudgetMs = 20;
      // Identity's 403 is handed on only as the budget runs out.
      identity.authorize.mockImplementation((_patientId, _scope, _purpose, _context, options) =>
        new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(
          new DomainProblem(403, 'CONSENT_REQUIRED', 'Consent is required')), { once: true })));
      const answer = await service.readBatch(context, { patients: [{ patientId: patient(1),
        sourceEhrOrderIds: [order(1)] }] });
      expect(answer.patients).toEqual([{ patientId: patient(1), outcome: 'denied', code: 'CONSENT_REQUIRED' }]);
      expect(database.withTransaction).toHaveBeenCalledTimes(1);
      expect(auditCalls(audit).map(([client, event]) => [client.transaction, event.patientId, event.outcome,
        event.details])).toEqual([[1, patient(1), 'denied', { requestedCount: 1, reason: 'identity_refusal',
        via: 'batch' }]]);
    });

  it('B14: a failed read fails the call, after the denials were committed', async () => {
    const { service, database, audit } = harness({}, (patientId) => (patientId === patient(2)
      ? { ...allowedFor(patientId), allowed: false } : allowedFor(patientId)));
    const failure = new Error('connection lost');
    const real = database.withTransaction.getMockImplementation()!;
    database.withTransaction.mockImplementationOnce(real).mockImplementationOnce(async () => { throw failure; });
    await expect(service.readBatch(context, { patients: [1, 2].map((n) => ({ patientId: patient(n),
      sourceEhrOrderIds: [order(n)] })) })).rejects.toBe(failure);
    expect(database.withTransaction).toHaveBeenCalledTimes(2);
    await expect(database.withTransaction.mock.results[0]!.value).resolves.toBeUndefined();
    expect(auditCalls(audit).map(([, event]) => [event.patientId, event.outcome])).toEqual([[patient(2), 'denied']]);
  });

  it('B15: a failed denial write fails the call before any read', async () => {
    const { service, database, query } = harness({}, (patientId) => (patientId === patient(2)
      ? { ...allowedFor(patientId), allowed: false } : allowedFor(patientId)));
    const failure = new Error('connection lost');
    database.withTransaction.mockImplementationOnce(async () => { throw failure; });
    await expect(service.readBatch(context, { patients: [1, 2].map((n) => ({ patientId: patient(n),
      sourceEhrOrderIds: [order(n)] })) })).rejects.toBe(failure);
    expect(database.withTransaction).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it('B16: answers in the order asked, each patient and id as sent', async () => {
    const upper = patient(2).toUpperCase();
    const upperOrder = order(2).toUpperCase();
    const { service, query } = harness({ [patient(2)]: [row(work(2), order(2))] });
    const answer = await service.readBatch(context, { patients: [
      { patientId: patient(3), sourceEhrOrderIds: [order(3)] },
      { patientId: upper, sourceEhrOrderIds: [upperOrder] },
      { patientId: patient(1), sourceEhrOrderIds: [order(1)] }] });
    expect(answer.patients.map((entry) => entry.patientId)).toEqual([patient(3), upper, patient(1)]);
    expect(answer.patients[1]).toEqual({ patientId: upper, outcome: 'answered', items: [{ sourceEhrOrderId: upperOrder,
      status: 'received', receivedAt: '2026-11-18T09:00:00.000Z', collectedAt: null, lastResultAt: null }] });
    expect(query).toHaveBeenCalledWith(LAB_WORK_ITEM_PROGRESS_QUERY, [upper, facility, [upperOrder]]);
  });
});

describe('POST lab/work-items/progress/batch: lab-api\'s own Identity audit', () => {
  it('B20: one identity.authorization.check row per checked patient, none for one skipped at the budget', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const provider = { authorize: jest.fn(async (request: AuthorizationRequest): Promise<AuthorizationDecision> => {
      signals.push(request.signal);
      if (request.patientId === patient(1)) return allowedFor(request.patientId);
      if (request.patientId === patient(2)) return { ...allowedFor(request.patientId), allowed: false };
      if (request.patientId === patient(3)) {
        throw new DomainProblem(503, 'IDENTITY_SERVICE_UNAVAILABLE', 'Unavailable');
      }
      return new Promise<AuthorizationDecision>((_resolve, reject) => request.signal?.addEventListener('abort',
        () => reject(new DomainProblem(503, 'IDENTITY_SERVICE_UNAVAILABLE',
          'Identity authorization service is unavailable')), { once: true }));
    }), lookupExactHid: jest.fn(), consentStatus: jest.fn() };
    const audit = { record: jest.fn(), recordWithClient: jest.fn() };
    const query = jest.fn(async () => ({ rows: [] }));
    const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => unknown) =>
      operation({ query })) };
    const service = new LabWorkItemProgressService(database as never, new IdentityService(provider, audit as never),
      audit as never);
    service.batchCheckBudgetMs = 50;
    const answer = await service.readBatch(context, { patients: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
      patientId: patient(n), sourceEhrOrderIds: [order(n)] })) });

    expect(answer.patients.map((entry) => ('code' in entry ? entry.code : entry.outcome))).toEqual(['answered',
      'LAB_WORK_ITEM_ACCESS_DENIED', 'IDENTITY_SERVICE_UNAVAILABLE', ...Array(5).fill('PROGRESS_CHECK_TIME_LIMIT')]);
    // The answer does not wait for the checks the budget aborted; each writes its row as it ends.
    await flush();
    const checks = (audit.record.mock.calls as Array<[{ action: string; patientId: string; outcome: string }]>)
      .map(([event]) => event).filter((event) => event.action === 'identity.authorization.check');
    expect(checks.map((event) => [event.patientId, event.outcome]).sort()).toEqual([
      [patient(1), 'success'], [patient(2), 'denied'], [patient(3), 'failure'],
      [patient(4), 'failure'], [patient(5), 'failure'], [patient(6), 'failure'], [patient(7), 'failure']]);
    expect(provider.authorize).toHaveBeenCalledTimes(7);
    expect(signals.every((signal) => signal instanceof AbortSignal && signal.aborted)).toBe(true);

    // The one-patient route asks the provider exactly as before, with no signal.
    provider.authorize.mockClear();
    await service.read(context, { patientId: patient(1), sourceEhrOrderIds: [order(1)] });
    expect(provider.authorize).toHaveBeenCalledWith({ patientId: patient(1), scope: 'read_records',
      purpose: 'direct-care', context: { ...context, requestMethod: 'GET' } });
    expect(Object.keys(provider.authorize.mock.calls[0]![0])).toEqual(['patientId', 'scope', 'purpose', 'context']);
  });
});
