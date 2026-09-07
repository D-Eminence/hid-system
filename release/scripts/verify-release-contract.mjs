#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import duplicateKeyJson from 'json-dup-key-validator'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = resolve(dirname(scriptPath), '..', '..')
const releaseRoot = resolve(repositoryRoot, 'release')

const SHA256 = /^[a-f0-9]{64}$/
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/
const GIT_SHA = /^[a-f0-9]{40}$/
const RELEASE_ID = /^r([0-9]{10})-g([a-f0-9]{40})$/
const TIMESTAMP = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/
const SAFE_TARGET = /^environments\/(staging|production)\/releases\/r[0-9]{10}-g[a-f0-9]{40}\/[a-z0-9][a-z0-9._/-]*$/
const SAFE_ARCHIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

const OCI_COMPONENTS = [
  'identity-api', 'ehr-api', 'lab-api', 'pharmacy-api', 'ocr-api', 'ocr-worker',
  'outreach-api', 'notification-api', 'notification-worker', 'event-dispatcher',
  'gateway', 'database-migration',
]

const DEPLOYMENT_PARAMETERS = [
  'IdentityApiImageUri', 'EhrApiImageUri', 'LabApiImageUri', 'PharmacyApiImageUri',
  'OcrApiImageUri', 'OcrWorkerImageUri', 'OutreachApiImageUri',
  'NotificationApiImageUri', 'NotificationWorkerImageUri', 'EventDispatcherImageUri',
  'GatewayImageUri', 'MigrationImageUri',
]

const FRONTENDS = ['web', 'ehr', 'lab', 'pharmacy', 'ocr', 'outreach', 'admin']
const PROMOTION_EVIDENCE = [
  ['staging_acceptance', 'staging-acceptance.json'],
  ['migration_dry_run', 'migration-dry-run.json'],
  ['staging_copy_migration', 'staging-copy-migration.json'],
  ['backup_restore', 'backup-restore.json'],
  ['rollback_drill', 'rollback-drill.json'],
  ['approval', 'approval.json'],
]

const REQUIRED_GATE_CHECKS = Object.freeze({
  'staging-acceptance': ['release-bundle-admitted', 'deployment-healthy', 'frontend-canary', 'api-canary'],
  'migration-dry-run': ['migration-ledger-verified', 'dry-run-completed', 'schema-postconditions'],
  'staging-copy-migration': ['source-copy-restored', 'migration-completed', 'schema-postconditions', 'application-smoke'],
  'backup-restore': ['backup-created', 'restore-completed', 'data-integrity', 'application-smoke'],
  'rollback-drill': ['forward-rollback-release', 'rollback-deployed', 'application-smoke'],
  approval: ['all-staging-gates-bound', 'artifact-set-identical', 'production-change-approved'],
})

const MEDIA = Object.freeze({
  bundle: 'application/vnd.hid.release-bundle+json',
  archive: 'application/vnd.hid.frontend-ustar',
  contentManifest: 'application/vnd.hid.frontend-content-manifest+json',
  sbom: 'application/spdx+json',
  scan: 'application/vnd.hid.scan-summary+json',
  provenance: 'application/vnd.in-toto+jsonl',
  worker: 'text/javascript',
  migrationLedger: 'application/vnd.hid.migration-ledger+json',
  migrationVerification: 'application/vnd.hid.migration-verification+json',
  promotionEvidence: 'application/vnd.hid.promotion-evidence+json',
})

function fail(path, message) {
  throw new Error(`${path}: ${message}`)
}

function plainObject(value, path, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object')
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(path, `unexpected property ${JSON.stringify(key)}`)
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(path, `missing required property ${JSON.stringify(key)}`)
  }
  return value
}

function exact(value, expected, path) {
  if (value !== expected) fail(path, `expected ${JSON.stringify(expected)}, received ${JSON.stringify(value)}`)
}

function pattern(value, expression, path) {
  if (typeof value !== 'string' || !expression.test(value)) fail(path, `does not match ${expression}`)
}

function integer(value, minimum, maximum, path) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(path, `must be an integer from ${minimum} through ${maximum}`)
  }
}

function canonicalTime(value, path) {
  pattern(value, TIMESTAMP, path)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().replace('.000Z', 'Z') !== value) {
    fail(path, 'must be a real UTC timestamp at whole-second precision')
  }
  return parsed
}

function releaseIdentity(value, path = 'release') {
  const match = typeof value === 'string' ? RELEASE_ID.exec(value) : null
  if (!match) fail(path, 'must be r plus ten decimal sequence digits, -g, and a 40-character lowercase Git SHA')
  return { sequence: Number(match[1]), gitSha: match[2] }
}

function checkTargetRef(value, expectedPath, expectedMedia, path, maximum = 26214400) {
  plainObject(value, path, ['path', 'length', 'sha256', 'media_type'])
  pattern(value.path, SAFE_TARGET, `${path}.path`)
  exact(value.path, expectedPath, `${path}.path`)
  integer(value.length, 1, maximum, `${path}.length`)
  pattern(value.sha256, SHA256, `${path}.sha256`)
  exact(value.media_type, expectedMedia, `${path}.media_type`)
}

function checkEvidence(value, targetPath, prefix, path) {
  plainObject(value, path, ['format', 'target'])
  exact(value.format, 'SPDX-JSON', `${path}.format`)
  checkTargetRef(value.target, `${prefix}/${targetPath}`, MEDIA.sbom, `${path}.target`)
}

