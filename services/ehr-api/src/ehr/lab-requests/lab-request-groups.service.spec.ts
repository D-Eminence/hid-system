import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import type { AuditedPart, SemanticEvent } from '../shared/clinical.repository';
import { OrderStatus } from '../shared/clinical.dto';
import {
  LAB_REQUEST_GROUP_OPERATION,
  LAB_REQUEST_GROUP_PART,
  LAB_REQUEST_GROUP_SEND_DEADLINE_MS,
  LabRequestGroups,
} from './lab-request-groups';
import type { CreateLabRequestGroupInput } from './lab-request-groups.dto';
import { LabRequestsService } from './lab-requests.service';

/*
 * ORD-6 (0158; Ola's design note on hid-system#258, 7214746190): several
 * tests in one lab request. A fake database keeps the lab requests and the
 * Idempotency-Key rows in memory, as ClinicalRepository and Postgres keep
 * them, so a replay finds what the first call stored. Fictional data only.
 */

const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const key = 'lab-request-group-key-0001';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const context = (permissions = ['ehr.lab-request.write', 'lab.work-item.accept']) => ({ correlationId: 'correlation-123456',
  facilityId, membershipId, purposeOfUse: 'direct-care', authorization: 'Bearer user', actor: { id: accountId,
    subject: 'staff:test', accountId, authenticationMethod: 'local', roles: ['doctor'], permissions,
    facilityIds: [facilityId], facilities: [], facility: { id: facilityId, membershipId, organizationId: facilityId,
      name: 'Test', roles: ['doctor'], permissions: [], isPrimary: true } } }) as unknown as DataAccessContext;
const noRoutes = { summaries: async () => new Map(), summary: async () => null, crossFacilityOrdersEnabled: async () => false };

/** Three tests: two coded (one with its own priority and specimen), one by its name only (0156). */
const group = (status: 'draft' | 'active' = 'active'): CreateLabRequestGroupInput => ({
  status, priority: 'routine', clinicalInformation: 'Fever for 3 days',
  tests: [
    { testCodeSystem: 'LOINC', testCode: '58410-2', testDisplay: 'Full blood count', specimenTypeCode: 'Blood (EDTA)' },
    { testCodeSystem: 'HID-LAB', testCode: 'MP-RDT', testDisplay: 'Malaria rapid diagnostic test', priority: 'urgent' },
    { testDisplay: 'Sickling test' },
  ],
}) as unknown as CreateLabRequestGroupInput;

/** Lets the service's promise chain run up to its next timer (fake timers fake no microtask). */
const settle = async () => { for (let turn = 0; turn < 200; turn += 1) await Promise.resolve(); };

type StoredRow = Record<string, unknown> & { id: string; requestGroupId: string | null; status: string };

/**
 * The fake database and repository. `run` and `runParts` hold one
 * transaction each (a part that throws leaves nothing: the writes of the
 * transaction are kept only when it returns); `executeCreate` keeps a key row
 * per (operation, key) with its digest and result, and replays it.
 */
