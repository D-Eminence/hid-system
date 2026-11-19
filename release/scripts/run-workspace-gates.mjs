#!/usr/bin/env node
// Fixed credential-free commands, with independently hashable logs.
//
// Usage: node release/scripts/run-workspace-gates.mjs <build-verify|test|migration-rehearsal>
//
// Each workspace job runs its own fixed list of gates. A pull request run may
// pass a narrower list in HID_WORKSPACE_GATES (chosen by
// select-local-gates.mjs); the runner accepts only one of the lists in
// WORKSPACE_SELECTIONS for its job, and runs the job's full list when the
// variable is missing, empty or anything else. Every gate the job did not run
// is recorded in evidence.json with the reason.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { openSync, closeSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORKSPACE_SELECTIONS } from './select-local-gates.mjs'

// `npm --prefix release test`, `npm --prefix release run verify` and
// `npm --prefix apps/ehr test` are not repeated here: the release-contracts and
// ehr-release-cache jobs run them in the same workflow run on the same commit,
// and verify-publication-workflow.mjs refuses any condition on those jobs.
export const GATES = Object.freeze(new Map([
  ['build', ['npm', 'run', 'build']],
  ['verify', ['npm', 'run', 'verify']],
  // The secret scan without the built frontend artifacts, for a pull request
  // that runs no build; the verify gate runs the full scan.
  ['secret-readiness', ['node', 'scripts/verify-secret-readiness.mjs', '--sources-only']],
  ['test', ['npm', 'test']],
  ['staging-preparation', ['npm', 'run', 'test:staging-preparation']],
  ['shared-packages', ['npm', 'run', 'build:test-prerequisites']],
  ['migration-rehearsal', ['node', 'scripts/tuf-staging-migration-rehearsal.mjs', '--evidence-dir', '<RUNNER_TEMP>/synthetic-migration']],
  ['diff-check', ['git', 'diff', '--check']],
]))
for (const lists of Object.values(WORKSPACE_SELECTIONS)) for (const list of Object.values(lists)) for (const gate of list) assert.ok(GATES.has(gate), gate)

// The gates that one job runs: its full list unless `requested` names exactly
// one of the lists the job accepts.
export function resolveGates(job, requested) {
  assert.ok(Object.hasOwn(WORKSPACE_SELECTIONS, job), `unknown workspace job ${JSON.stringify(job)}`)
  const { full, ...narrower } = WORKSPACE_SELECTIONS[job]
  const fallback = reason => ({ mode: 'all', reason, gates: [...full], skipped: [] })
  if (requested === undefined || requested === null || requested.trim() === '') return fallback('no gate list was given, so every gate of this job runs')
  if (requested.length > 200 || !/^[a-z,-]+$/.test(requested)) return fallback('the gate list is malformed, so every gate of this job runs')
  const names = requested.split(',')
  if (names.some(name => !GATES.has(name))) return fallback('the gate list names an unknown gate, so every gate of this job runs')
  if (new Set(names).size !== names.length) return fallback('the gate list repeats a gate, so every gate of this job runs')
  const sameSet = list => list.length === names.length && list.every(name => names.includes(name))
  if (sameSet(full)) return { mode: 'all', reason: 'every gate of this job was selected', gates: [...full], skipped: [] }
  const match = Object.values(narrower).find(sameSet)
  if (!match) return fallback('the gate list is not one this job accepts, so every gate of this job runs')
  return { mode: 'selected', reason: 'selected from the paths the pull request changes', gates: [...match],
    skipped: full.filter(gate => !match.includes(gate)) }
}

function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  const job = process.argv[2]
  assert.equal(process.argv.length, 3, 'Usage: run-workspace-gates.mjs <build-verify|test|migration-rehearsal>')
  const selection = resolveGates(job, process.env.HID_WORKSPACE_GATES)
  const skipReason = (process.env.HID_WORKSPACE_SKIP_REASON ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 300) ||
    'not needed for the paths this pull request changes'
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.equal(source, process.env.GITHUB_SHA)
  const output = join(process.env.RUNNER_TEMP, 'workspace-gates')
  mkdirSync(output, { mode: 0o700 })
  const commandFor = label => GATES.get(label).map(arg => arg.replace('<RUNNER_TEMP>', process.env.RUNNER_TEMP))
  const gateSelection = { job, requested: process.env.HID_WORKSPACE_GATES ?? null, mode: selection.mode, reason: selection.reason,
    gates: selection.gates, skipped: selection.skipped.map(gate => ({ gate, command: commandFor(gate), reason: skipReason })) }
  const results = []
  const record = () => writeFileSync(join(output, 'evidence.json'), JSON.stringify({ schema_version: 'hid.tuf.workspace-ci-evidence/v2',
    source_sha: source, repository: process.env.GITHUB_REPOSITORY, run_id: process.env.GITHUB_RUN_ID,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT, event: process.env.GITHUB_EVENT_NAME ?? null, gate_selection: gateSelection,
    results, publication_result: 'not-attempted' }, null, 2) + '\n', { mode: 0o600 })
  record()
  process.stdout.write(`${job}: ${selection.mode === 'all' ? 'every gate' : 'selected gates'} (${selection.reason})\n`)
  for (const skip of gateSelection.skipped) process.stdout.write(`${skip.gate}: skipped (${skip.reason})\n`)
  for (const label of selection.gates) {
    const [executable, ...args] = commandFor(label)
    const started = new Date().toISOString(), path = join(output, `${label}.log`), fd = openSync(path, 'wx', 0o600)
    let result
    try { result = spawnSync(executable, args, { stdio: ['ignore', fd, fd], timeout: 1800000, env: process.env }) } finally { closeSync(fd) }
    results.push({ label, command: [executable, ...args], started_at: started, completed_at: new Date().toISOString(),
      exit_code: result.status, execution_error: result.error?.code ?? null,
      log: `${label}.log`, log_sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })
    record()
    process.stdout.write(`${label}: ${result.status === 0 ? 'passed' : 'failed'}\n`)
    if (label === 'migration-rehearsal' && result.status === 0) {
      // Retain only the bounded summary; the synthetic backup and raw SQL logs
      // stay outside the uploaded workspace directory.
      copyFileSync(join(process.env.RUNNER_TEMP, 'synthetic-migration/evidence.json'), join(output, 'migration-evidence.json'))
    }
    if (result.error || result.status !== 0) { process.exitCode = 1; break }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
