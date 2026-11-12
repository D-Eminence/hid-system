import { types } from 'pg';
import type { DataAccessContext } from '../../common/request-context';
import { matchAllergies } from '../allergies/allergy-match';
import { warningToken } from '../allergies/allergy-reader';
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

const prescription = (status: OrderStatus, rowVersion = '3'): PrescriptionRow => ({
  id: prescriptionId, encounterId, patientId, facilityId, createdBy: accountId,
  createdByMembershipId: membershipId, medicationCodeSystem: 'rxnorm', medicationCode: '123',
  medicationDisplay: 'Amoxicillin 500 mg', doseQuantity: '1', doseUnit: 'tablet', routeCode: 'oral',
  frequency: 'Three times daily', instructions: 'Take with food', startsOn: '2026-08-10',
  endsOn: '2026-08-17', status, rowVersion, createdAt: new Date('2026-08-10T10:00:00Z'),
  updatedAt: new Date('2026-08-10T10:00:00Z'),
});

// The order-route reader of an EHR with no routes to other facilities (P4c).
const noRoutes = { summaries: async () => new Map(), summary: async () => null,
  crossFacilityOrdersEnabled: async () => false };

describe('PrescriptionsService Pharmacy handoff', () => {
  const pharmacyApi = { acceptEhrPrescription: jest.fn() };
  const repository = { run: jest.fn() };
  /** In order: each statement of the hand-off's transaction ('tx: …'), its audit row ('audit') and Pharmacy ('pharmacy'). */
  let log: string[] = [];
  let calls: { sql: string; values: unknown[] }[] = [];
  let audits: Record<string, unknown>[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    log = [];
    calls = [];
    audits = [];
    pharmacyApi.acceptEhrPrescription.mockImplementation(async () => {
      log.push('pharmacy');
      return { id: '123e4567-e89b-42d3-a456-426614174007' };
    });
  });

  /**
   * The hand-off with a client answering the locked prescription, the
   * patient's recorded allergies and the acknowledgements already stored for
   * the prescription; the repository records the audit details as
   * ClinicalRepository.run merges them.
   */
  const serviceFor = (row: PrescriptionRow, recorded: unknown[] = [], stored: unknown[] = []) => {
    const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      log.push(`tx: ${sql.trim().split(/\s+/).slice(0, 3).join(' ')}`);
      if (/from ehr\.prescriptions/.test(sql)) return { rows: [row] };
      if (/from ehr\.recorded_allergies/.test(sql)) return { rows: recorded };
      if (/from ehr\.prescription_allergy_acknowledgements/.test(sql)) return { rows: stored };
      return { rows: [] };
    }) };
    repository.run.mockImplementation(async (_context, _patientId, _access, event, operation) => {
      const result = await operation(client);
      audits.push({ action: event.action, details: { ...event.details, ...result.details } });
      log.push('audit');
      return result.value;
    });
    return new PrescriptionsService(repository as never, pharmacyApi as never, noRoutes as never);
  };

  it('rejects a stale prescription version before crossing the service boundary', async () => {
    const service = serviceFor(prescription(OrderStatus.Active));
    await expect(service.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
      { expectedRowVersion: 2, reason: 'Reviewed for Pharmacy acceptance' }, 'handoff-key-1234'))
      .rejects.toMatchObject({ status: 412, code: 'PRESCRIPTION_VERSION_CONFLICT' });
    expect(pharmacyApi.acceptEhrPrescription).not.toHaveBeenCalled();
  });

  it('rejects a draft prescription because intent is not active', async () => {
    const service = serviceFor(prescription(OrderStatus.Draft));
    await expect(service.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
      { expectedRowVersion: 3, reason: 'Reviewed for Pharmacy acceptance' }, 'handoff-key-1234'))
      .rejects.toMatchObject({ status: 409, code: 'PRESCRIPTION_NOT_ELIGIBLE' });
    expect(pharmacyApi.acceptEhrPrescription).not.toHaveBeenCalled();
  });

  // The review of 0100: node-postgres makes a date column a JavaScript Date at local midnight, so
  // its ISO string is the day before east of UTC; the hand-off sends the calendar date instead,
  // which 0100 compares exactly, whatever the EHR API process's TZ (calendar-date.spec.ts runs
  // the conversion under Africa/Lagos and other zones).
  it('sends the start and end dates node-postgres read as calendar dates', async () => {
    const parseDate = types.getTypeParser(1082) as (text: string) => unknown;
    const row = { ...prescription(OrderStatus.Active), startsOn: parseDate('2026-11-01'), endsOn: parseDate('2026-12-31') };
    expect(row.startsOn).toBeInstanceOf(Date);
    const service = serviceFor(row as unknown as PrescriptionRow);
    await service.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
      { expectedRowVersion: 3, reason: 'Reviewed for Pharmacy acceptance' }, 'handoff-key-1234');
    const body = pharmacyApi.acceptEhrPrescription.mock.calls[0][1];
    expect(JSON.parse(JSON.stringify(body))).toMatchObject({ startsOn: '2026-11-01', endsOn: '2026-12-31' });
  });

  it('sends absent dates as absent and a date already read as text unchanged', async () => {
    const service = serviceFor({ ...prescription(OrderStatus.Active), startsOn: null, endsOn: '2026-08-17' });
    await service.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
      { expectedRowVersion: 3, reason: 'Reviewed for Pharmacy acceptance' }, 'handoff-key-1234');
    const body = pharmacyApi.acceptEhrPrescription.mock.calls[0][1];
    expect(body.startsOn).toBeUndefined();
    expect(body.endsOn).toBe('2026-08-17');
  });

  it('forwards the exact active snapshot and original idempotency key', async () => {
    const service = serviceFor(prescription(OrderStatus.Active));
    await service.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
      { expectedRowVersion: 3, reason: 'Reviewed for Pharmacy acceptance' }, 'handoff-key-1234');
    expect(pharmacyApi.acceptEhrPrescription).toHaveBeenCalledWith(context,
      expect.objectContaining({ sourceEhrPrescriptionId: prescriptionId,
        sourceEhrPrescriptionVersion: 3, sourceStatus: OrderStatus.Active,
        orderingFacilityId: facilityId, patientId }), 'handoff-key-1234');
  });

  /**
   * The review of PR 218 (Medium 1): Amoxicillin activated on Monday, a
   * severe Penicillin allergy recorded on Tuesday, the prescription handed to
   * this facility's pharmacy on Wednesday.
   */
  describe('the allergy check (0117)', () => {
    const allergyId = '123e4567-e89b-42d3-a456-426614174010';
    const penicillin = { id: allergyId, substance: 'Penicillin', reaction: 'Anaphylaxis', severity: 'severe' };
    const medicine = { display: 'Amoxicillin 500 mg', code: '123' };
    const token = warningToken(matchAllergies(medicine, [{ source: 'recorded', ...penicillin }]), medicine);
    const handoff = { expectedRowVersion: 3, reason: 'Reviewed for Pharmacy acceptance' };
    const acknowledgement = { reason: 'Tolerated amoxicillin in 2024; observe 30 minutes', warningToken: token };
    const inserts = () => calls.filter((call) => /insert into/.test(call.sql));

    it('refuses with 409 before Pharmacy is called, and stores nothing', async () => {
      const service = serviceFor(prescription(OrderStatus.Active), [penicillin]);
      await expect(service.acceptForPharmacy(context, patientId, encounterId, prescriptionId, handoff, 'handoff-key-1234'))
        .rejects.toMatchObject({ status: 409, code: 'ALLERGY_ACKNOWLEDGEMENT_REQUIRED',
          errors: expect.arrayContaining([{ field: 'allergyAcknowledgement.warningToken', messages: [token] },
            expect.objectContaining({ field: 'allergyAcknowledgement.rejected', code: 'ALLERGY_ACKNOWLEDGEMENT_MISSING' })]) });
      expect(pharmacyApi.acceptEhrPrescription).not.toHaveBeenCalled();
      expect(inserts()).toEqual([]);
      expect(audits).toEqual([]);
      // Checked for this prescription: a reason stored for it would have covered the match.
      expect(calls.find((call) => /from ehr\.prescription_allergy_acknowledgements/.test(call.sql))?.values)
        .toEqual([prescriptionId, patientId, facilityId]);
    });

    it('refuses a reason given for another warning with 409 ALLERGY_WARNING_TOKEN_STALE, before Pharmacy', async () => {
      const service = serviceFor(prescription(OrderStatus.Active), [penicillin]);
      await expect(service.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
        { ...handoff, allergyAcknowledgement: { ...acknowledgement, warningToken: 'b'.repeat(64) } }, 'handoff-key-1234'))
        .rejects.toMatchObject({ status: 409, code: 'ALLERGY_ACKNOWLEDGEMENT_REQUIRED',
          errors: expect.arrayContaining([expect.objectContaining({ code: 'ALLERGY_WARNING_TOKEN_STALE' })]) });
      expect(pharmacyApi.acceptEhrPrescription).not.toHaveBeenCalled();
      expect(inserts()).toEqual([]);
    });

    it('with the reason for the warning shown, stores it for the handoff stage, then hands off', async () => {
      const service = serviceFor(prescription(OrderStatus.Active), [penicillin]);
      await service.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
        { ...handoff, allergyAcknowledgement: acknowledgement }, 'handoff-key-1234');
      expect(inserts().map((call) => call.values)).toEqual([[prescriptionId, patientId, facilityId, accountId, membershipId,
        'Tolerated amoxicillin in 2024; observe 30 minutes', [allergyId], false, 'handoff', []]]);
      expect(log.indexOf('tx: insert into ehr.prescription_allergy_acknowledgements')).toBeGreaterThan(-1);
      expect(log.indexOf('tx: insert into ehr.prescription_allergy_acknowledgements')).toBeLessThan(log.indexOf('audit'));
      expect(log.at(-1)).toBe('pharmacy');
      expect(pharmacyApi.acceptEhrPrescription).toHaveBeenCalledTimes(1);
      expect(audits).toEqual([{ action: 'ehr.prescription.pharmacy-handoff.eligibility-checked', details: {
        expectedPrescriptionVersion: 3, prescriptionVersion: 3, allergyOverride: true, matchedRecordedCount: 1,
        patientReportedMatched: false } }]);
      expect(JSON.stringify(audits)).not.toMatch(/penicillin|amoxicillin|observe/i);
      // Pharmacy gets the prescription as before, never the reason.
      expect(JSON.stringify(pharmacyApi.acceptEhrPrescription.mock.calls[0][1])).not.toMatch(/observe|allergy/i);
    });

    it('needs no new reason when a stored one already covers every match', async () => {
      const service = serviceFor(prescription(OrderStatus.Active), [penicillin],
        [{ matchedRecordedAllergyIds: [allergyId], patientReportedTerms: [] }]);
      await service.acceptForPharmacy(context, patientId, encounterId, prescriptionId, handoff, 'handoff-key-1234');
      expect(inserts()).toEqual([]);
      expect(pharmacyApi.acceptEhrPrescription).toHaveBeenCalledTimes(1);
      expect(audits[0]?.details).toEqual({ expectedPrescriptionVersion: 3, prescriptionVersion: 3 });
    });

    it('ignores an acknowledgement when nothing matches', async () => {
      const service = serviceFor(prescription(OrderStatus.Active),
        [{ id: allergyId, substance: 'Peanuts', reaction: null, severity: 'mild' }]);
      await service.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
        { ...handoff, allergyAcknowledgement: acknowledgement }, 'handoff-key-1234');
      expect(inserts()).toEqual([]);
      expect(pharmacyApi.acceptEhrPrescription).toHaveBeenCalledTimes(1);
    });

    it('answers a version conflict or a prescription not active first, without reading the allergies', async () => {
      const stale = serviceFor(prescription(OrderStatus.Active), [penicillin]);
      await expect(stale.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
        { ...handoff, expectedRowVersion: 2 }, 'handoff-key-1234'))
        .rejects.toMatchObject({ status: 412, code: 'PRESCRIPTION_VERSION_CONFLICT' });
      for (const status of [OrderStatus.Draft, OrderStatus.OnHold, OrderStatus.Completed]) {
        const service = serviceFor(prescription(status), [penicillin]);
        await expect(service.acceptForPharmacy(context, patientId, encounterId, prescriptionId, handoff, 'handoff-key-1234'))
          .rejects.toMatchObject({ status: 409, code: 'PRESCRIPTION_NOT_ELIGIBLE' });
      }
      expect(calls.some((call) => /recorded_allergies|allergy/.test(call.sql))).toBe(false);
      expect(pharmacyApi.acceptEhrPrescription).not.toHaveBeenCalled();
    });
  });
});
