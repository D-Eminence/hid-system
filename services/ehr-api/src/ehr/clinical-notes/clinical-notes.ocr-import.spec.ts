import type { PoolClient } from 'pg';
import type { DataAccessContext } from '../../common/request-context';
import { ClinicalRepository, type OperationResult, type SemanticEvent } from '../shared/clinical.repository';
import { ClinicalNotesService, PAPER_RECORD_NOTE_TYPE, type ClinicalNoteRow, type OcrClinicalNoteImport } from './clinical-notes.service';
import { DomainProblem } from '../../common/problem';
import { PATIENT_EVIDENCE_QUERY, STAFF_EVIDENCE_QUERY } from '../patient-records/patient-evidence.query';

const context = {
  correlationId: 'ocr-import-correlation', facilityId: '10000000-0000-4000-8000-000000000001',
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care',
  actor: { id: 'actor', subject: 'staff:doctor', accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['doctor'], permissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local' },
} satisfies DataAccessContext;

describe('ClinicalNotesService OCR ingestion boundary', () => {
  it('creates a draft note, first revision, and immutable source provenance in one owning-domain operation', async () => {
    const queries: string[] = [];
    const note = { id: '70000000-0000-4000-8000-000000000001', status: 'draft' } as ClinicalNoteRow;
    const client = { query: jest.fn(async (sql: string) => {
      queries.push(sql);
      return { rows: sql.includes('insert into ehr.clinical_notes') ? [note] : [], rowCount: 1 };
    }) } as unknown as PoolClient;
    const repository = {
      run: async <Value>(_context: DataAccessContext, _patientId: string, _access: string,
        _event: SemanticEvent, operation: (db: PoolClient) => Promise<OperationResult<Value>>,
        scopedLookup?: (db: PoolClient) => Promise<boolean>): Promise<Value> => {
        expect(await scopedLookup?.(client)).toBe(true);
        return (await operation(client)).value;
      },
      executeCreate: async <Value>(_client: PoolClient, _context: DataAccessContext,
        _patientId: string, _key: string, _operation: string, _digest: string,
        _resourceType: string, create: () => Promise<{ value: Value; id: string }>) => {
        const created = await create();
        return { value: created.value, resourceId: created.id };
      },
      encounterExists: jest.fn().mockResolvedValue(true),
    } as unknown as ClinicalRepository;
    const service = new ClinicalNotesService(repository);

    const result = await service.createImportedFromOcr(context,
      '50000000-0000-4000-8000-000000000001', {
        encounterId: '60000000-0000-4000-8000-000000000001', noteType: 'historical-record',
        title: 'Imported record', content: 'Human-reviewed content',
        publicationId: '80000000-0000-4000-8000-000000000001',
        documentId: '90000000-0000-4000-8000-000000000001',
        ocrJobId: 'a0000000-0000-4000-8000-000000000001',
        extractionId: 'b0000000-0000-4000-8000-000000000001',
        validationId: 'c0000000-0000-4000-8000-000000000001', validationVersion: 1,
        reviewedBy: '20000000-0000-4000-8000-000000000002',
      });

    expect(result).toBe(note);
    expect(queries.some((sql) => sql.includes('insert into ehr.clinical_notes'))).toBe(true);
    expect(queries.some((sql) => sql.includes('insert into ehr.clinical_note_revisions'))).toBe(true);
    expect(queries.some((sql) => sql.includes('insert into ehr.ocr_import_provenance'))).toBe(true);
    // The patient's chat cannot read the provenance row (staff-only RLS), so it knows a note read from a
    // scanned paper record by this first revision's fixed reason: the two must stay the same.
    const revision = queries.find((sql) => sql.includes('insert into ehr.clinical_note_revisions'))!;
    const reason = /values \(\$1,\$2,\$3,1,\$4,'([^']+)'/.exec(revision.replace(/\s+/g, ' '))?.[1];
    expect(reason).toBe('OCR import from human-validated source evidence');
    expect(PATIENT_EVIDENCE_QUERY).toContain(`r.revision_no=1 and r.change_reason='${reason}'`);
    expect(STAFF_EVIDENCE_QUERY).toContain(`r.revision_no=1 and r.change_reason='${reason}'`);
  });
});

