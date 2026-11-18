import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { INTERNAL_CALLER, READ_ONLY_POST, REQUIRED_PERMISSIONS } from '../common/decorators';
import type { DataAccessContext } from '../common/request-context';
import { WORK_ITEM_PROGRESS_MAX_IDS, WorkItemProgressDto } from './dto/work-item-progress.dto';
import { PharmacyWorkItemProgressController } from './work-item-progress.controller';
import { PharmacyWorkItemProgressService, WORK_ITEM_PROGRESS_QUERY } from './work-item-progress.service';

// Fictional ids only.
const ids = {
  patient: '7a1c0d2e-0000-4000-8000-000000000001', facility: '7a1c0d2e-0000-4000-8000-000000000002',
  account: '7a1c0d2e-0000-4000-8000-000000000003', membership: '7a1c0d2e-0000-4000-8000-000000000004',
  rxA: '7a1c0d2e-0000-4000-8000-00000000000a', rxB: '7a1c0d2e-0000-4000-8000-00000000000b',
  rxC: '7a1c0d2e-0000-4000-8000-00000000000c', rxD: '7a1c0d2e-0000-4000-8000-00000000000d',
  workA: '7a1c0d2e-0000-4000-8000-0000000000a1', workB: '7a1c0d2e-0000-4000-8000-0000000000b1',
  workC: '7a1c0d2e-0000-4000-8000-0000000000c1',
};
const doctorPermissions = ['ehr.prescription.read', 'ehr.prescription.write'];
const context: DataAccessContext = {
  correlationId: 'progress-correlation-1', facilityId: ids.facility, membershipId: ids.membership,
  purposeOfUse: 'direct-care', authorization: 'Bearer doctor', actor: {
    id: ids.account, subject: 'staff:doctor', accountId: ids.account, authenticationMethod: 'local',
    roles: ['doctor'], permissions: doctorPermissions, facilityIds: [ids.facility], facilities: [],
    facility: { id: ids.facility, membershipId: ids.membership, organizationId: ids.facility, name: 'Test Clinic',
      roles: ['doctor'], permissions: doctorPermissions, isPrimary: true } },
};
const allowed = { allowed: true, patientId: ids.patient, facilityId: ids.facility, membershipId: ids.membership,
  scope: 'read_records', purpose: 'direct-care', breakGlass: false };

function harness(rows: unknown[], decision: unknown = allowed) {
  const query = jest.fn(async (sql: string) => (sql === WORK_ITEM_PROGRESS_QUERY ? { rows } : { rows: [] }));
  const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => unknown) =>
    operation({ query })) };
  const identity = { authorize: jest.fn().mockResolvedValue(decision) };
  const audit = { recordWithClient: jest.fn() };
  const service = new PharmacyWorkItemProgressService(database as never, identity as never, audit as never);
  return { service, query, database, identity, audit };
}

