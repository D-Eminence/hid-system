import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONFIG_READERS, MAX_CHANGED_PATHS, REHEARSAL_PACKAGES, REHEARSAL_SCRIPTS, REHEARSAL_SERVICES, REPOSITORY_ROOT, SELECT_EVERYTHING,
  WORKSPACE_SELECTIONS, classifyPath, selectLocalGates, verificationScripts, workflowOutputs,
} from '../scripts/select-local-gates.mjs'
import { GATES, resolveGates } from '../scripts/run-workspace-gates.mjs'
import { LOCAL_GATE_AUDITS, parseWorkflow, verifyLocalGateWorkflow } from '../scripts/verify-publication-workflow.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const localGates = readFileSync(new URL('../../.github/workflows/tuf-local-gates.yml', import.meta.url), 'utf8')
const BASE = 'a'.repeat(40)
const pr = (paths, extra = {}) => selectLocalGates({ event: 'pull_request', paths, baseSha: BASE, headSha: 'b'.repeat(40), ...extra })
const ALL_JOBS_RUN = plan => {
  assert.equal(plan.mode, 'full')
  for (const job of ['tuf-client', 'upstream-reference', 'workspace', 'workspace-test', 'migration-rehearsal']) assert.equal(plan.jobs[job].run, true, job)
  assert.deepEqual(plan.jobs.workspace.gates, WORKSPACE_SELECTIONS['build-verify'].full)
  assert.deepEqual(plan.jobs['workspace-test'].gates, WORKSPACE_SELECTIONS.test.full)
  assert.deepEqual(plan.jobs['migration-rehearsal'].gates, WORKSPACE_SELECTIONS['migration-rehearsal'].full)
  assert.equal(plan.jobs.workspace.install, 'all')
  assert.equal(plan.jobs['workspace-test'].install, 'all')
  const outputs = workflowOutputs(plan)
  assert.equal(outputs.skip_go_jobs, 'false')
  assert.equal(outputs.skip_workspace_test, 'false')
  assert.equal(outputs.skip_migration_rehearsal, 'false')
  return plan
}
const ran = plan => Object.fromEntries(Object.entries(plan.jobs).map(([job, decision]) => [job, decision.run ? (decision.gates ?? true) : false]))

test('push, manual, scheduled and unknown events run every gate whatever changed', () => {
  for (const event of ['push', 'workflow_dispatch', 'schedule', 'merge_group', 'pull_request_target', undefined, null]) {
    const plan = ALL_JOBS_RUN(selectLocalGates({ event, paths: ['docs/README.md'], baseSha: BASE }))
    assert.match(plan.full_reason, /is not a pull request/)
  }
})

test('a pull request whose changed paths cannot be read for certain runs every gate', () => {
  const cases = {
    'diff error': pr(['docs/README.md'], { diffError: 'fatal: bad object' }),
    'missing base': pr(['docs/README.md'], { baseSha: null }),
    'zero base': pr(['docs/README.md'], { baseSha: '0'.repeat(40) }),
    'malformed base': pr(['docs/README.md'], { baseSha: 'HEAD^1' }),
    'unreadable paths': pr(null),
    'empty diff': pr([]),
    'too many paths': pr(Array.from({ length: MAX_CHANGED_PATHS + 1 }, (_, i) => `docs/n${i}.md`)),
  }
  for (const [name, plan] of Object.entries(cases)) assert.doesNotThrow(() => ALL_JOBS_RUN(plan), name)
  assert.equal(pr(Array.from({ length: MAX_CHANGED_PATHS }, (_, i) => `docs/n${i}.md`)).mode, 'selected')
})

test('a path that matches no rule, or one that changes how gates are chosen or run, runs every gate', () => {
  const everything = [...SELECT_EVERYTHING, '.github/workflows/production-backend-images.yml', '.github/CODEOWNERS',
    'Makefile', 'newdir/file.txt', 'config/new-settings.json', 'docs/../package.json', './docs/a.md', 'docs//a.md', '/etc/passwd', 'docs/a\nb.md']
  for (const path of everything) {
    const plan = ALL_JOBS_RUN(pr(['docs/README.md', path]))
    assert.match(plan.full_reason, /matches rule/, path)
  }
  // A path with a line break is reported on one line.
  assert.ok(!/\n/.test(workflowOutputs(pr(['docs/a\nb.md'])).reason))
})

