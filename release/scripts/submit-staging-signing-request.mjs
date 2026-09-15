#!/usr/bin/env node
// Adapter to the existing immutable S3 request / qualified Lambda broker contract.
// No key creation, direct KMS signing, deployment, retry, or production path.
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { open, writeFile, readdir, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import duplicateKeyJson from 'json-dup-key-validator'
import { canonicalizeTuf, validatePublicRootFile } from '../../infra/cloudflare/scripts/tuf-repository-layout.mjs'

const ACCOUNT = '659225405023', REGION = 'eu-west-1', REPOSITORY = 'D-Eminence/hid-system'
const REF = 'refs/heads/tuf-production-release', STATE = 'hid-staging-broker-v1'
const HEX = /^[a-f0-9]{64}$/, SHA = /^[a-f0-9]{40}$/, ID = /^[1-9][0-9]{0,19}$/
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const ok = (condition, message = 'staging signer input rejected') => assert.ok(condition, message)
const exact = (value, keys) => ok(value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()))
const positive = value => Number.isSafeInteger(value) && value > 0
const utc = value => new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z')
const parse = bytes => duplicateKeyJson.parse(bytes.toString(), false)
const metadataTime = value => {
  ok(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value))
  const parsed = Date.parse(value)
  ok(Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19), 'signing metadata timestamp rejected')
  return parsed
}
const label = c => `${c.role}-signer-${c.candidate}`
const prefix = c => `tuf-signing-broker/requests/${STATE}/${c.role}-${c.candidate}/`

export function signerConfig(bytes, expectedHash, e) {
  ok(typeof bytes === 'string' && Buffer.byteLength(bytes) < 16384 && HEX.test(expectedHash ?? '') && hash(bytes) === expectedHash)
  const c = parse(bytes)
  exact(c, ['schema_version', 'environment', 'role', 'candidate', 'source_sha', 'workflow_sha', 'caller_workflow_path', 'aws_account_id', 'aws_region',
    'submitter_role_arn', 'broker_version_arn', 'candidate_spki_sha256', 'request_bucket', 'storage_kms_key_arn', 'release_id', 'root_version', 'root_sha256',
    'input_version', 'input_sha256', 'request_lifetime_seconds', 'producer'])
  ok(c.schema_version === 'hid.staging-signing-submission/v1' && c.environment === 'staging' && ['snapshot', 'timestamp'].includes(c.role)
    && ['one', 'two'].includes(c.candidate) && c.aws_account_id === ACCOUNT && c.aws_region === REGION
    && SHA.test(c.source_sha) && SHA.test(c.workflow_sha))
  ok(/^\.github\/workflows\/[a-z0-9-]*staging[a-z0-9-]*\.yml$/.test(c.caller_workflow_path) && !c.caller_workflow_path.includes('production'))
  ok(/^arn:aws:iam::659225405023:role\/[A-Za-z0-9+=,.@_/-]*staging[A-Za-z0-9+=,.@_/-]+$/.test(c.submitter_role_arn)
    && !/production/i.test(c.submitter_role_arn))
  const roleLabel = `${c.role[0].toUpperCase()}${c.role.slice(1)}Signer${c.candidate[0].toUpperCase()}${c.candidate.slice(1)}Role`
  ok(c.submitter_role_arn.split('/').at(-1).includes(roleLabel), 'signing role/candidate scope rejected')
  ok(new RegExp(`^arn:aws:lambda:${REGION}:${ACCOUNT}:function:hid-staging-tuf-broker-${c.role}-${c.candidate}:[1-9][0-9]*$`).test(c.broker_version_arn))
  ok(HEX.test(c.candidate_spki_sha256))
  ok(/^(?=.{3,63}$)[a-z0-9][a-z0-9-]*staging[a-z0-9-]*[a-z0-9]$/.test(c.request_bucket) && !c.request_bucket.includes('production'))
  ok(/^arn:aws:kms:eu-west-1:659225405023:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(c.storage_kms_key_arn))
  ok(new RegExp(`^r[0-9]{10}-g${c.source_sha}$`).test(c.release_id) && positive(c.root_version) && positive(c.input_version)
    && HEX.test(c.root_sha256) && HEX.test(c.input_sha256))
  const minimum = c.role === 'snapshot' ? 72 * 3600 : 6 * 3600, maximum = c.role === 'snapshot' ? 7 * 86400 : 86400
  ok(Number.isSafeInteger(c.request_lifetime_seconds) && c.request_lifetime_seconds >= minimum + 3600 && c.request_lifetime_seconds <= maximum)
  exact(c.producer, ['run_id', 'artifact_id', 'artifact_digest', 'workflow_path'])
  ok(ID.test(c.producer.run_id) && ID.test(c.producer.artifact_id) && /^sha256:[a-f0-9]{64}$/.test(c.producer.artifact_digest)
    && /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(c.producer.workflow_path)
    && c.producer.workflow_path !== `.github/workflows/tuf-${label(c)}.yml`)
  if (e) {
    const expected = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_REPOSITORY_ID: '1317340803', GITHUB_REPOSITORY_OWNER_ID: '182018869',
      GITHUB_REF: REF, GITHUB_REF_TYPE: 'branch', GITHUB_REF_PROTECTED: 'true', GITHUB_RUN_ATTEMPT: '1', RUNNER_ENVIRONMENT: 'github-hosted',
      GITHUB_SHA: c.source_sha, GITHUB_WORKFLOW_SHA: c.source_sha, APPROVED_SOURCE_SHA: c.source_sha, REQUESTED_SOURCE_SHA: c.source_sha,
      APPROVED_WORKFLOW_SHA: c.workflow_sha, SUBMITTER_ROLE_ARN: c.submitter_role_arn, HID_SIGNING_ROLE: c.role, HID_SIGNING_CANDIDATE: c.candidate,
      GITHUB_WORKFLOW_REF: `${REPOSITORY}/${c.caller_workflow_path}@${REF}` }
    ok(Object.entries(expected).every(([k, v]) => e[k] === v), 'staging signer source or capability rejected')
    ok(['push', 'workflow_dispatch'].includes(e.GITHUB_EVENT_NAME) && !e.GITHUB_HEAD_REF && !e.GITHUB_BASE_REF
      && ID.test(e.GITHUB_RUN_ID ?? '') && ID.test(e.GITHUB_ACTOR_ID ?? ''))
  }
  return c
}

