#!/usr/bin/env node
import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {databaseOptions,managedDatabaseUrl} from './database-options.mjs';
import {preservedMigrationKey} from './preserved-migration-key.mjs';
import {verifiedParent,verifyClinicalQuarantine,insertExactCustomerRow} from './customer-import-context.mjs';
import {clinicalPayload,validTime} from './customer-data-validation.mjs';
import {canonicalJson,sha256,deterministicUuid} from './staging-cutover-additions.mjs';
export async function importHealthProfiles(client,{parentId,checksum,fieldKey,keyReference,operator,apply=false}){
  await client.query('begin isolation level serializable');
  try{
    await client.query("select pg_advisory_xact_lock(hashtextextended('hid-customer-health-profile-import',0))");
    const source=await verifiedParent(client,parentId,checksum);
    const patients=source.grouped.get('patients');if(!patients) throw new Error('Patient source category is absent');
    for(const row of patients){
      const p=row.payload,clinical=clinicalPayload(p);
      if(!validTime(p.updated_at)) throw new Error('Patient profile source timestamp is missing');
      const canonical=(await client.query('select id,account_id,source_system,source_record_id from identity.patients where id=$1',[row.source_pk])).rows[0];
      if(canonical?.source_system!=='legacy_identity'||canonical.source_record_id!==row.source_pk||canonical.account_id!==(p.auth_user_id??null)) throw new Error('Canonical patient profile association differs');
      if(Object.values(clinical).some(v=>v!==null&&v!=='')) await verifyClinicalQuarantine(client,
        {parentId,patientId:p.id,coordinate:p.id,aadCoordinate:'legacy-clinical',payload:clinical,fieldKey,keyReference});
      await insertExactCustomerRow(client,'ehr.imported_patient_health_profiles',{patient_id:p.id,source_run_id:parentId,
        clinical_payload:clinical,source_sha256:sha256(canonicalJson(clinical)),source_updated_at:new Date(p.updated_at).toISOString()},['patient_id']);
    }
    const count=(await client.query('select count(*)::int n from ehr.imported_patient_health_profiles where source_run_id=$1',[parentId])).rows[0].n;
    if(count!==patients.length) throw new Error('Health-profile target count differs');
    const receiptId=deterministicUuid(`health-profile-import:${parentId}:${checksum}:v1`),seal=sha256(canonicalJson({parentId,checksum,count}));
    await client.query(`insert into migration.runs(id,source_system,source_snapshot,mode,status,source_counts,target_counts,source_checksum_sha256,target_checksum_sha256,started_by,completed_at)
      values($1,'staging_health_profile_import',$2,'cutover','completed',$3,$3,$4,$4,$5,clock_timestamp()) on conflict(id) do nothing`,
      [receiptId,source.parent.source_snapshot,JSON.stringify({patients:count}),seal,operator]);
    const receipt=(await client.query('select target_checksum_sha256 from migration.runs where id=$1',[receiptId])).rows[0];
    if(receipt?.target_checksum_sha256.trim()!==seal) throw new Error('Health-profile receipt differs');
    await client.query(apply?'commit':'rollback');return {mode:apply?'applied':'dry-run',patient_profiles:count,receipt_id:receiptId};
  }catch(error){await client.query('rollback').catch(()=>{});if(error.code) throw new Error(`Health-profile database check failed (${error.code}); rolled back`);throw error;}
}
async function main(){
  const args=process.argv.slice(2),e=process.env;
  if(args.some(a=>!['--dry-run','--apply'].includes(a))||(args.includes('--dry-run')&&args.includes('--apply'))||e.HID_DEPLOYMENT_ENV!=='staging') throw new Error('Choose a staging health-profile dry-run or apply');
  if(!e.MIGRATION_PARENT_RUN_ID||!e.MIGRATION_PARENT_SOURCE_CHECKSUM||!e.MIGRATION_OPERATOR||!e.MIGRATION_FIELD_KEY_REFERENCE) throw new Error('Verified parent/key/operator input is required');
  const client=new pg.Client(databaseOptions(e.DATABASE_URL||managedDatabaseUrl(),'hid-health-profile-import'));
  try{await client.connect();console.log(JSON.stringify(await importHealthProfiles(client,{parentId:e.MIGRATION_PARENT_RUN_ID,checksum:e.MIGRATION_PARENT_SOURCE_CHECKSUM,
    operator:e.MIGRATION_OPERATOR,fieldKey:preservedMigrationKey(e.MIGRATION_FIELD_ENCRYPTION_KEY_B64),keyReference:e.MIGRATION_FIELD_KEY_REFERENCE,apply:args.includes('--apply')})));}
  finally{await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(e=>{process.stderr.write(e.code?'Health-profile operation failed; inspect privately.\n':e.message+'\n');process.exitCode=1;});