test('documentation runs only the secret scan and the whitespace check', () => {
  const plan = pr(['docs/ARCHITECTURE.md', 'README.md', 'CODEX.md', 'security/production-runtime-assessment.json',
    'config/production-schema-compatibility.json', 'release/test/publication-workflow.test.mjs'])
  assert.equal(plan.mode, 'selected')
  assert.deepEqual(ran(plan), { 'tuf-client': false, 'upstream-reference': false, workspace: ['secret-readiness', 'diff-check'], 'workspace-test': false, 'migration-rehearsal': false })
  assert.equal(plan.jobs.workspace.install, 'none')
  assert.deepEqual(plan.jobs.workspace.skipped.map(s => s.gate), ['build', 'verify'])
  assert.deepEqual(plan.jobs['workspace-test'].skipped.map(s => s.gate), ['test', 'staging-preparation'])
  assert.deepEqual(plan.jobs['migration-rehearsal'].skipped.map(s => s.gate), ['migration-rehearsal'])
  for (const decision of Object.values(plan.jobs)) for (const skip of decision.skipped ?? []) assert.match(skip.reason, /no changed path needs/)
  assert.deepEqual(workflowOutputs(plan), { skip_go_jobs: 'true', workspace_gates: 'secret-readiness,diff-check', workspace_install: 'none',
    skip_workspace_test: 'true', test_gates: '', test_install: 'none', skip_migration_rehearsal: 'true', reason: 'selected from 6 changed paths' })
})

test('documents and scripts read by the staging preparation tests run those tests only', () => {
  for (const path of ['docs/INTERFACE_CONTRACT.md', 'docs/codes/hid-lab-codes.json', 'scripts/tests/staging-capacity.test.mjs',
    'scripts/production_deployment.py', 'scripts/staging-provider-secret.py', 'scripts/production-backend-build.mjs']) {
    const plan = pr([path])
    assert.deepEqual(ran(plan), { 'tuf-client': false, 'upstream-reference': false, workspace: ['secret-readiness', 'diff-check'],
      'workspace-test': ['staging-preparation', 'diff-check'], 'migration-rehearsal': false }, path)
    assert.equal(plan.jobs['workspace-test'].install, 'staging-preparation')
    assert.deepEqual(plan.jobs['workspace-test'].skipped.map(s => s.gate), ['test'])
  }
})

test('code outside the database roles builds, verifies and tests everything but skips the rehearsal and Go jobs', () => {
  for (const path of ['services/ocr-worker/src/worker.ts', 'apps/web/src/main.tsx', 'packages/ui/src/index.ts', 'infra/aws/src/stack.ts',
    'gateway/nginx.conf.template', 'services/workload-token-agent/src/health.mjs', 'release/scripts/admit-release.mjs', 'release/config/components.json',
    'scripts/verify-container-platform.mjs', 'scripts/verification-paths.mjs', 'scripts/verify-secret-readiness.mjs']) {
    const plan = pr([path])
    assert.deepEqual(ran(plan), { 'tuf-client': false, 'upstream-reference': false, workspace: ['build', 'verify', 'diff-check'],
      'workspace-test': ['test', 'diff-check'], 'migration-rehearsal': false }, path)
    assert.equal(plan.jobs.workspace.install, 'all')
    assert.equal(plan.jobs['workspace-test'].install, 'all')
  }
  assert.deepEqual(ran(pr(['.dockerignore'])).workspace, ['build', 'verify', 'diff-check'])
})

