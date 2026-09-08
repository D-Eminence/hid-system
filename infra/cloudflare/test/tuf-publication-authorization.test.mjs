import assert from 'node:assert/strict'
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { obtainPublicationAuthorization, validatePublicationAuthorization } from '../scripts/tuf-publication-authorization.mjs'
import { validateTufRepositoryDirectory } from '../scripts/tuf-repository-layout.mjs'
import { runTufWrangler } from '../scripts/tuf-wrangler.mjs'
import { writeRepository } from './helpers/tuf-repository-fixture.mjs'
import { publicationAuthorization } from './helpers/tuf-publication-fixture.mjs'

const versionId = '1234abcd-1234-1234-1234-123456789abc'
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
function uploadOutput(options, now, changes = {}) {
  writeFileSync(options.env.WRANGLER_OUTPUT_FILE_PATH, `${JSON.stringify({
    type: 'version-upload', version: 1, worker_name: 'hid-tuf-staging', version_id: versionId,
    preview_url: 'https://1234abcd-hid-tuf-staging.account-name.workers.dev/', worker_name_overridden: false,
    timestamp: now.toISOString(), ...changes,
  })}\n`)
}

test('authorization rejects changed trust, metadata, repository, time and schema', async () => {
  const fixture = await writeRepository('staging')
  try {
    const repository = await validateTufRepositoryDirectory(fixture.repository, 'staging')
    const now = new Date()
    for (const change of [
      (value) => { value.repository_sha256 = 'b'.repeat(64) },
      (value) => { value.file_count += 1 },
      (value) => { value.unexpected = true },
      (value) => { value.authorization.environment = 'production' },
      (value) => { value.authorization.state_id = 'other-state' },
      (value) => { value.authorization.bootstrap_root_sha256 = 'b'.repeat(64) },
      (value) => { value.authorization.candidate.timestamp.version = 3 },
      (value) => { value.authorization.candidate.timestamp.sha256 = 'b'.repeat(64) },
      (value) => { value.authorization.current.timestamp.version = 1 },
      (value) => { value.authorization.expires_at = '2000-01-01T00:00:00Z' },
    ]) {
      const authorization = publicationAuthorization(repository, now)
      change(authorization)
      assert.throws(() => validatePublicationAuthorization(authorization, repository, now))
    }
    for (const offset of [-61000, 1000]) {
      assert.throws(() => validatePublicationAuthorization(publicationAuthorization(repository, new Date(now.getTime() + offset)), repository, now), /freshly obtained/)
    }
  } finally { await rm(fixture.repository, { recursive: true, force: true }) }
})

test('authorization failure stops upload before Wrangler and produces no receipt', async () => {
  const fixture = await writeRepository('staging')
  const receipts = await mkdtemp(join(tmpdir(), 'hid-publication-failed-'))
  try {
    const receipt = resolve(receipts, 'upload.json')
    await assert.rejects(runTufWrangler(['versions-upload', 'staging', fixture.repository, receipt], {
      wranglerPath: process.execPath,
      authorize() { throw new Error('simulated superseded checkpoint') },
      spawn() { assert.fail('authorization failure reached Wrangler') },
    }), /superseded checkpoint/)
    await assert.rejects(readFile(receipt), /ENOENT/)
  } finally {
    await rm(fixture.repository, { recursive: true, force: true })
    await rm(receipts, { recursive: true, force: true })
  }
})

