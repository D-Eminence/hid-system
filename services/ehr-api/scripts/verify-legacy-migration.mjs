#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import bcrypt from 'bcryptjs';
import { validLegacyPinHash } from './legacy-pin-hash.mjs';

const serviceRoot = resolve(import.meta.dirname, '..');
const fixturePath = resolve(serviceRoot, 'test/fixtures/legacy-identity.sample.json');
const stagingPath = resolve(serviceRoot, 'scripts/stage-legacy-identity.mjs');
const promotionPath = resolve(serviceRoot, 'scripts/promote-legacy-identity.mjs');
const reconciliationPath = resolve(serviceRoot, 'scripts/reconcile-legacy-identity.mjs');
const inputGatePath = resolve(serviceRoot, 'scripts/verify-supabase-cutover-input.mjs');
process.env.MIGRATION_FIXTURE_PATH = fixturePath;
// This verifier exercises fixture mode even when a developer shell happens to
// have staging database variables set.
delete process.env.DATABASE_URL;
delete process.env.MIGRATION_RUN_ID;
process.env.MIGRATION_SNAPSHOT_ID = 'offline-fixture-v1';
process.env.MIGRATION_OPERATOR = 'automated-local-verifier';
// The fixture deliberately contains a minimal synthetic slice. Its expected
// inventory is explicit here so the production defaults (39/6/4/2) can never
// be accidentally treated as evidence supplied by the fixture itself.
process.env.CUTOVER_EXPECTED_PIN_COUNT = '1';
process.env.CUTOVER_EXPECTED_GOOGLE_COUNT = '1';
process.env.CUTOVER_EXPECTED_PLANNED_CAMPAIGN_COUNT = '4';
process.env.CUTOVER_EXPECTED_QUEUED_ENCOUNTER_COUNT = '2';
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
assert.equal(patient.auth_user_id, fixture.accounts[0]?.payload.id,
  'The existing patient must retain the existing account UUID');
assert.equal(bcrypt.compareSync('FixturePassw0rd!', fixture.accounts[0]?.payload.encrypted_password), true,
  'The preserved synthetic password hash must remain usable');
assert.equal(validLegacyPinHash(fixture.patient_access_pins[0]?.payload.pin_hash), true);
assert.equal(fixture.patient_access_pins[0]?.payload.patient_id, patient.id,
  'The imported PIN must remain tied to the preserved patient UUID');
assert.equal(bcrypt.compareSync('1234', fixture.patient_access_pins[0]?.payload.pin_hash), true,
  'The preserved synthetic PIN hash must remain usable');

const promotion = await readFile(promotionPath, 'utf8');
for (const invariant of [
  "id: source.id",
  "account_id: source.auth_user_id",
  "hid_code: source.hid_code",
  "source_system: 'legacy_identity'",
  'legacy_identity_user_id: source.id',
  'password_hash: passwordHash',
  "state: 'LEGACY_MIGRATED'",
  'pin_hash: source.pin_hash',
  'validLegacyPinHash(source.pin_hash)',
  'verify-supabase-cutover-input.mjs',
  'enforceCutoverInputGate();',
  'on conflict',
]) assert.ok(promotion.includes(invariant), `Promotion does not prove ${invariant}`);

const staging = await readFile(stagingPath, 'utf8');
for (const invariant of ['on conflict (id) do nothing', 'stageRunCreated', 'fresh staging run']) {
  assert.ok(staging.includes(invariant), `Staging does not prove ${invariant}`);
}

const inputGate = await readFile(inputGatePath, 'utf8');
for (const invariant of [
  'source_counts',
  'source_checksum_sha256',
  'STAGED_ENTITY_TYPES',
  'synthetic fixture staging run',
]) assert.ok(inputGate.includes(invariant), `Input gate does not prove ${invariant}`);

const reconciliation = await readFile(reconciliationPath, 'utf8');
for (const invariant of ['source_checksum_sha256', 'target_checksum_sha256', "status = 'blocked'", 'migration.entity_reconciliations']) {
  assert.ok(reconciliation.includes(invariant), `Reconciliation does not prove ${invariant}`);
}

// The input gate recomputes each payload hash and validates exact crosswalks,
// provider subjects, required inventory, and outreach relationships. It throws
// on any mismatch; its count/checksum-only output is safe for local CI logs.
await import('./verify-supabase-cutover-input.mjs');

console.log('Verified offline fixture dry run, deterministic repeatability, UUID/HID preservation, idempotent promotion, and checksum-blocking reconciliation contracts.');
