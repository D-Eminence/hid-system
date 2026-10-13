import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import type { OperationResult } from '../shared/clinical.repository';
import { EncounterStatus } from '../shared/clinical.dto';
import { EncountersService, type EncounterRow } from './encounters.service';

const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const encounterId = '123e4567-e89b-42d3-a456-426614174005';

/**
 * Every record write permission, as a doctor or clinician holds them once Lab
 * ordering is enabled again. At launch no role holds ehr.lab-request.write
 * (0084), so DOCTOR_AT_LAUNCH lacks it.
 */
const ALL_WRITES = ['ehr.encounter.write', 'ehr.note.write', 'ehr.vital.write', 'ehr.diagnosis.write',
  'ehr.prescription.write', 'ehr.lab-request.write', 'ehr.document.write'];
const DOCTOR_AT_LAUNCH = ALL_WRITES.filter((permission) => permission !== 'ehr.lab-request.write');
/** The seeded nurse role (0006): no diagnosis, prescription or lab-request write. */
const NURSE = ['ehr.encounter.write', 'ehr.note.write', 'ehr.vital.write', 'ehr.document.write'];
/** The seeded receptionist role (0006): encounter write only. */
const RECEPTIONIST = ['ehr.encounter.write'];

const contextWith = (permissions: readonly string[]) => ({ correlationId: 'correlation-123456', facilityId, membershipId,
  purposeOfUse: 'direct-care', authorization: 'Bearer user', actor: { id: accountId,
    subject: 'staff:test', accountId, authenticationMethod: 'local', roles: ['doctor'],
    permissions: [...permissions], facilityIds: [facilityId], facilities: [] } }) as unknown as DataAccessContext;
const context = contextWith(ALL_WRITES);

const encounter = (status: EncounterStatus, rowVersion = '3'): EncounterRow => ({
  id: encounterId, patientId, facilityId, createdBy: accountId, createdByMembershipId: membershipId,
  encounterNumber: null, encounterType: 'ambulatory', status, startedAt: new Date('2026-10-01T08:00:00.000Z'),
  endedAt: status === EncounterStatus.Completed ? new Date('2026-10-01T09:00:00.000Z') : null,
  chiefComplaint: 'Synthetic complaint', rowVersion, createdAt: new Date('2026-10-01T08:00:00.000Z'),
  updatedAt: new Date('2026-10-01T08:00:00.000Z'),
});

const OPEN_ORDERS = ['draft', 'active', 'on_hold'];
/** Orders entered in error with their encounter: open ones and, since 0090, completed ones (ENC-RETRACT-2). */
const RETRACTABLE_ORDERS = ['draft', 'active', 'on_hold', 'completed'];

/**
 * A fake transaction for one encounter in `current` status. The row lock
 * returns it; the encounter UPDATE returns it at the next version (no row when
 * `stale`); a probe of whether a category holds records the close would change
 * answers from `affected`, and a child UPDATE returns the ids in `affected` for
 * its table. `log` keeps every statement and change reason in the order they
 * were issued.
 */
function harness(current: EncounterStatus, affected: Readonly<Record<string, readonly string[]>> = {},
  { stale = false } = {}) {
  const log: string[] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    const statement = sql.replace(/\s+/g, ' ').trim();
    log.push(statement);
    if (/^select .* from ehr\.encounters .* for update$/i.test(statement)) return { rows: [encounter(current)] };
    const probed = /^select exists \(select 1 from ehr\.(\w+)\b/i.exec(statement)?.[1];
    if (probed) return { rows: [{ present: (affected[probed]?.length ?? 0) > 0 }] };
    if (/^update ehr\.encounters\b/i.test(statement)) {
      return { rows: stale ? [] : [encounter((params[0] as EncounterStatus | null) ?? current, '4')] };
    }
    const child = /^update ehr\.(\w+)\b/i.exec(statement)?.[1];
    if (child) return { rows: (affected[child] ?? []).map((id) => ({ id })), rowCount: affected[child]?.length ?? 0 };
    return { rows: [] };
  });
  const results: Array<OperationResult<unknown>> = [];
  const repository = {
    run: jest.fn(async (_context: unknown, _patientId: unknown, _access: unknown, _event: unknown,
      operation: (client: unknown) => Promise<OperationResult<unknown>>) => {
      const result = await operation({ query });
      results.push(result);
      return result.value;
    }),
    setChangeReason: jest.fn(async (_client: unknown, reason: string) => { log.push(`change reason: ${reason}`); }),
    encounterExists: jest.fn(async () => true),
  };
  return { query, log, results, repository, service: new EncountersService(repository as never) };
}