test('upload consumes its validated private copy despite later caller edits', async () => {
  const fixture = await writeRepository('staging')
  const receipts = await mkdtemp(join(tmpdir(), 'hid-publication-isolation-'))
  const now = new Date()
  let isolated
  try {
    const initial = await validateTufRepositoryDirectory(fixture.repository, 'staging')
    const receipt = await runTufWrangler(['versions-upload', 'staging', fixture.repository, resolve(receipts, 'upload.json')], {
      now, wranglerPath: process.execPath,
      authorize: (repository) => publicationAuthorization(repository, now),
      spawn(_binary, args, options) {
        isolated = JSON.parse(readFileSync(args.at(-1), 'utf8')).assets.directory
        assert.notEqual(isolated, fixture.repository)
        const previous = readFileSync(resolve(isolated, 'metadata/timestamp.json'))
        writeFileSync(resolve(fixture.repository, 'metadata/timestamp.json'), 'caller edit after validation')
        assert.deepEqual(readFileSync(resolve(isolated, 'metadata/timestamp.json')), previous)
        assert.equal(options.timeout, 240000)
        uploadOutput(options, now)
        return { status: 0 }
      },
    })
    assert.equal(receipt.repository_sha256, initial.repositorySha256)
    assert.equal(receipt.schema_version, '2.0.0')
    await assert.rejects(readFile(resolve(isolated, 'metadata/timestamp.json')), /ENOENT/)
  } finally {
    await rm(fixture.repository, { recursive: true, force: true })
    await rm(receipts, { recursive: true, force: true })
  }
})

test('failed, malformed, or overlong uploads never seal success evidence', async () => {
  for (const scenario of ['command', 'identity', 'preview', 'deadline']) {
    const fixture = await writeRepository('staging')
    const receipts = await mkdtemp(join(tmpdir(), 'hid-publication-outcome-'))
    const now = new Date()
    try {
      const receipt = resolve(receipts, 'upload.json')
      await assert.rejects(runTufWrangler(['versions-upload', 'staging', fixture.repository, receipt], {
        now, wranglerPath: process.execPath,
        authorize: (repository) => publicationAuthorization(repository, now),
        spawn(_binary, _args, options) {
          if (scenario === 'command') return { status: 1 }
          if (scenario === 'deadline') now.setTime(now.getTime() + 360000)
          uploadOutput(options, now, scenario === 'identity' ? { worker_name: 'other-worker' }
            : scenario === 'preview' ? { preview_url: 'https://attacker.example/' } : {})
          return { status: 0 }
        },
      }))
      await assert.rejects(readFile(receipt), /ENOENT/, scenario)
    } finally {
      await rm(fixture.repository, { recursive: true, force: true })
      await rm(receipts, { recursive: true, force: true })
    }
  }
})

test('all mutation commands reject unusable receipt paths before authorization or Wrangler', async () => {
  const fixture = await writeRepository('staging')
  const receipts = await mkdtemp(join(tmpdir(), 'hid-publication-preflight-'))
  try {
    const existing = resolve(receipts, 'existing.json')
    await writeFile(existing, 'retain this evidence')
    await symlink(receipts, resolve(receipts, 'linked-parent'))
    await symlink(existing, resolve(receipts, 'linked-file'))
    const paths = ['relative.json', existing, receipts, resolve(receipts, 'linked-file'),
      resolve(receipts, 'linked-parent', 'new', 'receipt.json')]
    for (const mode of ['bootstrap-parent', 'versions-upload', 'versions-deploy', 'activate-route']) {
      const outputs = mode === 'bootstrap-parent' ? paths : [...paths, resolve(fixture.repository, 'receipt.json')]
      for (const output of outputs) {
        const args = mode === 'bootstrap-parent' ? [output, 'create-inaccessible-hid-tuf-staging-parent']
          : mode === 'versions-upload' ? [fixture.repository, output]
            : mode === 'versions-deploy' ? [fixture.repository, existing, existing, output, 'unused']
              : [fixture.repository, existing, output, 'unused']
        await assert.rejects(runTufWrangler([mode, 'staging', ...args], {
          authorize() { assert.fail('invalid receipt destination reached authorization') },
          spawn() { assert.fail('invalid receipt destination reached Wrangler') },
        }), /receipt/, `${mode}: ${output}`)
      }
    }
    assert.equal(await readFile(existing, 'utf8'), 'retain this evidence')
  } finally {
    await rm(fixture.repository, { recursive: true, force: true })
    await rm(receipts, { recursive: true, force: true })
  }
})

