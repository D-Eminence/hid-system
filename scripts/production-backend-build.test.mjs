import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {selectComponents,componentConfig,components,assertScan,runtimePolicyPath,assertPublicationContext,assertAssessmentBinding,assertGatewayVex,gatewayVexPath} from './production-backend-build.mjs';

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
test('a migration with its ledger entry rebuilds only the migration runner and the changed services',()=>assert.deepEqual(
  selectComponents(['scripts/verify-migration-ledger.mjs','services/ehr-api/database/migrations/0095_example.sql','services/identity-api/src/app.module.ts',
    'release/config/components.json','config/production-schema-compatibility.json','docs/DATABASE.md']),['identity-api','ehr-api','database-migration']));
test('any other script still rebuilds every component',()=>assert.deepEqual(selectComponents(['scripts/production_deployment.py']),components));
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
  const proposedOnly={...policy,findings:[],proposed_findings:{findings:policy.findings}};
  assert.throws(()=>assertScan(report,assessment,proposedOnly),/Unassessed/);
});

test('production applicability cannot transfer between images, sources, components or raw reports',()=>{
  const source='a'.repeat(40),image='sha256:'+'b'.repeat(64),raw='c'.repeat(64);
  const assessment={assessment_scope:'production',component:'ehr-api',source_commit:source,image_id:image,raw_scan_sha256:raw};
  assertAssessmentBinding(assessment,'ehr-api',source,image,raw);
  for(const change of [{assessment_scope:'staging'},{component:'identity-api'},
    {source_commit:'d'.repeat(40)},{image_id:'sha256:'+'e'.repeat(64)},{raw_scan_sha256:'f'.repeat(64)}])
    assert.throws(()=>assertAssessmentBinding({...assessment,...change},'ehr-api',source,image,raw));
});

const gatewayPurl=n=>`pkg:apk/alpine/${n}@3.5.9-r0?arch=aarch64&distro=alpine-3.24.2&upstream=openssl`;
const gatewayMatch=(id,n='libssl3')=>({vulnerability:{id,severity:'High'},artifact:{name:n,version:'3.5.9-r0',type:'apk',purl:gatewayPurl(n)},
  appliedIgnoreRules:[{namespace:'vex','vex-status':'not_affected'}]});
test('gateway VEX edits rebuild only the gateway',()=>assert.deepEqual(selectComponents([gatewayVexPath]),['gateway']));
test('committed gateway VEX covers only the reviewed Alpine OpenSSL findings and expires by 2026-12-01',()=>{
  const vex=JSON.parse(readFileSync(new URL('../'+gatewayVexPath,import.meta.url)));
  assert.ok(Date.parse(vex.hid_expires_at)<=Date.parse('2026-12-01T00:00:00Z'));
  assert.deepEqual(vex.statements.map(s=>s.vulnerability.name).sort(),['CVE-2026-107496','CVE-2026-88823','CVE-2026-95691','CVE-2026-95692']);
  for(const s of vex.statements){
    assert.equal(s.status,'not_affected');assert.equal(s.justification,'vulnerable_code_not_in_execute_path');
    assert.deepEqual(s.products.map(p=>p['@id']).sort(),[gatewayPurl('libcrypto3'),gatewayPurl('libssl3')]);
  }
  const reviewed=vex.statements.flatMap(s=>['libssl3','libcrypto3'].map(n=>gatewayMatch(s.vulnerability.name,n)));
  assertGatewayVex(reviewed,vex,Date.parse('2026-11-20T00:00:00Z'));
  assert.throws(()=>assertGatewayVex(reviewed,vex,Date.parse('2026-12-01T00:00:00Z')),/unexpired gateway OpenVEX/);
});
test('gateway VEX suppresses only exact, High, VEX-applied Alpine package matches',()=>{
  const now=Date.now(),vex={'@context':'https://openvex.dev/ns/v0.2.0',timestamp:new Date(now-86400000).toISOString(),
    hid_expires_at:new Date(now+86400000).toISOString(),statements:[{vulnerability:{name:'CVE-2026-88823'},
    products:[{'@id':gatewayPurl('libssl3')}],status:'not_affected',justification:'vulnerable_code_not_in_execute_path'}]};
  const report={descriptor:{version:'test'},distro:{name:'alpine',version:'3.24.2'},matches:[],ignoredMatches:[gatewayMatch('CVE-2026-88823')]};
  assertScan(report,null,null,vex);
  assert.throws(()=>assertScan(report),/runtime assessment required/);
  for(const alter of [x=>x.vulnerability.id='CVE-2026-95691',x=>x.vulnerability.severity='Critical',
    x=>x.artifact.purl=gatewayPurl('libcrypto3'),x=>x.artifact.purl=x.artifact.purl.replace('3.5.9-r0','3.5.9-r1'),
    x=>x.artifact.purl=x.artifact.purl.replace('alpine-3.24.2','alpine-3.25.0'),x=>x.artifact.type='deb',x=>x.appliedIgnoreRules=[]]){
    const changed=structuredClone(report);alter(changed.ignoredMatches[0]);assert.throws(()=>assertScan(changed,null,null,vex),/Unassessed/);
  }
  for(const change of [{hid_expires_at:new Date(now-1).toISOString()},{hid_expires_at:undefined},
    {timestamp:new Date(now-40*86400000).toISOString(),hid_expires_at:new Date(now+86400000).toISOString()},
    {'@context':'https://openvex.dev/ns/v0.0.1'},{statements:[{...vex.statements[0],status:'affected'}]},
    {statements:[{...vex.statements[0],justification:'inline_mitigations_already_exist'}]}])
    assert.throws(()=>assertScan(report,null,null,{...vex,...change}));
  assert.throws(()=>assertScan({...report,matches:[gatewayMatch('CVE-2026-88823')]},null,null,vex),/block publication/);
});
test('only the gateway scan applies the committed VEX, and it keeps --fail-on high',()=>{
  for(const workflow of ['production-backend-images.yml','staging-backend-images.yml']){
    const text=readFileSync(new URL(`../.github/workflows/${workflow}`,import.meta.url),'utf8');
    assert.ok(text.includes(`if [ "$scan_status" -eq 2 ] && [ "$COMPONENT" = 'gateway' ]; then`),workflow);
    assert.equal(text.split('--vex security/gateway-runtime.vex.json --output json --fail-on high').length,2,workflow);
    assert.ok(/elif \[ "\$scan_status" -eq 2 \]; then\n\s+python3 scripts\/assess-(production|staging)-runtime\.py/.test(text),workflow);
    assert.ok(text.includes("'security/gateway-runtime.vex.json'"),workflow);
  }
});
