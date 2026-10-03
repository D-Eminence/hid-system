import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {syntheticMedicalSource} from './medical-import-fixture.mjs';
import {syntheticCustomerSource} from './customer-history-fixture.mjs';
import {canonicalJson,sha256} from './staging-cutover-additions.mjs';
import {encodedInput,buildCustomerImportInput,decodeCustomerImportInput,validatePinnedCustomerInput,verifiedS3Bytes} from './customer-import-input.mjs';
import {publishCustomerInput} from './publish-staging-customer-inputs.mjs';
import {customerImportContext,dispatchCustomerImport} from './run-staging-customer-import.mjs';

const bucket='hid-migration-source-synthetic',kmsKey='arn:aws:kms:eu-west-1:659225405023:key/11111111-1111-4111-8111-111111111111';
function fixture(){
  const bundle=syntheticCustomerSource(syntheticMedicalSource()),context={operation:'CustomerHistory',parentId:randomUUID(),checksum:'b'.repeat(64),fixtureSha256:'a'.repeat(64),bucket,kmsKey};
  const bytes=buildCustomerImportInput(context.operation,{source:encodedInput(Buffer.from(JSON.stringify(bundle))),source_checksum:bundle.checksum},context);
  const ref={schema:'hid.staging-customer-input-ref/v1',operation:context.operation,bucket,key:`migration-inputs/${randomUUID()}/customer-history.json`,
    version_id:'synthetic-version',sha256:sha256(bytes),size_bytes:bytes.length,kms_key_arn:kmsKey,parent_run_id:context.parentId,
    parent_source_checksum:context.checksum,fixture_sha256:context.fixtureSha256};
  return {bundle,context,bytes,ref};
}
function response(bytes,ref){return {Body:Readable.from([bytes]),VersionId:ref.version_id,ContentLength:bytes.length,ServerSideEncryption:'aws:kms',SSEKMSKeyId:kmsKey};}
test('pinned package preserves complete source bytes and explicit preservation decisions',()=>{
  const {bundle,context,bytes}=fixture(),decoded=decodeCustomerImportInput(bytes,context);
  assert.deepEqual(decoded.bundle,bundle);assert.equal(decoded.sourceChecksum,bundle.checksum);assert.equal(decoded.mapping,undefined);
  assert.equal(decoded.bundle.counts.notifications,193);
});
test('wrong operation, parent, fixture, embedded bytes and unsupported schema cannot enter a database import',async()=>{
  const {context,bytes}=fixture();
  for(const change of [{operation:'AttachmentEvidence'},{parentId:randomUUID()},{checksum:'c'.repeat(64)},{fixtureSha256:'d'.repeat(64)}])
    assert.throws(()=>decodeCustomerImportInput(bytes,{...context,...change}),/parent differs/);
  const tampered=JSON.parse(bytes);tampered.payload.source.bytes_b64=Buffer.from('{}').toString('base64');
  assert.throws(()=>decodeCustomerImportInput(Buffer.from(JSON.stringify(tampered)),context),/bytes differ/);
  const unknown=JSON.parse(bytes);unknown.payload.unreviewed_rules=true;
  assert.throws(()=>decodeCustomerImportInput(Buffer.from(JSON.stringify(unknown)),context),/shape/);
  await assert.rejects(dispatchCustomerImport({query(){throw new Error('Database must not be reached');}},
    {operation:'CustomerHistory',e:{},inputBytes:bytes}),/staging parent/);
});
test('package references cannot select latest objects, another bucket/key or unbounded bytes',()=>{
  const {context,ref}=fixture(),options={operation:context.operation,expectedBucket:bucket,expectedKmsKey:kmsKey};
  assert.equal(validatePinnedCustomerInput(ref,options),ref);
  for(const change of [{version_id:'null'},{bucket:'unapproved'},{key:'migration-fixtures/old.json'},{size_bytes:17000000},{operation:'AttachmentEvidence'},
    {kms_key_arn:'unapproved'},{sha256:'invalid'},{additional:'ignored'}]) assert.throws(()=>validatePinnedCustomerInput({...ref,...change},options),/reference|shape/);
});
test('S3 verification denies changed version, KMS key, hash, declared size and oversized streams',async()=>{
  const {bytes,ref}=fixture();assert.deepEqual(await verifiedS3Bytes(response(bytes,ref),ref,kmsKey),bytes);
  for(const change of [{VersionId:'different'},{SSEKMSKeyId:'different'},{ServerSideEncryption:'AES256'},{ContentLength:1}])
    await assert.rejects(verifiedS3Bytes({...response(bytes,ref),...change},ref,kmsKey),/object differs/);
  await assert.rejects(verifiedS3Bytes(response(bytes,ref),{...ref,sha256:'f'.repeat(64)},kmsKey),/hash or size/);
  const overflow={...response(bytes,ref),Body:Readable.from([bytes,Buffer.from('unexpected')])};
  await assert.rejects(verifiedS3Bytes(overflow,ref,kmsKey),/size differs/);
});
test('publisher encrypts inputs, pins returned version and independently verifies uploaded bytes',async()=>{
  const {bytes,context}=fixture(),calls=[];
  const s3={async send(command){calls.push(command.input);if(calls.length===1)return {VersionId:'synthetic-version'};
    return response(bytes,{version_id:command.input.VersionId});}};
  const ref=await publishCustomerInput(s3,bytes,context);
  assert.equal(calls[0].ServerSideEncryption,'aws:kms');assert.equal(calls[0].SSEKMSKeyId,kmsKey);
  assert.equal(calls[0].ChecksumSHA256,Buffer.from(sha256(bytes),'hex').toString('base64'));
  assert.equal(calls[1].VersionId,'synthetic-version');assert.equal(ref.sha256,sha256(bytes));
  const invalid={async send(){return {VersionId:undefined};}};
  await assert.rejects(publishCustomerInput(invalid,bytes,context),/reference/);
});
test('attachment package binds original manifest bytes, scan report and source fixture',()=>{
  const {context}=fixture(),manifest={fixture_sha256:context.fixtureSha256},manifestBytes=Buffer.from(JSON.stringify(manifest));
  const payload={manifest:encodedInput(manifestBytes),manifest_version_id:'synthetic-manifest',bucket:'hid-staging-documents-synthetic',
    report:encodedInput(Buffer.from(canonicalJson({bucket:'hid-staging-documents-synthetic',manifest_version_id:'synthetic-manifest',manifest_sha256:sha256(manifestBytes)})))};
  const bytes=buildCustomerImportInput('AttachmentEvidence',payload,context);
  assert.equal(decodeCustomerImportInput(bytes,{...context,operation:'AttachmentEvidence'}).manifestSha256,sha256(manifestBytes));
  const changed=structuredClone(payload);changed.manifest_version_id='different';
  assert.throws(()=>buildCustomerImportInput('AttachmentEvidence',changed,context),/provenance/);
});
test('dispatcher requires staging parent/operator and rejects production or missing field-key inputs',async()=>{
  const {context}=fixture(),e={HID_DEPLOYMENT_ENV:'staging',MIGRATION_PARENT_RUN_ID:context.parentId,MIGRATION_PARENT_SOURCE_CHECKSUM:context.checksum,
    MIGRATION_FIXTURE_SHA256:context.fixtureSha256,MIGRATION_OPERATOR:'synthetic-test'};
  assert.equal(customerImportContext('HealthProfiles',e).parentId,context.parentId);
  assert.throws(()=>customerImportContext('HealthProfiles',{...e,HID_DEPLOYMENT_ENV:'production'}),/staging parent/);
  await assert.rejects(dispatchCustomerImport({}, {operation:'HealthProfiles',e}),/field key/);
});
test('dispatcher CLI requires an explicit mode and emits no private environment values on failure',()=>{
  const privateValue='synthetic-private-do-not-print';
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./run-staging-customer-import.mjs',import.meta.url)),'CustomerHistory'],
    {encoding:'utf8',env:{...process.env,DATABASE_URL:privateValue,HID_DEPLOYMENT_ENV:'staging'}});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Staging customer import failed/);assert.doesNotMatch(result.stderr,new RegExp(privateValue));
});