describe('POST pharmacy/work-items/progress (ORD-3)', () => {
  it('is for ehr-api only, with the EHR read permission, not a pharmacist permission', () => {
    const handler = PharmacyWorkItemProgressController.prototype.read;
    expect(Reflect.getMetadata(INTERNAL_CALLER, handler)).toBe('ehr-api');
    expect(Reflect.getMetadata(READ_ONLY_POST, handler)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['ehr.prescription.read']);
    expect(Reflect.getMetadata('path', PharmacyWorkItemProgressController)).toBe('pharmacy/work-items');
    expect(Reflect.getMetadata('path', handler)).toBe('progress');
  });

  it('takes 1 to 100 distinct prescription ids and one patient, and nothing else', async () => {
    const check = (body: unknown) => validate(plainToInstance(WorkItemProgressDto, body),
      { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
    const many = (count: number) => Array.from({ length: count }, (_, index) =>
      `7a1c0d2e-0000-4000-8000-${String(index).padStart(12, '0')}`);
    expect(await check({ patientId: ids.patient, sourceEhrPrescriptionIds: many(WORK_ITEM_PROGRESS_MAX_IDS) })).toEqual([]);
    expect(await check({ patientId: ids.patient, sourceEhrPrescriptionIds: [] })).not.toEqual([]);
    expect(await check({ patientId: ids.patient, sourceEhrPrescriptionIds: many(101) })).not.toEqual([]);
    expect(await check({ patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA, ids.rxA] })).not.toEqual([]);
    expect(await check({ patientId: ids.patient, sourceEhrPrescriptionIds: ['HID-ABC123'] })).not.toEqual([]);
    expect(await check({ patientId: 'HID-ABC123', sourceEhrPrescriptionIds: [ids.rxA] })).not.toEqual([]);
    expect(await check({ patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA], healthId: 'HID-ABC123' }))
      .not.toEqual([]);
  });

  it('answers every id asked, in order: not received, received, dispensed and reversed', async () => {
    const { service, query, audit } = harness([
      { work_item_id: ids.workA, source_ehr_prescription_id: ids.rxA, accepted_at: new Date('2026-11-18T10:40:00Z'),
        dispensed_at: null, reversed_at: null },
      { work_item_id: ids.workB, source_ehr_prescription_id: ids.rxB, accepted_at: new Date('2026-11-18T10:41:00Z'),
        dispensed_at: new Date('2026-11-18T11:05:00Z'), reversed_at: null },
      { work_item_id: ids.workC, source_ehr_prescription_id: ids.rxC, accepted_at: new Date('2026-11-18T10:42:00Z'),
        dispensed_at: new Date('2026-11-18T11:06:00Z'), reversed_at: new Date('2026-11-18T11:30:00Z') },
    ]);
    const answer = await service.read(context, { patientId: ids.patient,
      sourceEhrPrescriptionIds: [ids.rxD, ids.rxC, ids.rxB, ids.rxA] });
    expect(answer.items).toEqual([
      { sourceEhrPrescriptionId: ids.rxD, status: 'not_received', receivedAt: null, dispensedAt: null, reversedAt: null },
      { sourceEhrPrescriptionId: ids.rxC, status: 'dispensing_reversed', receivedAt: '2026-11-18T10:42:00.000Z',
        dispensedAt: '2026-11-18T11:06:00.000Z', reversedAt: '2026-11-18T11:30:00.000Z' },
      { sourceEhrPrescriptionId: ids.rxB, status: 'dispensed', receivedAt: '2026-11-18T10:41:00.000Z',
        dispensedAt: '2026-11-18T11:05:00.000Z', reversedAt: null },
      { sourceEhrPrescriptionId: ids.rxA, status: 'received', receivedAt: '2026-11-18T10:40:00.000Z',
        dispensedAt: null, reversedAt: null },
    ]);
    expect(query).toHaveBeenCalledWith(WORK_ITEM_PROGRESS_QUERY,
      [ids.patient, ids.facility, [ids.rxD, ids.rxC, ids.rxB, ids.rxA]]);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context, 'pharmacy.work-item.progress.read',
      { patientId: ids.patient, resourceType: 'pharmacy-work-item-collection', resourceId: ids.facility },
      { requestedCount: 4, foundCount: 3, workItemIds: [ids.workA, ids.workB, ids.workC], breakGlass: false });
    expect(JSON.stringify(answer)).not.toMatch(/unverified/i);
  });

  it('audits the lookup even when nothing is found', async () => {
    const { service, audit } = harness([]);
    const answer = await service.read(context, { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA] });
    expect(answer.items).toEqual([{ sourceEhrPrescriptionId: ids.rxA, status: 'not_received', receivedAt: null,
      dispensedAt: null, reversedAt: null }]);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context, 'pharmacy.work-item.progress.read',
      expect.objectContaining({ patientId: ids.patient }), expect.objectContaining({ requestedCount: 1, foundCount: 0 }));
  });

  it('refuses with 403 and an audited denial when Identity does not allow the read, before any read', async () => {
    const { service, query, audit } = harness([], { ...allowed, allowed: false });
    await expect(service.read(context, { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA] }))
      .rejects.toMatchObject({ status: 403, code: 'PHARMACY_ACCESS_DENIED' });
    expect(query).not.toHaveBeenCalledWith(WORK_ITEM_PROGRESS_QUERY, expect.anything());
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context, 'pharmacy.work-item.progress.read',
      expect.objectContaining({ patientId: ids.patient }), expect.objectContaining({ reason: 'identity_authorization' }),
      'denied');
  });

  it('asks Identity as a GET read, whatever the internal call\'s method, and keeps the clinician\'s cookie', async () => {
    const { service, identity } = harness([]);
    const cookieOnly: DataAccessContext = { ...context, authorization: undefined, userCookie: 'hid_access=opaque',
      requestMethod: 'POST' };
    await service.read(cookieOnly, { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA] });
    expect(identity.authorize).toHaveBeenCalledWith(ids.patient, 'read_records',
      expect.objectContaining({ requestMethod: 'GET', userCookie: 'hid_access=opaque' }));
    expect(identity.authorize.mock.calls[0][2]).not.toHaveProperty('csrfToken', expect.anything());
    expect(cookieOnly.requestMethod).toBe('POST');
  });

  it('audits Identity\'s own 403 as a denied read of the patient, and passes it on', async () => {
    const { DomainProblem } = await import('../common/problem');
    const { service, identity, query, audit } = harness([]);
    identity.authorize.mockRejectedValue(new DomainProblem(403, 'CONSENT_REQUIRED', 'Consent is required'));
    await expect(service.read(context, { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA] }))
      .rejects.toMatchObject({ status: 403, code: 'CONSENT_REQUIRED' });
    expect(query).not.toHaveBeenCalledWith(WORK_ITEM_PROGRESS_QUERY, expect.anything());
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context, 'pharmacy.work-item.progress.read',
      expect.objectContaining({ patientId: ids.patient }), expect.objectContaining({ reason: 'identity_refusal' }),
      'denied');
  });

  it('does not audit an unreachable Identity as a denial', async () => {
    const { DomainProblem } = await import('../common/problem');
    const { service, identity, audit } = harness([]);
    identity.authorize.mockRejectedValue(new DomainProblem(503, 'IDENTITY_SERVICE_UNAVAILABLE', 'Unavailable'));
    await expect(service.read(context, { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA] }))
      .rejects.toMatchObject({ status: 503 });
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('reads this facility\'s own work only, read-only, under row-level security', () => {
    expect(WORK_ITEM_PROGRESS_QUERY).toMatch(/w\.order_route_id is null/);
    expect(WORK_ITEM_PROGRESS_QUERY).toMatch(/w\.facility_id=\$2::uuid/);
    expect(WORK_ITEM_PROGRESS_QUERY).toMatch(/w\.patient_id=\$1::uuid/);
    expect(WORK_ITEM_PROGRESS_QUERY).not.toMatch(/\b(insert|update|delete|for update|for share)\b/i);
  });
});
