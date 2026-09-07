import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  parseArguments,
  runTufRepositoryValidation,
} from '../scripts/tuf-validate-repository.mjs'
import { digest, writeRepository } from './helpers/tuf-repository-fixture.mjs'

const execute = promisify(execFile)
const script = resolve(import.meta.dirname, '../scripts/tuf-validate-repository.mjs')

async function repositoryState(repository) {
  const state = []
  async function visit(relativeDirectory) {
    const directory = relativeDirectory === '' ? repository : resolve(repository, relativeDirectory)
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
    for (const entry of entries) {
      const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
      const path = resolve(repository, relativePath)
      const metadata = await lstat(path, { bigint: true })
      const record = {
        path: relativePath,
        type: entry.isDirectory() ? 'directory' : 'file',
        mode: Number(metadata.mode),
        size: String(metadata.size),
        mtime_ns: String(metadata.mtimeNs),
      }
      if (entry.isFile()) record.sha256 = digest(await readFile(path))
      state.push(record)
      if (entry.isDirectory()) await visit(relativePath)
    }
  }
  await visit('')
  return state
}

test('repository validator CLI requires exactly a deployment and canonical absolute directory', async () => {
  assert.throws(() => parseArguments([]), /requires exactly DEPLOYMENT and REPOSITORY_DIRECTORY/)
  assert.throws(() => parseArguments(['staging']), /requires exactly DEPLOYMENT and REPOSITORY_DIRECTORY/)
  assert.throws(() => parseArguments(['staging', '/tmp/repository', 'extra']), /requires exactly DEPLOYMENT and REPOSITORY_DIRECTORY/)
  assert.throws(() => parseArguments(['preview', '/tmp/repository']), /DEPLOYMENT must be staging or production/)
  assert.throws(() => parseArguments(['staging', './repository']), /canonical absolute path/)
  assert.throws(() => parseArguments(['staging', '/tmp/repository/../repository']), /canonical absolute path/)

  const fixture = await writeRepository('staging')
  const alias = `${fixture.repository}-alias`
  try {
    assert.deepEqual(parseArguments(['staging', fixture.repository]), {
      deployment: 'staging',
      repository: fixture.repository,
    })
    await assert.rejects(
      runTufRepositoryValidation(['production', fixture.repository]),
      /outside the production target namespace/,
    )
    await symlink(fixture.repository, alias, 'dir')
    await assert.rejects(
      runTufRepositoryValidation(['staging', alias]),
      /must be its canonical real path/,
    )

    await assert.rejects(
      execute(process.execPath, [script, 'staging']),
      (error) => {
        assert.equal(error.stdout, '')
        assert.match(error.stderr, /requires exactly DEPLOYMENT and REPOSITORY_DIRECTORY/)
        return true
      },
    )
  } finally {
    await rm(alias, { force: true })
    await rm(fixture.repository, { recursive: true, force: true })
  }
})

test('repository validator CLI prints one stable JSON summary and does not mutate its input', async () => {
  const fixture = await writeRepository('production')
  try {
    const before = await repositoryState(fixture.repository)
    const { stdout, stderr } = await execute(
      process.execPath,
      [script, 'production', fixture.repository],
      { env: { ...process.env, PATH: '' } },
    )
    const after = await repositoryState(fixture.repository)

    assert.doesNotMatch(stderr, /validation failed closed/i)
    assert.equal(stdout.endsWith('\n'), true)
    assert.equal(stdout.slice(0, -1).includes('\n'), false)
    const summary = JSON.parse(stdout)
    assert.deepEqual(Object.keys(summary), [
      'schema_version',
      'status',
      'deployment',
      'repository',
      'repository_sha256',
      'file_count',
      'root_version',
      'targets_version',
      'snapshot_version',
      'timestamp_version',
    ])
    assert.deepEqual(summary, {
      schema_version: '1.0.0',
      status: 'repository-valid',
      deployment: 'production',
      repository: fixture.repository,
      repository_sha256: summary.repository_sha256,
      file_count: 5,
      root_version: 1,
      targets_version: 1,
      snapshot_version: 1,
      timestamp_version: 1,
    })
    assert.match(summary.repository_sha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(after, before)

    const inProcess = await runTufRepositoryValidation(['production', fixture.repository])
    assert.equal(inProcess.repository_sha256, summary.repository_sha256)
  } finally {
    await rm(fixture.repository, { recursive: true, force: true })
  }
})
