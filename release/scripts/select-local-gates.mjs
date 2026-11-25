#!/usr/bin/env node
// Chooses which TUF local gate jobs a pull request run needs, from the paths
// the pull request changes. Only pull request runs are narrowed: a push,
// manual or scheduled run always runs every gate, and so does any run where
// the changed paths cannot be read for certain (no merge commit, a missing or
// zero base, a diff error, an empty diff, more than MAX_CHANGED_PATHS paths)
// or where one path matches no rule below. The four audit jobs (release
// contracts, AWS release trust, Cloudflare TUF, EHR release cache) are not
// chosen here: they have no condition and always run.
//
// The path rules live in this file, not in the workflow, because
// verify-publication-workflow.mjs refuses any workflow step outside the audit
// steps whose text names the security/ directory.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCHEMA_VERSION = 'hid.tuf.local-gate-selection/v1'
export const MAX_CHANGED_PATHS = 300
export const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url))

// The gate lists each workspace job accepts; run-workspace-gates.mjs refuses
// any other list and then runs the job's full list instead.
export const WORKSPACE_SELECTIONS = Object.freeze({
  'build-verify': Object.freeze({ full: Object.freeze(['build', 'verify', 'diff-check']), light: Object.freeze(['secret-readiness', 'diff-check']) }),
  test: Object.freeze({ full: Object.freeze(['test', 'diff-check']), light: Object.freeze(['staging-preparation', 'diff-check']) }),
  'migration-rehearsal': Object.freeze({ full: Object.freeze(['shared-packages', 'migration-rehearsal', 'diff-check']) }),
})

// Changing one of these changes how gates are chosen or run, so it runs every gate.
export const SELECT_EVERYTHING = Object.freeze([
  '.github/workflows/tuf-local-gates.yml',
  'release/scripts/select-local-gates.mjs',
  'release/scripts/run-workspace-gates.mjs',
  'package.json',
  '.gitattributes',
  '.gitignore',
  // Imported by the frontend builds (ports.mjs, from each vite.config.ts) and
  // by the EHR database scripts the rehearsal runs (local-environment.mjs).
  'scripts/ports.mjs',
  'scripts/local-environment.mjs',
])

// Services the migration rehearsal loads from source: the rehearsal and the
// runtime verifiers it runs boot each of them under the exact database roles
// (verify-records-processing-runtime.mjs boots ocr-api), and
// verify-provider-enrollment-runtime.mjs checks Identity's staff invitations
// against notification-api's own route DTO, recipient check and templates.
export const REHEARSAL_SERVICES = Object.freeze(['identity-api', 'ehr-api', 'lab-api', 'pharmacy-api', 'ocr-api', 'notification-api'])
// Shared packages those services load at run time.
export const REHEARSAL_PACKAGES = Object.freeze(['api-client', 'server-telemetry'])
// The rehearsal script and the repository scripts it imports or runs.
export const REHEARSAL_SCRIPTS = Object.freeze([
  'scripts/tuf-staging-migration-rehearsal.mjs',
  'scripts/prepare-staging-journey-fixture.mjs',
  'scripts/private-custody.mjs',
  'scripts/verify-migration-ledger.mjs',
])

// Paths the TUF client and upstream oracle jobs read beyond tools/.
export const GO_JOB_FILES = Object.freeze([
  'release/scripts/go-vulnerability-gate.mjs',
  'release/scripts/collect-local-gate-evidence.mjs',
])

// config/ files mapped to the workspace gates that read them, found by
// searching the repository for each file name. Only the production backend
// workflow and its scripts, the migration SQL comments, and an EHR staging
// upgrade script that no gate here runs name production-schema-compatibility.json,
// so it needs no workspace gate. A config file not listed here runs every gate.
export const CONFIG_READERS = Object.freeze({
  'config/production-schema-compatibility.json': Object.freeze([]),
})

// The docs/codes files the EHR migration image carries, by name (services/ehr-api/Dockerfile; ORD-7's catalogue
// load reads them there). verify-container-platform.mjs, part of npm run verify, checks the image carries exactly
// these, so a change to one runs the build and verify gate as well as the staging preparation tests; any other
// docs/codes file (a draft list) never ships and runs those tests only.
export const MIGRATION_IMAGE_CODES = Object.freeze(['docs/codes/catalog-approvals.json', 'docs/codes/hid-lab-codes.json',
  'docs/codes/hid-medicines.json', 'docs/codes/hid-lab-tests.json'])

