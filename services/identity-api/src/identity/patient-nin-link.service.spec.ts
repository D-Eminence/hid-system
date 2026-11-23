import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { LinkPatientNinDto } from './dto/link-patient-nin.dto';
import { NIN_LINK_FAILED_MESSAGE, PatientNinLinkService, patientNinLinkDigest } from './patient-nin-link.service';
import type { NinLinkCheck } from './nin-registration.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NIN = '12345678901';
const HMAC = 'a'.repeat(64);
const KEY = 'nin-link-key-0000000001';

const context = {
  correlationId: 'nin-link-spec-0001',
  facilityId: '33333333-3333-4333-8333-333333333333',
  membershipId: '44444444-4444-4444-8444-444444444444',
  purposeOfUse: 'healthcare-operations',
  actor: { subject: 'synthetic:desk', accountId: '55555555-5555-4555-8555-555555555555',
    facility: { organizationId: '66666666-6666-4666-8666-666666666666' } },
} as unknown as DataAccessContext;

const eligible = { decision: 'eligible', first_name: 'Ngozi', last_name: 'Linkone', date_of_birth: '1990-03-04' };

function harness(options: {
  precheck?: Record<string, unknown>;
  checks?: NinLinkCheck[];
  link?: Record<string, unknown>;
} = {}) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('patient_nin_link_precheck')) return { rows: [options.precheck ?? eligible] };
      if (sql.includes('link_patient_nin')) return { rows: [options.link ?? { outcome: 'nin_linked', other_patient_id: null }] };
      throw new Error(`unexpected query ${sql}`);
    }),
  };
  const database = { withTransaction: jest.fn(async (_context: unknown, operation: (c: typeof client) => unknown) => operation(client)) };
  const audit = { record: jest.fn(async () => undefined) };
  const protector = {
    lookup: jest.fn(() => HMAC),
    protectLink: jest.fn((_nin: string, _id: string) => ({ ciphertext: Buffer.alloc(40, 1), lookupHmac: HMAC, last4: '8901', keyVersion: 'k1' })),
  };
  const checks = [...(options.checks ?? [{ verified: true, outcome: 'match', providerCalled: true, stored: false,
    healthIdRecord: false, reference: 'QOREID-TXN-0001' } as NinLinkCheck])];
  const registrations = { checkNinForLink: jest.fn(async () => {
    const next = checks.shift();
    if (!next) throw new Error('no more checks');
    return next;
  }) };
  const service = new PatientNinLinkService(database as never, audit as never, protector as never, registrations as never);
  return { service, queries, audit, protector, registrations };
}

function input(nin = NIN): LinkPatientNinDto {
  return { nin, purpose: 'healthcare-operations' };
}

function auditDetails(audit: { record: jest.Mock }) {
  return audit.record.mock.calls.map(([event]) => event);
}

