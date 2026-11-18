import { ValidationPipe } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditService } from '../../audit/audit.service';
import type { HidRequest } from '../../common/request-context';
import type { DataAccessContext } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import type { IdentityApiService } from '../../integrations/identity-api.service';
import { PatientRecordsService } from '../patient-records/patient-records.service';
import { PATIENT_EVIDENCE_QUERY } from '../patient-records/patient-evidence.query';
import type { ClinicalRepository } from '../shared/clinical.repository';
import { EncounterStatus, UpdateEncounterDto } from '../shared/clinical.dto';
import { EncountersService, type EncounterRow } from './encounters.service';

// Fictional identifiers only.
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  authorization: 'Bearer user', actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local',
    roles: ['doctor'], permissions: [], facilityIds: [facilityId], facilities: [],
    facility: { id: facilityId, membershipId, organizationId: facilityId, name: 'Test', roles: ['doctor'],
      permissions: [], isPrimary: true } } } as unknown as DataAccessContext;

const visit = (status: EncounterStatus, overrides: Partial<EncounterRow> = {}): EncounterRow => ({
  id: encounterId, patientId, facilityId, createdBy: accountId, createdByMembershipId: membershipId,
  encounterNumber: null, encounterType: 'ambulatory', status, startedAt: new Date('2026-11-17T08:00:00Z'),
  endedAt: status === EncounterStatus.Completed ? new Date('2026-11-17T09:00:00Z') : null, chiefComplaint: 'Cough',
  rowVersion: '3', createdAt: new Date('2026-11-17T08:00:00Z'), updatedAt: new Date('2026-11-17T09:00:00Z'),
  importedPaperRecords: false, ...overrides,
});

function setup(current: EncounterRow, openOrders = 0, signedNotes = 0) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (/for update/.test(sql)) return { rows: [current] };
    if (/as "openOrders"/.test(sql)) return { rows: [{ openOrders, signedNotes }] };
    if (/^\s*update ehr\.encounters/.test(sql)) {
      return { rows: [{ ...current, status: values[0] ?? current.status, rowVersion: '4' }] };
    }
    return { rows: [] };
  }) };
  const audits: Record<string, unknown>[] = [];
  const reasons: string[] = [];
  const repository = {
    run: jest.fn(async (_c, _p, access, event, operation) => {
      const result = await operation(client);
      audits.push({ access, action: event.action, details: { ...event.details, ...result.details } });
      return result.value;
    }),
    setChangeReason: jest.fn(async (_client: unknown, reason: string) => { reasons.push(reason); }),
  };
  return { service: new EncountersService(repository as never), calls, audits, reasons };
}

const enterInError = { expectedRowVersion: 3, status: EncounterStatus.EnteredInError, changeReason: 'Wrong patient chosen' };
const updated = (calls: { sql: string }[]) => calls.some((call) => /^\s*update ehr\.encounters/.test(call.sql));

describe('EHR-C8a a completed visit entered in error', () => {
  it('marks a completed visit as entered in error with the typed reason, audited', async () => {
    const { service, calls, audits, reasons } = setup(visit(EncounterStatus.Completed));
    await expect(service.update(context, patientId, encounterId, enterInError))
      .resolves.toMatchObject({ status: 'entered_in_error', rowVersion: '4' });
    expect(reasons).toEqual(['Wrong patient chosen']);
    expect(audits).toEqual([{ access: 'write_records', action: 'ehr.encounter.update',
      details: { rowVersion: '4', completedVisitEnteredInError: true } }]);
    const orders = calls.find((call) => /as "openOrders"/.test(call.sql));
    expect(orders?.values).toEqual([encounterId, patientId, facilityId]);
    // Review finding 1: a draft counts too, since it could otherwise be activated later.
    expect(orders?.sql).toMatch(/from ehr\.prescriptions\s+where encounter_id = \$1 and patient_id = \$2 and facility_id = \$3\s+and status in \('draft', 'active', 'on_hold'\)/);
    expect(orders?.sql).toMatch(/from ehr\.lab_requests\s+where encounter_id = \$1 and patient_id = \$2 and facility_id = \$3\s+and status in \('draft', 'active', 'on_hold'\)/);
    // Review finding 2: signed notes are entered in error first.
    expect(orders?.sql).toMatch(/from ehr\.clinical_notes\s+where encounter_id = \$1 and patient_id = \$2 and facility_id = \$3\s+and status in \('signed', 'amended'\)/);
    // The count runs after the visit's FOR UPDATE lock.
    const lock = calls.findIndex((call) => /for update/.test(call.sql));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(calls.indexOf(orders!));
  });

  it('refuses the imported paper records visit', async () => {
    const { service, calls, reasons } = setup(visit(EncounterStatus.Completed, { importedPaperRecords: true }));
    await expect(service.update(context, patientId, encounterId, enterInError))
      .rejects.toMatchObject({ status: 409, code: 'IMPORTED_VISIT_NOT_ENTERED_IN_ERROR',
        message: 'The imported paper records visit cannot be marked as entered in error.' });
    expect(updated(calls)).toBe(false);
    expect(reasons).toEqual([]);
  });

  it('refuses while the visit still has a draft, active or on-hold prescription or lab request', async () => {
    const { service, calls, reasons } = setup(visit(EncounterStatus.Completed), 1);
    await expect(service.update(context, patientId, encounterId, enterInError))
      .rejects.toMatchObject({ status: 409, code: 'VISIT_HAS_OPEN_ORDERS',
        message: 'Cancel or stop this visit\'s prescriptions and lab requests, drafts included, before marking it as entered in error.' });
    expect(updated(calls)).toBe(false);
    expect(reasons).toEqual([]);
  });

  it('refuses while the visit still has a signed or amended note (review finding 2)', async () => {
    const { service, calls, reasons } = setup(visit(EncounterStatus.Completed), 0, 1);
    await expect(service.update(context, patientId, encounterId, enterInError))
      .rejects.toMatchObject({ status: 409, code: 'VISIT_HAS_SIGNED_NOTES',
        message: 'Mark this visit\'s signed notes as entered in error before marking the visit as entered in error.' });
    expect(updated(calls)).toBe(false);
    expect(reasons).toEqual([]);
  });

  it.each([EncounterStatus.InProgress, EncounterStatus.Planned, EncounterStatus.Cancelled, EncounterStatus.OnHold])(
    'still refuses completed to %s', async (status) => {
      const { service, calls } = setup(visit(EncounterStatus.Completed));
      await expect(service.update(context, patientId, encounterId, { ...enterInError, status }))
        .rejects.toMatchObject({ status: 409, code: 'INVALID_ENCOUNTER_TRANSITION' });
      expect(updated(calls)).toBe(false);
    });

  it('leaves entering an unfinished visit in error as it was (no new checks, no new audit field)', async () => {
    const { service, calls, audits } = setup(visit(EncounterStatus.InProgress));
    await service.update(context, patientId, encounterId, enterInError);
    expect(calls.some((call) => /as "openOrders"/.test(call.sql))).toBe(false);
    expect(audits[0]?.details).toEqual({ rowVersion: '4' });
  });

  it('needs a reason (the visit body still requires changeReason)', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true, transform: true });
    await expect(pipe.transform({ expectedRowVersion: 3, status: 'entered_in_error' }, { type: 'body', metatype: UpdateEncounterDto }))
      .rejects.toMatchObject({ status: 400 });
    await expect(pipe.transform({ expectedRowVersion: 3, status: 'entered_in_error', changeReason: 'ab' },
      { type: 'body', metatype: UpdateEncounterDto })).rejects.toMatchObject({ status: 400 });
  });
});

