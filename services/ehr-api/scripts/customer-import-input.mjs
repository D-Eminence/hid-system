import {canonicalJson,sha256} from './staging-cutover-additions.mjs';
import {prepareCustomerSource,validUuid} from './customer-data-validation.mjs';
import {configurationDecisions} from './customer-configuration-mapping.mjs';

export const CUSTOMER_INPUT_LIMIT=16*1024*1024;
export const CUSTOMER_INPUT_OPERATIONS=new Set(['CustomerHistory','AttachmentEvidence']);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const version=value=>typeof value==='string'&&value!=='null'&&/^[A-Za-z0-9+_./=-]{1,1024}$/.test(value);
function object(value,required,optional=[]){
  if(!value||typeof value!=='object'||Array.isArray(value)||required.some(k=>!Object.hasOwn(value,k))
    ||Object.keys(value).some(k=>![...required,...optional].includes(k))) throw new Error('Customer input shape is invalid');
}
export function encodedInput(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>CUSTOMER_INPUT_LIMIT) throw new Error('Protected input size is invalid');
  return {sha256:sha256(bytes),size_bytes:bytes.length,bytes_b64:bytes.toString('base64')};
}
function decodedInput(value){
  object(value,['sha256','size_bytes','bytes_b64']);
  if(!hash(value.sha256)||!Number.isSafeInteger(value.size_bytes)||value.size_bytes<1||value.size_bytes>CUSTOMER_INPUT_LIMIT
    ||typeof value.bytes_b64!=='string'||value.bytes_b64.length>Math.ceil(CUSTOMER_INPUT_LIMIT/3)*4
    ||!/^[A-Za-z0-9+/]+={0,2}$/.test(value.bytes_b64)) throw new Error('Protected input encoding is invalid');
  const bytes=Buffer.from(value.bytes_b64,'base64');
  if(bytes.toString('base64')!==value.bytes_b64||bytes.length!==value.size_bytes||sha256(bytes)!==value.sha256) throw new Error('Protected input bytes differ');
  try{return JSON.parse(bytes);}catch{throw new Error('Protected input JSON is invalid');}
}
export function decodeCustomerImportInput(bytes,{operation,parentId,checksum,fixtureSha256}){
  if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>CUSTOMER_INPUT_LIMIT) throw new Error('Customer package size is invalid');
  let input;try{input=JSON.parse(bytes);}catch{throw new Error('Customer package JSON is invalid');}
  object(input,['schema','operation','parent_run_id','parent_source_checksum','fixture_sha256','payload']);
  if(input.schema!=='hid.staging-customer-input/v1'||!CUSTOMER_INPUT_OPERATIONS.has(operation)||input.operation!==operation
    ||!validUuid(parentId)||input.parent_run_id!==parentId||!hash(checksum)||input.parent_source_checksum!==checksum
    ||!hash(fixtureSha256)||input.fixture_sha256!==fixtureSha256) throw new Error('Customer package operation or parent differs');
  const p=input.payload;
  if(operation==='CustomerHistory'){
    object(p,['source','source_checksum'],['configuration_map']);
    if(!hash(p.source_checksum)) throw new Error('Customer source checksum is invalid');
    const bundle=decodedInput(p.source),prepared=prepareCustomerSource(bundle,p.source_checksum);
    const mapping=p.configuration_map?decodedInput(p.configuration_map):undefined;
    configurationDecisions(prepared,mapping);
    return {bundle,sourceChecksum:p.source_checksum,mapping};
  }
  object(p,['manifest','manifest_version_id','report','bucket']);
  if(!version(p.manifest_version_id)||!/^hid-staging-documents-[a-z0-9]+$/.test(p.bucket??'')) throw new Error('Attachment package coordinates are invalid');
  const manifest=decodedInput(p.manifest),report=decodedInput(p.report);
  if(manifest.fixture_sha256!==fixtureSha256||report.manifest_sha256!==p.manifest.sha256
    ||report.manifest_version_id!==p.manifest_version_id||report.bucket!==p.bucket) throw new Error('Attachment package provenance differs');
  return {manifest,report,manifestSha256:p.manifest.sha256,manifestVersionId:p.manifest_version_id,bucket:p.bucket,fixtureSha256};
}
export function buildCustomerImportInput(operation,payload,{parentId,checksum,fixtureSha256}){
  const bytes=Buffer.from(canonicalJson({schema:'hid.staging-customer-input/v1',operation,
    parent_run_id:parentId,parent_source_checksum:checksum,fixture_sha256:fixtureSha256,payload}));
  decodeCustomerImportInput(bytes,{operation,parentId,checksum,fixtureSha256});
  return bytes;
}
export function validatePinnedCustomerInput(ref,{operation,expectedBucket,expectedKmsKey}){
  object(ref,['schema','operation','bucket','key','version_id','sha256','size_bytes','kms_key_arn','parent_run_id','parent_source_checksum','fixture_sha256']);
  const file=operation==='CustomerHistory'?'customer-history':'attachment-evidence';
  if(ref.schema!=='hid.staging-customer-input-ref/v1'||!CUSTOMER_INPUT_OPERATIONS.has(operation)||ref.operation!==operation
    ||!/^hid-migration-source-[a-z0-9]+$/.test(expectedBucket??'')||ref.bucket!==expectedBucket||ref.kms_key_arn!==expectedKmsKey
    ||!/^arn:aws:kms:eu-west-1:659225405023:key\/[a-f0-9-]{36}$/.test(expectedKmsKey??'')
    ||!new RegExp(`^migration-inputs/[a-f0-9-]{36}/${file}\\.json$`).test(ref.key??'')
    ||!version(ref.version_id)||!hash(ref.sha256)||!Number.isSafeInteger(ref.size_bytes)||ref.size_bytes<1||ref.size_bytes>CUSTOMER_INPUT_LIMIT
    ||!validUuid(ref.parent_run_id)||!hash(ref.parent_source_checksum)||!hash(ref.fixture_sha256)) throw new Error('Pinned customer input reference is invalid');
  return ref;
}
// Versioned GetObject responses are bounded while reading, before JSON parsing.
// The read-only ECS task never materializes source data onto its filesystem.
export async function verifiedS3Bytes(response,ref,expectedKmsKey,maximum=CUSTOMER_INPUT_LIMIT){
  if(!response.Body||response.VersionId!==ref.version_id||response.ContentLength!==ref.size_bytes||ref.size_bytes>maximum
    ||response.ServerSideEncryption!=='aws:kms'||response.SSEKMSKeyId!==expectedKmsKey) throw new Error('Pinned encrypted object differs');
  const chunks=[];let length=0;
  try{
    for await(const chunk of response.Body){length+=chunk.length;if(length>ref.size_bytes||length>maximum) throw new Error('Pinned object size differs');chunks.push(Buffer.from(chunk));}
  }finally{response.Body.destroy?.();}
  const bytes=Buffer.concat(chunks);
  if(bytes.length!==ref.size_bytes||sha256(bytes)!==ref.sha256) throw new Error('Pinned object hash or size differs');
  return bytes;
}