const memory = () => {
  const rows = new Map<string, StoredRow>();
  const keys = new Map<string, { digest: string; id: string }>();
  const operations: string[] = [];
  const statements: { sql: string; values: unknown[] }[] = [];
  const committed: { events: readonly SemanticEvent[]; parts: readonly AuditedPart[] }[] = [];
  let next = 0;
  let open: { rows: Map<string, StoredRow>; keys: Map<string, { digest: string; id: string }> } | undefined;
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    const table = open?.rows ?? rows;
    if (/from ehr\.encounters/.test(sql)) return { rows: [{ status: 'in_progress' }] };
    if (/insert into ehr\.lab_requests/.test(sql)) {
      next += 1;
      const row: StoredRow = { id: `223e4567-e89b-42d3-a456-${String(next).padStart(12, '0')}`, encounterId: values[0],
        patientId: values[1], facilityId: values[2], createdBy: values[3], createdByMembershipId: values[4],
        testCodeSystem: values[5], testCode: values[6], testDisplay: values[7], priority: values[8], status: String(values[9]),
        specimenTypeCode: values[10], clinicalInformation: values[11], externalOrderReference: values[12],
        requestGroupId: values[13] as string | null, rowVersion: '1', createdAt: new Date('2026-12-01T09:00:00.123Z'),
        updatedAt: new Date('2026-12-01T09:00:00.123Z'), createdAtExact: `2026-12-01T09:00:00.12345${next}Z` };
      table.set(row.id, row);
      return { rows: [row] };
    }
    if (/from ehr\.lab_requests where id = \$1/.test(sql)) {
      const row = table.get(String(values[0]));
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  });
  const client = { query };
  const transaction = async <T>(work: () => Promise<T>): Promise<T> => {
    open = { rows: new Map(rows), keys: new Map(keys) };
    try {
      const value = await work();
      for (const [id, row] of open.rows) rows.set(id, row);
      for (const [name, row] of open.keys) keys.set(name, row);
      return value;
    } finally {
      open = undefined;
    }
  };
  const repository = {
    run: jest.fn(async (_c: unknown, _p: unknown, _a: unknown, event: SemanticEvent,
      operation: (c: unknown) => Promise<{ value: unknown; resourceId?: string; details?: Record<string, unknown> }>) =>
      transaction(async () => {
        const done = await operation(client);
        committed.push({ events: [event], parts: [{ event, resourceId: done.resourceId, details: done.details }] });
        return done.value;
      })),
    runParts: jest.fn(async (_c: unknown, _p: unknown, _a: unknown, events: readonly SemanticEvent[],
      operation: (c: unknown) => Promise<{ value: unknown; parts: readonly AuditedPart[] }>,
      lookup?: (c: unknown) => Promise<boolean>) => transaction(async () => {
      if (lookup && !await lookup(client)) throw new DomainProblem(404, 'CLINICAL_RESOURCE_NOT_FOUND', 'not found');
      const done = await operation(client);
      committed.push({ events, parts: done.parts });
      return done.value;
    })),
    executeCreate: jest.fn(async (_client: unknown, _context: unknown, _patient: unknown, idempotencyKey: string,
      operation: string, digest: string, _type: string, create: () => Promise<{ value: unknown; id: string }>,
      load: (id: string) => Promise<unknown>) => {
      operations.push(operation);
      const store = open?.keys ?? keys;
      const held = store.get(`${operation}:${idempotencyKey}`);
      if (held) {
        if (held.digest !== digest) {
          throw new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
        }
        return { value: await load(held.id), resourceId: held.id, details: { idempotentReplay: true } };
      }
      const created = await create();
      store.set(`${operation}:${idempotencyKey}`, { digest, id: created.id });
      return { value: created.value, resourceId: created.id, details: { idempotentReplay: false } };
    }),
    encounterExists: jest.fn(async () => true),
    exists: jest.fn(async () => true),
    setChangeReason: jest.fn(async () => undefined),
  };
  return { rows, keys, operations, statements, committed, repository, client, query };
};

/** Lab accepts each order; `answers` overrides it per call, in order. */
const lab = (answers: ((order: { sourceEhrOrderId: string }, signal?: AbortSignal) => Promise<unknown>)[] = []) => {
  const calls: { order: Record<string, unknown>; key: string; signal?: AbortSignal }[] = [];
  let active = 0;
  let most = 0;
  const acceptEhrOrder = jest.fn(async (_context: unknown, order: Record<string, unknown>, orderKey: string,
    signal?: AbortSignal) => {
    calls.push({ order, key: orderKey, signal });
    active += 1;
    most = Math.max(most, active);
    try {
      const answer = answers[calls.length - 1];
      if (answer) return await answer(order as { sourceEhrOrderId: string }, signal);
      await Promise.resolve();
      return { id: `work-item-for-${String(order.sourceEhrOrderId)}`, status: 'accepted' };
    } finally {
      active -= 1;
    }
  });
  return { labApi: { acceptEhrOrder }, calls, most: () => most };
};

