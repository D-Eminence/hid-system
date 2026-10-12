import type { PoolClient } from 'pg';
import type { AuditService } from '../../audit/audit.service';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import type { IdentityApiService } from '../../integrations/identity-api.service';
import { ClinicalRepository, type OperationResult } from '../shared/clinical.repository';
import { PatientRecordsService } from './patient-records.service';

const actor = { kind: 'patient', patientId: 'patient-id', accountId: 'account-id', subject: 'subject', sessionId: 'session-id' };
const request = { actor, correlationId: 'patient-record-test', header: () => undefined } as unknown as HidRequest;
/** Every read permission the summary's categories need: the route's two, and each optional category's own. */
const EMERGENCY_READS = ['ehr.encounter.read', 'ehr.note.read', 'ehr.vital.read', 'ehr.diagnosis.read',
  'ehr.prescription.read', 'ehr.lab-request.read', 'ehr.document.read'];
function emergencyContextWith(permissions?: readonly string[]): DataAccessContext {
  return { purposeOfUse: 'emergency', facilityId: 'facility',
    actor: { subject: 'doctor', accountId: 'account', ...(permissions ? { permissions } : {}) } } as unknown as DataAccessContext;
}
const emergencyContext = emergencyContextWith(EMERGENCY_READS);

const WITHHELD = ['vitals', 'diagnoses', 'prescriptions', 'labRequests', 'documents'];
const SECTIONS = ['encounters', 'notes', 'vitals', 'diagnoses', 'prescriptions', 'labRequests', 'documents'] as const;
type Section = typeof SECTIONS[number];
/** The summary as the API serializes it; the specs read it loosely so they compile against any shape. */
type Summary = Record<string, unknown> & Partial<Record<Section, unknown[]>>;

/** Rows a fake client returns for the statement reading each section. */
type Fixture = Partial<Record<Section, unknown[]>>;
const SECTION_SOURCES: ReadonlyArray<readonly [Section, RegExp]> = [
  ['encounters', /from ehr\.encounters/],
  ['notes', /from ehr\.clinical_notes/],
  ['vitals', /from ehr\.vitals/],
  ['diagnoses', /from ehr\.diagnoses/],
  ['prescriptions', /from ehr\.prescriptions/],
  ['labRequests', /from ehr\.lab_requests/],
  ['documents', /from ehr\.documents/],
];
function sectionOf(sql: string): Section | undefined {
  return SECTION_SOURCES.find(([, source]) => source.test(sql))?.[0];
}
function rows(count: number, extra: (index: number) => Record<string, unknown> = () => ({})) {
  return Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, ...extra(index) }));
}

function setup(fixture: Fixture = {}) {
  const authorization = { ...actor, expiresAt: new Date(Date.now() + 30_000).toISOString(), allowed: true };
  const authorizeSelf = jest.fn().mockResolvedValue(authorization);
  const query = jest.fn(async (sql: string) => {
    const section = sectionOf(sql);
    return { rows: section ? [...(fixture[section] ?? [])] : [] };
  });
  const client = { query } as unknown as PoolClient;
  const transaction = jest.fn(async (_auth: unknown, _correlation: string, work: (c: PoolClient) => Promise<unknown>) =>
    work(client));
  const recordWithClient = jest.fn().mockResolvedValue(undefined);
  // The repository runs the operation on the fake client and returns its value, as ClinicalRepository.run does
  // after authorization; `operations` keeps each operation's result (value and audit details).
  const operations: Array<OperationResult<unknown>> = [];
  const run = jest.fn(async (_context: unknown, _patientId: unknown, _access: unknown, _event: unknown,
    operation: (c: PoolClient) => Promise<OperationResult<unknown>>) => {
    const result = await operation(client);
    operations.push(result);
    return result.value;
  });
  const service = new PatientRecordsService({ withPatientTransaction: transaction } as unknown as DatabaseService,
    { authorizeSelf } as unknown as IdentityApiService, { recordWithClient } as unknown as AuditService,
    { run } as unknown as ClinicalRepository);
  return { service, transaction, authorizeSelf, recordWithClient, query, run, operations };
}

