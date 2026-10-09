import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { collectStagingTrustAudit, validateStagingAuditConfig, verifyStagingAuditClaims, verifyStagingAuditPolicy } from '../scripts/audit-staging-release-trust.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const arn = i => `arn:aws:kms:eu-west-1:659225405023:key/00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
const keys = ['snapshot_one', 'snapshot_two', 'timestamp_one', 'timestamp_two'].map((name, i) => {
  const pub = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' })
  return { name, arn: arn(i + 4), spki_sha256: digest(pub), pub: pub.toString('base64') }
})
const config = () => ({ schema_version: 'hid.staging-release-trust-audit/v1', environment: 'staging', source_sha: 'a'.repeat(40),
  workflow_sha: 'b'.repeat(40),
  caller_workflow_path: '.github/workflows/staging-test-caller.yml', aws_account_id: '659225405023', aws_region: 'eu-west-1',
  auditor_role_arn: 'arn:aws:iam::659225405023:role/Hid-staging-ReleaseTrust-AuditorRole',
  archives: Object.fromEntries(['repository', 'evidence', 'audit'].map((n, i) => [n, { bucket: `hid-staging-${n}-fixture`, kms_key_arn: arn(i + 1) }])),
  signing_keys: Object.fromEntries(keys.map(({ name, arn, spki_sha256 }) => [name, { arn, spki_sha256 }])) })
const context = () => ({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'D-Eminence/hid-system', GITHUB_REPOSITORY_ID: '1317340803',
  GITHUB_REPOSITORY_OWNER_ID: '182018869', GITHUB_REF: 'refs/heads/tuf-production-release', GITHUB_REF_TYPE: 'branch', GITHUB_REF_PROTECTED: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1', GITHUB_ACTOR_ID: '182018869', RUNNER_ENVIRONMENT: 'github-hosted',
  APPROVED_SOURCE_SHA: config().source_sha, REQUESTED_SOURCE_SHA: config().source_sha, GITHUB_SHA: config().source_sha,
  APPROVED_WORKFLOW_SHA: config().workflow_sha,
  GITHUB_WORKFLOW_SHA: config().source_sha, AUDITOR_ROLE_ARN: config().auditor_role_arn,
  GITHUB_WORKFLOW_REF: 'D-Eminence/hid-system/.github/workflows/staging-test-caller.yml@refs/heads/tuf-production-release' })
const policy = () => ({ name: 'staging-auditor', id: 123, can_admins_bypass: false,
  deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }, protection_rules: [{ type: 'required_reviewers',
    prevent_self_review: false, reviewers: [{ type: 'User', reviewer: { id: 182018869, login: 'D-Eminence' } }] }] })
const now = Date.parse('2026-09-14T15:00:00Z')
const claims = () => ({ iss: 'https://token.actions.githubusercontent.com', aud: 'sts.amazonaws.com', repository: context().GITHUB_REPOSITORY,
  repository_id: '1317340803', repository_owner_id: '182018869', ref: context().GITHUB_REF, ref_type: 'branch', environment: 'staging-auditor',
  sub: 'repo:D-Eminence/hid-system:environment:staging-auditor', sha: config().source_sha,
  job_workflow_ref: `D-Eminence/hid-system/.github/workflows/tuf-audit.yml@${config().workflow_sha}`, job_workflow_sha: config().workflow_sha,
  workflow_ref: context().GITHUB_WORKFLOW_REF, runner_environment: 'github-hosted', run_id: '12345', run_attempt: '1', actor_id: '182018869',
  event_name: 'workflow_dispatch', iat: now / 1000 - 10, exp: now / 1000 + 290 })

test('audit config binds exact staging owner/source/caller/role and distinct public keys', () => {
  const c = config(), bytes = JSON.stringify(c)
  assert.deepEqual(validateStagingAuditConfig(bytes, digest(bytes), context()), c)
  for (const edit of [c => { c.environment = 'production' }, c => { c.aws_account_id = '000000000000' },
    c => { c.aws_region = 'us-east-1' }, c => { c.source_sha = null }, c => { c.extra = 'unapproved' },
    c => { c.caller_workflow_path = '.github/workflows/production.yml' },
    c => { c.archives.audit.bucket = c.archives.repository.bucket }, c => { c.signing_keys.timestamp_one.arn = c.signing_keys.snapshot_one.arn },
    c => { c.signing_keys.timestamp_one.spki_sha256 = c.signing_keys.snapshot_one.spki_sha256 },
    c => { c.auditor_role_arn = 'arn:aws:iam::659225405023:role/hid-production-staging' }]) {
    const value = config(); edit(value); const encoded = JSON.stringify(value)
    assert.throws(() => validateStagingAuditConfig(encoded, digest(encoded), context()))
  }
  for (const changed of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_WORKFLOW_REF: context().GITHUB_WORKFLOW_REF.replace('staging-test-caller', 'staging-other-caller') },
    { AUDITOR_ROLE_ARN: config().auditor_role_arn + '-Other' }, { GITHUB_REF_PROTECTED: 'false' }]) {
    assert.throws(() => validateStagingAuditConfig(bytes, digest(bytes), { ...context(), ...changed }))
  }
  assert.throws(() => validateStagingAuditConfig(bytes, 'f'.repeat(64), context()))
  const duplicate = bytes.replace('"environment":"staging"', '"environment":"staging","environment":"staging"')
  assert.throws(() => validateStagingAuditConfig(duplicate, digest(duplicate), context()))
})

