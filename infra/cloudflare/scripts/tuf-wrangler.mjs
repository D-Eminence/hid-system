import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import duplicateKeyJson from 'json-dup-key-validator'
import { validateTufRepositoryDirectory } from './tuf-repository-layout.mjs'
import { obtainPublicationAuthorization, publicationBinding, validatePublicationAuthorization } from './tuf-publication-authorization.mjs'

const cloudflareRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const deployments = new Set(['staging', 'production'])
const VERSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const SHA256 = /^[a-f0-9]{64}$/
const CANONICAL_TIME = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{3})?Z$/
const RELEASE_ID = /^r[0-9]{10}-g[a-f0-9]{40}$/
const WRANGLER_VERSION = '4.127.1'
const WRANGLER_BIN_SHA256 = '780661a508810f3b65786895b1ca9aacbc4f55d329ae6b8c1e49ec8433569f77'
const WRANGLER_CLI_SHA256 = 'ba531de00d3c21615f3d523df4e83a94d487de68d77225aa703463b6a2979406'

function usage() {
  return [
    'Usage:',
    '  tuf-wrangler.mjs dry-run DEPLOYMENT ABSOLUTE_REPOSITORY',
    '  tuf-wrangler.mjs versions-upload DEPLOYMENT ABSOLUTE_REPOSITORY ABSOLUTE_UPLOAD_RECEIPT',
    '  tuf-wrangler.mjs versions-deploy DEPLOYMENT ABSOLUTE_REPOSITORY ABSOLUTE_UPLOAD_RECEIPT ABSOLUTE_PREVIEW_EVIDENCE ABSOLUTE_DEPLOY_RECEIPT CONFIRMATION',
    '  tuf-wrangler.mjs bootstrap-parent DEPLOYMENT ABSOLUTE_BOOTSTRAP_RECEIPT CONFIRMATION',
    '  tuf-wrangler.mjs activate-route DEPLOYMENT ABSOLUTE_REPOSITORY ABSOLUTE_DEPLOY_RECEIPT ABSOLUTE_ROUTE_RECEIPT CONFIRMATION',
  ].join('\n')
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function exactKeys(value, required, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...required].sort())) {
    throw new Error(`${label} has missing or unexpected properties`)
  }
  return value
}

function exactTime(value, label) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  const normalized = typeof value === 'string' && !value.includes('.') ? value.replace('Z', '.000Z') : value
  if (typeof value !== 'string' || !CANONICAL_TIME.test(value) || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== normalized) {
    throw new Error(`${label} must be a canonical UTC timestamp`)
  }
  return parsed
}

async function readBoundedFile(path, maximum = 1048576) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) {
    throw new Error(`security-sensitive input path must be canonical and symlink-free: ${path}`)
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum) throw new Error(`${path} is not a bounded regular file`)
    const bytes = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) throw new Error(`${path} changed while being read`)
      offset += bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new Error(`${path} grew while being read`)
    return bytes
  } finally {
    await handle.close()
  }
}

async function prepareReceiptDestination(path, repository) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error('receipt output path must be canonical and absolute')
  }
  if (repository && (path === resolve(repository) || path.startsWith(`${resolve(repository)}${sep}`))) {
    throw new Error('receipt output must be outside the repository')
  }
  const existing = await lstat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (existing) throw new Error('receipt output already exists')
  let ancestor = dirname(path)
  while (true) {
    const stat = await lstat(ancestor).catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (stat) {
      if (!stat.isDirectory() || await realpath(ancestor) !== ancestor) {
        throw new Error('receipt ancestors must be symlink-free directories')
      }
      break
    }
    ancestor = dirname(ancestor)
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  if (await realpath(dirname(path)) !== dirname(path)) throw new Error('receipt parent changed during preflight')
  await access(dirname(path), constants.W_OK | constants.X_OK)
}

