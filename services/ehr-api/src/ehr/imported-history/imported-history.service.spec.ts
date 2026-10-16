import type { PoolClient } from 'pg';
import type { AuditEventInput } from '../../audit/audit.service';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { configuredPatientRelease, PatientRecordRelease, type PatientReleaseCategory } from '../patient-records/patient-release';
import { ImportedHistoryService, IMPORTED_HISTORY_LIMITS } from './imported-history.service';

// Imported legacy medical history (owner decision 3 of 2026-10-16, ADR-066).
// The patient reads their own history through the patient-self path and the
// one release set (PatientRecordRelease, its own flag off by default); staff
// read it through ClinicalRepository.run, direct care only, never under
// break-glass, and see it only when the patient has chosen to share it.

const patientId = '30000000-0000-4000-8000-000000000001';
const actor = { kind: 'patient', patientId, accountId: '30000000-0000-4000-8000-000000000002',
  subject: 'patient-subject', sessionId: '30000000-0000-4000-8000-000000000003' };
const request = { actor, correlationId: 'imported-history-correlation', header: () => undefined } as unknown as HidRequest;
const authorization = { allowed: true, patientId, accountId: actor.accountId, subject: actor.subject,
  sessionId: actor.sessionId, expiresAt: new Date(Date.now() + 30_000).toISOString() };
const staffContext = { correlationId: 'staff-correlation-1234', facilityId: '30000000-0000-4000-8000-000000000010',
  membershipId: '30000000-0000-4000-8000-000000000011', purposeOfUse: 'direct-care',
  actor: { subject: 'staff-subject', accountId: '30000000-0000-4000-8000-000000000012', permissions: [] } } as unknown as
  DataAccessContext;

type QueryCall = [string, unknown[] | undefined];
const recordId = (n: number) => `30000000-0000-4000-8000-1000000000${String(n).padStart(2, '0')}`;

/** A record row as the imported history query returns it: allowlisted fields only. */
function recordRow(n: number, versions = 1, files = 0) {
  return {
    id: recordId(n), origin: n % 2 ? 'patient-provided' : 'provider-authored', title: `Synthetic history ${n}`,
    category: 'history', infoType: 'text', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z',
    currentVersionId: `30000000-0000-4000-8000-2000000000${String(n).padStart(2, '0')}`,
    cursorAt: `2025-01-01T00:00:${String(59 - (n % 60)).padStart(2, '0')}.000000Z`,
    versions: Array.from({ length: versions }, (_, v) => ({ id: `30000000-0000-4000-8000-3${String(n).padStart(4, '0')}${String(v).padStart(7, '0')}`,
      versionNo: versions - v, origin: 'patient-provided', createdAt: '2025-01-01T00:00:00.000Z',
      record: 'Invented clinical content', notes: null, structuredData: { synthetic: true }, transcriptionText: null })),
    files: Array.from({ length: files }, (_, f) => ({ id: `30000000-0000-4000-8000-4${String(n).padStart(4, '0')}${String(f).padStart(7, '0')}`,
      recordVersionId: null, fileName: 'synthetic.txt', mediaType: 'text/plain', sizeBytes: 19,
      createdAt: '2025-01-01T00:00:00.000Z' })),
  };
}

