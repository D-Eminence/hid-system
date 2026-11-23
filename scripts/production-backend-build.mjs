import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const components = ['identity-api','ehr-api','lab-api','pharmacy-api','ocr-api','ocr-worker',
  'outreach-api','notification-api','notification-worker','event-dispatcher','gateway','support-api','database-migration'];
const registry = '659225405023.dkr.ecr.eu-west-1.amazonaws.com';
export function assertPublicationContext(e) {
  if(e.GITHUB_REPOSITORY!=='D-Eminence/hid-system'||e.GITHUB_REPOSITORY_ID!=='1317340803'
    ||e.GITHUB_REPOSITORY_OWNER_ID!=='182018869'||!['push','workflow_dispatch'].includes(e.GITHUB_EVENT_NAME)
    ||e.GITHUB_REF!=='refs/heads/staging-novu-ci-20261005') throw Error('Publication context rejected');
}
export const runtimePolicyPath = () => 'security/production-runtime-assessment.json';
// Committed OpenVEX for the gateway's Alpine OpenSSL. The gateway has no ELF
// inventory assessment, so only these exact package statements may suppress a
// gateway finding, only until hid_expires_at, and only while the gateway files
// it was reviewed against (hid_bound_files: path -> sha256) are unchanged.
export const gatewayVexPath = 'security/gateway-runtime.vex.json';
export const gatewayBoundFiles = ['gateway/Dockerfile','gateway/nginx.conf.template','gateway/proxy-headers.conf'];
const repoRoot = fileURLToPath(new URL('../',import.meta.url));
const highCritical = report => (report?.ignoredMatches??[]).filter(m=>['High','Critical'].includes(m.vulnerability?.severity));
export function gatewayBoundFileHashes(root=repoRoot) {
  return Object.fromEntries(gatewayBoundFiles.map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')]));
}
export function assertGatewayVex(ignored, vex, now=Date.now(), root=repoRoot) {
  const expires=Date.parse(vex?.hid_expires_at), issued=Date.parse(vex?.timestamp);
  if(vex?.['@context']!=='https://openvex.dev/ns/v0.2.0'||!Array.isArray(vex.statements)
    ||!Number.isFinite(expires)||!Number.isFinite(issued)||now>=expires||expires-issued>30*86400000)
    throw Error('Reviewed unexpired gateway OpenVEX required');
  const bound=vex.hid_bound_files;
  let current;
  try { current=gatewayBoundFileHashes(root); } catch { throw Error('Gateway OpenVEX bound files missing'); }
  if(!bound||typeof bound!=='object'||Array.isArray(bound)
    ||JSON.stringify(Object.keys(bound).sort())!==JSON.stringify([...gatewayBoundFiles].sort())
    ||gatewayBoundFiles.some(p=>bound[p]!==current[p]))
    throw Error('Gateway changed since its OpenVEX was reviewed');
  for(const m of ignored){
    const covered=vex.statements.some(s=>s.vulnerability?.name===m.vulnerability.id&&s.status==='not_affected'
      &&s.justification==='vulnerable_code_not_in_execute_path'&&s.products?.some(p=>p['@id']===m.artifact.purl));
    if(m.vulnerability.severity!=='High'||m.artifact.type!=='apk'||!covered
      ||!m.appliedIgnoreRules?.some(r=>r.namespace==='vex'&&r['vex-status']==='not_affected'))
      throw Error('Unassessed or incorrectly suppressed High/Critical finding');
  }
}
// The committed gateway VEX is read only for a gateway scan with ignored High/Critical
// rows and no native assessment; a clean gateway scan needs no VEX file at all.
export function loadGatewayVex(component, assessment, scan, root=repoRoot) {
  const file=join(root,gatewayVexPath);
  if(component!=='gateway'||assessment||!highCritical(scan).length||!existsSync(file)) return null;
  return JSON.parse(readFileSync(file));
}
const run = (command,args,options={}) => (execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','inherit'],...options})??'').trim();
// Changed-path selection. Every changed path must match one rule below; a path
// that matches none rebuilds every component, as does any path under scripts/
// or packages/ that is not listed, and any .dockerignore (the root one and the
// per-Dockerfile <Dockerfile>.dockerignore files that BuildKit also reads). A
// narrower rule can only leave the previously scanned image running: nothing is
// published unless it is rebuilt, scanned and admitted in this run.
// production-backend-build.test.mjs checks these rules against every production
// Dockerfile COPY source, every scripts/ path the production workflows run (and
// the modules and built service output those scripts load), and every file a
// service's tests read from outside that service.
const nodeServices = components.filter(c=>!['gateway','database-migration'].includes(c));
const apiClientServices = ['ehr-api','lab-api','pharmacy-api','ocr-api','outreach-api'];
export const maxChangedPaths = 300;
// The selector and its test, the build and evidence scripts, the deployment
// controller (every release redeploys through it) and repository-wide build inputs.
const rebuildAllPaths = new Set(['package.json','.gitattributes',runtimePolicyPath(),
  'scripts/production-backend-build.mjs','scripts/production-backend-build.test.mjs',
  'scripts/install-production-scanners.mjs','scripts/assess-production-runtime.py',
  'scripts/assess-staging-runtime.py','scripts/production-deployment.mjs',
  'scripts/verify-production-approval.py','scripts/production_release_compatibility.py']);
const migrationOnlyScripts = new Set(['scripts/verify-migration-ledger.mjs','scripts/local-environment.mjs']);
// The migration build step compiles ehr-api and lab-api from source and runs the
// database rehearsal against that built output (services/ehr-api/scripts/
// test-patient-evidence-runtime.mjs), and the migration image ships ehr-api's
// database, scripts and dependencies. So every ehr-api or lab-api file except
// its jest specs and test/ directory, which neither build reads, also selects
// the migration runner.
const rehearsalServices = ['ehr-api','lab-api'];
const notBuilt = p => p.endsWith('.spec.ts')||/^services\/[\w-]+\/test\//.test(p);
// Files that a service's tests read from outside that service (jest specs, and
// for identity-api the workload token agent tests its job runs). A change to one
// of these runs the reader's tests too. Prefixes end in '/'; the rest are exact.
export const outsideTestInputs = [
  // ocr-worker and outreach-api grant specs build their paths from the whole database directory.
  ['services/ehr-api/database/',['ocr-worker','outreach-api']],
  ['services/ehr-api/database/migrations/',['identity-api','ocr-api']],
  ['services/ehr-api/test/database/registration-case-list.integration.sql',['identity-api']],
  // #279: qoreid-nin-desk.spec.ts holds this suite to the desk NIN holder read.
  ['services/ehr-api/test/database/desk-nin-holder.integration.sql',['identity-api']],
  // SX-8: open-patient-sql.spec.ts holds this suite to Identity's open-patient statements.
  ['services/ehr-api/test/database/session-open-patient.integration.sql',['identity-api']],
  ['services/ehr-api/test/fixtures/order-route-cannot-complete-reasons.sql',['lab-api','pharmacy-api']],
  ['services/ocr-worker/src/',['ocr-api']],
  ['services/identity-api/src/identity/dto/authorize-outreach.dto.ts',['outreach-api']],
  ['gateway/nginx.conf.template',['outreach-api']],
  ['infra/aws/runtime/workload-issuer/',['identity-api']],
  // ehr-api's zero136-count-block.spec.ts checks 0136 carries this file's count block (Q113 A).
  ['docs/rollback/0136_affected_staff_counts.sql',['ehr-api']],
];
const noImagePackages = ['ui','offline','telemetry','identity-browser-client'];
// Never copied into a production image and never run by the production build.
const noImageScripts = [/^scripts\/tests\//,/^scripts\/tuf-[^/]+$/,/^scripts\/staging-[^/]+$/,
  /^scripts\/verify-[^/]+\.mjs$/,/^scripts\/(test_[^/]+\.py|[^/]+_test\.py|[^/]+\.test\.mjs)$/];
const noImageSecurity = [/^security\/[^/]+\.md$/,/^security\/staging-[a-z]+-runtime-assessment\.json$/,
  /^security\/[^/]+-runtime-evidence\.json$/,/^security\/npm-audit-exceptions\.json$/];
const noImageRoots = ['apps/','docs/','infra/','release/','tools/','.github/'];
const noImageFiles = new Set(['README.md','CODEX.md','.gitignore','config/production-schema-compatibility.json']);
function imageComponentsForPath(p) {
  if(rebuildAllPaths.has(p)||p.endsWith('.dockerignore')||p.startsWith('.github/workflows/production-backend-')
    ||/^scripts\/production_deployment[\w-]*\.py$/.test(p)) return components;
  if(p===gatewayVexPath) return ['gateway'];
  if(p==='security/staging-novu-runtime-assessment.json') return ['notification-worker','database-migration'];
  // The migration ledger and local environment are read only by the migration target.
  if(migrationOnlyScripts.has(p)) return ['database-migration'];
  const rehearsal=rehearsalServices.find(c=>p.startsWith(`services/${c}/`));
  if(rehearsal&&!notBuilt(p)) return [rehearsal,'database-migration'];
  if(p.startsWith('packages/server-telemetry/')) return [...nodeServices,'database-migration'];
  if(p.startsWith('packages/api-client/')) return [...apiClientServices,'database-migration'];
  if(noImagePackages.some(x=>p.startsWith(`packages/${x}/`))) return [];
  if(p.startsWith('packages/')) return components;
  if(noImageScripts.some(r=>r.test(p))) return [];
  if(p.startsWith('scripts/')) return components;
  // identity-api copies the workload token agent (services/identity-api/Dockerfile).
  if(p.startsWith('services/workload-token-agent/')) return ['identity-api'];
  const service=nodeServices.find(c=>p.startsWith(`services/${c}/`));
  if(service) return [service];
  if(p.startsWith('services/')) return components;
  if(p.startsWith('gateway/')) return ['gateway'];
  if(noImageSecurity.some(r=>r.test(p))) return [];
  if(p.startsWith('security/')) return components;
  if(noImageFiles.has(p)||noImageRoots.some(r=>p.startsWith(r))) return [];
  return components;
}
export function componentsForPath(p) {
  if(typeof p!=='string'||!p||p.startsWith('/')||p.split('/').includes('..')) return components;
  const selected=imageComponentsForPath(p);
  if(selected===components) return components;
  const readers=outsideTestInputs.filter(([s])=>s.endsWith('/')?p.startsWith(s):p===s).flatMap(([,cs])=>cs);
  return readers.length?components.filter(c=>selected.includes(c)||readers.includes(c)):selected;
}
export function selectComponents(paths, requested='changed') {
  if(requested==='patient-chat-update') return ['identity-api','ehr-api','lab-api','database-migration'];
  if(requested==='admin-update') return ['identity-api','database-migration'];
  if(requested==='novu-update') return ['notification-worker','database-migration'];
  if(requested==='all') return components;
  if(requested!=='changed') { if(!components.includes(requested)) throw Error('Unknown backend component'); return [requested]; }
  // No paths or too many to review: build everything.
  if(!Array.isArray(paths)||!paths.length||paths.length>maxChangedPaths) return components;
  const result=new Set();
  for(const p of paths){
    const selected=componentsForPath(p);
    if(selected===components) return components;
    selected.forEach(c=>result.add(c));
  }
  return components.filter(c=>result.has(c));
}
const gitDiff = base => execFileSync('git',['diff','--no-renames','--name-only','-z',base,'HEAD'],
  {encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:64*1024*1024});
// Paths changed since base, or null when base is missing, all zeros or unusable,
// or the diff fails. --no-renames reports both sides of a move.
export function changedPaths(base, diff=gitDiff) {
  if(!/^[a-f0-9]{40}$/.test(base??'')||/^0+$/.test(base)) return null;
  try { return diff(base).split('\0').filter(Boolean); } catch { return null; }
}
export function selectChanged(base, diff=gitDiff) {
  const paths=changedPaths(base,diff);
  return paths===null?components:selectComponents(paths);
}
// The base for a push is the commit of the newest earlier push run of this
// workflow that finished with success and either deployed or built nothing, not
// the previous push (github.event.before). A queued run that GitHub cancelled for
// a newer one, or a run that failed before deploying, released nothing, so its
// changes stay in the diff until a run deploys them. A run that published but did
// not deploy (deployment switched off) is passed over the same way. Any API error,
// unexpected answer, no qualifying run among the newest 30, or a base that is not
// an ancestor of HEAD returns null, and a null base builds every component.
// The select job also hands this base to the candidate step (released_base), which
// compares the schema change with it: a migration that a failed release left pending
// is then still a new file there, so a reviewed change to it needs no carrier push.
// A pull request, a dispatch or a null base hands over nothing, and the candidate
// falls back to the push's before.
export function selectionOutputs(matrix, base, env) {
  const released=env.GITHUB_EVENT_NAME==='push'&&/^[a-f0-9]{40}$/.test(base??'')&&!/^0+$/.test(base)?base:'';
  return `matrix=${matrix}\nhas_changes=${JSON.parse(matrix).component.length>0}\nreleased_base=${released}\n`;
}
export const releaseBranch = 'staging-novu-ci-20261005';
export const workflowPath = '.github/workflows/production-backend-images.yml';
async function githubGet(suffix, env=process.env) {
  if(!env.GITHUB_TOKEN||!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY??'')) throw Error('GitHub context required');
  const response=await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${suffix}`,{
    headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28','User-Agent':'HID-Production-Selector/1'},signal:AbortSignal.timeout(30000)});
  if(!response.ok) throw Error(`GitHub API answered ${response.status}`);
  return response.json();
}
const gitIsAncestor = sha => {
  try { execFileSync('git',['merge-base','--is-ancestor',sha,'HEAD'],{stdio:'ignore'}); return true; } catch { return false; }
};
export async function releasedBase(env, request=suffix=>githubGet(suffix,env), isAncestor=gitIsAncestor) {
  try {
    if(env.GITHUB_EVENT_NAME!=='push'||env.GITHUB_REF!==`refs/heads/${releaseBranch}`) return null;
    const file=workflowPath.split('/').pop();
    const runs=(await request(`actions/workflows/${file}/runs?branch=${releaseBranch}&event=push&status=success&per_page=30`))?.workflow_runs;
    if(!Array.isArray(runs)) return null;
    for(const run of runs){
      if(String(run?.id)===String(env.GITHUB_RUN_ID)) continue;
      if(run.head_branch!==releaseBranch||run.event!=='push'||run.conclusion!=='success'||run.path!==workflowPath
        ||!/^[a-f0-9]{40}$/.test(run.head_sha??'')||!Number.isInteger(run.id)||!Number.isInteger(run.run_attempt)) return null;
      const jobs=(await request(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`))?.jobs;
      if(!Array.isArray(jobs)||!jobs.some(j=>j?.name==='select'&&j.conclusion==='success')) return null;
      const deployed=jobs.some(j=>j.name==='deploy'&&j.conclusion==='success');
      const built=jobs.some(j=>/^(build|publish|candidate)\b/.test(j.name??'')&&j.conclusion!=='skipped');
      if(!deployed&&built) continue;
      return isAncestor(run.head_sha)?run.head_sha:null;
    }
    return null;
  } catch { return null; }
}
export function componentConfig(c) {
  if(!components.includes(c)) throw Error('Unknown backend component');
  return {component:c, repository:`staging/hid/${c==='database-migration'?'ehr-api':c}`,
    dockerfile:c==='gateway'?'gateway/Dockerfile':`services/${c==='database-migration'?'ehr-api':c}/Dockerfile`,
    target:c==='database-migration'?'migration':'runtime'};
}
export function assertScan(report, assessment=null, policy=null, gatewayVex=null) {
  if(!Array.isArray(report.matches) || !report.descriptor?.version || !report.distro?.name || !report.distro?.version) throw Error('Complete Grype report with OS distribution required');
  if(report.matches.some(m=>['High','Critical'].includes(m.vulnerability?.severity))) throw Error('High/Critical vulnerabilities block publication');
  const ignored=highCritical(report);
  if(!ignored.length) return;
  if(!assessment&&gatewayVex) return assertGatewayVex(ignored,gatewayVex);
  if(!assessment||!policy||!Number.isFinite(Date.parse(assessment.expires_at))||Date.now()>=Date.parse(assessment.expires_at)
    ||assessment.expires_at!==policy.expires_at||!policy.elf_inventory[assessment.component]
    ||assessment.native_binary_count!==Object.keys(policy.elf_inventory[assessment.component]).length
    ||assessment.glibc_affected_imports!==0||assessment.raw_high_matches!==ignored.length)
    throw Error('Image-bound unexpired runtime assessment required');
  for(const m of ignored){
    const finding=policy.findings.find(f=>f.id===m.vulnerability.id&&f.packages.includes(m.artifact.name));
    // Optional per-finding expires_at: refused at and after that instant (or if unparsable).
    if(m.vulnerability.severity==='Critical'||!finding||finding.versions[m.artifact.name]!==m.artifact.version
      ||('expires_at' in finding&&!(Date.now()<Date.parse(finding.expires_at)))
      ||!assessment.reviewed_not_affected.some(r=>r.id===m.vulnerability.id&&r.package===m.artifact.name&&r.version===m.artifact.version&&r.purl===m.artifact.purl)
      ||!m.appliedIgnoreRules?.some(r=>r.namespace==='vex'&&r['vex-status']==='not_affected'))
      throw Error('Unassessed or incorrectly suppressed High/Critical finding');
  }
}
const hashFile=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
export function assertAssessmentBinding(assessment, component, source, imageId, rawHash) {
  if(assessment.assessment_scope!=='production'||assessment.component!==component
    ||assessment.source_commit!==source||assessment.image_id!==imageId||assessment.raw_scan_sha256!==rawHash)
    throw Error('Production assessment image/source/raw scan binding differs');
}
function context(){
  const e=process.env, sha=run('git',['rev-parse','HEAD']);
  if(!/^[a-f0-9]{40}$/.test(sha) || e.GITHUB_SHA && e.GITHUB_SHA!==sha) throw Error('Source mismatch');
  if(run('git',['status','--porcelain','--untracked-files=no'])) throw Error('Tracked source is dirty');
  return {source_commit:sha,run_id:e.GITHUB_RUN_ID??'local',run_attempt:e.GITHUB_RUN_ATTEMPT??'1'};
}
async function main(){
  const [mode,c]=process.argv.slice(2), e=process.env;
  if(mode==='matrix') {
    const requested=e.REQUESTED_COMPONENT||'changed';
    // A pull request compares with its base; a push compares with the last released run.
    const base=requested!=='changed'?null:e.GITHUB_EVENT_NAME==='pull_request'?e.BASE_SHA:await releasedBase(e);
    if(requested==='changed') console.error(`Selection base: ${base||'none, so every component is built'}`);
    const selected=requested==='changed'?selectChanged(base):selectComponents([],requested);
    const matrix=JSON.stringify({component:selected});
    if(e.GITHUB_OUTPUT) writeFileSync(e.GITHUB_OUTPUT,selectionOutputs(matrix,base,e),{flag:'a'});
    console.log(matrix);return;
  }
  const config=componentConfig(c), source=context(), directory=e.BUILD_EVIDENCE_DIR??`build-evidence/${c}`;
  mkdirSync(directory,{recursive:true});
  const local=`hid-ci/${c}:${source.source_commit}`;
  if(mode==='build') {
    run('docker',['buildx','build','--pull','--platform','linux/arm64','--target',config.target,'--provenance=false',
      '--label',`org.opencontainers.image.revision=${source.source_commit}`,
      '--label','org.opencontainers.image.source=https://github.com/D-Eminence/hid-system',
      '-f',config.dockerfile,'-t',local,'--load','.'],{stdio:'inherit'});return;
  }
  if(mode==='distro') {
    const container=run('docker',['create',local]);
    try {
      let osRelease;
      for(const location of ['/etc/os-release','/usr/lib/os-release']) {
        try {run('docker',['cp',`${container}:${location}`,`${directory}/os-release`],{stdio:['ignore','pipe','pipe']});
          osRelease=readFileSync(`${directory}/os-release`,'utf8');break;}catch{}
      }
      const id=osRelease?.match(/^ID=["']?([a-z0-9_-]+)/m)?.[1],version=osRelease?.match(/^VERSION_ID=["']?([0-9.]+)/m)?.[1];
      if(!id||!version) throw Error('Exact image distribution cannot be established');
      writeFileSync(`${directory}/distribution.json`,JSON.stringify({id,version,image:local})+'\n');
      if(e.GITHUB_OUTPUT)writeFileSync(e.GITHUB_OUTPUT,`distro=${id}:${version}\n`,{flag:'a'});
      console.log(`${id}:${version}`);return;
    }finally{run('docker',['rm',container]);}
  }
  if(mode==='findings') {
    const scan=JSON.parse(readFileSync(`${directory}/grype.json`));
    const findings=scan.matches.filter(m=>['High','Critical'].includes(m.vulnerability?.severity));
    console.log(JSON.stringify(findings.map(m=>({id:m.vulnerability.id,severity:m.vulnerability.severity,
      package:m.artifact.name,version:m.artifact.version,type:m.artifact.type,
      fix:m.vulnerability.fix,url:m.vulnerability.dataSource,namespace:m.vulnerability.namespace})),null,2));
    return;
  }
  const scan=JSON.parse(readFileSync(`${directory}/grype.json`));
  const assessment=existsSync(`${directory}/runtime-assessment.json`)?JSON.parse(readFileSync(`${directory}/runtime-assessment.json`)):null;
  const policy=assessment?JSON.parse(readFileSync(runtimePolicyPath(c))):null;
  if(assessment&&(assessment.component!==c||assessment.policy_sha256!==hashFile(runtimePolicyPath(c)))) throw Error('Runtime assessment policy binding changed');
  if(assessment) assertAssessmentBinding(assessment,c,source.source_commit,assessment.image_id,hashFile(`${directory}/grype.raw.json`));
  const gatewayVex=loadGatewayVex(c,assessment,scan);
  assertScan(scan,assessment,policy,gatewayVex);
  const gatewayIgnored=gatewayVex?highCritical(scan).length:0;
  if(mode==='pack') {
    const image=JSON.parse(run('docker',['image','inspect',local]))[0];
    if(image.Os!=='linux'||image.Architecture!=='arm64'||image.Config.Labels?.['org.opencontainers.image.revision']!==source.source_commit) throw Error('Image provenance mismatch');
    if(assessment&&assessment.image_id!==image.Id) throw Error('Assessment covers a different image');
    run('docker',['save','--output',`${directory}/image.tar`,local]);
    if(gatewayIgnored) writeFileSync(`${directory}/gateway-runtime.vex.json`,readFileSync(gatewayVexPath));
    const receipt={schema:'hid.production-component-build/v1',...source,...config,local_tag:local,image_id:image.Id,
      architecture:'arm64',os:'linux',archive_sha256:hashFile(`${directory}/image.tar`),
      sbom_sha256:hashFile(`${directory}/sbom.spdx.json`),scan_sha256:hashFile(`${directory}/grype.json`),
      high_critical_findings:0,raw_high_matches:assessment?.raw_high_matches??gatewayIgnored,
      assessment_sha256:assessment?hashFile(`${directory}/runtime-assessment.json`):null,
      vex_sha256:assessment?hashFile(`${directory}/runtime.vex.json`):gatewayIgnored?hashFile(gatewayVexPath):null,
      raw_scan_sha256:hashFile(`${directory}/grype.raw.json`),deployment_authorized:false};
    writeFileSync(`${directory}/build.json`,JSON.stringify(receipt,null,2)+'\n');return;
  }
  if(mode!=='publish') throw Error('Unknown build operation');
  assertPublicationContext(e);
  const receipt=JSON.parse(readFileSync(`${directory}/build.json`));
  if(receipt.component!==c||receipt.source_commit!==source.source_commit||receipt.run_id!==source.run_id
    ||receipt.run_attempt!==source.run_attempt||receipt.archive_sha256!==hashFile(`${directory}/image.tar`)
    ||receipt.sbom_sha256!==hashFile(`${directory}/sbom.spdx.json`)||receipt.scan_sha256!==hashFile(`${directory}/grype.json`)) throw Error('Build evidence mismatch');
  if(receipt.raw_scan_sha256!==hashFile(`${directory}/grype.raw.json`)
    ||(assessment&&(receipt.assessment_sha256!==hashFile(`${directory}/runtime-assessment.json`)
      ||receipt.vex_sha256!==hashFile(`${directory}/runtime.vex.json`)))
    ||(gatewayIgnored&&receipt.vex_sha256!==hashFile(gatewayVexPath))) throw Error('Assessment evidence changed in transfer');
  const aws=(...args)=>JSON.parse(run('aws',[...args,'--region','eu-west-1','--output','json','--no-cli-pager']));
  if(aws('sts','get-caller-identity').Account!=='659225405023') throw Error('Wrong AWS account');
  const repo=aws('ecr','describe-repositories','--repository-names',config.repository).repositories[0];
  if(repo.imageTagMutability!=='IMMUTABLE'||!repo.imageScanningConfiguration.scanOnPush) throw Error('Immutable scanned staging repository required');
  run('docker',['load','--input',`${directory}/image.tar`]);
  const image=JSON.parse(run('docker',['image','inspect',local]))[0];
  if(image.Id!==receipt.image_id||image.Architecture!=='arm64'||image.Config.Labels?.['org.opencontainers.image.revision']!==source.source_commit) throw Error('Loaded image mismatch');
  if(assessment){
    assertAssessmentBinding(assessment,c,source.source_commit,image.Id,hashFile(`${directory}/grype.raw.json`));
    run('python3',['scripts/assess-production-runtime.py',c,local,`${directory}/grype.raw.json`,`${directory}/publish-verification`],{stdio:'inherit'});
    const verified=JSON.parse(readFileSync(`${directory}/publish-verification/runtime-assessment.json`));
    for(const key of ['image_id','policy_sha256','native_inventory_sha256'])
      if(verified[key]!==assessment[key]) throw Error('Loaded native runtime assessment differs');
  }
  const password=run('aws',['ecr','get-login-password','--region','eu-west-1']);
  run('docker',['login','--username','AWS','--password-stdin',registry],{input:password,stdio:['pipe','pipe','pipe']});
  const tag=`ci-${source.source_commit}-${source.run_id}-${source.run_attempt}-${config.target}`,target=`${registry}/${config.repository}:${tag}`;
  run('docker',['tag',local,target]);
  run('docker',['push',target],{stdio:'inherit'});
  const digest=aws('ecr','describe-images','--repository-name',config.repository,'--image-ids',`imageTag=${tag}`).imageDetails[0]?.imageDigest;
  if(!/^sha256:[a-f0-9]{64}$/.test(digest??'')) throw Error('Published digest missing');
  const remote=JSON.parse(run('docker',['buildx','imagetools','inspect',`${registry}/${config.repository}@${digest}`,'--format','{{json .Image}}']));
  if(remote.architecture!=='arm64'||remote.config?.Labels?.['org.opencontainers.image.revision']!==source.source_commit) throw Error('Remote provenance mismatch');
  writeFileSync(`${directory}/publication.json`,JSON.stringify({...receipt,image_uri:`${registry}/${config.repository}@${digest}`,digest,tag,
    published_at:new Date().toISOString(),publication:'Production candidate in retained ECR; deployment requires manual approval'},null,2)+'\n');
  console.log(`Published ${c}: ${digest}`);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(error=>{console.error(error);process.exitCode=1;});
