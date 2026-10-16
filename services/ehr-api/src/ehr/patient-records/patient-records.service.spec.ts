import type { PoolClient } from 'pg';
import type { AuditService } from '../../audit/audit.service';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import type { IdentityApiService } from '../../integrations/identity-api.service';
import { ClinicalRepository, type OperationResult } from '../shared/clinical.repository';
import type { StorageProvider } from '../../storage/storage.types';
import { PatientRecordRelease, type PatientReleasable } from './patient-release';
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
type Section = typeof SECTIONS[number] | 'labResults';
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
  ['labResults', /from ehr\.patient_released_lab_results/],
  ['documents', /from ehr\.documents/],
];
function sectionOf(sql: string): Section | undefined {
  return SECTION_SOURCES.find(([, source]) => source.test(sql))?.[0];
}
/** The statement that tells the database which categories this transaction releases (the release policies read it). */
const RELEASE_BINDING = /set_config\('app\.patient_release'/;
type QueryCall = [string, unknown[]];
/** The record reads: every statement except the release binding. */
function reads(query: jest.Mock): QueryCall[] {
  return (query.mock.calls as unknown as QueryCall[]).filter(([sql]) => !RELEASE_BINDING.test(String(sql)));
}
/** The values the release binding set, in order. */
function bindings(query: jest.Mock): unknown[] {
  return (query.mock.calls as unknown as QueryCall[]).filter(([sql]) => RELEASE_BINDING.test(String(sql)))
    .map(([, params]) => params);
}
function rows(count: number, extra: (index: number) => Record<string, unknown> = () => ({})) {
  return Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, ...extra(index) }));
}

/** The stored document a patient download reads, as the download SQL names its columns. */
const STORED_DOCUMENT = { id: '70000000-0000-4000-8000-000000000001', storageBucket: 'synthetic-bucket',
  storageKey: 'synthetic/lab-report.pdf', objectVersionId: 'object-version-1', sha256Hex: 'a'.repeat(64),
  sizeBytes: '2048', mediaType: 'application/pdf', fileName: 'Lab report (October).pdf' };

