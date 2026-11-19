import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,copyFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {selectComponents,componentConfig,components,assertScan,runtimePolicyPath,assertPublicationContext,assertAssessmentBinding,assertGatewayVex,gatewayVexPath,
  gatewayBoundFiles,gatewayBoundFileHashes,loadGatewayVex,componentsForPath,changedPaths,selectChanged,maxChangedPaths} from './production-backend-build.mjs';

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
  assert.deepEqual(selectComponents(['services/ehr-api/src/main.ts']),['ehr-api']);
});
test('a migration PR with its ledger and rehearsal scripts no longer rebuilds all 13',()=>assert.deepEqual(selectComponents([
  'scripts/verify-migration-ledger.mjs','scripts/tuf-staging-migration-rehearsal.mjs','services/ehr-api/database/migrations/0137_example.sql',
  'services/ehr-api/database/runtime-grants.sql','services/identity-api/src/app.module.ts','release/migration/manifest.json']),
  ['identity-api','ehr-api','database-migration']));
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
  assert.deepEqual(selectChanged(base,()=>'services/lab-api/src/a.ts\0services/lab-api/src/b.ts\0'),['lab-api']);
});
test('renames report both paths, so moving a file out of a service still rebuilds that service',()=>{
  const repo=mkdtempSync(join(tmpdir(),'hid-select-'));
  const git=(...a)=>execFileSync('git',['-C',repo,'-c','user.name=t','-c','user.email=t@example.invalid',...a],{encoding:'utf8'});
  try{
    git('init','-q');
    mkdirSync(join(repo,'services/lab-api/src'),{recursive:true});
    writeFileSync(join(repo,'services/lab-api/src/helper.ts'),'export const x = 1;\n'.repeat(20));
    git('add','.');git('commit','-qm','base');
    const base=git('rev-parse','HEAD').trim();
    mkdirSync(join(repo,'docs'));
    git('mv','services/lab-api/src/helper.ts','docs/helper.ts');git('commit','-qm','move');
    const diff=b=>execFileSync('git',['-C',repo,'diff','--no-renames','--name-only','-z',b,'HEAD'],{encoding:'utf8'});
    assert.deepEqual(changedPaths(base,diff).sort(),['docs/helper.ts','services/lab-api/src/helper.ts']);
    assert.deepEqual(selectChanged(base,diff),['lab-api']);
  }finally{rmSync(repo,{recursive:true,force:true});}
});
test('database changes also rebuild the migration runner',()=>assert.deepEqual(selectComponents(['services/ehr-api/database/migrations/0063_example.sql']),['ehr-api','database-migration']));
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
function scriptImports(p){
  if(!existsSync(join(repoRoot,p))) return [];
  const text=readFileSync(join(repoRoot,p),'utf8'), dir=p.slice(0,p.lastIndexOf('/')), found=[];
  if(p.endsWith('.mjs')||p.endsWith('.js'))
    for(const m of text.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) found.push(join(dir,m[1]));
  if(p.endsWith('.py')){
    for(const m of text.matchAll(/^\s*(?:from\s+([\w]+)\s+import|import\s+([\w]+))/gm)) found.push(`${dir}/${m[1]??m[2]}.py`);
    for(const m of text.matchAll(/['"](?:scripts\/)?([\w.-]+\.py)['"]/g)) found.push(`${dir}/${m[1]}`);
  }
  return found.filter(f=>existsSync(join(repoRoot,f)));
}
test('every scripts/ path the production workflows run selects the components that run it',()=>{
  const owners=new Map();
  const add=(p,cs)=>{const prev=owners.get(p)??new Set();const size=prev.size;cs.forEach(c=>prev.add(c));owners.set(p,prev);return prev.size!==size;};
  const queue=[];
  for(const file of ['.github/workflows/production-backend-images.yml','.github/workflows/production-backend-rollback.yml'])
    for(const step of workflowSteps(file)) for(const p of stepScripts(step.text)) if(add(p,stepOwners(step))) queue.push(p);
  while(queue.length){
    const p=queue.shift();
    for(const i of scriptImports(p)) if(add(i,[...owners.get(p)])) queue.push(i);
  }
  for(const p of ['scripts/production-backend-build.mjs','scripts/verify-migration-ledger.mjs','scripts/production_deployment_core.py',
    'scripts/assess-staging-runtime.py','services/ehr-api/scripts/test-patient-evidence-runtime.mjs','scripts/test_production_deployment_ecs.py'])
    assert.ok(owners.has(p),`workflow parser missed ${p}`);
  assert.deepEqual([...owners.get('scripts/verify-migration-ledger.mjs')],['database-migration']);
  for(const [p,cs] of owners){
    assert.ok(existsSync(join(repoRoot,p)),`workflow runs missing ${p}`);
    if(testFile(p)) continue;
    const selected=selectComponents([p]);
    for(const c of cs) assert.ok(selected.includes(c),`${p} runs for ${c} but does not select it`);
  }
});