export function signerProvenance(c, run, artifact) {
  ok(String(run?.id) === c.producer.run_id && run.status === 'completed' && run.conclusion === 'success' && run.run_attempt === 1
    && ['push', 'workflow_dispatch'].includes(run.event) && run.head_sha === c.source_sha && run.head_branch === REF.slice(11)
    && run.path === c.producer.workflow_path && String(run.repository?.id) === '1317340803'
    && String(run.head_repository?.id) === '1317340803' && run.repository?.full_name === REPOSITORY
    && String(run.repository?.owner?.id) === '182018869', 'signing input producer rejected')
  ok(String(artifact?.id) === c.producer.artifact_id && artifact.expired === false && positive(artifact.size_in_bytes)
    && artifact.size_in_bytes <= 8 * 1024 * 1024 && artifact.digest === c.producer.artifact_digest
    && String(artifact.workflow_run?.id) === c.producer.run_id && artifact.workflow_run?.head_sha === c.source_sha
    && artifact.workflow_run?.head_branch === run.head_branch && String(artifact.workflow_run?.repository_id) === '1317340803'
    && String(artifact.workflow_run?.head_repository_id) === '1317340803', 'signing input artifact rejected')
}

export function signerPolicy(c, policy) {
  ok(policy?.name === `staging-${label(c)}` && positive(policy.id) && policy.can_admins_bypass === false
    && policy.deployment_branch_policy?.protected_branches === true && policy.deployment_branch_policy?.custom_branch_policies === false)
  const rules = policy.protection_rules?.filter(p => p.type === 'required_reviewers'), owner = rules?.[0]?.reviewers?.[0]
  ok(rules?.length === 1 && rules[0].prevent_self_review === false && rules[0].reviewers?.length === 1
    && owner?.type === 'User' && owner.reviewer?.id === 182018869 && owner.reviewer?.login === 'D-Eminence', 'signing owner policy rejected')
}

