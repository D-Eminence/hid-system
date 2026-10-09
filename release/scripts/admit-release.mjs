#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  admitReleaseBundle,
  canonicalize,
  collectTargetReferences,
  deriveDeploymentPlan,
  loadConfiguration,
  loadStrictJson,
  verifyFrontendContentManifest,
  verifyProductionPromotionEvidence,
} from './verify-release-contract.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const SHA256 = /^[a-f0-9]{64}$/
const GIT_SHA = /^[a-f0-9]{40}$/
const RELEASE_ID = /^r[0-9]{10}-g[a-f0-9]{40}$/
const ACCOUNT_ID = /^[0-9]{12}$/
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/
const TIMESTAMP = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/
const MAX_PUBLIC_TARGET_BYTES = 26214400
const MAX_CLIENT_BYTES = 134217728
const MAX_BATCH_REQUEST_BYTES = 1048576
const MAX_BATCH_TARGETS = 512
const MAX_BATCH_TARGET_PATH_BYTES = 512
const MAX_BATCH_OUTPUT_PATH_BYTES = 4096

const REQUIRED_FLAGS = new Map([
  ['--client', 'client'],
  ['--client-sha256', 'clientSha256'],
  ['--config', 'config'],
  ['--environment', 'environment'],
  ['--release', 'releaseId'],
  ['--git-sha', 'gitSha'],
  ['--aws-account', 'awsAccountId'],
  ['--aws-region', 'awsRegion'],
  ['--admission-time', 'admissionTime'],
  ['--workspace', 'workspace'],
  ['--output', 'output'],
])

const PROMOTION_EVIDENCE = [
  ['staging_acceptance', 'staging-acceptance.json'],
  ['migration_dry_run', 'migration-dry-run.json'],
  ['staging_copy_migration', 'staging-copy-migration.json'],
  ['backup_restore', 'backup-restore.json'],
  ['rollback_drill', 'rollback-drill.json'],
  ['approval', 'approval.json'],
]

function fail(message) {
  throw new Error(message)
}

function parseArguments(arguments_) {
  if (arguments_.length !== REQUIRED_FLAGS.size * 2) {
    fail(`usage: admit-release.mjs ${[...REQUIRED_FLAGS].map(([flag]) => `${flag} VALUE`).join(' ')}`)
  }
  const values = {}
  const seen = new Set()
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index]
    const value = arguments_[index + 1]
    const key = REQUIRED_FLAGS.get(flag)
    if (key === undefined || value === undefined || value.length === 0) fail(`unknown or empty argument ${flag}`)
    if (seen.has(flag)) fail(`duplicate argument ${flag}`)
    seen.add(flag)
    values[key] = value
  }
  for (const [flag] of REQUIRED_FLAGS) {
    if (!seen.has(flag)) fail(`missing required argument ${flag}`)
  }
  return values
}

function validateIdentity(options) {
  if (!['staging', 'production'].includes(options.environment)) fail('environment must be staging or production')
  if (!SHA256.test(options.clientSha256)) fail('client SHA-256 must be 64 lowercase hexadecimal characters')
  if (!RELEASE_ID.test(options.releaseId)) fail('release must be an exact immutable HID release ID')
  if (!GIT_SHA.test(options.gitSha) || !options.releaseId.endsWith(`-g${options.gitSha}`)) {
    fail('Git SHA must be exact and match the release ID')
  }
  if (!ACCOUNT_ID.test(options.awsAccountId)) fail('AWS account must contain exactly 12 digits')
  if (!REGION.test(options.awsRegion)) fail('AWS region is invalid')
  if (!TIMESTAMP.test(options.admissionTime)
    || new Date(options.admissionTime).toISOString().replace('.000Z', 'Z') !== options.admissionTime) {
    fail('admission time must be a real whole-second UTC timestamp')
  }
}

async function readRegularNoFollow(path, maximumBytes, expectedLength, expectedSha256) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) fail(`${path} is not a regular file`)
    if (metadata.size < 1 || metadata.size > maximumBytes) fail(`${path} violates the ${maximumBytes}-byte bound`)
    if (expectedLength !== undefined && metadata.size !== expectedLength) fail(`${path} length does not match its admitted target reference`)
    const bytes = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) fail(`${path} changed or was truncated while being read`)
      offset += bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) fail(`${path} grew while being read`)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (expectedSha256 !== undefined && digest !== expectedSha256) fail(`${path} hash does not match its admitted target reference`)
    return { bytes, digest, mode: metadata.mode }
  } finally {
    await handle.close()
  }
}