describe('PatientNinLinkService (ID-6, 0138)', () => {
  it('links a matching NIN: one check, then the database link with the protected NIN', async () => {
    const { service, queries, registrations, protector } = harness();
    await expect(service.link(PATIENT, input(), KEY, context)).resolves.toEqual({
      patientId: PATIENT, outcome: 'nin_linked', ninStatus: 'verified',
      message: 'NIN Verified. It is now on this patient\'s record.', replayed: false,
    });
    expect(registrations.checkNinForLink).toHaveBeenCalledTimes(1);
    expect(registrations.checkNinForLink).toHaveBeenCalledWith(NIN, HMAC,
      { firstName: 'Ngozi', lastName: 'Linkone', dateOfBirth: '1990-03-04' }, context);
    const link = queries.find((query) => query.sql.includes('link_patient_nin'))!;
    expect(link.params[0]).toBe(PATIENT);
    expect(link.params[2]).toBe(HMAC);
    expect(link.params[5]).toBe('8901');
    expect(link.params[6]).toBe('QOREID-TXN-0001');
    expect(link.params[7]).toBe(true);
    expect(link.params[8]).toBe(KEY);
    expect(link.params[9]).toBe(patientNinLinkDigest(PATIENT, HMAC));
    expect(protector.protectLink).toHaveBeenCalledWith(NIN, link.params[1]);
    // The link's own audit row is the database's.
  });

  it('compares the names the other way round, from the stored answer', async () => {
    const { service, registrations } = harness({ checks: [
      { verified: false, outcome: 'name_mismatch', providerCalled: true, stored: false, healthIdRecord: false },
      { verified: true, outcome: 'match', providerCalled: false, stored: true, healthIdRecord: false, reference: 'QOREID-TXN-0002' },
    ] });
    await expect(service.link(PATIENT, input(), KEY, context)).resolves.toMatchObject({ outcome: 'nin_linked' });
    expect(registrations.checkNinForLink).toHaveBeenLastCalledWith(NIN, HMAC,
      { firstName: 'Linkone', lastName: 'Ngozi', dateOfBirth: '1990-03-04' }, context);
  });

  it.each([
    ['no record', { verified: false, outcome: 'no_match', providerCalled: true, stored: false, healthIdRecord: false }, 'no_record'],
    ['the details do not match either way', { verified: false, outcome: 'name_mismatch', providerCalled: true, stored: false,
      healthIdRecord: false }, 'details_mismatch'],
  ] as const)('answers %s with Q117\'s words, and links nothing', async (_label, check, refusal) => {
    const { service, queries, audit } = harness({ checks: [check, check] });
    await expect(service.link(PATIENT, input(), KEY, context)).rejects.toMatchObject({
      status: 422, code: 'NIN_VERIFICATION_FAILED', message: NIN_LINK_FAILED_MESSAGE });
    expect(queries.some((query) => query.sql.includes('link_patient_nin'))).toBe(false);
    expect(auditDetails(audit)).toEqual([expect.objectContaining({ action: 'identity.patient.nin-link', outcome: 'denied',
      patientId: PATIENT, details: { refusal, qoreidCalled: true } })]);
  });

  it('does not swap names that are the same both ways', async () => {
    const { service, registrations } = harness({
      precheck: { ...eligible, first_name: 'Ada', last_name: 'ada ' },
      checks: [{ verified: false, outcome: 'name_mismatch', providerCalled: true, stored: false, healthIdRecord: false }],
    });
    await expect(service.link(PATIENT, input(), KEY, context)).rejects.toMatchObject({ code: 'NIN_VERIFICATION_FAILED' });
    expect(registrations.checkNinForLink).toHaveBeenCalledTimes(1);
  });

  it('answers a NIN another Health ID holds (Q110) only after its record matched, never naming it', async () => {
    const { service, queries, audit } = harness({ checks: [
      { verified: true, outcome: 'match', providerCalled: false, stored: false, healthIdRecord: true, holderPatientId: OTHER },
    ] });
    const error = await service.link(PATIENT, input(), KEY, context).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 409, code: 'NIN_ON_ANOTHER_RECORD' });
    expect(JSON.stringify((error as DomainProblem).getResponse())).not.toContain(OTHER);
    expect(queries.some((query) => query.sql.includes('link_patient_nin'))).toBe(false);
    expect(auditDetails(audit)[0]).toMatchObject({ details: { refusal: 'on_another_record', qoreidCalled: false,
      otherPatientId: OTHER } });
  });

  it('answers the database\'s on_another_record after a QoreID match', async () => {
    const { service, audit } = harness({ link: { outcome: 'on_another_record', other_patient_id: OTHER } });
    await expect(service.link(PATIENT, input(), KEY, context)).rejects.toMatchObject({ status: 409, code: 'NIN_ON_ANOTHER_RECORD' });
    expect(auditDetails(audit)[0]).toMatchObject({ details: { refusal: 'on_another_record', qoreidCalled: true, otherPatientId: OTHER } });
  });

  it.each([
    ['not_found', 404, 'PATIENT_NOT_FOUND', 'No such patient.'],
    ['not_permitted', 403, 'NIN_LINK_NOT_PERMITTED', 'You can add a NIN only for this facility\'s own patients.'],
    ['has_nin', 409, 'PATIENT_ALREADY_HAS_NIN', 'This patient already has a verified NIN.'],
    ['key_reused', 409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different request.'],
  ] as const)('refuses %s before any NIN check', async (decision, status, code, message) => {
    const { service, registrations, audit } = harness({ precheck: { decision } });
    await expect(service.link(PATIENT, input(), KEY, context)).rejects.toMatchObject({ status, code, message });
    expect(registrations.checkNinForLink).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('names no patient in the audit row for an unknown patient', async () => {
    const { service, audit } = harness({ precheck: { decision: 'not_found' } });
    await expect(service.link(PATIENT, input(), KEY, context)).rejects.toMatchObject({ code: 'PATIENT_NOT_FOUND' });
    const [event] = auditDetails(audit);
    expect(event.patientId).toBeUndefined();
    expect(event.resourceId).toBe(PATIENT);
  });

  it('answers the same NIN already on the record with no NIN check', async () => {
    const { service, registrations, audit } = harness({ precheck: { decision: 'already_linked' } });
    await expect(service.link(PATIENT, input(), KEY, context)).resolves.toEqual({
      patientId: PATIENT, outcome: 'already_linked', ninStatus: 'verified',
      message: 'NIN Verified. It is already on this patient\'s record.', replayed: false });
    expect(registrations.checkNinForLink).not.toHaveBeenCalled();
    expect(auditDetails(audit)).toEqual([expect.objectContaining({ outcome: 'success',
      details: { outcome: 'already_linked', qoreidCalled: false } })]);
  });

  it('replays the first answer for the same key and request, with its own audit row', async () => {
    const { service, registrations, audit } = harness({ precheck: { decision: 'replay' } });
    await expect(service.link(PATIENT, input(), KEY, context)).resolves.toMatchObject({ outcome: 'nin_linked', replayed: true });
    expect(registrations.checkNinForLink).not.toHaveBeenCalled();
    // Not 'nin_linked': the patient's access log shows "NIN added" once.
    expect(auditDetails(audit)).toEqual([expect.objectContaining({ outcome: 'success',
      details: { outcome: 'replayed', replayed: true, qoreidCalled: false } })]);
  });

  it('writes a row for a replay the link answers after a NIN check', async () => {
    const { service, audit } = harness({ link: { outcome: 'replay', other_patient_id: null } });
    await expect(service.link(PATIENT, input(), KEY, context)).resolves.toMatchObject({ outcome: 'nin_linked', replayed: true });
    expect(auditDetails(audit)).toEqual([expect.objectContaining({ outcome: 'success',
      details: { outcome: 'replayed', replayed: true, qoreidCalled: true } })]);
  });

  it.each([
    ['source_nin_differs', 409, 'PATIENT_ALREADY_HAS_NIN', 'source_nin_differs'],
    ['try_later', 503, 'NIN_LINK_TRY_LATER', 'legacy_records_pending'],
  ] as const)('refuses the legacy crosswalk\'s %s before any NIN check, with its own refusal kind',
    async (decision, status, code, refusal) => {
      const { service, registrations, audit } = harness({ precheck: { decision } });
      await expect(service.link(PATIENT, input(), KEY, context)).rejects.toMatchObject({ status, code });
      expect(registrations.checkNinForLink).not.toHaveBeenCalled();
      expect(auditDetails(audit)).toEqual([expect.objectContaining({ outcome: 'denied',
        details: { refusal, qoreidCalled: false } })]);
    });

  it.each([
    ['source_nin_differs', 409, 'PATIENT_ALREADY_HAS_NIN', 'source_nin_differs'],
    ['try_later', 503, 'NIN_LINK_TRY_LATER', 'legacy_records_pending'],
  ] as const)('answers the link\'s %s after a NIN check', async (outcome, status, code, refusal) => {
    const { service, audit } = harness({ link: { outcome, other_patient_id: null } });
    await expect(service.link(PATIENT, input(), KEY, context)).rejects.toMatchObject({ status, code });
    expect(auditDetails(audit)).toEqual([expect.objectContaining({ outcome: 'denied',
      details: { refusal, qoreidCalled: true } })]);
  });

  it('passes the NIN service\'s refusals and failures through unchanged', async () => {
    const { service, registrations } = harness();
    const held = new DomainProblem(409, 'NIN_CHECK_HELD', 'We could not finish checking this NIN. Please try again in 5 minutes.');
    registrations.checkNinForLink.mockRejectedValueOnce(held);
    await expect(service.link(PATIENT, input(), KEY, context)).rejects.toBe(held);
  });

  it('never writes the NIN or its HMAC in an audit row', async () => {
    for (const decision of ['not_found', 'not_permitted', 'has_nin', 'already_linked', 'key_reused', 'replay',
      'source_nin_differs', 'try_later']) {
      const { service, audit } = harness({ precheck: { decision } });
      await service.link(PATIENT, input(), KEY, context).catch(() => undefined);
      const written = JSON.stringify(auditDetails(audit));
      expect(written).not.toContain(NIN);
      expect(written).not.toContain(HMAC);
      expect(written).not.toContain('8901');
    }
  });

  it('requires an Idempotency-Key', async () => {
    const { service } = harness();
    await expect(service.link(PATIENT, input(), undefined, context)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });
});

describe('LinkPatientNinDto (ID-6)', () => {
  it('takes an 11-digit NIN with spaces and the purpose', async () => {
    const dto = plainToInstance(LinkPatientNinDto, { nin: '123 456 789 01', purpose: 'healthcare-operations' });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    expect(dto.nin).toBe('12345678901');
  });

  it.each([['1234567890'], ['123456789012'], ['1234567890a'], [12345678901]])('refuses the NIN %p', async (nin) => {
    const errors = await validate(plainToInstance(LinkPatientNinDto, { nin, purpose: 'healthcare-operations' }));
    expect(errors.map((error) => error.property)).toEqual(['nin']);
    expect(Object.values(errors[0]!.constraints ?? {})).toContain('Enter the 11-digit NIN.');
  });

  it('refuses another purpose and any other field', async () => {
    const errors = await validate(plainToInstance(LinkPatientNinDto,
      { nin: '12345678901', purpose: 'direct-care', hid: 'HID-ABC234' }), { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((error) => error.property).sort()).toEqual(['hid', 'purpose']);
  });
});
