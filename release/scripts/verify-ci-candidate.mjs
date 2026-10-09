#!/usr/bin/env node
// Executes only from the independently approved tooling checkout. Never runs
// candidate source, persists credentials, or makes a cloud mutation.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import duplicateKeyJson from 'json-dup-key-validator'

const id = value => /^[1-9][0-9]{0,19}$/.test(String(value))
const sha = value => /^[a-f0-9]{40}$/.test(value)
const digest = value => /^[a-f0-9]{64}$/.test(value)
const reject = () => { throw Error('candidate CI provenance rejected before cloud authority') }

export function verifyCandidateIdentity(plan, context, run, artifact) {
  if (!['staging', 'production'].includes(plan.environment) || !sha(context.GITHUB_SHA) || plan.git_sha !== context.GITHUB_SHA
    || !id(plan.candidate_run_id) || !id(plan.candidate_artifact_id) || !digest(plan.repository_sha256)
    || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(context.APPROVED_REF)
    || context.GITHUB_REF !== context.APPROVED_REF || context.GITHUB_REF_PROTECTED !== 'true'
    || !/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(context.APPROVED_CANDIDATE_WORKFLOW_PATH)) reject()
  if (String(run.id) !== String(plan.candidate_run_id) || run.status !== 'completed' || run.conclusion !== 'success'
    || !['push', 'workflow_dispatch'].includes(run.event) || run.head_sha !== context.GITHUB_SHA
    || run.head_branch !== context.APPROVED_REF.slice('refs/heads/'.length)
    || run.path !== context.APPROVED_CANDIDATE_WORKFLOW_PATH || !id(run.run_attempt)
    || String(run.repository?.id) !== context.APPROVED_REPOSITORY_ID
    || String(run.head_repository?.id) !== context.APPROVED_REPOSITORY_ID
    || String(run.repository?.owner?.id) !== context.APPROVED_OWNER_ID
    || run.repository?.full_name !== context.GITHUB_REPOSITORY) reject()
  if (String(artifact.id) !== String(plan.candidate_artifact_id) || artifact.expired !== false
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1
    || !/^[A-Za-z0-9._-]{1,160}$/.test(artifact.name)
    || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
    || String(artifact.workflow_run?.id) !== String(run.id)
    || artifact.workflow_run?.head_sha !== context.GITHUB_SHA
    || artifact.workflow_run?.head_branch !== run.head_branch
    || String(artifact.workflow_run?.repository_id) !== context.APPROVED_REPOSITORY_ID
    || String(artifact.workflow_run?.head_repository_id) !== context.APPROVED_REPOSITORY_ID) reject()
  return {
    run_id: String(run.id), run_attempt: String(run.run_attempt), workflow_path: run.path, event: run.event,
    head_sha: run.head_sha, protected_ref: context.APPROVED_REF, conclusion: run.conclusion,
    artifact: { id: String(artifact.id), name: artifact.name, size_in_bytes: artifact.size_in_bytes, github_archive_digest: artifact.digest },
  }
}

export function approvalIdentities(reviews, environment) {
  assert.ok(Array.isArray(reviews), 'invalid review history')
  // Review comments and arbitrary user profile fields are intentionally omitted.
  return reviews.filter(item => item.state === 'approved' && item.environments?.some(value => value.name === `${environment}-publisher`))
    .map(item => {
      if (!id(item.user?.id)) reject()
      return { state: 'approved', actor_id: String(item.user.id), environment: `${environment}-publisher` }
    })
}

export async function verifyCiCandidate(e = process.env, get = fetch) {
  if (e.GITHUB_ACTIONS !== 'true' || e.HID_TUF_IDENTITY_VERIFIED !== 'true') reject()
  const plan = duplicateKeyJson.parse(await readFile(resolve(e.RUNNER_TEMP, 'hid-publication-plan.json'), 'utf8'), false)
  if (!id(plan.candidate_run_id) || !id(plan.candidate_artifact_id) || !id(e.GITHUB_RUN_ID)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(e.GITHUB_REPOSITORY)) reject()
  const read = async path => {
    const response = await get(`https://api.github.com/repos/${e.GITHUB_REPOSITORY}/${path}`, {
      headers: { Authorization: `Bearer ${e.GH_EVIDENCE_READ_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error', signal: AbortSignal.timeout(30000),
    })
    if (!response.ok) reject()
    const bytes = await response.text()
    if (Buffer.byteLength(bytes) > 1048576) reject()
    return duplicateKeyJson.parse(bytes, false)
  }
  const run = await read(`actions/runs/${plan.candidate_run_id}`)
  const artifact = await read(`actions/artifacts/${plan.candidate_artifact_id}`)
  const candidate = verifyCandidateIdentity(plan, e, run, artifact)
  const approvals = approvalIdentities(await read(`actions/runs/${e.GITHUB_RUN_ID}/approvals`), plan.environment)
  if (approvals.length === 0) reject()
  const { validateTufRepositoryDirectory } = await import('../../infra/cloudflare/scripts/tuf-repository-layout.mjs')
  const repository = await validateTufRepositoryDirectory(resolve(e.RUNNER_TEMP, 'hid-candidate/repository'), plan.environment)
  if (repository.repositorySha256 !== plan.repository_sha256) reject()
  const evidence = {
    schema_version: 'hid.tuf.ci-publication-inputs/v1', recorded_at: new Date().toISOString(),
    repository: e.GITHUB_REPOSITORY, repository_id: e.APPROVED_REPOSITORY_ID, owner_id: e.APPROVED_OWNER_ID,
    publication_run_id: e.GITHUB_RUN_ID, publication_run_attempt: e.GITHUB_RUN_ATTEMPT,
    source_sha: e.GITHUB_SHA, environment: plan.environment, candidate, approvals,
    approval_attempt_binding: 'GitHub review-history API does not expose run-attempt binding; retain deployment review audit evidence',
    repository_sha256: repository.repositorySha256,
    tuf_versions: { root: repository.rootVersion, targets: repository.targetsVersion, snapshot: repository.snapshotVersion, timestamp: repository.timestampVersion },
    files: repository.files,
  }
  await writeFile(resolve(e.RUNNER_TEMP, 'hid-publication-inputs.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return evidence
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyCiCandidate().catch(() => { process.stderr.write('candidate CI provenance rejected before cloud authority\n'); process.exitCode = 1 })
}