function setup(categories: PatientReleaseCategory[] = ['importedHistory'],
  options: { records?: unknown[]; shared?: boolean; auditFails?: boolean; queryError?: unknown; decisionError?: unknown } = {}) {
  const query = jest.fn(async (sql: string, _values?: unknown[]) => {
    if (/set_config\('app\.patient_release'/.test(sql)) return { rows: [{}] };
    if (/imported_history_staff_read_allowed/.test(sql)) {
      if (options.decisionError) throw options.decisionError;
      return { rows: [{ shared: options.shared ?? false, bound: _values?.[0] }] };
    }
    if (/from ehr\.imported_medical_records/.test(sql)) {
      if (options.queryError) throw options.queryError;
      return { rows: options.records ?? [recordRow(1, 2, 1), recordRow(2)] };
    }
    throw new Error(`Unexpected statement: ${sql}`);
  });
  const client = { query } as unknown as PoolClient;
  const recorded: AuditEventInput[] = [];
  const audit = { recordWithClient: jest.fn(async (_client: unknown, input: AuditEventInput) => {
    if (options.auditFails) throw new Error('audit unavailable');
    recorded.push(input);
  }) };
  const transaction = jest.fn(async (_authorization: unknown, _correlation: string,
    operation: (client: PoolClient) => Promise<unknown>) => operation(client));
  const database = { withPatientTransaction: transaction };
  const authorizeSelf = jest.fn(async () => authorization);
  const identity = { authorizeSelf };
  const run = jest.fn(async (_context: unknown, _patient: string, _access: string, _event: unknown,
    operation: (client: PoolClient) => Promise<{ value: unknown; details?: Record<string, unknown> }>) =>
    (await operation(client)).value);
  const clinical = { run };
  const release = new PatientRecordRelease(categories);
  const service = new ImportedHistoryService(database as never, identity as never, audit as never, clinical as never,
    release);
  return { service, query, transaction, authorizeSelf, run, recorded, audit };
}

const STAFF_DECISION = "select ehr.imported_history_staff_read_allowed($1::uuid) as shared, "
  + "set_config('app.imported_history_patient', $1::uuid::text, true) as bound";

const statements = (query: jest.Mock) => (query.mock.calls as unknown as QueryCall[]).map(([sql]) =>
  String(sql).replace(/\s+/g, ' ').trim());

describe('The imported history is part of the one patient release set, on its own flag', () => {
  it('is released only when its own flag is on, never in the summary categories', () => {
    expect(configuredPatientRelease({ EHR_PATIENT_RELEASE_VITALS: false, EHR_PATIENT_RELEASE_DIAGNOSES: false,
      EHR_PATIENT_RELEASE_PRESCRIPTIONS: false, EHR_PATIENT_RELEASE_LAB_RESULTS: false,
      EHR_PATIENT_RELEASE_DOCUMENTS: false, EHR_PATIENT_RELEASE_IMPORTED_HISTORY: false })).toEqual([]);
    expect(configuredPatientRelease({ EHR_PATIENT_RELEASE_VITALS: true, EHR_PATIENT_RELEASE_DIAGNOSES: false,
      EHR_PATIENT_RELEASE_PRESCRIPTIONS: false, EHR_PATIENT_RELEASE_LAB_RESULTS: false,
      EHR_PATIENT_RELEASE_DOCUMENTS: false, EHR_PATIENT_RELEASE_IMPORTED_HISTORY: true }))
      .toEqual(['vitals', 'importedHistory']);
    const release = new PatientRecordRelease(['importedHistory']);
    expect(release.releases('importedHistory')).toBe(true);
    expect(new PatientRecordRelease([]).releases('importedHistory')).toBe(false);
  });

  it('names importedHistory last in the database\'s release set, after the summary categories', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    await new PatientRecordRelease(['documents', 'importedHistory', 'vitals']).bind({ query } as unknown as PoolClient);
    expect(query).toHaveBeenCalledWith("select set_config('app.patient_release',$1,true)", ['vitals,documents,importedHistory']);
  });
});

