#!/usr/bin/env node
// Preserve owner-approved evidence bytes. Archival is not evidence generation or acceptance.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { open, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import duplicateKeyJson from 'json-dup-key-validator'
import { verifyPromotionEvidence } from './verify-release-contract.mjs'

const ACCOUNT = '659225405023', REGION = 'eu-west-1', REPOSITORY = 'D-Eminence/hid-system'
const REF = 'refs/heads/tuf-production-release', ENVIRONMENT = 'staging-evidence-writer'
const WORKFLOW = '.github/workflows/tuf-evidence.yml'
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/, ID = /^[1-9][0-9]{0,19}$/
const MAXIMUM = 1048576
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const check = (value, message = 'staging evidence input rejected') => assert.ok(value, message)
const exact = (object, keys) => check(object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).sort().join() === [...keys].sort().join())
const stagingPath = value => typeof value === 'string' && /^\.github\/workflows\/[a-z0-9-]*staging[a-z0-9-]*\.yml$/.test(value)
  && !value.includes('production')

export function validateStagingEvidenceConfig(bytes, digest, context, now = new Date()) {
  check(typeof bytes === 'string' && Buffer.byteLength(bytes) <= 16384 && DIGEST.test(digest ?? '') && hash(bytes) === digest)
  const c = duplicateKeyJson.parse(bytes, false)
  exact(c, ['schema_version', 'environment', 'source_sha', 'workflow_sha', 'caller_workflow_path', 'aws_account_id', 'aws_region',
    'writer_role_arn', 'archive', 'release_id', 'artifact_set_sha256', 'expires_at', 'producer'])
  check(c.schema_version === 'hid.staging-release-evidence-config/v1' && c.environment === 'staging'
    && c.aws_account_id === ACCOUNT && c.aws_region === REGION && SHA.test(c.source_sha) && SHA.test(c.workflow_sha)
    && stagingPath(c.caller_workflow_path))
  check(/^arn:aws:iam::659225405023:role\/[A-Za-z0-9+=,.@_/-]*staging[A-Za-z0-9+=,.@_/-]*$/.test(c.writer_role_arn)
    && !/production/i.test(c.writer_role_arn))
  exact(c.archive, ['bucket', 'kms_key_arn'])
  check(/^(?=.{3,63}$)[a-z0-9][a-z0-9-]*staging[a-z0-9-]*[a-z0-9]$/.test(c.archive.bucket)
    && !c.archive.bucket.includes('production')
    && /^arn:aws:kms:eu-west-1:659225405023:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(c.archive.kms_key_arn))
  check(/^r[0-9]{10}-g[a-f0-9]{40}$/.test(c.release_id) && c.release_id.endsWith(`-g${c.source_sha}`) && DIGEST.test(c.artifact_set_sha256))
  check(typeof c.expires_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(c.expires_at)
    && Number.isFinite(Date.parse(c.expires_at)) && new Date(c.expires_at).toISOString().replace('.000Z', 'Z') === c.expires_at
    && Date.parse(c.expires_at) > now.getTime(), 'staging evidence approval expired')
  exact(c.producer, ['run_id', 'artifact_id', 'artifact_name', 'artifact_digest', 'workflow_path', 'evidence_sha256', 'evidence_size_bytes'])
  check(typeof c.producer.run_id === 'string' && ID.test(c.producer.run_id)
    && typeof c.producer.artifact_id === 'string' && ID.test(c.producer.artifact_id)
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(c.producer.artifact_name)
    && /^sha256:[a-f0-9]{64}$/.test(c.producer.artifact_digest) && stagingPath(c.producer.workflow_path)
    && DIGEST.test(c.producer.evidence_sha256) && Number.isSafeInteger(c.producer.evidence_size_bytes)
    && c.producer.evidence_size_bytes > 0 && c.producer.evidence_size_bytes <= MAXIMUM)
  if (context) {
    const expected = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_REPOSITORY_ID: '1317340803',
      GITHUB_REPOSITORY_OWNER_ID: '182018869', GITHUB_REF: REF, GITHUB_REF_TYPE: 'branch', GITHUB_REF_PROTECTED: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_RUN_ATTEMPT: '1', APPROVED_SOURCE_SHA: c.source_sha,
      GITHUB_SHA: c.source_sha, GITHUB_WORKFLOW_SHA: c.source_sha, REQUESTED_SOURCE_SHA: c.source_sha,
      APPROVED_WORKFLOW_SHA: c.workflow_sha, EVIDENCE_WRITER_ROLE_ARN: c.writer_role_arn,
      GITHUB_WORKFLOW_REF: `${REPOSITORY}/${c.caller_workflow_path}@${REF}` }
    check(Object.entries(expected).every(([key, value]) => context[key] === value), 'staging evidence source or role rejected')
    check(['push', 'workflow_dispatch'].includes(context.GITHUB_EVENT_NAME) && !context.GITHUB_HEAD_REF && !context.GITHUB_BASE_REF)
    check(ID.test(context.GITHUB_RUN_ID ?? '') && ID.test(context.GITHUB_ACTOR_ID ?? '') && context.GITHUB_RUN_ID !== c.producer.run_id)
  }
  return c
}

