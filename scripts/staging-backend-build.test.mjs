import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectComponents,componentConfig,components,assertScan,runtimePolicyPath} from './staging-backend-build.mjs';
import {gatewayBoundFileHashes} from './production-backend-build.mjs';
test('every staging component is admitted against the reviewed production inventory policy',()=>{
  for(const c of components) assert.equal(runtimePolicyPath(c),'security/production-runtime-assessment.json');
});
test('production policy edits rebuild every staging component for fresh native verification',()=>assert.deepEqual(selectComponents(['security/production-runtime-assessment.json']),components));
test('retired staging policies no longer select any image',()=>{
  for(const p of ['security/staging-novu-runtime-assessment.json','security/staging-ehr-runtime-assessment.json',
    'security/staging-identity-runtime-assessment.json','security/staging-lab-runtime-assessment.json'])
    assert.deepEqual(selectComponents([p]),[]);
});
test('frontend-only changes do not build backend images',()=>assert.deepEqual(selectComponents(['apps/web/src/App.tsx']),[]));
test('Novu worker changes select only its image',()=>assert.deepEqual(selectComponents(['services/notification-worker/src/worker.ts']),['notification-worker']));
test('scoped Novu dispatch builds only worker and migration',()=>assert.deepEqual(selectComponents([],'novu-update'),['notification-worker','database-migration']));
test('scoped admin correction builds only Identity and migration',()=>assert.deepEqual(selectComponents([],'admin-update'),['identity-api','database-migration']));
test('patient chat release builds exactly its three APIs and compatible migration runner',()=>assert.deepEqual(selectComponents([],'patient-chat-update'),['identity-api','ehr-api','lab-api','database-migration']));
test('database changes also rebuild the migration runner',()=>assert.deepEqual(selectComponents(['services/ehr-api/database/migrations/0063_example.sql']),['ehr-api','database-migration']));
test('docs/codes, which the migration image carries for the catalogue load, rebuilds only the migration runner',()=>
  assert.deepEqual(selectComponents(['docs/codes/catalog-approvals.json','docs/codes/hid-medicines.json']),['database-migration']));
