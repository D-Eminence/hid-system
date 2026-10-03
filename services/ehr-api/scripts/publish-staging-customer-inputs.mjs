#!/usr/bin/env node
import {readFile,writeFile,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {S3Client,PutObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {pathToFileURL} from 'node:url';
import {encodedInput,buildCustomerImportInput,validatePinnedCustomerInput,verifiedS3Bytes,CUSTOMER_INPUT_LIMIT} from './customer-import-input.mjs';
import {sha256} from './staging-cutover-additions.mjs';
async function privateBytes(file,expectedHash){
  const size=(await stat(file)).size;
  if(size<1||size>CUSTOMER_INPUT_LIMIT) throw new Error('Protected input size is unsupported');
  const bytes=await readFile(file);if(sha256(bytes)!==expectedHash) throw new Error('Protected input changed');return bytes;
}
export async function publishCustomerInput(s3,bytes,context){
  const {operation,parentId,checksum,fixtureSha256,bucket,kmsKey}=context;
  const ref={schema:'hid.staging-customer-input-ref/v1',operation,bucket,
    key:`migration-inputs/${randomUUID()}/${operation==='CustomerHistory'?'customer-history':'attachment-evidence'}.json`,
    version_id:'pending',sha256:sha256(bytes),size_bytes:bytes.length,kms_key_arn:kmsKey,
    parent_run_id:parentId,parent_source_checksum:checksum,fixture_sha256:fixtureSha256};
  validatePinnedCustomerInput(ref,{operation,expectedBucket:bucket,expectedKmsKey:kmsKey});
  const stored=await s3.send(new PutObjectCommand({Bucket:bucket,Key:ref.key,Body:bytes,ContentType:'application/json',
    ServerSideEncryption:'aws:kms',SSEKMSKeyId:kmsKey,ChecksumSHA256:Buffer.from(ref.sha256,'hex').toString('base64')}));
  ref.version_id=stored.VersionId;
  validatePinnedCustomerInput(ref,{operation,expectedBucket:bucket,expectedKmsKey:kmsKey});
  const readback=await s3.send(new GetObjectCommand({Bucket:bucket,Key:ref.key,VersionId:ref.version_id,ChecksumMode:'ENABLED'}));
  await verifiedS3Bytes(readback,ref,kmsKey);
  return ref;
}
async function main(){
  const [operation,inputMetadataPath,parentPath,fixturePath,reconciliationPath,outputPath,mapPath]=process.argv.slice(2),e=process.env;
  if(e.HID_DEPLOYMENT_ENV!=='staging'||!['CustomerHistory','AttachmentEvidence'].includes(operation)
    ||!inputMetadataPath||!parentPath||!fixturePath||!reconciliationPath||!outputPath||(mapPath&&operation!=='CustomerHistory')) throw new Error('Protected staging metadata inputs are required');
  const parent=JSON.parse(await readFile(parentPath,'utf8')),fixture=JSON.parse(await readFile(fixturePath,'utf8')),
    reconciliation=JSON.parse(await readFile(reconciliationPath,'utf8')),metadata=JSON.parse(await readFile(inputMetadataPath,'utf8'));
  if(parent.staging_task_exit_code!==0||parent.fixture_sha256!==fixture.sha256||parent.snapshot_id!==fixture.snapshot_id
    ||parent.source_checksum_sha256!==fixture.overall_checksum||reconciliation.exit_code!==0||reconciliation.run_id!==parent.run_id
    ||reconciliation.source_checksum_sha256!==parent.source_checksum_sha256) throw new Error('Successful parent/source/reconciliation evidence must agree');
  const context={operation,parentId:parent.run_id,checksum:parent.source_checksum_sha256,fixtureSha256:fixture.sha256,
    bucket:e.MIGRATION_INPUT_BUCKET,kmsKey:e.MIGRATION_INPUT_KMS_KEY_ARN};
  let payload;
  if(operation==='CustomerHistory'){
    payload={source:encodedInput(await privateBytes(metadata.protected_source_path,metadata.sha256)),source_checksum:metadata.source_checksum};
    if(mapPath){const bytes=await readFile(mapPath);payload.configuration_map=encodedInput(bytes);}
  }else{
    if(metadata.fixture_sha256!==fixture.sha256) throw new Error('Attachment fixture metadata differs');
    const manifest=encodedInput(await privateBytes(metadata.protected_manifest_path,metadata.manifest_sha256));
    const value=JSON.parse(Buffer.from(manifest.bytes_b64,'base64'));
    if(value.fixture_snapshot_id!==fixture.snapshot_id) throw new Error('Attachment snapshot differs');
    const report=encodedInput(await privateBytes(metadata.protected_report_path,metadata.report_sha256));
    payload={manifest,manifest_version_id:metadata.manifest_version_id,report,bucket:JSON.parse(Buffer.from(report.bytes_b64,'base64')).bucket};
  }
  const bytes=buildCustomerImportInput(operation,payload,context),s3=new S3Client({region:'eu-west-1'});
  try{
    const ref=await publishCustomerInput(s3,bytes,context);
    await writeFile(outputPath,JSON.stringify(ref,null,2),{flag:'wx',mode:0o600});
    console.log(JSON.stringify(ref));
  }finally{s3.destroy();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(()=>{
  process.stderr.write('Protected staging input publication failed; inspect access and metadata privately.\n');process.exitCode=1;
});