function checkScan(value, targetPath, prefix, path, releaseCreatedAt, admissionTime) {
  plainObject(value, path,
    ['scanner', 'scanner_version', 'completed_at', 'critical', 'high', 'decision', 'target'],
    ['exception'])
  if (typeof value.scanner !== 'string' || value.scanner.length < 1 || value.scanner.length > 64) fail(`${path}.scanner`, 'invalid scanner')
  if (typeof value.scanner_version !== 'string' || value.scanner_version.length < 1 || value.scanner_version.length > 64) fail(`${path}.scanner_version`, 'invalid scanner version')
  const completedAt = canonicalTime(value.completed_at, `${path}.completed_at`)
  if (completedAt > releaseCreatedAt) fail(`${path}.completed_at`, 'cannot be later than release.created_at')
  integer(value.critical, 0, Number.MAX_SAFE_INTEGER, `${path}.critical`)
  integer(value.high, 0, Number.MAX_SAFE_INTEGER, `${path}.high`)
  checkTargetRef(value.target, `${prefix}/${targetPath}`, MEDIA.scan, `${path}.target`)
  if (value.decision === 'pass') {
    exact(value.critical, 0, `${path}.critical`)
    exact(value.high, 0, `${path}.high`)
    if (Object.hasOwn(value, 'exception')) fail(`${path}.exception`, 'is forbidden for a passing scan')
  } else if (value.decision === 'approved_exception') {
    if (!Object.hasOwn(value, 'exception')) fail(`${path}.exception`, 'is required for an approved exception')
    const exception = plainObject(value.exception, `${path}.exception`,
      ['id', 'approved_by', 'approved_at', 'expires_at', 'issue_uri'])
    pattern(exception.id, /^[A-Z][A-Z0-9_-]{2,63}$/, `${path}.exception.id`)
    if (typeof exception.approved_by !== 'string' || exception.approved_by.length < 3 || exception.approved_by.length > 128) fail(`${path}.exception.approved_by`, 'invalid approver identity')
    const approvedAt = canonicalTime(exception.approved_at, `${path}.exception.approved_at`)
    const expiresAt = canonicalTime(exception.expires_at, `${path}.exception.expires_at`)
    if (approvedAt < completedAt) fail(`${path}.exception.approved_at`, 'cannot precede scan completion')
    if (approvedAt > releaseCreatedAt) fail(`${path}.exception.approved_at`, 'cannot be later than release creation')
    if (expiresAt <= approvedAt || expiresAt <= releaseCreatedAt || (admissionTime !== undefined && expiresAt <= admissionTime)) {
      fail(`${path}.exception.expires_at`, 'must remain valid through release admission')
    }
    if (typeof exception.issue_uri !== 'string' || !exception.issue_uri.startsWith('https://')) fail(`${path}.exception.issue_uri`, 'must be HTTPS')
  } else {
    fail(`${path}.decision`, 'must be pass or approved_exception')
  }
}

function checkProvenance(value, targetPath, prefix, path) {
  plainObject(value, path, ['format', 'predicate_type', 'target'])
  exact(value.format, 'in-toto-jsonl', `${path}.format`)
  exact(value.predicate_type, 'https://slsa.dev/provenance/v1', `${path}.predicate_type`)
  checkTargetRef(value.target, `${prefix}/${targetPath}`, MEDIA.provenance, `${path}.target`)
}

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
}

export function artifactSetProjection(bundle) {
  return {
    git_sha: bundle.release.git_sha,
    oci_images: bundle.oci_images.map(({ component, digest, sbom, scan, provenance }) => ({
      component,
      digest,
      sbom_sha256: sbom.target.sha256,
      scan_sha256: scan.target.sha256,
      provenance_sha256: provenance.target.sha256,
    })),
    frontends: bundle.frontends.map((frontend) => ({
      app: frontend.app,
      archive_sha256: frontend.archive.target.sha256,
      content_manifest_sha256: frontend.content_manifest.sha256,
      worker_sha256: frontend.worker.script.sha256,
      sbom_sha256: frontend.sbom.target.sha256,
      scan_sha256: frontend.scan.target.sha256,
      provenance_sha256: frontend.provenance.target.sha256,
    })),
    migration: {
      first: bundle.migration.first,
      last: bundle.migration.last,
      count: bundle.migration.count,
      ledger_sha256: bundle.migration.ledger.sha256,
      verification_sha256: bundle.migration.verification.sha256,
    },
  }
}

export function computeArtifactSetSha256(bundle) {
  return createHash('sha256').update(canonicalize(artifactSetProjection(bundle))).digest('hex')
}

function configMaps(configuration) {
  return {
    components: new Map(configuration.components.oci_components.map((item) => [item.name, item])),
    frontends: new Map(configuration.components.frontends.map((item) => [item.app, item])),
    environments: new Map(configuration.environments.environments.map((item) => [item.name, item])),
  }
}

