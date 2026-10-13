import { DomainProblem } from '../common/problem';
import type { AuditService } from '../audit/audit.service';
import type { DataAccessContext } from '../common/request-context';
import type { IdentityPatient, IdentityProvider } from './identity.types';
import { IdentityService } from './identity.service';

const context = {
  actor: { subject: 'staff-subject', accountId: 'staff-account', facility: { organizationId: 'org-1' } },
  facilityId: 'facility-a', membershipId: 'membership-a', correlationId: 'lookup-correlation',
  purposeOfUse: 'direct-care',
} as unknown as DataAccessContext;
const patient: IdentityPatient = {
  id: 'patient-1', hidCode: 'HID-ABCDEFGH', firstName: 'Amina', lastName: 'Okafor', fullName: 'Amina Okafor',
  dateOfBirth: '1990-01-01', gender: 'female', rowVersion: 1,
};
const allowed = {
  allowed: true, patientId: patient.id, facilityId: 'facility-a', membershipId: 'membership-a',
  scope: 'read_records' as const, purpose: 'direct-care' as const, consentGrantId: 'grant-1',
  expiresAt: '2026-10-13T12:00:00.000Z', breakGlass: false,
};

/**
 * Staff patient lookup answers every refusal alike (PSEARCH-1, 0086): one
 * 404 PATIENT_NOT_AVAILABLE for an unknown HID, a patient without a grant and a
 * grant held at another facility, while the audit keeps the true outcome; and
 * each lookup is counted first against the actor's and facility's budgets.
 */
describe('IdentityService.lookupPatient', () => {
  function fixture(options: { visible?: IdentityPatient | null; subject?: string | null; decision?: typeof allowed;
    budget?: () => Promise<void> } = {}) {
    const order: string[] = [];
    const provider = {
      lookupExactHid: jest.fn(async () => { order.push('lookup'); return options.visible ?? null; }),
      lookupAuditSubject: jest.fn(async () => { order.push('subject'); return options.subject ?? null; }),
      authorize: jest.fn(async () => { order.push('authorize'); return options.decision ?? allowed; }),
      consentStatus: jest.fn(),
    } as unknown as IdentityProvider & Record<string, jest.Mock>;
    const audit = { record: jest.fn(async () => { order.push('audit'); }) };
    const budget = { consume: jest.fn(options.budget ?? (async () => { order.push('budget'); })) };
    // The budget is a third dependency since 0086; constructed loosely so that
    // this spec also compiles against a service without it.
    const service = new (IdentityService as unknown as new (...dependencies: unknown[]) => IdentityService)(
      provider, audit as unknown as AuditService, budget);
    return { service, provider, audit, budget, order };
  }
  const refusal = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

  it('answers an unknown HID, a patient without a grant and a visible but unauthorized patient with one 404', async () => {
    const unknown = fixture({ visible: null, subject: null });
    const hidden = fixture({ visible: null, subject: 'patient-1' });
    const unauthorized = fixture({ visible: patient, decision: { ...allowed, allowed: false } });
    const answers = [
      await refusal(unknown.service.lookupPatient('HID-UNKNOWNX', 'direct-care', context)),
      await refusal(hidden.service.lookupPatient('HID-ABCDEFGH', 'direct-care', context)),
      await refusal(unauthorized.service.lookupPatient('HID-ABCDEFGH', 'direct-care', context)),
    ];
    for (const answer of answers) {
      expect(answer).toBeInstanceOf(DomainProblem);
      expect(answer).toMatchObject({ status: 404, code: 'PATIENT_NOT_AVAILABLE', message: 'The patient is not available' });
    }
  });

  it('keeps the true outcome in the audit: not found, or not authorized with the patient it named', async () => {
    const unknown = fixture({ visible: null, subject: null });
    const hidden = fixture({ visible: null, subject: 'patient-1' });
    const unauthorized = fixture({ visible: patient, decision: { ...allowed, allowed: false } });
    await refusal(unknown.service.lookupPatient('HID-UNKNOWNX', 'direct-care', context));
    await refusal(hidden.service.lookupPatient('HID-ABCDEFGH', 'direct-care', context));
    await refusal(unauthorized.service.lookupPatient('HID-ABCDEFGH', 'direct-care', context));

    expect(unknown.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.patient.lookup',
      outcome: 'denied', patientId: undefined, details: { reason: 'not_found' } }));
    expect(hidden.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.patient.lookup',
      outcome: 'denied', patientId: 'patient-1', details: { reason: 'not_authorized' } }));
    expect(unauthorized.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.patient.lookup',
      outcome: 'denied', patientId: 'patient-1', details: { reason: 'not_authorized' } }));
    expect(hidden.provider.lookupAuditSubject).toHaveBeenCalledWith('HID-ABCDEFGH', context);
    expect(unauthorized.provider.lookupAuditSubject).not.toHaveBeenCalled();
  });

  it('returns the patient and its authorization only with an allowing grant', async () => {
    const f = fixture({ visible: patient });
    const result = await f.service.lookupPatient('HID-ABCDEFGH', 'direct-care', context);
    expect(result).toMatchObject({ patient: { patientId: 'patient-1', hid: 'HID-ABCDEFGH' },
      authorization: { decision: 'allow', consentGrantId: 'grant-1' } });
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', patientId: 'patient-1' }));
  });

  it('counts the lookup against the budget before it reads anything, and stops at 429', async () => {
    const counted = fixture({ visible: patient });
    await counted.service.lookupPatient('HID-ABCDEFGH', 'direct-care', context);
    expect(counted.budget.consume).toHaveBeenCalledWith('patient_lookup', context);
    expect(counted.order[0]).toBe('budget');

    const limited = fixture({ visible: patient, budget: async () => {
      throw new DomainProblem(429, 'PATIENT_LOOKUP_RATE_LIMITED', 'Too many patient lookups; wait and try again');
    } });
    await expect(limited.service.lookupPatient('HID-ABCDEFGH', 'direct-care', context))
      .rejects.toMatchObject({ status: 429, code: 'PATIENT_LOOKUP_RATE_LIMITED' });
    expect(limited.provider.lookupExactHid).not.toHaveBeenCalled();
    expect(limited.provider.lookupAuditSubject).not.toHaveBeenCalled();
  });
});
