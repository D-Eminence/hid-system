import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

// The exact-role runtime verifiers create and drop databases as the cluster
// administrator they are given, so each accepts only the socket of the
// disposable cluster its own harness owns: the TUF rehearsal's
// /tmp/hid-tuf-migration.* or the non-superuser check's /tmp/hid-non-superuser.*.
// A developer's own cluster is reached only through an untracked copy of a
// verifier, never through a switch in the committed one.
const repository = resolve(import.meta.dirname, '../..');
const owned = new Set(['/tmp/hid-tuf-migration.', '/tmp/hid-non-superuser.']);

function databaseVerifiers() {
  const found = [];
  for (const service of readdirSync(join(repository, 'services'))) {
    let names = [];
    try {
      names = readdirSync(join(repository, 'services', service, 'scripts'));
    } catch {
      continue;
    }
    for (const name of names.filter((file) => /^verify-.+-runtime\.mjs$/.test(file))) {
      const path = `services/${service}/scripts/${name}`;
      const source = readFileSync(join(repository, path), 'utf8');
      if (source.includes('process.env.PGHOST')) found.push({ path, source });
    }
  }
  return found;
}

test('every runtime verifier that reads PGHOST admits only its harness\'s own socket', () => {
  const verifiers = databaseVerifiers();
  assert.ok(verifiers.length >= 20, `found only ${verifiers.length} runtime verifiers`);
  for (const { path, source } of verifiers) {
    assert.doesNotMatch(source, /HID_VERIFIER_LOCAL_CLUSTER|\/tmp\/pgtmp-/, `${path} admits a cluster its harness does not own`);
    const prefixes = [...new Set([...source.matchAll(/socket\?\.startsWith\('([^']*)'\)/g)].map((match) => match[1]))];
    assert.equal(prefixes.length, 1, `${path} checks ${prefixes.length} socket prefixes`);
    assert.ok(owned.has(prefixes[0]), `${path} admits ${prefixes[0]}`);
  }
});

test('the record chat, imported history and patient record release verifiers admit only the rehearsal', () => {
  for (const name of ['verify-record-chat-runtime.mjs', 'verify-imported-history-runtime.mjs',
    'verify-patient-record-release-runtime.mjs']) {
    const source = readFileSync(join(repository, 'services/ehr-api/scripts', name), 'utf8');
    assert.deepEqual([...source.matchAll(/socket\?\.startsWith\('([^']*)'\)/g)].map((match) => match[1]),
      ['/tmp/hid-tuf-migration.'], name);
  }
});