export function verifyReleaseBundle(bundle, configuration, expectations = {}) {
  plainObject(bundle, 'bundle', ['schema_version', 'release', 'environment', 'oci_images', 'frontends', 'edge', 'migration', 'promotion'])
  exact(bundle.schema_version, '2.0.0', 'bundle.schema_version')
  const release = plainObject(bundle.release, 'bundle.release',
    ['id', 'sequence', 'source_repository', 'git_sha', 'created_at', 'artifact_set_sha256'])
  const parsedRelease = releaseIdentity(release.id, 'bundle.release.id')
  integer(release.sequence, 1, 9999999999, 'bundle.release.sequence')
  exact(parsedRelease.sequence, release.sequence, 'bundle.release.id sequence')
  pattern(release.git_sha, GIT_SHA, 'bundle.release.git_sha')
  exact(parsedRelease.gitSha, release.git_sha, 'bundle.release.id Git SHA')
  exact(release.source_repository, configuration.components.source_repository, 'bundle.release.source_repository')
  const releaseCreatedAt = canonicalTime(release.created_at, 'bundle.release.created_at')
  const admissionTime = expectations.admissionTime === undefined
    ? undefined
    : canonicalTime(expectations.admissionTime, 'expectations.admissionTime')
  if (admissionTime !== undefined && releaseCreatedAt > admissionTime) fail('bundle.release.created_at', 'cannot be in the future at admission')
  pattern(release.artifact_set_sha256, SHA256, 'bundle.release.artifact_set_sha256')
  if (expectations.releaseId !== undefined) exact(release.id, expectations.releaseId, 'bundle.release.id')
  if (expectations.gitSha !== undefined) exact(release.git_sha, expectations.gitSha, 'bundle.release.git_sha')

  const environment = plainObject(bundle.environment, 'bundle.environment',
    ['name', 'tuf_repository_id', 'update_origin', 'target_prefix', 'aws_account_id', 'aws_region'])
  const maps = configMaps(configuration)
  const expectedEnvironment = maps.environments.get(environment.name)
  if (!expectedEnvironment) fail('bundle.environment.name', 'is not a configured deployable environment')
  if (expectations.environment !== undefined) exact(environment.name, expectations.environment, 'bundle.environment.name')
  for (const key of ['tuf_repository_id', 'update_origin', 'target_prefix']) {
    exact(environment[key], expectedEnvironment[key], `bundle.environment.${key}`)
  }
  pattern(environment.aws_account_id, new RegExp(configuration.environments.aws_identity.account_id_pattern), 'bundle.environment.aws_account_id')
  pattern(environment.aws_region, new RegExp(configuration.environments.aws_identity.region_pattern), 'bundle.environment.aws_region')
  if (expectations.awsAccountId !== undefined) exact(environment.aws_account_id, expectations.awsAccountId, 'bundle.environment.aws_account_id')
  if (expectations.awsRegion !== undefined) exact(environment.aws_region, expectations.awsRegion, 'bundle.environment.aws_region')
  const prefix = `${environment.target_prefix}/releases/${release.id}`

  if (!Array.isArray(bundle.oci_images) || bundle.oci_images.length !== OCI_COMPONENTS.length) fail('bundle.oci_images', 'must contain exactly 12 records')
  bundle.oci_images.forEach((image, index) => {
    const path = `bundle.oci_images[${index}]`
    plainObject(image, path, ['component', 'repository_uri', 'digest', 'size_bytes', 'platform', 'built_at', 'sbom', 'scan', 'provenance'])
    exact(image.component, OCI_COMPONENTS[index], `${path}.component`)
    const component = maps.components.get(image.component)
    if (!component) fail(`${path}.component`, 'is not configured')
    const expectedRepository = `${environment.aws_account_id}.dkr.ecr.${environment.aws_region}.amazonaws.com/${environment.name}/hid/${component.ecr_repository}`
    exact(image.repository_uri, expectedRepository, `${path}.repository_uri`)
    pattern(image.digest, OCI_DIGEST, `${path}.digest`)
    integer(image.size_bytes, 1, 10737418240, `${path}.size_bytes`)
    plainObject(image.platform, `${path}.platform`, ['os', 'architecture'])
    exact(image.platform.os, 'linux', `${path}.platform.os`)
    exact(image.platform.architecture, 'amd64', `${path}.platform.architecture`)
    if (canonicalTime(image.built_at, `${path}.built_at`) > releaseCreatedAt) fail(`${path}.built_at`, 'cannot be later than release.created_at')
    const base = `oci/${image.component}`
    checkEvidence(image.sbom, `${base}/sbom.spdx.json`, prefix, `${path}.sbom`)
    checkScan(image.scan, `${base}/scan-summary.json`, prefix, `${path}.scan`, releaseCreatedAt, admissionTime)
    checkProvenance(image.provenance, `${base}/provenance.intoto.jsonl`, prefix, `${path}.provenance`)
  })

  if (!Array.isArray(bundle.frontends) || bundle.frontends.length !== FRONTENDS.length) fail('bundle.frontends', 'must contain exactly seven records')
  const sharedWorkerPath = `${prefix}/edge/frontend-worker.mjs`
  let sharedWorkerHash
  bundle.frontends.forEach((frontend, index) => {
    const path = `bundle.frontends[${index}]`
    plainObject(frontend, path, ['app', 'archive', 'content_manifest', 'worker', 'sbom', 'scan', 'provenance'])
    exact(frontend.app, FRONTENDS[index], `${path}.app`)
    const configuredFrontend = maps.frontends.get(frontend.app)
    const base = `frontends/${frontend.app}`
    plainObject(frontend.archive, `${path}.archive`, ['format', 'file_count', 'uncompressed_size_bytes', 'target'])
    exact(frontend.archive.format, 'ustar', `${path}.archive.format`)
    integer(frontend.archive.file_count, 3, configuration.components.frontend_archive.limits.files, `${path}.archive.file_count`)
    integer(frontend.archive.uncompressed_size_bytes, 1, configuration.components.frontend_archive.limits.total_bytes, `${path}.archive.uncompressed_size_bytes`)
    checkTargetRef(frontend.archive.target, `${prefix}/${base}/assets.tar`, MEDIA.archive, `${path}.archive.target`)
    checkTargetRef(frontend.content_manifest, `${prefix}/${base}/content-manifest.json`, MEDIA.contentManifest, `${path}.content_manifest`)
    plainObject(frontend.worker, `${path}.worker`, ['name', 'script', 'compatibility_date', 'hostname', 'api_origin', 'cache_generation'])
    exact(frontend.worker.name, `${configuredFrontend.worker}-${environment.name}`, `${path}.worker.name`)
    checkTargetRef(frontend.worker.script, sharedWorkerPath, MEDIA.worker, `${path}.worker.script`, 1048576)
    exact(frontend.worker.compatibility_date, '2026-08-12', `${path}.worker.compatibility_date`)
    exact(frontend.worker.hostname, expectedEnvironment.frontend_hosts[frontend.app], `${path}.worker.hostname`)
    exact(frontend.worker.api_origin, expectedEnvironment.api_origin, `${path}.worker.api_origin`)
    exact(frontend.worker.cache_generation, release.git_sha, `${path}.worker.cache_generation`)
    sharedWorkerHash ??= frontend.worker.script.sha256
    exact(frontend.worker.script.sha256, sharedWorkerHash, `${path}.worker.script.sha256`)
    exact(frontend.worker.script.length, bundle.frontends[0].worker.script.length, `${path}.worker.script.length`)
    checkEvidence(frontend.sbom, `${base}/sbom.spdx.json`, prefix, `${path}.sbom`)
    checkScan(frontend.scan, `${base}/scan-summary.json`, prefix, `${path}.scan`, releaseCreatedAt, admissionTime)
    checkProvenance(frontend.provenance, `${base}/provenance.intoto.jsonl`, prefix, `${path}.provenance`)
  })

  plainObject(bundle.edge, 'bundle.edge', ['frontend_worker', 'apex_redirect'])
  checkTargetRef(bundle.edge.frontend_worker, sharedWorkerPath, MEDIA.worker, 'bundle.edge.frontend_worker', 1048576)
  exact(bundle.edge.frontend_worker.sha256, sharedWorkerHash, 'bundle.edge.frontend_worker.sha256')
  if (environment.name === 'staging') {
    exact(bundle.edge.apex_redirect, null, 'bundle.edge.apex_redirect')
  } else {
    const apex = plainObject(bundle.edge.apex_redirect, 'bundle.edge.apex_redirect', ['name', 'script', 'hostname', 'destination_origin'])
    exact(apex.name, expectedEnvironment.apex_redirect.worker, 'bundle.edge.apex_redirect.name')
    checkTargetRef(apex.script, `${prefix}/edge/apex-redirect-worker.mjs`, MEDIA.worker, 'bundle.edge.apex_redirect.script', 1048576)
    exact(apex.hostname, expectedEnvironment.apex_redirect.hostname, 'bundle.edge.apex_redirect.hostname')
    exact(apex.destination_origin, expectedEnvironment.apex_redirect.destination_origin, 'bundle.edge.apex_redirect.destination_origin')
  }

  const migration = plainObject(bundle.migration, 'bundle.migration', ['image_component', 'first', 'last', 'count', 'ledger', 'verification'])
  exact(migration.image_component, 'database-migration', 'bundle.migration.image_component')
  exact(migration.first, configuration.components.migration.first, 'bundle.migration.first')
  exact(migration.last, configuration.components.migration.last, 'bundle.migration.last')
  exact(migration.count, configuration.components.migration.count, 'bundle.migration.count')
  checkTargetRef(migration.ledger, `${prefix}/migrations/ledger.json`, MEDIA.migrationLedger, 'bundle.migration.ledger', 16777216)
  checkTargetRef(migration.verification, `${prefix}/migrations/verification.json`, MEDIA.migrationVerification, 'bundle.migration.verification', 16777216)

  if (environment.name === 'staging') {
    plainObject(bundle.promotion, 'bundle.promotion', ['kind'])
    exact(bundle.promotion.kind, 'candidate', 'bundle.promotion.kind')
  } else {
    const promotion = plainObject(bundle.promotion, 'bundle.promotion',
      ['kind', 'staging_release_id', 'staging_artifact_set_sha256', 'evidence'])
    exact(promotion.kind, 'staging-validated', 'bundle.promotion.kind')
    const staging = releaseIdentity(promotion.staging_release_id, 'bundle.promotion.staging_release_id')
    if (staging.sequence >= release.sequence) fail('bundle.promotion.staging_release_id', 'must have a lower sequence than the production release')
    exact(staging.gitSha, release.git_sha, 'bundle.promotion.staging_release_id Git SHA')
    exact(promotion.staging_artifact_set_sha256, release.artifact_set_sha256, 'bundle.promotion.staging_artifact_set_sha256')
    plainObject(promotion.evidence, 'bundle.promotion.evidence', PROMOTION_EVIDENCE.map(([key]) => key))
    for (const [key, filename] of PROMOTION_EVIDENCE) {
      checkTargetRef(promotion.evidence[key], `${prefix}/promotion/${filename}`, MEDIA.promotionEvidence, `bundle.promotion.evidence.${key}`, 16777216)
    }
  }

  exact(computeArtifactSetSha256(bundle), release.artifact_set_sha256, 'bundle.release.artifact_set_sha256')
  return true
}

