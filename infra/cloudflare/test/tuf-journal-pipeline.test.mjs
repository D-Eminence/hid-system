import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { runPublicationPipeline, evidenceEnvelope } from '../../../release/scripts/publication-pipeline.mjs'
import { runTufWrangler } from '../scripts/tuf-wrangler.mjs'
import { validateTufRepositoryDirectory } from '../scripts/tuf-repository-layout.mjs'
import { writeRepository, canonicalize, digest } from './helpers/tuf-repository-fixture.mjs'
import { publicationAuthorization } from './helpers/tuf-publication-fixture.mjs'

test('real Wrangler wrapper boundaries require durable intents through complete bootstrap publication', async () => {
  for (const failAt of [null, 'parent-started', 'upload-started', 'deploy-started', 'route-started', 'uploaded', 'deployed']) {
    const fixture = await writeRepository('staging')
    const output = await mkdtemp(join(tmpdir(), 'hid-journal-wrapper-'))
    try {
      const now = new Date(Math.floor(Date.now() / 1000) * 1000)
      const repository = await validateTufRepositoryDirectory(fixture.repository, 'staging')
      const authorized = publicationAuthorization(repository, now)
      const binding = { owner: '123:1', git_sha: 'a'.repeat(40), artifact_sha256: 'b'.repeat(64), artifact_set_sha256: 'c'.repeat(64),
        repository_sha256: repository.repositorySha256, authorization: authorized.authorization }
      const version = '1234abcd-1234-1234-1234-123456789abc'
      const previewUrl = 'https://1234abcd-hid-tuf-staging.account-name.workers.dev/'
      const path = name => resolve(output, `${name}.json`)
      let record
      const effects = []
      const seal = (phase, payload) => {
        const value = evidenceEnvelope(binding, phase, payload)
        return { ...value, reference: { bucket: 'hid-staging-evidence', key: `tuf-publication-journal/hid-staging-publication-v1/evidence/${value.sha256}.json`, version_id: 'immutable-version', sha256: value.sha256 } }
      }
      const options = (beforeEffect, phase, type) => ({
        now, wranglerPath: process.execPath,
        authorize: async () => { await beforeEffect(); return authorized },
        spawn(_binary, _args, execution) {
          assert.equal(record.phase, phase, 'Wrangler was reached without its committed intent')
          effects.push(phase)
          if (type) writeFileSync(execution.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({ type, version: 1, worker_name: 'hid-tuf-staging',
            version_id: version, deployment_id: version, preview_url: previewUrl, worker_name_overridden: false, targets: [], timestamp: now.toISOString() }) + '\n')
          return { status: 0 }
        },
      })
      const promise = runPublicationPipeline({ binding, bootstrap: true }, {
        now: () => now.getTime(), authorize: async () => authorized.authorization,
        journal: {
          begin: async () => (record = { schema_version: '1.0.0', result: 'pending', phase: 'claimed', revision: 1, binding }),
          advance: async (prior, phase) => {
            record = { ...prior, phase, revision: prior.revision + 1 }
            if (phase === failAt) throw Error('simulated lost committed response')
            return record
          },
          fail: async () => {},
          confirm: async prior => (record = { ...prior, phase: 'confirmed', result: 'completed', revision: prior.revision + 1 }),
        },
        verifyArchive: async () => seal('archive-verified', { retained: true }),
        parent: async ({ beforeEffect }) => {
          const wrapper = options(null, 'parent-started', 'deploy')
          wrapper.beforeEffect = beforeEffect
          return seal('parent-created', await runTufWrangler(['bootstrap-parent', 'staging', path('parent'), 'create-inaccessible-hid-tuf-staging-parent'], wrapper))
        },
        upload: async ({ beforeEffect }) => seal('uploaded', await runTufWrangler(['versions-upload', 'staging', fixture.repository, path('upload')], options(beforeEffect, 'upload-started', 'version-upload'))),
        preview: async () => {
          const body = { schema_version: '1.0.0', admitted_at: now.toISOString(), client_sha256: 'b'.repeat(64),
            bundle_target: `environments/staging/releases/${authorized.authorization.release_id}/release-bundle.json`,
            workspace: '/private/test',
            trust: { configuration_sha256: 'c'.repeat(64), repository_id: 'hid-staging-preview-1234abcd', metadata_url: `${previewUrl}metadata`, targets_url: `${previewUrl}targets`, trusted_root_sha256: authorized.authorization.bootstrap_root_sha256 },
            tuf_metadata: Object.fromEntries(['root', 'targets', 'snapshot', 'timestamp'].map(role => [role, { version: 1, expires: new Date(now.getTime() + 86400000).toISOString() }])),
            deployment_plan: { environment: 'staging', release_id: authorized.authorization.release_id, artifact_set_sha256: binding.artifact_set_sha256, plan_sha256: 'f'.repeat(64) },
            verified_target_files: [{}], frontend_directories: Array.from({ length: 7 }, () => ({})) }
          const preview = { ...body, admission_record_sha256: digest(canonicalize(body)) }
          await writeFile(path('preview'), JSON.stringify(preview), { mode: 0o600 })
          return seal('preview-verified', preview)
        },
        deploy: async ({ beforeEffect }) => seal('deployed', await runTufWrangler(['versions-deploy', 'staging', fixture.repository, path('upload'), path('preview'), path('deploy'), `deploy-hid-tuf-staging-${version}-at-100-percent`], options(beforeEffect, 'deploy-started', 'version-deploy'))),
        route: async ({ beforeEffect }) => seal('route-activated', await runTufWrangler(['activate-route', 'staging', fixture.repository, path('deploy'), path('route'), `activate-updates.staging.healthidentitydirectory.com-for-${version}`], options(beforeEffect, 'route-started', null))),
        confirmPublished: async () => seal('confirmed', { independently_observed: true }),
      })
      if (failAt === null) {
        const result = await promise.catch(error => { throw new Error(`phase=${record?.phase}; effects=${effects.join(',')}`, { cause: error }) })
        assert.equal(result.record.phase, 'confirmed')
        assert.deepEqual(effects, ['parent-started', 'upload-started', 'deploy-started', 'route-started'])
        const receipt = JSON.parse(await readFile(path('deploy'), 'utf8'))
        assert.equal(receipt.repository_sha256, binding.repository_sha256)
      } else {
        await assert.rejects(promise)
        if (failAt.endsWith('-started')) assert.ok(!effects.includes(failAt), 'lost intent response reached Wrangler')
        assert.notEqual(record.phase, 'confirmed')
      }
    } finally {
      await rm(fixture.repository, { recursive: true, force: true })
      await rm(output, { recursive: true, force: true })
    }
  }
})