async function writeExclusiveReceipt(path, body, validate = (receipt) => receipt) {
  const receipt = { ...body, receipt_sha256: sha256(canonicalize(body)) }
  validate(receipt)
  await prepareReceiptDestination(path)
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
      if (bytesWritten === 0) throw new Error('short write while recording Wrangler evidence')
      offset += bytesWritten
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
  const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    await parent.sync()
  } finally {
    await parent.close()
  }
  return receipt
}

function expectedWorker(deployment) {
  return `hid-tuf-${deployment}`
}

function expectedHost(deployment) {
  return deployment === 'production'
    ? 'updates.healthidentitydirectory.com'
    : 'updates.staging.healthidentitydirectory.com'
}

function validateReceiptHash(receipt, label) {
  if (!SHA256.test(receipt.receipt_sha256 ?? '')) throw new Error(`${label} receipt hash is invalid`)
  const { receipt_sha256: claimed, ...body } = receipt
  if (sha256(canonicalize(body)) !== claimed) throw new Error(`${label} receipt hash does not match its content`)
}

export function validateUploadReceipt(receipt, deployment) {
  requireDeployment(deployment)
  exactKeys(receipt, [
    'schema_version', 'action', 'deployment', 'worker_name', 'repository_sha256', 'file_count',
    'root_version', 'targets_version', 'snapshot_version', 'timestamp_version', 'version_id',
    'preview_url', 'uploaded_at', 'wrangler_version', 'receipt_sha256', 'publication_authorization',
  ], 'upload receipt')
  if (receipt.schema_version !== '2.0.0' || receipt.action !== 'version-upload') throw new Error('upload receipt schema/action is invalid')
  if (receipt.deployment !== deployment || receipt.worker_name !== expectedWorker(deployment)) throw new Error('upload receipt deployment identity is invalid')
  if (!SHA256.test(receipt.repository_sha256) || !VERSION_ID.test(receipt.version_id)) throw new Error('upload receipt hash/version ID is invalid')
  if (!Number.isSafeInteger(receipt.file_count) || receipt.file_count < 5 || receipt.file_count > 20000) throw new Error('upload receipt file count is invalid')
  for (const role of ['root_version', 'targets_version', 'snapshot_version', 'timestamp_version']) {
    if (!Number.isSafeInteger(receipt[role]) || receipt[role] < 1) throw new Error(`upload receipt ${role} is invalid`)
  }
  const preview = new URL(receipt.preview_url)
  const prefix = `${receipt.version_id.slice(0, 8)}-${expectedWorker(deployment)}.`
  if (preview.protocol !== 'https:' || preview.username !== '' || preview.password !== ''
    || preview.port !== '' || preview.pathname !== '/' || preview.search !== '' || preview.hash !== ''
    || !preview.hostname.startsWith(prefix) || !preview.hostname.endsWith('.workers.dev')) {
    throw new Error('upload receipt preview URL is not the exact versioned Worker preview')
  }
  exactTime(receipt.uploaded_at, 'upload receipt uploaded_at')
  if (receipt.wrangler_version !== WRANGLER_VERSION) throw new Error('upload receipt Wrangler version is not pinned')
  validatePublicationAuthorization(receipt.publication_authorization, {
    deployment, repositorySha256: receipt.repository_sha256, fileCount: receipt.file_count,
    rootVersion: receipt.root_version, targetsVersion: receipt.targets_version,
    snapshotVersion: receipt.snapshot_version, timestampVersion: receipt.timestamp_version,
  }, null)
  const authorization = receipt.publication_authorization.authorization
  if (Date.parse(receipt.uploaded_at) < Date.parse(authorization.authorized_at)
    || Date.parse(receipt.uploaded_at) >= Date.parse(authorization.expires_at)) {
    throw new Error('upload receipt is outside its publication authorization window')
  }
  validateReceiptHash(receipt, 'upload')
  return receipt
}

