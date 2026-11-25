import 'reflect-metadata';
import { Logger, RequestMethod } from '@nestjs/common';
import { HEADERS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { INTERNAL_CALLER, READ_ONLY_POST, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { WORK_ITEM_PROGRESS_BATCH_MAX_PATIENTS, WORK_ITEM_PROGRESS_MAX_IDS, WorkItemProgressBatchDto,
  progressBatchProblems } from './dto/work-item-progress.dto';
import { PharmacyOwnWork } from './own-work-access';
import { PharmacyRefills } from './prescription-refills';
import { PharmacyWorkItemProgressController, progressVersions } from './work-item-progress.controller';
import { PROGRESS_BATCH_CHECK_BUDGET_MS, PROGRESS_BATCH_CHECK_CONCURRENCY, PharmacyWorkItemProgressService,
  WORK_ITEM_PROGRESS_QUERY } from './work-item-progress.service';

/*
 * ORD-3's batch form (decision 4): several patients in one call, each as by a call of its own. Fictional ids only,
 * in the style of work-item-progress.spec.ts.
 */
const ids = {
  facility: '7a1c0d2e-0000-4000-8000-000000000002', account: '7a1c0d2e-0000-4000-8000-000000000003',
  membership: '7a1c0d2e-0000-4000-8000-000000000004',
};
const pad = (n: number) => String(n).padStart(2, '0');
const patient = (n: number) => `7a1c0d2e-0000-4000-8000-3000000000${pad(n)}`;
const rx = (n: number) => `7a1c0d2e-0000-4000-8000-1000000000${pad(n)}`;
const work = (n: number) => `7a1c0d2e-0000-4000-8000-2000000000${pad(n)}`;
const doctorPermissions = ['ehr.prescription.read', 'ehr.prescription.write'];
const context: DataAccessContext = {
  correlationId: 'progress-batch-correlation-1', facilityId: ids.facility, membershipId: ids.membership,
  purposeOfUse: 'direct-care', authorization: 'Bearer doctor', actor: {
    id: ids.account, subject: 'staff:doctor', accountId: ids.account, authenticationMethod: 'local',
    roles: ['doctor'], permissions: doctorPermissions, facilityIds: [ids.facility], facilities: [],
    facility: { id: ids.facility, membershipId: ids.membership, organizationId: ids.facility, name: 'Test Clinic',
      roles: ['doctor'], permissions: doctorPermissions, isPrimary: true } },
};
const allowed = { allowed: true, facilityId: ids.facility, membershipId: ids.membership, scope: 'read_records',
  purpose: 'direct-care', breakGlass: false };
const ACTION = 'pharmacy.work-item.progress.read';
const resource = (patientId: string) => ({ patientId, resourceType: 'pharmacy-work-item-collection',
  resourceId: ids.facility });

const STATES = /from pharmacy\.own_work_item_states\(\$1::uuid\[\]\)/;
const STEPS = /from pharmacy\.own_work_item_steps\(\$1::uuid\[\]\)/;
/** The pharmacist who accepted (ORD-4); the progress never names them. */
const acceptor = '7a1c0d2e-0000-4000-8000-000000000005';

interface Row { work_item_id: string; source_ehr_prescription_id: string; accepted_at: Date; dispensed_at: Date | null;
  reversed_at: Date | null }
type Steps = Record<string, { sent: boolean; acceptedAt?: Date; acceptedWith?: 'accept' | 'dispensing' }>;
interface Own { withdrawn?: string[]; reasons?: Record<string, string>; error?: Error & { code?: string };
  steps?: Steps; stepsError?: Error & { code?: string } }
type Authorize = (patientId: string, scope: string, context: DataAccessContext, options?: { signal?: AbortSignal })
  => Promise<unknown>;

/**
 * The read's database, bound like the statement: a work item answers only to
 * its own patient ($1) and to an id asked ($3), letter case ignored, as uuids
 * compare. `own` turns 0133's (and ORD-4's) reader on, as in
 * work-item-progress.spec.ts. Each transaction gets its own client, so a test
 * can tell which transaction an audit row went into.
 */
function harness(rowsByPatient: Record<string, Row[]> = {}, own?: Own) {
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    if (sql === WORK_ITEM_PROGRESS_QUERY) {
      const [patientId, , asked] = values as [string, string, string[]];
      const wanted = new Set(asked.map((id) => id.toLowerCase()));
      return { rows: (rowsByPatient[patientId.toLowerCase()] ?? [])
        .filter((row) => wanted.has(row.source_ehr_prescription_id.toLowerCase())) };
    }
    if (STEPS.test(sql)) {
      if (own?.stepsError) throw own.stepsError;
      if (!own?.steps) throw Object.assign(new Error('function pharmacy.own_work_item_steps(uuid[]) does not exist'),
        { code: '42883' });
      const steps = own.steps;
      return { rows: (values[0] as string[]).map((item) => {
        const withdrawn = own.withdrawn?.includes(item) ?? false;
        const step = steps[item] ?? { sent: true };
        return { work_item_id: item, basis: 'consent', withdrawn,
          withdrawn_reason: withdrawn ? own.reasons?.[item] ?? 'changed' : null, sent_automatically: step.sent,
          accepted_at: step.acceptedAt ?? null, accepted_by_membership_id: step.acceptedAt ? acceptor : null,
          accepted_with: step.acceptedAt ? step.acceptedWith ?? 'accept' : null };
      }) };
    }
    if (STATES.test(sql)) {
      if (own?.error) throw own.error;
      return { rows: (values[0] as string[]).map((item) => {
        const withdrawn = own?.withdrawn?.includes(item) ?? false;
        return { work_item_id: item, basis: 'consent', withdrawn,
          withdrawn_reason: withdrawn ? own?.reasons?.[item] ?? 'changed' : null };
      }) };
    }
    return { rows: [] };
  });
  let opened = 0;
  const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => unknown) => {
    opened += 1;
    return operation({ query, transaction: opened });
  }) };
  const identity = { authorize: jest.fn<Promise<unknown>, Parameters<Authorize>>(
    async (patientId) => ({ ...allowed, patientId })) };
  const audit = { recordWithClient: jest.fn() };
  const ownWork = own ? new PharmacyOwnWork(true) : undefined;
  const service = new PharmacyWorkItemProgressService(database as never, identity as never, audit as never, ownWork);
  return { service, query, database, identity, audit, ownWork };
}