export function admitReleaseBundle(bundle, configuration, expectations) {
  plainObject(expectations, 'expectations',
    ['environment', 'awsAccountId', 'awsRegion', 'releaseId', 'gitSha', 'admissionTime'])
  if (!['staging', 'production'].includes(expectations.environment)) fail('expectations.environment', 'must be staging or production')
  pattern(expectations.awsAccountId, /^[0-9]{12}$/, 'expectations.awsAccountId')
  pattern(expectations.awsRegion, /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/, 'expectations.awsRegion')
  const identity = releaseIdentity(expectations.releaseId, 'expectations.releaseId')
  pattern(expectations.gitSha, GIT_SHA, 'expectations.gitSha')
  exact(identity.gitSha, expectations.gitSha, 'expectations release/Git identity')
  canonicalTime(expectations.admissionTime, 'expectations.admissionTime')
  return verifyReleaseBundle(bundle, configuration, expectations)
}

export function verifyFrontendContentManifest(manifest, configuration) {
  plainObject(manifest, 'manifest', ['schema_version', 'app', 'git_sha', 'archive_profile', 'file_count', 'total_size_bytes', 'files'])
  exact(manifest.schema_version, '1.0.0', 'manifest.schema_version')
  if (!FRONTENDS.includes(manifest.app)) fail('manifest.app', 'is not a configured frontend')
  pattern(manifest.git_sha, GIT_SHA, 'manifest.git_sha')
  exact(manifest.archive_profile, 'hid-frontend-ustar-v1', 'manifest.archive_profile')
  const policy = configuration.components.frontend_archive
  if (!Array.isArray(manifest.files)) fail('manifest.files', 'must be an array')
  integer(manifest.file_count, 3, policy.limits.files, 'manifest.file_count')
  exact(manifest.file_count, manifest.files.length, 'manifest.file_count')
  integer(manifest.total_size_bytes, 1, policy.limits.total_bytes, 'manifest.total_size_bytes')
  const paths = new Set()
  const foldedPaths = new Set()
  let previous
  let total = 0
  manifest.files.forEach((file, index) => {
    const path = `manifest.files[${index}]`
    plainObject(file, path, ['path', 'length', 'sha256', 'mode'])
    if (typeof file.path !== 'string' || !SAFE_ARCHIVE_PATH.test(file.path)
      || file.path.startsWith('/') || file.path.endsWith('/') || file.path.includes('\\')
      || file.path.includes('//') || file.path.split('/').some((segment) => segment === '.' || segment === '..')
      || file.path !== file.path.normalize('NFC') || Buffer.byteLength(file.path, 'utf8') > policy.limits.path_bytes) {
      fail(`${path}.path`, 'is not a safe normalized relative archive path')
    }
    if (paths.has(file.path)) fail(`${path}.path`, 'duplicates an earlier path')
    const folded = file.path.toLowerCase()
    if (foldedPaths.has(folded)) fail(`${path}.path`, 'has a case-insensitive collision')
    if (previous !== undefined && Buffer.compare(Buffer.from(previous, 'ascii'), Buffer.from(file.path, 'ascii')) >= 0) {
      fail(`${path}.path`, 'files must be strictly ASCII-bytewise sorted')
    }
    paths.add(file.path)
    foldedPaths.add(folded)
    previous = file.path
    integer(file.length, 0, policy.limits.file_bytes, `${path}.length`)
    pattern(file.sha256, SHA256, `${path}.sha256`)
    exact(file.mode, policy.mode, `${path}.mode`)
    total += file.length
    if (!Number.isSafeInteger(total) || total > policy.limits.total_bytes) fail('manifest.total_size_bytes', 'file lengths exceed the configured total-size limit')
  })
  exact(total, manifest.total_size_bytes, 'manifest.total_size_bytes')
  for (const required of policy.required_files) {
    if (!paths.has(required)) fail('manifest.files', `missing required file ${required}`)
  }
  return true
}

