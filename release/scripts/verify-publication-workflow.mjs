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
export const PUBLISHER_AUDITS = Object.freeze({
  tooling: ['npm --prefix release audit --audit-level=moderate', 'npm --prefix infra/cloudflare audit --audit-level=moderate', AWS_AUDIT_GATE, ''].join('\n'),
})
export const LOCAL_GATE_AUDITS = Object.freeze({
  'release-contracts': 'npm --prefix release audit --audit-level=moderate',
  'aws-release-trust': AWS_AUDIT_GATE,
  'cloudflare-tuf': 'npm --prefix infra/cloudflare audit --audit-level=moderate',
  'ehr-release-cache': 'for package in packages/offline packages/telemetry packages/ui apps/ehr; do\n  npm --prefix "${package}" audit --audit-level=moderate\ndone\n',
})
const AUDIT_COMMAND = /\bnpm\b[^\n]*\baudit\b|npm-audit-with-exceptions/

// Pins every npm audit in a workflow: one audit step in each reviewed job with
// exactly the reviewed commands. It also rejects these ways to skip,
// reconfigure or redirect an audit: a workflow or job default shell; a
// condition, needs (a job waiting on a skipped job is skipped too),
// continue-on-error, container, service or matrix on an audit job;
// any key but id, name and run on the audit step; npm_config_*,
// NODE_OPTIONS or PATH set in a workflow, job or step env map; a step in an
// audit job that writes GITHUB_ENV or GITHUB_PATH; a setup-node registry; and
// any other step that names the gate or security/. These are static text
// checks, not a sandbox and not a complete list: obfuscated shell (for
// example a path built from pieces, or an .npmrc written by a script), or an
// HTTPS proxy plus an extra CA set in the environment, can still get past
// them, so owner review of every workflow change remains the real control.
export function verifyAuditSteps(workflow, expected) {
  assert.equal(workflow.defaults, undefined, 'workflow cannot change the default shell or directory')
  const found = new Map()
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const steps = (job.steps ?? []).filter(step => typeof step.run === 'string' && AUDIT_COMMAND.test(step.run))
    if (steps.length === 0) continue
    assert.equal(steps.length, 1, `job ${name} runs more than one audit step`)
    assert.equal(job.defaults, undefined, `job ${name} cannot change the default shell or directory`)
    for (const key of ['if', 'needs', 'continue-on-error', 'container', 'services', 'strategy']) assert.equal(job[key], undefined, `job ${name} cannot be skipped, allowed to fail or moved into another runtime`)
    for (const step of job.steps) assert.ok(!/GITHUB_(?:ENV|PATH)/.test(JSON.stringify(step)), `job ${name} cannot change the environment or PATH of later steps`)
    for (const step of job.steps) {
      if (step.uses?.startsWith('actions/setup-node@')) {
        assert.deepEqual(Object.keys(step.with ?? {}).sort(), ['node-version', 'package-manager-cache'], `job ${name} cannot configure an npm registry`)
      }
    }
    found.set(name, steps[0])
  }
  assert.deepEqual([...found.keys()].sort(), Object.keys(expected).sort(), 'npm audits run only in the reviewed jobs')
  for (const [name, step] of found) {
    assert.deepEqual(Object.keys(step).sort(), ['id', 'name', 'run'], `audit step in ${name} cannot be conditional, configured or allowed to fail`)
    assert.equal(step.run, expected[name], `audit commands in ${name} must be exactly the reviewed ones`)
  }
  const environments = [workflow.env, ...Object.values(workflow.jobs).flatMap(job => [job.env, ...(job.steps ?? []).map(step => step.env)])]
  for (const env of environments) {
    for (const key of Object.keys(env ?? {})) assert.ok(!/^(?:npm_config_|node_options$|path$)/i.test(key), `workflow cannot set ${key}`)
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
