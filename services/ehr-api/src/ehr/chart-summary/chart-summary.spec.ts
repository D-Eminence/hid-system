import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { PoolClient } from 'pg';
import { ANY_PERMISSIONS, AUDIT_FAILURES_ONLY, REQUIRED_PERMISSIONS } from '../../common/decorators';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { LAB_PROGRESS_UNKNOWN, PHARMACY_PROGRESS_UNKNOWN, type LabOwnProgress,
  type PharmacyOwnProgress } from '../../integrations/work-item-progress.service';
import { AllergiesController } from '../allergies/allergies.controller';
import { DiagnosesController } from '../diagnoses/diagnoses.controller';
import { EncountersController } from '../encounters/encounters.controller';
import { LabRequestsController } from '../lab-requests/lab-requests.controller';
import { PatientRecordsController } from '../patient-records/patient-records.controller';
import { PrescriptionsController } from '../prescriptions/prescriptions.controller';
import { STAFF_SOURCE_PERMISSIONS } from '../patient-records/staff-chat-scope.service';
import { ClinicalRepository } from '../shared/clinical.repository';
import { PatientVitalsController } from '../vitals/patient-vitals.controller';
import { LATEST_VITALS_SQL } from '../vitals/vitals.service';
import { ChartSummaryController } from './chart-summary.controller';
import {
  ACTIVE_PROBLEMS_SQL, CHART_LIMITS, CHART_SECTION_PERMISSIONS, CHART_SECTIONS, CURRENT_MEDICATIONS_SQL,
  ChartSummaryService, EMERGENCY_VISITS_SQL, LEFT_OUT_MESSAGES, OPEN_LAB_REQUESTS_SQL, RECENT_VISITS_SQL,
  RESULT_PAGE_LIMIT,
} from './chart-summary.service';

// Fictional identifiers and fictional clinical content only.
const patientId = '123e4567-e89b-42d3-a456-426614174101';
const facilityId = '123e4567-e89b-42d3-a456-426614174102';
const accountId = '123e4567-e89b-42d3-a456-426614174103';
const membershipId = '123e4567-e89b-42d3-a456-426614174104';
const encounterId = '123e4567-e89b-42d3-a456-426614174105';
const prescriptionId = '123e4567-e89b-42d3-a456-426614174106';
const labRequestId = '123e4567-e89b-42d3-a456-426614174107';
const diagnosisId = '123e4567-e89b-42d3-a456-426614174108';
const allergyId = '123e4567-e89b-42d3-a456-426614174109';
const vitalId = '123e4567-e89b-42d3-a456-426614174110';

/** Each role's read permissions as the role table grants them (fictional members). */
const ROLES: Record<string, readonly string[]> = {
  doctor: ['ehr.encounter.read', 'ehr.diagnosis.read', 'ehr.prescription.read', 'ehr.lab-request.read',
    'ehr.vital.read', 'ehr.note.read', 'identity.patient.read', 'lab.result.released.read'],
  nurse: ['ehr.encounter.read', 'ehr.diagnosis.read', 'ehr.prescription.read', 'ehr.lab-request.read',
    'ehr.vital.read', 'ehr.note.read', 'identity.patient.read', 'lab.result.released.read'],
  receptionist: ['ehr.encounter.read', 'identity.patient.read'],
  lab: ['ehr.encounter.read', 'ehr.lab-request.read', 'lab.result.released.read'],
  pharmacist: ['ehr.encounter.read', 'ehr.prescription.read'],
};

function contextFor(permissions: readonly string[], purposeOfUse: 'direct-care' | 'emergency' = 'direct-care') {
  return { correlationId: 'correlation-chart-1', facilityId, membershipId, purposeOfUse, authorization: 'Bearer staff',
    actor: { id: accountId, subject: 'staff:fictional', accountId, authenticationMethod: 'local', roles: [],
      permissions, facilityIds: [facilityId], facilities: [],
      facility: { id: facilityId, membershipId, organizationId: facilityId, name: 'Fictional Clinic', roles: [],
        permissions, isPrimary: true } } } as unknown as DataAccessContext;
}

