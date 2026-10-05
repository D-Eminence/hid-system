import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const components = ['identity-api','ehr-api','lab-api','pharmacy-api','ocr-api','ocr-worker',
  'outreach-api','notification-api','notification-worker','event-dispatcher','gateway','support-api','database-migration'];
const registry = '659225405023.dkr.ecr.eu-west-1.amazonaws.com';
const run = (command,args,options={}) => (execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','inherit'],...options})??'').trim();
export function selectComponents(paths, requested='changed') {
  if(requested==='novu-update') return ['notification-worker','database-migration'];
  if(requested==='all') return components;
  if(requested!=='changed') { if(!components.includes(requested)) throw Error('Unknown backend component'); return [requested]; }
  const result=new Set();
  for(const p of paths){
    if(p==='security/staging-novu-runtime-assessment.json'){
      result.add('notification-worker');result.add('database-migration');continue;
    }
    if(p.startsWith('packages/') || p.startsWith('scripts/') || p.startsWith('.github/workflows/staging-backend-images')) return components;
    if(p.startsWith('gateway/')) result.add('gateway');
    for(const c of components.filter(x=>!['gateway','database-migration'].includes(x)))
      if(p.startsWith(`services/${c}/`)) result.add(c);
    if(p.startsWith('services/ehr-api/database/') || p.startsWith('services/ehr-api/scripts/')) result.add('database-migration');
  }
  return components.filter(c=>result.has(c));
}
export function componentConfig(c) {
  if(!components.includes(c)) throw Error('Unknown backend component');
  return {component:c, repository:`staging/hid/${c==='database-migration'?'ehr-api':c}`,
    dockerfile:c==='gateway'?'gateway/Dockerfile':`services/${c==='database-migration'?'ehr-api':c}/Dockerfile`,
    target:c==='database-migration'?'migration':'runtime'};
}
export function assertScan(report, assessment=null, policy=null) {
  if(!Array.isArray(report.matches) || !report.descriptor?.version || !report.distro?.name || !report.distro?.version) throw Error('Complete Grype report with OS distribution required');
  if(report.matches.some(m=>['High','Critical'].includes(m.vulnerability?.severity))) throw Error('High/Critical vulnerabilities block publication');
  const ignored=(report.ignoredMatches??[]).filter(m=>['High','Critical'].includes(m.vulnerability?.severity));
  if(!ignored.length) return;
  if(!assessment||!policy||!Number.isFinite(Date.parse(assessment.expires_at))||Date.now()>=Date.parse(assessment.expires_at)
    ||assessment.expires_at!==policy.expires_at||!policy.elf_inventory[assessment.component]
    ||assessment.native_binary_count!==Object.keys(policy.elf_inventory[assessment.component]).length
    ||assessment.glibc_affected_imports!==0||assessment.raw_high_matches!==ignored.length)
    throw Error('Image-bound unexpired runtime assessment required');
  for(const m of ignored){
    const finding=policy.findings.find(f=>f.id===m.vulnerability.id&&f.packages.includes(m.artifact.name));
    if(m.vulnerability.severity==='Critical'||!finding||finding.versions[m.artifact.name]!==m.artifact.version
      ||!assessment.reviewed_not_affected.some(r=>r.id===m.vulnerability.id&&r.package===m.artifact.name&&r.version===m.artifact.version&&r.purl===m.artifact.purl)
      ||!m.appliedIgnoreRules?.some(r=>r.namespace==='vex'&&r['vex-status']==='not_affected'))
      throw Error('Unassessed or incorrectly suppressed High/Critical finding');
  }
}
const hashFile=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function context(){
  const e=process.env, sha=run('git',['rev-parse','HEAD']);
  if(!/^[a-f0-9]{40}$/.test(sha) || e.GITHUB_SHA && e.GITHUB_SHA!==sha) throw Error('Source mismatch');
  if(run('git',['status','--porcelain','--untracked-files=no'])) throw Error('Tracked source is dirty');
  return {source_commit:sha,run_id:e.GITHUB_RUN_ID??'local',run_attempt:e.GITHUB_RUN_ATTEMPT??'1'};
}
function main(){
  const [mode,c]=process.argv.slice(2), e=process.env;
  if(mode==='matrix') {
    const requested=e.REQUESTED_COMPONENT||'changed';
    let paths=[];
    if(requested==='changed'){
      const base=e.BASE_SHA;
      paths=/^[a-f0-9]{40}$/.test(base??'') && !/^0+$/.test(base)
        ? run('git',['diff','--name-only',base,'HEAD']).split('\n') : ['scripts/'];
    }
    const matrix=JSON.stringify({component:selectComponents(paths,requested)});
    if(e.GITHUB_OUTPUT) writeFileSync(e.GITHUB_OUTPUT,`matrix=${matrix}\nhas_changes=${JSON.parse(matrix).component.length>0}\n`,{flag:'a'});
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
  const policy=assessment?JSON.parse(readFileSync('security/staging-novu-runtime-assessment.json')):null;
  if(assessment&&(assessment.component!==c||assessment.policy_sha256!==hashFile('security/staging-novu-runtime-assessment.json'))) throw Error('Runtime assessment policy binding changed');
  assertScan(scan,assessment,policy);
  if(mode==='pack') {
    const image=JSON.parse(run('docker',['image','inspect',local]))[0];
    if(image.Os!=='linux'||image.Architecture!=='arm64'||image.Config.Labels?.['org.opencontainers.image.revision']!==source.source_commit) throw Error('Image provenance mismatch');
    if(assessment&&assessment.image_id!==image.Id) throw Error('Assessment covers a different image');
    run('docker',['save','--output',`${directory}/image.tar`,local]);
    const receipt={schema:'hid.staging-component-build/v1',...source,...config,local_tag:local,image_id:image.Id,
      architecture:'arm64',os:'linux',archive_sha256:hashFile(`${directory}/image.tar`),
      sbom_sha256:hashFile(`${directory}/sbom.spdx.json`),scan_sha256:hashFile(`${directory}/grype.json`),
      high_critical_findings:0,raw_high_matches:assessment?.raw_high_matches??0,
      assessment_sha256:assessment?hashFile(`${directory}/runtime-assessment.json`):null,
      vex_sha256:assessment?hashFile(`${directory}/runtime.vex.json`):null,
      raw_scan_sha256:hashFile(`${directory}/grype.raw.json`),deployment_authorized:false};
    writeFileSync(`${directory}/build.json`,JSON.stringify(receipt,null,2)+'\n');return;
  }
  if(mode!=='publish') throw Error('Unknown build operation');
  if(e.GITHUB_REPOSITORY!=='D-Eminence/hid-system'||e.GITHUB_REPOSITORY_ID!=='1317340803'
    ||e.GITHUB_REPOSITORY_OWNER_ID!=='182018869'||!['push','workflow_dispatch'].includes(e.GITHUB_EVENT_NAME)
    ||!['refs/heads/staging','refs/heads/staging-novu-ci-20261005'].includes(e.GITHUB_REF)) throw Error('Publication context rejected');
  const receipt=JSON.parse(readFileSync(`${directory}/build.json`));
  if(receipt.component!==c||receipt.source_commit!==source.source_commit||receipt.run_id!==source.run_id
    ||receipt.run_attempt!==source.run_attempt||receipt.archive_sha256!==hashFile(`${directory}/image.tar`)
    ||receipt.sbom_sha256!==hashFile(`${directory}/sbom.spdx.json`)||receipt.scan_sha256!==hashFile(`${directory}/grype.json`)) throw Error('Build evidence mismatch');
  if(receipt.raw_scan_sha256!==hashFile(`${directory}/grype.raw.json`)
    ||(assessment&&(receipt.assessment_sha256!==hashFile(`${directory}/runtime-assessment.json`)
      ||receipt.vex_sha256!==hashFile(`${directory}/runtime.vex.json`)))) throw Error('Assessment evidence changed in transfer');
  const aws=(...args)=>JSON.parse(run('aws',[...args,'--region','eu-west-1','--output','json','--no-cli-pager']));
  if(aws('sts','get-caller-identity').Account!=='659225405023') throw Error('Wrong AWS account');
  const repo=aws('ecr','describe-repositories','--repository-names',config.repository).repositories[0];
  if(repo.imageTagMutability!=='IMMUTABLE'||!repo.imageScanningConfiguration.scanOnPush) throw Error('Immutable scanned staging repository required');
  run('docker',['load','--input',`${directory}/image.tar`]);
  const image=JSON.parse(run('docker',['image','inspect',local]))[0];
  if(image.Id!==receipt.image_id||image.Architecture!=='arm64'||image.Config.Labels?.['org.opencontainers.image.revision']!==source.source_commit) throw Error('Loaded image mismatch');
  if(assessment){
    run('python3',['scripts/assess-staging-runtime.py',c,local,`${directory}/grype.raw.json`,`${directory}/publish-verification`],{stdio:'inherit'});
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
    published_at:new Date().toISOString(),publication:'staging ECR only; Terraform deployment is separate'},null,2)+'\n');
  console.log(`Published ${c}: ${digest}`);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main();
