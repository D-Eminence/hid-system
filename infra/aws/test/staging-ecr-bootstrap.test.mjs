import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { environmentConfig } from '../src/config.js'
import { HidRegionalStack } from '../src/hid-regional-stack.js'
import { buildStagingEcrBootstrap, prepareStagingEcrBootstrap } from '../scripts/prepare-staging-ecr-bootstrap.mjs'

function synthesizedStagingTemplate() {
  const app = new App()
  const stack = new HidRegionalStack(app, 'StagingEcrBootstrapTest', {
    configuration: environmentConfig('staging', 'economy'),
  })
  return {
    Description: 'HID staging private data and independently deployable ECS/Fargate runtimes',
    ...Template.fromStack(stack).toJSON(),
  }
}

function repositoryEntries(template) {
  return Object.entries(template.Resources).filter(([, resource]) => resource.Type === 'AWS::ECR::Repository')
}

test('bootstrap retains exactly the synthesized staging ECR resources and URI outputs', () => {
  const full = synthesizedStagingTemplate()
  const bootstrap = buildStagingEcrBootstrap(full)
  const repositories = repositoryEntries(full)
  const outputs = Object.entries(full.Outputs).filter(([id]) => id.endsWith('RepositoryUri'))
  assert.equal(repositories.length, 11)
  assert.equal(outputs.length, 11)
  assert.equal(Object.keys(bootstrap.Resources).length, 11)
  assert.equal(Object.keys(bootstrap.Outputs).length, 11)
  assert.deepEqual(Object.keys(bootstrap.Parameters), ['BootstrapVersion'])
  assert.deepEqual(Object.keys(bootstrap.Rules), ['CheckBootstrapVersion'])
  for (const [id, resource] of repositories) assert.deepEqual(bootstrap.Resources[id], resource)
  for (const [id, output] of outputs) assert.deepEqual(bootstrap.Outputs[id], output)
  assert.match(bootstrap.Description, /ECR bootstrap only/)
  assert.equal(bootstrap.Resources.IdentityApiRepositoryA33249E9.Properties.EncryptionConfiguration, undefined)
})

test('bootstrap refuses mutable, dependent, or incorrectly wired repository inputs', () => {
  const mutations = [
    template => { template.Resources.IdentityApiRepositoryA33249E9.Properties.EmptyOnDelete = true },
    template => { template.Resources.IdentityApiRepositoryA33249E9.DependsOn = 'UnrelatedResource' },
    template => { template.Resources.IdentityApiRepositoryA33249E9.Properties.RepositoryName = 'production/hid/identity-api' },
    template => { template.Outputs.IdentityApiRepositoryUri.Value = { Ref: 'UnrelatedResource' } },
    template => { delete template.Outputs.IdentityApiRepositoryUri },
    ...[{ Ref: 'MissingParameter' }, { 'Fn::GetAtt': ['MissingResource', 'Arn'] },
      { 'Fn::Sub': '${MissingParameter}' }, { 'Fn::Join': ['', ['constant']] }].map(intrinsic => template => {
      template.Resources.IdentityApiRepositoryA33249E9.Properties.Tags = [{ Key: 'example', Value: intrinsic }]
    }),
    template => { template.Parameters.BootstrapVersion.Default = '/another-bootstrap/version' },
    template => {
      template.Rules.CheckBootstrapVersion.Assertions[0].Assert = { 'Fn::Equals': [{ Ref: 'MissingParameter' }, '6'] }
    },
    template => { template.Rules.CheckBootstrapVersion.RuleCondition = { Ref: 'MissingParameter' } },
  ]
  for (const mutate of mutations) {
    const full = synthesizedStagingTemplate()
    mutate(full)
    assert.throws(() => buildStagingEcrBootstrap(full), /Staging ECR bootstrap rejected/)
  }
})

test('later full-stack resources may depend on retained repositories without entering the bootstrap', () => {
  const full = synthesizedStagingTemplate()
  const [id, resource] = Object.entries(full.Resources).find(([, value]) => value.Type !== 'AWS::ECR::Repository')
  resource.DependsOn = 'IdentityApiRepositoryA33249E9'
  const bootstrap = buildStagingEcrBootstrap(full)
  assert.equal(bootstrap.Resources[id], undefined)
  assert.equal(Object.keys(bootstrap.Resources).length, 11)
})

