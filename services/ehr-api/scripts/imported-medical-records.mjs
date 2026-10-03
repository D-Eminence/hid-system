import { canonicalJson, validateSealedSource } from './staging-cutover-additions.mjs';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function requireSource(condition, message) { if (!condition) throw new Error(message); }

// Errors never contain source IDs, titles, clinical text, file names or contacts.
export function prepareMedicalImport(rows, evidence, checksum) {
  const sealed = validateSealedSource(rows,evidence,checksum);
  const category = type => sealed.grouped.get(type) ?? [];
  for (const type of ['accounts','patients','user_profiles','staff','medical_records','medical_record_versions','medical_record_files']) {
    requireSource(sealed.grouped.has(type),'Missing clinical source category');
    for (const row of category(type)) requireSource(uuid(row.payload.id) && row.source_pk === row.payload.id,'Source identifier mismatch');
  }
  const patients = new Map(category('patients').map(r => [r.source_pk,r.payload]));
  const profiles = new Map(category('user_profiles').map(r => [r.source_pk,r.payload]));
  const accounts = new Set(category('accounts').map(r => r.source_pk));
  const staff = new Map(category('staff').map(r => [r.source_pk,r.payload]));
  const sourceRecords = new Map(category('medical_records').map(r => [r.source_pk,r.payload]));
  const sourceVersions = new Map(category('medical_record_versions').map(r => [r.source_pk,r.payload]));
  function author(source, patient, profileField = 'created_by_user_profile_id') {
    const profile = profiles.get(source[profileField]);
    requireSource(profile && uuid(profile.auth_user_id) && accounts.has(profile.auth_user_id),'Clinical author account is unresolved');
    const patientProvided = patient.user_profile_id === profile.id;
    if (patientProvided) {
      requireSource(patient.auth_user_id === profile.auth_user_id && !source.created_by_staff_account_id,'Patient author association differs');
    } else {
      const candidates = source.created_by_staff_account_id
        ? [staff.get(source.created_by_staff_account_id)].filter(Boolean)
        : [...staff.values()].filter(s => s.user_profile_id === profile.id && s.auth_user_id === profile.auth_user_id);
      requireSource(candidates.length === 1 && candidates[0].user_profile_id === profile.id
        && candidates[0].auth_user_id === profile.auth_user_id,'Provider author association is ambiguous');
    }
    return { accountId: profile.auth_user_id, origin: patientProvided ? 'patient-provided' : 'provider-authored' };
  }
  const records = category('medical_records').map(row => {
    const s = row.payload; const patient = patients.get(s.patient_id);
    requireSource(patient && uuid(s.current_version_id) && sourceVersions.get(s.current_version_id)?.record_id === s.id,'Record patient/current version binding differs');
    requireSource(timestamp(s.created_at) && timestamp(s.updated_at),'Record source timestamp missing');
    return { row, patientId:s.patient_id, author:author(s,patient) };
  });
  const versionNumbers = new Set();
  const versions = category('medical_record_versions').map(row => {
    const s = row.payload; const record = sourceRecords.get(s.record_id); const patient = patients.get(record?.patient_id);
    requireSource(record && patient && Number.isSafeInteger(s.version_no) && s.version_no > 0
      && !versionNumbers.has(`${s.record_id}:${s.version_no}`) && timestamp(s.created_at),'Version binding/number/time differs');
    versionNumbers.add(`${s.record_id}:${s.version_no}`);
    requireSource([s.record,s.notes,s.transcription_text].some(v => typeof v === 'string' && v.trim())
      || (s.structured_data && typeof s.structured_data === 'object' && Object.keys(s.structured_data).length),'Version has no clinical content');
    return { row, patientId:record.patient_id, author:author(s,patient) };
  });
  const files = category('medical_record_files').map(row => {
    const s = row.payload; const record = sourceRecords.get(s.record_id);
    requireSource(record && s.patient_id === record.patient_id && (!s.record_version_id
      || sourceVersions.get(s.record_version_id)?.record_id === s.record_id),'File patient/record/version binding differs');
    requireSource(timestamp(s.created_at) && Number.isSafeInteger(s.size_bytes) && s.size_bytes >= 0
      && typeof s.storage_bucket === 'string' && s.storage_bucket && typeof s.storage_path === 'string' && s.storage_path
      && (!s.sha256_hex || /^[a-f0-9]{64}$/i.test(s.sha256_hex)),'File metadata is incomplete');
    const profile = profiles.get(s.uploaded_by_user_profile_id);
    requireSource(profile && accounts.has(profile.auth_user_id),'File uploader account is unresolved');
    return { row, patientId:record.patient_id, uploaderAccountId:profile.auth_user_id };
  });
  return { ...sealed,records,versions,files };
}

export function assertExactImportedRow(actual, expected) {
  const normalized = Object.fromEntries(Object.keys(expected).map(key => [key,
    actual?.[key] instanceof Date ? actual[key].toISOString() : actual?.[key]]));
  if (canonicalJson(normalized) !== canonicalJson(expected)) throw new Error('Imported history differs; no overwrite is permitted');
}
