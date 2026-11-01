import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { AWS_AUDIT_GATE, LOCAL_GATE_AUDITS, parseWorkflow, verifyLocalGateWorkflow, verifyPublicationWorkflow } from '../scripts/verify-publication-workflow.mjs'

const source = await readFile(new URL('../../.github/workflows/tuf-publish.yml', import.meta.url), 'utf8')
const localGates = await readFile(new URL('../../.github/workflows/tuf-local-gates.yml', import.meta.url), 'utf8')
const auditStep = (w) => w.jobs.tooling.steps.find(s => s.id === 'audit')
test('protected publisher workflow pins code, permissions, ordering and retained evidence', () => assert.equal(verifyPublicationWorkflow(source), true))
test('publisher audits release and Cloudflare as before and only infra/aws through the exception gate', () => {
  assert.equal(auditStep(parseWorkflow(source)).run, [
    'npm --prefix release audit --audit-level=moderate',
    'npm --prefix infra/cloudflare audit --audit-level=moderate',
    'node release/scripts/npm-audit-with-exceptions.mjs infra/aws', ''].join('\n'))
})
test('local gates keep every npm audit and run only infra/aws through the exception gate', () => {
  assert.equal(verifyLocalGateWorkflow(localGates), true)
  const step = (w, job) => w.jobs[job].steps.find(s => s.run === LOCAL_GATE_AUDITS[job])
  assert.equal(step(parseWorkflow(localGates), 'aws-release-trust').id, 'gate_2')
  const attacks = {
    'plain infra/aws audit kept beside the gate': (w) => { step(w, 'aws-release-trust').run += '\nnpm --prefix infra/aws audit --audit-level=moderate' },
    'infra/aws audit failure ignored': (w) => { step(w, 'aws-release-trust').run += ' || true' },
    'substitute exception file': (w) => { step(w, 'aws-release-trust').run += ' --exceptions /tmp/empty.json' },
    'unreviewed infra/aws audit command': (w) => { step(w, 'aws-release-trust').run = 'npm --prefix infra/aws audit --audit-level=critical' },
    'infra/aws audit removed': (w) => { w.jobs['aws-release-trust'].steps = w.jobs['aws-release-trust'].steps.filter(s => s.run !== AWS_AUDIT_GATE) },
    'conditional infra/aws audit': (w) => { step(w, 'aws-release-trust').if = '${{ false }}' },
    'infra/aws audit may fail': (w) => { step(w, 'aws-release-trust')['continue-on-error'] = true },
    'exception gate for release audit': (w) => { step(w, 'release-contracts').run = 'node release/scripts/npm-audit-with-exceptions.mjs release' },
    'Cloudflare audit removed': (w) => { w.jobs['cloudflare-tuf'].steps = w.jobs['cloudflare-tuf'].steps.filter(s => s.run !== LOCAL_GATE_AUDITS['cloudflare-tuf']) },
    'EHR audit narrowed': (w) => { step(w, 'ehr-release-cache').run = step(w, 'ehr-release-cache').run.replace(' apps/ehr;', ';') },
    'audit added to another job': (w) => { w.jobs['tuf-client'].steps.push({ name: 'Audit', run: AWS_AUDIT_GATE, id: 'gate_99' }) },
    'workflow npm configuration': (w) => { w.env.npm_config_audit_level = 'none' },
    'exception file rewritten before audit': (w) => { w.jobs['aws-release-trust'].steps.splice(2, 0, { run: 'cp /tmp/empty.json security/npm-audit-exceptions.json' }) },
    'security file replaced by glob': (w) => { w.jobs['aws-release-trust'].steps.splice(2, 0, { run: 'cp /tmp/empty.json security/*.json' }) },
    'npm registry redirected': (w) => { w.jobs['aws-release-trust'].steps.find(s => s.uses?.startsWith('actions/setup-node@')).with['registry-url'] = 'https://registry.invalid/' },
    'default shell replaced': (w) => { w.jobs['aws-release-trust'].defaults = { run: { shell: 'true {0}' } } },
  }
  for (const [name, attack] of Object.entries(attacks)) {
    const workflow = parseWorkflow(localGates)
    attack(workflow)
    assert.throws(() => verifyLocalGateWorkflow(stringify(workflow)), undefined, name)
  }
})
test('forbidden workflow paths are rejected statically', () => {
  const attacks = {
    'direct trigger': (w) => { w.on.workflow_dispatch = {} },
    'ordinary build credentials': (w) => { w.jobs.tooling.permissions['id-token'] = 'write' },
    'build environment': (w) => { w.jobs.tooling.environment = 'production-publisher' },
    'weak environment': (w) => { w.jobs.publish.environment.name = 'staging' },
    'cancel publication': (w) => { w.concurrency['cancel-in-progress'] = true },
    'per-run concurrency': (w) => { w.concurrency.group = '${{ github.run_id }}' },
    'privileged job without validation': (w) => { delete w.jobs.publish.needs },
    'unprotected branch': (w) => { w.jobs.publish.steps[0].run = w.jobs.publish.steps[0].run.replace("e.GITHUB_REF_PROTECTED !== 'true'", 'false') },
    'missing explicit self-review policy': (w) => { w.jobs.publish.steps[0].run = w.jobs.publish.steps[0].run.replace('approval?.prevent_self_review', 'true') },
    'substitute owner': (w) => { w.jobs.publish.steps[0].run = w.jobs.publish.steps[0].run.replace('ownerReviewer?.reviewer?.id !== Number(e.APPROVED_OWNER_ID)', 'false') },
    'extra reviewers allowed': (w) => { w.jobs.publish.steps[0].run = w.jobs.publish.steps[0].run.replace('approval.reviewers.length !== 1', 'false') },
    'admin bypass': (w) => { w.jobs.publish.steps[0].run = w.jobs.publish.steps[0].run.replace('environment.can_admins_bypass !== false', 'false') },
    'different workflow': (w) => { w.jobs.publish.steps[0].run = w.jobs.publish.steps[0].run.replace('job_workflow_ref', 'workflow_ref') },
    'unbound release SHA': (w) => { w.jobs.publish.steps[0].run = w.jobs.publish.steps[0].run.replace('plan.git_sha !== e.GITHUB_SHA', 'false') },
    'unbound OIDC SHA': (w) => { w.jobs.publish.steps[0].run = w.jobs.publish.steps[0].run.replace('expected.sha = e.GITHUB_SHA', 'expected.sha = undefined') },
    'missing candidate provenance': (w) => { w.jobs.publish.steps = w.jobs.publish.steps.filter(s => s.run !== 'node release/scripts/verify-ci-candidate.mjs') },
    'caller chooses candidate workflow': (w) => { w.jobs.publish.env.APPROVED_CANDIDATE_WORKFLOW_PATH = '${{ inputs.workflow }}' },
    'mutable action': (w) => { w.jobs.publish.steps[1].uses = 'actions/checkout@main' },
    'candidate code checkout': (w) => { w.jobs.publish.steps[1].with.ref = '${{ fromJSON(inputs.plan_json).git_sha }}' },
    'persistent checkout credentials': (w) => { w.jobs.publish.steps[1].with['persist-credentials'] = true },
    'unreviewed tooling': (w) => { w.jobs.publish.steps.splice(4, 1) },
    'direct command': (w) => { w.jobs.publish.steps.push({ run: 'wrangler deploy' }) },
    'shell injection': (w) => { w.jobs.tooling.steps.push({ run: 'echo ${{ inputs.plan_json }}' }) },
    'ignore failure': (w) => { w.jobs.publish.steps[0]['continue-on-error'] = true },
    'GitHub Cloudflare secret': (w) => { w.jobs.publish.env.CLOUDFLARE_API_TOKEN = '${{ secrets.CLOUDFLARE_API_TOKEN }}' },
    'audit step removed': (w) => { w.jobs.tooling.steps = w.jobs.tooling.steps.filter(s => s.id !== 'audit') },
    'infra/aws audit dropped': (w) => { auditStep(w).run = auditStep(w).run.replace(`${AWS_AUDIT_GATE}\n`, '') },
    'infra/aws audit failure ignored': (w) => { auditStep(w).run = auditStep(w).run.replace(AWS_AUDIT_GATE, `${AWS_AUDIT_GATE} || true`) },
    'substitute exception file': (w) => { auditStep(w).run = auditStep(w).run.replace(AWS_AUDIT_GATE, `${AWS_AUDIT_GATE} --exceptions /tmp/empty.json`) },
    'exception gate for release audit': (w) => { auditStep(w).run = auditStep(w).run.replace('npm --prefix release audit --audit-level=moderate', 'node release/scripts/npm-audit-with-exceptions.mjs release') },
    'exception gate for Cloudflare audit': (w) => { auditStep(w).run = auditStep(w).run.replace('npm --prefix infra/cloudflare audit --audit-level=moderate', 'node release/scripts/npm-audit-with-exceptions.mjs infra/cloudflare') },
    'weaker release audit level': (w) => { auditStep(w).run = auditStep(w).run.replace('release audit --audit-level=moderate', 'release audit --audit-level=critical') },
    'unreviewed infra/aws audit command': (w) => { auditStep(w).run = auditStep(w).run.replace(AWS_AUDIT_GATE, 'npm --prefix infra/aws audit --audit-level=high') },
    'conditional audit': (w) => { auditStep(w).if = '${{ false }}' },
    'audit step environment': (w) => { auditStep(w).env = { npm_config_registry: 'https://registry.invalid/' } },
    'tooling npm configuration': (w) => { w.jobs.tooling.env.NPM_CONFIG_OMIT = 'dev' },
    'tooling node preload': (w) => { w.jobs.tooling.env.NODE_OPTIONS = '--import ./preload.mjs' },
    'second audit step': (w) => { w.jobs.tooling.steps.push({ name: 'Audit again', run: 'npm --prefix infra/aws audit || true', id: 'audit_2' }) },
    'exception file rewritten before audit': (w) => { w.jobs.tooling.steps.splice(3, 0, { run: "echo '{}' > security/npm-audit-exceptions.json" }) },
    'security file replaced by glob': (w) => { w.jobs.tooling.steps.splice(3, 0, { run: 'cp /tmp/empty.json security/*.json' }) },
    'npm registry redirected': (w) => { w.jobs.tooling.steps.find(s => s.uses?.startsWith('actions/setup-node@')).with['registry-url'] = 'https://registry.invalid/' },
    'default shell replaced': (w) => { w.jobs.tooling.defaults = { run: { shell: 'true {0}' } } },
  }
  for (const [name, attack] of Object.entries(attacks)) {
    const workflow = parseWorkflow(source)
    attack(workflow)
    assert.throws(() => verifyPublicationWorkflow(stringify(workflow)), undefined, name)
  }
})
test('duplicate YAML fields and aliases cannot hide workflow permissions', () => {
  assert.throws(() => parseWorkflow('permissions: read-all\npermissions: write-all\n'))
  assert.throws(() => parseWorkflow('a: &unsafe {permissions: write-all}\nb: *unsafe\n'))
})

