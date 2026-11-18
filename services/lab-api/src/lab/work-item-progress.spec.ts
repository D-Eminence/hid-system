import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AUDIT_ACTION, INTERNAL_CALLER, READ_ONLY_POST, REQUIRED_PERMISSIONS } from '../common/decorators';
import type { DataAccessContext } from '../common/request-context';
import { LabWorkItemProgressDto, WORK_ITEM_PROGRESS_MAX_IDS } from './dto/work-item-progress.dto';
import { LabWorkItemProgressController } from './work-item-progress.controller';
import { LAB_WORK_ITEM_PROGRESS_QUERY, LabWorkItemProgressService } from './work-item-progress.service';

// Fictional ids only.
const ids = {
  patient: '8b2d1e3f-0000-4000-8000-000000000001', facility: '8b2d1e3f-0000-4000-8000-000000000002',
  account: '8b2d1e3f-0000-4000-8000-000000000003', membership: '8b2d1e3f-0000-4000-8000-000000000004',
  reqA: '8b2d1e3f-0000-4000-8000-00000000000a', reqB: '8b2d1e3f-0000-4000-8000-00000000000b',
  reqC: '8b2d1e3f-0000-4000-8000-00000000000c', reqD: '8b2d1e3f-0000-4000-8000-00000000000d',
  reqE: '8b2d1e3f-0000-4000-8000-00000000000e',
  workA: '8b2d1e3f-0000-4000-8000-0000000000a1', workB: '8b2d1e3f-0000-4000-8000-0000000000b1',
  workC: '8b2d1e3f-0000-4000-8000-0000000000c1', workD: '8b2d1e3f-0000-4000-8000-0000000000d1',
};
const context = { correlationId: 'lab-progress-correlation', facilityId: ids.facility, membershipId: ids.membership,
  purposeOfUse: 'direct-care', authorization: 'Bearer doctor', actor: { id: ids.account, subject: 'staff:doctor',
    accountId: ids.account, roles: ['doctor'], permissions: ['ehr.lab-request.read'], facilityIds: [ids.facility],
    facilities: [], authenticationMethod: 'local' } } satisfies DataAccessContext;
const allowed = { allowed: true, patientId: ids.patient, facilityId: ids.facility, membershipId: ids.membership,
  scope: 'read_records', purpose: 'direct-care', breakGlass: false };

function harness(rows: unknown[], decision: unknown = allowed) {
  const query = jest.fn(async (sql: string) => (sql === LAB_WORK_ITEM_PROGRESS_QUERY ? { rows } : { rows: [] }));
  const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => unknown) =>
    operation({ query })) };
  const identity = { authorize: jest.fn().mockResolvedValue(decision) };
  const audit = { recordWithClient: jest.fn() };
  const service = new LabWorkItemProgressService(database as never, identity as never, audit as never);
  return { service, query, identity, audit };
}

const at = (time: string) => new Date(`2026-11-18T${time}:00Z`);

