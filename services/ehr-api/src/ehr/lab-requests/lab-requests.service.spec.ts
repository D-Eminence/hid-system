import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { timelineCursorSql } from '../shared/clinical-context';
import { OrderStatus } from '../shared/clinical.dto';
import { LabRequestsService, type LabRequestRow } from './lab-requests.service';

const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const requestId = '123e4567-e89b-42d3-a456-426614174005';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';

const context = { correlationId: 'correlation-123456', facilityId, membershipId,
  purposeOfUse: 'direct-care', authorization: 'Bearer user', actor: { id: accountId,
    subject: 'staff:test', accountId, authenticationMethod: 'local', roles: ['doctor'],
    permissions: [], facilityIds: [facilityId], facilities: [],
    facility: { id: facilityId, membershipId, organizationId: facilityId, name: 'Test',
      roles: ['doctor'], permissions: [], isPrimary: true } } } as DataAccessContext;

// ehr.lab_requests.created_at defaults to clock_timestamp(), which keeps
// microseconds. node-postgres returns it as a Date, which keeps milliseconds.
const createdAtExact = '2026-10-01T09:00:00.123456Z';
// The microsecond text of created_at, as lab-session-guards.integration.sql
// proves Lab's acceptance guard needs it.
const exactColumn = `${timelineCursorSql('created_at')} as "createdAtExact"`;
const row = (status: OrderStatus): LabRequestRow => ({
  id: requestId, encounterId, patientId, facilityId, createdBy: accountId, createdByMembershipId: membershipId,
  testCodeSystem: 'loinc', testCode: '718-7', testDisplay: 'Hemoglobin', priority: 'routine', status,
  specimenTypeCode: null, clinicalInformation: 'Fatigue', externalOrderReference: null, rowVersion: '1',
  createdAt: new Date('2026-10-01T09:00:00.123Z'), updatedAt: new Date('2026-10-01T09:00:00.123Z'),
});

