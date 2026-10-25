import 'reflect-metadata';
import { FACILITY_OPTIONAL, PATIENT_ALLOWED, PATIENT_ONLY } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { consentContext, patientConsentContext } from './consent-context';
import { ConsentController } from './consent.controller';

// A patient's own decisions on access requests (list, approve, deny) are bound
// to the patient session: the patient app sends no purpose header and a
// patient has no facility. Before, these answered 400 PURPOSE_OF_USE_REQUIRED
// to the app, and 500 with the header (no facility in the request context).
function request(actor: Record<string, unknown> | undefined, headers: Record<string, string> = {}, facilityId?: string) {
  return { actor, correlationId: 'consent-context-correlation', facilityId,
    header: (name: string) => headers[name.toLowerCase()] } as unknown as HidRequest;
}
const patient = { kind: 'patient', subject: 'patient:subject', accountId: 'a0000000-0000-4000-8000-000000000001',
  patientId: 'b0000000-0000-4000-8000-000000000001', sessionId: 'c0000000-0000-4000-8000-000000000001',
  facilities: [], facilityIds: [], permissions: [], roles: [] };

describe('patientConsentContext', () => {
  it('takes the patient session with no purpose header and no facility', () => {
    const context = patientConsentContext(request(patient));
    expect(context).toEqual({ actor: patient, facilityId: '', membershipId: '', correlationId: 'consent-context-correlation',
      purposeOfUse: 'direct-care', authorization: undefined });
  });

  it('accepts a direct-care header and refuses any other purpose', () => {
    expect(patientConsentContext(request(patient, { 'x-purpose-of-use': 'direct-care' })).purposeOfUse).toBe('direct-care');
    expect(() => patientConsentContext(request(patient, { 'x-purpose-of-use': 'emergency' })))
      .toThrow(expect.objectContaining({ code: 'PURPOSE_OF_USE_REQUIRED' }));
  });

  it('refuses a staff session and a patient session without its ids', () => {
    for (const actor of [undefined, { ...patient, kind: 'staff' }, { ...patient, sessionId: undefined }]) {
      const error = (() => { try { patientConsentContext(request(actor)); } catch (caught) { return caught; } })();
      expect(error).toBeInstanceOf(DomainProblem);
      expect(error).toMatchObject({ code: 'PATIENT_SESSION_REQUIRED' });
      expect((error as DomainProblem).getStatus()).toBe(403);
    }
  });

  it('is what the staff context could not be for a patient', () => {
    expect(() => consentContext(request(patient, { 'x-purpose-of-use': 'direct-care' }), ['direct-care']))
      .toThrow('Request context was not established by security guards');
  });
});

describe('ConsentController patient decisions', () => {
  it.each(['listMyAccessRequests', 'approveAccessRequest', 'denyAccessRequest'] as const)('%s is patient-only', (name) => {
    const handler = ConsentController.prototype[name];
    expect(Reflect.getMetadata(PATIENT_ONLY, handler)).toBe(true);
    expect(Reflect.getMetadata(PATIENT_ALLOWED, handler)).toBe(true);
    expect(Reflect.getMetadata(FACILITY_OPTIONAL, handler)).toBe(true);
  });

  it('passes the patient context to the service', async () => {
    const consent = { approveAccessRequest: jest.fn().mockResolvedValue({ status: 'approved' }),
      denyAccessRequest: jest.fn().mockResolvedValue({ status: 'denied' }), listMyAccessRequests: jest.fn().mockResolvedValue([]) };
    const controller = new ConsentController(consent as never);
    await controller.approveAccessRequest(request(patient), 'd0000000-0000-4000-8000-000000000001');
    await controller.denyAccessRequest(request(patient), 'd0000000-0000-4000-8000-000000000001', { reason: 'Not this clinic' });
    await controller.listMyAccessRequests(request(patient));
    for (const call of [consent.approveAccessRequest.mock.calls[0], consent.denyAccessRequest.mock.calls[0],
      consent.listMyAccessRequests.mock.calls[0]]) {
      expect(call![0]).toMatchObject({ facilityId: '', membershipId: '', purposeOfUse: 'direct-care', actor: patient });
    }
    expect(consent.denyAccessRequest).toHaveBeenCalledWith(expect.anything(), 'd0000000-0000-4000-8000-000000000001',
      'Not this clinic');
  });
});