function sqlFor(query: jest.Mock, section: Section): string {
  const call = query.mock.calls.find(([sql]) => sectionOf(String(sql)) === section);
  if (!call) throw new Error(`no statement read ${section}`);
  return String(call[0]).replace(/\s+/g, ' ');
}

describe('Owning EHR patient and emergency read boundary', () => {
  it('reauthorizes self with Identity and constrains every SQL read to that canonical patient', async () => {
    const { service, authorizeSelf, query } = setup();
    await service.self(request);
    expect(authorizeSelf).toHaveBeenCalledWith(request);
    for (const [, params] of query.mock.calls as unknown as Array<[string, unknown[]]>) {
      expect(params).toEqual(['patient-id']);
    }
    expect(sqlFor(query, 'encounters')).toContain("status='completed'");
    expect(sqlFor(query, 'notes')).toContain("n.status in ('signed','amended')");
  });

  it('denies altered patient mapping before opening an EHR transaction', async () => {
    const { service, authorizeSelf, transaction } = setup();
    authorizeSelf.mockResolvedValue({ ...actor, patientId: 'other-patient' });
    await expect(service.self(request)).rejects.toThrow('Patient authorization changed');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('fails closed before PHI serialization on Identity or durable audit failure', async () => {
    const { service, recordWithClient } = setup();
    recordWithClient.mockRejectedValue(new Error('audit failed'));
    await expect(service.self(request)).rejects.toThrow('audit failed');
  });

  it('requires a current break-glass authorization through the existing clinical repository', async () => {
    const { service, run } = setup();
    await service.emergency('patient-id', emergencyContext);
    expect(run).toHaveBeenCalledWith(emergencyContext, 'patient-id', 'read_records',
      expect.objectContaining({ breakGlassOnly: true }), expect.any(Function));
  });
});

describe('Patient self records: release honesty', () => {
  it('reads only the released categories and reports the withheld ones as withheld, not as absent', async () => {
    const { service, query } = setup({ encounters: rows(2), notes: rows(1) });
    const summary = await service.self(request) as unknown as Summary;
    // Only completed encounters and current signed/amended notes are released
    // (INTERFACE_CONTRACT.md, migration 0030); nothing else is read for the patient.
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(([sql]) => sectionOf(String(sql)))).toEqual(['encounters', 'notes']);
    expect(summary.released).toEqual(['encounters', 'notes']);
    expect(summary.withheld).toEqual(WITHHELD);
    expect(summary.encounters).toHaveLength(2);
    expect(summary.notes).toHaveLength(1);
    // The withheld arrays stay in the response, always empty, for existing clients.
    for (const section of WITHHELD) expect(summary[section]).toEqual([]);
  });

  it('audits the released counts and the withheld categories, without counts for categories it never read', async () => {
    const { service, recordWithClient } = setup({ encounters: rows(3), notes: rows(2) });
    await service.self(request);
    expect(recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorType: 'patient', outcome: 'success', action: 'ehr.patient.self.records.read',
      details: { encounterCount: 3, noteCount: 2, withheldCategories: WITHHELD },
    }));
  });

  it('reports the real per-section limits and whether each released section was truncated', async () => {
    const { service, query } = setup({ encounters: rows(51), notes: rows(50) });
    const summary = await service.self(request) as unknown as Summary;
    expect(sqlFor(query, 'encounters')).toMatch(/ limit 51$/);
    expect(sqlFor(query, 'notes')).toMatch(/ limit 51$/);
    expect(summary.encounters).toHaveLength(50);
    expect(summary.encounters?.[49]).toEqual({ id: 'row-49' });
    expect(summary.notes).toHaveLength(50);
    expect(summary.limits).toEqual({ encounters: 50, notes: 50 });
    expect(summary.truncated).toEqual({ encounters: true, notes: false });
    // The single limit is the smallest section cap, which is what the summary shows of encounters and notes.
    expect(summary.limit).toBe(50);
  });
});

