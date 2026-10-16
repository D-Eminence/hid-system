import { Reflector } from '@nestjs/core';
import { PATIENT_ONLY, REQUIRED_PERMISSIONS } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { getEnvironment, resetEnvironmentForTests } from '../../config/environment';
import { ImportedHistoryController } from './imported-history.controller';
import { StaffImportedHistoryEnabledGuard } from './imported-history-enabled.guard';

// The imported history routes (owner decision 3 of 2026-10-16, ADR-066).
describe('ImportedHistoryController', () => {
  const reflector = new Reflector();
  const patientId = '30000000-0000-4000-8000-000000000001';
  const facilityId = '30000000-0000-4000-8000-000000000010';
  function staffRequest(purpose?: string): HidRequest {
    const headers: Record<string, string | undefined> = { 'x-purpose-of-use': purpose, 'x-facility-id': facilityId };
    return { actor: { kind: 'staff', subject: 'doctor', accountId: 'account', facility: { membershipId: 'membership' } },
      facilityId, correlationId: 'imported-controller-test', method: 'GET',
      header: (name: string) => headers[name.toLowerCase()] } as unknown as HidRequest;
  }

  it('serves the patient\'s own history on a patient-only route', () => {
    expect(reflector.get(PATIENT_ONLY, ImportedHistoryController.prototype.self)).toBe(true);
  });

  it('requires ehr.imported-history.read for the staff route and is not patient-only', () => {
    expect(reflector.get(REQUIRED_PERMISSIONS, ImportedHistoryController.prototype.staff))
      .toEqual(['ehr.imported-history.read']);
    expect(reflector.get(PATIENT_ONLY, ImportedHistoryController.prototype.staff)).toBeUndefined();
    // The staff read's own switch runs after the security guard, on every request.
    expect(Reflect.getMetadata('__guards__', ImportedHistoryController.prototype.staff))
      .toEqual([StaffImportedHistoryEnabledGuard]);
    expect(Reflect.getMetadata('__guards__', ImportedHistoryController.prototype.self)).toBeUndefined();
  });

  it.each([undefined, 'emergency', 'healthcare-operations', 'Direct-care', 'patient-self'])(
    'answers 400 DIRECT_CARE_PURPOSE_REQUIRED for purpose %s before the service', (purpose) => {
      const history = { self: jest.fn(), staff: jest.fn() };
      const controller = new ImportedHistoryController(history as never);
      expect(() => controller.staff(patientId, staffRequest(purpose), {}))
        .toThrow(expect.objectContaining({ status: 400, code: 'DIRECT_CARE_PURPOSE_REQUIRED' }));
      expect(history.staff).not.toHaveBeenCalled();
    });

  it('passes a direct-care staff read to the service with its context and cursor', async () => {
    const history = { self: jest.fn(), staff: jest.fn(async () => ({ shared: false })) };
    const controller = new ImportedHistoryController(history as never);
    await controller.staff(patientId, staffRequest('direct-care'), { cursor: 'c'.repeat(20) });
    expect(history.staff).toHaveBeenCalledWith(patientId, expect.objectContaining({ purposeOfUse: 'direct-care',
      facilityId, membershipId: 'membership' }), 'c'.repeat(20));
  });

  describe('StaffImportedHistoryEnabledGuard', () => {
    const original = { ...process.env };
    afterEach(() => {
      for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
      Object.assign(process.env, original);
      resetEnvironmentForTests();
    });
    function configure(enabled?: string) {
      Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost/hid',
        CORS_ORIGINS: 'http://127.0.0.1', STORAGE_MODE: 'disabled', HID_DEPLOYMENT_ENV: 'development' });
      if (enabled === undefined) delete process.env.EHR_STAFF_IMPORTED_HISTORY_ENABLED;
      else process.env.EHR_STAFF_IMPORTED_HISTORY_ENABLED = enabled;
      resetEnvironmentForTests();
      getEnvironment();
    }

    it('answers 503 IMPORTED_HISTORY_DISABLED while the staff read is off (the default)', () => {
      configure();
      expect(() => new StaffImportedHistoryEnabledGuard().canActivate())
        .toThrow(expect.objectContaining({ status: 503, code: 'IMPORTED_HISTORY_DISABLED' }));
    });

    it('lets the request through when the staff read is on', () => {
      configure('true');
      expect(new StaffImportedHistoryEnabledGuard().canActivate()).toBe(true);
    });
  });
});
