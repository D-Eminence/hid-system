import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { validateStagingBuildConfig, verifyStagingBuildPolicy, verifyStagingBuildClaims,
  stagingImageBuildPlan, produceStagingImages, stagingBuildPreflight } from '../scripts/build-staging-images.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const config = () => ({ schema_version: 'hid.staging-image-build/v1', environment: 'staging', source_sha: 'a'.repeat(40),
  workflow_sha: 'b'.repeat(40), caller_workflow_path: '.github/workflows/tuf-staging-release.yml',
  aws_account_id: '659225405023', aws_region: 'eu-west-1',
  build_role_arn: 'arn:aws:iam::659225405023:role/Hid-staging-ReleaseTrust-BuildRole-test', build_kind: 'applications' })
const context = () => ({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'D-Eminence/hid-system', GITHUB_REPOSITORY_ID: '1317340803',
  GITHUB_REPOSITORY_OWNER_ID: '182018869', GITHUB_REF: 'refs/heads/tuf-production-release', GITHUB_REF_TYPE: 'branch',
  GITHUB_REF_PROTECTED: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_RUN_ATTEMPT: '1',
  APPROVED_SOURCE_SHA: config().source_sha, GITHUB_SHA: config().source_sha, GITHUB_WORKFLOW_SHA: config().source_sha,
  REQUESTED_SOURCE_SHA: config().source_sha, REQUESTED_BUILD_KIND: 'applications', RUNNER_ARCH: 'ARM64', APPROVED_WORKFLOW_SHA: config().workflow_sha, BUILD_ROLE_ARN: config().build_role_arn,
  GITHUB_WORKFLOW_REF: 'D-Eminence/hid-system/.github/workflows/tuf-staging-release.yml@refs/heads/tuf-production-release',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '123', GITHUB_ACTOR_ID: '182018869' })
const policy = () => ({ id: 1, name: 'staging-build', can_admins_bypass: false,
  deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
  protection_rules: [{ type: 'required_reviewers', prevent_self_review: false,
    reviewers: [{ type: 'User', reviewer: { id: 182018869, login: 'D-Eminence' } }] }] })
const now = 1750000000000
const claims = () => ({ iss: 'https://token.actions.githubusercontent.com', aud: 'sts.amazonaws.com', repository: 'D-Eminence/hid-system',
  repository_id: '1317340803', repository_owner_id: '182018869', ref: context().GITHUB_REF, ref_type: 'branch',
  environment: 'staging-build', sub: 'repo:D-Eminence/hid-system:environment:staging-build', sha: config().source_sha,
  job_workflow_ref: `D-Eminence/hid-system/.github/workflows/tuf-build.yml@${config().workflow_sha}`, job_workflow_sha: config().workflow_sha,
  runner_environment: 'github-hosted', run_id: '123', run_attempt: '1', actor_id: '182018869', event_name: 'workflow_dispatch',
  workflow_ref: context().GITHUB_WORKFLOW_REF, iat: now / 1000 - 1, exp: now / 1000 + 299 })
const validate = (value = config(), ctx = context()) => {
  const bytes = JSON.stringify(value); return validateStagingBuildConfig(bytes, hash(bytes), ctx)
}

test('separate immutable tooling and source pins are accepted; cross-scope and ambiguous inputs fail closed', () => {
  assert.deepEqual(validate(), config())
  for (const patch of [{ environment: 'production' }, { aws_account_id: '111122223333' }, { aws_region: 'us-east-1' },
    { source_sha: 'main' }, { workflow_sha: 'a'.repeat(39) }, { caller_workflow_path: '.github/workflows/production.yml' },
    { build_role_arn: config().build_role_arn.replace('staging', 'production') }, { build_kind: 'all' }, { secret: 'not-allowed' }]) {
    assert.throws(() => validate({ ...config(), ...patch }))
  }
  const bytes = JSON.stringify(config())
  assert.throws(() => validateStagingBuildConfig(bytes, 'f'.repeat(64), context()))
  const duplicate = bytes.replace('"environment":"staging"', '"environment":"staging","environment":"staging"')
  assert.throws(() => validateStagingBuildConfig(duplicate, hash(duplicate), context()))
  for (const [key, value] of Object.entries(context())) {
    assert.throws(() => validate(config(), { ...context(), [key]: `${value}-changed` }), key)
  }
  assert.throws(() => validate(config(), { ...context(), GITHUB_HEAD_REF: 'attacker' }))
})

