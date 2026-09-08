import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseWorkflow } from '../scripts/verify-publication-workflow.mjs'
import { AUDIENCE, ENVIRONMENTS, ISSUER, JWKS_URL, OWNER_ID, OWNER_LOGIN, PROTECTED_REF, REPOSITORY,
  REPOSITORY_ID, WORKFLOW, WORKFLOW_NAME, collectProtectedReadiness, trustedTokenRequestUrl,
  verifyEnvironmentProtections, verifyReadinessContext, verifyReadinessToken,
  verifyStagingApproval } from '../scripts/verify-protected-readiness.mjs'

const source = await readFile(new URL('../../.github/workflows/tuf-protected-readiness.yml', import.meta.url), 'utf8')
const now = Date.parse('2026-09-07T14:00:00Z')
// Disposable in-memory test keys only; no credentials or key files are created.
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicKey = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', use: 'sig', alg: 'RS256' }
const jwks = { keys: [publicKey] }
function fixture() {
  const e = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REPOSITORY_ID: REPOSITORY_ID, GITHUB_REPOSITORY_OWNER: OWNER_LOGIN, GITHUB_REPOSITORY_OWNER_ID: OWNER_ID,
    GITHUB_REF: PROTECTED_REF, GITHUB_REF_TYPE: 'branch', GITHUB_REF_PROTECTED: 'true',
    READINESS_ENVIRONMENT: 'staging', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW: WORKFLOW_NAME, GITHUB_WORKFLOW_REF: `${REPOSITORY}/${WORKFLOW}@${PROTECTED_REF}`, GITHUB_SHA: 'a'.repeat(40),
    READINESS_SOURCE_SHA: 'a'.repeat(40), TUF_READINESS_APPROVED_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '123', GITHUB_ACTOR: OWNER_LOGIN, GITHUB_ACTOR_ID: OWNER_ID, GH_READINESS_READ_TOKEN: 'fixture-read-token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-request-token', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fixture.actions.githubusercontent.com/token' }
  const environments = ENVIRONMENTS.map((name, i) => ({ name, id: i + 1, can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
    protection_rules: [{ type: 'required_reviewers', prevent_self_review: false,
      reviewers: [{ type: 'User', reviewer: { id: Number(OWNER_ID), login: OWNER_LOGIN } }] }] }))
  const history = [{ state: 'approved', user: { id: Number(OWNER_ID), login: OWNER_LOGIN, type: 'User' }, environments: [{ name: 'staging', id: 1 }] }]
  const claims = { iss: ISSUER, aud: AUDIENCE, sub: `repo:${REPOSITORY}:environment:staging`, repository: REPOSITORY,
    repository_id: REPOSITORY_ID, repository_owner: OWNER_LOGIN, repository_owner_id: OWNER_ID, ref: PROTECTED_REF, ref_type: 'branch', sha: e.GITHUB_SHA,
    environment: 'staging', workflow: WORKFLOW_NAME, workflow_ref: e.GITHUB_WORKFLOW_REF, workflow_sha: e.GITHUB_SHA, event_name: 'workflow_dispatch',
    runner_environment: 'github-hosted', actor: e.GITHUB_ACTOR, actor_id: e.GITHUB_ACTOR_ID, run_id: e.GITHUB_RUN_ID, run_attempt: '1',
    iat: now / 1000 - 10, nbf: now / 1000 - 10, exp: now / 1000 + 290 }
  return { e, environments, history, claims }
}
function token(claims, header = { alg: 'RS256', typ: 'JWT', kid: publicKey.kid }) {
  const data = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), pair.privateKey).toString('base64url')}`
}

test('readiness workflow is manual staging-only and cannot obtain AWS or publisher credentials', () => {
  const w = parseWorkflow(source), job = w.jobs['staging-readiness']
  assert.deepEqual(Object.keys(w.on), ['workflow_dispatch'])
  assert.deepEqual(Object.keys(w.on.workflow_dispatch.inputs), ['source_sha'])
  assert.deepEqual(w.permissions, {})
  assert.deepEqual(Object.keys(w.jobs), ['staging-readiness'])
  assert.equal(job.environment, 'staging')
  assert.equal(job['runs-on'], 'ubuntu-24.04')
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read', 'id-token': 'write' })
  assert.equal(job.env.TUF_READINESS_APPROVED_SHA, '${{ vars.TUF_READINESS_APPROVED_SHA }}')
  assert.match(job.if, /github\.event_name == 'workflow_dispatch'/)
  assert.match(job.if, /github\.ref == 'refs\/heads\/tuf-production-release'/)
  assert.equal(w.concurrency['cancel-in-progress'], false)
  const expectedActions = ['actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02']
  assert.deepEqual(job.steps.filter(step => step.uses).map(step => step.uses), expectedActions)
  assert.equal(job.steps[1].with.ref, '${{ inputs.source_sha }}')
  assert.equal(job.steps[1].with['persist-credentials'], false)
  assert.equal(job.steps.at(-1).with.path, '${{ runner.temp }}/tuf-protected-readiness.json')
  assert.doesNotMatch(source, /secrets\.|secrets:|configure-aws-credentials|tuf-publish\.yml|run-protected-publication|sts\.amazonaws\.com/)
  for (const step of job.steps) {
    assert.ok(!step['continue-on-error'])
    if (step.run) assert.doesNotMatch(step.run, /\$\{\{\s*(?:inputs\.|github\.event)/)
  }
})

test('real pre-checkout gate and verifier reject PRs, source/ref substitution, missing pins and replay attempts', async () => {
  const inline = parseWorkflow(source).jobs['staging-readiness'].steps[0].run
    .split("node --input-type=module <<'NODE'\n")[1].replace(/\nNODE\n?$/, '')
  const attacks = [e => { e.GITHUB_EVENT_NAME = 'pull_request' }, e => { e.GITHUB_REF = 'refs/heads/attacker' },
    e => { e.GITHUB_REF_PROTECTED = 'false' }, e => { e.READINESS_SOURCE_SHA = 'b'.repeat(40) },
    e => { e.TUF_READINESS_APPROVED_SHA = '' }, e => { e.GITHUB_WORKFLOW_SHA = 'b'.repeat(40) },
    e => { e.GITHUB_REPOSITORY_ID = '1' }, e => { e.GITHUB_REPOSITORY_OWNER_ID = '1' },
    e => { e.GITHUB_REPOSITORY_OWNER = 'attacker' }, e => { e.GITHUB_WORKFLOW = 'Other workflow' },
    e => { e.GITHUB_ACTOR = '' }, e => { e.GITHUB_ACTOR_ID = 'invalid' }, e => { e.GITHUB_RUN_ID = 'invalid' },
    e => { e.GITHUB_REPOSITORY = 'attacker/fork' }, e => { e.READINESS_ENVIRONMENT = 'production' },
    e => { e.RUNNER_ENVIRONMENT = 'self-hosted' }, e => { e.GITHUB_HEAD_REF = 'fork' },
    e => { e.GITHUB_RUN_ATTEMPT = '2' }, e => { e.GITHUB_REF_TYPE = 'tag' },
    e => { e.GITHUB_WORKFLOW_REF = `${REPOSITORY}/.github/workflows/attacker.yml@${PROTECTED_REF}` }]
  const directory = await mkdtemp(join(tmpdir(), 'hid-readiness-test-'))
  try {
    for (const mutate of [null, ...attacks]) {
      const { e } = fixture(); mutate?.(e)
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', inline], { cwd: directory, env: e, encoding: 'utf8', timeout: 10000 })
      assert.equal(result.status === 0, mutate === null)
      assert.equal(result.stdout, '')
      if (mutate) assert.throws(() => verifyReadinessContext(e, e.GITHUB_SHA))
      else assert.equal(verifyReadinessContext(e, e.GITHUB_SHA).sourceSha, e.GITHUB_SHA)
    }
    const { e } = fixture()
    assert.throws(() => verifyReadinessContext(e, 'b'.repeat(40)))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('live protections permit owner self-approval but reject substitute reviewers, bypass and mixed environments', () => {
  const attacks = [f => { f.environments.pop() }, f => { f.environments[1].id = 1 },
    f => { f.environments[1].name = 'staging' }, f => { f.environments[0].can_admins_bypass = true },
    f => { delete f.environments[0].can_admins_bypass }, f => { f.environments[0].protection_rules = [] },
    f => { f.environments[0].protection_rules[0].prevent_self_review = true },
    f => { delete f.environments[0].protection_rules[0].prevent_self_review },
    f => { f.environments[0].protection_rules[0].reviewers = [] },
    f => { f.environments[0].protection_rules[0].reviewers[0].reviewer.id = 999 },
    f => { f.environments[0].protection_rules[0].reviewers[0].reviewer.login = 'attacker' },
    f => { f.environments[0].protection_rules[0].reviewers[0].type = 'Team' },
    f => { f.environments[0].protection_rules[0].reviewers.push({ type: 'User', reviewer: { id: 999, login: 'contributor' } }) },
    f => { f.environments[0].deployment_branch_policy.protected_branches = false },
    f => { f.environments[0].deployment_branch_policy.custom_branch_policies = true }]
  for (const attack of attacks) { const f = fixture(); attack(f); assert.throws(() => verifyEnvironmentProtections(f.environments)) }
  const f = fixture(), protections = verifyEnvironmentProtections(f.environments)
  assert.equal(f.e.GITHUB_ACTOR_ID, OWNER_ID)
  assert.equal(protections[0].prevent_self_review, false)
  assert.deepEqual(verifyStagingApproval(f.history, protections[0]), [Number(OWNER_ID)])
  for (const mutate of [h => { h.length = 0 }, h => { h[0].state = 'rejected' }, h => { h[0].user.id = 999 },
    h => { h[0].user.login = 'attacker' }, h => { h[0].user.type = 'Bot' },
    h => { h[0].environments[0].name = 'production' }, h => { h[0].environments[0].id = 2 },
    h => { h[0].environments.push({ name: 'production', id: 2 }) }]) {
    const history = structuredClone(f.history); mutate(history)
    assert.throws(() => verifyStagingApproval(history, protections[0]))
  }
})

test('OIDC verifies signatures, exact readiness audience and identity, freshness and trusted endpoints', () => {
  const f = fixture()
  assert.equal(verifyReadinessToken(token(f.claims), jwks, f.e, now).signature_verified, true)
  for (const key of ['iss', 'aud', 'sub', 'repository', 'repository_id', 'repository_owner', 'repository_owner_id', 'ref', 'ref_type', 'sha',
    'environment', 'workflow', 'workflow_ref', 'workflow_sha', 'event_name', 'runner_environment', 'actor', 'actor_id', 'run_id', 'run_attempt']) {
    const claims = { ...f.claims, [key]: key === 'aud' ? 'sts.amazonaws.com' : 'wrong' }
    assert.throws(() => verifyReadinessToken(token(claims), jwks, f.e, now), undefined, key)
  }
  for (const changes of [{ exp: now / 1000 }, { iat: now / 1000 - 301 }, { nbf: now / 1000 + 31 },
    { exp: now / 1000 + 1000 }, { head_ref: 'attacker' },
    { job_workflow_ref: `${REPOSITORY}/.github/workflows/tuf-publish.yml@${'a'.repeat(40)}` }, { job_workflow_sha: 'a'.repeat(40) }]) {
    assert.throws(() => verifyReadinessToken(token({ ...f.claims, ...changes }), jwks, f.e, now))
  }
  const signed = token(f.claims).split('.'); signed[1] = Buffer.from(JSON.stringify({ ...f.claims, run_id: '999' })).toString('base64url')
  assert.throws(() => verifyReadinessToken(signed.join('.'), jwks, f.e, now))
  assert.throws(() => verifyReadinessToken(token(f.claims, { alg: 'none', typ: 'JWT', kid: publicKey.kid }), jwks, f.e, now))
  assert.throws(() => verifyReadinessToken(token(f.claims), { keys: [publicKey, publicKey] }, f.e, now))
  for (const url of ['http://fixture.actions.githubusercontent.com/token', 'https://actions.githubusercontent.com.attacker.test/token',
    'https://user:password@fixture.actions.githubusercontent.com/token', 'https://fixture.actions.githubusercontent.com:444/token', 'file:///tmp/token']) {
    assert.throws(() => trustedTokenRequestUrl(url))
  }
  assert.equal(trustedTokenRequestUrl(f.e.ACTIONS_ID_TOKEN_REQUEST_URL + '?audience=sts.amazonaws.com').searchParams.get('audience'), AUDIENCE)
})

test('end-to-end owner-approved probe obtains no OIDC token before authorization and retains no raw credentials or claims', async () => {
  const f = fixture(), calls = []
  const fetcher = async (url, options) => {
    calls.push(String(url)); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error')
    let value
    if (String(url) === JWKS_URL) { assert.equal(options.headers.Authorization, undefined); value = jwks }
    else if (String(url).startsWith('https://fixture.actions.githubusercontent.com/')) {
      assert.equal(new URL(url).searchParams.get('audience'), AUDIENCE); value = { value: token(f.claims) }
    } else if (String(url).endsWith('/approvals')) value = f.history
    else value = f.environments.find(v => String(url).endsWith(`/environments/${v.name}`))
    assert.ok(value, `unexpected outbound endpoint ${url}`)
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  }
  const evidence = await collectProtectedReadiness(f.e, { checkedOutSha: f.e.GITHUB_SHA, fetcher, now })
  assert.equal(evidence.publication_result, 'not-attempted')
  assert.equal(evidence.cloud_mutation, false)
  assert.equal(evidence.staging_status, 'NOT ACCEPTED')
  assert.equal(evidence.production, 'LOCKED')
  assert.equal(evidence.governance_model, 'sole-owner-approval')
  assert.equal(evidence.owner_self_approval_permitted, true)
  assert.deepEqual(evidence.approval_reviewer_ids, [Number(OWNER_ID)])
  assert.doesNotMatch(JSON.stringify(evidence), /fixture-read-token|fixture-request-token|"exp"|"iat"|"nbf"|"value"/)
  assert.equal(calls.length, 7)
  calls.length = 0
  f.environments[0].protection_rules[0].reviewers[0].reviewer.id = 999
  await assert.rejects(collectProtectedReadiness(f.e, { checkedOutSha: f.e.GITHUB_SHA, fetcher, now }), /Owner-only environment reviewer/)
  assert.equal(calls.length, 4)
  assert.ok(!calls.some(url => url.startsWith('https://fixture.actions.githubusercontent.com/')))
  calls.length = 0
  f.environments[0].protection_rules[0].reviewers[0].reviewer.id = Number(OWNER_ID)
  f.history[0].user.id = 999
  await assert.rejects(collectProtectedReadiness(f.e, { checkedOutSha: f.e.GITHUB_SHA, fetcher, now }), /Owner staging approval/)
  assert.equal(calls.length, 5)
  assert.ok(!calls.includes(JWKS_URL))
  assert.ok(!calls.some(url => url.startsWith('https://fixture.actions.githubusercontent.com/')))
  // Contributors may initiate a probe, but cannot replace the owner's approval.
  calls.length = 0
  f.e.GITHUB_ACTOR_ID = '999'; f.claims.actor_id = '999'
  f.e.GITHUB_ACTOR = 'contributor'; f.claims.actor = 'contributor'
  f.history[0].user.id = Number(OWNER_ID)
  const contributorEvidence = await collectProtectedReadiness(f.e, { checkedOutSha: f.e.GITHUB_SHA, fetcher, now })
  assert.deepEqual(contributorEvidence.approval_reviewer_ids, [Number(OWNER_ID)])
  assert.equal(calls.length, 7)
})