describe('POST lab/work-items/progress (ORD-3)', () => {
  it('is for ehr-api only, with the EHR read permission, not a laboratory permission', () => {
    const handler = LabWorkItemProgressController.prototype.read;
    expect(Reflect.getMetadata(INTERNAL_CALLER, handler)).toBe('ehr-api');
    expect(Reflect.getMetadata(READ_ONLY_POST, handler)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['ehr.lab-request.read']);
    expect(Reflect.getMetadata(AUDIT_ACTION, handler)).toBe('lab.work-item.progress.request');
    expect(Reflect.getMetadata('path', LabWorkItemProgressController)).toBe('lab/work-items');
    expect(Reflect.getMetadata('path', handler)).toBe('progress');
  });

  it('takes 1 to 100 distinct lab request ids and one patient, and nothing else', async () => {
    const check = (body: unknown) => validate(plainToInstance(LabWorkItemProgressDto, body),
      { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
    const many = (count: number) => Array.from({ length: count }, (_, index) =>
      `8b2d1e3f-0000-4000-8000-${String(index).padStart(12, '0')}`);
    expect(await check({ patientId: ids.patient, sourceEhrOrderIds: many(WORK_ITEM_PROGRESS_MAX_IDS) })).toEqual([]);
    expect(await check({ patientId: ids.patient, sourceEhrOrderIds: [] })).not.toEqual([]);
    expect(await check({ patientId: ids.patient, sourceEhrOrderIds: many(101) })).not.toEqual([]);
    expect(await check({ patientId: ids.patient, sourceEhrOrderIds: [ids.reqA, ids.reqA] })).not.toEqual([]);
    expect(await check({ patientId: 'HID-ABC123', sourceEhrOrderIds: [ids.reqA] })).not.toEqual([]);
    expect(await check({ patientId: ids.patient, sourceEhrOrderIds: [ids.reqA], healthId: 'HID-ABC123' }))
      .not.toEqual([]);
  });

  it('answers every id asked, in order, from received to results ready', async () => {
    const { service, query, audit } = harness([
      { work_item_id: ids.workA, source_ehr_order_id: ids.reqA, accepted_at: at('09:00'), collected_at: null,
        test_count: 1, released_count: 0, released_at: null },
      { work_item_id: ids.workB, source_ehr_order_id: ids.reqB, accepted_at: at('09:01'), collected_at: at('09:30'),
        test_count: 2, released_count: 0, released_at: null },
      { work_item_id: ids.workC, source_ehr_order_id: ids.reqC, accepted_at: at('09:02'), collected_at: at('09:31'),
        test_count: 2, released_count: 1, released_at: at('10:15') },
      { work_item_id: ids.workD, source_ehr_order_id: ids.reqD, accepted_at: at('09:03'), collected_at: at('09:32'),
        test_count: 1, released_count: 1, released_at: at('11:05') },
    ]);
    const answer = await service.read(context, { patientId: ids.patient,
      sourceEhrOrderIds: [ids.reqE, ids.reqD, ids.reqC, ids.reqB, ids.reqA] });
    expect(answer.items).toEqual([
      { sourceEhrOrderId: ids.reqE, status: 'not_received', receivedAt: null, collectedAt: null, lastResultAt: null },
      { sourceEhrOrderId: ids.reqD, status: 'results_ready', receivedAt: '2026-11-18T09:03:00.000Z',
        collectedAt: '2026-11-18T09:32:00.000Z', lastResultAt: '2026-11-18T11:05:00.000Z' },
      { sourceEhrOrderId: ids.reqC, status: 'some_results_ready', receivedAt: '2026-11-18T09:02:00.000Z',
        collectedAt: '2026-11-18T09:31:00.000Z', lastResultAt: '2026-11-18T10:15:00.000Z' },
      { sourceEhrOrderId: ids.reqB, status: 'sample_collected', receivedAt: '2026-11-18T09:01:00.000Z',
        collectedAt: '2026-11-18T09:30:00.000Z', lastResultAt: null },
      { sourceEhrOrderId: ids.reqA, status: 'received', receivedAt: '2026-11-18T09:00:00.000Z', collectedAt: null,
        lastResultAt: null },
    ]);
    expect(query).toHaveBeenCalledWith(LAB_WORK_ITEM_PROGRESS_QUERY,
      [ids.patient, ids.facility, [ids.reqE, ids.reqD, ids.reqC, ids.reqB, ids.reqA]]);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'lab.work-item.progress.read', patientId: ids.patient, outcome: 'success', actorType: 'staff',
      resourceType: 'lab-work-item-collection', resourceId: ids.facility, facilityId: ids.facility,
      details: { requestedCount: 5, foundCount: 4, workItemIds: [ids.workA, ids.workB, ids.workC, ids.workD],
        breakGlass: false } }));
    expect(JSON.stringify(answer)).not.toMatch(/unverified/i);
  });

  it('a work item without a requested test stays received or sample collected', async () => {
    const { service } = harness([{ work_item_id: ids.workA, source_ehr_order_id: ids.reqA, accepted_at: at('09:00'),
      collected_at: null, test_count: 0, released_count: 0, released_at: null }]);
    const answer = await service.read(context, { patientId: ids.patient, sourceEhrOrderIds: [ids.reqA] });
    expect(answer.items[0]?.status).toBe('received');
  });

  it('refuses with 403 and an audited denial when Identity does not allow the read, before any read', async () => {
    const { service, query, audit } = harness([], { ...allowed, allowed: false });
    await expect(service.read(context, { patientId: ids.patient, sourceEhrOrderIds: [ids.reqA] }))
      .rejects.toMatchObject({ status: 403, code: 'LAB_WORK_ITEM_ACCESS_DENIED' });
    expect(query).not.toHaveBeenCalledWith(LAB_WORK_ITEM_PROGRESS_QUERY, expect.anything());
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'lab.work-item.progress.read', patientId: ids.patient, outcome: 'denied' }));
  });

  it('asks Identity as a GET read, whatever the internal call\'s method, and keeps the clinician\'s cookie', async () => {
    const { service, identity } = harness([]);
    const cookieOnly: DataAccessContext = { ...context, authorization: undefined, userCookie: 'hid_access=opaque',
      requestMethod: 'POST' };
    await service.read(cookieOnly, { patientId: ids.patient, sourceEhrOrderIds: [ids.reqA] });
    expect(identity.authorize).toHaveBeenCalledWith(ids.patient, 'read_records', 'direct-care',
      expect.objectContaining({ requestMethod: 'GET', userCookie: 'hid_access=opaque' }));
    expect(cookieOnly.requestMethod).toBe('POST');
  });

  it('audits Identity\'s own 403 as a denied read of the patient, and passes it on', async () => {
    const { DomainProblem } = await import('../common/problem');
    const { service, identity, query, audit } = harness([]);
    identity.authorize.mockRejectedValue(new DomainProblem(403, 'CONSENT_REQUIRED', 'Consent is required'));
    await expect(service.read(context, { patientId: ids.patient, sourceEhrOrderIds: [ids.reqA] }))
      .rejects.toMatchObject({ status: 403 });
    expect(query).not.toHaveBeenCalledWith(LAB_WORK_ITEM_PROGRESS_QUERY, expect.anything());
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'lab.work-item.progress.read', patientId: ids.patient, outcome: 'denied',
      details: expect.objectContaining({ reason: 'identity_refusal' }) }));
  });

  it('does not audit an unreachable Identity as a denial', async () => {
    const { DomainProblem } = await import('../common/problem');
    const { service, identity, audit } = harness([]);
    identity.authorize.mockRejectedValue(new DomainProblem(503, 'IDENTITY_SERVICE_UNAVAILABLE', 'Unavailable'));
    await expect(service.read(context, { patientId: ids.patient, sourceEhrOrderIds: [ids.reqA] }))
      .rejects.toMatchObject({ status: 503 });
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('reads this facility\'s own work only, read-only, with the released-result rule of the work list', () => {
    expect(LAB_WORK_ITEM_PROGRESS_QUERY).toMatch(/w\.order_route_id is null/);
    expect(LAB_WORK_ITEM_PROGRESS_QUERY).toMatch(/w\.facility_id=\$2::uuid/);
    expect(LAB_WORK_ITEM_PROGRESS_QUERY).toMatch(/rel\.result_version=r\.current_version/);
    expect(LAB_WORK_ITEM_PROGRESS_QUERY).toMatch(/not exists\(select 1 from lab\.result_invalidations/);
    expect(LAB_WORK_ITEM_PROGRESS_QUERY).toMatch(/s\.status in \('collected','received'\)/);
    expect(LAB_WORK_ITEM_PROGRESS_QUERY).not.toMatch(/\b(insert|update|delete|for update|for share)\b/i);
  });
});