export function validateDeployReceipt(receipt, deployment, repositorySha256) {
  requireDeployment(deployment)
  exactKeys(receipt, [
    'schema_version', 'action', 'deployment', 'worker_name', 'repository_sha256',
    'version_id', 'traffic_percentage', 'upload_receipt_sha256', 'preview_evidence_sha256',
    'release_id', 'artifact_set_sha256', 'deployment_id', 'deployed_at',
    'wrangler_version', 'receipt_sha256', 'publication_authorization',
  ], 'deployment receipt')
  if (receipt.schema_version !== '2.0.0' || receipt.action !== 'version-deploy') throw new Error('deployment receipt schema/action is invalid')
  if (receipt.deployment !== deployment || receipt.worker_name !== expectedWorker(deployment)) throw new Error('deployment receipt identity is invalid')
  if (!SHA256.test(repositorySha256) || receipt.repository_sha256 !== repositorySha256) throw new Error('deployment receipt repository generation is invalid')
  if (!VERSION_ID.test(receipt.version_id) || !VERSION_ID.test(receipt.deployment_id)) throw new Error('deployment receipt version/deployment ID is invalid')
  if (receipt.traffic_percentage !== 100) throw new Error('deployment receipt does not bind 100 percent traffic')
  if (!SHA256.test(receipt.upload_receipt_sha256) || !SHA256.test(receipt.preview_evidence_sha256)
    || !RELEASE_ID.test(receipt.release_id) || !SHA256.test(receipt.artifact_set_sha256)) {
    throw new Error('deployment receipt release evidence is invalid')
  }
  exactTime(receipt.deployed_at, 'deployment receipt deployed_at')
  if (receipt.wrangler_version !== WRANGLER_VERSION) throw new Error('deployment receipt Wrangler version is not pinned')
  const authorization = receipt.publication_authorization
  validatePublicationAuthorization(authorization, {
    deployment, repositorySha256, fileCount: authorization?.file_count,
    ...Object.fromEntries(['root', 'targets', 'snapshot', 'timestamp'].map((role) => [
      `${role}Version`, authorization?.authorization?.candidate?.[role]?.version,
    ])),
  }, null)
  if (receipt.release_id !== authorization.authorization.release_id) {
    throw new Error('deployment receipt release differs from its publication authorization')
  }
  if (Date.parse(receipt.deployed_at) < Date.parse(authorization.authorization.authorized_at)
    || Date.parse(receipt.deployed_at) >= Date.parse(authorization.authorization.expires_at)) {
    throw new Error('deployment receipt is outside its publication authorization window')
  }
  validateReceiptHash(receipt, 'deployment')
  return receipt
}

function validatePreviewEvidence(evidence, upload, deployment, now = new Date()) {
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)
    || evidence.schema_version !== '1.0.0' || !SHA256.test(evidence.admission_record_sha256 ?? '')) {
    throw new Error('preview evidence schema/hash is invalid')
  }
  const { admission_record_sha256: claimed, ...body } = evidence
  if (sha256(canonicalize(body)) !== claimed) throw new Error('preview evidence admission hash does not match its content')
  const admitted = exactTime(evidence.admitted_at, 'preview evidence admitted_at')
  const uploaded = exactTime(upload.uploaded_at, 'upload receipt uploaded_at')
  if (admitted < uploaded || admitted > now.getTime() + 300000) throw new Error('preview admission must occur after upload and not in the future')
  if (evidence.deployment_plan?.environment !== deployment
    || evidence.bundle_target !== `environments/${deployment}/releases/${evidence.deployment_plan?.release_id}/release-bundle.json`
    || !SHA256.test(evidence.client_sha256 ?? '') || !SHA256.test(evidence.deployment_plan?.plan_sha256 ?? '')
    || !SHA256.test(evidence.deployment_plan?.artifact_set_sha256 ?? '')
    || !Array.isArray(evidence.verified_target_files) || evidence.verified_target_files.length === 0
    || !Array.isArray(evidence.frontend_directories) || evidence.frontend_directories.length !== 7) {
    throw new Error('preview evidence does not contain a complete admitted deployment plan')
  }
  const origin = upload.preview_url.slice(0, -1)
  if (evidence.trust?.repository_id !== `hid-${deployment}-preview-${upload.version_id.slice(0, 8)}`
    || evidence.trust?.metadata_url !== `${origin}/metadata`
    || evidence.trust?.targets_url !== `${origin}/targets`
    || !SHA256.test(evidence.trust?.configuration_sha256 ?? '')
    || evidence.trust?.trusted_root_sha256 !== upload.publication_authorization.authorization.bootstrap_root_sha256) {
    throw new Error('preview evidence is not bound to the uploaded version URL and pinned root')
  }
  for (const role of ['root', 'targets', 'snapshot', 'timestamp']) {
    if (!Number.isSafeInteger(evidence.tuf_metadata?.[role]?.version)
      || evidence.tuf_metadata[role].version < 1
      || evidence.tuf_metadata[role].version !== upload[`${role}_version`]
      || !Number.isFinite(Date.parse(evidence.tuf_metadata[role].expires))) {
      throw new Error(`preview evidence has invalid ${role} metadata state`)
    }
  }
  if (evidence.deployment_plan.release_id !== upload.publication_authorization.authorization.release_id) {
    throw new Error('preview evidence release differs from the broker-authorized publication')
  }
  return evidence
}