test('owner policy and immutable role/caller OIDC claims fail closed', () => {
  verifyStagingAuditPolicy(policy()); verifyStagingAuditClaims(claims(), context(), now)
  for (const edit of [p => { p.can_admins_bypass = true }, p => { p.name = 'production-auditor' },
    p => { p.protection_rules[0].reviewers[0].reviewer.id = 1 }, p => { p.deployment_branch_policy.protected_branches = false }]) {
    const p = policy(); edit(p); assert.throws(() => verifyStagingAuditPolicy(p))
  }
  for (const [key, value] of Object.entries(claims())) {
    if (['iat', 'exp'].includes(key)) continue
    assert.throws(() => verifyStagingAuditClaims({ ...claims(), [key]: String(value) + '-wrong' }, context(), now), key)
  }
  assert.throws(() => verifyStagingAuditClaims({ ...claims(), exp: now / 1000 }, context(), now))
})

function awsFixture() {
  const calls = [], c = config()
  const read = args => {
    calls.push(args)
    const operation = args[1], selected = args[args.indexOf('--key-id') + 1]
    if (operation === 'get-caller-identity') return { Account: c.aws_account_id, Arn: 'arn:aws:sts::659225405023:assumed-role/Hid-staging-ReleaseTrust-AuditorRole/test' }
    if (operation === 'get-bucket-location') return { LocationConstraint: c.aws_region }
    if (operation === 'get-bucket-versioning') return { Status: 'Enabled' }
    if (operation === 'get-object-lock-configuration') return { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 90 } } } }
    const signing = keys.find(k => k.arn === selected)
    if (operation === 'describe-key') return { KeyMetadata: { Arn: selected, AWSAccountId: c.aws_account_id, Enabled: true, KeyState: 'Enabled',
      KeyUsage: signing ? 'SIGN_VERIFY' : 'ENCRYPT_DECRYPT', KeySpec: signing ? 'ECC_NIST_P256' : 'SYMMETRIC_DEFAULT', KeyManager: 'CUSTOMER' } }
    if (operation === 'get-public-key') return { KeyId: selected, KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY', SigningAlgorithms: ['ECDSA_SHA_256'], PublicKey: signing.pub }
    throw Error('unapproved operation')
  }
  return { calls, read }
}

test('scoped audit uses only current auditor reads and reports its acceptance limits', async () => {
  const f = awsFixture(), result = await collectStagingTrustAudit(config(), f.read, new Date(now))
  assert.equal(result.result, 'archive-retention-and-public-key-pins-verified')
  assert.equal(result.deployment_authorized, false); assert.equal(result.cloud_mutations, false)
  assert.ok(result.unverified.includes('checkpoint-journal'))
  assert.equal(f.calls.length, 21)
  assert.ok(f.calls.every(args => /^(get-|describe-)/.test(args[1]) && args.includes('eu-west-1')))
  assert.ok(f.calls.filter(args => args[0] === 's3api').every(args => args.includes('--expected-bucket-owner')))
})

test('incorrect caller key pin retention or AWS read failure cannot produce a successful receipt', async () => {
  for (const change of [
    (args, value) => args[1] === 'get-caller-identity' ? { ...value, Account: '000000000000' } : value,
    (args, value) => args[1] === 'get-caller-identity' ? { ...value, Arn: value.Arn.replace('AuditorRole', 'PublisherRole') } : value,
    (args, value) => args[1] === 'get-bucket-location' ? { LocationConstraint: 'us-east-1' } : value,
    (args, value) => args[1] === 'get-bucket-versioning' ? { Status: 'Suspended' } : value,
    (args, value) => { if (args[1] === 'get-object-lock-configuration') value.ObjectLockConfiguration.Rule.DefaultRetention.Mode = 'GOVERNANCE'; return value },
    (args, value) => { if (args[1] === 'describe-key') value.KeyMetadata.Enabled = false; return value },
    (args, value) => args[1] === 'get-public-key' ? { ...value, PublicKey: Buffer.from('wrong public key').toString('base64') } : value,
  ]) {
    const f = awsFixture(); await assert.rejects(collectStagingTrustAudit(config(), args => change(args, f.read(args))))
  }
  await assert.rejects(collectStagingTrustAudit(config(), () => { throw Error('AccessDenied') }))
})

test('audit workflow is reusable staging-only and validates identity before AWS credentials', async () => {
  const source = await readFile(new URL('../../.github/workflows/tuf-audit.yml', import.meta.url), 'utf8'), w = parse(source)
  assert.deepEqual(Object.keys(w.on), ['workflow_call']); assert.equal(w.jobs.audit.environment, 'staging-auditor')
  assert.deepEqual(w.jobs.audit.permissions, { contents: 'read', actions: 'read', 'id-token': 'write' })
  const steps = w.jobs.audit.steps, aws = steps.findIndex(s => s.uses?.startsWith('aws-actions/'))
  assert.ok(steps.findIndex(s => s.run?.endsWith('mjs preflight')) < aws)
  assert.ok(steps.findIndex(s => s.run?.endsWith('mjs audit')) > aws)
  assert.match(steps[0].run, /GITHUB_WORKFLOW_SHA/)
  for (const s of steps.filter(s => s.uses)) assert.match(s.uses, /@[a-f0-9]{40}$/)
  assert.doesNotMatch(source, /secrets\.|kms:Sign|workflow_dispatch:|tuf-publish|production-auditor|aws s3 cp|cdk deploy/)
})
