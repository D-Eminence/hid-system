#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {databaseOptions,managedDatabaseUrl} from './database-options.mjs';
import {verifiedParent,insertExactCustomerRow} from './customer-import-context.mjs';
import {prepareCustomerSource,ninCoverage} from './customer-data-validation.mjs';
import {CUSTOMER_SOURCE_TABLES,CONFIGURATION_CATEGORIES} from './customer-source-tables.mjs';
import {configurationDecisions,applyNativeConfiguration} from './customer-configuration-mapping.mjs';
import {canonicalJson,sha256,deterministicUuid} from './staging-cutover-additions.mjs';
export async function importCustomerHistory(client,{parentId,checksum,bundle,sourceChecksum,operator,mapping,apply=false}){
  if(mapping?.parent_run_id&& (mapping.parent_run_id!==parentId||mapping.parent_source_checksum!==checksum)) throw new Error('Configuration mapping parent differs');
  const prepared=prepareCustomerSource(bundle,sourceChecksum),decisions=configurationDecisions(prepared,mapping);
  const mappingHash=sha256(canonicalJson(mapping??{mode:'preservation-only'}));
  const receiptId=deterministicUuid(`customer-history:${parentId}:${sourceChecksum}:v1`);
  const coverage=ninCoverage(prepared.grouped.get('patients'));
  await client.query('begin isolation level serializable');
  try{
    await client.query("select pg_advisory_xact_lock(hashtextextended('hid-customer-history-import',0))");
    const parent=await verifiedParent(client,parentId,checksum);
    for(const table of CUSTOMER_SOURCE_TABLES.filter(t=>['canonical','imported-history'].includes(t.disposition)&&t.category!=='notifications')){
      if(parent.counts[table.category]===undefined||parent.counts[table.category]!==prepared.counts[table.category]
        ||parent.checksums[table.category]!==prepared.checksums[table.category]) throw new Error('Customer source differs from verified parent; reconcile source delta first');
    }
    const repeated=(await client.query('select * from migration.runs where id=$1',[receiptId])).rows[0];
    const seal=sha256(canonicalJson({parentId,checksum,sourceChecksum}));
    if(repeated&&(repeated.status!=='completed'||repeated.source_checksum_sha256?.trim()!==sourceChecksum||repeated.target_checksum_sha256?.trim()!==seal)) throw new Error('Customer-history receipt differs');
    if(!repeated) await client.query(`insert into migration.runs(id,source_system,source_snapshot,mode,status,source_counts,source_checksum_sha256,started_by)
      values($1,'staging_customer_history',$2,'cutover','running',$3,$4,$5)`,[receiptId,bundle.snapshot_id,JSON.stringify(prepared.counts),sourceChecksum,operator]);
    // The restricted source ledger preserves every row, including expired
    // challenges and excluded outreach. Nothing here enqueues an event or OTP.
    for(const row of bundle.rows){
      await client.query(`insert into migration.source_rows(run_id,entity_type,source_pk,payload,payload_sha256) values($1,$2,$3,$4,$5)
        on conflict(run_id,entity_type,source_pk) do nothing`,[receiptId,row.entity_type,row.source_pk,JSON.stringify(row.payload),row.payload_sha256]);
      const existing=(await client.query('select payload,payload_sha256 from migration.source_rows where run_id=$1 and entity_type=$2 and source_pk=$3',[receiptId,row.entity_type,row.source_pk])).rows[0];
      if(existing?.payload_sha256.trim()!==row.payload_sha256||canonicalJson(existing.payload)!==canonicalJson(row.payload)) throw new Error('Customer source preservation differs');
    }
    const profiles=new Map(prepared.grouped.get('user_profiles').map(r=>[r.source_pk,r.payload]));
    for(const row of prepared.grouped.get('notifications')){
      const p=row.payload,accountId=profiles.get(p.user_profile_id).auth_user_id;
      const account=(await client.query('select legacy_identity_user_id,source_system from auth.accounts where id=$1',[accountId])).rows[0];
      if(account?.source_system!=='legacy_identity'||account.legacy_identity_user_id!==accountId) throw new Error('Historical notification recipient is unresolved');
      if(p.patient_id&&!parent.grouped.get('patients').some(r=>r.source_pk===p.patient_id)) throw new Error('Historical notification patient is unresolved');
      await insertExactCustomerRow(client,'notification.imported_inbox_items',{id:p.id,account_id:accountId,patient_id:p.patient_id??null,
        source_run_id:receiptId,title:p.title,message:p.message,notification_type:p.type,source_read_at:p.read_at?new Date(p.read_at).toISOString():null,
        source_created_at:new Date(p.created_at).toISOString(),source_payload:p,source_sha256:row.payload_sha256},['id']);
    }
    let retained=0,mapped=0;
    for(const category of CONFIGURATION_CATEGORIES) for(const row of prepared.grouped.get(category)){
      const decision=decisions.get(`${category}:${row.source_pk}`);
      const decisionHash=decision?sha256(canonicalJson({decision,approved_by:mapping.approved_by,actor_subject:mapping.actor_subject,sourceChecksum})):null;
      await insertExactCustomerRow(client,'platform.imported_customer_configuration',{category,source_pk:row.source_pk,source_run_id:receiptId,
        source_payload:row.payload,source_sha256:row.payload_sha256,disposition:'retained-pending-activation',target_reference:null},['category','source_pk']);
      const priorMapping=(await client.query('select mapping_sha256 from platform.imported_configuration_mappings where category=$1 and source_pk=$2',[category,row.source_pk])).rows[0];
      if(priorMapping&&decision?.action!=='retain'&&decision&&priorMapping.mapping_sha256.trim()!==decisionHash) throw new Error('Previously mapped configuration decision differs');
      const disposition=decision?await applyNativeConfiguration(client,row,decision,{products:prepared.grouped.get('commercial_products'),decisions,
        actorSubject:mapping.actor_subject,repeated:!!priorMapping,correlationId:receiptId}) :{disposition:'retained-pending-activation',target:null};
      if(disposition.disposition==='mapped'){
        mapped++;
        await insertExactCustomerRow(client,'platform.imported_configuration_mappings',{category,source_pk:row.source_pk,mapping_sha256:decisionHash,
          target_reference:disposition.target,approved_by:mapping.approved_by},['category','source_pk']);
      }else retained++;
    }
    for(const table of CUSTOMER_SOURCE_TABLES){
      let disposition=table.disposition;
      // The source archive stays retained even when supported target fields are
      // mapped. Unsupported billing/AI/policy semantics never become active.
      await insertExactCustomerRow(client,'migration.customer_table_dispositions',{run_id:receiptId,source_table:table.table,
        source_count:String(prepared.counts[table.category]),source_checksum_sha256:prepared.checksums[table.category],disposition},['run_id','source_table']);
    }
    const targetNotifications=(await client.query('select count(*)::int n from notification.imported_inbox_items where source_run_id=$1',[receiptId])).rows[0].n;
    const preservedCount=(await client.query('select count(*)::int n from migration.source_rows where run_id=$1',[receiptId])).rows[0].n;
    const dispositions=(await client.query('select count(*)::int n from migration.customer_table_dispositions where run_id=$1',[receiptId])).rows[0].n;
    const configurationCount=(await client.query('select count(*)::int n from platform.imported_customer_configuration where source_run_id=$1',[receiptId])).rows[0].n;
    const expectedConfiguration=CONFIGURATION_CATEGORIES.reduce((n,c)=>n+prepared.counts[c],0);
    if(targetNotifications!==prepared.counts.notifications||preservedCount!==bundle.rows.length||dispositions!==29||configurationCount!==expectedConfiguration) throw new Error('Customer-history target counts differ');
    if(!repeated) await client.query(`update migration.runs set status='completed',target_counts=$2,target_checksum_sha256=$3,completed_at=clock_timestamp(),
      notes='Historical preservation; no notification or authentication replay; operational configuration requires explicit reviewed mappings' where id=$1`,
      [receiptId,JSON.stringify({notifications:targetNotifications,configuration_preserved:configurationCount,table_dispositions:dispositions}),seal]);
    await client.query(apply?'commit':'rollback');
    return {mode:apply?'applied':'dry-run',receipt_id:receiptId,notifications:targetNotifications,configuration_mapped:mapped,
      configuration_retained_pending_activation:retained,table_dispositions:dispositions,challenge_replay:false,operational_outreach_import:false,
      configuration_map_sha256:mapping?mappingHash:null,configuration_mapping_scope:'supported native fields only',nin_coverage:coverage};
  }catch(error){await client.query('rollback').catch(()=>{});if(error.code) throw new Error(`Customer-history database check failed (${error.code}); rolled back`);throw error;}
}
async function main(){
  const e=process.env,args=process.argv.slice(2);
  if(e.HID_DEPLOYMENT_ENV!=='staging'||args.some(a=>!['--dry-run','--apply'].includes(a))||(args.includes('--dry-run')&&args.includes('--apply'))) throw new Error('Choose a staging customer-history dry-run or apply');
  if(!e.MIGRATION_CUSTOMER_SOURCE_PATH||!e.MIGRATION_CUSTOMER_SOURCE_SHA256||!e.MIGRATION_CUSTOMER_SOURCE_CHECKSUM||!e.MIGRATION_PARENT_RUN_ID||!e.MIGRATION_PARENT_SOURCE_CHECKSUM||!e.MIGRATION_OPERATOR) throw new Error('Pinned protected source and verified parent are required');
  const bytes=await readFile(e.MIGRATION_CUSTOMER_SOURCE_PATH);if(sha256(bytes)!==e.MIGRATION_CUSTOMER_SOURCE_SHA256) throw new Error('Customer source bytes differ');
  let mapping;
  if(e.MIGRATION_CONFIGURATION_MAP_PATH){const bytes=await readFile(e.MIGRATION_CONFIGURATION_MAP_PATH);if(sha256(bytes)!==e.MIGRATION_CONFIGURATION_MAP_SHA256) throw new Error('Configuration decision bytes differ');mapping=JSON.parse(bytes);}
  const client=new pg.Client(databaseOptions(e.DATABASE_URL||managedDatabaseUrl(),'hid-customer-history-import'));
  try{await client.connect();console.log(JSON.stringify(await importCustomerHistory(client,{parentId:e.MIGRATION_PARENT_RUN_ID,checksum:e.MIGRATION_PARENT_SOURCE_CHECKSUM,
    bundle:JSON.parse(bytes),sourceChecksum:e.MIGRATION_CUSTOMER_SOURCE_CHECKSUM,operator:e.MIGRATION_OPERATOR,mapping,apply:args.includes('--apply')})));}
  finally{await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(e=>{process.stderr.write(e.code?'Customer-history operation failed; inspect privately.\n':e.message+'\n');process.exitCode=1;});