const visit = { id: encounterId, encounterNumber: 'V-1', encounterType: 'ambulatory', status: 'in_progress',
  startedAt: new Date('2026-11-18T08:00:00Z'), endedAt: null, chiefComplaint: 'Fictional cough',
  importedPaperRecords: false };
const problem = { id: diagnosisId, encounterId, codeSystem: 'ICD-10', code: 'B50.9', display: 'Fictional malaria',
  clinicalStatus: 'active', verificationStatus: 'confirmed', onsetAt: null, notes: null,
  createdAt: new Date('2026-11-18T08:10:00Z') };
const medication = { id: prescriptionId, encounterId, medicationCodeSystem: null, medicationCode: null,
  medicationDisplay: 'Fictional tablet 500 mg', doseQuantity: '1', doseUnit: 'tablet', routeCode: 'oral',
  frequency: 'twice a day', instructions: 'after food', startsOn: new Date(2026, 10, 18), endsOn: null,
  status: 'active', createdAt: new Date('2026-11-18T08:20:00Z') };
const labRequest = { id: labRequestId, encounterId, testCodeSystem: 'HID-LAB', testCode: 'MP-SMEAR',
  testDisplay: 'Malaria smear', priority: 'routine', status: 'active', specimenTypeCode: null,
  clinicalInformation: null, createdAt: new Date('2026-11-18T08:30:00Z') };
const allergyRow = { id: allergyId, substance: 'Fictional penicillin', reaction: 'rash', severity: 'severe',
  facilityId, createdAt: new Date('2026-11-01T08:00:00Z') };
const vitalRow = { measure: 'pulseBpm', value: 76, recordedAt: new Date('2026-11-18T08:05:00Z'), vitalId,
  encounterId, corrected: false };

function result(id: string, recordedAt: string) {
  return { id, version: '1:' + id, title: 'Malaria smear', recordedAt, effectiveAt: null, fields: { test: 'Malaria smear' } };
}

interface Setup {
  authorization?: { allowed: boolean; breakGlass?: boolean };
  rows?: Partial<Record<'visits' | 'problems' | 'medications' | 'labRequests', unknown[]>>;
  profile?: () => Promise<Record<string, unknown>>;
  results?: (cursor?: string) => Promise<{ records: unknown[]; nextCursor: string | null }>;
  pharmacy?: (items: readonly { id: string }[]) => Map<string, PharmacyOwnProgress>;
  lab?: (items: readonly { id: string }[]) => Map<string, LabOwnProgress>;
}

