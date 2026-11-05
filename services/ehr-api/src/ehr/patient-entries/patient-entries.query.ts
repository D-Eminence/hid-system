import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import { isCalendarTimestamp, timelineCursorSql } from '../shared/clinical-context';
import type { PatientEntryKind } from './patient-entries.dto';

/** One record the patient added, as the records answer and the staff read list it. */
export interface PatientEntryItem {
  id: string;
  source: 'patient';
  kind: PatientEntryKind;
  title: string;
  facilityName: string | null;
  /** YYYY-MM-DD, the calendar date as entered. */
  occurredOn: string;
  notes: string | null;
  createdAt: string;
  /**
   * The record's confirmed photos and files (0117), oldest first; empty while
   * PATIENT_ENTRY_FILES_ENABLED is off (attachPatientEntryDocuments is not run).
   */
  documents: PatientEntryDocumentItem[];
}

/** One confirmed file on a record the patient added (0117), as the records answer lists it. */
export interface PatientEntryDocumentItem {
  id: string;
  fileName: string;
  mediaType: 'image/jpeg' | 'image/png' | 'application/pdf';
  sizeBytes: number;
  /** uploaded, available (scanned clean) or rejected. */
  status: 'uploaded' | 'available' | 'rejected';
  /** pending until the scanner's result, then clean or rejected; any other scanner state reads pending. */
  scanStatus: 'pending' | 'clean' | 'rejected';
  createdAt: string;
}

export interface PatientEntryPage {
  items: PatientEntryItem[];
  more: boolean;
  /** The cursor of the page after this one (GET ehr/me/patient-entries?before=), or null at the end. */
  nextBefore: string | null;
}

/** Where a page of the list starts: after the entry with this date, time added and id. */
export interface PatientEntryPosition {
  occurredOn: string;
  /** UTC with microseconds, as timelineCursorSql renders it. */
  createdAt: string;
  id: string;
}

export const PATIENT_ENTRIES_LIMIT = 50;

interface PatientEntryRow {
  id: string;
  kind: PatientEntryKind;
  title: string;
  facility_name: string | null;
  occurred_on: string;
  notes: string | null;
  created_at: Date | string;
}

export function patientEntryItem(row: PatientEntryRow): PatientEntryItem {
  return { id: row.id, source: 'patient', kind: row.kind, title: row.title, facilityName: row.facility_name,
    occurredOn: row.occurred_on, notes: row.notes, createdAt: new Date(row.created_at).toISOString(), documents: [] };
}

/** The scanner's state as the website reads it: clean and rejected are final, anything else is still pending. */
export function patientDocumentScanStatus(scanStatus: string | null | undefined): PatientEntryDocumentItem['scanStatus'] {
  return scanStatus === 'clean' || scanStatus === 'rejected' ? scanStatus : 'pending';
}

interface PatientEntryDocumentRow {
  id: string;
  entry_id: string;
  original_file_name: string;
  media_type: PatientEntryDocumentItem['mediaType'];
  size_bytes: string;
  status: PatientEntryDocumentItem['status'];
  scan_status: string;
  created_at: Date | string;
}

/**
 * Fills each listed record's documents with its confirmed files (0117),
 * oldest first, at most 5 a record, read through the effective view under the
 * reader's row-level security: the patient's own, or a clinician whose access
 * is granted, and never a removed record's (0117's read policy). Only while
 * PATIENT_ENTRY_FILES_ENABLED is on: the callers do not run it while off, so
 * nothing names the new objects.
 */
export async function attachPatientEntryDocuments(client: Pick<PoolClient, 'query'>, patientId: string,
  items: PatientEntryItem[]): Promise<PatientEntryItem[]> {
  if (items.length === 0) return items;
  const rows = (await client.query<PatientEntryDocumentRow>(`select id, entry_id, original_file_name,
      coalesce(detected_media_type, declared_media_type) as media_type, size_bytes::text as size_bytes, status,
      scan_status, created_at
    from ehr.patient_entry_documents_effective
    where patient_id = $1 and entry_id = any($2::uuid[]) and object_version_id is not null
      and status in ('uploaded', 'available', 'rejected')
    order by entry_id, created_at, id`, [patientId, items.map((item) => item.id)])).rows;
  const byEntry = new Map<string, PatientEntryDocumentItem[]>();
  for (const row of rows) {
    const list = byEntry.get(row.entry_id) ?? [];
    if (list.length >= 5) continue;
    list.push({ id: row.id, fileName: row.original_file_name, mediaType: row.media_type, sizeBytes: Number(row.size_bytes),
      status: row.status, scanStatus: patientDocumentScanStatus(row.scan_status),
      createdAt: new Date(row.created_at).toISOString() });
    byEntry.set(row.entry_id, list);
  }
  return items.map((item) => ({ ...item, documents: byEntry.get(item.id) ?? [] }));
}

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written YYYY-MM-DD. */
export function realDate(text: string): boolean {
  const parts = CALENDAR_DATE.exec(text);
  if (!parts) return false;
  const [, year, month, day] = parts;
  const value = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  value.setUTCFullYear(Number(year));
  return value.toISOString().slice(0, 10) === text;
}

/*
 * Opaque keyset cursors for the list (newest date first, then newest added,
 * then id), as the clinical record's timeline cursors are: a position, not a
 * credential (every page re-applies the reader's authorization), bound to the
 * patient whose list it pages, and accepted only exactly as issued. Anything
 * else answers 400 INVALID_CURSOR, which tells the client to load the list
 * again from the start.
 */
