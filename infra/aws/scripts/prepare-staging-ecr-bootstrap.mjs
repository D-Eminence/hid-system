#!/usr/bin/env node
// Generates an offline review template only. It never reads credentials, calls AWS,
// creates a stack, pushes an image, or changes an existing file.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseStrictJsonBytes } from '../../../release/scripts/verify-release-contract.mjs'

const expectedRepositoryNames = Object.freeze([
  'staging/hid/identity-api', 'staging/hid/ehr-api', 'staging/hid/lab-api',
  'staging/hid/pharmacy-api', 'staging/hid/ocr-api', 'staging/hid/ocr-worker',
  'staging/hid/outreach-api', 'staging/hid/notification-api',
  'staging/hid/notification-worker', 'staging/hid/event-dispatcher',
  'staging/hid/gateway',
])
const expectedTopLevelKeys = Object.freeze(['Description', 'Outputs', 'Parameters', 'Resources', 'Rules'])
const bootstrapDescription = 'HID staging ECR bootstrap only; expand this same stack with the reviewed full regional template before runtime use'

function reject(condition, message) {
  assert.ok(condition, `Staging ECR bootstrap rejected: ${message}`)
}

function record(value, label) {
  reject(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value
}

function exactKeys(value, keys, label) {
  record(value, label)
  reject(Object.keys(value).sort().join(',') === [...keys].sort().join(','), `${label} has unexpected keys`)
}

function rejectIntrinsics(value, label) {
  if (Array.isArray(value)) {
    for (const item of value) rejectIntrinsics(item, label)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    reject(key !== 'Ref' && !key.startsWith('Fn::'), `${label} must not contain CloudFormation intrinsics`)
    rejectIntrinsics(item, label)
  }
}

function repositoryEntries(template) {
  return Object.entries(record(template.Resources, 'Resources'))
    .filter(([, resource]) => record(resource, 'resource').Type === 'AWS::ECR::Repository')
}

function validateRepository(id, repository) {
  const resource = record(repository, `Resources.${id}`)
  const properties = record(resource.Properties, `Resources.${id}.Properties`)
  reject(typeof properties.RepositoryName === 'string' && expectedRepositoryNames.includes(properties.RepositoryName),
    `Resources.${id} has an unexpected repository name`)
  reject(properties.EmptyOnDelete === false, `Resources.${id} must not empty images on deletion`)
  reject(properties.ImageTagMutability === 'IMMUTABLE', `Resources.${id} must retain immutable tags`)
  reject(record(properties.ImageScanningConfiguration, `Resources.${id}.Properties.ImageScanningConfiguration`).ScanOnPush === true,
    `Resources.${id} must scan images on push`)
  reject(resource.DeletionPolicy === 'Retain' && resource.UpdateReplacePolicy === 'Retain',
    `Resources.${id} must retain the repository on deletion or replacement`)
  reject(properties.EncryptionConfiguration === undefined,
    `Resources.${id} must preserve the reviewed default AES-256 encryption configuration`)
  reject(properties.RepositoryPolicyText === undefined, `Resources.${id} must not add a repository policy during bootstrap`)
  reject(resource.DependsOn === undefined && resource.Condition === undefined,
    `Resources.${id} must not depend on a non-ECR resource or condition`)
  rejectIntrinsics(resource, `Resources.${id}`)
  return properties.RepositoryName
}

function outputEntries(template) {
  return Object.entries(record(template.Outputs, 'Outputs'))
    .filter(([id]) => id.endsWith('RepositoryUri'))
}

function validateOutput(id, output, repositoryIds) {
  const value = record(output, `Outputs.${id}`)
  exactKeys(value, ['Value'], `Outputs.${id}`)
  const join = record(value.Value, `Outputs.${id}.Value`)
  exactKeys(join, ['Fn::Join'], `Outputs.${id}.Value`)
  reject(Array.isArray(join['Fn::Join']) && join['Fn::Join'].length === 2 && join['Fn::Join'][0] === '',
    `Outputs.${id} must use the canonical ECR URI join`)
  const parts = join['Fn::Join'][1]
  reject(Array.isArray(parts) && parts.length === 7
    && parts[1] === '.dkr.ecr.' && parts[3] === '.' && parts[5] === '/',
  `Outputs.${id} must use the canonical ECR URI literals`)
  const getRepositoryArn = (part, selectIndex, label) => {
    const select = record(part, label)
    exactKeys(select, ['Fn::Select'], label)
    reject(Array.isArray(select['Fn::Select']) && select['Fn::Select'].length === 2 && select['Fn::Select'][0] === selectIndex,
      `${label} must select the expected ECR ARN segment`)
    const split = record(select['Fn::Select'][1], `${label}.Fn::Select[1]`)
    exactKeys(split, ['Fn::Split'], `${label}.Fn::Select[1]`)
    reject(Array.isArray(split['Fn::Split']) && split['Fn::Split'].length === 2 && split['Fn::Split'][0] === ':',
      `${label} must split an ECR ARN`)
    const getAtt = record(split['Fn::Split'][1], `${label}.Fn::Split[1]`)
    exactKeys(getAtt, ['Fn::GetAtt'], `${label}.Fn::Split[1]`)
    reject(Array.isArray(getAtt['Fn::GetAtt']) && getAtt['Fn::GetAtt'].length === 2
      && repositoryIds.has(getAtt['Fn::GetAtt'][0]) && getAtt['Fn::GetAtt'][1] === 'Arn',
    `${label} must use an ECR repository ARN`)
    return getAtt['Fn::GetAtt'][0]
  }
  const accountRepository = getRepositoryArn(parts[0], 4, `Outputs.${id}.Value.Fn::Join[1][0]`)
  const regionRepository = getRepositoryArn(parts[2], 3, `Outputs.${id}.Value.Fn::Join[1][2]`)
  const suffix = record(parts[4], `Outputs.${id}.Value.Fn::Join[1][4]`)
  const name = record(parts[6], `Outputs.${id}.Value.Fn::Join[1][6]`)
  exactKeys(suffix, ['Ref'], `Outputs.${id}.Value.Fn::Join[1][4]`)
  exactKeys(name, ['Ref'], `Outputs.${id}.Value.Fn::Join[1][6]`)
  reject(suffix.Ref === 'AWS::URLSuffix', `Outputs.${id} must use AWS::URLSuffix`)
  reject(accountRepository === regionRepository && regionRepository === name.Ref,
    `Outputs.${id} must derive one URI from one ECR repository`)
  return name.Ref
}

/**
 * Produce a narrowly scoped initial CloudFormation template for the exact
 * application ECR repositories emitted by the staging regional CDK stack.
 * The caller must later use the full template to update the *same* stack.
 */
export function buildStagingEcrBootstrap(fullTemplate) {
  exactKeys(fullTemplate, expectedTopLevelKeys, 'full template')
  const repositories = repositoryEntries(fullTemplate)
  reject(repositories.length === expectedRepositoryNames.length, 'expected exactly eleven application ECR repositories')
  const names = repositories.map(([id, value]) => validateRepository(id, value))
  reject(new Set(names).size === expectedRepositoryNames.length, 'repository names must be unique')
  reject([...names].sort().join(',') === [...expectedRepositoryNames].sort().join(','),
    'repository names do not match the fixed staging application set')

  const repositoryIds = new Set(repositories.map(([id]) => id))
  const outputs = outputEntries(fullTemplate)
  reject(outputs.length === repositories.length, 'expected one RepositoryUri output for each ECR repository')
  const outputTargets = outputs.map(([id, value]) => validateOutput(id, value, repositoryIds))
  reject(new Set(outputTargets).size === repositories.length, 'each ECR repository must have exactly one URI output')
  reject([...outputTargets].sort().join(',') === [...repositoryIds].sort().join(','),
    'RepositoryUri outputs do not cover exactly the staging ECR repositories')

  const parameters = record(fullTemplate.Parameters, 'Parameters')
  const rules = record(fullTemplate.Rules, 'Rules')
  reject(Object.hasOwn(parameters, 'BootstrapVersion') && Object.hasOwn(rules, 'CheckBootstrapVersion'),
    'the CDK bootstrap parameter and rule are required')
  const versionParameter = parameters.BootstrapVersion
  exactKeys(versionParameter, ['Type', 'Default', 'Description'], 'Parameters.BootstrapVersion')
  reject(versionParameter.Type === 'AWS::SSM::Parameter::Value<String>'
    && versionParameter.Default === '/cdk-bootstrap/hnb659fds/version'
    && typeof versionParameter.Description === 'string',
  'BootstrapVersion must use the fixed CDK bootstrap SSM version parameter')
  const versionRule = rules.CheckBootstrapVersion
  exactKeys(versionRule, ['Assertions'], 'Rules.CheckBootstrapVersion')
  reject(Array.isArray(versionRule.Assertions) && versionRule.Assertions.length === 1,
    'CheckBootstrapVersion must contain exactly the CDK version assertion')
  const versionAssertion = versionRule.Assertions[0]
  exactKeys(versionAssertion, ['Assert', 'AssertDescription'], 'Rules.CheckBootstrapVersion.Assertions[0]')
  reject(typeof versionAssertion.AssertDescription === 'string', 'CDK version assertion description must be a string')
  assert.deepEqual(versionAssertion.Assert,
    { 'Fn::Not': [{ 'Fn::Contains': [['1', '2', '3', '4', '5'], { Ref: 'BootstrapVersion' }] }] },
    'Staging ECR bootstrap rejected: CheckBootstrapVersion must use only the retained BootstrapVersion parameter and require version 6')

  const bootstrap = {
    Description: bootstrapDescription,
    Parameters: { BootstrapVersion: structuredClone(parameters.BootstrapVersion) },
    Resources: Object.fromEntries(repositories.map(([id, value]) => [id, structuredClone(value)])),
    Outputs: Object.fromEntries(outputs.map(([id, value]) => [id, structuredClone(value)])),
    Rules: { CheckBootstrapVersion: structuredClone(rules.CheckBootstrapVersion) },
  }
  const bootstrapRepositories = repositoryEntries(bootstrap)
  const bootstrapOutputs = outputEntries(bootstrap)
  reject(bootstrapRepositories.length === repositories.length && bootstrapOutputs.length === outputs.length,
    'bootstrap template completeness check failed')
  for (const [id, value] of repositories) {
    reject(JSON.stringify(bootstrap.Resources[id]) === JSON.stringify(value), `Resources.${id} was changed`)
  }
  for (const [id, value] of outputs) {
    reject(JSON.stringify(bootstrap.Outputs[id]) === JSON.stringify(value), `Outputs.${id} was changed`)
  }
  reject(JSON.stringify(bootstrap.Parameters.BootstrapVersion) === JSON.stringify(parameters.BootstrapVersion),
    'BootstrapVersion parameter was changed')
  reject(JSON.stringify(bootstrap.Rules.CheckBootstrapVersion) === JSON.stringify(rules.CheckBootstrapVersion),
    'CheckBootstrapVersion rule was changed')
  return bootstrap
}

async function preflightOutputPaths(paths) {
  const absolutePaths = paths.map(path => resolve(path))
  reject(new Set(absolutePaths).size === paths.length, 'bootstrap and review output paths must be distinct')
  for (const absolute of absolutePaths) {
    const parent = dirname(absolute)
    const parentStat = await lstat(parent)
    reject(parentStat.isDirectory() && !parentStat.isSymbolicLink(), `${parent} must be a real directory`)
    const realParent = await realpath(parent)
    reject(resolve(realParent, basename(absolute)) === absolute, 'output path must be directly inside its real parent directory')
    const existing = await lstat(absolute).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    reject(existing === null, 'output paths must not already exist')
  }
  return absolutePaths
}

async function writeNewFiles(entries) {
  const created = []
  try {
    // Reserve both outputs before writing either. O_EXCL also closes the race
    // between preflight and creation without overwriting another process's file.
    for (const [path, bytes] of entries) {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const entry = { path, bytes, handle, metadata: null, closed: false }
      created.push(entry)
      entry.metadata = await handle.stat()
    }
    for (const entry of created) {
      await entry.handle.chmod(0o600)
      await entry.handle.writeFile(entry.bytes)
      await entry.handle.sync()
    }
    for (const entry of created) {
      await entry.handle.close()
      entry.closed = true
    }
  } catch (error) {
    for (const entry of created) {
      if (!entry.closed) await entry.handle.close().catch(() => {})
      // Remove only the files this operation created, never an existing or
      // subsequently replaced output. A failed identity check leaves it intact.
      if (entry.metadata) {
        const current = await lstat(entry.path).catch(() => null)
        if (current?.dev === entry.metadata.dev && current?.ino === entry.metadata.ino) {
          await unlink(entry.path).catch(() => {})
        }
      }
    }
    throw error
  }
}

export async function prepareStagingEcrBootstrap(fullTemplatePath, bootstrapPath, reviewPath) {
  reject(arguments.length === 3, 'source approval cannot be supplied to this offline preparation tool')
  const [bootstrapOutputPath, reviewOutputPath] = await preflightOutputPaths([bootstrapPath, reviewPath])
  const fullPath = resolve(fullTemplatePath)
  const fullBytes = await readStableFile(fullPath)
  const fullTemplate = parseStrictJsonBytes(fullBytes)
  const bootstrap = buildStagingEcrBootstrap(fullTemplate)
  const bootstrapBytes = Buffer.from(`${JSON.stringify(bootstrap, null, 2)}\n`)
  const repositories = repositoryEntries(bootstrap).map(([logicalId, resource]) => ({
    logical_id: logicalId,
    repository_name: resource.Properties.RepositoryName,
  }))
  const receipt = {
    schema_version: 'hid.staging-ecr-bootstrap-review/v1',
    created_at: new Date().toISOString(),
    environment: 'staging',
    stack_name: 'Hid-staging-Regional',
    source_template_sha256: createHash('sha256').update(fullBytes).digest('hex'),
    bootstrap_template_sha256: createHash('sha256').update(bootstrapBytes).digest('hex'),
    reviewed_source_sha: null,
    reviewed_source_sha_required_before_execution: true,
    source_checkout_verified: false,
    full_template_resource_count: Object.keys(fullTemplate.Resources).length,
    bootstrap_resource_count: repositories.length,
    expected_full_update_new_resource_count: Object.keys(fullTemplate.Resources).length - repositories.length,
    full_template_parameter_count: Object.keys(fullTemplate.Parameters).length,
    full_template_output_count: Object.keys(fullTemplate.Outputs).length,
    repositories,
    repository_uri_outputs: outputEntries(bootstrap).map(([logicalId]) => logicalId),
    cloud_calls: false,
    deployment_authorized: false,
    production: 'LOCKED',
    expansion_contract: [
      'Do not create this bootstrap template while the Fargate quota request is pending.',
      'Before any later create, verify Hid-staging-Regional is absent; never apply this reduced template to an existing full stack.',
      'Create only the reviewed bootstrap template with the same Hid-staging-Regional stack name, then build real digest-qualified images.',
      'Expand only by updating that same stack with the reviewed full regional template, reviewed source SHA, and real image parameters.',
      `Require the full-stack change set to add exactly ${Object.keys(fullTemplate.Resources).length - repositories.length} resources from this input template and make no ECR modify, replacement, delete, import, or adoption action.`,
      'Never import, delete, replace, empty, or re-create these repositories during the expansion.',
    ],
  }
  const reviewBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)
  await writeNewFiles([[bootstrapOutputPath, bootstrapBytes], [reviewOutputPath, reviewBytes]])
  return {
    schema_version: receipt.schema_version,
    environment: receipt.environment,
    repository_count: repositories.length,
    expected_full_update_new_resource_count: receipt.expected_full_update_new_resource_count,
    source_template_sha256: receipt.source_template_sha256,
    bootstrap_template_sha256: receipt.bootstrap_template_sha256,
    cloud_calls: false,
    deployment_authorized: false,
  }
}

async function readStableFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    reject(metadata.isFile() && metadata.size > 0 && metadata.size <= 2 * 1024 * 1024, 'source template must be a regular file up to 2 MiB')
    const bytes = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      reject(bytesRead > 0, 'source template changed while being read')
      offset += bytesRead
    }
    const trailing = Buffer.alloc(1)
    reject((await handle.read(trailing, 0, 1, offset)).bytesRead === 0, 'source template grew while being read')
    return bytes
  } finally {
    await handle.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [fullTemplatePath, bootstrapPath, reviewPath, ...extra] = process.argv.slice(2)
    reject(fullTemplatePath && bootstrapPath && reviewPath && extra.length === 0,
      'usage: prepare-staging-ecr-bootstrap.mjs FULL_TEMPLATE NEW_BOOTSTRAP_TEMPLATE NEW_REVIEW_RECEIPT')
    process.stdout.write(`${JSON.stringify(await prepareStagingEcrBootstrap(fullTemplatePath, bootstrapPath, reviewPath), null, 2)}\n`)
  } catch {
    process.stderr.write('Staging ECR bootstrap preparation rejected; no cloud operation was performed.\n')
    process.exitCode = 1
  }
}
