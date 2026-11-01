import { requestDigest } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import { PharmacyService, WORK_LIST_QUERY } from './pharmacy.service';
import { PharmacyOrderRouteAccess } from './order-route-access';
import { PharmacyOrderRouteCards } from './order-route-cards';

const ids = {
  patient: '123e4567-e89b-42d3-a456-426614174001', facility: '123e4567-e89b-42d3-a456-426614174002',
  account: '123e4567-e89b-42d3-a456-426614174003', membership: '123e4567-e89b-42d3-a456-426614174004',
  prescription: '123e4567-e89b-42d3-a456-426614174005', encounter: '123e4567-e89b-42d3-a456-426614174006',
  work: '123e4567-e89b-42d3-a456-426614174007', dispensing: '123e4567-e89b-42d3-a456-426614174008',
};
const context: DataAccessContext = {
  correlationId: 'correlation-123456', facilityId: ids.facility, membershipId: ids.membership,
  purposeOfUse: 'direct-care', authorization: 'Bearer user', actor: {
    id: ids.account, subject: 'staff:test', accountId: ids.account, authenticationMethod: 'local',
    roles: ['pharmacist'], permissions: ['pharmacy.work-item.accept', 'pharmacy.dispensing.create'],
    facilityIds: [ids.facility], facilities: [], facility: { id: ids.facility,
      membershipId: ids.membership, organizationId: ids.facility, name: 'Test', roles: ['pharmacist'],
      permissions: ['pharmacy.work-item.accept', 'pharmacy.dispensing.create'], isPrimary: true },
  },
};
const command = {
  patientId: ids.patient, orderingFacilityId: ids.facility, sourceEhrPrescriptionId: ids.prescription,
  sourceEhrPrescriptionVersion: 2, sourceEncounterId: ids.encounter, sourceStatus: 'active' as const,
  medicationDisplay: 'Amoxicillin 500 mg', doseQuantity: 1, doseUnit: 'tablet',
  frequency: 'Three times daily', instructions: 'Take with food', prescribedBy: ids.account,
  prescribedAt: '2026-08-10T10:00:00.000Z', acceptanceReason: 'Accepted after exact prescription review',
};
const workRow = { id: ids.work, patient_id: ids.patient, facility_id: ids.facility,
  ordering_facility_id: ids.facility, source_ehr_prescription_id: ids.prescription,
  source_ehr_prescription_version: '2', source_encounter_id: ids.encounter, source_status: 'active',
  status: 'accepted', medication_code_system: null, medication_code: null,
  medication_display: command.medicationDisplay, dose_quantity: '1', dose_unit: 'tablet', route_code: null,
  frequency: command.frequency, instructions: command.instructions, starts_on: null, ends_on: null,
  prescribed_by: ids.account, prescribed_at: new Date(), accepted_by: ids.account,
  accepted_at: new Date(), row_version: '1', created_at: new Date(), dispensing_id: null, reversal_id: null };