describe('Emergency record summary', () => {
  it('reads every section for the patient at the active facility, each with its own limit and truncation flag', async () => {
    const { service, query } = setup({ encounters: rows(50), notes: rows(51), vitals: rows(101), documents: rows(100) });
    const summary = await service.emergency('patient-id', emergencyContext) as unknown as Summary;
    expect(query).toHaveBeenCalledTimes(7);
    for (const [, params] of query.mock.calls as unknown as Array<[string, unknown[]]>) {
      expect(params).toEqual(['patient-id', 'facility']);
    }
    for (const section of ['encounters', 'notes'] as const) expect(sqlFor(query, section)).toMatch(/ limit 51$/);
    for (const section of ['vitals', 'diagnoses', 'prescriptions', 'labRequests', 'documents'] as const) {
      expect(sqlFor(query, section)).toMatch(/ limit 101$/);
    }
    expect(summary.limits).toEqual({ encounters: 50, notes: 50, vitals: 100, diagnoses: 100, prescriptions: 100,
      labRequests: 100, documents: 100 });
    expect(summary.truncated).toEqual({ encounters: false, notes: true, vitals: true, diagnoses: false,
      prescriptions: false, labRequests: false, documents: false });
    expect(summary.notes).toHaveLength(50);
    expect(summary.vitals).toHaveLength(100);
    expect(summary.documents).toHaveLength(100);
    expect(summary.limit).toBe(50);
  });

  it('returns vitals with the current correction applied, the recorded values apart, and fails closed', async () => {
    const { service, query } = setup();
    await service.emergency('patient-id', emergencyContext);
    const vitals = sqlFor(query, 'vitals');
    // The current correction (correction_no = current_correction_no) is joined at the same patient and facility.
    expect(vitals).toContain('left join ehr.vital_corrections c on c.vital_id=v.id and c.patient_id=v.patient_id'
      + ' and c.facility_id=v.facility_id and c.correction_no=v.current_correction_no and v.current_correction_no>0');
    // Its replacement set is the whole current set: an omitted measurement is null, never the recorded value.
    expect(vitals).toContain('case when v.current_correction_no=0 then v.systolic_mmhg'
      + " when c.id is not null then (c.replacement_values->>'systolic_mmhg')::smallint end as \"systolicMmhg\"");
    expect(vitals).toContain('case when v.current_correction_no=0 then v.temperature_c'
      + " when c.id is not null then (c.replacement_values->>'temperature_c')::numeric(4,1) end as \"temperatureC\"");
    expect(vitals).toContain('v.current_correction_no as "currentCorrectionNo"');
    expect(vitals).toContain('c.created_at as "correctedAt"');
    expect(vitals).toContain('(v.current_correction_no>0 and c.id is null) as "correctionUnavailable"');
    expect(vitals).toContain('case when v.current_correction_no>0 then jsonb_build_object(');
    expect(vitals).toContain('as "recordedValues"');
    expect(vitals).toContain('c.reason as "correctionReason"');
    expect(vitals).toContain('where v.patient_id=$1 and v.facility_id=$2 order by v.recorded_at desc,v.id desc limit 101');
    // No measurement is read from the recorded row once a vital has a correction.
    expect(vitals).not.toMatch(/(^|[ ,])v\.systolic_mmhg as "systolicMmhg"/);
  });

  it('lists only documents whose effective status is available, as the download rule requires', async () => {
    const { service, query } = setup();
    await service.emergency('patient-id', emergencyContext);
    const documents = sqlFor(query, 'documents');
    expect(documents).toContain('from ehr.documents_effective where patient_id=$1 and facility_id=$2'
      + " and status='available' order by created_at desc,id desc limit 101");
    expect(documents).toContain('scan_status as "scanStatus"');
    expect(documents).toContain('coalesce(detected_media_type,declared_media_type) as "mediaType"');
    expect(documents).not.toMatch(/from ehr\.documents /);
    expect(documents).not.toContain("status='uploaded'");
  });

  it('records the disclosed count of each category in the emergency audit, counts only', async () => {
    const { service, operations } = setup({
      encounters: rows(4), notes: rows(3),
      vitals: rows(5, (index) => ({ currentCorrectionNo: index < 2 ? index + 1 : 0 })),
      diagnoses: rows(2), prescriptions: rows(1), labRequests: rows(6), documents: rows(7),
    });
    await service.emergency('patient-id', emergencyContext);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.details).toEqual({
      encounterCount: 4, noteCount: 3, vitalCount: 5, correctedVitalCount: 2, diagnosisCount: 2,
      prescriptionCount: 1, labRequestCount: 6, documentCount: 7, withheldCategories: [],
    });
  });

  it('keeps returning all seven categories to a reader holding every read permission until the scope is decided', async () => {
    const { service } = setup({ diagnoses: rows(1), prescriptions: rows(1), labRequests: rows(1) });
    const summary = await service.emergency('patient-id', emergencyContext) as unknown as Summary;
    for (const section of SECTIONS) expect(Array.isArray(summary[section])).toBe(true);
    expect(summary.diagnoses).toHaveLength(1);
    expect(summary.prescriptions).toHaveLength(1);
    expect(summary.labRequests).toHaveLength(1);
    expect(summary.released).toEqual([...SECTIONS]);
    expect(summary.withheld).toEqual([]);
  });
});