async function readWranglerOutput(path, expectedType) {
  const lines = (await readBoundedFile(path, 1048576)).toString('utf8').trim().split('\n')
  if (lines.length !== 1) throw new Error('Wrangler emitted an ambiguous output record')
  const record = duplicateKeyJson.parse(lines[0], false)
  if (record?.type !== expectedType || record.version !== 1) throw new Error(`Wrangler did not emit a ${expectedType} v1 record`)
  return record
}

async function verifyPinnedWrangler(wrangler) {
  const packageRoot = resolve(cloudflareRoot, 'node_modules', 'wrangler')
  const binPath = resolve(packageRoot, 'bin', 'wrangler.js')
  const cliPath = resolve(packageRoot, 'wrangler-dist', 'cli.js')
  const manifest = duplicateKeyJson.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'), false)
  if (manifest.version !== WRANGLER_VERSION) throw new Error('installed Wrangler version does not match the audited pin')
  if (process.platform !== 'win32' && await realpath(wrangler) !== binPath) {
    throw new Error('local Wrangler executable does not resolve to the audited package binary')
  }
  const [binBytes, cliBytes] = await Promise.all([readFile(binPath), readFile(cliPath)])
  if (sha256(binBytes) !== WRANGLER_BIN_SHA256 || sha256(cliBytes) !== WRANGLER_CLI_SHA256) {
    throw new Error('installed Wrangler executable does not match the audited 4.127.1 bytes')
  }
}

async function executeWrangler(command, temporaryDirectory, options) {
  const wrangler = options.wranglerPath
    ?? resolve(cloudflareRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler')
  await access(wrangler, constants.X_OK).catch(() => {
    throw new Error('Pinned Wrangler is not installed; run npm ci in infra/cloudflare before this command')
  })
  if (options.spawn === undefined) await verifyPinnedWrangler(wrangler)
  const outputPath = resolve(temporaryDirectory, 'wrangler-output.ndjson')
  const result = (options.spawn ?? spawnSync)(wrangler, command, {
    cwd: cloudflareRoot,
    env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outputPath },
    stdio: 'inherit',
    timeout: 240000,
    killSignal: 'SIGKILL',
  })
  if (result.error || result.status !== 0) throw new Error(`Wrangler command failed: ${command.slice(0, 2).join(' ')}; reconcile the external outcome before any retry`)
  return outputPath
}

async function isolatedRepository(repository, temporaryDirectory) {
  const isolated = resolve(temporaryDirectory, 'repository')
  await mkdir(isolated, { mode: 0o700 })
  for (const file of repository.files) {
    const bytes = await readBoundedFile(resolve(repository.repository, file.path), 25 * 1024 * 1024)
    if (bytes.length !== file.length || sha256(bytes) !== file.sha256) throw new Error('repository changed while making the publication copy')
    const destination = resolve(isolated, file.path)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o400 })
  }
  const validated = await validateTufRepositoryDirectory(isolated, repository.deployment)
  if (validated.repositorySha256 !== repository.repositorySha256) throw new Error('isolated publication copy differs from the validated repository')
  return validated
}