describe('PharmacyService', () => {
  const identity = { authorize: jest.fn() };
  const audit = { recordWithClient: jest.fn() };
  beforeEach(() => { jest.clearAllMocks(); identity.authorize.mockResolvedValue({ allowed: true,
    patientId: ids.patient, facilityId: ids.facility, membershipId: ids.membership,
    scope: 'write_records', purpose: 'direct-care', breakGlass: false }); });

  it('rejects break-glass mutations before opening a Pharmacy transaction', async () => {
    const database = { withTransaction: jest.fn() };
    identity.authorize.mockResolvedValue({ allowed: true, patientId: ids.patient,
      facilityId: ids.facility, membershipId: ids.membership, scope: 'write_records',
      purpose: 'direct-care', breakGlass: true });
    const service = new PharmacyService(database as never, identity as never, audit as never,
      new PharmacyOrderRouteAccess(identity as never), new PharmacyOrderRouteCards(database as never));
    await expect(service.acceptPrescription(context, command, 'acceptance-key-1234'))
      .rejects.toMatchObject({ status: 403, code: 'PHARMACY_ACCESS_DENIED' });
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it('creates an accepted item, event, minimum outbox record, and semantic audit atomically', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [workRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    const service = new PharmacyService(database as never, identity as never, audit as never,
      new PharmacyOrderRouteAccess(identity as never), new PharmacyOrderRouteCards(database as never));
    const result = await service.acceptPrescription(context, command, 'acceptance-key-1234');
    expect(result).toMatchObject({ id: ids.work, status: 'accepted', dispensing: null,
      sourceEhrPrescriptionVersion: 2 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('pharmacy.work_item_events'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("'PharmacyWorkItemCreated'"))).toBe(false);
    expect(query.mock.calls.some(([sql, values]) => String(sql).includes('pharmacy.outbox_events')
      && values[0] === 'PharmacyWorkItemCreated')).toBe(true);
    expect(identity.authorize).toHaveBeenCalledWith(ids.patient, 'write_records', context);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
  });

  it('returns the same accepted item for an identical idempotent replay', async () => {
    const existing = { ...workRow,
      request_sha256: requestDigest('pharmacy.work-item.accept-ehr-prescription', command) };
    const query = jest.fn().mockResolvedValueOnce({ rows: [existing] });
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    const service = new PharmacyService(database as never, identity as never, audit as never,
      new PharmacyOrderRouteAccess(identity as never), new PharmacyOrderRouteCards(database as never));
    await expect(service.acceptPrescription(context, command, 'acceptance-key-1234'))
      .resolves.toMatchObject({ id: ids.work, status: 'accepted', dispensing: null });
    expect(query).toHaveBeenCalledTimes(1);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  // 0100: pharmacy.validate_work_item refuses a same-facility work item that is not exactly its
  // ehr.prescriptions row with 23514 and one of four messages; each is answered with its own code.
  describe('acceptance refused by the prescription source check (0100)', () => {
    const refusedBy = (error: unknown) => {
      const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(error);
      const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
      const service = new PharmacyService(database as never, identity as never, audit as never,
        new PharmacyOrderRouteAccess(identity as never), new PharmacyOrderRouteCards(database as never));
      return { query, run: () => service.acceptPrescription(context, command, 'acceptance-key-1234') };
    };

    it.each([
      ['PRESCRIPTION_SOURCE_NOT_FOUND', 404, 'The prescription was not found at this facility'],
      ['PRESCRIPTION_SOURCE_NOT_ACTIVE', 409, 'This prescription is no longer active, so Pharmacy did not accept it'],
      ['PRESCRIPTION_SOURCE_VERSION_MISMATCH', 409,
        'This prescription changed since it was read; reload it and send it again'],
      ['PRESCRIPTION_SOURCE_MISMATCH', 422,
        'The details sent do not match the prescription, so Pharmacy did not accept it'],
      ['PRESCRIPTION_ROUTED', 409, 'This prescription has been sent to another pharmacy; withdraw it there first'],
    ])('answers 23514 %s with %i and that code, writing nothing after the insert', async (message, status, detail) => {
      const { query, run } = refusedBy(Object.assign(new Error(message), { code: '23514' }));
      const refusal = await run().catch((error: unknown) => error);
      expect(refusal).toMatchObject({ status, code: message });
      expect((refusal as Error).message).toBe(detail);
      // The replay read and the refused insert only: no event, outbox row or audit.
      expect(query).toHaveBeenCalledTimes(2);
      expect(audit.recordWithClient).not.toHaveBeenCalled();
    });

    it('passes the validator\'s other refusals and other errors on unchanged', async () => {
      for (const error of [
        Object.assign(new Error('Pharmacy acceptance patient, facility, prescription status, or actor context is invalid'),
          { code: '23514' }),
        // The message alone is not enough: only a check violation is the validator's answer.
        Object.assign(new Error('PRESCRIPTION_SOURCE_MISMATCH'), { code: '42501' }),
        Object.assign(new Error('could not serialize access'), { code: '40001' }),
        // Not one of its own properties: an inherited name is never a refusal.
        Object.assign(new Error('toString'), { code: '23514' }),
      ]) {
        const { run } = refusedBy(error);
        await expect(run()).rejects.toBe(error);
      }
    });
  });

  it('records dispensing separately and never changes the accepted work-item status', async () => {
    const dispensingRow = { id: ids.dispensing, work_item_id: ids.work, work_item_version: '1',
      patient_id: ids.patient, facility_id: ids.facility, medication_code_system: null,
      medication_code: null, medication_display: command.medicationDisplay, quantity_dispensed: '21',
      quantity_unit: 'tablet', status: 'dispensed', dispensed_by: ids.account, dispensed_at: new Date(),
      row_version: '1', created_at: new Date(), reversal_id: null };
    // The work item, C17's answer for it (P4c: no route, so Identity's consent decides), the
    // replay read, the insert and the outbox.
    const query = jest.fn().mockResolvedValueOnce({ rows: [workRow] })
      .mockResolvedValueOnce({ rows: [{ outcome: 'none', route_id: null, work_item_id: ids.work }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [dispensingRow] }).mockResolvedValueOnce({ rows: [] });
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    const service = new PharmacyService(database as never, identity as never, audit as never,
      new PharmacyOrderRouteAccess(identity as never), new PharmacyOrderRouteCards(database as never));
    await expect(service.dispense(context, ids.work, { expectedWorkItemVersion: 1,
      quantityDispensed: 21, quantityUnit: 'tablet', reason: 'Medicine handed to patient' },
    'dispensing-key-1234')).resolves.toMatchObject({ id: ids.dispensing, status: 'dispensed',
      effectiveStatus: 'dispensed' });
    expect(query.mock.calls.every(([sql]) => !/^update pharmacy\.work_items/i.test(String(sql).trim()))).toBe(true);
  });
});

/**
 * The work list answered the 200 oldest rows the member could read, dispensed
 * or not, so a busy pharmacy stopped seeing new prescriptions. Open work (no
 * dispensing, or a reversed one) now comes first, oldest first, and done work
 * fills the rest, newest first. The database does the ordering (checked
 * against Postgres 16 with 250 work items, 30 open, all 30 answered first);
 * these tests hold the query to that rule and the service to answering exactly
 * what the query returns, with the same audit rows.
 */
describe('PharmacyService.listWorkItems order: open work first', () => {
  const row = (n: number, state: 'open' | 'reversed' | 'dispensed') => ({ ...workRow,
    id: `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`, accepted_at: new Date(Date.UTC(2026, 0, 1, 0, n)),
    order_route_id: null, dispensing_id: state === 'open' ? null : ids.dispensing, dispensing_status: state === 'open' ? null : 'dispensed',
    reversal_id: state === 'reversed' ? '123e4567-e89b-42d3-a456-426614174099' : null });
  const build = (rows: ReturnType<typeof row>[]) => {
    const statements: string[] = [];
    const query = jest.fn(async (sql: string) => {
      statements.push(sql);
      return { rows: sql === WORK_LIST_QUERY ? rows : [] };
    });
    const database = { withTransaction: async <T>(_c: unknown, fn: (c: unknown) => Promise<T>) => fn({ query }),
      query: jest.fn(async () => ({ rows: [{ orders: false, work: false }] })) };
    const identity = { authorize: jest.fn() };
    const audits: Array<Record<string, unknown>> = [];
    const audit = { recordWithClient: jest.fn(async (_c: unknown, _x: unknown, action: string, resource: object, details = {}) => {
      audits.push({ action, ...resource, details });
    }) };
    const service = new PharmacyService(database as never, identity as never, audit as never,
      new PharmacyOrderRouteAccess(identity as never), new PharmacyOrderRouteCards(database as never));
    return { service, statements, audits };
  };

  it('asks for open work (no dispensing, or a reversed one) oldest first, then done work newest first, 200 rows in all', () => {
    expect(WORK_LIST_QUERY).toContain('cross join lateral (select d.id is null or r.id is not null as open_work) o');
    const order = WORK_LIST_QUERY.slice(WORK_LIST_QUERY.lastIndexOf('order by'));
    expect(order.replace(/\s+/g, ' ')).toBe('order by o.open_work desc,case when o.open_work then w.accepted_at end asc,'
      + 'case when o.open_work then null else w.accepted_at end desc, case when o.open_work then w.id end asc,'
      + 'case when o.open_work then null else w.id end desc limit 200');
    expect(WORK_LIST_QUERY).not.toMatch(/order by w\.accepted_at asc,w\.id asc/);
    // The same row source as a single read, so each row is projected as before.
    expect(WORK_LIST_QUERY.startsWith('select w.*,d.id::text as dispensing_id,d.status as dispensing_status,')).toBe(true);
  });

  it('answers what the query returns, in its order and shape: 250 items with 30 open answers all 30 first', async () => {
    // What Postgres answers for 250 work items of which 30 are open (indexes 0-9, 100-109, 240-249; every third
    // one reversed): the 30 open oldest first, then the 170 newest done.
    const openIndexes = [...Array.from({ length: 10 }, (_, i) => i), ...Array.from({ length: 10 }, (_, i) => 100 + i),
      ...Array.from({ length: 10 }, (_, i) => 240 + i)];
    const openRows = openIndexes.map((i) => row(i, i % 3 === 0 ? 'reversed' : 'open'));
    const doneRows = Array.from({ length: 250 }, (_, i) => i).filter((i) => !openIndexes.includes(i)).reverse().slice(0, 170)
      .map((i) => row(i, 'dispensed'));
    const { service, statements, audits } = build([...openRows, ...doneRows]);
    const answer = await service.listWorkItems(context);
    expect(answer.items).toHaveLength(200);
    expect(answer.items.slice(0, 30).map((item) => item.id)).toEqual(openRows.map((r) => r.id));
    expect(answer.items.slice(30).map((item) => item.id)).toEqual(doneRows.map((r) => r.id));
    expect(answer.items.map((item) => item.id)).toContain(row(249, 'open').id);
    expect(statements.filter((sql) => sql.includes('from pharmacy.work_items w'))).toEqual([WORK_LIST_QUERY]);
    // Each row projected as before: a reversed dispensing, no dispensing, a dispensing.
    expect(answer.items[0]).toMatchObject({ status: 'accepted', dispensing: { id: ids.dispensing, status: 'dispensed', reversed: true } });
    expect(answer.items[1]).toMatchObject({ status: 'accepted', dispensing: null });
    expect(answer.items[30]).toMatchObject({ dispensing: { id: ids.dispensing, status: 'dispensed', reversed: false } });
    // The audit rows are as before: the collection row with the count returned, and no patient row for own work.
    expect(audits).toEqual([{ action: 'pharmacy.work-item.list', resourceType: 'pharmacy-work-item-collection',
      resourceId: ids.facility, details: { returnedCount: 200 } }]);
  });
});
