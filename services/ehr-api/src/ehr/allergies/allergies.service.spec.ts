import type { DataAccessContext } from '../../common/request-context';
import { OrderStatus } from '../shared/clinical.dto';
import { PrescriptionsService } from '../prescriptions/prescriptions.service';
import { AllergiesService } from './allergies.service';
import { matchAllergies } from './allergy-match';
import { warningToken } from './allergy-reader';

const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const otherFacilityId = '123e4567-e89b-42d3-a456-426614174099';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const allergyId = '123e4567-e89b-42d3-a456-426614174010';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const laterAllergyId = '123e4567-e89b-42d3-a456-426614174011';
const penicillin = { id: allergyId, substance: 'Penicillin', reaction: null, severity: 'severe' };
/** The token of the warning a prescriber sees for Amoxicillin with these recorded allergies and patient text. */
const tokenFor = (recorded: { id: string; substance: string }[], reported?: string, display = 'Amoxicillin 500 mg') =>
  warningToken(matchAllergies({ display },
    [...recorded.map((row) => ({ source: 'recorded' as const, ...row })),
      ...(reported ? [{ source: 'patient_reported' as const, substance: reported }] : [])]), { display });

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  authorization: 'Bearer user', actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local',
    roles: ['doctor'], permissions: [], facilityIds: [facilityId], facilities: [],
    facility: { id: facilityId, membershipId, organizationId: facilityId, name: 'Test', roles: ['doctor'],
      permissions: [], isPrimary: true } } } as unknown as DataAccessContext;

const allergyRow = (overrides: Record<string, unknown> = {}) => ({
  id: allergyId, patientId, facilityId, createdBy: accountId, createdByMembershipId: membershipId,
  substance: 'Penicillin', reaction: 'Hives', severity: 'severe', status: 'active', enteredInErrorBy: null,
  enteredInErrorAt: null, enteredInErrorReason: null, rowVersion: '1', createdAt: new Date(), updatedAt: new Date(),
  ...overrides,
});

/** A client that answers each query by the first matching pattern. */
function fakeClient(answers: [RegExp, unknown[]][]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    const answer = answers.find(([pattern]) => pattern.test(sql));
    return { rows: answer ? answer[1] : [], rowCount: answer ? answer[1].length : 0 };
  });
  return { client: { query }, calls };
}

function repositoryWith(client: unknown) {
  return {
    run: jest.fn(async (_c, _p, _a, _e, operation, lookup) => {
      if (lookup && !(await lookup(client))) throw Object.assign(new Error('missing'), { status: 404 });
      return (await operation(client)).value;
    }),
    executeCreate: jest.fn(async (_client, _c, _p, _k, _o, _d, _r, create) => {
      const created = await create();
      return { value: created.value, resourceId: created.id, details: { ...created.details, idempotentReplay: false } };
    }),
    setChangeReason: jest.fn(async () => undefined),
    encounterExists: jest.fn(async () => true),
  };
}