test('offline preparation writes new private files and never claims authorization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hid-ecr-bootstrap-'))
  try {
    const fullPath = join(directory, 'full.json')
    const templatePath = join(directory, 'bootstrap.json')
    const reviewPath = join(directory, 'review.json')
    const fullBytes = Buffer.from(` \n${JSON.stringify(synthesizedStagingTemplate(), null, 2)}\n`)
    await writeFile(fullPath, fullBytes)
    const summary = await prepareStagingEcrBootstrap(fullPath, templatePath, reviewPath)
    assert.equal(summary.repository_count, 11)
    assert.equal(summary.cloud_calls, false)
    assert.equal(summary.deployment_authorized, false)
    assert.equal((await stat(templatePath)).mode & 0o777, 0o600)
    assert.equal((await stat(reviewPath)).mode & 0o777, 0o600)
    const review = JSON.parse(await readFile(reviewPath, 'utf8'))
    assert.equal(review.source_template_sha256, createHash('sha256').update(fullBytes).digest('hex'))
    assert.equal(review.bootstrap_template_sha256,
      createHash('sha256').update(await readFile(templatePath)).digest('hex'))
    assert.equal(review.stack_name, 'Hid-staging-Regional')
    assert.equal(review.expected_full_update_new_resource_count,
      Object.keys(synthesizedStagingTemplate().Resources).length - 11)
    assert.equal(review.reviewed_source_sha, null)
    assert.equal(review.reviewed_source_sha_required_before_execution, true)
    assert.equal(review.source_checkout_verified, false)
    assert.equal(review.expansion_contract.length, 6)
    assert.ok(review.expansion_contract.some(item => item.includes(`add exactly ${review.expected_full_update_new_resource_count} resources`)))
    await assert.rejects(prepareStagingEcrBootstrap(fullPath, templatePath, join(directory, 'second-review.json')))
    await assert.rejects(stat(join(directory, 'second-review.json')), { code: 'ENOENT' })
    await assert.rejects(prepareStagingEcrBootstrap(fullPath, join(directory, 'invalid-source.json'),
      join(directory, 'invalid-source-review.json'), { reviewedSourceSha: 'a'.repeat(40) }), /source approval cannot be supplied/)
    await assert.rejects(stat(join(directory, 'invalid-source.json')), { code: 'ENOENT' })
    await assert.rejects(stat(join(directory, 'invalid-source-review.json')), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('offline preparation rejects duplicate JSON keys before creating either output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hid-ecr-bootstrap-'))
  try {
    const fullPath = join(directory, 'full.json')
    const templatePath = join(directory, 'bootstrap.json')
    const reviewPath = join(directory, 'review.json')
    const full = JSON.stringify(synthesizedStagingTemplate())
    await writeFile(fullPath, full.replace('{', '{"Description":"duplicate",'))
    await assert.rejects(prepareStagingEcrBootstrap(fullPath, templatePath, reviewPath), /duplicat/i)
    await assert.rejects(stat(templatePath), { code: 'ENOENT' })
    await assert.rejects(stat(reviewPath), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('offline preparation removes both new outputs when receipt writing fails', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'hid-ecr-bootstrap-'))
  try {
    const fullPath = join(directory, 'full.json')
    const templatePath = join(directory, 'bootstrap.json')
    const reviewPath = join(directory, 'review.json')
    await writeFile(fullPath, JSON.stringify(synthesizedStagingTemplate()))
    const realOpen = fsPromises.open
    context.mock.method(fsPromises, 'open', async (path, ...options) => {
      const handle = await realOpen(path, ...options)
      if (path === reviewPath && (options[0] & constants.O_CREAT)) {
        context.mock.method(handle, 'writeFile', async () => {
          throw Object.assign(new Error('injected receipt write failure'), { code: 'ENOSPC' })
        })
      }
      return handle
    })
    syncBuiltinESMExports()
    await assert.rejects(prepareStagingEcrBootstrap(fullPath, templatePath, reviewPath), { code: 'ENOSPC' })
    await assert.rejects(stat(templatePath), { code: 'ENOENT' })
    await assert.rejects(stat(reviewPath), { code: 'ENOENT' })
  } finally {
    context.mock.restoreAll()
    syncBuiltinESMExports()
    await rm(directory, { recursive: true, force: true })
  }
})

test('offline preparation preserves a receipt created by another writer after preflight', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'hid-ecr-bootstrap-'))
  try {
    const fullPath = join(directory, 'full.json')
    const templatePath = join(directory, 'bootstrap.json')
    const reviewPath = join(directory, 'review.json')
    await writeFile(fullPath, JSON.stringify(synthesizedStagingTemplate()))
    const realOpen = fsPromises.open
    context.mock.method(fsPromises, 'open', async (path, ...options) => {
      const handle = await realOpen(path, ...options)
      if (path === templatePath && (options[0] & constants.O_CREAT)) {
        await writeFile(reviewPath, 'another writer', { flag: 'wx' })
      }
      return handle
    })
    syncBuiltinESMExports()
    await assert.rejects(prepareStagingEcrBootstrap(fullPath, templatePath, reviewPath), { code: 'EEXIST' })
    assert.equal(await readFile(reviewPath, 'utf8'), 'another writer')
    await assert.rejects(stat(templatePath), { code: 'ENOENT' })
  } finally {
    context.mock.restoreAll()
    syncBuiltinESMExports()
    await rm(directory, { recursive: true, force: true })
  }
})

test('offline preparation rejects equal output paths without leaving a template', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hid-ecr-bootstrap-'))
  try {
    const fullPath = join(directory, 'full.json')
    const outputPath = join(directory, 'output.json')
    await writeFile(fullPath, JSON.stringify(synthesizedStagingTemplate()))
    await assert.rejects(prepareStagingEcrBootstrap(fullPath, outputPath, join(directory, '.', 'output.json')), /must be distinct/)
    await assert.rejects(stat(outputPath), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('offline preparation preserves an existing receipt without creating a template', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hid-ecr-bootstrap-'))
  try {
    const fullPath = join(directory, 'full.json')
    const templatePath = join(directory, 'bootstrap.json')
    const reviewPath = join(directory, 'review.json')
    await writeFile(fullPath, JSON.stringify(synthesizedStagingTemplate()))
    await writeFile(reviewPath, 'existing review')
    await assert.rejects(prepareStagingEcrBootstrap(fullPath, templatePath, reviewPath), /must not already exist/)
    assert.equal(await readFile(reviewPath, 'utf8'), 'existing review')
    await assert.rejects(stat(templatePath), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
