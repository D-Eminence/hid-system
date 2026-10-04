import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import type { LabApiService } from '../../integrations/lab-api.service';
import type { ClinicalRepository } from '../shared/clinical.repository';
import { OrderStatus, type UpdateLabRequestDto } from '../shared/clinical.dto';
import { LabRequestsService, type LabRequestRow } from './lab-requests.service';

const patientId = '10000000-0000-4000-8000-000000000001';
const encounterId = '20000000-0000-4000-8000-000000000001';
const requestId = '30000000-0000-4000-8000-000000000001';
const facilityId = '40000000-0000-4000-8000-000000000001';
const context = {
  correlationId: 'lab-handoff-test', facilityId,
  membershipId: '50000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care',
  actor: { id: 'actor', subject: 'staff:doctor', accountId: '60000000-0000-4000-8000-000000000001',
    roles: ['doctor'], permissions: ['ehr.lab-request.write', 'lab.work-item.accept'],
    facilityIds: [facilityId], facilities: [], authenticationMethod: 'local' },
} satisfies DataAccessContext;
const draft = {
  id: requestId, encounterId, patientId, facilityId, createdBy: context.actor.accountId,
  createdByMembershipId: context.membershipId, testCodeSystem: 'LOINC', testCode: '718-7',
  testDisplay: 'Haemoglobin', priority: 'routine', status: OrderStatus.Draft,
  specimenTypeCode: null, clinicalInformation: null, externalOrderReference: null,
  rowVersion: '1', createdAt: new Date('2026-08-10T10:00:00Z'), updatedAt: new Date('2026-08-10T10:00:00Z'),
} satisfies LabRequestRow;
const input = { status: OrderStatus.Active, expectedRowVersion: 1,
  changeReason: 'Send requested test to the laboratory' } satisfies UpdateLabRequestDto;

function harness(current: LabRequestRow, updated?: LabRequestRow) {
  let stored = current;
  const client = { query: jest.fn(async (sql: string) => {
    if (sql.includes('for update')) return { rows: [stored] };
    if (sql.includes('update ehr.lab_requests')) {
      if (updated) stored = updated;
      return { rows: updated ? [updated] : [] };
    }
    return { rows: [] };
  }) } as unknown as PoolClient;
  const repository = {
    run: jest.fn(async (...args: unknown[]) => {
      const operation = args[4] as (databaseClient: PoolClient) => Promise<{ value: LabRequestRow }>;
      return (await operation(client)).value;
    }),
    setChangeReason: jest.fn(async () => undefined), exists: jest.fn(async () => true),
  } as unknown as ClinicalRepository;
  const labApi = { acceptEhrOrder: jest.fn(async () => ({ id: '70000000-0000-4000-8000-000000000001', status: 'accepted' })) } as unknown as LabApiService;
  return { service: new LabRequestsService(repository, labApi), repository, labApi, client };
}

describe('LabRequestsService draft activation', () => {
  it('accepts the exact committed active version at Lab', async () => {
    const active = { ...draft, status: OrderStatus.Active, rowVersion: '2' };
    const { service, labApi } = harness(draft, active);
    const result = await service.update(context, patientId, encounterId, requestId, input);
    expect(result.labWorkItem).toMatchObject({ status: 'accepted' });
    expect(labApi.acceptEhrOrder).toHaveBeenCalledWith(context, expect.objectContaining({
      sourceEhrOrderId: requestId, sourceEhrOrderVersion: 2, orderingFacilityId: facilityId,
      patientId, requestedBy: draft.createdBy,
    }), `ehr-order:${requestId}:2`);
  });

  it('retries Lab acceptance against the same active version without another EHR mutation', async () => {
    const active = { ...draft, status: OrderStatus.Active, rowVersion: '2' };
    const { service, client, labApi } = harness(draft, active);
    jest.spyOn(labApi, 'acceptEhrOrder')
      .mockRejectedValueOnce(new Error('Lab response lost'))
      .mockResolvedValueOnce({ id: '70000000-0000-4000-8000-000000000001', status: 'accepted' });
    await expect(service.update(context, patientId, encounterId, requestId, input)).rejects.toThrow('Lab response lost');
    await expect(service.update(context, patientId, encounterId, requestId, input)).resolves.toMatchObject({
      rowVersion: '2', labWorkItem: { status: 'accepted' },
    });
    const updateCalls=(client.query as jest.Mock).mock.calls.filter(([sql]) => String(sql).includes('update ehr.lab_requests'));
    expect(updateCalls).toHaveLength(1);
    expect(labApi.acceptEhrOrder).toHaveBeenNthCalledWith(1,context,
      expect.objectContaining({ sourceEhrOrderVersion: 2 }),`ehr-order:${requestId}:2`);
    expect(labApi.acceptEhrOrder).toHaveBeenNthCalledWith(2,context,
      expect.objectContaining({ sourceEhrOrderVersion: 2 }),`ehr-order:${requestId}:2`);
  });

  it('rejects a changed active snapshot and does not send it to Lab', async () => {
    const active = { ...draft, status: OrderStatus.Active, rowVersion: '2', priority: 'stat' };
    const { service, labApi } = harness(active);
    await expect(service.update(context, patientId, encounterId, requestId,
      { ...input, priority: 'routine' as UpdateLabRequestDto['priority'] })).rejects.toMatchObject({ status: 412, code: 'VERSION_CONFLICT' });
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
  });

  it('surfaces a Lab conflict without making a second EHR update on retry', async () => {
    const active = { ...draft, status: OrderStatus.Active, rowVersion: '2' };
    const { service, client, labApi } = harness(draft, active);
    jest.spyOn(labApi, 'acceptEhrOrder')
      .mockRejectedValue(new DomainProblem(409, 'IDEMPOTENCY_CONFLICT', 'Existing Lab work conflicts'));
    await expect(service.update(context, patientId, encounterId, requestId, input))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    await expect(service.update(context, patientId, encounterId, requestId, input))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    const updateCalls=(client.query as jest.Mock).mock.calls.filter(([sql]) => String(sql).includes('update ehr.lab_requests'));
    expect(updateCalls).toHaveLength(1);
  });

  it('does not hand off an updated draft', async () => {
    const { service, labApi } = harness(draft, { ...draft, rowVersion: '2', clinicalInformation: 'Repeat test' });
    const result = await service.update(context, patientId, encounterId, requestId,
      { expectedRowVersion: 1, clinicalInformation: 'Repeat test', changeReason: 'Clarify the order' });
    expect(result.labWorkItem).toBeNull();
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
  });
});
