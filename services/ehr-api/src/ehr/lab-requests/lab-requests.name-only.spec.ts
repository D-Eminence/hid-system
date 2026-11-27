import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { orderRouteContent, orderRouteResults } from '../order-routes/order-route.mapping';
import { OrderStatus } from '../shared/clinical.dto';
import { CreateLabRequestBodyPipe, NameOnlyCodes } from '../shared/name-only-codes';
import { LabRequestsService, type LabRequestRow } from './lab-requests.service';

/*
 * A lab request by its test name only (0156, ORD-7 F3), while
 * LAB_REQUEST_NAME_ONLY_ENABLED is on: saved with both codes null, answered
 * with both null, and sent to Lab with both null. A Lab image before 0156
 * refuses that (400), which the EHR answers as 409 LAB_HANDOFF_REFUSED, naming
 * the saved request: the rollback floor of "one way once used". Fictional data.
 */

const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const requestId = '123e4567-e89b-42d3-a456-426614174005';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const createdAtExact = '2026-12-01T09:00:00.123456Z';
const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  authorization: 'Bearer user', actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local',
    roles: ['doctor'], permissions: ['ehr.lab-request.write', 'lab.work-item.accept'], facilityIds: [facilityId], facilities: [],
    facility: { id: facilityId, membershipId, organizationId: facilityId, name: 'Test', roles: ['doctor'], permissions: [],
      isPrimary: true } } } as unknown as DataAccessContext;
const noRoutes = { summaries: async () => new Map(), summary: async () => null, crossFacilityOrdersEnabled: async () => false };
const workItem = { id: '123e4567-e89b-42d3-a456-426614174007', sourceEhrOrderId: requestId, status: 'accepted' };

/** The request as the database stores it: both codes null for a request by name only. */
const stored = (status: OrderStatus, rowVersion = '1'): LabRequestRow => ({ id: requestId, encounterId, patientId, facilityId,
  createdBy: accountId, createdByMembershipId: membershipId, testCodeSystem: null, testCode: null,
  testDisplay: 'Sickling test', priority: 'urgent', status, specimenTypeCode: 'blood', clinicalInformation: 'Bone pain',
  externalOrderReference: null, requestGroupId: null, rowVersion, createdAt: new Date('2026-12-01T09:00:00.123Z'),
  updatedAt: new Date('2026-12-01T09:00:00.123Z') });

/** A fake database for one request: reads, the row lock, the insert and the update return `row`. */
const harness = (row: LabRequestRow) => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (/from ehr\.encounters/.test(sql)) return { rows: [{ status: 'in_progress' }] };
    return { rows: [{ ...row, ...(sql.includes('as "createdAtExact"') ? { createdAtExact } : {}) }] };
  });
  const repository = {
    run: jest.fn(async (_c: unknown, _p: unknown, _a: unknown, _e: unknown,
      operation: (client: unknown) => Promise<{ value: unknown }>) => (await operation({ query })).value),
    executeCreate: jest.fn(async (...args: unknown[]) => (args[7] as () => Promise<unknown>)()),
    setChangeReason: jest.fn(async () => undefined),
    exists: jest.fn(async () => true),
  };
  const labApi = { acceptEhrOrder: jest.fn().mockResolvedValue(workItem) };
  return { statements, repository, labApi, service: new LabRequestsService(repository as never, labApi as never,
    noRoutes as never) };
};
const pipe = new CreateLabRequestBodyPipe(new NameOnlyCodes(true, false));
const nameOnly = { testDisplay: 'Sickling test', priority: 'urgent', status: 'active', specimenTypeCode: 'blood',
  clinicalInformation: 'Bone pain' };

