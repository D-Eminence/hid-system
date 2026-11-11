import type { PoolClient } from 'pg';
import type { DataAccessContext } from '../../common/request-context';
import { NoteStatus } from '../shared/clinical.dto';
import { ClinicalRepository, type OperationResult, type SemanticEvent } from '../shared/clinical.repository';
import { ClinicalNotesService, type ClinicalNoteRow } from './clinical-notes.service';

const context = {
  correlationId: 'note-create-correlation', facilityId: '10000000-0000-4000-8000-000000000001',
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care',
  actor: { id: 'actor', subject: 'staff:doctor', accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['doctor'], permissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local' },
} satisfies DataAccessContext;

function harness() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const note = { id: '70000000-0000-4000-8000-000000000001', status: 'draft' } as ClinicalNoteRow;
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    return { rows: sql.includes('insert into ehr.clinical_notes') ? [note] : [], rowCount: 1 };
  }) } as unknown as PoolClient;
  const repository = {
    run: async <Value>(_context: DataAccessContext, _patientId: string, _access: string,
      _event: SemanticEvent, operation: (db: PoolClient) => Promise<OperationResult<Value>>) =>
      (await operation(client)).value,
    executeCreate: async <Value>(_client: PoolClient, _context: DataAccessContext,
      _patientId: string, _key: string, _operation: string, _digest: string,
      _resourceType: string, create: () => Promise<{ value: Value; id: string }>) => {
      const created = await create();
      return { value: created.value, resourceId: created.id };
    },
  } as unknown as ClinicalRepository;
  return { calls, service: new ClinicalNotesService(repository) };
}

describe('ClinicalNotesService.create (staff visit note)', () => {
  it.each([NoteStatus.Draft, NoteStatus.Signed])('types every reused parameter so PostgreSQL accepts a %s note', async (status) => {
    const { calls, service } = harness();
    await service.create(context, '50000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001',
      { noteType: 'progress', title: 'Visit note', content: 'Fictional note text', status }, 'idem-key-1');

    const insert = calls.find((call) => call.sql.includes('insert into ehr.clinical_notes'))!;
    const sql = insert.sql.replace(/\s+/g, ' ');
    // The author ($4) fills created_by and, when signed, signed_by. Inside a CASE an
    // untyped parameter is read as text, which clashes with created_by's uuid and
    // fails the whole insert with 42P08 (the 5 Nov 2026 production 500). Every use
    // of a parameter inside a CASE must carry an explicit type.
    for (const match of sql.matchAll(/case when ([^]*?) end/g)) {
      expect(match[1]).not.toMatch(/\$\d+(?!\d|::)/);
    }
    expect(sql).toContain('case when $9::boolean then $4::uuid else null end');
    expect(insert.values[3]).toBe(context.actor.accountId);
    expect(insert.values[8]).toBe(status === NoteStatus.Signed);
    expect(calls.some((call) => call.sql.includes('insert into ehr.clinical_note_revisions'))).toBe(true);
  });
});