const EFFECTS = Object.freeze(['go', 'build-verify', 'test', 'staging-preparation', 'migration-rehearsal'])

// Root package.json scripts that run repository scripts during the build,
// test and verify gates, and every local module those scripts import.
export function verificationScripts(root = REPOSITORY_ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const found = new Set()
  for (const command of Object.values(manifest.scripts ?? {})) {
    for (const match of String(command).matchAll(/(?:^|[\s&;|])(?:node|bash)\s+(scripts\/[A-Za-z0-9._/-]+\.(?:mjs|js|sh))\b/g)) found.add(match[1])
  }
  const pending = [...found]
  while (pending.length > 0) {
    const path = pending.pop()
    let source
    try { source = readFileSync(join(root, path), 'utf8') } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    for (const match of source.matchAll(/\bfrom\s+['"](\.\.?\/[^'"]+)['"]|\bimport\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
      const target = posix.normalize(posix.join(posix.dirname(path), match[1] ?? match[2]))
      if (target.startsWith('scripts/') && !found.has(target)) { found.add(target); pending.push(target) }
    }
  }
  return Object.freeze([...found].sort())
}

const under = (path, ...prefixes) => prefixes.some(prefix => path.startsWith(prefix))
const rehearsalPath = path => under(path, 'services/ehr-api/database/', 'services/ehr-api/scripts/', 'release/migration/') ||
  /^services\/[^/]+\/scripts\/verify-[^/]*-runtime\.mjs$/.test(path) ||
  REHEARSAL_SERVICES.some(service => path.startsWith(`services/${service}/`)) ||
  REHEARSAL_PACKAGES.some(name => path.startsWith(`packages/${name}/`)) ||
  REHEARSAL_SCRIPTS.includes(path)

// Returns the rule a path matches and the gates it needs: 'all' for every
// gate, or a list of effects. A path that matches no rule runs every gate.
export function classifyPath(path, { verifyScripts = verificationScripts() } = {}) {
  assert.equal(typeof path, 'string')
  if (path === '' || path.startsWith('/') || path.split('/').some(part => part === '' || part === '.' || part === '..') || /[\0\n\r]/.test(path)) return { rule: 'unreadable path', effects: 'all' }
  if (SELECT_EVERYTHING.includes(path)) return { rule: 'selector, gate runner, workflow or root configuration', effects: 'all' }
  if (path.startsWith('.github/')) return { rule: 'workflow or repository settings', effects: 'all' }
  const name = posix.basename(path)
  const effects = new Set()
  if (name === 'package-lock.json' || name === 'package.json') {
    // Dependencies: every workspace gate installs from these.
    return { rule: 'package manifest or lockfile', effects: ['build-verify', 'test', 'migration-rehearsal'] }
  }
  if (path.startsWith('tools/')) return { rule: 'TUF release tooling', effects: ['go'] }
  if (GO_JOB_FILES.includes(path)) return { rule: 'TUF client job script', effects: ['go'] }
  if (path.startsWith('release/test/')) return { rule: 'release tests (run by the always-on release contracts job)', effects: [] }
  if (path.startsWith('release/migration/')) return { rule: 'synthetic migration fixture', effects: ['migration-rehearsal', 'staging-preparation'] }
  if (path.startsWith('release/')) {
    // Read by the Cloudflare and AWS infrastructure tests and verifiers and by
    // the staging preparation tests; the release tests themselves always run.
    return { rule: 'release scripts, schemas and configuration', effects: ['build-verify', 'test'] }
  }
  if (under(path, 'apps/', 'services/', 'packages/', 'infra/', 'gateway/')) {
    effects.add('build-verify'); effects.add('test')
    if (rehearsalPath(path)) effects.add('migration-rehearsal')
    return { rule: rehearsalPath(path) ? 'application code with database roles' : 'application or infrastructure code', effects: [...effects] }
  }
  if (path.startsWith('scripts/')) {
    effects.add('staging-preparation')
    if (verifyScripts.includes(path)) { effects.add('build-verify'); effects.add('test') }
    if (REHEARSAL_SCRIPTS.includes(path)) effects.add('migration-rehearsal')
    return { rule: 'repository scripts', effects: [...effects] }
  }
  if (MIGRATION_IMAGE_CODES.includes(path)) return { rule: 'catalogue files the EHR migration image carries', effects: ['build-verify', 'staging-preparation'] }
  if (path === 'docs/INTERFACE_CONTRACT.md' || path.startsWith('docs/codes/')) return { rule: 'documents read by the staging preparation tests', effects: ['staging-preparation'] }
  if (path.startsWith('docs/') || path === 'README.md' || path === 'CODEX.md') return { rule: 'documentation (secret scan only)', effects: [] }
  if (path === '.dockerignore') return { rule: 'container build context', effects: ['build-verify'] }
  if (Object.hasOwn(CONFIG_READERS, path)) return { rule: 'configuration with known readers', effects: [...CONFIG_READERS[path]] }
  // Release-time evidence and policy for the production workflows; no
  // workspace gate reads it, and the audit jobs that read the npm audit
  // exceptions always run.
  if (path.startsWith('security/')) return { rule: 'production release evidence and policy', effects: [] }
  return { rule: 'no rule', effects: 'all' }
}

function fullPlan(event, reason, extra = {}) {
  return finish({ event, mode: 'full', full_reason: reason, effects: new Set(EFFECTS), paths: [], ...extra })
}

function finish({ event, mode, full_reason = null, effects, paths, base_sha = null, head_sha = null }) {
  const reasonFor = gateName => mode === 'full'
    ? `every gate runs: ${full_reason}`
    : `no changed path needs ${gateName}`
  const workspace = effects.has('build-verify') ? 'full' : 'light'
  const test = effects.has('test') ? 'full' : effects.has('staging-preparation') ? 'light' : 'none'
  const skippedWorkspace = workspace === 'full' ? [] : ['build', 'verify'].map(gate => ({ gate, reason: reasonFor('the full build and verify') }))
  const testSkip = { gate: 'test', reason: reasonFor('the full workspace test suite') }
  const jobs = {
    'tuf-client': { run: effects.has('go'), reason: effects.has('go') ? null : reasonFor('the TUF client tooling') },
    'upstream-reference': { run: effects.has('go'), reason: effects.has('go') ? null : reasonFor('the TUF client tooling') },
    workspace: { run: true, gates: WORKSPACE_SELECTIONS['build-verify'][workspace], install: workspace === 'full' ? 'all' : 'none', skipped: skippedWorkspace },
    'workspace-test': test === 'none'
      ? { run: false, gates: [], install: 'none', skipped: [testSkip, { gate: 'staging-preparation', reason: reasonFor('the staging preparation tests') }] }
      : { run: true, gates: WORKSPACE_SELECTIONS.test[test], install: test === 'full' ? 'all' : 'staging-preparation', skipped: test === 'full' ? [] : [testSkip] },
    'migration-rehearsal': effects.has('migration-rehearsal')
      ? { run: true, gates: WORKSPACE_SELECTIONS['migration-rehearsal'].full, skipped: [] }
      : { run: false, gates: [], skipped: [{ gate: 'migration-rehearsal', reason: reasonFor('the synthetic migration rehearsal') }] },
  }
  return { schema_version: SCHEMA_VERSION, event, mode, full_reason, base_sha, head_sha, changed_path_count: paths.length, paths, jobs }
}

// Pure selection from an event and the changed paths (null when they could not be read).
export function selectLocalGates({ event, paths, diffError = null, baseSha = null, headSha = null, verifyScripts = verificationScripts() }) {
  if (event !== 'pull_request') return fullPlan(event ?? null, `event ${JSON.stringify(event ?? null)} is not a pull request`)
  const ids = { base_sha: baseSha, head_sha: headSha }
  if (diffError) return fullPlan(event, `changed paths could not be read: ${diffError}`, ids)
  if (typeof baseSha !== 'string' || !/^[0-9a-f]{40}$/.test(baseSha) || /^0+$/.test(baseSha)) return fullPlan(event, 'base commit is missing or zero', ids)
  if (!Array.isArray(paths)) return fullPlan(event, 'changed paths could not be read', ids)
  if (paths.length === 0) return fullPlan(event, 'the diff is empty', ids)
  if (paths.length > MAX_CHANGED_PATHS) return fullPlan(event, `more than ${MAX_CHANGED_PATHS} changed paths`, ids)
  const effects = new Set()
  const matched = []
  for (const path of paths) {
    const { rule, effects: needs } = classifyPath(path, { verifyScripts })
    matched.push({ path, rule, gates: needs === 'all' ? 'all' : [...needs].sort() })
    if (needs === 'all') return fullPlan(event, `${JSON.stringify(path)} matches rule "${rule}"`, { ...ids, paths: matched })
    for (const effect of needs) effects.add(effect)
  }
  return finish({ event, mode: 'selected', effects, paths: matched, ...ids })
}

// GitHub step outputs. Each one is phrased so that a missing or empty value
// (a failed or skipped changes job) makes the workflow run the gate.
export function workflowOutputs(plan) {
  const { jobs } = plan
  const outputs = {
    skip_go_jobs: String(!jobs['tuf-client'].run),
    workspace_gates: jobs.workspace.gates.join(','),
    workspace_install: jobs.workspace.install,
    skip_workspace_test: String(!jobs['workspace-test'].run),
    test_gates: jobs['workspace-test'].gates.join(','),
    test_install: jobs['workspace-test'].install,
    skip_migration_rehearsal: String(!jobs['migration-rehearsal'].run),
    reason: plan.mode === 'full' ? `every gate: ${plan.full_reason}` : `selected from ${plan.changed_path_count} changed paths`,
  }
  for (const [key, value] of Object.entries(outputs)) assert.ok(!/[\r\n]/.test(value), `output ${key} must be one line`)
  return outputs
}

function git(args) {
  return execFileSync('git', args, { cwd: REPOSITORY_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

// Reads the pull request merge commit the runner checked out (fetch-depth 2):
// its first parent is the base branch tip, so its diff is the pull request.
export function readPullRequestChanges() {
  const head = git(['rev-parse', '--verify', 'HEAD']).trim()
  if (process.env.GITHUB_SHA && head !== process.env.GITHUB_SHA) throw new Error('checked-out commit is not the event commit')
  const parents = git(['rev-list', '--parents', '--max-count=1', head]).trim().split(/\s+/).slice(1)
  if (parents.length !== 2) throw new Error(`checked-out commit has ${parents.length} parents, not a pull request merge commit`)
  const base = parents[0]
  const paths = git(['diff', '--no-renames', '--name-only', '-z', base, head]).split('\0').filter(Boolean)
  return { baseSha: base, headSha: head, paths }
}

function main() {
  const event = process.env.GITHUB_EVENT_NAME ?? null
  let plan
  try {
    if (event !== 'pull_request') plan = selectLocalGates({ event, paths: null })
    else {
      let changes = null, diffError = null
      try { changes = readPullRequestChanges() } catch (error) { diffError = String(error?.message ?? error).split('\n')[0].slice(0, 300) }
      plan = selectLocalGates({ event, paths: changes?.paths ?? null, diffError, baseSha: changes?.baseSha ?? null, headSha: changes?.headSha ?? null })
    }
  } catch (error) {
    plan = fullPlan(event, `selector error: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`)
  }
  const outputs = workflowOutputs(plan)
  if (process.env.RUNNER_TEMP) {
    const directory = join(process.env.RUNNER_TEMP, 'local-gate-selection')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, 'evidence.json'), `${JSON.stringify({ ...plan, source_sha: process.env.GITHUB_SHA ?? null,
      repository: process.env.GITHUB_REPOSITORY ?? null, run_id: process.env.GITHUB_RUN_ID ?? null,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null, outputs }, null, 2)}\n`, { mode: 0o600 })
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''))
  process.stdout.write(`${outputs.reason}\n`)
  for (const [job, decision] of Object.entries(plan.jobs)) {
    process.stdout.write(`${job}: ${decision.run ? `runs ${(decision.gates ?? []).join(', ') || 'all steps'}` : 'skipped'}\n`)
    for (const skip of decision.skipped ?? []) process.stdout.write(`  skipped ${skip.gate}: ${skip.reason}\n`)
    if (decision.reason) process.stdout.write(`  ${decision.reason}\n`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
