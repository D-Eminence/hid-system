#!/usr/bin/env node
// Value-free validation only. No SDK, credential resolution or deployment path.
import assert from 'node:assert/strict'
import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import duplicateKeyJson from 'json-dup-key-validator'

export const template = JSON.parse(await readFile(new URL('../config/staging-identifiers.template.json', import.meta.url), 'utf8'))
const patterns = {
  AWS_ACCOUNT_ID: /^[0-9]{12}$/, AWS_REGION: /^[a-z]{2}-[a-z]+-[0-9]$/,
  GIT_SHA: /^[a-f0-9]{40}$/, SHA256: /^[a-f0-9]{64}$/, CLOUDFLARE_ID: /^[a-f0-9]{32}$/,
  GITHUB_ID: /^[1-9][0-9]{0,19}$/, PROTECTED_REF: /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/,
  WORKFLOW_REF: /^D-Eminence\/hid-system\/\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml@[a-f0-9]{40}$/,
  WORKFLOW_PATH: /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/,
  ROLE_ARN: /^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]+$/,
  KMS_ARN: /^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  OIDC_ARN: /^arn:aws:iam::[0-9]{12}:oidc-provider\/token\.actions\.githubusercontent\.com$/,
  SECRET_ARN: /^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$/,
  SECRET_VERSION: /^[A-Za-z0-9-]{32,64}$/, OBJECT_VERSION: /^[A-Za-z0-9._~+/-]{1,1024}$/,
  STAGING_BUCKET: /^(?=.{3,63}$)[a-z0-9][a-z0-9.-]*staging[a-z0-9.-]*[a-z0-9]$/,
  ECR_DIGEST_URI: /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$/,
  SNS_ARN: /^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:hid-staging-release-trust-alerts$/,
  ECS_CLUSTER_ARN: /^arn:aws:ecs:[a-z0-9-]+:[0-9]{12}:cluster\/[A-Za-z0-9_-]+$/,
  RDS_ARN: /^arn:aws:rds:[a-z0-9-]+:[0-9]{12}:db:[A-Za-z0-9-]+$/,
  RDS_SNAPSHOT_ARN: /^arn:aws:rds:[a-z0-9-]+:[0-9]{12}:snapshot:[A-Za-z0-9:-]+$/,
  ACM_ARN: /^arn:aws:acm:[a-z0-9-]+:[0-9]{12}:certificate\/[a-f0-9-]{36}$/,
  ELB_ARN: /^arn:aws:elasticloadbalancing:[a-z0-9-]+:[0-9]{12}:loadbalancer\/app\/[A-Za-z0-9-]+\/[a-f0-9]+$/,
  RELEASE_ID: /^r[0-9]{10}-g[a-f0-9]{40}$/,
  TARGET: /^environments\/staging\/releases\/r[0-9]{10}-g[a-f0-9]{40}\/release-bundle\.json$/,
  REVIEWED_REFERENCE: /^evidence:sha256:[a-f0-9]{64}$/,
}

