import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const components = ['identity-api','ehr-api','lab-api','pharmacy-api','ocr-api','ocr-worker',
  'outreach-api','notification-api','notification-worker','event-dispatcher','gateway','support-api','database-migration'];
const registry = '659225405023.dkr.ecr.eu-west-1.amazonaws.com';
const run = (command,args,options={}) => execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','inherit'],...options}).trim();
export function selectComponents(paths, requested='changed') {
  if(requested==='all') return components;
  if(requested!=='changed') { if(!components.includes(requested)) throw Error('Unknown backend component'); return [requested]; }
  const result=new Set();
  for(const p of paths){
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
export function assertScan(report) {
  if(!Array.isArray(report.matches) || !report.descriptor?.version) throw Error('Complete Grype report required');
  if(report.matches.some(m=>['High','Critical'].includes(m.vulnerability?.severity))) throw Error('High/Critical vulnerabilities block publication');
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
  const scan=JSON.parse(readFileSync(`${directory}/grype.json`));assertScan(scan);
  if(mode==='pack') {
    const image=JSON.parse(run('docker',['image','inspect',local]))[0];
    if(image.Os!=='linux'||image.Architecture!=='arm64'||image.Config.Labels?.['org.opencontainers.image.revision']!==source.source_commit) throw Error('Image provenance mismatch');
    run('docker',['save','--output',`${directory}/image.tar`,local]);
    const receipt={schema:'hid.staging-component-build/v1',...source,...config,local_tag:local,image_id:image.Id,
      architecture:'arm64',os:'linux',archive_sha256:hashFile(`${directory}/image.tar`),
      sbom_sha256:hashFile(`${directory}/sbom.spdx.json`),scan_sha256:hashFile(`${directory}/grype.json`),
      high_critical_findings:0,deployment_authorized:false};
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
  const aws=(...args)=>JSON.parse(run('aws',[...args,'--region','eu-west-1','--output','json','--no-cli-pager']));
  if(aws('sts','get-caller-identity').Account!=='659225405023') throw Error('Wrong AWS account');
  const repo=aws('ecr','describe-repositories','--repository-names',config.repository).repositories[0];
  if(repo.imageTagMutability!=='IMMUTABLE'||!repo.imageScanningConfiguration.scanOnPush) throw Error('Immutable scanned staging repository required');
  run('docker',['load','--input',`${directory}/image.tar`]);
  const image=JSON.parse(run('docker',['image','inspect',local]))[0];
  if(image.Id!==receipt.image_id||image.Architecture!=='arm64'||image.Config.Labels?.['org.opencontainers.image.revision']!==source.source_commit) throw Error('Loaded image mismatch');
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
