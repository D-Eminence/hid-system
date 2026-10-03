import { createHash } from 'node:crypto';
import { validLegacyPinHash } from './legacy-pin-hash.mjs';

export function canonicalJson(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item)).join(',') + '}';
  throw new Error('Unsupported sealed source value');
}
export function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
export function deterministicUuid(namespace) {
  const bytes = createHash('sha256').update(namespace).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const time = value => typeof value === 'string' && Number.isFinite(new Date(value).valueOf());

// Validate every category, including clinical preservation, before deriving
// additions. Never alter the existing sealed run or infer absent source data.
export function validateSealedSource(rows, evidence, expectedChecksum) {
  if (!/^[a-f0-9]{64}$/.test(expectedChecksum ?? '')
    || evidence.sourceChecksum !== expectedChecksum) throw new Error('Unexpected parent snapshot checksum');
  const grouped = new Map();
  const counts = {}; const checksums = {};
  for (const [type, count] of Object.entries(evidence.sourceCounts ?? {})) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid sealed source counts');
    grouped.set(type, []);
  }
  if (!grouped.size) throw new Error('Missing sealed source counts');
  for (const row of rows) {
    if (!grouped.has(row.entity_type) || typeof row.source_pk !== 'string'
      || sha256(canonicalJson(row.payload)) !== row.payload_sha256?.trim()) throw new Error('Source payload checksum mismatch');
    grouped.get(row.entity_type).push(row);
  }
  for (const [type, collection] of grouped) {
    collection.sort((a, b) => a.source_pk.localeCompare(b.source_pk));
    if (new Set(collection.map(row => row.source_pk)).size !== collection.length) throw new Error('Duplicate source coordinate');
    counts[type] = collection.length;
    checksums[type] = sha256(collection.map(row => `${row.source_pk}:${row.payload_sha256.trim()}\n`).join(''));
    if (counts[type] !== evidence.sourceCounts[type]) throw new Error('Sealed source count mismatch');
  }
  if (sha256(canonicalJson({ counts, checksums })) !== expectedChecksum) throw new Error('Sealed source checksum mismatch');
  return { grouped, counts, checksums, sourceChecksum: expectedChecksum };
}

export function prepareStagingAdditions(rows, evidence, expectedChecksum, expected = { pins: 39, google: 6 }) {
  const { grouped, counts, checksums } = validateSealedSource(rows, evidence, expectedChecksum);
  const patients = new Map((grouped.get('patients') ?? []).map(row => [row.source_pk, row.payload]));
  const accounts = new Set((grouped.get('accounts') ?? []).map(row => row.source_pk));
  const pins = grouped.get('patient_access_secrets') ?? [];
  const google = (grouped.get('auth_identities') ?? []).filter(row => row.payload.provider === 'google');
  if (pins.length !== expected.pins || google.length !== expected.google) throw new Error('Authorized PIN/Google count mismatch');
  const subjects = new Set();
  for (const row of pins) {
    const source = row.payload;
    if (!uuid(source.patient_id) || row.source_pk !== source.patient_id || !patients.has(source.patient_id)
      || !validLegacyPinHash(source.access_pin_hash) || !time(source.created_at) || !time(source.updated_at)) {
      throw new Error('Invalid preserved PIN envelope');
    }
  }
  for (const row of google) {
    const source = row.payload;
    if (!uuid(source.id) || source.id !== row.source_pk || !accounts.has(source.user_id)
      || ![...patients.values()].some(patient => patient.auth_user_id === source.user_id)
      || typeof source.provider_id !== 'string' || !source.provider_id || source.account_status !== 'active'
      || (source.identity_data?.sub != null && source.identity_data.sub !== source.provider_id)
      || subjects.has(source.provider_id) || !time(source.created_at)) throw new Error('Invalid preserved Google mapping');
    subjects.add(source.provider_id);
  }
  return { pins, google, counts, checksums, sourceChecksum: expectedChecksum };
}

export function assertUnchangedPin(existing, source) {
  const expected = {
    patient_id: source.patient_id, pin_hash: source.access_pin_hash, status: 'active', hash_algorithm: 'bcrypt',
    disabled_at: null, disabled_reason: null, source_system: 'legacy_identity', source_record_id: source.patient_id,
    source_created_at: new Date(source.created_at).toISOString(), source_updated_at: new Date(source.updated_at).toISOString(),
    created_at: new Date(source.created_at).toISOString(), updated_at: new Date(source.updated_at).toISOString(), row_version: '1',
  };
  const actual = Object.fromEntries(Object.keys(expected).map(key => [key,
    existing[key] instanceof Date ? existing[key].toISOString() : key === 'row_version' ? String(existing[key]) : existing[key]]));
  // Do not include hashes or patient values in assertion errors.
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error('Existing PIN differs; no overwrite is permitted');
}
