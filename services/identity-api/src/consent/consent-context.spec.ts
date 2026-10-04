import type { HidRequest } from '../common/request-context';
import { patientConsentRequest } from './consent-context';

function request(kind: 'patient' | 'staff', purpose = 'direct-care') {
  return {
    correlationId: 'patient-consent-test',
    actor: {
      kind, patientId: kind === 'patient' ? 'patient-id' : undefined,
      sessionId: kind === 'patient' ? 'session-id' : undefined,
    },
    header: (name: string) => name === 'x-purpose-of-use' ? purpose : undefined,
  } as unknown as HidRequest;
}

describe('Patient consent context', () => {
  it('accepts a patient session without a staff facility or membership', () => {
    const patient = request('patient');
    expect(patientConsentRequest(patient)).toBe(patient);
  });

  it('rejects staff and non-direct-care patient requests', () => {
    expect(() => patientConsentRequest(request('staff'))).toThrow('An active patient session is required');
    expect(() => patientConsentRequest(request('patient', 'emergency')))
      .toThrow('X-Purpose-Of-Use must be direct-care');
  });
});
