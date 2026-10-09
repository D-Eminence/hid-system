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
  ['0029_governed_otp_recovery.sql', 'ac8abd701b4da141867ea3e8bf0d3d6993b6414f6dc3b43bacc25afe3728b479'],
  ['0030_patient_self_service.sql', 'c25b47c46e34b0adbe384b3964636dbe26c083d2ef3bd7d787c5e1f75fe1b9d6'],
  ['0031_emergency_notification_and_rate_limit.sql', 'f04f1cc8380dc0c6bd38d69403f23b13cad6a4e02778a0817df220da3dc3f701'],
  ['0032_governed_patient_enrollment.sql', 'c4ee4ac51ce90a622901c3f8ebd4f3ac4d72acb5a8f7addd0a2b1ea993572225'],
  ['0033_supabase_cutover_identity_controls.sql', '4df718e800165d27085ae4b7b79761ef2748841cb6cebe1895c3674ebc6a2bce'],
  ['0034_qoreid_verification_evidence.sql', '7dbb417aa3ff8982316606546047c37fa00559d8790e510cfd6ac622be538c18'],
  ['0035_patient_access_request_decisions.sql', '9deac031d48c5e38587cb75090ff0b1234c81dc44b5fccd0b92fd3d38d58080b'],
  ['0036_staff_access_request_visibility.sql', 'b52347897e20781add7d5db1b36851bb5892e4c5a0b268269b7a7bc3f3cb8c32'],
  ['0037_patient_notification_inbox.sql', '86a2af2c94967bb536cd004ddbb39111ab6ce2239076844e295008731b3249be'],
  ['0038_outreach_campaign_workspaces.sql', '30b0f5dfe9ca2114a956047c6165101219af57cecba6f0870c73bfad488dd28a'],
  ['0039_platform_control_settings.sql', '1eb71f69e181390014ed1bd00f2a076683c0a3f420ef945f8da111afccb3ed0b'],
  ['0040_platform_control_enforcement.sql', 'bf51abc205bc88fcb89b6318640da2448b82766050739784ab660c771259f5be'],
  ['0041_disable_initial_maintenance_mode.sql', '196d5a227cfb3aca3f87f41c629b1d4e10520a55d9961130bc92ec0112831093'],
  ['0042_outreach_campaign_membership_key.sql', 'b8cd326ea393dc80ae897822b32d0f3e8b90d6770a6e86a9207b543174a4c0d7'],
  ['0043_authoritative_product_pricing.sql', 'd892901a51540925cf54dca3c649d487c11196780460b4aa74d1442f4e8ec146'],
  ['0044_commercial_demo_requests.sql', 'a62508cd72325f2bc98a8a33530a281643a1e891740d12adab776e164fb6bf8b'],
  ['0045_outreach_campaign_registration_binding.sql', 'f5b432143ddbb9e7066313a3af221f2d4b33d85a4d7e46390e956dc5c2fff6ae'],
  ['0046_organization_onboarding.sql', '0c19d39b019e0d967160a2f0fce4f86e432be90ec7cb7da87313d1511326b2c2'],
  ['0047_provider_integration_controls.sql', '9822ce9603c21a318377abd9f9b596b17cfaa8b406bdaf5c642539cbcd79fbe4'],
  ['0048_cac_legal_entity_binding.sql', '62dbe2720db379e824be9a38b1e1648fb4c3cdb64a63904707c486c31c5f88d3'],
  ['0049_qoreid_request_quotas.sql', 'e696c52591d25531c417b6d6cccd96419758ebf5ce640de8d84562ee086d548d'],
  ['0050_patient_nin_evidence_binding.sql', 'b7354dfe7e5918e309a40f0814bce76165200a088f922e3a1d561f7d5419d59f'],
  ['0051_public_patient_enrollment.sql', '24fef483e8bd5c9cddd91b4e3ad9b6e9436c8844d44cab9d25bcb21d9a6039ec'],
  ['0052_authoritative_cac_identity.sql', '7970e20da6bbf9984d08dd36b1f7beb60b618c19d2fc1c9c970ebea49953db88'],
  ['0053_remove_unwired_piersflow_catalog.sql', '57ae02a97839c581c35a6c78c27fabdc4873000e60dfb33e8c556a39a6b58331'],
  ['0054_complete_existing_cac_evidence_binding.sql', '3c06c35ad311835a825397c5b52269a059edd426f4edb6292007cf47041d444d'],
  ['0055_verified_incomplete_cac_result.sql', 'ac451f14dee5f7e6996de89ec92172773598229515829ee90637f98ebed7a54b'],
  ['0056_cac_applicant_profile_completion.sql', '3b501b72e6c34f2d8139de077a446614666e4e37ee872721864c2f8463d52b91'],
  ['0057_legacy_nin_crosswalk_and_contact_lookup.sql', '03441563d0f429844f60ca917351f8f754375ee05c21ce4c1358849688760048'],
  ['0058_progressive_patient_nin_binding.sql', 'f7e384f1fa49c3d2a950ad08bf761644e7194a80f34ea7a622af175452608aa8'],
  ['0059_google_onboarding.sql', '2a4147ad2310c928de23c350999adea4287d84b68fee51766e6633f929052af8'],
  ['0060_patient_access_pin_profile_status.sql', '1a0b5ca25f815dcd8714cdd569e8fe336b48d8a8c53362a8e42dbe986d407f50'],
  ['0061_provider_cac_self_service_onboarding.sql', '6d744c1a7d464d219bdcdca69050100c967e457e64c617b0a01857fe556a1493'],
  ['0062_provider_cac_self_service_constraints.sql', '49615ea6bdc7be995e8ae00c65ce63e708d3ec943f2aef8b5871b4825e617eac'],
  ['0063_provider_self_service_cac_quota.sql', '67bcd2a75081d5c2425e0661f3771329e382e92b0ab7e4f2f6fb9f9447f9357c'],
  ['0064_patient_account_deletion_lifecycle.sql', 'afee2b47c283669fbba864148b601fb0314f8847ff254600e3132c8c84010f38'],
  ['0065_patient_emergency_contacts.sql', 'f2136603fddb738a0ef6f761ee4267761c212bbb8490843a5b056928c575b341'],
  ['0066_patient_access_safety.sql', '513faac2e4d45ac345c462ad73a83371e78ca337b918be07d2955370eb9288dd'],
  ['0067_platform_admin_scope.sql', '31dbcee17c952c2714dacb8d690298201642bc8e7e43a8260608416672f2d741'],
  ['0068_admin_account_transition_safety.sql', '3c939177cd26302d6035b049bbbb571e83de2b1abbcf74350fa33af56e2abf30'],
  ['0069_platform_mfa_sessions.sql', '8dba4aca9afdcc8ee2ad9ae443793254ba2f0d48697956430776ec32e5f83173'],
  ['0070_platform_two_person_approval.sql', '3b732bbd473c58c7ec8ed7b56068e9c76c8d0c4f91fca16fbb3a4c9d62c3f954'],
  ['0071_platform_control_command_column_references.sql', '7e36a04c06be641af89a34f2edc0ef3d65476454c8003cacf15e1d4b3217ef92'],
  ['0072_platform_admin_contract_gaps.sql', '565f759bac8f6b2bc60c4bbf57e7dbdaae0f020b53d3f2af431c7aa22f886e4b'],
  ['0073_session_revocation_serialization.sql', '4901fc0a868e709db5edf28055760aa1a0cb85cefe327c0319f421d284c5df93'],
  ['0074_staff_access_request_outcome.sql', '21a412f66fa6d3d4613ab783969ec0b8fb18bd8895af97b17428c7aac4bf8efb'],
  ['0075_ocr_queue_metrics_and_outbox_insert.sql', '71063d846570742aea3a026994a888fca7a56c0f05f8f8f345b400f64dd8512f'],
  ['0076_mfa_account_lock_and_fail_closed_ocr_guards.sql', 'd83ad67ec5e172d529bbbb8e41213f602d20458c98b0bd5229dca073d5d13834'],
  ['0077_fail_closed_session_guards_and_ocr_worker_leases.sql', '4881f847ee37f707a67644112466e468dc170d61be20087ad38e082736609011'],
])

const migrationFiles = (await readdir(migrationDirectory))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
assert.deepEqual(migrationFiles, [...acceptedMigrations.keys()],
  'The checked-in migration set must exactly match the reviewed ledger; add a new migration and ledger entry deliberately.')

for (const [name, expectedChecksum] of acceptedMigrations) {
  const source = await readFile(join(migrationDirectory, name))
  const actualChecksum = createHash('sha256').update(source).digest('hex')
  assert.equal(actualChecksum, expectedChecksum, `Accepted migration was modified: ${name}`)
}

const runtimeGrants = await readFile(join(repository, 'services/ehr-api/database/runtime-grants.sql'), 'utf8')
assert.match(runtimeGrants, /nobypassrls/i, 'Runtime roles must remain unable to bypass RLS')

process.stdout.write(JSON.stringify({
  status: 'passed',
  immutableMigrationCount: acceptedMigrations.size,
  acceptedMigration: [...acceptedMigrations.keys()].at(-1),
  runtimeRolesBypassRls: false,
}) + '\n')