/** The child UPDATE statements issued, as [table, params]. */
const childUpdates = (query: jest.Mock) => query.mock.calls
  .map(([sql, params]) => [/^\s*update ehr\.(\w+)/i.exec(String(sql))?.[1], params] as const)
  .filter(([table]) => table !== undefined && table !== 'encounters');
/** Whether any statement wrote anything. */
const wroteAnything = (query: jest.Mock) => query.mock.calls.some(([sql]) => /^\s*(update|insert|delete)\b/i.test(String(sql)));

const update = (status: EncounterStatus | undefined, extra: Record<string, unknown> = {}) =>
  ({ ...(status ? { status } : {}), expectedRowVersion: 3, changeReason: 'Documented on the wrong patient', ...extra });

describe('EncountersService status transitions', () => {
  it('marks a completed encounter entered in error, so a wrong-patient encounter can be retracted after completion', async () => {
    const { service } = harness(EncounterStatus.Completed);
    await expect(service.update(context, patientId, encounterId, update(EncounterStatus.EnteredInError) as never))
      .resolves.toMatchObject({ status: EncounterStatus.EnteredInError, rowVersion: '4' });
  });

  it.each([
    [EncounterStatus.Completed, EncounterStatus.Cancelled],
    [EncounterStatus.Completed, EncounterStatus.InProgress],
    [EncounterStatus.Completed, EncounterStatus.OnHold],
    [EncounterStatus.Completed, EncounterStatus.Planned],
    [EncounterStatus.Cancelled, EncounterStatus.InProgress],
    [EncounterStatus.Cancelled, EncounterStatus.EnteredInError],
    [EncounterStatus.EnteredInError, EncounterStatus.Completed],
    [EncounterStatus.EnteredInError, EncounterStatus.InProgress],
  ])('refuses %s to %s before writing anything', async (from, to) => {
    const { service, query, repository } = harness(from);
    await expect(service.update(context, patientId, encounterId, update(to) as never))
      .rejects.toMatchObject({ status: 409, code: 'INVALID_ENCOUNTER_TRANSITION' });
    expect(query.mock.calls.some(([sql]) => /^\s*update\b/i.test(String(sql)))).toBe(false);
    expect(repository.setChangeReason).not.toHaveBeenCalled();
  });
});