function setup(options: Setup = {}) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const rows = options.rows ?? {};
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    if (sql === RECENT_VISITS_SQL || sql === EMERGENCY_VISITS_SQL) return { rows: rows.visits ?? [visit] };
    if (sql === ACTIVE_PROBLEMS_SQL) return { rows: rows.problems ?? [problem] };
    if (sql === CURRENT_MEDICATIONS_SQL) return { rows: rows.medications ?? [medication] };
    if (sql === OPEN_LAB_REQUESTS_SQL) return { rows: rows.labRequests ?? [labRequest] };
    if (sql === LATEST_VITALS_SQL) return { rows: [vitalRow] };
    if (sql.includes('from ehr.recorded_allergies')) return { rows: [allergyRow] };
    if (sql.includes('from ehr.patient_reported_health_profiles')) return { rows: [] };
    throw new Error('unexpected query');
  }) } as unknown as PoolClient;
  const database = { withTransaction: jest.fn(async (_context: unknown, operation: (c: PoolClient) => unknown) =>
    operation(client)) };
  const audit = { record: jest.fn(async () => undefined), recordWithClient: jest.fn(async () => undefined) };
  const identity = {
    authorize: jest.fn(async () => ({ breakGlass: false, ...(options.authorization ?? { allowed: true }) })),
    staffPatientProfile: jest.fn(options.profile ?? (async () => ({ patientId, version: 3, fullName: 'Ada Fictional',
      firstName: 'Ada', lastName: 'Fictional', dateOfBirth: '1990-01-01', gender: 'female' }))),
  };
  const lab = { staffReleasedResults: jest.fn(async (_context: unknown, _patient: string, cursor?: string) =>
    (options.results ?? (async () => ({ records: [result('123e4567-e89b-42d3-a456-426614174201',
      '2026-11-18T10:00:00Z')], nextCursor: null })))(cursor)) };
  const progress = {
    pharmacy: jest.fn(async (_context: unknown, _patient: string, items: readonly { id: string }[]) =>
      (options.pharmacy ?? ((list) => new Map(list.map((item) => [item.id, { status: 'dispensed',
        receivedAt: '2026-11-18T09:00:00Z', acceptedAt: '2026-11-18T09:02:00Z', dispensedAt: '2026-11-18T09:05:00Z',
        reversedAt: null }]))))(items)),
    lab: jest.fn(async (_context: unknown, _patient: string, items: readonly { id: string }[]) =>
      (options.lab ?? ((list) => new Map(list.map((item) => [item.id, { status: 'received',
        receivedAt: '2026-11-18T09:00:00Z', collectedAt: null, lastResultAt: null }]))))(items)),
  };
  const repository = new ClinicalRepository(database as never, audit as never, identity as never);
  const service = new ChartSummaryService(repository, identity as never, lab as never, progress as never);
  return { service, queries, database, audit, identity, lab, progress };
}

const leftOutSections = (answer: { leftOut: { section: string }[] }) => answer.leftOut.map((item) => item.section);

describe('EHR-C4 GET ehr/patients/:patientId/chart-summary: the route', () => {
  it('is a GET on the patient, open to anyone who may read at least one EHR section', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ChartSummaryController)).toBe('ehr/patients/:patientId');
    const handler = ChartSummaryController.prototype.read;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('chart-summary');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toBeUndefined();
    expect(Reflect.getMetadata(ANY_PERMISSIONS, handler)).toEqual(['ehr.encounter.read', 'ehr.diagnosis.read',
      'ehr.prescription.read', 'ehr.lab-request.read', 'ehr.vital.read', 'ehr.note.read']);
  });

  it('leaves the success audit row to the service, so a read writes one EHR success row', () => {
    expect(Reflect.getMetadata(AUDIT_FAILURES_ONLY, ChartSummaryController)).toBe(true);
    expect(Reflect.getMetadata(AUDIT_FAILURES_ONLY, PatientRecordsController)).toBe(true);
  });

  it('gates each section with the permission its own route already needs (no new permission)', () => {
    const own = (handler: unknown) => (Reflect.getMetadata(REQUIRED_PERMISSIONS, handler as object) as string[])[0];
    expect(CHART_SECTION_PERMISSIONS).toEqual({
      demographics: STAFF_SOURCE_PERMISSIONS.profile[0],
      problems: own(DiagnosesController.prototype.list),
      medications: own(PrescriptionsController.prototype.list),
      allergies: own(AllergiesController.prototype.list),
      latestVitals: own(PatientVitalsController.prototype.latest),
      recentVisits: own(EncountersController.prototype.list),
      openLabRequests: own(LabRequestsController.prototype.list),
      recentResults: STAFF_SOURCE_PERMISSIONS.lab_result[0],
    });
    // The emergency read's own permissions are the ones the emergency summary needs.
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, PatientRecordsController.prototype.emergency))
      .toEqual(['ehr.encounter.read', 'ehr.note.read']);
  });

  it('takes direct care or emergency, and refuses any other purpose as the per-section routes do', async () => {
    const read = jest.fn(async () => ({}));
    const controller = new ChartSummaryController({ read } as never);
    const request = (purpose?: string) => ({ actor: contextFor(ROLES.doctor!).actor, facilityId,
      correlationId: 'correlation-chart-1', header: (name: string) => (name === 'x-purpose-of-use' ? purpose : undefined),
    }) as unknown as HidRequest;
    await controller.read(request('direct-care'), patientId);
    await controller.read(request('emergency'), patientId);
    expect(read.mock.calls.map((call) => (call as unknown[])[0] as DataAccessContext).map((c) => c.purposeOfUse))
      .toEqual(['direct-care', 'emergency']);
    for (const purpose of ['healthcare-operations', undefined]) {
      expect(() => controller.read(request(purpose), patientId)).toThrow(expect.objectContaining({
        code: 'PURPOSE_OF_USE_REQUIRED' }));
    }
  });
});