export function signerClaims(c, e, claims, now = Date.now()) {
  const expected = { iss: 'https://token.actions.githubusercontent.com', aud: 'sts.amazonaws.com', repository: REPOSITORY,
    repository_id: '1317340803', repository_owner_id: '182018869', ref: REF, ref_type: 'branch', environment: `staging-${label(c)}`,
    sub: `repo:${REPOSITORY}:environment:staging-${label(c)}`, sha: c.source_sha, job_workflow_sha: c.workflow_sha,
    job_workflow_ref: `${REPOSITORY}/.github/workflows/tuf-${label(c)}.yml@${c.workflow_sha}`, workflow_ref: e.GITHUB_WORKFLOW_REF,
    runner_environment: 'github-hosted', run_id: e.GITHUB_RUN_ID, run_attempt: '1', actor_id: e.GITHUB_ACTOR_ID, event_name: e.GITHUB_EVENT_NAME }
  ok(Object.entries(expected).every(([k, v]) => v && claims?.[k] === v), 'signing immutable workload identity rejected')
  ok(Number.isSafeInteger(claims.iat) && Number.isSafeInteger(claims.exp) && claims.iat <= now / 1000 + 60
    && claims.exp > now / 1000 && claims.exp - claims.iat > 0 && claims.exp - claims.iat <= 600)
  // Claim precheck only; AWS STS verifies the independently obtained action token signature and trust.
}

async function file(path, maximum) {
  ok(path === await realpath(path))
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    ok(stat.isFile() && stat.size > 0 && stat.size <= maximum)
    const buffer = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
      if (!bytesRead) break
      offset += bytesRead
    }
    ok(offset === stat.size, 'signing file changed while reading')
    return buffer.subarray(0, offset)
  } finally { await handle.close() }
}

export async function prepareSignerRequest(c, directory, now = Date.now()) {
  const inputRole = c.role === 'snapshot' ? 'targets' : 'snapshot'
  const names = [`${c.root_version}.root.json`, `${c.input_version}.${inputRole}.json`]
  ok(directory === await realpath(directory) && JSON.stringify((await readdir(directory)).sort()) === JSON.stringify([...names].sort()), 'signing input closure rejected')
  const rootPath = resolve(directory, names[0]), root = await file(rootPath, 512000)
  const input = await file(resolve(directory, names[1]), c.role === 'snapshot' ? 5000000 : 2000000)
  ok(hash(root) === c.root_sha256 && hash(input) === c.input_sha256, 'signing input byte pin rejected')
  const rootCheck = await validatePublicRootFile(rootPath, { now: new Date(now) })
  ok(rootCheck.sha256 === c.root_sha256 && rootCheck.version === c.root_version
    && rootCheck.keys.some(key => key.role === c.role && key.spki_sha256 === c.candidate_spki_sha256), 'paired candidate public pin rejected')
  const authority = parse(root).signed, metadata = parse(input)
  exact(metadata, ['signed', 'signatures'])
  const fields = ['_type', 'spec_version', 'version', 'expires', inputRole === 'targets' ? 'targets' : 'meta']
  exact(metadata.signed, fields)
  ok(metadata.signed._type === inputRole && metadata.signed.spec_version === '1.0.31' && metadata.signed.version === c.input_version
    && Array.isArray(metadata.signatures) && metadata.signatures.length >= 1 && metadata.signatures.length <= 20)
  const remaining = metadataTime(metadata.signed.expires) - now
  ok(Number.isFinite(remaining) && remaining >= (inputRole === 'targets' ? 14 * 86400000 : 72 * 3600000)
    && remaining <= (inputRole === 'targets' ? 90 * 86400000 : 7 * 86400000), 'signing input freshness rejected')
  const ids = new Set(), accepted = new Set(), role = authority.roles[inputRole]
  const payload = Buffer.from(canonicalizeTuf(metadata.signed))
  for (const s of metadata.signatures) {
    exact(s, ['keyid', 'sig']); ok(HEX.test(s.keyid) && /^(?:[a-f0-9]{2}){1,256}$/.test(s.sig) && !ids.has(s.keyid))
    ids.add(s.keyid)
    if (role.keyids.includes(s.keyid)) {
      const key = createPublicKey(authority.keys[s.keyid].keyval.public)
      if (verify('sha256', payload, key, Buffer.from(s.sig, 'hex'))) accepted.add(s.keyid)
    }
  }
  ok(accepted.size >= role.threshold, 'signing input signature threshold rejected')
  // Field order matches signingbroker.Request's Go JSON encoding exactly. All
  // strings here are governed ASCII/base64; no HTML or Unicode escaping differs.
  const request = { schema_version: '1.0.0', environment: 'staging', repository_id: 'hid-staging-v1', role: c.role, release_id: c.release_id,
    created_at: utc(now), expires: utc(now + c.request_lifetime_seconds * 1000), root_version: c.root_version, root_sha256: c.root_sha256,
    root: root.toString('base64'), input_metadata_version: c.input_version, input_metadata_sha256: c.input_sha256, input_metadata: input.toString('base64') }
  const bytes = Buffer.from(JSON.stringify(request)); ok(bytes.length <= 8 * 1024 * 1024)
  return bytes
}

