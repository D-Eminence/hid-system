import type { DataAccessContext } from '../../common/request-context';
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
const row = (status: OrderStatus): LabRequestRow => ({
  id: requestId, encounterId, patientId, facilityId, createdBy: accountId, createdByMembershipId: membershipId,
  testCodeSystem: 'loinc', testCode: '718-7', testDisplay: 'Hemoglobin', priority: 'routine', status,
  specimenTypeCode: null, clinicalInformation: 'Fatigue', externalOrderReference: null, rowVersion: '1',
  createdAt: new Date('2026-10-01T09:00:00.123Z'), updatedAt: new Date('2026-10-01T09:00:00.123Z'),
});

describe('LabRequestsService handoff to Lab', () => {
  const labApi = { acceptEhrOrder: jest.fn() };
  const repository = { run: jest.fn(), executeCreate: jest.fn() };
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
    const { service } = serviceFor(row(OrderStatus.Active));
    await service.create(context, patientId, encounterId, input as never, 'lab-request-key-1234');
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
    const { service } = serviceFor(row(OrderStatus.Active));
    repository.executeCreate.mockImplementation(async (_client, _context, _patientId, _key, _operation, _digest,
      _type, _create, load) => ({ value: await load(requestId), id: requestId }));
    await service.create(context, patientId, encounterId, input as never, 'lab-request-key-1234');
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