const service = (store: ReturnType<typeof memory>, labApi: unknown, enabled = true) =>
  new LabRequestsService(store.repository as never, labApi as never, noRoutes as never, new LabRequestGroups(enabled));
const labProblem = (status: number, code: string) => new DomainProblem(status, code, `Lab answered ${code}`);
const inserts = (store: ReturnType<typeof memory>) => store.statements.filter(({ sql }) => /insert into ehr\.lab_requests/.test(sql));

describe('ORD-6: several tests in one lab request (LAB_REQUEST_GROUPS_ENABLED on)', () => {
  it('saves every test in one transaction as its own lab request, linked by one group id ehr-api makes', async () => {
    const store = memory();
    const { labApi } = lab();
    const answer = await service(store, labApi).createGroup(context(), patientId, encounterId, group(), key, Date.now());
    expect(store.repository.runParts).toHaveBeenCalledTimes(1);
    expect(store.repository.run).not.toHaveBeenCalled();
    expect(answer.requestGroupId).toMatch(UUID_V4);
    expect(inserts(store).map(({ sql, values }) => [/request_group_id\s*\) values/.test(sql), values[13]]))
      .toEqual([[true, answer.requestGroupId], [true, answer.requestGroupId], [true, answer.requestGroupId]]);
    // In the order sent; each test with its own fields and the group's status, priority and clinical information.
    expect(answer.labRequests.map((request) => [request.testDisplay, request.testCodeSystem, request.testCode,
      request.priority, request.status, request.specimenTypeCode, request.clinicalInformation, request.requestGroupId]))
      .toEqual([
        ['Full blood count', 'LOINC', '58410-2', 'routine', 'active', 'Blood (EDTA)', 'Fever for 3 days', answer.requestGroupId],
        ['Malaria rapid diagnostic test', 'HID-LAB', 'MP-RDT', 'urgent', 'active', null, 'Fever for 3 days',
          answer.requestGroupId],
        ['Sickling test', null, null, 'routine', 'active', null, 'Fever for 3 days', answer.requestGroupId],
      ]);
    expect(new Set(answer.labRequests.map((request) => request.id)).size).toBe(3);
    expect(answer.labRequests.every((request) => !('createdAtExact' in request))).toBe(true);
  });

  it('one Idempotency-Key: a whole-call row naming the group, and a part row per test, named apart from the single create',
    async () => {
      const store = memory();
      const answer = await service(store, lab().labApi).createGroup(context(), patientId, encounterId, group(), key,
        Date.now());
      expect(LAB_REQUEST_GROUP_OPERATION).toBe('lab-request-group.create');
      expect([0, 1, 19].map(LAB_REQUEST_GROUP_PART)).toEqual(['lab-request-group.test.1', 'lab-request-group.test.2',
        'lab-request-group.test.20']);
      expect(store.operations).toEqual(['lab-request-group.create', 'lab-request-group.test.1', 'lab-request-group.test.2',
        'lab-request-group.test.3']);
      expect(store.operations).not.toContain('lab-request.create');
      // The whole-call row's result is the group, not a table row; the part rows name their requests.
      expect(store.keys.get(`lab-request-group.create:${key}`)?.id).toBe(answer.requestGroupId);
      expect(answer.labRequests.map((_request, index) => store.keys.get(`lab-request-group.test.${index + 1}:${key}`)?.id))
        .toEqual(answer.labRequests.map((request) => request.id));
      expect(store.repository.executeCreate.mock.calls.map((call) => call[6]))
        .toEqual(['lab-request-group', 'lab-request', 'lab-request', 'lab-request']);
    });

  it('audits each test as the single create does, plus one group row: the ids, the count and the status, no test names',
    async () => {
      const store = memory();
      const answer = await service(store, lab().labApi).createGroup(context(), patientId, encounterId, group(), key,
        Date.now());
      const [transaction] = store.committed;
      // A consent refusal writes one denied row per event asked for: each test's, and the group's.
      expect(transaction?.events.map((event) => event.action)).toEqual(['ehr.lab-request.create', 'ehr.lab-request.create',
        'ehr.lab-request.create', 'ehr.lab-request-group.create']);
      const ids = answer.labRequests.map((request) => request.id);
      expect(transaction?.parts).toEqual([
        ...ids.map((id) => ({ event: { action: 'ehr.lab-request.create', resourceType: 'lab-request' }, resourceId: id,
          details: { idempotentReplay: false } })),
        { event: { action: 'ehr.lab-request-group.create', resourceType: 'lab-request-group' },
          resourceId: answer.requestGroupId,
          details: { labRequestIds: ids, count: 3, status: 'active', idempotentReplay: false } },
      ]);
      const groupRow = JSON.stringify(transaction?.parts.at(-1));
      for (const text of ['Full blood count', 'Malaria', 'Sickling', '58410-2', 'MP-RDT', 'Fever']) {
        expect(groupRow).not.toContain(text);
      }
    });

  it('the same key and body replays: the stored group and requests as they are now, every active test sent again',
    async () => {
      const store = memory();
      const first = lab();
      const answer = await service(store, first.labApi).createGroup(context(), patientId, encounterId, group(), key,
        Date.now());
      const again = lab([async () => { throw labProblem(409, 'LAB_ORDER_ALREADY_ACCEPTED'); }]);
      const replay = await service(store, again.labApi).createGroup(context(), patientId, encounterId, group(), key,
        Date.now());
      expect(inserts(store)).toHaveLength(3);
      expect(replay.requestGroupId).toBe(answer.requestGroupId);
      expect(replay.labRequests.map((request) => request.id)).toEqual(answer.labRequests.map((request) => request.id));
      // Lab replays the ones it holds (or answers that it holds them).
      expect(again.calls.map(({ key: orderKey }) => orderKey)).toEqual(first.calls.map(({ key: orderKey }) => orderKey));
      expect(replay.labRequests.map((request) => request.labHandoff)).toEqual([
        { state: 'already_accepted', code: 'LAB_ORDER_ALREADY_ACCEPTED' }, { state: 'accepted' }, { state: 'accepted' }]);
      expect(store.committed[1]?.parts.map((part) => part.details?.idempotentReplay)).toEqual([true, true, true, true]);
    });

  it('a replay answers the group the tests were saved with, whatever the setting says now', async () => {
    const store = memory();
    const answer = await service(store, lab().labApi).createGroup(context(), patientId, encounterId, group(), key,
      Date.now());
    // The whole-call row replays; its parts load the stored rows, not a new id.
    const replay = await service(store, lab().labApi).createGroup(context(), patientId, encounterId, group(), key,
      Date.now());
    expect(replay.labRequests.map((request) => request.requestGroupId)).toEqual(Array(3).fill(answer.requestGroupId));
  });

  it('the same key with another body is 409 IDEMPOTENCY_KEY_REUSED, and nothing more is saved', async () => {
    const store = memory();
    await service(store, lab().labApi).createGroup(context(), patientId, encounterId, group(), key, Date.now());
    const other = { ...group(), clinicalInformation: 'Fever for 4 days' } as CreateLabRequestGroupInput;
    await expect(service(store, lab().labApi).createGroup(context(), patientId, encounterId, other, key, Date.now()))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(store.rows.size).toBe(3);
  });

  it('a test the database refuses leaves no request, no group and no key row: every one, or none', async () => {
    const store = memory();
    const real = store.query.getMockImplementation()!;
    let count = 0;
    store.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (/insert into ehr\.lab_requests/.test(sql) && (count += 1) === 3) {
        throw Object.assign(new Error('violates check constraint'), { code: '23514' });
      }
      return real(sql, values);
    });
    const { labApi } = lab();
    await expect(service(store, labApi).createGroup(context(), patientId, encounterId, group(), key, Date.now()))
      .rejects.toMatchObject({ code: '23514' });
    expect(store.rows.size).toBe(0);
    expect(store.keys.size).toBe(0);
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
  });

  it('asks for the visit first, as the single create does (404 CLINICAL_RESOURCE_NOT_FOUND, nothing saved)', async () => {
    const store = memory();
    store.repository.encounterExists.mockResolvedValue(false);
    await expect(service(store, lab().labApi).createGroup(context(), patientId, encounterId, group(), key, Date.now()))
      .rejects.toMatchObject({ status: 404, code: 'CLINICAL_RESOURCE_NOT_FOUND' });
    expect(store.repository.encounterExists).toHaveBeenCalledWith(store.client, encounterId, patientId, facilityId);
    expect(store.rows.size).toBe(0);
  });

  it('sends each active test after the commit, in order and one at a time, with no group: Lab copies it (0158)', async () => {
    const store = memory();
    let savedBeforeSend = true;
    const send = async (order: { sourceEhrOrderId: string }) => {
      // Committed: the fake keeps a transaction's rows apart until it returns.
      savedBeforeSend &&= store.rows.has(order.sourceEhrOrderId);
      await new Promise((resolve) => setImmediate(resolve));
      return { id: 'work-item', status: 'accepted' };
    };
    const { labApi, calls, most } = lab([send, send, send]);
    const answer = await service(store, labApi).createGroup(context(), patientId, encounterId, group(), key, Date.now());
    expect(savedBeforeSend).toBe(true);
    expect(calls.map(({ order }) => order.sourceEhrOrderId)).toEqual(answer.labRequests.map((request) => request.id));
    expect(most()).toBeLessThanOrEqual(1);
    for (const { order } of calls) expect(Object.keys(order)).not.toContain('requestGroupId');
    // The single create's order, as accept() makes it: the name-only test with both codes null.
    expect(calls[2]?.order).toMatchObject({ sourceEhrOrderVersion: 1, testCodeSystem: null, testCode: null,
      testName: 'Sickling test', priority: 'routine', clinicalIndication: 'Fever for 3 days' });
    expect(calls.map(({ key: orderKey }) => orderKey)).toEqual(answer.labRequests.map((request) => `ehr-order:${request.id}:1`));
    expect(answer.labRequests.map((request) => [request.labWorkItem, request.labHandoff])).toEqual(
      Array(3).fill([{ id: 'work-item', status: 'accepted' }, { state: 'accepted' }]));
  });

  it('a draft group is saved and nothing is sent', async () => {
    const store = memory();
    const { labApi } = lab();
    const answer = await service(store, labApi).createGroup(context(), patientId, encounterId, group('draft'), key,
      Date.now());
    expect(answer.labRequests.map((request) => [request.status, request.labWorkItem, request.labHandoff]))
      .toEqual(Array(3).fill(['draft', null, null]));
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
  });

  it('never fails because of Lab: every request is saved and each labHandoff says what happened', async () => {
    const store = memory();
    const { labApi } = lab([
      async () => { throw labProblem(409, 'LAB_ORDER_NOT_CURRENT'); },
      async () => { throw labProblem(503, 'LAB_SERVICE_UNAVAILABLE'); },
      async () => { throw labProblem(409, 'LAB_ORDER_ALREADY_ACCEPTED'); },
    ]);
    const answer = await service(store, labApi).createGroup(context(), patientId, encounterId, group(), key, Date.now());
    expect(store.rows.size).toBe(3);
    expect(answer.labRequests.map((request) => [request.labWorkItem, request.labHandoff])).toEqual([
      [null, { state: 'failed', status: 409, code: 'LAB_ORDER_NOT_CURRENT' }],
      [null, { state: 'failed', status: 503, code: 'LAB_SERVICE_UNAVAILABLE' }],
      [null, { state: 'already_accepted', code: 'LAB_ORDER_ALREADY_ACCEPTED' }],
    ]);
  });

  it('without lab.work-item.accept each active test is not_sent LAB_PERMISSION_ABSENT, and Lab is not called', async () => {
    const store = memory();
    const { labApi } = lab();
    const answer = await service(store, labApi).createGroup(context(['ehr.lab-request.write']), patientId, encounterId,
      group(), key, Date.now());
    expect(answer.labRequests.map((request) => request.labHandoff))
      .toEqual(Array(3).fill({ state: 'not_sent', code: 'LAB_PERMISSION_ABSENT' }));
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
  });
});