describe('AllergiesService (0124)', () => {
  it('lists recorded and patient-reported allergies apart, and says which were recorded here', async () => {
    const { client } = fakeClient([
      [/from ehr\.recorded_allergies/, [allergyRow(), allergyRow({ id: 'x', facilityId: otherFacilityId })]],
      [/patient_reported_health_profiles/, [{ allergies: 'Peanuts', updated_at: new Date('2026-11-01T00:00:00Z') }]],
    ]);
    const repository = repositoryWith(client);
    const result = await new AllergiesService(repository as never).list(context, patientId, false);
    expect(result.recorded.map((row) => row.recordedHere)).toEqual([true, false]);
    expect(result.patientReported.allergies).toBe('Peanuts');
    const event = repository.run.mock.calls[0]?.[3];
    expect(event).toEqual({ action: 'ehr.allergy.list', resourceType: 'allergy', resourceId: patientId });
  });

  it('records an allergy at the current facility as the acting account', async () => {
    const { client, calls } = fakeClient([[/insert into ehr\.recorded_allergies/, [allergyRow()]]]);
    const service = new AllergiesService(repositoryWith(client) as never);
    const row = await service.create(context, patientId, { substance: 'Penicillin', reaction: 'Hives', severity: 'severe' }, 'key-12345678');
    expect(row.recordedHere).toBe(true);
    // The patient's allergy lock first (the check at prescribing takes the same one), then the insert.
    expect(calls[0]?.sql).toContain('pg_advisory_xact_lock');
    expect(calls[0]?.values).toEqual([patientId]);
    expect(calls[1]?.values).toEqual([patientId, facilityId, accountId, membershipId, 'Penicillin', 'Hives', 'severe']);
  });

  it('refuses "NKDA" and other "no known allergies" as a substance, writing nothing', async () => {
    for (const substance of ['NKDA', 'No known allergies', 'none']) {
      const { client, calls } = fakeClient([[/insert into ehr\.recorded_allergies/, [allergyRow()]]]);
      const repository = repositoryWith(client);
      expect(() => new AllergiesService(repository as never).create(context, patientId, { substance, severity: 'unknown' },
        'key-12345678')).toThrow(expect.objectContaining({ status: 400, code: 'ALLERGY_NOT_A_SUBSTANCE' }));
      expect(repository.run).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    }
  });

  it('lists active allergies most serious first: severe, then not known, moderate, mild', async () => {
    const { client, calls } = fakeClient([[/from ehr\.recorded_allergies/, []]]);
    await new AllergiesService(repositoryWith(client) as never).list(context, patientId, false);
    expect(calls[0]?.sql.replace(/\s+/g, ' ')).toContain(
      "order by (status = 'active') desc, array_position(array['severe', 'unknown', 'moderate', 'mild'], severity), created_at desc, id desc");
  });

  it('refuses to mark an allergy recorded at another facility, before any locking read', async () => {
    // Under forced RLS a FOR UPDATE read of another facility's row returns nothing (the update
    // policy applies), so the facility check must come from the plain read.
    const { client, calls } = fakeClient([
      [/for update/, []],
      [/from ehr\.recorded_allergies/, [allergyRow({ facilityId: otherFacilityId })]],
    ]);
    const service = new AllergiesService(repositoryWith(client) as never);
    await expect(service.markEnteredInError(context, patientId, allergyId, { expectedRowVersion: 1, reason: 'Wrong patient' }))
      .rejects.toMatchObject({ status: 409, code: 'ALLERGY_RECORDED_ELSEWHERE' });
    expect(calls.some((call) => /for update/.test(call.sql))).toBe(false);
  });

  it('refuses a stale version and an allergy already marked', async () => {
    const stale = fakeClient([[/from ehr\.recorded_allergies/, [allergyRow({ rowVersion: '2' })]]]);
    await expect(new AllergiesService(repositoryWith(stale.client) as never)
      .markEnteredInError(context, patientId, allergyId, { expectedRowVersion: 1, reason: 'Wrong patient' }))
      .rejects.toMatchObject({ status: 412 });
    const marked = fakeClient([[/from ehr\.recorded_allergies/, [allergyRow({ status: 'entered_in_error' })]]]);
    await expect(new AllergiesService(repositoryWith(marked.client) as never)
      .markEnteredInError(context, patientId, allergyId, { expectedRowVersion: 1, reason: 'Wrong patient' }))
      .rejects.toMatchObject({ status: 409, code: 'ALLERGY_ALREADY_ENTERED_IN_ERROR' });
  });

  it('marks an allergy entered in error with the reason as the change reason', async () => {
    const { client, calls } = fakeClient([
      [/^\s*update ehr\.recorded_allergies/, [allergyRow({ status: 'entered_in_error', rowVersion: '2' })]],
      [/from ehr\.recorded_allergies/, [allergyRow()]],
    ]);
    const repository = repositoryWith(client);
    const row = await new AllergiesService(repository as never)
      .markEnteredInError(context, patientId, allergyId, { expectedRowVersion: 1, reason: 'Recorded on the wrong patient' });
    expect(row.status).toBe('entered_in_error');
    expect(repository.setChangeReason).toHaveBeenCalledWith(client, 'Recorded on the wrong patient');
    const update = calls.find((call) => /^\s*update/.test(call.sql));
    expect(update?.values).toEqual([accountId, 'Recorded on the wrong patient', allergyId, patientId, facilityId, 1]);
  });

  it('checks a medicine against recorded and patient-reported allergies, counting matches only in the audit', async () => {
    const { client } = fakeClient([
      [/from ehr\.recorded_allergies/, [{ id: allergyId, substance: 'Penicillin', reaction: 'Hives', severity: 'severe' }]],
      [/patient_reported_health_profiles/, [{ allergies: 'sulfa drugs', updated_at: null }]],
    ]);
    const repository = repositoryWith(client);
    let details: unknown;
    repository.run.mockImplementation(async (_c, _p, _a, _e, operation) => {
      const result = await operation(client);
      details = result.details;
      return result.value;
    });
    const result = await new AllergiesService(repository as never)
      .check(context, patientId, { medicationDisplay: 'Amoxicillin 500 mg' });
    expect(result.acknowledgementRequired).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.warningToken).toBe(tokenFor([{ id: allergyId, substance: 'Penicillin' }]));
    expect(result.warningToken).toMatch(/^[a-f0-9]{64}$/);
    expect(details).toEqual({ matchCount: 1 });
  });

  it('does not warn for an allergy marked entered in error', async () => {
    const { client } = fakeClient([
      [/from ehr\.recorded_allergies[\s\S]*status = 'active'/, []],
      [/from ehr\.recorded_allergies/, [{ id: allergyId, substance: 'Penicillin', reaction: null, severity: 'severe' }]],
    ]);
    const result = await new AllergiesService(repositoryWith(client) as never)
      .check(context, patientId, { medicationDisplay: 'Amoxicillin 500 mg' });
    expect(result.matches).toEqual([]);
  });

  it('says where and when each allergy was recorded', async () => {
    const { client } = fakeClient([
      [/from ehr\.recorded_allergies/, [
        { ...penicillin, facility_id: otherFacilityId, created_at: new Date('2026-03-03T10:00:00Z') }]],
    ]);
    const result = await new AllergiesService(repositoryWith(client) as never)
      .check(context, patientId, { medicationDisplay: 'Amoxicillin 500 mg' });
    expect(result.matches[0]).toMatchObject({ recordedHere: false });
    expect(result.matches[0]?.message).toContain('Recorded by a clinician at another facility on 3 Mar 2026.');
  });
});

