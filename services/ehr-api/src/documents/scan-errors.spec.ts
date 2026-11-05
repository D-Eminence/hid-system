import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DomainProblem } from '../common/problem';
import { SCAN_REFUSALS, scanRefusalProblem } from './scan-errors';

const migrations = join(__dirname, '../../database/migrations');
const append = readFileSync(join(migrations, '0009_document_scan_object_binding.sql'), 'utf8');
const scanner = readFileSync(join(migrations, '0105_document_scanner.sql'), 'utf8');
const patientFiles = readFileSync(join(migrations, '0117_patient_entry_documents.sql'), 'utf8');

// The body of one function in a migration file, from its CREATE to the next $$;.
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} is not in the file`);
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end);
}

const bodies = {
  'ehr.append_document_scan_event': functionBody(append, 'ehr.append_document_scan_event'),
  'ehr.resolve_document_scan_target': functionBody(scanner, 'ehr.resolve_document_scan_target'),
  'ehr.list_documents_awaiting_scan': functionBody(scanner, 'ehr.list_documents_awaiting_scan'),
  // The same three for the files patients add (0117), which the EHR API dispatches to.
  'ehr.append_patient_entry_document_scan_event': functionBody(patientFiles, 'ehr.append_patient_entry_document_scan_event'),
  'ehr.resolve_patient_entry_document_scan_target':
    functionBody(patientFiles, 'ehr.resolve_patient_entry_document_scan_target'),
  'ehr.list_patient_entry_documents_awaiting_scan':
    functionBody(patientFiles, 'ehr.list_patient_entry_documents_awaiting_scan'),
};
const raised = (body: string) => [...body.matchAll(/raise exception using errcode = '([0-9A-Z]{5})', message = '([^']+)'/g)]
  .map(match => `${match[1]} ${match[2]}`);

describe('scanner refusals: the database messages the EHR API keys on', () => {
  it('finds every mapped SQLSTATE and message raised, verbatim, by a scanner command', () => {
    const all = new Set(Object.values(bodies).flatMap(raised));
    for (const refusal of SCAN_REFUSALS) {
      expect(all).toContain(`${refusal.sqlstate} ${refusal.message}`);
    }
  });

  it('maps every refusal each command can raise, so none of them reaches the bridge as a 500', () => {
    const mapped = new Set(SCAN_REFUSALS.map(refusal => `${refusal.sqlstate} ${refusal.message}`));
    for (const [name, body] of Object.entries(bodies)) {
      const unmapped = raised(body).filter(refusal => !mapped.has(refusal));
      expect({ name, unmapped }).toEqual({ name, unmapped: [] });
    }
  });

  it('pins the codes and statuses of the contract the bridge matches', () => {
    expect(Object.fromEntries(SCAN_REFUSALS.filter(refusal => refusal.sqlstate !== '22023')
      .map(refusal => [`${refusal.sqlstate} ${refusal.message}`, `${refusal.status} ${refusal.code}`]))).toEqual({
      'P0002 Document not found': '404 DOCUMENT_NOT_FOUND',
      '55000 Only an uploaded document can be scanned': '409 DOCUMENT_NOT_UPLOADED',
      '55000 Document is no longer awaiting a scan': '409 DOCUMENT_NOT_SCANNABLE',
      '55000 Scan result does not match the current immutable document object': '409 OBJECT_VERSION_MISMATCH',
      '55000 Document object scan has already reached a terminal result': '409 SCAN_ALREADY_TERMINAL',
      '23505 Scanner idempotency key payload mismatch': '409 SCAN_IDEMPOTENCY_CONFLICT',
      '42501 Authorized document scanner context is required': '403 DOCUMENT_SCANNER_FORBIDDEN',
    });
    expect(new Set(SCAN_REFUSALS.filter(refusal => refusal.sqlstate === '22023')
      .map(refusal => `${refusal.status} ${refusal.code}`))).toEqual(new Set(['400 INVALID_SCAN_REQUEST']));
  });

  it('turns a known refusal into its DomainProblem', () => {
    const problem = scanRefusalProblem({ code: '55000', message: 'Only an uploaded document can be scanned' });
    expect(problem).toBeInstanceOf(DomainProblem);
    expect(problem).toMatchObject({ code: 'DOCUMENT_NOT_UPLOADED', status: 409 });
    expect((problem as DomainProblem).getStatus()).toBe(409);
  });

  it.each([
    ['another message under a mapped SQLSTATE', { code: '55000', message: 'Something else' }],
    ['a mapped message under another SQLSTATE', { code: 'XX000', message: 'Document not found' }],
    ['a connection failure', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['no code at all', new Error('boom')],
    ['a non-object', 'boom'],
  ])('leaves %s as it is (still a 500)', (_name, error) => {
    expect(scanRefusalProblem(error)).toBe(error);
  });
});