export function validatePreparedRequest(c, bytes, now = Date.now()) {
  ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 8 * 1024 * 1024)
  const r = parse(bytes)
  exact(r, ['schema_version', 'environment', 'repository_id', 'role', 'release_id', 'created_at', 'expires', 'root_version', 'root_sha256', 'root',
    'input_metadata_version', 'input_metadata_sha256', 'input_metadata'])
  const expected = { schema_version: '1.0.0', environment: 'staging', repository_id: 'hid-staging-v1', role: c.role, release_id: c.release_id,
    root_version: c.root_version, root_sha256: c.root_sha256, input_metadata_version: c.input_version, input_metadata_sha256: c.input_sha256 }
  ok(Object.entries(expected).every(([k, v]) => r[k] === v))
  for (const [field, pin] of [['root', c.root_sha256], ['input_metadata', c.input_sha256]]) {
    ok(typeof r[field] === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r[field])
      && hash(Buffer.from(r[field], 'base64')) === pin)
  }
  const created = Date.parse(r.created_at), expires = Date.parse(r.expires)
  ok(Number.isFinite(created) && Number.isFinite(expires) && utc(created) === r.created_at && utc(expires) === r.expires
    && created >= now - 300000 && created <= now + 60000 && expires - created === c.request_lifetime_seconds * 1000
    && expires - now >= (c.role === 'snapshot' ? 72 * 3600000 : 6 * 3600000) + 1800000, 'signing request clock rejected')
  const canonical = Object.fromEntries(['schema_version', 'environment', 'repository_id', 'role', 'release_id', 'created_at', 'expires', 'root_version', 'root_sha256', 'root',
    'input_metadata_version', 'input_metadata_sha256', 'input_metadata'].map(k => [k, r[k]]))
  ok(Buffer.from(JSON.stringify(canonical)).equals(bytes), 'signing request canonical bytes rejected')
  return r
}

