#!/usr/bin/env node
// Focused, atomic staging bridge for the already reconciled September run.
// Dry-run is default. Customer data, existing mappings and history are never
// overwritten. Outreach rows are not read or promoted by this operation.
import { createDecipheriv } from 'node:crypto';
import pg from 'pg';
import { databaseOptions, managedDatabaseUrl } from './database-options.mjs';
import { prepareStagingAdditions, assertUnchangedPin, canonicalJson, sha256, deterministicUuid } from './staging-cutover-additions.mjs';
import { preservedMigrationKey } from './preserved-migration-key.mjs';

const env = process.env;
const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some(arg => !['--apply', '--dry-run'].includes(arg))
  || (apply && process.argv.includes('--dry-run'))) throw new Error('Choose --dry-run or --apply');
if (env.HID_DEPLOYMENT_ENV !== 'staging') throw new Error('This bridge is staging-only');
const url = env.DATABASE_URL || managedDatabaseUrl();
const parentId = env.MIGRATION_PARENT_RUN_ID;
const expectedChecksum = env.MIGRATION_PARENT_SOURCE_CHECKSUM;
const operator = env.MIGRATION_OPERATOR;
if (!url || !parentId || !operator || !expectedChecksum || !env.MIGRATION_FIELD_KEY_REFERENCE) {
  throw new Error('Database, parent run/checksum, operator and field key reference are required');
}
const fieldKey = preservedMigrationKey(env.MIGRATION_FIELD_ENCRYPTION_KEY_B64);
function decrypt(value, aad) {
  if (!Buffer.isBuffer(value) || value.length < 30 || value[0] !== 1) throw new Error('Invalid preserved ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', fieldKey, value.subarray(1, 13));
  decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(value.subarray(13, 29));
  return Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]).toString('utf8');
}
async function main() {
  const client = new pg.Client(databaseOptions(url, 'hid-staging-cutover-additions'));
  await client.connect();
  try {
    await client.query('begin isolation level serializable');
    await client.query("select pg_advisory_xact_lock(hashtextextended('hid-staging-cutover-additions', 0))");
    const parent = (await client.query('select * from migration.runs where id = $1 for share', [parentId])).rows[0];
    if (!parent || parent.source_system !== 'legacy_identity' || parent.status !== 'verified' || parent.mode !== 'reconcile') {
      throw new Error('Parent migration must already be reconciled and verified');
    }
    if ((await client.query('select count(*)::int as n from migration.conflicts where run_id = $1', [parentId])).rows[0].n) {
      throw new Error('Parent migration contains unresolved conflict evidence');
    }
    const rows = (await client.query('select entity_type, source_pk, payload, payload_sha256 from migration.source_rows where run_id = $1 order by entity_type, source_pk', [parentId])).rows;
    const additions = prepareStagingAdditions(rows, { sourceCounts: parent.source_counts,
      sourceChecksum: parent.source_checksum_sha256?.trim() }, expectedChecksum);
    const reconciliations = (await client.query('select * from migration.entity_reconciliations where run_id = $1', [parentId])).rows;
    for (const [type, count] of Object.entries(additions.counts)) {
      const item = reconciliations.find(row => row.entity_type === type);
      if (!item || Number(item.source_count) !== count || Number(item.target_count) !== count
        || item.source_checksum_sha256.trim() !== additions.checksums[type]
        || item.target_checksum_sha256.trim() !== additions.checksums[type]) throw new Error('Parent category reconciliation is incomplete');
    }
    // Validate all dependencies and quarantined ciphertext before inserting any PIN.
    for (const row of additions.pins) {
      const source = row.payload;
      const patient = (await client.query('select source_system, source_record_id from identity.patients where id = $1', [source.patient_id])).rows[0];
      if (patient?.source_system !== 'legacy_identity' || patient.source_record_id !== source.patient_id) throw new Error('PIN canonical patient provenance mismatch');
      const quarantine = (await client.query('select * from migration.legacy_patient_access_secrets where run_id = $1 and patient_id = $2', [parentId, source.patient_id])).rows[0];
      const plaintext = canonicalJson({ source_table: 'public.hid_patient_access_secrets', payload: source });
      if (!quarantine || quarantine.encryption_key_reference !== env.MIGRATION_FIELD_KEY_REFERENCE
        || quarantine.payload_sha256.trim() !== sha256(plaintext)
        || decrypt(quarantine.encrypted_payload, `${parentId}:${source.patient_id}:patient-access-secret`) !== plaintext) {
        throw new Error('PIN quarantine preservation evidence mismatch');
      }
      const existing = (await client.query('select * from identity.patient_access_pins where patient_id = $1 for update', [source.patient_id])).rows[0];
      if (existing) assertUnchangedPin(existing, source);
    }
    for (const row of additions.google) {
      const source = row.payload;
      const sourcePatients = rows.filter(item => item.entity_type === 'patients' && item.payload.auth_user_id === source.user_id);
      if (sourcePatients.length !== 1) throw new Error('Google canonical patient association is ambiguous');
      const sourcePatient = sourcePatients[0];
      const canonicalPatient = (await client.query('select account_id,source_system,source_record_id from identity.patients where id=$1', [sourcePatient.source_pk])).rows[0];
      if (canonicalPatient?.account_id !== source.user_id || canonicalPatient.source_system !== 'legacy_identity'
        || canonicalPatient.source_record_id !== sourcePatient.source_pk) throw new Error('Google canonical patient association differs');
      const account = (await client.query('select source_system, legacy_identity_user_id, status from auth.accounts where id = $1', [source.user_id])).rows[0];
      const mapping = (await client.query('select * from auth.external_identities where issuer = $1 and subject = $2 for update', ['https://accounts.google.com', source.provider_id])).rows[0];
      if (account?.source_system !== 'legacy_identity' || account.legacy_identity_user_id !== source.user_id || account.status !== 'active'
        || !mapping || mapping.id !== deterministicUuid(`legacy-provider-identity:${source.id}`)
        || mapping.account_id !== source.user_id || mapping.status !== 'active' || mapping.revoked_at !== null
        || mapping.source_system !== 'legacy_identity') throw new Error('Google mapping differs from reconciled provenance');
    }
    for (const row of additions.pins) {
      const s = row.payload;
      await client.query(`insert into identity.patient_access_pins
        (patient_id, pin_hash, source_system, source_record_id, source_created_at, source_updated_at, created_at, updated_at)
        values ($1::uuid,$2,'legacy_identity',$1::text,$3,$4,$3,$4) on conflict (patient_id) do nothing`,
        [s.patient_id, s.access_pin_hash, s.created_at, s.updated_at]);
      assertUnchangedPin((await client.query('select * from identity.patient_access_pins where patient_id = $1', [s.patient_id])).rows[0], s);
    }
    const receiptId = deterministicUuid(`staging-cutover-additions:${parentId}:${expectedChecksum}:v1`);
    const receiptCounts = { patient_access_pins: additions.pins.length, google_mapping_checks: additions.google.length };
    const receiptChecksum = sha256(canonicalJson({ parentId, expectedChecksum, receiptCounts }));
    await client.query(`insert into migration.runs
      (id, source_system, source_snapshot, mode, status, started_by, completed_at, source_counts, target_counts, source_checksum_sha256, target_checksum_sha256, notes)
      values ($1,'staging_cutover_additions',$2,'cutover','completed',$3,clock_timestamp(),$4::jsonb,$4::jsonb,$5,$5,$6)
      on conflict (id) do nothing`, [receiptId, parent.source_snapshot, operator, JSON.stringify(receiptCounts), receiptChecksum,
      `Validated additions to parent run ${parentId}; Google mappings unchanged; invalid outreach excluded; clinical preservation unchanged.`]);
    const receipt = (await client.query('select * from migration.runs where id = $1', [receiptId])).rows[0];
    if (receipt.source_system !== 'staging_cutover_additions' || receipt.source_snapshot !== parent.source_snapshot
      || receipt.mode !== 'cutover' || receipt.status !== 'completed' || !receipt.completed_at
      || canonicalJson(receipt.source_counts) !== canonicalJson(receiptCounts)
      || canonicalJson(receipt.target_counts) !== canonicalJson(receiptCounts)
      || receipt.source_checksum_sha256.trim() !== receiptChecksum || receipt.target_checksum_sha256.trim() !== receiptChecksum) throw new Error('Additive receipt mismatch');
    await client.query(apply ? 'commit' : 'rollback');
    process.stdout.write(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', parent_run_id: parentId,
      receipt_id: receiptId, counts: receiptCounts, operational_outreach_rows_promoted: 0, clinical_release: 'separate required step' }) + '\n');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    // PG errors can include patient data in detail; never relay them to logs.
    if (error.code) throw new Error(`Additive migration database check failed (${error.code}); transaction rolled back`);
    throw error;
  } finally { await client.end(); }
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
