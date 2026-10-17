import type { PoolClient } from 'pg';
import { PATIENT_SECTION_LIMITS } from '../patient-records/patient-release';
import { readStaffEvidence, staffEvidenceCategories, STAFF_ALWAYS_WITHHELD, STAFF_EVIDENCE_PERMISSIONS } from './staff-evidence';

const PATIENT = '5c4b7d00-0000-4000-8000-000000000001';
const FACILITY = '5c4b7d00-0000-4000-8000-0000000000fa';
const ALL = Object.values(STAFF_EVIDENCE_PERMISSIONS);

function client(rowsFor: (sql: string) => unknown[] = () => []) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const query = jest.fn(async (sql: string, values: unknown[]) => {
    const text = sql.replace(/\s+/g, ' ');
    statements.push({ sql: text, values });
    return { rows: rowsFor(text) };
  });
  return { statements, client: { query } as unknown as PoolClient };
}

describe('readStaffEvidence', () => {
  it('maps the permissions a member holds to the categories chat may read, in extract order', () => {
    expect(staffEvidenceCategories([])).toEqual([]);
    expect(staffEvidenceCategories(['ehr.record-chat.use', 'ehr.note.read', 'ehr.vital.read'])).toEqual(['notes', 'vitals']);
    expect(staffEvidenceCategories(ALL)).toEqual(['encounters', 'notes', 'vitals', 'diagnoses', 'prescriptions', 'documents']);
    // Lab and imported history have no staff chat permission at all.
    expect(Object.values(STAFF_EVIDENCE_PERMISSIONS).join(' ')).not.toMatch(/lab|imported/);
  });

  it('reads one statement per permitted category, each for this patient at this facility only', async () => {
    const { client: db, statements } = client();
    const records = await readStaffEvidence(db, PATIENT, FACILITY, ALL);
    expect(statements).toHaveLength(6);
    for (const { sql, values } of statements) {
      expect(values).toEqual([PATIENT, FACILITY]);
      expect(sql).toContain('patient_id=$1');
      expect(sql).toContain('facility_id=$2');
      expect(sql).toContain("e.status in ('in_progress','on_hold','completed')");
    }
    expect(records.released).toEqual(['encounters', 'notes', 'vitals', 'diagnoses', 'prescriptions', 'documents']);
    expect(records.withheld).toEqual([...STAFF_ALWAYS_WITHHELD]);
    expect(records.labRequests).toEqual([]);
    expect(records.labResults).toBeUndefined();
  });

  it('reads no category the member lacks the permission for, and names it as withheld', async () => {
    const { client: db, statements } = client();
    const records = await readStaffEvidence(db, PATIENT, FACILITY, ['ehr.record-chat.use', 'ehr.note.read']);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toContain('from ehr.clinical_notes');
    expect(records.released).toEqual(['notes']);
    expect(records.withheld).toEqual(['encounters', 'vitals', 'diagnoses', 'prescriptions', 'documents', 'labRequests', 'labResults']);
    const none = await readStaffEvidence(client().client, PATIENT, FACILITY, ['ehr.record-chat.use']);
    expect(none.released).toEqual([]);
    expect(none.encounters).toEqual([]);
  });

  it('never selects the clinician\'s diagnosis notes, a storage location, Lab, imported history or another facility', async () => {
    const { client: db, statements } = client();
    await readStaffEvidence(db, PATIENT, FACILITY, ALL);
    const sql = statements.map((statement) => statement.sql).join('\n');
    expect(sql).not.toMatch(/\bnotes\b(?! as)\s*(,|from)|d\.notes|storage_key|storage_bucket|object_version_id/);
    expect(sql).not.toMatch(/imported_|lab\.|lab_requests|patient_released_lab_results|emergency/);
    expect(sql).not.toContain("'entered_in_error')");
  });

  it('reads one row more than a section shows, and says which sections were cut', async () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `row-${index}` }));
    const { client: db } = client((sql) => (sql.includes('from ehr.vitals') ? rows(PATIENT_SECTION_LIMITS.vitals + 1)
      : sql.includes('from ehr.diagnoses') ? rows(3) : []));
    const records = await readStaffEvidence(db, PATIENT, FACILITY, ALL);
    expect(records.vitals).toHaveLength(PATIENT_SECTION_LIMITS.vitals);
    expect(records.diagnoses).toHaveLength(3);
    expect(records.truncated).toMatchObject({ vitals: true, diagnoses: false, encounters: false });
    expect(records.limits).toMatchObject({ vitals: PATIENT_SECTION_LIMITS.vitals, encounters: PATIENT_SECTION_LIMITS.encounters });
  });

  it('returns a document\'s size as an integer', async () => {
    const { client: db } = client((sql) => (sql.includes('documents_effective') ? [{ id: 'd1', sizeBytes: '1024' }] : []));
    expect((await readStaffEvidence(db, PATIENT, FACILITY, ALL)).documents).toEqual([{ id: 'd1', sizeBytes: 1024 }]);
  });
});