describe('EHR-C4 chart summary: sections by permission', () => {
  it('gives a doctor every section, with ownProgress, and audits one row with counts only', async () => {
    const { service, audit, identity, lab, progress } = setup();
    const answer = await service.read(contextFor(ROLES.doctor!), patientId);
    expect(Object.keys(answer.sections).sort()).toEqual([...CHART_SECTIONS].sort());
    expect(answer.leftOut).toEqual([]);
    expect(answer).toMatchObject({ patientId, facilityId, purposeOfUse: 'direct-care', limits: CHART_LIMITS });
    expect(answer.sections.demographics).toEqual({ patientId, fullName: 'Ada Fictional', firstName: 'Ada',
      lastName: 'Fictional', dateOfBirth: '1990-01-01', gender: 'female' });
    // ORD-4: the medication's ownProgress carries acceptedAt as the progress read gave it.
    expect(answer.sections.medications).toEqual({ more: false, items: [{ ...medication, startsOn: '2026-11-18',
      endsOn: null, ownProgress: { status: 'dispensed', receivedAt: '2026-11-18T09:00:00Z',
        acceptedAt: '2026-11-18T09:02:00Z', dispensedAt: '2026-11-18T09:05:00Z', reversedAt: null } }] });
    expect(answer.sections.openLabRequests?.items[0]).toEqual({ ...labRequest,
      ownProgress: expect.objectContaining({ status: 'received' }) });
    expect(answer.sections.problems).toEqual({ items: [problem], more: false });
    expect(answer.sections.recentVisits).toEqual({ items: [visit], more: false });
    expect(answer.sections.latestVitals).toEqual({ facilityId, measures: { pulseBpm: { value: 76,
      recordedAt: vitalRow.recordedAt, vitalId, encounterId, corrected: false } } });
    expect(answer.sections.allergies?.recorded).toEqual([expect.objectContaining({ id: allergyId, recordedHere: true })]);
    expect(answer.sections.recentResults).toEqual({ items: [expect.objectContaining({ title: 'Malaria smear' })],
      more: false, complete: true });
    expect(identity.authorize).toHaveBeenCalledTimes(1);
    expect(identity.authorize).toHaveBeenCalledWith(patientId, 'read_records', 'direct-care', expect.anything());
    expect(identity.staffPatientProfile).toHaveBeenCalledWith(patientId, expect.anything());
    expect(lab.staffReleasedResults).toHaveBeenCalledTimes(1);
    expect(progress.pharmacy).toHaveBeenCalledWith(expect.anything(), patientId, [expect.objectContaining({ id: prescriptionId })]);
    expect(progress.lab).toHaveBeenCalledWith(expect.anything(), patientId, [expect.objectContaining({ id: labRequestId })]);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    const row = (audit.recordWithClient.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(row).toMatchObject({ action: 'ehr.chart-summary.read', resourceType: 'chart-summary', resourceId: patientId,
      outcome: 'success', patientId, purposeOfUse: 'direct-care' });
    expect(row.details).toEqual({ sections: ['demographics', 'problems', 'medications', 'allergies', 'latestVitals',
      'recentVisits', 'openLabRequests', 'recentResults'], counts: { recentVisits: 1, allergies: 1, problems: 1,
      medications: 1, latestVitals: 1, openLabRequests: 1 } });
    // Counts only: no clinical words, names or identifiers other than the patient's UUID column.
    expect(JSON.stringify(row)).not.toMatch(/Fictional|Malaria|penicillin|Ada/);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('gives a nurse the same sections as a doctor', async () => {
    const { service } = setup();
    const answer = await service.read(contextFor(ROLES.nurse!), patientId);
    expect(Object.keys(answer.sections).sort()).toEqual([...CHART_SECTIONS].sort());
    expect(answer.leftOut).toEqual([]);
  });

  it.each([
    ['receptionist', ['demographics', 'recentVisits']],
    ['lab', ['recentVisits', 'openLabRequests', 'recentResults']],
    ['pharmacist', ['medications', 'recentVisits']],
  ])('gives a %s only the sections its permissions allow and lists the rest as permission', async (role, shown) => {
    const { service, queries, identity, lab, progress } = setup();
    const answer = await service.read(contextFor(ROLES[role]!), patientId);
    expect(Object.keys(answer.sections).sort()).toEqual([...shown].sort());
    const hidden = CHART_SECTIONS.filter((section) => !shown.includes(section));
    expect(answer.leftOut).toEqual(hidden.map((section) => ({ section, reason: 'permission',
      message: LEFT_OUT_MESSAGES.permission })));
    // A section left out is never read: not in the database, not from another service.
    const read = queries.map((query) => query.sql);
    expect(read.includes(ACTIVE_PROBLEMS_SQL)).toBe(shown.includes('problems'));
    expect(read.includes(CURRENT_MEDICATIONS_SQL)).toBe(shown.includes('medications'));
    expect(read.includes(OPEN_LAB_REQUESTS_SQL)).toBe(shown.includes('openLabRequests'));
    expect(read.includes(LATEST_VITALS_SQL)).toBe(false);
    expect(read.some((sql) => sql.includes('recorded_allergies'))).toBe(false);
    expect(identity.staffPatientProfile).toHaveBeenCalledTimes(shown.includes('demographics') ? 1 : 0);
    expect(lab.staffReleasedResults).toHaveBeenCalledTimes(shown.includes('recentResults') ? 1 : 0);
    expect(progress.pharmacy).toHaveBeenCalledTimes(shown.includes('medications') ? 1 : 0);
    expect(progress.lab).toHaveBeenCalledTimes(shown.includes('openLabRequests') ? 1 : 0);
  });
});

describe('EHR-C4 chart summary: consent', () => {
  it('answers 403 CONSENT_REQUIRED without consent, audited as denied like its siblings, and reads nothing', async () => {
    const { service, database, audit, identity, lab, progress } = setup({ authorization: { allowed: false } });
    await expect(service.read(contextFor(ROLES.doctor!), patientId)).rejects.toMatchObject({ status: 403,
      code: 'CONSENT_REQUIRED' });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'ehr.chart-summary.read',
      resourceType: 'chart-summary', outcome: 'denied', patientId, facilityId, purposeOfUse: 'direct-care',
      details: expect.objectContaining({ reason: 'identity_authorization' }) }));
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(identity.staffPatientProfile).not.toHaveBeenCalled();
    expect(lab.staffReleasedResults).not.toHaveBeenCalled();
    expect(progress.pharmacy).not.toHaveBeenCalled();
    expect(progress.lab).not.toHaveBeenCalled();
  });
});