const CURSOR_VERSION = 1;
const CURSOR_LIST = 'ehr.patient-entries';
const MAX_CURSOR_LENGTH = 512;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function cursorBinding(patientId: string): string {
  return createHash('sha256').update(JSON.stringify([CURSOR_LIST, patientId.toLowerCase()]), 'utf8')
    .digest('base64url').slice(0, 22);
}

function validPosition(position: PatientEntryPosition): boolean {
  return realDate(position.occurredOn) && isCalendarTimestamp(position.createdAt) && CURSOR_ID.test(position.id);
}

function encodePatientEntryCursor(patientId: string, position: PatientEntryPosition): string {
  if (!validPosition(position)) throw new Error('A patient entry cursor needs a date, a microsecond UTC time and a lower-case UUID');
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, l: CURSOR_LIST, f: cursorBinding(patientId),
    d: position.occurredOn, t: position.createdAt, i: position.id }), 'utf8').toString('base64url');
}

function invalidCursor(): DomainProblem {
  return new DomainProblem(400, 'INVALID_CURSOR', 'This list changed. Load it again from the start.');
}

/** The position a cursor names for this patient's list, or 400 INVALID_CURSOR; undefined for the first page. */
export function decodePatientEntryCursor(value: string | undefined, patientId: string): PatientEntryPosition | undefined {
  if (value === undefined || value === '') return undefined;
  if (value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw invalidCursor();
  const { v, l, f, d, t, i } = decoded as Readonly<Record<string, unknown>>;
  if (v !== CURSOR_VERSION || l !== CURSOR_LIST || f !== cursorBinding(patientId)
    || typeof d !== 'string' || typeof t !== 'string' || typeof i !== 'string') throw invalidCursor();
  const position = { occurredOn: d, createdAt: t, id: i };
  // Only the exact issued encoding is accepted: no extra fields, padding or re-ordering.
  if (!validPosition(position) || encodePatientEntryCursor(patientId, position) !== value) throw invalidCursor();
  return position;
}

/**
 * One page of the patient's active entries, newest first (the date entered,
 * then when it was added, then id), 50 at a time, after `before` when given,
 * with whether there are more and the next page's cursor. Row-level security
 * (0116's read policy) limits the rows to the patient's own session or a
 * clinician whose access is granted; withdrawn ones are never read. The date
 * is read as text (node-postgres turns a date into local midnight) and the
 * cursor's time at the microsecond (a JavaScript date keeps milliseconds).
 */
export async function readPatientEntries(client: Pick<PoolClient, 'query'>, patientId: string,
  before?: PatientEntryPosition): Promise<PatientEntryPage> {
  const rows = (await client.query<PatientEntryRow & { cursor_at: string }>(`select id, kind, title, facility_name,
      occurred_on::text as occurred_on, notes, created_at, ${timelineCursorSql('created_at')} as cursor_at
    from ehr.patient_entries
    where patient_id = $1 and status = 'active'
      and ($2::date is null or (occurred_on, created_at, id) < ($2::date, $3::timestamptz, $4::uuid))
    order by occurred_on desc, created_at desc, id desc
    limit ${PATIENT_ENTRIES_LIMIT + 1}`,
  [patientId, before?.occurredOn ?? null, before?.createdAt ?? null, before?.id ?? null])).rows;
  const page = rows.slice(0, PATIENT_ENTRIES_LIMIT);
  const tail = rows.length > PATIENT_ENTRIES_LIMIT ? page.at(-1) : undefined;
  return { items: page.map(patientEntryItem), more: tail !== undefined,
    nextBefore: tail ? encodePatientEntryCursor(patientId, { occurredOn: tail.occurred_on, createdAt: tail.cursor_at,
      id: tail.id }) : null };
}

/**
 * The statement each chat runs at its next search, while PATIENT_ENTRIES_ENABLED
 * is on, in its own transaction: it deletes this patient's vectors of records
 * the patient removed from that chat's chunk table (the staff chat's, which the
 * removal cannot reach under that table's row-level security, and the
 * patient's, should a search that checked its sources before the removal write
 * them after it). Row-level security shows the transaction only active entries
 * of a patient it may read, and only chunks it may read, so an active entry's
 * vectors are kept. The database suite (patient-entries.integration.sql) runs
 * this exact text for both tables.
 */
export function withdrawnPatientEntryChunksSql(chunksTable: string): string {
  return `delete from ${chunksTable} chunk where chunk.patient_id = $1 and chunk.source_kind = 'patient_entry' and not exists (select 1 from ehr.patient_entries entry where entry.id = chunk.source_id and entry.patient_id = chunk.patient_id)`;
}

/**
 * The statement the chat runs at its next search, while
 * PATIENT_ENTRY_FILES_ENABLED is on, beside withdrawnPatientEntryChunksSql:
 * it deletes this patient's vectors of files (0117) that chat's row-level
 * security no longer shows as available (a removed record's files), so none
 * is kept once its record is gone. The database suite
 * (patient-entry-documents.integration.sql) runs this exact text.
 */
export function withdrawnPatientEntryDocumentChunksSql(chunksTable: string): string {
  return `delete from ${chunksTable} chunk where chunk.patient_id = $1 and chunk.source_kind = 'patient_entry_document' and not exists (select 1 from ehr.patient_entry_documents_effective file where file.id = chunk.source_id and file.patient_id = chunk.patient_id and file.status = 'available')`;
}
