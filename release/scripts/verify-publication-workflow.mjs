#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

export function parseWorkflow(source) {
  assert.ok(source.length < 100000, 'workflow exceeds source bound')
  const doc = parseDocument(source, { uniqueKeys: true, strict: true, version: '1.2', stringKeys: true })
  assert.deepEqual(doc.errors, [], 'ambiguous or invalid workflow YAML')
  assert.deepEqual(doc.warnings, [], 'unsupported workflow YAML')
  return doc.toJS({ maxAliasCount: 0 })
}

// Only the infra/aws audit runs through the reviewed exception gate
// (release/scripts/npm-audit-with-exceptions.mjs reading
// security/npm-audit-exceptions.json); every other audit is plain npm audit.
export const AWS_AUDIT_GATE = 'node release/scripts/npm-audit-with-exceptions.mjs infra/aws'
// Every audit step starts by pinning PATH to the Node runtime the reviewed
// setup-node step installs (the runner's tool cache, which a workflow cannot
// redirect: RUNNER_* variables cannot be overwritten) and the system
// directories, and by checking that this is the reviewed Node. Whatever an
// earlier step added to PATH, through GITHUB_PATH or an action, then never
// reaches npm or the gate.
export const NODE_RUNTIME = '22.23.2'
// Every audit step runs in this shell: an absolute path, so no bash found on
// PATH runs it, and privileged mode (-p), so bash reads no BASH_ENV or ENV file
// and imports no shell function from the environment, even one written to
// GITHUB_ENV at run time. -e stops the step at the first failing command.
export const AUDIT_SHELL = '/usr/bin/bash -p -e {0}'
export const AUDIT_RUNNER = 'ubuntu-24.04'
export const AUDIT_PATH = [
  `export PATH="$RUNNER_TOOL_CACHE/node/${NODE_RUNTIME}/x64/bin:/usr/bin:/bin"`,
  `test "$(node --version)" = v${NODE_RUNTIME}`, ''].join('\n')
export const PUBLISHER_AUDITS = Object.freeze({
  tooling: AUDIT_PATH + ['npm --prefix release audit --audit-level=moderate', 'npm --prefix infra/cloudflare audit --audit-level=moderate', AWS_AUDIT_GATE, ''].join('\n'),
})
export const LOCAL_GATE_AUDITS = Object.freeze({
  'release-contracts': AUDIT_PATH + 'npm --prefix release audit --audit-level=moderate\n',
  'aws-release-trust': AUDIT_PATH + AWS_AUDIT_GATE + '\n',
  'cloudflare-tuf': AUDIT_PATH + 'npm --prefix infra/cloudflare audit --audit-level=moderate\n',
  'ehr-release-cache': AUDIT_PATH + 'for package in packages/offline packages/telemetry packages/ui apps/ehr; do\n  npm --prefix "${package}" audit --audit-level=moderate\ndone\n',
})
// The only environment variables the workflow, an audit job or one of its
// steps may set: the ones these workflows use today. Anything else is
// refused, so no BASH_ENV, ENV, NODE_OPTIONS, npm_config_*, PATH, proxy or
// extra CA can reach an audit through an env map. NODE_VERSION may be set
// only in the workflow env, where the setup-node check reads it.
export const AUDIT_ENV_ALLOWLIST = Object.freeze(new Set([
  'CI', 'NODE_VERSION', 'GO_VERSION', 'BROKER_GO_BUILD_IMAGE', 'BROKER_LAMBDA_RUNTIME_IMAGE', 'GOTOOLCHAIN',
  'TOOLING_SHA', 'PLAN_JSON', 'WRANGLER_SEND_METRICS', 'HID_REQUIRE_CLOUDFLARE_VALIDATOR', 'HID_PUBLIC_BASE', 'GATE_STEPS_JSON',
]))
// The only actions an audit job may use, each at its reviewed immutable
// commit and with only the inputs it takes today. No other action, local
// action or container action can run in an audit job, so none can change
// PATH, the environment or the tool cache before the audit.
export const AUDIT_JOB_ACTIONS = Object.freeze(new Map([
  ['actions/checkout', { pin: '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0', inputs: ['persist-credentials', 'ref'] }],
  ['actions/setup-node', { pin: '820762786026740c76f36085b0efc47a31fe5020', inputs: ['node-version', 'package-manager-cache'] }],
  ['actions/setup-go', { pin: 'b7ad1dad31e06c5925ef5d2fc7ad053ef454303e', inputs: ['go-version', 'check-latest', 'cache', 'cache-dependency-path'] }],
  ['actions/upload-artifact', { pin: 'ea165f8d65b6e75b540449e92b4886f43607fa02', inputs: ['name', 'path', 'if-no-files-found', 'retention-days', 'compression-level'] }],
]))
const WORKFLOW_ENV_ONLY = new Set(['NODE_VERSION'])
const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const jobEnvAllowed = key => AUDIT_ENV_ALLOWLIST.has(key) && !WORKFLOW_ENV_ONLY.has(key)
const AUDIT_COMMAND = /\bnpm\b[^\n]*\baudit\b|npm-audit-with-exceptions/