describe('EHR-C4 chart summary: other services down', () => {
  it('still answers when the laboratory is down: results unavailable, lab requests without progress', async () => {
    const { service } = setup({
      results: async () => { throw new DomainProblem(503, 'LAB_SERVICE_UNAVAILABLE', 'Lab service is unavailable'); },
      lab: (items) => new Map(items.map((item) => [item.id, LAB_PROGRESS_UNKNOWN])),
    });
    const answer = await service.read(contextFor(ROLES.doctor!), patientId);
    expect(answer.sections.recentResults).toBeUndefined();
    expect(answer.sections.openLabRequests?.items[0]?.ownProgress).toEqual(LAB_PROGRESS_UNKNOWN);
    expect(answer.leftOut).toEqual([
      { section: 'openLabRequests.ownProgress', reason: 'unavailable', message: LEFT_OUT_MESSAGES.labProgress },
      { section: 'recentResults', reason: 'unavailable', message: LEFT_OUT_MESSAGES.unavailable },
    ]);
    for (const section of ['demographics', 'problems', 'medications', 'allergies', 'latestVitals', 'recentVisits']) {
      expect(answer.sections).toHaveProperty(section);
    }
  });

  it('marks pharmacy progress unavailable and keeps the medicines when the pharmacy is down', async () => {
    const { service } = setup({ pharmacy: (items) => new Map(items.map((item) => [item.id, PHARMACY_PROGRESS_UNKNOWN])) });
    const answer = await service.read(contextFor(ROLES.doctor!), patientId);
    expect(answer.sections.medications?.items).toHaveLength(1);
    expect(answer.leftOut).toEqual([{ section: 'medications.ownProgress', reason: 'unavailable',
      message: LEFT_OUT_MESSAGES.pharmacyProgress }]);
  });

  it('leaves the patient card out as unavailable when Identity cannot be reached, and as permission when it refuses', async () => {
    const down = setup({ profile: async () => { throw new DomainProblem(503, 'IDENTITY_SERVICE_UNAVAILABLE', 'down'); } });
    expect((await down.service.read(contextFor(ROLES.doctor!), patientId)).leftOut).toEqual([
      { section: 'demographics', reason: 'unavailable', message: LEFT_OUT_MESSAGES.unavailable }]);
    const refused = setup({ profile: async () => { throw new DomainProblem(403, 'Forbidden', 'refused'); } });
    expect((await refused.service.read(contextFor(ROLES.doctor!), patientId)).leftOut).toEqual([
      { section: 'demographics', reason: 'permission', message: LEFT_OUT_MESSAGES.permission }]);
    const other = setup({ profile: async () => ({ patientId: encounterId, version: 1 }) });
    expect(leftOutSections(await other.service.read(contextFor(ROLES.doctor!), patientId))).toEqual(['demographics']);
  });

  it('answers results Lab refuses (403) as permission', async () => {
    const { service } = setup({ results: async () => { throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'no'); } });
    expect((await service.read(contextFor(ROLES.doctor!), patientId)).leftOut).toEqual([
      { section: 'recentResults', reason: 'permission', message: LEFT_OUT_MESSAGES.permission }]);
  });
});

