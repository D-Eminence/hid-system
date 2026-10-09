#!/usr/bin/env node
// Read-only staging archive/key inspection. This grants no publication or signing authority.
import assert from 'node:assert/strict'
import { createHash, createPublicKey } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import duplicateKeyJson from 'json-dup-key-validator'

const ACCOUNT = '659225405023', REGION = 'eu-west-1', REPOSITORY = 'D-Eminence/hid-system'
const REF = 'refs/heads/tuf-production-release', WORKFLOW = '.github/workflows/tuf-audit.yml'
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/
const KMS = /^arn:aws:kms:eu-west-1:659225405023:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const ROLES = ['snapshot_one', 'snapshot_two', 'timestamp_one', 'timestamp_two']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const check = (value, message = 'staging audit input rejected') => assert.ok(value, message)
const exact = (object, keys) => check(object && typeof object === 'object' && !Array.isArray(object)
  && JSON.stringify(Object.keys(object).sort()) === JSON.stringify([...keys].sort()))

export function validateStagingAuditConfig(bytes, approvedDigest, context) {
  check(typeof bytes === 'string' && Buffer.byteLength(bytes) <= 16384
    && DIGEST.test(approvedDigest ?? '') && hash(bytes) === approvedDigest)
  const config = duplicateKeyJson.parse(bytes, false)
  exact(config, ['schema_version', 'environment', 'source_sha', 'workflow_sha', 'caller_workflow_path', 'aws_account_id', 'aws_region', 'auditor_role_arn', 'archives', 'signing_keys'])
  check(config.schema_version === 'hid.staging-release-trust-audit/v1' && config.environment === 'staging'
    && config.aws_account_id === ACCOUNT && config.aws_region === REGION && SHA.test(config.source_sha) && SHA.test(config.workflow_sha)
    && /^\.github\/workflows\/[a-z0-9-]*staging[a-z0-9-]*\.yml$/.test(config.caller_workflow_path)
    && !config.caller_workflow_path.includes('production'))
  check(/^arn:aws:iam::659225405023:role\/[A-Za-z0-9+=,.@_/-]*staging[A-Za-z0-9+=,.@_/-]*$/.test(config.auditor_role_arn)
    && !/production/i.test(config.auditor_role_arn))
  exact(config.archives, ['repository', 'evidence', 'audit'])
  const buckets = [], keys = []
  for (const archive of Object.values(config.archives)) {
    exact(archive, ['bucket', 'kms_key_arn'])
    check(/^(?=.{3,63}$)[a-z0-9][a-z0-9-]*staging[a-z0-9-]*[a-z0-9]$/.test(archive.bucket)
      && !archive.bucket.includes('production') && KMS.test(archive.kms_key_arn))
    buckets.push(archive.bucket); keys.push(archive.kms_key_arn)
  }
  check(new Set(buckets).size === 3)
  exact(config.signing_keys, ROLES)
  const pins = []
  for (const key of Object.values(config.signing_keys)) {
    exact(key, ['arn', 'spki_sha256'])
    check(KMS.test(key.arn) && DIGEST.test(key.spki_sha256))
    keys.push(key.arn); pins.push(key.spki_sha256)
  }
  check(new Set(keys).size === 7 && new Set(pins).size === 4)
  if (context) {
    const expected = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_REPOSITORY_ID: '1317340803',
      GITHUB_REPOSITORY_OWNER_ID: '182018869', GITHUB_REF: REF, GITHUB_REF_TYPE: 'branch', GITHUB_REF_PROTECTED: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_RUN_ATTEMPT: '1', APPROVED_SOURCE_SHA: config.source_sha,
      GITHUB_SHA: config.source_sha, GITHUB_WORKFLOW_SHA: config.source_sha, REQUESTED_SOURCE_SHA: config.source_sha,
      APPROVED_WORKFLOW_SHA: config.workflow_sha, AUDITOR_ROLE_ARN: config.auditor_role_arn,
      GITHUB_WORKFLOW_REF: `${REPOSITORY}/${config.caller_workflow_path}@${REF}` }
    check(Object.entries(expected).every(([key, value]) => context[key] === value), 'staging audit source or role rejected')
    check(['push', 'workflow_dispatch'].includes(context.GITHUB_EVENT_NAME) && !context.GITHUB_HEAD_REF && !context.GITHUB_BASE_REF)
    check(/^[1-9][0-9]{0,19}$/.test(context.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]{0,19}$/.test(context.GITHUB_ACTOR_ID ?? ''))
  }
  return config
}