export function verifyChannel(channel, configuration) {
  plainObject(channel, 'channel', ['schema_version', 'environment', 'release_id', 'release_sequence', 'artifact_set_sha256', 'release_bundle', 'updated_at', 'discovery_only'])
  exact(channel.schema_version, '1.0.0', 'channel.schema_version')
  const environment = configuration.environments.environments.find((item) => item.name === channel.environment)
  if (!environment) fail('channel.environment', 'is not configured')
  const release = releaseIdentity(channel.release_id, 'channel.release_id')
  integer(channel.release_sequence, 1, 9999999999, 'channel.release_sequence')
  exact(release.sequence, channel.release_sequence, 'channel.release_sequence')
  pattern(channel.artifact_set_sha256, SHA256, 'channel.artifact_set_sha256')
  checkTargetRef(channel.release_bundle,
    `${environment.target_prefix}/releases/${channel.release_id}/release-bundle.json`,
    MEDIA.bundle, 'channel.release_bundle', 16777216)
  canonicalTime(channel.updated_at, 'channel.updated_at')
  exact(channel.discovery_only, true, 'channel.discovery_only')
  return true
}

export function verifyPromotionEvidence(evidence, expectations = {}) {
  plainObject(evidence, 'evidence',
    ['schema_version', 'evidence_type', 'environment', 'subject_release_id', 'artifact_set_sha256', 'status', 'started_at', 'completed_at', 'executor', 'checks'],
    ['authorization'])
  exact(evidence.schema_version, '1.0.0', 'evidence.schema_version')
  const types = PROMOTION_EVIDENCE.map(([, filename]) => filename.replace('.json', ''))
  if (!types.includes(evidence.evidence_type)) fail('evidence.evidence_type', 'is not a governed promotion evidence type')
  releaseIdentity(evidence.subject_release_id, 'evidence.subject_release_id')
  pattern(evidence.artifact_set_sha256, SHA256, 'evidence.artifact_set_sha256')
  if (expectations.evidenceType !== undefined) exact(evidence.evidence_type, expectations.evidenceType, 'evidence.evidence_type')
  if (expectations.environment !== undefined) exact(evidence.environment, expectations.environment, 'evidence.environment')
  if (expectations.subjectReleaseId !== undefined) exact(evidence.subject_release_id, expectations.subjectReleaseId, 'evidence.subject_release_id')
  if (expectations.artifactSetSha256 !== undefined) exact(evidence.artifact_set_sha256, expectations.artifactSetSha256, 'evidence.artifact_set_sha256')
  exact(evidence.status, 'passed', 'evidence.status')
  const started = canonicalTime(evidence.started_at, 'evidence.started_at')
  const completed = canonicalTime(evidence.completed_at, 'evidence.completed_at')
  if (completed < started) fail('evidence.completed_at', 'cannot precede started_at')
  const admissionTime = expectations.admissionTime === undefined
    ? undefined
    : canonicalTime(expectations.admissionTime, 'expectations.admissionTime')
  if (admissionTime !== undefined && completed > admissionTime) fail('evidence.completed_at', 'cannot be in the future at admission')
  pattern(evidence.executor, /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,127}$/, 'evidence.executor')
  if (!Array.isArray(evidence.checks) || evidence.checks.length < 1 || evidence.checks.length > 1000) fail('evidence.checks', 'must have from 1 through 1000 checks')
  const names = new Set()
  evidence.checks.forEach((check, index) => {
    const path = `evidence.checks[${index}]`
    plainObject(check, path, ['name', 'status'], ['detail'])
    pattern(check.name, /^[a-z0-9][a-z0-9._-]{1,63}$/, `${path}.name`)
    if (names.has(check.name)) fail(`${path}.name`, 'duplicates an earlier check')
    names.add(check.name)
    exact(check.status, 'passed', `${path}.status`)
    if (Object.hasOwn(check, 'detail') && (typeof check.detail !== 'string' || check.detail.length < 1 || check.detail.length > 512)) fail(`${path}.detail`, 'must be from 1 through 512 characters')
  })
  for (const required of REQUIRED_GATE_CHECKS[evidence.evidence_type]) {
    if (!names.has(required)) fail('evidence.checks', `missing required ${evidence.evidence_type} check ${required}`)
  }
  if (evidence.evidence_type === 'approval') {
    exact(evidence.environment, 'production', 'evidence.environment')
    const authorization = plainObject(evidence.authorization, 'evidence.authorization', ['approval_id', 'approved_by', 'approved_at', 'expires_at', 'scope'])
    pattern(authorization.approval_id, /^[A-Z][A-Z0-9_-]{2,63}$/, 'evidence.authorization.approval_id')
    if (typeof authorization.approved_by !== 'string' || authorization.approved_by.length < 3 || authorization.approved_by.length > 128) fail('evidence.authorization.approved_by', 'invalid approver identity')
    const approved = canonicalTime(authorization.approved_at, 'evidence.authorization.approved_at')
    const expires = canonicalTime(authorization.expires_at, 'evidence.authorization.expires_at')
    if (approved < completed) fail('evidence.authorization.approved_at', 'cannot precede completed evidence checks')
    if (expires <= approved || (admissionTime !== undefined && expires <= admissionTime)) {
      fail('evidence.authorization.expires_at', 'must remain valid through release admission')
    }
    exact(authorization.scope, 'production-promotion', 'evidence.authorization.scope')
  } else {
    exact(evidence.environment, 'staging', 'evidence.environment')
    if (Object.hasOwn(evidence, 'authorization')) fail('evidence.authorization', 'is permitted only for approval evidence')
  }
  return true
}