describe('ORD-6: one deadline for the sends, 25 s after the request reached ehr-api', () => {
  afterEach(() => jest.useRealTimers());

  it('gives each send the time left: one cut off is failed 503 LAB_SERVICE_UNAVAILABLE, the rest not tried', async () => {
    jest.useFakeTimers({ now: new Date('2026-12-01T09:00:00.000Z') });
    const store = memory();
    // Lab never answers: each send ends only when its signal aborts, as LabApiService answers an aborted call.
    const hang = (_order: unknown, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(labProblem(503, 'LAB_SERVICE_UNAVAILABLE')), { once: true });
    });
    const { labApi, calls } = lab([hang, hang, hang]);
    const receivedAt = Date.now() - 10_000;
    expect(LAB_REQUEST_GROUP_SEND_DEADLINE_MS).toBe(25_000);
    const pending = service(store, labApi).createGroup(context(), patientId, encounterId, group(), key, receivedAt);
    await settle();
    expect(calls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(14_999);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const answer = await pending;
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(answer.labRequests.map((request) => request.labHandoff)).toEqual([
      { state: 'failed', status: 503, code: 'LAB_SERVICE_UNAVAILABLE' },
      { state: 'failed', status: 503, code: 'LAB_HANDOFF_NOT_TRIED' },
      { state: 'failed', status: 503, code: 'LAB_HANDOFF_NOT_TRIED' },
    ]);
    // Every request is saved; "Send to lab" sends either kind of failure later.
    expect(store.rows.size).toBe(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a send that ends in time clears its timer, and the next send gets what is left', async () => {
    jest.useFakeTimers({ now: new Date('2026-12-01T09:00:00.000Z') });
    const store = memory();
    const slow = (_order: unknown, signal?: AbortSignal) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ id: 'work-item', status: 'accepted' }), 6_000);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(labProblem(503, 'LAB_SERVICE_UNAVAILABLE')); },
        { once: true });
    });
    const { labApi, calls } = lab([slow, slow, slow]);
    const pending = service(store, labApi).createGroup(context(), patientId, encounterId, group(), key, Date.now() - 10_000);
    await settle();
    // 15 s left: two sends of 6 s end in time; the third is cut off at the deadline, 3 s in.
    await jest.advanceTimersByTimeAsync(15_000);
    const answer = await pending;
    expect(calls).toHaveLength(3);
    expect(answer.labRequests.map((request) => request.labHandoff)).toEqual([{ state: 'accepted' }, { state: 'accepted' },
      { state: 'failed', status: 503, code: 'LAB_SERVICE_UNAVAILABLE' }]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('when the deadline has passed before the first send, no test is tried, and the group is still saved', async () => {
    const store = memory();
    const { labApi } = lab();
    const answer = await service(store, labApi).createGroup(context(), patientId, encounterId, group(), key,
      Date.now() - LAB_REQUEST_GROUP_SEND_DEADLINE_MS);
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
    expect(answer.labRequests.map((request) => [request.labWorkItem, request.labHandoff]))
      .toEqual(Array(3).fill([null, { state: 'failed', status: 503, code: 'LAB_HANDOFF_NOT_TRIED' }]));
    expect(store.rows.size).toBe(3);
  });
});