test('owner protection and OIDC workload reject role reuse, wrong owner, reruns and stale tokens', () => {
  verifyStagingBuildPolicy(policy()); verifyStagingBuildClaims(claims(), context(), now)
  for (const mutate of [p => { p.can_admins_bypass = true }, p => { p.name = 'staging' },
    p => { p.deployment_branch_policy.protected_branches = false }, p => { p.protection_rules = [] },
    p => { p.protection_rules[0].reviewers[0].reviewer.id = 2 }]) {
    const value = policy(); mutate(value); assert.throws(() => verifyStagingBuildPolicy(value))
  }
  for (const [key, value] of Object.entries(claims())) {
    assert.throws(() => verifyStagingBuildClaims({ ...claims(), [key]: typeof value === 'number' ? 0 : `${value}-changed` }, context(), now), key)
  }
})

function harness(options = {}) {
  const c = { ...config(), ...options.config }, calls = [], plan = stagingImageBuildPlan(c, '123')
  const read = async args => {
    calls.push(['aws', ...args])
    const [service, operation] = args
    assert.equal(args[args.indexOf('--region') + 1], 'eu-west-1')
    if (service === 'sts') return { Account: options.wrongAccount ? '111122223333' : '659225405023',
      Arn: `arn:aws:sts::659225405023:assumed-role/${c.build_role_arn.split('/').at(-1)}/session` }
    if (operation === 'describe-repositories') {
      if (options.missingRepository) throw Error('missing repository')
      const name = args[args.indexOf('--repository-names') + 1]
      return { repositories: [{ registryId: '659225405023', repositoryName: name,
        repositoryUri: `659225405023.dkr.ecr.eu-west-1.amazonaws.com/${name}`,
        repositoryArn: `arn:aws:ecr:eu-west-1:659225405023:repository/${name}`,
        imageTagMutability: options.mutable ? 'MUTABLE' : 'IMMUTABLE', imageScanningConfiguration: { scanOnPush: true },
        encryptionConfiguration: { encryptionType: name.startsWith('staging/') ? 'AES256' : 'KMS' } }] }
    }
    assert.equal(operation, 'describe-images')
    const tag = args[args.indexOf('--image-ids') + 1].slice('imageTag='.length)
    return { imageDetails: [{ registryId: '659225405023', repositoryName: args[args.indexOf('--repository-name') + 1],
      imageDigest: options.badDigest ? 'latest' : `sha256:${hash(tag)}`, imageTags: [tag], imageSizeInBytes: 1000 }] }
  }
  const docker = async (operation, args) => {
    calls.push(['docker', operation, ...args])
    if (operation === 'inspect') return JSON.stringify([{ Architecture: options.wrongPlatform ? (c.build_kind === 'applications' ? 'amd64' : 'arm64') : (c.build_kind === 'applications' ? 'arm64' : 'amd64'), Os: 'linux',
      RepoTags: [args.at(-1)], Config: { Labels: { 'org.opencontainers.image.revision': c.source_sha } } }])
  }
  return { calls, plan, run: () => produceStagingImages(c, '123', read, docker, () => new Date(now)) }
}

test('application producer resolves 12 real outputs across 11 repositories and keeps migration target distinct', async () => {
  const h = harness(), result = await h.run()
  assert.equal(result.images.length, 12)
  assert.ok(result.images.every(image => image.platform === 'linux/arm64'))
  assert.equal(new Set(result.images.map(item => item.repository_uri)).size, 11)
  assert.equal(new Set(result.images.map(item => item.digest)).size, 12)
  assert.equal(result.images.at(-1).target, 'migration')
  assert.equal(result.images.at(-1).dockerfile, 'services/ehr-api/Dockerfile')
  assert.equal(result.images.at(-1).repository_uri, result.images[1].repository_uri)
  assert.equal(result.deployment_authorized, false)
  assert.equal(result.release_admission, 'NOT_PERFORMED')
  const firstDocker = h.calls.findIndex(call => call[0] === 'docker')
  assert.equal(firstDocker, 12) // STS plus ALL 11 repository checks before any Docker operation.
  assert.equal(h.calls.filter(call => call[0] === 'docker' && call[1] === 'push').length, 12)
  assert.ok(result.images.every(image => image.image_uri.endsWith(image.digest)))
  assert.ok(h.calls.filter(call => call[0] === 'aws').every(call => ['get-caller-identity', 'describe-repositories', 'describe-images'].includes(call[2])))
})

test('broker build remains separate and pins its two mandatory base images', async () => {
  const h = harness({ config: { build_kind: 'signing-broker' } }), result = await h.run()
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].platform, 'linux/amd64')
  assert.equal(result.images[0].repository_uri, '659225405023.dkr.ecr.eu-west-1.amazonaws.com/hid-staging-tuf-signing-broker')
  const build = h.calls.find(call => call[1] === 'build')
  assert.equal(build.at(-1), 'tools/tuf-release')
  assert.equal(build.filter(value => value === '--build-arg').length, 2)
  assert.ok(Object.values(result.images[0].broker_base_images).every(value => /@sha256:[a-f0-9]{64}$/.test(value)))
  const dockerfile = await readFile(new URL('../../tools/tuf-release/Dockerfile.signing-broker', import.meta.url), 'utf8')
  for (const base of Object.values(result.images[0].broker_base_images)) assert.ok(dockerfile.includes(base))
})

