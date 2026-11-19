import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,copyFileSync,rmSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,posix} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {selectComponents,componentConfig,components,assertScan,runtimePolicyPath,assertPublicationContext,assertAssessmentBinding,assertGatewayVex,gatewayVexPath,
  gatewayBoundFiles,gatewayBoundFileHashes,loadGatewayVex,componentsForPath,changedPaths,selectChanged,maxChangedPaths,
  outsideTestInputs,releasedBase,releaseBranch,workflowPath} from './production-backend-build.mjs';

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
    'release/config/components.json','config/production-schema-compatibility.json','docs/DATABASE.md']),
  // identity-api, ocr-api, ocr-worker and outreach-api specs read every migration (see outsideTestInputs).
  ['identity-api','ehr-api','ocr-api','ocr-worker','outreach-api','database-migration']));
test('build, evidence and deployment controller scripts rebuild and redeploy every component',()=>{
  for(const p of ['scripts/production_deployment.py','scripts/production_deployment_core.py','scripts/production-deployment.mjs',
    'scripts/verify-production-approval.py','scripts/production_release_compatibility.py','scripts/production-backend-build.mjs',
    'scripts/production-backend-build.test.mjs','scripts/install-production-scanners.mjs','scripts/assess-production-runtime.py',
    'scripts/assess-staging-runtime.py','package.json','.dockerignore','.gitattributes'])
    assert.deepEqual(selectComponents([p]),components,p);
});
test('an unknown path under scripts/ or packages/ selects all 13 components',()=>{
  assert.equal(components.length,13);
  for(const p of ['scripts/new-helper.mjs','scripts/attestation.mjs','scripts/apply-something.py','scripts/run-container-database-acceptance.sh',
    'scripts/newdir/tool.mjs','scripts/verify-prebaseline-git.sh','packages/new-shared/src/index.ts','packages/README.md'])
    assert.deepEqual(selectComponents([p]),components,p);
});
test('a pure docs/ or scripts/tests/ change selects no component',()=>{
  assert.deepEqual(selectComponents(['docs/INTERFACE_CONTRACT.md','docs/codes/hid-lab-codes.json']),[]);
  assert.deepEqual(selectComponents(['scripts/tests/hid-lab-codes.test.mjs','scripts/tests/fixtures/a.json']),[]);
  assert.deepEqual(selectComponents(['docs/INTERFACE_CONTRACT.md','docs/codes/hid-lab-codes.json','scripts/tests/hid-lab-codes.test.mjs']),[]);
});
test('scripts and packages that no image or production build uses select no component',()=>{
  for(const p of ['scripts/tuf-staging-migration-rehearsal.mjs','scripts/staging-backend-build.mjs','scripts/verify-container-platform.mjs',
    'scripts/verify-platform-graph.mjs','scripts/test_production_deployment_core.py','scripts/assess_production_runtime_test.py',
    'scripts/staging-backend-build.test.mjs','packages/ui/src/Button.tsx','packages/offline/src/index.ts','packages/telemetry/src/index.ts',
    'packages/identity-browser-client/src/index.ts','security/npm-audit-exceptions.json','security/staging-ehr-runtime-assessment.json',
    'security/node-22.23.5-runtime-evidence.json','security/STAGING_NOVU_RUNTIME_ASSESSMENT.md','.github/workflows/tuf-local-gates.yml',
    'release/config/components.json','infra/terraform/main.tf','tools/tuf-release/go.mod','README.md','config/production-schema-compatibility.json'])
    assert.deepEqual(selectComponents([p]),[],p);
});
test('paths that match no rule, and unknown services or security files, select all 13 components',()=>{
  for(const p of ['Makefile','new-top-level/x.json','config/new.json','services/new-service/src/main.ts','security/new-policy.json',
    '"quoted/\\303\\251.txt"','','/etc/passwd','services/ehr-api/../../x'])
    assert.deepEqual(selectComponents([p]),components,JSON.stringify(p));
});
test('shared server packages select their consumers and the migration runner',()=>{
  assert.deepEqual(selectComponents(['packages/server-telemetry/src/index.ts']),components.filter(c=>c!=='gateway'));
  assert.deepEqual(selectComponents(['packages/api-client/package.json']),
    ['ehr-api','lab-api','pharmacy-api','ocr-api','outreach-api','database-migration']);
});
test('closed fail-open gaps: workload token agent, ehr-api package files and Dockerfile',()=>{
  assert.deepEqual(selectComponents(['services/workload-token-agent/src/agent.mjs']),['identity-api']);
  for(const p of ['services/ehr-api/package.json','services/ehr-api/package-lock.json','services/ehr-api/Dockerfile'])
    assert.deepEqual(selectComponents([p]),['ehr-api','database-migration'],p);
  assert.deepEqual(selectComponents(['scripts/local-environment.mjs']),['database-migration']);
});
test('ehr-api and lab-api build inputs select the migration rehearsal that runs their built output',()=>{
  for(const p of ['services/ehr-api/src/main.ts','services/ehr-api/src/ehr/patient-records/patient-evidence.service.ts',
    'services/ehr-api/tsconfig.build.json','services/ehr-api/nest-cli.json'])
    assert.deepEqual(selectComponents([p]),['ehr-api','database-migration'],p);
  for(const p of ['services/lab-api/src/lab/patient-results.service.ts','services/lab-api/src/new-file.ts',
    'services/lab-api/package.json','services/lab-api/package-lock.json','services/lab-api/tsconfig.json','services/lab-api/Dockerfile'])
    assert.deepEqual(selectComponents([p]),['lab-api','database-migration'],p);
  // Jest specs and the test/ directory are not compiled into dist or copied into the migration image.
  assert.deepEqual(selectComponents(['services/ehr-api/src/main.spec.ts']),['ehr-api']);
  assert.deepEqual(selectComponents(['services/lab-api/src/lab/lab.service.spec.ts']),['lab-api']);
  assert.deepEqual(selectComponents(['services/ehr-api/test/fixtures/legacy-identity.sample.json']),['ehr-api']);
  // Other services are not built by the rehearsal.
  assert.deepEqual(selectComponents(['services/pharmacy-api/src/main.ts']),['pharmacy-api']);
});
test('every .dockerignore, including a per-Dockerfile one, rebuilds every component',()=>{
  for(const c of components){
    const {dockerfile}=componentConfig(c);
    assert.deepEqual(selectComponents([`${dockerfile}.dockerignore`]),components,`${dockerfile}.dockerignore`);
  }
  for(const p of ['.dockerignore','services/ehr-api/Dockerfile.dockerignore','gateway/Dockerfile.dockerignore','apps/web/.dockerignore'])
    assert.deepEqual(selectComponents([p]),components,p);
});
test('files that service tests read from outside the service select the reading service',()=>{
  const cases=[
    ['services/ehr-api/database/migrations/0120_x.sql',['identity-api','ehr-api','ocr-api','ocr-worker','outreach-api','database-migration']],
    ['services/ehr-api/database/runtime-grants.sql',['ehr-api','ocr-worker','outreach-api','database-migration']],
    ['services/ehr-api/database/tests/schema.integration.sql',['ehr-api','ocr-worker','outreach-api','database-migration']],
    ['services/ehr-api/test/fixtures/order-route-cannot-complete-reasons.sql',['ehr-api','lab-api','pharmacy-api']],
    ['services/ehr-api/test/database/registration-case-list.integration.sql',['identity-api','ehr-api']],
    ['services/ocr-worker/src/reading/contract.ts',['ocr-api','ocr-worker']],
    ['services/ocr-worker/package.json',['ocr-worker']],
    ['services/identity-api/src/identity/dto/authorize-outreach.dto.ts',['identity-api','outreach-api']],
    ['gateway/nginx.conf.template',['outreach-api','gateway']],
    ['gateway/proxy-headers.conf',['gateway']],
    ['infra/aws/runtime/workload-issuer/issuer.mjs',['identity-api']],
    ['infra/aws/runtime/other/x.mjs',[]],
  ];
  for(const [p,expected] of cases) assert.deepEqual(selectComponents([p]),components.filter(c=>expected.includes(c)),p);
  // A reader never narrows a rule that already selects all 13.
  assert.deepEqual(selectComponents(['services/ehr-api/database/migrations/../../x']),components);
});
test('a migration PR with its ledger and rehearsal scripts no longer rebuilds all 13',()=>assert.deepEqual(selectComponents([
  'scripts/verify-migration-ledger.mjs','scripts/tuf-staging-migration-rehearsal.mjs','services/ehr-api/database/migrations/0137_example.sql',
  'services/ehr-api/database/runtime-grants.sql','services/identity-api/src/app.module.ts','release/migration/manifest.json']),
  ['identity-api','ehr-api','ocr-api','ocr-worker','outreach-api','database-migration']));