test('live operator invocation requires and independently binds the protected predecessor hash', async () => {
  const fixture = await writeRepository('staging')
  const runner = await mkdtemp(join(tmpdir(), 'hid-publication-pins-'))
  const names = ['HID_TUF_PUBLICATION_EXECUTABLE', 'HID_TUF_PUBLICATION_EXECUTABLE_SHA256',
    'HID_TUF_PUBLICATION_CONFIG', 'HID_TUF_PUBLICATION_CONFIG_SHA256',
    'HID_TUF_PREVIOUS_REPOSITORY', 'HID_TUF_PREVIOUS_REPOSITORY_SHA256']
  const previousEnv = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  try {
    const repository = await validateTufRepositoryDirectory(fixture.repository, 'staging')
    const now = new Date()
    const decision = publicationAuthorization(repository, now)
    decision.previous_repository_sha256 = 'f'.repeat(64)
    decision.authorization.state_revision = 1
    decision.authorization.current = structuredClone(decision.authorization.candidate)
    delete decision.config_sha256
    delete decision.executable_sha256
    // Hosted toolcache executables can be group-writable. Pin a private copy
    // whose permissions satisfy the same invariant as a protected operator.
    const privateExecutable = resolve(runner, 'pinned-node')
    await copyFile(process.execPath, privateExecutable)
    await chmod(privateExecutable, 0o500)
    const executable = await realpath(privateExecutable)
    const config = resolve(runner, 'pinned-test-operator.cjs')
    const script = Buffer.from(`const assert = require('node:assert/strict');\nassert.deepEqual(process.argv.slice(2), ${JSON.stringify([fixture.repository, 'f'.repeat(64), fixture.repository, repository.repositorySha256])});\nprocess.stdout.write(${JSON.stringify(JSON.stringify(decision))});\n`)
    await writeFile(config, script, { mode: 0o600 })
    Object.assign(process.env, {
      HID_TUF_PUBLICATION_EXECUTABLE: executable,
      HID_TUF_PUBLICATION_EXECUTABLE_SHA256: digest(await readFile(executable)),
      HID_TUF_PUBLICATION_CONFIG: config, HID_TUF_PUBLICATION_CONFIG_SHA256: digest(script),
      HID_TUF_PREVIOUS_REPOSITORY: fixture.repository, HID_TUF_PREVIOUS_REPOSITORY_SHA256: 'f'.repeat(64),
    })
    for (const mode of [0o520, 0o502]) {
      await chmod(executable, mode)
      await assert.rejects(obtainPublicationAuthorization(repository, { now }), /not writable by group or others/)
    }
    await chmod(executable, 0o500)
    assert.equal((await obtainPublicationAuthorization(repository, { now })).previous_repository_sha256, 'f'.repeat(64))
    delete process.env.HID_TUF_PREVIOUS_REPOSITORY_SHA256
    await assert.rejects(obtainPublicationAuthorization(repository, { now }), /pins and predecessor are required/)
    process.env.HID_TUF_PREVIOUS_REPOSITORY_SHA256 = 'b'.repeat(64)
    const substituted = Buffer.from(`process.stdout.write(${JSON.stringify(JSON.stringify(decision))});\n`)
    await writeFile(config, substituted)
    process.env.HID_TUF_PUBLICATION_CONFIG_SHA256 = digest(substituted)
    await assert.rejects(obtainPublicationAuthorization(repository, { now }), /protected previously published repository hash/)
  } finally {
    for (const name of names) {
      if (previousEnv[name] === undefined) delete process.env[name]
      else process.env[name] = previousEnv[name]
    }
    await rm(fixture.repository, { recursive: true, force: true })
    await rm(runner, { recursive: true, force: true })
  }
})