function requireAuthorizationWindow(authorization, options) {
  if ((options.now ?? new Date()).getTime() >= Date.parse(authorization.authorization.expires_at)) {
    throw new Error('publication authorization expired during Wrangler execution; external outcome requires reconciliation')
  }
}

function requireSamePublicationAuthorization(previous, current) {
  if (canonicalize(publicationBinding(previous)) !== canonicalize(publicationBinding(current))) {
    throw new Error('durable publication state or protected operator changed after upload; uploaded version must remain unpromoted')
  }
}

async function generatedConfig(deployment, repository, temporaryDirectory) {
  const workerDirectory = resolve(cloudflareRoot, 'workers', `hid-tuf-${deployment}`)
  const sourceConfig = duplicateKeyJson.parse(await readFile(resolve(workerDirectory, 'wrangler.json'), 'utf8'), false)
  sourceConfig.$schema = resolve(cloudflareRoot, 'node_modules', 'wrangler', 'config-schema.json')
  sourceConfig.main = resolve(workerDirectory, sourceConfig.main)
  sourceConfig.assets.directory = repository.repository
  const path = resolve(temporaryDirectory, 'wrangler.json')
  await writeFile(path, `${JSON.stringify(sourceConfig, null, 2)}\n`, { mode: 0o600 })
  return path
}

function requireDeployment(value) {
  if (!deployments.has(value)) throw new Error(usage())
}