describe('a lab request by name only (0156)', () => {
  it('is saved with both codes null, answered with both null and sent to Lab with both null', async () => {
    const { statements, labApi, service } = harness(stored(OrderStatus.Active));
    const created = await service.create(context, patientId, encounterId, await pipe.transform(nameOnly),
      'lab-request-key-1234');
    const insert = statements.find(({ sql }) => /insert into ehr\.lab_requests/.test(sql));
    expect(insert?.sql).toMatch(/test_code_system, test_code, test_display/);
    expect(insert?.values.slice(5, 8)).toEqual([null, null, 'Sickling test']);
    expect(created).toMatchObject({ id: requestId, testCodeSystem: null, testCode: null, testDisplay: 'Sickling test',
      labWorkItem: workItem, labHandoff: { state: 'accepted' } });
    expect(labApi.acceptEhrOrder).toHaveBeenCalledTimes(1);
    expect(labApi.acceptEhrOrder.mock.calls[0]?.[1]).toEqual({ sourceEhrOrderId: requestId, sourceEhrOrderVersion: 1,
      sourceEncounterId: encounterId, patientId, orderingFacilityId: facilityId, testCodeSystem: null, testCode: null,
      testName: 'Sickling test', priority: 'urgent', clinicalIndication: 'Bone pain', requestedBy: accountId,
      requestedAt: createdAtExact });
    // JSON keeps the nulls, so Lab receives both codes as null, never a missing field it might default.
    expect(JSON.parse(JSON.stringify(labApi.acceptEhrOrder.mock.calls[0]?.[1]))).toMatchObject({ testCodeSystem: null,
      testCode: null });
  });

  it('a draft is saved by name only and not sent', async () => {
    const { statements, labApi, service } = harness(stored(OrderStatus.Draft));
    await expect(service.create(context, patientId, encounterId, await pipe.transform({ ...nameOnly, status: 'draft' }),
      'lab-request-key-1234')).resolves.toMatchObject({ testCodeSystem: null, testCode: null, labWorkItem: null,
      labHandoff: null });
    expect(statements.find(({ sql }) => /insert into ehr\.lab_requests/.test(sql))?.values.slice(5, 7)).toEqual([null, null]);
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
  });

  it('a Lab image before 0156 refuses the null pair (400): 409 LAB_HANDOFF_REFUSED, naming the saved request', async () => {
    const { labApi, service } = harness(stored(OrderStatus.Active));
    labApi.acceptEhrOrder.mockRejectedValue(new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.'));
    const refusal = await service.create(context, patientId, encounterId, await pipe.transform(nameOnly),
      'lab-request-key-1234').catch((error: unknown) => error);
    expect(refusal).toMatchObject({ status: 409, code: 'LAB_HANDOFF_REFUSED' });
    expect((refusal as DomainProblem).getResponse()).toEqual(expect.stringContaining(requestId));
  });

  it('is sent again (POST .../lab-work-item) with both codes null', async () => {
    const { labApi, service } = harness(stored(OrderStatus.Active, '2'));
    await expect(service.sendToLab(context, patientId, encounterId, requestId, { expectedRowVersion: 2 }))
      .resolves.toEqual(workItem);
    expect(labApi.acceptEhrOrder.mock.calls[0]?.[1]).toMatchObject({ sourceEhrOrderVersion: 2, testCodeSystem: null,
      testCode: null, testName: 'Sickling test' });
  });

  it('is sent with both codes null when a held request is resumed', async () => {
    const { labApi, service } = harness(stored(OrderStatus.Active, '3'));
    const updated = await service.update(context, patientId, encounterId, requestId,
      { expectedRowVersion: 2, status: OrderStatus.Active, changeReason: 'Specimen bottle now available' });
    expect(updated).toMatchObject({ testCodeSystem: null, testCode: null, status: OrderStatus.Active,
      labHandoff: { state: 'accepted' } });
    expect(labApi.acceptEhrOrder.mock.calls[0]?.[1]).toMatchObject({ sourceEhrOrderVersion: 3, testCodeSystem: null,
      testCode: null, testName: 'Sickling test' });
  });

  it('reads back with both codes null (list and read)', async () => {
    const { service } = harness(stored(OrderStatus.Active));
    const page = await service.list(context, patientId, encounterId, { limit: 20 });
    expect(page.items[0]).toMatchObject({ testCodeSystem: null, testCode: null, testDisplay: 'Sickling test' });
    await expect(service.get(context, patientId, encounterId, requestId)).resolves.toMatchObject({ testCodeSystem: null,
      testCode: null });
  });

  it('a coded request is saved and sent with its codes, as before', async () => {
    const coded = { ...stored(OrderStatus.Active), testCodeSystem: 'LOCAL', testCode: 'SICKLE' };
    const { statements, labApi, service } = harness(coded);
    await service.create(context, patientId, encounterId, await pipe.transform({ ...nameOnly, testCodeSystem: 'LOCAL',
      testCode: 'SICKLE' }), 'lab-request-key-1234');
    expect(statements.find(({ sql }) => /insert into ehr\.lab_requests/.test(sql))?.values.slice(5, 7))
      .toEqual(['LOCAL', 'SICKLE']);
    expect(labApi.acceptEhrOrder.mock.calls[0]?.[1]).toMatchObject({ testCodeSystem: 'LOCAL', testCode: 'SICKLE' });
  });

  it('crosses an order route with both codes null: the route\'s content and a returned result keep them null', () => {
    expect(orderRouteContent({ content: JSON.stringify({ testCodeSystem: null, testCode: null, testDisplay: 'Sickling test',
      priority: 'urgent' }) }, 'lab_request')).toMatchObject({ testCodeSystem: null, testCode: null,
      testDisplay: 'Sickling test' });
    expect(orderRouteResults([{ resultId: workItem.id, resultVersion: 1, kind: 'released',
      test: { codeSystem: null, code: null, name: 'Sickling test' } }])[0]?.test)
      .toEqual({ codeSystem: null, code: null, name: 'Sickling test' });
  });
});
