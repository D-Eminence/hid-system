import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {syntheticMedicalSource} from './medical-import-fixture.mjs';
import {syntheticCustomerSource} from './customer-history-fixture.mjs';
import {sealCustomerSource,prepareCustomerSource} from './customer-data-validation.mjs';
import {canonicalJson,sha256} from './staging-cutover-additions.mjs';
import {prepareConfigurationMap} from './prepare-customer-configuration-map.mjs';
import {sealConfigurationBaseline,collectConfigurationBaseline} from './configuration-baseline.mjs';
import {configurationDecisions} from './customer-configuration-mapping.mjs';
import {importCustomerHistory} from './import-staging-customer-history.mjs';
const parentId='10000000-0000-4000-8000-000000000001',parentChecksum='a'.repeat(64);
function fixture(){
  const source=syntheticCustomerSource(syntheticMedicalSource());
  const product=source.rows.find(r=>r.entity_type==='commercial_products'&&r.payload.slug==='ehr');
  const price=source.rows.find(r=>r.entity_type==='commercial_prices'&&r.payload.product_id===product.source_pk);
  const baseline=sealConfigurationBaseline({schema:'hid.configuration-baseline/v1',parent_run_id:parentId,parent_source_checksum:parentChecksum,
    captured_at:'2026-01-01T00:00:00.000Z',products:[{slug:'ehr',sha256:'b'.repeat(64)}],
    prices:[{product_slug:'ehr',context:'standalone',sha256:'c'.repeat(64)}],
    controls:['patient_portal_enabled','provider_portal_enabled','maintenance_mode','uploads_enabled','break_glass_enabled','outreach_portal_enabled'].map(control_key=>({control_key,sha256:'d'.repeat(64)}))});
  return {source,product,price,baseline};
}
function reseal(source){
  for(const row of source.rows) row.payload_sha256=sha256(canonicalJson(row.payload));
  return sealCustomerSource(source.snapshot_id,source.transaction_snapshot,source.inventory,source.rows);
}
test('exact supported products/prices/controls map; unsupported rows and flags stay preserved',()=>{
  const {source,baseline,product,price}=fixture(),plan=prepareConfigurationMap(source,baseline);
  assert.equal(plan.entries.length,31);assert.equal(plan.summary.mapped,3);assert.equal(plan.summary.retained,28);
  assert.equal(plan.entries.find(e=>e.source_pk===product.source_pk).target,'ehr');
  assert.deepEqual(plan.entries.find(e=>e.source_pk===price.source_pk).target,{product_slug:'ehr'});
  const controls=plan.entries.find(e=>e.category==='platform_controls');
  assert.ok(controls.controls.includes('hospital_portal_enabled'));assert.equal(controls.expected_targets.provider_portal_enabled,'d'.repeat(64));
  assert.ok(!controls.controls.includes('patient_signup_enabled'));
  assert.throws(()=>configurationDecisions(prepareCustomerSource(source,source.checksum),plan),/Reviewed/);
  const approved={...plan,schema:'hid.customer-configuration-map/v1',approved_by:'Synthetic reviewer',actor_subject:'synthetic:admin'};
  assert.equal(configurationDecisions(prepareCustomerSource(source,source.checksum),approved).size,31);
})
test('duplicate product slugs or price coordinates never select an arbitrary row',()=>{
  const {source,baseline,product,price}=fixture();
  const second=source.rows.find(r=>r.entity_type==='commercial_products'&&r!==product);second.payload.slug='ehr';
  assert.ok(prepareConfigurationMap(reseal(source),baseline).entries.filter(e=>e.category==='commercial_products').every(e=>e.action==='retain'));
  second.payload.slug='synthetic-again';
  const otherPrice=source.rows.find(r=>r.entity_type==='commercial_prices'&&r!==price);otherPrice.payload.product_id=product.source_pk;
  assert.ok(prepareConfigurationMap(reseal(source),baseline).entries.filter(e=>e.category==='commercial_prices').every(e=>e.action==='retain'));
})
test('changed baselines/seals fail and invalid amounts, periods, visibility and missing targets are retained',()=>{
  for(const changes of [{amount_minor:'9007199254740992'},{billing_period:'unsafe period'},{unit:''},{visibility:'fixed',amount_minor:null}]){
    const {source,baseline,price}=fixture();Object.assign(price.payload,changes);
    assert.equal(prepareConfigurationMap(reseal(source),baseline).entries.find(e=>e.source_pk===price.source_pk).action,'retain');
  }
  const {source,baseline,product}=fixture();baseline.products[0].sha256='e'.repeat(64);assert.throws(()=>prepareConfigurationMap(source,baseline),/checksum/);
  source.rows[0].payload.changed=true;assert.throws(()=>prepareConfigurationMap(source,baseline),/checksum/);
  const f=fixture();f.product.payload.public_visible=false;
  assert.equal(prepareConfigurationMap(reseal(f.source),f.baseline).entries.find(e=>e.source_pk===f.product.source_pk).action,'retain');
})
test('baseline collection uses a read-only snapshot and emits only coordinates/hashes',async()=>{
  const calls=[],secret='synthetic-value-not-for-logs';
  const client={query:async(sql)=>{calls.push(sql);if(sql.includes('migration.runs'))return {rows:[{source_system:'legacy_identity',mode:'reconcile',status:'verified',target_checksum_sha256:parentChecksum}]};
    if(sql.includes('commercial_products'))return {rows:[{value:{slug:'ehr',name:secret,row_version:1}}]};
    if(sql.includes('commercial_prices'))return {rows:[{value:{product_slug:'ehr',context:'standalone',amount_minor:12500}}]};
    if(sql.includes('control_settings'))return {rows:[{value:{control_key:'uploads_enabled',enabled:true}}]};return {rows:[]};}};
  const baseline=await collectConfigurationBaseline(client,{parentId,parentChecksum});
  assert.equal(calls[0],'begin isolation level repeatable read read only');assert.equal(calls.at(-1),'commit');
  assert.ok(calls.every(s=>!/insert|update|delete|alter/i.test(s)));assert.ok(!JSON.stringify(baseline).includes(secret));
  assert.equal(baseline.products[0].sha256,sha256(canonicalJson({slug:'ehr',name:secret,row_version:1})));
  await assert.rejects(collectConfigurationBaseline(client,{parentId,parentChecksum:'f'.repeat(64)}),/verified parent/);assert.equal(calls.at(-1),'rollback');
})
test('mapping from a different verified parent fails before any database work',async()=>{
  await assert.rejects(importCustomerHistory({query:()=>assert.fail('No database access expected')},{parentId,checksum:parentChecksum,
    mapping:{parent_run_id:'20000000-0000-4000-8000-000000000002',parent_source_checksum:parentChecksum}}),/parent differs/);
})
test('operator CLI binds real metadata fields, saves drafts privately and never overwrites a decision file',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hid-synthetic-config-'));
  try{
    const {source,baseline}=fixture(),bytes=Buffer.from(JSON.stringify(source)),sourcePath=join(dir,'source.json'),metadataPath=join(dir,'metadata.json'),baselinePath=join(dir,'baseline.json'),output=join(dir,'map.json');
    await writeFile(sourcePath,bytes);await writeFile(metadataPath,JSON.stringify({protected_source_path:sourcePath,sha256:sha256(bytes),source_checksum:source.checksum}));await writeFile(baselinePath,JSON.stringify(baseline));
    const args=['services/ehr-api/scripts/prepare-customer-configuration-map.mjs',metadataPath,baselinePath,output];
    const result=spawnSync(process.execPath,args,{cwd:new URL('../../../',import.meta.url),encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(await readFile(output)).schema,'hid.customer-configuration-map-draft/v1');
    assert.notEqual(spawnSync(process.execPath,args,{cwd:new URL('../../../',import.meta.url)}).status,0);
  }finally{
    if(!resolve(dir).startsWith(resolve(tmpdir())+sep+'hid-synthetic-config-')) throw new Error('Invalid disposable test directory');
    await rm(dir,{recursive:true,force:true});
  }
})
