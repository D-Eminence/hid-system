import type { DataAccessContext } from '../../common/request-context';
import { timelineCursorSql } from '../shared/clinical-context';
import { OrderStatus } from '../shared/clinical.dto';
import { PrescriptionsService, type PrescriptionRow } from './prescriptions.service';

const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const prescriptionId = '123e4567-e89b-42d3-a456-426614174005';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';

const context = { correlationId: 'correlation-123456', facilityId, membershipId,
  purposeOfUse: 'direct-care', authorization: 'Bearer user', actor: { id: accountId,
    subject: 'staff:test', accountId, authenticationMethod: 'local', roles: ['pharmacist'],
    permissions: ['pharmacy.work-item.accept'], facilityIds: [facilityId], facilities: [],
    facility: { id: facilityId, membershipId, organizationId: facilityId, name: 'Test',
      roles: ['pharmacist'], permissions: ['pharmacy.work-item.accept'], isPrimary: true } } } as DataAccessContext;

// ehr.prescriptions.created_at defaults to clock_timestamp(), which keeps
// microseconds; node-postgres returns it as a Date, which keeps milliseconds.
// starts_on and ends_on are dates, which node-postgres returns as a Date at
// local midnight: in a process running in Africa/Lagos (UTC+1), '2026-08-10'
// becomes 2026-08-09T23:00:00.000Z, which Pharmacy would store as 2026-08-09.
const createdAtExact = '2026-08-10T10:00:00.123456Z';
const handoffText = { createdAtExact, startsOnText: '2026-08-10', endsOnText: '2026-08-17' };
const exactColumns = [`${timelineCursorSql('created_at')} as "createdAtExact"`,
  `to_char(starts_on, 'YYYY-MM-DD') as "startsOnText"`, `to_char(ends_on, 'YYYY-MM-DD') as "endsOnText"`];
// A row as node-postgres returns it: the dates are Date objects.
type StoredRow = Omit<PrescriptionRow, 'startsOn' | 'endsOn'> & { startsOn: Date | null; endsOn: Date | null };
const prescription = (status: OrderStatus, rowVersion = '3'): StoredRow => ({
  id: prescriptionId, encounterId, patientId, facilityId, createdBy: accountId,
  createdByMembershipId: membershipId, medicationCodeSystem: 'rxnorm', medicationCode: '123',
  medicationDisplay: 'Amoxicillin 500 mg', doseQuantity: '1', doseUnit: 'tablet', routeCode: 'oral',
  frequency: 'Three times daily', instructions: 'Take with food',
  startsOn: new Date('2026-08-09T23:00:00.000Z'), endsOn: new Date('2026-08-16T23:00:00.000Z'),
  status, rowVersion, createdAt: new Date('2026-08-10T10:00:00.123Z'),
  updatedAt: new Date('2026-08-10T10:00:00.123Z'),
});

