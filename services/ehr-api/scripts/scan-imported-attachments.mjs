#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {GetObjectCommand,S3Client} from '@aws-sdk/client-s3';
import {canonicalJson,sha256} from './staging-cutover-additions.mjs';
import {scannerVersion,classifyScan,detectedType} from './attachment-safety.mjs';
const [output]=process.argv.slice(2),e=process.env;
if(e.HID_DEPLOYMENT_ENV!=='staging'||!output||!e.MIGRATION_PRIVATE_DIRECTORY||!e.MIGRATION_CLAMSCAN_PATH
  ||!path.isAbsolute(e.MIGRATION_CLAMSCAN_PATH)||!/^hid-staging-documents-[a-z0-9]+$/.test(e.MIGRATION_DOCUMENT_BUCKET??'')
  ||!e.MIGRATION_ATTACHMENT_MANIFEST_KEY||!e.MIGRATION_ATTACHMENT_MANIFEST_VERSION||!/^[a-f0-9]{64}$/.test(e.MIGRATION_ATTACHMENT_MANIFEST_SHA256??'')) throw new Error('Pinned staging manifest, private folder and absolute scanner executable are required');
const client=new S3Client({region:'eu-west-1'});let directory;
async function get(key,version){
  const r=await client.send(new GetObjectCommand({Bucket:e.MIGRATION_DOCUMENT_BUCKET,Key:key,VersionId:version,ChecksumMode:'ENABLED'}));
  if(r.VersionId!==version||r.ServerSideEncryption!=='aws:kms'||!r.SSEKMSKeyId||!r.Body||r.ContentLength>20*1024*1024) throw new Error('Pinned encrypted object is unavailable');
  const bytes=Buffer.from(await r.Body.transformToByteArray());
  if(bytes.length>20*1024*1024||r.ContentLength!==bytes.length) throw new Error('Object size differs');
  return bytes;
}
try{
  const executableHash=sha256(await readFile(e.MIGRATION_CLAMSCAN_PATH));
  const help=spawnSync(e.MIGRATION_CLAMSCAN_PATH,['--help'],{encoding:'utf8',timeout:10000});
  if(help.status!==0||!help.stdout.includes('--alert-exceeds-max')||!help.stdout.includes('--alert-encrypted')) throw new Error('Scanner lacks required complete-scan safeguards');
  const version=spawnSync(e.MIGRATION_CLAMSCAN_PATH,['--version'],{encoding:'utf8',timeout:10000});
  if(version.status!==0) throw new Error('Scanner version check failed');
  const engine=scannerVersion(version.stdout);
  const manifestBytes=await get(e.MIGRATION_ATTACHMENT_MANIFEST_KEY,e.MIGRATION_ATTACHMENT_MANIFEST_VERSION);
  if(sha256(manifestBytes)!==e.MIGRATION_ATTACHMENT_MANIFEST_SHA256) throw new Error('Manifest hash differs');
  const manifest=JSON.parse(manifestBytes.toString('utf8'));
  if(!Array.isArray(manifest.files)||manifest.files.length!==4||new Set(manifest.files.map(f=>f.source_file_id)).size!==4) throw new Error('Four unique imported files are required');
  directory=await mkdtemp(path.join(path.resolve(e.MIGRATION_PRIVATE_DIRECTORY),'attachment-scan-'));
  const files=[];
  for(const f of manifest.files){
    if(!/^[a-f0-9-]{36}$/.test(f.source_file_id??'')||f.destination_key!==`migration-quarantine/${manifest.source_snapshot_id}/medical-files/${f.source_file_id}`||!f.destination_version_id) throw new Error('Manifest object coordinate differs');
    const bytes=await get(f.destination_key,f.destination_version_id);
    if(sha256(bytes)!==f.sha256||bytes.length!==f.size_bytes||bytes.length===0) throw new Error('Attachment bytes differ');
    const filePath=path.join(directory,f.source_file_id);await writeFile(filePath,bytes,{flag:'wx',mode:0o600});
    const scan=spawnSync(e.MIGRATION_CLAMSCAN_PATH,['--no-summary','--stdout','--official-db-only=yes','--scan-archive=yes',
      '--alert-encrypted=yes','--alert-exceeds-max=yes','--max-filesize=21M','--max-scansize=100M',filePath],{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
    if(sha256(await readFile(filePath))!==f.sha256||sha256(await readFile(e.MIGRATION_CLAMSCAN_PATH))!==executableHash) throw new Error('File/scanner changed during scanning');
    const item={file_id:f.source_file_id,key:f.destination_key,version_id:f.destination_version_id,sha256:f.sha256,size_bytes:f.size_bytes,
      ...engine,scanner_binary_sha256:executableHash,scanned_at:new Date().toISOString(),result:classifyScan(scan.status,scan.stdout??'',scan.stderr??''),
      detected_media_type:detectedType(bytes),scanner_output_sha256:sha256(`${scan.status}\n${scan.stdout??''}\n${scan.stderr??''}`)};
    files.push({...item,report_sha256:sha256(canonicalJson(item))});
  }
  const report={schema:'hid.imported-attachment-scan/v1',bucket:e.MIGRATION_DOCUMENT_BUCKET,
    manifest_sha256:e.MIGRATION_ATTACHMENT_MANIFEST_SHA256,manifest_version_id:e.MIGRATION_ATTACHMENT_MANIFEST_VERSION,files};
  const bytes=Buffer.from(JSON.stringify(report));await writeFile(output,bytes,{flag:'wx',mode:0o600});
  console.log(JSON.stringify({file_count:files.length,clean:files.filter(f=>f.result==='clean').length,
    infected:files.filter(f=>f.result==='infected').length,errors:files.filter(f=>f.result==='error').length,report_sha256:sha256(bytes)}));
  if(files.some(f=>f.result!=='clean')) process.exitCode=1;
}catch(error){process.stderr.write('Attachment safety scan failed; inspect scanner/input privately.\n');process.exitCode=1;}
finally{
  client.destroy();if(directory){const root=path.resolve(e.MIGRATION_PRIVATE_DIRECTORY);if(!path.resolve(directory).startsWith(root+path.sep)) throw new Error('Unsafe scan cleanup path');await rm(directory,{recursive:true,force:true});}
}