/** The transaction each audit row went into (1, 2, ...), with the row's arguments after the client. */
const auditRows = (audit: { recordWithClient: jest.Mock }) => audit.recordWithClient.mock.calls
  .map(([client, ...rest]: unknown[]) => ({ transaction: (client as { transaction: number }).transaction, args: rest }));
const progressCalls = (query: jest.Mock) => query.mock.calls.filter(([sql]) => sql === WORK_ITEM_PROGRESS_QUERY)
  .map(([, values]) => values as unknown[]);
const entry = (n: number, rxs: number[]) => ({ patientId: patient(n), sourceEhrPrescriptionIds: rxs.map(rx) });
const row = (n: number, minute = n, times: { dispensed?: Date; reversed?: Date } = {}): Row => ({
  work_item_id: work(n), source_ehr_prescription_id: rx(n), accepted_at: new Date(Date.UTC(2026, 10, 20, 8, minute)),
  dispensed_at: times.dispensed ?? null, reversed_at: times.reversed ?? null });
const received = (n: number, minute = n) => ({ sourceEhrPrescriptionId: rx(n), status: 'received',
  receivedAt: new Date(Date.UTC(2026, 10, 20, 8, minute)).toISOString(), dispensedAt: null, reversedAt: null });
const notReceived = (id: string) => ({ sourceEhrPrescriptionId: id, status: 'not_received', receivedAt: null,
  dispensedAt: null, reversedAt: null });

