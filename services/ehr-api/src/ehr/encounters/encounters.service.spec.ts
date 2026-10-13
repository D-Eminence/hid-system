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

const context = { correlationId: 'correlation-123456', facilityId, membershipId,
  purposeOfUse: 'direct-care', authorization: 'Bearer user', actor: { id: accountId,
    subject: 'staff:test', accountId, authenticationMethod: 'local', roles: ['doctor'],
    permissions: ['ehr.encounter.write'], facilityIds: [facilityId], facilities: [] } } as DataAccessContext;

const encounter = (status: EncounterStatus, rowVersion = '3'): EncounterRow => ({
  id: encounterId, patientId, facilityId, createdBy: accountId, createdByMembershipId: membershipId,
  encounterNumber: null, encounterType: 'ambulatory', status, startedAt: new Date('2026-10-01T08:00:00.000Z'),
  endedAt: status === EncounterStatus.Completed ? new Date('2026-10-01T09:00:00.000Z') : null,
  chiefComplaint: 'Synthetic complaint', rowVersion, createdAt: new Date('2026-10-01T08:00:00.000Z'),
  updatedAt: new Date('2026-10-01T08:00:00.000Z'),
});

const OPEN_ORDERS = ['draft', 'active', 'on_hold'];

/**
 * A fake transaction for one encounter in `current` status. The row lock
 * returns it; the encounter UPDATE returns it at the next version (no row when
 * `stale`); a child UPDATE returns the ids in `affected` for its table. `log`
 * keeps every statement and change reason in the order they were issued.
 */
function harness(current: EncounterStatus, affected: Readonly<Record<string, readonly string[]>> = {},
  { stale = false } = {}) {
  const log: string[] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    const statement = sql.replace(/\s+/g, ' ').trim();
    log.push(statement);
    if (/^select .* from ehr\.encounters .* for update$/i.test(statement)) return { rows: [encounter(current)] };
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

describe('EncountersService retraction of an encounter entered in error (CLIN-EIE)', () => {
  const affected = { clinical_notes: ['note-1', 'note-2'], diagnoses: ['diagnosis-1'],
    prescriptions: ['prescription-1'], lab_requests: ['lab-request-1'] };

  it.each([EncounterStatus.InProgress, EncounterStatus.Completed, EncounterStatus.OnHold, EncounterStatus.Planned])(
    'from %s marks its notes, diagnoses and open orders entered in error, after locking the encounter', async (from) => {
      const { service, query, log } = harness(from, affected);
      await service.update(context, patientId, encounterId, update(EncounterStatus.EnteredInError) as never);
      const keys = [encounterId, patientId, facilityId];
      expect(childUpdates(query)).toEqual([
        ['clinical_notes', ['entered_in_error', ...keys, ['draft', 'signed', 'amended']]],
        ['diagnoses', ['entered_in_error', ...keys, ['unconfirmed', 'provisional', 'differential', 'confirmed', 'refuted']]],
        ['prescriptions', ['entered_in_error', ...keys, OPEN_ORDERS]],
        ['lab_requests', ['entered_in_error', ...keys, OPEN_ORDERS]],
      ]);
      const statements = query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());
      expect(statements.find((sql) => /^update ehr\.clinical_notes\b/i.test(sql)))
        .toMatch(/^update ehr\.clinical_notes set status = \$1 where encounter_id = \$2 and patient_id = \$3 and facility_id = \$4 and status = any\(\$5::text\[\]\) returning id$/i);
      expect(statements.find((sql) => /^update ehr\.diagnoses\b/i.test(sql)))
        .toMatch(/^update ehr\.diagnoses set verification_status = \$1 where .* and verification_status = any\(\$5::text\[\]\) returning id$/i);
      // Under the encounter's row lock, after the encounter itself, with the clinician's change reason,
      // which the version trigger records on every retracted record.
      const lockAt = log.findIndex((entry) => /from ehr\.encounters .* for update$/i.test(entry));
      const reasonAt = log.indexOf('change reason: Documented on the wrong patient');
      const encounterAt = log.findIndex((entry) => /^update ehr\.encounters\b/i.test(entry));
      const firstChildAt = log.findIndex((entry) => /^update ehr\.(clinical_notes|diagnoses|prescriptions|lab_requests)\b/i.test(entry));
      expect(lockAt).toBe(0);
      expect(reasonAt).toBeGreaterThan(lockAt);
      expect(encounterAt).toBeGreaterThan(reasonAt);
      expect(firstChildAt).toBeGreaterThan(encounterAt);
    });

  it('records the retracted record ids in the encounter update audit', async () => {
    const { service, results } = harness(EncounterStatus.Completed, affected);
    await service.update(context, patientId, encounterId, update(EncounterStatus.EnteredInError) as never);
    expect(results[0]?.details).toEqual({ rowVersion: '4', cascade: { status: 'entered_in_error',
      clinicalNoteIds: ['note-1', 'note-2'], diagnosisIds: ['diagnosis-1'], prescriptionIds: ['prescription-1'],
      labRequestIds: ['lab-request-1'] } });
  });

  it('writes no child when the encounter changed since it was loaded', async () => {
    const { service, query } = harness(EncounterStatus.InProgress, affected, { stale: true });
    await expect(service.update(context, patientId, encounterId, update(EncounterStatus.EnteredInError) as never))
      .rejects.toMatchObject({ status: 412, code: 'VERSION_CONFLICT' });
    expect(childUpdates(query)).toEqual([]);
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
    ['an unchanged status', EncounterStatus.EnteredInError, update(EncounterStatus.EnteredInError)],
    ['a chief complaint edit', EncounterStatus.InProgress, update(undefined, { chiefComplaint: 'Edited complaint' })],
  ])('%s touches no clinical record', async (_label, current, input) => {
    const { service, query, results } = harness(current, { clinical_notes: ['note-1'], prescriptions: ['p-1'] });
    await service.update(context, patientId, encounterId, input as never);
    expect(childUpdates(query)).toEqual([]);
    expect(results[0]?.details).toEqual({ rowVersion: '4' });
  });

  it('keeps refusing an empty update as before', async () => {
    const { service } = harness(EncounterStatus.InProgress);
    expect(() => service.update(context, patientId, encounterId, { expectedRowVersion: 3,
      changeReason: 'Nothing to change' } as never)).toThrow(DomainProblem);
  });
});