export function validateStagingIdentifiers(input, { allowPlaceholders = false } = {}) {
  const missing = [], errors = [], supplied = []
  const visit = (expected, actual, path) => {
    const token = typeof expected === 'string' && /^<([A-Z_0-9]+)>$/.exec(expected)
    if (token) {
      if (actual === expected) { missing.push(path); return }
      const kind = token[1]
      const valid = kind === 'POSITIVE_INTEGER' ? Number.isSafeInteger(actual) && actual > 0
        : kind === 'KMS_ARN_OR_AWS_MANAGED' ? actual === 'aws-managed:aws/secretsmanager' || typeof actual === 'string' && patterns.KMS_ARN.test(actual)
          : typeof actual === 'string' && patterns[kind]?.test(actual)
      if (!valid) errors.push(`${path}: invalid ${kind}`)
      else supplied.push([path, actual, kind])
    } else if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (!actual || typeof actual !== 'object' || Array.isArray(actual)) { errors.push(`${path}: expected object`); return }
      if (JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify(Object.keys(actual).sort())) errors.push(`${path}: missing or unknown fields`)
      for (const key of Object.keys(expected)) visit(expected[key], actual[key], path ? `${path}.${key}` : key)
    } else if (JSON.stringify(expected) !== JSON.stringify(actual)) errors.push(`${path}: governed value differs`)
  }
  visit(template, input, '')
  const account = input?.aws?.account_id, region = input?.aws?.region
  for (const [path, value, kind] of supplied) {
    if (typeof value !== 'string') continue
    if (value.startsWith('arn:aws:')) {
      const parts = value.split(':')
      if (parts[4] !== account || parts[3] && parts[3] !== region) errors.push(`${path}: AWS account/region mismatch`)
      if (/production/i.test(value)) errors.push(`${path}: production resource forbidden`)
      if (['ROLE_ARN', 'SECRET_ARN', 'ECS_CLUSTER_ARN', 'RDS_ARN', 'RDS_SNAPSHOT_ARN', 'ELB_ARN'].includes(kind) && !/staging/i.test(parts.slice(5).join(':'))) errors.push(`${path}: staging resource name required`)
    }
    if (kind === 'ECR_DIGEST_URI' && !value.startsWith(`${account}.dkr.ecr.${region}.amazonaws.com/`)) errors.push(`${path}: ECR account/region mismatch`)
    if (kind === 'PROTECTED_REF' && /\.\.|\/\.|\/\/|\/$|\.lock$|\.$/.test(value)) errors.push(`${path}: invalid Git ref`)
    if (kind === 'STAGING_BUCKET' && /\.\.|\.-|-\.|production/.test(value)) errors.push(`${path}: invalid staging bucket`)
  }
  for (const [capability, details] of Object.entries(input?.github?.capabilities ?? {})) {
    const suffix = template.github.capabilities[capability]?.environment.slice('staging-'.length)
    const expectedWorkflow = `${input.github.repository}/.github/workflows/tuf-${suffix === 'evidence-writer' ? 'evidence' : suffix === 'auditor' ? 'audit' : suffix === 'publisher' ? 'publish' : suffix}.yml@`
    if (details.workflow_ref !== '<WORKFLOW_REF>' && !details.workflow_ref?.startsWith(expectedWorkflow)) errors.push(`github.capabilities.${capability}: capability workflow mismatch`)
  }
  const release = input?.release
  if (release?.release_id !== '<RELEASE_ID>' && release?.release_id !== undefined) {
    if (!release.release_id.endsWith(`-g${release.source_sha}`)) errors.push('release: source SHA/release ID mismatch')
    if (release.target !== `environments/staging/releases/${release.release_id}/release-bundle.json`) errors.push('release: exact target mismatch')
  }
  if (input?.aws?.cloudflare_secret_arn !== '<SECRET_ARN>' && !input?.aws?.cloudflare_secret_arn?.startsWith(`arn:aws:secretsmanager:${region}:${account}:secret:hid-staging-cloudflare-publisher-token-`)) errors.push('aws.cloudflare_secret_arn: publisher credential scope mismatch')
  const keys = Object.values(input?.aws?.kms_keys ?? {}).filter(v => v !== '<KMS_ARN>')
  if (new Set(keys).size !== keys.length) errors.push('aws.kms_keys: key separation required')
  const roles = Object.values(input?.github?.capabilities ?? {}).map(v => v.role_arn).filter(v => v !== '<ROLE_ARN>')
  if (new Set(roles).size !== roles.length) errors.push('github.capabilities: role separation required')
  for (const [component, uri] of Object.entries(input?.aws?.oci_images ?? {})) {
    const repository = component === 'database-migration' ? 'ehr-api' : component
    if (uri !== '<ECR_DIGEST_URI>' && !uri.startsWith(`${account}.dkr.ecr.${region}.amazonaws.com/staging/hid/${repository}@sha256:`)) errors.push(`aws.oci_images.${component}: governed staging ECR repository mismatch`)
  }
  if (input?.aws?.broker_image_uri !== '<ECR_DIGEST_URI>' && !input?.aws?.broker_image_uri?.startsWith(`${account}.dkr.ecr.${region}.amazonaws.com/hid-staging-tuf-signing-broker@sha256:`)) errors.push('aws.broker_image_uri: staging broker repository mismatch')
  if (input?.aws?.restore_instance_arn !== '<RDS_ARN>' && input?.aws?.restore_instance_arn === input?.aws?.rds_instance_arn) errors.push('aws.restore_instance_arn: restore destination must be separate')
  return { valid: errors.length === 0 && (allowPlaceholders || missing.length === 0), missing, errors,
    live_ownership_verified: false, authorization: 'NOT_AUTHORIZED' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), allowPlaceholders = args[0] === '--check-template'
    if (allowPlaceholders) args.shift()
    assert.equal(args.length, 1, 'one manifest path required')
    const stat = await lstat(args[0]); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 131072)
    const result = validateStagingIdentifiers(duplicateKeyJson.parse(await readFile(args[0], 'utf8'), false), { allowPlaceholders })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.valid) process.exitCode = 1
  } catch { process.stderr.write('staging identifier manifest rejected\n'); process.exitCode = 1 }
}