describe('EHR-C4 chart summary: break-glass (emergency)', () => {
  it('shows what the emergency read shows (allergies, completed visits) under a break-glass grant, nothing else', async () => {
    const { service, queries, audit, identity, lab, progress } = setup({ authorization: { allowed: true, breakGlass: true } });
    const answer = await service.read(contextFor(ROLES.doctor!, 'emergency'), patientId);
    expect(answer.purposeOfUse).toBe('emergency');
    expect(Object.keys(answer.sections).sort()).toEqual(['allergies', 'recentVisits']);
    expect(answer.leftOut).toEqual(['demographics', 'problems', 'medications', 'latestVitals', 'openLabRequests',
      'recentResults'].map((section) => ({ section, reason: 'permission', message: LEFT_OUT_MESSAGES.emergency })));
    expect(identity.authorize).toHaveBeenCalledWith(patientId, 'read_records', 'emergency', expect.anything());
    expect(queries.map((query) => query.sql)).toContain(EMERGENCY_VISITS_SQL);
    expect(queries.map((query) => query.sql)).not.toContain(RECENT_VISITS_SQL);
    expect(identity.staffPatientProfile).not.toHaveBeenCalled();
    expect(lab.staffReleasedResults).not.toHaveBeenCalled();
    expect(progress.pharmacy).not.toHaveBeenCalled();
    expect(progress.lab).not.toHaveBeenCalled();
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ehr.chart-summary.read', outcome: 'success', purposeOfUse: 'emergency' }));
  });

  it('refuses emergency purpose without a break-glass grant (403 CONSENT_REQUIRED, audited), as the emergency read does', async () => {
    const { service, audit, database } = setup({ authorization: { allowed: true, breakGlass: false } });
    await expect(service.read(contextFor(ROLES.doctor!, 'emergency'), patientId)).rejects.toMatchObject({
      status: 403, code: 'CONSENT_REQUIRED' });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'ehr.chart-summary.read',
      outcome: 'denied', purposeOfUse: 'emergency' }));
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it('refuses emergency purpose without both of the emergency read permissions, before asking Identity', async () => {
    const { service, identity } = setup({ authorization: { allowed: true, breakGlass: true } });
    await expect(service.read(contextFor(ROLES.pharmacist!, 'emergency'), patientId)).rejects.toMatchObject({
      status: 403, code: 'PERMISSION_DENIED' });
    expect(identity.authorize).not.toHaveBeenCalled();
  });

  it('keeps the emergency visit columns to the emergency read\'s own', () => {
    expect(EMERGENCY_VISITS_SQL).toContain("status = 'completed'");
    expect(EMERGENCY_VISITS_SQL).not.toContain('chief_complaint');
    expect(EMERGENCY_VISITS_SQL).toContain('facility_id = $2');
  });
});

