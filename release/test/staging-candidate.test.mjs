import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, basename, resolve } from 'node:path'
import { parse } from 'yaml'
import { admitStagingCandidate, loadCandidatePlan, validateCandidatePlan, validateSourceProvenance } from '../scripts/admit-staging-candidate.mjs'
import { computeArtifactSetSha256 } from '../scripts/verify-release-contract.mjs'
import { writeRepository, signedEnvelope, digest } from '../../infra/cloudflare/test/helpers/tuf-repository-fixture.mjs'
import { validateTufRepositoryDirectory } from '../../infra/cloudflare/scripts/tuf-repository-layout.mjs'
import { buildBundle, GIT_SHA, ACCOUNT, REGION } from './helpers/candidate-fixture.mjs'
const plan = () => ({ schema_version:'hid.staging-candidate-approval/v1', environment:'staging', git_sha:GIT_SHA,
  release_id:`r0000000001-g${GIT_SHA}`, repository_sha256:'a'.repeat(64), trusted_root_version:1,
  trusted_root_sha256:'b'.repeat(64), artifact_set_sha256:'c'.repeat(64), aws_account_id:ACCOUNT, aws_region:REGION,
  expires_at:new Date(Date.now()+3600000).toISOString().replace(/\.\d{3}Z$/,'Z'), source_run_id:'123',source_artifact_id:'456',
  source_artifact_digest:'sha256:'+'d'.repeat(64),source_workflow_path:'.github/workflows/signed-staging-data.yml' })