export function verifyProductionPromotionEvidence(bundle, evidenceByKey, admissionTime) {
  if (bundle.environment.name !== 'production' || bundle.promotion.kind !== 'staging-validated') {
    fail('bundle.promotion', 'production promotion evidence requires a staging-validated production bundle')
  }
  canonicalTime(admissionTime, 'admissionTime')
  plainObject(evidenceByKey, 'promotion evidence', PROMOTION_EVIDENCE.map(([key]) => key))
  let latestStagingCompletion = 0
  let approval
  for (const [key, filename] of PROMOTION_EVIDENCE) {
    const evidence = evidenceByKey[key]
    const evidenceType = filename.replace('.json', '')
    const isApproval = key === 'approval'
    verifyPromotionEvidence(evidence, {
      evidenceType,
      environment: isApproval ? 'production' : 'staging',
      subjectReleaseId: isApproval ? bundle.release.id : bundle.promotion.staging_release_id,
      artifactSetSha256: bundle.release.artifact_set_sha256,
      admissionTime,
    })
    const completed = canonicalTime(evidence.completed_at, `promotion evidence.${key}.completed_at`)
    if (completed > canonicalTime(bundle.release.created_at, 'bundle.release.created_at')) {
      fail(`promotion evidence.${key}.completed_at`, 'cannot be later than production release creation')
    }
    if (isApproval) {
      approval = evidence
    } else {
      latestStagingCompletion = Math.max(latestStagingCompletion, completed)
    }
  }
  const approvedAt = canonicalTime(approval.authorization.approved_at, 'promotion evidence.approval.authorization.approved_at')
  if (approvedAt < latestStagingCompletion) {
    fail('promotion evidence.approval.authorization.approved_at', 'cannot precede any mandatory staging gate')
  }
  return true
}

export function collectTargetReferences(bundle) {
  const references = []
  const add = (reference) => references.push(reference)
  for (const image of bundle.oci_images) {
    add(image.sbom.target)
    add(image.scan.target)
    add(image.provenance.target)
  }
  for (const frontend of bundle.frontends) {
    add(frontend.archive.target)
    add(frontend.content_manifest)
    add(frontend.worker.script)
    add(frontend.sbom.target)
    add(frontend.scan.target)
    add(frontend.provenance.target)
  }
  add(bundle.edge.frontend_worker)
  if (bundle.edge.apex_redirect !== null) add(bundle.edge.apex_redirect.script)
  add(bundle.migration.ledger)
  add(bundle.migration.verification)
  if (bundle.promotion.kind === 'staging-validated') {
    for (const [key] of PROMOTION_EVIDENCE) add(bundle.promotion.evidence[key])
  }
  const byPath = new Map()
  for (const reference of references) {
    const prior = byPath.get(reference.path)
    if (prior !== undefined && canonicalize(prior) !== canonicalize(reference)) {
      fail('bundle target references', `path ${reference.path} has conflicting length, hash, or media type`)
    }
    byPath.set(reference.path, reference)
  }
  return [...byPath.values()].sort((left, right) => Buffer.compare(Buffer.from(left.path, 'ascii'), Buffer.from(right.path, 'ascii')))
}

export function deriveDeploymentPlan(bundle, configuration) {
  const maps = configMaps(configuration)
  const imageParameters = bundle.oci_images.map((image) => ({
    parameter: maps.components.get(image.component).deployment_parameter,
    component: image.component,
    image_uri: `${image.repository_uri}@${image.digest}`,
  }))
  const body = {
    schema_version: '1.0.0',
    environment: bundle.environment.name,
    release_id: bundle.release.id,
    git_sha: bundle.release.git_sha,
    artifact_set_sha256: bundle.release.artifact_set_sha256,
    aws: {
      account_id: bundle.environment.aws_account_id,
      region: bundle.environment.aws_region,
      image_parameters: imageParameters,
    },
    cloudflare: {
      frontends: bundle.frontends.map((frontend) => ({
        app: frontend.app,
        worker: frontend.worker.name,
        hostname: frontend.worker.hostname,
        api_origin: frontend.worker.api_origin,
        cache_generation: frontend.worker.cache_generation,
        archive: frontend.archive.target,
        content_manifest: frontend.content_manifest,
        script: frontend.worker.script,
      })),
      apex_redirect: bundle.edge.apex_redirect,
    },
    migration: {
      image_uri: imageParameters.find((item) => item.component === 'database-migration').image_uri,
      first: bundle.migration.first,
      last: bundle.migration.last,
      count: bundle.migration.count,
      ledger: bundle.migration.ledger,
      verification: bundle.migration.verification,
    },
    verified_targets: collectTargetReferences(bundle),
  }
  return {
    ...body,
    plan_sha256: createHash('sha256').update(canonicalize(body)).digest('hex'),
  }
}

export async function loadStrictJson(path, maximumBytes = 26214400) {
  integer(maximumBytes, 1, 26214400, 'maximumBytes')
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) fail(path, 'must be a regular file')
    if (metadata.size < 1 || metadata.size > maximumBytes) {
      fail(path, `must contain from 1 through ${maximumBytes} bytes`)
    }
    const bytes = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) fail(path, 'changed or was truncated while being read')
      offset += bytesRead
    }
    const trailing = Buffer.alloc(1)
    if ((await handle.read(trailing, 0, 1, offset)).bytesRead !== 0) {
      fail(path, 'grew while being read')
    }
    return duplicateKeyJson.parse(bytes.toString('utf8'), false)
  } finally {
    await handle.close()
  }
}