describe('PrescriptionsService Pharmacy handoff', () => {
  const pharmacyApi = { acceptEhrPrescription: jest.fn() };
  const repository = { run: jest.fn() };
  const workItem = { id: '123e4567-e89b-42d3-a456-426614174007', status: 'accepted' };

  beforeEach(() => {
    jest.clearAllMocks();
    pharmacyApi.acceptEhrPrescription.mockResolvedValue(workItem);
  });

  // A fake database: it returns the row, and the exact texts of created_at,
  // starts_on and ends_on only when the statement selects them.
  const serviceFor = (row: StoredRow, texts: Record<string, string | null> = handoffText) => {
    const query = jest.fn(async (sql: string) => ({ rows: [{ ...row,
      ...(exactColumns.every((column) => sql.includes(column)) ? texts : {}) }] }));
    repository.run.mockImplementation(async (_context, _patientId, _access, _event, operation) =>
      (await operation({ query })).value);
    return { query, service: new PrescriptionsService(repository as never, pharmacyApi as never) };
  };

  it('rejects a stale prescription version before crossing the service boundary', async () => {
    const { service } = serviceFor(prescription(OrderStatus.Active));
    await expect(service.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
      { expectedRowVersion: 2, reason: 'Reviewed for Pharmacy acceptance' }, 'handoff-key-1234'))
      .rejects.toMatchObject({ status: 412, code: 'PRESCRIPTION_VERSION_CONFLICT' });
    expect(pharmacyApi.acceptEhrPrescription).not.toHaveBeenCalled();
  });

  it('rejects a draft prescription because intent is not active', async () => {
    const { service } = serviceFor(prescription(OrderStatus.Draft));
    await expect(service.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
      { expectedRowVersion: 3, reason: 'Reviewed for Pharmacy acceptance' }, 'handoff-key-1234'))
      .rejects.toMatchObject({ status: 409, code: 'PRESCRIPTION_NOT_ELIGIBLE' });
    expect(pharmacyApi.acceptEhrPrescription).not.toHaveBeenCalled();
  });

  it('forwards the exact active snapshot and original idempotency key', async () => {
    const { service } = serviceFor(prescription(OrderStatus.Active));
    await service.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
      { expectedRowVersion: 3, reason: 'Reviewed for Pharmacy acceptance' }, 'handoff-key-1234');
    expect(pharmacyApi.acceptEhrPrescription).toHaveBeenCalledWith(context,
      expect.objectContaining({ sourceEhrPrescriptionId: prescriptionId,
        sourceEhrPrescriptionVersion: 3, sourceStatus: OrderStatus.Active,
        orderingFacilityId: facilityId, patientId }), 'handoff-key-1234');
  });

  // Pharmacy accepts a prescription only when its snapshot equals the EHR row
  // (pharmacy.validate_work_item, 0080); it compares prescribed_at with
  // created_at at the microsecond, and the dates, in a later release.
  it('sends Pharmacy the prescription time at the microsecond and the dates as written', async () => {
    const { query, service } = serviceFor(prescription(OrderStatus.Active));
    await service.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
      { expectedRowVersion: 3, reason: 'Reviewed for Pharmacy acceptance' }, 'handoff-key-1234');
    const sent = pharmacyApi.acceptEhrPrescription.mock.calls[0]?.[1];
    // What the HTTP client puts on the wire.
    expect(JSON.parse(JSON.stringify(sent))).toMatchObject({ prescribedAt: createdAtExact,
      startsOn: '2026-08-10', endsOn: '2026-08-17' });
    expect(sent).toMatchObject({ prescribedAt: createdAtExact, startsOn: '2026-08-10', endsOn: '2026-08-17' });
    // The texts come from the locking read, rendered by PostgreSQL.
    expect(timelineCursorSql('created_at')).toBe(`to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
    const locks = query.mock.calls.map(([sql]) => sql).filter((sql) => /from ehr\.prescriptions/i.test(sql));
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatch(/\bfor update\s*$/i);
    for (const column of exactColumns) expect(locks[0]).toContain(column);
  });

  it('leaves out dates the prescription does not have', async () => {
    const { service } = serviceFor({ ...prescription(OrderStatus.Active), startsOn: null, endsOn: null },
      { createdAtExact, startsOnText: null, endsOnText: null });
    await service.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
      { expectedRowVersion: 3, reason: 'Reviewed for Pharmacy acceptance' }, 'handoff-key-1234');
    const sent = pharmacyApi.acceptEhrPrescription.mock.calls[0]?.[1];
    expect(sent.startsOn).toBeUndefined();
    expect(sent.endsOn).toBeUndefined();
    expect(sent.prescribedAt).toBe(createdAtExact);
  });

  it('returns Pharmacy\'s answer, not the exact texts it read', async () => {
    const { service } = serviceFor(prescription(OrderStatus.Active));
    const result = await service.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
      { expectedRowVersion: 3, reason: 'Reviewed for Pharmacy acceptance' }, 'handoff-key-1234');
    expect(result).toEqual(workItem);
    for (const field of Object.keys(handoffText)) expect(result).not.toHaveProperty(field);
  });

  // The EHR transaction that checked eligibility and held the prescription's
  // row lock commits before the HTTP call to Pharmacy. Pharmacy's guard takes a
  // share lock on that row; a lock held across the call would make it wait for
  // the call itself, until a timeout.
  it('commits its eligibility check before calling Pharmacy', async () => {
    const events: string[] = [];
    const query = jest.fn(async () => ({ rows: [{ ...prescription(OrderStatus.Active), ...handoffText }] }));
    repository.run.mockImplementation(async (_context, _patientId, _access, _event, operation) => {
      events.push('begin');
      const result = await operation({ query });
      events.push('commit');
      return result.value;
    });
    pharmacyApi.acceptEhrPrescription.mockImplementation(async () => { events.push('pharmacy'); return workItem; });
    const service = new PrescriptionsService(repository as never, pharmacyApi as never);
    await service.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
      { expectedRowVersion: 3, reason: 'Reviewed for Pharmacy acceptance' }, 'handoff-key-1234');
    expect(events).toEqual(['begin', 'commit', 'pharmacy']);
  });
});
