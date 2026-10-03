#!/usr/bin/env node
import { createDecipheriv } from 'node:crypto';
import pg from 'pg';
import { databaseOptions,managedDatabaseUrl } from './database-options.mjs';
import { canonicalJson,sha256,deterministicUuid } from './staging-cutover-additions.mjs';
import { prepareMedicalImport,assertExactImportedRow } from './imported-medical-records.mjs';
import { preservedMigrationKey } from './preserved-migration-key.mjs';

export async function importMedicalRecords(client, options) {
  const { parentId,checksum,operator,fieldKey,keyReference,apply = false } = options;
  const decrypt = (value,aad) => {
    if (!Buffer.isBuffer(value) || value.length < 30 || value[0] !== 1) throw new Error('Invalid clinical preservation envelope');
    const cipher = createDecipheriv('aes-256-gcm',fieldKey,value.subarray(1,13));
    cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(value.subarray(13,29));
    return Buffer.concat([cipher.update(value.subarray(29)),cipher.final()]).toString('utf8');
  };
  await client.query('begin isolation level serializable');
  try {
    await client.query("select pg_advisory_xact_lock(hashtextextended('hid-medical-history-import',0))");
    const parent = (await client.query('select * from migration.runs where id=$1 for share',[parentId])).rows[0];
    if (!parent || parent.source_system !== 'legacy_identity' || parent.mode !== 'reconcile' || parent.status !== 'verified'
      || parent.target_checksum_sha256?.trim() !== checksum) throw new Error('A verified reconciled parent seal is required');
    if ((await client.query('select count(*)::int n from migration.conflicts where run_id=$1',[parentId])).rows[0].n) throw new Error('Parent conflict evidence is unresolved');
    const rows = (await client.query('select entity_type,source_pk,payload,payload_sha256 from migration.source_rows where run_id=$1',[parentId])).rows;
    const prepared = prepareMedicalImport(rows,{sourceCounts:parent.source_counts,sourceChecksum:parent.source_checksum_sha256?.trim()},checksum);
    const reconciliations = (await client.query('select * from migration.entity_reconciliations where run_id=$1',[parentId])).rows;
    for (const [type,count] of Object.entries(prepared.counts)) {
      const r = reconciliations.find(x => x.entity_type === type);
      if (!r || Number(r.source_count) !== count || Number(r.target_count) !== count
        || r.source_checksum_sha256.trim() !== prepared.checksums[type] || r.target_checksum_sha256.trim() !== prepared.checksums[type]) throw new Error('Parent category reconciliation differs');
    }
    const canonicalPatients = new Map((await client.query(`select id,account_id,source_system,source_record_id from identity.patients
      where id=any($1::uuid[])`,[[...new Set(prepared.records.map(r => r.patientId))]])).rows.map(p => [p.id,p]));
    const sourcePatients = new Map(rows.filter(r => r.entity_type === 'patients').map(r => [r.source_pk,r.payload]));
    const canonicalAccounts = new Map((await client.query(`select id,source_system,legacy_identity_user_id from auth.accounts
      where id=any($1::uuid[])`,[[...new Set([...prepared.records,...prepared.versions].map(r => r.author.accountId)
        .concat(prepared.files.map(r => r.uploaderAccountId)))]] )).rows.map(a => [a.id,a]));
    for (const item of [...prepared.records,...prepared.versions,...prepared.files]) {
      const patient = canonicalPatients.get(item.patientId); const sourcePatient = sourcePatients.get(item.patientId);
      if (patient?.source_system !== 'legacy_identity' || patient.source_record_id !== item.patientId
        || patient.account_id !== (sourcePatient.auth_user_id ?? null)) throw new Error('Canonical clinical patient association differs');
      const accountId = item.author?.accountId ?? item.uploaderAccountId; const account = canonicalAccounts.get(accountId);
      if (account?.source_system !== 'legacy_identity' || account.legacy_identity_user_id !== accountId) throw new Error('Canonical clinical author association differs');
      const type = prepared.records.includes(item) ? 'medical_records' : prepared.versions.includes(item) ? 'medical_record_versions' : 'medical_record_files';
      const coordinate = `public.hid_${type}:${item.row.source_pk}`;
      const plaintext = canonicalJson({source_table:`public.hid_${type}`,payload:item.row.payload});
      const q = (await client.query(`select * from migration.legacy_clinical_quarantine
        where run_id=$1 and patient_id=$2 and source_record_id=$3`,[parentId,item.patientId,coordinate])).rows[0];
      let matches = false;
      try { matches = q && q.encryption_key_reference === keyReference && q.payload_sha256.trim() === sha256(plaintext)
        && decrypt(q.encrypted_payload,`${parentId}:${item.patientId}:${coordinate}`) === plaintext; } catch { /* Fail closed without logging plaintext. */ }
      if (!matches) throw new Error('Encrypted clinical preservation evidence differs');
    }
    async function insertExact(table,expected) {
      const columns = Object.keys(expected); const values = Object.values(expected).map(v => v && typeof v === 'object' ? JSON.stringify(v) : v);
      // table/column identifiers are exclusively fixed below, never source input.
      await client.query(`insert into ehr.${table} (${columns.join(',')}) values (${columns.map((_,i) => `$${i+1}`).join(',')}) on conflict (id) do nothing`,values);
      assertExactImportedRow((await client.query(`select * from ehr.${table} where id=$1`,[expected.id])).rows[0],expected);
    }
    for (const {row,patientId,author} of prepared.records) {
      const s = row.payload;
      await insertExact('imported_medical_records',{id:s.id,patient_id:patientId,author_account_id:author.accountId,origin:author.origin,
        current_version_id:s.current_version_id,source_run_id:parentId,source_payload:s,source_sha256:row.payload_sha256.trim(),
        source_created_at:new Date(s.created_at).toISOString(),source_updated_at:new Date(s.updated_at).toISOString()});
    }
    for (const {row,patientId,author} of prepared.versions) {
      const s = row.payload;
      await insertExact('imported_medical_record_versions',{id:s.id,record_id:s.record_id,patient_id:patientId,version_no:s.version_no,
        author_account_id:author.accountId,origin:author.origin,source_payload:s,source_sha256:row.payload_sha256.trim(),source_created_at:new Date(s.created_at).toISOString()});
    }
    for (const {row,patientId,uploaderAccountId} of prepared.files) {
      const s = row.payload;
      await insertExact('imported_medical_record_files',{id:s.id,record_id:s.record_id,patient_id:patientId,record_version_id:s.record_version_id ?? null,
        uploader_account_id:uploaderAccountId,source_payload:s,source_sha256:row.payload_sha256.trim(),source_created_at:new Date(s.created_at).toISOString()});
    }
    await client.query('set constraints ehr.imported_current_version immediate');
    const counts = {medical_records:prepared.records.length,medical_record_versions:prepared.versions.length,medical_record_files:prepared.files.length};
    // Count the entire target run, including rows unexpectedly present on repeat.
    const targetCounts = {};
    for (const [type,table] of Object.entries({medical_records:'imported_medical_records',medical_record_versions:'imported_medical_record_versions',medical_record_files:'imported_medical_record_files'})) {
      const result = await client.query(`select count(*)::int n from ehr.${table} t ${type === 'medical_records' ? '' : 'join ehr.imported_medical_records r on r.id=t.record_id'} where ${type === 'medical_records' ? 't' : 'r'}.source_run_id=$1`,[parentId]);
      targetCounts[type] = result.rows[0].n;
    }
    if (canonicalJson(counts) !== canonicalJson(targetCounts)) throw new Error('Imported target count differs');
    const receiptId = deterministicUuid(`medical-history-import:${parentId}:${checksum}:v1`);
    const receiptChecksum = sha256(canonicalJson({parentId,checksum,counts}));
    const expectedReceipt = {id:receiptId,source_system:'staging_medical_history_import',source_snapshot:parent.source_snapshot,
      mode:'cutover',status:'completed',source_counts:counts,target_counts:counts,source_checksum_sha256:receiptChecksum,target_checksum_sha256:receiptChecksum};
    await client.query(`insert into migration.runs(id,source_system,source_snapshot,mode,status,source_counts,target_counts,source_checksum_sha256,target_checksum_sha256,started_by,completed_at,notes)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp(),'Immutable medical history imported; attachment access pending verified binding and clean scan') on conflict (id) do nothing`,
    [...Object.values(expectedReceipt).map(v => typeof v === 'object' ? JSON.stringify(v) : v),operator]);
    const receipt=(await client.query('select * from migration.runs where id=$1',[receiptId])).rows[0];
    assertExactImportedRow(receipt,expectedReceipt);
    if (!receipt.completed_at) throw new Error('Medical import receipt is incomplete');
    await client.query(apply ? 'commit' : 'rollback');
    return {mode:apply ? 'applied' : 'dry-run',parent_run_id:parentId,receipt_id:receiptId,counts,attachment_downloads:'pending verified binding and clean scan'};
  } catch (error) {
    await client.query('rollback').catch(() => {});
    if (error.code) throw new Error(`Medical import database check failed (${error.code}); transaction rolled back`);
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => !['--dry-run','--apply'].includes(a)) || (args.includes('--apply') && args.includes('--dry-run'))) throw new Error('Choose --dry-run or --apply');
  const e = process.env;
  if (e.HID_DEPLOYMENT_ENV !== 'staging') throw new Error('Medical importer is staging-only');
  if (!e.MIGRATION_PARENT_RUN_ID || !e.MIGRATION_PARENT_SOURCE_CHECKSUM || !e.MIGRATION_OPERATOR || !e.MIGRATION_FIELD_KEY_REFERENCE) throw new Error('Parent seal, operator and field key reference are required');
  const client = new pg.Client(databaseOptions(e.DATABASE_URL || managedDatabaseUrl(),'hid-medical-history-import'));
  await client.connect();
  try { process.stdout.write(JSON.stringify(await importMedicalRecords(client,{parentId:e.MIGRATION_PARENT_RUN_ID,checksum:e.MIGRATION_PARENT_SOURCE_CHECKSUM,
    operator:e.MIGRATION_OPERATOR,keyReference:e.MIGRATION_FIELD_KEY_REFERENCE,fieldKey:preservedMigrationKey(e.MIGRATION_FIELD_ENCRYPTION_KEY_B64),apply:args.includes('--apply')}))+'\n'); }
  finally { await client.end(); }
}
// Importable by the disposable rehearsal; no database connection on module import.
if (process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replaceAll('\\','/').split('/').at(-1))) {
  main().catch(error => { process.stderr.write(error.message+'\n'); process.exitCode=1; });
}
