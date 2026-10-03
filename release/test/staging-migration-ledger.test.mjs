import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfiguration, verifyMachineConfiguration } from '../scripts/verify-release-contract.mjs';

test('release accepts 64 full filenames through prefix 0062 without renaming applied files', async () => {
  const configuration = await loadConfiguration();
  assert.equal(configuration.components.migration.count, 64);
  assert.equal(configuration.components.migration.last, '0062');
  await verifyMachineConfiguration(configuration);
});
test('release rejects omission, checksum substitution and duplicate retained filenames', async () => {
  for (const mutation of [
    c => { c.migration.files.splice(c.migration.files.findIndex(f => f.name === '0033_patient_record_embeddings.sql'), 1); c.migration.count--; },
    c => { c.migration.files.find(f => f.name === '0034_legacy_patient_access_secret_preservation.sql').sha256 = 'a'.repeat(64); },
    c => { c.migration.files.push(c.migration.files[0]); c.migration.count++; },
  ]) {
    const configuration = await loadConfiguration(); mutation(configuration.components);
    await assert.rejects(verifyMachineConfiguration(configuration));
  }
});
