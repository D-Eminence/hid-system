#!/usr/bin/env node
// Data-only admission. No signing keys, candidate execution, cloud credentials or publication.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import duplicateKeyJson from 'json-dup-key-validator'
import { validateTufRepositoryDirectory } from '../../infra/cloudflare/scripts/tuf-repository-layout.mjs'
import { admitReleaseBundle, collectTargetReferences, loadConfiguration, verifyFrontendContentManifest } from './verify-release-contract.mjs'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sha256 = /^[a-f0-9]{64}$/, gitSha = /^[a-f0-9]{40}$/, id = /^[1-9][0-9]{0,19}$/
function check(value, message) { assert.ok(value, `Staging candidate rejected: ${message}`) }
async function regular(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat(); check(stat.isFile() && stat.size > 0 && stat.size <= maximum, 'file size/type')
    const bytes = await file.readFile(); check(bytes.length === stat.size, 'file changed while reading'); return bytes
  } finally { await file.close() }
}
export function validateCandidatePlan(plan, now = new Date()) {
  const keys = ['schema_version','environment','git_sha','release_id','repository_sha256','trusted_root_version','trusted_root_sha256','artifact_set_sha256','aws_account_id','aws_region','expires_at','source_run_id','source_artifact_id','source_artifact_digest','source_workflow_path']
  check(plan && Object.keys(plan).sort().join() === keys.sort().join(), 'approval plan shape')
  check(plan.schema_version === 'hid.staging-candidate-approval/v1' && plan.environment === 'staging', 'staging-only plan')
  check(gitSha.test(plan.git_sha) && /^r[0-9]{10}-g[a-f0-9]{40}$/.test(plan.release_id) && plan.release_id.endsWith(`-g${plan.git_sha}`), 'source/release binding')
  for (const key of ['repository_sha256','trusted_root_sha256','artifact_set_sha256']) check(sha256.test(plan[key]), key)
  check(Number.isSafeInteger(plan.trusted_root_version) && plan.trusted_root_version > 0, 'trusted root version')
  check(/^[0-9]{12}$/.test(plan.aws_account_id) && /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/.test(plan.aws_region), 'AWS staging identity')
  check(typeof plan.expires_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(plan.expires_at)
    && Number.isFinite(Date.parse(plan.expires_at))
    && new Date(plan.expires_at).toISOString().replace('.000Z', 'Z') === plan.expires_at
    && Date.parse(plan.expires_at) > now.getTime(), 'expired approval')
  check(typeof plan.source_run_id === 'string' && typeof plan.source_artifact_id === 'string'
    && id.test(plan.source_run_id) && id.test(plan.source_artifact_id) && /^sha256:[a-f0-9]{64}$/.test(plan.source_artifact_digest), 'immutable source artifact pins')
  check(/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(plan.source_workflow_path)
    && plan.source_workflow_path !== '.github/workflows/tuf-staging-candidate.yml', 'approved independent producer path')
  return plan
}
export async function loadCandidatePlan(path, expectedHash, now = new Date()) {
  check(sha256.test(expectedHash), 'independent approval digest required')
  const bytes = await regular(resolve(path), 16384)
  check(hash(bytes) === expectedHash, 'approval digest mismatch')
  return validateCandidatePlan(duplicateKeyJson.parse(bytes.toString('utf8'), false), now)
}
export function validateSourceProvenance(plan, env, run, artifact, protection) {
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'D-Eminence/hid-system'
    && env.GITHUB_REPOSITORY_ID === '1317340803' && env.GITHUB_REPOSITORY_OWNER_ID === '182018869', 'fixed repository/owner')
  check(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF_PROTECTED === 'true'
    && env.APPROVED_REF === 'refs/heads/tuf-production-release' && env.GITHUB_REF === env.APPROVED_REF
    && env.GITHUB_SHA === plan.git_sha && env.APPROVED_SOURCE_SHA === plan.git_sha
    && env.GITHUB_WORKFLOW_SHA === plan.git_sha
    && env.GITHUB_WORKFLOW_REF === 'D-Eminence/hid-system/.github/workflows/tuf-staging-candidate.yml@refs/heads/tuf-production-release', 'protected exact source and workflow')
  check(String(run.id) === plan.source_run_id && run.status === 'completed' && run.conclusion === 'success'
    && ['push','workflow_dispatch'].includes(run.event) && run.head_sha === plan.git_sha
    && run.head_branch === env.APPROVED_REF.slice(11) && run.path === plan.source_workflow_path
    && String(run.repository?.id) === '1317340803' && String(run.head_repository?.id) === '1317340803'
    && String(run.repository?.owner?.id) === '182018869' && run.repository?.full_name === env.GITHUB_REPOSITORY, 'producer provenance')
  check(String(artifact.id) === plan.source_artifact_id && artifact.expired === false
    && artifact.digest === plan.source_artifact_digest && Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0
    && String(artifact.workflow_run?.id) === plan.source_run_id && artifact.workflow_run?.head_sha === plan.git_sha
    && artifact.workflow_run?.head_branch === run.head_branch && String(artifact.workflow_run?.repository_id) === '1317340803'
    && String(artifact.workflow_run?.head_repository_id) === '1317340803', 'artifact provenance')
  const rules = protection.protection_rules?.filter(rule => rule.type === 'required_reviewers')
  check(protection.name === 'staging-candidate' && rules?.length === 1 && rules[0].prevent_self_review === false
    && rules[0].reviewers?.length === 1 && rules[0].reviewers[0].type === 'User'
    && rules[0].reviewers[0].reviewer?.id === 182018869 && rules[0].reviewers[0].reviewer?.login === 'D-Eminence'
    && protection.can_admins_bypass === false && protection.deployment_branch_policy?.protected_branches === true
    && protection.deployment_branch_policy?.custom_branch_policies === false, 'sole-owner environment review policy')
  return { source_run_id: plan.source_run_id, source_artifact_id: plan.source_artifact_id, source_artifact_digest: artifact.digest,
    source_workflow_path: run.path, git_sha: plan.git_sha, approval_source: 'GitHub staging-candidate environment runtime gate' }
}
export async function verifySource(plan, env = process.env, get = fetch) {
  const read = async suffix => {
    const response = await get(`https://api.github.com/repos/D-Eminence/hid-system/${suffix}`, {
      headers: { Authorization: `Bearer ${env.GH_READ_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error', signal: AbortSignal.timeout(30000),
    }); check(response.ok, 'GitHub read failed')
    const bytes = await response.text(); check(Buffer.byteLength(bytes) <= 1048576, 'GitHub response size')
    return duplicateKeyJson.parse(bytes, false)
  }
  const [run, artifact, environment] = await Promise.all([read(`actions/runs/${plan.source_run_id}`), read(`actions/artifacts/${plan.source_artifact_id}`), read('environments/staging-candidate')])
  return validateSourceProvenance(plan, env, run, artifact, environment)
}
function physical(logical, digest) { return `targets/${dirname(logical)}/${digest}.${basename(logical)}` }
export async function admitStagingCandidate(plan, repositoryPath, outputPath, now = new Date()) {
  validateCandidatePlan(plan, now)
  check(isAbsolute(repositoryPath) && await realpath(repositoryPath) === repositoryPath, 'canonical input directory')
  const validated = await validateTufRepositoryDirectory(repositoryPath, 'staging', { now })
  check(validated.repositorySha256 === plan.repository_sha256, 'repository digest mismatch')
  const files = new Map(validated.files.map(file => [file.path, file]))
  check(files.get(`metadata/${plan.trusted_root_version}.root.json`)?.sha256 === plan.trusted_root_sha256, 'independently trusted root mismatch')
  const targets = duplicateKeyJson.parse((await regular(resolve(repositoryPath, `metadata/${validated.targetsVersion}.targets.json`), 5000000)).toString('utf8'), false).signed.targets
  const logicalBundle = `environments/staging/releases/${plan.release_id}/release-bundle.json`
  const bundleReference = targets[logicalBundle]; check(bundleReference, 'release absent from current signed targets')
  async function targetJson(logical, reference, maximum) {
    const bytes = await regular(resolve(repositoryPath, physical(logical, reference.hashes.sha256)), maximum)
    check(bytes.length === reference.length && hash(bytes) === reference.hashes.sha256, 'target changed after signature validation')
    return duplicateKeyJson.parse(bytes.toString('utf8'), false)
  }
  const bundle = await targetJson(logicalBundle, bundleReference, 16777216)
  const configuration = await loadConfiguration()
  admitReleaseBundle(bundle, configuration, { environment: 'staging', awsAccountId: plan.aws_account_id, awsRegion: plan.aws_region,
    releaseId: plan.release_id, gitSha: plan.git_sha, admissionTime: now.toISOString().replace(/\.\d{3}Z$/, 'Z') })
  check(bundle.release.artifact_set_sha256 === plan.artifact_set_sha256, 'artifact set mismatch')
  for (const target of collectTargetReferences(bundle)) {
    const signed = targets[target.path]
    check(signed?.length === target.length && signed?.hashes.sha256 === target.sha256, 'release target absent or mismatched in current signed targets')
  }
  for (const frontend of bundle.frontends) {
    const ref = frontend.content_manifest
    const manifest = await targetJson(ref.path, { length: ref.length, hashes: { sha256: ref.sha256 } }, 16777216)
    verifyFrontendContentManifest(manifest, configuration)
    check(manifest.app === frontend.app && manifest.git_sha === plan.git_sha
      && manifest.file_count === frontend.archive.file_count && manifest.total_size_bytes === frontend.archive.uncompressed_size_bytes, 'frontend manifest source identity and archive summary')
  }
  const output = resolve(outputPath); check(output !== repositoryPath && !output.startsWith(repositoryPath+'/'), 'output overlaps input')
  // Exclusive creation avoids replacing any earlier accepted candidate.
  await mkdir(output, { mode: 0o700 })
  await mkdir(resolve(output, 'repository'), { mode: 0o700 })
  for (const file of validated.files) {
    const bytes = await regular(resolve(repositoryPath, file.path), 25*1024*1024)
    check(bytes.length === file.length && hash(bytes) === file.sha256, 'source changed after verification')
    const destination = resolve(output, 'repository', file.path)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o444 })
  }
  const sealed = await validateTufRepositoryDirectory(resolve(output, 'repository'), 'staging', { now })
  check(sealed.repositorySha256 === plan.repository_sha256, 'copied repository changed')
  const evidence = { schema_version: 'hid.staging-candidate-admission/v1', status: 'candidate-data-admitted', environment: 'staging',
    git_sha: plan.git_sha, release_id: plan.release_id, repository_sha256: sealed.repositorySha256,
    trusted_root_sha256: plan.trusted_root_sha256, artifact_set_sha256: plan.artifact_set_sha256, file_count: sealed.fileCount,
    admitted_at: now.toISOString(), deployment_authorized: false,
    remaining_gates: ['publisher owner approval and source-artifact provenance', 'journal and signer capability/custody checks', 'live staging acceptance'] }
  await writeFile(resolve(output, 'admission.json'), JSON.stringify(evidence,null,2)+'\n', { flag: 'wx', mode: 0o444 })
  return evidence
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const [mode, planPath, expectedHash, first, second] = process.argv.slice(2)
    check((mode === 'provenance' && process.argv.length === 6) || (mode === 'admit' && process.argv.length === 7), 'usage: provenance PLAN SHA OUTPUT | admit PLAN SHA REPOSITORY OUTPUT')
    const plan = await loadCandidatePlan(planPath, expectedHash)
    if (mode === 'provenance') await writeFile(first, JSON.stringify(await verifySource(plan),null,2)+'\n', { flag: 'wx', mode: 0o444 })
    else process.stdout.write(JSON.stringify(await admitStagingCandidate(plan, first, second))+'\n')
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode=1 }
}