test('database, migration, grant and runtime-verifier changes always run the rehearsal', () => {
  const rehearsal = ['services/ehr-api/database/migrations/0200_new.sql', 'services/ehr-api/database/runtime-grants.sql',
    'services/ehr-api/database/tests/x.integration.sql', 'services/ehr-api/scripts/apply-migrations.mjs',
    'services/notification-api/scripts/verify-delivery-runtime.mjs', 'services/identity-api/src/auth/auth.service.ts',
    'services/lab-api/src/lab/lab.service.ts', 'services/pharmacy-api/Dockerfile', 'services/ocr-api/src/ocr/ocr.service.ts',
    'packages/api-client/src/index.ts', 'packages/server-telemetry/src/index.ts', 'release/migration/synthetic-fixture.mjs',
    // verify-provider-enrollment-runtime.mjs checks Identity's staff invitations
    // against notification-api's own DTO, recipient check and templates.
    'services/notification-api/src/notification/dto/deliver-staff-invitation.dto.ts',
    'services/notification-api/src/notification/dto/deliver-otp.dto.ts', 'services/notification-api/src/providers/provider.types.ts',
    'services/notification-api/package-lock.json',
    'services/outreach-api/package-lock.json', 'apps/web/package.json', 'release/package-lock.json', ...REHEARSAL_SCRIPTS]
  for (const path of rehearsal) {
    const plan = pr([path])
    assert.equal(plan.jobs['migration-rehearsal'].run, true, path)
    assert.deepEqual(workflowOutputs(plan).skip_migration_rehearsal, 'false', path)
  }
  assert.deepEqual(ran(pr(['release/migration/synthetic-fixture.mjs'])), { 'tuf-client': false, 'upstream-reference': false,
    workspace: ['secret-readiness', 'diff-check'], 'workspace-test': ['staging-preparation', 'diff-check'],
    'migration-rehearsal': ['shared-packages', 'migration-rehearsal', 'diff-check'] })
  // The ledger is also part of npm run verify.
  assert.deepEqual(ran(pr(['scripts/verify-migration-ledger.mjs'])).workspace, ['build', 'verify', 'diff-check'])
  for (const path of ['services/outreach-api/src/outreach.ts', 'services/notification-worker/src/worker.ts', 'apps/ehr/src/main.tsx']) {
    assert.equal(pr([path]).jobs['migration-rehearsal'].run, false, path)
  }
})

test('TUF tooling changes run the Go jobs, and only they need them', () => {
  for (const path of ['tools/tuf-release/go.mod', 'tools/tuf-release/toolchain/production-build.json', 'tools/tuf-release/cmd/hid-tuf/main.go',
    'release/scripts/go-vulnerability-gate.mjs', 'release/scripts/collect-local-gate-evidence.mjs']) {
    const plan = pr([path])
    assert.equal(plan.jobs['tuf-client'].run, true, path)
    assert.equal(plan.jobs['upstream-reference'].run, true, path)
    assert.equal(workflowOutputs(plan).skip_go_jobs, 'false')
    assert.equal(plan.jobs['workspace-test'].run, false, path)
  }
  for (const path of ['services/ehr-api/src/x.ts', 'release/scripts/admit-release.mjs', 'docs/TUF-CI-PROTECTION.md']) {
    assert.equal(pr([path]).jobs['tuf-client'].run, false, path)
  }
})

test('the gates of several paths add up', () => {
  assert.deepEqual(ran(pr(['tools/tuf-release/go.sum', 'docs/codes/x.json', 'services/ehr-api/database/migrations/0201.sql'])), {
    'tuf-client': true, 'upstream-reference': true, workspace: ['build', 'verify', 'diff-check'], 'workspace-test': ['test', 'diff-check'],
    'migration-rehearsal': ['shared-packages', 'migration-rehearsal', 'diff-check'] })
})

test('the repository scripts that build and verify read are found from the root package.json and their imports', () => {
  const scripts = verificationScripts()
  for (const path of ['scripts/verify-container-platform.mjs', 'scripts/verify-frontend-platform.mjs', 'scripts/verify-platform-graph.mjs',
    'scripts/verify-production-convergence.mjs', 'scripts/verify-secret-readiness.mjs', 'scripts/verify-migration-ledger.mjs',
    'scripts/verification-paths.mjs', 'scripts/ports.mjs']) assert.ok(scripts.includes(path), path)
  for (const path of scripts) assert.ok(classifyPath(path, { verifyScripts: scripts }).effects === 'all' ||
    classifyPath(path, { verifyScripts: scripts }).effects.includes('build-verify'), path)
})