describe('EHR-C4 chart summary: entered in error and bounded sizes', () => {
  const squash = (sql: string) => sql.replace(/\s+/g, ' ');
  const notInErrorVisit = (alias: string) => `not exists (select 1 from ehr.encounters e where e.id = ${alias}.encounter_id `
    + `and e.patient_id = ${alias}.patient_id and e.facility_id = ${alias}.facility_id and e.status = 'entered_in_error')`;

  it('leaves out anything entered in error, and anything recorded in a visit entered in error', () => {
    expect(squash(RECENT_VISITS_SQL)).toContain("status <> 'entered_in_error'");
    expect(squash(ACTIVE_PROBLEMS_SQL)).toContain("d.verification_status not in ('refuted', 'entered_in_error')");
    expect(squash(ACTIVE_PROBLEMS_SQL)).toContain("d.clinical_status in ('active', 'recurrence', 'relapse')");
    expect(squash(ACTIVE_PROBLEMS_SQL)).toContain(notInErrorVisit('d'));
    expect(squash(CURRENT_MEDICATIONS_SQL)).toContain("p.status in ('active', 'on_hold')");
    expect(squash(CURRENT_MEDICATIONS_SQL)).toContain(notInErrorVisit('p'));
    expect(squash(OPEN_LAB_REQUESTS_SQL)).toContain("l.status in ('active', 'on_hold')");
    expect(squash(OPEN_LAB_REQUESTS_SQL)).toContain(notInErrorVisit('l'));
    expect(squash(LATEST_VITALS_SQL)).toContain("e.status <> 'entered_in_error'");
    for (const sql of [RECENT_VISITS_SQL, ACTIVE_PROBLEMS_SQL, CURRENT_MEDICATIONS_SQL, OPEN_LAB_REQUESTS_SQL]) {
      expect(squash(sql)).toMatch(/patient_id = \$1 and (\w\.)?facility_id = \$2/);
    }
  });

  it('reads only active recorded allergies (an allergy entered in error is left out)', async () => {
    const { service, queries } = setup();
    await service.read(contextFor(ROLES.doctor!), patientId);
    const allergies = queries.find((query) => query.sql.includes('from ehr.recorded_allergies'))!;
    expect(squash(allergies.sql)).toContain("status = 'active'");
    expect(allergies.values).toEqual([patientId]);
  });

  it('asks for one row more than each limit and says when there are more', async () => {
    const many = (row: Record<string, unknown>, count: number) => Array.from({ length: count }, (_, index) => ({ ...row,
      id: `123e4567-e89b-42d3-a456-${String(426614175000 + index)}` }));
    const { service, queries } = setup({ rows: { visits: many(visit, CHART_LIMITS.recentVisits + 1),
      problems: many(problem, 3) } });
    const answer = await service.read(contextFor(ROLES.doctor!), patientId);
    expect(answer.sections.recentVisits?.items).toHaveLength(CHART_LIMITS.recentVisits);
    expect(answer.sections.recentVisits?.more).toBe(true);
    expect(answer.sections.problems).toMatchObject({ more: false });
    const limits = Object.fromEntries(queries.filter((query) => query.values.length === 3)
      .map((query) => [query.sql, query.values]));
    expect(limits[RECENT_VISITS_SQL]).toEqual([patientId, facilityId, CHART_LIMITS.recentVisits + 1]);
    expect(limits[ACTIVE_PROBLEMS_SQL]).toEqual([patientId, facilityId, CHART_LIMITS.problems + 1]);
    expect(limits[CURRENT_MEDICATIONS_SQL]).toEqual([patientId, facilityId, CHART_LIMITS.medications + 1]);
    expect(limits[OPEN_LAB_REQUESTS_SQL]).toEqual([patientId, facilityId, CHART_LIMITS.openLabRequests + 1]);
    expect(CHART_LIMITS).toEqual({ recentVisits: 10, problems: 50, medications: 50, openLabRequests: 50,
      allergies: 200, recentResults: 10 });
  });

  it('answers the 10 newest released results, reading at most a few pages from Lab', async () => {
    const pageOf = (start: number) => Array.from({ length: 200 }, (_, index) => result(
      `123e4567-e89b-42d3-a456-${String(426614180000 + start + index)}`,
      new Date(Date.UTC(2026, 0, 1) + (start + index) * 60_000).toISOString()));
    let calls = 0;
    const { service, lab } = setup({ results: async () => {
      calls += 1;
      return { records: pageOf((calls - 1) * 200), nextCursor: '123e4567-e89b-42d3-a456-426614179999' };
    } });
    const answer = await service.read(contextFor(ROLES.doctor!), patientId);
    // A cursor Lab repeats ends the reading (as the staff chat's reader does).
    expect(lab.staffReleasedResults).toHaveBeenCalledTimes(2);
    expect(answer.sections.recentResults?.complete).toBe(false);

    calls = 0;
    const paged = setup({ results: async () => {
      calls += 1;
      return { records: pageOf((calls - 1) * 200), nextCursor: `123e4567-e89b-42d3-a456-42661417${String(9000 + calls)}` };
    } });
    const many = await paged.service.read(contextFor(ROLES.doctor!), patientId);
    expect(paged.lab.staffReleasedResults).toHaveBeenCalledTimes(RESULT_PAGE_LIMIT);
    const items = many.sections.recentResults!.items;
    expect(items).toHaveLength(CHART_LIMITS.recentResults);
    expect(items.map((item) => item.recordedAt)).toEqual([...items.map((item) => item.recordedAt)].sort().reverse());
    expect(items[0]!.recordedAt).toBe(new Date(Date.UTC(2026, 0, 1) + (RESULT_PAGE_LIMIT * 200 - 1) * 60_000).toISOString());
    expect(many.sections.recentResults).toMatchObject({ more: true, complete: false });
  });

  it('writes every left-out message in plain words', () => {
    for (const message of Object.values(LEFT_OUT_MESSAGES)) {
      expect(message).toMatch(/^[A-Z][^_{}]+\.$/);
      expect(message.toLowerCase()).not.toContain('unverified');
    }
  });
});