describe('EHR-C8a what the patient sees afterwards (patient-self re-run)', () => {
  const actor = { kind: 'patient', patientId, accountId, subject: 'patient:test', sessionId: 'session-id' };
  const request = { actor, correlationId: 'patient-record-test', header: () => undefined } as unknown as HidRequest;

  function patientRecords() {
    const authorizeSelf = jest.fn().mockResolvedValue({ ...actor, allowed: true,
      expiresAt: new Date(Date.now() + 30_000).toISOString() });
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const transaction = jest.fn(async (_auth: unknown, _correlation: string, work: (c: PoolClient) => Promise<unknown>) =>
      work({ query } as unknown as PoolClient));
    const run = jest.fn(async (_c, _p, _a, _e, operation) => (await operation({ query })).value);
    const service = new PatientRecordsService({ withPatientTransaction: transaction } as unknown as DatabaseService,
      { authorizeSelf } as unknown as IdentityApiService, { recordWithClient: jest.fn() } as unknown as AuditService,
      { run } as unknown as ClinicalRepository);
    return { service, query };
  }
  const NOTE_VISIT_FILTER = "and not exists(select 1 from ehr.encounters e where e.id=n.encounter_id and e.patient_id=n.patient_id\n"
    + "          and e.facility_id=n.facility_id and e.status='entered_in_error')";

  // Review finding 2: the filter is "no visit entered in error can be seen", not "a visit not entered in
  // error can be seen", so the patient (who sees only completed visits) still gets notes of open visits as
  // before.
  it('the patient\'s own record lists only completed visits; notes are filtered only against a visit entered in error', async () => {
    const { service, query } = patientRecords();
    await service.self(request);
    expect(query.mock.calls[0]?.[0]).toContain("status='completed'");
    expect(query.mock.calls[1]?.[0]).toContain(NOTE_VISIT_FILTER);
  });

  it('the emergency read leaves out notes of a visit entered in error too', async () => {
    const { service, query } = patientRecords();
    await service.emergency(patientId, { ...context, purposeOfUse: 'emergency' } as DataAccessContext);
    const notes = query.mock.calls.find(([sql]) => /from ehr\.clinical_notes n/.test(sql as string));
    expect(notes?.[0]).toContain(NOTE_VISIT_FILTER);
    expect(notes?.[1]).toEqual([patientId, facilityId]);
  });

  it('the patient chat reads visits, notes, prescriptions and tests only from completed visits (unchanged)', () => {
    expect(PATIENT_EVIDENCE_QUERY).toContain("from ehr.encounters e where e.status='completed'");
    expect(PATIENT_EVIDENCE_QUERY).toContain("from ehr.clinical_notes n join ehr.encounters e on e.id=n.encounter_id");
    expect(PATIENT_EVIDENCE_QUERY).toMatch(/from ehr\.prescriptions p join ehr\.encounters e on e\.id=p\.encounter_id[^\n]*e\.status='completed'/);
    expect(PATIENT_EVIDENCE_QUERY).toMatch(/from ehr\.lab_requests l join ehr\.encounters e on e\.id=l\.encounter_id[^\n]*e\.status='completed'/);
  });
});