export function verifyStagingAuditPolicy(policy) {
  check(policy?.name === 'staging-auditor' && Number.isSafeInteger(policy.id) && policy.id > 0
    && policy.can_admins_bypass === false && policy.deployment_branch_policy?.protected_branches === true
    && policy.deployment_branch_policy?.custom_branch_policies === false, 'staging audit environment rejected')
  const rules = policy.protection_rules?.filter(rule => rule.type === 'required_reviewers')
  check(rules?.length === 1 && rules[0].prevent_self_review === false && rules[0].reviewers?.length === 1)
  const owner = rules[0].reviewers[0]
  check(owner.type === 'User' && owner.reviewer?.id === 182018869 && owner.reviewer?.login === 'D-Eminence')
}

export function verifyStagingAuditClaims(claims, context, now = Date.now()) {
  const expected = { iss: 'https://token.actions.githubusercontent.com', aud: 'sts.amazonaws.com', repository: REPOSITORY,
    repository_id: '1317340803', repository_owner_id: '182018869', ref: REF, ref_type: 'branch', environment: 'staging-auditor',
    sub: `repo:${REPOSITORY}:environment:staging-auditor`, sha: context.APPROVED_SOURCE_SHA,
    job_workflow_ref: `${REPOSITORY}/${WORKFLOW}@${context.APPROVED_WORKFLOW_SHA}`, job_workflow_sha: context.APPROVED_WORKFLOW_SHA,
    runner_environment: 'github-hosted', run_id: context.GITHUB_RUN_ID, run_attempt: '1', actor_id: context.GITHUB_ACTOR_ID,
    event_name: context.GITHUB_EVENT_NAME, workflow_ref: context.GITHUB_WORKFLOW_REF }
  check(Object.entries(expected).every(([key, value]) => value && claims?.[key] === value), 'staging audit workload claims rejected')
  check(Number.isSafeInteger(claims.iat) && Number.isSafeInteger(claims.exp) && claims.iat <= now / 1000 + 60
    && claims.exp > now / 1000 && claims.exp - claims.iat > 0 && claims.exp - claims.iat <= 600)
  // This is a claim precheck only. configure-aws-credentials obtains its own token;
  // AWS STS verifies that token signature and the exact role's immutable workflow trust.
}

export async function collectStagingTrustAudit(config, readAws, now = new Date()) {
  const read = (service, operation, args = []) => readAws([service, operation, ...args, '--region', REGION, '--output', 'json', '--no-cli-pager'])
  const identity = await read('sts', 'get-caller-identity')
  const roleName = config.auditor_role_arn.split('/').at(-1)
  check(identity.Account === ACCOUNT && typeof identity.Arn === 'string'
    && identity.Arn.startsWith(`arn:aws:sts::${ACCOUNT}:assumed-role/${roleName}/`), 'staging audit assumed role rejected')
  const archives = {}
  for (const [name, archive] of Object.entries(config.archives)) {
    const args = ['--bucket', archive.bucket, '--expected-bucket-owner', ACCOUNT]
    const location = await read('s3api', 'get-bucket-location', args)
    check(location.LocationConstraint === REGION, 'staging audit archive region rejected')
    const versioning = await read('s3api', 'get-bucket-versioning', args)
    check(versioning.Status === 'Enabled', 'staging audit archive versioning rejected')
    const lock = await read('s3api', 'get-object-lock-configuration', args)
    const retention = lock.ObjectLockConfiguration?.Rule?.DefaultRetention
    check(lock.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled'
      && retention?.Mode === 'COMPLIANCE' && retention?.Days === 90 && retention.Years === undefined,
    'staging audit archive retention rejected')
    const key = (await read('kms', 'describe-key', ['--key-id', archive.kms_key_arn])).KeyMetadata
    check(key?.Arn === archive.kms_key_arn && key.AWSAccountId === ACCOUNT && key.Enabled === true && key.KeyState === 'Enabled'
      && key.KeyUsage === 'ENCRYPT_DECRYPT' && key.KeySpec === 'SYMMETRIC_DEFAULT' && key.KeyManager === 'CUSTOMER', 'staging audit storage key rejected')
    archives[name] = { bucket: archive.bucket, location: REGION, versioning: 'Enabled', default_retention: { mode: 'COMPLIANCE', days: 90 },
      kms_key_arn: archive.kms_key_arn, kms_key_enabled: true }
  }
  const signingKeys = {}
  for (const [name, expected] of Object.entries(config.signing_keys)) {
    const key = (await read('kms', 'describe-key', ['--key-id', expected.arn])).KeyMetadata
    check(key?.Arn === expected.arn && key.AWSAccountId === ACCOUNT && key.Enabled === true && key.KeyState === 'Enabled'
      && key.KeySpec === 'ECC_NIST_P256' && key.KeyUsage === 'SIGN_VERIFY' && key.KeyManager === 'CUSTOMER', 'staging audit signing key rejected')
    const pub = await read('kms', 'get-public-key', ['--key-id', expected.arn])
    check(pub.KeyId === expected.arn && pub.KeySpec === 'ECC_NIST_P256' && pub.KeyUsage === 'SIGN_VERIFY'
      && Array.isArray(pub.SigningAlgorithms) && pub.SigningAlgorithms.includes('ECDSA_SHA_256')
      && typeof pub.PublicKey === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(pub.PublicKey)
      && hash(Buffer.from(pub.PublicKey, 'base64')) === expected.spki_sha256, 'staging audit public key pin rejected')
    const parsed = createPublicKey({ key: Buffer.from(pub.PublicKey, 'base64'), format: 'der', type: 'spki' })
    check(parsed.asymmetricKeyType === 'ec' && parsed.asymmetricKeyDetails?.namedCurve === 'prime256v1', 'staging audit public key curve rejected')
    signingKeys[name] = { arn: expected.arn, spki_sha256: expected.spki_sha256, enabled: true }
  }
  return { schema_version: 'hid.staging-release-trust-audit-result/v1', recorded_at: now.toISOString(), environment: 'staging',
    source_sha: config.source_sha, workflow_sha: config.workflow_sha, aws_account_id: ACCOUNT, aws_region: REGION, auditor_role_arn: config.auditor_role_arn,
    result: 'archive-retention-and-public-key-pins-verified', archives, signing_keys: signingKeys,
    unverified: ['archive-encryption-configuration', 'bucket-policy', 'per-object-retention', 'root-and-targets-custody', 'checkpoint-journal', 'release-admission', 'live-staging-acceptance'],
    cloud_mutations: false, deployment_authorized: false, production: 'LOCKED' }
}