// 0113 (owner decision of 2026-11-11, Option B): a reading published under
// records processing becomes a draft in the patient's "Imported paper records"
// encounter, only with the dedicated records-processing grant.
describe('ClinicalNotesService OCR draft path (0113)', () => {
  const patientId = '50000000-0000-4000-8000-000000000001';
  const grantId = 'd0000000-0000-4000-8000-000000000001';
  const importedEncounterId = 'e0000000-0000-4000-8000-000000000001';
  const reading: OcrClinicalNoteImport = {
    noteType: 'historical-record', title: 'Clinic card', content: 'Human-reviewed content',
    publicationId: '80000000-0000-4000-8000-000000000001', documentId: '90000000-0000-4000-8000-000000000001',
    ocrJobId: 'a0000000-0000-4000-8000-000000000001', extractionId: 'b0000000-0000-4000-8000-000000000001',
    validationId: 'c0000000-0000-4000-8000-000000000001', validationVersion: 1,
    reviewedBy: '20000000-0000-4000-8000-000000000002', confirmedBy: '20000000-0000-4000-8000-000000000003',
  };

  function harness(grant: string | null) {
    const calls: { sql: string; values: readonly unknown[] }[] = [];
    const note = { id: '70000000-0000-4000-8000-000000000001', status: 'draft' } as ClinicalNoteRow;
    const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('records_processing_write_grant')) return { rows: [{ id: grant }], rowCount: 1 };
      if (sql.includes('imported_paper_records_encounter')) return { rows: [{ id: importedEncounterId }], rowCount: 1 };
      return { rows: sql.includes('insert into ehr.clinical_notes') ? [note] : [], rowCount: 1 };
    }) } as unknown as PoolClient;
    const recorded: { event?: SemanticEvent; details?: Readonly<Record<string, unknown>>; lookup?: boolean } = {};
    const repository = {
      run: async <Value>(_context: DataAccessContext, _patientId: string, access: string,
        event: SemanticEvent, operation: (db: PoolClient) => Promise<OperationResult<Value>>,
        scopedLookup?: (db: PoolClient) => Promise<boolean>): Promise<Value> => {
        expect(access).toBe('write_records');
        recorded.event = event;
        recorded.lookup = scopedLookup !== undefined;
        const result = await operation(client);
        recorded.details = result.details;
        return result.value;
      },
      executeCreate: async <Value>(_client: PoolClient, _context: DataAccessContext,
        _patientId: string, _key: string, _operation: string, _digest: string,
        _resourceType: string, create: () => Promise<{ value: Value; id: string }>) => {
        const created = await create();
        return { value: created.value, resourceId: created.id, details: { idempotentReplay: false } };
      },
      encounterExists: jest.fn().mockResolvedValue(true),
    } as unknown as ClinicalRepository;
    return { service: new ClinicalNotesService(repository), calls, recorded, note };
  }
  const recordsProcessing = { ...context, purposeOfUse: 'healthcare-operations' } satisfies DataAccessContext;

  it('with the dedicated grant: a draft in the imported encounter, the grant named in the audit', async () => {
    const { service, calls, recorded, note } = harness(grantId);
    await expect(service.createImportedFromOcr(recordsProcessing, patientId, reading)).resolves.toBe(note);
    const check = calls.find((call) => call.sql.includes('records_processing_write_grant'))!;
    expect(check.values).toEqual([patientId, context.actor.subject, context.membershipId, context.facilityId]);
    expect(calls.some((call) => call.sql.includes('ehr.imported_paper_records_encounter($1)'))).toBe(true);
    const insert = calls.find((call) => call.sql.includes('insert into ehr.clinical_notes'))!;
    expect(insert.sql).toContain("'draft'");
    expect(insert.values[0]).toBe(importedEncounterId);
    expect(insert.values.slice(5)).toEqual([PAPER_RECORD_NOTE_TYPE, 'From a paper record (Migrate): Clinic card']);
    expect(calls.some((call) => call.sql.includes('insert into ehr.ocr_import_provenance'))).toBe(true);
    expect(recorded.lookup).toBe(false);
    expect(recorded.event?.details).toEqual({ publicationId: reading.publicationId, documentId: reading.documentId,
      basis: 'records_processing_grant', publishedBy: context.actor.accountId, confirmedBy: reading.confirmedBy });
    expect(recorded.details).toEqual({ idempotentReplay: false, importedPaperRecords: true, grantId });
  });

  it('without it (a share, an Access PIN, a read-only approval): 403 and nothing written', async () => {
    const { service, calls } = harness(null);
    const problem = await service.createImportedFromOcr(recordsProcessing, patientId, reading).catch((error) => error);
    expect(problem).toBeInstanceOf(DomainProblem);
    expect([problem.getStatus(), problem.code]).toEqual([403, 'OCR_PUBLISH_NEEDS_DIRECT_CARE']);
    expect(calls.map((call) => call.sql).filter((sql) => /insert|imported_paper_records_encounter/.test(sql))).toEqual([]);
  });

  it('under records processing a visit cannot be chosen', async () => {
    const { service, calls } = harness(grantId);
    const problem = await service.createImportedFromOcr(recordsProcessing, patientId,
      { ...reading, encounterId: '60000000-0000-4000-8000-000000000001' }).catch((error) => error);
    expect([problem.getStatus(), problem.code]).toEqual([400, 'OCR_DRAFT_ENCOUNTER_NOT_CHOSEN']);
    expect(calls).toEqual([]);
  });

  it('direct care without a visit: the imported encounter, no grant check', async () => {
    const { service, calls, recorded } = harness(null);
    await service.createImportedFromOcr(context, patientId, reading);
    expect(calls.some((call) => call.sql.includes('records_processing_write_grant'))).toBe(false);
    expect(calls.find((call) => call.sql.includes('insert into ehr.clinical_notes'))!.values[0]).toBe(importedEncounterId);
    expect(recorded.event?.details).toMatchObject({ basis: 'direct_care' });
    expect(recorded.details).toEqual({ idempotentReplay: false, importedPaperRecords: true });
  });

  it('direct care with a visit: as before (that visit, its own note type and title, no grant check)', async () => {
    const { service, calls, recorded } = harness(null);
    await service.createImportedFromOcr(context, patientId, { ...reading, encounterId: '60000000-0000-4000-8000-000000000001' });
    expect(calls.some((call) => /records_processing_write_grant|imported_paper_records_encounter/.test(call.sql))).toBe(false);
    const insert = calls.find((call) => call.sql.includes('insert into ehr.clinical_notes'))!;
    expect(insert.values[0]).toBe('60000000-0000-4000-8000-000000000001');
    expect(insert.values.slice(5)).toEqual(['historical-record', 'Clinic card']);
    expect(recorded.lookup).toBe(true);
    expect(recorded.details).toEqual({ idempotentReplay: false, importedPaperRecords: false });
  });
});

