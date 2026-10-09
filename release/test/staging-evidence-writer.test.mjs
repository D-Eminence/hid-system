import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { appendStagingEvidence, loadStagingEvidenceBytes, preflightStagingEvidence, validateStagingEvidenceBytes,
  validateStagingEvidenceConfig, verifyStagingEvidenceClaims, verifyStagingEvidencePolicy, verifyStagingEvidenceProducer } from '../scripts/append-staging-release-evidence.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const now = new Date('2026-09-15T03:00:00Z')
const payload = () => ({ schema_version: '1.0.0', evidence_type: 'migration-dry-run', environment: 'staging',
  subject_release_id: `r0000000001-g${'a'.repeat(40)}`, artifact_set_sha256: 'c'.repeat(64), status: 'passed',
  started_at: '2026-09-14T15:00:00Z', completed_at: '2026-09-14T16:00:00Z', executor: 'synthetic-local-test',
  checks: ['migration-ledger-verified', 'dry-run-completed', 'schema-postconditions'].map(name => ({ name, status: 'passed' })) })
const bytes = () => Buffer.from(JSON.stringify(payload()) + '\n')
const config = () => ({ schema_version: 'hid.staging-release-evidence-config/v1', environment: 'staging', source_sha: 'a'.repeat(40),
  workflow_sha: 'b'.repeat(40), caller_workflow_path: '.github/workflows/staging-evidence-caller.yml', aws_account_id: '659225405023',
  aws_region: 'eu-west-1', writer_role_arn: 'arn:aws:iam::659225405023:role/Hid-staging-ReleaseTrust-EvidenceWriterRole',
  archive: { bucket: 'hid-staging-evidence-fixture', kms_key_arn: 'arn:aws:kms:eu-west-1:659225405023:key/00000000-0000-4000-8000-000000000001' },
  release_id: payload().subject_release_id, artifact_set_sha256: payload().artifact_set_sha256, expires_at: '2026-09-16T00:00:00Z',
  producer: { run_id: '111', artifact_id: '222', artifact_name: 'staging-evidence-input', artifact_digest: `sha256:${'d'.repeat(64)}`,
    workflow_path: '.github/workflows/staging-acceptance-producer.yml', evidence_sha256: digest(bytes()), evidence_size_bytes: bytes().length } })
const context = () => ({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'D-Eminence/hid-system', GITHUB_REPOSITORY_ID: '1317340803',
  GITHUB_REPOSITORY_OWNER_ID: '182018869', GITHUB_REF: 'refs/heads/tuf-production-release', GITHUB_REF_TYPE: 'branch', GITHUB_REF_PROTECTED: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '333', GITHUB_RUN_ATTEMPT: '1', GITHUB_ACTOR_ID: '182018869', RUNNER_ENVIRONMENT: 'github-hosted',
  APPROVED_SOURCE_SHA: config().source_sha, REQUESTED_SOURCE_SHA: config().source_sha, GITHUB_SHA: config().source_sha,
  APPROVED_WORKFLOW_SHA: config().workflow_sha, GITHUB_WORKFLOW_SHA: config().source_sha, EVIDENCE_WRITER_ROLE_ARN: config().writer_role_arn,
  GITHUB_WORKFLOW_REF: 'D-Eminence/hid-system/.github/workflows/staging-evidence-caller.yml@refs/heads/tuf-production-release' })
const policy = () => ({ name: 'staging-evidence-writer', id: 123, can_admins_bypass: false,
  deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }, protection_rules: [{ type: 'required_reviewers',
    prevent_self_review: false, reviewers: [{ type: 'User', reviewer: { id: 182018869, login: 'D-Eminence' } }] }] })
const claims = (time = now.getTime()) => ({ iss: 'https://token.actions.githubusercontent.com', aud: 'sts.amazonaws.com', repository: context().GITHUB_REPOSITORY,
  repository_id: '1317340803', repository_owner_id: '182018869', ref: context().GITHUB_REF, ref_type: 'branch', environment: 'staging-evidence-writer',
  sub: 'repo:D-Eminence/hid-system:environment:staging-evidence-writer', sha: config().source_sha,
  job_workflow_ref: `D-Eminence/hid-system/.github/workflows/tuf-evidence.yml@${config().workflow_sha}`, job_workflow_sha: config().workflow_sha,
  workflow_ref: context().GITHUB_WORKFLOW_REF, runner_environment: 'github-hosted', run_id: '333', run_attempt: '1', actor_id: '182018869',
  event_name: 'workflow_dispatch', iat: Math.floor(time / 1000) - 10, exp: Math.floor(time / 1000) + 290 })
