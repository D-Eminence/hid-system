// The import of the legacy medical history (owner decision 3 of 2026-10-16,
// ADR-067), without the database: what import-legacy-history.mjs checks
// before it asks ehr.import_legacy_medical_history to import, the transaction
// it runs that command in, and the deployment check both CLIs of the history
// pipeline make first. The command repeats every check of the runs and of
// each row's content and bindings itself (0099), with the same codes; it
// does not recompute the stager's checksums (ROW_TAMPERED, SEAL_MISMATCH,
// PARENT_SEAL_MISMATCH are this module's alone) but takes only rows equal to
// the sealed rows, whose seal the database's triggers keep. This module
// refuses earlier, so an operator learns what is wrong before anything is
// written.
//
// The history comes only from main's sealed staging pipeline: a parent run
// that is main's reconciled and verified legacy identity run (stage, promote,
// reconcile), and a history run of source system legacy_imported_history
// that stage-legacy-identity.mjs --scope=imported-history sealed from the
// same source snapshot. Every refusal is an ImportRefusal whose message is
// its code: never an identifier and never any content.
import { createHash } from 'node:crypto';

export const IMPORTED_HISTORY_ENTITY_TYPES = Object.freeze(['medical_records', 'medical_record_versions',
  'medical_record_files']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// A legacy timestamp as the stager writes it from the legacy database (ISO 8601 with a zone).
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$/;

/** The source system of a history run: never legacy_identity, whose staged runs close patient enrollment (0057). */
export const IMPORTED_HISTORY_SOURCE_SYSTEM = 'legacy_imported_history';

/**
 * The history pipeline runs on staging, or on an owned disposable rehearsal
 * (NODE_ENV test on a local Unix-socket cluster, reading a synthetic fixture
 * when `syntheticSourceOnly`), never in production. HID_DEPLOYMENT_ENV is the
 * operator's declaration of where the command runs; the database does not
 * enforce it (ADR-067, P38). Checked before anything is read or connected.
 * @param {string} what what is refused, for the message
 * @param {{ syntheticSourceOnly?: boolean, environment?: NodeJS.ProcessEnv }} [options]
 */
export function requireStagingOrRehearsal(what, { syntheticSourceOnly = false, environment = process.env } = {}) {
  const deployment = environment.HID_DEPLOYMENT_ENV ?? '';
  if (deployment === 'production') throw new Error(`${what} is refused in production (ADR-067)`);
  if (deployment === 'staging') return;
  let socket;
  try {
    socket = environment.DATABASE_URL ? new URL(environment.DATABASE_URL).searchParams.get('host') : null;
  } catch {
    socket = null;
  }
  if (deployment === '' && environment.NODE_ENV === 'test' && socket?.startsWith('/tmp/')
    && (!syntheticSourceOnly || (environment.MIGRATION_FIXTURE_PATH && !environment.LEGACY_DATABASE_URL))) return;
  throw new Error(`${what} runs only on staging or an owned rehearsal database`);
}

export class ImportRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'ImportRefusal';
    this.code = code;
  }
}

const refuse = (code) => { throw new ImportRefusal(code); };

/** The canonical JSON every legacy checksum is taken over (as stage-legacy-identity.mjs writes it). */
export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ImportRefusal('IMPORTED_HISTORY_ROW_TAMPERED');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new ImportRefusal('IMPORTED_HISTORY_ROW_TAMPERED');
}

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * The seal of staged history rows, exactly as the stager computes it: per
 * category, the count and the checksum over `source_pk:payload_sha256` lines
 * in source_pk order, and the checksum over both.
 * @param {ReadonlyArray<{ entity_type: string, source_pk: string, payload_sha256: string }>} rows
 */
