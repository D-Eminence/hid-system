import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectComponents,componentConfig,components,assertScan,runtimePolicyPath,assertPublicationContext,assertAssessmentBinding} from './production-backend-build.mjs';

test('publication accepts only the approved Novu backend branch and exact repository context',()=>{
  const env={GITHUB_REPOSITORY:'D-Eminence/hid-system',GITHUB_REPOSITORY_ID:'1317340803',
    GITHUB_REPOSITORY_OWNER_ID:'182018869',GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/staging-novu-ci-20261005'};
  assert.doesNotThrow(()=>assertPublicationContext(env));
  for(const [key,value] of [['GITHUB_REF','refs/heads/main'],['GITHUB_REF','refs/heads/staging'],
    ['GITHUB_EVENT_NAME','pull_request'],['GITHUB_REPOSITORY_ID','999'],['GITHUB_REPOSITORY_OWNER_ID','999']]) {
    assert.throws(()=>assertPublicationContext({...env,[key]:value}),/Publication context rejected/);
  }
});
test('production workflow edits rebuild every backend component',()=>{
  assert.deepEqual(selectComponents(['.github/workflows/production-backend-images.yml']),components);
  assert.deepEqual(selectComponents(['.github/workflows/production-backend-rollback.yml']),components);
});
test('production EHR and migration use the independent production inventory policy',()=>{
  assert.equal(runtimePolicyPath('ehr-api'),'security/production-runtime-assessment.json');
  assert.equal(runtimePolicyPath('database-migration'),'security/production-runtime-assessment.json');
});
test('production Identity and workers do not inherit staging assessment policies',()=>{
  assert.equal(runtimePolicyPath('identity-api'),'security/production-runtime-assessment.json');
  assert.equal(runtimePolicyPath('notification-worker'),'security/production-runtime-assessment.json');
  assert.equal(runtimePolicyPath('database-migration'),'security/production-runtime-assessment.json');
});
test('frontend-only changes do not build backend images',()=>assert.deepEqual(selectComponents(['apps/web/src/App.tsx']),[]));
test('Novu worker changes select only its image',()=>assert.deepEqual(selectComponents(['services/notification-worker/src/worker.ts']),['notification-worker']));
test('scoped Novu dispatch builds only worker and migration',()=>assert.deepEqual(selectComponents([],'novu-update'),['notification-worker','database-migration']));
test('scoped admin correction builds only Identity and migration',()=>assert.deepEqual(selectComponents([],'admin-update'),['identity-api','database-migration']));
test('patient chat release builds exactly its three APIs and compatible migration runner',()=>assert.deepEqual(selectComponents([],'patient-chat-update'),['identity-api','ehr-api','lab-api','database-migration']));
test('production policy edits rebuild every component for fresh native verification',()=>assert.deepEqual(selectComponents(['security/production-runtime-assessment.json']),components));
test('database changes also rebuild the migration runner',()=>assert.deepEqual(selectComponents(['services/ehr-api/database/migrations/0063_example.sql']),['ehr-api','database-migration']));
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

test('production applicability cannot transfer between images, sources, components or raw reports',()=>{
  const source='a'.repeat(40),image='sha256:'+'b'.repeat(64),raw='c'.repeat(64);
  const assessment={assessment_scope:'production',component:'ehr-api',source_commit:source,image_id:image,raw_scan_sha256:raw};
  assertAssessmentBinding(assessment,'ehr-api',source,image,raw);
  for(const change of [{assessment_scope:'staging'},{component:'identity-api'},
    {source_commit:'d'.repeat(40)},{image_id:'sha256:'+'e'.repeat(64)},{raw_scan_sha256:'f'.repeat(64)}])
    assert.throws(()=>assertAssessmentBinding({...assessment,...change},'ehr-api',source,image,raw));
});