const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'D-Eminence/hid-system',GITHUB_REPOSITORY_ID:'1317340803',GITHUB_REPOSITORY_OWNER_ID:'182018869',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF_PROTECTED:'true',APPROVED_REF:'refs/heads/tuf-production-release',GITHUB_REF:'refs/heads/tuf-production-release',GITHUB_SHA:GIT_SHA,APPROVED_SOURCE_SHA:GIT_SHA,GITHUB_WORKFLOW_SHA:GIT_SHA,GITHUB_WORKFLOW_REF:'D-Eminence/hid-system/.github/workflows/tuf-staging-candidate.yml@refs/heads/tuf-production-release'}
const run={id:123,status:'completed',conclusion:'success',event:'push',head_sha:GIT_SHA,head_branch:'tuf-production-release',path:plan().source_workflow_path,repository:{id:1317340803,full_name:env.GITHUB_REPOSITORY,owner:{id:182018869}},head_repository:{id:1317340803}}
const artifact={id:456,expired:false,digest:plan().source_artifact_digest,size_in_bytes:1234,workflow_run:{id:123,head_sha:GIT_SHA,head_branch:'tuf-production-release',repository_id:1317340803,head_repository_id:1317340803}}
const protection={name:'staging-candidate',protection_rules:[{type:'required_reviewers',prevent_self_review:false,reviewers:[{type:'User',reviewer:{id:182018869,login:'D-Eminence'}}]}],can_admins_bypass:false,deployment_branch_policy:{protected_branches:true,custom_branch_policies:false}}
test('requires separately approved fixed-repository exact source/artifact and owner review policy',()=>{
 assert.equal(validateSourceProvenance(plan(),env,run,artifact,protection).source_artifact_id,'456')
 for(const changed of [{GITHUB_REF_PROTECTED:'false'},{GITHUB_REPOSITORY_ID:'42'},{APPROVED_SOURCE_SHA:'f'.repeat(40)},{GITHUB_WORKFLOW_SHA:'f'.repeat(40)},{GITHUB_EVENT_NAME:'pull_request'},{APPROVED_REF:'refs/heads/production',GITHUB_REF:'refs/heads/production'},{GITHUB_WORKFLOW_REF:'D-Eminence/hid-system/.github/workflows/other.yml@refs/heads/tuf-production-release'}])assert.throws(()=>validateSourceProvenance(plan(),{...env,...changed},run,artifact,protection))
 for(const changed of [{conclusion:'failure'},{head_sha:'f'.repeat(40)},{event:'pull_request'},{path:'.github/workflows/unknown.yml'}])assert.throws(()=>validateSourceProvenance(plan(),env,{...run,...changed},artifact,protection))
 assert.throws(()=>validateSourceProvenance(plan(),env,run,{...artifact,digest:'sha256:'+'e'.repeat(64)},protection))
 assert.throws(()=>validateSourceProvenance(plan(),env,run,artifact,{...protection,can_admins_bypass:true}))
})
test('rejects production, expired approvals, malformed hashes and unknown plan keys',()=>{
 for(const changed of [{environment:'production'},{expires_at:'2020-01-01T00:00:00Z'},{trusted_root_sha256:'unknown'},{extra:'unapproved'},{source_workflow_path:'.github/workflows/tuf-staging-candidate.yml'}])assert.throws(()=>validateCandidatePlan({...plan(),...changed}))
})
function refs(value, result=[]){if(value&&typeof value==='object'){if(value.path&&value.sha256&&value.media_type)result.push(value);Object.values(value).forEach(v=>refs(v,result))}return result}
async function fixture(){
 const f=await writeRepository('staging'),bundle=buildBundle('staging',1),bytesByPath=new Map()
 for(const frontend of bundle.frontends){
  const files=['index.html','manifest.webmanifest','service-worker.js'].map(path=>({path,length:2,sha256:digest('ok'),mode:420}))
  bytesByPath.set(frontend.content_manifest.path,Buffer.from(JSON.stringify({schema_version:'1.0.0',app:frontend.app,git_sha:GIT_SHA,archive_profile:'hid-frontend-ustar-v1',file_count:3,total_size_bytes:6,files})))
  frontend.archive.file_count=3;frontend.archive.uncompressed_size_bytes=6
 }
 for(const ref of refs(bundle)){const bytes=bytesByPath.get(ref.path)??Buffer.from('Synthetic release evidence only\n');bytesByPath.set(ref.path,bytes);ref.length=bytes.length;ref.sha256=digest(bytes)}
 bundle.release.artifact_set_sha256=computeArtifactSetSha256(bundle)
 bytesByPath.set(`environments/staging/releases/${bundle.release.id}/release-bundle.json`,Buffer.from(JSON.stringify(bundle)))
 for(const [logical,bytes] of bytesByPath){const d=digest(bytes),file=resolve(f.repository,'targets',dirname(logical),d+'.'+basename(logical));await mkdir(dirname(file),{recursive:true});await writeFile(file,bytes);f.signed.targets.targets[logical]={length:bytes.length,hashes:{sha256:d}}}
 const targets=signedEnvelope(f.signed.targets,f.signers.targets.slice(0,2));f.signed.snapshot.meta['targets.json']={version:1,length:targets.length,hashes:{sha256:digest(targets)}}
 const snapshot=signedEnvelope(f.signed.snapshot,f.signers.snapshot.slice(0,1));f.signed.timestamp.meta['snapshot.json']={version:1,length:snapshot.length,hashes:{sha256:digest(snapshot)}}
 await writeFile(resolve(f.repository,'metadata/1.targets.json'),targets);await writeFile(resolve(f.repository,'metadata/1.snapshot.json'),snapshot);await writeFile(resolve(f.repository,'metadata/timestamp.json'),signedEnvelope(f.signed.timestamp,f.signers.timestamp.slice(0,1)))
 const validated=await validateTufRepositoryDirectory(f.repository,'staging')
 return { ...f,plan:{...plan(),repository_sha256:validated.repositorySha256,trusted_root_sha256:digest(f.metadata.root),artifact_set_sha256:bundle.release.artifact_set_sha256} }
}
test('admits independently signed synthetic staging data and rejects wrong root/repository/artifact pins without output',async()=>{
 const f=await fixture(),out=f.repository+'-accepted',approval=f.repository+'-approval.json'
 try{
  const bytes=Buffer.from(JSON.stringify(f.plan));await writeFile(approval,bytes)
  assert.deepEqual(await loadCandidatePlan(approval,digest(bytes)),f.plan)
  await assert.rejects(loadCandidatePlan(approval,'f'.repeat(64)),/approval digest/)
  for(const key of ['trusted_root_sha256','repository_sha256','artifact_set_sha256'])await assert.rejects(admitStagingCandidate({...f.plan,[key]:'f'.repeat(64)},f.repository,out))
  const admitted=await admitStagingCandidate(f.plan,f.repository,out)
  assert.equal(admitted.status,'candidate-data-admitted');assert.equal(admitted.deployment_authorized,false)
  assert.equal((await validateTufRepositoryDirectory(resolve(out,'repository'),'staging')).repositorySha256,f.plan.repository_sha256)
  await assert.rejects(admitStagingCandidate(f.plan,f.repository,out),/exist/)
  const timestampPath=resolve(f.repository,'metadata/timestamp.json')
  const unsigned=JSON.parse(await readFile(timestampPath,'utf8'));unsigned.signatures[0].sig='00'.repeat(64)
  await writeFile(timestampPath,JSON.stringify(unsigned))
  await assert.rejects(admitStagingCandidate(f.plan,f.repository,out+'-tampered'),/signature|threshold/)

 }finally{await Promise.all([rm(f.repository,{recursive:true,force:true}),rm(out,{recursive:true,force:true}),rm(approval,{force:true})])}
})
test('workflow has no cloud authority, checks pins before checkout and uses immutable action revisions',async()=>{
 const source=await readFile(new URL('../../.github/workflows/tuf-staging-candidate.yml',import.meta.url),'utf8'),workflow=parse(source)
 assert.deepEqual(workflow.permissions,{contents:'read',actions:'read'});assert.equal(workflow.jobs.admit.environment,'staging-candidate')
 assert.doesNotMatch(source,/id-token:|secrets\.|configure-aws-credentials|wrangler|tuf-publish\.yml/)
 const steps=workflow.jobs.admit.steps;assert.match(steps[0].run,/GITHUB_WORKFLOW_SHA/)
 for(const step of steps.filter(s=>s.uses))assert.match(step.uses,/@[a-f0-9]{40}$/)
 assert.ok(steps.findIndex(s=>s.name?.includes('provenance'))<steps.findIndex(s=>s.uses?.startsWith('actions/download-artifact')))
})
