import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticMedicalSource} from './medical-import-fixture.mjs';
import {syntheticCustomerSource} from './customer-history-fixture.mjs';
import {prepareCustomerSource,ninCoverage,clinicalPayload} from './customer-data-validation.mjs';
import {configurationDecisions,nativeConfigurationChange} from './customer-configuration-mapping.mjs';
import {classifyScan,scannerVersion,detectedType,validateAttachmentEvidence} from './attachment-safety.mjs';
import {canonicalJson,sha256} from './staging-cutover-additions.mjs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
test('malformed private source credentials never appear in export diagnostics',()=>{
  const secret='synthetic-private-do-not-print';
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./export-customer-source.mjs',import.meta.url)),path.join(tmpdir(),'synthetic-unwritten-source.json')],
    {encoding:'utf8',env:{...process.env,HID_DEPLOYMENT_ENV:'staging',MIGRATION_SNAPSHOT_ID:'synthetic',LEGACY_DATABASE_URL:secret}});
  assert.notEqual(result.status,0);assert.match(result.stderr,/source connection URL is invalid/);
  assert.doesNotMatch(result.stderr,new RegExp(secret));
});
test('complete source covers historical counts and 29 dispositions with NIN evidence',()=>{
  const b=syntheticCustomerSource(syntheticMedicalSource()),p=prepareCustomerSource(b,b.checksum);
  assert.equal(p.counts.notifications,193);assert.equal(p.counts.auth_challenges,74);assert.equal(p.counts.commercial_products,8);
  assert.equal(Object.keys(b.inventory).length,29);assert.equal(ninCoverage(p.grouped.get('patients')).absent_in_snapshot,1);
});
test('source seals, unknown populated tables, unresolved recipients and absent NIN columns fail closed',()=>{
  const b=syntheticCustomerSource(syntheticMedicalSource());
  const bad=structuredClone(b);bad.rows[0].payload.changed=true;assert.throws(()=>prepareCustomerSource(bad,b.checksum),/checksum/i);
  b.inventory['public.hid_unreviewed']=1;assert.throws(()=>prepareCustomerSource(b,b.checksum),/additional populated/);
  assert.throws(()=>ninCoverage([{payload:{nin_hash:null}}]),/columns/);
  assert.throws(()=>ninCoverage([{payload:{nin_hash:'synthetic',nin_ciphertext:null}}]),/partial/);
  assert.throws(()=>clinicalPayload({}),/clinical source columns/);
});
test('configuration activation requires every coordinate, source seal, exact baseline and supported semantics',()=>{
  const b=syntheticCustomerSource(syntheticMedicalSource()),p=prepareCustomerSource(b,b.checksum);
  assert.equal(configurationDecisions(p).size,0);
  assert.throws(()=>configurationDecisions(p,{schema:'hid.customer-configuration-map/v1',source_checksum:b.checksum,approved_by:'synthetic-reviewer',actor_subject:'synthetic',entries:[]}),/Every preserved/);
  const product=p.grouped.get('commercial_products')[0];
  assert.throws(()=>nativeConfigurationChange(product,{action:'product',target:'unsupported'},[]),/supported target/);
  assert.equal(nativeConfigurationChange(product,{action:'retain'},[]),null);
  assert.throws(()=>nativeConfigurationChange(p.grouped.get('staff_role_policies')[0],{action:'control',controls:['can_create_records']},[]),/unsupported/);
});
test('scanner errors, warnings, skipped files, encrypted archive alerts and stale signatures cannot approve downloads',()=>{
  assert.equal(classifyScan(0,'synthetic: OK',''),'clean');
  for(const [code,out,err] of [[0,'synthetic: OK','WARNING'],[0,'SKIPPED\nsynthetic: OK',''],[2,'synthetic: ERROR',''],[null,'synthetic: OK','']]) assert.equal(classifyScan(code,out,err),'error');
  assert.equal(classifyScan(1,'synthetic: Encrypted FOUND',''),'infected');
  assert.throws(()=>scannerVersion('ClamAV 1.4.3/1/2020-01-01'),/current/);
  assert.equal(detectedType(Buffer.from('<html>')),'application/octet-stream');
  assert.equal(detectedType(Buffer.from('%PDF-synthetic')),'application/pdf');
});
export function syntheticAttachmentEvidence(source,parentSnapshot){
  const now=new Date().toISOString(),bucket='hid-staging-documents-synthetic';
  const manifest={fixture_sha256:'a'.repeat(64),fixture_snapshot_id:parentSnapshot,source_snapshot_id:'synthetic-snapshot',files:source.collections.medical_record_files.map(p=>({
    source_file_id:p.id,destination_key:`migration-quarantine/synthetic-snapshot/medical-files/${p.id}`,destination_version_id:`synthetic-${p.id}`,size_bytes:p.size_bytes,sha256:'b'.repeat(64)}))};
  const manifestSha256=sha256(canonicalJson(manifest)),manifestVersionId='synthetic-manifest';
  const files=manifest.files.map(f=>{const s={file_id:f.source_file_id,key:f.destination_key,version_id:f.destination_version_id,sha256:f.sha256,size_bytes:f.size_bytes,
    scanner:'clamav',scanner_version:'synthetic-only',signatures_version:'synthetic-only',scanner_binary_sha256:'c'.repeat(64),signatures_updated_at:now,
    scanned_at:now,result:'clean',detected_media_type:'application/octet-stream',scanner_output_sha256:'d'.repeat(64)};return {...s,report_sha256:sha256(canonicalJson(s))};});
  const report={schema:'hid.imported-attachment-scan/v1',manifest_sha256:manifestSha256,manifest_version_id:manifestVersionId,bucket,files};
  return {manifest,report,manifestSha256,manifestVersionId,bucket,fixtureSha256:manifest.fixture_sha256};
}
test('attachment reports require all exact file/version/hash associations',()=>{
  const source=syntheticMedicalSource(),e=syntheticAttachmentEvidence(source,'synthetic-medical-import');
  const options={...e,sourceFiles:source.rows.filter(r=>r.entity_type==='medical_record_files')};
  assert.equal(validateAttachmentEvidence(e.manifest,e.report,options).length,4);
  const changed=structuredClone(e.report);changed.files[0].version_id='wrong';assert.throws(()=>validateAttachmentEvidence(e.manifest,changed,options),/evidence differs/);
  changed.files=e.report.files.slice(1);assert.throws(()=>validateAttachmentEvidence(e.manifest,changed,options),/every source file/);
});
