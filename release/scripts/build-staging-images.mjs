#!/usr/bin/env node
// Protected staging image producer. Digest receipts are NOT release admission.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, realpath, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import duplicateKeyJson from 'json-dup-key-validator'

const ACCOUNT = '659225405023', REGION = 'eu-west-1', REPOSITORY = 'D-Eminence/hid-system'
const REGISTRY = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com`
const REF = 'refs/heads/tuf-production-release', WORKFLOW = '.github/workflows/tuf-build.yml'
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/
const COMPONENTS = ['identity-api', 'ehr-api', 'lab-api', 'pharmacy-api', 'ocr-api', 'ocr-worker',
  'outreach-api', 'notification-api', 'notification-worker', 'event-dispatcher', 'gateway', 'database-migration']
const BROKER_BASES = {
  GO_BUILD_IMAGE: 'docker.io/library/golang:1.26.8-bookworm@sha256:9fdc884aacc3bec89b20ffc69f4bb369c78210e3e4f600387b5128b12c199f81',
  LAMBDA_RUNTIME_IMAGE: 'public.ecr.aws/lambda/provided:al2023@sha256:7dea43facdd67ffd71aa540527b6af413dfdae0133a0423ee9c329bf1e5adb6c',
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const check = (value, message = 'staging build input rejected') => assert.ok(value, message)
const exact = (object, keys) => check(object && typeof object === 'object' && !Array.isArray(object)
  && JSON.stringify(Object.keys(object).sort()) === JSON.stringify([...keys].sort()))

export function validateStagingBuildConfig(bytes, approvedDigest, context) {
  check(typeof bytes === 'string' && Buffer.byteLength(bytes) <= 16384
    && DIGEST.test(approvedDigest ?? '') && hash(bytes) === approvedDigest)
  const config = duplicateKeyJson.parse(bytes, false)
  exact(config, ['schema_version', 'environment', 'source_sha', 'workflow_sha', 'caller_workflow_path',
    'aws_account_id', 'aws_region', 'build_role_arn', 'build_kind'])
  check(config.schema_version === 'hid.staging-image-build/v1' && config.environment === 'staging'
    && config.aws_account_id === ACCOUNT && config.aws_region === REGION && SHA.test(config.source_sha) && SHA.test(config.workflow_sha)
    && ['applications', 'signing-broker'].includes(config.build_kind)
    && /^\.github\/workflows\/[a-z0-9-]*staging[a-z0-9-]*\.yml$/.test(config.caller_workflow_path)
    && !config.caller_workflow_path.includes('production'))
  check(/^arn:aws:iam::659225405023:role\/[A-Za-z0-9+=,.@_/-]*staging[A-Za-z0-9+=,.@_/-]*$/.test(config.build_role_arn)
    && !/production/i.test(config.build_role_arn))
  if (context) {
    const expected = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_REPOSITORY_ID: '1317340803',
      GITHUB_REPOSITORY_OWNER_ID: '182018869', GITHUB_REF: REF, GITHUB_REF_TYPE: 'branch', GITHUB_REF_PROTECTED: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_RUN_ATTEMPT: '1', APPROVED_SOURCE_SHA: config.source_sha,
      GITHUB_SHA: config.source_sha, GITHUB_WORKFLOW_SHA: config.source_sha, REQUESTED_SOURCE_SHA: config.source_sha,
      APPROVED_WORKFLOW_SHA: config.workflow_sha, BUILD_ROLE_ARN: config.build_role_arn,
      REQUESTED_BUILD_KIND: config.build_kind, RUNNER_ARCH: config.build_kind === 'applications' ? 'ARM64' : 'X64',
      GITHUB_WORKFLOW_REF: `${REPOSITORY}/${config.caller_workflow_path}@${REF}` }
    check(Object.entries(expected).every(([key, value]) => context[key] === value), 'staging build source or role rejected')
    check(['push', 'workflow_dispatch'].includes(context.GITHUB_EVENT_NAME) && !context.GITHUB_HEAD_REF && !context.GITHUB_BASE_REF)
    check(/^[1-9][0-9]{0,19}$/.test(context.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]{0,19}$/.test(context.GITHUB_ACTOR_ID ?? ''))
  }
  return config
}

export function verifyStagingBuildPolicy(policy) {
  check(policy?.name === 'staging-build' && Number.isSafeInteger(policy.id) && policy.id > 0
    && policy.can_admins_bypass === false && policy.deployment_branch_policy?.protected_branches === true
    && policy.deployment_branch_policy?.custom_branch_policies === false, 'staging build environment rejected')
  const rules = policy.protection_rules?.filter(rule => rule.type === 'required_reviewers')
  check(rules?.length === 1 && rules[0].prevent_self_review === false && rules[0].reviewers?.length === 1)
  const owner = rules[0].reviewers[0]
  check(owner.type === 'User' && owner.reviewer?.id === 182018869 && owner.reviewer?.login === 'D-Eminence')
}

export function verifyStagingBuildClaims(claims, context, now = Date.now()) {
  const expected = { iss: 'https://token.actions.githubusercontent.com', aud: 'sts.amazonaws.com', repository: REPOSITORY,
    repository_id: '1317340803', repository_owner_id: '182018869', ref: REF, ref_type: 'branch', environment: 'staging-build',
    sub: `repo:${REPOSITORY}:environment:staging-build`, sha: context.APPROVED_SOURCE_SHA,
    job_workflow_ref: `${REPOSITORY}/${WORKFLOW}@${context.APPROVED_WORKFLOW_SHA}`, job_workflow_sha: context.APPROVED_WORKFLOW_SHA,
    runner_environment: 'github-hosted', run_id: context.GITHUB_RUN_ID, run_attempt: '1', actor_id: context.GITHUB_ACTOR_ID,
    event_name: context.GITHUB_EVENT_NAME, workflow_ref: context.GITHUB_WORKFLOW_REF }
  check(Object.entries(expected).every(([key, value]) => value && claims?.[key] === value), 'staging build workload claims rejected')
  check(Number.isSafeInteger(claims.iat) && Number.isSafeInteger(claims.exp) && claims.iat <= now / 1000 + 60
    && claims.exp > now / 1000 && claims.exp - claims.iat > 0 && claims.exp - claims.iat <= 600)
  // Claim precheck only; AWS STS verifies its independently obtained token's
  // signature and this role's immutable capability workflow trust.
}

export function stagingImageBuildPlan(config, runId) {
  check(/^[1-9][0-9]{0,19}$/.test(runId ?? ''))
  const components = config.build_kind === 'applications' ? COMPONENTS : ['signing-broker']
  return components.map(component => {
    const broker = component === 'signing-broker', migration = component === 'database-migration'
    const repository = broker ? 'hid-staging-tuf-signing-broker' : `staging/hid/${migration ? 'ehr-api' : component}`
    return { component, repository, tag: `${config.source_sha}-${component}-${runId}`,
      context: broker ? 'tools/tuf-release' : '.',
      dockerfile: broker ? 'tools/tuf-release/Dockerfile.signing-broker'
        : component === 'gateway' ? 'gateway/Dockerfile' : `services/${migration ? 'ehr-api' : component}/Dockerfile`,
      target: migration ? 'migration' : null,
      build_args: broker ? BROKER_BASES : {}, platform: broker ? 'linux/amd64' : 'linux/arm64', repository_uri: `${REGISTRY}/${repository}` }
  })
}

export async function produceStagingImages(config, runId, readAws, docker, now = () => new Date()) {
  const aws = (service, operation, args = []) => readAws([service, operation, ...args, '--region', REGION, '--output', 'json', '--no-cli-pager'])
  const identity = await aws('sts', 'get-caller-identity')
  check(identity.Account === ACCOUNT && identity.Arn?.startsWith(`arn:aws:sts::${ACCOUNT}:assumed-role/${config.build_role_arn.split('/').at(-1)}/`), 'staging build assumed role rejected')
  const plan = stagingImageBuildPlan(config, runId)
  // Resolve every repository before building/pushing any image. No bootstrap or
  // mutable-tag workaround when the regional repositories have not been created.
  for (const repository of [...new Set(plan.map(item => item.repository))]) {
    const response = await aws('ecr', 'describe-repositories', ['--registry-id', ACCOUNT, '--repository-names', repository])
    check(response.repositories?.length === 1)
    const found = response.repositories[0]
    check(found.registryId === ACCOUNT && found.repositoryName === repository && found.repositoryUri === `${REGISTRY}/${repository}`
      && found.repositoryArn === `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/${repository}`
      && found.imageTagMutability === 'IMMUTABLE' && found.imageScanningConfiguration?.scanOnPush === true
      && found.encryptionConfiguration?.encryptionType === (repository.startsWith('staging/') ? 'AES256' : 'KMS'), 'staging build repository rejected')
  }
  await docker('login', [])
  const images = []
  for (const item of plan) {
    const tagged = `${item.repository_uri}:${item.tag}`
    await docker('build', ['build', '--pull', '--platform', item.platform, '--file', item.dockerfile,
      ...(item.target ? ['--target', item.target] : []), ...Object.entries(item.build_args).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`]),
      '--label', `org.opencontainers.image.revision=${config.source_sha}`, '--label', `org.opencontainers.image.source=https://github.com/${REPOSITORY}`,
      '--tag', tagged, item.context])
    const local = duplicateKeyJson.parse(await docker('inspect', ['image', 'inspect', tagged]), false)
    check(Array.isArray(local) && local.length === 1 && local[0].Architecture === item.platform.split('/')[1] && local[0].Os === 'linux'
      && local[0].RepoTags?.includes(tagged) && local[0].Config?.Labels?.['org.opencontainers.image.revision'] === config.source_sha,
    'staging build local image platform or source rejected')
    await docker('push', ['push', tagged])
    const response = await aws('ecr', 'describe-images', ['--registry-id', ACCOUNT, '--repository-name', item.repository, '--image-ids', `imageTag=${item.tag}`])
    check(response.imageDetails?.length === 1)
    const found = response.imageDetails[0]
    check(found.registryId === ACCOUNT && found.repositoryName === item.repository && /^sha256:[a-f0-9]{64}$/.test(found.imageDigest)
      && found.imageTags?.includes(item.tag) && Number.isSafeInteger(found.imageSizeInBytes) && found.imageSizeInBytes > 0, 'staging build image receipt rejected')
    images.push({ component: item.component, repository_uri: item.repository_uri, digest: found.imageDigest,
      image_uri: `${item.repository_uri}@${found.imageDigest}`, size_bytes: found.imageSizeInBytes,
      platform: item.platform, built_at: now().toISOString(), tag: item.tag, dockerfile: item.dockerfile,
      target: item.target, broker_base_images: item.component === 'signing-broker' ? item.build_args : undefined })
  }
  return { schema_version: 'hid.staging-image-build-result/v1', environment: 'staging', source_sha: config.source_sha,
    workflow_sha: config.workflow_sha, aws_account_id: ACCOUNT, aws_region: REGION, run_id: runId, run_attempt: '1',
    build_kind: config.build_kind, images, recorded_at: now().toISOString(),
    release_admission: 'NOT_PERFORMED', deployment_authorized: false, production: 'LOCKED',
    still_required: ['independent-sbom-scan-and-provenance-evidence', 'signed-release-bundle-and-TUF-admission', 'protected-deployment-approval'] }
}