function runClient(client, arguments_, timeout = 120000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(client, arguments_, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`verified client exceeded its ${timeout} ms invocation bound`))
    }, timeout)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) rejectPromise(error)
      else resolvePromise(value)
    }
    const collect = (chunks, kind) => (chunk) => {
      if (kind === 'stdout') stdoutBytes += chunk.length
      else stderrBytes += chunk.length
      if (stdoutBytes > 1048576 || stderrBytes > 1048576) {
        child.kill('SIGKILL')
        finish(new Error(`verified client ${kind} exceeded 1 MiB`))
        return
      }
      chunks.push(chunk)
    }
    child.stdout.on('data', collect(stdout, 'stdout'))
    child.stderr.on('data', collect(stderr, 'stderr'))
    child.on('error', finish)
    child.on('close', (code, signal) => {
      const output = Buffer.concat(stdout).toString('utf8')
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim()
      if (code !== 0) {
        finish(new Error(`verified client failed (${signal ?? code}): ${errorOutput || 'no diagnostic'}`))
      } else {
        finish(undefined, output)
      }
    })
  })
}

function containedPath(root, ...parts) {
  const rootPath = resolve(root)
  const candidate = resolve(rootPath, ...parts)
  if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${sep}`)) fail('derived path escaped the admission workspace')
  return candidate
}

async function writeExclusiveJson(path, value, label = 'JSON file', maximumBytes) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  if (maximumBytes !== undefined && bytes.length > maximumBytes) {
    fail(`${label} exceeds its ${maximumBytes}-byte bound`)
  }
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const handle = await open(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  )
  try {
    let offset = 0
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
      if (bytesWritten === 0) fail(`short write while sealing ${label}`)
      offset += bytesWritten
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
  const directory = await open(parent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

function createBatchRequest(workspace, references) {
  if (references.length < 1 || references.length > MAX_BATCH_TARGETS) {
    fail(`verified target count ${references.length} is outside the batch bound 1..${MAX_BATCH_TARGETS}`)
  }
  const targets = references.map((reference) => {
    const destination = containedPath(workspace, 'targets', reference.path)
    if (Buffer.byteLength(reference.path) > MAX_BATCH_TARGET_PATH_BYTES) {
      fail(`target path ${reference.path} exceeds the batch client path bound`)
    }
    if (Buffer.byteLength(destination) > MAX_BATCH_OUTPUT_PATH_BYTES) {
      fail(`target output ${destination} exceeds the batch client path bound`)
    }
    return { target: reference.path, output: destination }
  })
  return { schema_version: '1.0.0', targets }
}

export async function admit(options) {
  validateIdentity(options)
  const client = resolve(options.client)
  const config = resolve(options.config)
  const workspace = resolve(options.workspace)
  const output = resolve(options.output)
  if (workspace === output || output.startsWith(`${workspace}${sep}`)) fail('sealed output must be outside the target workspace')

  const clientEvidence = await readRegularNoFollow(client, MAX_CLIENT_BYTES)
  if (clientEvidence.digest !== options.clientSha256) fail('verified client hash does not match --client-sha256')
  if ((clientEvidence.mode & 0o111) === 0) fail('verified client is not executable')
  const configEvidence = await readRegularNoFollow(config, 64000)
  const trustConfiguration = await loadStrictJson(config, 64000)
  if (trustConfiguration.environment !== options.environment
    || typeof trustConfiguration.repository_id !== 'string'
    || typeof trustConfiguration.metadata_url !== 'string'
    || typeof trustConfiguration.targets_url !== 'string'
    || !SHA256.test(trustConfiguration.trusted_root_sha256 ?? '')) {
    fail('trust configuration identity is incomplete or does not match the requested environment')
  }
  await mkdir(workspace, { recursive: false, mode: 0o700 })
  const workspaceHandle = await open(workspace, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
  try {
    const workspaceMetadata = await workspaceHandle.stat()
    if ((workspaceMetadata.mode & 0o077) !== 0) fail('admission workspace permissions must exclude group and other access')
  } finally {
    await workspaceHandle.close()
  }

  const refreshText = await runClient(client, ['refresh', '--config', config])
  let metadataState
  try {
    metadataState = JSON.parse(refreshText)
  } catch (error) {
    throw new Error(`verified client returned invalid refresh JSON: ${error.message}`)
  }

  const bundleTarget = `environments/${options.environment}/releases/${options.releaseId}/release-bundle.json`
  const bundlePath = containedPath(workspace, 'release-bundle.json')
  await runClient(client, ['get', '--config', config, '--release', options.releaseId, '--target', bundleTarget, '--output', bundlePath])
  const bundle = await loadStrictJson(bundlePath, 16777216)
  const configuration = await loadConfiguration()
  admitReleaseBundle(bundle, configuration, {
    environment: options.environment,
    awsAccountId: options.awsAccountId,
    awsRegion: options.awsRegion,
    releaseId: options.releaseId,
    gitSha: options.gitSha,
    admissionTime: options.admissionTime,
  })

  const references = collectTargetReferences(bundle)
  const batchRequest = createBatchRequest(workspace, references)
  const batchRequestPath = containedPath(workspace, 'batch-request.json')
  await writeExclusiveJson(batchRequestPath, batchRequest, 'batch request', MAX_BATCH_REQUEST_BYTES)
  await runClient(client, [
    'get-batch',
    '--config', config,
    '--release', options.releaseId,
    '--request', batchRequestPath,
  ])

  const verifiedTargets = []
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index]
    const destination = batchRequest.targets[index].output
    await readRegularNoFollow(destination, MAX_PUBLIC_TARGET_BYTES, reference.length, reference.sha256)
    verifiedTargets.push({
      ...reference,
      local_path: relative(workspace, destination),
    })
  }

  const frontendDirectories = []
  await mkdir(containedPath(workspace, 'frontends'), { recursive: false, mode: 0o700 })
  for (const frontend of bundle.frontends) {
    const archivePath = containedPath(workspace, 'targets', frontend.archive.target.path)
    const manifestPath = containedPath(workspace, 'targets', frontend.content_manifest.path)
    const manifest = await loadStrictJson(manifestPath, frontend.content_manifest.length)
    verifyFrontendContentManifest(manifest, configuration)
    if (manifest.app !== frontend.app) fail(`frontend ${frontend.app} content manifest names ${manifest.app}`)
    if (manifest.git_sha !== bundle.release.git_sha) fail(`frontend ${frontend.app} content manifest has the wrong Git SHA`)
    if (manifest.file_count !== frontend.archive.file_count
      || manifest.total_size_bytes !== frontend.archive.uncompressed_size_bytes) {
      fail(`frontend ${frontend.app} archive summary does not match its content manifest`)
    }
    const destination = containedPath(workspace, 'frontends', frontend.app)
    await runClient(client, ['extract-frontend', '--archive', archivePath, '--manifest', manifestPath, '--output', destination])
    frontendDirectories.push({ app: frontend.app, local_path: relative(workspace, destination) })
  }

  if (bundle.environment.name === 'production') {
    const evidence = {}
    for (const [key, filename] of PROMOTION_EVIDENCE) {
      const reference = bundle.promotion.evidence[key]
      const evidencePath = containedPath(workspace, 'targets', reference.path)
      evidence[key] = await loadStrictJson(evidencePath, reference.length)
      if (!reference.path.endsWith(`/promotion/${filename}`)) fail(`promotion evidence ${key} has the wrong target filename`)
    }
    verifyProductionPromotionEvidence(bundle, evidence, options.admissionTime)
  }

  const deploymentPlan = deriveDeploymentPlan(bundle, configuration)
  const body = {
    schema_version: '1.0.0',
    admitted_at: options.admissionTime,
    client_sha256: clientEvidence.digest,
    trust: {
      configuration_sha256: configEvidence.digest,
      repository_id: trustConfiguration.repository_id,
      metadata_url: trustConfiguration.metadata_url,
      targets_url: trustConfiguration.targets_url,
      trusted_root_sha256: trustConfiguration.trusted_root_sha256,
    },
    bundle_target: bundleTarget,
    tuf_metadata: metadataState,
    deployment_plan: deploymentPlan,
    workspace,
    verified_target_files: verifiedTargets,
    frontend_directories: frontendDirectories,
  }
  const record = {
    ...body,
    admission_record_sha256: createHash('sha256').update(canonicalize(body)).digest('hex'),
  }
  await writeExclusiveJson(output, record, 'admission record')
  return record
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const record = await admit(options)
  process.stdout.write(`${JSON.stringify({
    status: 'admitted',
    environment: record.deployment_plan.environment,
    release_id: record.deployment_plan.release_id,
    artifact_set_sha256: record.deployment_plan.artifact_set_sha256,
    plan_sha256: record.deployment_plan.plan_sha256,
    admission_record_sha256: record.admission_record_sha256,
  })}\n`)
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`release admission failed closed: ${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}