describe('ORD-6 option (b): createInTransaction as ORD-8 (0180) calls it', () => {
  // ORD-8's own part names, inside its own transaction; it sends to Lab after its own commit.
  const orderSetPart = (index: number) => `order-set.apply.lab-request.${index + 1}`;

  it('setting off: every test is saved with a null group, requestGroupId null, and no group audit row', async () => {
    const store = memory();
    const { labApi } = lab();
    const saved = await service(store, labApi, false).createInTransaction(store.client as never, context(), patientId,
      encounterId, group('draft'), key, orderSetPart);
    expect(saved.requestGroupId).toBeNull();
    expect(inserts(store).map(({ values }) => values[13])).toEqual([null, null, null]);
    expect(saved.labRequests.map((request) => request.requestGroupId)).toEqual([null, null, null]);
    expect(saved.parts.map((part) => part.event.action)).toEqual(Array(3).fill('ehr.lab-request.create'));
    expect(store.operations).toEqual(['order-set.apply.lab-request.1', 'order-set.apply.lab-request.2',
      'order-set.apply.lab-request.3']);
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
  });

  it('setting on: one id for all, and the group audit row', async () => {
    const store = memory();
    const saved = await service(store, lab().labApi, true).createInTransaction(store.client as never, context(), patientId,
      encounterId, group('draft'), key, orderSetPart);
    expect(saved.requestGroupId).toMatch(UUID_V4);
    expect(inserts(store).map(({ values }) => values[13])).toEqual(Array(3).fill(saved.requestGroupId));
    expect(saved.parts.at(-1)).toMatchObject({ event: { action: 'ehr.lab-request-group.create' },
      resourceId: saved.requestGroupId, details: { count: 3, status: 'draft' } });
  });

  it('each call makes its own group: two groups never share an id', async () => {
    const store = memory();
    const labRequests = service(store, lab().labApi, true);
    const one = await labRequests.createInTransaction(store.client as never, context(), patientId, encounterId,
      group('draft'), 'lab-request-group-key-0001', orderSetPart);
    const two = await labRequests.createInTransaction(store.client as never, context(), patientId, encounterId,
      group('draft'), 'lab-request-group-key-0002', orderSetPart);
    expect(one.requestGroupId).not.toBe(two.requestGroupId);
  });
});

