import { DomainProblem } from '../common/problem';

/**
 * The database refusals of the scanner commands (ehr.append_document_scan_event,
 * 0009; ehr.resolve_document_scan_target and ehr.list_documents_awaiting_scan,
 * 0105), keyed on their SQLSTATE and exact message, and the 4xx answer each one
 * gets instead of a generic 500. The bridge acts on the codes: it retries
 * DOCUMENT_NOT_UPLOADED, and acknowledges DOCUMENT_NOT_FOUND,
 * DOCUMENT_NOT_SCANNABLE, OBJECT_VERSION_MISMATCH and SCAN_ALREADY_TERMINAL.
 * A refusal not listed here keeps today's 500, so a change to a message shows
 * as a failure rather than a wrong answer; scan-errors.spec.ts pins every
 * message against the migration files.
 */
export interface ScanRefusal {
  sqlstate: string;
  message: string;
  status: number;
  code: string;
  detail: string;
}

export const SCAN_REFUSALS: readonly ScanRefusal[] = [
  { sqlstate: 'P0002', message: 'Document not found', status: 404, code: 'DOCUMENT_NOT_FOUND',
    detail: 'No document holds this object' },
  { sqlstate: '55000', message: 'Only an uploaded document can be scanned', status: 409, code: 'DOCUMENT_NOT_UPLOADED',
    detail: 'The document upload is not completed yet' },
  { sqlstate: '55000', message: 'Document is no longer awaiting a scan', status: 409, code: 'DOCUMENT_NOT_SCANNABLE',
    detail: 'The document is no longer awaiting a scan' },
  { sqlstate: '55000', message: 'Scan result does not match the current immutable document object', status: 409,
    code: 'OBJECT_VERSION_MISMATCH', detail: 'The scanned object is not the document\'s bound version and SHA-256' },
  { sqlstate: '55000', message: 'Document object scan has already reached a terminal result', status: 409,
    code: 'SCAN_ALREADY_TERMINAL', detail: 'The document object already has a terminal scan result' },
  { sqlstate: '23505', message: 'Scanner idempotency key payload mismatch', status: 409,
    code: 'SCAN_IDEMPOTENCY_CONFLICT', detail: 'The idempotency key was already used for another scan result' },
  { sqlstate: '42501', message: 'Authorized document scanner context is required', status: 403,
    code: 'DOCUMENT_SCANNER_FORBIDDEN', detail: 'The workload is not an authorized document scanner' },
  ...[
    'Invalid document scan event type',
    'Exact scanned object version and SHA-256 are required',
    'Invalid scanner idempotency key',
    'Invalid scanner provenance',
    'A supported detected media type is required for a clean scan',
    'A reason code is required for unsuccessful scans',
    'Invalid scanner reason code',
    'Invalid document scan target',
    'Invalid scan target list request',
  ].map((message): ScanRefusal => ({ sqlstate: '22023', message, status: 400, code: 'INVALID_SCAN_REQUEST',
    detail: message })),
];

/** The DomainProblem for a known scanner refusal, or the error itself. */
export function scanRefusalProblem(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return error;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || typeof message !== 'string') return error;
  const refusal = SCAN_REFUSALS.find(candidate => candidate.sqlstate === code && candidate.message === message);
  return refusal ? new DomainProblem(refusal.status, refusal.code, refusal.detail) : error;
}
