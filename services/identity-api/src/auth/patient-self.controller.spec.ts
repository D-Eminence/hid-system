import type { HidRequest } from '../common/request-context';
import { PatientSelfController } from './patient-self.controller';
import type { PatientSelfService } from './patient-self.service';
import type { WorkloadAuthService } from './workload-auth.service';

// The controller's workload service imports jose (ESM); this spec never verifies a token.
jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

/**
 * D17 and the patient record release (owner decision 4 of 2026-10-16): the
 * patient-self authorization is EHR's alone. Lab results reach a patient only
 * through EHR's patient-self transaction and the released-results view, never
 * through a Lab route, so lab-api (or any other caller) is refused before its
 * workload credential is even checked.
 */
function setup(caller: string | undefined) {
  const authorize = jest.fn().mockResolvedValue({ allowed: true });
  const authenticateService = jest.fn().mockResolvedValue(undefined);
  const controller = new PatientSelfController({ authorize } as unknown as PatientSelfService,
    { authenticateService } as unknown as WorkloadAuthService);
  const headers: Record<string, string | undefined> = {
    'x-hid-internal-caller': caller, 'x-hid-service-token': 'synthetic-workload-token-0000000000000000',
  };
  const request = { header: (name: string) => headers[name.toLowerCase()] } as unknown as HidRequest;
  return { controller, request, authorize, authenticateService };
}

describe('Patient-self authorization is for the EHR service only (D17)', () => {
  it.each(['lab-api', 'pharmacy-api', 'ocr-api', 'outreach-api', 'notification-api', undefined])(
    'refuses %s with 403 WORKLOAD_AUTHENTICATION_REQUIRED before checking its credential', async (caller) => {
      const { controller, request, authorize, authenticateService } = setup(caller);
      await expect(controller.authorize(request)).rejects.toMatchObject({
        status: 403, code: 'WORKLOAD_AUTHENTICATION_REQUIRED' });
      expect(authenticateService).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
    });

  it('authenticates the EHR workload and then authorizes the patient session', async () => {
    const { controller, request, authorize, authenticateService } = setup('ehr-api');
    await expect(controller.authorize(request)).resolves.toEqual({ allowed: true });
    expect(authenticateService).toHaveBeenCalledWith('ehr-api', undefined, 'synthetic-workload-token-0000000000000000');
    expect(authorize).toHaveBeenCalledWith(request);
  });
});

// Imported legacy medical history (owner decision 3 of 2026-10-16, ADR-065):
// the patient's sharing choice, on the patient-only controller, behind its
// own switch (off by default), answered before the body is read.
describe('Patient imported history sharing routes', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Reflector } = require('@nestjs/core') as typeof import('@nestjs/core');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { plainToInstance } = require('class-transformer') as typeof import('class-transformer');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { validateSync } = require('class-validator') as typeof import('class-validator');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AUDIT_ACTION, PATIENT_ONLY } = require('../common/decorators') as typeof import('../common/decorators');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ImportedHistorySharingDto } = require('./dto/imported-history-sharing.dto') as
    typeof import('./dto/imported-history-sharing.dto');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ImportedHistorySharingEnabledGuard } = require('./imported-history-sharing.guard') as
    typeof import('./imported-history-sharing.guard');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const environment = require('../config/environment') as typeof import('../config/environment');
  const reflector = new Reflector();
  const prototype = PatientSelfController.prototype as unknown as Record<string, object>;

  it('serves both routes on the patient-only controller; only the read is behind the sharing switch', () => {
    expect(reflector.get(PATIENT_ONLY, PatientSelfController)).toBe(true);
    expect(Reflect.getMetadata('__guards__', prototype.importedHistorySharing as object))
      .toEqual([ImportedHistorySharingEnabledGuard]);
    // Turning sharing off is always allowed (ADR-065): the change route has
    // no switch guard, and the service refuses only turning it on while the
    // switch is off.
    expect(Reflect.getMetadata('__guards__', prototype.setImportedHistorySharing as object)).toBeUndefined();
    expect(reflector.get(AUDIT_ACTION, prototype.setImportedHistorySharing as () => unknown))
      .toBe('identity.patient.imported-history-sharing.change.command');
    expect(Reflect.getMetadata('__httpCode__', prototype.setImportedHistorySharing as object)).toBe(200);
  });

  it('passes the verified request and the choice to the service', async () => {
    const self = { importedHistorySharing: jest.fn(async () => ({ shared: false, updatedAt: null })),
      setImportedHistorySharing: jest.fn(async () => ({ shared: true, changed: true, updatedAt: null })) };
    const controller = new PatientSelfController(self as unknown as PatientSelfService, {} as WorkloadAuthService);
    const request = { correlationId: 'sharing-controller-test' } as unknown as HidRequest;
    await controller.importedHistorySharing(request);
    await controller.setImportedHistorySharing(request, { shared: true });
    expect(self.importedHistorySharing).toHaveBeenCalledWith(request);
    expect(self.setImportedHistorySharing).toHaveBeenCalledWith(request, true);
  });

  it.each([
    [{ shared: true }, true], [{ shared: false }, true], [{}, false], [{ shared: 'true' }, false], [{ shared: 1 }, false],
    [{ shared: null }, false],
  ])('validates the body %j: %s', (body, valid) => {
    const errors = validateSync(plainToInstance(ImportedHistorySharingDto, body));
    expect(errors.length === 0).toBe(valid);
  });

  describe('ImportedHistorySharingEnabledGuard', () => {
    afterEach(() => { jest.restoreAllMocks(); });
    it('answers 503 IMPORTED_HISTORY_SHARING_DISABLED while the switch is off', () => {
      jest.spyOn(environment, 'getEnvironment').mockReturnValue(
        { IMPORTED_HISTORY_SHARING_ENABLED: false } as ReturnType<typeof environment.getEnvironment>);
      expect(() => new ImportedHistorySharingEnabledGuard().canActivate())
        .toThrow(expect.objectContaining({ status: 503, code: 'IMPORTED_HISTORY_SHARING_DISABLED' }));
    });
    it('lets the request through when the switch is on', () => {
      jest.spyOn(environment, 'getEnvironment').mockReturnValue(
        { IMPORTED_HISTORY_SHARING_ENABLED: true } as ReturnType<typeof environment.getEnvironment>);
      expect(new ImportedHistorySharingEnabledGuard().canActivate()).toBe(true);
    });
  });
});
