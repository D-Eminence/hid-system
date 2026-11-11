import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataAccessContext } from '../../common/request-context';
import { OrderStatus } from '../shared/clinical.dto';
import { PrescriptionsService } from '../prescriptions/prescriptions.service';
import { AllergiesService } from './allergies.service';

const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const otherFacilityId = '123e4567-e89b-42d3-a456-426614174099';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const allergyId = '123e4567-e89b-42d3-a456-426614174010';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';

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
    expect(calls[0]?.values).toEqual([patientId, facilityId, accountId, membershipId, 'Penicillin', 'Hives', 'severe']);
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
    expect(details).toEqual({ matchCount: 1 });
  });
});

describe('PrescriptionsService allergy check at create (0124)', () => {
  const input = { medicationDisplay: 'Amoxicillin 500 mg', frequency: 'Three times daily', instructions: 'After food',
    status: OrderStatus.Active };
  const prescriptionRow = { id: '123e4567-e89b-42d3-a456-426614174020', encounterId, patientId, facilityId };
  const noRoutes = { summaries: async () => new Map(), summary: async () => null, crossFacilityOrdersEnabled: async () => false };

  function setup(recorded: unknown[], reported: string | null) {
    const fake = fakeClient([
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
        errors: [{ field: 'allergyAcknowledgement', messages: [expect.stringContaining('penicillins')] }] });
    expect(calls.some((call) => /insert into ehr\.prescriptions/.test(call.sql))).toBe(false);
  });

  it('creates the prescription and records the acknowledgement with the matched allergies', async () => {
    const { service, calls } = setup([{ id: allergyId, substance: 'Penicillin', reaction: null, severity: 'severe' }],
      'penicillin');
    await service.create(context, patientId, encounterId,
      { ...input, allergyAcknowledgement: { reason: 'Tolerated amoxicillin last year; monitoring' } }, 'key-12345678');
    const acknowledgement = calls.find((call) => /prescription_allergy_acknowledgements/.test(call.sql));
    expect(acknowledgement?.values).toEqual([prescriptionRow.id, patientId, facilityId, accountId, membershipId,
      'Tolerated amoxicillin last year; monitoring', [allergyId], true]);
  });

  it('marks a create that went ahead after a warning in the audit, with counts and flags only', async () => {
    const { service, repository } = setup([{ id: allergyId, substance: 'Penicillin', reaction: null, severity: 'severe' }],
      'penicillin');
    await service.create(context, patientId, encounterId,
      { ...input, allergyAcknowledgement: { reason: 'Tolerated amoxicillin last year; monitoring' } }, 'key-12345678');
    const result = await repository.executeCreate.mock.results[0]?.value;
    expect(result.details).toEqual({ allergyOverride: true, matchedRecordedCount: 1, patientReportedMatched: true,
      idempotentReplay: false });
    expect(JSON.stringify(result.details)).not.toMatch(/penicillin|amoxicillin|monitoring/i);
  });

  it('creates a prescription with no match without any acknowledgement row', async () => {
    const { service, calls } = setup([{ id: allergyId, substance: 'Peanuts', reaction: null, severity: 'mild' }], 'None');
    await service.create(context, patientId, encounterId,
      { ...input, allergyAcknowledgement: { reason: 'Not needed but sent' } }, 'key-12345678');
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

describe('an allergy marked entered in error stops warning (0124)', () => {
  const otherAllergyId = '123e4567-e89b-42d3-a456-426614174011';
  const otherMembershipId = '123e4567-e89b-42d3-a456-426614174098';
  const otherContext = { ...context, facilityId: otherFacilityId, membershipId: otherMembershipId } as DataAccessContext;
  const amoxicillin = { medicationDisplay: 'Amoxicillin 500 mg', frequency: 'Three times daily', instructions: 'After food',
    status: OrderStatus.Active };
  const prescriptionRow = { id: '123e4567-e89b-42d3-a456-426614174020', encounterId, patientId, facilityId };
  const noRoutes = { summaries: async () => new Map(), summary: async () => null, crossFacilityOrdersEnabled: async () => false };
  const checkRead = /^\s*select id, substance, reaction, severity from ehr\.recorded_allergies/;

  /**
   * A client that holds the patient's recorded allergies and answers the services' reads and
   * their one update the way the database would. A read keeps only active allergies when its SQL
   * says status = 'active', and every allergy otherwise, so if the allergy check stopped filtering
   * on status these tests would see the allergy marked entered in error come back and fail.
   */
  function recordedAllergiesClient(rows: ReturnType<typeof allergyRow>[]) {
    const calls: { sql: string; values: unknown[] }[] = [];
    const query = jest.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (/^\s*update ehr\.recorded_allergies/.test(sql)) {
        const [by, reason, id, patient, facility, version] = values;
        const row = rows.find((candidate) => candidate.id === id && candidate.patientId === patient
          && candidate.facilityId === facility && Number(candidate.rowVersion) === version
          && candidate.status === 'active');
        if (!row) return { rows: [], rowCount: 0 };
        Object.assign(row, { status: 'entered_in_error', enteredInErrorBy: by, enteredInErrorReason: reason,
          enteredInErrorAt: new Date(), rowVersion: String(Number(row.rowVersion) + 1) });
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (/from ehr\.recorded_allergies/.test(sql)) {
        const byId = /where id = \$1 and patient_id = \$2/.test(sql);
        const activeOnly = /status = 'active'/.test(sql);
        const found = rows.filter((row) => (byId ? row.id === values[0] && row.patientId === values[1]
          : row.patientId === values[0]) && (!activeOnly || row.status === 'active'));
        return { rows: found.map((row) => ({ ...row })), rowCount: found.length };
      }
      if (/insert into ehr\.prescriptions/.test(sql)) return { rows: [prescriptionRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    return { client: { query }, calls };
  }

  function services(rows: ReturnType<typeof allergyRow>[]) {
    const fake = recordedAllergiesClient(rows);
    const repository = repositoryWith(fake.client);
    return {
      allergies: new AllergiesService(repository as never),
      prescriptions: new PrescriptionsService(repository as never, {} as never, noRoutes as never),
      calls: fake.calls,
    };
  }
  const markedInError = { expectedRowVersion: 1, reason: 'Recorded on the wrong patient' };

  it('warns for Amoxicillin 500 mg against a Penicillin allergy, and stops once it is marked entered in error here', async () => {
    const { allergies, prescriptions, calls } = services([
      allergyRow({ substance: 'Penicillin', reaction: 'Anaphylaxis', severity: 'severe' })]);
    const before = await allergies.check(context, patientId, { medicationDisplay: 'Amoxicillin 500 mg' });
    expect(before.acknowledgementRequired).toBe(true);
    expect(before.matches).toEqual([expect.objectContaining({ allergyId, substance: 'Penicillin', matchKind: 'same_class' })]);
    await expect(prescriptions.create(context, patientId, encounterId, amoxicillin, 'key-12345678'))
      .rejects.toMatchObject({ status: 409, code: 'ALLERGY_ACKNOWLEDGEMENT_REQUIRED' });

    const marked = await allergies.markEnteredInError(context, patientId, allergyId, markedInError);
    expect(marked.status).toBe('entered_in_error');

    const after = await allergies.check(context, patientId, { medicationDisplay: 'Amoxicillin 500 mg' });
    expect(after).toEqual({ matches: [], acknowledgementRequired: false });
    await expect(prescriptions.create(context, patientId, encounterId, amoxicillin, 'key-12345679'))
      .resolves.toMatchObject({ id: prescriptionRow.id });
    expect(calls.some((call) => /prescription_allergy_acknowledgements/.test(call.sql))).toBe(false);
  });

  it('stops warning here once an allergy recorded at another facility is marked entered in error there', async () => {
    const { allergies, prescriptions } = services([allergyRow({ id: otherAllergyId, facilityId: otherFacilityId,
      createdByMembershipId: otherMembershipId, substance: 'Penicillin', reaction: 'Anaphylaxis', severity: 'severe' })]);
    const before = await allergies.check(context, patientId, { medicationDisplay: 'Amoxicillin 500 mg' });
    expect(before.matches).toEqual([expect.objectContaining({ allergyId: otherAllergyId, substance: 'Penicillin' })]);
    // This facility cannot mark it, so it keeps warning here.
    await expect(allergies.markEnteredInError(context, patientId, otherAllergyId, markedInError))
      .rejects.toMatchObject({ status: 409, code: 'ALLERGY_RECORDED_ELSEWHERE' });
    expect((await allergies.check(context, patientId, { medicationDisplay: 'Amoxicillin 500 mg' })).acknowledgementRequired)
      .toBe(true);

    await allergies.markEnteredInError(otherContext, patientId, otherAllergyId, markedInError);

    const after = await allergies.check(context, patientId, { medicationDisplay: 'Amoxicillin 500 mg' });
    expect(after).toEqual({ matches: [], acknowledgementRequired: false });
    await expect(prescriptions.create(context, patientId, encounterId, amoxicillin, 'key-12345678'))
      .resolves.toMatchObject({ id: prescriptionRow.id });
  });

  it('keeps warning for an active allergy beside one entered in error, and names only the active one', async () => {
    const { allergies } = services([
      allergyRow({ substance: 'Penicillin', reaction: 'Anaphylaxis', severity: 'severe', status: 'entered_in_error',
        enteredInErrorBy: accountId, enteredInErrorAt: new Date(), enteredInErrorReason: 'Recorded on the wrong patient',
        rowVersion: '2' }),
      allergyRow({ id: otherAllergyId, substance: 'Amoxicillin', reaction: 'Hives', severity: 'moderate' }),
    ]);
    const result = await allergies.check(context, patientId, { medicationDisplay: 'Amoxicillin 500 mg' });
    expect(result.matches.map((match) => match.allergyId)).toEqual([otherAllergyId]);
  });

  it('runs, in the database suite, the same read the check sends', async () => {
    const { allergies, calls } = services([]);
    await allergies.check(context, patientId, { medicationDisplay: 'Amoxicillin 500 mg' });
    const sent = calls.find((call) => checkRead.test(call.sql));
    expect(sent?.values).toEqual([patientId]);
    const words = (text: string) => text.replace(/\s+/g, ' ').trim();
    // The database suite shows, under row-level security, that this read stops returning an
    // allergy once it is marked entered in error; it must keep testing the read the code sends.
    const suite = readFileSync(
      join(__dirname, '../../../test/database/recorded-allergies-entered-in-error.integration.sql'), 'utf8');
    const suiteRead = /create function pg_temp\.allergies_for_check\(uuid\)[\s\S]*?as \$\$([\s\S]*?)\$\$/
      .exec(suite)?.[1];
    expect(words(suiteRead ?? 'pg_temp.allergies_for_check is missing'))
      .toBe(words(sent?.sql ?? 'no allergy read was sent'));
  });
});
