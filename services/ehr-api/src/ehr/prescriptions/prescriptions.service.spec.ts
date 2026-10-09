import type { DataAccessContext } from '../../common/request-context';
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

describe('PrescriptionsService Pharmacy handoff', () => {
  const pharmacyApi = { acceptEhrPrescription: jest.fn() };
  const repository = { run: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    pharmacyApi.acceptEhrPrescription.mockResolvedValue({ id: '123e4567-e89b-42d3-a456-426614174007' });
  });

  const serviceFor = (row: PrescriptionRow) => {
    repository.run.mockImplementation(async (_context, _patientId, _access, _event, operation) =>
      (await operation({ query: jest.fn().mockResolvedValue({ rows: [row] }) })).value);
    return new PrescriptionsService(repository as never, pharmacyApi as never);
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

  it('forwards the exact active snapshot and original idempotency key', async () => {
    const service = serviceFor(prescription(OrderStatus.Active));
    await service.acceptForPharmacy(context, patientId, encounterId, prescriptionId,
      { expectedRowVersion: 3, reason: 'Reviewed for Pharmacy acceptance' }, 'handoff-key-1234');
    expect(pharmacyApi.acceptEhrPrescription).toHaveBeenCalledWith(context,
      expect.objectContaining({ sourceEhrPrescriptionId: prescriptionId,
        sourceEhrPrescriptionVersion: 3, sourceStatus: OrderStatus.Active,
        orderingFacilityId: facilityId, patientId }), 'handoff-key-1234');
  });
});
