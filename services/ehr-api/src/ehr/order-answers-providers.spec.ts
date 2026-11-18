import { Test } from '@nestjs/testing';
import type { HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { WorkItemProgressService } from '../integrations/work-item-progress.service';
import { LabRequestsController } from './lab-requests/lab-requests.controller';
import { LabRequestsModule } from './lab-requests/lab-requests.module';
import { DuplicateMedicineChecker } from './prescriptions/duplicate-medicines';
import { PrescriptionsController } from './prescriptions/prescriptions.controller';
import { PrescriptionsModule } from './prescriptions/prescriptions.module';

/*
 * ORD-3 and ORD-10 phase 1 add ownProgress and duplicateMedicines to the
 * prescription and lab request answers through two providers. The real
 * modules must give the controllers the real providers: a provider that
 * stopped resolving must fail here, not leave the answers silently without
 * the fields. Only what lies outside these modules (the database, audit) is
 * a stand-in.
 */

const original = { ...process.env };
beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost:5432/hid',
    CORS_ORIGINS: 'http://localhost:3000', STORAGE_MODE: 'disabled' });
  resetEnvironmentForTests();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  resetEnvironmentForTests();
});

const stand = (token: unknown) => ({ standIn: typeof token === 'function' ? token.name : String(token) });

describe('the order modules give the controllers their ORD-3 and ORD-10 providers', () => {
  it('PrescriptionsModule: WorkItemProgressService and DuplicateMedicineChecker', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrescriptionsModule] }).useMocker(stand).compile();
    const controller = moduleRef.get(PrescriptionsController) as unknown as Record<string, unknown>;
    expect(controller.progress).toBeInstanceOf(WorkItemProgressService);
    expect(controller.duplicates).toBeInstanceOf(DuplicateMedicineChecker);
    await moduleRef.close();
  });

  it('LabRequestsModule: WorkItemProgressService', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [LabRequestsModule] }).useMocker(stand).compile();
    const controller = moduleRef.get(LabRequestsController) as unknown as Record<string, unknown>;
    expect(controller.progress).toBeInstanceOf(WorkItemProgressService);
    await moduleRef.close();
  });
});

describe('a lab request answer is the service\'s, plus exactly ownProgress (ORD-3)', () => {
  const patientId = '123e4567-e89b-42d3-a456-426614174001';
  const facilityId = '123e4567-e89b-42d3-a456-426614174002';
  const encounterId = '123e4567-e89b-42d3-a456-426614174006';
  const requestId = '123e4567-e89b-42d3-a456-426614174005';
  const request = { actor: { id: 'staff:doctor', subject: 'staff:doctor', accountId: 'account', roles: [], permissions: [],
    facilityIds: [facilityId], facilities: [], facility: { membershipId: 'membership' }, authenticationMethod: 'local' },
  facilityId, correlationId: 'correlation-123456', method: 'GET',
  header: (name: string) => (name === 'x-purpose-of-use' ? 'direct-care' : undefined) } as unknown as HidRequest;
  // A lab request as LabRequestsService answers it (fictional values).
  const labRequest = { id: requestId, encounterId, patientId, facilityId, createdBy: 'account', createdByMembershipId: 'membership',
    testCodeSystem: 'http://loinc.org', testCode: '4548-4', testDisplay: 'Synthetic HbA1c', priority: 'routine',
    clinicalNotes: null, status: 'active', rowVersion: '2', createdAt: '2026-11-18T10:00:00.000Z',
    updatedAt: '2026-11-18T10:00:00.000Z', labHandoff: { state: 'sent' }, orderRoute: null };
  const service = { list: jest.fn().mockResolvedValue({ items: [labRequest], nextCursor: null, crossFacilityOrders: false }),
    get: jest.fn().mockResolvedValue(labRequest) };
  const controller = new LabRequestsController(service as never, new WorkItemProgressService({} as never));

  it('listed and read by id', async () => {
    const page = await controller.list(request, patientId, encounterId, { limit: 50 } as never);
    expect(Object.keys(page)).toEqual(['items', 'nextCursor', 'crossFacilityOrders']);
    expect(Object.keys(page.items[0]!)).toEqual([...Object.keys(labRequest), 'ownProgress']);
    const one = await controller.get(request, patientId, encounterId, requestId);
    expect(Object.keys(one)).toEqual([...Object.keys(labRequest), 'ownProgress']);
    expect(one.ownProgress).toEqual({ status: 'unknown', receivedAt: null, collectedAt: null, lastResultAt: null });
  });
});