describe('EncountersService retraction of an encounter entered in error (CLIN-EIE, ENC-RETRACT-2)', () => {
  const affected = { clinical_notes: ['note-1', 'note-2'], diagnoses: ['diagnosis-1'], vitals: ['vital-1'],
    prescriptions: ['prescription-1'], lab_requests: ['lab-request-1'], documents: ['document-1'] };

  it.each([EncounterStatus.InProgress, EncounterStatus.Completed, EncounterStatus.OnHold, EncounterStatus.Planned])(
    'from %s marks its notes, diagnoses, vitals, open and completed orders and linked documents entered in error, after locking the encounter', async (from) => {
      const { service, query, log } = harness(from, affected);
      await service.update(context, patientId, encounterId, update(EncounterStatus.EnteredInError) as never);
      const keys = [encounterId, patientId, facilityId];
      expect(childUpdates(query)).toEqual([
        ['clinical_notes', ['entered_in_error', ...keys, ['draft', 'signed', 'amended']]],
        ['diagnoses', ['entered_in_error', ...keys, ['unconfirmed', 'provisional', 'differential', 'confirmed', 'refuted']]],
        ['vitals', ['entered_in_error', ...keys, ['final']]],
        ['prescriptions', ['entered_in_error', ...keys, RETRACTABLE_ORDERS]],
        ['lab_requests', ['entered_in_error', ...keys, RETRACTABLE_ORDERS]],
        ['documents', ['entered_in_error', ...keys, ['initiated', 'uploaded']]],
      ]);
      const statements = query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());
      expect(statements.find((sql) => /^update ehr\.clinical_notes\b/i.test(sql)))
        .toMatch(/^update ehr\.clinical_notes set status = \$1 where encounter_id = \$2 and patient_id = \$3 and facility_id = \$4 and status = any\(\$5::text\[\]\) returning id$/i);
      expect(statements.find((sql) => /^update ehr\.diagnoses\b/i.test(sql)))
        .toMatch(/^update ehr\.diagnoses set verification_status = \$1 where .* and verification_status = any\(\$5::text\[\]\) returning id$/i);
      expect(statements.find((sql) => /^update ehr\.vitals\b/i.test(sql)))
        .toMatch(/^update ehr\.vitals set status = \$1 where encounter_id = \$2 and patient_id = \$3 and facility_id = \$4 and status = any\(\$5::text\[\]\) returning id$/i);
      // Under the encounter's row lock, after the encounter itself, with the clinician's change reason,
      // which the version trigger records on every retracted record.
      const lockAt = log.findIndex((entry) => /from ehr\.encounters .* for update$/i.test(entry));
      const reasonAt = log.indexOf('change reason: Documented on the wrong patient');
      const encounterAt = log.findIndex((entry) => /^update ehr\.encounters\b/i.test(entry));
      const firstChildAt = log.findIndex((entry) =>
        /^update ehr\.(clinical_notes|diagnoses|vitals|prescriptions|lab_requests|documents)\b/i.test(entry));
      expect(lockAt).toBe(0);
      expect(reasonAt).toBeGreaterThan(lockAt);
      expect(encounterAt).toBeGreaterThan(reasonAt);
      expect(firstChildAt).toBeGreaterThan(encounterAt);
    });

  it('records the retracted record ids in the encounter update audit and returns them with the encounter', async () => {
    const { service, results } = harness(EncounterStatus.Completed, affected);
    const cascade = { status: 'entered_in_error', clinicalNoteIds: ['note-1', 'note-2'], diagnosisIds: ['diagnosis-1'],
      vitalIds: ['vital-1'], prescriptionIds: ['prescription-1'], labRequestIds: ['lab-request-1'],
      documentIds: ['document-1'] };
    const returned = await service.update(context, patientId, encounterId, update(EncounterStatus.EnteredInError) as never);
    expect(results[0]?.details).toEqual({ rowVersion: '4', cascade });
    // Additive: the encounter as before, with what its retraction changed.
    expect(returned).toEqual({ ...encounter(EncounterStatus.EnteredInError, '4'), cascade });
  });

  it('writes no child when the encounter changed since it was loaded', async () => {
    const { service, query } = harness(EncounterStatus.InProgress, affected, { stale: true });
    await expect(service.update(context, patientId, encounterId, update(EncounterStatus.EnteredInError) as never))
      .rejects.toMatchObject({ status: 412, code: 'VERSION_CONFLICT' });
    expect(childUpdates(query)).toEqual([]);
  });
});