export function verifyStagingEvidencePolicy(policy) {
  check(policy?.name === ENVIRONMENT && Number.isSafeInteger(policy.id) && policy.id > 0
    && policy.can_admins_bypass === false && policy.deployment_branch_policy?.protected_branches === true
    && policy.deployment_branch_policy?.custom_branch_policies === false, 'staging evidence owner policy rejected')
  const rules = policy.protection_rules?.filter(rule => rule.type === 'required_reviewers')
  check(rules?.length === 1 && rules[0].prevent_self_review === false && rules[0].reviewers?.length === 1)
  const owner = rules[0].reviewers[0]
  check(owner.type === 'User' && owner.reviewer?.id === 182018869 && owner.reviewer?.login === 'D-Eminence')
}

export function verifyStagingEvidenceClaims(claims, context, now = Date.now()) {
  const expected = { iss: 'https://token.actions.githubusercontent.com', aud: 'sts.amazonaws.com', repository: REPOSITORY,
    repository_id: '1317340803', repository_owner_id: '182018869', ref: REF, ref_type: 'branch', environment: ENVIRONMENT,
    sub: `repo:${REPOSITORY}:environment:${ENVIRONMENT}`, sha: context.APPROVED_SOURCE_SHA,
    job_workflow_ref: `${REPOSITORY}/${WORKFLOW}@${context.APPROVED_WORKFLOW_SHA}`, job_workflow_sha: context.APPROVED_WORKFLOW_SHA,
    runner_environment: 'github-hosted', run_id: context.GITHUB_RUN_ID, run_attempt: '1', actor_id: context.GITHUB_ACTOR_ID,
    event_name: context.GITHUB_EVENT_NAME, workflow_ref: context.GITHUB_WORKFLOW_REF }
  check(Object.entries(expected).every(([key, value]) => value && claims?.[key] === value), 'staging evidence workload claims rejected')
  check(Number.isSafeInteger(claims.iat) && Number.isSafeInteger(claims.exp) && claims.iat <= now / 1000 + 60
    && claims.exp > now / 1000 && claims.exp - claims.iat > 0 && claims.exp - claims.iat <= 600)
  // A precheck, not JWT signature verification. AWS STS verifies its independently obtained token.
}

export function verifyStagingEvidenceProducer(c, run, artifact) {
  check(String(run.id) === c.producer.run_id && run.status === 'completed' && run.conclusion === 'success' && run.run_attempt === 1
    && ['push', 'workflow_dispatch'].includes(run.event) && run.head_sha === c.source_sha && run.head_branch === REF.slice(11)
    && run.path === c.producer.workflow_path && run.repository?.full_name === REPOSITORY
    && String(run.repository?.id) === '1317340803' && String(run.head_repository?.id) === '1317340803'
    && String(run.repository?.owner?.id) === '182018869', 'staging evidence producer rejected')
  check(String(artifact.id) === c.producer.artifact_id && artifact.name === c.producer.artifact_name && artifact.expired === false
    && artifact.digest === c.producer.artifact_digest && Number.isSafeInteger(artifact.size_in_bytes)
    && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 2 * MAXIMUM
    && String(artifact.workflow_run?.id) === c.producer.run_id && artifact.workflow_run?.head_sha === c.source_sha
    && artifact.workflow_run?.head_branch === run.head_branch && String(artifact.workflow_run?.repository_id) === '1317340803'
    && String(artifact.workflow_run?.head_repository_id) === '1317340803', 'staging evidence artifact rejected')
}