export async function submitSignerRequest(c, bytes, transport, now = Date.now()) {
  const r = validatePreparedRequest(c, bytes, now), sha = hash(bytes)
  const identity = await transport.identity()
  ok(identity.Account === ACCOUNT && typeof identity.Arn === 'string'
    && identity.Arn.startsWith(`arn:aws:sts::${ACCOUNT}:assumed-role/${c.submitter_role_arn.split('/').at(-1)}/`), 'signing assumed role rejected')
  const key = `${prefix(c)}${sha}.json`, checksum = Buffer.from(sha, 'hex').toString('base64')
  const stored = await transport.put({ Bucket: c.request_bucket, Key: key, Body: bytes, ExpectedBucketOwner: ACCOUNT, IfNoneMatch: '*',
    ContentType: 'application/json', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: c.storage_kms_key_arn, BucketKeyEnabled: false,
    ChecksumSHA256: checksum, Metadata: { 'hid-schema': 'hid.tuf.signing-broker.request/v1', 'hid-state-id': STATE,
      'hid-role': c.role, 'hid-candidate': c.candidate, 'hid-sha256': sha } })
  // No explicit retention header: existing submitter IAM has only PutObject.
  // The existing 90-day COMPLIANCE bucket default applies; the broker checks
  // exact version retention, checksum, owner, encryption and metadata itself.
  ok(typeof stored.VersionId === 'string' && /^[A-Za-z0-9._~+/-]{1,1024}$/.test(stored.VersionId) && stored.VersionId !== 'null'
    && stored.ChecksumSHA256 === checksum && stored.ServerSideEncryption === 'aws:kms'
    && stored.SSEKMSKeyId === c.storage_kms_key_arn && stored.BucketKeyEnabled !== true, 'immutable signing upload response rejected; do not retry')
  const object = { bucket: c.request_bucket, key, version_id: stored.VersionId, sha256: sha }
  const invocation = { schema_version: 'hid.tuf.signing-broker.invoke/v1', ...object }
  const response = await transport.invoke({ FunctionName: c.broker_version_arn, InvocationType: 'RequestResponse', LogType: 'None', Payload: Buffer.from(JSON.stringify(invocation)) })
  ok(response.StatusCode === 200 && !response.FunctionError && response.ExecutedVersion === c.broker_version_arn.split(':').at(-1), 'signing invocation ambiguous or rejected; do not retry')
  const result = parse(response.Payload)
  exact(result, ['schema_version', 'environment', 'repository_id', 'state_id', 'role', 'candidate_id', 'release_id', 'request_sha256', 'request_object',
    'root_version', 'root_sha256', 'input_metadata_version', 'input_metadata_sha256', 'output_version', 'output_sha256', 'output', 'state_revision', 'idempotent_replay'])
  const expected = { schema_version: '1.0.0', environment: 'staging', repository_id: 'hid-staging-v1', state_id: STATE, role: c.role, candidate_id: c.candidate,
    release_id: c.release_id, request_sha256: sha, root_version: c.root_version, root_sha256: c.root_sha256,
    input_metadata_version: c.input_version, input_metadata_sha256: c.input_sha256 }
  ok(Object.entries(expected).every(([k, v]) => result[k] === v)
    && JSON.stringify(result.request_object) === JSON.stringify(object) && positive(result.output_version) && positive(result.state_revision)
    && typeof result.idempotent_replay === 'boolean' && typeof result.output === 'string' && HEX.test(result.output_sha256)
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.output)
    && hash(Buffer.from(result.output, 'base64')) === result.output_sha256, 'signing broker result binding rejected; do not retry')
  const outputBytes = Buffer.from(result.output, 'base64'), output = parse(outputBytes), authority = parse(Buffer.from(r.root, 'base64')).signed
  ok(outputBytes.length > 0 && outputBytes.length <= (c.role === 'snapshot' ? 2000000 : 64000))
  exact(output, ['signed', 'signatures']); exact(output.signed, ['_type', 'spec_version', 'version', 'expires', 'meta'])
  ok(output.signed._type === c.role && output.signed.spec_version === '1.0.31' && output.signed.version === result.output_version
    && output.signed.expires === r.expires && metadataTime(output.signed.expires) > now
    && Array.isArray(output.signatures) && output.signatures.length === 1, 'signed output metadata rejected')
  const inputName = c.role === 'snapshot' ? 'targets.json' : 'snapshot.json'
  exact(output.signed.meta, [inputName]); const inputRef = output.signed.meta[inputName]
  exact(inputRef, ['version', 'length', 'hashes']); exact(inputRef.hashes, ['sha256'])
  ok(inputRef.version === c.input_version && inputRef.length === Buffer.from(r.input_metadata, 'base64').length && inputRef.hashes.sha256 === c.input_sha256)
  const signature = output.signatures[0]; exact(signature, ['keyid', 'sig'])
  ok(HEX.test(signature.keyid) && /^(?:[a-f0-9]{2}){1,256}$/.test(signature.sig) && authority.roles[c.role].keyids.includes(signature.keyid))
  const publicKey = createPublicKey(authority.keys[signature.keyid].keyval.public)
  ok(hash(publicKey.export({ type: 'spki', format: 'der' })) === c.candidate_spki_sha256
    && verify('sha256', Buffer.from(canonicalizeTuf(output.signed)), publicKey, Buffer.from(signature.sig, 'hex')), 'paired broker output signature rejected')
  return { schema_version: 'hid.staging-signing-submission-result/v1', recorded_at: utc(now), environment: 'staging', source_sha: c.source_sha,
    workflow_sha: c.workflow_sha, role: c.role, candidate: c.candidate, request_object: object, broker_version_arn: c.broker_version_arn,
    broker_result: result, retention_validation: 'existing broker validates exact immutable object; replay follows its retained-decision policy',
    publication_authorized: false, deployment_authorized: false, production: 'LOCKED', automatic_retry_permitted: false }
}

export async function reserveSigningAttempt(directory, c, bytes) {
  ok(directory === await realpath(directory))
  validatePreparedRequest(c, bytes)
  const marker = { status: 'STARTED_RECONCILE_BEFORE_RETRY', request_sha256: hash(bytes), request_bucket: c.request_bucket,
    request_key: `${prefix(c)}${hash(bytes)}.json`, broker_version_arn: c.broker_version_arn }
  await writeFile(resolve(directory, 'staging-signing-attempt.json'), JSON.stringify(marker), { flag: 'wx', mode: 0o600 })
  return marker
}