describe('EncountersService retraction requires the write permission of every record it changes (ENC-RETRACT-1)', () => {
  it('refuses a nurse marking entered in error an encounter with a diagnosis and a prescription, before writing anything', async () => {
    const { service, query, repository } = harness(EncounterStatus.InProgress,
      { clinical_notes: ['note-1'], diagnoses: ['d-1'], prescriptions: ['p-1'] });
    const refusal = service.update(contextWith(NURSE), patientId, encounterId, update(EncounterStatus.EnteredInError) as never);
    await expect(refusal).rejects.toMatchObject({ status: 403, code: 'ENCOUNTER_RETRACTION_NOT_PERMITTED' });
    expect(wroteAnything(query)).toBe(false);
    expect(repository.setChangeReason).not.toHaveBeenCalled();
  });

  it('names the missing permissions for the refusal audit, and no record content', async () => {
    const { service } = harness(EncounterStatus.InProgress, { diagnoses: ['d-1'], prescriptions: ['p-1'] });
    const refusal = await service.update(contextWith(NURSE), patientId, encounterId,
      update(EncounterStatus.EnteredInError) as never).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DomainProblem);
    expect((refusal as DomainProblem & { auditDetails?: unknown }).auditDetails)
      .toEqual({ missingPermissions: ['ehr.diagnosis.write', 'ehr.prescription.write'] });
  });

  it('answers a fixed detail that does not tell the caller which kinds of record the encounter holds', async () => {
    // Only a kind the encounter holds is probed, so a permission named in the
    // response would tell a receptionist, who reads none of these records,
    // that the encounter holds a diagnosis or a prescription.
    const holdings: readonly Record<string, readonly string[]>[] = [
      { diagnoses: ['d-1'] }, { prescriptions: ['p-1'] }, { clinical_notes: ['n-1'], vitals: ['v-1'] }];
    for (const records of holdings) {
      const { service } = harness(EncounterStatus.InProgress, records);
      const refusal = await service.update(contextWith(RECEPTIONIST), patientId, encounterId,
        update(EncounterStatus.EnteredInError) as never).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ status: 403, code: 'ENCOUNTER_RETRACTION_NOT_PERMITTED' });
      expect((refusal as DomainProblem).message)
        .toBe('Cancelling or retracting this encounter changes records you may not write');
    }
  });

  it('lets a doctor retract the same encounter, returning what changed', async () => {
    const { service } = harness(EncounterStatus.InProgress, { diagnoses: ['d-1'], prescriptions: ['p-1'] });
    await expect(service.update(contextWith(DOCTOR_AT_LAUNCH), patientId, encounterId,
      update(EncounterStatus.EnteredInError) as never)).resolves.toMatchObject({ status: EncounterStatus.EnteredInError,
      cascade: { diagnosisIds: ['d-1'], prescriptionIds: ['p-1'] } });
  });

  it('lets a nurse retract an encounter holding only notes and vitals, which a nurse may write', async () => {
    const { service } = harness(EncounterStatus.InProgress, { clinical_notes: ['note-1'], vitals: ['vital-1'] });
    await expect(service.update(contextWith(NURSE), patientId, encounterId, update(EncounterStatus.EnteredInError) as never))
      .resolves.toMatchObject({ cascade: { clinicalNoteIds: ['note-1'], vitalIds: ['vital-1'] } });
  });

  it('lets a receptionist cancel or retract an encounter with no records', async () => {
    for (const status of [EncounterStatus.Cancelled, EncounterStatus.EnteredInError]) {
      const { service } = harness(EncounterStatus.Planned);
      await expect(service.update(contextWith(RECEPTIONIST), patientId, encounterId, update(status) as never))
        .resolves.toMatchObject({ status });
    }
  });

  it('refuses a receptionist cancelling an encounter with an open prescription', async () => {
    const { service, query } = harness(EncounterStatus.InProgress, { prescriptions: ['p-1'] });
    await expect(service.update(contextWith(RECEPTIONIST), patientId, encounterId, update(EncounterStatus.Cancelled) as never))
      .rejects.toMatchObject({ status: 403, code: 'ENCOUNTER_RETRACTION_NOT_PERMITTED' });
    expect(wroteAnything(query)).toBe(false);
  });

  it('refuses a launch doctor retracting an encounter that holds a lab request: no role writes lab requests at launch', async () => {
    const { service, query } = harness(EncounterStatus.InProgress, { lab_requests: ['lab-1'] });
    await expect(service.update(contextWith(DOCTOR_AT_LAUNCH), patientId, encounterId,
      update(EncounterStatus.EnteredInError) as never))
      .rejects.toMatchObject({ status: 403, code: 'ENCOUNTER_RETRACTION_NOT_PERMITTED' });
    expect(wroteAnything(query)).toBe(false);
  });

  it('asks only about the categories the close changes: cancelling probes orders, not notes', async () => {
    const { service, query } = harness(EncounterStatus.InProgress, { clinical_notes: ['note-1'], diagnoses: ['d-1'] });
    await expect(service.update(contextWith(RECEPTIONIST), patientId, encounterId, update(EncounterStatus.Cancelled) as never))
      .resolves.toMatchObject({ status: EncounterStatus.Cancelled });
    const probed = query.mock.calls.map(([sql]) => /^\s*select exists \(select 1 from ehr\.(\w+)/i.exec(String(sql))?.[1])
      .filter(Boolean);
    expect(probed).toEqual(['prescriptions', 'lab_requests']);
  });
});

