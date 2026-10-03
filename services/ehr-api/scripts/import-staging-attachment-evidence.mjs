#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {GetObjectCommand,S3Client} from '@aws-sdk/client-s3';
import {verifiedParent,insertExactCustomerRow} from './customer-import-context.mjs';
import {validateAttachmentEvidence} from './attachment-safety.mjs';
import {canonicalJson,sha256,deterministicUuid} from './staging-cutover-additions.mjs';
import {databaseOptions,managedDatabaseUrl} from './database-options.mjs';
export async function importAttachmentEvidence(client,options){
  const {parentId,checksum,operator,manifest,report,manifestSha256,manifestVersionId,bucket,fixtureSha256,verifyObject,apply=false}=options;
  if(typeof verifyObject!=='function') throw new Error('Independent exact-version object verification is required');
  await client.query('begin isolation level serializable');
  try{
    await client.query("select pg_advisory_xact_lock(hashtextextended('hid-imported-attachment-evidence',0))");
    const source=await verifiedParent(client,parentId,checksum);
    if(manifest.fixture_snapshot_id!==source.parent.source_snapshot) throw new Error('Attachment fixture snapshot differs from parent');
    const files=source.grouped.get('medical_record_files');if(!files) throw new Error('Medical file source category is missing');
    const prepared=validateAttachmentEvidence(manifest,report,{manifestSha256,manifestVersionId,bucket,fixtureSha256,sourceFiles:files});
    for(const {file,source:row,scan} of prepared){
      const existing=(await client.query(`select f.*,r.source_run_id from ehr.imported_medical_record_files f
        join ehr.imported_medical_records r on r.id=f.record_id and r.patient_id=f.patient_id where f.id=$1`,[row.source_pk])).rows[0];
      if(existing?.source_run_id!==parentId||existing.source_sha256.trim()!==row.payload_sha256.trim()
        ||canonicalJson(existing.source_payload)!==canonicalJson(row.payload)) throw new Error('Imported attachment source association differs');
      const actual=await verifyObject(file.destination_key,file.destination_version_id);
      if(actual.versionId!==file.destination_version_id||actual.sha256!==file.sha256||actual.sizeBytes!==file.size_bytes
        ||actual.encrypted!==true) throw new Error('Independent attachment object integrity differs');
      await insertExactCustomerRow(client,'ehr.imported_attachment_bindings',{file_id:row.source_pk,patient_id:existing.patient_id,
        storage_bucket:bucket,storage_key:file.destination_key,object_version_id:file.destination_version_id,sha256_hex:file.sha256,
        size_bytes:String(file.size_bytes),manifest_sha256:manifestSha256,manifest_version_id:manifestVersionId},['file_id']);
      const scanId=deterministicUuid(`imported-attachment-scan:${row.source_pk}:${scan.report_sha256}`);
      const latest=(await client.query('select id,scanned_at from ehr.imported_attachment_scan_events where file_id=$1 order by sequence_id desc limit 1',[row.source_pk])).rows[0];
      if(latest&&latest.id!==scanId&&new Date(latest.scanned_at)>=new Date(scan.scanned_at)) throw new Error('Older or simultaneous scan cannot supersede a newer safety result');
      await insertExactCustomerRow(client,'ehr.imported_attachment_scan_events',{id:scanId,file_id:row.source_pk,patient_id:existing.patient_id,
        sha256_hex:file.sha256,object_version_id:file.destination_version_id,result:scan.result,detected_media_type:scan.detected_media_type,
        scanner:scan.scanner,scanner_version:scan.scanner_version,signatures_version:scan.signatures_version,
        signatures_updated_at:scan.signatures_updated_at,scanned_at:scan.scanned_at,report_sha256:scan.report_sha256,recorded_by:operator},['id']);
    }
    const bindings=(await client.query(`select count(*)::int n from ehr.imported_attachment_bindings b join ehr.imported_medical_record_files f on f.id=b.file_id
      join ehr.imported_medical_records r on r.id=f.record_id where r.source_run_id=$1`,[parentId])).rows[0].n;
    if(bindings!==files.length) throw new Error('Attachment binding target count differs');
    await client.query(apply?'commit':'rollback');
    return {mode:apply?'applied':'dry-run',bindings,clean:prepared.filter(f=>f.scan.result==='clean').length,
      infected:prepared.filter(f=>f.scan.result==='infected').length,errors:prepared.filter(f=>f.scan.result==='error').length};
  }catch(error){await client.query('rollback').catch(()=>{});if(error.code) throw new Error(`Attachment database check failed (${error.code}); rolled back`);throw error;}
}
async function main(){
  const args=process.argv.slice(2),e=process.env;
  if(args.some(a=>!['--dry-run','--apply'].includes(a))||(args.includes('--dry-run')&&args.includes('--apply'))||e.HID_DEPLOYMENT_ENV!=='staging') throw new Error('Choose a staging attachment-evidence dry-run or apply');
  const required=['MIGRATION_PARENT_RUN_ID','MIGRATION_PARENT_SOURCE_CHECKSUM','MIGRATION_OPERATOR','MIGRATION_ATTACHMENT_MANIFEST_PATH',
    'MIGRATION_ATTACHMENT_MANIFEST_SHA256','MIGRATION_ATTACHMENT_MANIFEST_VERSION','MIGRATION_ATTACHMENT_SCAN_REPORT_PATH',
    'MIGRATION_ATTACHMENT_SCAN_REPORT_SHA256','MIGRATION_FIXTURE_SHA256','MIGRATION_DOCUMENT_BUCKET'];
  if(required.some(k=>!e[k])) throw new Error('Pinned protected attachment inputs are required');
  const manifestBytes=await readFile(e.MIGRATION_ATTACHMENT_MANIFEST_PATH),reportBytes=await readFile(e.MIGRATION_ATTACHMENT_SCAN_REPORT_PATH);
  if(sha256(manifestBytes)!==e.MIGRATION_ATTACHMENT_MANIFEST_SHA256||sha256(reportBytes)!==e.MIGRATION_ATTACHMENT_SCAN_REPORT_SHA256) throw new Error('Protected attachment evidence hash differs');
  const s3=new S3Client({region:'eu-west-1'}),client=new pg.Client(databaseOptions(e.DATABASE_URL||managedDatabaseUrl(),'hid-attachment-evidence-import'));
  try{
    await client.connect();
    const result=await importAttachmentEvidence(client,{parentId:e.MIGRATION_PARENT_RUN_ID,checksum:e.MIGRATION_PARENT_SOURCE_CHECKSUM,operator:e.MIGRATION_OPERATOR,
      manifest:JSON.parse(manifestBytes),report:JSON.parse(reportBytes),manifestSha256:e.MIGRATION_ATTACHMENT_MANIFEST_SHA256,
      manifestVersionId:e.MIGRATION_ATTACHMENT_MANIFEST_VERSION,bucket:e.MIGRATION_DOCUMENT_BUCKET,fixtureSha256:e.MIGRATION_FIXTURE_SHA256,
      apply:args.includes('--apply'),verifyObject:async(key,version)=>{
        const r=await s3.send(new GetObjectCommand({Bucket:e.MIGRATION_DOCUMENT_BUCKET,Key:key,VersionId:version,ChecksumMode:'ENABLED'}));
        if(!r.Body||r.ContentLength>20971520) throw new Error('Attachment bytes unavailable');
        const bytes=Buffer.from(await r.Body.transformToByteArray());if(bytes.length>20971520) throw new Error('Attachment exceeds supported size');
        return {versionId:r.VersionId,sha256:sha256(bytes),sizeBytes:bytes.length,encrypted:r.ServerSideEncryption==='aws:kms'&&!!r.SSEKMSKeyId};
      }});
    console.log(JSON.stringify(result));
  }finally{s3.destroy();await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(e=>{process.stderr.write(e.code?'Attachment operation failed; inspect privately.\n':e.message+'\n');process.exitCode=1;});
