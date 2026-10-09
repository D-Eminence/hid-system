#!/usr/bin/env node
// Credential-free tooling job only. The manifest allowlists fields and files;
// it never serializes the process environment, command output, or raw claims.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export async function toolingEvidence(root, temporary, context) {
  assert.equal(context.GITHUB_ACTIONS, 'true')
  assert.match(context.TOOLING_SHA, /^[a-f0-9]{40}$/)
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), context.TOOLING_SHA)
  const steps = JSON.parse(context.GATE_STEPS_JSON)
  for (const gate of ['policy', 'audit', 'go_audit', 'reproducibility', 'package']) assert.equal(steps[gate]?.outcome, 'success', `gate ${gate} did not pass`)
  const file = async (path, name) => {
    const stat = await lstat(path)
    assert.ok(stat.isFile() && !stat.isSymbolicLink())
    const bytes = await readFile(path)
    return { name, size_in_bytes: bytes.length, sha256: hash(bytes) }
  }
  const binaries = []
  for (const name of ['hid-tuf', 'hid-tuf-repo', 'hid-tuf-publication', 'hid-tuf-journal', 'hid-tuf-signing-broker']) {
    const first = await file(resolve(root, `tools/tuf-release/bin/${name}-a`), `${name}-a`)
    const second = await file(resolve(root, `tools/tuf-release/bin/${name}-b`), `${name}-b`)
    assert.equal(first.sha256, second.sha256)
    binaries.push({ name, builds: [first, second], reproducible: true })
  }
  const lockfiles = []
  for (const name of ['release/package-lock.json', 'infra/cloudflare/package-lock.json', 'infra/aws/package-lock.json', 'tools/tuf-release/go.sum']) {
    lockfiles.push(await file(resolve(root, name), name))
  }
  return {
    schema_version: 'hid.tuf.ci-tooling-evidence/v1', recorded_at: new Date().toISOString(),
    repository: context.GITHUB_REPOSITORY, repository_id: context.GITHUB_REPOSITORY_ID, owner_id: context.GITHUB_REPOSITORY_OWNER_ID,
    tooling_sha: context.TOOLING_SHA, caller_sha: context.GITHUB_SHA, protected_ref: context.GITHUB_REF,
    ref_protected: context.GITHUB_REF_PROTECTED === 'true', event: context.GITHUB_EVENT_NAME,
    run_id: context.GITHUB_RUN_ID, run_attempt: context.GITHUB_RUN_ATTEMPT, workflow_ref: context.GITHUB_WORKFLOW_REF,
    environment: JSON.parse(context.PLAN_JSON).environment,
    gates: Object.fromEntries(['policy', 'audit', 'go_audit', 'reproducibility', 'package'].map(name => [name, steps[name].outcome])),
    toolchain: { node: process.version, go: execFileSync('go', ['version'], { encoding: 'utf8' }).trim(),
      flags: 'GOENV=off GOTOOLCHAIN=local GOOS=linux GOARCH=amd64 GOAMD64=v1 CGO_ENABLED=0 -mod=readonly -trimpath -buildvcs=false -ldflags=-buildid=' },
    tooling_archive: await file(resolve(temporary, 'tooling.tar.gz'), 'tooling.tar.gz'), binaries, lockfiles,
    result: 'tooling-verified', publication_result: 'not-attempted',
    audit_detail: 'Exact commands and results remain in the identified GitHub job logs; export and hash those logs after run completion',
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3)
    const evidence = await toolingEvidence(resolve(fileURLToPath(new URL('../..', import.meta.url))), process.env.RUNNER_TEMP, process.env)
    await writeFile(process.argv[2], `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch { process.stderr.write('tooling evidence incomplete or inconsistent\n'); process.exitCode = 1 }
}