export function sealSummary(rows) {
  const counts = {};
  const checksums = {};
  for (const entityType of IMPORTED_HISTORY_ENTITY_TYPES) {
    const aggregate = createHash('sha256');
    const entityRows = rows.filter((row) => row.entity_type === entityType)
      .sort((left, right) => (left.source_pk < right.source_pk ? -1 : 1));
    for (const row of entityRows) aggregate.update(`${row.source_pk}:${String(row.payload_sha256).trim()}\n`, 'utf8');
    counts[entityType] = entityRows.length;
    checksums[entityType] = aggregate.digest('hex');
  }
  return { counts, checksums, overallChecksum: sha256(canonicalJson({ counts, checksums })) };
}

const text = (value) => (typeof value === 'string' ? value : null);
const isTimestamp = (value) => typeof value === 'string' && TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
const hasText = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Checks a parent run, a history run and their rows, and returns what the
 * import command receives (`rows`, exactly the sealed rows) and what it will
 * import, with each author's account and the record's origin resolved through
 * the parent's sealed identity rows.
 * @param {{
 *   parent: Record<string, unknown>, history: Record<string, unknown>, parentChecksum: string,
 *   parentRows: ReadonlyArray<{ entity_type: string, source_pk: string, payload: Record<string, unknown> }>,
 *   historyRows: ReadonlyArray<{ entity_type: string, source_pk: string, payload: Record<string, unknown>,
 *     payload_sha256: string }>,
 * }} input
 */
