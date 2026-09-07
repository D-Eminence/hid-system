import assert from 'node:assert/strict'
import test from 'node:test'
import { evidenceEnvelope, runPublicationPipeline } from '../scripts/publication-pipeline.mjs'

function fixture(bootstrap = true) {
  const now = Date.parse('2026-09-05T12:00:00Z')
  const binding = { owner: '123:1', git_sha: 'a'.repeat(40), repository_sha256: 'b'.repeat(64), artifact_sha256: 'c'.repeat(64), artifact_set_sha256: 'd'.repeat(64),
    authorization: { environment: 'staging', release_id: `r0000000001-g${'a'.repeat(40)}`, state_revision: bootstrap ? 0 : 3, authorized_at: '2026-09-05T12:00:00Z', expires_at: '2026-09-05T12:05:00Z' } }
  const events = []
  let record
  const seal = (phase, payload = {}) => {
    const value = evidenceEnvelope(binding, phase, payload)
    return { ...value, reference: { bucket: 'hid-staging-evidence', key: `tuf-publication-journal/hid-staging-publication-v1/evidence/${value.sha256}.json`, version_id: 'immutable-version-1', sha256: value.sha256 } }
  }
  const ports = {
    now: () => now,
    authorize: async () => { events.push('authorize'); return structuredClone(binding.authorization) },
    journal: {
      begin: async (value) => {
        events.push('begin')
        if (record) throw Error('occupied')
        record = { schema_version: '1.0.0', phase: 'claimed', result: 'pending', revision: 1, binding: value }
        return structuredClone(record)
      },
      advance: async (prior, phase, evidence, auth) => {
        assert.equal(prior.revision, record.revision)
        assert.match(evidence, /^[a-f0-9]{64}$/)
        if (phase.endsWith('-started')) assert.deepEqual(auth, binding.authorization)
        events.push(phase)
        record = { ...record, phase, revision: record.revision + 1 }
        return structuredClone(record)
      },
      fail: async (_record, code) => { events.push(`fail:${code}`) },
      confirm: async (prior, confirmation) => {
        assert.deepEqual(confirmation, { exact: true })
        events.push('confirmed')
        record = { ...record, result: 'completed', phase: 'confirmed', revision: prior.revision + 1 }
        return structuredClone(record)
      },
    },
    verifyArchive: async () => { events.push('archive'); return seal('archive-verified') },
    preview: async () => { events.push('preview'); return seal('preview-verified') },
    confirmPublished: async () => { events.push('confirm-read'); return seal('confirmed', { exact: true }) },
    wait: async () => { events.push('wait') },
  }
  for (const [name, phase] of Object.entries({ parent: 'parent-created', upload: 'uploaded', deploy: 'deployed', route: 'route-activated' })) {
    ports[name] = async ({ beforeEffect }) => {
      await beforeEffect()
      events.push(`effect:${name}`)
      return seal(phase)
    }
  }
  return { options: { binding, bootstrap, maxConfirmationAttempts: 2, confirmationDelayMs: 0 }, ports, events, seal }
}

test('publication executes each effect once after its durable intent and closes on exact confirmation', async () => {
  for (const bootstrap of [true, false]) {
    const { options, ports, events } = fixture(bootstrap)
    const result = await runPublicationPipeline(options, ports)
    assert.equal(result.record.result, 'completed')
    for (const name of bootstrap ? ['parent', 'upload', 'deploy', 'route'] : ['upload', 'deploy']) {
      const started = `${name}-started`
      assert.equal(events.filter((item) => item === `effect:${name}`).length, 1)
      assert.equal(events[events.indexOf(`effect:${name}`) - 1], started)
      assert.equal(events[events.indexOf(started) - 1], 'authorize')
    }
    if (!bootstrap) assert.ok(!events.includes('effect:parent') && !events.includes('effect:route'))
    assert.equal(events.at(-1), 'confirmed')
    assert.equal(result.evidence.at(-1).phase, 'confirmed')
  }
})

test('claim failure and replay cannot perform external effects', async () => {
  const { options, ports, events } = fixture()
  await runPublicationPipeline(options, ports)
  events.length = 0
  await assert.rejects(runPublicationPipeline(options, ports), /failed closed/)
  assert.deepEqual(events, ['begin'])
})

test('lost intent or result responses never replay or continue an effect', async () => {
  for (const failedPhase of ['archive-verified', 'parent-started', 'parent-created', 'upload-started', 'uploaded', 'preview-verified', 'deploy-started', 'deployed', 'route-started', 'route-activated']) {
    const { options, ports, events } = fixture()
    const advance = ports.journal.advance
    ports.journal.advance = async (...args) => {
      const result = await advance(...args)
      if (args[1] === failedPhase) throw Error('lost committed response')
      return result
    }
    await assert.rejects(runPublicationPipeline(options, ports))
    if (failedPhase.endsWith('-started')) assert.ok(!events.includes(`effect:${failedPhase.replace('-started', '')}`))
    assert.ok(!events.includes('confirmed'))
    assert.equal(events.at(-1), 'fail:storage-failed')
  }
})

test('bad evidence, cross-binding, stale authorization and canceled work stay unpromoted', async () => {
  for (const scenario of ['hash', 'binding', 'version', 'expired', 'superseded', 'missing-before-effect', 'duplicate-before-effect', 'canceled']) {
    const { options, ports, events, seal } = fixture()
    if (scenario === 'hash') ports.verifyArchive = async () => ({ ...seal('archive-verified'), sha256: 'f'.repeat(64) })
    if (scenario === 'binding') ports.verifyArchive = async () => ({ ...seal('uploaded') })
    if (scenario === 'version') ports.verifyArchive = async () => { const value = seal('archive-verified'); value.reference.version_id = 'null'; return value }
    if (scenario === 'expired') ports.authorize = async () => ({ ...options.binding.authorization, authorized_at: '2026-09-05T11:58:00Z', expires_at: '2026-09-05T12:03:00Z' })
    if (scenario === 'superseded') ports.authorize = async () => ({ ...options.binding.authorization, state_revision: 5 })
    if (scenario === 'missing-before-effect') ports.parent = async () => seal('parent-created')
    if (scenario === 'duplicate-before-effect') ports.parent = async ({ beforeEffect }) => { await beforeEffect(); await beforeEffect(); return seal('parent-created') }
    if (scenario === 'canceled') options.signal = AbortSignal.abort()
    await assert.rejects(runPublicationPipeline(options, ports), /failed closed/)
    assert.ok(!events.includes('effect:upload'))
    assert.ok(!events.includes('confirmed'))
  }
})

test('only read-only confirmation is polled, and timeout never completes the attempt', async () => {
  const { options, ports, events } = fixture(false)
  ports.confirmPublished = async () => { events.push('confirm-read'); return null }
  await assert.rejects(runPublicationPipeline(options, ports))
  assert.equal(events.filter((item) => item === 'confirm-read').length, 2)
  assert.equal(events.filter((item) => item === 'effect:deploy').length, 1)
  assert.equal(events.at(-1), 'fail:canary-timeout')
})
