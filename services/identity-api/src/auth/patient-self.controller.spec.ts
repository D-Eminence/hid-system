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