describe('ORD-6 with LAB_REQUEST_GROUPS_ENABLED off: no new group, stored groups still answered', () => {
  const storedGroup = '323e4567-e89b-42d3-a456-426614174099';
  const stored = { id: '223e4567-e89b-42d3-a456-000000000077', encounterId, patientId, facilityId, createdBy: accountId,
    createdByMembershipId: membershipId, testCodeSystem: 'LOINC', testCode: '58410-2', testDisplay: 'Full blood count',
    priority: 'routine', status: OrderStatus.Active, specimenTypeCode: null, clinicalInformation: null,
    externalOrderReference: null, requestGroupId: storedGroup, rowVersion: '1',
    createdAt: new Date('2026-12-01T09:00:00.123Z'), updatedAt: new Date('2026-12-01T09:00:00.123Z'),
    cursorAt: '2026-12-01T09:00:00.123456Z' };
  const reader = () => {
    const statements: { sql: string; values: unknown[] }[] = [];
    const query = jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      if (/from ehr\.encounters/.test(sql)) return { rows: [{ status: 'in_progress' }] };
      return { rows: [stored, { ...stored, id: '223e4567-e89b-42d3-a456-000000000078' }] };
    });
    const repository = { run: jest.fn(async (_c: unknown, _p: unknown, _a: unknown, _e: unknown,
      operation: (client: unknown) => Promise<{ value: unknown }>) => (await operation({ query })).value),
    runParts: jest.fn(), executeCreate: jest.fn(async (...args: unknown[]) => (args[7] as () => Promise<unknown>)()),
    setChangeReason: jest.fn(async () => undefined), exists: jest.fn(async () => true) };
    return { statements, repository, labRequests: new LabRequestsService(repository as never, lab().labApi as never,
      noRoutes as never, new LabRequestGroups(false)) };
  };

  it('the group create answers 503 LAB_REQUEST_GROUPS_UNAVAILABLE and writes nothing', async () => {
    const { repository, labRequests } = reader();
    await expect(labRequests.createGroup(context(), patientId, encounterId, group(), key, Date.now()))
      .rejects.toMatchObject({ status: 503, code: 'LAB_REQUEST_GROUPS_UNAVAILABLE',
        message: 'Several tests in one request are not available yet. Add each test on its own.' });
    expect(repository.runParts).not.toHaveBeenCalled();
    expect(repository.executeCreate).not.toHaveBeenCalled();
  });

  it('the list and the read answer a stored group, and the list\'s ?requestGroupId= keeps to it', async () => {
    const { statements, labRequests } = reader();
    const page = await labRequests.list(context(), patientId, encounterId, { limit: 1, requestGroupId: storedGroup });
    expect(page.items).toEqual([expect.objectContaining({ id: stored.id, requestGroupId: storedGroup })]);
    expect(statements[0]?.sql).toMatch(/request_group_id as "requestGroupId"/);
    expect(statements[0]?.sql).toMatch(/and \(\$7::uuid is null or request_group_id = \$7::uuid\)/);
    expect(statements[0]?.values[6]).toBe(storedGroup);
    await expect(labRequests.get(context(), patientId, encounterId, stored.id))
      .resolves.toMatchObject({ id: stored.id, requestGroupId: storedGroup });
    // Without the filter, the list is as before ($7 null).
    await labRequests.list(context(), patientId, encounterId, { limit: 1 });
    expect(statements.at(-1)?.values[6]).toBeNull();
  });

  it('a cursor binds the filter: a group\'s cursor pages no other group and no unfiltered list (400 INVALID_CURSOR)',
    async () => {
      const { labRequests } = reader();
      const filtered = await labRequests.list(context(), patientId, encounterId, { limit: 1, requestGroupId: storedGroup });
      const plain = await labRequests.list(context(), patientId, encounterId, { limit: 1 });
      expect(filtered.nextCursor).toEqual(expect.any(String));
      expect(filtered.nextCursor).not.toBe(plain.nextCursor);
      await expect(labRequests.list(context(), patientId, encounterId, { limit: 1, cursor: filtered.nextCursor! }))
        .rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
      await expect(labRequests.list(context(), patientId, encounterId, { limit: 1, cursor: plain.nextCursor!,
        requestGroupId: storedGroup })).rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
      await expect(labRequests.list(context(), patientId, encounterId, { limit: 1, cursor: filtered.nextCursor!,
        requestGroupId: '323e4567-e89b-42d3-a456-426614174098' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
      // Each cursor pages its own list, and the group's id is matched whatever its case.
      await expect(labRequests.list(context(), patientId, encounterId, { limit: 1, cursor: filtered.nextCursor!,
        requestGroupId: storedGroup.toUpperCase() })).resolves.toMatchObject({ items: [expect.anything()] });
      await expect(labRequests.list(context(), patientId, encounterId, { limit: 1, cursor: plain.nextCursor! }))
        .resolves.toMatchObject({ items: [expect.anything()] });
    });

  it('the single create writes no group whatever the setting says, and answers requestGroupId null', async () => {
    for (const enabled of [false, true]) {
      const store = memory();
      const labRequests = service(store, lab().labApi, enabled);
      const created = await labRequests.create(context(), patientId, encounterId, { testCodeSystem: 'LOINC',
        testCode: '58410-2', testDisplay: 'Full blood count', priority: 'routine', status: OrderStatus.Draft } as never,
      'lab-request-key-0001');
      expect(inserts(store).map(({ values }) => values[13])).toEqual([null]);
      expect(created).toMatchObject({ requestGroupId: null, labHandoff: null });
      expect(store.operations).toEqual(['lab-request.create']);
    }
  });

  it('an update never names the group, so 0158\'s guard is never met, and answers the stored group', async () => {
    const { statements, labRequests } = reader();
    const updated = await labRequests.update(context(), patientId, encounterId, stored.id,
      { expectedRowVersion: 1, status: OrderStatus.OnHold, changeReason: 'Patient not fasting' } as never);
    const update = statements.find(({ sql }) => /^\s*update ehr\.lab_requests/.test(sql));
    expect(update?.sql.split(/\bwhere\b/)[0]).not.toMatch(/request_group_id/);
    expect(updated).toMatchObject({ requestGroupId: storedGroup });
  });
});