describe('LabRequestsService handoff to Lab', () => {
  const labApi = { acceptEhrOrder: jest.fn() };
  // The encounter is open (CLIN-EIE): the share-locked status check passes.
  const repository = { run: jest.fn(), executeCreate: jest.fn(),
    requireOpenEncounter: jest.fn(async () => 'in_progress'), lockEncounterStatus: jest.fn(async () => 'in_progress') };
  const input = { testCodeSystem: 'loinc', testCode: '718-7', testDisplay: 'Hemoglobin', priority: 'routine',
    status: OrderStatus.Active, clinicalInformation: 'Fatigue' };

  // A fake database: it returns the row, and the exact text of created_at only
  // when the statement selects it.
  const serviceFor = (stored: LabRequestRow) => {
    const query = jest.fn(async (sql: string) => ({ rows: [{ ...stored,
      ...(sql.includes('as "createdAtExact"') ? { createdAtExact } : {}) }] }));
    repository.run.mockImplementation(async (_context, _patientId, _access, _event, operation) =>
      (await operation({ query })).value);
    repository.executeCreate.mockImplementation(async (_client, _context, _patientId, _key, _operation, _digest,
      _type, create) => create());
    return { query, service: new LabRequestsService(repository as never, labApi as never) };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    labApi.acceptEhrOrder.mockResolvedValue({ id: '123e4567-e89b-42d3-a456-426614174007' });
  });

  it('sends Lab the order time at the microsecond, as the database stores it', async () => {
    const { query, service } = serviceFor(row(OrderStatus.Active));
    await service.create(context, patientId, encounterId, input as never, 'lab-request-key-1234');
    expect(timelineCursorSql('created_at')).toBe(`to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
    expect(query.mock.calls.map(([sql]) => sql).filter((sql) => /insert into ehr\.lab_requests/i.test(sql)))
      .toEqual([expect.stringContaining(exactColumn)]);
    expect(labApi.acceptEhrOrder).toHaveBeenCalledTimes(1);
    expect(labApi.acceptEhrOrder.mock.calls[0]?.[1]).toMatchObject({ sourceEhrOrderId: requestId,
      sourceEhrOrderVersion: 1, requestedAt: createdAtExact });
    expect(labApi.acceptEhrOrder.mock.calls[0]?.[2]).toBe(`ehr-order:${requestId}:1`);
  });

  it('keeps the exact time out of the response', async () => {
    const { service } = serviceFor(row(OrderStatus.Active));
    const created = await service.create(context, patientId, encounterId, input as never, 'lab-request-key-1234');
    expect(created).not.toHaveProperty('createdAtExact');
    expect(created).toMatchObject({ id: requestId, createdAt: new Date('2026-10-01T09:00:00.123Z') });
  });

  it('reads the exact time on an idempotent replay too', async () => {
    const { query, service } = serviceFor(row(OrderStatus.Active));
    repository.executeCreate.mockImplementation(async (_client, _context, _patientId, _key, _operation, _digest,
      _type, _create, load) => ({ value: await load(requestId), id: requestId }));
    await service.create(context, patientId, encounterId, input as never, 'lab-request-key-1234');
    expect(query.mock.calls.map(([sql]) => sql).filter((sql) => /from ehr\.lab_requests/i.test(sql)))
      .toEqual([expect.stringContaining(exactColumn)]);
    expect(labApi.acceptEhrOrder.mock.calls[0]?.[1]).toMatchObject({ requestedAt: createdAtExact });
  });

  it('does not contact Lab for a draft order', async () => {
    const { service } = serviceFor(row(OrderStatus.Draft));
    const created = await service.create(context, patientId, encounterId,
      { ...input, status: OrderStatus.Draft } as never, 'lab-request-key-1234');
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
    expect(created).toMatchObject({ labWorkItem: null });
  });
});

// A Lab answer as LabApiService translates it: Lab's own status and code, or
// 503 LAB_SERVICE_UNAVAILABLE when Lab could not be reached.
const labProblem = (status: number, code: string) => new DomainProblem(status, code, `Lab answered ${code}`);
const withLabPermission = { ...context, actor: { ...context.actor,
  permissions: ['ehr.lab-request.write', 'lab.work-item.accept'] } } as DataAccessContext;
const workItem = { id: '123e4567-e89b-42d3-a456-426614174007', sourceEhrOrderId: requestId, status: 'accepted' };

/**
 * A fake database for one lab request: `before` is the stored row, which reads
 * and the row lock return; `after` is what an UPDATE of it returns. Each
 * carries the exact text of created_at only when the statement selects it.
 */
const fakeDatabase = (before: LabRequestRow, after: LabRequestRow = before) => {
  const query = jest.fn(async (sql: string) => {
    const stored = /^\s*update\s+ehr\.lab_requests\b/i.test(sql) ? after : before;
    return { rows: [{ ...stored, ...(sql.includes('as "createdAtExact"') ? { createdAtExact } : {}) }] };
  });
  const repository = {
    run: jest.fn(async (_context: unknown, _patientId: unknown, _access: unknown, _event: unknown,
      operation: (client: unknown) => Promise<{ value: unknown }>) => (await operation({ query })).value),
    // executeCreate(client, context, patientId, key, operation, digest, type, create, load): a first request creates.
    executeCreate: jest.fn(async (...args: unknown[]) => (args[7] as () => Promise<unknown>)()),
    setChangeReason: jest.fn(async () => undefined),
    exists: jest.fn(async () => true),
    // The encounter is open (CLIN-EIE): the share-locked status check passes.
    requireOpenEncounter: jest.fn(async () => 'in_progress'),
    lockEncounterStatus: jest.fn(async () => 'in_progress'),
  };
  const labApi = { acceptEhrOrder: jest.fn().mockResolvedValue(workItem) };
  return { query, repository, labApi, service: new LabRequestsService(repository as never, labApi as never) };
};
const at = (status: OrderStatus, rowVersion: string) => ({ ...row(status), rowVersion });
const writes = (query: jest.Mock) => query.mock.calls.map(([sql]) => String(sql))
  .filter((sql) => /\b(insert|update|delete)\b|\bfor\s+(update|share|no key update|key share)\b/i.test(sql));

describe('LabRequestsService create when Lab does not accept the saved order', () => {
  const input = { testCodeSystem: 'loinc', testCode: '718-7', testDisplay: 'Hemoglobin', priority: 'routine',
    status: OrderStatus.Active, clinicalInformation: 'Fatigue' };

  it('reports a Lab that could not be reached as 502 LAB_HANDOFF_UNCONFIRMED, naming the saved request', async () => {
    const { query, labApi, service } = fakeDatabase(row(OrderStatus.Active));
    labApi.acceptEhrOrder.mockRejectedValue(labProblem(503, 'LAB_SERVICE_UNAVAILABLE'));
    const refusal = await service.create(context, patientId, encounterId, input as never, 'lab-request-key-1234')
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: 'LAB_HANDOFF_UNCONFIRMED', status: 502 });
    expect((refusal as DomainProblem).getResponse()).toEqual(expect.stringContaining(requestId));
    expect(query.mock.calls.filter(([sql]) => /insert into ehr\.lab_requests/i.test(String(sql)))).toHaveLength(1);
  });

  it.each([[409, 'IDEMPOTENCY_CONFLICT'], [403, 'LAB_WORK_ITEM_ACCESS_DENIED'], [409, 'LAB_ORDER_NOT_CURRENT'],
    [400, 'VALIDATION_FAILED']])('reports a Lab %i %s as 409 LAB_HANDOFF_REFUSED, naming the saved request and Lab\'s code',
    async (status, code) => {
      const { labApi, service } = fakeDatabase(row(OrderStatus.Active));
      labApi.acceptEhrOrder.mockRejectedValue(labProblem(status, code));
      const refusal = await service.create(context, patientId, encounterId, input as never, 'lab-request-key-1234')
        .catch((error: unknown) => error);
      expect(refusal).toMatchObject({ code: 'LAB_HANDOFF_REFUSED', status: 409 });
      expect((refusal as DomainProblem).getResponse()).toEqual(expect.stringContaining(requestId));
      expect((refusal as DomainProblem).getResponse()).toEqual(expect.stringContaining(code));
    });

  // A Lab 401 means Lab could not verify the EHR's workload identity (or its
  // JWKS), a 429 that Lab is shedding load: neither is Lab's verdict on the
  // request, which can be sent again as it is.
  it.each([[401, 'INTERNAL_SERVICE_AUTH_REQUIRED'], [407, 'PROXY_AUTHENTICATION_REQUIRED'], [429, 'RATE_LIMITED']])(
    'reports a Lab %i %s, which is no refusal of the request, as 502 LAB_HANDOFF_UNCONFIRMED', async (status, code) => {
      const { labApi, service } = fakeDatabase(row(OrderStatus.Active));
      labApi.acceptEhrOrder.mockRejectedValue(labProblem(status, code));
      const refusal = await service.create(context, patientId, encounterId, input as never, 'lab-request-key-1234')
        .catch((error: unknown) => error);
      expect(refusal).toMatchObject({ code: 'LAB_HANDOFF_UNCONFIRMED', status: 502 });
      expect((refusal as DomainProblem).getResponse()).toEqual(expect.stringContaining(requestId));
      expect((refusal as DomainProblem).getResponse()).toEqual(expect.stringContaining(code));
    });

  it('reports the work item Lab accepted', async () => {
    const { service } = fakeDatabase(row(OrderStatus.Active));
    await expect(service.create(context, patientId, encounterId, input as never, 'lab-request-key-1234'))
      .resolves.toMatchObject({ id: requestId, labWorkItem: workItem, labHandoff: { state: 'accepted' } });
  });

  it('treats an order Lab already holds at another version as handed off on a replay', async () => {
    const { repository, labApi, service } = fakeDatabase(at(OrderStatus.Active, '2'));
    // A replay of the key loads the stored request.
    repository.executeCreate.mockImplementation(async (...args: unknown[]) =>
      ({ value: await (args[8] as (id: string) => Promise<unknown>)(requestId), id: requestId }));
    labApi.acceptEhrOrder.mockRejectedValue(labProblem(409, 'LAB_ORDER_ALREADY_ACCEPTED'));
    await expect(service.create(context, patientId, encounterId, input as never, 'lab-request-key-1234'))
      .resolves.toMatchObject({ id: requestId, labWorkItem: null,
        labHandoff: { state: 'already_accepted', code: 'LAB_ORDER_ALREADY_ACCEPTED' } });
  });
});

// The explicit send (or re-send) of an active lab request to Lab, the
// counterpart of a prescription's pharmacy-work-item command. Called loosely so
// that this spec states the contract of a method the service may not have.
type SendToLab = (context: DataAccessContext, patientId: string, encounterId: string, requestId: string,
  input: { expectedRowVersion: number }) => Promise<unknown>;
const sendToLab = (service: LabRequestsService): SendToLab => {
  const method = (service as unknown as { sendToLab?: SendToLab }).sendToLab;
  if (typeof method !== 'function') throw new Error('LabRequestsService has no sendToLab command');
  return method.bind(service);
};

describe('LabRequestsService sendToLab', () => {
  it('sends the stored active version, at its exact time, reading it without a lock or a write', async () => {
    const { query, repository, labApi, service } = fakeDatabase(at(OrderStatus.Active, '2'));
    await expect(sendToLab(service)(withLabPermission, patientId, encounterId, requestId, { expectedRowVersion: 2 }))
      .resolves.toEqual(workItem);
    expect(labApi.acceptEhrOrder).toHaveBeenCalledTimes(1);
    expect(labApi.acceptEhrOrder.mock.calls[0]?.[1]).toMatchObject({ sourceEhrOrderId: requestId, sourceEhrOrderVersion: 2,
      requestedAt: createdAtExact });
    expect(labApi.acceptEhrOrder.mock.calls[0]?.[2]).toBe(`ehr-order:${requestId}:2`);
    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([expect.stringContaining(exactColumn)]);
    expect(writes(query)).toEqual([]);
    expect(repository.run).toHaveBeenCalledWith(withLabPermission, patientId, 'write_records', expect.objectContaining({
      action: 'ehr.lab-request.lab-handoff.eligibility-checked', resourceType: 'lab-request', resourceId: requestId }),
    expect.any(Function), expect.any(Function));
  });

  it('refuses a version that is not the stored one with 412 LAB_REQUEST_VERSION_CONFLICT, without contacting Lab', async () => {
    const { labApi, service } = fakeDatabase(at(OrderStatus.Active, '2'));
    await expect(sendToLab(service)(withLabPermission, patientId, encounterId, requestId, { expectedRowVersion: 1 }))
      .rejects.toMatchObject({ code: 'LAB_REQUEST_VERSION_CONFLICT', status: 412 });
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
  });

  it.each([OrderStatus.Draft, OrderStatus.OnHold, OrderStatus.Cancelled, OrderStatus.Completed])(
    'refuses a %s request with 409 LAB_REQUEST_NOT_ELIGIBLE, without contacting Lab', async (status) => {
      const { labApi, service } = fakeDatabase(at(status, '1'));
      await expect(sendToLab(service)(withLabPermission, patientId, encounterId, requestId, { expectedRowVersion: 1 }))
        .rejects.toMatchObject({ code: 'LAB_REQUEST_NOT_ELIGIBLE', status: 409 });
      expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
    });

  it.each([[409, 'LAB_ORDER_ALREADY_ACCEPTED'], [409, 'LAB_ORDER_NOT_CURRENT'], [403, 'LAB_WORK_ITEM_ACCESS_DENIED'],
    [400, 'VALIDATION_FAILED']])('passes Lab\'s refusal %i %s through unchanged, since the EHR wrote nothing',
    async (status, code) => {
      const { labApi, service } = fakeDatabase(at(OrderStatus.Active, '2'));
      const refusal = labProblem(status, code);
      labApi.acceptEhrOrder.mockRejectedValue(refusal);
      await expect(sendToLab(service)(withLabPermission, patientId, encounterId, requestId, { expectedRowVersion: 2 }))
        .rejects.toBe(refusal);
    });

  // Health-id takes any 401 on a cookie request for its own expired session: it
  // refreshes, repeats the request and, on a second 401, signs the clinician
  // out. Lab answers 401 when it cannot verify the EHR's workload identity, a
  // fault of the services, not of the clinician's session.
  it.each([[401, 'INTERNAL_SERVICE_AUTH_REQUIRED'], [407, 'PROXY_AUTHENTICATION_REQUIRED'], [429, 'RATE_LIMITED'],
    [500, 'INTERNAL_ERROR'], [503, 'LAB_SERVICE_UNAVAILABLE']])(
    'answers a Lab %i %s as 502 LAB_HANDOFF_UNCONFIRMED, never with Lab\'s status', async (status, code) => {
      const { labApi, service } = fakeDatabase(at(OrderStatus.Active, '2'));
      labApi.acceptEhrOrder.mockRejectedValue(labProblem(status, code));
      const refusal = await sendToLab(service)(withLabPermission, patientId, encounterId, requestId, { expectedRowVersion: 2 })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(DomainProblem);
      expect(refusal).toMatchObject({ code: 'LAB_HANDOFF_UNCONFIRMED', status: 502 });
      expect((refusal as DomainProblem).getResponse()).toEqual(expect.stringContaining(requestId));
      expect((refusal as DomainProblem).getResponse()).toEqual(expect.stringContaining(code));
    });
});

describe('LabRequestsService update sends the active version to Lab', () => {
  const update = (service: LabRequestsService, input: Record<string, unknown>, actor = withLabPermission) =>
    service.update(actor, patientId, encounterId, requestId, { changeReason: 'Clinical review', ...input } as never);

  it('activating a draft sends version 2 at its exact time and reports the work item', async () => {
    const { labApi, service } = fakeDatabase(at(OrderStatus.Draft, '1'), at(OrderStatus.Active, '2'));
    const updated = await update(service, { status: OrderStatus.Active, expectedRowVersion: 1 });
    expect(labApi.acceptEhrOrder).toHaveBeenCalledTimes(1);
    expect(labApi.acceptEhrOrder.mock.calls[0]?.[1]).toMatchObject({ sourceEhrOrderVersion: 2, requestedAt: createdAtExact });
    expect(labApi.acceptEhrOrder.mock.calls[0]?.[2]).toBe(`ehr-order:${requestId}:2`);
    expect(updated).toMatchObject({ status: OrderStatus.Active, rowVersion: '2', labWorkItem: workItem,
      labHandoff: { state: 'accepted' } });
    expect(updated).not.toHaveProperty('createdAtExact');
  });

  it('resuming an on-hold request sends its current version', async () => {
    const { labApi, service } = fakeDatabase(at(OrderStatus.OnHold, '3'), at(OrderStatus.Active, '4'));
    await update(service, { status: OrderStatus.Active, expectedRowVersion: 3 });
    expect(labApi.acceptEhrOrder.mock.calls[0]?.[1]).toMatchObject({ sourceEhrOrderVersion: 4 });
  });

  it('does not contact Lab when the request is no longer active', async () => {
    const { labApi, service } = fakeDatabase(at(OrderStatus.Active, '1'), at(OrderStatus.Cancelled, '2'));
    await expect(update(service, { status: OrderStatus.Cancelled, expectedRowVersion: 1 }))
      .resolves.toMatchObject({ status: OrderStatus.Cancelled, labWorkItem: null, labHandoff: null });
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
  });

  it('keeps the committed update and reports a Lab failure in labHandoff', async () => {
    const { query, labApi, service } = fakeDatabase(at(OrderStatus.Draft, '1'), at(OrderStatus.Active, '2'));
    labApi.acceptEhrOrder.mockRejectedValue(labProblem(503, 'LAB_SERVICE_UNAVAILABLE'));
    await expect(update(service, { status: OrderStatus.Active, expectedRowVersion: 1 })).resolves.toMatchObject({
      status: OrderStatus.Active, labWorkItem: null,
      labHandoff: { state: 'failed', status: 503, code: 'LAB_SERVICE_UNAVAILABLE' } });
    expect(query.mock.calls.filter(([sql]) => /^\s*update\s+ehr\.lab_requests/i.test(String(sql)))).toHaveLength(1);
  });

  it('reports an order Lab already holds at an earlier version', async () => {
    const { labApi, service } = fakeDatabase(at(OrderStatus.Active, '1'), { ...at(OrderStatus.Active, '2'), priority: 'stat' });
    labApi.acceptEhrOrder.mockRejectedValue(labProblem(409, 'LAB_ORDER_ALREADY_ACCEPTED'));
    await expect(update(service, { priority: 'stat', expectedRowVersion: 1 })).resolves.toMatchObject({
      labWorkItem: null, labHandoff: { state: 'already_accepted', code: 'LAB_ORDER_ALREADY_ACCEPTED' } });
  });

  it('does not send for an actor without the Lab acceptance permission', async () => {
    const { labApi, service } = fakeDatabase(at(OrderStatus.Draft, '1'), at(OrderStatus.Active, '2'));
    await expect(update(service, { status: OrderStatus.Active, expectedRowVersion: 1 }, context)).resolves.toMatchObject({
      labWorkItem: null, labHandoff: { state: 'not_sent', code: 'LAB_PERMISSION_ABSENT' } });
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
  });
});

describe('LabRequestsService update of a closed lab request (ORDER-CLOSED-EDIT)', () => {
  const update = (service: LabRequestsService, input: Record<string, unknown>) =>
    service.update(context, patientId, encounterId, requestId,
      { changeReason: 'Clinical review', expectedRowVersion: 3, ...input } as never);
  const updates = (query: jest.Mock) => query.mock.calls.filter(([sql]) => /^\s*update\b/i.test(String(sql)));

  it.each([
    [OrderStatus.Completed, { clinicalInformation: 'Rewritten information' }],
    [OrderStatus.Cancelled, { priority: 'stat' }],
    [OrderStatus.EnteredInError, { clinicalInformation: 'Rewritten information' }],
    [OrderStatus.Cancelled, { status: OrderStatus.Cancelled }],
    [OrderStatus.Completed, { status: OrderStatus.EnteredInError, priority: 'stat' }],
  ])('refuses to change a %s lab request (%j) with 409 LAB_REQUEST_NOT_AMENDABLE before any UPDATE', async (status, fields) => {
    const { query, service } = fakeDatabase(at(status, '3'));
    await expect(update(service, fields)).rejects.toMatchObject({ status: 409, code: 'LAB_REQUEST_NOT_AMENDABLE' });
    expect(updates(query)).toEqual([]);
  });

  it('marks a completed lab request entered in error (ENC-RETRACT-2)', async () => {
    const { query, labApi, service } = fakeDatabase(at(OrderStatus.Completed, '3'), at(OrderStatus.EnteredInError, '4'));
    await expect(update(service, { status: OrderStatus.EnteredInError }))
      .resolves.toMatchObject({ status: OrderStatus.EnteredInError, labWorkItem: null, labHandoff: null });
    expect(updates(query)).toHaveLength(1);
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
  });

  it('keeps answering a cancelled request reactivated with 409 INVALID_LAB_REQUEST_TRANSITION', async () => {
    const { query, service } = fakeDatabase(at(OrderStatus.Cancelled, '3'));
    await expect(update(service, { status: OrderStatus.Active }))
      .rejects.toMatchObject({ status: 409, code: 'INVALID_LAB_REQUEST_TRANSITION' });
    expect(updates(query)).toEqual([]);
  });
});
