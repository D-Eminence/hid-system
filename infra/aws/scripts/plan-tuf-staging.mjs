#!/usr/bin/env node
// Offline CloudFormation synthesis only. This is intentionally not a CDK deploy
// entry point and never sets up credentials, looks up resources or contacts AWS.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { App } from 'aws-cdk-lib'
import { HidReleaseTrustStack } from '../src/hid-release-trust-stack.ts'
import { validateStagingIdentifiers } from '../../../release/scripts/validate-staging-identifiers.mjs'
import { loadStrictJson } from '../../../release/scripts/verify-release-contract.mjs'

const [mode, manifestPath, outputPath, ...extra] = process.argv.slice(2)
assert.ok(['--foundation', '--broker'].includes(mode) && manifestPath && outputPath && extra.length === 0,
  'Usage: node --import tsx scripts/plan-tuf-staging.mjs --foundation|--broker MANIFEST NEW_OUTPUT_DIRECTORY')
const manifest = await loadStrictJson(resolve(manifestPath))
const validation = validateStagingIdentifiers(manifest, { allowPlaceholders: true })
assert.ok(validation.valid, 'invalid staging identifiers')
const literal = (value) => { assert.ok(typeof value === 'string' && !value.includes('<'), 'required plan identifier missing'); return value }
const props = {
  environmentName: 'staging', approvedAccount: literal(manifest.aws.account_id), approvedRegion: literal(manifest.aws.region),
  githubOidcProviderArn: literal(manifest.aws.oidc_provider_arn), githubAudience: 'sts.amazonaws.com',
  approvedGithubRepository: manifest.github.repository, approvedGithubRepositoryId: manifest.github.repository_id,
  approvedGithubRepositoryOwnerId: manifest.github.owner_id, approvedGithubRef: literal(manifest.github.protected_ref),
  githubWorkflowRefs: Object.fromEntries(Object.entries(manifest.github.capabilities).map(([key, value]) => [key, literal(value.workflow_ref)])),
  githubProtectedEnvironmentSubjects: Object.fromEntries(Object.entries(manifest.github.capabilities).map(([key, value]) =>
    [key, `repo:${manifest.github.repository}:environment:${value.environment}`])),
  evidenceObjectLockMode: manifest.aws.object_lock.mode, evidenceRetentionDays: manifest.aws.object_lock.default_retention_days,
  // Required by the construct even for pure source modeling. This literal is
  // not owner authorization and the retained plan explicitly records that.
  acknowledgeObjectLockIsIrreversible: true,
}
if (mode === '--broker') {
  const pins = manifest.aws.candidate_spki_sha256
  props.signingBroker = { repositoryId: 'hid-staging-v1', stateId: 'hid-staging-broker-v1',
    imageDigest: literal(manifest.aws.broker_image_uri).split('@')[1],
    publicRepositoryUrl: `${manifest.cloudflare.update_origin}/`, bootstrapRootSha256: literal(manifest.release.bootstrap_root_sha256),
    bootstrapRootObjectVersionId: literal(manifest.aws.bootstrap_root_object_version_id),
    candidatePublicKeySpkiSha256: { snapshotOne: literal(pins.snapshot_one), snapshotTwo: literal(pins.snapshot_two),
      timestampOne: literal(pins.timestamp_one), timestampTwo: literal(pins.timestamp_two) },
    acknowledgeCeremonyApprovedImmutablePins: true }
  props.alarmNotificationTopicArn = literal(manifest.aws.alarm_topic_arn)
  props.publisherCloudflareToken = { secretArn: literal(manifest.aws.cloudflare_secret_arn), versionId: literal(manifest.aws.cloudflare_secret_version_id),
    ...(manifest.aws.cloudflare_secret_kms_key_arn === 'aws-managed:aws/secretsmanager' ? {} : { encryptionKeyArn: literal(manifest.aws.cloudflare_secret_kms_key_arn) }) }
}
const output = resolve(outputPath)
await mkdir(output, { mode: 0o700 })
const app = new App({ outdir: output })
new HidReleaseTrustStack(app, manifest.aws.release_stack_name, props)
const assembly = app.synth()
const stack = assembly.stacks[0]
const bytes = await readFile(resolve(output, stack.templateFile))
const template = JSON.parse(bytes)
const review = { schema_version: 'hid.tuf.offline-infrastructure-plan/v1', environment: 'staging', mode,
  authorization: 'NOT_AUTHORIZED', live_diff: false, cloud_calls: false,
  template_file: stack.templateFile, template_sha256: createHash('sha256').update(bytes).digest('hex'),
  changes: Object.entries(template.Resources).map(([logical_id, value]) => ({ logical_id, type: value.Type,
    proposed_action: 'create-if-confirmed-absent', deletion_policy: value.DeletionPolicy ?? null })) }
await writeFile(resolve(output, 'review.json'), `${JSON.stringify(review, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
process.stdout.write(`${JSON.stringify({ ...review, changes: review.changes.length })}\n`)