test('an empty change list or more than the review limit selects all 13 components',()=>{
  assert.deepEqual(selectComponents([]),components);
  assert.deepEqual(selectComponents(undefined),components);
  assert.deepEqual(selectComponents(Array.from({length:maxChangedPaths+1},(_,i)=>`docs/${i}.md`)),components);
  assert.deepEqual(selectComponents(Array.from({length:maxChangedPaths},(_,i)=>`docs/${i}.md`)),[]);
});
test('a bad, zero or missing base, a failing diff or an empty diff selects all 13 components',()=>{
  const base='a'.repeat(40);
  const fail=()=>{throw Error('fatal: bad object');};
  for(const b of [undefined,'','0'.repeat(40),'abc','A'.repeat(40),'g'.repeat(40),`${base}\n`])
    assert.deepEqual(selectChanged(b,()=>'docs/a.md\0'),components,JSON.stringify(b));
  assert.deepEqual(selectChanged(base,fail),components);
  assert.equal(changedPaths(base,fail),null);
  assert.deepEqual(selectChanged(base,()=>''),components);
  assert.deepEqual(selectChanged(base,()=>'docs/a.md\0scripts/tests/b.test.mjs\0'),[]);
  assert.deepEqual(selectChanged(base,()=>'services/pharmacy-api/src/a.ts\0services/pharmacy-api/src/b.ts\0'),['pharmacy-api']);
});
test('renames report both paths, so moving a file out of a service still rebuilds that service',()=>{
  const repo=mkdtempSync(join(tmpdir(),'hid-select-'));
  const git=(...a)=>execFileSync('git',['-C',repo,'-c','user.name=t','-c','user.email=t@example.invalid',...a],{encoding:'utf8'});
  try{
    git('init','-q');
    mkdirSync(join(repo,'services/pharmacy-api/src'),{recursive:true});
    writeFileSync(join(repo,'services/pharmacy-api/src/helper.ts'),'export const x = 1;\n'.repeat(20));
    git('add','.');git('commit','-qm','base');
    const base=git('rev-parse','HEAD').trim();
    mkdirSync(join(repo,'docs'));
    git('mv','services/pharmacy-api/src/helper.ts','docs/helper.ts');git('commit','-qm','move');
    const diff=b=>execFileSync('git',['-C',repo,'diff','--no-renames','--name-only','-z',b,'HEAD'],{encoding:'utf8'});
    assert.deepEqual(changedPaths(base,diff).sort(),['docs/helper.ts','services/pharmacy-api/src/helper.ts']);
    assert.deepEqual(selectChanged(base,diff),['pharmacy-api']);
  }finally{rmSync(repo,{recursive:true,force:true});}
});
test('database changes also rebuild the migration runner',()=>assert.deepEqual(selectComponents(['services/ehr-api/database/migrations/0063_example.sql']),['identity-api','ehr-api','ocr-api','ocr-worker','outreach-api','database-migration']));
test('shared client changes select its five consumers and the migration runner',()=>assert.deepEqual(selectComponents(['packages/api-client/src/index.ts']),
  ['ehr-api','lab-api','pharmacy-api','ocr-api','outreach-api','database-migration']));
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
  const withExpiry=v=>({...policy,findings:[{...policy.findings[0],expires_at:v}]});
  assertScan(report,assessment,withExpiry(new Date(Date.now()+3600000).toISOString()));
  for(const v of [new Date(Date.now()-1).toISOString(),'invalid',null])
    assert.throws(()=>assertScan(report,assessment,withExpiry(v)),/Unassessed/);
  assertScan(report,assessment,{...policy,findings:[...policy.findings,{id:'CVE-OTHER',packages:['libc6'],versions:{libc6:'x'},expires_at:'2020-01-01T00:00:00Z'}]});
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
  assert.deepEqual(vex.hid_bound_files,gatewayBoundFileHashes());
  assertGatewayVex(reviewed,vex,Date.parse('2026-11-20T00:00:00Z'));
  assert.throws(()=>assertGatewayVex(reviewed,vex,Date.parse('2026-12-01T00:00:00Z')),/unexpired gateway OpenVEX/);
});
test('gateway VEX suppresses only exact, High, VEX-applied Alpine package matches',()=>{
  const now=Date.now(),vex={'@context':'https://openvex.dev/ns/v0.2.0',timestamp:new Date(now-86400000).toISOString(),
    hid_expires_at:new Date(now+86400000).toISOString(),hid_bound_files:gatewayBoundFileHashes(),statements:[{vulnerability:{name:'CVE-2026-88823'},
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
    {statements:[{...vex.statements[0],justification:'inline_mitigations_already_exist'}]},
    {hid_bound_files:undefined},{hid_bound_files:{...vex.hid_bound_files,'gateway/Dockerfile':'0'.repeat(64)}},
    {hid_bound_files:{...vex.hid_bound_files,'gateway/README.md':'0'.repeat(64)}}])
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

const repoRoot=fileURLToPath(new URL('../',import.meta.url));
const gatewayFixture=()=>{
  const root=mkdtempSync(join(tmpdir(),'hid-gateway-vex-'));
  mkdirSync(join(root,'gateway'));mkdirSync(join(root,'security'));
  for(const p of [...gatewayBoundFiles,gatewayVexPath]) copyFileSync(join(repoRoot,p),join(root,p));
  return root;
};
test('the gateway VEX is bound to the gateway Dockerfile, nginx template and proxy headers it was reviewed against',()=>{
  const now=Date.parse('2026-11-20T00:00:00Z');
  for(const changed of gatewayBoundFiles){
    const root=gatewayFixture();
    try{
      const vex=JSON.parse(readFileSync(join(root,gatewayVexPath)));
      const reviewed=vex.statements.map(s=>gatewayMatch(s.vulnerability.name));
      assertGatewayVex(reviewed,vex,now,root);
      writeFileSync(join(root,changed),readFileSync(join(root,changed),'utf8')+'\n# changed\n');
      assert.throws(()=>assertGatewayVex(reviewed,vex,now,root),/Gateway changed since its OpenVEX was reviewed/,changed);
      rmSync(join(root,changed));
      assert.throws(()=>assertGatewayVex(reviewed,vex,now,root),/bound files missing/,changed);
    }finally{rmSync(root,{recursive:true,force:true});}
  }
});
test('the gateway VEX is read only for a gateway scan with ignored High rows; a clean scan needs no file',()=>{
  const root=gatewayFixture();
  try{
    const clean={descriptor:{version:'test'},distro:{name:'alpine',version:'3.24.2'},matches:[],ignoredMatches:[]};
    const suppressed={...clean,ignoredMatches:[gatewayMatch('CVE-2026-88823')]};
    const lowOnly={...clean,ignoredMatches:[{...gatewayMatch('CVE-2026-88823'),vulnerability:{id:'CVE-2026-88823',severity:'Medium'}}]};
    assert.deepEqual(loadGatewayVex('gateway',null,suppressed,root),JSON.parse(readFileSync(join(root,gatewayVexPath))));
    assert.equal(loadGatewayVex('ehr-api',null,suppressed,root),null);
    assert.equal(loadGatewayVex('gateway',{component:'gateway'},suppressed,root),null);
    assert.equal(loadGatewayVex('gateway',null,clean,root),null);
    rmSync(join(root,gatewayVexPath));
    for(const scan of [clean,lowOnly,{...clean,ignoredMatches:undefined}]){
      const vex=loadGatewayVex('gateway',null,scan,root);
      assert.equal(vex,null);
      assertScan(scan,null,null,vex);
    }
    assert.equal(loadGatewayVex('gateway',null,suppressed,root),null);
    assert.throws(()=>assertScan(suppressed,null,null,loadGatewayVex('gateway',null,suppressed,root)),/runtime assessment required/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('pack copies the committed gateway VEX into the gateway build evidence',()=>{
  for(const script of ['production-backend-build.mjs','staging-backend-build.mjs']){
    const text=readFileSync(new URL(script,import.meta.url),'utf8');
    assert.ok(text.includes("if(gatewayIgnored) writeFileSync(`${directory}/gateway-runtime.vex.json`,readFileSync(gatewayVexPath));"),script);
    assert.ok(text.includes('const gatewayVex=loadGatewayVex(c,assessment,scan);'),script);
  }
});

// The release candidate step re-checks every published scan (scripts/production-deployment.mjs).
// It must admit the gateway exactly as the build step did: the committed VEX, bound by hash.
test('the release candidate step admits the gateway scan only with the committed, hash-bound VEX',async()=>{
  const {validatePublication}=await import('./production-deployment.mjs');
  const vexFile=join(repoRoot,gatewayVexPath);
  const vex=JSON.parse(readFileSync(vexFile));
  const ignored=vex.statements.flatMap(s=>['libssl3','libcrypto3'].map(n=>gatewayMatch(s.vulnerability.name,n)));
  const dir=mkdtempSync(join(tmpdir(),'hid-candidate-gw-'));
  const write=(receipt,scan)=>{writeFileSync(join(dir,'publication.json'),JSON.stringify(receipt));writeFileSync(join(dir,'grype.json'),JSON.stringify(scan));};
  const scan={descriptor:{version:'test'},distro:{name:'alpine',version:'3.24.2'},matches:[],ignoredMatches:ignored};
  const sha=createHash('sha256').update(readFileSync(vexFile)).digest('hex');
  const realNow=Date.now; Date.now=()=>Date.parse('2026-11-20T00:00:00Z');
  try {
    write({component:'gateway',assessment_sha256:null,vex_sha256:sha},scan);
    assert.equal(validatePublication(dir,repoRoot).component,'gateway');
    write({component:'gateway',assessment_sha256:null,vex_sha256:'0'.repeat(64)},scan);
    assert.throws(()=>validatePublication(dir,repoRoot),/ASSESSMENT_BINDING_DIFFERS/);
    write({component:'gateway',assessment_sha256:null,vex_sha256:sha},{...scan,ignoredMatches:[...ignored,gatewayMatch('CVE-2026-99999')]});
    assert.throws(()=>validatePublication(dir,repoRoot));
    write({component:'identity-api',assessment_sha256:null,vex_sha256:null},scan);
    assert.throws(()=>validatePublication(dir,repoRoot),/runtime assessment required/i);
    write({component:'gateway',assessment_sha256:null,vex_sha256:null},{...scan,ignoredMatches:[]});
    assert.equal(validatePublication(dir,repoRoot).component,'gateway');
  } finally { Date.now=realNow; }
});

// The Grype database downloads in the background while tests and the image
// build run. The scan must still wait for it, refuse any exit code but 0, keep
// grype's default database age check and record the database status.
test('the background Grype database download is waited for, required to succeed and recorded before the scan',()=>{
  const text=readFileSync(new URL('../.github/workflows/production-backend-images.yml',import.meta.url),'utf8');
  const at=s=>{const i=text.indexOf(s);assert.ok(i>=0,s);assert.equal(text.indexOf(s,i+1),-1,`${s} appears once`);return i;};
  const install=at('run: node scripts/install-production-scanners.mjs');
  const start=at('- name: Start the Grype vulnerability database download in the background');
  const tests=at('- name: Locked service tests and type checks');
  const require_=at('- name: Require the Grype database download to have succeeded and record its status');
  const scan=at('- name: Scan exact runtime and verify production-specific applicability');
  assert.ok(install<start&&start<tests&&tests<require_&&require_<scan);
  const startStep=text.slice(start,tests), requireStep=text.slice(require_,scan);
  assert.ok(startStep.includes('if "$1" db update; then code=0; else code=$?; fi'));
  assert.ok(startStep.includes('mv "$2/exit-code.partial" "$2/exit-code"'));
  assert.ok(requireStep.includes('if [ "$code" != 0 ]; then'));
  assert.ok(requireStep.includes("GRYPE_DB_VALIDATE_AGE: 'true'"));
  assert.ok(requireStep.includes('grype db status --output json > "$BUILD_EVIDENCE_DIR/grype-db-status.json"'));
  assert.ok(text.slice(scan).includes("GRYPE_DB_VALIDATE_AGE: 'true'"));
  assert.ok(!/MAX_ALLOWED_BUILT_AGE|max-allowed-built-age|VALIDATE_AGE: '?false|validate-age/i.test(text));
});

// The staging workflow no longer runs on pull requests, so the production PR
// check runs the staging selection and scan guard tests and also starts when
// the staging workflow file changes.
test('the production PR check runs the staging script tests and watches the staging workflow',()=>{
  const text=readFileSync(new URL('../.github/workflows/production-backend-images.yml',import.meta.url),'utf8');
  const staging=readFileSync(new URL('../.github/workflows/staging-backend-images.yml',import.meta.url),'utf8');
  const pr=text.slice(text.indexOf('  pull_request:'),text.indexOf('  push:'));
  assert.ok(pr.includes("'.github/workflows/staging-backend-images.yml'"));
  const select=text.slice(text.indexOf('- name: Verify retained database and workload source compatibility'),text.indexOf('- id: matrix'));
  for(const command of ['node --test scripts/production-backend-build.test.mjs','node --test scripts/staging-backend-build.test.mjs',
    "python3 -m unittest discover -s scripts -p 'assess*runtime_test.py'"]) assert.ok(select.includes(command),command);
  assert.ok(!/^\s*pull_request:/m.test(staging));
});
// Coverage guard for the changed-path selector. Each production image's inputs are
// the non --from COPY sources of the stages its target reaches (FROM <stage> and
// COPY --from=<stage>). A stage that is reached only through COPY --from of paths
// under /app/packages/ contributes only its packages/ sources: the migration target
// takes only the built packages from the ehr-api build stage, never the ehr-api app.
const trackedFiles=p=>execFileSync('git',['-C',repoRoot,'ls-files','--',p],{encoding:'utf8'}).split('\n').filter(Boolean);
function dockerStages(file){
  const text=readFileSync(join(repoRoot,file),'utf8').replace(/\\\r?\n/g,' ');
  const stages=[];
  for(const raw of text.split(/\r?\n/)){
    const line=raw.trim();
    const from=line.match(/^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i);
    if(from){stages.push({name:from[2]??String(stages.length),base:from[1],copies:[]});continue;}
    const copy=line.match(/^(COPY|ADD)\s+(.*)$/i);
    if(!copy) continue;
    assert.ok(stages.length,`${file}: COPY before FROM`);
    let args=copy[2].trim(), flags=[];
    while(args.startsWith('--')){const [flag,...rest]=args.split(/\s+/);flags.push(flag);args=rest.join(' ');}
    const parts=args.startsWith('[')?JSON.parse(args):args.split(/\s+/);
    const fromStage=flags.find(f=>f.startsWith('--from='))?.slice(7)??null;
    stages.at(-1).copies.push({fromStage,sources:parts.slice(0,-1)});
  }
  return stages;
}
function imageInputs(file,target){
  const stages=dockerStages(file), byName=new Map(stages.map(s=>[s.name,s]));
  assert.ok(byName.has(target),`${file}: missing target ${target}`);
  const scope=new Map([[target,'all']]), queue=[target];
  const reach=(name,how)=>{
    if(!byName.has(name)) return;
    if(scope.get(name)==='all'||scope.get(name)===how) return;
    scope.set(name,how==='all'||scope.has(name)?'all':how);queue.push(name);
  };
  while(queue.length){
    const stage=byName.get(queue.shift());
    reach(stage.base,'all');
    for(const c of stage.copies) if(c.fromStage!==null)
      reach(c.fromStage,c.sources.every(s=>s.startsWith('/app/packages/'))?'packages':'all');
  }
  const inputs=new Set([file]);
  for(const [name,how] of scope) for(const c of byName.get(name).copies) if(c.fromStage===null)
    for(const s of c.sources) if(how==='all'||s.startsWith('packages/')) inputs.add(s);
  return inputs;
}
test('every production Dockerfile COPY source selects the component that copies it',()=>{
  let checked=0;
  for(const c of components){
    const {dockerfile,target}=componentConfig(c);
    for(const source of imageInputs(dockerfile,target)){
      const files=trackedFiles(source);
      assert.ok(files.length,`${c}: ${source} is not tracked`);
      // A directory source also stands for any file added under it later.
      const isFile=files.length===1&&files[0]===source;
      for(const p of [isFile?source:`${source}/new-file`,...files]){
        assert.ok(selectComponents([p]).includes(c),`${p} is copied into ${c} but does not select it`);checked++;
      }
    }
  }
  assert.ok(checked>500,`only ${checked} image input files checked`);
});
test('the image input parser sees the inputs that the selector map relies on',()=>{
  const migration=imageInputs('services/ehr-api/Dockerfile','migration');
  for(const p of ['scripts/local-environment.mjs','services/ehr-api/database','services/ehr-api/scripts','services/ehr-api/package.json',
    'packages/api-client','packages/server-telemetry/src','services/ehr-api/Dockerfile']) assert.ok(migration.has(p),p);
  assert.ok(!migration.has('services/ehr-api/src'));
  assert.ok(imageInputs('services/ehr-api/Dockerfile','runtime').has('services/ehr-api/src'));
  assert.ok(imageInputs('services/identity-api/Dockerfile','runtime').has('services/workload-token-agent/src'));
  assert.ok(imageInputs('gateway/Dockerfile','runtime').has('gateway/nginx.conf.template'));
});

// Every scripts/ path the production workflows run, with the modules those scripts
// import, must select the components whose job runs it. Steps in the build job that
// are limited to one component belong to that component; everything else (select,
// publish, candidate, deploy, rollback) runs for every release and belongs to all.
// Test files that the select job runs are verified on every run and are exempt, but
// the modules they import are not.
const testFile=p=>/^scripts\/(test_[^/]+\.py|[^/]+_test\.py|[^/]+\.test\.mjs)$/.test(p);
function workflowSteps(file){
  const steps=[];let job=null,inJobs=false,step=null;
  for(const line of readFileSync(join(repoRoot,file),'utf8').split('\n')){
    if(/^jobs:\s*$/.test(line)){inJobs=true;continue;}
    if(!inJobs) continue;
    const j=line.match(/^  ([\w-]+):\s*$/);
    if(j){job=j[1];step=null;continue;}
    if(/^      - /.test(line)){step={job,condition:null,text:''};steps.push(step);}
    if(!step) continue;
    const condition=line.match(/^        if:\s*(.*)$/);
    if(condition) step.condition=condition[1].trim();
    step.text+=line.replace(/^\s*(?:- )?name:.*$/,'')+'\n';
  }
  return steps;
}
function stepOwners(step){
  if(step.job!=='build'||!step.condition||step.condition==='failure()') return components;
  const eq=[...step.condition.matchAll(/matrix\.component == '([\w-]+)'/g)].map(m=>m[1]);
  const ne=[...step.condition.matchAll(/matrix\.component != '([\w-]+)'/g)].map(m=>m[1]);
  assert.ok(eq.length+ne.length&&!(eq.length&&ne.length)&&!/\|\|/.test(step.condition),`unparsed condition: ${step.condition}`);
  return eq.length?eq:components.filter(c=>!ne.includes(c));
}
function stepScripts(text){
  const found=new Set();
  for(const m of text.matchAll(/(?<![\w./-])((?:services\/[\w-]+\/)?scripts\/[\w./-]+)/g)) found.add(m[1]);
  for(const m of text.matchAll(/unittest discover -s scripts -p '([^']+)'/g)){
    const pattern=new RegExp('^scripts/'+m[1].replace(/[.]/g,'\\.').replace(/\*/g,'[^/]*')+'$');
    const matches=trackedFiles('scripts').filter(p=>pattern.test(p));
    assert.ok(matches.length,`no tests match ${m[1]}`);matches.forEach(p=>found.add(p));
  }
  return found;
}
// A require of a service's built output (services/<c>/dist/...) is a read of the
// whole service build: every src file that tsconfig.build.json compiles and the
// files that configure the build. It is followed to services/<c>/src and those
// files, never dropped. Relative JavaScript imports must exist; Python import
// guesses that are not repository files are standard library modules.
const buildConfig=['package.json','package-lock.json','tsconfig.json','tsconfig.build.json','nest-cli.json'];
function builtSource(f){
  const m=f.match(/^(services\/[\w-]+)\/dist\//);
  if(!m) return [f];
  return [`${m[1]}/src`,...buildConfig.map(n=>`${m[1]}/${n}`).filter(x=>existsSync(join(repoRoot,x)))];
}
function scriptImports(p){
  if(!existsSync(join(repoRoot,p))||statSync(join(repoRoot,p)).isDirectory()) return [];
  const text=readFileSync(join(repoRoot,p),'utf8'), dir=p.slice(0,p.lastIndexOf('/')), found=[];
  if(p.endsWith('.mjs')||p.endsWith('.js'))
    for(const m of text.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)){
      for(const f of builtSource(join(dir,m[1]))){
        assert.ok(existsSync(join(repoRoot,f)),`${p} imports ${m[1]}, which is not in the repository`);found.push(f);
      }
    }
  if(p.endsWith('.py')){
    const guesses=[];
    for(const m of text.matchAll(/^\s*(?:from\s+([\w]+)\s+import|import\s+([\w]+))/gm)) guesses.push(`${dir}/${m[1]??m[2]}.py`);
    for(const m of text.matchAll(/['"](?:scripts\/)?([\w.-]+\.py)['"]/g)) guesses.push(`${dir}/${m[1]}`);
    found.push(...guesses.filter(f=>existsSync(join(repoRoot,f))));
  }
  return found;
}
// A directory owner stands for every compiled file in it now and any file added later.
const ownedFiles=p=>statSync(join(repoRoot,p)).isDirectory()
  ?[...trackedFiles(p).filter(f=>!f.endsWith('.spec.ts')),`${p}/new-file.ts`]:[p];
test('every scripts/ path the production workflows run selects the components that run it',()=>{
  const owners=new Map();
  const add=(p,cs)=>{const prev=owners.get(p)??new Set();const size=prev.size;cs.forEach(c=>prev.add(c));owners.set(p,prev);return prev.size!==size;};
  const queue=[];
  // Paths a step runs directly, or that such a path imports. A module reached
  // only through a test file is exercised by that test on every run of the
  // workflow and is never itself run by a release step, so it needs no image.
  const direct=new Set();
  for(const file of ['.github/workflows/production-backend-images.yml','.github/workflows/production-backend-rollback.yml'])
    for(const step of workflowSteps(file)) for(const p of stepScripts(step.text)){
      if(!testFile(p)) direct.add(p);
      if(add(p,stepOwners(step))) queue.push(p);
    }
  while(queue.length){
    const p=queue.shift();
    for(const i of scriptImports(p)){
      const grew=direct.has(p)&&!direct.has(i);
      if(direct.has(p)) direct.add(i);
      if(add(i,[...owners.get(p)])||grew) queue.push(i);
    }
  }
  for(const p of ['scripts/production-backend-build.mjs','scripts/verify-migration-ledger.mjs','scripts/production_deployment_core.py',
    'scripts/assess-staging-runtime.py','services/ehr-api/scripts/test-patient-evidence-runtime.mjs','scripts/test_production_deployment_ecs.py',
    'services/ehr-api/scripts/lab-work-list-runtime-checks.mjs','services/ehr-api/src','services/lab-api/src','services/lab-api/tsconfig.build.json'])
    assert.ok(owners.has(p),`workflow parser missed ${p}`);
  assert.deepEqual([...owners.get('scripts/verify-migration-ledger.mjs')],['database-migration']);
  assert.deepEqual([...owners.get('services/ehr-api/src')],['database-migration']);
  assert.deepEqual([...owners.get('services/lab-api/src')],['database-migration']);
  for(const [p,cs] of owners){
    assert.ok(existsSync(join(repoRoot,p)),`workflow runs missing ${p}`);
    if(testFile(p)||!direct.has(p)) continue;
    for(const f of ownedFiles(p)){
      const selected=selectComponents([f]);
      for(const c of cs) assert.ok(selected.includes(c),`${f} runs for ${c} but does not select it`);
    }
  }
});

// Every file that a service's tests read or import from outside the service must
// select that service, so that a change to the file runs those tests. The
// identity-api job also runs the workload token agent tests. Reads are found from
// relative path literals and from join/resolve calls built from __dirname and
// string literals (also through a const that holds such a call). Files under
// services/<c>/scripts/ are runtime verifiers that the service jobs do not run:
// the ones the migration step runs are covered by the workflow test above, and
// the rest run in the TUF staging rehearsal.
const testReader=p=>{
  const dir=p.split('/')[1];
  if(dir==='workload-token-agent') return 'identity-api';
  return components.includes(dir)&&!['gateway','database-migration'].includes(dir)?dir:null;
};
// Literals that look like paths but are never read as files.
const notReadLiterals=new Set(['services/workload-token-agent/test/agent.test.mjs ../../outside']);
function outsideReads(file){
  const text=readFileSync(join(repoRoot,file),'utf8'), dir=posix.dirname(file), service=file.split('/').slice(0,2).join('/');
  const names=new Map([['__dirname',dir],['import.meta.dirname',dir]]), found=new Set();
  const literal=a=>/^(['"])([^'"$`]*)\1$/.exec(a)?.[2];
  const evaluate=args=>{
    const parts=args.split(',').map(a=>a.trim());
    let value=names.get(parts[0]);
    if(value===undefined) return null;
    for(const a of parts.slice(1)){const l=literal(a); if(l===undefined) break; value=posix.join(value,l);}
    return posix.normalize(value);
  };
  for(const m of text.matchAll(/const\s+(\w+)\s*=\s*(?:path\.)?(?:join|resolve)\(([^()]*)\)/g)){
    const v=evaluate(m[2]); if(v) names.set(m[1],v);
  }
  for(const m of text.matchAll(/(?:path\.)?(?:join|resolve)\(([^()]*)\)/g)){const v=evaluate(m[1]); if(v) found.add(v);}
  for(const m of text.matchAll(/['"`]((?:\.\.\/)+[^'"`$]*)['"`]/g))
    if(!notReadLiterals.has(`${file} ${m[1]}`)) found.add(posix.normalize(posix.join(dir,m[1])));
  return [...found].map(p=>p.replace(/\/$/,'')).filter(p=>p!==service&&!p.startsWith(`${service}/`));
}
test('every file a service test reads from outside the service selects that service',()=>{
  const reads=new Map();
  for(const file of trackedFiles('services')){
    const reader=testReader(file);
    if(!reader||!/\.(?:ts|mts|js|mjs|cjs)$/.test(file)||/^services\/[\w-]+\/scripts\//.test(file)) continue;
    for(const target of outsideReads(file)) reads.set(`${file} -> ${target}`,{reader,target});
  }
  for(const known of ['services/identity-api/src/auth/product-gate.spec.ts -> services/ehr-api/database/migrations',
    'services/outreach-api/src/database/runtime-function-grants.spec.ts -> services/ehr-api/database/migrations',
    'services/outreach-api/src/database/runtime-function-grants.spec.ts -> services/ehr-api/database/runtime-grants.sql',
    'services/ocr-api/src/ocr/reading/reading-versions.spec.ts -> services/ocr-worker/src',
    'services/ocr-worker/src/database-privileges.spec.ts -> services/ehr-api/database/runtime-grants.sql',
    'services/outreach-api/src/outreach/health-id-unclaimed.spec.ts -> gateway/nginx.conf.template',
    'services/workload-token-agent/test/issuer.test.mjs -> infra/aws/runtime/workload-issuer/issuer.mjs',
    'services/lab-api/src/lab/lab-order-route-cannot-complete.spec.ts -> services/ehr-api/test/fixtures/order-route-cannot-complete-reasons.sql'])
    assert.ok(reads.has(known),`test read scanner missed ${known}`);
  for(const [key,{reader,target}] of reads){
    assert.ok(existsSync(join(repoRoot,target)),`${key}: not in the repository`);
    for(const f of statSync(join(repoRoot,target)).isDirectory()?[...trackedFiles(target),`${target}/new-file`]:[target])
      assert.ok(selectComponents([f]).includes(reader),`${key}: ${f} does not select ${reader}`);
  }
});
test('the workflow starts for every outside file a service test reads',()=>{
  const text=readFileSync(join(repoRoot,'.github/workflows/production-backend-images.yml'),'utf8');
  for(const [p] of outsideTestInputs){
    const root=p.split('/')[0];
    assert.ok(['services','gateway'].includes(root)||text.split(`'${p}**'`).length===3,`${p} is missing from the workflow paths`);
  }
});


// Push selection base: the commit of the last run that deployed (or built nothing).
const pushEnv={GITHUB_EVENT_NAME:'push',GITHUB_REF:`refs/heads/${releaseBranch}`,GITHUB_RUN_ID:'900'};
const sha=n=>String(n).repeat(40).slice(0,40);
const run=(id,head,extra={})=>({id,run_attempt:1,head_sha:head,head_branch:releaseBranch,event:'push',conclusion:'success',path:workflowPath,...extra});
const deployedJobs=[{name:'select',conclusion:'success'},{name:'build (lab-api)',conclusion:'success'},
  {name:'publish (lab-api)',conclusion:'success'},{name:'candidate',conclusion:'success'},{name:'deploy',conclusion:'success'}];
const publishedOnlyJobs=deployedJobs.map(j=>j.name==='deploy'?{...j,conclusion:'skipped'}:j);
const emptyJobs=[{name:'select',conclusion:'success'},{name:'build',conclusion:'skipped'},{name:'verify-publisher',conclusion:'skipped'},
  {name:'publish',conclusion:'skipped'},{name:'candidate',conclusion:'skipped'},{name:'deploy',conclusion:'skipped'}];
const fakeApi=(runs,jobs)=>async suffix=>{
  if(suffix.startsWith('actions/workflows/')){
    assert.equal(suffix,`actions/workflows/production-backend-images.yml/runs?branch=${releaseBranch}&event=push&status=success&per_page=30`);
    return {workflow_runs:runs};
  }
  const m=suffix.match(/^actions\/runs\/(\d+)\/attempts\/1\/jobs\?per_page=100$/);
  assert.ok(m,suffix);
  return {jobs:jobs[m[1]]};
};
const always=()=>true;
test('a push compares with the last run that deployed, so cancelled and failed runs are not lost',async()=>{
  // The API lists only successful runs: a cancelled or failed run in between never appears,
  // so its changes stay inside the diff from the last deployed commit.
  assert.equal(await releasedBase(pushEnv,fakeApi([run(800,sha(1)),run(700,sha(2))],{800:deployedJobs,700:deployedJobs}),always),sha(1));
  // A run that published without deploying is passed over; one that built nothing is a valid base.
  assert.equal(await releasedBase(pushEnv,fakeApi([run(800,sha(1)),run(700,sha(2))],{800:publishedOnlyJobs,700:deployedJobs}),always),sha(2));
  assert.equal(await releasedBase(pushEnv,fakeApi([run(800,sha(1))],{800:emptyJobs}),always),sha(1));
  // The current run is never its own base.
  assert.equal(await releasedBase(pushEnv,fakeApi([run(900,sha(3)),run(800,sha(1))],{800:deployedJobs}),always),sha(1));
});
test('the push base fails closed to every component on any doubt',async()=>{
  const ok=fakeApi([run(800,sha(1))],{800:deployedJobs});
  const cases=[
    ['pull request event',{...pushEnv,GITHUB_EVENT_NAME:'pull_request'},ok,always],
    ['workflow_dispatch',{...pushEnv,GITHUB_EVENT_NAME:'workflow_dispatch'},ok,always],
    ['other branch',{...pushEnv,GITHUB_REF:'refs/heads/main'},ok,always],
    ['API error',pushEnv,async()=>{throw Error('500');},always],
    ['no runs',pushEnv,fakeApi([],{}),always],
    ['unexpected answer',pushEnv,async()=>({}),always],
    ['jobs missing',pushEnv,fakeApi([run(800,sha(1))],{}),always],
    ['select did not succeed',pushEnv,fakeApi([run(800,sha(1))],{800:deployedJobs.filter(j=>j.name!=='select')}),always],
    ['only published runs',pushEnv,fakeApi([run(800,sha(1))],{800:publishedOnlyJobs}),always],
    ['not an ancestor of HEAD',pushEnv,ok,()=>false],
    ['malformed sha',pushEnv,fakeApi([run(800,'abc')],{800:deployedJobs}),always],
    ['other workflow',pushEnv,fakeApi([run(800,sha(1),{path:'.github/workflows/other.yml'})],{800:deployedJobs}),always],
    ['other branch run',pushEnv,fakeApi([run(800,sha(1),{head_branch:'main'})],{800:deployedJobs}),always],
    ['failed run listed',pushEnv,fakeApi([run(800,sha(1),{conclusion:'failure'})],{800:deployedJobs}),always],
  ];
  for(const [name,env,api,ancestor] of cases){
    const base=await releasedBase(env,api,ancestor);
    assert.equal(base,null,name);
    assert.deepEqual(selectChanged(base,()=>'docs/a.md\0'),components,name);
  }
});
test('the select job reads the push base from the Actions API, not from the previous push',()=>{
  const text=readFileSync(join(repoRoot,'.github/workflows/production-backend-images.yml'),'utf8');
  const select=text.slice(text.indexOf('\n  select:\n'),text.indexOf('\n  build:\n'));
  assert.ok(/permissions:\n\s+contents: read\n\s+actions: read\n/.test(select));
  assert.ok(select.includes('BASE_SHA: ${{ github.event.pull_request.base.sha }}\n'));
  assert.ok(!select.includes('github.event.before'));
});