describe('Emergency record summary: each category needs its own read permission', () => {
  // The read permission each category's own routes require (vitals, diagnoses, prescriptions,
  // lab-requests and document controllers); the summary route itself requires only encounter and note reads.
  const OPTIONAL: ReadonlyArray<readonly [Section, string, readonly string[]]> = [
    ['vitals', 'ehr.vital.read', ['vitalCount', 'correctedVitalCount']],
    ['diagnoses', 'ehr.diagnosis.read', ['diagnosisCount']],
    ['prescriptions', 'ehr.prescription.read', ['prescriptionCount']],
    ['labRequests', 'ehr.lab-request.read', ['labRequestCount']],
    ['documents', 'ehr.document.read', ['documentCount']],
  ];
  const everyRow: Fixture = { encounters: rows(2), notes: rows(1), vitals: rows(3, () => ({ currentCorrectionNo: 1 })),
    diagnoses: rows(4), prescriptions: rows(5), labRequests: rows(6), documents: rows(7) };

  it.each(OPTIONAL)('withholds %s from a reader without %s: not read, returned empty, named and audited as withheld',
    async (section, permission, countKeys) => {
      const { service, query, operations } = setup(everyRow);
      const context = emergencyContextWith(EMERGENCY_READS.filter((read) => read !== permission));
      const summary = await service.emergency('patient-id', context) as unknown as Summary;
      const read = query.mock.calls.map(([sql]) => sectionOf(String(sql)));
      expect(read).not.toContain(section);
      expect(read).toHaveLength(6);
      expect(summary[section]).toEqual([]);
      expect(summary.withheld).toEqual([section]);
      expect(summary.released).toEqual(SECTIONS.filter((name) => name !== section));
      expect(summary.limits).not.toHaveProperty(section);
      expect(summary.truncated).not.toHaveProperty(section);
      const details: Readonly<Record<string, unknown>> = operations[0]?.details ?? {};
      for (const key of countKeys) expect(details).not.toHaveProperty(key);
      expect(details.withheldCategories).toEqual([section]);
      // The categories it may read are still returned and counted.
      for (const [other] of OPTIONAL.filter(([name]) => name !== section)) {
        expect(summary[other]).toHaveLength(everyRow[other]?.length ?? -1);
      }
      expect(details.encounterCount).toBe(2);
    });

  it('returns only encounters and notes to a reader holding only the route permissions', async () => {
    const { service, query, operations } = setup(everyRow);
    const summary = await service.emergency('patient-id', emergencyContextWith(['ehr.encounter.read', 'ehr.note.read'])) as
      unknown as Summary;
    expect(query.mock.calls.map(([sql]) => sectionOf(String(sql)))).toEqual(['encounters', 'notes']);
    expect(summary.released).toEqual(['encounters', 'notes']);
    expect(summary.withheld).toEqual(WITHHELD);
    for (const section of WITHHELD) expect(summary[section]).toEqual([]);
    expect(summary.limits).toEqual({ encounters: 50, notes: 50 });
    expect(summary.truncated).toEqual({ encounters: false, notes: false });
    expect(summary.limit).toBe(50);
    expect(operations[0]?.details).toEqual({ encounterCount: 2, noteCount: 1, withheldCategories: WITHHELD });
  });

  it('fails closed, withholding every optional category, when the reader\'s permissions are not known', async () => {
    const { service, query } = setup(everyRow);
    const summary = await service.emergency('patient-id', emergencyContextWith()) as unknown as Summary;
    expect(query).toHaveBeenCalledTimes(2);
    expect(summary.withheld).toEqual(WITHHELD);
    for (const section of WITHHELD) expect(summary[section]).toEqual([]);
  });
});