test('the real inline identity gate rejects forged claims and weakened environment rules', async () => {
  const script = parseWorkflow(source).jobs.publish.steps[0].run.split("node --input-type=module <<'NODE'\n")[1].replace(/\nNODE\n?$/, '')
  const temporary = await mkdtemp(join(tmpdir(), 'hid-workflow-gate-'))
  try {
    const baseEnv = { GITHUB_REPOSITORY: 'D-Eminence/hid-system', GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true',
      APPROVED_REF: 'refs/heads/main', TOOLING_SHA: 'a'.repeat(40), APPROVED_WORKFLOW_SHA: 'a'.repeat(40),
      PLAN_JSON: JSON.stringify({ environment: 'staging', git_sha: 'b'.repeat(40) }), GITHUB_SHA: 'b'.repeat(40), APPROVED_REPOSITORY_ID: '1317340803', APPROVED_OWNER_ID: '182018869',
      GITHUB_ACTOR_ID: '182018869', GITHUB_RUN_ID: '1000', GITHUB_RUN_ATTEMPT: '1',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://test.actions.githubusercontent.com/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-token', GH_ENVIRONMENT_READ_TOKEN: 'fake-read-token' }
    const baseClaims = { iss: 'https://token.actions.githubusercontent.com', aud: 'sts.amazonaws.com', repository: baseEnv.GITHUB_REPOSITORY,
      repository_id: '1317340803', repository_owner_id: '182018869', ref: baseEnv.GITHUB_REF, environment: 'staging-publisher', job_workflow_sha: 'a'.repeat(40),
      job_workflow_ref: `${baseEnv.GITHUB_REPOSITORY}/.github/workflows/tuf-publish.yml@${'a'.repeat(40)}`, actor_id: '182018869', run_id: '1000', run_attempt: '1',
      runner_environment: 'github-hosted', ref_type: 'branch', event_name: 'workflow_dispatch', sha: 'b'.repeat(40) }
    const baseProtection = { id: 21412881394, name: 'staging-publisher', protection_rules: [{ type: 'required_reviewers', prevent_self_review: false, reviewers: [{ type: 'User', reviewer: { id: 182018869, login: 'D-Eminence' } }] }],
      can_admins_bypass: false, deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }
    const cases = { valid: () => {}, 'unprotected branch': (e) => { e.GITHUB_REF_PROTECTED = 'false' },
      'cross SHA plan': (e) => { e.PLAN_JSON = JSON.stringify({ environment: 'staging', git_sha: 'c'.repeat(40) }) },
      'cross SHA OIDC': (_e, c) => { c.sha = 'c'.repeat(40) },
      'tag caller': (_e, c) => { c.ref_type = 'tag' }, 'PR caller': (_e, c) => { c.event_name = 'pull_request' },
      'self-hosted runner': (_e, c) => { c.runner_environment = 'self-hosted' },
      'different workflow commit': (_e, c) => { c.job_workflow_sha = 'b'.repeat(40) },
      'developer workflow': (_e, c) => { c.job_workflow_ref = c.job_workflow_ref.replace('tuf-publish.yml', 'developer.yml') },
      'recreated repository': (_e, c) => { c.repository_id = '999' }, 'transferred repository': (_e, c) => { c.repository_owner_id = '999' },
      'cross environment': (_e, c) => { c.environment = 'production-publisher' }, 'cross actor': (_e, c) => { c.actor_id = '999' },
      'cross run': (_e, c) => { c.run_id = '999' }, 'no reviewers': (_e, _c, p) => { p.protection_rules = [] },
      'owner self-review blocked': (_e, _c, p) => { p.protection_rules[0].prevent_self_review = true },
      'unknown self-review policy': (_e, _c, p) => { delete p.protection_rules[0].prevent_self_review },
      'substitute reviewer': (_e, _c, p) => { p.protection_rules[0].reviewers[0].reviewer.id = 999 },
      'substitute login': (_e, _c, p) => { p.protection_rules[0].reviewers[0].reviewer.login = 'attacker' },
      'team reviewer': (_e, _c, p) => { p.protection_rules[0].reviewers[0].type = 'Team' },
      'empty reviewers': (_e, _c, p) => { p.protection_rules[0].reviewers = [] },
      'extra reviewer': (_e, _c, p) => { p.protection_rules[0].reviewers.push({ type: 'User', reviewer: { id: 999 } }) },
      'duplicate review rules': (_e, _c, p) => { p.protection_rules.push(structuredClone(p.protection_rules[0])) },
      'unapproved owner pin': e => { e.APPROVED_OWNER_ID = '999' },
      'unapproved repository pin': e => { e.APPROVED_REPOSITORY_ID = '999' },
      'custom branches': (_e, _c, p) => { p.deployment_branch_policy.custom_branch_policies = true },
      'admin bypass': (_e, _c, p) => { p.can_admins_bypass = true }, 'unknown admin bypass': (_e, _c, p) => { delete p.can_admins_bypass },
      'weak branch policy': (_e, _c, p) => { p.deployment_branch_policy.protected_branches = false },
      'unapproved checkout': (e) => { e.TOOLING_SHA = 'b'.repeat(40) } }
    let number = 0
    for (const [name, mutate] of Object.entries(cases)) {
      const runDirectory = await mkdtemp(join(temporary, 'run-'))
      const env = { ...baseEnv, RUNNER_TEMP: runDirectory, GITHUB_ENV: join(temporary, `env-${number++}`) }
      const claims = structuredClone(baseClaims)
      const protection = structuredClone(baseProtection)
      mutate(env, claims, protection)
      const prelude = `globalThis.fetch = async (url) => ({ok:true,json:async()=>String(url).startsWith('https://api.github.com/') ? ${JSON.stringify(protection)} : {value:'header.'+Buffer.from(JSON.stringify(${JSON.stringify(claims)})).toString('base64url')+'.signature'}});\n`
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', prelude + script], { env, encoding: 'utf8', timeout: 10000 })
      assert.equal(result.status === 0, name === 'valid', name)
      assert.equal(result.stdout, '', 'identity gate must not log tokens or claims')
      if (name === 'valid') {
        assert.match(await readFile(env.GITHUB_ENV, 'utf8'), /HID_TUF_IDENTITY_VERIFIED=true/)
        const evidence = JSON.parse(await readFile(join(runDirectory, 'hid-publication-identity.json'), 'utf8'))
        assert.equal(evidence.prevent_self_review, false)
        assert.equal(evidence.governance_model, 'sole-owner-approval')
        assert.equal(evidence.approval_evidence_source, 'github-environment-runtime-gate')
        assert.equal(evidence.reviewer_ids[0].id, Number(env.GITHUB_ACTOR_ID))
      }
      else await assert.rejects(readFile(env.GITHUB_ENV))
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