/** A promise this test settles itself. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

afterEach(() => jest.restoreAllMocks());

describe('POST pharmacy/work-items/progress/batch (ORD-3, decision 4): the route', () => {
  it('A1 is a sibling of the one-patient route: ehr-api only, read-only POST, the EHR read permission, 200, no-store',
    () => {
      const handler = PharmacyWorkItemProgressController.prototype.readBatch;
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('progress/batch');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(INTERNAL_CALLER, handler)).toBe('ehr-api');
      expect(Reflect.getMetadata(READ_ONLY_POST, handler)).toBe(true);
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['ehr.prescription.read']);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
      expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
      // The one-patient route is where it was.
      expect(Reflect.getMetadata(PATH_METADATA, PharmacyWorkItemProgressController)).toBe('pharmacy/work-items');
      expect(Reflect.getMetadata(PATH_METADATA, PharmacyWorkItemProgressController.prototype.read)).toBe('progress');
      expect(Reflect.getMetadata(HEADERS_METADATA, PharmacyWorkItemProgressController.prototype.read))
        .toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
    });
});

describe('the batch body', () => {
  const check = (body: unknown) => validate(plainToInstance(WorkItemProgressBatchDto, body),
    { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
  const many = (prefix: string, count: number, from = 0) => Array.from({ length: count }, (_, index) =>
    `7a1c0d2e-0000-4000-8000-${prefix}${String(from + index).padStart(11, '0')}`);
  const people = (count: number) => many('6', count);

  it('A2 takes 50 patients with 2 ids each (100 in all), one patient with 100 ids, and a patientId of any version',
    async () => {
      expect(WORK_ITEM_PROGRESS_BATCH_MAX_PATIENTS).toBe(50);
      expect(WORK_ITEM_PROGRESS_MAX_IDS).toBe(100);
      const prescriptions = many('7', 100);
      expect(await check({ patients: people(50).map((patientId, index) => ({ patientId,
        sourceEhrPrescriptionIds: prescriptions.slice(index * 2, index * 2 + 2) })) })).toEqual([]);
      expect(await check({ patients: [{ patientId: patient(1), sourceEhrPrescriptionIds: prescriptions }] }))
        .toEqual([]);
      // Not v4: taken here, and answered unavailable by Identity's own 400, for that patient only.
      expect(await check({ patients: [{ patientId: '7a1c0d2e-0000-1000-8000-000000000001',
        sourceEhrPrescriptionIds: [rx(1)] }] })).toEqual([]);
    });

  it('A3 refuses anything else, on `patients` unless it is a field of its own', async () => {
    const refused = async (body: unknown) => {
      const errors = await check(body);
      expect(errors).not.toEqual([]);
      return errors;
    };
    const on = async (body: unknown) => (await refused(body)).map((error) => error.property);
    const rule = async (body: unknown) => (await refused(body)).map((error) => error.constraints);
    expect(await on({ patients: [] })).toEqual(['patients']);
    expect(await on({ patients: people(51).map((patientId, index) => ({ patientId,
      sourceEhrPrescriptionIds: [many('7', 51)[index]] })) })).toEqual(['patients']);
    expect(await rule({ patients: [{ patientId: patient(1), sourceEhrPrescriptionIds: many('7', 51) },
      { patientId: patient(2), sourceEhrPrescriptionIds: many('7', 50, 51) }] }))
      .toEqual([{ workItemProgressBatch: 'patients must hold at most 100 ids in all' }]);
    expect(await on({ patients: [{ patientId: patient(1), sourceEhrPrescriptionIds: [] }] })).toEqual(['patients']);
    expect(await on({ patients: [{ patientId: patient(1), sourceEhrPrescriptionIds: many('7', 101) }] }))
      .toEqual(['patients']);
    expect(await rule({ patients: [entry(1, [1]), { patientId: patient(1).toUpperCase(),
      sourceEhrPrescriptionIds: [rx(2)] }] })).toEqual([{ workItemProgressBatch: 'patients must name each patient once' }]);
    expect(await rule({ patients: [entry(1, [1]), { patientId: patient(2),
      sourceEhrPrescriptionIds: [rx(1).toUpperCase()] }] })).toEqual([{ workItemProgressBatch: 'patients must name each id once' }]);
    expect(await rule({ patients: [{ patientId: patient(1), sourceEhrPrescriptionIds: [rx(1), rx(1).toUpperCase()] }] }))
      .toEqual([{ workItemProgressBatch: 'patients must name each id once' }]);
    expect(await on({ patients: [{ patientId: 'HID-ABC123', sourceEhrPrescriptionIds: [rx(1)] }] })).toEqual(['patients']);
    expect(await on({ patients: [{ patientId: patient(1), sourceEhrPrescriptionIds: ['HID-ABC123'] }] }))
      .toEqual(['patients']);
    expect(await on({ patients: [{ ...entry(1, [1]), healthId: 'HID-ABC123' }] })).toEqual(['patients']);
    expect(await on({ patients: [entry(1, [1])], healthId: 'HID-ABC123' })).toEqual(['healthId']);
    expect(await on({ patients: entry(1, [1]) })).toEqual(['patients']);
    expect(await on({ patients: [patient(1)] })).toEqual(['patients']);
    // An entry that is itself an array of valid bodies, which ValidateNested alone would take body by body, past the
    // rules across the body (rx 1 twice here): refused as not an object, and by that rule alone.
    expect(await rule({ patients: [[entry(1, [1]), entry(2, [1])]] }))
      .toEqual([{ isObject: 'each value in patients must be an object' }]);
  });

  it('A4 names every rule across the body that fails, in order, in one message; leaves the rest to the other rules',
    async () => {
      const idField = 'sourceEhrPrescriptionIds';
      expect(progressBatchProblems([entry(1, [1, 2]), entry(2, [3])], idField)).toEqual([]);
      expect(progressBatchProblems([{ patientId: patient(1), sourceEhrPrescriptionIds: many('7', 60) },
        { patientId: patient(2), sourceEhrPrescriptionIds: many('7', 41, 60) }], idField))
        .toEqual(['patients must hold at most 100 ids in all']);
      expect(progressBatchProblems([entry(1, [1]), { patientId: patient(1).toUpperCase(),
        sourceEhrPrescriptionIds: [rx(2)] }], idField)).toEqual(['patients must name each patient once']);
      expect(progressBatchProblems([entry(1, [1]), { patientId: patient(2),
        sourceEhrPrescriptionIds: [rx(1).toUpperCase()] }], idField)).toEqual(['patients must name each id once']);
      const all = [{ patientId: patient(1), sourceEhrPrescriptionIds: many('7', 100) },
        { patientId: patient(1).toUpperCase(), sourceEhrPrescriptionIds: [many('7', 1)[0]!.toUpperCase()] }];
      expect(progressBatchProblems(all, idField)).toEqual(['patients must hold at most 100 ids in all',
        'patients must name each patient once', 'patients must name each id once']);
      const errors = await check({ patients: all });
      expect(errors.map((error) => error.constraints?.workItemProgressBatch)).toEqual([
        'patients must hold at most 100 ids in all; patients must name each patient once; patients must name each id once']);
      // Not an array, entries that are not objects, and values that are not strings are for the other rules.
      expect(progressBatchProblems(undefined, idField)).toEqual([]);
      expect(progressBatchProblems('patients', idField)).toEqual([]);
      expect(progressBatchProblems(entry(1, [1]), idField)).toEqual([]);
      expect(progressBatchProblems([patient(1), patient(1), null, 7], idField)).toEqual([]);
      expect(progressBatchProblems([{ patientId: 7, sourceEhrPrescriptionIds: 'x' }, { patientId: 7,
        sourceEhrPrescriptionIds: [1, 1] }], idField)).toEqual([]);
      // Only the given id field counts (lab-api reads sourceEhrOrderIds).
      expect(progressBatchProblems([entry(1, [1]), entry(2, [1])], 'sourceEhrOrderIds')).toEqual([]);
    });
});

describe('readBatch: each patient as by a call of its own', () => {
  it('A5 refuses any purpose but direct care, before Identity is asked and before any transaction', async () => {
    const { service, identity, database } = harness();
    await expect(service.readBatch({ ...context, purposeOfUse: 'emergency' }, { patients: [entry(1, [1])] }, true, true))
      .rejects.toMatchObject({ status: 400, code: 'PURPOSE_OF_USE_REQUIRED',
        message: 'X-Purpose-Of-Use must be direct-care for this route' });
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it('A6 asks Identity once per patient, in the order asked, as a GET read, with the budget\'s signal', async () => {
    const { service, identity } = harness();
    const internalPost: DataAccessContext = { ...context, authorization: undefined, userCookie: 'hid_access=opaque',
      requestMethod: 'POST' };
    await service.readBatch(internalPost, { patients: [entry(3, [3]), entry(1, [1]), entry(2, [2])] });
    expect(identity.authorize.mock.calls.map(([patientId]) => patientId)).toEqual([patient(3), patient(1), patient(2)]);
    for (const call of identity.authorize.mock.calls) {
      expect(call).toEqual([expect.any(String), 'read_records', { ...internalPost, requestMethod: 'GET' },
        { signal: expect.any(AbortSignal) }]);
    }
    expect(internalPost.requestMethod).toBe('POST');
  });

  it('A7 never runs more than four checks at once, and checks all nine', async () => {
    expect(PROGRESS_BATCH_CHECK_CONCURRENCY).toBe(4);
    expect(PROGRESS_BATCH_CHECK_BUDGET_MS).toBe(2_000);
    const { service, identity } = harness();
    const waiting: Array<() => void> = [];
    let running = 0;
    let most = 0;
    identity.authorize.mockImplementation((patientId) => {
      running += 1;
      most = Math.max(most, running);
      const decision = deferred<unknown>();
      waiting.push(() => { running -= 1; decision.resolve({ ...allowed, patientId }); });
      return decision.promise;
    });
    const nine = Array.from({ length: 9 }, (_, index) => entry(index + 1, [index + 1]));
    const answer = service.readBatch(context, { patients: nine });
    for (let turn = 0; turn < 100 && (waiting.length > 0 || identity.authorize.mock.calls.length < 9); turn += 1) {
      await new Promise((settle) => setImmediate(settle));
      expect(running).toBeLessThanOrEqual(4);
      waiting.shift()?.();
    }
    expect((await answer).patients.map((patientEntry) => patientEntry.outcome)).toEqual(Array(9).fill('answered'));
    expect(identity.authorize).toHaveBeenCalledTimes(9);
    expect(most).toBe(4);
  });

  it('A8 answers each patient by its own check: one refusal or failure never refuses the call or another patient',
    async () => {
      const logged = (['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
      // Each patient also has a work item here, so an id that reached a statement would show.
      const { service, identity, database, query, audit } = harness(Object.fromEntries(
        [1, 2, 3, 4, 5, 6, 7].map((n) => [patient(n), [row(n)]])));
      identity.authorize.mockImplementation(async (patientId) => {
        switch (patientId) {
          case patient(2): return { ...allowed, patientId, allowed: false };
          case patient(3): throw new DomainProblem(403, 'CONSENT_REQUIRED', 'Consent is required');
          case patient(4): throw new DomainProblem(503, 'IDENTITY_SERVICE_UNAVAILABLE', 'Identity is unavailable');
          case patient(5): throw new DomainProblem(502, 'INVALID_IDENTITY_RESPONSE', 'Identity answered badly');
          case patient(6): return { ...allowed, patientId, breakGlass: true };
          case patient(7): throw new Error(`no answer about ${patient(7)} and ${rx(7)}`);
          default: return { ...allowed, patientId };
        }
      });
      const asked = [entry(1, [1, 8]), entry(2, [2]), entry(3, [3]), entry(4, [4]), entry(5, [5]), entry(6, [6]),
        entry(7, [7])];
      const answer = await service.readBatch(context, { patients: asked }, true, true);
      expect(answer.patients).toEqual([
        { patientId: patient(1), outcome: 'answered', items: [{ ...received(1), acceptedAt: null },
          { ...notReceived(rx(8)), acceptedAt: null }] },
        { patientId: patient(2), outcome: 'denied', code: 'PHARMACY_ACCESS_DENIED' },
        { patientId: patient(3), outcome: 'denied', code: 'CONSENT_REQUIRED' },
        { patientId: patient(4), outcome: 'unavailable', code: 'IDENTITY_SERVICE_UNAVAILABLE' },
        { patientId: patient(5), outcome: 'unavailable', code: 'INVALID_IDENTITY_RESPONSE' },
        { patientId: patient(6), outcome: 'unavailable', code: 'INVALID_IDENTITY_RESPONSE' },
        { patientId: patient(7), outcome: 'unavailable', code: 'PROGRESS_CHECK_FAILED' },
      ]);
      expect(answer.patients.map((patientEntry) => Object.keys(patientEntry))).toEqual([['patientId', 'outcome', 'items'],
        ...Array(6).fill(['patientId', 'outcome', 'code'])]);
      // First the denials, in one transaction, in the order asked; then the read, with the one success row.
      expect(database.withTransaction).toHaveBeenCalledTimes(2);
      expect(auditRows(audit)).toEqual([
        { transaction: 1, args: [context, ACTION, resource(patient(2)),
          { requestedCount: 1, reason: 'identity_authorization', via: 'batch' }, 'denied'] },
        { transaction: 1, args: [context, ACTION, resource(patient(3)),
          { requestedCount: 1, reason: 'identity_refusal', via: 'batch' }, 'denied'] },
        { transaction: 2, args: [context, ACTION, resource(patient(1)),
          { requestedCount: 2, foundCount: 1, workItemIds: [work(1)], breakGlass: false, via: 'batch' }] },
      ]);
      expect(progressCalls(query)).toEqual([[patient(1), ids.facility, [rx(1), rx(8)]]]);
      const parameters = JSON.stringify(query.mock.calls.map(([, values]) => values ?? []));
      for (const n of [2, 3, 4, 5, 6, 7]) {
        expect(parameters).not.toContain(patient(n));
        expect(parameters).not.toContain(rx(n));
        expect(parameters).not.toContain(work(n));
      }
      // The plain error is logged once, by its name, with no id and not its message.
      const failed = logged[2]!;
      expect(failed).toHaveBeenCalledTimes(1);
      expect(failed).toHaveBeenCalledWith({ message: 'Own progress check failed', correlationId: context.correlationId,
        errorName: 'Error' });
      const lines = JSON.stringify(logged.flatMap((spy) => spy.mock.calls));
      for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
        expect(lines).not.toContain(patient(n));
        expect(lines).not.toContain(rx(n));
      }
    });

  // ORD-4's fixtures (work-item-progress.spec.ts), split between two patients with a refused one between them: 1
  // received; 2 accepted; 3 handed in by hand; 4 accepted, then held; 5 accepted, then sent elsewhere; 6 accepted,
  // then dispensed; 7 accepted by its dispensing, dispensed and reversed; 8 dispensed before ORD-4; 9 received, then
  // held; 10 not here; 11 handed in by hand, then dispensed.
  describe('A9 every answered entry is exactly the one-patient answer', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 9, minute));
    const progressRow = (n: number, times: { dispensed?: number; reversed?: number } = {}) => row(n, n, {
      ...(times.dispensed === undefined ? {} : { dispensed: at(times.dispensed) }),
      ...(times.reversed === undefined ? {} : { reversed: at(times.reversed) }) });
    const first = [progressRow(1), progressRow(2), progressRow(3), progressRow(4), progressRow(5)];
    const second = [progressRow(6, { dispensed: 40 }), progressRow(7, { dispensed: 41, reversed: 50 }),
      progressRow(8, { dispensed: 42 }), progressRow(9), progressRow(11, { dispensed: 43 })];
    const own: Own = { withdrawn: [work(4), work(5), work(9)], reasons: { [work(4)]: 'changed',
      [work(5)]: 'sent_elsewhere', [work(9)]: 'changed' }, steps: {
      [work(1)]: { sent: true }, [work(2)]: { sent: true, acceptedAt: at(21) }, [work(3)]: { sent: false },
      [work(4)]: { sent: true, acceptedAt: at(24) }, [work(5)]: { sent: true, acceptedAt: at(25) },
      [work(6)]: { sent: true, acceptedAt: at(26) }, [work(7)]: { sent: true, acceptedAt: at(41), acceptedWith: 'dispensing' },
      [work(8)]: { sent: true }, [work(9)]: { sent: true }, [work(11)]: { sent: false } } };
    const rows = { [patient(1)]: first, [patient(2)]: second, [patient(3)]: [progressRow(12)] };
    const one = entry(1, [10, 5, 4, 3, 2, 1]);
    const two = entry(2, [6, 7, 8, 9, 11]);
    const refused = entry(3, [12]);

    it.each([
      ['no header', false, false], ['0133 only', true, false], ['ord4 only', false, true], ['both', true, true],
    ])('with %s', async (_name, current, accepted) => {
      const batch = harness(rows, own);
      batch.identity.authorize.mockImplementation(async (patientId) => ({ ...allowed, patientId,
        allowed: patientId !== patient(3) }));
      const answer = await batch.service.readBatch(context, { patients: [one, refused, two] }, current, accepted);
      expect(answer.patients.map((patientEntry) => patientEntry.outcome)).toEqual(['answered', 'denied', 'answered']);
      const successRows = auditRows(batch.audit).filter(({ args }) => args.length === 4);
      for (const [index, asked] of [[0, one], [2, two]] as const) {
        const single = harness(rows, own);
        const alone = await single.service.read(context, asked, current, accepted);
        expect(answer.patients[index]).toEqual({ patientId: asked.patientId, outcome: 'answered', items: alone.items });
        const [singleRow] = auditRows(single.audit);
        const batchRow = successRows.find(({ args }) => (args[2] as { patientId: string }).patientId === asked.patientId);
        expect(batchRow?.args).toEqual([...singleRow!.args.slice(0, 3),
          { ...(singleRow!.args[3] as object), via: 'batch' }]);
      }
      if (current && accepted) {
        const statuses = new Set(answer.patients.flatMap((patientEntry) =>
          'items' in patientEntry ? patientEntry.items.map((item) => item.status) : []));
        expect([...statuses].sort()).toEqual(['accepted', 'dispensed', 'dispensing_reversed', 'not_received',
          'received', 'sent_elsewhere', 'withdrawn']);
      }
      expect(JSON.stringify(answer)).not.toContain(acceptor);
    });

    it('and the controller takes the same versions from the same headers on both routes', async () => {
      const read = jest.fn(async () => ({ items: [] }));
      const readBatch = jest.fn(async () => ({ patients: [] }));
      const controller = new PharmacyWorkItemProgressController({ read, readBatch } as never);
      const request = (sent: Record<string, string>) => {
        const headers: Record<string, string> = { authorization: 'Bearer doctor', 'x-purpose-of-use': 'direct-care',
          ...sent };
        return { correlationId: context.correlationId, actor: context.actor, facilityId: ids.facility, method: 'POST',
          headers, header: (name: string) => headers[name.toLowerCase()] } as never;
      };
      const both = { 'x-hid-own-progress': '0133', 'x-hid-own-progress-accepted': 'ord4' };
      const headerSets: Array<Record<string, string>> = [{}, { 'x-hid-own-progress': '0133' },
        { 'x-hid-own-progress-accepted': 'ord4' }, both, { 'x-hid-own-progress': '0133, 0133' },
        { ...both, 'x-hid-own-progress-accepted': 'ord4, ord4' }, { ...both, 'x-hid-own-progress-accepted': 'ORD4' },
        { 'x-hid-own-progress': '0134', 'x-hid-own-progress-accepted': 'ord4' }];
      for (const headers of headerSets) {
        read.mockClear();
        readBatch.mockClear();
        await controller.read(one as never, request(headers));
        await controller.readBatch({ patients: [one] } as never, request(headers));
        const [singleCall] = read.mock.calls as unknown[][];
        const [batchCall] = readBatch.mock.calls as unknown[][];
        expect(batchCall!.slice(2)).toEqual(singleCall!.slice(2));
        expect(batchCall![0]).toEqual(singleCall![0]);
      }
    });
  });

  it('A10 reads each patient\'s ids under that patient alone: another patient\'s id asked under A is not found', async () => {
    const { service, query, audit } = harness({ [patient(2)]: [row(21), row(22)] });
    const answer = await service.readBatch(context, { patients: [entry(1, [21]), entry(2, [22])] });
    expect(answer.patients).toEqual([
      { patientId: patient(1), outcome: 'answered', items: [notReceived(rx(21))] },
      { patientId: patient(2), outcome: 'answered', items: [received(22)] },
    ]);
    expect(progressCalls(query)).toEqual([[patient(1), ids.facility, [rx(21)]], [patient(2), ids.facility, [rx(22)]]]);
    expect(auditRows(audit).map(({ args }) => args[3])).toEqual([
      { requestedCount: 1, foundCount: 0, workItemIds: [], breakGlass: false, via: 'batch' },
      { requestedCount: 1, foundCount: 1, workItemIds: [work(22)], breakGlass: false, via: 'batch' },
    ]);
  });

  describe('A11 0133\'s and ORD-4\'s reader, once for the whole call', () => {
    const rows = { [patient(1)]: [row(1), row(2)], [patient(2)]: [row(3)] };
    const asked = { patients: [entry(1, [2, 1]), entry(2, [3, 4])] };

    it('is asked once, with every work item found, patient by patient in the order asked', async () => {
      const { service, ownWork } = harness(rows, { steps: {} });
      const states = jest.spyOn(ownWork!, 'states');
      await service.readBatch(context, asked, true, true);
      expect(states).toHaveBeenCalledTimes(1);
      expect(states).toHaveBeenCalledWith(expect.anything(), [work(1), work(2), work(3)], context.correlationId, 'flag');
    });

    it('falls back to 0133\'s reader on a schema without ORD-4\'s (42883)', async () => {
      const { service, query } = harness(rows, { withdrawn: [work(2), work(3)] });
      const answer = await service.readBatch(context, asked, true, true);
      expect(answer.patients.map((patientEntry) => 'items' in patientEntry
        ? patientEntry.items.map((item) => [item.status, item.acceptedAt]) : [])).toEqual([
        [['withdrawn', null], ['received', null]], [['withdrawn', null], ['not_received', null]]]);
      expect(query.mock.calls.map(([sql]) => sql).filter((sql) => STEPS.test(sql) || STATES.test(sql) || /savepoint/.test(sql)))
        .toEqual(['savepoint pharmacy_own_work_states', expect.stringMatching(STEPS),
          'rollback to savepoint pharmacy_own_work_states', expect.stringMatching(STATES),
          'release savepoint pharmacy_own_work_states']);
    });

    it('answers no flags when the reader fails, and never fails because of it', async () => {
      const { service } = harness(rows, { withdrawn: [work(2), work(3)], steps: {},
        stepsError: Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) });
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const answer = await service.readBatch(context, asked, true, true);
      expect(answer.patients.map((patientEntry) => 'items' in patientEntry
        ? patientEntry.items.map((item) => item.status) : [])).toEqual([['received', 'received'],
        ['received', 'not_received']]);
    });

    it('passes a serialization failure on, so the read is run again', async () => {
      const conflict = Object.assign(new Error('could not serialize access'), { code: '40001' });
      const { service } = harness(rows, { steps: {}, stepsError: conflict });
      await expect(service.readBatch(context, asked, true, true)).rejects.toBe(conflict);
    });
  });

  it('A12 opens only the transactions it needs, and answers 200 when nobody can be read', async () => {
    const nobodyAllowed = harness({ [patient(1)]: [row(1)] }, { steps: {} });
    const states = jest.spyOn(nobodyAllowed.ownWork!, 'states');
    nobodyAllowed.identity.authorize.mockImplementation(async (patientId) => ({ ...allowed, patientId, allowed: false }));
    expect((await nobodyAllowed.service.readBatch(context, { patients: [entry(1, [1]), entry(2, [2])] })).patients)
      .toEqual([{ patientId: patient(1), outcome: 'denied', code: 'PHARMACY_ACCESS_DENIED' },
        { patientId: patient(2), outcome: 'denied', code: 'PHARMACY_ACCESS_DENIED' }]);
    expect(nobodyAllowed.database.withTransaction).toHaveBeenCalledTimes(1);
    expect(auditRows(nobodyAllowed.audit).map(({ args }) => args[4])).toEqual(['denied', 'denied']);
    expect(progressCalls(nobodyAllowed.query)).toEqual([]);
    expect(states).not.toHaveBeenCalled();

    const nobodyDenied = harness({ [patient(1)]: [row(1)] });
    await nobodyDenied.service.readBatch(context, { patients: [entry(1, [1]), entry(2, [2])] });
    expect(nobodyDenied.database.withTransaction).toHaveBeenCalledTimes(1);
    expect(auditRows(nobodyDenied.audit).map(({ transaction, args }) => [transaction, args.length])).toEqual([[1, 4], [1, 4]]);

    const nobodyChecked = harness({ [patient(1)]: [row(1)] });
    nobodyChecked.identity.authorize.mockRejectedValue(new DomainProblem(503, 'IDENTITY_SERVICE_UNAVAILABLE',
      'Identity authorization service is unavailable'));
    expect(await nobodyChecked.service.readBatch(context, { patients: [entry(1, [1]), entry(2, [2])] })).toEqual({
      patients: [{ patientId: patient(1), outcome: 'unavailable', code: 'IDENTITY_SERVICE_UNAVAILABLE' },
        { patientId: patient(2), outcome: 'unavailable', code: 'IDENTITY_SERVICE_UNAVAILABLE' }] });
    expect(nobodyChecked.database.withTransaction).not.toHaveBeenCalled();
    expect(nobodyChecked.audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('A13 aborts the checks still running when the budget is up and starts none after it; the rest is still read',
    async () => {
      const { service, identity, query } = harness({ [patient(1)]: [row(1)] });
      service.batchCheckBudgetMs = 50;
      const signals = new Map<string, AbortSignal>();
      identity.authorize.mockImplementation((patientId, _scope, _context, options) => {
        if (patientId === patient(1)) return Promise.resolve({ ...allowed, patientId });
        const signal = options!.signal!;
        signals.set(patientId, signal);
        // As the Identity client answers an aborted fetch.
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DomainProblem(503,
          'IDENTITY_SERVICE_UNAVAILABLE', 'Identity authorization service is unavailable')), { once: true }));
      });
      const started = Date.now();
      const answer = await service.readBatch(context, { patients: [1, 2, 3, 4, 5, 6].map((n) => entry(n, [n])) });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(answer.patients).toEqual([
        { patientId: patient(1), outcome: 'answered', items: [received(1)] },
        ...[2, 3, 4, 5, 6].map((n) => ({ patientId: patient(n), outcome: 'unavailable', code: 'PROGRESS_CHECK_TIME_LIMIT' })),
      ]);
      expect([...signals.keys()]).toEqual([patient(2), patient(3), patient(4), patient(5)]);
      expect([...signals.values()].every((signal) => signal.aborted)).toBe(true);
      // Patient 6 waited for a free slot, and none came before the budget was up.
      expect(identity.authorize.mock.calls.map(([patientId]) => patientId)).not.toContain(patient(6));
      expect(progressCalls(query)).toEqual([[patient(1), ids.facility, [rx(1)]]]);
    });

  it('A13 stops waiting at the budget for a check that never ends (Identity\'s answer stalling after its headers)',
    async () => {
      const { service, identity, query } = harness({ [patient(1)]: [row(1)] });
      service.batchCheckBudgetMs = 50;
      // Past the headers the Identity client reads the body with no time limit and no abort, so the signal goes
      // unheard.
      identity.authorize.mockImplementation((patientId) => (patientId === patient(1)
        ? Promise.resolve({ ...allowed, patientId }) : new Promise(() => undefined)));
      const started = Date.now();
      const answer = await service.readBatch(context, { patients: [entry(1, [1]), entry(2, [2]), entry(3, [3])] });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(answer.patients).toEqual([
        { patientId: patient(1), outcome: 'answered', items: [received(1)] },
        { patientId: patient(2), outcome: 'unavailable', code: 'PROGRESS_CHECK_TIME_LIMIT' },
        { patientId: patient(3), outcome: 'unavailable', code: 'PROGRESS_CHECK_TIME_LIMIT' },
      ]);
      expect(progressCalls(query)).toEqual([[patient(1), ids.facility, [rx(1)]]]);
    });

  it('A13 reads a 403 that settles with the budget\'s abort as a denial, audited, not as the time limit',
    async () => {
      const { service, identity, database, audit } = harness();
      service.batchCheckBudgetMs = 20;
      // Identity's 403 is handed on only as the budget runs out.
      identity.authorize.mockImplementation((_patientId, _scope, _context, options) => new Promise((_resolve, reject) =>
        options!.signal!.addEventListener('abort', () => reject(new DomainProblem(403, 'CONSENT_REQUIRED',
          'Consent is required')), { once: true })));
      const answer = await service.readBatch(context, { patients: [entry(1, [1])] });
      expect(answer.patients).toEqual([{ patientId: patient(1), outcome: 'denied', code: 'CONSENT_REQUIRED' }]);
      expect(database.withTransaction).toHaveBeenCalledTimes(1);
      expect(auditRows(audit)).toEqual([{ transaction: 1, args: [context, ACTION, resource(patient(1)),
        { requestedCount: 1, reason: 'identity_refusal', via: 'batch' }, 'denied'] }]);
    });

  it('A14 fails the whole call when the read fails, after the denials were committed', async () => {
    const { service, identity, database, audit } = harness({ [patient(1)]: [row(1)] });
    identity.authorize.mockImplementation(async (patientId) => ({ ...allowed, patientId,
      allowed: patientId === patient(1) }));
    const lost = new Error('connection terminated');
    database.withTransaction
      .mockImplementationOnce(async (_context, operation) => operation({ transaction: 1 }))
      .mockImplementationOnce(async () => { throw lost; });
    await expect(service.readBatch(context, { patients: [entry(1, [1]), entry(2, [2])] })).rejects.toBe(lost);
    expect(database.withTransaction).toHaveBeenCalledTimes(2);
    await expect(database.withTransaction.mock.results[0]!.value).resolves.toBeUndefined();
    expect(auditRows(audit)).toEqual([{ transaction: 1, args: [context, ACTION, resource(patient(2)),
      { requestedCount: 1, reason: 'identity_authorization', via: 'batch' }, 'denied'] }]);
  });

  it('A15 fails the whole call when the denials cannot be written, and reads nothing', async () => {
    const { service, identity, database, query } = harness({ [patient(1)]: [row(1)] });
    identity.authorize.mockImplementation(async (patientId) => ({ ...allowed, patientId,
      allowed: patientId === patient(1) }));
    const lost = new Error('connection terminated');
    database.withTransaction.mockImplementationOnce(async () => { throw lost; });
    await expect(service.readBatch(context, { patients: [entry(1, [1]), entry(2, [2])] })).rejects.toBe(lost);
    expect(database.withTransaction).toHaveBeenCalledTimes(1);
    expect(progressCalls(query)).toEqual([]);
  });

  it('A16 answers in the order asked, whatever order the checks finish in, with each id as sent', async () => {
    const { service, identity, query } = harness({ [patient(1)]: [row(1)], [patient(3)]: [row(3)] });
    const upper = patient(3).toUpperCase();
    const delays: Record<string, number> = { [upper]: 30, [patient(1)]: 15, [patient(2)]: 0 };
    identity.authorize.mockImplementation((patientId) => new Promise((resolve) => setTimeout(() => resolve({ ...allowed,
      patientId, allowed: patientId !== patient(2) }), delays[patientId])));
    const answer = await service.readBatch(context, { patients: [
      { patientId: upper, sourceEhrPrescriptionIds: [rx(3).toUpperCase()] }, entry(1, [1]), entry(2, [2])] });
    expect(answer.patients).toEqual([
      { patientId: upper, outcome: 'answered', items: [{ ...received(3), sourceEhrPrescriptionId: rx(3).toUpperCase() }] },
      { patientId: patient(1), outcome: 'answered', items: [received(1)] },
      { patientId: patient(2), outcome: 'denied', code: 'PHARMACY_ACCESS_DENIED' },
    ]);
    // Bound as sent; the database compares uuids without regard to letter case.
    expect(progressCalls(query)).toEqual([[upper, ids.facility, [rx(3).toUpperCase()]],
      [patient(1), ids.facility, [rx(1)]]]);
  });
});

describe('progressVersions', () => {
  it('A17 matches each value exactly, and the ORD-4 header only with 0133\'s', () => {
    const versions = (headers: Record<string, string>) => progressVersions({ headers } as never);
    expect(versions({})).toEqual({ current: false, accepted: false });
    expect(versions({ 'x-hid-own-progress': '0133' })).toEqual({ current: true, accepted: false });
    expect(versions({ 'x-hid-own-progress': '0133', 'x-hid-own-progress-accepted': 'ord4' }))
      .toEqual({ current: true, accepted: true });
    // A repeated header, as node joins it, is not a match.
    expect(versions({ 'x-hid-own-progress': '0133, 0133', 'x-hid-own-progress-accepted': 'ord4' }))
      .toEqual({ current: false, accepted: false });
    expect(versions({ 'x-hid-own-progress': '0133', 'x-hid-own-progress-accepted': 'ord4, ord4' }))
      .toEqual({ current: true, accepted: false });
    expect(versions({ 'x-hid-own-progress-accepted': 'ord4' })).toEqual({ current: false, accepted: false });
    expect(versions({ 'x-hid-own-progress': '0133 ', 'x-hid-own-progress-accepted': 'ord4' }))
      .toEqual({ current: false, accepted: false });
    expect(versions({ 'x-hid-own-progress': '0133', 'x-hid-own-progress-accepted': 'ORD4' }))
      .toEqual({ current: true, accepted: false });
  });
});

/*
 * ORD-12 (refills, 0154) with the batch: while PRESCRIPTION_REFILLS_ENABLED is
 * on, the one-patient answer carries `lastFilledAt` (the latest fill's time,
 * null whenever `dispensedAt` is); each answered batch entry must carry it the
 * same way, so readBatch answers each patient exactly as read() does. Off,
 * neither answer carries it. Rows as WORK_ITEM_PROGRESS_QUERY gives them with
 * 0154: the first fill (`dispensed_at`), the latest (`last_filled_at`), the
 * latest fill's reversal and whether any fill stands.
 */
