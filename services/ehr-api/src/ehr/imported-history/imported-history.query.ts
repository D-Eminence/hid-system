import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import { type TimelineCursor, type TimelineScope, timelineCursorSql, timelinePage } from '../shared/clinical-context';

/**
 * The read of the imported legacy medical history (owner decision 3 of
 * 2026-10-16, ADR-067, 0099), shared by the patient's own route (through
 * PatientRecordRelease.readImportedHistory) and the staff route (through
 * ClinicalRepository). Row-level security decides whose rows a transaction
 * sees; the SELECT list below decides which fields leave the database. Only
 * the allowlisted, typed fields of the legacy row are read: never the stored
 * legacy row as a whole, its checksum, the sealed staging run, the legacy
 * author's or uploader's account, or any storage location.
 */

/** Records a page shows, and each record's versions and files, at most; one more of each is read. */
export const IMPORTED_HISTORY_LIMITS = Object.freeze({ records: 50, versionsPerRecord: 20, filesPerRecord: 20 });

/** The cursor lists of the two routes: a cursor of one is refused by the other. */
export const IMPORTED_HISTORY_LISTS = Object.freeze({ self: 'imported-history:self', staff: 'imported-history:staff' });

/**
 * What a patient's file is, until imported files are verified (ADR-067: no
 * attachment, scan evidence or download is part of this change).
 */
export const IMPORTED_FILE_ACCESS = 'pending-safety-verification' as const;

export interface ImportedVersion {
  id: string;
  versionNo: number;
  origin: string;
  createdAt: string;
  record: string | null;
  notes: string | null;
  structuredData: Record<string, unknown> | null;
  transcriptionText: string | null;
}

export interface ImportedFile {
  id: string;
  recordVersionId: string | null;
  fileName: string | null;
  mediaType: string | null;
  sizeBytes: number | null;
  createdAt: string;
  accessStatus: typeof IMPORTED_FILE_ACCESS;
}

export interface ImportedRecord {
  id: string;
  origin: string;
  title: string | null;
  category: string | null;
  infoType: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  currentVersionId: string;
  versions: ImportedVersion[];
  versionsTruncated: boolean;
  files: ImportedFile[];
  filesTruncated: boolean;
}

export interface ImportedHistoryPage {
  records: ImportedRecord[];
  truncated: { records: boolean };
  nextCursor: string | null;
}

interface ImportedRecordRow {
  id: string;
  origin: string;
  title: string | null;
  category: string | null;
  infoType: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  currentVersionId: string;
  cursorAt: string;
  versions: ImportedVersion[] | null;
  files: Omit<ImportedFile, 'accessStatus'>[] | null;
}

/**
 * Database refusals of the read: a privilege, a relation, a function or a
 * column that is not there, or the statement timeout.
 */
const REFUSED_READ = new Set(['42501', '42P01', '42883', '42703', '57014']);

/**
 * A database refusal of the read or of the staff decision as 503
 * IMPORTED_HISTORY_UNAVAILABLE (nothing is returned); any other error as it is.
 */
export function refusedImportedHistoryRead(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && REFUSED_READ.has(code)) {
    return new DomainProblem(503, 'IMPORTED_HISTORY_UNAVAILABLE', 'Imported medical history is unavailable');
  }
  return error;
}

/** A legacy text field: the string the legacy row holds, or null for anything else. */
const text = (alias: string, field: string) =>
  `case when jsonb_typeof(${alias}.source_payload->'${field}')='string' then ${alias}.source_payload->>'${field}' end`;
