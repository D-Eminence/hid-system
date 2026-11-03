import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfiguration, verifyMachineConfiguration } from '../scripts/verify-release-contract.mjs';

test('release accepts 105 retained filenames through 0119, including duplicate prefixes and the unused 0065 slot', async () => {
  const configuration = await loadConfiguration();
  assert.equal(configuration.components.migration.count, 105);
  assert.equal(configuration.components.migration.last, '0119');
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
test('TEMPORARY: the 0104-0118 allowance is narrow: only those numbers, only while 0119 is the newest', async () => {
  for (const mutation of [
    c => { c.migration.files.splice(c.migration.files.findIndex(f => f.name === '0103_platform_organization_applications.sql'), 1); c.migration.count--; },
    c => { c.migration.files.splice(c.migration.files.findIndex(f => f.name === '0101_pharmacy_dispensing_source_check.sql'), 1); c.migration.count--; },
    c => { const last = c.migration.files.at(-1); c.migration.files[c.migration.files.length - 1] = { ...last, name: last.name.replace(/^0119/, '0120') }; c.migration.last = '0120'; },
  ]) {
    const configuration = await loadConfiguration(); mutation(configuration.components);
    await assert.rejects(verifyMachineConfiguration(configuration), /missing migration prefix/);
  }
});