describe('A18 ORD-12: with refills, each answered entry is still exactly the one-patient answer', () => {
  const at = (day: number, hour: number) => new Date(Date.UTC(2026, 10, day, hour, 5));
  const fills = (n: number, fill: { first?: Date; latest?: Date; reversed?: Date; standing?: boolean } = {}) => ({
    ...row(n), dispensed_at: fill.first ?? null, last_filled_at: fill.latest ?? null, reversed_at: fill.reversed ?? null,
    fill_standing: fill.standing ?? null });
  const rows = {
    // Two fills, both standing; a refill reversed while the first stands; every fill reversed; not yet dispensed.
    [patient(1)]: [fills(1, { first: at(18, 11), latest: at(21, 9), standing: true }),
      fills(2, { first: at(18, 12), latest: at(22, 9), reversed: at(22, 10), standing: true }),
      fills(3, { first: at(18, 13), latest: at(23, 9), reversed: at(23, 10), standing: false }), fills(4)],
    // One fill: the latest is the first.
    [patient(2)]: [fills(6, { first: at(19, 8), latest: at(19, 8), standing: true }), fills(7)],
    [patient(3)]: [fills(12, { first: at(19, 9), latest: at(24, 9), standing: true })],
  };
  const one = entry(1, [10, 4, 3, 2, 1]);
  const two = entry(2, [7, 6]);
  const refused = entry(3, [12]);
  const build = (on: boolean) => {
    const built = harness(rows as never);
    built.identity.authorize.mockImplementation(async (patientId) => ({ ...allowed, patientId,
      allowed: patientId !== patient(3) }));
    return new PharmacyWorkItemProgressService(built.database as never, built.identity as never, built.audit as never,
      undefined, new PharmacyRefills(on));
  };

  it.each([['on', true], ['off', false]])('refills %s: the batch items equal read()\'s, lastFilledAt included',
    async (_name, on) => {
      for (const [current, accepted] of [[true, true], [false, false]] as const) {
        const answer = await build(on).readBatch(context, { patients: [one, refused, two] }, current, accepted);
        expect(answer.patients.map((patientEntry) => patientEntry.outcome)).toEqual(['answered', 'denied', 'answered']);
        expect(answer.patients[1]).toStrictEqual({ patientId: patient(3), outcome: 'denied',
          code: 'PHARMACY_ACCESS_DENIED' });
        for (const [index, asked] of [[0, one], [2, two]] as const) {
          const alone = await build(on).read(context, asked, current, accepted);
          expect(answer.patients[index]).toStrictEqual({ patientId: asked.patientId, outcome: 'answered',
            items: alone.items });
        }
      }
    });

  it('refills on: every item of both answers carries lastFilledAt, the latest fill\'s time or null', async () => {
    const answer = await build(true).readBatch(context, { patients: [one, two] }, true, true);
    const alone = await build(true).read(context, one, true, true);
    const latest = (entryAnswer: (typeof answer.patients)[number]) => 'items' in entryAnswer
      ? entryAnswer.items.map((item) => [item.sourceEhrPrescriptionId, item.status, item.lastFilledAt]) : [];
    expect(latest(answer.patients[0]!)).toEqual([[rx(10), 'not_received', null], [rx(4), 'received', null],
      [rx(3), 'dispensing_reversed', at(23, 9).toISOString()], [rx(2), 'dispensed', at(22, 9).toISOString()],
      [rx(1), 'dispensed', at(21, 9).toISOString()]]);
    expect(latest(answer.patients[1]!)).toEqual([[rx(7), 'received', null],
      [rx(6), 'dispensed', at(19, 8).toISOString()]]);
    expect(alone.items.map((item) => item.lastFilledAt)).toEqual(latest(answer.patients[0]!).map(([, , time]) => time));
    for (const item of [...alone.items, ...answer.patients.flatMap((patientEntry) =>
      'items' in patientEntry ? patientEntry.items : [])]) {
      expect(Object.keys(item)).toEqual(['sourceEhrPrescriptionId', 'status', 'receivedAt', 'dispensedAt', 'reversedAt',
        'acceptedAt', 'lastFilledAt']);
    }
  });

  it('refills off: neither answer carries lastFilledAt', async () => {
    const answer = await build(false).readBatch(context, { patients: [one, two] }, true, true);
    const alone = await build(false).read(context, one, true, true);
    for (const item of [...alone.items, ...answer.patients.flatMap((patientEntry) =>
      'items' in patientEntry ? patientEntry.items : [])]) {
      expect(item).not.toHaveProperty('lastFilledAt');
    }
    expect(JSON.stringify(answer)).not.toContain('lastFilledAt');
  });
});