const run = () => ({ id: 111, status: 'completed', conclusion: 'success', run_attempt: 1, event: 'workflow_dispatch', head_sha: config().source_sha,
  head_branch: 'tuf-production-release', path: config().producer.workflow_path, repository: { full_name: context().GITHUB_REPOSITORY, id: 1317340803,
    owner: { id: 182018869 } }, head_repository: { id: 1317340803 } })
const artifact = () => ({ id: 222, name: config().producer.artifact_name, digest: config().producer.artifact_digest, size_in_bytes: 1200, expired: false,
  workflow_run: { id: 111, head_sha: config().source_sha, head_branch: 'tuf-production-release', repository_id: 1317340803, head_repository_id: 1317340803 } })

test('configuration binds exact independent workflow/source pins and fixed staging resources', () => {
  const c = config(), encoded = JSON.stringify(c)
  assert.deepEqual(validateStagingEvidenceConfig(encoded, digest(encoded), context(), now), c)
  for (const edit of [c => { c.environment = 'production' }, c => { c.aws_account_id = '000000000000' }, c => { c.aws_region = 'us-east-1' },
    c => { c.source_sha = null }, c => { c.workflow_sha = null }, c => { c.prefix = 'tuf-signing-broker/' },
    c => { c.writer_role_arn += '-production' }, c => { c.archive.bucket += '-production' }, c => { c.archive.kms_key_arn = c.archive.kms_key_arn.replace('eu-west-1', 'us-east-1') },
    c => { c.caller_workflow_path = '.github/workflows/staging-production.yml' }, c => { c.producer.workflow_path = '.github/workflows/tuf-evidence.yml' },
    c => { c.release_id = c.release_id.replace('a', 'b') }, c => { c.expires_at = now.toISOString().replace('.000Z', 'Z') },
    c => { c.producer.run_id = 111 }, c => { c.producer.artifact_id = '../222' }, c => { c.producer.evidence_size_bytes = 1048577 }]) {
    const v = config(); edit(v); const raw = JSON.stringify(v)
    assert.throws(() => validateStagingEvidenceConfig(raw, digest(raw), context(), now))
  }
  for (const changed of [{ GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_RUN_ID: '111' },
    { GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_REF_PROTECTED: 'false' }, { EVIDENCE_WRITER_ROLE_ARN: config().writer_role_arn + '-Other' },
    { GITHUB_WORKFLOW_REF: context().GITHUB_WORKFLOW_REF.replace('staging-evidence-caller', 'staging-other-caller') }]) {
    assert.throws(() => validateStagingEvidenceConfig(encoded, digest(encoded), { ...context(), ...changed }, now))
  }
  assert.throws(() => validateStagingEvidenceConfig(encoded, 'f'.repeat(64), context(), now))
  const duplicate = encoded.replace('"environment":"staging"', '"environment":"staging","environment":"staging"')
  assert.throws(() => validateStagingEvidenceConfig(duplicate, digest(duplicate), context(), now))
})

test('owner-only environment and immutable OIDC claims reject substitutions and expiry', () => {
  verifyStagingEvidencePolicy(policy()); verifyStagingEvidenceClaims(claims(), context(), now.getTime())
  for (const edit of [p => { p.can_admins_bypass = true }, p => { p.name = 'production-evidence-writer' },
    p => { p.protection_rules[0].reviewers[0].reviewer.id = 1 }, p => { p.deployment_branch_policy.protected_branches = false }]) {
    const p = policy(); edit(p); assert.throws(() => verifyStagingEvidencePolicy(p))
  }
  for (const [key, value] of Object.entries(claims())) {
    if (['iat', 'exp'].includes(key)) continue
    assert.throws(() => verifyStagingEvidenceClaims({ ...claims(), [key]: `${value}-wrong` }, context(), now.getTime()), key)
  }
  assert.throws(() => verifyStagingEvidenceClaims({ ...claims(), exp: now.getTime() / 1000 }, context(), now.getTime()))
})

test('completed same-source producer and immutable artifact identity are mandatory', () => {
  verifyStagingEvidenceProducer(config(), run(), artifact())
  for (const edit of [r => { r.status = 'in_progress' }, r => { r.conclusion = 'failure' }, r => { r.run_attempt = 2 },
    r => { r.event = 'pull_request' }, r => { r.head_sha = 'f'.repeat(40) }, r => { r.path = '.github/workflows/staging-other.yml' },
    r => { r.head_repository.id = 1 }, r => { r.repository.owner.id = 1 }]) {
    const r = run(); edit(r); assert.throws(() => verifyStagingEvidenceProducer(config(), r, artifact()))
  }
  for (const edit of [a => { a.expired = true }, a => { a.id++ }, a => { a.digest = `sha256:${'f'.repeat(64)}` },
    a => { a.name += '-other' }, a => { a.size_in_bytes = 3000000 }, a => { a.workflow_run.id++ },
    a => { a.workflow_run.head_sha = 'f'.repeat(40) }]) {
    const a = artifact(); edit(a); assert.throws(() => verifyStagingEvidenceProducer(config(), run(), a))
  }
})

