import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { validateTufRepositoryDirectory } from '../scripts/tuf-repository-layout.mjs'
import { runTufWrangler, validateDeployReceipt } from '../scripts/tuf-wrangler.mjs'
import { canonicalize, digest, signedEnvelope, writeRepository } from './helpers/tuf-repository-fixture.mjs'
import { publicationAuthorization } from './helpers/tuf-publication-fixture.mjs'

const cloudflareRoot = resolve(import.meta.dirname, '..')
const deployments = Object.freeze({
  staging: 'updates.staging.healthidentitydirectory.com',
  production: 'updates.healthidentitydirectory.com',
})

test('staging and production configs are explicit, isolated, and schema-aligned', async () => {
  const names = new Set()
  for (const [deployment, host] of Object.entries(deployments)) {
    const configPath = resolve(cloudflareRoot, 'workers', `hid-tuf-${deployment}`, 'wrangler.json')
    const raw = await readFile(configPath, 'utf8')
    const config = JSON.parse(raw)
    names.add(config.name)
    assert.equal(config.$schema, '../../node_modules/wrangler/config-schema.json')
    assert.equal(config.name, `hid-tuf-${deployment}`)
    assert.equal(config.main, '../../src/tuf-repository-worker.mjs')
    assert.equal(config.compatibility_date, '2026-08-31')
    assert.deepEqual(config.compatibility_flags, ['nodejs_compat'])
    assert.equal(config.workers_dev, false)
    assert.equal(config.preview_urls, true)
    assert.equal(config.env, undefined)
    assert.deepEqual(config.routes, [{ pattern: host, custom_domain: true }])
    assert.deepEqual(config.vars, {
      DEPLOYMENT_ENV: deployment,
      EXPECTED_HOST: host,
      WORKER_NAME: `hid-tuf-${deployment}`,
    })
    assert.deepEqual(config.assets, {
      directory: './repository',
      binding: 'ASSETS',
      html_handling: 'none',
      not_found_handling: 'none',
      run_worker_first: true,
    })
    assert.deepEqual(config.observability, {
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 1, invocation_logs: false },
      traces: { enabled: false },
    })
    assert.doesNotMatch(raw, /password|private[_-]?key|api[_-]?token|secret/i)
  }
  assert.equal(names.size, 2)

  const ignore = await readFile(resolve(cloudflareRoot, '.gitignore'), 'utf8')
  assert.match(ignore, /hid-tuf-staging\/repository\//)
  assert.match(ignore, /hid-tuf-production\/repository\//)
})

test('validates a complete signed-layout staging repository without network access', async () => {
  const fixture = await writeRepository('staging')
  try {
    const result = await validateTufRepositoryDirectory(fixture.repository, 'staging')
    assert.equal(result.deployment, 'staging')
    assert.equal(result.rootVersion, 1)
    assert.equal(result.snapshotVersion, 1)
    assert.equal(result.targetsVersion, 1)
    assert.equal(result.timestampVersion, 1)
    assert.equal(result.fileCount, 5)
    assert.match(result.repositorySha256, /^[a-f0-9]{64}$/)
    assert.equal(result.repositorySha256, (await validateTufRepositoryDirectory(fixture.repository, 'staging')).repositorySha256)
  } finally {
    await rm(fixture.repository, { recursive: true, force: true })
  }
})

test('cryptographic layout rejects invalid thresholds, signatures, duplicate JSON, stale-freshness abuse, and metadata mix', async () => {
  const cases = [
    {
      name: 'weakened root policy',
      expected: /threshold 2 of exactly 3 keys/,
      mutate: async (fixture) => {
        const signed = structuredClone(fixture.signed.root)
        signed.roles.targets.threshold = 1
        await writeFile(resolve(fixture.repository, 'metadata', '1.root.json'), signedEnvelope(signed, fixture.signers.root.slice(0, 2)))
      },
    },
    {
      name: 'invalid targets signature',
      expected: /not threshold-signed/,
      mutate: async (fixture) => {
        const envelope = JSON.parse(fixture.metadata.targets)
        envelope.signatures[0].sig = '00'.repeat(envelope.signatures[0].sig.length / 2)
        envelope.signatures[1].sig = '00'.repeat(envelope.signatures[1].sig.length / 2)
        await writeFile(resolve(fixture.repository, 'metadata', '1.targets.json'), JSON.stringify(envelope))
      },
    },
    {
      name: 'one public key represented by two threshold key IDs',
      expected: /repeats one cryptographic public key/,
      mutate: async (fixture) => {
        const signed = structuredClone(fixture.signed.root)
        const originalID = signed.roles.targets.keyids[0]
        const replacedID = signed.roles.targets.keyids[1]
        const duplicateKey = structuredClone(signed.keys[originalID])
        duplicateKey.keytype = 'ecdsa-sha2-nistp256'
        const duplicateID = digest(canonicalize(duplicateKey))
        delete signed.keys[replacedID]
        signed.keys[duplicateID] = duplicateKey
        signed.roles.targets.keyids[1] = duplicateID
        await writeFile(resolve(fixture.repository, 'metadata', '1.root.json'), signedEnvelope(signed, fixture.signers.root.slice(0, 2)))
      },
    },
    {
      name: 'duplicate metadata key',
      expected: /duplicate-free JSON/,
      mutate: async (fixture) => {
        const timestamp = fixture.metadata.timestamp.toString('utf8')
        await writeFile(resolve(fixture.repository, 'metadata', 'timestamp.json'), timestamp.replace('{"signatures":', '{"signed":{},"signatures":'))
      },
    },
    {
      name: 'excessive timestamp lifetime',
      expected: /maximum timestamp metadata lifetime/,
      mutate: async (fixture) => {
        const signed = structuredClone(fixture.signed.timestamp)
        signed.expires = new Date(Date.now() + 48 * 3600000).toISOString()
        await writeFile(resolve(fixture.repository, 'metadata', 'timestamp.json'), signedEnvelope(signed, fixture.signers.timestamp.slice(0, 1)))
      },
    },
    {
      name: 'normalized but impossible calendar timestamp',
      expected: /not a real timestamp/,
      mutate: async (fixture) => {
        const signed = structuredClone(fixture.signed.timestamp)
        signed.expires = '2027-02-31T12:00:00Z'
        await writeFile(resolve(fixture.repository, 'metadata', 'timestamp.json'), signedEnvelope(signed, fixture.signers.timestamp.slice(0, 1)))
      },
    },
    {
      name: 'orphan higher snapshot mix',
      expected: /highest retained snapshot/,
      mutate: async (fixture) => {
        const signed = structuredClone(fixture.signed.snapshot)
        signed.version = 2
        await writeFile(resolve(fixture.repository, 'metadata', '2.snapshot.json'), signedEnvelope(signed, fixture.signers.snapshot.slice(0, 1)))
      },
    },
    {
      name: 'orphan retained targets metadata',
      expected: /not selected by any retained snapshot/,
      mutate: async (fixture) => {
        const targetsSigned = structuredClone(fixture.signed.targets)
        targetsSigned.version = 2
        const targets = signedEnvelope(targetsSigned, fixture.signers.targets.slice(0, 2))
        await writeFile(resolve(fixture.repository, 'metadata', '2.targets.json'), targets)

        const snapshotSigned = structuredClone(fixture.signed.snapshot)
        snapshotSigned.meta['targets.json'] = { version: 2, length: targets.length, hashes: { sha256: digest(targets) } }
        const snapshot = signedEnvelope(snapshotSigned, fixture.signers.snapshot.slice(0, 1))
        await writeFile(resolve(fixture.repository, 'metadata', '1.snapshot.json'), snapshot)

        const timestampSigned = structuredClone(fixture.signed.timestamp)
        timestampSigned.meta['snapshot.json'] = { version: 1, length: snapshot.length, hashes: { sha256: digest(snapshot) } }
        await writeFile(resolve(fixture.repository, 'metadata', 'timestamp.json'), signedEnvelope(timestampSigned, fixture.signers.timestamp.slice(0, 1)))
      },
    },
  ]

  for (const attack of cases) {
    const fixture = await writeRepository('staging')
    try {
      await attack.mutate(fixture)
      await assert.rejects(validateTufRepositoryDirectory(fixture.repository, 'staging'), attack.expected, attack.name)
    } finally {
      await rm(fixture.repository, { recursive: true, force: true })
    }
  }
})

test('rejects relative paths, unversioned metadata, cross-environment targets, and changed target bytes', async () => {
  await assert.rejects(
    validateTufRepositoryDirectory('./repository', 'production'),
    /explicit absolute repository directory/,
  )

  const unversioned = await writeRepository('production')
  try {
    await writeFile(resolve(unversioned.repository, 'metadata', 'targets.json'), '{}')
    await assert.rejects(
      validateTufRepositoryDirectory(unversioned.repository, 'production'),
      /metadata\/targets\.json is not an allowed repository asset path/,
    )
  } finally {
    await rm(unversioned.repository, { recursive: true, force: true })
  }

  const changed = await writeRepository('production')
  try {
    await writeFile(changed.targetPath, 'changed after signing')
    await assert.rejects(
      validateTufRepositoryDirectory(changed.repository, 'production'),
      /hash prefix does not match its bytes/,
    )
    await assert.rejects(
      validateTufRepositoryDirectory(changed.repository, 'staging'),
      /outside the staging target namespace/,
    )
  } finally {
    await rm(changed.repository, { recursive: true, force: true })
  }
})

test('Wrangler wrapper injects only a validated explicit directory and can be tested without spawning a process', async () => {
  const fixture = await writeRepository('staging')
  let invocation
  try {
    await runTufWrangler(['dry-run', 'staging', fixture.repository], {
      wranglerPath: process.execPath,
      spawn(binary, args, options) {
        const generated = JSON.parse(readFileSync(args.at(-1), 'utf8'))
        invocation = { binary, args, options, generated }
        return { status: 0 }
      },
    })
    assert.equal(invocation.binary, process.execPath)
    assert.deepEqual(invocation.args.slice(0, 2), ['deploy', '--dry-run'])
    assert.equal(invocation.options.cwd, cloudflareRoot)
    assert.equal(invocation.generated.assets.directory, fixture.repository)
    assert.equal(invocation.generated.name, 'hid-tuf-staging')
    assert.equal(invocation.generated.vars.DEPLOYMENT_ENV, 'staging')
  } finally {
    await rm(fixture.repository, { recursive: true, force: true })
  }
})

test('Wrangler upload receipt binds the generation and deploy selects only that preview-verified version at 100 percent', async () => {
  const fixture = await writeRepository('staging')
  const receipts = await mkdtemp(join(tmpdir(), 'hid-tuf-receipts-'))
  const versionId = '1234abcd-1234-1234-1234-123456789abc'
  const previewUrl = 'https://1234abcd-hid-tuf-staging.account-name.workers.dev/'
  const uploadPath = resolve(receipts, 'upload.json')
  let uploadInvocation
  try {
    const upload = await runTufWrangler(['versions-upload', 'staging', fixture.repository, uploadPath], {
      wranglerPath: process.execPath,
      now: new Date('2026-09-01T00:00:00Z'),
      authorize: (repository) => publicationAuthorization(repository, new Date('2026-09-01T00:00:00Z')),
      spawn(binary, args, options) {
        uploadInvocation = { binary, args, options }
        writeFileSync(options.env.WRANGLER_OUTPUT_FILE_PATH, `${JSON.stringify({
          type: 'version-upload',
          version: 1,
          worker_name: 'hid-tuf-staging',
          version_id: versionId,
          preview_url: previewUrl,
          worker_name_overridden: false,
          timestamp: '2026-09-01T00:00:00.000Z',
        })}\n`)
        return { status: 0 }
      },
    })
    assert.equal(upload.version_id, versionId)
    assert.equal(upload.repository_sha256, (await validateTufRepositoryDirectory(fixture.repository, 'staging')).repositorySha256)
    assert.deepEqual(uploadInvocation.args.slice(0, 3), ['versions', 'upload', '--strict'])
    assert.equal(JSON.parse(await readFile(uploadPath, 'utf8')).receipt_sha256, upload.receipt_sha256)

    const releaseId = `r0000000001-g${'a'.repeat(40)}`
    const evidenceBody = {
      schema_version: '1.0.0',
      admitted_at: '2026-09-01T00:01:00Z',
      client_sha256: 'b'.repeat(64),
      trust: {
        configuration_sha256: 'c'.repeat(64),
        repository_id: 'hid-staging-preview-1234abcd',
        metadata_url: `${previewUrl}metadata`,
        targets_url: `${previewUrl}targets`,
        trusted_root_sha256: upload.publication_authorization.authorization.bootstrap_root_sha256,
      },
      bundle_target: `environments/staging/releases/${releaseId}/release-bundle.json`,
      tuf_metadata: Object.fromEntries(['root', 'targets', 'snapshot', 'timestamp'].map((role) => [role, {
        version: 1,
        expires: '2026-09-02T00:00:00Z',
      }])),
      deployment_plan: {
        environment: 'staging',
        release_id: releaseId,
        artifact_set_sha256: 'e'.repeat(64),
        plan_sha256: 'f'.repeat(64),
      },
      workspace: '/private/test',
      verified_target_files: [{}],
      frontend_directories: Array.from({ length: 7 }, (_, index) => ({ app: String(index) })),
    }
    const evidence = {
      ...evidenceBody,
      admission_record_sha256: digest(canonicalize(evidenceBody)),
    }
    const evidencePath = resolve(receipts, 'preview.json')
    const deployPath = resolve(receipts, 'deploy.json')
    await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`)
    for (const artifactHash of [undefined, 'invalid']) {
      const invalid = structuredClone(evidenceBody)
      invalid.deployment_plan.artifact_set_sha256 = artifactHash
      if (artifactHash === undefined) delete invalid.deployment_plan.artifact_set_sha256
      const invalidPath = resolve(receipts, `invalid-artifacts-${String(artifactHash)}.json`)
      await writeFile(invalidPath, JSON.stringify({ ...invalid, admission_record_sha256: digest(canonicalize(invalid)) }))
      await assert.rejects(runTufWrangler([
        'versions-deploy', 'staging', fixture.repository, uploadPath, invalidPath,
        resolve(receipts, 'invalid-must-not-deploy.json'), `deploy-hid-tuf-staging-${versionId}-at-100-percent`,
      ], {
        now: new Date('2026-09-01T00:02:00Z'),
        authorize() { assert.fail('invalid artifact hash reached authorization') },
        spawn() { assert.fail('invalid artifact hash reached deployment') },
      }), /complete admitted deployment plan/)
    }
    let deployInvocation
    const deploy = await runTufWrangler([
      'versions-deploy', 'staging', fixture.repository, uploadPath, evidencePath, deployPath,
      `deploy-hid-tuf-staging-${versionId}-at-100-percent`,
    ], {
      wranglerPath: process.execPath,
      now: new Date('2026-09-01T00:02:00Z'),
      authorize: (repository) => publicationAuthorization(repository, new Date('2026-09-01T00:02:00Z')),
      spawn(binary, args, options) {
        deployInvocation = { binary, args, options }
        writeFileSync(options.env.WRANGLER_OUTPUT_FILE_PATH, `${JSON.stringify({
          type: 'version-deploy',
          version: 1,
          worker_name: 'hid-tuf-staging',
          deployment_id: '9876abcd-1234-1234-1234-123456789abc',
          timestamp: '2026-09-01T00:02:00.000Z',
        })}\n`)
        return { status: 0 }
      },
    })
    assert.equal(deploy.version_id, versionId)
    assert.equal(deploy.traffic_percentage, 100)
    const wrongRelease = { ...deploy, release_id: `r0000000002-g${'a'.repeat(40)}` }
    const { receipt_sha256: _ignored, ...wrongReleaseBody } = wrongRelease
    wrongRelease.receipt_sha256 = digest(canonicalize(wrongReleaseBody))
    assert.throws(() => validateDeployReceipt(wrongRelease, 'staging', deploy.repository_sha256), /release differs/)
    assert.deepEqual(deployInvocation.args.slice(0, 7), [
      'versions', 'deploy', '--version-id', versionId, '--percentage', '100', '--yes',
    ])

    await assert.rejects(runTufWrangler([
      'versions-deploy', 'staging', fixture.repository, uploadPath, evidencePath,
      resolve(receipts, 'must-not-promote.json'), `deploy-hid-tuf-staging-${versionId}-at-100-percent`,
    ], {
      wranglerPath: process.execPath,
      now: new Date('2026-09-01T00:02:00Z'),
      authorize(repository) {
        const authorization = publicationAuthorization(repository, new Date('2026-09-01T00:02:00Z'))
        authorization.config_sha256 = 'f'.repeat(64)
        return authorization
      },
      spawn() { assert.fail('changed authorization reached version deployment') },
    }), /protected operator changed after upload/)
    await assert.rejects(readFile(resolve(receipts, 'must-not-promote.json')), /ENOENT/)

    const substituted = structuredClone(evidence)
    substituted.trust.targets_url = 'https://attacker.example/targets'
    const substitutedBody = structuredClone(substituted)
    delete substitutedBody.admission_record_sha256
    substituted.admission_record_sha256 = digest(canonicalize(substitutedBody))
    const substitutedPath = resolve(receipts, 'substituted.json')
    await writeFile(substitutedPath, JSON.stringify(substituted))
    await assert.rejects(runTufWrangler([
      'versions-deploy', 'staging', fixture.repository, uploadPath, substitutedPath,
      resolve(receipts, 'must-not-exist.json'), `deploy-hid-tuf-staging-${versionId}-at-100-percent`,
    ], { wranglerPath: process.execPath, now: new Date('2026-09-01T00:02:00Z') }), /not bound to the uploaded version URL/)
  } finally {
    await rm(fixture.repository, { recursive: true, force: true })
    await rm(receipts, { recursive: true, force: true })
  }
})

test('bootstrap is create-only and route activation requires an exact sealed deployment receipt', async () => {
  const receipts = await mkdtemp(join(tmpdir(), 'hid-tuf-lifecycle-test-'))
  const bootstrapPath = resolve(receipts, 'bootstrap.json')
  const bootstrapVersion = '1111abcd-1234-1234-1234-123456789abc'
  let bootstrapInvocation
  try {
    const bootstrap = await runTufWrangler([
      'bootstrap-parent', 'production', bootstrapPath,
      'create-inaccessible-hid-tuf-production-parent',
    ], {
      wranglerPath: process.execPath,
      beforeEffect: async () => {},
      spawn(binary, args, options) {
        bootstrapInvocation = { binary, args, options }
        writeFileSync(options.env.WRANGLER_OUTPUT_FILE_PATH, `${JSON.stringify({
          type: 'deploy',
          version: 1,
          worker_name: 'hid-tuf-production',
          version_id: bootstrapVersion,
          targets: [],
          worker_name_overridden: false,
          timestamp: '2026-09-01T00:00:00.000Z',
        })}\n`)
        return { status: 0 }
      },
    })
    assert.equal(bootstrap.inaccessible, true)
    assert.equal(bootstrap.version_id, bootstrapVersion)
    assert.deepEqual(bootstrapInvocation.args.slice(0, 3), ['deploy', '--strict', '--fail-if-worker-name-taken'])
    await assert.rejects(runTufWrangler([
      'bootstrap-parent', 'production', resolve(receipts, 'unprotected-parent.json'),
      'create-inaccessible-hid-tuf-production-parent',
    ], { spawn() { assert.fail('direct bootstrap reached Wrangler') } }), /committed protected publication intent/)
    await assert.rejects(runTufWrangler([
      'bootstrap-parent', 'production', resolve(receipts, 'must-not-exist.json'), 'overwrite-parent',
    ]), /bootstrap confirmation/)

    const fixture = await writeRepository('production')
    try {
      const repository = await validateTufRepositoryDirectory(fixture.repository, 'production')
      const versionId = '2222abcd-1234-1234-1234-123456789abc'
      const deployBody = {
        schema_version: '2.0.0',
        action: 'version-deploy',
        deployment: 'production',
        worker_name: 'hid-tuf-production',
        repository_sha256: repository.repositorySha256,
        version_id: versionId,
        traffic_percentage: 100,
        upload_receipt_sha256: 'a'.repeat(64),
        preview_evidence_sha256: 'b'.repeat(64),
        release_id: `r0000000001-g${'a'.repeat(40)}`,
        artifact_set_sha256: 'd'.repeat(64),
        deployment_id: '3333abcd-1234-1234-1234-123456789abc',
        deployed_at: '2026-09-01T00:02:00.000Z',
        wrangler_version: '4.127.1',
        publication_authorization: publicationAuthorization(repository, new Date('2026-09-01T00:02:00Z')),
      }
      const deployPath = resolve(receipts, 'deploy.json')
      await writeFile(deployPath, JSON.stringify({
        ...deployBody,
        receipt_sha256: digest(canonicalize(deployBody)),
      }))
      const routePath = resolve(receipts, 'route.json')
      let routeInvocation
      const route = await runTufWrangler([
        'activate-route', 'production', fixture.repository, deployPath, routePath,
        `activate-updates.healthidentitydirectory.com-for-${versionId}`,
      ], {
        wranglerPath: process.execPath,
        authorize: publicationAuthorization,
        spawn(binary, args, options) {
          routeInvocation = { binary, args, options }
          return { status: 0 }
        },
      })
      assert.equal(route.hostname, 'updates.healthidentitydirectory.com')
      assert.equal(route.version_id, versionId)
      assert.deepEqual(routeInvocation.args.slice(0, 2), ['triggers', 'deploy'])

      const ambiguous = { ...deployBody, unexpected: true }
      const ambiguousPath = resolve(receipts, 'ambiguous-deploy.json')
      await writeFile(ambiguousPath, JSON.stringify({
        ...ambiguous,
        receipt_sha256: digest(canonicalize(ambiguous)),
      }))
      await assert.rejects(runTufWrangler([
        'activate-route', 'production', fixture.repository, ambiguousPath,
        resolve(receipts, 'must-not-route.json'),
        `activate-updates.healthidentitydirectory.com-for-${versionId}`,
      ]), /missing or unexpected properties/)
    } finally {
      await rm(fixture.repository, { recursive: true, force: true })
    }
  } finally {
    await rm(receipts, { recursive: true, force: true })
  }
})