// Pins every npm audit in a workflow: one audit step in each reviewed job with
// exactly the reviewed commands, each starting with the pinned PATH and Node
// check above, run in AUDIT_SHELL, and placed before every run step of its job
// (only reviewed actions come first), so no dependency code, install script
// or test runs before the audit. It also rejects these ways to skip,
// reconfigure or redirect an audit: a workflow or job default shell; a
// condition, needs (a job waiting on a skipped job is skipped too),
// continue-on-error, container, service, matrix or another runner on an audit
// job; any key but id, name, run and shell on the audit step; an
// env that is not a plain map anywhere in the workflow; any variable outside
// AUDIT_ENV_ALLOWLIST in the workflow env or in an audit job's or its steps'
// env; any action in an audit job outside AUDIT_JOB_ACTIONS, at another
// commit or with other inputs; a setup-node of another Node; a step in an
// audit job that writes GITHUB_ENV or GITHUB_PATH; and any other step that
// names the gate or security/. These are static checks on the workflow text,
// not a sandbox and not a complete list: one of the reviewed actions itself
// turned hostile (it runs as the runner user and could replace files in the
// tool cache or write ~/.npmrc), or a self-hosted runner set up to answer
// ubuntu-24.04, can still get past them, so owner review of every workflow
// change remains the real control.
export function verifyAuditSteps(workflow, expected) {
  assert.equal(workflow.defaults, undefined, 'workflow cannot change the default shell or directory')
  // The workflow env reaches every job, the audit jobs included.
  assert.ok(workflow.env === undefined || isMap(workflow.env), 'every env must be a plain map, not an expression')
  for (const key of Object.keys(workflow.env ?? {})) assert.ok(AUDIT_ENV_ALLOWLIST.has(key), `workflow cannot set ${key}`)
  const found = new Map()
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const steps = (job.steps ?? []).filter(step => typeof step.run === 'string' && AUDIT_COMMAND.test(step.run))
    if (steps.length === 0) continue
    assert.equal(steps.length, 1, `job ${name} runs more than one audit step`)
    assert.equal(job.defaults, undefined, `job ${name} cannot change the default shell or directory`)
    for (const key of ['if', 'needs', 'continue-on-error', 'container', 'services', 'strategy']) assert.equal(job[key], undefined, `job ${name} cannot be skipped, allowed to fail or moved into another runtime`)
    assert.equal(job['runs-on'], AUDIT_RUNNER, `job ${name} cannot be skipped, allowed to fail or moved into another runtime`)
    for (const step of job.steps) assert.ok(!/GITHUB_(?:ENV|PATH)/.test(JSON.stringify(step)), `job ${name} cannot change the environment or PATH of later steps`)
    for (const step of job.steps) {
      if (step.uses?.startsWith('actions/setup-node@')) {
        assert.deepEqual(Object.keys(step.with ?? {}).sort(), ['node-version', 'package-manager-cache'], `job ${name} cannot configure an npm registry`)
        const version = step.with['node-version'] === '${{ env.NODE_VERSION }}' ? workflow.env?.NODE_VERSION : step.with['node-version']
        assert.equal(String(version), NODE_RUNTIME, `job ${name} must set up the reviewed Node ${NODE_RUNTIME}`)
      }
      if (step.uses !== undefined) {
        assert.equal(typeof step.uses, 'string', `job ${name} uses an unreviewed action`)
        const at = step.uses.lastIndexOf('@')
        const action = AUDIT_JOB_ACTIONS.get(at > 0 ? step.uses.slice(0, at) : step.uses)
        assert.ok(action && step.uses.slice(at + 1) === action.pin, `job ${name} cannot use ${step.uses}: only the reviewed actions at their reviewed commits`)
        assert.ok(step.with === undefined || isMap(step.with), `job ${name} gives ${step.uses} inputs that are not a plain map`)
        for (const input of Object.keys(step.with ?? {})) assert.ok(action.inputs.includes(input), `job ${name} cannot give ${step.uses} the input ${input}`)
      }
      assert.ok(step.env === undefined || isMap(step.env), `job ${name} has a step env that is not a plain map`)
      for (const key of Object.keys(step.env ?? {})) assert.ok(jobEnvAllowed(key), `workflow cannot set ${key}`)
    }
    assert.ok(job.env === undefined || isMap(job.env), `job ${name} has an env that is not a plain map`)
    for (const key of Object.keys(job.env ?? {})) assert.ok(jobEnvAllowed(key), `workflow cannot set ${key}`)
    // Only reviewed actions run before the audit: no install, script or test.
    const first = job.steps.indexOf(steps[0])
    for (const step of job.steps.slice(0, first)) assert.ok(step.run === undefined && step.uses !== undefined, `job ${name} runs code before its audit`)
    found.set(name, steps[0])
  }
  assert.deepEqual([...found.keys()].sort(), Object.keys(expected).sort(), 'npm audits run only in the reviewed jobs')
  for (const [name, step] of found) {
    assert.deepEqual(Object.keys(step).sort(), ['id', 'name', 'run', 'shell'], `audit step in ${name} cannot be conditional, configured or allowed to fail`)
    assert.equal(step.shell, AUDIT_SHELL, `audit step in ${name} must run in ${AUDIT_SHELL}`)
    assert.equal(step.run, expected[name], `audit commands in ${name} must be exactly the reviewed ones`)
  }
  const environments = [workflow.env, ...Object.values(workflow.jobs).flatMap(job => [job.env, ...(job.steps ?? []).map(step => step.env)])]
  for (const env of environments) {
    assert.ok(env === undefined || isMap(env), 'every env must be a plain map, not an expression')
    for (const key of Object.keys(env ?? {})) assert.ok(!/^(?:npm_config_|node_options$|path$|bash_env$|env$)/i.test(key), `workflow cannot set ${key}`)
  }

  const audits = new Set(found.values())
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (!audits.has(step)) assert.ok(!/npm-audit-|security\//.test(JSON.stringify(step)), 'only the reviewed audit step may use the audit gate or the exception file')
    }
  }
  return true
}

