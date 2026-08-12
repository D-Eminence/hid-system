#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '..')
const migrationDirectory = join(repository, 'services/ehr-api/database/migrations')

// These are the accepted source checksums for the immutable baseline. A
// subsequent schema change must be a new migration and deliberately extend this
// ledger; it must never rewrite an accepted migration.
const acceptedMigrations = new Map([
  ['0001_platform_and_migration_control.sql', '0658978c5f01dea74f3f4183f809e3a39198ac11484658ddb7844d1dd692f842'],
  ['0002_auth_and_canonical_identity.sql', '9c0dd720cf8f474191a2deee3889655519b9afca665c457c974b41144809ec7b'],
  ['0003_consent_and_audit.sql', '0f24ece14b73e39461798b4acc74f93433a22393c3f8d9c9dce8dc58a53e7ea4'],
  ['0004_ehr_clinical_records.sql', '8cb2222c26f1f74e959965058445b1c2584cb38d4ea8f5f4f6617c28db104d72'],
  ['0005_database_authorization.sql', 'f9431059ddcec475ae591c8c542b387dacc8a0b2191cf99ea923e0ca8ed1b2ab'],
  ['0006_phase1_authorization_vocabulary.sql', '39b78e964545bb415260f9ec43d6a12cc528d267d18d4f915c086fa4b2fbe757'],
  ['0007_least_privilege_password_upgrade.sql', '7be31ac82ed4fa34a7022649d3b9f1a5064770f299e7460045cb0e8b1c9f6794'],
  ['0008_identity_consent_integrity.sql', '8e0769ae7b889988be61f6983f24cf726faf4e2feddf1f71be267611f2babde9'],
  ['0009_document_scan_object_binding.sql', '7b6f442d87a9d2b2770bae94d393e8a618a93ae1fc61d86fe50ebdb4d11c2e33'],
  ['0010_consent_commands_and_audit_reads.sql', '8ec056d960ff75d8c9db26b55c6d953a680ce7d85f4e4b37fcf8c44d4891c8b6'],
  ['0011_governed_nin_registration.sql', '8221a54a0bf3fe8db0a22d467dfd484a7709afd9a7b0910ce8b03edecd2ead15'],
  ['0012_narrow_break_glass_authorization.sql', '8fef1dedd4c3e4b47b49353d9f5264fcf7f38746070a20effc71e716bce732e5'],
  ['0013_durable_ocr_persistence.sql', 'dcda6ef782248722ae3440f104d89fdeb747bf674b0e5347368f8c745239a20d'],
  ['0014_ocr_worker_leases.sql', 'd6d7495ef8a35750c999e38d06bfda8477c60fb2e27c95d558774a8a5f17bc7b'],
  ['0015_ocr_claim_column_resolution.sql', '718b455dfc9b9667bf82b403884e613bb08eefb145501c340d377e873822215f'],
  ['0016_governed_ocr_validation_publication.sql', 'e4bb1e57131cab2bc31a17a14d7ea5a59fc270aa3e7880c9e876810a05687d4e'],
  ['0017_lab_imported_evidence.sql', 'd16c010051c0656c5920416f463c6f877132a3b60202cc0122eec48bce35f7fb'],
  ['0018_lab_work_items.sql', '0c4323966698a8834a1c7a718fa78c5d064f40a516f8286e04229b47a9cd620e'],
  ['0019_lab_accessions_specimens.sql', 'cf2c9ba1097bda3e47b742191b6fa4c36c587f9430c4425a678a32e882ff285a'],
  ['0020_lab_test_execution_results.sql', 'f0197b82912a8d3653e3f88cddc20b18452dd6d5bab0ba64ab4bd6bedbddc932'],
  ['0021_lab_result_verification_release.sql', 'b85b587ce59aaafd7818d5ccbccdd33a874b4d68094a02dce85d1ebda8d7d5f2'],
  ['0022_lab_result_revision_kind_compatibility.sql', '03442b7281f7c56381f4fe8b817c588926da1df1da278f8f8b33defc88c77d35'],
  ['0023_pharmacy_domain_foundation.sql', 'f05f66c9d28ff571b1e88290ba39fb54c1cbf7f52ef100a801d605c5e246c654'],
  ['0024_outreach_registration_foundation.sql', '65d30c48853c39188694ce95ed0c5cb489b37ec4b5d131eb955af0b43513d5f9'],
  ['0025_identity_transactional_outbox.sql', '1a4242fb12db180bbd2cd32fb134df77c2910a7ccb10d02d17892e5bb38adc08'],
  ['0026_transactional_event_delivery.sql', '1a2c2f5269397fb54e6df5bf3ae08bf373b62f68cec3f2104994faa2d8a32f3f'],
  ['0027_super_admin_foundation.sql', '59a74a198d9b773d6a80e87b55556e569f18a47a633d6ba4107d5bb68101839f'],
  ['0028_identity_notification_migration_state.sql', 'c074a44a1e98946721de9763a230762b28aa8639b302dd57afa4edc5c92de200'],
])

const migrationFiles = (await readdir(migrationDirectory))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
assert.deepEqual(migrationFiles, [...acceptedMigrations.keys()],
  'The accepted baseline must contain exactly migrations 0001 through 0028; add a new migration and ledger entry deliberately.')

for (const [name, expectedChecksum] of acceptedMigrations) {
  const source = await readFile(join(migrationDirectory, name))
  const actualChecksum = createHash('sha256').update(source).digest('hex')
  assert.equal(actualChecksum, expectedChecksum, `Accepted migration was modified: ${name}`)
}

const runtimeGrants = await readFile(join(repository, 'services/ehr-api/database/runtime-grants.sql'), 'utf8')
assert.match(runtimeGrants, /nobypassrls/i, 'Runtime roles must remain unable to bypass RLS')

process.stdout.write(JSON.stringify({
  status: 'passed',
  immutableMigrationCount: acceptedMigrations.size - 1,
  acceptedMigration: '0028_identity_notification_migration_state.sql',
  runtimeRolesBypassRls: false,
}) + '\n')