// The rehearsal job installs only some lockfiles and the selector runs the
// rehearsal only for some paths; both must cover what the rehearsal loads.
test('the rehearsal selection and install cover every service, package and script the rehearsal loads', () => {
  const rehearsal = readFileSync(new URL('../../scripts/tuf-staging-migration-rehearsal.mjs', import.meta.url), 'utf8')
  const verifiers = [...new Set([...rehearsal.matchAll(/services\/([a-z-]+)\/scripts\/(verify-[a-z-]+-runtime\.mjs)/g)].map(m => m[0]))]
  assert.ok(verifiers.length >= 5, 'the rehearsal runs its runtime verifiers')
  const services = new Set([...rehearsal.matchAll(/services\/([a-z-]+)/g)].map(m => m[1]))
  for (const verifier of verifiers) {
    const source = readFileSync(new URL(`../../${verifier}`, import.meta.url), 'utf8')
    // services/<name>, '<name>', '<name>/...' and '../<name>': every way a
    // verifier reaches another service's source or dependencies.
    for (const m of source.matchAll(/services\/([a-z-]+)|['"/](?:\.\.\/)*([a-z]+(?:-[a-z]+)*-(?:api|worker))['"/]/g)) services.add(m[1] ?? m[2])
    for (const m of source.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
      const target = posix.normalize(posix.join(posix.dirname(verifier), m[1]))
      assert.ok(REHEARSAL_SERVICES.some(s => target.startsWith(`services/${s}/`)), `${verifier} imports ${target}`)
    }
  }
  for (const service of services) assert.ok(REHEARSAL_SERVICES.includes(service), `the rehearsal boots ${service}`)
  // Local imports of the rehearsal script, followed through the scripts it imports.
  const pending = ['scripts/tuf-staging-migration-rehearsal.mjs'], seen = new Set(pending)
  while (pending.length) {
    const path = pending.pop()
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
    for (const m of source.matchAll(/from\s+'(\.\.?\/[^']+)'|\['(scripts\/[a-z-]+\.mjs)'\]/g)) {
      const target = m[2] ?? posix.normalize(posix.join(posix.dirname(path), m[1]))
      if (seen.has(target)) continue
      seen.add(target)
      assert.equal(pr([target]).jobs['migration-rehearsal'].run, true, `${path} loads ${target}`)
      if (target.startsWith('scripts/')) pending.push(target)
    }
  }
  assert.ok(seen.has('release/migration/synthetic-fixture.mjs') && seen.has('scripts/verify-migration-ledger.mjs'))
  const install = parseWorkflow(localGates).jobs['migration-rehearsal'].steps.find(s => /npm --prefix/.test(s.run ?? '')).run
  for (const directory of ['release', ...REHEARSAL_PACKAGES.map(p => `packages/${p}`), ...REHEARSAL_SERVICES.map(s => `services/${s}`)]) {
    assert.ok(install.split(/[\s;]+/).includes(directory), `the rehearsal job installs ${directory}`)
  }
})

test('every file that names a mapped config file is a production release reader that no local gate runs', () => {
  const allowed = [/^config\//, /^docs\//, /^\.github\/workflows\/production-backend-/, /^scripts\/(?:production|test_production)/,
    /^services\/ehr-api\/database\/migrations\//, /^services\/ehr-api\/scripts\/test-staging-schema-upgrade\.mjs$/,
    // The selector's own map and this test name the file but do not read it.
    /^release\/scripts\/select-local-gates\.mjs$/, /^release\/test\/select-local-gates\.test\.mjs$/]
  for (const [path, gates] of Object.entries(CONFIG_READERS)) {
    assert.deepEqual(gates, [])
    const readers = execFileSync('git', ['grep', '-l', '-F', posix.basename(path)], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
    assert.ok(readers.length > 0)
    for (const reader of readers) assert.ok(allowed.some(pattern => pattern.test(reader)), `${reader} reads ${path}: map it to its gate`)
  }
  // The staging upgrade script is not run by any local gate.
  assert.ok(!readFileSync(new URL('../../scripts/tuf-staging-migration-rehearsal.mjs', import.meta.url), 'utf8').includes('test-staging-schema-upgrade'))
})

test('no code that the workspace gates run reads the production release evidence and policy directory', () => {
  const directory = ['secu', 'rity/'].join('')
  const scopes = ['apps', 'services', 'packages', 'infra', 'gateway', 'scripts/tests', 'release/migration', ...verificationScripts(), ...REHEARSAL_SCRIPTS]
  let readers = ''
  try { readers = execFileSync('git', ['grep', '-l', '-F', directory, '--', ...scopes, ':!**/*.md'], { cwd: root, encoding: 'utf8' }) } catch (error) { if (error.status !== 1) throw error }
  assert.equal(readers.trim(), '', 'a workspace gate reads that directory: give its paths a workspace gate in select-local-gates.mjs')
})

test('the workspace gate runner accepts only the fixed gate lists of its job', () => {
  for (const [job, lists] of Object.entries(WORKSPACE_SELECTIONS)) {
    for (const requested of [undefined, null, '', '   ']) {
      assert.deepEqual(resolveGates(job, requested), { mode: 'all', reason: 'no gate list was given, so every gate of this job runs', gates: [...lists.full], skipped: [] })
    }
    assert.equal(resolveGates(job, lists.full.join(',')).mode, 'all')
    assert.equal(resolveGates(job, [...lists.full].reverse().join(',')).mode, 'all')
    for (const bad of ['nope', 'build;rm -rf', 'diff-check,diff-check', 'Build', 'diff-check', 'release-tests,diff-check', `${lists.full.join(',')},release-tests`, 'x'.repeat(201)]) {
      const result = resolveGates(job, bad)
      assert.equal(result.mode, 'all', `${job}: ${bad}`)
      assert.deepEqual(result.gates, [...lists.full])
      assert.deepEqual(result.skipped, [])
    }
  }
  assert.deepEqual(resolveGates('build-verify', 'diff-check,secret-readiness'), { mode: 'selected', reason: 'selected from the paths the pull request changes',
    gates: ['secret-readiness', 'diff-check'], skipped: ['build', 'verify'] })
  assert.deepEqual(resolveGates('test', 'staging-preparation,diff-check').skipped, ['test'])
  // A gate list from another job is refused, not run.
  assert.equal(resolveGates('test', 'secret-readiness,diff-check').mode, 'all')
  assert.equal(resolveGates('migration-rehearsal', 'staging-preparation,diff-check').mode, 'all')
  assert.equal(resolveGates('build-verify', 'test,diff-check').mode, 'all')
  assert.throws(() => resolveGates('workspace', ''), /unknown workspace job/)
  for (const gate of new Set(Object.values(WORKSPACE_SELECTIONS).flatMap(lists => Object.values(lists).flat()))) assert.ok(GATES.has(gate), gate)
  // Every gate of the former single workspace job still runs in one of the three jobs.
  for (const gate of ['build', 'test', 'verify', 'migration-rehearsal', 'diff-check']) {
    assert.ok(Object.values(WORKSPACE_SELECTIONS).some(lists => lists.full.includes(gate)), gate)
  }
  assert.ok(REPOSITORY_ROOT.endsWith('/'))
})

test('the workflow narrows only pull request runs, fails closed on missing outputs, and keeps the audit jobs unconditional', () => {
  assert.equal(verifyLocalGateWorkflow(localGates), true)
  const workflow = parseWorkflow(localGates)
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push', 'schedule', 'workflow_dispatch'])
  assert.equal(workflow.on.schedule.length, 1)
  assert.match(workflow.on.schedule[0].cron, /^\d+ \d+ \* \* [0-6]$/)
  for (const job of Object.keys(LOCAL_GATE_AUDITS)) {
    for (const key of ['if', 'needs']) assert.equal(workflow.jobs[job][key], undefined, `${job} ${key}`)
    assert.ok(!workflow.jobs[job].steps.some(step => step.uses?.startsWith('actions/cache@')), `${job} restores no cache`)
  }
  const { changes } = workflow.jobs
  assert.equal(changes.if, undefined)
  assert.equal(changes.needs, undefined)
  assert.equal(changes.steps.find(s => s.uses?.startsWith('actions/checkout@')).with['fetch-depth'], 2)
  assert.ok(changes.steps.some(s => s.id === 'select' && s.run === 'node release/scripts/select-local-gates.mjs'))
  const conditions = {
    'tuf-client': "${{ !cancelled() && (github.event_name != 'pull_request' || needs.changes.outputs.skip_go_jobs != 'true') }}",
    'upstream-reference': "${{ !cancelled() && (github.event_name != 'pull_request' || needs.changes.outputs.skip_go_jobs != 'true') }}",
    workspace: '${{ !cancelled() }}',
    'workspace-test': "${{ !cancelled() && (github.event_name != 'pull_request' || needs.changes.outputs.skip_workspace_test != 'true') }}",
    'migration-rehearsal': "${{ !cancelled() && (github.event_name != 'pull_request' || needs.changes.outputs.skip_migration_rehearsal != 'true') }}",
  }
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [...Object.keys(LOCAL_GATE_AUDITS), 'changes', 'workspace-complete', ...Object.keys(conditions)].sort())
  for (const [job, condition] of Object.entries(conditions)) {
    assert.equal(workflow.jobs[job].needs, 'changes', job)
    assert.equal(workflow.jobs[job].if, condition, job)
  }
  // Nothing waits on a job that a pull request may skip, so no job needs its
  // artifacts; only the required-check job below reads their results.
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== 'workspace-complete') assert.ok(job.needs === undefined || job.needs === 'changes', name)
  }
  const runner = { workspace: 'build-verify', 'workspace-test': 'test', 'migration-rehearsal': 'migration-rehearsal' }
  for (const [job, argument] of Object.entries(runner)) {
    const steps = workflow.jobs[job].steps
    const run = steps.find(s => s.run === `node release/scripts/run-workspace-gates.mjs ${argument}`)
    assert.ok(run, job)
    const gates = run.env?.HID_WORKSPACE_GATES
    if (job === 'migration-rehearsal') assert.equal(gates, undefined)
    else assert.match(gates, /^\$\{\{ github\.event_name == 'pull_request' && needs\.changes\.outputs\.[a-z_]+ \|\| '' \}\}$/, job)
    // No actions/cache: the repository's allowed-actions list does not include it.
    assert.ok(!steps.some(s => s.uses?.startsWith('actions/cache@')), `${job} restores no cache`)
    const upload = steps.find(s => s.uses?.startsWith('actions/upload-artifact@'))
    assert.equal(upload.if, '${{ always() }}')
    assert.equal(upload.with.name, `tuf-workspace-${argument}-\${{ github.run_id }}-\${{ github.run_attempt }}`)
  }
  // Only a pull request run can skip the workspace install.
  for (const step of workflow.jobs.workspace.steps.filter(s => s.if !== undefined && s.uses?.startsWith('actions/upload-artifact@') !== true)) {
    assert.equal(step.if, "${{ github.event_name != 'pull_request' || needs.changes.outputs.workspace_install != 'none' }}")
  }
  assert.equal(workflow.jobs['workspace-test'].steps.find(s => s.env?.HID_TEST_INSTALL).env.HID_TEST_INSTALL,
    "${{ github.event_name == 'pull_request' && needs.changes.outputs.test_install || 'all' }}")
  // Every action in the workflow is pinned to a full commit.
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) if (step.uses) assert.match(step.uses, /^[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/, step.uses)
})