async function preflight(config, context, get = fetch) {
  const read = async (url, token) => {
    const response = await get(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      redirect: 'error', signal: AbortSignal.timeout(30000) })
    check(response.ok)
    const bytes = await response.text(); check(Buffer.byteLength(bytes) <= 131072)
    return duplicateKeyJson.parse(bytes, false)
  }
  check(typeof context.GH_AUDIT_READ_TOKEN === 'string' && context.GH_AUDIT_READ_TOKEN.length > 0)
  verifyStagingAuditPolicy(await read(`https://api.github.com/repos/${REPOSITORY}/environments/staging-auditor`, context.GH_AUDIT_READ_TOKEN))
  const url = new URL(context.ACTIONS_ID_TOKEN_REQUEST_URL)
  check(url.protocol === 'https:' && url.hostname.endsWith('.actions.githubusercontent.com') && !url.username && !url.password && !url.hash)
  url.searchParams.set('audience', 'sts.amazonaws.com')
  const response = await read(url, context.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
  check(typeof response.value === 'string' && response.value.split('.').length === 3)
  const claims = duplicateKeyJson.parse(Buffer.from(response.value.split('.')[1], 'base64url').toString(), false)
  verifyStagingAuditClaims(claims, context)
  return { environment: config.environment, workload_claim_precheck: true, aws_signature_verification: 'required-by-STS',
    deployment_authorized: false }
}

async function main() {
  const context = process.env, [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['preflight', 'audit'].includes(mode))
  check(resolve(context.RUNNER_TEMP) === await realpath(context.RUNNER_TEMP))
  const config = validateStagingAuditConfig(await readFile(resolve(context.RUNNER_TEMP, 'staging-audit-config.json'), 'utf8'), context.AUDIT_CONFIG_SHA256, context)
  check(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === config.workflow_sha)
  if (mode === 'preflight') { await preflight(config, context); process.stdout.write('Staging audit source, policy and workload prechecks passed.\n'); return }
  const readAws = args => {
    const bytes = execFileSync('aws', args, { encoding: 'utf8', maxBuffer: 262144, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] })
    return duplicateKeyJson.parse(bytes, false)
  }
  const result = await collectStagingTrustAudit(config, readAws)
  result.configuration_sha256 = context.AUDIT_CONFIG_SHA256
  await writeFile(resolve(context.RUNNER_TEMP, 'staging-release-trust-audit.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write('Staging archive retention and public key pin audit passed; release acceptance remains unverified.\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Staging release trust audit rejected. No credentials or provider response details are logged.\n'); process.exitCode = 1 })
}
