import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import bcrypt from 'bcryptjs';
import { prepareLegacyNinInventory } from './import-legacy-nin-crosswalk.mjs';
import { validLegacyPinHash } from './legacy-pin-hash.mjs';
import { contactLookupHmac, normalizeContactForLookup } from './contact-lookup.mjs';

const runId = '10000000-0000-4000-8000-000000000001';
const accountA = '20000000-0000-4000-8000-000000000001';
const accountB = '20000000-0000-4000-8000-000000000002';
const patientA = '30000000-0000-4000-8000-000000000001';
const patientB = '30000000-0000-4000-8000-000000000002';
const lookupKey = Buffer.alloc(32, 7);
const baseInput = {
  runId, sourceSnapshot: 'synthetic-snapshot-v1', sourceChecksumSha256: 'a'.repeat(64),
  evidenceReference: 'synthetic-source-inventory-v1', attestedBy: 'test-operator',
  attestedAt: '2026-01-01T00:00:00.000Z',
  patients: [
    { patientId: patientA, ninStatus: 'exact', nin: '12345678901',
      evidenceReference: 'synthetic-exact-source-record' },
    { patientId: patientB, ninStatus: 'absent',
      evidenceReference: 'synthetic-no-nin-source-record' },
  ],
};
const baseSources = [
  { source_pk: patientA, payload_sha256: 'b'.repeat(64),
    payload: { id: patientA, auth_user_id: accountA, hid_code: 'HID-ABCDEFGH', nin_last4: '8901' },
    patient_id: patientA, account_id: accountA, hid_code: 'HID-ABCDEFGH',
    source_system: 'legacy_identity', source_record_id: patientA, assurance_state: 'LEGACY_MIGRATED' },
  { source_pk: patientB, payload_sha256: 'c'.repeat(64),
    payload: { id: patientB, auth_user_id: accountB, hid_code: 'HID-ABCDEFJK' },
    patient_id: patientB, account_id: accountB, hid_code: 'HID-ABCDEFJK',
    source_system: 'legacy_identity', source_record_id: patientB, assurance_state: 'LEGACY_MIGRATED' },
];

function inputWith(patch) {
  return { ...baseInput, patients: structuredClone(baseInput.patients), ...patch };
}
function sourcesWith(patch) {
  const rows = structuredClone(baseSources);
  patch(rows);
  return rows;
}

test('complete attestation preserves exact patient UUIDs while recording no-NIN separately', () => {
  const prepared = prepareLegacyNinInventory(baseInput, baseSources, new Map(), lookupKey);
  assert.deepEqual(prepared.entries.map((entry) => entry.patientId), [patientA, patientB]);
  assert.deepEqual(prepared.entries.map((entry) => entry.ninState), ['attested_exact', 'attested_absent']);
  assert.equal(prepared.entries[0].ninLookupHmac,
    createHmac('sha256', lookupKey).update('12345678901').digest('hex'));
  assert.equal(prepared.entries[1].ninLookupHmac, null);
  assert.equal(prepared.exactNinCount, 1);
  assert.equal(prepared.absentNinCount, 1);
  assert.equal(JSON.stringify(prepared).includes('12345678901'), false,
    'Prepared database rows must never retain raw NIN');
});

test('partial inventory, opaque-field absence, duplicate NIN, and identity drift fail closed', () => {
  const missing = inputWith({ patients: [baseInput.patients[0]] });
  assert.throws(() => prepareLegacyNinInventory(missing, baseSources, new Map(), lookupKey), /every staged patient/);
  const opaque = sourcesWith((rows) => { rows[1].payload.nin_hash = 'opaque-old-digest'; });
  assert.throws(() => prepareLegacyNinInventory(baseInput, opaque, new Map(), lookupKey), /source NIN evidence/);
  const duplicate = inputWith({ patients: [baseInput.patients[0], {
    ...baseInput.patients[1], ninStatus: 'exact', nin: '12345678901',
  }] });
  assert.throws(() => prepareLegacyNinInventory(duplicate, baseSources, new Map(), lookupKey), /multiple patients/);
  const drift = sourcesWith((rows) => { rows[0].account_id = accountB; });
  assert.throws(() => prepareLegacyNinInventory(baseInput, drift, new Map(), lookupKey), /does not match staged source/);
  const boundElsewhere = new Map([[createHmac('sha256', lookupKey)
    .update('12345678901').digest('hex'), patientB]]);
  assert.throws(() => prepareLegacyNinInventory(baseInput, baseSources, boundElsewhere, lookupKey), /governed patient/);
});

test('a migrated bcrypt PIN hash stays usable byte-for-byte; invalid and excessive-cost hashes fail', () => {
  const exactHash = bcrypt.hashSync('1234', 6);
  assert.equal(validLegacyPinHash(exactHash), true);
  assert.equal(bcrypt.compareSync('1234', exactHash), true);
  assert.equal(bcrypt.compareSync('4321', exactHash), false);
  assert.equal(validLegacyPinHash(exactHash.replace('$06$', '$13$')), false);
  assert.equal(validLegacyPinHash('1234'), false);
  assert.equal(validLegacyPinHash(null), false);
});

test('migration contact lookup matches the Identity runtime canonical vectors', () => {
  const key = Buffer.alloc(32, 4);
  const vectors = [
    ['phone', '08012345678', '+2348012345678',
      'f581b89538c9b7b250b3678c2671a37f0211abfa1a8b813ba963ae17adfc5248'],
    ['email', ' Patient@Example.Test ', 'patient@example.test',
      'e15c0546f956495899f58ae92277b215dc3cb4183f8ce379b04f70f18c5047a8'],
  ];
  for (const [channel, input, normalized, expected] of vectors) {
    assert.equal(normalizeContactForLookup(channel, input), normalized);
    assert.equal(contactLookupHmac(channel, normalized, key), expected);
  }
});
