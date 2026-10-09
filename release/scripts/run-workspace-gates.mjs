#!/usr/bin/env node
// Fixed credential-free commands, with independently hashable logs.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { openSync, closeSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
assert.equal(source, process.env.GITHUB_SHA)
const output = join(process.env.RUNNER_TEMP, 'workspace-gates')
mkdirSync(output, { mode: 0o700 })
const results = []
const commands = [['build', ['npm', 'run', 'build']], ['test', ['npm', 'test']], ['verify', ['npm', 'run', 'verify']],
  ['release-tests', ['npm', '--prefix', 'release', 'test']], ['release-contracts', ['npm', '--prefix', 'release', 'run', 'verify']],
  ['ehr-tests', ['npm', '--prefix', 'apps/ehr', 'test']],
  ['migration-rehearsal', ['node', 'scripts/tuf-staging-migration-rehearsal.mjs', '--evidence-dir', join(process.env.RUNNER_TEMP, 'synthetic-migration')]],
  ['diff-check', ['git', 'diff', '--check']]]
for (const [label, [executable, ...args]] of commands) {
  const started = new Date().toISOString(), path = join(output, `${label}.log`), fd = openSync(path, 'wx', 0o600)
  let result
  try { result = spawnSync(executable, args, { stdio: ['ignore', fd, fd], timeout: 1800000, env: process.env }) } finally { closeSync(fd) }
  results.push({ label, command: [executable, ...args], started_at: started, completed_at: new Date().toISOString(),
    exit_code: result.status, execution_error: result.error?.code ?? null,
    log: `${label}.log`, log_sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })
  writeFileSync(join(output, 'evidence.json'), JSON.stringify({ schema_version: 'hid.tuf.workspace-ci-evidence/v1',
    source_sha: source, repository: process.env.GITHUB_REPOSITORY, run_id: process.env.GITHUB_RUN_ID,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT, results, publication_result: 'not-attempted' }, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(`${label}: ${result.status === 0 ? 'passed' : 'failed'}\n`)
  if (label === 'migration-rehearsal' && result.status === 0) {
    // Retain only the bounded summary; the synthetic backup and raw SQL logs
    // stay outside the uploaded workspace directory.
    copyFileSync(join(process.env.RUNNER_TEMP, 'synthetic-migration/evidence.json'), join(output, 'migration-evidence.json'))
  }
  if (result.error || result.status !== 0) { process.exitCode = 1; break }
}