function setup(fixture: Fixture = {}, categories: readonly PatientReleasable[] = [],
  options: { download?: Record<string, unknown> | null } = {}) {
  const events: string[] = [];
  const authorization = { ...actor, expiresAt: new Date(Date.now() + 30_000).toISOString(), allowed: true };
  const authorizeSelf = jest.fn().mockResolvedValue(authorization);
  const query = jest.fn(async (sql: string) => {
    if (RELEASE_BINDING.test(sql)) {
      events.push('bind');
      return { rows: [] };
    }
    if (/ d\.id=\$1/.test(sql.replace(/\s+/g, ' '))) {
      events.push('read');
      return { rows: options.download === null ? [] : [options.download ?? STORED_DOCUMENT] };
    }
    const section = sectionOf(sql);
    return { rows: section ? [...(fixture[section] ?? [])] : [] };
  });
  const client = { query } as unknown as PoolClient;
  const transaction = jest.fn(async (_auth: unknown, _correlation: string, work: (c: PoolClient) => Promise<unknown>) => {
    const result = await work(client);
    events.push('commit');
    return result;
  });
  const recordWithClient = jest.fn(async () => { events.push('audit'); });
  const storage = {
    bucket: jest.fn(() => 'synthetic-bucket'),
    inspectVersion: jest.fn(async () => {
      events.push('inspect');
      return { versionId: 'object-version-1', sizeBytes: 2048, mediaType: 'application/pdf', sha256Hex: 'a'.repeat(64) };
    }),
    createDownload: jest.fn(async () => {
      events.push('sign');
      return { url: 'https://signed.example.invalid/object', expiresInSeconds: 60 };
    }),
  };
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
    { run } as unknown as ClinicalRepository, new PatientRecordRelease(categories),
    storage as unknown as StorageProvider);
  return { service, transaction, authorizeSelf, recordWithClient, query, run, operations, storage, events };
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
    for (const [, params] of reads(query)) {
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
    // (INTERFACE_CONTRACT.md, migration 0030); nothing else is read for the patient,
    // and the database is told that no further category is released.
    expect(query).toHaveBeenCalledTimes(3);
    expect(bindings(query)).toEqual([['']]);
    expect(reads(query).map(([sql]) => sectionOf(String(sql)))).toEqual(['encounters', 'notes']);
    expect(summary.released).toEqual(['encounters', 'notes']);
    expect(summary.withheld).toEqual(WITHHELD);
    expect(summary.encounters).toHaveLength(2);
    expect(summary.notes).toHaveLength(1);
    // The withheld arrays stay in the response, always empty, for existing clients.
    for (const section of WITHHELD) expect(summary[section]).toEqual([]);
    // With no category configured the response is exactly the earlier one: Lab
    // results are neither returned nor named until their own flag releases them.
    expect(summary).not.toHaveProperty('labResults');
    expect(Object.keys(summary)).toEqual(['encounters', 'notes', 'vitals', 'diagnoses', 'prescriptions', 'labRequests',
      'documents', 'released', 'withheld', 'limits', 'truncated', 'limit']);
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

describe('Record summaries release notes by their encounter (PREC-NOTES)', () => {
  // The note's own encounter, matched on all three keys of the composite foreign key.
  const ENCOUNTER_JOIN = 'join ehr.encounters e on e.id=n.encounter_id and e.patient_id=n.patient_id'
    + ' and e.facility_id=n.facility_id';

  it('releases to the patient only signed or amended notes of completed encounters', async () => {
    const { service, query } = setup({ encounters: rows(1), notes: rows(1) });
    await service.self(request);
    const notes = sqlFor(query, 'notes');
    expect(notes).toContain(ENCOUNTER_JOIN);
    expect(notes).toContain("n.status in ('signed','amended')");
    expect(notes).toContain("e.status='completed'");
    // The note of a cancelled, entered-in-error or still open encounter is never read for the patient.
    expect(notes).not.toContain("e.status<>'entered_in_error'");
  });

  it('leaves out of the emergency summary the notes of an encounter entered in error, and only those', async () => {
    const { service, query } = setup({ encounters: rows(1), notes: rows(1) });
    await service.emergency('patient-id', emergencyContext);
    const notes = sqlFor(query, 'notes');
    expect(notes).toContain(ENCOUNTER_JOIN);
    expect(notes).toContain("n.status in ('signed','amended')");
    expect(notes).toContain("e.status<>'entered_in_error'");
    // Signed notes of an encounter still in progress matter in an emergency: completion is not required.
    expect(notes).not.toContain("e.status='completed'");
    expect(notes).toContain('n.facility_id=$2');
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

  it('returns vitals as first recorded, with no correction applied and no correction field, and none entered in error', async () => {
    const recorded = { id: 'vital', encounterId: 'encounter', facilityId: 'facility', recordedAt: '2026-10-12T09:00:00.000Z',
      heightCm: null, weightKg: null, temperatureC: '37.0', pulseBpm: 90, respiratoryRate: null, systolicMmhg: 200,
      diastolicMmhg: 100, oxygenSaturationPercent: null, source: 'manual' };
    const { service, query } = setup({ vitals: [recorded] });
    const summary = await service.emergency('patient-id', emergencyContext) as unknown as Summary;
    // The columns the summary has always returned, from the vital row alone, with the section's own limit.
    // A vital entered in error (ENC-RETRACT-2, 0090) is not a measurement of this patient: it is left out.
    expect(sqlFor(query, 'vitals')).toBe('select id,encounter_id as "encounterId",facility_id as "facilityId",'
      + ' recorded_at as "recordedAt",height_cm as "heightCm",weight_kg as "weightKg",'
      + ' temperature_c as "temperatureC",pulse_bpm as "pulseBpm",respiratory_rate as "respiratoryRate",'
      + ' systolic_mmhg as "systolicMmhg",diastolic_mmhg as "diastolicMmhg",'
      + ' oxygen_saturation_percent as "oxygenSaturationPercent",source'
      + ' from ehr.vitals where patient_id=$1 and facility_id=$2 and status=\'final\''
      + ' order by recorded_at desc,id desc limit 101');
    // No correction is read: applying corrections waits for the correction-semantics decision.
    expect(query.mock.calls.some(([sql]) => /vital_corrections|current_correction_no|replacement_values/.test(String(sql))))
      .toBe(false);
    expect(summary.vitals).toEqual([recorded]);
    for (const field of ['currentCorrectionNo', 'correctedAt', 'correctionUnavailable', 'recordedValues', 'correctionReason']) {
      expect(summary.vitals?.[0]).not.toHaveProperty(field);
    }
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
      vitals: rows(5), diagnoses: rows(2), prescriptions: rows(1), labRequests: rows(6), documents: rows(7),
    });
    await service.emergency('patient-id', emergencyContext);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.details).toEqual({
      encounterCount: 4, noteCount: 3, vitalCount: 5, diagnosisCount: 2, prescriptionCount: 1, labRequestCount: 6,
      documentCount: 7, withheldCategories: [],
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
    ['vitals', 'ehr.vital.read', ['vitalCount']],
    ['diagnoses', 'ehr.diagnosis.read', ['diagnosisCount']],
    ['prescriptions', 'ehr.prescription.read', ['prescriptionCount']],
    ['labRequests', 'ehr.lab-request.read', ['labRequestCount']],
    ['documents', 'ehr.document.read', ['documentCount']],
  ];
  const everyRow: Fixture = { encounters: rows(2), notes: rows(1), vitals: rows(3),
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

describe('Patient self records: the configured release (owner decision 4 of 2026-10-16, D7)', () => {
  const ALL: readonly PatientReleasable[] = ['vitals', 'diagnoses', 'prescriptions', 'labResults', 'documents'];
  // An item's encounter, matched on all three keys of the composite foreign key.
  const encounterJoin = (alias: string) => `join ehr.encounters e on e.id=${alias}.encounter_id`
    + ` and e.patient_id=${alias}.patient_id and e.facility_id=${alias}.facility_id`;
  const labRow = { id: 'result-1', encounterId: 'encounter-1', sourceEhrOrderId: 'order-1', facilityId: 'facility',
    testCodeSystem: 'http://loinc.org', testCode: '2345-7', testName: 'Glucose', version: '2', revisionKind: 'correction',
    resultType: 'numeric', numericValue: '6.10', textValue: null, unit: 'mmol/L', referenceRange: '3.9-5.5',
    abnormalFlag: 'high', releasedAt: '2026-10-16T09:00:00.000Z' };

  it('reads each configured category after encounters and notes, in the release order, and withholds lab requests', async () => {
    const { service, query } = setup({ encounters: rows(1), notes: rows(1), vitals: rows(2), diagnoses: rows(3),
      prescriptions: rows(4), labResults: [labRow], documents: rows(5) }, ALL);
    const summary = await service.self(request) as unknown as Summary;
    expect(reads(query).map(([sql]) => sectionOf(String(sql))))
      .toEqual(['encounters', 'notes', 'vitals', 'diagnoses', 'prescriptions', 'labResults', 'documents']);
    for (const [, params] of reads(query)) {
      expect(params).toEqual(['patient-id']);
    }
    expect(summary.released).toEqual(['encounters', 'notes', 'vitals', 'diagnoses', 'prescriptions', 'labResults',
      'documents']);
    expect(summary.withheld).toEqual(['labRequests']);
    expect(summary.labRequests).toEqual([]);
    expect(summary.vitals).toHaveLength(2);
    expect(summary.diagnoses).toHaveLength(3);
    expect(summary.prescriptions).toHaveLength(4);
    expect(summary.documents).toHaveLength(5);
    expect(summary.labResults).toHaveLength(1);
    expect(summary.limits).toEqual({ encounters: 50, notes: 50, vitals: 100, diagnoses: 100, prescriptions: 100,
      labResults: 100, documents: 100 });
  });

  it('releases only final vitals never corrected, of completed encounters, as first recorded', async () => {
    const { service, query } = setup({}, ['vitals']);
    await service.self(request);
    const vitals = sqlFor(query, 'vitals');
    expect(vitals).toContain(encounterJoin('v'));
    expect(vitals).toContain("v.status='final'");
    expect(vitals).toContain('v.current_correction_no=0');
    expect(vitals).toContain("e.status='completed'");
    expect(vitals).toContain('v.patient_id=$1');
    expect(vitals).toMatch(/ limit 101$/);
    // D8 is open: no correction is read, so a corrected vital is withheld, not shown with a value it no longer has.
    expect(vitals).not.toMatch(/vital_corrections|replacement_values/);
    expect(vitals).not.toContain('facility_id=$2');
  });

  it('releases only confirmed diagnoses of completed encounters and never the clinician notes', async () => {
    const { service, query } = setup({}, ['diagnoses']);
    await service.self(request);
    const diagnoses = sqlFor(query, 'diagnoses');
    expect(diagnoses).toContain(encounterJoin('d'));
    expect(diagnoses).toContain("d.verification_status='confirmed'");
    expect(diagnoses).toContain("e.status='completed'");
    expect(diagnoses).not.toMatch(/\bnotes\b/);
    expect(diagnoses).toMatch(/ limit 101$/);
  });

  it('releases only active, on-hold and completed prescriptions of completed encounters', async () => {
    const { service, query } = setup({}, ['prescriptions']);
    await service.self(request);
    const prescriptions = sqlFor(query, 'prescriptions');
    expect(prescriptions).toContain(encounterJoin('p'));
    expect(prescriptions).toContain("p.status in ('active','on_hold','completed')");
    expect(prescriptions).toContain("e.status='completed'");
    expect(prescriptions).not.toMatch(/draft|cancelled|entered_in_error/);
  });

  it('releases only available PHI documents of completed encounters, by their effective status', async () => {
    const { service, query } = setup({}, ['documents']);
    await service.self(request);
    const documents = sqlFor(query, 'documents');
    expect(documents).toContain('from ehr.documents_effective d');
    expect(documents).toContain(encounterJoin('d'));
    expect(documents).toContain("d.status='available'");
    expect(documents).toContain("d.classification='phi'");
    expect(documents).toContain("e.status='completed'");
    // The storage location is never returned to the patient; the download route signs a URL.
    expect(documents).not.toMatch(/storage_key|storage_bucket|object_version_id|sha256/);
  });

  it('reads Lab results only through the released-results view and returns them as Lab does', async () => {
    const { service, query } = setup({ labResults: [labRow] }, ['labResults']);
    const summary = await service.self(request) as unknown as Summary;
    const lab = sqlFor(query, 'labResults');
    expect(lab).toContain('from ehr.patient_released_lab_results where patient_id=$1');
    expect(lab).toContain('order by released_at desc,result_id desc');
    expect(lab).toMatch(/ limit 101$/);
    expect(lab).not.toMatch(/lab\.|correction_reason|released_by|reason/);
    expect(summary.labResults).toEqual([{ id: 'result-1', encounterId: 'encounter-1', sourceEhrOrderId: 'order-1',
      facilityId: 'facility', test: { codeSystem: 'http://loinc.org', code: '2345-7', name: 'Glucose' }, version: 2,
      revisionKind: 'correction', resultType: 'numeric', numericValue: 6.1, textValue: null, unit: 'mmol/L',
      referenceRange: '3.9-5.5', abnormalFlag: 'high', releasedAt: '2026-10-16T09:00:00.000Z' }]);
    expect(summary.released).toEqual(['encounters', 'notes', 'labResults']);
    expect(summary.withheld).toEqual(['vitals', 'diagnoses', 'prescriptions', 'labRequests', 'documents']);
  });

  it('reads one configured category alone and keeps every other one withheld', async () => {
    const { service, query } = setup({ diagnoses: rows(2) }, ['diagnoses']);
    const summary = await service.self(request) as unknown as Summary;
    expect(reads(query).map(([sql]) => sectionOf(String(sql)))).toEqual(['encounters', 'notes', 'diagnoses']);
    expect(summary.released).toEqual(['encounters', 'notes', 'diagnoses']);
    expect(summary.withheld).toEqual(['vitals', 'prescriptions', 'labRequests', 'documents']);
    expect(summary).not.toHaveProperty('labResults');
    for (const section of ['vitals', 'prescriptions', 'labRequests', 'documents'] as const) {
      expect(summary[section]).toEqual([]);
    }
    expect(summary.limits).toEqual({ encounters: 50, notes: 50, diagnoses: 100 });
  });

  it('reports each released section\'s own limit and whether it was truncated', async () => {
    const { service } = setup({ vitals: rows(101), diagnoses: rows(100), labResults: Array.from({ length: 101 },
      (_, index) => ({ ...labRow, id: `result-${index}` })) }, ['vitals', 'diagnoses', 'labResults']);
    const summary = await service.self(request) as unknown as Summary;
    expect(summary.vitals).toHaveLength(100);
    expect(summary.diagnoses).toHaveLength(100);
    expect(summary.labResults).toHaveLength(100);
    expect(summary.truncated).toEqual({ encounters: false, notes: false, vitals: true, diagnoses: false, labResults: true });
    expect(summary.limit).toBe(50);
  });

  it('audits the count of each category read and the withheld categories, counts only', async () => {
    const { service, recordWithClient } = setup({ encounters: rows(1), notes: rows(2), vitals: rows(3), diagnoses: rows(4),
      prescriptions: rows(5), labResults: [labRow], documents: rows(6) }, ALL);
    await service.self(request);
    expect(recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ehr.patient.self.records.read', purposeOfUse: 'patient-self',
      details: { encounterCount: 1, noteCount: 2, vitalCount: 3, diagnosisCount: 4, prescriptionCount: 5,
        labResultCount: 1, documentCount: 6, withheldCategories: ['labRequests'] },
    }));
  });

  it.each(['42501', '42P01', '42883', '57014'])(
    'answers 503 PATIENT_RECORDS_UNAVAILABLE when the database refuses or times out a released read (%s), disclosing nothing',
    async (code) => {
      const { service, query, recordWithClient } = setup({ labResults: [labRow] }, ['labResults']);
      query.mockImplementation(async (sql: string) => {
        if (/patient_released_lab_results/.test(sql)) throw Object.assign(new Error('refused'), { code });
        return { rows: [] };
      });
      await expect(service.self(request)).rejects.toMatchObject({ status: 503, code: 'PATIENT_RECORDS_UNAVAILABLE' });
      expect(recordWithClient).not.toHaveBeenCalled();
    });

  it('fails closed before disclosure when the durable audit fails', async () => {
    const { service, recordWithClient } = setup({ vitals: rows(1) }, ALL);
    recordWithClient.mockRejectedValue(new Error('audit failed'));
    await expect(service.self(request)).rejects.toThrow('audit failed');
  });

  it.each([
    [[], ''],
    [['vitals'], 'vitals'],
    [['documents', 'vitals'], 'vitals,documents'],
    [ALL, 'vitals,diagnoses,prescriptions,labResults,documents'],
  ] as Array<[PatientReleasable[], string]>)(
    'tells the database, before any read, that it releases exactly %j (app.patient_release %j)',
    async (categories, setting) => {
      const { service, query } = setup({}, categories);
      await service.self(request);
      const [first] = query.mock.calls as unknown as QueryCall[];
      expect(String(first?.[0]).replace(/\s+/g, ' ')).toBe("select set_config('app.patient_release',$1,true)");
      expect(first?.[1]).toEqual([setting]);
      expect(bindings(query)).toEqual([[setting]]);
    });

  it('refuses a configuration that names lab requests or an unknown category', () => {
    expect(() => new PatientRecordRelease(['labRequests' as PatientReleasable])).toThrow(/never released/);
    expect(() => new PatientRecordRelease(['allergies' as PatientReleasable])).toThrow(/not a releasable/);
  });

  it('exposes the one release set the patient summary, chat and imported records read', async () => {
    const release = new PatientRecordRelease(['vitals']);
    const query = jest.fn(async (sql: string) => ({ rows: sectionOf(sql) === 'vitals' ? rows(1) : [] }));
    const released = await release.read({ query } as unknown as PoolClient, 'patient-id');
    // Any reader through read() tells the database its release set first, so a
    // reader cannot widen what the policies admit by forgetting it.
    expect(query.mock.calls[0]).toEqual(["select set_config('app.patient_release',$1,true)", ['vitals']]);
    expect(released.released).toEqual(['encounters', 'notes', 'vitals']);
    expect(released.vitals).toHaveLength(1);
    expect(release.releases('vitals')).toBe(true);
    expect(release.releases('documents')).toBe(false);
  });

  it('leaves the emergency summary unchanged: seven categories, no Lab results', async () => {
    const { service, query } = setup({}, ALL);
    const summary = await service.emergency('patient-id', emergencyContext) as unknown as Summary;
    expect(query).toHaveBeenCalledTimes(7);
    expect(query.mock.calls.some(([sql]) => /patient_released_lab_results/.test(String(sql)))).toBe(false);
    expect(summary).not.toHaveProperty('labResults');
    expect(summary.released).toEqual([...SECTIONS]);
  });
});

describe('Patient document download (owner decision 4, D7: documents only with a patient download route)', () => {
  const documentId = STORED_DOCUMENT.id;

  it('refuses a session that is not a patient\'s before anything is read', async () => {
    const { service, authorizeSelf, transaction } = setup({}, ['documents']);
    const staffRequest = { ...request, actor: { kind: 'staff', subject: 'doctor' } } as unknown as HidRequest;
    await expect(service.downloadOwnDocument(staffRequest, documentId))
      .rejects.toMatchObject({ status: 403, code: 'PATIENT_SESSION_REQUIRED' });
    expect(authorizeSelf).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('answers 404 DOCUMENT_NOT_AVAILABLE when documents are not released, before any read', async () => {
    const { service, authorizeSelf, transaction, storage } = setup({}, ['vitals']);
    await expect(service.downloadOwnDocument(request, documentId))
      .rejects.toMatchObject({ status: 404, code: 'DOCUMENT_NOT_AVAILABLE' });
    expect(authorizeSelf).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(storage.createDownload).not.toHaveBeenCalled();
  });

  it('denies before reading when the Identity authorization changed', async () => {
    const { service, authorizeSelf, transaction } = setup({}, ['documents']);
    authorizeSelf.mockResolvedValue({ ...actor, sessionId: 'other-session' });
    await expect(service.downloadOwnDocument(request, documentId))
      .rejects.toMatchObject({ status: 403, code: 'PATIENT_ACCESS_DENIED' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('answers the same 404 for an unknown, unreleased or another patient\'s document, with no audit or storage call', async () => {
    const { service, recordWithClient, storage } = setup({}, ['documents'], { download: null });
    await expect(service.downloadOwnDocument(request, documentId))
      .rejects.toMatchObject({ status: 404, code: 'DOCUMENT_NOT_AVAILABLE' });
    expect(recordWithClient).not.toHaveBeenCalled();
    expect(storage.inspectVersion).not.toHaveBeenCalled();
    expect(storage.createDownload).not.toHaveBeenCalled();
  });

  it('repeats the release rules in its read: the patient\'s own available, clean PHI document of a completed encounter', async () => {
    const { service, query } = setup({}, ['documents']);
    await service.downloadOwnDocument(request, documentId);
    const [sql, params] = reads(query)[0] as QueryCall;
    const text = sql.replace(/\s+/g, ' ');
    expect(text).toContain('from ehr.documents_effective d');
    expect(text).toContain('d.id=$1 and d.patient_id=$2');
    expect(text).toContain("d.status='available'");
    expect(text).toContain("d.scan_status='clean'");
    expect(text).toContain("d.classification='phi'");
    expect(text).toContain("e.status='completed'");
    expect(params).toEqual([documentId, 'patient-id']);
    // In the same transaction, the database was first told the release set.
    expect(bindings(query)).toEqual([['documents']]);
  });

  it('answers 404 for a document of another bucket, auditing nothing', async () => {
    const { service, recordWithClient, storage } = setup({}, ['documents'],
      { download: { ...STORED_DOCUMENT, storageBucket: 'another-bucket' } });
    await expect(service.downloadOwnDocument(request, documentId))
      .rejects.toMatchObject({ status: 404, code: 'DOCUMENT_NOT_AVAILABLE' });
    expect(recordWithClient).not.toHaveBeenCalled();
    expect(storage.createDownload).not.toHaveBeenCalled();
  });

  it('commits the audit, then checks the exact stored version, then signs an attachment URL', async () => {
    const { service, events, storage, recordWithClient } = setup({}, ['documents']);
    await expect(service.downloadOwnDocument(request, documentId))
      .resolves.toEqual({ url: 'https://signed.example.invalid/object', expiresInSeconds: 60 });
    // The database is told the release set before the document is read.
    expect(events).toEqual(['bind', 'read', 'audit', 'commit', 'inspect', 'sign']);
    expect(storage.inspectVersion).toHaveBeenCalledWith('synthetic/lab-report.pdf', 'object-version-1');
    expect(storage.createDownload).toHaveBeenCalledWith('synthetic/lab-report.pdf', 'object-version-1',
      { fileName: 'Lab report (October).pdf', mediaType: 'application/pdf' });
    // Counts and identifiers only: no file name, storage key or content.
    expect(recordWithClient).toHaveBeenCalledWith(expect.anything(), {
      correlationId: 'patient-record-test', actorType: 'patient', actorSubject: 'subject', actorAccountId: 'account-id',
      patientId: 'patient-id', action: 'ehr.patient.self.document.download', resourceType: 'document',
      resourceId: documentId, outcome: 'success', purposeOfUse: 'patient-self',
      details: { mediaType: 'application/pdf', sizeBytes: 2048 },
    });
  });

  it.each([
    ['checksum', { sha256Hex: 'b'.repeat(64) }],
    ['size', { sizeBytes: 4096 }],
    ['version', { versionId: 'object-version-2' }],
  ])('signs nothing when the stored object\'s %s differs: 503 DOCUMENT_INTEGRITY_UNAVAILABLE', async (_field, change) => {
    const { service, storage } = setup({}, ['documents']);
    storage.inspectVersion.mockResolvedValue({ versionId: 'object-version-1', sizeBytes: 2048, mediaType: 'application/pdf',
      sha256Hex: 'a'.repeat(64), ...change });
    await expect(service.downloadOwnDocument(request, documentId))
      .rejects.toMatchObject({ status: 503, code: 'DOCUMENT_INTEGRITY_UNAVAILABLE' });
    expect(storage.createDownload).not.toHaveBeenCalled();
  });

  it('signs nothing when the object store cannot be read: 503 DOCUMENT_STORAGE_UNAVAILABLE', async () => {
    const { service, storage } = setup({}, ['documents']);
    storage.inspectVersion.mockRejectedValue(new Error('synthetic object store outage'));
    await expect(service.downloadOwnDocument(request, documentId))
      .rejects.toMatchObject({ status: 503, code: 'DOCUMENT_STORAGE_UNAVAILABLE' });
    expect(storage.createDownload).not.toHaveBeenCalled();
  });

  it('signs nothing when the provider reports the version is not intact: 503 DOCUMENT_INTEGRITY_UNAVAILABLE', async () => {
    const { StoredObjectIntegrityError } = await import('../../storage/storage.types');
    const { service, storage } = setup({}, ['documents']);
    storage.inspectVersion.mockRejectedValue(new StoredObjectIntegrityError('synthetic KMS key mismatch'));
    await expect(service.downloadOwnDocument(request, documentId))
      .rejects.toMatchObject({ status: 503, code: 'DOCUMENT_INTEGRITY_UNAVAILABLE' });
    expect(storage.createDownload).not.toHaveBeenCalled();
  });
});

describe('Imported history never enters either record summary (owner decision 3, ADR-065)', () => {
  // The release set with every category and the imported history on.
  const EVERY_RELEASE = ['vitals', 'diagnoses', 'prescriptions', 'labResults', 'documents', 'importedHistory'] as
    unknown as PatientReleasable[];
  const touchesImported = (query: jest.Mock) =>
    (query.mock.calls as unknown as QueryCall[]).some(([sql]) => /imported/i.test(String(sql)));

  it('GET /ehr/me/records keeps exactly its keys and reads no imported table with the imported history released', async () => {
    const { service, query } = setup({}, EVERY_RELEASE);
    const summary = await service.self(request) as unknown as Summary;
    expect(Object.keys(summary)).toEqual(['encounters', 'notes', 'vitals', 'diagnoses', 'prescriptions', 'labRequests',
      'labResults', 'documents', 'released', 'withheld', 'limits', 'truncated', 'limit']);
    expect(summary.released).toEqual(['encounters', 'notes', 'vitals', 'diagnoses', 'prescriptions', 'labResults',
      'documents']);
    expect(summary.withheld).toEqual(['labRequests']);
    expect(touchesImported(query)).toBe(false);
    expect(JSON.stringify(summary)).not.toMatch(/imported/i);
    // The one binding names the imported history too (its own route reads it), the summary never does.
    expect(bindings(query)).toEqual([['vitals,diagnoses,prescriptions,labResults,documents,importedHistory']]);
  });

  it('the emergency (break-glass) summary keeps exactly its keys, audit counts and reads, and no imported table', async () => {
    const { service, query, operations } = setup({}, EVERY_RELEASE);
    const summary = await service.emergency('patient-id', emergencyContext) as unknown as Summary;
    expect(Object.keys(summary)).toEqual(['encounters', 'notes', 'vitals', 'diagnoses', 'prescriptions', 'labRequests',
      'documents', 'released', 'withheld', 'limits', 'truncated', 'limit']);
    expect(touchesImported(query)).toBe(false);
    expect(Object.keys(operations[0]?.details ?? {})).toEqual(['encounterCount', 'noteCount', 'vitalCount',
      'diagnosisCount', 'prescriptionCount', 'labRequestCount', 'documentCount', 'withheldCategories']);
    expect(JSON.stringify({ summary, operations })).not.toMatch(/imported/i);
  });
});
