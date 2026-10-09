import type { PoolClient } from 'pg';
import type { DataAccessContext } from '../../common/request-context';
import { ClinicalRepository, type OperationResult, type SemanticEvent } from '../shared/clinical.repository';
import { ClinicalNotesService, type ClinicalNoteRow } from './clinical-notes.service';

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
  });
});
