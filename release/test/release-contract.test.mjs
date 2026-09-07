import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { admit } from '../scripts/admit-release.mjs'
import {
  admitReleaseBundle,
  collectTargetReferences,
  computeArtifactSetSha256,
  deriveDeploymentPlan,
  loadConfiguration,
  loadStrictJson,
  verifyChannel,
  verifyFrontendContentManifest,
  verifyMachineConfiguration,
  verifyProductionPromotionEvidence,
  verifyPromotionEvidence,
  verifyReleaseBundle,
} from '../scripts/verify-release-contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const verifier = resolve(here, '..', 'scripts', 'verify-release-contract.mjs')
const configuration = await loadConfiguration()

const COMPONENTS = configuration.components.oci_components
const FRONTENDS = configuration.components.frontends
const ACCOUNT = '123456789012'
const REGION = 'af-south-1'
const GIT_SHA = '0123456789abcdef0123456789abcdef01234567'
const ADMISSION_TIME = '2026-08-31T15:00:00Z'
const SHA256 = /^[a-f0-9]{64}$/
const MEDIA = {
  bundle: 'application/vnd.hid.release-bundle+json',
  archive: 'application/vnd.hid.frontend-ustar',
  manifest: 'application/vnd.hid.frontend-content-manifest+json',
  sbom: 'application/spdx+json',
  scan: 'application/vnd.hid.scan-summary+json',
  provenance: 'application/vnd.in-toto+jsonl',
  worker: 'text/javascript',
  ledger: 'application/vnd.hid.migration-ledger+json',
  migrationVerification: 'application/vnd.hid.migration-verification+json',
  promotion: 'application/vnd.hid.promotion-evidence+json',
}
const REQUIRED_CHECKS = {
  'staging-acceptance': ['release-bundle-admitted', 'deployment-healthy', 'frontend-canary', 'api-canary'],
  'migration-dry-run': ['migration-ledger-verified', 'dry-run-completed', 'schema-postconditions'],
  'staging-copy-migration': ['source-copy-restored', 'migration-completed', 'schema-postconditions', 'application-smoke'],
  'backup-restore': ['backup-created', 'restore-completed', 'data-integrity', 'application-smoke'],
  'rollback-drill': ['forward-rollback-release', 'rollback-deployed', 'application-smoke'],
  approval: ['all-staging-gates-bound', 'artifact-set-identical', 'production-change-approved'],
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function releaseId(sequence) {
  return `r${String(sequence).padStart(10, '0')}-g${GIT_SHA}`
}

function target(environment, id, relativePath, mediaType, length = 97) {
  return {
    path: `environments/${environment}/releases/${id}/${relativePath}`,
    length,
    sha256: sha256(`content:${relativePath}`),
    media_type: mediaType,
  }
}

function evidenceRef(environment, id, relativePath, mediaType) {
  return { format: 'SPDX-JSON', target: target(environment, id, relativePath, mediaType) }
}

function provenanceRef(environment, id, relativePath) {
  return {
    format: 'in-toto-jsonl',
    predicate_type: 'https://slsa.dev/provenance/v1',
    target: target(environment, id, relativePath, MEDIA.provenance),
  }
}

function scanRef(environment, id, relativePath) {
  return {
    scanner: 'trivy',
    scanner_version: '1.2.3',
    completed_at: '2026-08-31T10:30:00Z',
    critical: 0,
    high: 0,
    decision: 'pass',
    target: target(environment, id, relativePath, MEDIA.scan),
  }
}

function buildBundle(environment, sequence, stagingBundle) {
  const id = releaseId(sequence)
  const environmentConfig = configuration.environments.environments.find((item) => item.name === environment)
  const createdAt = environment === 'staging' ? '2026-08-31T12:00:00Z' : '2026-08-31T14:00:00Z'
  const workerScript = target(environment, id, 'edge/frontend-worker.mjs', MEDIA.worker, 4096)
  const bundle = {
    schema_version: '2.0.0',
    release: {
      id,
      sequence,
      source_repository: configuration.components.source_repository,
      git_sha: GIT_SHA,
      created_at: createdAt,
      artifact_set_sha256: '0'.repeat(64),
    },
    environment: {
      name: environment,
      tuf_repository_id: environmentConfig.tuf_repository_id,
      update_origin: environmentConfig.update_origin,
      target_prefix: environmentConfig.target_prefix,
      aws_account_id: ACCOUNT,
      aws_region: REGION,
    },
    oci_images: COMPONENTS.map((component) => {
      const base = `oci/${component.name}`
      return {
        component: component.name,
        repository_uri: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${environment}/hid/${component.ecr_repository}`,
        digest: `sha256:${sha256(`image:${component.name}`)}`,
        size_bytes: 1048576,
        platform: { os: 'linux', architecture: 'amd64' },
        built_at: '2026-08-31T10:00:00Z',
        sbom: evidenceRef(environment, id, `${base}/sbom.spdx.json`, MEDIA.sbom),
        scan: scanRef(environment, id, `${base}/scan-summary.json`),
        provenance: provenanceRef(environment, id, `${base}/provenance.intoto.jsonl`),
      }
    }),
    frontends: FRONTENDS.map(({ app, worker }) => {
      const base = `frontends/${app}`
      return {
        app,
        archive: {
          format: 'ustar',
          file_count: 3,
          uncompressed_size_bytes: 3072,
          target: target(environment, id, `${base}/assets.tar`, MEDIA.archive, 10240),
        },
        content_manifest: target(environment, id, `${base}/content-manifest.json`, MEDIA.manifest),
        worker: {
          name: `${worker}-${environment}`,
          script: structuredClone(workerScript),
          compatibility_date: '2026-08-12',
          hostname: environmentConfig.frontend_hosts[app],
          api_origin: environmentConfig.api_origin,
          cache_generation: GIT_SHA,
        },
        sbom: evidenceRef(environment, id, `${base}/sbom.spdx.json`, MEDIA.sbom),
        scan: scanRef(environment, id, `${base}/scan-summary.json`),
        provenance: provenanceRef(environment, id, `${base}/provenance.intoto.jsonl`),
      }
    }),
    edge: {
      frontend_worker: structuredClone(workerScript),
      apex_redirect: environment === 'staging' ? null : {
        name: environmentConfig.apex_redirect.worker,
        script: target(environment, id, 'edge/apex-redirect-worker.mjs', MEDIA.worker, 2048),
        hostname: environmentConfig.apex_redirect.hostname,
        destination_origin: environmentConfig.apex_redirect.destination_origin,
      },
    },
    migration: {
      image_component: 'database-migration',
      first: '0001',
      last: '0028',
      count: 28,
      ledger: target(environment, id, 'migrations/ledger.json', MEDIA.ledger),
      verification: target(environment, id, 'migrations/verification.json', MEDIA.migrationVerification),
    },
    promotion: environment === 'staging' ? { kind: 'candidate' } : {
      kind: 'staging-validated',
      staging_release_id: stagingBundle.release.id,
      staging_artifact_set_sha256: stagingBundle.release.artifact_set_sha256,
      evidence: Object.fromEntries([
        ['staging_acceptance', 'staging-acceptance.json'],
        ['migration_dry_run', 'migration-dry-run.json'],
        ['staging_copy_migration', 'staging-copy-migration.json'],
        ['backup_restore', 'backup-restore.json'],
        ['rollback_drill', 'rollback-drill.json'],
        ['approval', 'approval.json'],
      ].map(([key, filename]) => [key, target(environment, id, `promotion/${filename}`, MEDIA.promotion)])),
    },
  }
  bundle.release.artifact_set_sha256 = computeArtifactSetSha256(bundle)
  if (environment === 'production') {
    assert.equal(bundle.release.artifact_set_sha256, stagingBundle.release.artifact_set_sha256)
  }
  return bundle
}

function expectations(bundle) {
  return {
    environment: bundle.environment.name,
    awsAccountId: ACCOUNT,
    awsRegion: REGION,
    releaseId: bundle.release.id,
    gitSha: GIT_SHA,
    admissionTime: ADMISSION_TIME,
  }
}

function buildPromotionEvidence(productionBundle) {
  const stagingId = productionBundle.promotion.staging_release_id
  const artifactHash = productionBundle.release.artifact_set_sha256
  const gates = ['staging-acceptance', 'migration-dry-run', 'staging-copy-migration', 'backup-restore', 'rollback-drill']
  const output = Object.fromEntries(gates.map((type, index) => {
    const minute = String(index + 1).padStart(2, '0')
    return [type.replaceAll('-', '_'), {
      schema_version: '1.0.0',
      evidence_type: type,
      environment: 'staging',
      subject_release_id: stagingId,
      artifact_set_sha256: artifactHash,
      status: 'passed',
      started_at: `2026-08-31T12:${minute}:00Z`,
      completed_at: `2026-08-31T13:${minute}:00Z`,
      executor: `github:hid/${type}`,
      checks: REQUIRED_CHECKS[type].map((name) => ({ name, status: 'passed' })),
    }]
  }))
  output.approval = {
    schema_version: '1.0.0',
    evidence_type: 'approval',
    environment: 'production',
    subject_release_id: productionBundle.release.id,
    artifact_set_sha256: artifactHash,
    status: 'passed',
    started_at: '2026-08-31T13:10:00Z',
    completed_at: '2026-08-31T13:20:00Z',
    executor: 'github:hid/production-approval',
    checks: REQUIRED_CHECKS.approval.map((name) => ({ name, status: 'passed' })),
    authorization: {
      approval_id: 'HID_PROD_0001',
      approved_by: 'security@example.com',
      approved_at: '2026-08-31T13:30:00Z',
      expires_at: '2026-09-01T15:00:00Z',
      scope: 'production-promotion',
    },
  }
  return output
}

const stagingBundle = buildBundle('staging', 1)
const productionBundle = buildBundle('production', 2, stagingBundle)

test('machine configuration and exact-bound staging admission produce a deterministic deployment plan', async () => {
  await verifyMachineConfiguration(configuration)
  assert.equal(admitReleaseBundle(stagingBundle, configuration, expectations(stagingBundle)), true)
  const plan = deriveDeploymentPlan(stagingBundle, configuration)
  assert.equal(plan.aws.image_parameters.length, 12)
  assert.equal(plan.cloudflare.frontends.length, 7)
  assert.match(plan.plan_sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(plan, deriveDeploymentPlan(stagingBundle, configuration))
  assert.equal(new Set(plan.verified_targets.map(({ path }) => path)).size, plan.verified_targets.length)
})

test('bundle admission rejects caller/bundle identity confusion and post-attestation mutation', () => {
  for (const [key, value] of [
    ['environment', 'production'],
    ['awsAccountId', '999999999999'],
    ['awsRegion', 'us-east-1'],
    ['releaseId', releaseId(9)],
    ['gitSha', 'f'.repeat(40)],
  ]) {
    assert.throws(
      () => admitReleaseBundle(stagingBundle, configuration, { ...expectations(stagingBundle), [key]: value }),
      /expected|identity/,
    )
  }
  const mutated = structuredClone(stagingBundle)
  mutated.oci_images[0].sbom.target.sha256 = sha256('attacker bytes')
  assert.throws(() => verifyReleaseBundle(mutated, configuration), /artifact_set_sha256/)
})

test('bundle path, ordering, media, size, and duplicate-path conflicts fail closed', () => {
  const wrongOrder = structuredClone(stagingBundle)
  ;[wrongOrder.oci_images[0], wrongOrder.oci_images[1]] = [wrongOrder.oci_images[1], wrongOrder.oci_images[0]]
  assert.throws(() => verifyReleaseBundle(wrongOrder, configuration), /component/)

  const wrongMedia = structuredClone(stagingBundle)
  wrongMedia.frontends[0].archive.target.media_type = MEDIA.bundle
  assert.throws(() => verifyReleaseBundle(wrongMedia, configuration), /media_type/)

  const oversized = structuredClone(stagingBundle)
  oversized.frontends[0].archive.target.length = 26214401
  assert.throws(() => verifyReleaseBundle(oversized, configuration), /26214400/)

  const unsafe = structuredClone(stagingBundle)
  unsafe.migration.ledger.path = `environments/staging/releases/${unsafe.release.id}/migrations/../ledger.json`
  assert.throws(() => verifyReleaseBundle(unsafe, configuration), /path/)

  const conflict = structuredClone(stagingBundle)
  conflict.edge.frontend_worker.length += 1
  assert.throws(() => collectTargetReferences(conflict), /conflicting/)
})

test('frontend content manifest enforces canonical paths, ordering, collisions, and totals', () => {
  const manifest = {
    schema_version: '1.0.0',
    app: 'ehr',
    git_sha: GIT_SHA,
    archive_profile: 'hid-frontend-ustar-v1',
    file_count: 3,
    total_size_bytes: 6,
    files: ['index.html', 'manifest.webmanifest', 'service-worker.js'].map((path) => ({
      path,
      length: 2,
      sha256: sha256(path),
      mode: 420,
    })),
  }
  assert.equal(verifyFrontendContentManifest(manifest, configuration), true)

  const traversal = structuredClone(manifest)
  traversal.files[0].path = '../index.html'
  assert.throws(() => verifyFrontendContentManifest(traversal, configuration), /safe normalized/)

  const collision = structuredClone(manifest)
  collision.files.push({ path: 'INDEX.HTML', length: 0, sha256: sha256('INDEX.HTML'), mode: 420 })
  collision.file_count = 4
  assert.throws(() => verifyFrontendContentManifest(collision, configuration), /case-insensitive collision|sorted/)

  const wrongTotal = structuredClone(manifest)
  wrongTotal.total_size_bytes += 1
  assert.throws(() => verifyFrontendContentManifest(wrongTotal, configuration), /total_size_bytes/)
})

test('production promotion requires every bound staging gate and a later live approval', () => {
  assert.equal(admitReleaseBundle(productionBundle, configuration, expectations(productionBundle)), true)
  const evidence = buildPromotionEvidence(productionBundle)
  assert.equal(verifyProductionPromotionEvidence(productionBundle, evidence, ADMISSION_TIME), true)

  const wrongSubject = structuredClone(evidence)
  wrongSubject.backup_restore.subject_release_id = releaseId(9)
  assert.throws(() => verifyProductionPromotionEvidence(productionBundle, wrongSubject, ADMISSION_TIME), /subject_release_id/)

  const missingCheck = structuredClone(evidence)
  missingCheck.rollback_drill.checks.pop()
  assert.throws(() => verifyProductionPromotionEvidence(productionBundle, missingCheck, ADMISSION_TIME), /missing required/)

  const expired = structuredClone(evidence)
  expired.approval.authorization.expires_at = ADMISSION_TIME
  assert.throws(() => verifyProductionPromotionEvidence(productionBundle, expired, ADMISSION_TIME), /remain valid/)

  const premature = structuredClone(evidence)
  premature.approval.started_at = '2026-08-31T12:30:00Z'
  premature.approval.completed_at = '2026-08-31T12:40:00Z'
  premature.approval.authorization.approved_at = '2026-08-31T12:50:00Z'
  assert.throws(() => verifyProductionPromotionEvidence(productionBundle, premature, ADMISSION_TIME), /cannot precede any mandatory staging gate/)
})

test('individual promotion evidence and channel contracts reject semantic ambiguity', () => {
  const evidence = buildPromotionEvidence(productionBundle).migration_dry_run
  assert.equal(verifyPromotionEvidence(evidence), true)
  const duplicate = structuredClone(evidence)
  duplicate.checks.push(structuredClone(duplicate.checks[0]))
  assert.throws(() => verifyPromotionEvidence(duplicate), /duplicates an earlier check/)

  const channel = {
    schema_version: '1.0.0',
    environment: 'staging',
    release_id: stagingBundle.release.id,
    release_sequence: stagingBundle.release.sequence,
    artifact_set_sha256: stagingBundle.release.artifact_set_sha256,
    release_bundle: target('staging', stagingBundle.release.id, 'release-bundle.json', MEDIA.bundle),
    updated_at: '2026-08-31T12:01:00Z',
    discovery_only: true,
  }
  assert.equal(verifyChannel(channel, configuration), true)
  channel.environment = 'production'
  assert.throws(() => verifyChannel(channel, configuration), /release_bundle.path/)
})

test('strict JSON loader rejects duplicate keys and symbolic links', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'hid-release-json-'))
  try {
    const duplicatePath = resolve(directory, 'duplicate.json')
    await writeFile(duplicatePath, '{"safe":true,"safe":false}\n', { mode: 0o600 })
    await assert.rejects(loadStrictJson(duplicatePath), /duplicated keys/)

    const validPath = resolve(directory, 'valid.json')
    const linkPath = resolve(directory, 'link.json')
    await writeFile(validPath, '{"safe":true}\n', { mode: 0o600 })
    await symlink(validPath, linkPath)
    await assert.rejects(loadStrictJson(linkPath), /ELOOP/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('CLI refuses unbound bundle validation and accepts a fully pinned admission', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'hid-release-cli-'))
  try {
    const bundlePath = resolve(directory, 'bundle.json')
    await writeFile(bundlePath, `${JSON.stringify(stagingBundle)}\n`, { mode: 0o600 })
    const unbound = spawnSync(process.execPath, [verifier, '--bundle', bundlePath], { encoding: 'utf8' })
    assert.notEqual(unbound.status, 0)
    assert.match(unbound.stderr, /--bundle requires/)

    const bound = spawnSync(process.execPath, [
      verifier,
      '--bundle', bundlePath,
      '--expected-environment', 'staging',
      '--expected-account', ACCOUNT,
      '--expected-region', REGION,
      '--expected-release', stagingBundle.release.id,
      '--expected-git-sha', GIT_SHA,
      '--admission-time', ADMISSION_TIME,
    ], { encoding: 'utf8' })
    assert.equal(bound.status, 0, bound.stderr)
    assert.match(bound.stdout, /verified bundle/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function targetReferenceObjects(value, output = []) {
  if (value === null || typeof value !== 'object') return output
  if (!Array.isArray(value)
    && Object.hasOwn(value, 'path')
    && Object.hasOwn(value, 'length')
    && Object.hasOwn(value, 'sha256')
    && Object.hasOwn(value, 'media_type')) {
    output.push(value)
  }
  for (const child of Object.values(value)) targetReferenceObjects(child, output)
  return output
}

test('end-to-end admission orchestrates the pinned client, rechecks every target, and seals a plan', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'hid-release-admission-'))
  const priorStore = process.env.HID_TEST_TUF_STORE
  const priorBatchMode = process.env.HID_TEST_BATCH_MODE
  try {
    const store = resolve(directory, 'store')
    await mkdir(store, { recursive: true, mode: 0o700 })
    const bundle = structuredClone(stagingBundle)
    const contentByPath = new Map()
    for (const frontend of bundle.frontends) {
      const files = ['index.html', 'manifest.webmanifest', 'service-worker.js'].map((path) => ({
        path,
        length: 2,
        sha256: sha256(`${frontend.app}:${path}`),
        mode: 420,
      }))
      const manifest = {
        schema_version: '1.0.0',
        app: frontend.app,
        git_sha: GIT_SHA,
        archive_profile: 'hid-frontend-ustar-v1',
        file_count: files.length,
        total_size_bytes: 6,
        files,
      }
      frontend.archive.file_count = files.length
      frontend.archive.uncompressed_size_bytes = 6
      contentByPath.set(frontend.content_manifest.path, Buffer.from(`${JSON.stringify(manifest)}\n`))
    }
    const referenceGroups = new Map()
    for (const reference of targetReferenceObjects(bundle)) {
      const group = referenceGroups.get(reference.path) ?? []
      group.push(reference)
      referenceGroups.set(reference.path, group)
    }
    for (const [path, references] of referenceGroups) {
      const bytes = contentByPath.get(path) ?? Buffer.from(`verified test bytes for ${path}\n`)
      contentByPath.set(path, bytes)
      for (const reference of references) {
        reference.length = bytes.length
        reference.sha256 = sha256(bytes)
      }
    }
    bundle.release.artifact_set_sha256 = computeArtifactSetSha256(bundle)
    const bundleTarget = `environments/staging/releases/${bundle.release.id}/release-bundle.json`
    contentByPath.set(bundleTarget, Buffer.from(`${JSON.stringify(bundle)}\n`))

    for (const [path, bytes] of contentByPath) {
      const destination = resolve(store, path)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, bytes, { mode: 0o600 })
    }

    const fakeClient = resolve(directory, 'fake-hid-tuf.mjs')
    await writeFile(fakeClient, `#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
const args = process.argv.slice(2)
const command = args.shift()
const mode = process.env.HID_TEST_BATCH_MODE ?? 'normal'
const value = (name) => {
  const index = args.indexOf(name)
  if (index < 0 || index + 1 >= args.length) throw new Error('missing ' + name)
  return args[index + 1]
}
if (command === 'refresh') {
  process.stdout.write(JSON.stringify({
    root: { version: 1, expires: '2027-08-31T00:00:00Z' },
    targets: { version: 1, expires: '2026-11-29T00:00:00Z' },
    snapshot: { version: 1, expires: '2026-09-07T00:00:00Z' },
    timestamp: { version: 1, expires: '2026-09-01T00:00:00Z' },
  }) + '\\n')
} else if (command === 'get') {
  const target = value('--target')
  const output = value('--output')
  if (!target.endsWith('/release-bundle.json')) throw new Error('individual target download is forbidden')
  await mkdir(dirname(output), { recursive: true, mode: 0o700 })
  await copyFile(resolve(process.env.HID_TEST_TUF_STORE, target), output)
  if (mode === 'precreate-request') {
    await writeFile(resolve(dirname(output), 'batch-request.json'), '{"attacker":true}\\n', { mode: 0o600 })
  }
} else if (command === 'get-batch') {
  const requestPath = value('--request')
  const request = JSON.parse(await readFile(requestPath, 'utf8'))
  if (JSON.stringify(Object.keys(request)) !== JSON.stringify(['schema_version', 'targets'])
    || request.schema_version !== '1.0.0'
    || !Array.isArray(request.targets)
    || request.targets.length < 1
    || request.targets.length > 512) {
    throw new Error('invalid batch request envelope')
  }
  const seenTargets = new Set()
  const seenOutputs = new Set()
  for (let index = 0; index < request.targets.length; index += 1) {
    const entry = request.targets[index]
    if (JSON.stringify(Object.keys(entry)) !== JSON.stringify(['target', 'output'])
      || typeof entry.target !== 'string'
      || typeof entry.output !== 'string'
      || !isAbsolute(entry.output)
      || resolve(entry.output) !== entry.output
      || seenTargets.has(entry.target)
      || seenOutputs.has(entry.output)) {
      throw new Error('invalid batch target entry')
    }
    seenTargets.add(entry.target)
    seenOutputs.add(entry.output)
    if (mode === 'omit-last' && index === request.targets.length - 1) continue
    await mkdir(dirname(entry.output), { recursive: true, mode: 0o700 })
    await copyFile(resolve(process.env.HID_TEST_TUF_STORE, entry.target), entry.output)
    if (mode === 'corrupt-first' && index === 0) {
      const bytes = await readFile(entry.output)
      bytes[0] ^= 0xff
      await writeFile(entry.output, bytes, { mode: 0o600 })
    }
    if (mode === 'fail-after-first' && index === 0) throw new Error('simulated batch availability failure')
  }
} else if (command === 'extract-frontend') {
  const output = value('--output')
  const manifest = JSON.parse(await readFile(value('--manifest'), 'utf8'))
  await mkdir(output, { recursive: false, mode: 0o700 })
  for (const file of manifest.files) {
    const destination = resolve(output, file.path)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await writeFile(destination, 'ok', { mode: 0o600 })
  }
} else {
  throw new Error('unsupported fake command ' + command)
}
`, { mode: 0o700 })
    await chmod(fakeClient, 0o700)
    const fakeClientHash = sha256(await import('node:fs/promises').then(({ readFile }) => readFile(fakeClient)))
    const configPath = resolve(directory, 'trust.json')
    await writeFile(configPath, `${JSON.stringify({
      schema_version: '1.0.0',
      environment: 'staging',
      repository_id: 'hid-staging-preview-1234abcd',
      metadata_url: 'https://1234abcd-hid-tuf-staging.account-name.workers.dev/metadata',
      targets_url: 'https://1234abcd-hid-tuf-staging.account-name.workers.dev/targets',
      trusted_root_path: resolve(directory, 'root.json'),
      trusted_root_sha256: 'a'.repeat(64),
      state_dir: resolve(directory, 'state'),
      max_target_bytes: 26214400,
    })}\n`, { mode: 0o600 })
    const workspace = resolve(directory, 'workspace')
    const output = resolve(directory, 'admission.json')
    process.env.HID_TEST_TUF_STORE = store

    const record = await admit({
      client: fakeClient,
      clientSha256: fakeClientHash,
      config: configPath,
      environment: 'staging',
      releaseId: bundle.release.id,
      gitSha: GIT_SHA,
      awsAccountId: ACCOUNT,
      awsRegion: REGION,
      admissionTime: ADMISSION_TIME,
      workspace,
      output,
    })
    assert.equal(record.deployment_plan.release_id, bundle.release.id)
    assert.equal(record.deployment_plan.aws.image_parameters.length, 12)
    assert.equal(record.frontend_directories.length, 7)
    assert.equal(record.verified_target_files.length, collectTargetReferences(bundle).length)
    assert.match(record.admission_record_sha256, SHA256)
    assert.deepEqual(await loadStrictJson(output), record)

    const request = await loadStrictJson(resolve(workspace, 'batch-request.json'), 1048576)
    const references = collectTargetReferences(bundle)
    assert.deepEqual(request, {
      schema_version: '1.0.0',
      targets: references.map((reference) => ({
        target: reference.path,
        output: resolve(workspace, 'targets', reference.path),
      })),
    })

    for (const [mode, expected] of [
      ['corrupt-first', /hash does not match/],
      ['omit-last', /ENOENT/],
      ['fail-after-first', /simulated batch availability failure/],
      ['precreate-request', /EEXIST/],
    ]) {
      process.env.HID_TEST_BATCH_MODE = mode
      const failedWorkspace = resolve(directory, `workspace-${mode}`)
      const failedOutput = resolve(directory, `admission-${mode}.json`)
      await assert.rejects(admit({
        client: fakeClient,
        clientSha256: fakeClientHash,
        config: configPath,
        environment: 'staging',
        releaseId: bundle.release.id,
        gitSha: GIT_SHA,
        awsAccountId: ACCOUNT,
        awsRegion: REGION,
        admissionTime: ADMISSION_TIME,
        workspace: failedWorkspace,
        output: failedOutput,
      }), expected)
      await assert.rejects(loadStrictJson(failedOutput), /ENOENT/)
    }
  } finally {
    if (priorStore === undefined) delete process.env.HID_TEST_TUF_STORE
    else process.env.HID_TEST_TUF_STORE = priorStore
    if (priorBatchMode === undefined) delete process.env.HID_TEST_BATCH_MODE
    else process.env.HID_TEST_BATCH_MODE = priorBatchMode
    await rm(directory, { recursive: true, force: true })
  }
})
