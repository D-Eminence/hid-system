import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyCandidateIdentity, approvalIdentities } from '../scripts/verify-ci-candidate.mjs'

function fixture() {
  const context = { GITHUB_SHA: 'b'.repeat(40), GITHUB_REPOSITORY: 'D-Eminence/hid-system',
    GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true', APPROVED_REF: 'refs/heads/main',
    APPROVED_REPOSITORY_ID: '123', APPROVED_OWNER_ID: '456', APPROVED_CANDIDATE_WORKFLOW_PATH: '.github/workflows/tuf-candidate.yml' }
  const plan = { environment: 'staging', git_sha: context.GITHUB_SHA, candidate_run_id: '11', candidate_artifact_id: '22', repository_sha256: 'c'.repeat(64) }
  const run = { id: 11, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: context.GITHUB_SHA,
    head_branch: 'main', path: context.APPROVED_CANDIDATE_WORKFLOW_PATH,
    repository: { id: 123, full_name: context.GITHUB_REPOSITORY, owner: { id: 456 } }, head_repository: { id: 123 } }
  const artifact = { id: 22, expired: false, size_in_bytes: 300, name: 'staging-candidate', digest: `sha256:${'d'.repeat(64)}`,
    workflow_run: { id: 11, head_sha: context.GITHUB_SHA, head_branch: 'main', repository_id: 123, head_repository_id: 123 } }
  return { context, plan, run, artifact }
}

test('candidate provenance binds the exact successful protected source and immutable artifact identity', () => {
  const f = fixture()
  const evidence = verifyCandidateIdentity(f.plan, f.context, f.run, f.artifact)
  assert.equal(evidence.head_sha, f.context.GITHUB_SHA)
  assert.equal(evidence.artifact.github_archive_digest, f.artifact.digest)
})

test('CI provenance rejects PRs, fork substitution, stale evidence, spoofed SHA and missing artifact digest', () => {
  const attacks = [
    f => { f.plan.git_sha = 'a'.repeat(40) }, f => { f.context.GITHUB_REF_PROTECTED = 'false' },
    f => { f.context.GITHUB_REF = 'refs/pull/1/merge' }, f => { f.run.event = 'pull_request' },
    f => { f.run.conclusion = 'failure' }, f => { f.run.status = 'in_progress' },
    f => { f.run.head_sha = 'a'.repeat(40) }, f => { f.run.head_branch = 'attacker' },
    f => { f.run.path = '.github/workflows/attacker.yml' }, f => { f.run.head_repository.id = 999 },
    f => { f.run.repository.owner.id = 999 }, f => { f.artifact.id = 999 },
    f => { f.artifact.workflow_run.id = 999 }, f => { f.artifact.expired = true },
    f => { f.artifact.digest = null }, f => { f.artifact.workflow_run.head_sha = 'a'.repeat(40) },
    f => { f.artifact.workflow_run.repository_id = 999 }, f => { f.plan.environment = 'development' },
    f => { f.plan.candidate_run_id = '../11' },
  ]
  for (const attack of attacks) {
    const f = fixture(); attack(f)
    assert.throws(() => verifyCandidateIdentity(f.plan, f.context, f.run, f.artifact))
  }
})

test('approval evidence never transfers staging approval to production or exposes comments', () => {
  const history = [{ state: 'approved', user: { id: 71 }, environments: [{ name: 'staging-publisher' }], comment: 'omitted' }]
  assert.deepEqual(approvalIdentities(history, 'production'), [])
  assert.deepEqual(approvalIdentities(history, 'staging'), [{ state: 'approved', actor_id: '71', environment: 'staging-publisher' }])
  assert.throws(() => approvalIdentities({}, 'staging'))
})
