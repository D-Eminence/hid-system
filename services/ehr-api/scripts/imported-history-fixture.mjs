// Invented data only: no row here was extracted from any customer system.
// The synthetic legacy history (owner decision 3 of 2026-10-16, ADR-065) that
// the importer tests and rehearsals stage and import. Identifiers are in the
// e7 range, which no other suite or fixture uses.
import { createHash } from 'node:crypto';

export const historyIds = Object.freeze({
  parentRun: 'e7000000-0000-4000-8000-000000000001',
  historyRun: 'e7000000-0000-4000-8000-000000000002',
  tamperedRun: 'e7000000-0000-4000-8000-000000000003',
  patientProfile: 'e7100000-0000-4000-8000-000000000001',
  staffProfile: 'e7100000-0000-4000-8000-000000000002',
  records: ['e7200000-0000-4000-8000-000000000001', 'e7200000-0000-4000-8000-000000000002',
    'e7200000-0000-4000-8000-000000000003'],
  versions: ['e7300000-0000-4000-8000-000000000001', 'e7300000-0000-4000-8000-000000000002',
    'e7300000-0000-4000-8000-000000000003', 'e7300000-0000-4000-8000-000000000004'],
  files: ['e7400000-0000-4000-8000-000000000001'],
});

const created = '2025-03-01T08:00:00.000Z';
const updated = '2025-03-02T08:00:00.000Z';
const row = (payload, updatedAt = updated) => ({ source_pk: payload.id, source_updated_at: updatedAt, payload });

/**
 * The legacy identity fixture with the user profiles the history's authors
 * resolve through: one for the patient's account and one for the staff
 * member's. Every other category is the given fixture's.
 * @param {Record<string, Array<{ source_pk: string, payload: Record<string, unknown> }>>} identity
 * @param {{ patientAccount: string, staffAccount: string }} accounts
 */
export function identityFixtureWithProfiles(identity, accounts) {
  const profiles = [
    row({ id: historyIds.patientProfile, auth_user_id: accounts.patientAccount, display_name: 'Synthetic patient profile',
      app_role: 'patient', created_at: created, updated_at: updated }),
    row({ id: historyIds.staffProfile, auth_user_id: accounts.staffAccount, display_name: 'Synthetic clinician profile',
      app_role: 'doctor', created_at: created, updated_at: updated }),
  ];
  return { ...identity, user_profiles: [...(identity.user_profiles ?? []), ...profiles]
    .sort((left, right) => left.source_pk.localeCompare(right.source_pk)) };
}

/**
 * Three legacy records of one patient: two the patient wrote (the first with
 * two versions and a file), one a clinician wrote. The content is invented.
 * @param {{ patient: string, staff: string }} identity the patient's and the
 *   staff member's legacy ids, as the identity fixture stages them.
 * @param {{ title?: string }} [changes] a different title for the first
 *   record, for the tamper rehearsal.
 */
export function syntheticHistoryFixture(identity, changes = {}) {
  const [first, second, third] = historyIds.records;
  const [v1, v2, v3, v4] = historyIds.versions;
  const record = (id, versionId, author, staff, title, at) => row({
    id, patient_id: identity.patient, current_version_id: versionId, title, category: 'history', info_type: 'text',
    created_by_user_profile_id: author, created_by_staff_account_id: staff, created_at: at, updated_at: updated });
  const version = (id, recordId, versionNo, author, staff, content, at) => row({
    id, record_id: recordId, version_no: versionNo, created_by_user_profile_id: author, created_by_staff_account_id: staff,
    record: content, notes: null, structured_data: { synthetic: true, sequence: versionNo }, transcription_text: null,
    created_at: at }, at);
  return {
    medical_records: [
      record(first, v2, historyIds.patientProfile, null, changes.title ?? 'Synthetic childhood history', created),
      record(second, v3, historyIds.patientProfile, null, 'Synthetic allergy note (patient-reported)',
        '2025-03-01T09:00:00.000Z'),
      record(third, v4, historyIds.staffProfile, identity.staff, 'Synthetic clinic letter', '2025-03-01T10:00:00.000Z'),
    ],
    medical_record_versions: [
      version(v1, first, 1, historyIds.patientProfile, null, 'Invented first account of a synthetic history.', created),
      version(v2, first, 2, historyIds.patientProfile, null, 'Invented revised account of a synthetic history.',
        '2025-03-01T08:30:00.000Z'),
      version(v3, second, 1, historyIds.patientProfile, null, 'Invented patient-reported text.', '2025-03-01T09:00:00.000Z'),
      version(v4, third, 1, historyIds.staffProfile, identity.staff, 'Invented clinic letter text.',
        '2025-03-01T10:00:00.000Z'),
    ],
    medical_record_files: [row({
      id: historyIds.files[0], patient_id: identity.patient, record_id: first, record_version_id: v2,
      uploaded_by_user_profile_id: historyIds.patientProfile, original_file_name: 'synthetic-history.txt',
      mime_type: 'text/plain', size_bytes: 19, sha256_hex: null, storage_bucket: 'synthetic-private',
      storage_path: 'synthetic/history-1', created_at: created }, created)],
  };
}

/** The canonical JSON every legacy checksum is taken over (as stage-legacy-identity.mjs writes it). */
function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/**
 * A fixture's rows as migration.source_rows holds them after staging, and the
 * seal the stager writes for them, for tests that need no database.
 * @param {Record<string, Array<{ source_pk: string, payload: Record<string, unknown> }>>} fixture
 * @param {readonly string[]} entityTypes
 */
export function stagedRows(fixture, entityTypes) {
  const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
  const rows = [];
  const counts = {};
  const checksums = {};
  for (const entityType of entityTypes) {
    const aggregate = createHash('sha256');
    const entityRows = [...(fixture[entityType] ?? [])].sort((left, right) => (left.source_pk < right.source_pk ? -1 : 1));
    for (const item of entityRows) {
      const payloadSha256 = sha(canonicalJson(item.payload));
      aggregate.update(`${item.source_pk}:${payloadSha256}\n`, 'utf8');
      rows.push({ entity_type: entityType, source_pk: item.source_pk, payload: item.payload, payload_sha256: payloadSha256 });
    }
    counts[entityType] = entityRows.length;
    checksums[entityType] = aggregate.digest('hex');
  }
  return { rows, counts, checksums, overallChecksum: sha(canonicalJson({ counts, checksums })) };
}
