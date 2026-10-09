#!/usr/bin/env node
// Credential-free job evidence. All paths and context fields are allowlisted.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const e = process.env, sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(e.GITHUB_ACTIONS, 'true')
assert.match(e.GITHUB_SHA, /^[a-f0-9]{40}$/)
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), e.GITHUB_SHA)
const steps = JSON.parse(e.GATE_STEPS_JSON)
const gates = Object.entries(steps).filter(([id]) => id.startsWith('gate_')).map(([id, value]) => ({ id, outcome: value.outcome }))
assert.ok(gates.length > 0 && gates.every(gate => gate.outcome === 'success'))
const artifacts = []
async function add(path, name) {
  const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink())
  const bytes = await readFile(path); artifacts.push({ name, size_bytes: bytes.length, sha256: sha256(bytes) })
}
for (const path of ['.github/workflows/tuf-local-gates.yml', 'tools/tuf-release/toolchain/verified-upstream-build.json',
  'tools/tuf-release/toolchain/production-build.json',
  'tools/tuf-release/go.mod', 'tools/tuf-release/go.sum', 'release/config/components.json']) await add(path, path)
for (const directory of ['hid-tuf-client-reproducibility', 'hid-tuf-signing-broker-reproducibility', 'hid-tuf-operator-reproducibility', 'upstream-tuf-client-reproducibility']) {
  const path = join(e.RUNNER_TEMP, directory)
  let entries
  try { entries = await readdir(path, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
  for (const entry of entries) if (entry.isFile() && /^(?:hid-tuf(?:-repo|-publication|-journal)?|bootstrap|tuf-client)-[ab]$/.test(entry.name)) await add(join(path, entry.name), `${directory}/${entry.name}`)
}
const result = { schema_version: 'hid.tuf.local-ci-gates/v1', recorded_at: new Date().toISOString(),
  repository: e.GITHUB_REPOSITORY, repository_id: e.GITHUB_REPOSITORY_ID, owner_id: e.GITHUB_REPOSITORY_OWNER_ID,
  source_sha: e.GITHUB_SHA, ref: e.GITHUB_REF, ref_protected: e.GITHUB_REF_PROTECTED === 'true', event: e.GITHUB_EVENT_NAME,
  run_id: e.GITHUB_RUN_ID, run_attempt: e.GITHUB_RUN_ATTEMPT, job: e.GITHUB_JOB, workflow_ref: e.GITHUB_WORKFLOW_REF,
  workflow_sha: e.GITHUB_WORKFLOW_SHA, gates, artifacts, node: process.version,
  environment: 'credential-free-validation', publication_result: 'not-attempted',
  evidence_scope: 'Local CI checks only; independently verify all job results and export run logs through the GitHub API. Not signed release provenance.' }
await writeFile(join(e.RUNNER_TEMP, 'local-gate-evidence.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