test('real existing promotion contract rejects unbound, incomplete, future and production evidence', () => {
  assert.deepEqual(validateStagingEvidenceBytes(config(), bytes(), now), payload())
  assert.throws(() => validateStagingEvidenceBytes(config(), Buffer.concat([bytes(), Buffer.from(' ')]), now))
  for (const edit of [p => { p.environment = 'production' }, p => { p.evidence_type = 'approval' }, p => { p.status = 'failed' },
    p => { p.subject_release_id = p.subject_release_id.replace('a', 'b') }, p => { p.artifact_set_sha256 = 'f'.repeat(64) },
    p => { p.completed_at = '2027-01-01T00:00:00Z' }, p => { p.checks.pop() }, p => { p.checks.push(p.checks[0]) },
    p => { p.authorization = {} }]) {
    const p = payload(); edit(p); const encoded = Buffer.from(JSON.stringify(p)), c = config()
    c.producer.evidence_sha256 = digest(encoded); c.producer.evidence_size_bytes = encoded.length
    assert.throws(() => validateStagingEvidenceBytes(c, encoded, now))
  }
})

test('downloaded artifact must contain exactly one regular evidence file, never symlinks or extras', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hid-evidence-test-'))
  try {
    await writeFile(join(directory, 'evidence.json'), bytes())
    assert.deepEqual(await loadStagingEvidenceBytes(config(), directory), bytes())
    await writeFile(join(directory, 'unexpected.json'), '{}')
    await assert.rejects(loadStagingEvidenceBytes(config(), directory))
    await rm(join(directory, 'unexpected.json')); await rm(join(directory, 'evidence.json'))
    await symlink('/etc/hosts', join(directory, 'evidence.json'))
    await assert.rejects(loadStagingEvidenceBytes(config(), directory))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

function awsFixture(change = (_args, result) => result) {
  const calls = [], c = config()
  const invoke = (args, body) => {
    calls.push({ args, body })
    let value
    if (args[1] === 'get-caller-identity') value = { Account: '659225405023', Arn: 'arn:aws:sts::659225405023:assumed-role/Hid-staging-ReleaseTrust-EvidenceWriterRole/test' }
    else if (args[1] === 'get-bucket-versioning') value = { Status: 'Enabled' }
    else if (args[1] === 'get-object-lock-configuration') value = { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 90 } } } }
    else if (args[1] === 'put-object') value = { VersionId: 'version_fixture_123', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: c.archive.kms_key_arn,
      BucketKeyEnabled: false, ChecksumSHA256: Buffer.from(c.producer.evidence_sha256, 'hex').toString('base64') }
    else throw Error('unexpected operation')
    return change(args, value)
  }
  return { calls, invoke }
}

test('writer sends one conditional encrypted upload with exact approved bytes and existing scoped IAM only', async () => {
  const f = awsFixture(), result = await appendStagingEvidence(config(), bytes(), f.invoke, now)
  assert.equal(result.result, 'approved-evidence-bytes-appended'); assert.equal(result.deployment_authorized, false)
  assert.equal(result.retention.per_object_retention_verified, false)
  assert.deepEqual(f.calls.map(c => c.args.slice(0, 2)), [['sts', 'get-caller-identity'], ['s3api', 'get-bucket-versioning'],
    ['s3api', 'get-object-lock-configuration'], ['s3api', 'put-object']])
  const put = f.calls.at(-1), option = name => put.args[put.args.indexOf(name) + 1]
  assert.deepEqual(put.body, bytes()); assert.equal(option('--if-none-match'), '*')
  assert.equal(option('--key'), `release-evidence/staging/${config().release_id}/migration-dry-run/222-${digest(bytes())}.json`)
  assert.equal(option('--expected-bucket-owner'), '659225405023'); assert.equal(option('--region'), 'eu-west-1')
  assert.equal(option('--ssekms-key-id'), config().archive.kms_key_arn); assert.ok(put.args.includes('--no-bucket-key-enabled'))
  assert.equal(option('--checksum-sha256'), Buffer.from(digest(bytes()), 'hex').toString('base64'))
  assert.ok(!put.args.some(arg => /retention|object-lock|acl|tagging|endpoint|multipart/.test(arg)))
})