export function prepareImportedHistory({ parent, history, parentChecksum, parentRows, historyRows }) {
  // The parent: main's reconciled, verified legacy identity run, without conflicts, as the operator names it.
  if (!parent || parent.source_system !== 'legacy_identity' || parent.mode !== 'reconcile' || parent.status !== 'verified'
    || !SHA256.test(String(parent.source_checksum_sha256 ?? '').trim()) || Number(parent.conflicts ?? 0) !== 0) {
    refuse('IMPORTED_HISTORY_PARENT_NOT_VERIFIED');
  }
  if (String(parent.source_checksum_sha256).trim() !== parentChecksum) refuse('IMPORTED_HISTORY_PARENT_SEAL_MISMATCH');

  // The history: a sealed staging run of the same snapshot, of exactly the three categories.
  if (!history || history.id === parent.id || history.source_system !== IMPORTED_HISTORY_SOURCE_SYSTEM
    || history.mode !== 'stage'
    || history.status !== 'staged' || !SHA256.test(String(history.source_checksum_sha256 ?? '').trim())
    || Number(history.conflicts ?? 0) !== 0) {
    refuse('IMPORTED_HISTORY_RUN_NOT_SEALED');
  }
  if (history.source_snapshot !== parent.source_snapshot) refuse('IMPORTED_HISTORY_SNAPSHOT_MISMATCH');
  const sealedCounts = history.source_counts;
  if (!sealedCounts || typeof sealedCounts !== 'object' || Array.isArray(sealedCounts)
    || Object.keys(sealedCounts).sort().join(',') !== [...IMPORTED_HISTORY_ENTITY_TYPES].sort().join(',')
    || IMPORTED_HISTORY_ENTITY_TYPES.some((type) => !Number.isSafeInteger(sealedCounts[type]))
    || historyRows.some((row) => !IMPORTED_HISTORY_ENTITY_TYPES.includes(row.entity_type))) {
    refuse('IMPORTED_HISTORY_CATEGORY_MISMATCH');
  }
  // Each row as sealed: its payload's checksum, then the run's seal over all of them.
  for (const row of historyRows) {
    if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)
      || sha256(canonicalJson(row.payload)) !== String(row.payload_sha256).trim()) {
      refuse('IMPORTED_HISTORY_ROW_TAMPERED');
    }
  }
  const seal = sealSummary(historyRows);
  const keys = new Set(historyRows.map((row) => `${row.entity_type}\u0000${row.source_pk}`));
  if (keys.size !== historyRows.length || seal.overallChecksum !== String(history.source_checksum_sha256).trim()
    || IMPORTED_HISTORY_ENTITY_TYPES.some((type) => seal.counts[type] !== sealedCounts[type])) {
    refuse('IMPORTED_HISTORY_SEAL_MISMATCH');
  }

  // The parent's sealed identity rows, by legacy id.
  const parentByType = (type) => new Map(parentRows.filter((row) => row.entity_type === type)
    .map((row) => [row.source_pk, row.payload]));
  const accounts = parentByType('accounts');
  const profiles = parentByType('user_profiles');
  const patients = parentByType('patients');
  // Staff ids by their legacy account, and the history's rows by key, built
  // once: every check below is a lookup, so the checks grow with the rows.
  const staffByAccount = new Map();
  for (const [id, row] of parentByType('staff')) {
    const account = text(row.auth_user_id);
    if (account !== null) staffByAccount.set(account, [...(staffByAccount.get(account) ?? []), id]);
  }
  const byType = (type) => historyRows.filter((row) => row.entity_type === type)
    .sort((left, right) => (left.source_pk < right.source_pk ? -1 : 1));
  const recordRows = byType('medical_records');
  const versionRows = byType('medical_record_versions');
  const fileRows = byType('medical_record_files');
  const recordsById = new Map(recordRows.map((row) => [row.source_pk, row.payload]));
  const versionsById = new Map(versionRows.map((row) => [row.source_pk, row.payload]));
  const versionNumberKey = (payload) => JSON.stringify([payload.record_id, payload.version_no]);
  const versionNumberUses = new Map();
  for (const { payload } of versionRows) {
    versionNumberUses.set(versionNumberKey(payload), (versionNumberUses.get(versionNumberKey(payload)) ?? 0) + 1);
  }

  /** The account of a legacy user profile the parent staged, whose account the parent staged too. */
  const profileAccount = (profileId) => {
    const profile = typeof profileId === 'string' ? profiles.get(profileId) : undefined;
    const account = text(profile?.auth_user_id);
    return account && UUID.test(account) && accounts.has(account) ? account : null;
  };
  /** The author's account and the origin: the patient themself, or exactly one staff member of the parent. */
  const author = (patientAccount, payload) => {
    const account = profileAccount(payload.created_by_user_profile_id);
    if (!account) refuse('IMPORTED_HISTORY_AUTHOR_UNRESOLVED');
    const staffId = payload.created_by_staff_account_id ?? null;
    if (account === patientAccount && staffId === null) return { account, origin: 'patient-provided' };
    const staffIds = staffByAccount.get(account) ?? [];
    if (account !== patientAccount && (staffId === null ? staffIds.length === 1 : staffIds.includes(staffId))) {
      return { account, origin: 'provider-authored' };
    }
    return refuse('IMPORTED_HISTORY_AUTHOR_UNRESOLVED');
  };
  const patientAccountOf = (patientId) => {
    const account = text(patients.get(patientId)?.auth_user_id);
    return account ?? null;
  };

  const records = recordRows.map(({ source_pk: id, payload }) => {
    if (!UUID.test(id) || payload.id !== id || !UUID.test(text(payload.patient_id) ?? '')
      || !UUID.test(text(payload.current_version_id) ?? '') || !isTimestamp(payload.created_at)
      || !isTimestamp(payload.updated_at)) {
      refuse('IMPORTED_HISTORY_RECORD_INVALID');
    }
    const patientAccount = patientAccountOf(payload.patient_id);
    if (!patientAccount) refuse('IMPORTED_HISTORY_BINDING_DIFFERS');
    const resolved = author(patientAccount, payload);
    const current = versionsById.get(payload.current_version_id);
    if (!current || current.record_id !== id) refuse('IMPORTED_HISTORY_BINDING_DIFFERS');
    return { id, patientId: payload.patient_id, authorAccountId: resolved.account, origin: resolved.origin,
      currentVersionId: payload.current_version_id };
  });

  const versions = versionRows.map(({ source_pk: id, payload }) => {
    const record = typeof payload.record_id === 'string' ? recordsById.get(payload.record_id) : undefined;
    if (!UUID.test(id) || payload.id !== id || !record) refuse('IMPORTED_HISTORY_BINDING_DIFFERS');
    const numbered = versionNumberUses.get(versionNumberKey(payload));
    if (!Number.isSafeInteger(payload.version_no) || !/^[1-9][0-9]{0,8}$/.test(String(payload.version_no))
      || !isTimestamp(payload.created_at) || numbered !== 1
      || !(hasText(payload.record) || hasText(payload.notes) || hasText(payload.transcription_text)
        || (payload.structured_data && typeof payload.structured_data === 'object' && !Array.isArray(payload.structured_data)
          && Object.keys(payload.structured_data).length > 0))) {
      refuse('IMPORTED_HISTORY_VERSION_INVALID');
    }
    const resolved = author(patientAccountOf(record.patient_id), payload);
    return { id, recordId: payload.record_id, versionNo: payload.version_no, authorAccountId: resolved.account,
      origin: resolved.origin };
  });

  const files = fileRows.map(({ source_pk: id, payload }) => {
    const record = typeof payload.record_id === 'string' ? recordsById.get(payload.record_id) : undefined;
    const versionId = payload.record_version_id ?? null;
    if (!UUID.test(id) || payload.id !== id || !record || payload.patient_id !== record.patient_id
      || (versionId !== null && versionsById.get(versionId)?.record_id !== payload.record_id)) {
      refuse('IMPORTED_HISTORY_BINDING_DIFFERS');
    }
    if (!isTimestamp(payload.created_at) || !Number.isSafeInteger(payload.size_bytes)
      || !/^[0-9]{1,15}$/.test(String(payload.size_bytes)) || typeof payload.original_file_name !== 'string'
      || typeof payload.mime_type !== 'string') {
      refuse('IMPORTED_HISTORY_FILE_INVALID');
    }
    const uploader = profileAccount(payload.uploaded_by_user_profile_id);
    if (!uploader) refuse('IMPORTED_HISTORY_AUTHOR_UNRESOLVED');
    return { id, recordId: payload.record_id, recordVersionId: versionId, uploaderAccountId: uploader };
  });

  const rows = IMPORTED_HISTORY_ENTITY_TYPES.flatMap((type) => byType(type).map((row) => ({ entityType: row.entity_type,
    sourcePk: row.source_pk, payload: row.payload, payloadSha256: String(row.payload_sha256).trim() })));
  return { counts: seal.counts, records, versions, files, rows,
    historyChecksum: String(history.source_checksum_sha256).trim() };
}