export async function runTufWrangler(argv, options = {}) {
  const [mode, deployment, ...args] = argv
  requireDeployment(deployment)

  if (mode === 'bootstrap-parent') {
    if (args.length !== 2) throw new Error(usage())
    const [receiptPath, confirmation] = args
    if (confirmation !== `create-inaccessible-${expectedWorker(deployment)}-parent`) throw new Error('bootstrap confirmation does not match the exact inaccessible parent Worker')
    await prepareReceiptDestination(receiptPath)
    if (typeof options.beforeEffect !== 'function') {
      throw new Error('bootstrap parent creation requires a committed protected publication intent')
    }
    const temporaryDirectory = await mkdtemp(join(tmpdir(), `hid-tuf-${deployment}-bootstrap-`))
    try {
      const configPath = resolve(temporaryDirectory, 'wrangler.json')
      await writeFile(configPath, `${JSON.stringify({
        $schema: resolve(cloudflareRoot, 'node_modules', 'wrangler', 'config-schema.json'),
        name: expectedWorker(deployment),
        main: resolve(cloudflareRoot, 'src', 'tuf-bootstrap-worker.mjs'),
        compatibility_date: '2026-08-31',
        workers_dev: false,
        preview_urls: false,
      }, null, 2)}\n`, { mode: 0o600 })
      // This callback is the journal CAS boundary. It must immediately precede
      // the provider call; the CLI entry point cannot supply or bypass it.
      await options.beforeEffect()
      const output = await readWranglerOutput(await executeWrangler([
        'deploy', '--strict', '--fail-if-worker-name-taken', '--config', configPath,
      ], temporaryDirectory, options), 'deploy')
      if (output.worker_name !== expectedWorker(deployment) || !VERSION_ID.test(output.version_id ?? '')
        || output.worker_name_overridden !== false || !Array.isArray(output.targets) || output.targets.length !== 0) {
        throw new Error('Wrangler bootstrap output has the wrong Worker/version/targets')
      }
      exactTime(output.timestamp, 'Wrangler bootstrap timestamp')
      return writeExclusiveReceipt(receiptPath, {
        schema_version: '1.0.0', action: 'bootstrap-parent', deployment,
        worker_name: expectedWorker(deployment), version_id: output.version_id,
        inaccessible: true, created_at: output.timestamp, wrangler_version: WRANGLER_VERSION,
      })
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }

  if (mode === 'dry-run' || mode === 'versions-upload') {
    if (args.length !== (mode === 'dry-run' ? 1 : 2)) throw new Error(usage())
    const [repositoryArgument, receiptPath] = args
    if (mode === 'versions-upload') await prepareReceiptDestination(receiptPath, repositoryArgument)
    let repository = await validateTufRepositoryDirectory(repositoryArgument, deployment)
    const temporaryDirectory = await mkdtemp(join(tmpdir(), `hid-tuf-${deployment}-`))
    try {
      if (mode === 'dry-run') {
        const config = await generatedConfig(deployment, repository, temporaryDirectory)
        await executeWrangler(['deploy', '--dry-run', '--config', config], temporaryDirectory, options)
        return repository
      }
      repository = await isolatedRepository(repository, temporaryDirectory)
      const config = await generatedConfig(deployment, repository, temporaryDirectory)
      const authorization = await obtainPublicationAuthorization(repository, options)
      const output = await readWranglerOutput(await executeWrangler([
        'versions', 'upload', '--strict', '--tag', `generation-${repository.repositorySha256.slice(0, 32)}`,
        '--message', `${deployment} TUF generation ${repository.repositorySha256}`, '--config', config,
      ], temporaryDirectory, options), 'version-upload')
      requireAuthorizationWindow(authorization, options)
      const afterUpload = await validateTufRepositoryDirectory(repository.repository, deployment)
      if (afterUpload.repositorySha256 !== repository.repositorySha256) throw new Error('isolated repository changed during upload; uploaded version requires reconciliation')
      if (output.worker_name !== expectedWorker(deployment) || !VERSION_ID.test(output.version_id ?? '')
        || typeof output.preview_url !== 'string' || output.worker_name_overridden !== false) {
        throw new Error('Wrangler upload did not return an exact Worker version and preview URL')
      }
      exactTime(output.timestamp, 'Wrangler upload timestamp')
      const receipt = await writeExclusiveReceipt(receiptPath, {
        schema_version: '2.0.0', action: 'version-upload', deployment,
        worker_name: expectedWorker(deployment), repository_sha256: repository.repositorySha256,
        file_count: repository.fileCount, root_version: repository.rootVersion,
        targets_version: repository.targetsVersion, snapshot_version: repository.snapshotVersion,
        timestamp_version: repository.timestampVersion, version_id: output.version_id,
        preview_url: output.preview_url, uploaded_at: output.timestamp, wrangler_version: WRANGLER_VERSION,
        publication_authorization: authorization,
      }, (receipt) => validateUploadReceipt(receipt, deployment))
      validateUploadReceipt(receipt, deployment)
      return receipt
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }

  if (mode === 'versions-deploy') {
    if (args.length !== 5) throw new Error(usage())
    const [repositoryArgument, uploadReceiptPath, previewEvidencePath, deployReceiptPath, confirmation] = args
    await prepareReceiptDestination(deployReceiptPath, repositoryArgument)
    const repository = await validateTufRepositoryDirectory(repositoryArgument, deployment)
    const uploadBytes = await readBoundedFile(uploadReceiptPath)
    const upload = validateUploadReceipt(duplicateKeyJson.parse(uploadBytes.toString('utf8'), false), deployment)
    if (upload.repository_sha256 !== repository.repositorySha256 || upload.file_count !== repository.fileCount
      || upload.root_version !== repository.rootVersion || upload.targets_version !== repository.targetsVersion
      || upload.snapshot_version !== repository.snapshotVersion || upload.timestamp_version !== repository.timestampVersion) {
      throw new Error('repository generation changed after version upload')
    }
    if (confirmation !== `deploy-${expectedWorker(deployment)}-${upload.version_id}-at-100-percent`) throw new Error('deployment confirmation does not bind the exact version at 100 percent')
    const previewBytes = await readBoundedFile(previewEvidencePath, 16777216)
    const preview = validatePreviewEvidence(duplicateKeyJson.parse(previewBytes.toString('utf8'), false), upload, deployment, options.now)
    const temporaryDirectory = await mkdtemp(join(tmpdir(), `hid-tuf-${deployment}-deploy-`))
    try {
      const config = await generatedConfig(deployment, repository, temporaryDirectory)
      const authorization = await obtainPublicationAuthorization(repository, options)
      requireSamePublicationAuthorization(upload.publication_authorization, authorization)
      const output = await readWranglerOutput(await executeWrangler([
        'versions', 'deploy', '--version-id', upload.version_id, '--percentage', '100', '--yes',
        '--message', `${deployment} verified TUF generation ${repository.repositorySha256}`, '--config', config,
      ], temporaryDirectory, options), 'version-deploy')
      requireAuthorizationWindow(authorization, options)
      if (output.worker_name !== expectedWorker(deployment) || !VERSION_ID.test(output.deployment_id ?? '')) {
        throw new Error('Wrangler deployment output has the wrong identity')
      }
      const deployedAt = exactTime(output.timestamp, 'Wrangler deployment timestamp')
      if (deployedAt < exactTime(preview.admitted_at, 'preview evidence admitted_at')
        || deployedAt > (options.now instanceof Date ? options.now.getTime() : Date.now()) + 300000) {
        throw new Error('Wrangler deployment timestamp is outside the admitted deployment window')
      }
      const receipt = await writeExclusiveReceipt(deployReceiptPath, {
        schema_version: '2.0.0', action: 'version-deploy', deployment,
        worker_name: expectedWorker(deployment), repository_sha256: repository.repositorySha256,
        version_id: upload.version_id, traffic_percentage: 100,
        upload_receipt_sha256: sha256(uploadBytes), preview_evidence_sha256: sha256(previewBytes),
        release_id: preview.deployment_plan.release_id,
        artifact_set_sha256: preview.deployment_plan.artifact_set_sha256,
        deployment_id: output.deployment_id, deployed_at: output.timestamp,
        wrangler_version: WRANGLER_VERSION,
        publication_authorization: authorization,
      }, (receipt) => validateDeployReceipt(receipt, deployment, repository.repositorySha256))
      return validateDeployReceipt(receipt, deployment, repository.repositorySha256)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }

  if (mode === 'activate-route') {
    if (args.length !== 4) throw new Error(usage())
    const [repositoryArgument, deployReceiptPath, routeReceiptPath, confirmation] = args
    await prepareReceiptDestination(routeReceiptPath, repositoryArgument)
    const repository = await validateTufRepositoryDirectory(repositoryArgument, deployment)
    const deployBytes = await readBoundedFile(deployReceiptPath)
    const deploy = validateDeployReceipt(
      duplicateKeyJson.parse(deployBytes.toString('utf8'), false),
      deployment,
      repository.repositorySha256,
    )
    if (confirmation !== `activate-${expectedHost(deployment)}-for-${deploy.version_id}`) throw new Error('route confirmation does not bind the exact host and deployed version')
    const temporaryDirectory = await mkdtemp(join(tmpdir(), `hid-tuf-${deployment}-route-`))
    try {
      const config = await generatedConfig(deployment, repository, temporaryDirectory)
      const authorization = await obtainPublicationAuthorization(repository, options)
      requireSamePublicationAuthorization(deploy.publication_authorization, authorization)
      await executeWrangler(['triggers', 'deploy', '--config', config], temporaryDirectory, options)
      requireAuthorizationWindow(authorization, options)
      return writeExclusiveReceipt(routeReceiptPath, {
        schema_version: '1.0.0', action: 'activate-route', deployment,
        worker_name: expectedWorker(deployment), hostname: expectedHost(deployment),
        repository_sha256: repository.repositorySha256, version_id: deploy.version_id,
        deployment_receipt_sha256: sha256(deployBytes), activated_at: new Date().toISOString(),
        wrangler_version: WRANGLER_VERSION,
      })
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }

  throw new Error(usage())
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTufWrangler(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify({ status: 'completed', action: process.argv[2], deployment: result.deployment })}\n`)
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'TUF Wrangler command failed'}\n`)
    process.exitCode = 1
  })
}