test('shared client and CI changes select the complete backend matrix',()=>assert.deepEqual(selectComponents(['packages/api-client/src/index.ts']),components));
test('reject unknown/path-injection components',()=>assert.throws(()=>componentConfig('../production')));
test('migration uses the existing EHR repository with the migration target',()=>assert.equal(componentConfig('database-migration').target,'migration'));
test('High/Critical findings and incomplete scan reports block publication',()=>{
  assert.throws(()=>assertScan({matches:[]}));
  assert.throws(()=>assertScan({descriptor:{version:'test'},distro:{name:'debian',version:'13'},matches:[{vulnerability:{severity:'High'}}]}));
  assert.throws(()=>assertScan({descriptor:{version:'test'},matches:[]}));
  assertScan({descriptor:{version:'test'},distro:{name:'debian',version:'13'},matches:[]});
});
test('only verified not-affected VEX matches can pass; unknowns and changed packages fail',()=>{
  const m={vulnerability:{id:'CVE-2026-5435',severity:'High'},artifact:{name:'libc6',version:'assessed-version',purl:'pkg:deb/libc6@assessed-version'},
    appliedIgnoreRules:[{namespace:'vex','vex-status':'not_affected'}]};
  const expiry=new Date(Date.now()+86400000).toISOString();
  const assessment={component:'notification-worker',expires_at:expiry,native_binary_count:1,glibc_affected_imports:0,raw_high_matches:1,
    reviewed_not_affected:[{id:m.vulnerability.id,package:m.artifact.name,version:m.artifact.version,purl:m.artifact.purl}]};
  const policy={expires_at:expiry,elf_inventory:{'notification-worker':{node:'hash'}},findings:[{id:m.vulnerability.id,packages:['libc6'],versions:{libc6:'assessed-version'}}]};
  const report={descriptor:{version:'test'},distro:{name:'debian',version:'13'},matches:[],ignoredMatches:[m]};
  assertScan(report,assessment,policy);
  assert.throws(()=>assertScan(report));
  for(const alter of [x=>x.vulnerability.id='CVE-UNKNOWN',x=>x.vulnerability.severity='Critical',
    x=>x.artifact.version='different',x=>x.artifact.purl='different',x=>x.appliedIgnoreRules=[]]){
    const changed=structuredClone(report);alter(changed.ignoredMatches[0]);assert.throws(()=>assertScan(changed,assessment,policy));
  }
  assert.throws(()=>assertScan(report,{...assessment,expires_at:'2020-01-01'},policy));
  assert.throws(()=>assertScan(report,{...assessment,expires_at:'invalid'}, {...policy,expires_at:'invalid'}));
  assert.throws(()=>assertScan(report,{...assessment,glibc_affected_imports:1},policy));
  assert.throws(()=>assertScan({...report,matches:[m]},assessment,policy));
});
test('gateway VEX edits rebuild only the staging gateway',()=>assert.deepEqual(selectComponents(['security/gateway-runtime.vex.json']),['gateway']));
test('staging gateway scans accept only exact VEX-applied statements from the committed gateway VEX',()=>{
  const purl='pkg:apk/alpine/libssl3@3.5.9-r0?arch=aarch64&distro=alpine-3.24.2&upstream=openssl',now=Date.now();
  const m={vulnerability:{id:'CVE-2026-88823',severity:'High'},artifact:{name:'libssl3',version:'3.5.9-r0',type:'apk',purl},
    appliedIgnoreRules:[{namespace:'vex','vex-status':'not_affected'}]};
  const vex={'@context':'https://openvex.dev/ns/v0.2.0',timestamp:new Date(now-86400000).toISOString(),hid_expires_at:new Date(now+86400000).toISOString(),
    hid_bound_files:gatewayBoundFileHashes(),
    statements:[{vulnerability:{name:m.vulnerability.id},products:[{'@id':purl}],status:'not_affected',justification:'vulnerable_code_not_in_execute_path'}]};
  const report={descriptor:{version:'test'},distro:{name:'alpine',version:'3.24.2'},matches:[],ignoredMatches:[m]};
  assertScan(report,null,null,vex);
  assert.throws(()=>assertScan(report));
  assert.throws(()=>assertScan(report,null,null,{...vex,hid_expires_at:new Date(now-1).toISOString()}));
  assert.throws(()=>assertScan({...report,ignoredMatches:[{...m,vulnerability:{id:'CVE-2026-95691',severity:'High'}}]},null,null,vex));
  assert.throws(()=>assertScan(report,null,null,{...vex,hid_bound_files:{...vex.hid_bound_files,'gateway/nginx.conf.template':'0'.repeat(64)}}),/Gateway changed/);
  assert.throws(()=>assertScan(report,null,null,{...vex,hid_bound_files:undefined}),/Gateway changed/);
});
test('staging enforces a per-finding expires_at and leaves findings without one unchanged',()=>{
  const m={vulnerability:{id:'CVE-2026-107493',severity:'High'},artifact:{name:'libssl3t64',version:'3.5.7-1~deb13u3',purl:'pkg:deb/debian/libssl3t64@3.5.7-1~deb13u3'},
    appliedIgnoreRules:[{namespace:'vex','vex-status':'not_affected'}]};
  const expiry=new Date(Date.now()+86400000).toISOString();
  const assessment={component:'ehr-api',expires_at:expiry,native_binary_count:1,glibc_affected_imports:0,raw_high_matches:1,
    reviewed_not_affected:[{id:m.vulnerability.id,package:m.artifact.name,version:m.artifact.version,purl:m.artifact.purl}]};
  const finding={id:m.vulnerability.id,packages:['libssl3t64'],versions:{libssl3t64:'3.5.7-1~deb13u3'}};
  const policy=f=>({expires_at:expiry,elf_inventory:{'ehr-api':{node:'hash'}},findings:[f]});
  const report={descriptor:{version:'test'},distro:{name:'debian',version:'13'},matches:[],ignoredMatches:[m]};
  assertScan(report,assessment,policy(finding));
  assertScan(report,assessment,policy({...finding,expires_at:new Date(Date.now()+3600000).toISOString()}));
  for(const v of [new Date(Date.now()-1).toISOString(),'2020-01-01T00:00:00Z','invalid'])
    assert.throws(()=>assertScan(report,assessment,policy({...finding,expires_at:v})),/Unassessed/);
});