describe('EncountersService cancellation', () => {
  it('cancels the encounter\'s open orders and leaves its notes and diagnoses as they are', async () => {
    const { service, query, results } = harness(EncounterStatus.InProgress,
      { prescriptions: ['prescription-1', 'prescription-2'], lab_requests: ['lab-request-1'] });
    await service.update(context, patientId, encounterId, update(EncounterStatus.Cancelled) as never);
    const keys = [encounterId, patientId, facilityId];
    expect(childUpdates(query)).toEqual([
      ['prescriptions', ['cancelled', ...keys, OPEN_ORDERS]],
      ['lab_requests', ['cancelled', ...keys, OPEN_ORDERS]],
    ]);
    expect(results[0]?.details).toEqual({ rowVersion: '4', cascade: { status: 'cancelled',
      prescriptionIds: ['prescription-1', 'prescription-2'], labRequestIds: ['lab-request-1'] } });
  });
});

describe('EncountersService updates that close nothing', () => {
  it.each([
    ['completing the encounter', EncounterStatus.InProgress, update(EncounterStatus.Completed,
      { endedAt: '2026-10-01T09:00:00.000Z' })],
    ['a chief complaint edit', EncounterStatus.InProgress, update(undefined, { chiefComplaint: 'Edited complaint' })],
    ['a chief complaint edit of a completed encounter', EncounterStatus.Completed,
      update(undefined, { chiefComplaint: 'Late clarification' })],
  ])('%s touches no clinical record', async (_label, current, input) => {
    const { service, query, results } = harness(current, { clinical_notes: ['note-1'], prescriptions: ['p-1'] });
    const returned = await service.update(context, patientId, encounterId, input as never);
    expect(childUpdates(query)).toEqual([]);
    expect(results[0]?.details).toEqual({ rowVersion: '4' });
    expect(returned).not.toHaveProperty('cascade');
  });

  it('keeps refusing an empty update as before', async () => {
    const { service } = harness(EncounterStatus.InProgress);
    expect(() => service.update(context, patientId, encounterId, { expectedRowVersion: 3,
      changeReason: 'Nothing to change' } as never)).toThrow(DomainProblem);
  });
});

describe('EncountersService refuses any change of a cancelled or entered-in-error encounter (ORDER-CLOSED-EDIT)', () => {
  it.each([
    [EncounterStatus.Cancelled, 'a chief complaint edit', update(undefined, { chiefComplaint: 'Rewritten complaint' })],
    [EncounterStatus.Cancelled, 'an end time edit', update(undefined, { endedAt: '2026-10-01T10:00:00.000Z' })],
    [EncounterStatus.EnteredInError, 'a chief complaint edit', update(undefined, { chiefComplaint: 'Rewritten complaint' })],
    [EncounterStatus.EnteredInError, 'the unchanged status', update(EncounterStatus.EnteredInError)],
    [EncounterStatus.Cancelled, 'the unchanged status', update(EncounterStatus.Cancelled)],
  ])('answers 409 ENCOUNTER_NOT_OPEN to %s encounter: %s, before writing anything', async (current, _label, input) => {
    const { service, query, repository } = harness(current);
    await expect(service.update(context, patientId, encounterId, input as never))
      .rejects.toMatchObject({ status: 409, code: 'ENCOUNTER_NOT_OPEN' });
    expect(wroteAnything(query)).toBe(false);
    expect(repository.setChangeReason).not.toHaveBeenCalled();
  });
});