test('wrong AWS identity, suspended versioning and incorrect default retention fail before upload', async () => {
  for (const change of [
    (a, r) => a[1] === 'get-caller-identity' ? { ...r, Account: '000000000000' } : r,
    (a, r) => a[1] === 'get-caller-identity' ? { ...r, Arn: r.Arn.replace('EvidenceWriterRole', 'PublisherRole') } : r,
    (a, r) => a[1] === 'get-bucket-versioning' ? { Status: 'Suspended' } : r,
    (a, r) => { if (a[1] === 'get-object-lock-configuration') r.ObjectLockConfiguration.Rule.DefaultRetention.Days = 89; return r },
    (a, r) => { if (a[1] === 'get-object-lock-configuration') r.ObjectLockConfiguration.Rule.DefaultRetention.Mode = 'GOVERNANCE'; return r },
  ]) {
    const f = awsFixture(change); await assert.rejects(appendStagingEvidence(config(), bytes(), f.invoke, now))
    assert.ok(f.calls.every(c => c.args[1] !== 'put-object'))
  }
  const f = awsFixture(); await assert.rejects(appendStagingEvidence(config(), Buffer.from('changed'), f.invoke, now)); assert.equal(f.calls.length, 0)
})

test('existing keys, ambiguous writes, checksum mismatch and encryption downgrade never report success or retry', async () => {
  for (const change of [
    (a, r) => { if (a[1] === 'put-object') throw Error('PreconditionFailed'); return r },
    (a, r) => { if (a[1] === 'put-object') throw Error('Timeout'); return r },
    (a, r) => a[1] === 'put-object' ? { ...r, VersionId: 'null' } : r,
    (a, r) => a[1] === 'put-object' ? { ...r, ChecksumSHA256: 'mismatch' } : r,
    (a, r) => a[1] === 'put-object' ? { ...r, ServerSideEncryption: 'AES256' } : r,
    (a, r) => a[1] === 'put-object' ? { ...r, SSEKMSKeyId: 'wrong-key' } : r,
    (a, r) => a[1] === 'put-object' ? { ...r, BucketKeyEnabled: true } : r,
  ]) {
    const f = awsFixture(change); await assert.rejects(appendStagingEvidence(config(), bytes(), f.invoke, now))
    assert.equal(f.calls.filter(c => c.args[1] === 'put-object').length, 1)
  }
})

test('network preflight uses exact read-only GitHub resources and rejects failures before cloud authority', async () => {
  const urls = [], env = { ...context(), GH_EVIDENCE_READ_TOKEN: 'synthetic-test-token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-oidc-token',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.actions.githubusercontent.com/token' }
  const get = async (url, options) => {
    urls.push(String(url)); assert.equal(options.redirect, 'error')
    const value = String(url).includes('/environments/') ? policy() : String(url).includes('/runs/') ? run()
      : String(url).includes('/artifacts/') ? artifact() : { value: `e30.${Buffer.from(JSON.stringify(claims(Date.now()))).toString('base64url')}.synthetic-signature` }
    return { ok: true, text: async () => JSON.stringify(value) }
  }
  await preflightStagingEvidence(config(), env, get); assert.equal(urls.length, 4)
  await assert.rejects(preflightStagingEvidence(config(), env, async () => ({ ok: false })))
  await assert.rejects(preflightStagingEvidence(config(), { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://attacker.invalid/token' }, get))
})

test('workflow is reusable, staging only, action-pinned, and validates evidence before AWS role assumption', async () => {
  const source = await readFile(new URL('../../.github/workflows/tuf-evidence.yml', import.meta.url), 'utf8'), w = parse(source)
  assert.deepEqual(Object.keys(w.on), ['workflow_call']); assert.equal(w.jobs.append.environment, 'staging-evidence-writer')
  assert.deepEqual(w.jobs.append.permissions, { contents: 'read', actions: 'read', 'id-token': 'write' })
  const steps = w.jobs.append.steps, aws = steps.findIndex(s => s.uses?.startsWith('aws-actions/'))
  assert.ok(steps.findIndex(s => s.run?.endsWith('mjs preflight')) < aws)
  assert.ok(steps.findIndex(s => s.run?.endsWith('mjs validate')) < aws)
  assert.ok(steps.findIndex(s => s.run?.endsWith('mjs append')) > aws)
  for (const step of steps.filter(s => s.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/)
  assert.doesNotMatch(source, /secrets\.|kms:Sign|workflow_dispatch:|production-evidence|aws s3 cp|cdk deploy/)
})

test('unpopulated public template rejects and contains no invented resources or trust pins', async () => {
  const raw = await readFile(new URL('../config/staging-evidence-writer.template.json', import.meta.url), 'utf8')
  assert.throws(() => validateStagingEvidenceConfig(raw, digest(raw), context(), now))
  const value = JSON.parse(raw); assert.equal(value.writer_role_arn, null); assert.equal(value.archive.bucket, null)
})