async function main() {
  const e = process.env, [mode] = process.argv.slice(2)
  ok(process.argv.length === 3 && ['provenance', 'prepare', 'submit'].includes(mode) && resolve(e.RUNNER_TEMP) === await realpath(e.RUNNER_TEMP))
  const c = signerConfig((await file(resolve(e.RUNNER_TEMP, 'staging-signer-config.json'), 16384)).toString(), e.SIGNER_CONFIG_SHA256, e)
  ok(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === c.workflow_sha)
  const read = async (url, token) => {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, redirect: 'error', signal: AbortSignal.timeout(30000) })
    ok(response.ok); const bytes = await response.text(); ok(Buffer.byteLength(bytes) <= 262144); return parse(bytes)
  }
  if (mode === 'provenance') {
    const base = `https://api.github.com/repos/${REPOSITORY}`
    signerPolicy(c, await read(`${base}/environments/staging-${label(c)}`, e.GH_SIGNER_READ_TOKEN))
    signerProvenance(c, await read(`${base}/actions/runs/${c.producer.run_id}`, e.GH_SIGNER_READ_TOKEN), await read(`${base}/actions/artifacts/${c.producer.artifact_id}`, e.GH_SIGNER_READ_TOKEN))
    const url = new URL(e.ACTIONS_ID_TOKEN_REQUEST_URL)
    ok(url.protocol === 'https:' && url.hostname.endsWith('.actions.githubusercontent.com') && !url.username && !url.password && !url.hash)
    url.searchParams.set('audience', 'sts.amazonaws.com')
    const response = await read(url, e.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    ok(typeof response.value === 'string' && response.value.split('.').length === 3)
    signerClaims(c, e, parse(Buffer.from(response.value.split('.')[1], 'base64url')))
  } else if (mode === 'prepare') {
    const bytes = await prepareSignerRequest(c, resolve(e.RUNNER_TEMP, 'staging-signing-input'))
    await writeFile(resolve(e.RUNNER_TEMP, 'staging-broker-request.json'), bytes, { flag: 'wx', mode: 0o600 })
  } else {
    const bytes = await file(resolve(e.RUNNER_TEMP, 'staging-broker-request.json'), 8 * 1024 * 1024)
    validatePreparedRequest(c, bytes)
    // Reserve this runner attempt before any cloud operation. An interrupted
    // upload/invocation must be reconciled, never transparently resubmitted.
    await reserveSigningAttempt(e.RUNNER_TEMP, c, bytes)
    const aws = args => parse(execFileSync('aws', [...args, '--region', REGION, '--output', 'json', '--no-cli-pager'], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 45000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...e, AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' } }))
    const transport = {
      identity: () => aws(['sts', 'get-caller-identity']),
      put: input => aws(['s3api', 'put-object', '--bucket', input.Bucket, '--key', input.Key, '--body', resolve(e.RUNNER_TEMP, 'staging-broker-request.json'),
        '--expected-bucket-owner', ACCOUNT, '--if-none-match', '*', '--content-type', 'application/json', '--server-side-encryption', 'aws:kms',
        '--ssekms-key-id', input.SSEKMSKeyId, '--no-bucket-key-enabled', '--checksum-sha256', input.ChecksumSHA256, '--metadata', JSON.stringify(input.Metadata)]),
      invoke: async input => {
        const envelope = resolve(e.RUNNER_TEMP, 'staging-signing-invocation.json'), output = resolve(e.RUNNER_TEMP, 'staging-broker-response.json')
        await writeFile(envelope, input.Payload, { flag: 'wx', mode: 0o600 })
        const response = aws(['lambda', 'invoke', '--function-name', input.FunctionName, '--invocation-type', 'RequestResponse', '--log-type', 'None',
          '--payload', `fileb://${envelope}`, output])
        return { ...response, Payload: await file(output, 2 * 1024 * 1024) }
      },
    }
    const result = await submitSignerRequest(c, bytes, transport)
    result.configuration_sha256 = e.SIGNER_CONFIG_SHA256
    await writeFile(resolve(e.RUNNER_TEMP, 'staging-signing-result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
  process.stdout.write(`Staging signing ${mode} completed; publication and deployment remain unauthorized.\n`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  process.stderr.write('Staging signing request rejected or ambiguous. Do not retry a started submission without reconciliation.\n'); process.exitCode = 1
})