describe('PrescriptionsService allergy check at create (0124)', () => {
  const input = { medicationDisplay: 'Amoxicillin 500 mg', frequency: 'Three times daily', instructions: 'After food',
    status: OrderStatus.Active };
  const prescriptionRow = { id: '123e4567-e89b-42d3-a456-426614174020', encounterId, patientId, facilityId };
  const noRoutes = { summaries: async () => new Map(), summary: async () => null, crossFacilityOrdersEnabled: async () => false };

  function setup(recorded: unknown[], reported: string | null, extra: [RegExp, unknown[]][] = []) {
    const fake = fakeClient([
      ...extra,
      [/insert into ehr\.prescriptions/, [prescriptionRow]],
      [/insert into ehr\.prescription_allergy_acknowledgements/, [{}]],
      [/from ehr\.recorded_allergies/, recorded],
      [/patient_reported_health_profiles/, reported === null ? [] : [{ allergies: reported, updated_at: null }]],
    ]);
    const repository = repositoryWith(fake.client);
    const service = new PrescriptionsService(repository as never, {} as never, noRoutes as never);
    return { service, calls: fake.calls, repository };
  }

  it('refuses a matching prescription without an acknowledgement and writes nothing', async () => {
    const { service, calls } = setup([{ id: allergyId, substance: 'Penicillin', reaction: null, severity: 'severe' }], null);
    await expect(service.create(context, patientId, encounterId, input, 'key-12345678'))
      .rejects.toMatchObject({ status: 409, code: 'ALLERGY_ACKNOWLEDGEMENT_REQUIRED',
        errors: [{ field: 'allergyAcknowledgement', messages: [expect.stringContaining('penicillins')] },
          { field: 'allergyAcknowledgement.warningToken', messages: [tokenFor([{ id: allergyId, substance: 'Penicillin' }])] }] });
    expect(calls.some((call) => /insert into ehr\.prescriptions/.test(call.sql))).toBe(false);
  });

  it('refuses a reason given for another warning (a new allergy recorded meanwhile) and writes nothing', async () => {
    // The prescriber saw only the patient's text "penicillin"; a nurse then recorded "Amoxicillin", severe.
    const shown = tokenFor([], 'penicillin');
    const { service, calls } = setup([{ id: laterAllergyId, substance: 'Amoxicillin', reaction: 'Anaphylaxis', severity: 'severe' }],
      'penicillin');
    await expect(service.create(context, patientId, encounterId,
      { ...input, allergyAcknowledgement: { reason: 'Took amoxicillin in 2024 with no reaction', warningToken: shown } },
      'key-12345678'))
      .rejects.toMatchObject({ status: 409, code: 'ALLERGY_ACKNOWLEDGEMENT_REQUIRED', errors: expect.arrayContaining([
        { field: 'allergyAcknowledgement', messages: [expect.stringContaining('Amoxicillin allergy: SEVERE (Anaphylaxis).')] },
        { field: 'allergyAcknowledgement.warningToken',
          messages: [tokenFor([{ id: laterAllergyId, substance: 'Amoxicillin' }], 'penicillin')] }]) });
    expect(calls.some((call) => /insert into/.test(call.sql))).toBe(false);
  });

  it('refuses a token from a check of another medicine (Amoxicillin) for Meropenem', async () => {
    const { service, calls } = setup([penicillin], null);
    await expect(service.create(context, patientId, encounterId, { ...input, medicationDisplay: 'Meropenem 1 g',
      allergyAcknowledgement: { reason: 'Tolerated amoxicillin last year; monitoring',
        warningToken: tokenFor([{ id: allergyId, substance: 'Penicillin' }]) } }, 'key-12345678'))
      .rejects.toMatchObject({ status: 409, code: 'ALLERGY_ACKNOWLEDGEMENT_REQUIRED', errors: expect.arrayContaining([
        { field: 'allergyAcknowledgement.warningToken',
          messages: [tokenFor([{ id: allergyId, substance: 'Penicillin' }], undefined, 'Meropenem 1 g')] }]) });
    expect(calls.some((call) => /insert into/.test(call.sql))).toBe(false);
  });

  it('binds the token to the medicine and to how each allergy matched', () => {
    const medicine = { display: 'Amoxicillin 500 mg' };
    const [match] = matchAllergies(medicine, [{ source: 'recorded', id: allergyId, substance: 'Penicillin' }]);
    expect(warningToken([match!], medicine)).not.toBe(warningToken([match!], { display: 'Meropenem 1 g' }));
    expect(warningToken([match!], medicine)).not.toBe(warningToken([{ ...match!, matchKind: 'cross_reactivity' }], medicine));
    expect(warningToken([match!], medicine)).toBe(warningToken([match!], { display: '  AMOXICILLIN 500 MG ' }));
  });

  it('takes the patient\'s allergy lock before it reads the allergies, in the prescription\'s transaction', async () => {
    const { service, calls } = setup([], null);
    await service.create(context, patientId, encounterId, input, 'key-12345678');
    const lockAt = calls.findIndex((call) => /pg_advisory_xact_lock/.test(call.sql));
    const readAt = calls.findIndex((call) => /from ehr\.recorded_allergies/.test(call.sql));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(readAt);
    expect(calls[lockAt]?.values).toEqual([patientId]);
  });

  it('creates the prescription and records the acknowledgement with the matched allergies', async () => {
    const { service, calls } = setup([{ id: allergyId, substance: 'Penicillin', reaction: null, severity: 'severe' }],
      'penicillin');
    await service.create(context, patientId, encounterId,
      { ...input, allergyAcknowledgement: { reason: 'Tolerated amoxicillin last year; monitoring',
        warningToken: tokenFor([{ id: allergyId, substance: 'Penicillin' }], 'penicillin') } }, 'key-12345678');
    const acknowledgement = calls.find((call) => /prescription_allergy_acknowledgements/.test(call.sql));
    expect(acknowledgement?.values).toEqual([prescriptionRow.id, patientId, facilityId, accountId, membershipId,
      'Tolerated amoxicillin last year; monitoring', [allergyId], true, 'create', ['penicillin']]);
  });

  it('marks a create that went ahead after a warning in the audit, with counts and flags only', async () => {
    const { service, repository } = setup([{ id: allergyId, substance: 'Penicillin', reaction: null, severity: 'severe' }],
      'penicillin');
    await service.create(context, patientId, encounterId,
      { ...input, allergyAcknowledgement: { reason: 'Tolerated amoxicillin last year; monitoring',
        warningToken: tokenFor([{ id: allergyId, substance: 'Penicillin' }], 'penicillin') } }, 'key-12345678');
    const result = await repository.executeCreate.mock.results[0]?.value;
    expect(result.details).toEqual({ allergyOverride: true, matchedRecordedCount: 1, patientReportedMatched: true,
      idempotentReplay: false });
    expect(JSON.stringify(result.details)).not.toMatch(/penicillin|amoxicillin|monitoring/i);
  });

  it('creates a prescription with no match without any acknowledgement row', async () => {
    const { service, calls } = setup([{ id: allergyId, substance: 'Peanuts', reaction: null, severity: 'mild' }], 'None');
    await service.create(context, patientId, encounterId,
      { ...input, allergyAcknowledgement: { reason: 'Not needed but sent', warningToken: 'a'.repeat(64) } }, 'key-12345678');
    expect(calls.some((call) => /prescription_allergy_acknowledgements/.test(call.sql))).toBe(false);
    expect(calls.some((call) => /insert into ehr\.prescriptions/.test(call.sql))).toBe(true);
  });

  it('adds no override details to the audit of a create with no match', async () => {
    const { service, repository } = setup([], null);
    await service.create(context, patientId, encounterId, input, 'key-12345678');
    const result = await repository.executeCreate.mock.results[0]?.value;
    expect(result.details).toEqual({ idempotentReplay: false });
  });
});