// Branch protection on main and tuf-production-release requires a check named
// "Complete workspace verification" (the former single workspace job). The
// job that keeps that name must never be skipped, and must pass only when the
// three workspace jobs pass or the pull request selection skipped them.
test('the "Complete workspace verification" check runs on every event and fails closed', () => {
  const workflow = parseWorkflow(localGates)
  const job = workflow.jobs['workspace-complete']
  assert.equal(job.name, 'Complete workspace verification')
  assert.equal(Object.values(workflow.jobs).filter(j => j.name === 'Complete workspace verification').length, 1)
  // Every required check listed in the protection record is still reported by exactly one job.
  const protection = readFileSync(new URL('../../docs/TUF-CI-PROTECTION.md', import.meta.url), 'utf8')
  const listed = protection.slice(protection.indexOf('Required check names'))
  const required = [...listed.slice(0, listed.indexOf('\n\n', listed.indexOf('\n1. '))).matchAll(/^\d+\. `([^`]+)`$/gm)].map(m => m[1])
  assert.equal(required.length, 7)
  for (const name of required) assert.equal(Object.values(workflow.jobs).filter(j => j.name === name).length, 1, name)
  assert.deepEqual(job.needs, ['changes', 'workspace', 'workspace-test', 'migration-rehearsal'])
  // always(): a required check that is skipped counts as passed, so no
  // failure or skip upstream may skip this job.
  assert.equal(job.if, '${{ always() }}')
  assert.equal(job.container, undefined)
  assert.equal(job.services, undefined)
  assert.equal(job.steps.length, 1)
  const [step] = job.steps
  assert.equal(step.uses, undefined)
  assert.deepEqual(step.env, {
    EVENT_NAME: '${{ github.event_name }}',
    WORKSPACE_RESULT: '${{ needs.workspace.result }}',
    WORKSPACE_TEST_RESULT: '${{ needs.workspace-test.result }}',
    MIGRATION_REHEARSAL_RESULT: '${{ needs.migration-rehearsal.result }}',
    SKIP_WORKSPACE_TEST: '${{ needs.changes.outputs.skip_workspace_test }}',
    SKIP_MIGRATION_REHEARSAL: '${{ needs.changes.outputs.skip_migration_rehearsal }}',
  })
  assert.ok(!step.run.includes('${{'), 'no expression is interpolated into the shell script')
  const passes = env => {
    try {
      execFileSync('bash', ['-c', step.run], { env: { PATH: process.env.PATH, ...env }, stdio: 'pipe' })
      return true
    } catch (error) {
      if (typeof error.status !== 'number') throw error
      return false
    }
  }
  const ok = { EVENT_NAME: 'push', WORKSPACE_RESULT: 'success', WORKSPACE_TEST_RESULT: 'success', MIGRATION_REHEARSAL_RESULT: 'success',
    SKIP_WORKSPACE_TEST: 'false', SKIP_MIGRATION_REHEARSAL: 'false' }
  for (const event of ['push', 'workflow_dispatch', 'schedule', 'pull_request']) assert.equal(passes({ ...ok, EVENT_NAME: event }), true, event)
  // A pull request may skip the test and rehearsal jobs only when the changes job said so.
  const skippedPr = { ...ok, EVENT_NAME: 'pull_request', WORKSPACE_TEST_RESULT: 'skipped', MIGRATION_REHEARSAL_RESULT: 'skipped',
    SKIP_WORKSPACE_TEST: 'true', SKIP_MIGRATION_REHEARSAL: 'true' }
  assert.equal(passes(skippedPr), true)
  assert.equal(passes({ ...skippedPr, WORKSPACE_TEST_RESULT: 'success' }), true)
  // Fail closed: any failure, cancellation or unexplained skip fails the check.
  const failing = [
    ['workspace failed', { ...ok, WORKSPACE_RESULT: 'failure' }],
    ['workspace skipped', { ...skippedPr, WORKSPACE_RESULT: 'skipped' }],
    ['workspace cancelled', { ...ok, WORKSPACE_RESULT: 'cancelled' }],
    ['tests failed', { ...ok, WORKSPACE_TEST_RESULT: 'failure' }],
    ['rehearsal failed', { ...ok, MIGRATION_REHEARSAL_RESULT: 'failure' }],
    ['rehearsal failed on a pull request that selected it', { ...skippedPr, MIGRATION_REHEARSAL_RESULT: 'failure', SKIP_MIGRATION_REHEARSAL: 'false' }],
    ['tests skipped on a push', { ...skippedPr, EVENT_NAME: 'push' }],
    ['rehearsal skipped on a manual run', { ...skippedPr, EVENT_NAME: 'workflow_dispatch' }],
    ['rehearsal skipped on a scheduled run', { ...skippedPr, EVENT_NAME: 'schedule' }],
    ['rehearsal skipped without a selection (changes job failed)', { ...skippedPr, SKIP_WORKSPACE_TEST: '', SKIP_MIGRATION_REHEARSAL: '' }],
    ['tests skipped though the selection kept them', { ...skippedPr, SKIP_WORKSPACE_TEST: 'false' }],
    ['rehearsal skipped though the selection kept it', { ...skippedPr, SKIP_MIGRATION_REHEARSAL: 'false' }],
    ['missing results', { EVENT_NAME: 'pull_request' }],
    ['unexpected result', { ...ok, WORKSPACE_TEST_RESULT: 'neutral' }],
  ]
  for (const [label, env] of failing) assert.equal(passes(env), false, label)
})
