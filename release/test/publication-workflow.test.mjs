import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { AUDIT_PATH, AUDIT_SHELL, AWS_AUDIT_GATE, LOCAL_GATE_AUDITS, NODE_RUNTIME, parseWorkflow, verifyLocalGateWorkflow, verifyPublicationWorkflow } from '../scripts/verify-publication-workflow.mjs'

const source = await readFile(new URL('../../.github/workflows/tuf-publish.yml', import.meta.url), 'utf8')
const localGates = await readFile(new URL('../../.github/workflows/tuf-local-gates.yml', import.meta.url), 'utf8')
const auditStep = (w) => w.jobs.tooling.steps.find(s => s.id === 'audit')
// Reasons pinned for attacks whose only defence is one specific check.
const JOB_RUNTIME = /cannot be skipped, allowed to fail or moved into another runtime/
const LATER_STEPS = /cannot change the environment or PATH of later steps/
const DEFAULT_SHELL = /workflow cannot change the default shell or directory/
const preload = { name: 'Preload code into later node processes', run: 'echo "NODE_OPTIONS=--import=/tmp/p.mjs" >> "$GITHUB_ENV"' }
const fakeNpm = { name: 'Put a fake npm first on PATH', run: 'echo "$RUNNER_TEMP/bin" >> "$GITHUB_PATH"' }
// Reasons for the environment and action allowlists and the pinned PATH.
const UNLISTED = (key) => new RegExp(`workflow cannot set ${key}: not in AUDIT_ENV_ALLOWLIST$`)
const DENIED = (key) => new RegExp(`: workflow cannot set ${key}$`)
const ANY_ENV_MAP = /: every env must be a plain map, not an expression$/
const NOT_A_MAP = /plain map/
const ACTION = /only the reviewed actions at their reviewed commits/
const ACTION_INPUT = /cannot give actions\/[a-z-]+@[0-9a-f]+ the input/
const NODE = /must set up the reviewed Node/
const proxyAction = { name: 'Prepare', uses: 'example/prepare@0123456789abcdef0123456789abcdef01234567' }
const localAction = { name: 'Prepare', uses: './.github/actions/prepare' }
const dockerAction = { name: 'Prepare', uses: 'docker://alpine:3' }
const SHELL = /must run in \/usr\/bin\/bash -p -e/
const STEP_KEYS = /cannot be conditional, configured or allowed to fail/
const CODE_FIRST = /runs code before its audit/
const GATE_ONLY = /only the reviewed audit step may use the audit gate or the exception file/
const BEFORE_AUDIT = /before its audit: only checkout and setup-node come first/
const NPM_CACHE = /cannot restore a package-manager cache/
const ONE_CHECKOUT = /must check out its source exactly once/
const OTHER_TREE = /cannot check out another tree for its audit/
const setupGo = (steps) => steps.find(s => s.uses?.startsWith('actions/setup-go@'))
const setupNode = (steps) => steps.find(s => s.uses?.startsWith('actions/setup-node@'))
const checkout = (steps) => steps.find(s => s.uses?.startsWith('actions/checkout@'))
const move = (steps, step, id, after = false) => { steps.splice(steps.indexOf(step), 1); steps.splice(steps.findIndex(s => s.id === id) + (after ? 1 : 0), 0, step) }
const runFirst = (steps, id) => { const i = steps.findIndex(s => s.id === id); const [step] = steps.splice(i, 1); steps.splice(steps.findIndex(s => s.run !== undefined), 0, step) }
const before = (steps, id, step) => steps.splice(steps.findIndex(s => s.id === id), 0, step)
test('protected publisher workflow pins code, permissions, ordering and retained evidence', () => assert.equal(verifyPublicationWorkflow(source), true))
test('publisher audits release and Cloudflare as before and only infra/aws through the exception gate', () => {
  assert.equal(auditStep(parseWorkflow(source)).run, [
    `export PATH="$RUNNER_TOOL_CACHE/node/${NODE_RUNTIME}/x64/bin:/usr/bin:/bin"`,
    `test "$(node --version)" = v${NODE_RUNTIME}`,
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
    'infra/aws audit removed': (w) => { w.jobs['aws-release-trust'].steps = w.jobs['aws-release-trust'].steps.filter(s => s.run !== LOCAL_GATE_AUDITS['aws-release-trust']) },
    'conditional infra/aws audit': (w) => { step(w, 'aws-release-trust').if = '${{ false }}' },
    'infra/aws audit may fail': (w) => { step(w, 'aws-release-trust')['continue-on-error'] = true },
    'exception gate for release audit': (w) => { step(w, 'release-contracts').run = 'node release/scripts/npm-audit-with-exceptions.mjs release' },
    'Cloudflare audit removed': (w) => { w.jobs['cloudflare-tuf'].steps = w.jobs['cloudflare-tuf'].steps.filter(s => s.run !== LOCAL_GATE_AUDITS['cloudflare-tuf']) },
    'EHR audit narrowed': (w) => { step(w, 'ehr-release-cache').run = step(w, 'ehr-release-cache').run.replace(' apps/ehr;', ';') },
    'audit added to another job': (w) => { w.jobs['tuf-client'].steps.push({ name: 'Audit', run: AWS_AUDIT_GATE, id: 'gate_99' }) },
    'workflow npm configuration': (w) => { w.env.npm_config_audit_level = 'none' },
    'exception file rewritten before audit': (w) => { w.jobs['aws-release-trust'].steps.splice(2, 0, { run: 'cp /tmp/empty.json security/npm-audit-exceptions.json' }) },
    'security file replaced by glob': (w) => { w.jobs['aws-release-trust'].steps.splice(2, 0, { run: 'cp /tmp/empty.json security/*.json' }) },
    'security file replaced after the infra/aws audit': [(w) => { const steps = w.jobs['aws-release-trust'].steps; steps.splice(steps.findIndex(s => s.id === 'gate_2') + 1, 0, { run: 'cp /tmp/empty.json security/*.json' }) }, GATE_ONLY],
    'npm registry redirected': (w) => { w.jobs['aws-release-trust'].steps.find(s => s.uses?.startsWith('actions/setup-node@')).with['registry-url'] = 'https://registry.invalid/' },
    'default shell replaced': (w) => { w.jobs['aws-release-trust'].defaults = { run: { shell: 'true {0}' } } },
    'workflow default shell replaced': [(w) => { w.defaults = { run: { shell: 'true {0}' } } }, DEFAULT_SHELL],
    'install step npm configuration': [(w) => { w.jobs['aws-release-trust'].steps.find(s => s.id === 'gate_1').env = { npm_config_registry: 'https://registry.invalid/' } }, UNLISTED('npm_config_registry')],
    'infra/aws audit job skipped': [(w) => { w.jobs['aws-release-trust'].if = '${{ false }}' }, JOB_RUNTIME],
    'release audit job skipped': [(w) => { w.jobs['release-contracts'].if = '${{ false }}' }, JOB_RUNTIME],
    'infra/aws audit job may fail': [(w) => { w.jobs['aws-release-trust']['continue-on-error'] = true }, JOB_RUNTIME],
    'infra/aws audit job moved into a container': [(w) => { w.jobs['aws-release-trust'].container = 'node:22' }, JOB_RUNTIME],
    'Cloudflare audit job given a service container': [(w) => { w.jobs['cloudflare-tuf'].services = { registry: { image: 'verdaccio/verdaccio' } } }, JOB_RUNTIME],
    'EHR audit job given a matrix': [(w) => { w.jobs['ehr-release-cache'].strategy = { matrix: { node: ['18'] } } }, JOB_RUNTIME],
    'infra/aws audit job waits on a skipped job': [(w) => { w.jobs['tuf-client'].if = '${{ false }}'; w.jobs['aws-release-trust'].needs = 'tuf-client' }, JOB_RUNTIME],
    'node preload written to GITHUB_ENV': [(w) => { before(w.jobs['aws-release-trust'].steps, 'gate_2', preload) }, LATER_STEPS],
    'fake npm added through GITHUB_PATH': [(w) => { before(w.jobs['aws-release-trust'].steps, 'gate_2', fakeNpm) }, LATER_STEPS],
    'fake npm added through job PATH': [(w) => { w.jobs['aws-release-trust'].env = { PATH: '/tmp/bin:/usr/bin:/bin' } }, UNLISTED('PATH')],
    'BASH_ENV in the workflow env': [(w) => { w.env.BASH_ENV = '/tmp/skip.sh' }, UNLISTED('BASH_ENV')],
    'BASH_ENV in an audit job env': [(w) => { w.jobs['aws-release-trust'].env = { BASH_ENV: '/tmp/skip.sh' } }, UNLISTED('BASH_ENV')],
    'BASH_ENV in an audit job step env': [(w) => { w.jobs['release-contracts'].steps.find(s => s.id === 'gate_1').env = { BASH_ENV: '/tmp/skip.sh' } }, UNLISTED('BASH_ENV')],
    'proxy and extra CA in an audit job env': [(w) => { w.jobs['cloudflare-tuf'].env.HTTPS_PROXY = 'http://127.0.0.1:8080'; w.jobs['cloudflare-tuf'].env.NODE_EXTRA_CA_CERTS = '/tmp/ca.pem' }, UNLISTED('HTTPS_PROXY')],
    'proxy in an audit job step env': [(w) => { w.jobs['ehr-release-cache'].steps.find(s => s.id === 'gate_1').env = { HTTPS_PROXY: 'http://127.0.0.1:8080' } }, UNLISTED('HTTPS_PROXY')],
    'audit job step env given as an expression': [(w) => { w.jobs['aws-release-trust'].steps.find(s => s.id === 'gate_1').env = '${{ fromJSON(vars.AUDIT_ENV) }}' }, NOT_A_MAP],
    'unlisted variable in the workflow env': [(w) => { w.env.NPM_TOKEN = 'x' }, UNLISTED('NPM_TOKEN')],
    'audit job env given as an expression': [(w) => { w.jobs['aws-release-trust'].env = "${{ fromJSON('{\"BASH_ENV\":\"/tmp/skip.sh\"}') }}" }, NOT_A_MAP],
    'workflow env given as an expression': [(w) => { w.env = "${{ fromJSON('{\"BASH_ENV\":\"/tmp/skip.sh\"}') }}" }, NOT_A_MAP],
    'unreviewed action before the infra/aws audit': [(w) => { before(w.jobs['aws-release-trust'].steps, 'gate_2', proxyAction) }, ACTION],
    'local action before the release audit': [(w) => { before(w.jobs['release-contracts'].steps, 'gate_2', localAction) }, ACTION],
    'container action before the EHR audit': [(w) => { before(w.jobs['ehr-release-cache'].steps, 'gate_2', dockerAction) }, ACTION],
    'reviewed action at another commit': [(w) => { w.jobs['cloudflare-tuf'].steps.find(s => s.uses?.startsWith('actions/setup-go@')).uses = 'actions/setup-go@main' }, ACTION],
    'reviewed action given a new input': [(w) => { w.jobs['cloudflare-tuf'].steps.find(s => s.uses?.startsWith('actions/setup-go@')).with['go-version-file'] = 'go.mod' }, ACTION_INPUT],
    'another Node set up for the audits': [(w) => { w.env.NODE_VERSION = '22.0.0' }, NODE],
    'pinned PATH dropped from the infra/aws audit': (w) => { const s = w.jobs['aws-release-trust'].steps.find(x => x.id === 'gate_2'); s.run = s.run.replace(AUDIT_PATH, '') },
    'pinned PATH widened for the release audit': (w) => { const s = w.jobs['release-contracts'].steps.find(x => x.id === 'gate_2'); s.run = s.run.replace(':/usr/bin:/bin"', ':$PATH"') },
    'Node check dropped from the Cloudflare audit': (w) => { const s = w.jobs['cloudflare-tuf'].steps.find(x => x.id === 'gate_3'); s.run = s.run.replace(`test "$(node --version)" = v${NODE_RUNTIME}\n`, '') },
    'infra/aws audit in the default shell': [(w) => { delete w.jobs['aws-release-trust'].steps.find(x => x.id === 'gate_2').shell }, STEP_KEYS],
    'release audit in a bash found on PATH': [(w) => { w.jobs['release-contracts'].steps.find(x => x.id === 'gate_2').shell = 'bash -p -e {0}' }, SHELL],
    'EHR audit without privileged mode': [(w) => { w.jobs['ehr-release-cache'].steps.find(x => x.id === 'gate_2').shell = '/usr/bin/bash -e {0}' }, SHELL],
    'install scripts run before the infra/aws audit': [(w) => { runFirst(w.jobs['aws-release-trust'].steps, 'gate_1') }, CODE_FIRST],
    'install scripts run before the Cloudflare audit': [(w) => { runFirst(w.jobs['cloudflare-tuf'].steps, 'gate_1') }, CODE_FIRST],
    'NODE_VERSION in an audit job env': [(w) => { w.jobs['release-contracts'].env = { NODE_VERSION: '20.0.0' } }, UNLISTED('NODE_VERSION')],
    'NODE_VERSION in an audit step env': [(w) => { w.jobs['aws-release-trust'].steps.find(x => x.id === 'gate_1').env = { NODE_VERSION: '20.0.0' } }, UNLISTED('NODE_VERSION')],
    'infra/aws audit job on another runner': [(w) => { w.jobs['aws-release-trust']['runs-on'] = 'self-hosted' }, JOB_RUNTIME],
    // Jobs without an audit get only the whole-workflow rules: no npm_config_*, NODE_OPTIONS, PATH, BASH_ENV or ENV in any env,
    // and every env a plain map.
    'NODE_OPTIONS in a job without an audit': [(w) => { w.jobs['tuf-client'].env.NODE_OPTIONS = '--import=/tmp/p.mjs' }, DENIED('NODE_OPTIONS')],
    'BASH_ENV in a step of a job without an audit': [(w) => { w.jobs.workspace.steps.find(s => s.run !== undefined).env = { BASH_ENV: '/tmp/skip.sh' } }, DENIED('BASH_ENV')],
    'PATH in a job without an audit': [(w) => { w.jobs['tuf-client'].env.PATH = '/tmp/bin:/usr/bin:/bin' }, DENIED('PATH')],
    'ENV in a step of a job without an audit': [(w) => { w.jobs.workspace.steps.find(s => s.run !== undefined).env = { ENV: '/tmp/skip.sh' } }, DENIED('ENV')],
    'npm registry in a step of a job without an audit': [(w) => { w.jobs['tuf-client'].steps.find(s => s.run !== undefined).env = { npm_config_registry: 'https://registry.invalid/' } }, DENIED('npm_config_registry')],
    'step env of a job without an audit given as an expression': [(w) => { w.jobs.workspace.steps.find(s => s.run !== undefined).env = '${{ fromJSON(vars.WORKSPACE_ENV) }}' }, ANY_ENV_MAP],
    'action given as a number': [(w) => { w.jobs['release-contracts'].steps.find(s => s.uses?.startsWith('actions/checkout@')).uses = 7 }, /uses an unreviewed action/],
    'action inputs given as an expression': [(w) => { w.jobs['release-contracts'].steps.find(s => s.uses?.startsWith('actions/checkout@')).with = '${{ fromJSON(vars.CHECKOUT) }}' }, /inputs that are not a plain map/],
    // A cache restored before an audit can bring back what an earlier run's dependency code saved, a replaced npm included.
    'Go cache restored before the Cloudflare audit': [(w) => { const steps = w.jobs['cloudflare-tuf'].steps; move(steps, setupGo(steps), 'gate_3') }, BEFORE_AUDIT],
    'Go set up without a cache before the EHR audit': [(w) => { before(w.jobs['ehr-release-cache'].steps, 'gate_2', { ...setupGo(w.jobs['cloudflare-tuf'].steps), with: { 'go-version': '${{ env.GO_VERSION }}', cache: false } }) }, BEFORE_AUDIT],
    'artifact step before the release audit': [(w) => { const steps = w.jobs['release-contracts'].steps; move(steps, steps.find(s => s.uses?.startsWith('actions/upload-artifact@')), 'gate_2') }, BEFORE_AUDIT],
    'npm cache restored before the release audit': [(w) => { setupNode(w.jobs['release-contracts'].steps).with['package-manager-cache'] = true }, NPM_CACHE],
    'npm cache input left empty for the infra/aws audit': [(w) => { setupNode(w.jobs['aws-release-trust'].steps).with['package-manager-cache'] = '' }, NPM_CACHE],
    'npm cache input dropped for the EHR audit': [(w) => { delete setupNode(w.jobs['ehr-release-cache'].steps).with['package-manager-cache'] }, NPM_CACHE],
    // The audit must read the tree the later steps test, not another commit.
    'Cloudflare audit reads another commit': [(w) => { checkout(w.jobs['cloudflare-tuf'].steps).with.ref = '${{ github.event.pull_request.base.sha }}' }, OTHER_TREE],
    'head checked out again after the release audit': [(w) => { const steps = w.jobs['release-contracts'].steps; steps.splice(steps.findIndex(s => s.id === 'gate_2') + 1, 0, { ...checkout(steps), with: { 'persist-credentials': false } }) }, ONE_CHECKOUT],
    'source checked out only after the infra/aws audit': [(w) => { const steps = w.jobs['aws-release-trust'].steps; move(steps, checkout(steps), 'gate_2', true) }, /must check out its source before its audit/],
  }
  for (const [name, attack] of Object.entries(attacks)) {
    const [edit, reason] = [attack].flat()
    const workflow = parseWorkflow(localGates)
    edit(workflow)
    assert.throws(() => verifyLocalGateWorkflow(stringify(workflow)), reason, name)
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
    'exception file rewritten before audit': (w) => { before(w.jobs.tooling.steps, 'audit', { run: "echo '{}' > security/npm-audit-exceptions.json" }) },
    'security file replaced by glob': (w) => { before(w.jobs.tooling.steps, 'audit', { run: 'cp /tmp/empty.json security/*.json' }) },
    'security file replaced after the audit': [(w) => { const steps = w.jobs.tooling.steps; steps.splice(steps.findIndex(s => s.id === 'audit') + 1, 0, { run: 'cp /tmp/empty.json security/*.json' }) }, GATE_ONLY],
    'npm registry redirected': (w) => { w.jobs.tooling.steps.find(s => s.uses?.startsWith('actions/setup-node@')).with['registry-url'] = 'https://registry.invalid/' },
    'default shell replaced': (w) => { w.jobs.tooling.defaults = { run: { shell: 'true {0}' } } },
    'workflow default shell replaced': [(w) => { w.defaults = { run: { shell: 'true {0}' } } }, DEFAULT_SHELL],
    'install step npm configuration': [(w) => { w.jobs.tooling.steps.find(s => s.name === 'Install locked tooling without cloud authority').env = { npm_config_registry: 'https://registry.invalid/' } }, /workflow cannot set npm_config_registry/],
    'tooling job skipped': [(w) => { w.jobs.tooling.if = '${{ false }}' }, JOB_RUNTIME],
    'tooling job may fail': [(w) => { w.jobs.tooling['continue-on-error'] = true }, JOB_RUNTIME],
    'tooling job moved into a container': [(w) => { w.jobs.tooling.container = 'node:22' }, JOB_RUNTIME],
    'node preload written to GITHUB_ENV': [(w) => { before(w.jobs.tooling.steps, 'audit', preload) }, LATER_STEPS],
    'fake npm added through GITHUB_PATH': [(w) => { before(w.jobs.tooling.steps, 'audit', fakeNpm) }, LATER_STEPS],
    'fake npm added through tooling PATH': [(w) => { w.jobs.tooling.env.PATH = '/tmp/bin:/usr/bin:/bin' }, UNLISTED('PATH')],
    'BASH_ENV in the tooling env': [(w) => { w.jobs.tooling.env.BASH_ENV = '/tmp/skip.sh' }, UNLISTED('BASH_ENV')],
    'BASH_ENV in the workflow env': [(w) => { w.env = { BASH_ENV: '/tmp/skip.sh' } }, UNLISTED('BASH_ENV')],
    'proxy in the tooling env': [(w) => { w.jobs.tooling.env.HTTPS_PROXY = 'http://127.0.0.1:8080' }, UNLISTED('HTTPS_PROXY')],
    'tooling env given as an expression': [(w) => { w.jobs.tooling.env = "${{ fromJSON(inputs.plan_json).env }}" }, NOT_A_MAP],
    'unreviewed action before the audit': [(w) => { before(w.jobs.tooling.steps, 'audit', proxyAction) }, ACTION],
    'local action before the audit': [(w) => { before(w.jobs.tooling.steps, 'audit', localAction) }, ACTION],
    'pinned PATH dropped from the audit': (w) => { auditStep(w).run = auditStep(w).run.replace(AUDIT_PATH, '') },
    'another Node for the tooling': [(w) => { w.jobs.tooling.steps.find(s => s.uses?.startsWith('actions/setup-node@')).with['node-version'] = '20.0.0' }, NODE],
    'audit in the default shell': [(w) => { delete auditStep(w).shell }, STEP_KEYS],
    'audit in a bash found on PATH': [(w) => { auditStep(w).shell = 'bash -p -e {0}' }, SHELL],
    'policy tests run before the audit': [(w) => { runFirst(w.jobs.tooling.steps, 'policy') }, CODE_FIRST],
    'tooling install runs before the audit': [(w) => { const steps = w.jobs.tooling.steps; const i = steps.findIndex(s => s.name === 'Install locked tooling without cloud authority'); const [step] = steps.splice(i, 1); steps.splice(steps.findIndex(s => s.id === 'audit'), 0, step) }, CODE_FIRST],
    'NODE_VERSION in the tooling env': [(w) => { w.jobs.tooling.env.NODE_VERSION = '20.0.0' }, UNLISTED('NODE_VERSION')],
    'Go set up before the audit': [(w) => { const steps = w.jobs.tooling.steps; move(steps, setupGo(steps), 'audit') }, BEFORE_AUDIT],
    'publisher Go cache turned on': [(w) => { setupGo(w.jobs.tooling.steps).with.cache = true }, /the publisher tooling job restores no Go cache/],
    'publisher Go cache input dropped': [(w) => { delete setupGo(w.jobs.tooling.steps).with.cache }, /the publisher tooling job restores no Go cache/],
    'second publisher Go setup with a cache': [(w) => { const steps = w.jobs.tooling.steps; steps.splice(steps.indexOf(setupGo(steps)) + 1, 0, { uses: setupGo(steps).uses, with: { 'go-version': '1.26.10', cache: true } }) }, /the publisher tooling job restores no Go cache/],
    'npm cache restored for the tooling': [(w) => { setupNode(w.jobs.tooling.steps).with['package-manager-cache'] = true }, NPM_CACHE],
    'tooling checked out again after the audit': [(w) => { const steps = w.jobs.tooling.steps; steps.splice(steps.findIndex(s => s.id === 'audit') + 1, 0, structuredClone(checkout(steps))) }, ONE_CHECKOUT],
  }
  Object.assign(attacks, {
    'NODE_OPTIONS in the publish job env': [(w) => { w.jobs.publish.env.NODE_OPTIONS = '--import=/tmp/p.mjs' }, DENIED('NODE_OPTIONS')],
    'BASH_ENV in a publish step env': [(w) => { w.jobs.publish.steps.filter(s => s.run !== undefined)[1].env = { BASH_ENV: '/tmp/skip.sh' } }, DENIED('BASH_ENV')],
    'publish step env given as an expression': [(w) => { w.jobs.publish.steps.filter(s => s.run !== undefined)[1].env = '${{ fromJSON(inputs.plan_json).env }}' }, ANY_ENV_MAP],
  })
  for (const [name, attack] of Object.entries(attacks)) {
    const [edit, reason] = [attack].flat()
    const workflow = parseWorkflow(source)
    edit(workflow)
    assert.throws(() => verifyPublicationWorkflow(stringify(workflow)), reason, name)
  }
})
test('the audit shell reads no BASH_ENV and imports no shell function, as plain bash would', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-shell-'))
  try {
    const rc = join(dir, 'rc.sh')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(rc, 'npm() { echo fake; }\ntouch "$MARKER"\n')
    const script = join(dir, 'audit.sh')
    await writeFile(script, 'echo "npm is $(type -t npm || echo absent)"\n')
    const env = { PATH: '/usr/bin:/bin', BASH_ENV: rc, MARKER: join(dir, 'sourced'), 'BASH_FUNC_npm%%': '() { echo fake; }' }
    const run = (shell) => spawnSync(shell.split(' ')[0], [...shell.split(' ').slice(1, -1), script], { env, encoding: 'utf8' })
    const plain = run('/usr/bin/bash -e {0}')
    assert.match(plain.stdout, /npm is function/, 'control: plain bash takes the injected function')
    const audit = run(AUDIT_SHELL)
    assert.equal(audit.status, 0)
    assert.match(audit.stdout, /npm is (file|absent)/)
    await rm(join(dir, 'sourced'), { force: true })
    run(AUDIT_SHELL)
    await assert.rejects(readFile(join(dir, 'sourced')), 'the audit shell must not source BASH_ENV')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a line break the yaml parser does not see cannot hide workflow content', () => {
  // yaml ends a line only at LF; YAML 1.2 and GitHub also end one at these. Each would hide what follows it in a comment.
  const breaks = { CR: '\r', NEL: '\u0085', LS: '\u2028', PS: '\u2029' }
  const hidden = {
    'a checkout ref': ['persist-credentials: false', 'persist-credentials: false # reviewed{BREAK}          ref: ${{ github.event.pull_request.base.sha }}'],
    'a step before the audit': ['package-manager-cache: false', 'package-manager-cache: false # reviewed{BREAK}      - run: npm --prefix release ci'],
    'continue-on-error on the audit': ['id: gate_2', 'id: gate_2 # audit{BREAK}        continue-on-error: true'],
  }
  for (const [name, character] of Object.entries(breaks)) {
    for (const [what, [line, replacement]] of Object.entries(hidden)) {
      const edited = localGates.replace(line, replacement.replace('{BREAK}', character))
      assert.notEqual(edited, localGates)
      assert.throws(() => verifyLocalGateWorkflow(edited), /printable ASCII with LF line breaks/, `${what} behind ${name}`)
    }
    const publisher = source.replace('package-manager-cache: false', `package-manager-cache: false # reviewed${character}          cache: npm`)
    assert.notEqual(publisher, source)
    assert.throws(() => verifyPublicationWorkflow(publisher), /printable ASCII with LF line breaks/, `the publisher's npm cache behind ${name}`)
  }
  assert.throws(() => verifyLocalGateWorkflow(localGates.replace(/\n/g, '\r\n')), /printable ASCII with LF line breaks/, 'CRLF line breaks')
  assert.throws(() => verifyLocalGateWorkflow(`%YAML 1.1\n---\n${localGates}`), /YAML directive/, 'a YAML 1.1 directive')
  assert.throws(() => verifyPublicationWorkflow(`%YAML 1.2\n---\n${source}`), /YAML directive/, 'a YAML 1.2 directive')
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