export async function stagingBuildPreflight(context, get = fetch) {
  const read = async (url, token) => {
    check(typeof token === 'string' && token.length > 0)
    const response = await get(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      redirect: 'error', signal: AbortSignal.timeout(30000) })
    check(response.ok)
    const bytes = await response.text(); check(Buffer.byteLength(bytes) <= 131072)
    return duplicateKeyJson.parse(bytes, false)
  }
  verifyStagingBuildPolicy(await read(`https://api.github.com/repos/${REPOSITORY}/environments/staging-build`, context.GH_BUILD_READ_TOKEN))
  const url = new URL(context.ACTIONS_ID_TOKEN_REQUEST_URL)
  check(url.protocol === 'https:' && url.hostname.endsWith('.actions.githubusercontent.com') && !url.username && !url.password && !url.hash)
  url.searchParams.set('audience', 'sts.amazonaws.com')
  const response = await read(url, context.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
  check(typeof response.value === 'string' && response.value.split('.').length === 3)
  verifyStagingBuildClaims(duplicateKeyJson.parse(Buffer.from(response.value.split('.')[1], 'base64url').toString(), false), context)
}

async function main() {
  const context = process.env, [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['preflight', 'build'].includes(mode))
  check(resolve(context.RUNNER_TEMP) === await realpath(context.RUNNER_TEMP))
  const config = validateStagingBuildConfig(await readFile(resolve(context.RUNNER_TEMP, 'staging-build-config.json'), 'utf8'), context.BUILD_CONFIG_SHA256, context)
  check(process.platform === 'linux' && process.arch === (config.build_kind === 'applications' ? 'arm64' : 'x64'), 'staging build native runner architecture rejected')
  const command = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 1048576,
    timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'], ...options })
  check(command('git', ['rev-parse', 'HEAD']).trim() === config.workflow_sha)
  check(!command('git', ['status', '--porcelain', '--untracked-files=no']).trim(), 'staging build workflow tree is dirty')
  const source = resolve('source')
  check(source === await realpath(source) && command('git', ['rev-parse', 'HEAD'], { cwd: source }).trim() === config.source_sha)
  check(!command('git', ['status', '--porcelain', '--untracked-files=all', '--ignored'], { cwd: source }).trim(), 'staging build source tree is dirty')
  await stagingBuildPreflight(context)
  if (mode === 'preflight') { process.stdout.write('Staging build source, owner policy and workload prechecks passed.\n'); return }
  const readAws = args => duplicateKeyJson.parse(command('aws', args), false)
  const dockerConfig = resolve(context.RUNNER_TEMP, 'staging-build-docker')
  await mkdir(dockerConfig, { mode: 0o700 })
  // Docker receives an isolated config and build context. Never pass AWS/GitHub
  // credentials as build arguments, secrets, or files within that context.
  const docker = async (operation, args) => {
    if (operation === 'login') {
      const password = command('aws', ['ecr', 'get-login-password', '--region', REGION, '--no-cli-pager'])
      command('docker', ['--config', dockerConfig, 'login', '--username', 'AWS', '--password-stdin', REGISTRY], { input: password, stdio: ['pipe', 'pipe', 'ignore'] })
    } else return command('docker', ['--config', dockerConfig, ...args], { cwd: source, timeout: 2700000, maxBuffer: 16777216 })
  }
  try {
    const result = await produceStagingImages(config, context.GITHUB_RUN_ID, readAws, docker)
    result.configuration_sha256 = context.BUILD_CONFIG_SHA256
    await writeFile(resolve(context.RUNNER_TEMP, 'staging-image-build.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } finally {
    try { command('docker', ['--config', dockerConfig, 'logout', REGISTRY]) }
    finally { await rm(dockerConfig, { recursive: true, force: true }) }
  }
  process.stdout.write('Staging image digest receipt written. Release admission and deployment remain separate gates.\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Staging image build rejected. Credentials and provider responses are not logged.\n'); process.exitCode = 1 })
}
