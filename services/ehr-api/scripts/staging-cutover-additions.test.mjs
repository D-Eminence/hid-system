import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, sha256, prepareStagingAdditions, assertUnchangedPin } from './staging-cutover-additions.mjs';
const patient = '30000000-0000-4000-8000-000000000001';
const account = '10000000-0000-4000-8000-000000000001';
const identity = '20000000-0000-4000-8000-000000000001';
const timestamp = '2026-01-01T00:00:00.000Z';
const hash = '$2b$10$' + 'a'.repeat(53); // Invented format-only envelope.
function fixture(change = () => {}) {
  const collections = {
    accounts: [{ id: account }],
    patients: [{ id: patient, auth_user_id: account }],
    patient_access_secrets: [{ patient_id: patient, access_pin_hash: hash, created_at: timestamp, updated_at: timestamp }],
    auth_identities: [{ id: identity, provider: 'google', provider_id: 'invented-subject', user_id: account,
      account_status: 'active', created_at: timestamp, identity_data: { sub: 'invented-subject' } }],
    medical_records: [{ id: '40000000-0000-4000-8000-000000000001', title: 'Invented retained history' }],
  };
  change(collections);
  const counts = {}; const checksums = {}; const rows = [];
  for (const [type, payloads] of Object.entries(collections)) {
    const category = payloads.map(payload => ({ entity_type: type, source_pk: payload.id ?? payload.patient_id,
      payload, payload_sha256: sha256(canonicalJson(payload)) })).sort((a, b) => a.source_pk.localeCompare(b.source_pk));
    rows.push(...category); counts[type] = category.length;
    checksums[type] = sha256(category.map(row => `${row.source_pk}:${row.payload_sha256}\n`).join(''));
  }
  const sourceChecksum = sha256(canonicalJson({ counts, checksums }));
  return { rows, evidence: { sourceCounts: counts, sourceChecksum }, sourceChecksum };
}
function prepare(f) { return prepareStagingAdditions(f.rows, f.evidence, f.sourceChecksum, { pins: 1, google: 1 }); }
test('derives only additions while verifying retained clinical categories', () => {
  const data = fixture(); const before = structuredClone(data);
  const result = prepare(data);
  assert.equal(result.pins.length, 1); assert.equal(result.google.length, 1);
  assert.equal(result.counts.medical_records, 1); assert.deepEqual(data, before);
});
test('rejects a tampered clinical category even when PINs are unchanged', () => {
  const data = fixture(); data.rows.find(row => row.entity_type === 'medical_records').payload.title = 'tampered';
  assert.throws(() => prepare(data), /checksum mismatch/);
});
test('rejects deleted rows, substituted seals and unauthorized default counts', () => {
  const data = fixture();
  assert.throws(() => prepareStagingAdditions(data.rows, data.evidence, 'a'.repeat(64)), /snapshot checksum/);
  assert.throws(() => prepareStagingAdditions(data.rows, data.evidence, data.sourceChecksum), /count mismatch/);
  data.rows.pop(); assert.throws(() => prepare(data), /count mismatch/);
});
test('rejects unsupported hashes and mismatched Google subjects even with a valid source seal', () => {
  assert.throws(() => prepare(fixture(c => { c.patient_access_secrets[0].access_pin_hash = 'plaintext'; })), /PIN envelope/);
  assert.throws(() => prepare(fixture(c => { c.auth_identities[0].identity_data.sub = 'different'; })), /Google mapping/);
  assert.throws(() => prepare(fixture(c => { c.patients[0].auth_user_id = identity; })), /Google mapping/);
});
test('a changed or disabled operational PIN is never replaced by an old source hash', () => {
  const source = fixture().rows.find(row => row.entity_type === 'patient_access_secrets').payload;
  const existing = { patient_id: patient, pin_hash: hash, status: 'active', hash_algorithm: 'bcrypt', disabled_at: null,
    disabled_reason: null, source_system: 'legacy_identity', source_record_id: patient,
    source_created_at: new Date(timestamp), source_updated_at: new Date(timestamp),
    created_at: new Date(timestamp), updated_at: new Date(timestamp), row_version: 1 };
  assert.doesNotThrow(() => assertUnchangedPin(existing, source));
  for (const change of [{ pin_hash: '$2b$10$' + 'b'.repeat(53) }, { status: 'disabled' }, { row_version: 2 }]) {
    assert.throws(() => assertUnchangedPin({ ...existing, ...change }, source), /no overwrite/);
  }
});