describe('ImportedHistoryService.self: the patient-self path', () => {
  it('answers 503 IMPORTED_HISTORY_DISABLED while the flag is off, before any authorization or read', async () => {
    const { service, authorizeSelf, transaction } = setup(['vitals']);
    await expect(service.self(request)).rejects.toMatchObject({ status: 503, code: 'IMPORTED_HISTORY_DISABLED' });
    expect(authorizeSelf).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses a session that is not a patient\'s before anything else', async () => {
    const { service, authorizeSelf } = setup();
    const staff = { ...request, actor: { kind: 'staff', subject: 'doctor' } } as unknown as HidRequest;
    await expect(service.self(staff)).rejects.toMatchObject({ status: 403, code: 'PATIENT_SESSION_REQUIRED' });
    expect(authorizeSelf).not.toHaveBeenCalled();
  });

  it('denies before reading when Identity\'s authorization names another session', async () => {
    const { service, authorizeSelf, transaction } = setup();
    authorizeSelf.mockResolvedValue({ ...authorization, sessionId: 'another-session' });
    await expect(service.self(request)).rejects.toMatchObject({ status: 403, code: 'PATIENT_ACCESS_DENIED' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses a cursor it did not issue with 400 INVALID_CURSOR before authorization', async () => {
    const { service, authorizeSelf } = setup();
    await expect(service.self(request, 'not-a-cursor-of-this-list')).rejects.toMatchObject({ status: 400,
      code: 'INVALID_CURSOR' });
    expect(authorizeSelf).not.toHaveBeenCalled();
  });

  it('binds the release set, reads only allowlisted fields of the patient\'s own history and audits counts only', async () => {
    const { service, query, transaction, recorded } = setup();
    const value = await service.self(request);
    expect(transaction).toHaveBeenCalledWith(authorization, request.correlationId, expect.any(Function));
    const sql = statements(query);
    expect(sql[0]).toBe("select set_config('app.patient_release',$1,true)");
    expect(query.mock.calls[0]?.[1]).toEqual(['importedHistory']);
    expect(sql).toHaveLength(2);
    expect(query.mock.calls[1]?.[1]?.[0]).toBe(patientId);
    expect(sql[1]).not.toMatch(/source_payload\s*(,|from|as "sourcePayload")|storage_|source_sha256|source_run_id|author_account_id/);
    expect(Object.keys(value)).toEqual(['records', 'healthProfile', 'limits', 'truncated', 'nextCursor', 'provenance']);
    expect(value.records.map((record: { id: string }) => record.id)).toEqual([recordId(1), recordId(2)]);
    expect(Object.keys(value.records[0] ?? {})).toEqual(['id', 'origin', 'title', 'category', 'infoType', 'createdAt',
      'updatedAt', 'currentVersionId', 'versions', 'versionsTruncated', 'files', 'filesTruncated']);
    expect(value.records[0]?.files).toEqual([expect.objectContaining({ fileName: 'synthetic.txt',
      accessStatus: 'pending-safety-verification' })]);
    expect(value.records[0]?.versions).toHaveLength(2);
    expect(value).toMatchObject({ healthProfile: null, limits: IMPORTED_HISTORY_LIMITS, truncated: { records: false },
      nextCursor: null, provenance: 'legacy-import' });
    expect(recorded).toEqual([expect.objectContaining({ action: 'ehr.patient.self.imported-history.read',
      resourceType: 'imported-medical-history', outcome: 'success', purposeOfUse: 'patient-self', actorType: 'patient',
      patientId, details: { recordCount: 2, versionCount: 3, fileCount: 1, healthProfile: false, truncated: false } })]);
    expect(JSON.stringify(recorded)).not.toMatch(/Synthetic history|synthetic\.txt|Invented clinical/);
  });

  it('reads one record more than it shows and says the history is truncated, with the next page\'s cursor', async () => {
    const records = Array.from({ length: IMPORTED_HISTORY_LIMITS.records + 1 }, (_, n) => recordRow(n + 1));
    const { service } = setup(['importedHistory'], { records });
    const value = await service.self(request);
    expect(value.records).toHaveLength(IMPORTED_HISTORY_LIMITS.records);
    expect(value.truncated).toEqual({ records: true });
    expect(value.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(service.self(request, value.nextCursor ?? undefined)).resolves.toBeDefined();
  });

  it('caps each record\'s versions and files and marks them truncated', async () => {
    const { service } = setup(['importedHistory'], { records: [recordRow(1,
      IMPORTED_HISTORY_LIMITS.versionsPerRecord + 1, IMPORTED_HISTORY_LIMITS.filesPerRecord + 1)] });
    const [record] = (await service.self(request)).records;
    expect(record?.versions).toHaveLength(IMPORTED_HISTORY_LIMITS.versionsPerRecord);
    expect(record?.files).toHaveLength(IMPORTED_HISTORY_LIMITS.filesPerRecord);
    expect([record?.versionsTruncated, record?.filesTruncated]).toEqual([true, true]);
  });

  it('discloses nothing when the audit row cannot be written', async () => {
    await expect(setup(['importedHistory'], { auditFails: true }).service.self(request)).rejects.toThrow('audit unavailable');
  });

  it.each(['42501', '42P01', '57014'])('answers 503 IMPORTED_HISTORY_UNAVAILABLE when the database refuses the read (%s)',
    async (code) => {
      const { service, recorded } = setup(['importedHistory'], { queryError: Object.assign(new Error('refused'), { code }) });
      await expect(service.self(request)).rejects.toMatchObject({ status: 503, code: 'IMPORTED_HISTORY_UNAVAILABLE' });
      expect(recorded).toEqual([]);
    });
});

describe('ImportedHistoryService.staff: direct care, standard consent and the patient\'s choice, never break-glass', () => {
  it('runs through ClinicalRepository with read_records and the break-glass exclusion', async () => {
    const { service, run } = setup([], { shared: true });
    await service.staff(patientId, staffContext);
    expect(run).toHaveBeenCalledWith(staffContext, patientId, 'read_records', { action: 'ehr.imported-history.read',
      resourceType: 'imported-medical-history', excludeBreakGlass: { code: 'BREAK_GLASS_EXCLUDED' } }, expect.any(Function));
  });

  it('answers shared: false with nothing in it, and reads no record, when the patient has not shared', async () => {
    const { service, query } = setup([], { shared: false });
    const value = await service.staff(patientId, staffContext);
    expect(value).toEqual({ shared: false, records: [], healthProfile: null, limits: IMPORTED_HISTORY_LIMITS,
      truncated: { records: false }, nextCursor: null, provenance: 'legacy-import' });
    // One statement decides and binds the patient the staff policies compare
    // with (ADR-066): the decision runs once per statement, not per row.
    expect(statements(query)).toEqual([STAFF_DECISION]);
    expect(query.mock.calls[0]?.[1]).toEqual([patientId]);
  });

  it('binds the patient before the page is read, so the staff policies admit only that patient\'s rows', async () => {
    const { service, query } = setup([], { shared: true });
    await service.staff(patientId, staffContext);
    const sql = statements(query);
    expect(sql[0]).toBe(STAFF_DECISION);
    expect(sql[1]).toMatch(/from ehr\.imported_medical_records r where r\.patient_id=\$1/);
    expect(sql).toHaveLength(2);
  });

  it.each(['42501', '42P01', '42883', '42703', '57014'])(
    'answers 503 IMPORTED_HISTORY_UNAVAILABLE when the database refuses the staff decision (%s)', async (code) => {
      const { service, query } = setup([], { decisionError: Object.assign(new Error('refused'), { code }) });
      await expect(service.staff(patientId, staffContext)).rejects.toMatchObject({ status: 503,
        code: 'IMPORTED_HISTORY_UNAVAILABLE' });
      expect(statements(query)).toEqual([STAFF_DECISION]);
    });

  it('leaves any other database error of the staff decision to the request pipeline', async () => {
    const failure = Object.assign(new Error('unexpected'), { code: '40001' });
    const { service } = setup([], { decisionError: failure });
    await expect(service.staff(patientId, staffContext)).rejects.toBe(failure);
  });

  it('reads the shared history and records counts and the choice in the audit details', async () => {
    const { service, run, query } = setup([], { shared: true });
    let details: Record<string, unknown> | undefined;
    run.mockImplementationOnce(async (_c: unknown, _p: string, _a: string, _e: unknown,
      operation: (client: PoolClient) => Promise<{ value: unknown; details?: Record<string, unknown> }>) => {
      const result = await operation({ query } as unknown as PoolClient);
      details = result.details;
      return result.value;
    });
    const value = await service.staff(patientId, staffContext);
    expect(value.shared).toBe(true);
    expect(value.records).toHaveLength(2);
    expect(details).toEqual({ shared: true, recordCount: 2, versionCount: 3, fileCount: 1, healthProfile: false,
      truncated: false });
    // The staff read binds no release set: only its own policy can admit a row.
    expect(statements(query).some((sql) => sql.includes('app.patient_release'))).toBe(false);
  });

  it('refuses a cursor issued for the patient\'s own list', async () => {
    const records = Array.from({ length: IMPORTED_HISTORY_LIMITS.records + 1 }, (_, n) => recordRow(n + 1));
    const { service, run } = setup(['importedHistory'], { records, shared: true });
    const own = await service.self(request);
    await expect(service.staff(patientId, staffContext, own.nextCursor ?? undefined))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
    expect(run).not.toHaveBeenCalled();
  });
});