describe('PrescriptionsService allergy check on Activate and Resume (0124)', () => {
  const prescriptionId = '123e4567-e89b-42d3-a456-426614174020';
  const current = (status: OrderStatus) => ({ id: prescriptionId, encounterId, patientId, facilityId, status, rowVersion: '1',
    medicationDisplay: 'Amoxicillin 500 mg', medicationCode: null });
  const noRoutes = { summaries: async () => new Map(), summary: async () => null, crossFacilityOrdersEnabled: async () => false };

  function setup(status: OrderStatus, recorded: unknown[], stored: unknown[] = []) {
    const fake = fakeClient([
      [/for update/, [current(status)]],
      [/^\s*update ehr\.prescriptions/, [{ ...current(OrderStatus.Active), rowVersion: '2' }]],
      [/insert into ehr\.prescription_allergy_acknowledgements/, [{}]],
      [/from ehr\.prescription_allergy_acknowledgements/, stored],
      [/from ehr\.recorded_allergies/, recorded],
    ]);
    const repository = repositoryWith(fake.client);
    repository.run.mockImplementation(async (_c, _p, _a, _e, operation) => operation(fake.client));
    const service = new PrescriptionsService(repository as never, {} as never, noRoutes as never);
    return { service, calls: fake.calls };
  }
  const activate = { expectedRowVersion: 1, changeReason: 'Ready to give', status: OrderStatus.Active };
  /** As setup, with no recorded allergy and the patient's own text. */
  function setupReported(status: OrderStatus, reported: string, stored: unknown[]) {
    const fake = fakeClient([
      [/for update/, [current(status)]],
      [/^\s*update ehr\.prescriptions/, [{ ...current(OrderStatus.Active), rowVersion: '2' }]],
      [/insert into ehr\.prescription_allergy_acknowledgements/, [{}]],
      [/from ehr\.prescription_allergy_acknowledgements/, stored],
      [/from ehr\.recorded_allergies/, []],
      [/patient_reported_health_profiles/, [{ allergies: reported, updated_at: null }]],
    ]);
    const repository = repositoryWith(fake.client);
    repository.run.mockImplementation(async (_c, _p, _a, _e, operation) => operation(fake.client));
    const service = new PrescriptionsService(repository as never, {} as never, noRoutes as never);
    return { service, calls: fake.calls };
  }

  it('refuses Activate of a draft when an allergy was recorded after it was saved', async () => {
    // 09:00 draft of Amoxicillin, no allergies; 09:10 the nurse records Penicillin; 09:15 Activate.
    const { service, calls } = setup(OrderStatus.Draft, [penicillin]);
    await expect(service.update(context, patientId, encounterId, prescriptionId, activate))
      .rejects.toMatchObject({ status: 409, code: 'ALLERGY_ACKNOWLEDGEMENT_REQUIRED' });
    expect(calls.some((call) => /^\s*update ehr\.prescriptions/.test(call.sql))).toBe(false);
  });

  it('refuses Resume of a prescription on hold in the same way', async () => {
    const { service } = setup(OrderStatus.OnHold, [penicillin]);
    await expect(service.update(context, patientId, encounterId, prescriptionId, activate))
      .rejects.toMatchObject({ status: 409, code: 'ALLERGY_ACKNOWLEDGEMENT_REQUIRED' });
  });

  it('activates with the reason for the warning shown and stores it for the activate stage', async () => {
    const { service, calls } = setup(OrderStatus.Draft, [penicillin]);
    const result = await service.update(context, patientId, encounterId, prescriptionId, { ...activate,
      allergyAcknowledgement: { reason: 'Reviewed with the patient; observe 30 minutes',
        warningToken: tokenFor([{ id: allergyId, substance: 'Penicillin' }]) } }) as unknown as { details: unknown };
    const acknowledgement = calls.find((call) => /insert into ehr\.prescription_allergy_acknowledgements/.test(call.sql));
    expect(acknowledgement?.values).toEqual([prescriptionId, patientId, facilityId, accountId, membershipId,
      'Reviewed with the patient; observe 30 minutes', [allergyId], false, 'activate', []]);
    expect(result.details).toEqual({ rowVersion: '2', allergyOverride: true, matchedRecordedCount: 1,
      patientReportedMatched: false });
  });

  it('stores a Resume reason for the resume stage', async () => {
    const { service, calls } = setup(OrderStatus.OnHold, [penicillin]);
    await service.update(context, patientId, encounterId, prescriptionId, { ...activate,
      allergyAcknowledgement: { reason: 'Reviewed with the patient; observe 30 minutes',
        warningToken: tokenFor([{ id: allergyId, substance: 'Penicillin' }]) } });
    const acknowledgement = calls.find((call) => /insert into ehr\.prescription_allergy_acknowledgements/.test(call.sql));
    expect(acknowledgement?.values.at(-2)).toBe('resume');
  });

  it('needs no new reason when a stored one already covers every match', async () => {
    const { service, calls } = setup(OrderStatus.Draft, [penicillin],
      [{ matchedRecordedAllergyIds: [allergyId], patientReportedTerms: [] }]);
    await service.update(context, patientId, encounterId, prescriptionId, activate);
    expect(calls.some((call) => /insert into ehr\.prescription_allergy_acknowledgements/.test(call.sql))).toBe(false);
    expect(calls.some((call) => /^\s*update ehr\.prescriptions/.test(call.sql))).toBe(true);
  });

  it('asks again when an allergy recorded since is not covered by the stored reason', async () => {
    const { service } = setup(OrderStatus.Draft,
      [penicillin, { id: laterAllergyId, substance: 'Amoxicillin', reaction: 'Anaphylaxis', severity: 'severe' }],
      [{ matchedRecordedAllergyIds: [allergyId], patientReportedTerms: [] }]);
    await expect(service.update(context, patientId, encounterId, prescriptionId, activate))
      .rejects.toMatchObject({ status: 409, code: 'ALLERGY_ACKNOWLEDGEMENT_REQUIRED' });
  });

  it('asks again when the patient adds a term after the stored reason (only "penicillin" was acknowledged)', async () => {
    const { service, calls } = setupReported(OrderStatus.Draft, 'penicillin, amoxicillin - anaphylaxis',
      [{ matchedRecordedAllergyIds: [], patientReportedTerms: ['penicillin'] }]);
    await expect(service.update(context, patientId, encounterId, prescriptionId, activate))
      .rejects.toMatchObject({ status: 409, code: 'ALLERGY_ACKNOWLEDGEMENT_REQUIRED',
        errors: expect.arrayContaining([{ field: 'allergyAcknowledgement',
          messages: [expect.stringContaining('Patient-reported allergy: “amoxicillin - anaphylaxis”.')] }]) });
    expect(calls.some((call) => /^\s*update ehr\.prescriptions/.test(call.sql))).toBe(false);
  });

  it('needs no new reason when every patient-reported term was acknowledged, and stores the terms', async () => {
    const covered = setupReported(OrderStatus.Draft, 'Penicillin; amoxicillin - anaphylaxis',
      [{ matchedRecordedAllergyIds: [], patientReportedTerms: ['penicillin', 'amoxicillin anaphylaxis'] }]);
    await covered.service.update(context, patientId, encounterId, prescriptionId, activate);
    expect(covered.calls.some((call) => /^\s*update ehr\.prescriptions/.test(call.sql))).toBe(true);
    const fresh = setupReported(OrderStatus.Draft, 'Penicillin; amoxicillin - anaphylaxis', []);
    const token = warningToken(matchAllergies({ display: 'Amoxicillin 500 mg' },
      [{ source: 'patient_reported', substance: 'Penicillin; amoxicillin - anaphylaxis' }]), { display: 'Amoxicillin 500 mg' });
    await fresh.service.update(context, patientId, encounterId, prescriptionId, { ...activate,
      allergyAcknowledgement: { reason: 'Reviewed with the patient; observe 30 minutes', warningToken: token } });
    const acknowledgement = fresh.calls.find((call) => /insert into ehr\.prescription_allergy_acknowledgements/.test(call.sql));
    expect(acknowledgement?.values.slice(6)).toEqual([[], true, 'activate', ['penicillin', 'amoxicillin anaphylaxis']]);
  });

  it('does not check other changes (Hold, instructions)', async () => {
    const { service, calls } = setup(OrderStatus.Active, [penicillin]);
    await service.update(context, patientId, encounterId, prescriptionId, { expectedRowVersion: 1, changeReason: 'Waiting for results', status: OrderStatus.OnHold });
    expect(calls.some((call) => /recorded_allergies/.test(call.sql))).toBe(false);
  });
});