test('missing repositories, mutable repositories or wrong AWS identity cannot start a build', async () => {
  for (const options of [{ missingRepository: true }, { mutable: true }, { wrongAccount: true }]) {
    const h = harness(options); await assert.rejects(h.run)
    assert.equal(h.calls.filter(call => call[0] === 'docker').length, 0)
  }
})

test('wrong local platform cannot be pushed and registry digest failure cannot emit a success receipt', async () => {
  for (const build_kind of ['applications', 'signing-broker']) {
    const h = harness({ config: { build_kind }, wrongPlatform: true }); await assert.rejects(h.run)
    assert.equal(h.calls.filter(call => call[1] === 'push').length, 0)
  }
  await assert.rejects(harness({ badDigest: true }).run)
})

test('credential preflight refuses non-GitHub OIDC URL before releasing an ID token', async () => {
  const calls = []
  await assert.rejects(() => stagingBuildPreflight({ GH_BUILD_READ_TOKEN: 'test-token', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://attacker.invalid/token' },
    async url => { calls.push(url); return { ok: true, text: async () => JSON.stringify(policy()) } }))
  assert.equal(calls.length, 1)
  assert.equal(calls[0], 'https://api.github.com/repos/D-Eminence/hid-system/environments/staging-build')
})

test('workflow confines build authority to reusable owner-approved staging environment with pinned actions', async () => {
  const source = await readFile(new URL('../../.github/workflows/tuf-build.yml', import.meta.url), 'utf8'), w = parse(source)
  assert.deepEqual(Object.keys(w.on), ['workflow_call'])
  assert.equal(w.jobs.build.environment, 'staging-build')
  assert.equal(w.on.workflow_call.inputs.build_kind.required, true)
  assert.equal(w.jobs.build.env.REQUESTED_BUILD_KIND, '${{ inputs.build_kind }}')
  assert.equal(w.jobs.build['runs-on'], "${{ inputs.build_kind == 'applications' && 'ubuntu-24.04-arm' || 'ubuntu-24.04' }}")
  assert.equal(w.jobs.build.permissions['id-token'], 'write')
  const steps = w.jobs.build.steps
  assert.ok(steps.filter(step => step.uses).every(step => /^[^@]+@[a-f0-9]{40}$/.test(step.uses)))
  const roleIndex = steps.findIndex(step => step.uses?.startsWith('aws-actions/configure-aws-credentials@'))
  assert.ok(steps.findIndex(step => step.run === 'node release/scripts/build-staging-images.mjs preflight') < roleIndex)
  assert.ok(steps.findIndex(step => step.run === 'node release/scripts/build-staging-images.mjs build') > roleIndex)
  assert.equal(steps[roleIndex].with['allowed-account-ids'], '659225405023')
  assert.equal(steps[roleIndex].with['aws-region'], 'eu-west-1')
  assert.equal(steps.filter(step => step.uses?.startsWith('actions/checkout@')).length, 2)
  assert.ok(steps.filter(step => step.uses?.startsWith('actions/checkout@')).every(step => step.with['persist-credentials'] === false))
  assert.ok(!/workflow_dispatch:|secrets: inherit|cfn|cloudformation|cdk deploy|wrangler deploy/.test(source))
})


test('image platforms agree with existing ECS and broker runtime contracts', async () => {
  const regional = await readFile(new URL('../../infra/aws/src/hid-regional-stack.ts', import.meta.url), 'utf8')
  const tasks = [...regional.matchAll(/runtimePlatform: \{ cpuArchitecture: ecs\.CpuArchitecture\.([A-Z0-9_]+)/g)]
  assert.equal(tasks.length, 2) // Shared service constructor and separate migration task.
  assert.ok(tasks.every(match => match[1] === 'ARM64'))
  assert.ok(stagingImageBuildPlan(config(), '123').every(item => item.platform === 'linux/arm64'))
  const brokerDockerfile = await readFile(new URL('../../tools/tuf-release/Dockerfile.signing-broker', import.meta.url), 'utf8')
  assert.match(brokerDockerfile, /GOARCH=amd64/)
  assert.equal(stagingImageBuildPlan({ ...config(), build_kind: 'signing-broker' }, '123')[0].platform, 'linux/amd64')
})
