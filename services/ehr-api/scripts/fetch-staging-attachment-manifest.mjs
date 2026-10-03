#!/usr/bin/env node
import {writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {GetObjectCommand,S3Client} from '@aws-sdk/client-s3';
import {sha256} from './staging-cutover-additions.mjs';
const [folder,fixtureMetadataPath]=process.argv.slice(2),e=process.env;
if(e.HID_DEPLOYMENT_ENV!=='staging'||!folder||!fixtureMetadataPath||!/^hid-staging-documents-[a-z0-9]+$/.test(e.MIGRATION_DOCUMENT_BUCKET??'')
  ||!e.MIGRATION_ATTACHMENT_MANIFEST_KEY?.startsWith('migration-quarantine/')||!e.MIGRATION_ATTACHMENT_MANIFEST_VERSION) throw new Error('Pinned staging file-manifest inputs are required');
const s3=new S3Client({region:'eu-west-1'});
try{
  const fixture=JSON.parse(await readFile(fixtureMetadataPath,'utf8'));
  const r=await s3.send(new GetObjectCommand({Bucket:e.MIGRATION_DOCUMENT_BUCKET,Key:e.MIGRATION_ATTACHMENT_MANIFEST_KEY,
    VersionId:e.MIGRATION_ATTACHMENT_MANIFEST_VERSION,ChecksumMode:'ENABLED'}));
  if(r.VersionId!==e.MIGRATION_ATTACHMENT_MANIFEST_VERSION||!r.Body||r.ServerSideEncryption!=='aws:kms'||!r.SSEKMSKeyId||r.ContentLength>1048576) throw new Error('Pinned encrypted file manifest is unavailable');
  const bytes=Buffer.from(await r.Body.transformToByteArray());if(bytes.length>1048576) throw new Error('File manifest exceeds its supported size');
  const manifest=JSON.parse(bytes);
  if(manifest.fixture_sha256!==fixture.sha256||manifest.fixture_snapshot_id!==fixture.snapshot_id||manifest.files?.length!==4) throw new Error('File manifest differs from the protected source fixture');
  const target=path.join(folder,'manifest.json');await writeFile(target,bytes,{flag:'wx',mode:0o600});
  console.log(JSON.stringify({protected_manifest_path:target,manifest_sha256:sha256(bytes),manifest_version_id:r.VersionId,file_count:manifest.files.length,
    total_bytes:manifest.files.reduce((n,f)=>n+f.size_bytes,0),fixture_sha256:fixture.sha256}));
}catch{process.stderr.write('Pinned attachment-manifest retrieval failed; inspect access privately.\n');process.exitCode=1;}
finally{s3.destroy();}
