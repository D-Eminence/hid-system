import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfiguration, verifyMachineConfiguration } from '../scripts/verify-release-contract.mjs';

// 0124 (organisation kinds, Q90) is built on another branch. Until this branch merges it, the release contract refuses
// the gap ("missing migration prefix"), so this branch cannot be released before 0124: that refusal is intended.
test('release accepts 125 retained filenames through 0125, including duplicate prefixes and the unused 0065 slot', async () => {
  const configuration = await loadConfiguration();
  assert.equal(configuration.components.migration.count, 125);
  assert.equal(configuration.components.migration.last, '0125');
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
