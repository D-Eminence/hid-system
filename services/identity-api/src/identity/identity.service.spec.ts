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
 * grant held at another facility, while the audit keeps the true outcome. The
 * actor's and facility's budgets are read before anything else and counted
 * only by refusals, alike, so that Health-id's lookup before each clinical
 * read and write of a granted patient spends nothing (FE-10).
 */
describe('IdentityService.lookupPatient', () => {
  function fixture(options: { visible?: IdentityPatient | null; subject?: string | null; decision?: typeof allowed;
    blocked?: () => Promise<void>; budget?: () => Promise<void>;
    failing?: 'lookup' | 'subject' | 'authorize' } = {}) {
    const order: string[] = [];
    const step = (name: 'lookup' | 'subject' | 'authorize') => {
      order.push(name);
      if (options.failing === name) throw new Error('identity provider unavailable');
    };
    const provider = {
      lookupExactHid: jest.fn(async () => { step('lookup'); return options.visible ?? null; }),
      lookupAuditSubject: jest.fn(async () => { step('subject'); return options.subject ?? null; }),
      authorize: jest.fn(async () => { step('authorize'); return options.decision ?? allowed; }),
      consentStatus: jest.fn(),
    } as unknown as IdentityProvider & Record<string, jest.Mock>;
    const audit = { record: jest.fn(async () => { order.push('audit'); }) };
    const budget = {
      refuseWhileBlocked: jest.fn(options.blocked ?? (async () => { order.push('blocked'); })),
      consume: jest.fn(options.budget ?? (async () => { order.push('budget'); })),
    };
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

  const limited = () => new DomainProblem(429, 'PATIENT_LOOKUP_RATE_LIMITED', 'Too many patient lookups; wait and try again');

  it('reads the budgets before anything else, counting nothing, and answers 429 while either is blocked', async () => {
    const open = fixture({ visible: patient });
    await open.service.lookupPatient('HID-ABCDEFGH', 'direct-care', context);
    expect(open.budget.refuseWhileBlocked).toHaveBeenCalledWith('patient_lookup', context);
    expect(open.order[0]).toBe('blocked');

    const blocked = fixture({ visible: patient, blocked: async () => { throw limited(); } });
    await expect(blocked.service.lookupPatient('HID-ABCDEFGH', 'direct-care', context))
      .rejects.toMatchObject({ status: 429, code: 'PATIENT_LOOKUP_RATE_LIMITED' });
    expect(blocked.provider.lookupExactHid).not.toHaveBeenCalled();
    expect(blocked.provider.lookupAuditSubject).not.toHaveBeenCalled();
    expect(blocked.provider.authorize).not.toHaveBeenCalled();
    expect(blocked.budget.consume).not.toHaveBeenCalled();
    expect(blocked.audit.record).not.toHaveBeenCalled();
  });

  it('does not charge a lookup that returns an authorized patient, however often it is repeated', async () => {
    const f = fixture({ visible: patient });
    // One more than the default actor maximum (60 in 5 minutes).
    for (let repeat = 0; repeat < 61; repeat++) {
      await expect(f.service.lookupPatient('HID-ABCDEFGH', 'direct-care', context))
        .resolves.toMatchObject({ patient: { patientId: 'patient-1' } });
    }
    expect(f.budget.consume).not.toHaveBeenCalled();
    expect(f.budget.refuseWhileBlocked).toHaveBeenCalledTimes(61);
  });

  it('charges every refusal alike, once, after its audit and before the 404', async () => {
    const unknown = fixture({ visible: null, subject: null });
    const hidden = fixture({ visible: null, subject: 'patient-1' });
    const unauthorized = fixture({ visible: patient, decision: { ...allowed, allowed: false } });
    for (const refused of [unknown, hidden, unauthorized]) {
      await expect(refused.service.lookupPatient('HID-ABCDEFGH', 'direct-care', context))
        .rejects.toMatchObject({ status: 404, code: 'PATIENT_NOT_AVAILABLE' });
      expect(refused.budget.consume).toHaveBeenCalledTimes(1);
      expect(refused.budget.consume).toHaveBeenCalledWith('patient_lookup', context);
    }
    expect(unknown.order).toEqual(['blocked', 'lookup', 'subject', 'audit', 'budget']);
    expect(hidden.order).toEqual(['blocked', 'lookup', 'subject', 'audit', 'budget']);
    expect(unauthorized.order).toEqual(['blocked', 'lookup', 'authorize', 'audit', 'budget']);
  });

  it('answers 429 to an unknown and an unauthorized HID alike when the refusal reaches a limit, keeping the true outcome in the audit', async () => {
    const reached = { budget: async () => { throw limited(); } };
    const unknown = fixture({ ...reached, visible: null, subject: null });
    const hidden = fixture({ ...reached, visible: null, subject: 'patient-1' });
    const unauthorized = fixture({ ...reached, visible: patient, decision: { ...allowed, allowed: false } });
    const answers = [
      await refusal(unknown.service.lookupPatient('HID-UNKNOWNX', 'direct-care', context)),
      await refusal(hidden.service.lookupPatient('HID-ABCDEFGH', 'direct-care', context)),
      await refusal(unauthorized.service.lookupPatient('HID-ABCDEFGH', 'direct-care', context)),
    ];
    for (const answer of answers) {
      expect(answer).toBeInstanceOf(DomainProblem);
      expect(answer).toMatchObject({ status: 429, code: 'PATIENT_LOOKUP_RATE_LIMITED',
        message: 'Too many patient lookups; wait and try again' });
    }
    expect(unknown.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.patient.lookup',
      outcome: 'denied', patientId: undefined, details: { reason: 'not_found' } }));
    expect(hidden.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.patient.lookup',
      outcome: 'denied', patientId: 'patient-1', details: { reason: 'not_authorized' } }));
    expect(unauthorized.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.patient.lookup',
      outcome: 'denied', patientId: 'patient-1', details: { reason: 'not_authorized' } }));
  });

  it('does not charge a lookup that failed on a dependency', async () => {
    const lookupFailed = fixture({ visible: patient, failing: 'lookup' });
    const subjectFailed = fixture({ visible: null, failing: 'subject' });
    const authorizeFailed = fixture({ visible: patient, failing: 'authorize' });
    for (const failed of [lookupFailed, subjectFailed, authorizeFailed]) {
      await expect(failed.service.lookupPatient('HID-ABCDEFGH', 'direct-care', context))
        .rejects.toThrow('identity provider unavailable');
      expect(failed.budget.consume).not.toHaveBeenCalled();
    }
    expect(lookupFailed.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.patient.lookup',
      outcome: 'failure', details: { dependency: 'identity-provider' } }));
    expect(subjectFailed.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.patient.lookup',
      outcome: 'failure', details: { dependency: 'identity-provider' } }));
  });
});