/** A UTC timestamp at the millisecond, as the records' own Date fields serialize. */
const utc = (column: string) => `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * One page of records, newest first, each with its newest versions and its
 * first files. $1 is the patient; with a cursor, $2 and $3 are its position.
 */
export function importedHistorySql(withCursor: boolean): string {
  return `select r.id,r.origin,${text('r', 'title')} as title,${text('r', 'category')} as category,
    ${text('r', 'info_type')} as "infoType",r.source_created_at as "createdAt",r.source_updated_at as "updatedAt",
    r.current_version_id as "currentVersionId",${timelineCursorSql('r.source_created_at')} as "cursorAt",
    (select json_agg(json_build_object('id',v.id,'versionNo',v.version_no,'origin',v.origin,
        'createdAt',${utc('v.source_created_at')},'record',${text('v', 'record')},'notes',${text('v', 'notes')},
        'structuredData',case when jsonb_typeof(v.source_payload->'structured_data')='object'
          then v.source_payload->'structured_data' end,
        'transcriptionText',${text('v', 'transcription_text')}) order by v.version_no desc)
       from (select * from ehr.imported_medical_record_versions version_row
              where version_row.record_id=r.id and version_row.patient_id=r.patient_id
              order by version_row.version_no desc limit ${IMPORTED_HISTORY_LIMITS.versionsPerRecord + 1}) v) as versions,
    (select json_agg(json_build_object('id',f.id,'recordVersionId',f.record_version_id,
        'fileName',${text('f', 'original_file_name')},'mediaType',${text('f', 'mime_type')},
        'sizeBytes',case when (f.source_payload->>'size_bytes')~'^[0-9]{1,15}$'
          then (f.source_payload->>'size_bytes')::bigint end,
        'createdAt',${utc('f.source_created_at')}) order by f.source_created_at,f.id)
       from (select * from ehr.imported_medical_record_files file_row
              where file_row.record_id=r.id and file_row.patient_id=r.patient_id
              order by file_row.source_created_at,file_row.id limit ${IMPORTED_HISTORY_LIMITS.filesPerRecord + 1}) f) as files
    from ehr.imported_medical_records r
    where r.patient_id=$1${withCursor ? ' and (r.source_created_at,r.id)<($2::timestamptz,$3::uuid)' : ''}
    order by r.source_created_at desc,r.id desc
    limit ${IMPORTED_HISTORY_LIMITS.records + 1}`;
}

/**
 * Reads one page of the patient's imported history in the caller's
 * transaction. A read the database refuses or times out is 503
 * IMPORTED_HISTORY_UNAVAILABLE, and nothing is returned. A staff transaction
 * has bound the patient first (ImportedHistoryService.staff).
 */
export async function readImportedHistory(client: PoolClient, patientId: string, cursor: TimelineCursor | undefined,
  list: string = IMPORTED_HISTORY_LISTS.self): Promise<ImportedHistoryPage> {
  const values = cursor ? [patientId, cursor.sortAt, cursor.id] : [patientId];
  let rows: ImportedRecordRow[];
  try {
    rows = (await client.query<ImportedRecordRow>(importedHistorySql(Boolean(cursor)), values)).rows;
  } catch (error) {
    throw refusedImportedHistoryRead(error);
  }
  const scope: TimelineScope = { list, patientId };
  const page = timelinePage(rows, IMPORTED_HISTORY_LIMITS.records, scope);
  return {
    records: page.items.map(importedRecord),
    truncated: { records: page.nextCursor !== null },
    nextCursor: page.nextCursor,
  };
}

function importedRecord(row: Omit<ImportedRecordRow, 'cursorAt'>): ImportedRecord {
  const versions = row.versions ?? [];
  const files = row.files ?? [];
  return {
    id: row.id, origin: row.origin, title: row.title ?? null, category: row.category ?? null,
    infoType: row.infoType ?? null, createdAt: row.createdAt, updatedAt: row.updatedAt,
    currentVersionId: row.currentVersionId,
    versions: versions.slice(0, IMPORTED_HISTORY_LIMITS.versionsPerRecord).map((version) => ({
      id: version.id, versionNo: version.versionNo, origin: version.origin, createdAt: version.createdAt,
      record: version.record ?? null, notes: version.notes ?? null, structuredData: version.structuredData ?? null,
      transcriptionText: version.transcriptionText ?? null,
    })),
    versionsTruncated: versions.length > IMPORTED_HISTORY_LIMITS.versionsPerRecord,
    files: files.slice(0, IMPORTED_HISTORY_LIMITS.filesPerRecord).map((file) => ({
      id: file.id, recordVersionId: file.recordVersionId ?? null, fileName: file.fileName ?? null,
      mediaType: file.mediaType ?? null, sizeBytes: file.sizeBytes ?? null, createdAt: file.createdAt,
      accessStatus: IMPORTED_FILE_ACCESS,
    })),
    filesTruncated: files.length > IMPORTED_HISTORY_LIMITS.filesPerRecord,
  };
}

/** The counts-only audit details of a page. */
export function importedHistoryAuditCounts(page: Pick<ImportedHistoryPage, 'records' | 'truncated'>) {
  return {
    recordCount: page.records.length,
    versionCount: page.records.reduce((total, record) => total + record.versions.length, 0),
    fileCount: page.records.reduce((total, record) => total + record.files.length, 0),
    healthProfile: false,
    truncated: page.truncated.records,
  };
}
