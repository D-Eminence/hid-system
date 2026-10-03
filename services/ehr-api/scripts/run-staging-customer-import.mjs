#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3';
import {databaseOptions,managedDatabaseUrl} from './database-options.mjs';
import {preservedMigrationKey} from './preserved-migration-key.mjs';
import {decodeCustomerImportInput,validatePinnedCustomerInput,verifiedS3Bytes} from './customer-import-input.mjs';
import {validUuid} from './customer-data-validation.mjs';
import {importHealthProfiles} from './import-staging-health-profiles.mjs';
import {importAttachmentEvidence} from './import-staging-attachment-evidence.mjs';
import {importCustomerHistory} from './import-staging-customer-history.mjs';

export function customerImportContext(operation,e){
  if(e.HID_DEPLOYMENT_ENV!=='staging'||!['HealthProfiles','AttachmentEvidence','CustomerHistory'].includes(operation)
    ||!validUuid(e.MIGRATION_PARENT_RUN_ID)||!/^[a-f0-9]{64}$/.test(e.MIGRATION_PARENT_SOURCE_CHECKSUM??'')
    ||!/^[a-f0-9]{64}$/.test(e.MIGRATION_FIXTURE_SHA256??'')
    ||!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,127}$/.test(e.MIGRATION_OPERATOR??'')) throw new Error('Verified staging parent and operator are required');
  return {parentId:e.MIGRATION_PARENT_RUN_ID,checksum:e.MIGRATION_PARENT_SOURCE_CHECKSUM,operator:e.MIGRATION_OPERATOR,fixtureSha256:e.MIGRATION_FIXTURE_SHA256};
}
export async function dispatchCustomerImport(client,{operation,e,inputBytes,s3,apply=false}){
  const context=customerImportContext(operation,e);
  if(operation==='HealthProfiles'){
    if(inputBytes!==undefined||e.MIGRATION_FIELD_KEY_REFERENCE!=='staging-migration-v1') throw new Error('Preserved staging field key is required');
    return importHealthProfiles(client,{...context,apply,keyReference:e.MIGRATION_FIELD_KEY_REFERENCE,
      fieldKey:preservedMigrationKey(e.MIGRATION_FIELD_ENCRYPTION_KEY_B64)});
  }
  const input=decodeCustomerImportInput(inputBytes,{...context,operation});
  if(operation==='CustomerHistory') return importCustomerHistory(client,{...context,...input,apply});
  if(input.bucket!==e.MIGRATION_DOCUMENT_BUCKET||!/^arn:aws:kms:eu-west-1:659225405023:key\/[a-f0-9-]{36}$/.test(e.MIGRATION_DOCUMENT_KMS_KEY_ARN??'')) throw new Error('Accepted staging document coordinates are required');
  return importAttachmentEvidence(client,{...context,...input,apply,verifyObject:async(key,versionId)=>{
    const file=input.manifest.files.find(f=>f.destination_key===key&&f.destination_version_id===versionId);
    if(!file) throw new Error('Attachment version is outside the pinned manifest');
    const ref={version_id:versionId,sha256:file.sha256,size_bytes:file.size_bytes};
    const response=await s3.send(new GetObjectCommand({Bucket:input.bucket,Key:key,VersionId:versionId,ChecksumMode:'ENABLED'}));
    await verifiedS3Bytes(response,ref,e.MIGRATION_DOCUMENT_KMS_KEY_ARN,20*1024*1024);
    return {versionId,sha256:ref.sha256,sizeBytes:ref.size_bytes,encrypted:true};
  }});
}
async function main(){
  const [operation,...flags]=process.argv.slice(2),e=process.env;
  if(flags.length!==1||!['--dry-run','--apply'].includes(flags[0])) throw new Error('Choose exactly one staging import mode');
  const context=customerImportContext(operation,e),s3=new S3Client({region:'eu-west-1'});
  let client;
  try{
    let inputBytes;
    if(operation!=='HealthProfiles'){
      const ref=validatePinnedCustomerInput({schema:'hid.staging-customer-input-ref/v1',operation,bucket:e.MIGRATION_INPUT_BUCKET,
        key:e.MIGRATION_INPUT_KEY,version_id:e.MIGRATION_INPUT_VERSION,sha256:e.MIGRATION_INPUT_SHA256,size_bytes:Number(e.MIGRATION_INPUT_SIZE),
        kms_key_arn:e.MIGRATION_INPUT_KMS_KEY_ARN,parent_run_id:context.parentId,parent_source_checksum:context.checksum,fixture_sha256:context.fixtureSha256},
        {operation,expectedBucket:e.MIGRATION_ACCEPTED_INPUT_BUCKET,expectedKmsKey:e.MIGRATION_ACCEPTED_INPUT_KMS_KEY_ARN});
      inputBytes=await verifiedS3Bytes(await s3.send(new GetObjectCommand({Bucket:ref.bucket,Key:ref.key,VersionId:ref.version_id,ChecksumMode:'ENABLED'})),ref,ref.kms_key_arn);
      decodeCustomerImportInput(inputBytes,{...context,operation});
    }
    client=new pg.Client(databaseOptions(e.DATABASE_URL||managedDatabaseUrl(),'hid-staging-customer-import'));
    await client.connect();
    console.log(JSON.stringify(await dispatchCustomerImport(client,{operation,e,inputBytes,s3,apply:flags[0]==='--apply'})));
  }finally{s3.destroy();if(client) await client.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(()=>{
  process.stderr.write('Staging customer import failed; inspect protected inputs and migration evidence privately.\n');process.exitCode=1;
});
