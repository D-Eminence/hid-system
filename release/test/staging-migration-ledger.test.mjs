import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfiguration, verifyMachineConfiguration } from '../scripts/verify-release-contract.mjs';

// BILL-1's files carry provisional numbers (0162-0167) on this department branch, so 0154-0161 are absent here and
// this test (with the two machine-configuration tests of release-contract.test.mjs) refuses "missing migration prefix"
// until the coordinator closes the numbers up at integration, in release order. No booked-number exception: one
// would conflict with the other departments' and hide a missing file (Rahman, #258, 25 November 2026, 21:48 UTC).
test('release accepts 160 retained filenames through 0167, including duplicate prefixes and the unused 0065 slot', async () => {
  const configuration = await loadConfiguration();
  assert.equal(configuration.components.migration.count, 160);
  assert.equal(configuration.components.migration.last, '0167');
  assert.ok(!configuration.components.migration.files.some(file => file.name.startsWith('0065_')));
  await verifyMachineConfiguration(configuration);
});
test('release rejects omission, checksum substitution and duplicate retained filenames', async () => {
  for (const mutation of [
    c => { c.migration.files.splice(c.migration.files.findIndex(f => f.name === '0033_patient_record_embeddings.sql'), 1); c.migration.count--; },
    c => { c.migration.files.find(f => f.name === '0034_legacy_patient_access_secret_preservation.sql').sha256 = 'a'.repeat(64); },
    c => { c.migration.files.push(c.migration.files[0]); c.migration.count++; },
    c => { c.migration.files.splice(c.migration.files.findIndex(f => f.name === '0067_patient_chat_evidence.sql'), 1); c.migration.count--; },
  ]) {
    const configuration = await loadConfiguration(); mutation(configuration.components);
    await assert.rejects(verifyMachineConfiguration(configuration));
  }
});
