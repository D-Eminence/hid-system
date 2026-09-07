import assert from 'node:assert/strict'
import test from 'node:test'
import { template, validateStagingIdentifiers } from '../scripts/validate-staging-identifiers.mjs'

test('the value-free staging template is structurally valid but cannot authorize execution', () => {
  assert.equal(validateStagingIdentifiers(template, { allowPlaceholders: true }).valid, true)
  const result = validateStagingIdentifiers(template)
  assert.equal(result.valid, false); assert.ok(result.missing.length > 60)
  assert.equal(result.authorization, 'NOT_AUTHORIZED')
  assert.equal(template.aws.object_lock.journal_and_evidence_retention_days, 730)
  assert.equal(template.aws.object_lock.approved, false)
})

test('supplied identifiers reject production substitution, unknown secret fields, mismatched accounts and bypasses', () => {
  for (const mutate of [
    m => { m.environment = 'production' }, m => { m.authorization = 'APPROVED' },
    m => { m.aws.object_lock.approved = true }, m => { m.aws.account_id = 'not-an-account' },
    m => { m.cloudflare.account_id = 'bad' }, m => { m.cloudflare.api_token = 'unexpected' },
    m => { m.cloudflare.frontend_hosts.ehr = 'ehr.healthidentitydirectory.com' },
    m => { m.aws.object_lock.default_retention_days = 1 },
    m => { m.aws.object_lock.journal_and_evidence_retention_days = 729 },
    m => { m.aws.object_lock.journal_and_evidence_retention_days = 731 },
    m => { m.aws.account_id = '111122223333'; m.aws.region = 'eu-west-1'; m.github.capabilities.publisher.role_arn = 'arn:aws:iam::444455556666:role/hid-staging-publisher' },
    m => { m.aws.account_id = '111122223333'; m.aws.region = 'eu-west-1'; m.github.capabilities.publisher.role_arn = 'arn:aws:iam::111122223333:role/hid-production-publisher' },
    m => { m.github.protected_ref = 'refs/heads/../main' },
    m => { m.github.capabilities.publisher.workflow_ref = `D-Eminence/hid-system/.github/workflows/developer.yml@${'a'.repeat(40)}` },
    m => { m.release.release_id = `r0000000001-g${'a'.repeat(40)}`; m.release.source_sha = 'b'.repeat(40) },
  ]) {
    const value = structuredClone(template); mutate(value)
    assert.equal(validateStagingIdentifiers(value, { allowPlaceholders: true }).valid, false)
  }
})
