#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const serviceRoot = resolve(import.meta.dirname, '..');
const fixturePath = resolve(serviceRoot, 'test/fixtures/legacy-identity.sample.json');
const promotionPath = resolve(serviceRoot, 'scripts/promote-legacy-identity.mjs');
const reconciliationPath = resolve(serviceRoot, 'scripts/reconcile-legacy-identity.mjs');
process.env.MIGRATION_FIXTURE_PATH = fixturePath;
process.env.MIGRATION_SNAPSHOT_ID = 'offline-fixture-v1';
process.env.MIGRATION_OPERATOR = 'automated-local-verifier';
process.argv.push('--dry-run');
const { loadMigrationFixture, summarizeMigrationFixture } = await import('./stage-legacy-identity.mjs');
const loaded = await loadMigrationFixture(fixturePath);
const first = summarizeMigrationFixture(loaded);
const second = summarizeMigrationFixture(loaded);
assert.deepEqual(first, second, 'Repeated fixture scans must produce identical counts and checksums');
assert.equal(first.counts.patients, 1);
assert.match(first.checksums.patients, /^[0-9a-f]{64}$/);
assert.match(first.overallChecksum, /^[0-9a-f]{64}$/);

const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const patient = fixture.patients[0]?.payload;
assert.equal(patient.id, '30000000-0000-4000-8000-000000000001');
assert.equal(patient.hid_code, 'HID-ABCDEFGH');

const promotion = await readFile(promotionPath, 'utf8');
for (const invariant of [
  "id: source.id",
  "account_id: source.auth_user_id",
  "hid_code: source.hid_code",
  "source_system: 'legacy_identity'",
  'legacy_identity_user_id: source.id',
  'on conflict',
]) assert.ok(promotion.includes(invariant), `Promotion does not prove ${invariant}`);

const reconciliation = await readFile(reconciliationPath, 'utf8');
for (const invariant of ['source_checksum_sha256', 'target_checksum_sha256', "status = 'blocked'", 'migration.entity_reconciliations']) {
  assert.ok(reconciliation.includes(invariant), `Reconciliation does not prove ${invariant}`);
}

console.log('Verified offline fixture dry run, deterministic repeatability, UUID/HID preservation, idempotent promotion, and checksum-blocking reconciliation contracts.');