/**
 * Runs `operation` in one transaction as hid_migration_admin, the only role
 * that may execute the import. The administrator takes a SET-only membership
 * in it for this transaction and gives it up before the transaction ends, so
 * none is ever left behind (as runtime-grants.sql does for its technical
 * owners). A dry run rolls everything back; an apply commits.
 * @template Result
 * @param {import('pg').Client} client
 * @param {{ apply: boolean }} options
 * @param {() => Promise<Result>} operation
 * @returns {Promise<Result>}
 */
export async function withImportTransaction(client, { apply }, operation) {
  await client.query('begin');
  try {
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '300s'");
    await client.query("select pg_advisory_xact_lock(hashtextextended('hid-imported-history-import', 0))");
    const administrator = (await client.query('select current_user as name')).rows[0].name;
    await client.query('grant hid_migration_admin to current_user with inherit false, set true');
    await client.query('set local role hid_migration_admin');
    // A failed operation aborts the transaction; the rollback below ends the
    // role and the membership with it.
    const result = await operation();
    await client.query('reset role');
    await client.query(`revoke hid_migration_admin from ${quoteIdentifier(administrator)}`);
    // The administrator that created the role keeps its ADMIN OPTION (on RDS,
    // without SET or INHERIT); only a membership that lets it act as the role
    // must be gone.
    const left = await client.query(`select count(*)::int as n from pg_auth_members
      where roleid = 'hid_migration_admin'::regrole and member = (select oid from pg_roles where rolname = $1)
        and (inherit_option or set_option)`, [administrator]);
    if (left.rows[0].n !== 0) throw new Error('The migration administrator membership was not given up');
    await client.query(apply ? 'commit' : 'rollback');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

function quoteIdentifier(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}
