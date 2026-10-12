import { requestDigest } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import { PharmacyService } from './pharmacy.service';

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
    const service = new PharmacyService(database as never, identity as never, audit as never);
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
    const service = new PharmacyService(database as never, identity as never, audit as never);
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
    const service = new PharmacyService(database as never, identity as never, audit as never);
    await expect(service.acceptPrescription(context, command, 'acceptance-key-1234'))
      .resolves.toMatchObject({ id: ids.work, status: 'accepted', dispensing: null });
    expect(query).toHaveBeenCalledTimes(1);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('records dispensing separately and never changes the accepted work-item status', async () => {
    const dispensingRow = { id: ids.dispensing, work_item_id: ids.work, work_item_version: '1',
      patient_id: ids.patient, facility_id: ids.facility, medication_code_system: null,
      medication_code: null, medication_display: command.medicationDisplay, quantity_dispensed: '21',
      quantity_unit: 'tablet', status: 'dispensed', dispensed_by: ids.account, dispensed_at: new Date(),
      row_version: '1', created_at: new Date(), reversal_id: null };
    const query = jest.fn().mockResolvedValueOnce({ rows: [workRow] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [dispensingRow] }).mockResolvedValueOnce({ rows: [] });
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    const service = new PharmacyService(database as never, identity as never, audit as never);
    await expect(service.dispense(context, ids.work, { expectedWorkItemVersion: 1,
      quantityDispensed: 21, quantityUnit: 'tablet', reason: 'Medicine handed to patient' },
    'dispensing-key-1234')).resolves.toMatchObject({ id: ids.dispensing, status: 'dispensed',
      effectiveStatus: 'dispensed' });
    expect(query.mock.calls.every(([sql]) => !/^update pharmacy\.work_items/i.test(String(sql).trim()))).toBe(true);
  });

  // The database guards bind Pharmacy work to the EHR prescription (0080):
  // pharmacy.validate_work_item refuses an acceptance that is not the exact
  // active prescription version, and pharmacy.validate_dispensing refuses a
  // dispensing once the prescription is no longer active at that version. Each
  // raises 23514 naming its own constraint, which the service answers with 409.
  const guardRefusal = (constraint?: string) => Object.assign(
    new Error('Synthetic guard refusal'), { code: '23514', ...(constraint ? { constraint } : {}) });
  const dispenseInput = { expectedWorkItemVersion: 1, quantityDispensed: 21, quantityUnit: 'tablet',
    reason: 'Medicine handed to patient' };
  const dispensingDatabase = (insert: Error) => {
    const query = jest.fn(async (sql: string) => {
      if (/^insert into pharmacy\.dispensings/i.test(sql.trim())) throw insert;
      return { rows: /from pharmacy\.work_items/i.test(sql) ? [workRow] : [] };
    });
    return { query, database: { withTransaction: jest.fn(async (_context, operation) => operation({ query })) } };
  };

  it('refuses a dispensing whose EHR prescription is no longer active at the accepted version with 409', async () => {
    const { query, database } = dispensingDatabase(guardRefusal('pharmacy_dispensing_source_prescription'));
    const service = new PharmacyService(database as never, identity as never, audit as never);
    await expect(service.dispense(context, ids.work, dispenseInput, 'dispensing-key-1234'))
      .rejects.toMatchObject({ status: 409, code: 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE' });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('pharmacy.outbox_events'))).toBe(false);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('passes every other check violation of a dispensing through unchanged', async () => {
    for (const refusal of [guardRefusal(), guardRefusal('pharmacy_work_item_source_prescription'),
      guardRefusal('dispensings_quantity_dispensed_check')]) {
      const { database } = dispensingDatabase(refusal);
      const service = new PharmacyService(database as never, identity as never, audit as never);
      await expect(service.dispense(context, ids.work, dispenseInput, 'dispensing-key-1234')).rejects.toBe(refusal);
    }
  });

  it('replays an identical earlier dispensing without inserting', async () => {
    const existing = { id: ids.dispensing, work_item_id: ids.work, work_item_version: '1', patient_id: ids.patient,
      facility_id: ids.facility, medication_code_system: null, medication_code: null,
      medication_display: command.medicationDisplay, quantity_dispensed: '21', quantity_unit: 'tablet',
      status: 'dispensed', dispensed_by: ids.account, dispensed_at: new Date(), row_version: '1',
      created_at: new Date(), reversal_id: null,
      request_sha256: requestDigest('pharmacy.dispensing.create', { workItemId: ids.work, ...dispenseInput }) };
    const query = jest.fn().mockResolvedValueOnce({ rows: [workRow] }).mockResolvedValueOnce({ rows: [existing] });
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    const service = new PharmacyService(database as never, identity as never, audit as never);
    await expect(service.dispense(context, ids.work, dispenseInput, 'dispensing-key-1234'))
      .resolves.toMatchObject({ id: ids.dispensing, status: 'dispensed' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.some(([sql]) => /insert into/i.test(String(sql)))).toBe(false);
  });

  const acceptanceDatabase = (insert: Error) => {
    const query = jest.fn(async (sql: string) => {
      if (/^insert into pharmacy\.work_items/i.test(sql.trim())) throw insert;
      return { rows: [] };
    });
    return { query, database: { withTransaction: jest.fn(async (_context, operation) => operation({ query })) } };
  };

  it('refuses an acceptance that is not the exact active EHR prescription version with 409', async () => {
    const { query, database } = acceptanceDatabase(guardRefusal('pharmacy_work_item_source_prescription'));
    const service = new PharmacyService(database as never, identity as never, audit as never);
    await expect(service.acceptPrescription(context, command, 'acceptance-key-1234'))
      .rejects.toMatchObject({ status: 409, code: 'PHARMACY_PRESCRIPTION_NOT_ELIGIBLE' });
    expect(query.mock.calls.some(([sql]) => /pharmacy\.(work_item_events|outbox_events)/.test(String(sql)))).toBe(false);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('passes every other check violation of an acceptance through unchanged', async () => {
    for (const refusal of [guardRefusal(), guardRefusal('pharmacy_dispensing_source_prescription')]) {
      const { database } = acceptanceDatabase(refusal);
      const service = new PharmacyService(database as never, identity as never, audit as never);
      await expect(service.acceptPrescription(context, command, 'acceptance-key-1234')).rejects.toBe(refusal);
    }
  });
});