export function validateStagingEvidenceBytes(c, bytes, now = new Date()) {
  check(Buffer.isBuffer(bytes) && bytes.length === c.producer.evidence_size_bytes && bytes.length <= MAXIMUM
    && hash(bytes) === c.producer.evidence_sha256, 'staging evidence bytes rejected')
  const evidence = duplicateKeyJson.parse(bytes.toString('utf8'), false)
  verifyPromotionEvidence(evidence, { environment: 'staging', subjectReleaseId: c.release_id, artifactSetSha256: c.artifact_set_sha256,
    admissionTime: now.toISOString().replace(/\.\d{3}Z$/, 'Z') })
  return evidence
}

export async function loadStagingEvidenceBytes(c, directory) {
  check(resolve(directory) === await realpath(directory), 'staging evidence directory rejected')
  const entries = await readdir(directory, { withFileTypes: true })
  check(entries.length === 1 && entries[0].name === 'evidence.json' && entries[0].isFile(), 'staging evidence artifact contents rejected')
  const handle = await open(resolve(directory, 'evidence.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat(); check(stat.isFile() && stat.size === c.producer.evidence_size_bytes && stat.size <= MAXIMUM)
    // Read at most the approved size plus one sentinel byte, even if the file grows.
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    check(length === stat.size, 'staging evidence changed while reading')
    const bytes = buffer.subarray(0, length); validateStagingEvidenceBytes(c, bytes); return bytes
  } finally { await handle.close() }
}

export async function preflightStagingEvidence(c, context, get = fetch) {
  const read = async (url, token) => {
    const response = await get(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error', signal: AbortSignal.timeout(30000) })
    check(response.ok); const bytes = await response.text(); check(Buffer.byteLength(bytes) <= MAXIMUM)
    return duplicateKeyJson.parse(bytes, false)
  }
  check(typeof context.GH_EVIDENCE_READ_TOKEN === 'string' && context.GH_EVIDENCE_READ_TOKEN.length > 0)
  const base = `https://api.github.com/repos/${REPOSITORY}`
  const [policy, run, artifact] = await Promise.all([
    read(`${base}/environments/${ENVIRONMENT}`, context.GH_EVIDENCE_READ_TOKEN),
    read(`${base}/actions/runs/${c.producer.run_id}`, context.GH_EVIDENCE_READ_TOKEN),
    read(`${base}/actions/artifacts/${c.producer.artifact_id}`, context.GH_EVIDENCE_READ_TOKEN),
  ])
  verifyStagingEvidencePolicy(policy); verifyStagingEvidenceProducer(c, run, artifact)
  const url = new URL(context.ACTIONS_ID_TOKEN_REQUEST_URL)
  check(url.protocol === 'https:' && url.hostname.endsWith('.actions.githubusercontent.com') && !url.username && !url.password && !url.hash)
  url.searchParams.set('audience', 'sts.amazonaws.com')
  const response = await read(url, context.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
  check(typeof response.value === 'string' && response.value.split('.').length === 3)
  verifyStagingEvidenceClaims(duplicateKeyJson.parse(Buffer.from(response.value.split('.')[1], 'base64url').toString(), false), context)
}

export async function appendStagingEvidence(c, bytes, invokeAws, now = new Date()) {
  // Validate configuration and payload again at the mutation boundary, even for injected transports.
  const encoded = JSON.stringify(c); validateStagingEvidenceConfig(encoded, hash(encoded), undefined, now)
  const evidence = validateStagingEvidenceBytes(c, bytes, now)
  const call = (service, operation, args = [], body) => invokeAws([service, operation, ...args, '--region', REGION, '--output', 'json', '--no-cli-pager'], body)
  const identity = await call('sts', 'get-caller-identity')
  const roleName = c.writer_role_arn.split('/').at(-1)
  check(identity.Account === ACCOUNT && typeof identity.Arn === 'string'
    && identity.Arn.startsWith(`arn:aws:sts::${ACCOUNT}:assumed-role/${roleName}/`), 'staging evidence assumed role rejected')
  const bucketArgs = ['--bucket', c.archive.bucket, '--expected-bucket-owner', ACCOUNT]
  const versioning = await call('s3api', 'get-bucket-versioning', bucketArgs)
  check(versioning.Status === 'Enabled', 'staging evidence versioning rejected')
  const lock = await call('s3api', 'get-object-lock-configuration', bucketArgs)
  const retention = lock.ObjectLockConfiguration?.Rule?.DefaultRetention
  check(lock.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled' && retention?.Mode === 'COMPLIANCE'
    && retention.Days === 90 && retention.Years === undefined, 'staging evidence default retention rejected')
  const key = `release-evidence/staging/${c.release_id}/${evidence.evidence_type}/${c.producer.artifact_id}-${c.producer.evidence_sha256}.json`
  const checksum = Buffer.from(c.producer.evidence_sha256, 'hex').toString('base64')
  // Single PutObject, no multipart/decrypt permission. Do not set retention headers:
  // the current writer has no PutObjectRetention and must inherit the verified bucket default.
  const result = await call('s3api', 'put-object', [...bucketArgs, '--key', key, '--if-none-match', '*',
    '--server-side-encryption', 'aws:kms', '--ssekms-key-id', c.archive.kms_key_arn, '--no-bucket-key-enabled',
    '--checksum-algorithm', 'SHA256', '--checksum-sha256', checksum, '--content-length', String(bytes.length),
    '--content-type', 'application/vnd.hid.promotion-evidence+json'], bytes)
  check(typeof result.VersionId === 'string' && /^[A-Za-z0-9+/_.=-]{1,1024}$/.test(result.VersionId) && result.VersionId !== 'null'
    && result.ServerSideEncryption === 'aws:kms' && result.SSEKMSKeyId === c.archive.kms_key_arn
    && result.BucketKeyEnabled === false && result.ChecksumSHA256 === checksum, 'staging evidence write response incomplete; reconcile without overwriting')
  return { schema_version: 'hid.staging-release-evidence-append/v1', recorded_at: now.toISOString(), environment: 'staging',
    source_sha: c.source_sha, workflow_sha: c.workflow_sha, release_id: c.release_id, artifact_set_sha256: c.artifact_set_sha256,
    aws_account_id: ACCOUNT, aws_region: REGION, writer_role_arn: c.writer_role_arn, producer: c.producer,
    evidence_type: evidence.evidence_type, archive: { bucket: c.archive.bucket, key, version_id: result.VersionId,
      sha256: c.producer.evidence_sha256, size_bytes: bytes.length, kms_key_arn: c.archive.kms_key_arn, bucket_key_enabled: false },
    result: 'approved-evidence-bytes-appended', retention: { source: 'bucket-default-observed-before-put', mode: 'COMPLIANCE', days: 90,
      per_object_retention_verified: false }, deployment_authorized: false, production: 'LOCKED',
    unverified: ['per-object-retention-readback', 'independent-evidence-truth', 'release-admission', 'live-staging-acceptance'] }
}

async function main() {
  const context = process.env, [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['preflight', 'validate', 'append'].includes(mode))
  check(resolve(context.RUNNER_TEMP) === await realpath(context.RUNNER_TEMP))
  const c = validateStagingEvidenceConfig(await readFile(resolve(context.RUNNER_TEMP, 'staging-evidence-config.json'), 'utf8'), context.EVIDENCE_CONFIG_SHA256, context)
  check(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === c.workflow_sha)
  if (mode === 'preflight') { await preflightStagingEvidence(c, context); return }
  const bytes = await loadStagingEvidenceBytes(c, resolve(context.RUNNER_TEMP, 'staging-evidence-input'))
  if (mode === 'validate') { process.stdout.write('Approved staging evidence payload bytes and existing release contract verified.\n'); return }
  // Recheck the immutable producer and owner gate immediately before AWS writes.
  await preflightStagingEvidence(c, context)
  const bodyPath = resolve(context.RUNNER_TEMP, 'staging-evidence-sealed.json')
  await writeFile(bodyPath, bytes, { flag: 'wx', mode: 0o400 })
  const invokeAws = (args, body) => {
    check(!body || Buffer.compare(body, bytes) === 0)
    const output = execFileSync('aws', [...args, ...(body ? ['--body', bodyPath] : [])], { encoding: 'utf8', timeout: 30000,
      maxBuffer: 262144, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, AWS_MAX_ATTEMPTS: '1', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' } })
    return duplicateKeyJson.parse(output, false)
  }
  const result = await appendStagingEvidence(c, bytes, invokeAws)
  result.configuration_sha256 = context.EVIDENCE_CONFIG_SHA256
  result.writer_run_id = context.GITHUB_RUN_ID
  await writeFile(resolve(context.RUNNER_TEMP, 'staging-evidence-append-receipt.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write('Approved staging evidence bytes archived; this does not establish staging acceptance or authorize deployment.\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Staging evidence writer rejected or upload unconfirmed. Do not overwrite; reconcile any attempted write by object/version using the auditor. No credentials or provider response details are logged.\n'); process.exitCode = 1 })
}