export function verifyLocalGateWorkflow(source) {
  return verifyAuditSteps(parseWorkflow(source), LOCAL_GATE_AUDITS)
}

export function verifyPublicationWorkflow(source) {
  const workflow = parseWorkflow(source)
  verifyAuditSteps(workflow, PUBLISHER_AUDITS)
  assert.deepEqual(Object.keys(workflow.on), ['workflow_call'], 'publisher must be reusable-only')
  assert.deepEqual(workflow.permissions, { contents: 'read' }, 'default permissions are read-only')
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['publish', 'tooling'], 'unexpected authority-bearing job')
  assert.equal(workflow.concurrency?.group, '${{ fromJSON(inputs.plan_json).environment }}'.replace(/^/, 'tuf-publication-'))
  assert.equal(workflow.concurrency?.['cancel-in-progress'], false, 'never cancel a live publication for a newer run')
  const { tooling, publish } = workflow.jobs
  assert.equal(tooling.steps.find(step => step.uses?.startsWith('actions/setup-go@'))?.with['go-version'], '1.26.10')
  assert.ok(tooling.steps.some(step => step.id === 'go_audit' && step.run.includes('verify-production-toolchain.mjs') && step.run.includes('go-vulnerability-gate.mjs')))
  assert.deepEqual(tooling.permissions, { contents: 'read' })
  assert.equal(tooling.environment, undefined)
  assert.equal(tooling['runs-on'], 'ubuntu-24.04')
  assert.equal(publish['runs-on'], 'ubuntu-24.04')
  assert.equal(publish.needs, 'tooling')
  assert.equal(publish.environment.name, '${{ fromJSON(inputs.plan_json).environment }}-publisher')
  assert.deepEqual(publish.permissions, { contents: 'read', actions: 'read', 'id-token': 'write' })
  assert.ok(!/secrets\.|secrets:|pull_request_target|repository_dispatch/.test(JSON.stringify(tooling)), 'tooling cannot use deployment secrets or privileged triggers')
  const actions = new Map([
    ['actions/checkout', '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0'],
    ['actions/setup-node', '820762786026740c76f36085b0efc47a31fe5020'],
    ['actions/setup-go', 'b7ad1dad31e06c5925ef5d2fc7ad053ef454303e'],
    ['actions/upload-artifact', 'ea165f8d65b6e75b540449e92b4886f43607fa02'],
    ['actions/download-artifact', 'd3f86a106a0bac45b974a628896c90dbdf5c8093'],
    ['aws-actions/configure-aws-credentials', '7474bc4690e29a8392af63c5b98e7449536d5c3a'],
  ])
  for (const job of [tooling, publish]) for (const step of job.steps) {
    if (step.uses) {
      const [name, pin] = step.uses.split('@')
      assert.equal(pin, actions.get(name), 'action must use the reviewed immutable commit')
      if (name === 'actions/checkout') {
        assert.equal(step.with.ref, '${{ inputs.tooling_sha }}', 'never checkout candidate source in publisher')
        assert.equal(step.with['persist-credentials'], false)
      }
    }
    if (step.run) assert.ok(!/\$\{\{\s*(inputs\.|github\.event)/.test(step.run), 'untrusted input cannot be interpolated into shell code')
    assert.ok(!step['continue-on-error'], 'publication gates cannot continue on error')
  }
  const steps = publish.steps
  assert.match(steps[0].run, /e\.TOOLING_SHA !== e\.APPROVED_WORKFLOW_SHA/)
  for (const required of ['job_workflow_sha', 'job_workflow_ref', 'repository_id', 'repository_owner_id', 'actor_id', 'run_attempt',
    'plan.git_sha !== e.GITHUB_SHA', 'expected.sha = e.GITHUB_SHA',
    "e.GITHUB_REPOSITORY !== 'D-Eminence/hid-system'", "e.APPROVED_REPOSITORY_ID !== '1317340803'", "e.APPROVED_OWNER_ID !== '182018869'",
    "e.GITHUB_REF_PROTECTED !== 'true'", 'approvalRules?.length !== 1', 'approval?.prevent_self_review !== false', 'approval.reviewers.length !== 1',
    "ownerReviewer?.type !== 'User'", 'ownerReviewer?.reviewer?.id !== Number(e.APPROVED_OWNER_ID)', "ownerReviewer?.reviewer?.login !== 'D-Eminence'",
    'environment.can_admins_bypass !== false', 'environment.deployment_branch_policy?.protected_branches !== true']) {
    assert.ok(steps[0].run.includes(required), `missing protected identity/approval check ${required}`)
  }
  const identity = 0
  const archiveCheck = steps.findIndex((step) => step.name === 'Verify independently approved tooling and configuration before loading code')
  const credentials = steps.findIndex((step) => step.uses?.startsWith('aws-actions/configure-aws-credentials@'))
  const provenance = steps.findIndex((step) => step.name === 'Verify candidate source provenance and repository digest before cloud authority')
  const driver = steps.findIndex((step) => step.name === 'Execute the journal-owned publication pipeline')
  assert.ok(identity < archiveCheck && archiveCheck < provenance && provenance < credentials && credentials < driver)
  assert.equal(steps[provenance].run, 'node release/scripts/verify-ci-candidate.mjs')
  assert.equal(publish.env.APPROVED_CANDIDATE_WORKFLOW_PATH, '${{ vars.TUF_CANDIDATE_WORKFLOW_PATH }}')
  assert.match(steps[archiveCheck].run, /APPROVED_TOOLING_SHA256/)
  assert.match(steps[archiveCheck].run, /PUBLISHER_CONFIG_SHA256/)
  assert.equal(steps[credentials].with['role-to-assume'], '${{ vars.TUF_PUBLISHER_ROLE_ARN }}')
  assert.equal(steps[credentials].with['retry-max-attempts'], 1)
  assert.match(steps[driver].run, /^node release\/scripts\/run-protected-publication\.mjs /)
  for (const step of steps) if (step.run) assert.ok(!/npm |go build|wrangler |aws secretsmanager|secrets\./.test(step.run), 'publisher runs only the verified driver, never builds or direct publication')
  assert.equal(steps.at(-1).if, '${{ always() }}')
  assert.ok(steps.at(-1).with.path.includes('result-*.json'))
  assert.ok(!/CLOUDFLARE_API_TOKEN|secrets\./.test(source), 'Cloudflare authority is not a GitHub secret')
  const build = tooling.steps.map((step) => step.run ?? '').join('\n')
  for (const gate of ['go test -race -count=1 ./...', 'go vet ./...', 'go mod verify', 'cmp ', 'hid-tuf-journal', '--ignore-scripts', 'gzip -n']) assert.ok(build.includes(gate), `missing reproducible tooling gate ${gate}`)
  return true
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyPublicationWorkflow(await readFile(new URL('../../.github/workflows/tuf-publish.yml', import.meta.url), 'utf8'))
  process.stdout.write('Protected TUF workflow static gates passed. Live trust/approval acceptance remains required.\n')
}