export async function loadConfiguration() {
  return {
    components: await loadStrictJson(resolve(releaseRoot, 'config', 'components.json')),
    environments: await loadStrictJson(resolve(releaseRoot, 'config', 'environments.json')),
  }
}

export async function verifyMachineConfiguration(configuration) {
  configuration ??= await loadConfiguration()
  const components = plainObject(configuration.components, 'components config',
    ['schema_version', 'source_repository', 'oci_components', 'frontends', 'migration', 'frontend_archive'])
  exact(components.schema_version, '1.0.0', 'components config.schema_version')
  exact(components.source_repository, 'https://github.com/D-Eminence/hid-system.git', 'components config.source_repository')
  if (!Array.isArray(components.oci_components) || components.oci_components.length !== 12) fail('components config.oci_components', 'must contain exactly 12 records')
  components.oci_components.forEach((component, index) => {
    plainObject(component, `components config.oci_components[${index}]`, ['name', 'ecr_repository', 'deployment_parameter'])
    exact(component.name, OCI_COMPONENTS[index], `components config.oci_components[${index}].name`)
    exact(component.deployment_parameter, DEPLOYMENT_PARAMETERS[index], `components config.oci_components[${index}].deployment_parameter`)
    exact(component.ecr_repository, component.name === 'database-migration' ? 'ehr-api' : component.name,
      `components config.oci_components[${index}].ecr_repository`)
  })
  if (!Array.isArray(components.frontends) || components.frontends.length !== 7) fail('components config.frontends', 'must contain exactly seven records')
  components.frontends.forEach((frontend, index) => {
    plainObject(frontend, `components config.frontends[${index}]`, ['app', 'worker'])
    exact(frontend.app, FRONTENDS[index], `components config.frontends[${index}].app`)
    exact(frontend.worker, `hid-${FRONTENDS[index]}`, `components config.frontends[${index}].worker`)
  })
  const migration = plainObject(components.migration, 'components config.migration', ['first', 'last', 'count', 'files'])
  exact(migration.first, '0001', 'components config.migration.first')
  exact(migration.last, '0028', 'components config.migration.last')
  exact(migration.count, 28, 'components config.migration.count')
  if (!Array.isArray(migration.files) || migration.files.length !== 28) fail('components config.migration.files', 'must contain exactly 28 records')
  const migrationDirectory = resolve(repositoryRoot, 'services', 'ehr-api', 'database', 'migrations')
  const diskFiles = (await readdir(migrationDirectory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()
  exact(JSON.stringify(diskFiles), JSON.stringify(migration.files.map(({ name }) => name)), 'components config.migration.files')
  for (let index = 0; index < migration.files.length; index += 1) {
    const item = plainObject(migration.files[index], `components config.migration.files[${index}]`, ['name', 'sha256'])
    const expectedNumber = String(index + 1).padStart(4, '0')
    if (!item.name.startsWith(`${expectedNumber}_`)) fail(`components config.migration.files[${index}].name`, `must be migration ${expectedNumber}`)
    pattern(item.sha256, SHA256, `components config.migration.files[${index}].sha256`)
    const actual = createHash('sha256').update(await readFile(resolve(migrationDirectory, item.name))).digest('hex')
    exact(actual, item.sha256, `components config.migration.files[${index}].sha256`)
  }
  const archive = plainObject(components.frontend_archive, 'components config.frontend_archive',
    ['format', 'compression', 'path_order', 'entry_type', 'uid', 'gid', 'uname', 'gname', 'mode', 'mtime_unix', 'allow_pax', 'allow_gnu_extensions', 'allow_links', 'allow_sparse_files', 'allow_extended_attributes', 'allow_empty_directories', 'required_files', 'limits'])
  const archiveConstants = {
    format: 'ustar', compression: 'none', path_order: 'ascii-bytewise-ascending', entry_type: 'regular-file-only',
    uid: 0, gid: 0, uname: '', gname: '', mode: 420, mtime_unix: 0,
    allow_pax: false, allow_gnu_extensions: false, allow_links: false,
    allow_sparse_files: false, allow_extended_attributes: false, allow_empty_directories: false,
  }
  for (const [key, value] of Object.entries(archiveConstants)) exact(archive[key], value, `components config.frontend_archive.${key}`)
  exact(JSON.stringify(archive.required_files), JSON.stringify(['index.html', 'manifest.webmanifest', 'service-worker.js']), 'components config.frontend_archive.required_files')
  plainObject(archive.limits, 'components config.frontend_archive.limits', ['files', 'file_bytes', 'total_bytes', 'archive_bytes', 'path_bytes'])
  exact(JSON.stringify(archive.limits), JSON.stringify({ files: 20000, file_bytes: 26214400, total_bytes: 26214400, archive_bytes: 26214400, path_bytes: 240 }), 'components config.frontend_archive.limits')

  const environments = plainObject(configuration.environments, 'environments config',
    ['schema_version', 'aws_identity', 'environments', 'rollback', 'root_retention'])
  exact(environments.schema_version, '1.0.0', 'environments config.schema_version')
  plainObject(environments.aws_identity, 'environments config.aws_identity', ['account_id_source', 'region_source', 'account_id_pattern', 'region_pattern'])
  exact(environments.aws_identity.account_id_pattern, '^[0-9]{12}$', 'environments config.aws_identity.account_id_pattern')
  exact(environments.aws_identity.region_pattern, '^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$', 'environments config.aws_identity.region_pattern')
  if (!Array.isArray(environments.environments) || environments.environments.length !== 2) fail('environments config.environments', 'must contain staging and production only')
  const expectedEnvironments = [
    {
      name: 'staging', tuf_repository_id: 'hid-staging-v1', update_origin: 'https://updates.staging.healthidentitydirectory.com',
      target_prefix: 'environments/staging', api_origin: 'https://api.staging.healthidentitydirectory.com',
      hosts: ['staging.healthidentitydirectory.com', 'ehr.staging.healthidentitydirectory.com', 'lab.staging.healthidentitydirectory.com', 'pharmacy.staging.healthidentitydirectory.com', 'ocr.staging.healthidentitydirectory.com', 'outreach.staging.healthidentitydirectory.com', 'admin.staging.healthidentitydirectory.com'],
      apex_redirect: null, retention: { minimum_accepted_releases: 5, minimum_days: 90 },
    },
    {
      name: 'production', tuf_repository_id: 'hid-production-v1', update_origin: 'https://updates.healthidentitydirectory.com',
      target_prefix: 'environments/production', api_origin: 'https://api.healthidentitydirectory.com',
      hosts: ['www.healthidentitydirectory.com', 'ehr.healthidentitydirectory.com', 'lab.healthidentitydirectory.com', 'pharmacy.healthidentitydirectory.com', 'ocr.healthidentitydirectory.com', 'outreach.healthidentitydirectory.com', 'admin.healthidentitydirectory.com'],
      apex_redirect: { worker: 'hid-apex-redirect-production', hostname: 'healthidentitydirectory.com', destination_origin: 'https://www.healthidentitydirectory.com' },
      retention: { minimum_accepted_releases: 10, minimum_days: 180 },
    },
  ]
  environments.environments.forEach((environment, index) => {
    plainObject(environment, `environments config.environments[${index}]`, ['name', 'tuf_repository_id', 'update_origin', 'target_prefix', 'api_origin', 'frontend_hosts', 'apex_redirect', 'retention'])
    const expected = expectedEnvironments[index]
    for (const key of ['name', 'tuf_repository_id', 'update_origin', 'target_prefix', 'api_origin']) exact(environment[key], expected[key], `environments config.environments[${index}].${key}`)
    plainObject(environment.frontend_hosts, `environments config.environments[${index}].frontend_hosts`, FRONTENDS)
    exact(JSON.stringify(FRONTENDS.map((app) => environment.frontend_hosts[app])), JSON.stringify(expected.hosts), `environments config.environments[${index}].frontend_hosts`)
    exact(JSON.stringify(environment.apex_redirect), JSON.stringify(expected.apex_redirect), `environments config.environments[${index}].apex_redirect`)
    exact(JSON.stringify(environment.retention), JSON.stringify(expected.retention), `environments config.environments[${index}].retention`)
  })
  plainObject(environments.rollback, 'environments config.rollback', ['strategy', 'requires_higher_release_sequence', 'requires_retained_verified_targets', 'allow_metadata_reversion'])
  exact(JSON.stringify(environments.rollback), JSON.stringify({ strategy: 'forward-only', requires_higher_release_sequence: true, requires_retained_verified_targets: true, allow_metadata_reversion: false }), 'environments config.rollback')
  exact(environments.root_retention, 'permanent', 'environments config.root_retention')
  return true
}

async function verifySchemas() {
  const names = ['release-bundle.schema.json', 'frontend-content-manifest.schema.json', 'channel.schema.json', 'promotion-evidence.schema.json']
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  for (const name of names) {
    const schema = await loadStrictJson(resolve(releaseRoot, 'schemas', name))
    exact(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', `schemas/${name}.$schema`)
    exact(schema.type, 'object', `schemas/${name}.type`)
    exact(schema.additionalProperties, false, `schemas/${name}.additionalProperties`)
    try {
      ajv.compile(schema)
    } catch (error) {
      fail(`schemas/${name}`, `does not compile as strict Draft 2020-12: ${error.message}`)
    }
  }
}

async function main() {
  const configuration = await loadConfiguration()
  await verifyMachineConfiguration(configuration)
  await verifySchemas()
  const fileFlags = new Set(['--bundle', '--manifest', '--channel', '--evidence'])
  const expectationFlags = new Map([
    ['--expected-environment', 'environment'],
    ['--expected-account', 'awsAccountId'],
    ['--expected-region', 'awsRegion'],
    ['--expected-release', 'releaseId'],
    ['--expected-git-sha', 'gitSha'],
    ['--admission-time', 'admissionTime'],
  ])
  const allowedFlags = new Set([...fileFlags, ...expectationFlags.keys()])
  const argumentsByFlag = new Map()
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index]
    const value = process.argv[index + 1]
    if (!allowedFlags.has(flag) || !value) {
      throw new Error('usage: verify-release-contract.mjs [--manifest FILE] [--channel FILE] [--evidence FILE] [--bundle FILE --expected-environment ENV --expected-account ACCOUNT --expected-region REGION --expected-release RELEASE --expected-git-sha SHA --admission-time TIME]')
    }
    if (argumentsByFlag.has(flag)) fail('arguments', `duplicate flag ${flag}`)
    argumentsByFlag.set(flag, fileFlags.has(flag) ? resolve(value) : value)
  }

  const bundlePath = argumentsByFlag.get('--bundle')
  const suppliedExpectationFlags = [...expectationFlags.keys()].filter((flag) => argumentsByFlag.has(flag))
  if (bundlePath === undefined && suppliedExpectationFlags.length !== 0) {
    fail('arguments', 'bundle admission expectations require --bundle')
  }
  if (bundlePath !== undefined && suppliedExpectationFlags.length !== expectationFlags.size) {
    const missing = [...expectationFlags.keys()].filter((flag) => !argumentsByFlag.has(flag))
    fail('arguments', `--bundle requires ${missing.join(', ')}`)
  }
  const expectations = Object.fromEntries(
    [...expectationFlags].map(([flag, key]) => [key, argumentsByFlag.get(flag)]),
  )
  const validators = new Map([
    ['--bundle', (value) => admitReleaseBundle(value, configuration, expectations)],
    ['--manifest', (value) => verifyFrontendContentManifest(value, configuration)],
    ['--channel', (value) => verifyChannel(value, configuration)],
    ['--evidence', (value) => verifyPromotionEvidence(value)],
  ])
  for (const [flag, path] of argumentsByFlag) {
    if (!fileFlags.has(flag)) continue
    validators.get(flag)(await loadStrictJson(path))
    process.stdout.write(`verified ${flag.slice(2)} ${basename(path)}\n`)
  }
  process.stdout.write('HID release schemas, machine configuration, and semantic contracts verified.\n')
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}