describe('Emergency read grant revalidation', () => {
  it.each([{ allowed: false, breakGlass: false }, { allowed: true, breakGlass: false }])(
    'denies before EHR reads unless a current emergency grant is confirmed (%j)', async (decision) => {
      const withTransaction = jest.fn();
      const record = jest.fn().mockResolvedValue(undefined);
      const repository = new ClinicalRepository({ withTransaction } as unknown as DatabaseService,
        { record } as unknown as AuditService,
        { authorize: jest.fn().mockResolvedValue(decision) } as unknown as IdentityApiService);
      const context = { purposeOfUse: 'emergency', facilityId: 'facility', membershipId: 'membership',
        correlationId: 'emergency-revalidation-test', actor: { subject: 'doctor', accountId: 'account' } } as DataAccessContext;
      await expect(repository.run(context, 'patient-id', 'read_records', {
        action: 'ehr.emergency.records.read', resourceType: 'patient-record-summary', breakGlassOnly: true,
      }, jest.fn())).rejects.toThrow('Active consent and facility membership are required');
      expect(withTransaction).not.toHaveBeenCalled();
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', patientId: 'patient-id' }));
    },
  );

  it('records the operation details with the success audit in the read transaction', async () => {
    const client = {} as PoolClient;
    const recordWithClient = jest.fn().mockResolvedValue(undefined);
    const withTransaction = jest.fn(async (_context: unknown, work: (c: PoolClient) => Promise<unknown>) => work(client));
    const repository = new ClinicalRepository({ withTransaction } as unknown as DatabaseService,
      { record: jest.fn(), recordWithClient } as unknown as AuditService,
      { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: true }) } as unknown as IdentityApiService);
    const context = { purposeOfUse: 'emergency', facilityId: 'facility', membershipId: 'membership',
      correlationId: 'emergency-audit-details-test', actor: { subject: 'doctor', accountId: 'account' } } as DataAccessContext;
    await expect(repository.run(context, 'patient-id', 'read_records', {
      action: 'ehr.emergency.records.read', resourceType: 'patient-record-summary', breakGlassOnly: true,
    }, async () => ({ value: 'summary', details: { encounterCount: 1, vitalCount: 2 } }))).resolves.toBe('summary');
    expect(recordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
      action: 'ehr.emergency.records.read', outcome: 'success', purposeOfUse: 'emergency',
      details: { encounterCount: 1, vitalCount: 2 },
    }));
  });
});
